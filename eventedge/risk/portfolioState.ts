import type { DatabaseSync } from 'node:sqlite';
import {
  EventEdgeLiveModeDisabledError,
  assertNonLiveMode,
  createEventEdgeConfig,
  type EventEdgeConfig,
} from '../config/index';
import { ExperimentNotFoundError, getExperiment } from '../experiments/registry';
import { deriveEventFamilyId } from '../forecasting/priceBlindGuard';
import type { ContractLifecycleState } from '../lifecycle/contractLifecycle';
import { listCapturedBookSnapshotsForMarket } from '../shadow/bookReader';
import { computeShadowFillFee } from '../shadow/fees';
import type { CapturedBookSnapshot, ShadowOrderSide } from '../shadow/types';
import { getCurrentRiskSystemState } from './systemState';
import {
  PORTFOLIO_DAY_BOUNDARY_TIMEZONE,
  PORTFOLIO_EQUITY_SAMPLING_POLICY,
  RiskValidationError,
  type BuildPortfolioStateOptions,
  type EquitySamplePoint,
  type OpenPositionRecord,
  type PendingOrderExposureRecord,
  type PortfolioState,
} from './types';

function cleanFloat(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (Math.abs(value) < 1e-12) return 0;
  return Number(value.toFixed(10));
}

function getUtcDayStartIso(asOfEpochMs: number): { iso: string; epochMs: number } {
  const d = new Date(asOfEpochMs);
  const startEpochMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0);
  return {
    iso: new Date(startEpochMs).toISOString(),
    epochMs: startEpochMs,
  };
}

interface RawShadowFillWithMetaRow {
  fill_id: string;
  order_id: string | null;
  decision_id: string;
  market_id: string;
  status: 'FILLED' | 'PARTIAL' | 'NO_FILL';
  side: ShadowOrderSide | null;
  filled_quantity: number;
  fill_price_usd: number | null;
  fee_usd: number;
  evaluated_at: string;
  forecast_event_id: string | null;
  forecast_event_family_id: string | null;
}

interface RawShadowOrderWithMetaRow {
  order_id: string;
  decision_id: string;
  market_id: string;
  side: ShadowOrderSide;
  requested_quantity: number;
  decision_price_usd: number;
  decision_timestamp: string;
  forecast_event_id: string | null;
  forecast_event_family_id: string | null;
}

interface RawLifecycleRow {
  market_id: string;
  to_state: ContractLifecycleState;
  transitioned_at: string;
}

interface RawSettlementRow {
  market_ticker: string;
  outcome: 'YES' | 'NO' | 'VOID' | 'CANCELLED';
  settled_at: string;
}

interface ParsedExecutedFill {
  readonly fillId: string;
  readonly marketId: string;
  readonly eventId: string;
  readonly eventFamilyId: string;
  readonly side: ShadowOrderSide;
  readonly filledQuantity: number;
  readonly fillPriceUsd: number;
  readonly feeUsd: number;
  readonly evaluatedAt: string;
  readonly evaluatedEpochMs: number;
}

interface MarketResolutionInfo {
  readonly marketId: string;
  readonly outcome: 0 | 1;
  readonly resolvedAt: string;
  readonly resolvedEpochMs: number;
}

interface SnapshotEvalResult {
  readonly realizedPnl: number;
  readonly unrealizedPnl: number;
  readonly openPositions: readonly OpenPositionRecord[];
  readonly totalOpenWorstCaseLoss: number;
}

function findLatestBookSnapshot(
  snapshots: readonly CapturedBookSnapshot[],
  targetEpochMs: number,
  includeEqual: boolean
): CapturedBookSnapshot | null {
  let best: CapturedBookSnapshot | null = null;
  let bestEpochMs = Number.NEGATIVE_INFINITY;
  for (const snap of snapshots) {
    const snapMs = Date.parse(snap.capturedAt);
    if (!Number.isFinite(snapMs)) continue;
    const within = includeEqual ? snapMs <= targetEpochMs : snapMs < targetEpochMs;
    if (within && snapMs >= bestEpochMs) {
      best = snap;
      bestEpochMs = snapMs;
    }
  }
  return best;
}

function evaluatePortfolioAtTime(
  fills: readonly ParsedExecutedFill[],
  resolutionsByMarket: ReadonlyMap<string, MarketResolutionInfo>,
  snapshotsByMarket: ReadonlyMap<string, readonly CapturedBookSnapshot[]>,
  targetEpochMs: number,
  includeEqual: boolean
): SnapshotEvalResult {
  let realizedPnl = 0;

  interface OpenAccumulator {
    marketId: string;
    eventId: string;
    eventFamilyId: string;
    side: ShadowOrderSide;
    quantity: number;
    notionalCost: number;
    totalFees: number;
  }

  const openAcc = new Map<string, OpenAccumulator>();

  for (const fill of fills) {
    const fillIncluded = includeEqual
      ? fill.evaluatedEpochMs <= targetEpochMs
      : fill.evaluatedEpochMs < targetEpochMs;
    if (!fillIncluded) continue;

    const resolution = resolutionsByMarket.get(fill.marketId);
    const isResolved =
      resolution !== undefined &&
      (includeEqual
        ? resolution.resolvedEpochMs <= targetEpochMs
        : resolution.resolvedEpochMs < targetEpochMs);

    if (isResolved && resolution) {
      const payoff =
        fill.side === 'BUY_YES'
          ? fill.filledQuantity * (resolution.outcome - fill.fillPriceUsd) - fill.feeUsd
          : fill.filledQuantity * (1 - resolution.outcome - fill.fillPriceUsd) - fill.feeUsd;
      realizedPnl += payoff;
      continue;
    }

    const key = `${fill.marketId}::${fill.side}`;
    const existing = openAcc.get(key);
    if (existing) {
      existing.quantity += fill.filledQuantity;
      existing.notionalCost += fill.filledQuantity * fill.fillPriceUsd;
      existing.totalFees += fill.feeUsd;
    } else {
      openAcc.set(key, {
        marketId: fill.marketId,
        eventId: fill.eventId,
        eventFamilyId: fill.eventFamilyId,
        side: fill.side,
        quantity: fill.filledQuantity,
        notionalCost: fill.filledQuantity * fill.fillPriceUsd,
        totalFees: fill.feeUsd,
      });
    }
  }

  const openPositions: OpenPositionRecord[] = [];
  let unrealizedPnl = 0;
  let totalOpenWorstCaseLoss = 0;

  const sortedKeys = [...openAcc.keys()].sort();
  for (const key of sortedKeys) {
    const acc = openAcc.get(key)!;
    const averageFillPrice = cleanFloat(acc.notionalCost / acc.quantity);
    const totalFees = cleanFloat(acc.totalFees);
    const worstCaseLoss = cleanFloat(acc.notionalCost + acc.totalFees);

    const marketSnapshots = snapshotsByMarket.get(acc.marketId) ?? [];
    const latestSnap = findLatestBookSnapshot(marketSnapshots, targetEpochMs, includeEqual);

    let markPrice: number;
    let markedAtFillPriceFallback: boolean;
    let markSnapshotId: string | null;
    let markSnapshotCapturedAt: string | null;

    if (latestSnap) {
      markPrice =
        acc.side === 'BUY_YES'
          ? cleanFloat(latestSnap.yesBidUsd)
          : cleanFloat(1 - latestSnap.yesAskUsd);
      markedAtFillPriceFallback = false;
      markSnapshotId = latestSnap.snapshotId;
      markSnapshotCapturedAt = latestSnap.capturedAt;
    } else {
      markPrice = averageFillPrice;
      markedAtFillPriceFallback = true;
      markSnapshotId = null;
      markSnapshotCapturedAt = null;
    }

    const grossUnrealizedPnl = cleanFloat(acc.quantity * (markPrice - averageFillPrice));
    const netUnrealizedPnl = cleanFloat(grossUnrealizedPnl - totalFees);

    unrealizedPnl += netUnrealizedPnl;
    totalOpenWorstCaseLoss += worstCaseLoss;

    openPositions.push(
      Object.freeze({
        marketId: acc.marketId,
        eventId: acc.eventId,
        eventFamilyId: acc.eventFamilyId,
        side: acc.side,
        quantity: acc.quantity,
        averageFillPrice,
        totalFees,
        worstCaseLoss,
        markPrice,
        markSnapshotId,
        markSnapshotCapturedAt,
        markedAtFillPriceFallback,
        grossUnrealizedPnl,
        unrealizedPnl: netUnrealizedPnl,
      })
    );
  }

  return {
    realizedPnl: cleanFloat(realizedPnl),
    unrealizedPnl: cleanFloat(unrealizedPnl),
    openPositions: Object.freeze(openPositions),
    totalOpenWorstCaseLoss: cleanFloat(totalOpenWorstCaseLoss),
  };
}

/**
 * Deterministic, read-only portfolio state builder.
 *
 * Reconstructs the entire paper portfolio state for one registered experiment as of `asOf`
 * strictly from the EventEdge SQLite ledger (`shadow_decisions`, `shadow_orders`, `shadow_fills`,
 * `probability_forecasts`, `contract_lifecycle_history`, `settlements`, `orderbook_states` /
 * `market_snapshots`, and `risk_state_history`). Writes NOTHING to the database.
 *
 * Accounting conventions:
 * - **Day boundary**: UTC calendar day `[YYYY-MM-DDT00:00:00.000Z, asOf]`. `dailyPnl` equals the
 *   change in total PnL (`realizedPnl + unrealizedPnl`) from strictly before `dayStartUtc` to `asOf`.
 * - **Equity curve sampling**: Sampled at genesis (`settledCash`), each executed shadow fill,
 *   each contract resolution, each captured book mark for markets with an open position at that
 *   time, and `asOf` (all timestamps `<= asOf`). `peakEquity` and `drawdownPct` are computed
 *   peak-to-trough on this deterministic series.
 */
export function buildPortfolioState(
  db: DatabaseSync,
  experimentId: string,
  asOf: string,
  options: BuildPortfolioStateOptions | number
): PortfolioState {
  const trimmedExperimentId = experimentId.trim();
  if (!trimmedExperimentId) {
    throw new RiskValidationError('experimentId must be a non-empty string.');
  }

  const trimmedAsOf = asOf.trim();
  const asOfEpochMs = Date.parse(trimmedAsOf);
  if (!Number.isFinite(asOfEpochMs)) {
    throw new RiskValidationError(
      `Invalid asOf timestamp "${asOf}". Expected ISO-8601 UTC timestamp.`
    );
  }

  const resolvedOpts: BuildPortfolioStateOptions =
    typeof options === 'number' ? { settledCash: options } : options;

  if (
    !resolvedOpts ||
    typeof resolvedOpts.settledCash !== 'number' ||
    !Number.isFinite(resolvedOpts.settledCash) ||
    resolvedOpts.settledCash <= 0
  ) {
    throw new RiskValidationError(
      `settledCash must be a positive finite number (received ${String(resolvedOpts?.settledCash)}).`
    );
  }

  const config: EventEdgeConfig =
    resolvedOpts.config ?? createEventEdgeConfig({ mode: 'PAPER' });
  assertNonLiveMode(config.mode, 'risk.buildPortfolioState');
  if (config.liveEnabled !== false) {
    throw new EventEdgeLiveModeDisabledError('risk.buildPortfolioState#liveEnabled');
  }

  const experiment = getExperiment(db, trimmedExperimentId);
  if (!experiment) {
    throw new ExperimentNotFoundError(trimmedExperimentId);
  }

  const settledCash = cleanFloat(resolvedOpts.settledCash);
  const { iso: dayStartUtc, epochMs: dayStartEpochMs } = getUtcDayStartIso(asOfEpochMs);

  // 1. Load all shadow fills for this experiment (evaluated_at <= asOf filtered via Date.parse)
  const rawFillRows = db
    .prepare(
      `SELECT
         sf.fill_id,
         sf.order_id,
         sf.decision_id,
         sf.market_id,
         sf.status,
         sf.side,
         sf.filled_quantity,
         sf.fill_price_usd,
         sf.fee_usd,
         sf.evaluated_at,
         pf.event_id AS forecast_event_id,
         pf.event_family_id AS forecast_event_family_id
       FROM shadow_fills sf
       LEFT JOIN shadow_decisions sd ON sd.decision_id = sf.decision_id
       LEFT JOIN probability_forecasts pf ON pf.forecast_id = sd.forecast_id
       WHERE sf.experiment_id = ?
       ORDER BY sf.evaluated_at ASC, sf.rowid ASC`
    )
    .all(trimmedExperimentId) as unknown as RawShadowFillWithMetaRow[];

  const executedFills: ParsedExecutedFill[] = [];
  const filledOrderIdsAsOf = new Set<string>();
  const relevantMarkets = new Set<string>();

  for (const row of rawFillRows) {
    const evalMs = Date.parse(row.evaluated_at);
    if (!Number.isFinite(evalMs) || evalMs > asOfEpochMs) continue;

    if (row.order_id) {
      filledOrderIdsAsOf.add(row.order_id);
    }

    if (
      (row.status === 'FILLED' || row.status === 'PARTIAL') &&
      row.filled_quantity > 0 &&
      row.fill_price_usd !== null &&
      row.side !== null
    ) {
      const eventId = row.forecast_event_id?.trim() || row.market_id;
      const eventFamilyId =
        row.forecast_event_family_id?.trim() || deriveEventFamilyId(eventId).eventFamilyId;
      relevantMarkets.add(row.market_id);
      executedFills.push(
        Object.freeze({
          fillId: row.fill_id,
          marketId: row.market_id,
          eventId,
          eventFamilyId,
          side: row.side,
          filledQuantity: Number(row.filled_quantity),
          fillPriceUsd: Number(row.fill_price_usd),
          feeUsd: Number(row.fee_usd),
          evaluatedAt: row.evaluated_at,
          evaluatedEpochMs: evalMs,
        })
      );
    }
  }

  // 2. Load pending shadow orders (created <= asOf with NO shadow_fills row <= asOf)
  const rawOrderRows = db
    .prepare(
      `SELECT
         so.order_id,
         so.decision_id,
         so.market_id,
         so.side,
         so.requested_quantity,
         so.decision_price_usd,
         so.decision_timestamp,
         pf.event_id AS forecast_event_id,
         pf.event_family_id AS forecast_event_family_id
       FROM shadow_orders so
       LEFT JOIN probability_forecasts pf ON pf.forecast_id = so.forecast_id
       WHERE so.experiment_id = ?
       ORDER BY so.decision_timestamp ASC, so.rowid ASC`
    )
    .all(trimmedExperimentId) as unknown as RawShadowOrderWithMetaRow[];

  const pendingOrders: PendingOrderExposureRecord[] = [];
  let pendingExposure = 0;
  const pendingByMarket: Record<string, number> = {};
  const pendingByEvent: Record<string, number> = {};
  const pendingByFamily: Record<string, number> = {};

  for (const row of rawOrderRows) {
    const decMs = Date.parse(row.decision_timestamp);
    if (!Number.isFinite(decMs) || decMs > asOfEpochMs) continue;
    if (filledOrderIdsAsOf.has(row.order_id)) continue;

    const eventId = row.forecast_event_id?.trim() || row.market_id;
    const eventFamilyId =
      row.forecast_event_family_id?.trim() || deriveEventFamilyId(eventId).eventFamilyId;
    const qty = Number(row.requested_quantity);
    const decisionPrice = Number(row.decision_price_usd);
    const estimatedFee = computeShadowFillFee(
      qty,
      decisionPrice,
      config.shadow.feeScheduleVersion
    ).feeUsd;
    const worstCaseLoss = cleanFloat(qty * decisionPrice + estimatedFee);

    pendingExposure += worstCaseLoss;
    pendingByMarket[row.market_id] = cleanFloat((pendingByMarket[row.market_id] ?? 0) + worstCaseLoss);
    pendingByEvent[eventId] = cleanFloat((pendingByEvent[eventId] ?? 0) + worstCaseLoss);
    pendingByFamily[eventFamilyId] = cleanFloat((pendingByFamily[eventFamilyId] ?? 0) + worstCaseLoss);

    pendingOrders.push(
      Object.freeze({
        orderId: row.order_id,
        decisionId: row.decision_id,
        marketId: row.market_id,
        eventId,
        eventFamilyId,
        side: row.side,
        requestedQuantity: qty,
        decisionPriceUsd: decisionPrice,
        estimatedFeeUsd: estimatedFee,
        worstCaseLoss,
        decisionTimestamp: row.decision_timestamp,
      })
    );
  }
  pendingExposure = cleanFloat(pendingExposure);

  // 3. Load contract lifecycle states & binary outcomes for relevant markets (all <= asOf)
  const resolutionsByMarket = new Map<string, MarketResolutionInfo>();
  const snapshotsByMarket = new Map<string, readonly CapturedBookSnapshot[]>();

  for (const marketId of relevantMarkets) {
    // Lifecycle history <= asOf
    const lcRows = db
      .prepare(
        `SELECT market_id, to_state, transitioned_at
         FROM contract_lifecycle_history
         WHERE market_id = ?
         ORDER BY rowid ASC`
      )
      .all(marketId) as unknown as RawLifecycleRow[];

    let latestState: ContractLifecycleState | null = null;
    let resolvedTransitionAt: string | null = null;
    let resolvedTransitionMs = Number.NEGATIVE_INFINITY;

    for (const row of lcRows) {
      const ms = Date.parse(row.transitioned_at);
      if (!Number.isFinite(ms) || ms > asOfEpochMs) continue;
      latestState = row.to_state;
      if (row.to_state === 'RESOLVED') {
        resolvedTransitionAt = row.transitioned_at;
        resolvedTransitionMs = ms;
      }
    }

    if (latestState === 'RESOLVED' && resolvedTransitionAt !== null) {
      const settleRows = db
        .prepare(
          `SELECT market_ticker, outcome, settled_at
           FROM settlements
           WHERE market_ticker = ?
             AND outcome IN ('YES', 'NO')
           ORDER BY rowid ASC`
        )
        .all(marketId) as unknown as RawSettlementRow[];

      let matchedSettle: RawSettlementRow | null = null;
      for (const sRow of settleRows) {
        const sMs = Date.parse(sRow.settled_at);
        if (Number.isFinite(sMs) && sMs <= asOfEpochMs) {
          matchedSettle = sRow;
        }
      }
      // Fallback: if lifecycle reached RESOLVED <= asOf and settlement exists without later timestamp
      if (!matchedSettle && settleRows.length > 0) {
        const candidate = settleRows[settleRows.length - 1];
        const sMs = Date.parse(candidate.settled_at);
        if (Number.isFinite(sMs) && sMs <= asOfEpochMs) {
          matchedSettle = candidate;
        }
      }

      if (matchedSettle) {
        const settleMs = Date.parse(matchedSettle.settled_at);
        const effectiveMs = Math.max(resolvedTransitionMs, settleMs);
        resolutionsByMarket.set(marketId, {
          marketId,
          outcome: matchedSettle.outcome === 'YES' ? 1 : 0,
          resolvedAt: new Date(effectiveMs).toISOString(),
          resolvedEpochMs: effectiveMs,
        });
      }
    }

    // Load captured book snapshots <= asOf for this market
    const allSnaps = listCapturedBookSnapshotsForMarket(db, marketId).filter((s) => {
      const ms = Date.parse(s.capturedAt);
      return Number.isFinite(ms) && ms <= asOfEpochMs;
    });
    snapshotsByMarket.set(marketId, Object.freeze(allSnaps));
  }

  // 4. Evaluate current state at asOf and at strictly before UTC dayStart
  const asOfSnapshot = evaluatePortfolioAtTime(
    executedFills,
    resolutionsByMarket,
    snapshotsByMarket,
    asOfEpochMs,
    true
  );

  const beforeDaySnapshot = evaluatePortfolioAtTime(
    executedFills,
    resolutionsByMarket,
    snapshotsByMarket,
    dayStartEpochMs,
    false
  );

  const realizedPnl = asOfSnapshot.realizedPnl;
  const unrealizedPnl = asOfSnapshot.unrealizedPnl;
  const currentEquity = cleanFloat(settledCash + realizedPnl + unrealizedPnl);

  const totalPnlAtAsOf = realizedPnl + unrealizedPnl;
  const totalPnlBeforeDayStart = beforeDaySnapshot.realizedPnl + beforeDaySnapshot.unrealizedPnl;
  const dailyPnl = cleanFloat(totalPnlAtAsOf - totalPnlBeforeDayStart);
  const dailyLossPct = cleanFloat(Math.max(0, -dailyPnl) / settledCash);

  // 5. Build exposure maps from open positions
  const exposureByMarket: Record<string, number> = {};
  const exposureByEvent: Record<string, number> = {};
  const exposureByEventFamily: Record<string, number> = {};
  const unpricedPositionMarketIds: string[] = [];

  for (const pos of asOfSnapshot.openPositions) {
    exposureByMarket[pos.marketId] = cleanFloat(
      (exposureByMarket[pos.marketId] ?? 0) + pos.worstCaseLoss
    );
    exposureByEvent[pos.eventId] = cleanFloat(
      (exposureByEvent[pos.eventId] ?? 0) + pos.worstCaseLoss
    );
    exposureByEventFamily[pos.eventFamilyId] = cleanFloat(
      (exposureByEventFamily[pos.eventFamilyId] ?? 0) + pos.worstCaseLoss
    );
    if (pos.markedAtFillPriceFallback && !unpricedPositionMarketIds.includes(pos.marketId)) {
      unpricedPositionMarketIds.push(pos.marketId);
    }
  }
  unpricedPositionMarketIds.sort();

  const deployedPct = cleanFloat(asOfSnapshot.totalOpenWorstCaseLoss / settledCash);

  // 6. Build deterministic equity series sampled at genesis, each fill, each resolution,
  //    each mark snapshot for an active position, and asOf.
  const sampleTriggers = new Map<
    number,
    { timestamp: string; trigger: EquitySamplePoint['trigger'] }
  >();

  // Helper to record sample timestamp with precedence FILL/RESOLUTION > MARK > AS_OF
  const addSamplePoint = (
    epochMs: number,
    timestamp: string,
    trigger: EquitySamplePoint['trigger']
  ): void => {
    if (!Number.isFinite(epochMs) || epochMs > asOfEpochMs) return;
    const existing = sampleTriggers.get(epochMs);
    if (!existing) {
      sampleTriggers.set(epochMs, { timestamp, trigger });
      return;
    }
    const rank: Record<EquitySamplePoint['trigger'], number> = {
      GENESIS: 0,
      AS_OF: 1,
      MARK: 2,
      FILL: 3,
      RESOLUTION: 4,
    };
    if (rank[trigger] > rank[existing.trigger]) {
      sampleTriggers.set(epochMs, { timestamp, trigger });
    }
  };

  // Track first fill epoch per market so mark snapshots are sampled when the position is open
  const firstFillEpochByMarket = new Map<string, number>();
  for (const fill of executedFills) {
    addSamplePoint(fill.evaluatedEpochMs, fill.evaluatedAt, 'FILL');
    const prev = firstFillEpochByMarket.get(fill.marketId);
    if (prev === undefined || fill.evaluatedEpochMs < prev) {
      firstFillEpochByMarket.set(fill.marketId, fill.evaluatedEpochMs);
    }
  }

  for (const res of resolutionsByMarket.values()) {
    addSamplePoint(res.resolvedEpochMs, res.resolvedAt, 'RESOLUTION');
  }

  for (const [marketId, snaps] of snapshotsByMarket.entries()) {
    const firstFillMs = firstFillEpochByMarket.get(marketId);
    if (firstFillMs === undefined) continue;
    const resMs = resolutionsByMarket.get(marketId)?.resolvedEpochMs ?? Number.POSITIVE_INFINITY;
    for (const snap of snaps) {
      const snapMs = Date.parse(snap.capturedAt);
      if (Number.isFinite(snapMs) && snapMs >= firstFillMs && snapMs <= resMs && snapMs <= asOfEpochMs) {
        addSamplePoint(snapMs, snap.capturedAt, 'MARK');
      }
    }
  }

  addSamplePoint(asOfEpochMs, trimmedAsOf, 'AS_OF');

  const sortedEpochs = [...sampleTriggers.keys()].sort((a, b) => a - b);
  const equitySeries: EquitySamplePoint[] = [];

  let peakEquity = settledCash;
  equitySeries.push(
    Object.freeze({
      timestamp: sortedEpochs.length > 0 ? new Date(sortedEpochs[0]).toISOString() : trimmedAsOf,
      equity: settledCash,
      realizedPnl: 0,
      unrealizedPnl: 0,
      peakEquity: settledCash,
      drawdownPct: 0,
      trigger: 'GENESIS' as const,
    })
  );

  for (const epochMs of sortedEpochs) {
    const meta = sampleTriggers.get(epochMs)!;
    const snap = evaluatePortfolioAtTime(
      executedFills,
      resolutionsByMarket,
      snapshotsByMarket,
      epochMs,
      true
    );
    const equity = cleanFloat(settledCash + snap.realizedPnl + snap.unrealizedPnl);
    if (equity > peakEquity) {
      peakEquity = equity;
    }
    const dd = peakEquity > 0 ? cleanFloat(Math.max(0, (peakEquity - equity) / peakEquity)) : 0;
    equitySeries.push(
      Object.freeze({
        timestamp: meta.timestamp,
        equity,
        realizedPnl: snap.realizedPnl,
        unrealizedPnl: snap.unrealizedPnl,
        peakEquity: cleanFloat(peakEquity),
        drawdownPct: dd,
        trigger: meta.trigger,
      })
    );
  }

  peakEquity = cleanFloat(Math.max(peakEquity, currentEquity));
  const drawdownPct =
    peakEquity > 0 ? cleanFloat(Math.max(0, (peakEquity - currentEquity) / peakEquity)) : 0;

  // 7. Read current risk system state from append-only risk_state_history (<= asOf)
  const systemState = getCurrentRiskSystemState(db, trimmedAsOf);

  return Object.freeze({
    experimentId: trimmedExperimentId,
    asOf: trimmedAsOf,
    dayBoundaryTimezone: PORTFOLIO_DAY_BOUNDARY_TIMEZONE,
    dayStartUtc,
    equitySamplingPolicy: PORTFOLIO_EQUITY_SAMPLING_POLICY,
    settledCash,
    realizedPnl,
    unrealizedPnl,
    currentEquity,
    openPositions: asOfSnapshot.openPositions,
    unpricedPositionMarketIds: Object.freeze(unpricedPositionMarketIds),
    totalOpenWorstCaseLoss: asOfSnapshot.totalOpenWorstCaseLoss,
    exposureByMarket: Object.freeze(exposureByMarket),
    exposureByEvent: Object.freeze(exposureByEvent),
    exposureByEventFamily: Object.freeze(exposureByEventFamily),
    pendingOrders: Object.freeze(pendingOrders),
    pendingExposure,
    pendingExposureByMarket: Object.freeze(pendingByMarket),
    pendingExposureByEvent: Object.freeze(pendingByEvent),
    pendingExposureByEventFamily: Object.freeze(pendingByFamily),
    deployedPct,
    dailyPnl,
    dailyLossPct,
    peakEquity,
    drawdownPct,
    equitySeries: Object.freeze(equitySeries),
    systemState,
    riskConfig: config.risk,
  });
}
