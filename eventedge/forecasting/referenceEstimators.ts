import { isMarketPriceOrOrderbookKey } from './priceBlindGuard';
import type { BaseRateEstimator, QuantitativeEstimator, RawEstimatorOutput } from './types';

/**
 * =============================================================================
 * REFERENCE-ONLY TEST FIXTURE ESTIMATORS — NOT PRODUCTION MODELS
 * =============================================================================
 * These concrete implementations exist solely to exercise the `BaseRateEstimator`
 * and `QuantitativeEstimator` interfaces in tests and reference runs.
 * No calibration, fitting, or parameter tuning is performed.
 */

export interface ReferenceLaplaceBaseRateOptions {
  readonly id?: string;
  readonly version?: string;
  /** Normal-approximation z-multiplier for the simple Beta(a, b) uncertainty interval (default 1.96). */
  readonly zScore?: number;
}

/**
 * REFERENCE-ONLY BaseRateEstimator:
 * Computes Laplace-smoothed frequency:
 *   p = (positiveCount + 1) / (sampleCount + 2)
 * with a simple Beta(a, b) normal-approximation uncertainty interval:
 *   a = positiveCount + 1, b = (sampleCount - positiveCount) + 1
 *   se = sqrt((p * (1 - p)) / (a + b + 1))
 *   [max(0, p - z * se), min(1, p + z * se)]
 */
export function createReferenceLaplaceBaseRateEstimator(
  options: ReferenceLaplaceBaseRateOptions = {}
): BaseRateEstimator {
  const id = options.id ?? 'ref-only-laplace-base-rate';
  const version = options.version ?? 'ref-only-laplace-v1.0.0';
  const zScore = options.zScore ?? 1.96;

  return Object.freeze({
    id,
    version,
    isReferenceOnly: true as const,
    estimate({ referenceClass, minSampleCount }): RawEstimatorOutput {
      if (referenceClass.sampleCount < minSampleCount) {
        return {
          abstained: true,
          abstentionReasons: [
            {
              code: 'INSUFFICIENT_SAMPLE_SIZE',
              detail: `Sample count ${referenceClass.sampleCount} < minimum ${minSampleCount}.`,
            },
          ],
        };
      }

      const alpha = referenceClass.positiveCount + 1;
      const beta = referenceClass.sampleCount - referenceClass.positiveCount + 1;
      const probability = alpha / (alpha + beta);
      const standardError = Math.sqrt((probability * (1 - probability)) / (alpha + beta + 1));
      const lower = Math.max(0, probability - zScore * standardError);
      const upper = Math.min(1, probability + zScore * standardError);

      return {
        probability,
        uncertaintyInterval: {
          lower,
          upper,
          method: 'reference_laplace_beta_normal_95',
          confidenceLevel: 0.95,
        },
      };
    },
  });
}

export interface ReferenceFeatureTransformQuantOptions {
  readonly id?: string;
  readonly version?: string;
  /** Exact non-price feature key to read from `snapshot.features`. */
  readonly featureName: string;
  /** Fixed center constant for z = (x - center) / scale (default 0). */
  readonly center?: number;
  /** Fixed positive scale constant for z = (x - center) / scale (default 1). */
  readonly scale?: number;
  /** Documented fixed half-width for the reference uncertainty interval (default 0.10). */
  readonly intervalHalfWidth?: number;
}

/**
 * REFERENCE-ONLY QuantitativeEstimator:
 * Reads ONE named non-price feature `x` from `snapshot.features` and maps it through
 * the documented fixed logistic transform:
 *   p = 1 / (1 + exp(-(x - center) / scale))
 *
 * Abstains cleanly if the feature is missing, non-numeric, non-finite, or targets a
 * forbidden market-price / orderbook key.
 */
export function createReferenceFeatureTransformQuantEstimator(
  options: ReferenceFeatureTransformQuantOptions
): QuantitativeEstimator {
  const id = options.id ?? 'ref-only-fixed-logistic-quant';
  const version = options.version ?? 'ref-only-fixed-logistic-v1.0.0';
  const featureName = options.featureName.trim();
  const center = options.center ?? 0;
  const scale = options.scale ?? 1;
  const intervalHalfWidth = options.intervalHalfWidth ?? 0.10;

  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error(`Reference quantitative estimator scale must be finite and > 0 (received ${scale}).`);
  }

  return Object.freeze({
    id,
    version,
    isReferenceOnly: true as const,
    estimate({ snapshot }): RawEstimatorOutput {
      if (isMarketPriceOrOrderbookKey(featureName)) {
        return {
          abstained: true,
          abstentionReasons: [
            {
              code: 'FORBIDDEN_PRICE_FEATURE_REQUESTED',
              detail: `Feature "${featureName}" is a forbidden market-price/orderbook field.`,
            },
          ],
        };
      }

      if (!Object.prototype.hasOwnProperty.call(snapshot.features, featureName)) {
        return {
          abstained: true,
          abstentionReasons: [
            {
              code: 'MISSING_REQUIRED_FEATURE',
              detail: `Required research snapshot feature "${featureName}" is missing.`,
            },
          ],
        };
      }

      const rawVal = snapshot.features[featureName];
      if (typeof rawVal !== 'number' || !Number.isFinite(rawVal)) {
        return {
          abstained: true,
          abstentionReasons: [
            {
              code: 'INVALID_FEATURE_VALUE',
              detail: `Feature "${featureName}" must be a finite number (received ${String(rawVal)}).`,
            },
          ],
        };
      }

      const z = (rawVal - center) / scale;
      const probability = 1 / (1 + Math.exp(-z));
      const lower = Math.max(0, probability - intervalHalfWidth);
      const upper = Math.min(1, probability + intervalHalfWidth);

      return {
        probability,
        uncertaintyInterval: {
          lower,
          upper,
          method: 'reference_fixed_logistic_half_width',
        },
        featureMetadata: {
          featureName,
          featureValue: rawVal,
          transform: 'fixed_logistic',
          center,
          scale,
          isReferenceOnly: true,
        },
      };
    },
  });
}
