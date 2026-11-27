import type { DatabaseSync } from 'node:sqlite';
import {
  EventEdgeLiveModeDisabledError,
  assertNonLiveMode,
  computeEventEdgeConfigHash,
  createEventEdgeConfig,
  type EventEdgeConfig,
} from '../config/index';
import { getAppliedMigrations } from '../db/migrations';
import { EVENTEDGE_LEDGER_TABLES } from '../db/schema';
import { evaluateExperiment } from '../evaluation/killGate';
import { ExperimentNotFoundError, getExperiment } from '../experiments/registry';
import {
  CONTRACT_LIFECYCLE_STATES,
  type ContractLifecycleState,
} from '../lifecycle/contractLifecycle';
import { buildPortfolioState } from '../risk/portfolioState';
import type { ShadowFillStatus, ShadowNoFillReason } from '../shadow/types';
import {
  DASHBOARD_MANDATORY_DISCLAIMER,
  DashboardValidationError,
  type BuildDashboardOptions,
  type DashboardCalibrationSummary,
  type DashboardDataQualitySection,
  type DashboardExecutionRealismSection,
  type DashboardIntegritySection,
  type DashboardPaperPnlSection,
  type DashboardResearchQualitySection,
  type DashboardRiskSection,
  type DashboardSections,
  type EventEdgeDashboard,
  type LedgerTableTriggerCheck,
  type LiveDisabledAssertionCheck,
} from './types';

const DEFAULT_DASHBOARD_PAPER_BANKROLL_USD = 10_000;

function cleanFloat(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (Math.abs(value) < 1e-12) return 0;
  return Number(value.toFixed(10));
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

interface RawShadowDecisionCountRow {
  outcome: 'ORDER_CREATED' | 'NO_EDGE';
  decision_timestamp: string;
}

interface RawShadowOrderRow {
  order_id: string;
  decision_price_usd: number;
  decision_timestamp: string;
}

interface RawShadowFillRow {
  order_id: string | null;
  status: ShadowFillStatus;
  filled_quantity: number;
  fill_price_usd: number | null;
  fee_usd: number;
  book_age_ms: number | null;
  evaluated_at: string;
  reason_code: ShadowNoFillReason | null;
}

interface RawLifecycleEntryRow {
  market_id: string;
  to_state: ContractLifecycleState;
  transitioned_at: string;
}

interface RawRuleAuditRow {
  market_ticker: string;
  audit_status: 'CLEAR' | 'AMBIGUOUS';
  audited_at: string | null;
  effective_at: string;
}

interface RawTimestampRow {
  market_ticker?: string;
  captured_at: string;
}

interface RawForecastProvenanceRow {
  forecast_id: string | null;
  experiment_id: string | null;
  market_id: string | null;
  event_id: string | null;
  event_family_id: string | null;
  event_family_derivation_version: string | null;
  model_version: string | null;
  config_hash: string | null;
  code_commit_hash: string | null;
  data_snapshot_id: string | null;
  base_rate_version: string | null;
  ensemble_version: string | null;
  forecast_timestamp: string | null;
}

interface RawTriggerRow {
  tbl_name: string;
  sql: string | null;
}

function buildResearchQualitySection(
  db: DatabaseSync,
  experimentId: string,
  options: BuildDashboardOptions
): DashboardResearchQualitySection {
  // Explicitly force persistCalibratedForecasts: false so buildDashboard is 100% read-only.
  const report = evaluateExperiment(db, experimentId, {
    ...options.evaluationOptions,
    persistCalibratedForecasts: false,
  });

  const hasSettledScores = report.pooledScoring.sampleCount > 0;

  const calibrationSummary: DashboardCalibrationSummary = Object.freeze({
    status: report.calibration.status,
    skipReason: report.calibration.skipReason,
    selectedMethod: report.calibration.selectedMethod,
    trainCount: report.calibration.trainWindow?.count ?? 0,
    validationCount: report.calibration.validationWindow?.count ?? 0,
    forwardTestCount: report.calibration.forwardTestWindow?.count ?? 0,
    forwardTestRawBrier: report.calibration.forwardTestRaw?.brierScore ?? null,
    forwardTestCalibratedBrier: report.calibration.forwardTestCalibrated?.brierScore ?? null,
    forwardTestMarketBrier: report.calibration.forwardTestMarketReference?.brierScore ?? null,
  });

  if (!hasSettledScores) {
    return Object.freeze({
      status: 'INSUFFICIENT_DATA' as const,
      verdict: 'INSUFFICIENT_DATA' as const,
      verdictReasons: report.gate.reasons,
      hasSettledScores: false,
      sampleSize: 0,
      modelBrier: null,
      marketBrier: null,
      brierDiff: null,
      modelLogLoss: null,
      marketLogLoss: null,
      logLossDiff: null,
      coverage: report.denominatorTotals.coverage,
      denominatorTotals: report.denominatorTotals,
      denominatorByFamily: report.denominatorByFamily,
      perFamilyScores: Object.freeze([]),
      clusterBootstrapBrierDiff: report.clusterBootstrapBrierDiff,
      calibrationSummary,
      killGate: report.gate,
    });
  }

  return Object.freeze({
    status: report.gate.verdict,
    verdict: report.gate.verdict,
    verdictReasons: report.gate.reasons,
    hasSettledScores: true,
    sampleSize: report.pooledScoring.sampleCount,
    modelBrier: report.pooledScoring.model.brierScore,
    marketBrier: report.pooledScoring.marketReference.brierScore,
    brierDiff: report.pooledScoring.brierDiff,
    modelLogLoss: report.pooledScoring.model.logLoss,
    marketLogLoss: report.pooledScoring.marketReference.logLoss,
    logLossDiff: report.pooledScoring.logLossDiff,
    coverage: report.denominatorTotals.coverage,
    denominatorTotals: report.denominatorTotals,
    denominatorByFamily: report.denominatorByFamily,
    perFamilyScores: report.scoringByFamily,
    clusterBootstrapBrierDiff: report.clusterBootstrapBrierDiff,
    calibrationSummary,
    killGate: report.gate,
  });
}

function buildExecutionRealismSection(
  db: DatabaseSync,
  experimentId: string,
  asOfEpochMs: number
): DashboardExecutionRealismSection {
  const decisionRows = db
    .prepare(
      `SELECT outcome, decision_timestamp
       FROM shadow_decisions
       WHERE experiment_id = ?`
    )
    .all(experimentId) as unknown as RawShadowDecisionCountRow[];

  let decisionsTotal = 0;
  let noEdgeCount = 0;
  for (const row of decisionRows) {
    const ms = Date.parse(row.decision_timestamp);
    if (!Number.isFinite(ms) || ms > asOfEpochMs) continue;
    decisionsTotal += 1;
    if (row.outcome === 'NO_EDGE') {
      noEdgeCount += 1;
    }
  }

  const orderRows = db
    .prepare(
      `SELECT order_id, decision_price_usd, decision_timestamp
       FROM shadow_orders
       WHERE experiment_id = ?`
    )
    .all(experimentId) as unknown as RawShadowOrderRow[];

  const decisionPriceByOrderId = new Map<string, number>();
  let ordersTotal = 0;
  for (const row of orderRows) {
    const ms = Date.parse(row.decision_timestamp);
    if (!Number.isFinite(ms) || ms > asOfEpochMs) continue;
    ordersTotal += 1;
    decisionPriceByOrderId.set(row.order_id, Number(row.decision_price_usd));
  }

  const fillRows = db
    .prepare(
      `SELECT order_id, status, filled_quantity, fill_price_usd, fee_usd,
              book_age_ms, evaluated_at, reason_code
       FROM shadow_fills
       WHERE experiment_id = ?`
    )
    .all(experimentId) as unknown as RawShadowFillRow[];

  const fillsByStatus: Record<ShadowFillStatus, number> = {
    FILLED: 0,
    PARTIAL: 0,
    NO_FILL: 0,
  };
  const noFillReasons: Record<ShadowNoFillReason, number> = {
    NO_EDGE: 0,
    BOOK_NOT_CAPTURED: 0,
    STALE_BOOK: 0,
    INSUFFICIENT_DEPTH: 0,
  };

  let fillsTotal = 0;
  let totalFeesPaidUsd = 0;
  let bookAgeSum = 0;
  let bookAgeCount = 0;

  let executedFillCount = 0;
  let slippageSum = 0;
  let weightedSlippageNumerator = 0;
  let weightedSlippageQty = 0;
  let maxAdverseSlippage: number | null = null;
  let minSlippage: number | null = null;

  for (const row of fillRows) {
    const ms = Date.parse(row.evaluated_at);
    if (!Number.isFinite(ms) || ms > asOfEpochMs) continue;

    fillsTotal += 1;
    fillsByStatus[row.status] += 1;
    if (row.status === 'NO_FILL' && row.reason_code) {
      noFillReasons[row.reason_code] += 1;
    }

    if (row.book_age_ms !== null && Number.isFinite(Number(row.book_age_ms))) {
      bookAgeSum += Number(row.book_age_ms);
      bookAgeCount += 1;
    }

    if (row.status === 'FILLED' || row.status === 'PARTIAL') {
      totalFeesPaidUsd += Number(row.fee_usd);
      if (row.fill_price_usd !== null && row.order_id) {
        const decisionPrice = decisionPriceByOrderId.get(row.order_id);
        if (decisionPrice !== undefined && Number.isFinite(decisionPrice)) {
          const slippage = Number(row.fill_price_usd) - decisionPrice;
          const qty = Number(row.filled_quantity);
          executedFillCount += 1;
          slippageSum += slippage;
          weightedSlippageNumerator += slippage * qty;
          weightedSlippageQty += qty;
          if (maxAdverseSlippage === null || slippage > maxAdverseSlippage) {
            maxAdverseSlippage = slippage;
          }
          if (minSlippage === null || slippage < minSlippage) {
            minSlippage = slippage;
          }
        }
      }
    }
  }

  return Object.freeze({
    decisionsTotal,
    noEdgeCount,
    ordersTotal,
    fillsTotal,
    fillsByStatus: Object.freeze(fillsByStatus),
    noFillReasons: Object.freeze(noFillReasons),
    averageBookAgeMs: bookAgeCount > 0 ? cleanFloat(bookAgeSum / bookAgeCount) : null,
    totalFeesPaidUsd: cleanFloat(totalFeesPaidUsd),
    slippageSummary: Object.freeze({
      executedFillCount,
      meanSlippageUsd: executedFillCount > 0 ? cleanFloat(slippageSum / executedFillCount) : null,
      weightedMeanSlippageUsd:
        weightedSlippageQty > 0
          ? cleanFloat(weightedSlippageNumerator / weightedSlippageQty)
          : null,
      maxAdverseSlippageUsd: maxAdverseSlippage === null ? null : cleanFloat(maxAdverseSlippage),
      minSlippageUsd: minSlippage === null ? null : cleanFloat(minSlippage),
    }),
  });
}

function buildDataQualitySection(
  db: DatabaseSync,
  experimentId: string,
  asOfEpochMs: number
): DashboardDataQualitySection {
  // 1. Lifecycle history <= asOf
  const lifecycleRows = db
    .prepare(
      `SELECT market_id, to_state, transitioned_at
       FROM contract_lifecycle_history
       ORDER BY rowid ASC`
    )
    .all() as unknown as RawLifecycleEntryRow[];

  const latestStateByMarket = new Map<string, ContractLifecycleState>();
  const everApprovedMarkets = new Set<string>();
  const everRejectedMarkets = new Set<string>();

  for (const row of lifecycleRows) {
    const ms = Date.parse(row.transitioned_at);
    if (!Number.isFinite(ms) || ms > asOfEpochMs) continue;
    latestStateByMarket.set(row.market_id, row.to_state);
    if (row.to_state === 'APPROVED') {
      everApprovedMarkets.add(row.market_id);
    } else if (row.to_state === 'REJECTED') {
      everRejectedMarkets.add(row.market_id);
    }
  }

  const lifecycleStateCounts = {} as Record<ContractLifecycleState, number>;
  for (const st of CONTRACT_LIFECYCLE_STATES) {
    lifecycleStateCounts[st] = 0;
  }
  for (const st of latestStateByMarket.values()) {
    lifecycleStateCounts[st] += 1;
  }

  // 2. Market snapshots & orderbook states <= asOf
  const marketSnapshotRows = db
    .prepare(`SELECT market_ticker, captured_at FROM market_snapshots`)
    .all() as unknown as RawTimestampRow[];

  const discoveredMarketIds = new Set<string>(latestStateByMarket.keys());
  let marketSnapshotsCaptured = 0;
  for (const row of marketSnapshotRows) {
    const ms = Date.parse(row.captured_at);
    if (!Number.isFinite(ms) || ms > asOfEpochMs) continue;
    marketSnapshotsCaptured += 1;
    if (row.market_ticker) {
      discoveredMarketIds.add(row.market_ticker);
    }
  }

  const orderbookRows = db
    .prepare(`SELECT market_ticker, captured_at FROM orderbook_states`)
    .all() as unknown as RawTimestampRow[];

  let orderbookStatesCaptured = 0;
  for (const row of orderbookRows) {
    const ms = Date.parse(row.captured_at);
    if (!Number.isFinite(ms) || ms > asOfEpochMs) continue;
    orderbookStatesCaptured += 1;
  }

  // 3. Resolution audit counts (combine lifecycle APPROVED/REJECTED with rule-version audits for markets without lifecycle)
  const ruleAuditRows = db
    .prepare(
      `SELECT market_ticker, audit_status, audited_at, effective_at
       FROM settlement_rule_versions
       ORDER BY rowid ASC`
    )
    .all() as unknown as RawRuleAuditRow[];

  const latestRuleAuditByMarket = new Map<string, 'CLEAR' | 'AMBIGUOUS'>();
  for (const row of ruleAuditRows) {
    const ts = row.audited_at ?? row.effective_at;
    const ms = Date.parse(ts);
    if (!Number.isFinite(ms) || ms > asOfEpochMs) continue;
    latestRuleAuditByMarket.set(row.market_ticker, row.audit_status);
  }

  const approvedSet = new Set<string>(everApprovedMarkets);
  const rejectedSet = new Set<string>(everRejectedMarkets);
  for (const [marketTicker, status] of latestRuleAuditByMarket.entries()) {
    if (!approvedSet.has(marketTicker) && !rejectedSet.has(marketTicker)) {
      if (status === 'CLEAR') {
        approvedSet.add(marketTicker);
      } else {
        rejectedSet.add(marketTicker);
      }
    }
  }

  // 4. Forecast provenance completeness for this experiment (<= asOf)
  const forecastRows = db
    .prepare(
      `SELECT
         forecast_id, experiment_id, market_id, event_id,
         event_family_id, event_family_derivation_version,
         model_version, config_hash, code_commit_hash,
         data_snapshot_id, base_rate_version, ensemble_version,
         forecast_timestamp
       FROM probability_forecasts
       WHERE experiment_id = ?`
    )
    .all(experimentId) as unknown as RawForecastProvenanceRow[];

  let forecastsTotal = 0;
  let forecastsWithCompleteProvenance = 0;
  for (const row of forecastRows) {
    const ms = row.forecast_timestamp ? Date.parse(row.forecast_timestamp) : Number.NaN;
    if (!Number.isFinite(ms) || ms > asOfEpochMs) continue;
    forecastsTotal += 1;

    const complete =
      isNonEmptyString(row.forecast_id) &&
      isNonEmptyString(row.experiment_id) &&
      isNonEmptyString(row.market_id) &&
      isNonEmptyString(row.event_id) &&
      isNonEmptyString(row.event_family_id) &&
      isNonEmptyString(row.event_family_derivation_version) &&
      isNonEmptyString(row.model_version) &&
      isNonEmptyString(row.config_hash) &&
      isNonEmptyString(row.code_commit_hash) &&
      isNonEmptyString(row.data_snapshot_id) &&
      isNonEmptyString(row.base_rate_version) &&
      isNonEmptyString(row.ensemble_version) &&
      isNonEmptyString(row.forecast_timestamp);

    if (complete) {
      forecastsWithCompleteProvenance += 1;
    }
  }

  return Object.freeze({
    marketsDiscovered: discoveredMarketIds.size,
    auditsApproved: approvedSet.size,
    auditsRejected: rejectedSet.size,
    lifecycleStateCounts: Object.freeze(lifecycleStateCounts),
    snapshotsCaptured: marketSnapshotsCaptured + orderbookStatesCaptured,
    marketSnapshotsCaptured,
    orderbookStatesCaptured,
    forecastsTotal,
    forecastsWithCompleteProvenance,
    provenanceCompletenessShare:
      forecastsTotal > 0 ? cleanFloat(forecastsWithCompleteProvenance / forecastsTotal) : null,
  });
}

function buildIntegritySection(
  db: DatabaseSync,
  config: EventEdgeConfig
): DashboardIntegritySection {
  const triggerRows = db
    .prepare(
      `SELECT tbl_name, sql
       FROM sqlite_master
       WHERE type = 'trigger'`
    )
    .all() as unknown as RawTriggerRow[];

  const triggersByTable = new Map<string, string[]>();
  for (const row of triggerRows) {
    if (!row.tbl_name || !row.sql) continue;
    const list = triggersByTable.get(row.tbl_name) ?? [];
    list.push(row.sql);
    triggersByTable.set(row.tbl_name, list);
  }

  const tableTriggerChecks: LedgerTableTriggerCheck[] = EVENTEDGE_LEDGER_TABLES.map((tableName) => {
    const sqlList = triggersByTable.get(tableName) ?? [];
    const hasBeforeUpdateAbort = sqlList.some(
      (sql) => /BEFORE\s+UPDATE/i.test(sql) && /RAISE\s*\(\s*ABORT/i.test(sql)
    );
    const hasBeforeDeleteAbort = sqlList.some(
      (sql) => /BEFORE\s+DELETE/i.test(sql) && /RAISE\s*\(\s*ABORT/i.test(sql)
    );
    return Object.freeze({
      tableName,
      hasBeforeUpdateAbort,
      hasBeforeDeleteAbort,
      passed: hasBeforeUpdateAbort && hasBeforeDeleteAbort,
    });
  });

  const allTriggersPresent = tableTriggerChecks.every((c) => c.passed);

  const appliedMigrations = getAppliedMigrations(db);
  const migrationVersion =
    appliedMigrations.length > 0
      ? appliedMigrations[appliedMigrations.length - 1].version
      : 0;

  const configHash = computeEventEdgeConfigHash(config);

  // Actively verify LIVE mode hard-disable lock
  let liveConstructionRejected = false;
  try {
    createEventEdgeConfig({ mode: 'LIVE' }, {});
  } catch (err) {
    if (err instanceof EventEdgeLiveModeDisabledError) {
      liveConstructionRejected = true;
    }
  }

  const livePassed =
    config.liveEnabled === false &&
    (config.mode as string) !== 'LIVE' &&
    liveConstructionRejected;

  const liveDisabledAssertion: LiveDisabledAssertionCheck = Object.freeze({
    passed: livePassed,
    activeMode: config.mode,
    detail: livePassed
      ? `LIVE mode hard-disabled verified (active mode=${config.mode}, liveEnabled=false, LIVE constructor throws EventEdgeLiveModeDisabledError).`
      : 'LIVE mode hard-disable assertion FAILED.',
  });

  return Object.freeze({
    allTriggersPresent,
    tableTriggerChecks: Object.freeze(tableTriggerChecks),
    migrationVersion,
    appliedMigrationCount: appliedMigrations.length,
    configHash,
    liveDisabledAssertion,
  });
}

/**
 * Strictly read-only dashboard data assembler.
 *
 * Assembles all six quality-first research dashboard sections in the mandated order:
 *   1. `researchQuality`
 *   2. `executionRealism`
 *   3. `dataQuality`
 *   4. `risk`
 *   5. `integrity`
 *   6. `paperPnl`
 *
 * Writes NOTHING to the SQLite ledger. `LIVE` mode stays hard-disabled.
 */
export function buildDashboard(
  db: DatabaseSync,
  experimentId: string,
  asOf: string,
  options: BuildDashboardOptions = {}
): EventEdgeDashboard {
  const trimmedExperimentId = experimentId.trim();
  if (!trimmedExperimentId) {
    throw new DashboardValidationError('experimentId must be a non-empty string.');
  }

  const trimmedAsOf = asOf.trim();
  const asOfEpochMs = Date.parse(trimmedAsOf);
  if (!Number.isFinite(asOfEpochMs)) {
    throw new DashboardValidationError(
      `Invalid asOf timestamp "${asOf}". Expected ISO-8601 UTC timestamp.`
    );
  }

  const config = options.config ?? createEventEdgeConfig({ mode: 'PAPER' });
  assertNonLiveMode(config.mode, 'dashboard.buildDashboard');
  if (config.liveEnabled !== false) {
    throw new EventEdgeLiveModeDisabledError('dashboard.buildDashboard#liveEnabled');
  }

  const settledCash = options.settledCash ?? DEFAULT_DASHBOARD_PAPER_BANKROLL_USD;
  if (!Number.isFinite(settledCash) || settledCash <= 0) {
    throw new DashboardValidationError(
      `settledCash must be a positive finite number (received ${String(settledCash)}).`
    );
  }

  const experiment = getExperiment(db, trimmedExperimentId);
  if (!experiment) {
    throw new ExperimentNotFoundError(trimmedExperimentId);
  }

  // (a) Research Quality (EE-04 kill-gate report, strictly read-only)
  const researchQuality = buildResearchQualitySection(db, trimmedExperimentId, options);

  // (b) Execution Realism (EE-05 shadow statistics)
  const executionRealism = buildExecutionRealismSection(db, trimmedExperimentId, asOfEpochMs);

  // (c) Data Quality (EE-01 / EE-03 ledger counts & provenance completeness)
  const dataQuality = buildDataQualitySection(db, trimmedExperimentId, asOfEpochMs);

  // (d) Risk & (f) Paper PnL (both derived read-only from EE-06 buildPortfolioState)
  const portfolio = buildPortfolioState(db, trimmedExperimentId, trimmedAsOf, {
    settledCash,
    config,
  });

  const risk: DashboardRiskSection = Object.freeze({
    systemState: portfolio.systemState,
    deployedPct: portfolio.deployedPct,
    maxDeployedBankrollPct: portfolio.riskConfig.maxDeployedBankrollPct,
    exposureByEventFamily: portfolio.exposureByEventFamily,
    dailyPnlUsd: portfolio.dailyPnl,
    dailyLossPct: portfolio.dailyLossPct,
    dailyLossStopPct: portfolio.riskConfig.dailyLossStopPct,
    drawdownPct: portfolio.drawdownPct,
    peakToTroughDrawdownStopPct: portfolio.riskConfig.peakToTroughDrawdownStopPct,
    pendingExposureUsd: portfolio.pendingExposure,
  });

  // (e) Integrity (trigger audit for every ledger table, migration version, config hash, LIVE lock)
  const integrity = buildIntegritySection(db, config);

  // (f) Paper PnL (Paper Only)
  const paperPnl: DashboardPaperPnlSection = Object.freeze({
    label: 'PAPER_ONLY' as const,
    settledCashUsd: portfolio.settledCash,
    realizedPnlUsd: portfolio.realizedPnl,
    unrealizedPnlUsd: portfolio.unrealizedPnl,
    totalPaperPnlUsd: cleanFloat(portfolio.realizedPnl + portfolio.unrealizedPnl),
    currentPaperEquityUsd: portfolio.currentEquity,
    openPositionCount: portfolio.openPositions.length,
  });

  // Mandated section key order
  const sections: DashboardSections = Object.freeze({
    researchQuality,
    executionRealism,
    dataQuality,
    risk,
    integrity,
    paperPnl,
  });

  return Object.freeze({
    experimentId: experiment.experimentId,
    experimentTitle: experiment.title,
    experimentStatus: experiment.status,
    asOf: trimmedAsOf,
    disclaimer: DASHBOARD_MANDATORY_DISCLAIMER,
    sections,
    researchQuality,
    executionRealism,
    dataQuality,
    risk,
    integrity,
    paperPnl,
  });
}
