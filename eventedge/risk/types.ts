import type { EventEdgeConfig, EventEdgeRiskConfig } from '../config/index';
import type { ShadowOrderSide } from '../shadow/types';

export const RISK_SYSTEM_STATES = [
  'HEALTHY',
  'DEGRADED',
  'HALTED',
  'RECONCILIATION_REQUIRED',
  'DATA_QUARANTINE',
  'RECOVERY_PENDING',
] as const;

export type RiskSystemState = (typeof RISK_SYSTEM_STATES)[number];

export const TRADING_ALLOWED_RISK_STATES: readonly RiskSystemState[] = Object.freeze([
  'HEALTHY',
  'DEGRADED',
]);

export const RISK_REJECTION_REASON_CODES = [
  'POSITION_CAP',
  'EVENT_RISK_CAP',
  'CORRELATED_CAP',
  'DEPLOYED_CAP',
  'DAILY_LOSS_STOP',
  'DRAWDOWN_STOP',
  'SYSTEM_STATE',
] as const;

export type RiskRejectionReasonCode = (typeof RISK_REJECTION_REASON_CODES)[number];

export const RISK_EVALUATION_DECISIONS = ['APPROVED', 'REJECTED'] as const;
export type RiskEvaluationDecision = (typeof RISK_EVALUATION_DECISIONS)[number];

export const PORTFOLIO_DAY_BOUNDARY_TIMEZONE = 'UTC' as const;

export const PORTFOLIO_EQUITY_SAMPLING_POLICY =
  'Sampled deterministically at genesis (settledCash), each executed shadow fill, each contract resolution, each captured book mark for open positions, and asOf (all <= asOf).' as const;

export class RiskValidationError extends Error {
  public readonly code = 'EVENTEDGE_RISK_VALIDATION_ERROR' as const;

  constructor(message: string) {
    super(message);
    this.name = 'RiskValidationError';
  }
}

export class IllegalRiskStateTransitionError extends Error {
  public readonly code = 'EVENTEDGE_ILLEGAL_RISK_STATE_TRANSITION' as const;
  public readonly fromState: RiskSystemState;
  public readonly toState: RiskSystemState;

  constructor(fromState: RiskSystemState, toState: RiskSystemState, detail?: string) {
    const suffix = detail ? ` (${detail})` : '';
    super(`Illegal risk system state transition: ${fromState} -> ${toState} is forbidden${suffix}.`);
    this.name = 'IllegalRiskStateTransitionError';
    this.fromState = fromState;
    this.toState = toState;
  }
}

export interface RiskStateHistoryRecord {
  readonly transitionId: string;
  readonly fromState: RiskSystemState | null;
  readonly toState: RiskSystemState;
  readonly reason: string;
  readonly actor: string;
  readonly recordedAt: string;
  readonly createdAt: string;
}

export interface SystemStateEvaluationInputs {
  readonly ledgerIntegrityOk: boolean;
  readonly dataFresh: boolean;
  readonly dailyLossPct: number;
  readonly drawdownPct: number;
  readonly reconciliationPending: boolean;
  readonly degradedReason?: string | null;
  readonly dailyLossStopPct?: number;
  readonly peakToTroughDrawdownStopPct?: number;
}

export interface SystemStateEvaluationResult {
  readonly state: RiskSystemState;
  readonly reason: string;
}

export interface TransitionRiskStateInput {
  readonly toState: RiskSystemState;
  readonly reason: string;
  readonly actor: string;
  readonly recordedAt?: string;
}

export interface OperatorRiskActionInput {
  readonly actor: string;
  readonly reason: string;
  readonly recordedAt?: string;
}

export interface ApplySystemStateEvaluationOptions {
  readonly actor?: string;
  readonly recordedAt?: string;
  readonly riskConfig?: EventEdgeRiskConfig;
}

export interface ApplySystemStateEvaluationResult {
  readonly previousState: RiskSystemState;
  readonly evaluatedState: RiskSystemState;
  readonly currentState: RiskSystemState;
  readonly transitioned: boolean;
  readonly blockedAutoReset: boolean;
  readonly reason: string;
  readonly historyRecord: RiskStateHistoryRecord | null;
}

export interface OpenPositionRecord {
  readonly marketId: string;
  readonly eventId: string;
  readonly eventFamilyId: string;
  readonly side: ShadowOrderSide;
  readonly quantity: number;
  readonly averageFillPrice: number;
  readonly totalFees: number;
  /** Worst-case loss = total cost including fees (quantity * averageFillPrice + totalFees). */
  readonly worstCaseLoss: number;
  /** Mark price from latest book snapshot <= asOf (YES: yes_bid, NO: 1 - yes_ask), or averageFillPrice if none. */
  readonly markPrice: number;
  readonly markSnapshotId: string | null;
  readonly markSnapshotCapturedAt: string | null;
  /** True when no captured book snapshot existed <= asOf and position was marked at averageFillPrice. */
  readonly markedAtFillPriceFallback: boolean;
  /** Gross mark-to-market unrealized PnL: quantity * (markPrice - averageFillPrice). */
  readonly grossUnrealizedPnl: number;
  /** Net unrealized PnL after paid entry fees: grossUnrealizedPnl - totalFees. */
  readonly unrealizedPnl: number;
}

export interface PendingOrderExposureRecord {
  readonly orderId: string;
  readonly decisionId: string;
  readonly marketId: string;
  readonly eventId: string;
  readonly eventFamilyId: string;
  readonly side: ShadowOrderSide;
  readonly requestedQuantity: number;
  readonly decisionPriceUsd: number;
  readonly estimatedFeeUsd: number;
  readonly worstCaseLoss: number;
  readonly decisionTimestamp: string;
}

export interface EquitySamplePoint {
  readonly timestamp: string;
  readonly equity: number;
  readonly realizedPnl: number;
  readonly unrealizedPnl: number;
  readonly peakEquity: number;
  readonly drawdownPct: number;
  readonly trigger: 'GENESIS' | 'FILL' | 'RESOLUTION' | 'MARK' | 'AS_OF';
}

export interface BuildPortfolioStateOptions {
  /** Experiment's configured paper bankroll in USD (explicit input recorded on the state). */
  readonly settledCash: number;
  /** Optional EventEdgeConfig (defaults to PAPER mode with EE-00 risk defaults). */
  readonly config?: EventEdgeConfig;
}

export interface PortfolioState {
  readonly experimentId: string;
  readonly asOf: string;
  /** UTC calendar day boundary [dayStartUtc, asOf] used for dailyPnl calculation. */
  readonly dayBoundaryTimezone: typeof PORTFOLIO_DAY_BOUNDARY_TIMEZONE;
  readonly dayStartUtc: string;
  readonly equitySamplingPolicy: typeof PORTFOLIO_EQUITY_SAMPLING_POLICY;
  /** Configured paper bankroll in USD (explicit input). */
  readonly settledCash: number;
  readonly realizedPnl: number;
  readonly unrealizedPnl: number;
  readonly currentEquity: number;
  readonly openPositions: readonly OpenPositionRecord[];
  /** Markets whose open positions had no book snapshot <= asOf and were marked at fill price. */
  readonly unpricedPositionMarketIds: readonly string[];
  readonly totalOpenWorstCaseLoss: number;
  readonly exposureByMarket: Readonly<Record<string, number>>;
  readonly exposureByEvent: Readonly<Record<string, number>>;
  readonly exposureByEventFamily: Readonly<Record<string, number>>;
  readonly pendingOrders: readonly PendingOrderExposureRecord[];
  readonly pendingExposure: number;
  readonly pendingExposureByMarket: Readonly<Record<string, number>>;
  readonly pendingExposureByEvent: Readonly<Record<string, number>>;
  readonly pendingExposureByEventFamily: Readonly<Record<string, number>>;
  /** Total worst-case loss of open positions divided by settledCash. */
  readonly deployedPct: number;
  /** Realized + unrealized PnL change attributable to the asOf UTC calendar day. */
  readonly dailyPnl: number;
  /** Positive loss fraction attributable to the asOf UTC calendar day: max(0, -dailyPnl) / settledCash. */
  readonly dailyLossPct: number;
  readonly peakEquity: number;
  readonly drawdownPct: number;
  readonly equitySeries: readonly EquitySamplePoint[];
  readonly systemState: RiskSystemState;
  readonly riskConfig: EventEdgeRiskConfig;
}

export interface RiskProposal {
  readonly marketId: string;
  readonly eventFamilyId: string;
  readonly eventId?: string;
  readonly side: ShadowOrderSide;
  readonly quantity: number;
  readonly price: number;
  readonly fee: number;
}

export interface RiskLimitBreach {
  readonly code: RiskRejectionReasonCode;
  readonly message: string;
  readonly limitValue: number;
  readonly actualValue: number;
}

export interface RiskEvaluationResult {
  readonly decision: RiskEvaluationDecision;
  readonly approved: boolean;
  readonly proposalWorstCaseLoss: number;
  readonly reasons: readonly RiskRejectionReasonCode[];
  readonly breaches: readonly RiskLimitBreach[];
}

export interface ComputeMaxQuantityInput {
  readonly marketId: string;
  readonly eventFamilyId: string;
  readonly eventId?: string;
  readonly side: ShadowOrderSide;
  readonly price: number;
  readonly feePerContract: number;
  readonly modelProbability: number;
}

export type MaxQuantityConstraintName =
  | 'SYSTEM_STATE'
  | 'DAILY_LOSS_STOP'
  | 'DRAWDOWN_STOP'
  | 'KELLY'
  | 'POSITION_CAP'
  | 'EVENT_RISK_CAP'
  | 'CORRELATED_CAP'
  | 'DEPLOYED_CAP'
  | 'DEGRADED_HALF';

export interface MaxQuantityBreakdown {
  readonly maxQuantity: number;
  readonly rawMaxQuantity: number;
  readonly degradedHalved: boolean;
  readonly effectiveWinProbability: number;
  readonly kellyFraction: number;
  readonly kellyStakeUsd: number;
  readonly kellyQuantity: number;
  readonly positionCapQuantity: number;
  readonly eventCapQuantity: number;
  readonly correlatedCapQuantity: number;
  readonly deployedCapQuantity: number;
  readonly bindingConstraint: MaxQuantityConstraintName;
}
