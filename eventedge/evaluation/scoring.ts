import crypto from 'node:crypto';
import {
  DEFAULT_CLUSTER_BOOTSTRAP_ITERATIONS,
  LOG_LOSS_PROBABILITY_CLIP_EPSILON,
  type BinaryOutcome,
  type ClusterBootstrapOptions,
  type ClusterBootstrapResult,
  type EventFamilyScoringSummary,
  type LogLossClipReport,
  type PairedScoringSample,
  type PairedScoringSummary,
  type ScoringMetrics,
} from './types';

function assertValidProbability(p: number, label: string): void {
  if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) {
    throw new RangeError(`${label} must be a finite probability in [0, 1] (received ${String(p)}).`);
  }
}

function assertValidOutcome(y: number): asserts y is BinaryOutcome {
  if (y !== 0 && y !== 1) {
    throw new RangeError(`Outcome must be binary 0 or 1 (received ${String(y)}).`);
  }
}

function assertValidClipEpsilon(eps: number): void {
  if (typeof eps !== 'number' || !Number.isFinite(eps) || eps <= 0 || eps >= 0.5) {
    throw new RangeError(
      `log-loss clip epsilon must be in (0, 0.5) (received ${String(eps)}).`
    );
  }
}

/**
 * Clips a probability strictly for log-loss scoring to `[eps, 1 - eps]`.
 * Never mutates stored forecasts.
 */
export function clipProbabilityForLogLoss(
  probability: number,
  epsilon: number = LOG_LOSS_PROBABILITY_CLIP_EPSILON
): { readonly probability: number; readonly clipped: boolean } {
  assertValidProbability(probability, 'Probability');
  assertValidClipEpsilon(epsilon);

  const min = epsilon;
  const max = 1 - epsilon;
  if (probability < min) {
    return Object.freeze({ probability: min, clipped: true });
  }
  if (probability > max) {
    return Object.freeze({ probability: max, clipped: true });
  }
  return Object.freeze({ probability, clipped: false });
}

/**
 * Computes the Brier score `(p - y)^2` for a single binary forecast.
 */
export function brierScore(probability: number, outcome: BinaryOutcome): number {
  assertValidProbability(probability, 'Probability');
  assertValidOutcome(outcome);
  const diff = probability - outcome;
  return diff * diff;
}

/**
 * Computes binary log loss (natural logarithm) using `[eps, 1 - eps]` clipping for scoring only.
 */
export function logLoss(
  probability: number,
  outcome: BinaryOutcome,
  epsilon: number = LOG_LOSS_PROBABILITY_CLIP_EPSILON
): number {
  assertValidOutcome(outcome);
  const { probability: clipped, clipped: wasClipped } = clipProbabilityForLogLoss(
    probability,
    epsilon
  );
  if (outcome === 1) {
    return -Math.log(clipped);
  }
  const oneMinusP = wasClipped && probability > 1 - epsilon ? epsilon : 1 - clipped;
  return -Math.log(oneMinusP);
}

/**
 * Computes mean Brier score and mean log loss (with reported clipping bounds & clipped count)
 * on a series of `(probability, outcome)` pairs.
 */
export function computeScoringMetrics(
  pairs: readonly Readonly<{ probability: number; outcome: BinaryOutcome }>[],
  epsilon: number = LOG_LOSS_PROBABILITY_CLIP_EPSILON
): ScoringMetrics {
  assertValidClipEpsilon(epsilon);

  const min = epsilon;
  const max = 1 - epsilon;

  if (pairs.length === 0) {
    const emptyClip: LogLossClipReport = Object.freeze({
      epsilon,
      min,
      max,
      clippedCount: 0,
    });
    return Object.freeze({
      count: 0,
      brierScore: null,
      logLoss: null,
      logLossClip: emptyClip,
    });
  }

  let brierSum = 0;
  let logLossSum = 0;
  let clippedCount = 0;

  for (const item of pairs) {
    assertValidProbability(item.probability, 'Probability');
    assertValidOutcome(item.outcome);

    const diff = item.probability - item.outcome;
    brierSum += diff * diff;

    const clipped = clipProbabilityForLogLoss(item.probability, epsilon);
    if (clipped.clipped) {
      clippedCount += 1;
    }
    if (item.outcome === 1) {
      logLossSum += -Math.log(clipped.probability);
    } else {
      const oneMinusP =
        clipped.clipped && item.probability > max ? epsilon : 1 - clipped.probability;
      logLossSum += -Math.log(oneMinusP);
    }
  }

  const clipReport: LogLossClipReport = Object.freeze({
    epsilon,
    min,
    max,
    clippedCount,
  });

  return Object.freeze({
    count: pairs.length,
    brierScore: brierSum / pairs.length,
    logLoss: logLossSum / pairs.length,
    logLossClip: clipReport,
  });
}

/**
 * Scores model (`p_ensemble`) and market reference on the EXACT SAME settled sample.
 */
export function scorePairedSamples(
  samples: readonly PairedScoringSample[],
  epsilon: number = LOG_LOSS_PROBABILITY_CLIP_EPSILON
): PairedScoringSummary {
  const modelPairs = samples.map((s) => ({
    probability: s.modelProbability,
    outcome: s.outcome,
  }));
  const marketPairs = samples.map((s) => ({
    probability: s.marketReferenceProbability,
    outcome: s.outcome,
  }));

  const model = computeScoringMetrics(modelPairs, epsilon);
  const marketReference = computeScoringMetrics(marketPairs, epsilon);

  const brierDiff =
    model.brierScore !== null && marketReference.brierScore !== null
      ? model.brierScore - marketReference.brierScore
      : null;
  const logLossDiff =
    model.logLoss !== null && marketReference.logLoss !== null
      ? model.logLoss - marketReference.logLoss
      : null;

  return Object.freeze({
    sampleCount: samples.length,
    marketIds: Object.freeze(samples.map((s) => s.marketId)),
    model,
    marketReference,
    brierDiff,
    logLossDiff,
  });
}

/**
 * Groups paired settled samples by `eventFamilyId` (sorted deterministically) and scores each family.
 */
export function scorePairedSamplesByFamily(
  samples: readonly PairedScoringSample[],
  epsilon: number = LOG_LOSS_PROBABILITY_CLIP_EPSILON
): readonly EventFamilyScoringSummary[] {
  const byFamily = new Map<string, PairedScoringSample[]>();
  for (const sample of samples) {
    const existing = byFamily.get(sample.eventFamilyId);
    if (existing) {
      existing.push(sample);
    } else {
      byFamily.set(sample.eventFamilyId, [sample]);
    }
  }

  const sortedFamilies = [...byFamily.keys()].sort();
  return Object.freeze(
    sortedFamilies.map((eventFamilyId) => {
      const summary = scorePairedSamples(byFamily.get(eventFamilyId)!, epsilon);
      return Object.freeze({
        eventFamilyId,
        ...summary,
      });
    })
  );
}

/**
 * Deterministic sfc32 PRNG seeded from SHA-256 of `experimentId`.
 * Pure arithmetic, identical across all Node.js runs and platforms.
 */
export function createDeterministicPrng(experimentId: string): {
  readonly seedHex: string;
  readonly nextUint32: () => number;
  readonly nextInt: (upperExclusive: number) => number;
} {
  const digest = crypto
    .createHash('sha256')
    .update(`eventedge:cluster-bootstrap:v1:${experimentId.trim()}`)
    .digest();

  let a = digest.readUInt32BE(0);
  let b = digest.readUInt32BE(4);
  let c = digest.readUInt32BE(8);
  let d = digest.readUInt32BE(12);

  const nextUint32 = (): number => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return t >>> 0;
  };

  // Warm up 12 rounds to diffuse low-entropy bits
  for (let i = 0; i < 12; i += 1) {
    nextUint32();
  }

  const nextInt = (upperExclusive: number): number => {
    if (!Number.isInteger(upperExclusive) || upperExclusive <= 0) {
      throw new RangeError(`upperExclusive must be a positive integer (received ${upperExclusive}).`);
    }
    if (upperExclusive === 1) return 0;
    // Rejection sampling to avoid modulo bias
    const limit = Math.floor(0x1_0000_0000 / upperExclusive) * upperExclusive;
    let r = nextUint32();
    while (r >= limit) {
      r = nextUint32();
    }
    return r % upperExclusive;
  };

  return Object.freeze({
    seedHex: digest.toString('hex'),
    nextUint32,
    nextInt,
  });
}

function linearInterpolatedQuantile(sortedAsc: readonly number[], q: number): number {
  if (sortedAsc.length === 0) {
    throw new Error('Cannot compute quantile of empty array.');
  }
  if (sortedAsc.length === 1) {
    return sortedAsc[0];
  }
  const pos = q * (sortedAsc.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo];
  const frac = pos - lo;
  return sortedAsc[lo] * (1 - frac) + sortedAsc[hi] * frac;
}

/**
 * Computes a deterministic cluster bootstrap confidence interval for `(model Brier - market Brier)`.
 *
 * Resampling unit is strictly `event_family_id` (clusters of markets), NOT individual markets:
 * each bootstrap replicate draws `G` event families with replacement from the `G` distinct families
 * and computes the pooled Brier difference across all markets belonging to the drawn families.
 * Seeded deterministically from `experimentId`.
 */
export function computeClusterBootstrapBrierDiffCI(
  samples: readonly PairedScoringSample[],
  experimentId: string,
  options: ClusterBootstrapOptions = {}
): ClusterBootstrapResult {
  const iterations = options.iterations ?? DEFAULT_CLUSTER_BOOTSTRAP_ITERATIONS;
  const confidenceLevel = options.confidenceLevel ?? 0.95;

  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new RangeError(`Bootstrap iterations must be a positive integer (received ${iterations}).`);
  }
  if (
    typeof confidenceLevel !== 'number' ||
    !Number.isFinite(confidenceLevel) ||
    confidenceLevel <= 0 ||
    confidenceLevel >= 1
  ) {
    throw new RangeError(
      `confidenceLevel must be in (0, 1) (received ${String(confidenceLevel)}).`
    );
  }

  const prng = createDeterministicPrng(experimentId);

  if (samples.length === 0) {
    return Object.freeze({
      pointEstimate: null,
      lower: null,
      upper: null,
      confidenceLevel,
      iterations,
      clusterCount: 0,
      sampleCount: 0,
      resampleUnit: 'event_family_id' as const,
      seedExperimentId: experimentId.trim(),
      seedHex: prng.seedHex,
      distinctReplicateSampleSizes: Object.freeze([]),
      distinctReplicateValuesCount: 0,
    });
  }

  // Group into deterministic family clusters sorted by eventFamilyId
  const familyMap = new Map<string, { sumDiff: number; count: number }>();
  let totalDiffSum = 0;

  for (const s of samples) {
    const modelB = brierScore(s.modelProbability, s.outcome);
    const marketB = brierScore(s.marketReferenceProbability, s.outcome);
    const diff = modelB - marketB;
    totalDiffSum += diff;

    const cluster = familyMap.get(s.eventFamilyId);
    if (cluster) {
      cluster.sumDiff += diff;
      cluster.count += 1;
    } else {
      familyMap.set(s.eventFamilyId, { sumDiff: diff, count: 1 });
    }
  }

  const sortedFamilyIds = [...familyMap.keys()].sort();
  const clusters = sortedFamilyIds.map((id) => familyMap.get(id)!);
  const G = clusters.length;
  const pointEstimate = totalDiffSum / samples.length;

  const replicateValues: number[] = new Array(iterations);
  const replicateSizeSet = new Set<number>();
  const replicateRoundedValueSet = new Set<string>();

  for (let b = 0; b < iterations; b += 1) {
    let drawDiffSum = 0;
    let drawCount = 0;
    for (let k = 0; k < G; k += 1) {
      const idx = prng.nextInt(G);
      const cl = clusters[idx];
      drawDiffSum += cl.sumDiff;
      drawCount += cl.count;
    }
    const drawValue = drawDiffSum / drawCount;
    replicateValues[b] = drawValue;
    replicateSizeSet.add(drawCount);
    replicateRoundedValueSet.add(drawValue.toFixed(12));
  }

  replicateValues.sort((x, y) => x - y);
  const alpha = 1 - confidenceLevel;
  const lower = linearInterpolatedQuantile(replicateValues, alpha / 2);
  const upper = linearInterpolatedQuantile(replicateValues, 1 - alpha / 2);

  return Object.freeze({
    pointEstimate,
    lower,
    upper,
    confidenceLevel,
    iterations,
    clusterCount: G,
    sampleCount: samples.length,
    resampleUnit: 'event_family_id' as const,
    seedExperimentId: experimentId.trim(),
    seedHex: prng.seedHex,
    distinctReplicateSampleSizes: Object.freeze([...replicateSizeSet].sort((a, b) => a - b)),
    distinctReplicateValuesCount: replicateRoundedValueSet.size,
  });
}
