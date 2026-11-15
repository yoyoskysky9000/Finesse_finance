import crypto from 'node:crypto';
import {
  type ActiveRiskPosition,
  type CandidateRiskOrder,
  type CorrelationMatrix,
  type PortfolioCorrelationGuardResult,
  evaluatePortfolioCorrelationAndCap,
} from '../risk/PortfolioCorrelationGuard';

export const LEAD_LAG_CHAMPION_VERSION = '2.7.0-LEAD-LAG-LIVE-CHAMPION' as const;
export const PORTFOLIO_GUARD_ENVELOPE_VERSION = '2.6.0-PORTFOLIO-GUARD-CHAMPION' as const;

export type LeadLagTriggerId = 'SVB-60' | 'GKX-5' | 'XVD';

export interface Champion260EnvelopeInput {
  symbol: string;
  side: 'BUY_YES' | 'BUY_NO';
  chop14: number;
  adx14: number;
  lhs: number;
  ask: number;
  atrDollar?: number;
  settledCashUsd: number;
  requestedNotionalUsd?: number;
  activePositions?: ActiveRiskPosition[];
  correlationMatrix?: CorrelationMatrix;
  timestampMs?: number;
}

export interface Champion260EnvelopeValidation {
  passed: boolean;
  envelopeVersion: typeof PORTFOLIO_GUARD_ENVELOPE_VERSION;
  chop14Passed: boolean;
  adx14Passed: boolean;
  lhsPassed: boolean;
  askBandPassed: boolean;
  settledCashCapFraction: number;
  maxSettledCashNotionalUsd: number;
  approvedNotionalUsd: number;
  approvedContracts: number;
  idempotencyBucketSeconds: 900;
  timeBucket: number;
  idempotencyKey: string;
  portfolioGuardDecision: PortfolioCorrelationGuardResult;
  blockedReasons: string[];
}

/**
 * Trigger 1: SVB-60 (60s Spot Velocity Burst)
 * - |z_v| >= 2.75 over 2 consecutive 5s checks
 * - Dual-venue spot confirmation: |S_coinbase - S_kraken| <= $15
 * - Kalshi ask move <= $0.01 within 10s
 * - FV - ask >= $0.18
 * - Window minutes [4.5, 13.5]
 * - Stale-feed breaker: spot > 1000ms, kalshi > 1500ms, skew > 200ms
 */
export interface Svb60TriggerInput {
  /** Velocity z-scores sampled at consecutive 5s intervals (at least 2 recent checks required) */
  zVelocityChecks5s: number[];
  /** Coinbase BTC-USD spot price ($) */
  coinbaseSpotUsd: number;
  /** Kraken BTC-USD spot price ($) */
  krakenSpotUsd: number;
  /** Absolute or signed Kalshi ask change over the trailing 10 seconds ($) */
  kalshiAskMove10sDollars: number;
  /** Spot-implied fair probability FV in [0, 1] */
  fairValueProb: number;
  /** Live Kalshi contract ask price in dollars [0.01, 0.99] */
  kalshiAskDollars: number;
  /** Minutes remaining until 15m contract settlement */
  minutesRemaining: number;
  /** Spot feed telemetry latency (ms) */
  spotLatencyMs: number;
  /** Kalshi CLOB feed telemetry latency (ms) */
  kalshiLatencyMs: number;
  /** Inter-venue Coinbase/Kraken clock skew (ms) */
  interVenueSkewMs: number;
}

export interface Svb60EvaluationResult {
  triggerId: 'SVB-60';
  triggered: boolean;
  staleFeedBreakerTripped: boolean;
  staleReasons: string[];
  consecutiveZVelocityPassed: boolean;
  latestZVelocity: number;
  previousZVelocity: number;
  direction: 'BUY_YES' | 'BUY_NO';
  dualVenueSpotSpreadUsd: number;
  dualVenueSpotConfirmed: boolean;
  kalshiAskMove10sDollars: number;
  kalshiAskMovePassed: boolean;
  fvMinusAskDollars: number;
  fvEdgePassed: boolean;
  windowMinutesPassed: boolean;
  settledCashCapFraction: 0.03;
  blockedReasons: string[];
  rationale: string;
}

/**
 * Trigger 2: GKX-5 (5m Garman-Klass Volatility Expansion)
 * - R_GK >= 1.60 vs 30d time-of-day median
 * - z_v5 >= 2.0 (|z_v5| >= 2.0) with stable sign across the candle
 * - delta_FV_proj >= $0.24
 * - FV - ask >= $0.18
 * - Stale-feed breaker: candle_finalization > 2000ms, kalshi > 1500ms
 * - Tightens SL to -$0.03 if z_v5 sign flips in minute 1
 */
export interface Gkx5TriggerInput {
  /** Current 5m Garman-Klass volatility or pre-computed R_GK ratio */
  rGkRatio?: number;
  /** Optional 5m OHLC candle to compute Garman-Klass volatility directly */
  candle5m?: {
    open: number;
    high: number;
    low: number;
    close: number;
  };
  /** 30d time-of-day median Garman-Klass volatility (used when candle5m is provided) */
  median30dTimeOfDayGk?: number;
  /** 5m velocity z-score (z_v5) */
  zVelocity5m: number;
  /** Intra-candle velocity z-score samples or explicit sign stability flag across the 5m candle */
  intraCandleVelocitySigns?: number[];
  velocitySignStableAcrossCandle?: boolean;
  /** Projected fair-value change over the expansion impulse ($) */
  deltaFvProjDollars: number;
  /** Spot-implied fair value probability FV in [0, 1] */
  fairValueProb: number;
  /** Live Kalshi contract ask price in dollars [0.01, 0.99] */
  kalshiAskDollars: number;
  /** 5m candle finalization latency (ms) */
  candleFinalizationLatencyMs: number;
  /** Kalshi CLOB feed latency (ms) */
  kalshiLatencyMs: number;
  /** Optional minute-1 post-entry velocity z-score to evaluate immediate -$0.03 SL tightening */
  minute1ZVelocity5m?: number;
  /** Optional entry price in dollars for computing tightened stop price */
  entryPriceDollars?: number;
}

export interface Gkx5StopTighteningResult {
  signFlippedInMinute1: boolean;
  entryZVelocitySign: number;
  minute1ZVelocitySign: number;
  tightenedStopLossDeltaDollars: number;
  effectiveStopLossPriceDollars: number;
  rationale: string;
}

export interface Gkx5EvaluationResult {
  triggerId: 'GKX-5';
  triggered: boolean;
  staleFeedBreakerTripped: boolean;
  staleReasons: string[];
  rGkRatio: number;
  rGkPassed: boolean;
  zVelocity5m: number;
  zVelocity5mPassed: boolean;
  signStableAcrossCandle: boolean;
  direction: 'BUY_YES' | 'BUY_NO';
  deltaFvProjDollars: number;
  deltaFvProjPassed: boolean;
  fvMinusAskDollars: number;
  fvEdgePassed: boolean;
  settledCashCapFraction: 0.03;
  stopLossDeltaDollars: number;
  minute1StopTightening: Gkx5StopTighteningResult;
  blockedReasons: string[];
  rationale: string;
}

/**
 * Trigger 3: XVD (Cross-Venue Divergence — Kalshi vs Polymarket)
 * - |P_Kalshi - P_Polymarket| >= $0.10 for >= 3s across >= 3 snapshots on identical-settlement-source contracts
 * - Spot FV within $0.03 of leading venue
 * - FV - ask_lag >= $0.18
 * - Sized at half-cap (1.5% settled cash)
 * - Stale-feed breaker: any_feed > 1000ms, inter_venue_skew > 500ms
 */
export interface XvdDivergenceSnapshot {
  timestampMs: number;
  kalshiProb: number;
  polymarketProb: number;
}

export interface XvdTriggerInput {
  /** Trailing cross-venue probability snapshots (requires >= 3 snapshots spanning >= 3000ms) */
  snapshots: XvdDivergenceSnapshot[];
  /** Optional explicit persistence duration in milliseconds (if omitted, computed from snapshots span) */
  persistenceDurationMs?: number;
  /** Must be true: verifies both contracts settle on the identical underlying reference oracle/source */
  identicalSettlementSource: boolean;
  /** Spot-implied fair value probability FV in [0, 1] */
  spotFairValueProb: number;
  /** Leading venue mid/implied probability in [0, 1] (if omitted, inferred from latest snapshot closer to spotFairValueProb) */
  leadingVenueProb?: number;
  /** Lagging venue executable ask price in dollars [0.01, 0.99] */
  laggingVenueAskDollars: number;
  /** Individual feed latencies (ms): any feed > 1000ms trips breaker */
  kalshiLatencyMs: number;
  polymarketLatencyMs: number;
  spotLatencyMs: number;
  /** Max inter-venue timestamp skew across Kalshi, Polymarket, and Spot (ms): > 500ms trips breaker */
  interVenueSkewMs: number;
}

export interface XvdEvaluationResult {
  triggerId: 'XVD';
  triggered: boolean;
  staleFeedBreakerTripped: boolean;
  staleReasons: string[];
  identicalSettlementSource: boolean;
  snapshotCount: number;
  persistenceDurationMs: number;
  minObservedDivergenceDollars: number;
  latestDivergenceDollars: number;
  divergencePersistencePassed: boolean;
  spotToLeadingVenueGapDollars: number;
  spotConfirmsLeadingVenue: boolean;
  fvMinusLaggingAskDollars: number;
  fvEdgePassed: boolean;
  settledCashCapFraction: 0.015;
  direction: 'BUY_YES' | 'BUY_NO';
  blockedReasons: string[];
  rationale: string;
}

export interface LeadLagCombinedEvaluationInput {
  envelope: Champion260EnvelopeInput;
  svb60?: Svb60TriggerInput;
  gkx5?: Gkx5TriggerInput;
  xvd?: XvdTriggerInput;
}

export interface LeadLagCombinedEvaluationResult {
  version: typeof LEAD_LAG_CHAMPION_VERSION;
  envelopeVersion: typeof PORTFOLIO_GUARD_ENVELOPE_VERSION;
  triggered: boolean;
  activeTriggerId: LeadLagTriggerId | null;
  triggeredIds: LeadLagTriggerId[];
  settledCashCapFraction: number;
  approvedNotionalUsd: number;
  approvedContracts: number;
  idempotencyKey: string;
  timeBucket900s: number;
  envelopeEvaluation: Champion260EnvelopeValidation;
  svb60Result?: Svb60EvaluationResult;
  gkx5Result?: Gkx5EvaluationResult;
  xvdResult?: XvdEvaluationResult;
  rationale: string;
}

export const LEAD_LAG_DEFAULT_CONFIG = {
  version: LEAD_LAG_CHAMPION_VERSION,
  envelope: PORTFOLIO_GUARD_ENVELOPE_VERSION,
  envelopeGates: {
    maxChop14: 50.0,
    minAdx14: 25.0,
    minLhs: 0.65,
    askGateMin: 0.52,
    askGateMax: 0.74,
    idempotencyBucketSeconds: 900 as const,
    defaultSettledCashCapFraction: 0.03,
  },
  svb60: {
    minAbsZVelocity: 2.75,
    minConsecutive5sChecks: 2,
    maxDualVenueSpotSpreadUsd: 15.0,
    maxKalshiAskMove10sDollars: 0.01,
    minFvMinusAskDollars: 0.18,
    windowMinutesMin: 4.5,
    windowMinutesMax: 13.5,
    maxSpotLatencyMs: 1000,
    maxKalshiLatencyMs: 1500,
    maxInterVenueSkewMs: 200,
    settledCashCapFraction: 0.03 as const,
  },
  gkx5: {
    minRGkRatio: 1.60,
    minAbsZVelocity5m: 2.0,
    requireStableSignAcrossCandle: true,
    minDeltaFvProjDollars: 0.24,
    minFvMinusAskDollars: 0.18,
    maxCandleFinalizationLatencyMs: 2000,
    maxKalshiLatencyMs: 1500,
    minute1FlipTightenedStopDollars: -0.03,
    defaultStopDollars: -0.12,
    settledCashCapFraction: 0.03 as const,
  },
  xvd: {
    minCrossVenueDivergenceDollars: 0.10,
    minPersistenceDurationMs: 3000,
    minSnapshotsRequired: 3,
    requireIdenticalSettlementSource: true,
    maxSpotToLeadingVenueDollars: 0.03,
    minFvMinusLagAskDollars: 0.18,
    settledCashCapFraction: 0.015 as const,
    maxAnyFeedLatencyMs: 1000,
    maxInterVenueSkewMs: 500,
  },
} as const;

/**
 * Computes deterministic 900s idempotency key for a Lead-Lag trigger:
 * SHA-256(symbol + ":" + side + ":" + triggerId + ":" + floor(timestampSec / 900))
 */
export function buildLeadLag900sIdempotencyKey(
  symbol: string,
  side: 'BUY_YES' | 'BUY_NO',
  triggerId: LeadLagTriggerId | string,
  timestampMs: number = Date.now(),
): { idempotencyKey: string; timeBucket: number } {
  const cleanSymbol = symbol.trim().toUpperCase();
  const timestampSec = Math.floor(timestampMs / 1000);
  const timeBucket = Math.floor(timestampSec / 900);
  const rawSeed = `${cleanSymbol}:${side}:${triggerId}:${timeBucket}`;
  const idempotencyKey = crypto.createHash('sha256').update(rawSeed).digest('hex');
  return { idempotencyKey, timeBucket };
}

/**
 * Computes 5m Garman-Klass volatility estimator:
 * sigma_GK = sqrt(0.5 * (ln(H/L))^2 - (2*ln(2) - 1) * (ln(C/O))^2)
 */
export function computeGarmanKlassVolatility(candle: {
  open: number;
  high: number;
  low: number;
  close: number;
}): number {
  const o = Math.max(1e-8, candle.open);
  const h = Math.max(o, candle.high);
  const l = Math.max(1e-8, Math.min(o, candle.low));
  const c = Math.max(1e-8, candle.close);
  const hlLog = Math.log(h / l);
  const coLog = Math.log(c / o);
  const variance = Math.max(0, 0.5 * hlLog * hlLog - (2 * Math.LN2 - 1) * coLog * coLog);
  return Math.sqrt(variance);
}

/**
 * Validates the `2.6.0-PORTFOLIO-GUARD-CHAMPION` envelope:
 * - CHOP(14) < 50
 * - ADX(14) >= 25
 * - LHS >= 0.65
 * - ask in [0.52, 0.74]
 * - 900s idempotency bucket
 * - 3% settled-cash cap (or 1.5% half-cap when XVD is active) + PortfolioCorrelationGuard
 */
export function evaluateChampion260Envelope(
  input: Champion260EnvelopeInput,
  settledCashCapFraction: number = 0.03,
  triggerIdForIdempotency: LeadLagTriggerId | string = 'SVB-60',
): Champion260EnvelopeValidation {
  const blockedReasons: string[] = [];
  const chop14Passed = Number.isFinite(input.chop14) && input.chop14 < 50.0;
  if (!chop14Passed) {
    blockedReasons.push(`CHOP14_GATE_FAILED: CHOP(14)=${input.chop14.toFixed(2)} >= 50.0`);
  }

  const adx14Passed = Number.isFinite(input.adx14) && input.adx14 >= 25.0;
  if (!adx14Passed) {
    blockedReasons.push(`ADX14_GATE_FAILED: ADX(14)=${input.adx14.toFixed(2)} < 25.0`);
  }

  const lhsPassed = Number.isFinite(input.lhs) && input.lhs >= 0.65;
  if (!lhsPassed) {
    blockedReasons.push(`LHS_GATE_FAILED: LHS=${input.lhs.toFixed(3)} < 0.65`);
  }

  const askBandPassed = Number.isFinite(input.ask) && input.ask >= 0.52 && input.ask <= 0.74;
  if (!askBandPassed) {
    blockedReasons.push(`ASK_GATE_FAILED: ask=$${input.ask.toFixed(2)} outside [0.52, 0.74]`);
  }

  const effectiveCapFraction = Math.max(0, Math.min(0.03, settledCashCapFraction));
  const safeSettledCash = Number.isFinite(input.settledCashUsd) && input.settledCashUsd > 0 ? input.settledCashUsd : 0;
  const maxSettledCashNotionalUsd = Number((safeSettledCash * effectiveCapFraction).toFixed(4));
  const requestedNotional =
    input.requestedNotionalUsd !== undefined && Number.isFinite(input.requestedNotionalUsd)
      ? Math.min(input.requestedNotionalUsd, maxSettledCashNotionalUsd)
      : maxSettledCashNotionalUsd;

  const candidate: CandidateRiskOrder = {
    symbol: input.symbol.trim().toUpperCase(),
    requestedNotionalUsd: requestedNotional,
    ask: input.ask,
    atrDollar: input.atrDollar ?? 0.0778,
  };

  const portfolioGuardDecision = evaluatePortfolioCorrelationAndCap({
    settledCash: safeSettledCash,
    activePositions: input.activePositions ?? [],
    candidate,
    correlationMatrix: input.correlationMatrix ?? {},
  });

  if (!portfolioGuardDecision.allowed) {
    blockedReasons.push(`PORTFOLIO_GUARD_BLOCKED: ${portfolioGuardDecision.reason}`);
  }

  const { idempotencyKey, timeBucket } = buildLeadLag900sIdempotencyKey(
    input.symbol,
    input.side,
    triggerIdForIdempotency,
    input.timestampMs ?? Date.now(),
  );

  const passed =
    chop14Passed &&
    adx14Passed &&
    lhsPassed &&
    askBandPassed &&
    portfolioGuardDecision.allowed &&
    portfolioGuardDecision.approvedContracts >= 1;

  return {
    passed,
    envelopeVersion: PORTFOLIO_GUARD_ENVELOPE_VERSION,
    chop14Passed,
    adx14Passed,
    lhsPassed,
    askBandPassed,
    settledCashCapFraction: effectiveCapFraction,
    maxSettledCashNotionalUsd,
    approvedNotionalUsd: passed ? portfolioGuardDecision.approvedNotionalUsd : 0,
    approvedContracts: passed ? portfolioGuardDecision.approvedContracts : 0,
    idempotencyBucketSeconds: 900,
    timeBucket,
    idempotencyKey,
    portfolioGuardDecision,
    blockedReasons,
  };
}

/**
 * Evaluates Trigger 1: `SVB-60` (60s Spot Velocity Burst)
 */
export function evaluateSvb60Trigger(input: Svb60TriggerInput): Svb60EvaluationResult {
  const staleReasons: string[] = [];
  const blockedReasons: string[] = [];

  if (!Number.isFinite(input.spotLatencyMs) || input.spotLatencyMs > 1000) {
    staleReasons.push(`SVB60_STALE_SPOT: spotLatencyMs=${input.spotLatencyMs}ms > 1000ms`);
  }
  if (!Number.isFinite(input.kalshiLatencyMs) || input.kalshiLatencyMs > 1500) {
    staleReasons.push(`SVB60_STALE_KALSHI: kalshiLatencyMs=${input.kalshiLatencyMs}ms > 1500ms`);
  }
  if (!Number.isFinite(input.interVenueSkewMs) || Math.abs(input.interVenueSkewMs) > 200) {
    staleReasons.push(`SVB60_CLOCK_SKEW: interVenueSkewMs=${input.interVenueSkewMs}ms > 200ms`);
  }
  const staleFeedBreakerTripped = staleReasons.length > 0;
  if (staleFeedBreakerTripped) {
    blockedReasons.push(...staleReasons);
  }

  const checks = Array.isArray(input.zVelocityChecks5s) ? input.zVelocityChecks5s : [];
  const latestZVelocity = checks.length >= 1 ? checks[checks.length - 1] : 0;
  const previousZVelocity = checks.length >= 2 ? checks[checks.length - 2] : 0;
  const sameSign = Math.sign(latestZVelocity) !== 0 && Math.sign(latestZVelocity) === Math.sign(previousZVelocity);
  const consecutiveZVelocityPassed =
    checks.length >= 2 &&
    sameSign &&
    Math.abs(latestZVelocity) >= 2.75 &&
    Math.abs(previousZVelocity) >= 2.75;

  if (!consecutiveZVelocityPassed) {
    blockedReasons.push(
      `SVB60_Z_VELOCITY_BELOW_THRESHOLD: checks=[${previousZVelocity.toFixed(2)}, ${latestZVelocity.toFixed(2)}] requires |z_v| >= 2.75 over 2 consecutive 5s checks`,
    );
  }

  const dualVenueSpotSpreadUsd = Math.abs(input.coinbaseSpotUsd - input.krakenSpotUsd);
  const dualVenueSpotConfirmed =
    Number.isFinite(dualVenueSpotSpreadUsd) &&
    input.coinbaseSpotUsd > 0 &&
    input.krakenSpotUsd > 0 &&
    dualVenueSpotSpreadUsd <= 15.0;
  if (!dualVenueSpotConfirmed) {
    blockedReasons.push(
      `SVB60_DUAL_VENUE_DIVERGENCE: |S_coinbase - S_kraken|=$${dualVenueSpotSpreadUsd.toFixed(2)} > $15.00`,
    );
  }

  const absKalshiMove = Math.abs(input.kalshiAskMove10sDollars);
  const kalshiAskMovePassed = Number.isFinite(absKalshiMove) && absKalshiMove <= 0.01 + 1e-9;
  if (!kalshiAskMovePassed) {
    blockedReasons.push(
      `SVB60_KALSHI_ALREADY_REPRICED: kalshiAskMove10s=$${absKalshiMove.toFixed(3)} > $0.01`,
    );
  }

  const fvMinusAskDollars = Number((input.fairValueProb - input.kalshiAskDollars).toFixed(4));
  const fvEdgePassed = Number.isFinite(fvMinusAskDollars) && fvMinusAskDollars >= 0.18 - 1e-9;
  if (!fvEdgePassed) {
    blockedReasons.push(
      `SVB60_INSUFFICIENT_FV_EDGE: FV - ask = $${fvMinusAskDollars.toFixed(3)} < $0.18`,
    );
  }

  const windowMinutesPassed =
    Number.isFinite(input.minutesRemaining) &&
    input.minutesRemaining >= 4.5 &&
    input.minutesRemaining <= 13.5;
  if (!windowMinutesPassed) {
    blockedReasons.push(
      `SVB60_OUTSIDE_TIME_WINDOW: minutesRemaining=${input.minutesRemaining.toFixed(2)}m outside [4.5, 13.5]`,
    );
  }

  const direction: 'BUY_YES' | 'BUY_NO' = latestZVelocity >= 0 ? 'BUY_YES' : 'BUY_NO';
  const triggered =
    !staleFeedBreakerTripped &&
    consecutiveZVelocityPassed &&
    dualVenueSpotConfirmed &&
    kalshiAskMovePassed &&
    fvEdgePassed &&
    windowMinutesPassed;

  return {
    triggerId: 'SVB-60',
    triggered,
    staleFeedBreakerTripped,
    staleReasons,
    consecutiveZVelocityPassed,
    latestZVelocity,
    previousZVelocity,
    direction,
    dualVenueSpotSpreadUsd: Number(dualVenueSpotSpreadUsd.toFixed(2)),
    dualVenueSpotConfirmed,
    kalshiAskMove10sDollars: absKalshiMove,
    kalshiAskMovePassed,
    fvMinusAskDollars,
    fvEdgePassed,
    windowMinutesPassed,
    settledCashCapFraction: 0.03,
    blockedReasons,
    rationale: triggered
      ? `SVB-60 FIRED (${direction}): z_v=[${previousZVelocity.toFixed(2)}, ${latestZVelocity.toFixed(2)}]>=2.75, |CB-Kraken|=$${dualVenueSpotSpreadUsd.toFixed(2)}<=$15, askMove=$${absKalshiMove.toFixed(3)}<=$0.01, FV-ask=$${fvMinusAskDollars.toFixed(2)}>=$0.18.`
      : `SVB-60 HOLD: ${blockedReasons.join('; ')}`,
  };
}

/**
 * Evaluates minute-1 stop-loss tightening for `GKX-5`:
 * Tightens SL to -$0.03 if `z_v5` sign flips in minute 1.
 */
export function evaluateGkx5Minute1StopTightening(
  entryZVelocity5m: number,
  minute1ZVelocity5m?: number,
  entryPriceDollars: number = 0.60,
  defaultStopDeltaDollars: number = -0.12,
): Gkx5StopTighteningResult {
  const entrySign = Math.sign(entryZVelocity5m);
  const minute1Sign =
    minute1ZVelocity5m !== undefined && Number.isFinite(minute1ZVelocity5m)
      ? Math.sign(minute1ZVelocity5m)
      : entrySign;
  const signFlippedInMinute1 =
    entrySign !== 0 && minute1Sign !== 0 && minute1Sign !== entrySign;
  const tightenedStopLossDeltaDollars = signFlippedInMinute1 ? -0.03 : defaultStopDeltaDollars;
  const effectiveStopLossPriceDollars = Number(
    Math.max(0.01, entryPriceDollars + tightenedStopLossDeltaDollars).toFixed(4),
  );

  return {
    signFlippedInMinute1,
    entryZVelocitySign: entrySign,
    minute1ZVelocitySign: minute1Sign,
    tightenedStopLossDeltaDollars,
    effectiveStopLossPriceDollars,
    rationale: signFlippedInMinute1
      ? `GKX-5 MINUTE-1 SIGN FLIP DETECTED (entrySign=${entrySign}, min1Sign=${minute1Sign}): SL tightened to -$0.03 ($${effectiveStopLossPriceDollars.toFixed(2)}).`
      : `GKX-5 z_v5 sign stable in minute 1; standard SL delta $${tightenedStopLossDeltaDollars.toFixed(2)} ($${effectiveStopLossPriceDollars.toFixed(2)}).`,
  };
}

/**
 * Evaluates Trigger 2: `GKX-5` (5m Garman-Klass Expansion)
 */
export function evaluateGkx5Trigger(input: Gkx5TriggerInput): Gkx5EvaluationResult {
  const staleReasons: string[] = [];
  const blockedReasons: string[] = [];

  if (!Number.isFinite(input.candleFinalizationLatencyMs) || input.candleFinalizationLatencyMs > 2000) {
    staleReasons.push(
      `GKX5_STALE_CANDLE_FINALIZATION: candleFinalizationLatencyMs=${input.candleFinalizationLatencyMs}ms > 2000ms`,
    );
  }
  if (!Number.isFinite(input.kalshiLatencyMs) || input.kalshiLatencyMs > 1500) {
    staleReasons.push(`GKX5_STALE_KALSHI: kalshiLatencyMs=${input.kalshiLatencyMs}ms > 1500ms`);
  }
  const staleFeedBreakerTripped = staleReasons.length > 0;
  if (staleFeedBreakerTripped) {
    blockedReasons.push(...staleReasons);
  }

  let resolvedRGk = input.rGkRatio ?? 0;
  if (
    (input.rGkRatio === undefined || !Number.isFinite(input.rGkRatio)) &&
    input.candle5m &&
    input.median30dTimeOfDayGk &&
    input.median30dTimeOfDayGk > 0
  ) {
    const gkVol = computeGarmanKlassVolatility(input.candle5m);
    resolvedRGk = gkVol / input.median30dTimeOfDayGk;
  }

  const rGkPassed = Number.isFinite(resolvedRGk) && resolvedRGk >= 1.60 - 1e-9;
  if (!rGkPassed) {
    blockedReasons.push(`GKX5_RGK_BELOW_THRESHOLD: R_GK=${resolvedRGk.toFixed(2)} < 1.60`);
  }

  const zVelocity5mPassed = Number.isFinite(input.zVelocity5m) && Math.abs(input.zVelocity5m) >= 2.0 - 1e-9;
  if (!zVelocity5mPassed) {
    blockedReasons.push(`GKX5_Z_V5_BELOW_THRESHOLD: |z_v5|=${Math.abs(input.zVelocity5m).toFixed(2)} < 2.00`);
  }

  const targetSign = Math.sign(input.zVelocity5m);
  let signStableAcrossCandle = input.velocitySignStableAcrossCandle ?? true;
  if (Array.isArray(input.intraCandleVelocitySigns) && input.intraCandleVelocitySigns.length > 0) {
    signStableAcrossCandle =
      targetSign !== 0 &&
      input.intraCandleVelocitySigns.every((v) => Math.sign(v) === targetSign);
  }
  if (!signStableAcrossCandle) {
    blockedReasons.push('GKX5_UNSTABLE_VELOCITY_SIGN: z_v5 sign flipped across 5m candle');
  }

  const deltaFvProjPassed =
    Number.isFinite(input.deltaFvProjDollars) && input.deltaFvProjDollars >= 0.24 - 1e-9;
  if (!deltaFvProjPassed) {
    blockedReasons.push(
      `GKX5_DELTA_FV_PROJ_LOW: delta_FV_proj=$${input.deltaFvProjDollars.toFixed(3)} < $0.24`,
    );
  }

  const fvMinusAskDollars = Number((input.fairValueProb - input.kalshiAskDollars).toFixed(4));
  const fvEdgePassed = Number.isFinite(fvMinusAskDollars) && fvMinusAskDollars >= 0.18 - 1e-9;
  if (!fvEdgePassed) {
    blockedReasons.push(`GKX5_INSUFFICIENT_FV_EDGE: FV - ask = $${fvMinusAskDollars.toFixed(3)} < $0.18`);
  }

  const minute1StopTightening = evaluateGkx5Minute1StopTightening(
    input.zVelocity5m,
    input.minute1ZVelocity5m,
    input.entryPriceDollars ?? input.kalshiAskDollars,
  );

  const direction: 'BUY_YES' | 'BUY_NO' = input.zVelocity5m >= 0 ? 'BUY_YES' : 'BUY_NO';
  const triggered =
    !staleFeedBreakerTripped &&
    rGkPassed &&
    zVelocity5mPassed &&
    signStableAcrossCandle &&
    deltaFvProjPassed &&
    fvEdgePassed;

  return {
    triggerId: 'GKX-5',
    triggered,
    staleFeedBreakerTripped,
    staleReasons,
    rGkRatio: Number(resolvedRGk.toFixed(4)),
    rGkPassed,
    zVelocity5m: input.zVelocity5m,
    zVelocity5mPassed,
    signStableAcrossCandle,
    direction,
    deltaFvProjDollars: input.deltaFvProjDollars,
    deltaFvProjPassed,
    fvMinusAskDollars,
    fvEdgePassed,
    settledCashCapFraction: 0.03,
    stopLossDeltaDollars: minute1StopTightening.tightenedStopLossDeltaDollars,
    minute1StopTightening,
    blockedReasons,
    rationale: triggered
      ? `GKX-5 FIRED (${direction}): R_GK=${resolvedRGk.toFixed(2)}>=1.60, z_v5=${input.zVelocity5m.toFixed(2)} (stable sign), deltaFV=$${input.deltaFvProjDollars.toFixed(2)}>=$0.24, FV-ask=$${fvMinusAskDollars.toFixed(2)}>=$0.18, SL=${minute1StopTightening.tightenedStopLossDeltaDollars.toFixed(2)}.`
      : `GKX-5 HOLD: ${blockedReasons.join('; ')}`,
  };
}

/**
 * Evaluates Trigger 3: `XVD` (Cross-Venue Divergence — Kalshi vs Polymarket)
 */
export function evaluateXvdTrigger(input: XvdTriggerInput): XvdEvaluationResult {
  const staleReasons: string[] = [];
  const blockedReasons: string[] = [];

  const maxFeedLatencyMs = Math.max(
    input.kalshiLatencyMs,
    input.polymarketLatencyMs,
    input.spotLatencyMs,
  );
  if (
    !Number.isFinite(input.kalshiLatencyMs) ||
    !Number.isFinite(input.polymarketLatencyMs) ||
    !Number.isFinite(input.spotLatencyMs) ||
    maxFeedLatencyMs > 1000
  ) {
    staleReasons.push(`XVD_STALE_FEED: maxFeedLatencyMs=${maxFeedLatencyMs}ms > 1000ms`);
  }
  if (!Number.isFinite(input.interVenueSkewMs) || Math.abs(input.interVenueSkewMs) > 500) {
    staleReasons.push(`XVD_INTER_VENUE_SKEW: interVenueSkewMs=${input.interVenueSkewMs}ms > 500ms`);
  }
  const staleFeedBreakerTripped = staleReasons.length > 0;
  if (staleFeedBreakerTripped) {
    blockedReasons.push(...staleReasons);
  }

  if (!input.identicalSettlementSource) {
    blockedReasons.push('XVD_SETTLEMENT_SOURCE_MISMATCH: contracts do not share identical settlement source');
  }

  const snaps = Array.isArray(input.snapshots) ? input.snapshots : [];
  const snapshotCount = snaps.length;
  const computedSpanMs =
    snapshotCount >= 2
      ? Math.max(0, snaps[snapshotCount - 1].timestampMs - snaps[0].timestampMs)
      : 0;
  const persistenceDurationMs =
    input.persistenceDurationMs !== undefined && Number.isFinite(input.persistenceDurationMs)
      ? input.persistenceDurationMs
      : computedSpanMs;

  const divergences = snaps.map((s) => Math.abs(s.kalshiProb - s.polymarketProb));
  const minObservedDivergenceDollars =
    divergences.length > 0 ? Number(Math.min(...divergences).toFixed(4)) : 0;
  const latestDivergenceDollars =
    divergences.length > 0 ? Number(divergences[divergences.length - 1].toFixed(4)) : 0;

  const allSnapshotsAbove10Cents =
    snapshotCount >= 3 && divergences.every((d) => d >= 0.10 - 1e-9);
  const durationAbove3s = persistenceDurationMs >= 3000;
  const divergencePersistencePassed = allSnapshotsAbove10Cents && durationAbove3s;

  if (!divergencePersistencePassed) {
    blockedReasons.push(
      `XVD_DIVERGENCE_NOT_PERSISTENT: snapshots=${snapshotCount} (req >=3), duration=${persistenceDurationMs}ms (req >=3000ms), minDiv=$${minObservedDivergenceDollars.toFixed(3)} (req >=$0.10)`,
    );
  }

  const latestSnap = snapshotCount > 0 ? snaps[snapshotCount - 1] : { kalshiProb: 0.5, polymarketProb: 0.5 };
  const resolvedLeadingProb =
    input.leadingVenueProb !== undefined && Number.isFinite(input.leadingVenueProb)
      ? input.leadingVenueProb
      : Math.abs(input.spotFairValueProb - latestSnap.polymarketProb) <=
          Math.abs(input.spotFairValueProb - latestSnap.kalshiProb)
        ? latestSnap.polymarketProb
        : latestSnap.kalshiProb;

  const spotToLeadingVenueGapDollars = Number(
    Math.abs(input.spotFairValueProb - resolvedLeadingProb).toFixed(4),
  );
  const spotConfirmsLeadingVenue =
    Number.isFinite(spotToLeadingVenueGapDollars) && spotToLeadingVenueGapDollars <= 0.03 + 1e-9;
  if (!spotConfirmsLeadingVenue) {
    blockedReasons.push(
      `XVD_SPOT_LEADING_GAP_TOO_WIDE: |FV_spot - P_lead|=$${spotToLeadingVenueGapDollars.toFixed(3)} > $0.03`,
    );
  }

  const fvMinusLaggingAskDollars = Number(
    (input.spotFairValueProb - input.laggingVenueAskDollars).toFixed(4),
  );
  const fvEdgePassed = Number.isFinite(fvMinusLaggingAskDollars) && fvMinusLaggingAskDollars >= 0.18 - 1e-9;
  if (!fvEdgePassed) {
    blockedReasons.push(
      `XVD_INSUFFICIENT_LAG_EDGE: FV - ask_lag = $${fvMinusLaggingAskDollars.toFixed(3)} < $0.18`,
    );
  }

  const direction: 'BUY_YES' | 'BUY_NO' =
    resolvedLeadingProb >= input.laggingVenueAskDollars ? 'BUY_YES' : 'BUY_NO';

  const triggered =
    !staleFeedBreakerTripped &&
    input.identicalSettlementSource &&
    divergencePersistencePassed &&
    spotConfirmsLeadingVenue &&
    fvEdgePassed;

  return {
    triggerId: 'XVD',
    triggered,
    staleFeedBreakerTripped,
    staleReasons,
    identicalSettlementSource: input.identicalSettlementSource,
    snapshotCount,
    persistenceDurationMs,
    minObservedDivergenceDollars,
    latestDivergenceDollars,
    divergencePersistencePassed,
    spotToLeadingVenueGapDollars,
    spotConfirmsLeadingVenue,
    fvMinusLaggingAskDollars,
    fvEdgePassed,
    settledCashCapFraction: 0.015,
    direction,
    blockedReasons,
    rationale: triggered
      ? `XVD FIRED (${direction}, half-cap 1.5% settled cash): |P_K-P_PM|>=$${minObservedDivergenceDollars.toFixed(2)} across ${snapshotCount} snaps (${persistenceDurationMs}ms), |FV-lead|=$${spotToLeadingVenueGapDollars.toFixed(3)}<=$0.03, FV-ask_lag=$${fvMinusLaggingAskDollars.toFixed(2)}>=$0.18.`
      : `XVD HOLD: ${blockedReasons.join('; ')}`,
  };
}

/**
 * Evaluates all 3 `2.7.0-LEAD-LAG-LIVE-CHAMPION` cross-market lead-lag anomaly triggers
 * (`SVB-60`, `GKX-5`, `XVD`) inside the `2.6.0-PORTFOLIO-GUARD-CHAMPION` envelope.
 */
export function evaluateLeadLagAnomalyTriggers(
  input: LeadLagCombinedEvaluationInput,
): LeadLagCombinedEvaluationResult {
  const svb60Result = input.svb60 ? evaluateSvb60Trigger(input.svb60) : undefined;
  const gkx5Result = input.gkx5 ? evaluateGkx5Trigger(input.gkx5) : undefined;
  const xvdResult = input.xvd ? evaluateXvdTrigger(input.xvd) : undefined;

  const triggeredIds: LeadLagTriggerId[] = [];
  if (svb60Result?.triggered) triggeredIds.push('SVB-60');
  if (gkx5Result?.triggered) triggeredIds.push('GKX-5');
  if (xvdResult?.triggered) triggeredIds.push('XVD');

  const activeTriggerId: LeadLagTriggerId | null = triggeredIds.length > 0 ? triggeredIds[0] : null;
  const settledCashCapFraction = activeTriggerId === 'XVD' ? 0.015 : 0.03;

  const envelopeEvaluation = evaluateChampion260Envelope(
    input.envelope,
    settledCashCapFraction,
    activeTriggerId ?? 'SVB-60',
  );

  const triggered = activeTriggerId !== null && envelopeEvaluation.passed;

  return {
    version: LEAD_LAG_CHAMPION_VERSION,
    envelopeVersion: PORTFOLIO_GUARD_ENVELOPE_VERSION,
    triggered,
    activeTriggerId: triggered ? activeTriggerId : null,
    triggeredIds,
    settledCashCapFraction,
    approvedNotionalUsd: triggered ? envelopeEvaluation.approvedNotionalUsd : 0,
    approvedContracts: triggered ? envelopeEvaluation.approvedContracts : 0,
    idempotencyKey: envelopeEvaluation.idempotencyKey,
    timeBucket900s: envelopeEvaluation.timeBucket,
    envelopeEvaluation,
    svb60Result,
    gkx5Result,
    xvdResult,
    rationale: triggered
      ? `${LEAD_LAG_CHAMPION_VERSION} [${activeTriggerId}] APPROVED: ${envelopeEvaluation.approvedContracts} contracts ($${envelopeEvaluation.approvedNotionalUsd.toFixed(2)}, cap=${(settledCashCapFraction * 100).toFixed(1)}% settled cash, bucket=${envelopeEvaluation.timeBucket}).`
      : `${LEAD_LAG_CHAMPION_VERSION} HOLD: ${
          activeTriggerId === null
            ? 'No lead-lag anomaly trigger fired'
            : `Trigger ${activeTriggerId} blocked by envelope (${envelopeEvaluation.blockedReasons.join(', ')})`
        }.`,
  };
}
