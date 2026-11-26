import type { DatabaseSync } from 'node:sqlite';
import { ExperimentNotFoundError, getExperiment } from '../experiments/registry';
import { deriveEventFamilyId } from '../forecasting/priceBlindGuard';
import type { ForecastRecord } from '../forecasting/types';
import type { ContractLifecycleState } from '../lifecycle/contractLifecycle';
import { getForecastsForExperiment } from '../persistence/forecastRepository';
import type {
  AbstainedMarketRow,
  BinaryOutcome,
  DenominatorTotals,
  EventFamilyDenominatorReport,
  ExcludedDisputedOrVoidedRow,
  ExcludedMissingMarketRefRow,
  MarketReferenceMethod,
  OutcomeJoinResult,
  ParsedSampleDefinition,
  SettledEvaluationRow,
} from './types';

/**
 * Parses an experiment's registered `sample_definition` and `kill_criteria` text (JSON or structured prose)
 * to extract declared event families and minimum settled sample size without inventing defaults.
 */
export function parseExperimentSampleDefinition(
  sampleDefinition: string,
  killCriteria: string
): ParsedSampleDefinition {
  const families = new Set<string>();
  let minSettledSample: number | null = null;

  const trimmed = sampleDefinition.trim();

  // 1. Try JSON representation first
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const rawFams = parsed.eventFamilies ?? parsed.event_families ?? parsed.families;
      if (Array.isArray(rawFams)) {
        for (const f of rawFams) {
          if (typeof f === 'string' && f.trim().length > 0) {
            families.add(f.trim().toUpperCase());
          }
        }
      }
      const rawMin =
        parsed.minSettledSample ??
        parsed.min_settled_sample ??
        parsed.minSampleSize ??
        parsed.min_sample_size ??
        parsed.frozenSampleSize ??
        parsed.frozen_sample_size ??
        parsed.minN ??
        parsed.min_n ??
        parsed.sampleSize ??
        parsed.sample_size;
      if (typeof rawMin === 'number' && Number.isInteger(rawMin) && rawMin > 0) {
        minSettledSample = rawMin;
      }
    } catch {
      // Fall through to structured prose parsing
    }
  }

  // 2. Structured prose parsing for event families (e.g., "Event families: KXCPI, KXFED; ...")
  if (families.size === 0) {
    const familyClauseMatch = trimmed.match(
      /event[_\s-]*famil(?:y|ies)\s*(?:=|:|in)?\s*([A-Za-z0-9_,\s/&-]+?)(?:[;.\n]|$)/i
    );
    if (familyClauseMatch && familyClauseMatch[1]) {
      const tokens = familyClauseMatch[1]
        .split(/[,/\s]+|\band\b/i)
        .map((t) => t.trim().toUpperCase())
        .filter((t) => /^[A-Z][A-Z0-9_]{1,}$/.test(t) && t !== 'ALL' && t !== 'AND' && t !== 'OR');
      for (const token of tokens) {
        families.add(token);
      }
    }
  }

  // 3. Structured prose parsing for minimum settled sample size
  if (minSettledSample === null) {
    const samplePatterns: readonly RegExp[] = [
      /(?:min(?:imum)?[_\s-]*settled(?:[_\s-]*sample)?|min(?:imum)?[_\s-]*sample(?:[_\s-]*size)?|frozen[_\s-]*sample(?:[_\s-]*size)?|frozen[_\s-]*n|min[_\s-]*n)\s*(?:>=|=|:|of)?\s*(\d+)/i,
      /\bN\s*(?:>=|=|:)\s*(\d+)/,
      /minimum\s+(\d+)\s+(?:settled|resolved|forecasted)/i,
    ];
    for (const pattern of samplePatterns) {
      const m = trimmed.match(pattern);
      if (m && m[1]) {
        const parsedInt = Number.parseInt(m[1], 10);
        if (Number.isInteger(parsedInt) && parsedInt > 0) {
          minSettledSample = parsedInt;
          break;
        }
      }
    }
  }

  // Also allow kill_criteria JSON/prose to specify min_settled if sample_definition omitted it
  if (minSettledSample === null) {
    const m = killCriteria.match(
      /(?:min(?:imum)?[_\s-]*settled(?:[_\s-]*sample)?|min(?:imum)?[_\s-]*sample(?:[_\s-]*size)?|after|at)\s*(?:>=|=|:|N\s*=\s*)?\s*(\d+)/i
    );
    if (m && m[1]) {
      const parsedInt = Number.parseInt(m[1], 10);
      if (Number.isInteger(parsedInt) && parsedInt > 0) {
        minSettledSample = parsedInt;
      }
    }
  }

  return Object.freeze({
    eventFamilies: Object.freeze([...families].sort()),
    minSettledSample,
    rawSampleDefinition: sampleDefinition,
    rawKillCriteria: killCriteria,
  });
}

interface LatestLifecycleRow {
  market_id: string;
  to_state: ContractLifecycleState;
}

interface MarketEventTickerRow {
  market_ticker: string;
  event_ticker: string;
}

interface LatestSettlementRow {
  market_ticker: string;
  event_ticker: string;
  outcome: 'YES' | 'NO' | 'VOID' | 'CANCELLED';
  settled_at: string;
}

interface SnapshotCandidateRow {
  snapshot_id: string;
  market_ticker: string;
  yes_bid_usd: number | null;
  yes_ask_usd: number | null;
  captured_at: string;
}

/**
 * Finds the market's YES mid/ask snapshot closest to, but strictly NOT AFTER, `forecastTimestamp`.
 * This benchmark is evaluation-only and is never persisted back into forecast records.
 */
export function findTimestampMatchedMarketReference(
  db: DatabaseSync,
  marketId: string,
  forecastTimestamp: string
): {
  readonly snapshotId: string;
  readonly capturedAt: string;
  readonly probability: number;
  readonly method: MarketReferenceMethod;
} | null {
  const forecastEpochMs = Date.parse(forecastTimestamp);
  if (!Number.isFinite(forecastEpochMs)) {
    return null;
  }

  // Pull candidate snapshots ordered newest-first; filter both in SQL and with exact Date.parse
  // so mixed ISO timezone representations can never leak a post-forecast snapshot.
  const rows = db
    .prepare(
      `SELECT snapshot_id, market_ticker, yes_bid_usd, yes_ask_usd, captured_at
       FROM market_snapshots
       WHERE market_ticker = ?
         AND (
           (yes_bid_usd IS NOT NULL AND yes_ask_usd IS NOT NULL)
           OR yes_ask_usd IS NOT NULL
         )
       ORDER BY captured_at DESC, rowid DESC`
    )
    .all(marketId.trim()) as unknown as SnapshotCandidateRow[];

  let best: {
    snapshotId: string;
    capturedAt: string;
    capturedEpochMs: number;
    probability: number;
    method: MarketReferenceMethod;
  } | null = null;

  for (const row of rows) {
    const snapEpochMs = Date.parse(row.captured_at);
    if (!Number.isFinite(snapEpochMs) || snapEpochMs > forecastEpochMs) {
      continue;
    }

    const bid = row.yes_bid_usd === null ? null : Number(row.yes_bid_usd);
    const ask = row.yes_ask_usd === null ? null : Number(row.yes_ask_usd);

    let probability: number | null = null;
    let method: MarketReferenceMethod | null = null;

    if (
      bid !== null &&
      ask !== null &&
      Number.isFinite(bid) &&
      Number.isFinite(ask) &&
      bid >= 0 &&
      bid <= 1 &&
      ask >= 0 &&
      ask <= 1 &&
      bid <= ask
    ) {
      probability = (bid + ask) / 2;
      method = 'YES_MID';
    } else if (ask !== null && Number.isFinite(ask) && ask >= 0 && ask <= 1) {
      probability = ask;
      method = 'YES_ASK';
    }

    if (probability === null || method === null) {
      continue;
    }

    if (best === null || snapEpochMs > best.capturedEpochMs) {
      best = {
        snapshotId: row.snapshot_id,
        capturedAt: row.captured_at,
        capturedEpochMs: snapEpochMs,
        probability,
        method,
      };
    }
  }

  if (!best) return null;

  return Object.freeze({
    snapshotId: best.snapshotId,
    capturedAt: best.capturedAt,
    probability: best.probability,
    method: best.method,
  });
}

/**
 * Assembles the evaluation dataset and complete denominator report for a single registered
 * experiment (EE-03 registry).
 *
 * - Joins RESOLVED binary outcomes (1 = YES, 0 = NO), `p_ensemble` forecasts (EE-03 persistence),
 *   and timestamp-matched market reference snapshots (closest `captured_at <= forecast_timestamp`).
 * - Separately reports and excludes DISPUTED/VOIDED contracts from scoring.
 * - Keeps ABSTAINED forecasts visible in the denominator report (never silently dropped).
 */
export function assembleExperimentEvaluationSet(
  db: DatabaseSync,
  experimentId: string
): OutcomeJoinResult {
  const trimmedExperimentId = experimentId.trim();
  const experiment = getExperiment(db, trimmedExperimentId);
  if (!experiment) {
    throw new ExperimentNotFoundError(trimmedExperimentId);
  }

  const parsedDefinition = parseExperimentSampleDefinition(
    experiment.sampleDefinition,
    experiment.killCriteria
  );

  // 1. Read all forecasts for this experiment through EE-03 persistence
  const allExperimentForecasts = getForecastsForExperiment(db, trimmedExperimentId);

  // Latest p_ensemble record per market for this experiment
  const latestEnsembleByMarket = new Map<string, ForecastRecord>();
  const familyByMarket = new Map<string, string>();
  const eventByMarket = new Map<string, string>();

  for (const fc of allExperimentForecasts) {
    familyByMarket.set(fc.marketId, fc.eventFamilyId);
    eventByMarket.set(fc.marketId, fc.eventId);
    if (fc.forecastStage === 'p_ensemble') {
      latestEnsembleByMarket.set(fc.marketId, fc as ForecastRecord);
    }
  }

  // Target event families = union(registered sample_definition families, families in experiment forecasts)
  const targetFamilySet = new Set<string>(parsedDefinition.eventFamilies);
  for (const familyId of familyByMarket.values()) {
    targetFamilySet.add(familyId);
  }

  // 2. Load latest lifecycle state per market from contract_lifecycle_history
  const latestLifecycleRows = db
    .prepare(
      `SELECT l.market_id, l.to_state
       FROM contract_lifecycle_history l
       INNER JOIN (
         SELECT market_id, MAX(rowid) AS max_rowid
         FROM contract_lifecycle_history
         GROUP BY market_id
       ) latest ON latest.market_id = l.market_id AND latest.max_rowid = l.rowid`
    )
    .all() as unknown as LatestLifecycleRow[];

  const lifecycleByMarket = new Map<string, ContractLifecycleState>();
  for (const row of latestLifecycleRows) {
    lifecycleByMarket.set(row.market_id, row.to_state);
  }

  // 3. Load latest settlement per market from settlements
  const latestSettlementRows = db
    .prepare(
      `SELECT s.market_ticker, s.event_ticker, s.outcome, s.settled_at
       FROM settlements s
       INNER JOIN (
         SELECT market_ticker, MAX(rowid) AS max_rowid
         FROM settlements
         GROUP BY market_ticker
       ) latest ON latest.market_ticker = s.market_ticker AND latest.max_rowid = s.rowid`
    )
    .all() as unknown as LatestSettlementRow[];

  const settlementByMarket = new Map<string, LatestSettlementRow>();
  for (const row of latestSettlementRows) {
    settlementByMarket.set(row.market_ticker, row);
    if (!eventByMarket.has(row.market_ticker)) {
      eventByMarket.set(row.market_ticker, row.event_ticker);
    }
    if (!familyByMarket.has(row.market_ticker)) {
      familyByMarket.set(row.market_ticker, deriveEventFamilyId(row.event_ticker).eventFamilyId);
    }
  }

  // 4. Load distinct market_ticker -> event_ticker mappings from market_snapshots
  const snapshotMarketRows = db
    .prepare(
      `SELECT DISTINCT market_ticker, event_ticker
       FROM market_snapshots`
    )
    .all() as unknown as MarketEventTickerRow[];

  for (const row of snapshotMarketRows) {
    if (!eventByMarket.has(row.market_ticker)) {
      eventByMarket.set(row.market_ticker, row.event_ticker);
    }
    if (!familyByMarket.has(row.market_ticker)) {
      familyByMarket.set(row.market_ticker, deriveEventFamilyId(row.event_ticker).eventFamilyId);
    }
  }

  // Also ensure any lifecycle-tracked market without snapshots/forecasts derives its family from market_id
  for (const marketId of lifecycleByMarket.keys()) {
    if (!familyByMarket.has(marketId)) {
      familyByMarket.set(marketId, deriveEventFamilyId(marketId).eventFamilyId);
    }
  }

  // 5. Collect all discovered markets belonging to the experiment's event families
  const marketsInExperimentFamilies = new Set<string>();
  for (const [marketId, familyId] of familyByMarket.entries()) {
    if (targetFamilySet.has(familyId)) {
      marketsInExperimentFamilies.add(marketId);
    }
  }

  const sortedFamilies = [...targetFamilySet].sort();
  const familyCounters = new Map<
    string,
    {
      discovered: number;
      rejectedByAudit: number;
      abstained: number;
      forecasted: number;
      settled: number;
      settledForecasted: number;
      settledScored: number;
      disputed: number;
      voided: number;
    }
  >();

  for (const fam of sortedFamilies) {
    familyCounters.set(fam, {
      discovered: 0,
      rejectedByAudit: 0,
      abstained: 0,
      forecasted: 0,
      settled: 0,
      settledForecasted: 0,
      settledScored: 0,
      disputed: 0,
      voided: 0,
    });
  }

  const scoredSamples: SettledEvaluationRow[] = [];
  const disputedOrVoided: ExcludedDisputedOrVoidedRow[] = [];
  const excludedMissingMarketReference: ExcludedMissingMarketRefRow[] = [];
  const abstainedMarkets: AbstainedMarketRow[] = [];

  const sortedMarketIds = [...marketsInExperimentFamilies].sort();

  for (const marketId of sortedMarketIds) {
    const familyId = familyByMarket.get(marketId)!;
    const counters = familyCounters.get(familyId)!;
    const lifecycleState = lifecycleByMarket.get(marketId) ?? null;
    const settlement = settlementByMarket.get(marketId) ?? null;
    const ensemble = latestEnsembleByMarket.get(marketId) ?? null;

    counters.discovered += 1;

    if (lifecycleState === 'REJECTED') {
      counters.rejectedByAudit += 1;
    }

    if (ensemble && ensemble.status === 'ABSTAINED') {
      counters.abstained += 1;
      abstainedMarkets.push(
        Object.freeze({
          marketId,
          eventFamilyId: familyId,
          forecastId: ensemble.forecastId,
          forecastTimestamp: ensemble.forecastTimestamp,
          lifecycleState,
          abstentionReasonCodes: Object.freeze(ensemble.abstentionReasons.map((r) => r.code)),
        })
      );
    } else if (ensemble && ensemble.status === 'FORECAST' && ensemble.probability !== null) {
      counters.forecasted += 1;
    }

    const isDisputed = lifecycleState === 'DISPUTED';
    const isVoided =
      lifecycleState === 'VOIDED' ||
      settlement?.outcome === 'VOID' ||
      settlement?.outcome === 'CANCELLED';

    if (isDisputed || isVoided) {
      if (isDisputed) counters.disputed += 1;
      if (isVoided) counters.voided += 1;
      disputedOrVoided.push(
        Object.freeze({
          marketId,
          eventFamilyId: familyId,
          lifecycleState,
          settlementOutcome: settlement?.outcome ?? null,
          forecastId: ensemble?.forecastId ?? null,
          forecastStatus: ensemble?.status ?? null,
        })
      );
      continue;
    }

    // Check if market reached RESOLVED with a binary YES/NO settlement
    const isResolvedBinary =
      lifecycleState === 'RESOLVED' &&
      settlement !== null &&
      (settlement.outcome === 'YES' || settlement.outcome === 'NO');

    if (!isResolvedBinary) {
      continue;
    }

    counters.settled += 1;

    if (!ensemble || ensemble.status !== 'FORECAST' || ensemble.probability === null) {
      continue;
    }

    counters.settledForecasted += 1;
    const outcome: BinaryOutcome = settlement.outcome === 'YES' ? 1 : 0;

    // Join timestamp-matched market reference snapshot (closest <= forecast_timestamp)
    const marketRef = findTimestampMatchedMarketReference(
      db,
      marketId,
      ensemble.forecastTimestamp
    );

    if (!marketRef) {
      excludedMissingMarketReference.push(
        Object.freeze({
          marketId,
          eventFamilyId: familyId,
          forecastId: ensemble.forecastId,
          forecastTimestamp: ensemble.forecastTimestamp,
          outcome,
          reason: 'No market_snapshots row with valid YES bid/ask at or before forecast_timestamp.',
        })
      );
      continue;
    }

    counters.settledScored += 1;
    scoredSamples.push(
      Object.freeze({
        marketId,
        eventId: eventByMarket.get(marketId) ?? ensemble.eventId,
        eventFamilyId: familyId,
        forecastId: ensemble.forecastId,
        forecastTimestamp: ensemble.forecastTimestamp,
        modelProbability: ensemble.probability,
        marketReferenceProbability: marketRef.probability,
        outcome,
        settledAt: settlement.settled_at,
        settlementOutcome: settlement.outcome as 'YES' | 'NO',
        marketSnapshotId: marketRef.snapshotId,
        marketSnapshotCapturedAt: marketRef.capturedAt,
        marketReferenceMethod: marketRef.method,
        sourceForecast: ensemble,
      })
    );
  }

  // Strictly order scored samples chronologically (tie-broken by marketId, forecastId)
  scoredSamples.sort((a, b) => {
    const dt = Date.parse(a.forecastTimestamp) - Date.parse(b.forecastTimestamp);
    if (dt !== 0) return dt;
    const mk = a.marketId.localeCompare(b.marketId);
    if (mk !== 0) return mk;
    return a.forecastId.localeCompare(b.forecastId);
  });

  const denominatorByFamily: EventFamilyDenominatorReport[] = sortedFamilies.map((fam) => {
    const c = familyCounters.get(fam)!;
    return Object.freeze({
      eventFamilyId: fam,
      discovered: c.discovered,
      rejectedByAudit: c.rejectedByAudit,
      abstained: c.abstained,
      forecasted: c.forecasted,
      settled: c.settled,
      settledForecasted: c.settledForecasted,
      settledScored: c.settledScored,
      disputed: c.disputed,
      voided: c.voided,
      coverage: c.discovered > 0 ? c.forecasted / c.discovered : 0,
    });
  });

  const totals = denominatorByFamily.reduce(
    (acc, row) => ({
      discovered: acc.discovered + row.discovered,
      rejectedByAudit: acc.rejectedByAudit + row.rejectedByAudit,
      abstained: acc.abstained + row.abstained,
      forecasted: acc.forecasted + row.forecasted,
      settled: acc.settled + row.settled,
      settledForecasted: acc.settledForecasted + row.settledForecasted,
      settledScored: acc.settledScored + row.settledScored,
      disputed: acc.disputed + row.disputed,
      voided: acc.voided + row.voided,
    }),
    {
      discovered: 0,
      rejectedByAudit: 0,
      abstained: 0,
      forecasted: 0,
      settled: 0,
      settledForecasted: 0,
      settledScored: 0,
      disputed: 0,
      voided: 0,
    }
  );

  const denominatorTotals: DenominatorTotals = Object.freeze({
    ...totals,
    coverage: totals.discovered > 0 ? totals.forecasted / totals.discovered : 0,
  });

  return Object.freeze({
    experiment,
    parsedDefinition,
    eventFamilies: Object.freeze(sortedFamilies),
    scoredSamples: Object.freeze(scoredSamples),
    disputedOrVoided: Object.freeze(disputedOrVoided),
    excludedMissingMarketReference: Object.freeze(excludedMissingMarketReference),
    abstainedMarkets: Object.freeze(abstainedMarkets),
    denominatorByFamily: Object.freeze(denominatorByFamily),
    denominatorTotals,
  });
}
