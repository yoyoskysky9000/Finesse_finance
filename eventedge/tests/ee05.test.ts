/**
 * EventEdge EE-05 Verification Suite
 *
 * Covers the binding paper-only shadow-fill contract:
 *  (a) Edge gate: max(edge_yes, edge_no) < minConservativeEdge -> NO_EDGE decision, 0 order rows, NO_FILL / NO_EDGE
 *  (b) Arrival-book realism: decision vs arrival price differ (BUY_YES at yes_ask & BUY_NO at 1 - yes_bid);
 *      fill uses arrival book price and records BOTH decision & arrival book snapshot IDs
 *  (c) Latency sensitivity: latencyMs = 0 picks snapshot at/after decision time; large latency picks later snapshot
 *  (d) Partial fill: requested > displayed depth -> PARTIAL with exact filled & unfilled quantities
 *  (e) Stale / missing / zero-depth arrival books -> NO_FILL with STALE_BOOK / BOOK_NOT_CAPTURED / INSUFFICIENT_DEPTH
 *  (f) Fees: exact hand-computed Kalshi taker fee values including cent ceiling & feeScheduleVersion recorded
 *  (g) Determinism: identical inputs across two independent databases yield identical decision_id, order_id, fill_id
 *  (h) Append-only: raw SQL UPDATE & DELETE on shadow_decisions, shadow_orders, shadow_fills abort via triggers
 *  (i) Config: defaults & changing shadow config (latencyMs, maxBookAgeMs, feeScheduleVersion) changes config_hash
 *  (+) Extra checks: p_calibrated preferred over p_ensemble, LIVE mode rejected, zero marks/settlements written,
 *      static isolation of eventedge/shadow/ from live execution/network/credentials.
 *
 * Run with: npx tsx eventedge/tests/ee05.test.ts
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  EVENTEDGE_DEFAULT_SHADOW_CONFIG,
  EVENTEDGE_LEDGER_TABLES,
  EVENTEDGE_MIGRATIONS,
  EventEdgeLiveModeDisabledError,
  UnsupportedFeeScheduleError,
  computeEventEdgeConfigHash,
  computeShadowEdges,
  computeShadowFillFee,
  createEventEdgeConfig,
  createShadowExecutionEngine,
  executeShadowDecision,
  getAppliedMigrations,
  getShadowDecision,
  getShadowFillsForDecision,
  getShadowOrdersForDecision,
  initializeEventEdgeLedger,
  listShadowDecisionsForExperiment,
  listShadowFillsForExperiment,
  persistOrderbookState,
  registerDiscoveredContract,
  registerExperiment,
  saveForecast,
  transitionContractLifecycle,
  type EventEdgeConfig,
  type PersistedForecastRecord,
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `eventedge-ee05-${label}-`));
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

interface SeedOptions {
  readonly experimentId?: string;
  readonly marketId?: string;
  readonly probability?: number;
  readonly forecastStage?: 'p_ensemble' | 'p_calibrated';
  readonly forecastId?: string;
  readonly forecastTimestamp?: string;
  readonly configHash?: string;
}

function seedExperimentAndForecast(
  db: DatabaseSync,
  opts: SeedOptions = {}
): {
  experimentId: string;
  marketId: string;
  forecast: PersistedForecastRecord;
} {
  const experimentId = opts.experimentId ?? 'exp-ee05-shadow-01';
  const marketId = opts.marketId ?? 'KXMACRO-CPI-26DEC';
  const probability = opts.probability ?? 0.65;
  const forecastStage = opts.forecastStage ?? 'p_ensemble';
  const forecastId =
    opts.forecastId ?? `fc_${experimentId}_${marketId}_${forecastStage}_${Math.round(probability * 10000)}`;
  const forecastTimestamp = opts.forecastTimestamp ?? '2026-11-26T15:00:00.000Z';
  const configHash = opts.configHash ?? 'a'.repeat(64);

  const existingExp = db
    .prepare('SELECT experiment_id FROM experiments WHERE experiment_id = ?')
    .get(experimentId) as { experiment_id: string } | undefined;
  if (!existingExp) {
    registerExperiment(db, {
      experimentId,
      title: 'EE-05 Shadow Execution Validation',
      hypothesis: 'Shadow fills accurately capture latency, depth, and fees on captured books.',
      killCriteria: 'Kill if simulated net edge fails to clear fee + latency slippage.',
      sampleDefinition: 'families=KXMACRO; n=50',
      modelVersion: 'ee-ensemble-v1.0.0',
      configHash,
      registeredAt: '2026-11-26T14:00:00.000Z',
    });
  }

  const existingLifecycle = db
    .prepare('SELECT 1 AS ok FROM contract_lifecycle_history WHERE market_id = ? LIMIT 1')
    .get(marketId) as { ok: number } | undefined;
  if (!existingLifecycle) {
    registerDiscoveredContract(db, {
      marketId,
      actor: 'ee05-test-harness',
      transitionedAt: '2026-11-26T14:05:00.000Z',
      reason: 'Discovered for EE-05 test',
    });
    transitionContractLifecycle(db, {
      marketId,
      toState: 'AUDIT_PENDING',
      actor: 'ee05-test-harness',
      reason: 'Audit initiated',
      transitionedAt: '2026-11-26T14:06:00.000Z',
    });
    transitionContractLifecycle(db, {
      marketId,
      toState: 'APPROVED',
      actor: 'ee05-test-harness',
      reason: 'Audit CLEAR',
      transitionedAt: '2026-11-26T14:07:00.000Z',
    });
  }

  const sourceEnsembleId = `fc_${experimentId}_${marketId}_p_ensemble`;
  const forecast = saveForecast(db, {
    forecastId,
    experimentId,
    marketId,
    eventId: `EVT-${marketId}`,
    eventFamilyId: 'KXMACRO',
    eventFamilyDerivationVersion: 'ee-family-prefix-v1',
    forecastStage,
    status: 'FORECAST',
    probability,
    uncertaintyInterval: {
      lower: Math.max(0, Number((probability - 0.08).toFixed(4))),
      upper: Math.min(1, Number((probability + 0.08).toFixed(4))),
      confidenceLevel: 0.9,
      method: 'ee05-fixture-interval',
    },
    extremeProbabilityJustified: false,
    extremeProbabilityJustification: null,
    modelVersion: forecastStage === 'p_calibrated' ? 'ee-calib-platt-v1' : 'ee-ensemble-v1.0.0',
    configHash,
    codeCommitHash: 'ee05testcommit00000000000000000000000000',
    dataSnapshotId: 'rs_ee05_001',
    baseRateVersion: 'ee-base-laplace-v1',
    ensembleVersion: 'ee-ensemble-v1.0.0',
    forecastTimestamp,
    abstentionReasons: [],
    ruleVersionId: null,
    referenceClass: null,
    componentForecastIds: forecastStage === 'p_calibrated' ? [sourceEnsembleId] : [],
    ensembleMetadata: null,
    featureMetadata:
      forecastStage === 'p_calibrated'
        ? {
            calibration: {
              method: 'platt',
              sourceForecastId: sourceEnsembleId,
              trainWindow: {
                start: '2026-10-01T00:00:00.000Z',
                end: '2026-11-01T00:00:00.000Z',
              },
              validationWindow: {
                start: '2026-11-02T00:00:00.000Z',
                end: '2026-11-20T00:00:00.000Z',
              },
            },
          }
        : {
            ensembleVersion: 'ee-ensemble-v1.0.0',
          },
  });

  return { experimentId, marketId, forecast };
}

console.log('\n=== EventEdge EE-05 Verification Suite ===\n');

// ---------------------------------------------------------------------------
// Migration v6 schema sanity check
// ---------------------------------------------------------------------------
test('Migration v6 creates shadow_decisions, shadow_orders, and shadow_fills tables', () => {
  const { db, cleanup } = makeTempDb('schema');
  try {
    const applied = getAppliedMigrations(db);
    assert.equal(applied.length, EVENTEDGE_MIGRATIONS.length);
    assert.ok(applied.some((m) => m.version === 6 && m.name === '006_ee05_shadow_execution_tables'));
    assert.ok(EVENTEDGE_LEDGER_TABLES.includes('shadow_decisions'));
    assert.ok(EVENTEDGE_LEDGER_TABLES.includes('shadow_orders'));
    assert.ok(EVENTEDGE_LEDGER_TABLES.includes('shadow_fills'));
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (a) Edge gate
// ---------------------------------------------------------------------------
test('(a) Edge gate: max(edge_yes, edge_no) < minConservativeEdge records NO_EDGE decision, 0 orders, NO_FILL/NO_EDGE', () => {
  const { db, cleanup } = makeTempDb('edge-gate');
  try {
    const config = createEventEdgeConfig({ mode: 'PAPER' }); // minConservativeEdge = 0.04
    const { experimentId, marketId, forecast } = seedExperimentAndForecast(db, {
      probability: 0.52,
      forecastTimestamp: '2026-11-26T15:00:00.000Z',
    });

    // Decision book: bid = 0.50, ask = 0.51 -> edge_yes = 0.01, edge_no = -0.02 -> max = 0.01 < 0.04
    persistOrderbookState(db, {
      orderbookStateId: 'ob_dec_noedge_1',
      marketTicker: marketId,
      bestBidUsd: 0.5,
      bestAskUsd: 0.51,
      yesBidSizeFp: 50,
      yesAskSizeFp: 50,
      capturedAt: '2026-11-26T15:00:00.000Z',
    });

    // Arrival book also exists, but must never be used since no order is created
    persistOrderbookState(db, {
      orderbookStateId: 'ob_arr_noedge_2',
      marketTicker: marketId,
      bestBidUsd: 0.5,
      bestAskUsd: 0.51,
      yesBidSizeFp: 50,
      yesAskSizeFp: 50,
      capturedAt: '2026-11-26T15:00:00.300Z',
    });

    const result = executeShadowDecision(db, {
      experimentId,
      marketId,
      forecast,
      requestedQuantity: 10,
      config,
      decisionTimestamp: '2026-11-26T15:00:00.000Z',
    });

    assert.equal(result.replayed, false);
    assert.equal(result.decision.outcome, 'NO_EDGE');
    assert.equal(result.decision.side, null);
    assert.ok(Math.abs(result.decision.edgeYes - 0.01) < 1e-9);
    assert.ok(Math.abs(result.decision.edgeNo - -0.02) < 1e-9);
    assert.equal(result.decision.decisionBookSnapshotId, 'ob_dec_noedge_1');
    assert.equal(result.order, null);
    assert.equal(result.arrivalBook, null);

    // Zero order rows in shadow_orders table
    const orderRows = getShadowOrdersForDecision(db, result.decision.decisionId);
    assert.equal(orderRows.length, 0);
    const totalOrders = db.prepare('SELECT COUNT(*) AS cnt FROM shadow_orders').get() as {
      cnt: number;
    };
    assert.equal(totalOrders.cnt, 0);

    // Fill records NO_FILL / NO_EDGE with zero fee and null order_id
    assert.equal(result.fill.status, 'NO_FILL');
    assert.equal(result.fill.reasonCode, 'NO_EDGE');
    assert.equal(result.fill.orderId, null);
    assert.equal(result.fill.filledQuantity, 0);
    assert.equal(result.fill.unfilledQuantity, 10);
    assert.equal(result.fill.fillPriceUsd, null);
    assert.equal(result.fill.feeUsd, 0);
    assert.equal(result.fill.decisionBookSnapshotId, 'ob_dec_noedge_1');
    assert.equal(result.fill.arrivalBookSnapshotId, null);

    // Pure helper sanity check
    const edgeCheck = computeShadowEdges(0.52, 0.5, 0.51, 0.04);
    assert.equal(edgeCheck.outcome, 'NO_EDGE');
    assert.equal(edgeCheck.side, null);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (b) Arrival-book realism (BUY_YES at yes_ask AND BUY_NO at 1 - yes_bid)
// ---------------------------------------------------------------------------
test('(b) Arrival-book realism: BUY_YES fills at arrival yes_ask & BUY_NO fills at 1 - arrival yes_bid, recording both book IDs', () => {
  const { db, cleanup } = makeTempDb('arrival-realism');
  try {
    const config = createEventEdgeConfig({ mode: 'PAPER' }); // latencyMs = 250

    // --- Case 1: BUY_YES (p = 0.70, decision ask = 0.55 -> edge_yes = 0.15; arrival ask drifts to 0.59) ---
    const yesSeed = seedExperimentAndForecast(db, {
      experimentId: 'exp-ee05-arrival',
      marketId: 'KXMACRO-YES-01',
      probability: 0.7,
      forecastTimestamp: '2026-11-26T15:10:00.000Z',
    });

    persistOrderbookState(db, {
      orderbookStateId: 'ob_yes_decision',
      marketTicker: yesSeed.marketId,
      bestBidUsd: 0.53,
      bestAskUsd: 0.55,
      yesBidSizeFp: 40,
      yesAskSizeFp: 40,
      capturedAt: '2026-11-26T15:10:00.000Z',
    });

    persistOrderbookState(db, {
      orderbookStateId: 'ob_yes_arrival',
      marketTicker: yesSeed.marketId,
      bestBidUsd: 0.57,
      bestAskUsd: 0.59, // adverse drift by +4c vs decision book
      yesBidSizeFp: 25,
      yesAskSizeFp: 25,
      capturedAt: '2026-11-26T15:10:00.300Z', // >= T + 250ms
    });

    const yesRes = executeShadowDecision(db, {
      experimentId: yesSeed.experimentId,
      marketId: yesSeed.marketId,
      requestedQuantity: 10,
      config,
      decisionTimestamp: '2026-11-26T15:10:00.000Z',
    });

    assert.equal(yesRes.decision.outcome, 'ORDER_CREATED');
    assert.equal(yesRes.decision.side, 'BUY_YES');
    assert.ok(yesRes.order !== null);
    assert.equal(yesRes.order.side, 'BUY_YES');
    assert.equal(yesRes.order.decisionPriceUsd, 0.55);
    assert.equal(yesRes.order.arrivalTimestamp, '2026-11-26T15:10:00.250Z');

    assert.equal(yesRes.fill.status, 'FILLED');
    assert.equal(yesRes.fill.fillPriceUsd, 0.59); // arrival yes_ask, NOT decision 0.55
    assert.notEqual(yesRes.fill.fillPriceUsd, yesRes.order.decisionPriceUsd);
    assert.equal(yesRes.fill.filledQuantity, 10);
    assert.equal(yesRes.fill.unfilledQuantity, 0);
    assert.equal(yesRes.fill.decisionBookSnapshotId, 'ob_yes_decision');
    assert.equal(yesRes.fill.arrivalBookSnapshotId, 'ob_yes_arrival');
    assert.equal(yesRes.fill.reasonCode, null);

    // --- Case 2: BUY_NO (p = 0.20, decision yes_bid = 0.40 -> edge_no = 0.20; arrival yes_bid drops to 0.36 -> NO fill = 0.64) ---
    const noSeed = seedExperimentAndForecast(db, {
      experimentId: 'exp-ee05-arrival',
      marketId: 'KXMACRO-NO-02',
      probability: 0.2,
      forecastTimestamp: '2026-11-26T15:12:00.000Z',
    });

    persistOrderbookState(db, {
      orderbookStateId: 'ob_no_decision',
      marketTicker: noSeed.marketId,
      bestBidUsd: 0.4,
      bestAskUsd: 0.42,
      yesBidSizeFp: 30,
      yesAskSizeFp: 30,
      capturedAt: '2026-11-26T15:12:00.000Z',
    });

    persistOrderbookState(db, {
      orderbookStateId: 'ob_no_arrival',
      marketTicker: noSeed.marketId,
      bestBidUsd: 0.36, // NO ask = 1 - 0.36 = 0.64 (worse than decision 0.60)
      bestAskUsd: 0.38,
      yesBidSizeFp: 15,
      yesAskSizeFp: 2, // BUY_NO consumes yes_bid_size_fp (15), NOT yes_ask_size_fp (2)
      capturedAt: '2026-11-26T15:12:00.260Z',
    });

    const noRes = executeShadowDecision(db, {
      experimentId: noSeed.experimentId,
      marketId: noSeed.marketId,
      requestedQuantity: 10,
      config,
      decisionTimestamp: '2026-11-26T15:12:00.000Z',
    });

    assert.equal(noRes.decision.outcome, 'ORDER_CREATED');
    assert.equal(noRes.decision.side, 'BUY_NO');
    assert.ok(noRes.order !== null);
    assert.equal(noRes.order.side, 'BUY_NO');
    assert.equal(noRes.order.decisionPriceUsd, 0.6); // 1 - 0.40
    assert.equal(noRes.fill.status, 'FILLED');
    assert.equal(noRes.fill.fillPriceUsd, 0.64); // 1 - 0.36 from arrival book
    assert.equal(noRes.fill.displayedDepthAtPrice, 15);
    assert.equal(noRes.fill.filledQuantity, 10);
    assert.equal(noRes.fill.unfilledQuantity, 0);
    assert.equal(noRes.fill.decisionBookSnapshotId, 'ob_no_decision');
    assert.equal(noRes.fill.arrivalBookSnapshotId, 'ob_no_arrival');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (c) Latency sensitivity: latencyMs = 0 vs large latency
// ---------------------------------------------------------------------------
test('(c) Latency: latencyMs = 0 uses snapshot at/after decision time; large latency picks later snapshot', () => {
  const { db, cleanup } = makeTempDb('latency');
  try {
    const seed = seedExperimentAndForecast(db, {
      experimentId: 'exp-ee05-latency',
      marketId: 'KXMACRO-LAT-01',
      probability: 0.75,
      forecastTimestamp: '2026-11-26T15:20:00.000Z',
    });

    // T + 0ms (decision snapshot)
    persistOrderbookState(db, {
      orderbookStateId: 'ob_lat_t0',
      marketTicker: seed.marketId,
      bestBidUsd: 0.5,
      bestAskUsd: 0.52,
      yesBidSizeFp: 100,
      yesAskSizeFp: 100,
      capturedAt: '2026-11-26T15:20:00.000Z',
    });

    // T + 1000ms
    persistOrderbookState(db, {
      orderbookStateId: 'ob_lat_t1000',
      marketTicker: seed.marketId,
      bestBidUsd: 0.54,
      bestAskUsd: 0.56,
      yesBidSizeFp: 100,
      yesAskSizeFp: 100,
      capturedAt: '2026-11-26T15:20:01.000Z',
    });

    // T + 5000ms
    persistOrderbookState(db, {
      orderbookStateId: 'ob_lat_t5000',
      marketTicker: seed.marketId,
      bestBidUsd: 0.6,
      bestAskUsd: 0.62,
      yesBidSizeFp: 100,
      yesAskSizeFp: 100,
      capturedAt: '2026-11-26T15:20:05.000Z',
    });

    const zeroLatencyConfig = createEventEdgeConfig({
      mode: 'PAPER',
      shadow: { latencyMs: 0 },
    });
    const highLatencyConfig = createEventEdgeConfig({
      mode: 'PAPER',
      shadow: { latencyMs: 4500 },
    });

    const resZero = executeShadowDecision(db, {
      experimentId: seed.experimentId,
      marketId: seed.marketId,
      requestedQuantity: 5,
      config: zeroLatencyConfig,
      decisionTimestamp: '2026-11-26T15:20:00.000Z',
    });

    const resHigh = executeShadowDecision(db, {
      experimentId: seed.experimentId,
      marketId: seed.marketId,
      requestedQuantity: 5,
      config: highLatencyConfig,
      decisionTimestamp: '2026-11-26T15:20:00.000Z',
    });

    // Zero latency -> arrival_time = T+0 -> picks ob_lat_t0 (0.52)
    assert.equal(resZero.order?.latencyMs, 0);
    assert.equal(resZero.order?.arrivalTimestamp, '2026-11-26T15:20:00.000Z');
    assert.equal(resZero.fill.arrivalBookSnapshotId, 'ob_lat_t0');
    assert.equal(resZero.fill.fillPriceUsd, 0.52);

    // 4500ms latency -> arrival_time = T+4500ms -> earliest snapshot >= T+4500ms is ob_lat_t5000 (0.62)
    assert.equal(resHigh.order?.latencyMs, 4500);
    assert.equal(resHigh.order?.arrivalTimestamp, '2026-11-26T15:20:04.500Z');
    assert.equal(resHigh.fill.arrivalBookSnapshotId, 'ob_lat_t5000');
    assert.equal(resHigh.fill.fillPriceUsd, 0.62);

    // Both decisions share the same decision book, different config hashes & decision IDs
    assert.equal(resZero.decision.decisionBookSnapshotId, 'ob_lat_t0');
    assert.equal(resHigh.decision.decisionBookSnapshotId, 'ob_lat_t0');
    assert.notEqual(resZero.decision.configHash, resHigh.decision.configHash);
    assert.notEqual(resZero.decision.decisionId, resHigh.decision.decisionId);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (d) Partial fill
// ---------------------------------------------------------------------------
test('(d) Partial fill: requested quantity > displayed depth yields PARTIAL with exact filled & unfilled counts', () => {
  const { db, cleanup } = makeTempDb('partial-fill');
  try {
    const config = createEventEdgeConfig({ mode: 'PAPER' });
    const seed = seedExperimentAndForecast(db, {
      experimentId: 'exp-ee05-partial',
      marketId: 'KXMACRO-PARTIAL-01',
      probability: 0.72,
      forecastTimestamp: '2026-11-26T15:30:00.000Z',
    });

    persistOrderbookState(db, {
      orderbookStateId: 'ob_partial_dec',
      marketTicker: seed.marketId,
      bestBidUsd: 0.5,
      bestAskUsd: 0.52,
      yesBidSizeFp: 50,
      yesAskSizeFp: 50,
      capturedAt: '2026-11-26T15:30:00.000Z',
    });

    // Arrival book only shows 7 contracts at ask 0.54
    persistOrderbookState(db, {
      orderbookStateId: 'ob_partial_arr',
      marketTicker: seed.marketId,
      bestBidUsd: 0.52,
      bestAskUsd: 0.54,
      yesBidSizeFp: 20,
      yesAskSizeFp: 7,
      capturedAt: '2026-11-26T15:30:00.300Z',
    });

    const res = executeShadowDecision(db, {
      experimentId: seed.experimentId,
      marketId: seed.marketId,
      requestedQuantity: 20,
      config,
      decisionTimestamp: '2026-11-26T15:30:00.000Z',
    });

    assert.equal(res.fill.status, 'PARTIAL');
    assert.equal(res.fill.requestedQuantity, 20);
    assert.equal(res.fill.filledQuantity, 7);
    assert.equal(res.fill.unfilledQuantity, 13);
    assert.equal(res.fill.filledQuantity + res.fill.unfilledQuantity, res.fill.requestedQuantity);
    assert.equal(res.fill.displayedDepthAtPrice, 7);
    assert.equal(res.fill.fillPriceUsd, 0.54);
    assert.equal(res.fill.reasonCode, null);

    // Fee computed strictly on filledQuantity (7), NOT requestedQuantity (20):
    // 0.07 * 7 * 0.54 * 0.46 = 0.121716 -> ceil to cent = $0.13
    assert.equal(res.fill.feeUsd, 0.13);
    assert.equal(res.fill.feeScheduleVersion, 'kalshi-taker-v1');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (e) Stale / missing / zero-depth arrival books
// ---------------------------------------------------------------------------
test('(e) Stale, missing, and zero-depth arrival books yield NO_FILL with exact reason codes', () => {
  const { db, cleanup } = makeTempDb('no-fill-reasons');
  try {
    const config = createEventEdgeConfig({
      mode: 'PAPER',
      shadow: { latencyMs: 250, maxBookAgeMs: 5000 },
    });

    // 1. BOOK_NOT_CAPTURED: only a decision book exists; no snapshot at or after T + 250ms
    const missingSeed = seedExperimentAndForecast(db, {
      experimentId: 'exp-ee05-nofill',
      marketId: 'KXMACRO-MISSING-01',
      probability: 0.8,
      forecastTimestamp: '2026-11-26T15:40:00.000Z',
    });
    persistOrderbookState(db, {
      orderbookStateId: 'ob_missing_dec',
      marketTicker: missingSeed.marketId,
      bestBidUsd: 0.48,
      bestAskUsd: 0.5,
      yesBidSizeFp: 50,
      yesAskSizeFp: 50,
      capturedAt: '2026-11-26T15:40:00.000Z',
    });

    const missingRes = executeShadowDecision(db, {
      experimentId: missingSeed.experimentId,
      marketId: missingSeed.marketId,
      requestedQuantity: 10,
      config,
      decisionTimestamp: '2026-11-26T15:40:00.000Z',
    });

    assert.equal(missingRes.decision.outcome, 'ORDER_CREATED');
    assert.ok(missingRes.order !== null);
    assert.equal(missingRes.fill.status, 'NO_FILL');
    assert.equal(missingRes.fill.reasonCode, 'BOOK_NOT_CAPTURED');
    assert.equal(missingRes.fill.filledQuantity, 0);
    assert.equal(missingRes.fill.unfilledQuantity, 10);
    assert.equal(missingRes.fill.fillPriceUsd, null);
    assert.equal(missingRes.fill.feeUsd, 0);
    assert.equal(missingRes.fill.decisionBookSnapshotId, 'ob_missing_dec');
    assert.equal(missingRes.fill.arrivalBookSnapshotId, null);

    // 2. STALE_BOOK: arrival book captured at T + 300ms, evaluated at T + 6300ms -> bookAgeMs = 6000 > 5000
    const staleSeed = seedExperimentAndForecast(db, {
      experimentId: 'exp-ee05-nofill',
      marketId: 'KXMACRO-STALE-02',
      probability: 0.8,
      forecastTimestamp: '2026-11-26T15:41:00.000Z',
    });
    persistOrderbookState(db, {
      orderbookStateId: 'ob_stale_dec',
      marketTicker: staleSeed.marketId,
      bestBidUsd: 0.48,
      bestAskUsd: 0.5,
      yesBidSizeFp: 50,
      yesAskSizeFp: 50,
      capturedAt: '2026-11-26T15:41:00.000Z',
    });
    persistOrderbookState(db, {
      orderbookStateId: 'ob_stale_arr',
      marketTicker: staleSeed.marketId,
      bestBidUsd: 0.49,
      bestAskUsd: 0.51,
      yesBidSizeFp: 50,
      yesAskSizeFp: 50,
      capturedAt: '2026-11-26T15:41:00.300Z',
    });

    const staleRes = executeShadowDecision(db, {
      experimentId: staleSeed.experimentId,
      marketId: staleSeed.marketId,
      requestedQuantity: 10,
      config,
      decisionTimestamp: '2026-11-26T15:41:00.000Z',
      evaluatedAt: '2026-11-26T15:41:06.300Z', // 6000ms after arrival book captured_at
    });

    assert.equal(staleRes.fill.status, 'NO_FILL');
    assert.equal(staleRes.fill.reasonCode, 'STALE_BOOK');
    assert.equal(staleRes.fill.bookAgeMs, 6000);
    assert.equal(staleRes.fill.filledQuantity, 0);
    assert.equal(staleRes.fill.unfilledQuantity, 10);
    assert.equal(staleRes.fill.fillPriceUsd, null);
    assert.equal(staleRes.fill.feeUsd, 0);
    assert.equal(staleRes.fill.decisionBookSnapshotId, 'ob_stale_dec');
    assert.equal(staleRes.fill.arrivalBookSnapshotId, 'ob_stale_arr');

    // 3. INSUFFICIENT_DEPTH: arrival book has 0 displayed contracts on target side
    const zeroDepthSeed = seedExperimentAndForecast(db, {
      experimentId: 'exp-ee05-nofill',
      marketId: 'KXMACRO-ZERODEPTH-03',
      probability: 0.8,
      forecastTimestamp: '2026-11-26T15:42:00.000Z',
    });
    persistOrderbookState(db, {
      orderbookStateId: 'ob_zero_dec',
      marketTicker: zeroDepthSeed.marketId,
      bestBidUsd: 0.48,
      bestAskUsd: 0.5,
      yesBidSizeFp: 50,
      yesAskSizeFp: 50,
      capturedAt: '2026-11-26T15:42:00.000Z',
    });
    persistOrderbookState(db, {
      orderbookStateId: 'ob_zero_arr',
      marketTicker: zeroDepthSeed.marketId,
      bestBidUsd: 0.49,
      bestAskUsd: 0.51,
      yesBidSizeFp: 50,
      yesAskSizeFp: 0, // zero ask depth for BUY_YES
      capturedAt: '2026-11-26T15:42:00.300Z',
    });

    const zeroDepthRes = executeShadowDecision(db, {
      experimentId: zeroDepthSeed.experimentId,
      marketId: zeroDepthSeed.marketId,
      requestedQuantity: 10,
      config,
      decisionTimestamp: '2026-11-26T15:42:00.000Z',
    });

    assert.equal(zeroDepthRes.fill.status, 'NO_FILL');
    assert.equal(zeroDepthRes.fill.reasonCode, 'INSUFFICIENT_DEPTH');
    assert.equal(zeroDepthRes.fill.displayedDepthAtPrice, 0);
    assert.equal(zeroDepthRes.fill.filledQuantity, 0);
    assert.equal(zeroDepthRes.fill.unfilledQuantity, 10);
    assert.equal(zeroDepthRes.fill.fillPriceUsd, null);
    assert.equal(zeroDepthRes.fill.feeUsd, 0);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (f) Fees: hand-computed Kalshi taker fee values including cent ceiling
// ---------------------------------------------------------------------------
test('(f) Fees: exact hand-computed kalshi-taker-v1 values including cent ceiling & persisted version', () => {
  // Formula: ceil_to_cent(0.07 * contracts * price * (1 - price))
  // 10 @ 0.50: 0.07 * 10 * 0.25 = 0.175 -> $0.18
  assert.equal(computeShadowFillFee(10, 0.5, 'kalshi-taker-v1').feeUsd, 0.18);
  // 1 @ 0.50: 0.07 * 1 * 0.25 = 0.0175 -> $0.02
  assert.equal(computeShadowFillFee(1, 0.5, 'kalshi-taker-v1').feeUsd, 0.02);
  // 100 @ 0.50: 0.07 * 100 * 0.25 = 1.75 exact -> $1.75 (no floating-point overshoot to $1.76)
  assert.equal(computeShadowFillFee(100, 0.5, 'kalshi-taker-v1').feeUsd, 1.75);
  // 5 @ 0.40: 0.07 * 5 * 0.24 = 0.084 -> $0.09
  assert.equal(computeShadowFillFee(5, 0.4, 'kalshi-taker-v1').feeUsd, 0.09);
  // 7 @ 0.35: 0.07 * 7 * 0.2275 = 0.111475 -> $0.12
  assert.equal(computeShadowFillFee(7, 0.35, 'kalshi-taker-v1').feeUsd, 0.12);
  // 0 contracts -> $0.00
  assert.equal(computeShadowFillFee(0, 0.5, 'kalshi-taker-v1').feeUsd, 0);

  // Unknown schedule rejected explicitly
  assert.throws(
    () => computeShadowFillFee(10, 0.5, 'unknown-fee-v99'),
    UnsupportedFeeScheduleError
  );

  // Verify persisted fee & fee_schedule_version on an end-to-end fill (10 @ 0.50 -> $0.18)
  const { db, cleanup } = makeTempDb('fees');
  try {
    const config = createEventEdgeConfig({ mode: 'PAPER' });
    const seed = seedExperimentAndForecast(db, {
      experimentId: 'exp-ee05-fees',
      marketId: 'KXMACRO-FEE-01',
      probability: 0.7,
      forecastTimestamp: '2026-11-26T15:45:00.000Z',
    });
    persistOrderbookState(db, {
      orderbookStateId: 'ob_fee_dec',
      marketTicker: seed.marketId,
      bestBidUsd: 0.48,
      bestAskUsd: 0.5,
      yesBidSizeFp: 100,
      yesAskSizeFp: 100,
      capturedAt: '2026-11-26T15:45:00.000Z',
    });
    persistOrderbookState(db, {
      orderbookStateId: 'ob_fee_arr',
      marketTicker: seed.marketId,
      bestBidUsd: 0.48,
      bestAskUsd: 0.5,
      yesBidSizeFp: 100,
      yesAskSizeFp: 100,
      capturedAt: '2026-11-26T15:45:00.250Z',
    });

    const res = executeShadowDecision(db, {
      experimentId: seed.experimentId,
      marketId: seed.marketId,
      requestedQuantity: 10,
      config,
      decisionTimestamp: '2026-11-26T15:45:00.000Z',
    });

    assert.equal(res.fill.status, 'FILLED');
    assert.equal(res.fill.fillPriceUsd, 0.5);
    assert.equal(res.fill.feeUsd, 0.18);
    assert.equal(res.fill.feeScheduleVersion, 'kalshi-taker-v1');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (g) Determinism: identical inputs across two independent DBs + replay
// ---------------------------------------------------------------------------
test('(g) Determinism: identical inputs across two independent databases yield identical decision_id, order_id, fill_id', () => {
  const dbA = makeTempDb('det-a');
  const dbB = makeTempDb('det-b');
  try {
    const config = createEventEdgeConfig({ mode: 'PAPER' });

    const runInDb = (db: DatabaseSync) => {
      const seed = seedExperimentAndForecast(db, {
        experimentId: 'exp-ee05-det',
        marketId: 'KXMACRO-DET-01',
        probability: 0.74,
        forecastId: 'fc_det_fixed_001',
        forecastTimestamp: '2026-11-26T15:50:00.000Z',
      });
      persistOrderbookState(db, {
        orderbookStateId: 'ob_det_dec',
        marketTicker: seed.marketId,
        bestBidUsd: 0.52,
        bestAskUsd: 0.54,
        yesBidSizeFp: 20,
        yesAskSizeFp: 20,
        capturedAt: '2026-11-26T15:50:00.000Z',
      });
      persistOrderbookState(db, {
        orderbookStateId: 'ob_det_arr',
        marketTicker: seed.marketId,
        bestBidUsd: 0.53,
        bestAskUsd: 0.55,
        yesBidSizeFp: 20,
        yesAskSizeFp: 12,
        capturedAt: '2026-11-26T15:50:00.300Z',
      });

      const engine = createShadowExecutionEngine(db);
      return engine.executeShadowDecision({
        experimentId: seed.experimentId,
        marketId: seed.marketId,
        requestedQuantity: 10,
        config,
        decisionTimestamp: '2026-11-26T15:50:00.000Z',
      });
    };

    const resA = runInDb(dbA.db);
    const resB = runInDb(dbB.db);

    assert.equal(resA.replayed, false);
    assert.equal(resB.replayed, false);
    assert.equal(resA.decision.decisionId, resB.decision.decisionId);
    assert.equal(resA.order?.orderId, resB.order?.orderId);
    assert.equal(resA.fill.fillId, resB.fill.fillId);
    assert.equal(resA.fill.fillPriceUsd, resB.fill.fillPriceUsd);
    assert.equal(resA.fill.feeUsd, resB.fill.feeUsd);

    // Re-running identical decision in dbA replays existing immutable rows without creating duplicates
    const replayA = executeShadowDecision(dbA.db, {
      experimentId: 'exp-ee05-det',
      marketId: 'KXMACRO-DET-01',
      requestedQuantity: 10,
      config,
      decisionTimestamp: '2026-11-26T15:50:00.000Z',
    });
    assert.equal(replayA.replayed, true);
    assert.equal(replayA.decision.decisionId, resA.decision.decisionId);
    assert.equal(replayA.order?.orderId, resA.order?.orderId);
    assert.equal(replayA.fill.fillId, resA.fill.fillId);
    assert.equal(listShadowDecisionsForExperiment(dbA.db, 'exp-ee05-det').length, 1);
    assert.equal(listShadowFillsForExperiment(dbA.db, 'exp-ee05-det').length, 1);
  } finally {
    dbA.cleanup();
    dbB.cleanup();
  }
});

// ---------------------------------------------------------------------------
// (h) Append-only: raw SQL UPDATE & DELETE abort on all 3 shadow tables
// ---------------------------------------------------------------------------
test('(h) Append-only: raw SQL UPDATE and DELETE abort on shadow_decisions, shadow_orders, and shadow_fills', () => {
  const { db, cleanup } = makeTempDb('append-only');
  try {
    const config = createEventEdgeConfig({ mode: 'PAPER' });
    const seed = seedExperimentAndForecast(db, {
      experimentId: 'exp-ee05-immut',
      marketId: 'KXMACRO-IMMUT-01',
      probability: 0.78,
      forecastTimestamp: '2026-11-26T15:55:00.000Z',
    });

    persistOrderbookState(db, {
      orderbookStateId: 'ob_immut_dec',
      marketTicker: seed.marketId,
      bestBidUsd: 0.5,
      bestAskUsd: 0.52,
      yesBidSizeFp: 30,
      yesAskSizeFp: 30,
      capturedAt: '2026-11-26T15:55:00.000Z',
    });
    persistOrderbookState(db, {
      orderbookStateId: 'ob_immut_arr',
      marketTicker: seed.marketId,
      bestBidUsd: 0.51,
      bestAskUsd: 0.53,
      yesBidSizeFp: 30,
      yesAskSizeFp: 30,
      capturedAt: '2026-11-26T15:55:00.300Z',
    });

    const res = executeShadowDecision(db, {
      experimentId: seed.experimentId,
      marketId: seed.marketId,
      requestedQuantity: 5,
      config,
      decisionTimestamp: '2026-11-26T15:55:00.000Z',
    });

    assert.ok(getShadowDecision(db, res.decision.decisionId) !== null);
    assert.ok(res.order !== null);
    assert.equal(getShadowFillsForDecision(db, res.decision.decisionId).length, 1);

    // shadow_decisions: UPDATE & DELETE must abort
    assert.throws(
      () =>
        db
          .prepare('UPDATE shadow_decisions SET requested_quantity = 999 WHERE decision_id = ?')
          .run(res.decision.decisionId),
      /append-only|immutable/i
    );
    assert.throws(
      () =>
        db
          .prepare('DELETE FROM shadow_decisions WHERE decision_id = ?')
          .run(res.decision.decisionId),
      /append-only|immutable/i
    );

    // shadow_orders: UPDATE & DELETE must abort
    assert.throws(
      () =>
        db
          .prepare('UPDATE shadow_orders SET latency_ms = 0 WHERE order_id = ?')
          .run(res.order.orderId),
      /append-only|immutable/i
    );
    assert.throws(
      () => db.prepare('DELETE FROM shadow_orders WHERE order_id = ?').run(res.order.orderId),
      /append-only|immutable/i
    );

    // shadow_fills: UPDATE & DELETE must abort
    assert.throws(
      () =>
        db
          .prepare('UPDATE shadow_fills SET fee_usd = 0 WHERE fill_id = ?')
          .run(res.fill.fillId),
      /append-only|immutable/i
    );
    assert.throws(
      () => db.prepare('DELETE FROM shadow_fills WHERE fill_id = ?').run(res.fill.fillId),
      /append-only|immutable/i
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (i) Config: defaults & changing latencyMs / shadow params changes config_hash
// ---------------------------------------------------------------------------
test('(i) Config: shadow defaults verified & changing shadow config changes config_hash', () => {
  const defaultCfg = createEventEdgeConfig();
  assert.equal(defaultCfg.mode, 'OBSERVE');
  assert.equal(defaultCfg.liveEnabled, false);
  assert.equal(defaultCfg.shadow.latencyModelVersion, 'ee-latency-fixed-v1');
  assert.equal(defaultCfg.shadow.latencyMs, 250);
  assert.equal(defaultCfg.shadow.maxBookAgeMs, 5000);
  assert.equal(defaultCfg.shadow.feeScheduleVersion, 'kalshi-taker-v1');
  assert.deepEqual(defaultCfg.shadow, EVENTEDGE_DEFAULT_SHADOW_CONFIG);

  const baseHash = computeEventEdgeConfigHash(defaultCfg);
  assert.equal(baseHash.length, 64);

  // Identical config -> identical hash
  const clonedDefault = createEventEdgeConfig();
  assert.equal(computeEventEdgeConfigHash(clonedDefault), baseHash);

  // Changing latencyMs changes config_hash
  const latChanged = createEventEdgeConfig({ shadow: { latencyMs: 500 } });
  const latHash = computeEventEdgeConfigHash(latChanged);
  assert.notEqual(latHash, baseHash);

  // Changing maxBookAgeMs changes config_hash
  const ageChanged = createEventEdgeConfig({ shadow: { maxBookAgeMs: 10_000 } });
  assert.notEqual(computeEventEdgeConfigHash(ageChanged), baseHash);

  // Changing latencyModelVersion changes config_hash
  const modelChanged = createEventEdgeConfig({
    shadow: { latencyModelVersion: 'ee-latency-fixed-v2' },
  });
  assert.notEqual(computeEventEdgeConfigHash(modelChanged), baseHash);

  // Changing feeScheduleVersion changes config_hash
  const feeChanged = createEventEdgeConfig({
    shadow: { feeScheduleVersion: 'kalshi-taker-v2' },
  });
  assert.notEqual(computeEventEdgeConfigHash(feeChanged), baseHash);
});

// ---------------------------------------------------------------------------
// Extra contract guards: p_calibrated preference, zero marks/settlements, LIVE guard, static isolation
// ---------------------------------------------------------------------------
test('Extra: prefers p_calibrated over p_ensemble when both exist, writes zero marks/settlements, rejects LIVE', () => {
  const { db, cleanup } = makeTempDb('calibrated-and-guards');
  try {
    const config = createEventEdgeConfig({ mode: 'PAPER' });
    const ensembleSeed = seedExperimentAndForecast(db, {
      experimentId: 'exp-ee05-calib',
      marketId: 'KXMACRO-CALIB-01',
      probability: 0.51, // would be NO_EDGE against 0.50 ask
      forecastStage: 'p_ensemble',
      forecastId: 'fc_calib_ensemble_01',
      forecastTimestamp: '2026-11-26T16:00:00.000Z',
    });

    // Add persisted p_calibrated for the same market & experiment with strong edge (0.72)
    const calibratedSeed = seedExperimentAndForecast(db, {
      experimentId: ensembleSeed.experimentId,
      marketId: ensembleSeed.marketId,
      probability: 0.72,
      forecastStage: 'p_calibrated',
      forecastId: 'fc_calib_calibrated_01',
      forecastTimestamp: '2026-11-26T16:00:00.000Z',
    });

    persistOrderbookState(db, {
      orderbookStateId: 'ob_calib_dec',
      marketTicker: ensembleSeed.marketId,
      bestBidUsd: 0.48,
      bestAskUsd: 0.5,
      yesBidSizeFp: 50,
      yesAskSizeFp: 50,
      capturedAt: '2026-11-26T16:00:00.000Z',
    });
    persistOrderbookState(db, {
      orderbookStateId: 'ob_calib_arr',
      marketTicker: ensembleSeed.marketId,
      bestBidUsd: 0.49,
      bestAskUsd: 0.51,
      yesBidSizeFp: 50,
      yesAskSizeFp: 50,
      capturedAt: '2026-11-26T16:00:00.300Z',
    });

    // Even if caller passes the p_ensemble forecast, engine automatically prefers p_calibrated
    const res = executeShadowDecision(db, {
      experimentId: ensembleSeed.experimentId,
      marketId: ensembleSeed.marketId,
      forecast: ensembleSeed.forecast,
      requestedQuantity: 4,
      config,
      decisionTimestamp: '2026-11-26T16:00:00.000Z',
    });

    assert.equal(res.decision.forecastStage, 'p_calibrated');
    assert.equal(res.decision.forecastId, calibratedSeed.forecast.forecastId);
    assert.equal(res.decision.modelProbability, 0.72);
    assert.equal(res.fill.status, 'FILLED');

    // Confirm zero marks or settlements written
    for (const table of ['settlements', 'realized_pnl', 'unrealized_pnl'] as const) {
      const count = db.prepare(`SELECT COUNT(*) AS cnt FROM ${table}`).get() as { cnt: number };
      assert.equal(count.cnt, 0, `Shadow engine must not write to ${table}`);
    }

    // LIVE mode hard-rejected even if forged
    const forgedLiveConfig = {
      ...config,
      mode: 'LIVE',
      liveEnabled: true,
    } as unknown as EventEdgeConfig;

    assert.throws(
      () =>
        executeShadowDecision(db, {
          experimentId: ensembleSeed.experimentId,
          marketId: ensembleSeed.marketId,
          requestedQuantity: 1,
          config: forgedLiveConfig,
          decisionTimestamp: '2026-11-26T16:00:00.000Z',
        }),
      EventEdgeLiveModeDisabledError
    );

    // Static isolation: eventedge/shadow/* must never import live execution, network fetch, or credentials
    const shadowDir = path.resolve(process.cwd(), 'eventedge', 'shadow');
    const shadowFiles = fs.readdirSync(shadowDir).filter((f) => f.endsWith('.ts'));
    assert.ok(shadowFiles.length >= 4);
    for (const file of shadowFiles) {
      const content = fs.readFileSync(path.join(shadowDir, file), 'utf8');
      assert.doesNotMatch(
        content,
        /ExecutionVault|server\.ts|fetch\(|https?:\/\/|KALSHI_API_KEY|KALSHI_PRIVATE_KEY|PUBLIC_API_SECRET/i,
        `eventedge/shadow/${file} must remain strictly paper-only with no network/credentials/live execution`
      );
    }
  } finally {
    cleanup();
  }
});

console.log(`\n=== EE-05 Summary: ${passed} passed, ${failed} failed ===\n`);
if (failed > 0) {
  process.exit(1);
}
