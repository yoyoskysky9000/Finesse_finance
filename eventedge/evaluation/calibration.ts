import crypto from 'node:crypto';
import type { ForecastRecord } from '../forecasting/types';
import type { PersistedForecastRecord } from '../persistence/forecastRepository';
import { computeScoringMetrics } from './scoring';
import {
  CALIBRATION_METHOD_ORDER,
  DEFAULT_CALIBRATION_SPLIT_FRACTIONS,
  LOG_LOSS_PROBABILITY_CLIP_EPSILON,
  type CalibratedForwardPoint,
  type CalibrationMethod,
  type CalibrationMethodValidationEntry,
  type CalibrationPoint,
  type CalibrationProvenanceMetadata,
  type CalibrationSplitFractions,
  type FittedCalibrator,
  type ProbabilityCalibrator,
  type TemporalCalibrationResult,
  type TimeWindowSummary,
} from './types';

const CALIBRATION_DOMAIN_EPS = 1e-6;
const CALIBRATION_OUTPUT_EPS = 1e-9;
const REGULARIZATION_LAMBDA = 1e-4;
const MAX_NEWTON_ITERS = 100;
const CONVERGENCE_TOL = 1e-10;
const VALIDATION_TIE_EPS = 1e-12;

function clampForLogit(p: number): number {
  if (!Number.isFinite(p) || p < 0 || p > 1) {
    throw new RangeError(`Calibration input probability must be in [0, 1] (received ${String(p)}).`);
  }
  return Math.min(1 - CALIBRATION_DOMAIN_EPS, Math.max(CALIBRATION_DOMAIN_EPS, p));
}

function logit(p: number): number {
  const s = clampForLogit(p);
  return Math.log(s / (1 - s));
}

function sigmoid(z: number): number {
  if (z >= 0) {
    return 1 / (1 + Math.exp(-z));
  }
  const ez = Math.exp(z);
  return ez / (1 + ez);
}

function softplus(z: number): number {
  if (z > 0) {
    return z + Math.log1p(Math.exp(-z));
  }
  return Math.log1p(Math.exp(z));
}

function safeCalibratedProbability(z: number): number {
  const p = sigmoid(z);
  return Math.min(1 - CALIBRATION_OUTPUT_EPS, Math.max(CALIBRATION_OUTPUT_EPS, p));
}

/**
 * Solves an unconstrained regularized logistic regression problem
 *   min_theta (1/n) sum_i [ softplus(x_i . theta) - y_i (x_i . theta) ]
 *             + (lambda / 2) sum_j (theta_j - prior_j)^2
 * using damped Newton-Raphson with Armijo backtracking line search.
 * Strictly convex -> unique deterministic global minimum.
 */
function solveSmallLinearSystem(A: number[][], b: number[]): number[] | null {
  const d = b.length;
  const M = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < d; col += 1) {
    let pivotRow = col;
    let pivotAbs = Math.abs(M[col][col]);
    for (let r = col + 1; r < d; r += 1) {
      const cand = Math.abs(M[r][col]);
      if (cand > pivotAbs) {
        pivotAbs = cand;
        pivotRow = r;
      }
    }
    if (pivotAbs < 1e-14) {
      return null;
    }
    if (pivotRow !== col) {
      const tmp = M[col];
      M[col] = M[pivotRow];
      M[pivotRow] = tmp;
    }
    const diag = M[col][col];
    for (let r = col + 1; r < d; r += 1) {
      const factor = M[r][col] / diag;
      for (let c = col; c <= d; c += 1) {
        M[r][c] -= factor * M[col][c];
      }
    }
  }

  const x = new Array<number>(d).fill(0);
  for (let r = d - 1; r >= 0; r -= 1) {
    let sum = M[r][d];
    for (let c = r + 1; c < d; c += 1) {
      sum -= M[r][c] * x[c];
    }
    x[r] = sum / M[r][r];
  }
  return x;
}

function fitRegularizedLogistic(
  features: readonly (readonly number[])[],
  outcomes: readonly number[],
  prior: readonly number[],
  lambda: number = REGULARIZATION_LAMBDA
): { readonly theta: readonly number[]; readonly objective: number } {
  const n = features.length;
  const d = prior.length;
  if (n === 0) {
    throw new Error('Cannot fit calibrator on empty training set.');
  }

  let theta = [...prior];

  const evalObjective = (w: readonly number[]): number => {
    let lossSum = 0;
    for (let i = 0; i < n; i += 1) {
      let z = 0;
      const xi = features[i];
      for (let j = 0; j < d; j += 1) {
        z += xi[j] * w[j];
      }
      lossSum += softplus(z) - outcomes[i] * z;
    }
    let reg = 0;
    for (let j = 0; j < d; j += 1) {
      const diff = w[j] - prior[j];
      reg += diff * diff;
    }
    return lossSum / n + 0.5 * lambda * reg;
  };

  let obj = evalObjective(theta);

  for (let iter = 0; iter < MAX_NEWTON_ITERS; iter += 1) {
    const grad = new Array<number>(d).fill(0);
    const hess: number[][] = Array.from({ length: d }, () => new Array<number>(d).fill(0));

    for (let i = 0; i < n; i += 1) {
      const xi = features[i];
      let z = 0;
      for (let j = 0; j < d; j += 1) {
        z += xi[j] * theta[j];
      }
      const p = sigmoid(z);
      const err = p - outcomes[i];
      const w = Math.max(1e-12, p * (1 - p));
      for (let j = 0; j < d; j += 1) {
        grad[j] += err * xi[j];
        for (let k = 0; k < d; k += 1) {
          hess[j][k] += w * xi[j] * xi[k];
        }
      }
    }

    let gradNormSq = 0;
    for (let j = 0; j < d; j += 1) {
      grad[j] = grad[j] / n + lambda * (theta[j] - prior[j]);
      gradNormSq += grad[j] * grad[j];
      for (let k = 0; k < d; k += 1) {
        hess[j][k] /= n;
      }
      hess[j][j] += lambda;
    }

    if (Math.sqrt(gradNormSq) < CONVERGENCE_TOL) {
      break;
    }

    const negGrad = grad.map((g) => -g);
    const step = solveSmallLinearSystem(hess, negGrad) ?? negGrad;

    let directionalDeriv = 0;
    for (let j = 0; j < d; j += 1) {
      directionalDeriv += grad[j] * step[j];
    }

    let alpha = 1.0;
    let nextTheta = theta;
    let nextObj = obj;

    if (directionalDeriv < 0) {
      for (let ls = 0; ls < 40; ls += 1) {
        const cand = theta.map((v, j) => v + alpha * step[j]);
        const candObj = evalObjective(cand);
        if (candObj <= obj + 1e-4 * alpha * directionalDeriv) {
          nextTheta = cand;
          nextObj = candObj;
          break;
        }
        alpha *= 0.5;
      }
    }

    const stepDiff = Math.sqrt(
      nextTheta.reduce((acc, v, j) => acc + (v - theta[j]) * (v - theta[j]), 0)
    );
    theta = nextTheta;
    obj = nextObj;
    if (stepDiff < CONVERGENCE_TOL) {
      break;
    }
  }

  return Object.freeze({
    theta: Object.freeze(theta),
    objective: obj,
  });
}

/**
 * Beta Calibration (Kull, Silva Filho & Flach, 2017):
 *   P_cal(p) = sigmoid(a * ln(s) - b * ln(1 - s) + c)
 * subject to monotonicity constraints `a >= 0, b >= 0`.
 * Solved globally across all 4 convex active sets (`{free}`, `{a=0}`, `{b=0}`, `{a=0, b=0}`).
 */
export function createBetaCalibrator(): ProbabilityCalibrator {
  return Object.freeze({
    method: 'beta' as const,
    fit(trainData: readonly CalibrationPoint[]): FittedCalibrator {
      if (trainData.length === 0) {
        throw new Error('Beta calibrator requires at least 1 training point.');
      }

      const u = trainData.map((pt) => Math.log(clampForLogit(pt.probability)));
      const v = trainData.map((pt) => -Math.log(1 - clampForLogit(pt.probability)));
      const y = trainData.map((pt) => pt.outcome);

      const evaluateFullObjective = (a: number, b: number, c: number): number => {
        let lossSum = 0;
        for (let i = 0; i < trainData.length; i += 1) {
          const z = a * u[i] + b * v[i] + c;
          lossSum += softplus(z) - y[i] * z;
        }
        const reg = (a - 1) * (a - 1) + (b - 1) * (b - 1) + c * c;
        return lossSum / trainData.length + 0.5 * REGULARIZATION_LAMBDA * reg;
      };

      const candidates: Array<{ a: number; b: number; c: number; obj: number }> = [];

      // Active set 1: a, b, c all free
      {
        const X = trainData.map((_, i) => [u[i], v[i], 1]);
        const sol = fitRegularizedLogistic(X, y, [1, 1, 0]);
        const [a, b, c] = sol.theta;
        if (a >= 0 && b >= 0) {
          candidates.push({ a, b, c, obj: evaluateFullObjective(a, b, c) });
        }
      }

      // Active set 2: a = 0, b & c free
      {
        const X = trainData.map((_, i) => [v[i], 1]);
        const sol = fitRegularizedLogistic(X, y, [1, 0]);
        const [b, c] = sol.theta;
        if (b >= 0) {
          candidates.push({ a: 0, b, c, obj: evaluateFullObjective(0, b, c) });
        }
      }

      // Active set 3: b = 0, a & c free
      {
        const X = trainData.map((_, i) => [u[i], 1]);
        const sol = fitRegularizedLogistic(X, y, [1, 0]);
        const [a, c] = sol.theta;
        if (a >= 0) {
          candidates.push({ a, b: 0, c, obj: evaluateFullObjective(a, 0, c) });
        }
      }

      // Active set 4: a = 0, b = 0, c free (always feasible)
      {
        const X = trainData.map(() => [1]);
        const sol = fitRegularizedLogistic(X, y, [0]);
        const [c] = sol.theta;
        candidates.push({ a: 0, b: 0, c, obj: evaluateFullObjective(0, 0, c) });
      }

      candidates.sort((c1, c2) => c1.obj - c2.obj);
      const best = candidates[0];
      const params = Object.freeze({ a: best.a, b: best.b, c: best.c });

      return Object.freeze({
        method: 'beta' as const,
        parameters: params,
        trainSampleCount: trainData.length,
        transform(probability: number): number {
          const s = clampForLogit(probability);
          const z = best.a * Math.log(s) - best.b * Math.log(1 - s) + best.c;
          return safeCalibratedProbability(z);
        },
      });
    },
  });
}

/**
 * Platt Scaling (logistic regression on `logit(p)`):
 *   P_cal(p) = sigmoid(a * logit(p) + b)
 */
export function createPlattCalibrator(): ProbabilityCalibrator {
  return Object.freeze({
    method: 'platt' as const,
    fit(trainData: readonly CalibrationPoint[]): FittedCalibrator {
      if (trainData.length === 0) {
        throw new Error('Platt calibrator requires at least 1 training point.');
      }

      const X = trainData.map((pt) => [logit(pt.probability), 1]);
      const y = trainData.map((pt) => pt.outcome);
      const sol = fitRegularizedLogistic(X, y, [1, 0]);
      const [a, b] = sol.theta;
      const params = Object.freeze({ a, b });

      return Object.freeze({
        method: 'platt' as const,
        parameters: params,
        trainSampleCount: trainData.length,
        transform(probability: number): number {
          const z = a * logit(probability) + b;
          return safeCalibratedProbability(z);
        },
      });
    },
  });
}

/**
 * Temperature Scaling on `logit(p)`:
 *   P_cal(p) = sigmoid(logit(p) / T)  with T > 0 (parameterized by k = 1 / T >= 1e-3).
 */
export function createTemperatureCalibrator(): ProbabilityCalibrator {
  const MIN_INV_TEMP = 1e-3;
  return Object.freeze({
    method: 'temperature' as const,
    fit(trainData: readonly CalibrationPoint[]): FittedCalibrator {
      if (trainData.length === 0) {
        throw new Error('Temperature calibrator requires at least 1 training point.');
      }

      const logits = trainData.map((pt) => logit(pt.probability));
      const y = trainData.map((pt) => pt.outcome);
      const X = logits.map((l) => [l]);
      const sol = fitRegularizedLogistic(X, y, [1]);
      const invTemp = Math.max(MIN_INV_TEMP, sol.theta[0]);
      const temperature = 1 / invTemp;
      const params = Object.freeze({
        temperature,
        inverseTemperature: invTemp,
      });

      return Object.freeze({
        method: 'temperature' as const,
        parameters: params,
        trainSampleCount: trainData.length,
        transform(probability: number): number {
          const z = logit(probability) / temperature;
          return safeCalibratedProbability(z);
        },
      });
    },
  });
}

export function createDefaultCalibrators(): Readonly<
  Record<CalibrationMethod, ProbabilityCalibrator>
> {
  return Object.freeze({
    beta: createBetaCalibrator(),
    platt: createPlattCalibrator(),
    temperature: createTemperatureCalibrator(),
  });
}

export function validateSplitFractions(fractions: CalibrationSplitFractions): void {
  const { trainFraction, validationFraction, testFraction } = fractions;
  for (const [name, val] of [
    ['trainFraction', trainFraction],
    ['validationFraction', validationFraction],
    ['testFraction', testFraction],
  ] as const) {
    if (typeof val !== 'number' || !Number.isFinite(val) || val <= 0 || val >= 1) {
      throw new RangeError(`${name} must be strictly in (0, 1) (received ${String(val)}).`);
    }
  }
  const sum = trainFraction + validationFraction + testFraction;
  if (Math.abs(sum - 1) > 1e-6) {
    throw new RangeError(
      `Calibration split fractions must sum to 1.0 (received ${trainFraction} + ${validationFraction} + ${testFraction} = ${sum}).`
    );
  }
}

/**
 * Splits a series strictly by `forecastTimestamp` ascending into disjoint chronological
 * `(train, validation, forwardTest)` segments. Never shuffles or leaks future points.
 */
export function splitChronologically<T extends CalibrationPoint>(
  series: readonly T[],
  splitFractions: CalibrationSplitFractions = DEFAULT_CALIBRATION_SPLIT_FRACTIONS
): {
  readonly train: readonly T[];
  readonly validation: readonly T[];
  readonly forwardTest: readonly T[];
} {
  validateSplitFractions(splitFractions);

  const sorted = [...series].sort((a, b) => {
    const ta = Date.parse(a.forecastTimestamp);
    const tb = Date.parse(b.forecastTimestamp);
    if (!Number.isFinite(ta) || !Number.isFinite(tb)) {
      throw new Error('All calibration points must have valid ISO-8601 forecastTimestamp values.');
    }
    if (ta !== tb) return ta - tb;
    const ma = a.marketId ?? '';
    const mb = b.marketId ?? '';
    if (ma !== mb) return ma.localeCompare(mb);
    return (a.forecastId ?? '').localeCompare(b.forecastId ?? '');
  });

  const n = sorted.length;
  if (n < 3) {
    return Object.freeze({
      train: Object.freeze([]),
      validation: Object.freeze([]),
      forwardTest: Object.freeze([]),
    });
  }

  const trainCount = Math.max(1, Math.min(n - 2, Math.floor(n * splitFractions.trainFraction)));
  const remainingAfterTrain = n - trainCount;
  const validationCount = Math.max(
    1,
    Math.min(remainingAfterTrain - 1, Math.floor(n * splitFractions.validationFraction))
  );

  const train = sorted.slice(0, trainCount);
  const validation = sorted.slice(trainCount, trainCount + validationCount);
  const forwardTest = sorted.slice(trainCount + validationCount);

  return Object.freeze({
    train: Object.freeze(train),
    validation: Object.freeze(validation),
    forwardTest: Object.freeze(forwardTest),
  });
}

function summarizeWindow(points: readonly CalibrationPoint[]): TimeWindowSummary {
  return Object.freeze({
    start: points[0].forecastTimestamp,
    end: points[points.length - 1].forecastTimestamp,
    count: points.length,
  });
}

/**
 * Runs strict temporally-isolated calibration:
 * 1. Splits strictly by time into train (earliest), validation (middle), forward test (latest).
 * 2. Fits Beta, Platt, and Temperature calibrators on `train` ONLY.
 * 3. Selects the winning method by `validation` Brier score (ties broken in fixed order:
 *    `beta`, `platt`, `temperature`).
 * 4. Applies ONLY the frozen selected calibrator to `forwardTest` and reports raw vs calibrated
 *    Brier & log loss on `forwardTest` ONLY.
 */
export function runTemporallyIsolatedCalibration<T extends CalibrationPoint>(
  series: readonly T[],
  options: {
    readonly splitFractions?: CalibrationSplitFractions;
    readonly logLossClipEpsilon?: number;
    readonly calibrators?: Readonly<Record<CalibrationMethod, ProbabilityCalibrator>>;
  } = {}
): TemporalCalibrationResult {
  const splitFractions = options.splitFractions ?? DEFAULT_CALIBRATION_SPLIT_FRACTIONS;
  const logLossClipEpsilon = options.logLossClipEpsilon ?? LOG_LOSS_PROBABILITY_CLIP_EPSILON;
  const calibrators = options.calibrators ?? createDefaultCalibrators();

  validateSplitFractions(splitFractions);

  const { train, validation, forwardTest } = splitChronologically(series, splitFractions);

  if (train.length === 0 || validation.length === 0 || forwardTest.length === 0) {
    return Object.freeze({
      status: 'SKIPPED_INSUFFICIENT_DATA' as const,
      skipReason: `Need at least 3 settled forecasts to form non-empty train, validation, and forward-test segments (received ${series.length}).`,
      splitFractions: Object.freeze({ ...splitFractions }),
      trainWindow: null,
      validationWindow: null,
      forwardTestWindow: null,
      validationResults: Object.freeze([]),
      selectedMethod: null,
      selectedParameters: null,
      forwardTestRaw: null,
      forwardTestCalibrated: null,
      forwardTestMarketReference: null,
      forwardPredictions: Object.freeze([]),
    });
  }

  const trainWindow = summarizeWindow(train);
  const validationWindow = summarizeWindow(validation);
  const forwardTestWindow = summarizeWindow(forwardTest);

  // Fit strictly on train ONLY and score strictly on validation ONLY
  const fittedByMethod = new Map<CalibrationMethod, FittedCalibrator>();
  const validationResults: CalibrationMethodValidationEntry[] = [];

  let bestMethod: CalibrationMethod | null = null;
  let bestValidationBrier = Number.POSITIVE_INFINITY;

  for (const method of CALIBRATION_METHOD_ORDER) {
    const calibrator = calibrators[method];
    // STRICT ISOLATION: fit() receives ONLY train
    const fitted = calibrator.fit(train);
    fittedByMethod.set(method, fitted);

    // Evaluate strictly on validation
    const valMetrics = computeScoringMetrics(
      validation.map((pt) => ({
        probability: fitted.transform(pt.probability),
        outcome: pt.outcome,
      })),
      logLossClipEpsilon
    );

    const valBrier = valMetrics.brierScore!;
    const valLogLoss = valMetrics.logLoss!;

    validationResults.push(
      Object.freeze({
        method,
        validationBrier: valBrier,
        validationLogLoss: valLogLoss,
        parameters: fitted.parameters,
      })
    );

    // Fixed tie-breaking order: beta -> platt -> temperature
    if (bestMethod === null || valBrier < bestValidationBrier - VALIDATION_TIE_EPS) {
      bestMethod = method;
      bestValidationBrier = valBrier;
    }
  }

  const selectedMethod = bestMethod!;
  const selectedCalibrator = fittedByMethod.get(selectedMethod)!;

  // Apply frozen selected calibrator to forwardTest ONLY
  const forwardPredictions: CalibratedForwardPoint[] = forwardTest.map((pt, idx) => {
    const calibratedProbability = selectedCalibrator.transform(pt.probability);
    return Object.freeze({
      forecastId: pt.forecastId ?? `forward_${idx}`,
      marketId: pt.marketId ?? `market_${idx}`,
      forecastTimestamp: pt.forecastTimestamp,
      rawProbability: pt.probability,
      calibratedProbability,
      outcome: pt.outcome,
      marketReferenceProbability:
        typeof pt.marketReferenceProbability === 'number' ? pt.marketReferenceProbability : null,
    });
  });

  const forwardTestRaw = computeScoringMetrics(
    forwardPredictions.map((p) => ({ probability: p.rawProbability, outcome: p.outcome })),
    logLossClipEpsilon
  );

  const forwardTestCalibrated = computeScoringMetrics(
    forwardPredictions.map((p) => ({ probability: p.calibratedProbability, outcome: p.outcome })),
    logLossClipEpsilon
  );

  const allForwardHaveMarketRef = forwardPredictions.every(
    (p) => p.marketReferenceProbability !== null
  );
  const forwardTestMarketReference = allForwardHaveMarketRef
    ? computeScoringMetrics(
        forwardPredictions.map((p) => ({
          probability: p.marketReferenceProbability!,
          outcome: p.outcome,
        })),
        logLossClipEpsilon
      )
    : null;

  return Object.freeze({
    status: 'COMPLETED' as const,
    skipReason: null,
    splitFractions: Object.freeze({ ...splitFractions }),
    trainWindow,
    validationWindow,
    forwardTestWindow,
    validationResults: Object.freeze(validationResults),
    selectedMethod,
    selectedParameters: selectedCalibrator.parameters,
    forwardTestRaw,
    forwardTestCalibrated,
    forwardTestMarketReference,
    forwardPredictions: Object.freeze(forwardPredictions),
  });
}

/**
 * Constructs an immutable `p_calibrated` forecast record derived from a source `p_ensemble`
 * forecast record, embedding full calibration provenance (method, train/validation windows,
 * parameters, and source `forecast_id`). Never embeds market-reference prices.
 */
export function buildCalibratedForecastRecord(input: {
  readonly sourceForecast: ForecastRecord;
  readonly calibratedProbability: number;
  readonly method: CalibrationMethod;
  readonly parameters: Readonly<Record<string, number>>;
  readonly trainWindow: TimeWindowSummary;
  readonly validationWindow: TimeWindowSummary;
  readonly forwardTestWindow: TimeWindowSummary;
  readonly calibratedAt: string;
}): PersistedForecastRecord {
  const {
    sourceForecast,
    calibratedProbability,
    method,
    parameters,
    trainWindow,
    validationWindow,
    forwardTestWindow,
    calibratedAt,
  } = input;

  if (sourceForecast.status !== 'FORECAST' || sourceForecast.probability === null) {
    throw new Error(
      `Cannot build p_calibrated record from non-numeric source forecast "${sourceForecast.forecastId}".`
    );
  }

  const seed = JSON.stringify({
    experimentId: sourceForecast.experimentId,
    sourceForecastId: sourceForecast.forecastId,
    method,
    trainWindow,
    validationWindow,
    calibratedProbability,
  });
  const digest = crypto.createHash('sha256').update(seed).digest('hex').slice(0, 24);
  const forecastId = `fc_p_calibrated_${digest}`;

  const calibrationProvenance: CalibrationProvenanceMetadata = Object.freeze({
    method,
    parameters: Object.freeze({ ...parameters }),
    sourceForecastId: sourceForecast.forecastId,
    rawProbability: sourceForecast.probability,
    trainWindow: Object.freeze({ ...trainWindow }),
    validationWindow: Object.freeze({ ...validationWindow }),
    forwardTestWindow: Object.freeze({ ...forwardTestWindow }),
    calibratedAt,
  });

  return Object.freeze({
    forecastId,
    experimentId: sourceForecast.experimentId,
    marketId: sourceForecast.marketId,
    eventId: sourceForecast.eventId,
    eventFamilyId: sourceForecast.eventFamilyId,
    eventFamilyDerivationVersion: sourceForecast.eventFamilyDerivationVersion,
    forecastStage: 'p_calibrated' as const,
    status: 'FORECAST' as const,
    probability: calibratedProbability,
    uncertaintyInterval: null,
    extremeProbabilityJustified: false,
    extremeProbabilityJustification: null,
    abstentionReasons: Object.freeze([]),
    modelVersion: `calibrator:${method}:v1`,
    configHash: sourceForecast.configHash,
    codeCommitHash: sourceForecast.codeCommitHash,
    dataSnapshotId: sourceForecast.dataSnapshotId,
    baseRateVersion: sourceForecast.baseRateVersion,
    ensembleVersion: sourceForecast.ensembleVersion,
    ruleVersionId: sourceForecast.ruleVersionId,
    componentForecastIds: Object.freeze([sourceForecast.forecastId]),
    ensembleMetadata: null,
    referenceClass: null,
    featureMetadata: Object.freeze({
      calibration: calibrationProvenance,
    }),
    forecastTimestamp: sourceForecast.forecastTimestamp,
  });
}
