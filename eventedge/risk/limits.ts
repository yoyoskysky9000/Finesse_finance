import type { EventEdgeRiskConfig } from '../config/index';
import {
  RiskValidationError,
  TRADING_ALLOWED_RISK_STATES,
  type ComputeMaxQuantityInput,
  type MaxQuantityBreakdown,
  type MaxQuantityConstraintName,
  type PortfolioState,
  type RiskEvaluationResult,
  type RiskLimitBreach,
  type RiskProposal,
  type RiskRejectionReasonCode,
} from './types';

const CAP_EPSILON = 1e-12;

function cleanFloat(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (Math.abs(value) < 1e-12) return 0;
  return Number(value.toFixed(10));
}

function getCurrentExposures(
  state: PortfolioState,
  marketId: string,
  eventId: string,
  eventFamilyId: string
): {
  readonly marketExposure: number;
  readonly eventExposure: number;
  readonly familyExposure: number;
  readonly totalExposure: number;
} {
  const marketExposure =
    (state.exposureByMarket[marketId] ?? 0) + (state.pendingExposureByMarket[marketId] ?? 0);
  const eventExposure =
    (state.exposureByEvent[eventId] ?? 0) + (state.pendingExposureByEvent[eventId] ?? 0);
  const familyExposure =
    (state.exposureByEventFamily[eventFamilyId] ?? 0) +
    (state.pendingExposureByEventFamily[eventFamilyId] ?? 0);
  const totalExposure = state.totalOpenWorstCaseLoss + state.pendingExposure;

  return {
    marketExposure,
    eventExposure,
    familyExposure,
    totalExposure,
  };
}

/**
 * Pure, deterministic risk evaluator over a `PortfolioState`, a trade `RiskProposal`,
 * and an `EventEdgeRiskConfig` (defaults to `state.riskConfig`).
 *
 * Evaluates EVERY limit without short-circuiting so callers receive every breached
 * reason code (`POSITION_CAP`, `EVENT_RISK_CAP`, `CORRELATED_CAP`, `DEPLOYED_CAP`,
 * `DAILY_LOSS_STOP`, `DRAWDOWN_STOP`, `SYSTEM_STATE`).
 *
 * Fail-closed rule: rejects with `SYSTEM_STATE` whenever `state.systemState` is not
 * `'HEALTHY'` or `'DEGRADED'`.
 */
export function evaluateRisk(
  state: PortfolioState,
  proposal: RiskProposal,
  riskConfig: EventEdgeRiskConfig = state.riskConfig
): RiskEvaluationResult {
  if (!state || typeof state !== 'object') {
    throw new RiskValidationError('PortfolioState is required.');
  }
  if (!proposal || typeof proposal !== 'object') {
    throw new RiskValidationError('RiskProposal is required.');
  }

  const marketId = proposal.marketId?.trim() ?? '';
  const eventFamilyId = proposal.eventFamilyId?.trim() ?? '';
  const eventId = proposal.eventId?.trim() || marketId;

  if (!marketId || !eventFamilyId) {
    throw new RiskValidationError('proposal.marketId and proposal.eventFamilyId must be non-empty.');
  }
  if (proposal.side !== 'BUY_YES' && proposal.side !== 'BUY_NO') {
    throw new RiskValidationError(`Invalid proposal side "${String(proposal.side)}".`);
  }
  if (!Number.isFinite(proposal.quantity) || proposal.quantity <= 0) {
    throw new RiskValidationError(
      `proposal.quantity must be a positive finite number (received ${String(proposal.quantity)}).`
    );
  }
  if (!Number.isFinite(proposal.price) || proposal.price < 0 || proposal.price > 1) {
    throw new RiskValidationError(
      `proposal.price must be in [0, 1] (received ${String(proposal.price)}).`
    );
  }
  if (!Number.isFinite(proposal.fee) || proposal.fee < 0) {
    throw new RiskValidationError(
      `proposal.fee must be a non-negative finite number (received ${String(proposal.fee)}).`
    );
  }

  const proposalWorstCaseLoss = cleanFloat(proposal.quantity * proposal.price + proposal.fee);
  const exposures = getCurrentExposures(state, marketId, eventId, eventFamilyId);

  const breaches: RiskLimitBreach[] = [];

  // 1. Fail-closed system state check
  if (!TRADING_ALLOWED_RISK_STATES.includes(state.systemState)) {
    breaches.push(
      Object.freeze({
        code: 'SYSTEM_STATE' as const,
        message: `Trading forbidden in system state ${state.systemState} (only HEALTHY or DEGRADED allowed).`,
        limitValue: 1,
        actualValue: 0,
      })
    );
  }

  // 2. Daily loss stop check
  if (state.dailyLossPct >= riskConfig.dailyLossStopPct - CAP_EPSILON) {
    breaches.push(
      Object.freeze({
        code: 'DAILY_LOSS_STOP' as const,
        message: `Daily loss ${(state.dailyLossPct * 100).toFixed(4)}% reached/exceeded stop ${(riskConfig.dailyLossStopPct * 100).toFixed(4)}%.`,
        limitValue: riskConfig.dailyLossStopPct,
        actualValue: state.dailyLossPct,
      })
    );
  }

  // 3. Peak-to-trough drawdown stop check
  if (state.drawdownPct >= riskConfig.peakToTroughDrawdownStopPct - CAP_EPSILON) {
    breaches.push(
      Object.freeze({
        code: 'DRAWDOWN_STOP' as const,
        message: `Drawdown ${(state.drawdownPct * 100).toFixed(4)}% reached/exceeded stop ${(riskConfig.peakToTroughDrawdownStopPct * 100).toFixed(4)}%.`,
        limitValue: riskConfig.peakToTroughDrawdownStopPct,
        actualValue: state.drawdownPct,
      })
    );
  }

  // 4. Per-position settled-cash cap
  const positionCapUsd = state.settledCash * riskConfig.perPositionSettledCashCapPct;
  const projectedPositionExposure = exposures.marketExposure + proposalWorstCaseLoss;
  if (projectedPositionExposure > positionCapUsd + CAP_EPSILON) {
    breaches.push(
      Object.freeze({
        code: 'POSITION_CAP' as const,
        message: `Market ${marketId} exposure $${projectedPositionExposure.toFixed(6)} exceeds position cap $${positionCapUsd.toFixed(6)}.`,
        limitValue: cleanFloat(positionCapUsd),
        actualValue: cleanFloat(projectedPositionExposure),
      })
    );
  }

  // 5. Per-underlying-event bankroll risk cap
  const eventRiskCapUsd = state.settledCash * riskConfig.perEventBankrollRiskCapPct;
  const projectedEventExposure = exposures.eventExposure + proposalWorstCaseLoss;
  if (projectedEventExposure > eventRiskCapUsd + CAP_EPSILON) {
    breaches.push(
      Object.freeze({
        code: 'EVENT_RISK_CAP' as const,
        message: `Event ${eventId} exposure $${projectedEventExposure.toFixed(6)} exceeds event risk cap $${eventRiskCapUsd.toFixed(6)}.`,
        limitValue: cleanFloat(eventRiskCapUsd),
        actualValue: cleanFloat(projectedEventExposure),
      })
    );
  }

  // 6. Correlated event-family exposure cap
  const correlatedCapUsd = state.settledCash * riskConfig.correlatedEventExposureCapPct;
  const projectedFamilyExposure = exposures.familyExposure + proposalWorstCaseLoss;
  if (projectedFamilyExposure > correlatedCapUsd + CAP_EPSILON) {
    breaches.push(
      Object.freeze({
        code: 'CORRELATED_CAP' as const,
        message: `Event family ${eventFamilyId} exposure $${projectedFamilyExposure.toFixed(6)} exceeds correlated cap $${correlatedCapUsd.toFixed(6)}.`,
        limitValue: cleanFloat(correlatedCapUsd),
        actualValue: cleanFloat(projectedFamilyExposure),
      })
    );
  }

  // 7. Total deployed bankroll cap
  const deployedCapUsd = state.settledCash * riskConfig.maxDeployedBankrollPct;
  const projectedTotalExposure = exposures.totalExposure + proposalWorstCaseLoss;
  if (projectedTotalExposure > deployedCapUsd + CAP_EPSILON) {
    breaches.push(
      Object.freeze({
        code: 'DEPLOYED_CAP' as const,
        message: `Total deployed exposure $${projectedTotalExposure.toFixed(6)} exceeds deployed cap $${deployedCapUsd.toFixed(6)}.`,
        limitValue: cleanFloat(deployedCapUsd),
        actualValue: cleanFloat(projectedTotalExposure),
      })
    );
  }

  const reasons: readonly RiskRejectionReasonCode[] = Object.freeze(breaches.map((b) => b.code));
  const approved = breaches.length === 0;

  return Object.freeze({
    decision: approved ? ('APPROVED' as const) : ('REJECTED' as const),
    approved,
    proposalWorstCaseLoss,
    reasons,
    breaches: Object.freeze(breaches),
  });
}

/**
 * Pure, deterministic sizing breakdown returning the largest integer contract quantity
 * satisfying ALL risk caps AND fractional Kelly sizing, together with every individual
 * cap quantity and the binding constraint.
 *
 * - Binary Kelly fraction for a contract bought at `price` with win probability `p_win`:
 *   `f = (p_win - price) / (1 - price)` (where `p_win = modelProbability` for `BUY_YES`,
 *   or `1 - modelProbability` for `BUY_NO`).
 * - `stake = fractionalKelly * f * settledCash`; `kellyQuantity = floor(stake / price)`.
 * - Cap quantities account for `unitCost = price + feePerContract`.
 * - When `state.systemState === 'DEGRADED'`, the final max quantity is halved via `Math.floor(raw / 2)`.
 * - Returns `0` whenever system state forbids trading, a stop is breached, or any binding constraint is `0`.
 */
export function computeMaxQuantityBreakdown(
  state: PortfolioState,
  input: ComputeMaxQuantityInput,
  riskConfig: EventEdgeRiskConfig = state.riskConfig
): MaxQuantityBreakdown {
  if (!state || typeof state !== 'object') {
    throw new RiskValidationError('PortfolioState is required.');
  }
  if (!input || typeof input !== 'object') {
    throw new RiskValidationError('ComputeMaxQuantityInput is required.');
  }

  const marketId = input.marketId?.trim() ?? '';
  const eventFamilyId = input.eventFamilyId?.trim() ?? '';
  const eventId = input.eventId?.trim() || marketId;

  if (!marketId || !eventFamilyId) {
    throw new RiskValidationError('input.marketId and input.eventFamilyId must be non-empty.');
  }
  if (input.side !== 'BUY_YES' && input.side !== 'BUY_NO') {
    throw new RiskValidationError(`Invalid side "${String(input.side)}".`);
  }
  if (!Number.isFinite(input.price) || input.price <= 0 || input.price >= 1) {
    throw new RiskValidationError(
      `input.price must be strictly in (0, 1) (received ${String(input.price)}).`
    );
  }
  if (!Number.isFinite(input.feePerContract) || input.feePerContract < 0) {
    throw new RiskValidationError(
      `input.feePerContract must be a non-negative finite number (received ${String(input.feePerContract)}).`
    );
  }
  if (
    !Number.isFinite(input.modelProbability) ||
    input.modelProbability < 0 ||
    input.modelProbability > 1
  ) {
    throw new RiskValidationError(
      `input.modelProbability must be in [0, 1] (received ${String(input.modelProbability)}).`
    );
  }

  const effectiveWinProbability =
    input.side === 'BUY_YES' ? input.modelProbability : cleanFloat(1 - input.modelProbability);
  const rawKellyFraction = (effectiveWinProbability - input.price) / (1 - input.price);
  const kellyFraction = rawKellyFraction > 0 ? cleanFloat(rawKellyFraction) : 0;
  const kellyStakeUsd =
    kellyFraction > 0 ? cleanFloat(riskConfig.fractionalKelly * kellyFraction * state.settledCash) : 0;
  const kellyQuantity =
    kellyStakeUsd > 0 ? Math.max(0, Math.floor(kellyStakeUsd / input.price + CAP_EPSILON)) : 0;

  const exposures = getCurrentExposures(state, marketId, eventId, eventFamilyId);
  const unitCost = input.price + input.feePerContract;

  const positionRemaining = Math.max(
    0,
    state.settledCash * riskConfig.perPositionSettledCashCapPct - exposures.marketExposure
  );
  const eventRemaining = Math.max(
    0,
    state.settledCash * riskConfig.perEventBankrollRiskCapPct - exposures.eventExposure
  );
  const correlatedRemaining = Math.max(
    0,
    state.settledCash * riskConfig.correlatedEventExposureCapPct - exposures.familyExposure
  );
  const deployedRemaining = Math.max(
    0,
    state.settledCash * riskConfig.maxDeployedBankrollPct - exposures.totalExposure
  );

  const positionCapQuantity = Math.max(0, Math.floor(positionRemaining / unitCost + CAP_EPSILON));
  const eventCapQuantity = Math.max(0, Math.floor(eventRemaining / unitCost + CAP_EPSILON));
  const correlatedCapQuantity = Math.max(0, Math.floor(correlatedRemaining / unitCost + CAP_EPSILON));
  const deployedCapQuantity = Math.max(0, Math.floor(deployedRemaining / unitCost + CAP_EPSILON));

  // Hard fail-closed gates: system state & loss stops
  if (!TRADING_ALLOWED_RISK_STATES.includes(state.systemState)) {
    return Object.freeze({
      maxQuantity: 0,
      rawMaxQuantity: 0,
      degradedHalved: false,
      effectiveWinProbability,
      kellyFraction,
      kellyStakeUsd,
      kellyQuantity,
      positionCapQuantity,
      eventCapQuantity,
      correlatedCapQuantity,
      deployedCapQuantity,
      bindingConstraint: 'SYSTEM_STATE' as const,
    });
  }

  if (state.dailyLossPct >= riskConfig.dailyLossStopPct - CAP_EPSILON) {
    return Object.freeze({
      maxQuantity: 0,
      rawMaxQuantity: 0,
      degradedHalved: false,
      effectiveWinProbability,
      kellyFraction,
      kellyStakeUsd,
      kellyQuantity,
      positionCapQuantity,
      eventCapQuantity,
      correlatedCapQuantity,
      deployedCapQuantity,
      bindingConstraint: 'DAILY_LOSS_STOP' as const,
    });
  }

  if (state.drawdownPct >= riskConfig.peakToTroughDrawdownStopPct - CAP_EPSILON) {
    return Object.freeze({
      maxQuantity: 0,
      rawMaxQuantity: 0,
      degradedHalved: false,
      effectiveWinProbability,
      kellyFraction,
      kellyStakeUsd,
      kellyQuantity,
      positionCapQuantity,
      eventCapQuantity,
      correlatedCapQuantity,
      deployedCapQuantity,
      bindingConstraint: 'DRAWDOWN_STOP' as const,
    });
  }

  const candidates: ReadonlyArray<{ name: MaxQuantityConstraintName; qty: number }> = [
    { name: 'KELLY', qty: kellyQuantity },
    { name: 'POSITION_CAP', qty: positionCapQuantity },
    { name: 'EVENT_RISK_CAP', qty: eventCapQuantity },
    { name: 'CORRELATED_CAP', qty: correlatedCapQuantity },
    { name: 'DEPLOYED_CAP', qty: deployedCapQuantity },
  ];

  let binding: { name: MaxQuantityConstraintName; qty: number } = candidates[0];
  for (const candidate of candidates) {
    if (candidate.qty < binding.qty) {
      binding = candidate;
    }
  }

  const rawMaxQuantity = Math.max(0, binding.qty);
  const degradedHalved = state.systemState === 'DEGRADED';
  const maxQuantity = degradedHalved ? Math.floor(rawMaxQuantity / 2) : rawMaxQuantity;
  const bindingConstraint: MaxQuantityConstraintName =
    degradedHalved && maxQuantity < rawMaxQuantity ? 'DEGRADED_HALF' : binding.name;

  return Object.freeze({
    maxQuantity,
    rawMaxQuantity,
    degradedHalved,
    effectiveWinProbability,
    kellyFraction,
    kellyStakeUsd,
    kellyQuantity,
    positionCapQuantity,
    eventCapQuantity,
    correlatedCapQuantity,
    deployedCapQuantity,
    bindingConstraint,
  });
}

/**
 * Pure, deterministic contract-sizing function returning the largest integer quantity
 * satisfying all caps AND fractional-Kelly sizing (halved via integer floor in `DEGRADED`,
 * and `0` whenever any binding constraint is `0` or the system state forbids trading).
 */
export function computeMaxQuantity(
  state: PortfolioState,
  input: ComputeMaxQuantityInput,
  riskConfig: EventEdgeRiskConfig = state.riskConfig
): number {
  return computeMaxQuantityBreakdown(state, input, riskConfig).maxQuantity;
}
