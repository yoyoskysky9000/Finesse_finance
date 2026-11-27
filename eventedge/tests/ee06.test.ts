/**
 * EventEdge EE-06 Verification Suite
 *
 * Covers the paper-only risk and exposure manager:
 *  (a) Portfolio state builder: settled + open fills (YES & NO), unpriced fallback flag, pending exposure,
 *      hand-computed realized PnL, unrealized PnL, worst-case losses, family exposure, deployedPct,
 *      UTC dailyPnl, peakEquity, drawdownPct, and zero DB writes.
 *  (b) Limit checks: proposal exactly at each cap approved; one epsilon above rejected with exact code
 *      for POSITION_CAP, EVENT_RISK_CAP, CORRELATED_CAP, and DEPLOYED_CAP.
 *  (c) Sizing: hand-computed Kelly quantity, case where EVENT_RISK_CAP binds below Kelly, and quantity 0
 *      when edge is zero or negative (both BUY_YES and BUY_NO).
 *  (d) Stops: dailyLossPct at stop -> HALTED + evaluateRisk rejects with SYSTEM_STATE and DAILY_LOSS_STOP;
 *      drawdownPct at stop -> HALTED + evaluateRisk rejects with SYSTEM_STATE and DRAWDOWN_STOP.
 *  (e) Quarantine & Reconciliation: stale data -> DATA_QUARANTINE, integrity failure -> RECONCILIATION_REQUIRED,
 *      both fail closed; ordered operator recovery (RECOVERY_PENDING -> clearance) succeeds; direct jump to
 *      HEALTHY is rejected.
 *  (f) HALTED has no auto-reset: time passing / loss clearing alone never restores HEALTHY; only explicit
 *      recorded operator reset (actor + reason) does.
 *  (g) DEGRADED halves max quantity (integer floor).
 *  (h) Append-only: raw SQL UPDATE & DELETE on risk_state_history abort via triggers.
 *  (i) Determinism: buildPortfolioState twice on same fixture returns deeply identical values.
 *  (+) Extra guards: LIVE mode rejected, static isolation of eventedge/risk/ from live execution/network/creds.
 *
 * Run with: npx tsx eventedge/tests/ee06.test.ts
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  EVENTEDGE_LEDGER_TABLES,
  EVENTEDGE_MIGRATIONS,
  EventEdgeLiveModeDisabledError,
  IllegalRiskStateTransitionError,
  applySystemStateEvaluation,
  buildPortfolioState,
  completeOperatorClearance,
  computeMaxQuantity,
  computeMaxQuantityBreakdown,
  createEventEdgeConfig,
  evaluateRisk,
  evaluateSystemState,
  executeShadowDecision,
  getAppliedMigrations,
  getCurrentRiskSystemState,
  getRiskSystemStateHistory,
  initializeEventEdgeLedger,
  initiateOperatorRecovery,
  operatorResetFromHalted,
  persistOrderbookState,
  registerDiscoveredContract,
  registerExperiment,
  saveForecast,
  transitionContractLifecycle,
  transitionRiskSystemState,
  type EventEdgeConfig,
  type PortfolioState,
} from '../index';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  [FAIL] ${name}`);
    console.error(`         ${err instanceof Error ? err.stack || err.message : String(err)}`);
  }
}

function makeTempDb(label: string): { db: DatabaseSync; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `eventedge-ee06-${label}-`));
  const dbPath = path.join(dir, 'ledger.sqlite');
  const { db } = initializeEventEdgeLedger(dbPath);
  return {
    db,
    cleanup: () => {
      try {
        db.close();
      } catch {
        // ignore close error
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function ensureExperiment(db: DatabaseSync, experimentId: string): void {
  const exists = db
    .prepare('SELECT experiment_id FROM experiments WHERE experiment_id = ?')
    .get(experimentId) as { experiment_id: string } | undefined;
  if (!exists) {
    registerExperiment(db, {
      experimentId,
      title: 'EE-06 Risk Manager Verification',
      hypothesis: 'Portfolio state, caps, Kelly sizing, and fail-closed state machine are exact.',
      killCriteria: 'Kill on any cap bypass or unrecorded transition.',
      sampleDefinition: 'families=KXCPI,KXFED; n=50',
      modelVersion: 'ee-ensemble-v1.0.0',
      configHash: 'b'.repeat(64),
      registeredAt: '2026-11-24T00:00:00.000Z',
    });
  }
}

function seedMarketAndForecast(
  db: DatabaseSync,
  opts: {
    experimentId: string;
    marketId: string;
    eventId: string;
    eventFamilyId: string;
    probability: number;
    forecastTimestamp: string;
    forecastId: string;
  }
): void {
  ensureExperiment(db, opts.experimentId);
  const lcExists = db
    .prepare('SELECT 1 AS ok FROM contract_lifecycle_history WHERE market_id = ? LIMIT 1')
    .get(opts.marketId) as { ok: number } | undefined;
  if (!lcExists) {
    registerDiscoveredContract(db, {
      marketId: opts.marketId,
      actor: 'ee06-test',
      transitionedAt: '2026-11-24T00:01:00.000Z',
      reason: 'Discovered',
    });
    transitionContractLifecycle(db, {
      marketId: opts.marketId,
      toState: 'AUDIT_PENDING',
      actor: 'ee06-test',
      reason: 'Audit started',
      transitionedAt: '2026-11-24T00:02:00.000Z',
    });
    transitionContractLifecycle(db, {
      marketId: opts.marketId,
      toState: 'APPROVED',
      actor: 'ee06-test',
      reason: 'Audit CLEAR',
      transitionedAt: '2026-11-24T00:03:00.000Z',
    });
    transitionContractLifecycle(db, {
      marketId: opts.marketId,
      toState: 'ACTIVE',
      actor: 'ee06-test',
      reason: 'Active for trading',
      transitionedAt: '2026-11-24T00:04:00.000Z',
    });
  }

  saveForecast(db, {
    forecastId: opts.forecastId,
    experimentId: opts.experimentId,
    marketId: opts.marketId,
    eventId: opts.eventId,
    eventFamilyId: opts.eventFamilyId,
    eventFamilyDerivationVersion: 'ee-family-prefix-v1',
    forecastStage: 'p_ensemble',
    status: 'FORECAST',
    probability: opts.probability,
    uncertaintyInterval: {
      lower: Math.max(0, Number((opts.probability - 0.08).toFixed(4))),
      upper: Math.min(1, Number((opts.probability + 0.08).toFixed(4))),
      confidenceLevel: 0.9,
      method: 'ee06-fixture',
    },
    extremeProbabilityJustified: false,
    extremeProbabilityJustification: null,
    modelVersion: 'ee-ensemble-v1.0.0',
    configHash: 'b'.repeat(64),
    codeCommitHash: 'ee06testcommit00000000000000000000000000',
    dataSnapshotId: 'rs_ee06_001',
    baseRateVersion: 'ee-base-laplace-v1',
    ensembleVersion: 'ee-ensemble-v1.0.0',
    forecastTimestamp: opts.forecastTimestamp,
    abstentionReasons: [],
    ruleVersionId: null,
    referenceClass: null,
    componentForecastIds: [],
    ensembleMetadata: null,
    featureMetadata: { ensembleVersion: 'ee-ensemble-v1.0.0' },
  });
}

function resolveMarket(
  db: DatabaseSync,
  opts: {
    marketId: string;
    eventId: string;
    outcome: 'YES' | 'NO';
    resolvedAt: string;
  }
): void {
  transitionContractLifecycle(db, {
    marketId: opts.marketId,
    toState: 'SETTLEMENT_PENDING',
    actor: 'ee06-test',
    reason: 'Expired',
    transitionedAt: opts.resolvedAt,
  });
  transitionContractLifecycle(db, {
    marketId: opts.marketId,
    toState: 'RESOLVED',
    actor: 'ee06-test',
    reason: `Resolved ${opts.outcome}`,
    transitionedAt: opts.resolvedAt,
  });
  db.prepare(
    `INSERT INTO settlements (
      settlement_id, venue, event_ticker, market_ticker, rule_version_id,
      outcome, settlement_price_usd, settled_contracts, payout_usd,
      raw_settlement_json, settled_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    `settle_${opts.marketId}`,
    'KALSHI',
    opts.eventId,
    opts.marketId,
    null,
    opts.outcome,
    opts.outcome === 'YES' ? 1.0 : 0.0,
    10,
    opts.outcome === 'YES' ? 10.0 : 0.0,
    '{}',
    opts.resolvedAt
  );
}

/**
 * Helper to build a rich fixture ledger with settled YES/NO fills, open YES/NO fills,
 * an unpriced open position (no book snapshot), and an unfilled pending order.
 */
function buildRichPortfolioFixture(db: DatabaseSync): {
  experimentId: string;
  settledCash: number;
  asOf: string;
  config: EventEdgeConfig;
} {
  const experimentId = 'exp-ee06-portfolio';
  const settledCash = 1000;
  const config = createEventEdgeConfig({ mode: 'PAPER', shadow: { latencyMs: 250 } });
  const asOf = '2026-11-26T18:00:00.000Z';

  // --- Market 1 (KXCPI, RESOLVED YES on Nov 25): BUY_YES 10 @ 0.40 ---
  // Kalshi fee: ceil_to_cent(0.07 * 10 * 0.40 * 0.60 = 0.168) = $0.17
  // Realized payoff (YES wins, outcome = 1): 10 * (1 - 0.40) - 0.17 = 6.00 - 0.17 = +5.83
  seedMarketAndForecast(db, {
    experimentId,
    marketId: 'KXCPI-26NOV-T1',
    eventId: 'KXCPI-26NOV',
    eventFamilyId: 'KXCPI',
    probability: 0.70,
    forecastTimestamp: '2026-11-25T10:00:00.000Z',
    forecastId: 'fc_m1',
  });
  persistOrderbookState(db, {
    orderbookStateId: 'ob_m1_dec',
    marketTicker: 'KXCPI-26NOV-T1',
    bestBidUsd: 0.38,
    bestAskUsd: 0.40,
    yesBidSizeFp: 50,
    yesAskSizeFp: 50,
    capturedAt: '2026-11-25T10:00:00.000Z',
  });
  persistOrderbookState(db, {
    orderbookStateId: 'ob_m1_arr',
    marketTicker: 'KXCPI-26NOV-T1',
    bestBidUsd: 0.38,
    bestAskUsd: 0.40,
    yesBidSizeFp: 50,
    yesAskSizeFp: 50,
    capturedAt: '2026-11-25T10:00:00.300Z',
  });
  const m1Fill = executeShadowDecision(db, {
    experimentId,
    marketId: 'KXCPI-26NOV-T1',
    requestedQuantity: 10,
    config,
    decisionTimestamp: '2026-11-25T10:00:00.000Z',
  });
  assert.equal(m1Fill.fill.feeUsd, 0.17);
  resolveMarket(db, {
    marketId: 'KXCPI-26NOV-T1',
    eventId: 'KXCPI-26NOV',
    outcome: 'YES',
    resolvedAt: '2026-11-25T16:00:00.000Z',
  });

  // --- Market 2 (KXCPI, RESOLVED YES on Nov 26): BUY_NO 10 @ 0.60 (yes_bid=0.40 -> NO ask=0.60) ---
  // Kalshi fee: ceil_to_cent(0.07 * 10 * 0.60 * 0.40 = 0.168) = $0.17
  // Realized payoff (YES wins -> outcome=1 -> NO loses): 10 * ((1 - 1) - 0.60) - 0.17 = -6.17
  seedMarketAndForecast(db, {
    experimentId,
    marketId: 'KXCPI-26NOV-T2',
    eventId: 'KXCPI-26NOV-B',
    eventFamilyId: 'KXCPI',
    probability: 0.20,
    forecastTimestamp: '2026-11-26T09:00:00.000Z',
    forecastId: 'fc_m2',
  });
  persistOrderbookState(db, {
    orderbookStateId: 'ob_m2_dec',
    marketTicker: 'KXCPI-26NOV-T2',
    bestBidUsd: 0.40,
    bestAskUsd: 0.42,
    yesBidSizeFp: 50,
    yesAskSizeFp: 50,
    capturedAt: '2026-11-26T09:00:00.000Z',
  });
  persistOrderbookState(db, {
    orderbookStateId: 'ob_m2_arr',
    marketTicker: 'KXCPI-26NOV-T2',
    bestBidUsd: 0.40,
    bestAskUsd: 0.42,
    yesBidSizeFp: 50,
    yesAskSizeFp: 50,
    capturedAt: '2026-11-26T09:00:00.300Z',
  });
  const m2Fill = executeShadowDecision(db, {
    experimentId,
    marketId: 'KXCPI-26NOV-T2',
    requestedQuantity: 10,
    config,
    decisionTimestamp: '2026-11-26T09:00:00.000Z',
  });
  assert.equal(m2Fill.fill.side, 'BUY_NO');
  assert.equal(m2Fill.fill.fillPriceUsd, 0.60);
  assert.equal(m2Fill.fill.feeUsd, 0.17);
  resolveMarket(db, {
    marketId: 'KXCPI-26NOV-T2',
    eventId: 'KXCPI-26NOV-B',
    outcome: 'YES',
    resolvedAt: '2026-11-26T12:00:00.000Z',
  });

  // --- Market 3 (KXCPI, OPEN BUY_YES): filled 20 @ 0.50 on Nov 26 10:00, marked at yes_bid=0.60 at 15:00 ---
  // Fee: ceil_to_cent(0.07 * 20 * 0.50 * 0.50 = 0.35) = $0.35
  // Worst-case loss = 20 * 0.50 + 0.35 = $10.35
  // Gross unrealized = 20 * (0.60 - 0.50) = +2.00; Net unrealized = +2.00 - 0.35 = +1.65
  seedMarketAndForecast(db, {
    experimentId,
    marketId: 'KXCPI-26DEC-T3',
    eventId: 'KXCPI-26DEC',
    eventFamilyId: 'KXCPI',
    probability: 0.72,
    forecastTimestamp: '2026-11-26T10:00:00.000Z',
    forecastId: 'fc_m3',
  });
  persistOrderbookState(db, {
    orderbookStateId: 'ob_m3_dec',
    marketTicker: 'KXCPI-26DEC-T3',
    bestBidUsd: 0.48,
    bestAskUsd: 0.50,
    yesBidSizeFp: 50,
    yesAskSizeFp: 50,
    capturedAt: '2026-11-26T10:00:00.000Z',
  });
  persistOrderbookState(db, {
    orderbookStateId: 'ob_m3_arr',
    marketTicker: 'KXCPI-26DEC-T3',
    bestBidUsd: 0.48,
    bestAskUsd: 0.50,
    yesBidSizeFp: 50,
    yesAskSizeFp: 50,
    capturedAt: '2026-11-26T10:00:00.300Z',
  });
  const m3Fill = executeShadowDecision(db, {
    experimentId,
    marketId: 'KXCPI-26DEC-T3',
    requestedQuantity: 20,
    config,
    decisionTimestamp: '2026-11-26T10:00:00.000Z',
  });
  assert.equal(m3Fill.fill.feeUsd, 0.35);
  // Later mark snapshot <= asOf (and one future snapshot > asOf that MUST be ignored!)
  persistOrderbookState(db, {
    orderbookStateId: 'ob_m3_mark',
    marketTicker: 'KXCPI-26DEC-T3',
    bestBidUsd: 0.60,
    bestAskUsd: 0.62,
    yesBidSizeFp: 50,
    yesAskSizeFp: 50,
    capturedAt: '2026-11-26T15:00:00.000Z',
  });
  persistOrderbookState(db, {
    orderbookStateId: 'ob_m3_future_ignored',
    marketTicker: 'KXCPI-26DEC-T3',
    bestBidUsd: 0.99,
    bestAskUsd: 0.99,
    yesBidSizeFp: 50,
    yesAskSizeFp: 50,
    capturedAt: '2026-11-26T20:00:00.000Z',
  });

  // --- Market 4 (KXFED, OPEN BUY_NO): filled 10 @ 0.40 (yes_bid=0.60), marked at yes_ask=0.55 -> NO mark = 0.45 ---
  // Fee: ceil_to_cent(0.07 * 10 * 0.40 * 0.60 = 0.168) = $0.17
  // Worst-case loss = 10 * 0.40 + 0.17 = $4.17
  // Gross unrealized = 10 * (0.45 - 0.40) = +0.50; Net unrealized = +0.50 - 0.17 = +0.33
  seedMarketAndForecast(db, {
    experimentId,
    marketId: 'KXFED-26DEC-T4',
    eventId: 'KXFED-26DEC',
    eventFamilyId: 'KXFED',
    probability: 0.30,
    forecastTimestamp: '2026-11-26T11:00:00.000Z',
    forecastId: 'fc_m4',
  });
  persistOrderbookState(db, {
    orderbookStateId: 'ob_m4_dec',
    marketTicker: 'KXFED-26DEC-T4',
    bestBidUsd: 0.60,
    bestAskUsd: 0.62,
    yesBidSizeFp: 50,
    yesAskSizeFp: 50,
    capturedAt: '2026-11-26T11:00:00.000Z',
  });
  persistOrderbookState(db, {
    orderbookStateId: 'ob_m4_arr',
    marketTicker: 'KXFED-26DEC-T4',
    bestBidUsd: 0.60,
    bestAskUsd: 0.62,
    yesBidSizeFp: 50,
    yesAskSizeFp: 50,
    capturedAt: '2026-11-26T11:00:00.300Z',
  });
  const m4Fill = executeShadowDecision(db, {
    experimentId,
    marketId: 'KXFED-26DEC-T4',
    requestedQuantity: 10,
    config,
    decisionTimestamp: '2026-11-26T11:00:00.000Z',
  });
  assert.equal(m4Fill.fill.side, 'BUY_NO');
  assert.equal(m4Fill.fill.fillPriceUsd, 0.40);
  assert.equal(m4Fill.fill.feeUsd, 0.17);
  persistOrderbookState(db, {
    orderbookStateId: 'ob_m4_mark',
    marketTicker: 'KXFED-26DEC-T4',
    bestBidUsd: 0.53,
    bestAskUsd: 0.55, // NO mark = 1 - 0.55 = 0.45
    yesBidSizeFp: 50,
    yesAskSizeFp: 50,
    capturedAt: '2026-11-26T16:00:00.000Z',
  });

  // --- Market 5 (KXFED, OPEN BUY_YES with NO book snapshot <= asOf -> marked at fill price & flagged) ---
  // 5 contracts @ 0.50, fee $0.09 -> worstCaseLoss = $2.59; markPrice = 0.50 (fallback); net unrealized = -0.09
  seedMarketAndForecast(db, {
    experimentId,
    marketId: 'KXFED-UNPRICED-T5',
    eventId: 'KXFED-UNPRICED',
    eventFamilyId: 'KXFED',
    probability: 0.75,
    forecastTimestamp: '2026-11-26T13:00:00.000Z',
    forecastId: 'fc_m5',
  });
  db.prepare(
    `INSERT INTO shadow_decisions (
      decision_id, forecast_id, forecast_stage, experiment_id, market_id,
      model_probability, decision_timestamp, decision_book_snapshot_id, decision_book_captured_at,
      decision_yes_bid_usd, decision_yes_ask_usd, edge_yes, edge_no, selected_edge,
      min_conservative_edge, outcome, side, requested_quantity, config_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'sdec_m5',
    'fc_m5',
    'p_ensemble',
    experimentId,
    'KXFED-UNPRICED-T5',
    0.75,
    '2026-11-26T13:00:00.000Z',
    'ob_m5_missing',
    '2026-11-26T13:00:00.000Z',
    0.48,
    0.50,
    0.25,
    -0.27,
    0.25,
    0.04,
    'ORDER_CREATED',
    'BUY_YES',
    5,
    'b'.repeat(64)
  );
  db.prepare(
    `INSERT INTO shadow_orders (
      order_id, decision_id, experiment_id, forecast_id, market_id,
      side, requested_quantity, decision_price_usd, decision_book_snapshot_id,
      decision_timestamp, latency_model_version, latency_ms, arrival_timestamp, config_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'sord_m5',
    'sdec_m5',
    experimentId,
    'fc_m5',
    'KXFED-UNPRICED-T5',
    'BUY_YES',
    5,
    0.50,
    'ob_m5_missing',
    '2026-11-26T13:00:00.000Z',
    'ee-latency-fixed-v1',
    250,
    '2026-11-26T13:00:00.250Z',
    'b'.repeat(64)
  );
  db.prepare(
    `INSERT INTO shadow_fills (
      fill_id, order_id, decision_id, experiment_id, market_id,
      status, side, requested_quantity, filled_quantity, unfilled_quantity,
      fill_price_usd, fee_usd, fee_schedule_version,
      decision_book_snapshot_id, arrival_book_snapshot_id, arrival_book_captured_at,
      displayed_depth_at_price, book_age_ms, evaluated_at, reason_code, config_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'sfil_m5',
    'sord_m5',
    'sdec_m5',
    experimentId,
    'KXFED-UNPRICED-T5',
    'FILLED',
    'BUY_YES',
    5,
    5,
    0,
    0.50,
    0.09,
    'kalshi-taker-v1',
    'ob_m5_missing',
    'ob_m5_arr_missing',
    '2026-11-26T13:00:00.250Z',
    10,
    0,
    '2026-11-26T13:00:00.250Z',
    null,
    'b'.repeat(64)
  );

  // --- Market 6 (KXCPI, PENDING unfilled order: 10 @ 0.50, estimated fee $0.18 -> pendingExposure = $5.18) ---
  seedMarketAndForecast(db, {
    experimentId,
    marketId: 'KXCPI-PENDING-T6',
    eventId: 'KXCPI-PENDING',
    eventFamilyId: 'KXCPI',
    probability: 0.70,
    forecastTimestamp: '2026-11-26T17:00:00.000Z',
    forecastId: 'fc_m6',
  });
  db.prepare(
    `INSERT INTO shadow_decisions (
      decision_id, forecast_id, forecast_stage, experiment_id, market_id,
      model_probability, decision_timestamp, decision_book_snapshot_id, decision_book_captured_at,
      decision_yes_bid_usd, decision_yes_ask_usd, edge_yes, edge_no, selected_edge,
      min_conservative_edge, outcome, side, requested_quantity, config_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'sdec_m6',
    'fc_m6',
    'p_ensemble',
    experimentId,
    'KXCPI-PENDING-T6',
    0.70,
    '2026-11-26T17:00:00.000Z',
    'ob_m6_dec',
    '2026-11-26T17:00:00.000Z',
    0.48,
    0.50,
    0.20,
    -0.22,
    0.20,
    0.04,
    'ORDER_CREATED',
    'BUY_YES',
    10,
    'b'.repeat(64)
  );
  db.prepare(
    `INSERT INTO shadow_orders (
      order_id, decision_id, experiment_id, forecast_id, market_id,
      side, requested_quantity, decision_price_usd, decision_book_snapshot_id,
      decision_timestamp, latency_model_version, latency_ms, arrival_timestamp, config_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'sord_m6',
    'sdec_m6',
    experimentId,
    'fc_m6',
    'KXCPI-PENDING-T6',
    'BUY_YES',
    10,
    0.50,
    'ob_m6_dec',
    '2026-11-26T17:00:00.000Z',
    'ee-latency-fixed-v1',
    250,
    '2026-11-26T17:00:00.250Z',
    'b'.repeat(64)
  );

  return { experimentId, settledCash, asOf, config };
}

function makeSyntheticState(overrides: Partial<PortfolioState> = {}): PortfolioState {
  const defaultCfg = createEventEdgeConfig({ mode: 'PAPER' });
  const settledCash = overrides.settledCash ?? 10_000;
  return Object.freeze({
    experimentId: 'exp-synthetic',
    asOf: '2026-11-26T16:00:00.000Z',
    dayBoundaryTimezone: 'UTC' as const,
    dayStartUtc: '2026-11-26T00:00:00.000Z',
    equitySamplingPolicy:
      'Sampled deterministically at genesis (settledCash), each executed shadow fill, each contract resolution, each captured book mark for open positions, and asOf (all <= asOf).' as const,
    settledCash,
    realizedPnl: 0,
    unrealizedPnl: 0,
    currentEquity: settledCash,
    openPositions: Object.freeze([]),
    unpricedPositionMarketIds: Object.freeze([]),
    totalOpenWorstCaseLoss: 0,
    exposureByMarket: Object.freeze({}),
    exposureByEvent: Object.freeze({}),
    exposureByEventFamily: Object.freeze({}),
    pendingOrders: Object.freeze([]),
    pendingExposure: 0,
    pendingExposureByMarket: Object.freeze({}),
    pendingExposureByEvent: Object.freeze({}),
    pendingExposureByEventFamily: Object.freeze({}),
    deployedPct: 0,
    dailyPnl: 0,
    dailyLossPct: 0,
    peakEquity: settledCash,
    drawdownPct: 0,
    equitySeries: Object.freeze([]),
    systemState: 'HEALTHY' as const,
    riskConfig: defaultCfg.risk,
    ...overrides,
  });
}

console.log('\n=== EventEdge EE-06 Verification Suite ===\n');

// ---------------------------------------------------------------------------
// Migration v7 & genesis state sanity check
// ---------------------------------------------------------------------------
test('Migration v7 creates risk_state_history with recorded genesis HEALTHY row', () => {
  const { db, cleanup } = makeTempDb('schema-v7');
  try {
    const applied = getAppliedMigrations(db);
    assert.equal(applied.length, EVENTEDGE_MIGRATIONS.length);
    assert.ok(applied.some((m) => m.version === 7 && m.name === '007_ee06_risk_state_history'));
    assert.ok(EVENTEDGE_LEDGER_TABLES.includes('risk_state_history'));

    const history = getRiskSystemStateHistory(db);
    assert.equal(history.length, 1);
    assert.equal(history[0].fromState, null);
    assert.equal(history[0].toState, 'HEALTHY');
    assert.equal(history[0].reason, 'GENESIS_INITIAL_STATE');
    assert.equal(getCurrentRiskSystemState(db), 'HEALTHY');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (a) Portfolio state builder: exact hand-computed metrics + read-only guarantee
// ---------------------------------------------------------------------------
test('(a) State builder: settled + open fills reproduce hand-computed realized, unrealized, worst-case, family exposure, pending, deployedPct, UTC dailyPnl & drawdown', () => {
  const { db, cleanup } = makeTempDb('state-builder');
  try {
    const { experimentId, settledCash, asOf, config } = buildRichPortfolioFixture(db);

    const rowCountsBefore = db
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM shadow_decisions) AS d,
          (SELECT COUNT(*) FROM shadow_orders) AS o,
          (SELECT COUNT(*) FROM shadow_fills) AS f,
          (SELECT COUNT(*) FROM risk_state_history) AS r,
          (SELECT COUNT(*) FROM realized_pnl) AS rp,
          (SELECT COUNT(*) FROM unrealized_pnl) AS up`
      )
      .get();

    const state = buildPortfolioState(db, experimentId, asOf, { settledCash, config });

    // Confirm read-only: zero writes to any table
    const rowCountsAfter = db
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM shadow_decisions) AS d,
          (SELECT COUNT(*) FROM shadow_orders) AS o,
          (SELECT COUNT(*) FROM shadow_fills) AS f,
          (SELECT COUNT(*) FROM risk_state_history) AS r,
          (SELECT COUNT(*) FROM realized_pnl) AS rp,
          (SELECT COUNT(*) FROM unrealized_pnl) AS up`
      )
      .get();
    assert.deepEqual(rowCountsAfter, rowCountsBefore);

    assert.equal(state.settledCash, 1000);
    assert.equal(state.dayBoundaryTimezone, 'UTC');
    assert.equal(state.dayStartUtc, '2026-11-26T00:00:00.000Z');
    assert.equal(state.systemState, 'HEALTHY');

    // Realized PnL: M1 (+5.83) + M2 (-6.17) = -0.34
    assert.ok(Math.abs(state.realizedPnl - -0.34) < 1e-9, `expected -0.34, got ${state.realizedPnl}`);

    // Open positions: M3 (BUY_YES 20 @ 0.50, fee 0.35, wcl 10.35, mark 0.60, net upnl +1.65)
    //                 M4 (BUY_NO 10 @ 0.40, fee 0.17, wcl 4.17, mark 0.45, net upnl +0.33)
    //                 M5 (BUY_YES 5 @ 0.50, fee 0.09, wcl 2.59, mark 0.50 fallback, net upnl -0.09)
    assert.equal(state.openPositions.length, 3);
    const m3 = state.openPositions.find((p) => p.marketId === 'KXCPI-26DEC-T3')!;
    const m4 = state.openPositions.find((p) => p.marketId === 'KXFED-26DEC-T4')!;
    const m5 = state.openPositions.find((p) => p.marketId === 'KXFED-UNPRICED-T5')!;

    assert.equal(m3.quantity, 20);
    assert.equal(m3.averageFillPrice, 0.5);
    assert.equal(m3.totalFees, 0.35);
    assert.equal(m3.worstCaseLoss, 10.35);
    assert.equal(m3.markPrice, 0.6); // yes_bid from ob_m3_mark (future snapshot ignored!)
    assert.equal(m3.markedAtFillPriceFallback, false);
    assert.ok(Math.abs(m3.grossUnrealizedPnl - 2.0) < 1e-9);
    assert.ok(Math.abs(m3.unrealizedPnl - 1.65) < 1e-9);

    assert.equal(m4.quantity, 10);
    assert.equal(m4.averageFillPrice, 0.4);
    assert.equal(m4.totalFees, 0.17);
    assert.equal(m4.worstCaseLoss, 4.17);
    assert.equal(m4.markPrice, 0.45); // 1 - yes_ask (1 - 0.55)
    assert.equal(m4.markedAtFillPriceFallback, false);
    assert.ok(Math.abs(m4.grossUnrealizedPnl - 0.5) < 1e-9);
    assert.ok(Math.abs(m4.unrealizedPnl - 0.33) < 1e-9);

    assert.equal(m5.quantity, 5);
    assert.equal(m5.averageFillPrice, 0.5);
    assert.equal(m5.totalFees, 0.09);
    assert.equal(m5.worstCaseLoss, 2.59);
    assert.equal(m5.markPrice, 0.5); // fallback to fill price
    assert.equal(m5.markedAtFillPriceFallback, true);
    assert.deepEqual([...state.unpricedPositionMarketIds], ['KXFED-UNPRICED-T5']);

    // Total unrealized PnL: 1.65 + 0.33 - 0.09 = +1.89
    assert.ok(
      Math.abs(state.unrealizedPnl - 1.89) < 1e-9,
      `expected 1.89, got ${state.unrealizedPnl}`
    );

    // Exposure by event family: KXCPI = 10.35; KXFED = 4.17 + 2.59 = 6.76
    assert.ok(Math.abs(state.exposureByEventFamily.KXCPI - 10.35) < 1e-9);
    assert.ok(Math.abs(state.exposureByEventFamily.KXFED - 6.76) < 1e-9);

    // Total open worst-case loss = 10.35 + 4.17 + 2.59 = 17.11 -> deployedPct = 17.11 / 1000 = 0.01711
    assert.ok(Math.abs(state.totalOpenWorstCaseLoss - 17.11) < 1e-9);
    assert.ok(Math.abs(state.deployedPct - 0.01711) < 1e-9);

    // Pending exposure: M6 (10 @ 0.50 + 0.18 fee = 5.18)
    assert.equal(state.pendingOrders.length, 1);
    assert.ok(Math.abs(state.pendingExposure - 5.18) < 1e-9);

    // Daily PnL (UTC Nov 26):
    // Before 2026-11-26T00:00:00.000Z: M1 already resolved (+5.83), no open positions -> totalPnlBefore = +5.83
    // At asOf: realized (-0.34) + unrealized (+1.89) = +1.55
    // Daily PnL = 1.55 - 5.83 = -4.28 -> dailyLossPct = 4.28 / 1000 = 0.00428
    assert.ok(Math.abs(state.dailyPnl - -4.28) < 1e-9, `expected -4.28, got ${state.dailyPnl}`);
    assert.ok(Math.abs(state.dailyLossPct - 0.00428) < 1e-9);

    // Peak equity & drawdown:
    // After M1 resolves on Nov 25 16:00 -> equity = 1005.83 (peak!)
    // At asOf -> currentEquity = 1000 - 0.34 + 1.89 = 1001.55
    // Drawdown = (1005.83 - 1001.55) / 1005.83
    assert.ok(Math.abs(state.peakEquity - 1005.83) < 1e-9, `expected peak 1005.83, got ${state.peakEquity}`);
    assert.ok(Math.abs(state.currentEquity - 1001.55) < 1e-9);
    const expectedDrawdown = (1005.83 - 1001.55) / 1005.83;
    assert.ok(Math.abs(state.drawdownPct - expectedDrawdown) < 1e-9);
    assert.ok(state.equitySeries.length >= 6);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (b) Limit checks: exact cap approved, +epsilon rejected for all 4 caps
// ---------------------------------------------------------------------------
test('(b) Limits: exact cap approved & +epsilon rejected with exact code for POSITION_CAP, EVENT_RISK_CAP, CORRELATED_CAP, DEPLOYED_CAP', () => {
  const eps = 1e-4;

  // 1. POSITION_CAP: configure position cap (0.01 = $100) below event (0.02), correlated (0.05), deployed (0.10)
  const posCfg = createEventEdgeConfig({
    mode: 'PAPER',
    risk: {
      perPositionSettledCashCapPct: 0.01,
      perEventBankrollRiskCapPct: 0.02,
      correlatedEventExposureCapPct: 0.05,
      maxDeployedBankrollPct: 0.10,
    },
  });
  const posState = makeSyntheticState({ settledCash: 10_000, riskConfig: posCfg.risk });
  const posExact = evaluateRisk(posState, {
    marketId: 'MKT-POS-1',
    eventFamilyId: 'FAM-POS',
    side: 'BUY_YES',
    quantity: 200,
    price: 0.50,
    fee: 0, // worstCaseLoss = $100.00 exact
  });
  assert.equal(posExact.decision, 'APPROVED');
  assert.equal(posExact.approved, true);
  assert.deepEqual([...posExact.reasons], []);

  const posOver = evaluateRisk(posState, {
    marketId: 'MKT-POS-1',
    eventFamilyId: 'FAM-POS',
    side: 'BUY_YES',
    quantity: 200,
    price: 0.50,
    fee: eps, // $100.0001 > $100
  });
  assert.equal(posOver.decision, 'REJECTED');
  assert.deepEqual([...posOver.reasons], ['POSITION_CAP']);

  // 2. EVENT_RISK_CAP: default EE-00 risk config ($10,000 * 0.005 = $50.00)
  const defaultState = makeSyntheticState({ settledCash: 10_000 });
  const eventExact = evaluateRisk(defaultState, {
    marketId: 'MKT-EVT-1',
    eventFamilyId: 'FAM-EVT',
    side: 'BUY_YES',
    quantity: 100,
    price: 0.50,
    fee: 0, // $50.00 exact
  });
  assert.equal(eventExact.decision, 'APPROVED');
  assert.deepEqual([...eventExact.reasons], []);

  const eventOver = evaluateRisk(defaultState, {
    marketId: 'MKT-EVT-1',
    eventFamilyId: 'FAM-EVT',
    side: 'BUY_YES',
    quantity: 100,
    price: 0.50,
    fee: eps, // $50.0001 > $50
  });
  assert.equal(eventOver.decision, 'REJECTED');
  assert.deepEqual([...eventOver.reasons], ['EVENT_RISK_CAP']);

  // 3. CORRELATED_CAP: default 1.5% ($150); existing exposure on family FAM-CORR = $120 across other events -> $30 remaining
  const corrState = makeSyntheticState({
    settledCash: 10_000,
    exposureByEventFamily: Object.freeze({ 'FAM-CORR': 120 }),
    totalOpenWorstCaseLoss: 120,
  });
  const corrExact = evaluateRisk(corrState, {
    marketId: 'MKT-CORR-NEW',
    eventFamilyId: 'FAM-CORR',
    side: 'BUY_YES',
    quantity: 60,
    price: 0.50,
    fee: 0, // 120 + 30 = $150 exact (below $50 event cap & $1000 deployed cap)
  });
  assert.equal(corrExact.decision, 'APPROVED');
  assert.deepEqual([...corrExact.reasons], []);

  const corrOver = evaluateRisk(corrState, {
    marketId: 'MKT-CORR-NEW',
    eventFamilyId: 'FAM-CORR',
    side: 'BUY_YES',
    quantity: 60,
    price: 0.50,
    fee: eps, // 120 + 30.0001 > $150
  });
  assert.equal(corrOver.decision, 'REJECTED');
  assert.deepEqual([...corrOver.reasons], ['CORRELATED_CAP']);

  // 4. DEPLOYED_CAP: default 10% ($1,000); existing open exposure = $970 across unrelated families -> $30 remaining
  const depState = makeSyntheticState({
    settledCash: 10_000,
    totalOpenWorstCaseLoss: 970,
    deployedPct: 0.097,
  });
  const depExact = evaluateRisk(depState, {
    marketId: 'MKT-DEP-NEW',
    eventFamilyId: 'FAM-FRESH',
    side: 'BUY_YES',
    quantity: 60,
    price: 0.50,
    fee: 0, // 970 + 30 = $1,000 exact
  });
  assert.equal(depExact.decision, 'APPROVED');
  assert.deepEqual([...depExact.reasons], []);

  const depOver = evaluateRisk(depState, {
    marketId: 'MKT-DEP-NEW',
    eventFamilyId: 'FAM-FRESH',
    side: 'BUY_YES',
    quantity: 60,
    price: 0.50,
    fee: eps, // 970 + 30.0001 > $1,000
  });
  assert.equal(depOver.decision, 'REJECTED');
  assert.deepEqual([...depOver.reasons], ['DEPLOYED_CAP']);
});

// ---------------------------------------------------------------------------
// (c) Sizing: hand-computed Kelly, EVENT_RISK_CAP binding below Kelly, zero/negative edge
// ---------------------------------------------------------------------------
test('(c) Sizing: hand-computed Kelly quantity, per-event cap binding below Kelly, and 0 on zero/negative edge', () => {
  const state = makeSyntheticState({ settledCash: 10_000 }); // default EE-00 risk config

  // Case 1: Kelly binds cleanly below all caps
  // p = 0.52, price = 0.50, feePerContract = 0.02
  // f = (0.52 - 0.50) / (1 - 0.50) = 0.04
  // stake = 0.10 * 0.04 * 10000 = $40.00
  // kellyQty = floor(40 / 0.50) = 80
  // eventCap = $50 -> floor(50 / 0.52) = 96 -> Kelly (80) < eventCap (96)
  const kellyBreakdown = computeMaxQuantityBreakdown(state, {
    marketId: 'MKT-KELLY-1',
    eventFamilyId: 'FAM-KELLY',
    side: 'BUY_YES',
    price: 0.50,
    feePerContract: 0.02,
    modelProbability: 0.52,
  });
  assert.ok(Math.abs(kellyBreakdown.kellyFraction - 0.04) < 1e-12);
  assert.ok(Math.abs(kellyBreakdown.kellyStakeUsd - 40) < 1e-9);
  assert.equal(kellyBreakdown.kellyQuantity, 80);
  assert.equal(kellyBreakdown.eventCapQuantity, 96);
  assert.equal(kellyBreakdown.maxQuantity, 80);
  assert.equal(kellyBreakdown.bindingConstraint, 'KELLY');
  assert.equal(
    computeMaxQuantity(state, {
      marketId: 'MKT-KELLY-1',
      eventFamilyId: 'FAM-KELLY',
      side: 'BUY_YES',
      price: 0.50,
      feePerContract: 0.02,
      modelProbability: 0.52,
    }),
    80
  );

  // Case 2: Per-event cap ($50 -> 96 contracts) binds strictly below Kelly (800 contracts)
  // p = 0.70, price = 0.50, feePerContract = 0.02
  // f = (0.70 - 0.50) / 0.50 = 0.40 -> stake = $400 -> kellyQty = 800
  // eventCapQty = floor(50 / 0.52) = 96 -> EVENT_RISK_CAP binds!
  const capBreakdown = computeMaxQuantityBreakdown(state, {
    marketId: 'MKT-CAP-1',
    eventFamilyId: 'FAM-CAP',
    side: 'BUY_YES',
    price: 0.50,
    feePerContract: 0.02,
    modelProbability: 0.70,
  });
  assert.equal(capBreakdown.kellyQuantity, 800);
  assert.equal(capBreakdown.eventCapQuantity, 96);
  assert.equal(capBreakdown.maxQuantity, 96);
  assert.equal(capBreakdown.bindingConstraint, 'EVENT_RISK_CAP');

  // Case 3: Zero edge (p == price) -> quantity 0
  assert.equal(
    computeMaxQuantity(state, {
      marketId: 'MKT-ZERO-EDGE',
      eventFamilyId: 'FAM-ZERO',
      side: 'BUY_YES',
      price: 0.50,
      feePerContract: 0.02,
      modelProbability: 0.50,
    }),
    0
  );

  // Case 4: Negative edge (p < price for BUY_YES, and 1 - p < price for BUY_NO) -> quantity 0
  assert.equal(
    computeMaxQuantity(state, {
      marketId: 'MKT-NEG-YES',
      eventFamilyId: 'FAM-NEG',
      side: 'BUY_YES',
      price: 0.55,
      feePerContract: 0.02,
      modelProbability: 0.40,
    }),
    0
  );
  assert.equal(
    computeMaxQuantity(state, {
      marketId: 'MKT-NEG-NO',
      eventFamilyId: 'FAM-NEG',
      side: 'BUY_NO',
      price: 0.60, // requires P(NO) = 1 - p > 0.60, i.e., p < 0.40
      feePerContract: 0.02,
      modelProbability: 0.50, // P(NO) = 0.50 < 0.60 -> negative edge
    }),
    0
  );
});

// ---------------------------------------------------------------------------
// (d) Stops: daily loss stop & drawdown stop -> HALTED + SYSTEM_STATE + stop context
// ---------------------------------------------------------------------------
test('(d) Stops: dailyLossPct and drawdownPct at stops trigger HALTED and reject with SYSTEM_STATE + stop reason', () => {
  // 1. Daily loss stop (0.02)
  const dbDaily = makeTempDb('daily-stop');
  try {
    const evalDaily = evaluateSystemState({
      ledgerIntegrityOk: true,
      dataFresh: true,
      dailyLossPct: 0.02,
      drawdownPct: 0.01,
      reconciliationPending: false,
    });
    assert.equal(evalDaily.state, 'HALTED');
    assert.match(evalDaily.reason, /DAILY_LOSS_STOP/);

    const applied = applySystemStateEvaluation(
      dbDaily.db,
      {
        ledgerIntegrityOk: true,
        dataFresh: true,
        dailyLossPct: 0.02,
        drawdownPct: 0.01,
        reconciliationPending: false,
      },
      { recordedAt: '2026-11-26T12:00:00.000Z' }
    );
    assert.equal(applied.currentState, 'HALTED');
    assert.equal(applied.transitioned, true);

    const haltedDailyState = makeSyntheticState({
      systemState: getCurrentRiskSystemState(dbDaily.db),
      dailyPnl: -200,
      dailyLossPct: 0.02,
    });
    const riskRes = evaluateRisk(haltedDailyState, {
      marketId: 'MKT-1',
      eventFamilyId: 'FAM-1',
      side: 'BUY_YES',
      quantity: 1,
      price: 0.50,
      fee: 0.02,
    });
    assert.equal(riskRes.decision, 'REJECTED');
    assert.ok(riskRes.reasons.includes('SYSTEM_STATE'));
    assert.ok(riskRes.reasons.includes('DAILY_LOSS_STOP'));
    assert.equal(
      computeMaxQuantity(haltedDailyState, {
        marketId: 'MKT-1',
        eventFamilyId: 'FAM-1',
        side: 'BUY_YES',
        price: 0.50,
        feePerContract: 0.02,
        modelProbability: 0.70,
      }),
      0
    );
  } finally {
    dbDaily.cleanup();
  }

  // 2. Peak-to-trough drawdown stop (0.08)
  const dbDd = makeTempDb('drawdown-stop');
  try {
    const evalDd = evaluateSystemState({
      ledgerIntegrityOk: true,
      dataFresh: true,
      dailyLossPct: 0.005,
      drawdownPct: 0.08,
      reconciliationPending: false,
    });
    assert.equal(evalDd.state, 'HALTED');
    assert.match(evalDd.reason, /DRAWDOWN_STOP/);

    const applied = applySystemStateEvaluation(
      dbDd.db,
      {
        ledgerIntegrityOk: true,
        dataFresh: true,
        dailyLossPct: 0.005,
        drawdownPct: 0.08,
        reconciliationPending: false,
      },
      { recordedAt: '2026-11-26T12:00:00.000Z' }
    );
    assert.equal(applied.currentState, 'HALTED');

    const haltedDdState = makeSyntheticState({
      systemState: getCurrentRiskSystemState(dbDd.db),
      drawdownPct: 0.08,
    });
    const riskRes = evaluateRisk(haltedDdState, {
      marketId: 'MKT-2',
      eventFamilyId: 'FAM-2',
      side: 'BUY_YES',
      quantity: 1,
      price: 0.50,
      fee: 0.02,
    });
    assert.equal(riskRes.decision, 'REJECTED');
    assert.ok(riskRes.reasons.includes('SYSTEM_STATE'));
    assert.ok(riskRes.reasons.includes('DRAWDOWN_STOP'));
    assert.equal(
      computeMaxQuantity(haltedDdState, {
        marketId: 'MKT-2',
        eventFamilyId: 'FAM-2',
        side: 'BUY_YES',
        price: 0.50,
        feePerContract: 0.02,
        modelProbability: 0.70,
      }),
      0
    );
  } finally {
    dbDd.cleanup();
  }
});

// ---------------------------------------------------------------------------
// (e) Quarantine & Reconciliation: fail-closed + ordered operator recovery
// ---------------------------------------------------------------------------
test('(e) Quarantine/Reconciliation: stale data & integrity failure fail closed; direct jump to HEALTHY rejected; ordered recovery succeeds', () => {
  // 1. Stale data -> DATA_QUARANTINE
  const dbQ = makeTempDb('quarantine');
  try {
    const qApplied = applySystemStateEvaluation(
      dbQ.db,
      {
        ledgerIntegrityOk: true,
        dataFresh: false,
        dailyLossPct: 0,
        drawdownPct: 0,
        reconciliationPending: false,
      },
      { recordedAt: '2026-11-26T13:00:00.000Z' }
    );
    assert.equal(qApplied.currentState, 'DATA_QUARANTINE');

    // Fails closed in evaluateRisk and computeMaxQuantity
    const qState = makeSyntheticState({ systemState: getCurrentRiskSystemState(dbQ.db) });
    assert.deepEqual(
      [
        ...evaluateRisk(qState, {
          marketId: 'MKT-Q',
          eventFamilyId: 'FAM-Q',
          side: 'BUY_YES',
          quantity: 1,
          price: 0.50,
          fee: 0,
        }).reasons,
      ],
      ['SYSTEM_STATE']
    );
    assert.equal(
      computeMaxQuantity(qState, {
        marketId: 'MKT-Q',
        eventFamilyId: 'FAM-Q',
        side: 'BUY_YES',
        price: 0.50,
        feePerContract: 0,
        modelProbability: 0.80,
      }),
      0
    );

    // Attempted direct jump DATA_QUARANTINE -> HEALTHY is strictly rejected
    assert.throws(
      () =>
        transitionRiskSystemState(dbQ.db, {
          toState: 'HEALTHY',
          actor: 'ops-alice',
          reason: 'Attempted direct bypass',
          recordedAt: '2026-11-26T13:05:00.000Z',
        }),
      IllegalRiskStateTransitionError
    );
    assert.throws(
      () =>
        completeOperatorClearance(dbQ.db, {
          actor: 'ops-alice',
          reason: 'Clearance before recovery',
          recordedAt: '2026-11-26T13:05:00.000Z',
        }),
      IllegalRiskStateTransitionError
    );

    // Step 1: operator recovery -> RECOVERY_PENDING (still fails closed!)
    const recRow = initiateOperatorRecovery(dbQ.db, {
      actor: 'ops-alice',
      reason: 'Feed restored; verifying snapshots',
      recordedAt: '2026-11-26T13:10:00.000Z',
    });
    assert.equal(recRow.fromState, 'DATA_QUARANTINE');
    assert.equal(recRow.toState, 'RECOVERY_PENDING');
    assert.equal(getCurrentRiskSystemState(dbQ.db), 'RECOVERY_PENDING');

    const pendingState = makeSyntheticState({ systemState: 'RECOVERY_PENDING' });
    assert.equal(
      evaluateRisk(pendingState, {
        marketId: 'MKT-Q',
        eventFamilyId: 'FAM-Q',
        side: 'BUY_YES',
        quantity: 1,
        price: 0.50,
        fee: 0,
      }).decision,
      'REJECTED'
    );

    // Step 2: operator clearance -> HEALTHY
    const clearRow = completeOperatorClearance(dbQ.db, {
      actor: 'ops-bob',
      reason: 'Data freshness verified across 3 consecutive cycles',
      recordedAt: '2026-11-26T13:15:00.000Z',
    });
    assert.equal(clearRow.fromState, 'RECOVERY_PENDING');
    assert.equal(clearRow.toState, 'HEALTHY');
    assert.equal(getCurrentRiskSystemState(dbQ.db), 'HEALTHY');
  } finally {
    dbQ.cleanup();
  }

  // 2. Integrity failure -> RECONCILIATION_REQUIRED
  const dbR = makeTempDb('reconciliation');
  try {
    const rApplied = applySystemStateEvaluation(
      dbR.db,
      {
        ledgerIntegrityOk: false,
        dataFresh: true,
        dailyLossPct: 0,
        drawdownPct: 0,
        reconciliationPending: false,
      },
      { recordedAt: '2026-11-26T14:00:00.000Z' }
    );
    assert.equal(rApplied.currentState, 'RECONCILIATION_REQUIRED');

    // Direct jump RECONCILIATION_REQUIRED -> HEALTHY rejected
    assert.throws(
      () =>
        transitionRiskSystemState(dbR.db, {
          toState: 'HEALTHY',
          actor: 'ops-alice',
          reason: 'Direct jump attempt',
          recordedAt: '2026-11-26T14:05:00.000Z',
        }),
      IllegalRiskStateTransitionError
    );

    // Ordered recovery -> RECOVERY_PENDING -> HEALTHY
    initiateOperatorRecovery(dbR.db, {
      actor: 'ops-alice',
      reason: 'Reconciling shadow fills against snapshots',
      recordedAt: '2026-11-26T14:10:00.000Z',
    });
    assert.equal(getCurrentRiskSystemState(dbR.db), 'RECOVERY_PENDING');

    completeOperatorClearance(dbR.db, {
      actor: 'ops-bob',
      reason: 'Ledger integrity checksum verified',
      recordedAt: '2026-11-26T14:15:00.000Z',
    });
    assert.equal(getCurrentRiskSystemState(dbR.db), 'HEALTHY');
  } finally {
    dbR.cleanup();
  }
});

// ---------------------------------------------------------------------------
// (f) HALTED has NO auto-reset
// ---------------------------------------------------------------------------
test('(f) HALTED has no auto-reset: time passing & cleared daily loss do not restore HEALTHY; only operator reset does', () => {
  const { db, cleanup } = makeTempDb('halted-no-autoreset');
  try {
    applySystemStateEvaluation(
      db,
      {
        ledgerIntegrityOk: true,
        dataFresh: true,
        dailyLossPct: 0.025,
        drawdownPct: 0.025,
        reconciliationPending: false,
      },
      { recordedAt: '2026-11-26T15:00:00.000Z' }
    );
    assert.equal(getCurrentRiskSystemState(db), 'HALTED');

    // Next UTC day arrives: dailyLossPct = 0, drawdownPct = 0, everything fresh & healthy
    const nextDayEval = applySystemStateEvaluation(
      db,
      {
        ledgerIntegrityOk: true,
        dataFresh: true,
        dailyLossPct: 0,
        drawdownPct: 0,
        reconciliationPending: false,
      },
      { recordedAt: '2026-11-27T01:00:00.000Z' }
    );
    assert.equal(nextDayEval.evaluatedState, 'HEALTHY');
    assert.equal(nextDayEval.currentState, 'HALTED');
    assert.equal(nextDayEval.transitioned, false);
    assert.equal(nextDayEval.blockedAutoReset, true);
    assert.equal(getCurrentRiskSystemState(db), 'HALTED');

    // Explicit operator reset restores HEALTHY and logs actor + reason
    const resetRow = operatorResetFromHalted(db, {
      actor: 'risk-officer-skyler',
      reason: 'Post-mortem complete; approved paper restart for Nov 27 session',
      recordedAt: '2026-11-27T02:00:00.000Z',
    });
    assert.equal(resetRow.fromState, 'HALTED');
    assert.equal(resetRow.toState, 'HEALTHY');
    assert.equal(resetRow.actor, 'risk-officer-skyler');
    assert.match(resetRow.reason, /Post-mortem complete/);
    assert.equal(getCurrentRiskSystemState(db), 'HEALTHY');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (g) DEGRADED halves max quantity (integer floor)
// ---------------------------------------------------------------------------
test('(g) DEGRADED halves max quantity via integer floor while still allowing approved risk checks', () => {
  const healthyState = makeSyntheticState({ settledCash: 10_000, systemState: 'HEALTHY' });
  const degradedState = makeSyntheticState({ settledCash: 10_000, systemState: 'DEGRADED' });

  // Even raw quantity: 80 -> 40
  const evenInput = {
    marketId: 'MKT-DEG-EVEN',
    eventFamilyId: 'FAM-DEG',
    side: 'BUY_YES' as const,
    price: 0.50,
    feePerContract: 0.02,
    modelProbability: 0.52, // Kelly = 80
  };
  assert.equal(computeMaxQuantity(healthyState, evenInput), 80);
  const degradedEven = computeMaxQuantityBreakdown(degradedState, evenInput);
  assert.equal(degradedEven.rawMaxQuantity, 80);
  assert.equal(degradedEven.maxQuantity, 40);
  assert.equal(degradedEven.degradedHalved, true);
  assert.equal(degradedEven.bindingConstraint, 'DEGRADED_HALF');

  // Odd raw quantity: floor(50 / 0.51) = 98? Let's pick fee = 0.015 -> floor(50 / 0.515) = 97 -> floor(97 / 2) = 48
  const oddInput = {
    marketId: 'MKT-DEG-ODD',
    eventFamilyId: 'FAM-DEG',
    side: 'BUY_YES' as const,
    price: 0.50,
    feePerContract: 0.015,
    modelProbability: 0.70, // eventCap = floor(50 / 0.515) = 97
  };
  assert.equal(computeMaxQuantity(healthyState, oddInput), 97);
  assert.equal(computeMaxQuantity(degradedState, oddInput), 48); // Math.floor(97 / 2) === 48

  // evaluateRisk still allows valid proposals within caps in DEGRADED
  const riskCheck = evaluateRisk(degradedState, {
    marketId: 'MKT-DEG-ODD',
    eventFamilyId: 'FAM-DEG',
    side: 'BUY_YES',
    quantity: 48,
    price: 0.50,
    fee: 0.72,
  });
  assert.equal(riskCheck.decision, 'APPROVED');
});

// ---------------------------------------------------------------------------
// (h) Append-only: raw SQL UPDATE & DELETE on risk_state_history abort
// ---------------------------------------------------------------------------
test('(h) Append-only: raw SQL UPDATE and DELETE on risk_state_history abort via triggers', () => {
  const { db, cleanup } = makeTempDb('append-only');
  try {
    const history = getRiskSystemStateHistory(db);
    assert.equal(history.length, 1);
    const genesisId = history[0].transitionId;

    assert.throws(
      () =>
        db
          .prepare("UPDATE risk_state_history SET to_state = 'HALTED' WHERE transition_id = ?")
          .run(genesisId),
      /immutable: UPDATE forbidden/i
    );
    assert.throws(
      () =>
        db.prepare('DELETE FROM risk_state_history WHERE transition_id = ?').run(genesisId),
      /immutable: DELETE forbidden/i
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (i) Determinism: buildPortfolioState twice returns identical values
// ---------------------------------------------------------------------------
test('(i) Determinism: calling buildPortfolioState twice on the same fixture returns deeply identical results', () => {
  const { db, cleanup } = makeTempDb('determinism');
  try {
    const { experimentId, settledCash, asOf, config } = buildRichPortfolioFixture(db);
    const first = buildPortfolioState(db, experimentId, asOf, { settledCash, config });
    const second = buildPortfolioState(db, experimentId, asOf, { settledCash, config });
    assert.deepEqual(first, second);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Extra: LIVE mode guard & static isolation of eventedge/risk/
// ---------------------------------------------------------------------------
test('Extra: LIVE config rejected in buildPortfolioState & eventedge/risk/ has zero live/network/credential imports', () => {
  const { db, cleanup } = makeTempDb('isolation');
  try {
    ensureExperiment(db, 'exp-ee06-live-guard');
    const paperCfg = createEventEdgeConfig({ mode: 'PAPER' });
    const forgedLive = {
      ...paperCfg,
      mode: 'LIVE',
      liveEnabled: true,
    } as unknown as EventEdgeConfig;

    assert.throws(
      () =>
        buildPortfolioState(db, 'exp-ee06-live-guard', '2026-11-26T16:00:00.000Z', {
          settledCash: 1000,
          config: forgedLive,
        }),
      EventEdgeLiveModeDisabledError
    );

    const riskDir = path.resolve(process.cwd(), 'eventedge', 'risk');
    const riskFiles = fs.readdirSync(riskDir).filter((f) => f.endsWith('.ts'));
    assert.ok(riskFiles.length >= 4);
    for (const file of riskFiles) {
      const content = fs.readFileSync(path.join(riskDir, file), 'utf8');
      assert.doesNotMatch(
        content,
        /ExecutionVault|server\.ts|fetch\(|https?:\/\/|KALSHI_API_KEY|KALSHI_PRIVATE_KEY|PUBLIC_API_SECRET/i,
        `eventedge/risk/${file} must remain strictly paper-only with no network/credentials/live execution`
      );
    }
  } finally {
    cleanup();
  }
});

console.log(`\n=== EE-06 Summary: ${passed} passed, ${failed} failed ===\n`);
if (failed > 0) {
  process.exit(1);
}
