import { computeKalshiOrderFeeUsd } from '../../src/strategies/kalshiFeeCalculator';
import {
  SUPPORTED_SHADOW_FEE_SCHEDULES,
  ShadowExecutionValidationError,
  UnsupportedFeeScheduleError,
  type SupportedShadowFeeSchedule,
} from './types';

export interface ShadowFeeCalculationResult {
  readonly feeUsd: number;
  readonly feeScheduleVersion: SupportedShadowFeeSchedule;
  readonly contracts: number;
  readonly fillPriceUsd: number;
}

/**
 * Computes shadow execution fee per fill using the versioned fee schedule.
 *
 * For `'kalshi-taker-v1'`, delegates to the authoritative Kalshi taker formula in
 * `src/strategies/kalshiFeeCalculator.ts`:
 *   `fee = ceil_to_cent(0.07 * contracts * price * (1 - price))`
 */
export function computeShadowFillFee(
  contracts: number,
  fillPriceUsd: number,
  feeScheduleVersion: string = 'kalshi-taker-v1'
): ShadowFeeCalculationResult {
  const version = feeScheduleVersion.trim();
  if (!SUPPORTED_SHADOW_FEE_SCHEDULES.includes(version as SupportedShadowFeeSchedule)) {
    throw new UnsupportedFeeScheduleError(feeScheduleVersion);
  }

  if (!Number.isInteger(contracts) || contracts < 0) {
    throw new ShadowExecutionValidationError(
      `Fee calculation contracts must be a non-negative integer (received ${String(contracts)}).`
    );
  }
  if (!Number.isFinite(fillPriceUsd) || fillPriceUsd < 0 || fillPriceUsd > 1) {
    throw new ShadowExecutionValidationError(
      `Fee calculation fillPriceUsd must be in [0, 1] (received ${String(fillPriceUsd)}).`
    );
  }

  if (contracts === 0 || fillPriceUsd <= 0 || fillPriceUsd >= 1) {
    return Object.freeze({
      feeUsd: 0,
      feeScheduleVersion: version as SupportedShadowFeeSchedule,
      contracts,
      fillPriceUsd,
    });
  }

  const feeUsd = computeKalshiOrderFeeUsd(contracts, fillPriceUsd, 'TAKER', 0.07);
  return Object.freeze({
    feeUsd: Number(feeUsd.toFixed(2)),
    feeScheduleVersion: version as SupportedShadowFeeSchedule,
    contracts,
    fillPriceUsd,
  });
}
