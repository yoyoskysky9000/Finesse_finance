import type { EventEdgeConfig } from '../config/index';
import type { PersistedForecastRecord } from '../persistence/forecastRepository';

export const SHADOW_SIDES = ['BUY_YES', 'BUY_NO'] as const;
export type ShadowOrderSide = (typeof SHADOW_SIDES)[number];

export const SHADOW_DECISION_OUTCOMES = ['ORDER_CREATED', 'NO_EDGE'] as const;
export type ShadowDecisionOutcome = (typeof SHADOW_DECISION_OUTCOMES)[number];

export const SHADOW_FILL_STATUSES = ['FILLED', 'PARTIAL', 'NO_FILL'] as const;
export type ShadowFillStatus = (typeof SHADOW_FILL_STATUSES)[number];

export const SHADOW_NO_FILL_REASONS = [
  'NO_EDGE',
  'BOOK_NOT_CAPTURED',
  'STALE_BOOK',
  'INSUFFICIENT_DEPTH',
] as const;
export type ShadowNoFillReason = (typeof SHADOW_NO_FILL_REASONS)[number];

export const SUPPORTED_SHADOW_FEE_SCHEDULES = ['kalshi-taker-v1'] as const;
export type SupportedShadowFeeSchedule = (typeof SUPPORTED_SHADOW_FEE_SCHEDULES)[number];

export class ShadowExecutionValidationError extends Error {
  public readonly code = 'EVENTEDGE_SHADOW_VALIDATION_ERROR' as const;

  constructor(message: string) {
    super(message);
    this.name = 'ShadowExecutionValidationError';
  }
}

export class ShadowForecastNotFoundError extends Error {
  public readonly code = 'EVENTEDGE_SHADOW_FORECAST_NOT_FOUND' as const;
  public readonly experimentId: string;
  public readonly marketId: string;

  constructor(experimentId: string, marketId: string, detail?: string) {
    const suffix = detail ? ` (${detail})` : '';
    super(
      `No eligible persisted p_calibrated or p_ensemble forecast found for experiment "${experimentId}" on market "${marketId}"${suffix}.`
    );
    this.name = 'ShadowForecastNotFoundError';
    this.experimentId = experimentId;
    this.marketId = marketId;
  }
}

export class DecisionBookNotFoundError extends Error {
  public readonly code = 'EVENTEDGE_SHADOW_DECISION_BOOK_NOT_FOUND' as const;
  public readonly marketId: string;
  public readonly decisionTimestamp: string;

  constructor(marketId: string, decisionTimestamp: string, detail?: string) {
    const suffix = detail ? ` (${detail})` : '';
    super(
      `No captured book snapshot found for market "${marketId}" at or before decision_timestamp "${decisionTimestamp}"${suffix}.`
    );
    this.name = 'DecisionBookNotFoundError';
    this.marketId = marketId;
    this.decisionTimestamp = decisionTimestamp;
  }
}

export class UnsupportedFeeScheduleError extends Error {
  public readonly code = 'EVENTEDGE_SHADOW_UNSUPPORTED_FEE_SCHEDULE' as const;
  public readonly feeScheduleVersion: string;

  constructor(feeScheduleVersion: string) {
    super(
      `Unsupported shadow fee schedule version "${feeScheduleVersion}". Supported: ${SUPPORTED_SHADOW_FEE_SCHEDULES.join(', ')}.`
    );
    this.name = 'UnsupportedFeeScheduleError';
    this.feeScheduleVersion = feeScheduleVersion;
  }
}

export interface CapturedBookSnapshot {
  readonly snapshotId: string;
  readonly sourceTable: 'orderbook_states' | 'market_snapshots';
  readonly marketId: string;
  readonly yesBidUsd: number;
  readonly yesAskUsd: number;
  /** Displayed top-of-book YES bid depth (contracts available for BUY_NO at 1 - yes_bid). */
  readonly yesBidSize: number;
  /** Displayed top-of-book YES ask depth (contracts available for BUY_YES at yes_ask). */
  readonly yesAskSize: number;
  readonly capturedAt: string;
}

export interface PersistOrderbookStateInput {
  readonly orderbookStateId: string;
  readonly venue?: string;
  readonly marketTicker: string;
  readonly bestBidUsd: number;
  readonly bestAskUsd: number;
  readonly yesBidSizeFp: number;
  readonly yesAskSizeFp: number;
  readonly lhs?: number | null;
  readonly bids?: readonly (readonly [number, number])[];
  readonly asks?: readonly (readonly [number, number])[];
  readonly bookSeq?: number | null;
  readonly capturedAt: string;
}

export interface ShadowEdgeEvaluation {
  readonly edgeYes: number;
  readonly edgeNo: number;
  readonly selectedEdge: number;
  readonly minConservativeEdge: number;
  readonly outcome: ShadowDecisionOutcome;
  readonly side: ShadowOrderSide | null;
}

export interface ShadowDecisionRecord {
  readonly decisionId: string;
  readonly forecastId: string;
  readonly forecastStage: 'p_ensemble' | 'p_calibrated';
  readonly experimentId: string;
  readonly marketId: string;
  readonly modelProbability: number;
  readonly decisionTimestamp: string;
  readonly decisionBookSnapshotId: string;
  readonly decisionBookCapturedAt: string;
  readonly decisionYesBidUsd: number;
  readonly decisionYesAskUsd: number;
  readonly edgeYes: number;
  readonly edgeNo: number;
  readonly selectedEdge: number;
  readonly minConservativeEdge: number;
  readonly outcome: ShadowDecisionOutcome;
  readonly side: ShadowOrderSide | null;
  readonly requestedQuantity: number;
  readonly configHash: string;
  readonly createdAt: string;
}

export interface ShadowOrderRecord {
  readonly orderId: string;
  readonly decisionId: string;
  readonly experimentId: string;
  readonly forecastId: string;
  readonly marketId: string;
  readonly side: ShadowOrderSide;
  readonly requestedQuantity: number;
  readonly decisionPriceUsd: number;
  readonly decisionBookSnapshotId: string;
  readonly decisionTimestamp: string;
  readonly latencyModelVersion: string;
  readonly latencyMs: number;
  readonly arrivalTimestamp: string;
  readonly configHash: string;
  readonly createdAt: string;
}

export interface ShadowFillRecord {
  readonly fillId: string;
  readonly orderId: string | null;
  readonly decisionId: string;
  readonly experimentId: string;
  readonly marketId: string;
  readonly status: ShadowFillStatus;
  readonly side: ShadowOrderSide | null;
  readonly requestedQuantity: number;
  readonly filledQuantity: number;
  readonly unfilledQuantity: number;
  readonly fillPriceUsd: number | null;
  readonly feeUsd: number;
  readonly feeScheduleVersion: string;
  readonly decisionBookSnapshotId: string;
  readonly arrivalBookSnapshotId: string | null;
  readonly arrivalBookCapturedAt: string | null;
  readonly displayedDepthAtPrice: number | null;
  readonly bookAgeMs: number | null;
  readonly evaluatedAt: string;
  readonly reasonCode: ShadowNoFillReason | null;
  readonly configHash: string;
  readonly createdAt: string;
}

export interface ExecuteShadowOrderInput {
  readonly experimentId: string;
  readonly marketId: string;
  /** Positive integer contract quantity (sizing is an input to this engine). */
  readonly requestedQuantity: number;
  readonly config: EventEdgeConfig;
  /** Optional explicit persisted forecast record; if omitted (or p_ensemble when p_calibrated exists), p_calibrated is preferred. */
  readonly forecast?: PersistedForecastRecord;
  /** Whether to prefer a persisted p_calibrated forecast for the same market & experiment when available (default true). */
  readonly preferCalibrated?: boolean;
  /** ISO-8601 UTC timestamp of the shadow decision (defaults to forecast.forecastTimestamp). */
  readonly decisionTimestamp?: string;
  /** Optional explicit decision-time book snapshot id (must exist and have captured_at <= decisionTimestamp). */
  readonly decisionBookSnapshotId?: string;
  /** ISO-8601 UTC timestamp representing the evaluation moment recorded on the fill (defaults deterministically to arrival book captured_at when present, else arrivalTimestamp). */
  readonly evaluatedAt?: string;
}

export interface ShadowExecutionResult {
  readonly decision: ShadowDecisionRecord;
  readonly order: ShadowOrderRecord | null;
  readonly fill: ShadowFillRecord;
  readonly decisionBook: CapturedBookSnapshot;
  readonly arrivalBook: CapturedBookSnapshot | null;
  readonly replayed: boolean;
}
