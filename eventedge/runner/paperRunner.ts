import type { DatabaseSync } from 'node:sqlite';
import {
  EventEdgeLiveModeDisabledError,
  assertNonLiveMode,
  computeEventEdgeConfigHash,
  createEventEdgeConfig,
  type EventEdgeConfig,
  type EventEdgeMode,
} from '../config/index';
import { buildDashboard, type EventEdgeDashboard } from '../dashboard/index';
import { EVENTEDGE_LEDGER_TABLES } from '../db/schema';
import {
  fetchPublicKalshiMarketByTicker,
  normalizeKalshiMarketToSnapshot,
  persistMarketSnapshot,
  type KalshiPublicClientOptions,
  type KalshiRawEvent,
  type KalshiRawMarket,
  type NormalizedMarketSnapshot,
} from '../discovery/index';
import { ExperimentNotFoundError, getExperiment } from '../experiments/registry';
import {
  createReferenceFeatureTransformQuantEstimator,
  createReferenceLaplaceBaseRateEstimator,
  deriveEventFamilyId,
  evaluatePriceBlindForecast,
  type BaseRateEstimator,
  type ForecastRecord,
  type QuantitativeEstimator,
  type ReferenceClass,
  type ResearchDataSnapshot,
} from '../forecasting/index';
import {
  auditContractInLifecycle,
  getContractLifecycleState,
  listContractsInLifecycleStates,
  recordContractSettlement,
  registerDiscoveredContract,
  transitionContractLifecycle,
  type ContractLifecycleState,
  type SettlementOutcomeCode,
} from '../lifecycle/index';
import { getForecastsForExperiment, saveForecast } from '../persistence/index';
import {
  applySystemStateEvaluation,
  buildPortfolioState,
  computeMaxQuantity,
  computeMaxQuantityBreakdown,
  evaluateRisk,
  evaluateSystemState,
  getCurrentRiskSystemState,
  type RiskSystemState,
} from '../risk/index';
import {
  DecisionBookNotFoundError,
  computeShadowEdges,
  computeShadowFillFee,
  executeShadowDecision,
  findDecisionBookSnapshot,
  persistOrderbookState,
  type PersistOrderbookStateInput,
  type ShadowFillStatus,
  type ShadowOrderSide,
} from '../shadow/index';
import {
  SAMPLE_KALSHI_EVENTS_PAGE_1,
  SAMPLE_KALSHI_EVENTS_PAGE_2,
  SAMPLE_KALSHI_STANDALONE_MARKETS,
  createFixtureKalshiFetch,
} from '../tests/fixtures/kalshiPayloads';
import { runObserveCycle, type ObserveRunSummary } from './observeRunner';

export const PAPER_RUNNER_ALLOWED_MODES = ['OBSERVE', 'PAPER'] as const;
export type PaperRunnerAllowedMode = (typeof PAPER_RUNNER_ALLOWED_MODES)[number];

const DEFAULT_PAPER_BANKROLL_USD = 10_000;
const DEFAULT_RUNNER_ACTOR = 'eventedge_paper_runner';
const DEFAULT_QUANT_FEATURE_NAME = 'days_to_close';
const DEFAULT_QUANT_CENTER = 7;
const DEFAULT_QUANT_SCALE = 3;

/**
 * Thrown when `runPaperCycle` is called with a disallowed mode (such as `DEMO` or any
 * unknown mode; `LIVE` is also hard-blocked by EE-00's `assertNonLiveMode`).
 */
export class PaperRunnerModeError extends Error {
  public readonly code = 'EVENTEDGE_PAPER_RUNNER_MODE_REJECTED' as const;
  public readonly requestedMode: string;

  constructor(requestedMode: string, detail?: string) {
    const suffix = detail ? ` (${detail})` : '';
    super(
      `EventEdge paper runner only permits OBSERVE or PAPER mode (received "${requestedMode}")${suffix}. DEMO and LIVE modes are rejected.`
    );
    this.name = 'PaperRunnerModeError';
    this.requestedMode = requestedMode;
  }
}

/**
 * Thrown when the active EE-00 config hash (including EE-05 shadow config) does not match
 * the `config_hash` frozen on the registered experiment record.
 */
export class FrozenConfigMismatchError extends Error {
  public readonly code = 'EVENTEDGE_FROZEN_CONFIG_MISMATCH' as const;
  public readonly experimentId: string;
  public readonly registeredConfigHash: string;
  public readonly currentConfigHash: string;

  constructor(experimentId: string, registeredConfigHash: string, currentConfigHash: string) {
    super(
      `Frozen config mismatch for experiment "${experimentId}": registered config_hash="${registeredConfigHash}", current config_hash="${currentConfigHash}". No retuning or config modification is allowed inside a registered experiment.`
    );
    this.name = 'FrozenConfigMismatchError';
    this.experimentId = experimentId;
    this.registeredConfigHash = registeredConfigHash;
    this.currentConfigHash = currentConfigHash;
  }
}

export interface PaperCycleOrderbookFixture {
  readonly orderbookStateId: string;
  readonly bestBidUsd: number;
  readonly bestAskUsd: number;
  readonly yesBidSizeFp: number;
  readonly yesAskSizeFp: number;
  readonly capturedAt: string;
  readonly lhs?: number | null;
}

export interface PaperCycleFixtures {
  /** Custom public Kalshi `fetch` implementation (zero live network). */
  readonly fetchFn?: typeof fetch;
  /** Optional override for EE-01 `/events` page 1 payload (defaults to EE-01 fixture). */
  readonly eventsPage1?: { events: KalshiRawEvent[]; cursor: string };
  /** Optional override for EE-01 `/events` page 2 payload (defaults to EE-01 fixture). */
  readonly eventsPage2?: { events: KalshiRawEvent[]; cursor: string };
  /** Optional override for EE-01 standalone `/markets` payload (defaults to EE-01 fixture). */
  readonly standaloneMarkets?: { markets: KalshiRawMarket[]; cursor: string };
  /** Optional per-ticker payloads served on public `GET /markets/{ticker}` during settlement checks. */
  readonly marketByTicker?: Readonly<Record<string, KalshiRawMarket>>;
  /** Optional explicit price-blind `ReferenceClass` inputs keyed by `marketId`. */
  readonly referenceClassesByMarket?: Readonly<Record<string, ReferenceClass>>;
  /** Optional explicit price-blind `ResearchDataSnapshot` inputs keyed by `marketId`. */
  readonly researchSnapshotsByMarket?: Readonly<Record<string, ResearchDataSnapshot>>;
  /** Optional orderbook depth snapshots captured into `orderbook_states` keyed by `marketId`. */
  readonly orderbooksByMarket?: Readonly<Record<string, readonly PaperCycleOrderbookFixture[]>>;
}

export type PaperCycleResearchProvider = (context: {
  readonly snapshot: NormalizedMarketSnapshot;
  readonly eventFamilyId: string;
  readonly asOf: string;
}) => {
  readonly referenceClass?: ReferenceClass | null;
  readonly researchSnapshot?: ResearchDataSnapshot | null;
};

export interface RunPaperCycleInput {
  readonly experimentId: string;
  readonly mode: EventEdgeMode | string;
  readonly asOf: string;
  /** Optional validated config matching the experiment's frozen `config_hash`. */
  readonly config?: EventEdgeConfig;
  /** Optional env map forwarded to `createEventEdgeConfig` when `config` is omitted. */
  readonly env?: Record<string, string | undefined>;
  /** Paper bankroll (settled cash) in USD used for EE-06 risk & EE-07 dashboard (default 10000). */
  readonly settledCash?: number;
  /**
   * Dry-run offline fixture mode:
   * - `true`: reads default EE-01 Kalshi test fixtures instead of the network.
   * - `PaperCycleFixtures`: reads supplied/EE-01 fixture payloads and optional offline research/orderbook inputs.
   * - omitted / `undefined`: uses the live EE-01 public Kalshi client (no auth headers; operator-only).
   */
  readonly fixtures?: boolean | PaperCycleFixtures;
  /** Optional price-blind research data provider for EE-02 estimators. */
  readonly researchProvider?: PaperCycleResearchProvider;
  /** Optional EE-02 BaseRateEstimator override (defaults to EE-02 reference Laplace estimator). */
  readonly baseRateEstimator?: BaseRateEstimator;
  /** Optional EE-02 QuantitativeEstimator override (defaults to EE-02 fixed-logistic transform estimator). */
  readonly quantEstimator?: QuantitativeEstimator;
  /** Optional code commit hash forwarded to EE-02 provenance. */
  readonly codeCommitHash?: string;
  /** Optional actor name recorded on lifecycle & risk state transitions. */
  readonly actor?: string;
  /** Data freshness signal forwarded to EE-06 `evaluateSystemState` (default `true`). */
  readonly dataFresh?: boolean;
  /** Reconciliation flag forwarded to EE-06 `evaluateSystemState` (default `false`). */
  readonly reconciliationPending?: boolean;
}

export type PaperCycleMarketOutcomeStatus =
  | 'DISCOVERY_FILTERED'
  | 'AUDIT_REJECTED'
  | 'FORECAST_ABSTAINED'
  | 'RISK_SKIPPED_NO_BOOK'
  | 'RISK_REJECTED'
  | 'RISK_APPROVED_OBSERVE_ONLY'
  | 'SHADOW_NO_EDGE'
  | 'SHADOW_EXECUTED'
  | 'ALREADY_FORECASTED'
  | 'AWAITING_SETTLEMENT'
  | 'SETTLED'
  | 'TERMINAL_STATE';

export interface PaperCycleMarketOutcome {
  readonly marketId: string;
  readonly eventId: string;
  readonly eventFamilyId: string;
  readonly lifecycleState: ContractLifecycleState | null;
  readonly status: PaperCycleMarketOutcomeStatus;
  readonly reasonCodes: readonly string[];
  readonly forecastId: string | null;
  readonly modelProbability: number | null;
  readonly side: ShadowOrderSide | null;
  readonly approvedQuantity: number;
  readonly decisionId: string | null;
  readonly orderId: string | null;
  readonly fillId: string | null;
  readonly fillStatus: ShadowFillStatus | null;
  readonly settlementOutcome: SettlementOutcomeCode | null;
}

export interface PaperCycleStageCounts {
  readonly discoveredFetched: number;
  readonly discoveryFilteredOut: number;
  readonly scanned: number;
  readonly newlyRegisteredDiscovered: number;
  readonly auditedCount: number;
  readonly approvedCount: number;
  readonly rejectedCount: number;
  readonly forecastedCount: number;
  readonly abstainedCount: number;
  readonly riskEvaluatedCount: number;
  readonly riskApprovedCount: number;
  readonly riskRejectedCount: number;
  readonly shadowDecisionsCreated: number;
  readonly shadowOrdersCreated: number;
  readonly shadowFillsExecuted: number;
  readonly advancedToSettlementPending: number;
  readonly settledCount: number;
}

export interface PaperCycleReport {
  readonly experimentId: string;
  readonly mode: PaperRunnerAllowedMode;
  readonly asOf: string;
  readonly configHash: string;
  readonly usedFixtures: boolean;
  readonly systemState: RiskSystemState;
  readonly counts: PaperCycleStageCounts;
  readonly marketOutcomes: readonly PaperCycleMarketOutcome[];
  readonly observeSummary: ObserveRunSummary;
  readonly dashboard: EventEdgeDashboard;
}

function dedupeStrings(items: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const trimmed = item.trim();
    if (trimmed.length > 0 && !seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return Object.freeze(out);
}

function checkLedgerTriggersIntegrity(db: DatabaseSync): boolean {
  const rows = db
    .prepare(`SELECT tbl_name, sql FROM sqlite_master WHERE type = 'trigger'`)
    .all() as unknown as Array<{ tbl_name: string; sql: string | null }>;

  const sqlByTable = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.tbl_name || !row.sql) continue;
    const list = sqlByTable.get(row.tbl_name) ?? [];
    list.push(row.sql);
    sqlByTable.set(row.tbl_name, list);
  }

  return EVENTEDGE_LEDGER_TABLES.every((tableName) => {
    const sqlList = sqlByTable.get(tableName) ?? [];
    const hasUpdate = sqlList.some(
      (sql) => /BEFORE\s+UPDATE/i.test(sql) && /RAISE\s*\(\s*ABORT/i.test(sql)
    );
    const hasDelete = sqlList.some(
      (sql) => /BEFORE\s+DELETE/i.test(sql) && /RAISE\s*\(\s*ABORT/i.test(sql)
    );
    return hasUpdate && hasDelete;
  });
}

function parseKalshiSettlementOutcome(market: KalshiRawMarket): SettlementOutcomeCode | null {
  const rawResult = typeof market.result === 'string' ? market.result.trim().toLowerCase() : '';
  const rawStatus = typeof market.status === 'string' ? market.status.trim().toLowerCase() : '';

  const isSettledStatus =
    rawStatus === 'settled' ||
    rawStatus === 'finalized' ||
    rawStatus === 'determined' ||
    rawStatus === 'resolved' ||
    rawStatus === 'closed';

  if (rawResult === 'yes' || rawResult === 'all_yes') return 'YES';
  if (rawResult === 'no' || rawResult === 'all_no') return 'NO';
  if (rawResult === 'void' || rawResult === 'voided') return 'VOID';
  if (rawResult === 'cancelled' || rawResult === 'canceled') return 'CANCELLED';

  if (isSettledStatus && typeof market.settlement_value === 'number' && Number.isFinite(market.settlement_value)) {
    if (market.settlement_value === 100 || market.settlement_value === 1) return 'YES';
    if (market.settlement_value === 0) return 'NO';
  }

  return null;
}

function extractRawMarketFromSnapshot(snapshot: NormalizedMarketSnapshot): KalshiRawMarket | null {
  try {
    const parsed = JSON.parse(snapshot.rawPayloadJson) as { market?: KalshiRawMarket };
    if (parsed && parsed.market && typeof parsed.market === 'object') {
      return parsed.market;
    }
    return null;
  } catch {
    return null;
  }
}

function resolveFixtureClientOptions(fixtures: boolean | PaperCycleFixtures): {
  readonly clientOptions: KalshiPublicClientOptions;
  readonly fixtureConfig: PaperCycleFixtures;
} {
  const fixtureConfig: PaperCycleFixtures =
    typeof fixtures === 'object' && fixtures !== null ? fixtures : {};

  const baseFixtureFetch =
    fixtureConfig.fetchFn ??
    createFixtureKalshiFetch({
      eventsPage1: fixtureConfig.eventsPage1 ?? SAMPLE_KALSHI_EVENTS_PAGE_1,
      eventsPage2: fixtureConfig.eventsPage2 ?? SAMPLE_KALSHI_EVENTS_PAGE_2,
      standaloneMarkets: fixtureConfig.standaloneMarkets ?? SAMPLE_KALSHI_STANDALONE_MARKETS,
    }).fetchFn;

  // Build lookup map for `/markets/{ticker}` from explicit marketByTicker plus fixture payloads
  const tickerLookup = new Map<string, KalshiRawMarket>();
  const addFromEvents = (events?: readonly KalshiRawEvent[]) => {
    if (!events) return;
    for (const ev of events) {
      if (Array.isArray(ev.markets)) {
        for (const m of ev.markets) {
          if (m && typeof m.ticker === 'string' && m.ticker) {
            tickerLookup.set(m.ticker, {
              ...m,
              event_ticker: m.event_ticker ?? ev.event_ticker,
              category: m.category ?? ev.category,
            });
          }
        }
      }
    }
  };
  addFromEvents((fixtureConfig.eventsPage1 ?? SAMPLE_KALSHI_EVENTS_PAGE_1).events);
  addFromEvents((fixtureConfig.eventsPage2 ?? SAMPLE_KALSHI_EVENTS_PAGE_2).events);
  for (const m of (fixtureConfig.standaloneMarkets ?? SAMPLE_KALSHI_STANDALONE_MARKETS).markets) {
    if (m && typeof m.ticker === 'string' && m.ticker) {
      tickerLookup.set(m.ticker, m);
    }
  }
  if (fixtureConfig.marketByTicker) {
    for (const [ticker, m] of Object.entries(fixtureConfig.marketByTicker)) {
      tickerLookup.set(ticker, m);
    }
  }

  const wrappedFetch: typeof fetch = async (input, init) => {
    const urlStr =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const parsed = new URL(urlStr);
    const singleMarketMatch = parsed.pathname.match(/\/markets\/([^/]+)$/);
    if (singleMarketMatch && singleMarketMatch[1]) {
      const ticker = decodeURIComponent(singleMarketMatch[1]);
      if (fixtureConfig.marketByTicker && fixtureConfig.marketByTicker[ticker]) {
        return new Response(JSON.stringify({ market: fixtureConfig.marketByTicker[ticker] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (fixtureConfig.fetchFn) {
        const delegated = await fixtureConfig.fetchFn(input, init);
        if (delegated.status !== 404) {
          return delegated;
        }
      }
      const fallbackMarket = tickerLookup.get(ticker);
      if (fallbackMarket) {
        return new Response(JSON.stringify({ market: fallbackMarket }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: `Market not found in fixtures: ${ticker}` }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    return baseFixtureFetch(input, init);
  };

  return {
    fixtureConfig,
    clientOptions: {
      fetchFn: wrappedFetch,
      rateLimitDelayMs: 0,
    },
  };
}

function buildHistoricalFamilyReferenceClass(
  db: DatabaseSync,
  eventFamilyId: string,
  asOf: string,
  minSampleCount: number
): ReferenceClass | null {
  const asOfMs = Date.parse(asOf);
  const rows = db
    .prepare(
      `SELECT market_ticker, event_ticker, outcome, settled_at
       FROM settlements
       WHERE outcome IN ('YES', 'NO')`
    )
    .all() as unknown as Array<{
    market_ticker: string;
    event_ticker: string;
    outcome: 'YES' | 'NO';
    settled_at: string;
  }>;

  let sampleCount = 0;
  let positiveCount = 0;
  let earliestIso: string | null = null;
  let latestIso: string | null = null;

  for (const row of rows) {
    const settledMs = Date.parse(row.settled_at);
    if (!Number.isFinite(settledMs) || settledMs > asOfMs) continue;
    const derived = deriveEventFamilyId(row.event_ticker).eventFamilyId;
    if (derived !== eventFamilyId) continue;
    sampleCount += 1;
    if (row.outcome === 'YES') positiveCount += 1;
    if (!earliestIso || settledMs < Date.parse(earliestIso)) earliestIso = row.settled_at;
    if (!latestIso || settledMs > Date.parse(latestIso)) latestIso = row.settled_at;
  }

  if (sampleCount < minSampleCount) {
    return null;
  }

  return Object.freeze({
    definition: `Historical resolved binary outcomes in event family ${eventFamilyId}`,
    inclusionCriteria: `All RESOLVED YES/NO settlements in family ${eventFamilyId} with settled_at <= ${asOf}`,
    sampleCount,
    positiveCount,
    timeWindow: `${earliestIso ?? asOf}..${latestIso ?? asOf}`,
    source: 'eventedge_ledger_settlements',
  });
}

function buildDefaultPriceBlindResearchSnapshot(
  snapshot: NormalizedMarketSnapshot,
  asOf: string
): ResearchDataSnapshot {
  const asOfMs = Date.parse(asOf);
  const targetClose = snapshot.closeTimeUtc ?? snapshot.expirationTimeUtc;
  const closeMs = targetClose ? Date.parse(targetClose) : Number.NaN;
  const daysToClose =
    Number.isFinite(closeMs) && Number.isFinite(asOfMs)
      ? Number(((closeMs - asOfMs) / 86_400_000).toFixed(6))
      : null;

  const rawMarket = extractRawMarketFromSnapshot(snapshot);
  const hasSecondaryRules =
    typeof rawMarket?.rules_secondary === 'string' && rawMarket.rules_secondary.trim().length > 0
      ? 1
      : 0;
  const settlementSourceCount = snapshot.settlementSourceName
    ? snapshot.settlementSourceName.split(';').filter((s) => s.trim().length > 0).length
    : 0;

  const features: Record<string, number | string | boolean | null> = {
    has_secondary_rules: hasSecondaryRules,
    settlement_source_count: settlementSourceCount,
    category_label: snapshot.category ?? 'uncategorized',
  };
  if (daysToClose !== null) {
    features[DEFAULT_QUANT_FEATURE_NAME] = daysToClose;
  }

  return Object.freeze({
    dataSnapshotId: `res_${snapshot.snapshotId}`,
    capturedAt: asOf,
    source: 'eventedge_contract_metadata_price_blind',
    features: Object.freeze(features),
  });
}

function getLatestMarketSnapshotMeta(
  db: DatabaseSync,
  marketId: string
): {
  readonly eventTicker: string;
  readonly closeTimeUtc: string | null;
  readonly expirationTimeUtc: string | null;
} | null {
  const row = db
    .prepare(
      `SELECT event_ticker, close_time_utc, expiration_time_utc
       FROM market_snapshots
       WHERE market_ticker = ?
       ORDER BY captured_at DESC, rowid DESC
       LIMIT 1`
    )
    .get(marketId) as
    | {
        event_ticker: string;
        close_time_utc: string | null;
        expiration_time_utc: string | null;
      }
    | undefined;

  if (!row) return null;
  return {
    eventTicker: row.event_ticker,
    closeTimeUtc: row.close_time_utc,
    expirationTimeUtc: row.expiration_time_utc,
  };
}

function getLatestRuleVersionIdForMarket(db: DatabaseSync, marketId: string): string | null {
  const row = db
    .prepare(
      `SELECT rule_version_id
       FROM settlement_rule_versions
       WHERE market_ticker = ?
       ORDER BY version_number DESC, rowid DESC
       LIMIT 1`
    )
    .get(marketId) as { rule_version_id: string } | undefined;
  return row ? row.rule_version_id : null;
}

function persistOrderbookFixtureIfMissing(
  db: DatabaseSync,
  marketTicker: string,
  fixture: PaperCycleOrderbookFixture
): void {
  const existing = db
    .prepare(`SELECT 1 AS found FROM orderbook_states WHERE orderbook_state_id = ? LIMIT 1`)
    .get(fixture.orderbookStateId) as { found: number } | undefined;
  if (existing) return;

  const input: PersistOrderbookStateInput = {
    orderbookStateId: fixture.orderbookStateId,
    marketTicker,
    bestBidUsd: fixture.bestBidUsd,
    bestAskUsd: fixture.bestAskUsd,
    yesBidSizeFp: fixture.yesBidSizeFp,
    yesAskSizeFp: fixture.yesAskSizeFp,
    capturedAt: fixture.capturedAt,
    lhs: fixture.lhs ?? null,
  };
  persistOrderbookState(db, input);
}

/**
 * Executes one complete EventEdge paper validation cycle using existing modules only:
 * (a) Mode guard (`OBSERVE` or `PAPER` only; `DEMO` and `LIVE` rejected; EE-00 `assertNonLiveMode` invoked).
 * (b) Frozen-config hash check against the registered experiment (`FrozenConfigMismatchError` on mismatch).
 * (c) Discovery via EE-01 public client + `runObserveCycle`, registering new contracts as `DISCOVERED -> AUDIT_PENDING`.
 * (d) Resolution audit via EE-03 `auditContractInLifecycle` (`APPROVED` / `REJECTED`).
 * (e) Price-blind forecasting via EE-02 reference estimators, persisted via EE-03 `saveForecast` (`p_base`, `p_quant`, `p_ensemble`).
 * (f) Risk evaluation via EE-06 (`evaluateSystemState`, `evaluateRisk`, `computeMaxQuantity`); zero quantity or rejections recorded with reason codes.
 * (g) Shadow execution via EE-05 `executeShadowDecision` for approved quantities (in `PAPER` mode).
 * (h) Lifecycle advancement (`ACTIVE -> SETTLEMENT_PENDING` after close time) and discovery-sourced settlement recording (`RESOLVED` / `VOIDED` strictly from EE-01 discovery payloads, never invented).
 *
 * Returns per-stage counts, per-market outcomes (every discovered market accounted for, zero silent skips),
 * and the read-only EE-07 dashboard after the cycle.
 */
export async function runPaperCycle(
  db: DatabaseSync,
  input: RunPaperCycleInput
): Promise<PaperCycleReport> {
  // -------------------------------------------------------------------------
  // (a) Mode guard — invoke EE-00 assertNonLiveMode and strictly allow OBSERVE | PAPER
  // -------------------------------------------------------------------------
  if (typeof input.mode !== 'string' || input.mode.trim().length === 0) {
    throw new PaperRunnerModeError(String(input.mode), 'mode must be a non-empty string');
  }
  const nonLiveMode = assertNonLiveMode(input.mode, 'paperRunner.runPaperCycle');
  if (nonLiveMode !== 'OBSERVE' && nonLiveMode !== 'PAPER') {
    throw new PaperRunnerModeError(nonLiveMode, 'only OBSERVE and PAPER are permitted');
  }
  const mode: PaperRunnerAllowedMode = nonLiveMode;

  const experimentId = input.experimentId?.trim() ?? '';
  if (!experimentId) {
    throw new Error('runPaperCycle requires a non-empty experimentId.');
  }

  const asOf = input.asOf?.trim() ?? '';
  const asOfEpochMs = Date.parse(asOf);
  if (!Number.isFinite(asOfEpochMs)) {
    throw new Error(`Invalid asOf timestamp "${input.asOf}". Expected ISO-8601 UTC timestamp.`);
  }
  const asOfDate = new Date(asOfEpochMs);

  const settledCash = input.settledCash ?? DEFAULT_PAPER_BANKROLL_USD;
  if (!Number.isFinite(settledCash) || settledCash <= 0) {
    throw new Error(`settledCash must be a positive finite number (received ${String(settledCash)}).`);
  }

  const actor = input.actor?.trim() || DEFAULT_RUNNER_ACTOR;

  // Validate config and ensure LIVE is hard-disabled on any supplied config as well
  const config: EventEdgeConfig =
    input.config ?? createEventEdgeConfig({ mode }, input.env ?? process.env);
  const configNonLiveMode = assertNonLiveMode(config.mode, 'paperRunner.config');
  if (config.liveEnabled !== false) {
    throw new EventEdgeLiveModeDisabledError('paperRunner.config#liveEnabled');
  }
  if (configNonLiveMode !== 'OBSERVE' && configNonLiveMode !== 'PAPER') {
    throw new PaperRunnerModeError(configNonLiveMode, 'config.mode must be OBSERVE or PAPER');
  }
  if (configNonLiveMode !== mode) {
    throw new PaperRunnerModeError(
      configNonLiveMode,
      `config.mode="${configNonLiveMode}" disagrees with requested mode="${mode}"`
    );
  }

  // -------------------------------------------------------------------------
  // (b) Frozen-config check against the registered experiment
  // -------------------------------------------------------------------------
  const experiment = getExperiment(db, experimentId);
  if (!experiment) {
    throw new ExperimentNotFoundError(experimentId);
  }

  const currentConfigHash = computeEventEdgeConfigHash(config);
  if (currentConfigHash !== experiment.configHash) {
    throw new FrozenConfigMismatchError(experimentId, experiment.configHash, currentConfigHash);
  }

  // -------------------------------------------------------------------------
  // (c) Discovery via EE-01 public client and observeRunner
  // -------------------------------------------------------------------------
  const usedFixtures = input.fixtures !== undefined && input.fixtures !== false;
  let clientOptions: KalshiPublicClientOptions | undefined;
  let fixtureConfig: PaperCycleFixtures | null = null;
  if (usedFixtures) {
    const resolved = resolveFixtureClientOptions(input.fixtures!);
    clientOptions = resolved.clientOptions;
    fixtureConfig = resolved.fixtureConfig;
  }

  const observeConfig: EventEdgeConfig =
    config.mode === 'OBSERVE'
      ? config
      : createEventEdgeConfig(
          {
            mode: 'OBSERVE',
            ledgerDbPath: config.ledgerDbPath,
            risk: config.risk,
            discovery: config.discovery,
            forecasting: config.forecasting,
            shadow: config.shadow,
          },
          {}
        );

  const observeResult = await runObserveCycle({
    db,
    config: observeConfig,
    clientOptions,
    now: asOfDate,
  });

  // Track every market outcome by marketId so zero discovered markets are ever silently skipped
  const outcomesByMarket = new Map<string, PaperCycleMarketOutcome>();
  const setOutcome = (outcome: PaperCycleMarketOutcome): void => {
    outcomesByMarket.set(outcome.marketId, Object.freeze(outcome));
  };

  let newlyRegisteredDiscovered = 0;
  let auditedCount = 0;
  let approvedCount = 0;
  let rejectedCount = 0;
  let forecastedCount = 0;
  let abstainedCount = 0;
  let riskEvaluatedCount = 0;
  let riskApprovedCount = 0;
  let riskRejectedCount = 0;
  let shadowDecisionsCreated = 0;
  let shadowOrdersCreated = 0;
  let shadowFillsExecuted = 0;
  let advancedToSettlementPending = 0;
  let settledCount = 0;

  // Record every discovery-filtered market explicitly (no silent skip)
  for (const excluded of observeResult.discovery.excludedMarkets) {
    const marketId = excluded.snapshot.marketTicker;
    const eventId = excluded.snapshot.eventTicker;
    const eventFamilyId = deriveEventFamilyId(
      eventId,
      config.forecasting.eventFamilyDerivationVersion
    ).eventFamilyId;
    const currentState = getContractLifecycleState(db, marketId);
    setOutcome({
      marketId,
      eventId,
      eventFamilyId,
      lifecycleState: currentState,
      status: 'DISCOVERY_FILTERED',
      reasonCodes: Object.freeze([excluded.reason]),
      forecastId: null,
      modelProbability: null,
      side: null,
      approvedQuantity: 0,
      decisionId: null,
      orderId: null,
      fillId: null,
      fillStatus: null,
      settlementOutcome: null,
    });
  }

  // Register newly discovered scanned contracts: DISCOVERED -> AUDIT_PENDING
  const auditedRuleVersionByMarket = new Map<string, string | null>();
  for (const snapshot of observeResult.discovery.scannedSnapshots) {
    const marketId = snapshot.marketTicker;
    let state = getContractLifecycleState(db, marketId);

    if (state === null) {
      registerDiscoveredContract(db, {
        marketId,
        actor,
        reason: 'MARKET_DISCOVERED',
        transitionedAt: asOf,
      });
      newlyRegisteredDiscovered += 1;
      transitionContractLifecycle(db, {
        marketId,
        toState: 'AUDIT_PENDING',
        reason: 'QUEUED_FOR_RESOLUTION_AUDIT',
        actor,
        transitionedAt: asOf,
      });
      state = 'AUDIT_PENDING';
    } else if (state === 'DISCOVERED') {
      transitionContractLifecycle(db, {
        marketId,
        toState: 'AUDIT_PENDING',
        reason: 'QUEUED_FOR_RESOLUTION_AUDIT',
        actor,
        transitionedAt: asOf,
      });
      state = 'AUDIT_PENDING';
    }

    // -----------------------------------------------------------------------
    // (d) Audit via EE-03 lifecycle auditor binding (AUDIT_PENDING -> APPROVED | REJECTED)
    // -----------------------------------------------------------------------
    const eventId = snapshot.eventTicker;
    const eventFamilyId = deriveEventFamilyId(
      eventId,
      config.forecasting.eventFamilyDerivationVersion
    ).eventFamilyId;

    if (state === 'AUDIT_PENDING') {
      const auditRes = auditContractInLifecycle(db, snapshot, {
        actor,
        auditedAt: asOf,
      });
      auditedCount += 1;
      auditedRuleVersionByMarket.set(marketId, auditRes.ruleVersion.ruleVersionId);

      if (auditRes.transition.toState === 'APPROVED') {
        approvedCount += 1;
      } else {
        rejectedCount += 1;
        setOutcome({
          marketId,
          eventId,
          eventFamilyId,
          lifecycleState: auditRes.transition.toState,
          status: 'AUDIT_REJECTED',
          reasonCodes: Object.freeze([...auditRes.audit.reasonCodes]),
          forecastId: null,
          modelProbability: null,
          side: null,
          approvedQuantity: 0,
          decisionId: null,
          orderId: null,
          fillId: null,
          fillStatus: null,
          settlementOutcome: null,
        });
      }
    } else if (state === 'REJECTED') {
      setOutcome({
        marketId,
        eventId,
        eventFamilyId,
        lifecycleState: 'REJECTED',
        status: 'AUDIT_REJECTED',
        reasonCodes: Object.freeze(['ALREADY_REJECTED']),
        forecastId: null,
        modelProbability: null,
        side: null,
        approvedQuantity: 0,
        decisionId: null,
        orderId: null,
        fillId: null,
        fillStatus: null,
        settlementOutcome: null,
      });
    } else if (state === 'RESOLVED' || state === 'DISPUTED' || state === 'VOIDED') {
      setOutcome({
        marketId,
        eventId,
        eventFamilyId,
        lifecycleState: state,
        status: 'TERMINAL_STATE',
        reasonCodes: Object.freeze([`TERMINAL_${state}`]),
        forecastId: null,
        modelProbability: null,
        side: null,
        approvedQuantity: 0,
        decisionId: null,
        orderId: null,
        fillId: null,
        fillStatus: null,
        settlementOutcome: null,
      });
    }
  }

  // -------------------------------------------------------------------------
  // (e) Forecasting for APPROVED contracts via EE-02 reference estimators, persisted via EE-03
  // -------------------------------------------------------------------------
  const baseRateEstimator =
    input.baseRateEstimator ?? createReferenceLaplaceBaseRateEstimator();
  const quantEstimator =
    input.quantEstimator ??
    createReferenceFeatureTransformQuantEstimator({
      featureName: DEFAULT_QUANT_FEATURE_NAME,
      center: DEFAULT_QUANT_CENTER,
      scale: DEFAULT_QUANT_SCALE,
    });

  const existingExperimentForecasts = getForecastsForExperiment(db, experimentId);
  const existingEnsembleKeySet = new Set<string>();
  const existingEnsembleByMarket = new Map<string, ForecastRecord>();
  for (const rec of existingExperimentForecasts) {
    if (rec.forecastStage === 'p_ensemble') {
      existingEnsembleKeySet.add(`${rec.marketId}|${rec.ruleVersionId ?? ''}`);
      existingEnsembleByMarket.set(rec.marketId, rec as ForecastRecord);
    }
  }

  interface NewEnsembleEntry {
    readonly snapshot: NormalizedMarketSnapshot;
    readonly ensemble: ForecastRecord;
    readonly ruleVersionId: string | null;
  }
  const newEnsembleForecasts: NewEnsembleEntry[] = [];

  for (const snapshot of observeResult.discovery.scannedSnapshots) {
    const marketId = snapshot.marketTicker;
    const eventId = snapshot.eventTicker;
    const eventFamilyId = deriveEventFamilyId(
      eventId,
      config.forecasting.eventFamilyDerivationVersion
    ).eventFamilyId;

    const currentState = getContractLifecycleState(db, marketId);
    if (currentState !== 'APPROVED' && currentState !== 'ACTIVE') {
      continue;
    }

    // Persist any explicitly supplied offline orderbook fixtures for this market
    if (fixtureConfig?.orderbooksByMarket?.[marketId]) {
      for (const obFixture of fixtureConfig.orderbooksByMarket[marketId]) {
        persistOrderbookFixtureIfMissing(db, marketId, obFixture);
      }
    }

    const ruleVersionId =
      auditedRuleVersionByMarket.get(marketId) ?? getLatestRuleVersionIdForMarket(db, marketId);
    const forecastKey = `${marketId}|${ruleVersionId ?? ''}`;

    if (existingEnsembleKeySet.has(forecastKey) || existingEnsembleByMarket.has(marketId)) {
      // Ensure APPROVED contracts transition to ACTIVE for close-time monitoring
      let stateAfter = currentState;
      if (stateAfter === 'APPROVED') {
        transitionContractLifecycle(db, {
          marketId,
          toState: 'ACTIVE',
          reason: 'FORECAST_ACTIVE_MONITORING',
          actor,
          ruleVersionId,
          transitionedAt: asOf,
        });
        stateAfter = 'ACTIVE';
      }
      const prevEnsemble = existingEnsembleByMarket.get(marketId) ?? null;
      setOutcome({
        marketId,
        eventId,
        eventFamilyId,
        lifecycleState: stateAfter,
        status: 'ALREADY_FORECASTED',
        reasonCodes: Object.freeze(['EXISTING_FORECAST_FOR_EXPERIMENT']),
        forecastId: prevEnsemble?.forecastId ?? null,
        modelProbability: prevEnsemble?.probability ?? null,
        side: null,
        approvedQuantity: 0,
        decisionId: null,
        orderId: null,
        fillId: null,
        fillStatus: null,
        settlementOutcome: null,
      });
      continue;
    }

    // Assemble strictly price-blind research inputs
    const providerInputs = input.researchProvider?.({
      snapshot,
      eventFamilyId,
      asOf,
    });

    const referenceClass: ReferenceClass | null =
      providerInputs?.referenceClass ??
      fixtureConfig?.referenceClassesByMarket?.[marketId] ??
      buildHistoricalFamilyReferenceClass(
        db,
        eventFamilyId,
        asOf,
        config.forecasting.minBaseRateSampleCount
      );

    const researchSnapshot: ResearchDataSnapshot =
      providerInputs?.researchSnapshot ??
      fixtureConfig?.researchSnapshotsByMarket?.[marketId] ??
      buildDefaultPriceBlindResearchSnapshot(snapshot, asOf);

    const evalResult = evaluatePriceBlindForecast({
      experimentId,
      contract: {
        marketId,
        eventId,
        eventFamilyId,
        category: snapshot.category,
        marketTerms: snapshot.marketTerms,
        closeTimeUtc: snapshot.closeTimeUtc,
        expirationTimeUtc: snapshot.expirationTimeUtc,
        ruleVersionId,
        settlementSource: snapshot.settlementSourceName ?? 'UNSPECIFIED',
        auditStatus: 'CLEAR',
      },
      config,
      researchSnapshot,
      referenceClass,
      baseRateEstimator,
      quantEstimator,
      forecastTimestamp: asOf,
      codeCommitHash: input.codeCommitHash,
    });

    // Persist p_base, p_quant, p_ensemble via EE-03 saveForecast
    saveForecast(db, evalResult.pBase);
    saveForecast(db, evalResult.pQuant);
    saveForecast(db, evalResult.pEnsemble);

    existingEnsembleKeySet.add(forecastKey);
    existingEnsembleByMarket.set(marketId, evalResult.pEnsemble);

    if (evalResult.pEnsemble.status === 'FORECAST') {
      forecastedCount += 1;
    } else {
      abstainedCount += 1;
    }

    // Transition APPROVED -> ACTIVE now that the contract has entered active monitoring
    if (currentState === 'APPROVED') {
      transitionContractLifecycle(db, {
        marketId,
        toState: 'ACTIVE',
        reason: 'FORECAST_ACTIVE_MONITORING',
        actor,
        ruleVersionId,
        transitionedAt: asOf,
      });
    }

    newEnsembleForecasts.push({
      snapshot,
      ensemble: evalResult.pEnsemble,
      ruleVersionId,
    });
  }

  // -------------------------------------------------------------------------
  // (f) Risk evaluation via EE-06 & (g) Shadow decisions via EE-05
  // -------------------------------------------------------------------------
  const ledgerIntegrityOk = checkLedgerTriggersIntegrity(db);
  const dataFresh = input.dataFresh ?? true;
  const reconciliationPending = input.reconciliationPending ?? false;

  // Evaluate system state once upfront even if 0 new forecasts exist this cycle
  const initialPortfolio = buildPortfolioState(db, experimentId, asOf, {
    settledCash,
    config,
  });
  const initialSysEval = evaluateSystemState(
    {
      dailyLossPct: initialPortfolio.dailyLossPct,
      drawdownPct: initialPortfolio.drawdownPct,
      dataFresh,
      reconciliationPending,
      ledgerIntegrityOk,
    },
    config.risk
  );
  applySystemStateEvaluation(
    db,
    {
      dailyLossPct: initialPortfolio.dailyLossPct,
      drawdownPct: initialPortfolio.drawdownPct,
      dataFresh,
      reconciliationPending,
      ledgerIntegrityOk,
    },
    {
      riskConfig: config.risk,
      actor,
      recordedAt: asOf,
    }
  );
  void initialSysEval;

  for (const entry of newEnsembleForecasts) {
    const { snapshot, ensemble } = entry;
    const marketId = snapshot.marketTicker;
    const eventId = snapshot.eventTicker;
    const eventFamilyId = ensemble.eventFamilyId;
    const lifecycleState = getContractLifecycleState(db, marketId);

    if (ensemble.status !== 'FORECAST' || ensemble.probability === null) {
      setOutcome({
        marketId,
        eventId,
        eventFamilyId,
        lifecycleState,
        status: 'FORECAST_ABSTAINED',
        reasonCodes: dedupeStrings(ensemble.abstentionReasons.map((r) => r.code)),
        forecastId: ensemble.forecastId,
        modelProbability: null,
        side: null,
        approvedQuantity: 0,
        decisionId: null,
        orderId: null,
        fillId: null,
        fillStatus: null,
        settlementOutcome: null,
      });
      continue;
    }

    riskEvaluatedCount += 1;

    // Refresh portfolio state & system state after any previous shadow execution in this cycle
    let portfolioState = buildPortfolioState(db, experimentId, asOf, {
      settledCash,
      config,
    });
    const sysInputs = {
      dailyLossPct: portfolioState.dailyLossPct,
      drawdownPct: portfolioState.drawdownPct,
      dataFresh,
      reconciliationPending,
      ledgerIntegrityOk,
    };
    evaluateSystemState(sysInputs, config.risk);
    const appliedState = applySystemStateEvaluation(db, sysInputs, {
      riskConfig: config.risk,
      actor,
      recordedAt: asOf,
    });
    if (appliedState.transitioned) {
      portfolioState = buildPortfolioState(db, experimentId, asOf, {
        settledCash,
        config,
      });
    }

    // Look up decision-time book snapshot from ledger
    let decisionBook;
    try {
      decisionBook = findDecisionBookSnapshot(db, marketId, asOf);
    } catch (err) {
      if (err instanceof DecisionBookNotFoundError) {
        riskRejectedCount += 1;
        setOutcome({
          marketId,
          eventId,
          eventFamilyId,
          lifecycleState,
          status: 'RISK_SKIPPED_NO_BOOK',
          reasonCodes: Object.freeze(['BOOK_NOT_CAPTURED']),
          forecastId: ensemble.forecastId,
          modelProbability: ensemble.probability,
          side: null,
          approvedQuantity: 0,
          decisionId: null,
          orderId: null,
          fillId: null,
          fillStatus: null,
          settlementOutcome: null,
        });
        continue;
      }
      throw err;
    }

    const edgeEval = computeShadowEdges(
      ensemble.probability,
      decisionBook.yesBidUsd,
      decisionBook.yesAskUsd,
      config.risk.minConservativeEdge
    );

    const candidateSide: ShadowOrderSide =
      edgeEval.side ?? (edgeEval.edgeYes >= edgeEval.edgeNo ? 'BUY_YES' : 'BUY_NO');
    const entryPrice =
      candidateSide === 'BUY_YES'
        ? decisionBook.yesAskUsd
        : Number((1 - decisionBook.yesBidUsd).toFixed(6));

    if (!Number.isFinite(entryPrice) || entryPrice <= 0 || entryPrice >= 1) {
      riskRejectedCount += 1;
      setOutcome({
        marketId,
        eventId,
        eventFamilyId,
        lifecycleState,
        status: 'RISK_REJECTED',
        reasonCodes: Object.freeze(['INVALID_ENTRY_PRICE']),
        forecastId: ensemble.forecastId,
        modelProbability: ensemble.probability,
        side: candidateSide,
        approvedQuantity: 0,
        decisionId: null,
        orderId: null,
        fillId: null,
        fillStatus: null,
        settlementOutcome: null,
      });
      continue;
    }

    const feePerContract = computeShadowFillFee(
      1,
      entryPrice,
      config.shadow.feeScheduleVersion
    ).feeUsd;

    const sizingInput = {
      marketId,
      eventId,
      eventFamilyId,
      side: candidateSide,
      price: entryPrice,
      feePerContract,
      modelProbability: ensemble.probability,
    };

    const maxQty = computeMaxQuantity(portfolioState, sizingInput, config.risk);
    const sizingBreakdown = computeMaxQuantityBreakdown(portfolioState, sizingInput, config.risk);

    if (maxQty <= 0) {
      const probeRisk = evaluateRisk(
        portfolioState,
        {
          marketId,
          eventId,
          eventFamilyId,
          side: candidateSide,
          quantity: 1,
          price: entryPrice,
          fee: feePerContract,
        },
        config.risk
      );
      const reasons: string[] = [...probeRisk.reasons];
      if (sizingBreakdown.bindingConstraint === 'KELLY') {
        reasons.push('ZERO_QUANTITY_KELLY');
      } else {
        reasons.push(sizingBreakdown.bindingConstraint);
      }
      if (edgeEval.outcome === 'NO_EDGE') {
        reasons.push('NO_EDGE');
      }
      riskRejectedCount += 1;
      setOutcome({
        marketId,
        eventId,
        eventFamilyId,
        lifecycleState,
        status: 'RISK_REJECTED',
        reasonCodes: dedupeStrings(reasons),
        forecastId: ensemble.forecastId,
        modelProbability: ensemble.probability,
        side: candidateSide,
        approvedQuantity: 0,
        decisionId: null,
        orderId: null,
        fillId: null,
        fillStatus: null,
        settlementOutcome: null,
      });
      continue;
    }

    const totalFee = computeShadowFillFee(
      maxQty,
      entryPrice,
      config.shadow.feeScheduleVersion
    ).feeUsd;

    const riskEval = evaluateRisk(
      portfolioState,
      {
        marketId,
        eventId,
        eventFamilyId,
        side: candidateSide,
        quantity: maxQty,
        price: entryPrice,
        fee: totalFee,
      },
      config.risk
    );

    if (!riskEval.approved) {
      riskRejectedCount += 1;
      setOutcome({
        marketId,
        eventId,
        eventFamilyId,
        lifecycleState,
        status: 'RISK_REJECTED',
        reasonCodes: dedupeStrings(riskEval.reasons),
        forecastId: ensemble.forecastId,
        modelProbability: ensemble.probability,
        side: candidateSide,
        approvedQuantity: 0,
        decisionId: null,
        orderId: null,
        fillId: null,
        fillStatus: null,
        settlementOutcome: null,
      });
      continue;
    }

    riskApprovedCount += 1;

    // -----------------------------------------------------------------------
    // (g) Shadow decisions via EE-05 for approved quantities (PAPER mode)
    // -----------------------------------------------------------------------
    if (mode === 'OBSERVE') {
      setOutcome({
        marketId,
        eventId,
        eventFamilyId,
        lifecycleState,
        status: 'RISK_APPROVED_OBSERVE_ONLY',
        reasonCodes: Object.freeze(['OBSERVE_MODE_NO_SHADOW_EXECUTION']),
        forecastId: ensemble.forecastId,
        modelProbability: ensemble.probability,
        side: candidateSide,
        approvedQuantity: maxQty,
        decisionId: null,
        orderId: null,
        fillId: null,
        fillStatus: null,
        settlementOutcome: null,
      });
      continue;
    }

    const shadowResult = executeShadowDecision(db, {
      experimentId,
      marketId,
      forecast: ensemble,
      requestedQuantity: maxQty,
      config,
      decisionTimestamp: asOf,
    });

    shadowDecisionsCreated += 1;
    if (shadowResult.order) {
      shadowOrdersCreated += 1;
    }
    if (shadowResult.fill.status === 'FILLED' || shadowResult.fill.status === 'PARTIAL') {
      shadowFillsExecuted += 1;
    }

    const shadowReasonCodes = shadowResult.fill.reasonCode
      ? Object.freeze([shadowResult.fill.reasonCode])
      : Object.freeze([]);

    setOutcome({
      marketId,
      eventId,
      eventFamilyId,
      lifecycleState,
      status:
        shadowResult.decision.outcome === 'NO_EDGE' ? 'SHADOW_NO_EDGE' : 'SHADOW_EXECUTED',
      reasonCodes: shadowReasonCodes,
      forecastId: ensemble.forecastId,
      modelProbability: ensemble.probability,
      side: shadowResult.decision.side ?? candidateSide,
      approvedQuantity: maxQty,
      decisionId: shadowResult.decision.decisionId,
      orderId: shadowResult.order?.orderId ?? null,
      fillId: shadowResult.fill.fillId,
      fillStatus: shadowResult.fill.status,
      settlementOutcome: null,
    });
  }

  // -------------------------------------------------------------------------
  // (h) Lifecycle advancement (ACTIVE -> SETTLEMENT_PENDING) &
  //     discovery-sourced settlement recording (SETTLEMENT_PENDING -> RESOLVED/VOIDED)
  // -------------------------------------------------------------------------
  // 1. Advance ACTIVE contracts whose close_time has passed to SETTLEMENT_PENDING
  const activeContracts = listContractsInLifecycleStates(db, ['ACTIVE']);
  const snapshotByTicker = new Map(
    observeResult.discovery.allSnapshots.map((s) => [s.marketTicker, s])
  );

  for (const contract of activeContracts) {
    const discSnap = snapshotByTicker.get(contract.marketId);
    const latestMeta = discSnap
      ? {
          eventTicker: discSnap.eventTicker,
          closeTimeUtc: discSnap.closeTimeUtc,
          expirationTimeUtc: discSnap.expirationTimeUtc,
        }
      : getLatestMarketSnapshotMeta(db, contract.marketId);

    const closeIso = latestMeta?.closeTimeUtc ?? latestMeta?.expirationTimeUtc ?? null;
    if (closeIso && Number.isFinite(Date.parse(closeIso)) && Date.parse(closeIso) <= asOfEpochMs) {
      transitionContractLifecycle(db, {
        marketId: contract.marketId,
        toState: 'SETTLEMENT_PENDING',
        reason: 'CLOSE_TIME_PASSED',
        actor,
        ruleVersionId: contract.ruleVersionId,
        transitionedAt: asOf,
      });
      advancedToSettlementPending += 1;

      const existingOutcome = outcomesByMarket.get(contract.marketId);
      const eventId =
        existingOutcome?.eventId ?? latestMeta?.eventTicker ?? contract.marketId;
      const eventFamilyId =
        existingOutcome?.eventFamilyId ??
        deriveEventFamilyId(eventId, config.forecasting.eventFamilyDerivationVersion)
          .eventFamilyId;
      setOutcome({
        marketId: contract.marketId,
        eventId,
        eventFamilyId,
        lifecycleState: 'SETTLEMENT_PENDING',
        status: 'AWAITING_SETTLEMENT',
        reasonCodes: Object.freeze(['CLOSE_TIME_PASSED']),
        forecastId: existingOutcome?.forecastId ?? null,
        modelProbability: existingOutcome?.modelProbability ?? null,
        side: existingOutcome?.side ?? null,
        approvedQuantity: existingOutcome?.approvedQuantity ?? 0,
        decisionId: existingOutcome?.decisionId ?? null,
        orderId: existingOutcome?.orderId ?? null,
        fillId: existingOutcome?.fillId ?? null,
        fillStatus: existingOutcome?.fillStatus ?? null,
        settlementOutcome: null,
      });
    }
  }

  // 2. Record settlement strictly from EE-01 discovery data (never invented)
  const pendingSettlementContracts = listContractsInLifecycleStates(db, ['SETTLEMENT_PENDING']);
  for (const contract of pendingSettlementContracts) {
    const marketId = contract.marketId;
    let rawMarket: KalshiRawMarket | null = null;
    let eventTicker: string | null = null;
    let rawSettlementJson: string | null = null;

    // Source A: current cycle discovery payload already fetched via EE-01
    const discSnap = snapshotByTicker.get(marketId);
    if (discSnap) {
      const candidateRaw = extractRawMarketFromSnapshot(discSnap);
      if (candidateRaw && parseKalshiSettlementOutcome(candidateRaw) !== null) {
        rawMarket = candidateRaw;
        eventTicker = discSnap.eventTicker;
        rawSettlementJson = discSnap.rawPayloadJson;
      }
    }

    // Source B: EE-01 public GET /markets/{ticker} lookup (zero auth headers; fixture or public API)
    if (!rawMarket) {
      try {
        const fetched = await fetchPublicKalshiMarketByTicker(marketId, clientOptions);
        if (fetched.market && parseKalshiSettlementOutcome(fetched.market) !== null) {
          rawMarket = fetched.market;
          const normalized = normalizeKalshiMarketToSnapshot(fetched.market, null, asOf);
          persistMarketSnapshot(db, normalized);
          eventTicker = normalized.eventTicker;
          rawSettlementJson = normalized.rawPayloadJson;
        }
      } catch {
        // Leave contract in SETTLEMENT_PENDING if public lookup is transiently unavailable
      }
    }

    if (!rawMarket || !rawSettlementJson) {
      continue;
    }

    const outcome = parseKalshiSettlementOutcome(rawMarket);
    if (!outcome) {
      continue;
    }

    const meta = getLatestMarketSnapshotMeta(db, marketId);
    const resolvedEventTicker =
      eventTicker ?? rawMarket.event_ticker ?? meta?.eventTicker ?? marketId;
    const rawSettledAt =
      typeof rawMarket.settlement_ts === 'string' &&
      Number.isFinite(Date.parse(rawMarket.settlement_ts))
        ? new Date(Date.parse(rawMarket.settlement_ts)).toISOString()
        : asOf;

    const settlementResult = recordContractSettlement(db, {
      marketId,
      eventTicker: resolvedEventTicker,
      outcome,
      settledAt: rawSettledAt,
      rawSettlementJson,
      actor,
      ruleVersionId: contract.ruleVersionId,
    });

    if (!settlementResult.alreadySettled) {
      settledCount += 1;
    }

    const existingOutcome = outcomesByMarket.get(marketId);
    const eventFamilyId =
      existingOutcome?.eventFamilyId ??
      deriveEventFamilyId(resolvedEventTicker, config.forecasting.eventFamilyDerivationVersion)
        .eventFamilyId;
    setOutcome({
      marketId,
      eventId: resolvedEventTicker,
      eventFamilyId,
      lifecycleState: settlementResult.lifecycleStateAfter,
      status: 'SETTLED',
      reasonCodes: Object.freeze([`DISCOVERY_SETTLEMENT_${outcome}`]),
      forecastId: existingOutcome?.forecastId ?? null,
      modelProbability: existingOutcome?.modelProbability ?? null,
      side: existingOutcome?.side ?? null,
      approvedQuantity: existingOutcome?.approvedQuantity ?? 0,
      decisionId: existingOutcome?.decisionId ?? null,
      orderId: existingOutcome?.orderId ?? null,
      fillId: existingOutcome?.fillId ?? null,
      fillStatus: existingOutcome?.fillStatus ?? null,
      settlementOutcome: outcome,
    });
  }

  // Final read-only dashboard snapshot (EE-07)
  const dashboard = buildDashboard(db, experimentId, asOf, {
    settledCash,
    config,
  });

  const marketOutcomes = Array.from(outcomesByMarket.values()).sort((a, b) =>
    a.marketId.localeCompare(b.marketId)
  );

  const counts: PaperCycleStageCounts = Object.freeze({
    discoveredFetched: observeResult.discovery.marketsFetched,
    discoveryFilteredOut: observeResult.discovery.excludedMarkets.length,
    scanned: observeResult.discovery.scannedSnapshots.length,
    newlyRegisteredDiscovered,
    auditedCount,
    approvedCount,
    rejectedCount,
    forecastedCount,
    abstainedCount,
    riskEvaluatedCount,
    riskApprovedCount,
    riskRejectedCount,
    shadowDecisionsCreated,
    shadowOrdersCreated,
    shadowFillsExecuted,
    advancedToSettlementPending,
    settledCount,
  });

  const currentSystemState = getCurrentRiskSystemState(db, asOf);

  return Object.freeze({
    experimentId,
    mode,
    asOf,
    configHash: currentConfigHash,
    usedFixtures,
    systemState: currentSystemState,
    counts,
    marketOutcomes: Object.freeze(marketOutcomes),
    observeSummary: observeResult.summary,
    dashboard,
  });
}
