import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { EventEdgeConfig } from '../config/index';
import {
  canonicalStringify,
  computeForecastConfigHash,
  deriveEventFamilyId,
  resolveCodeCommitHash,
  sanitizeResearchSnapshotPriceBlind,
} from './priceBlindGuard';
import type {
  ApprovedContractInput,
  BaseRateEstimator,
  EnsembleCombinationMetadata,
  ForecastAbstentionReason,
  ForecastEvaluationResult,
  ForecastRecord,
  ForecastStage,
  QuantitativeEstimator,
  RawEstimatorOutput,
  ReferenceClass,
  ResearchDataSnapshot,
  SanitizedResearchSnapshot,
  UncertaintyInterval,
} from './types';

export interface EvaluatePriceBlindForecastInput {
  readonly experimentId: string;
  readonly contract: ApprovedContractInput;
  readonly config: EventEdgeConfig;
  readonly researchSnapshot?: ResearchDataSnapshot | null;
  readonly referenceClass?: ReferenceClass | null;
  readonly baseRateEstimator?: BaseRateEstimator | null;
  readonly quantEstimator?: QuantitativeEstimator | null;
  /** Deterministic ISO-8601 forecast timestamp (defaults to `new Date().toISOString()`). */
  readonly forecastTimestamp?: string;
  /** Optional override for code commit hash (defaults to git HEAD or literal `'unknown'`). */
  readonly codeCommitHash?: string;
  /** Optional directory to search for `.git/HEAD` when resolving `codeCommitHash`. */
  readonly repoRootDir?: string;
}

export interface RunPriceBlindForecastInput extends EvaluatePriceBlindForecastInput {
  readonly db: DatabaseSync;
}

interface ValidatedStageOutput {
  readonly status: 'FORECAST' | 'ABSTAINED';
  readonly probability: number | null;
  readonly uncertaintyInterval: UncertaintyInterval | null;
  readonly extremeProbabilityJustified: boolean;
  readonly extremeProbabilityJustification: string | null;
  readonly abstentionReasons: readonly ForecastAbstentionReason[];
  readonly featureMetadata: Readonly<Record<string, unknown>> | null;
}

interface ProvenanceContext {
  readonly experimentId: string;
  readonly marketId: string;
  readonly eventId: string;
  readonly eventFamilyId: string;
  readonly eventFamilyDerivationVersion: string;
  readonly configHash: string;
  readonly codeCommitHash: string;
  readonly dataSnapshotId: string;
  readonly baseRateVersion: string;
  readonly ensembleVersion: string;
  readonly ruleVersionId: string | null;
  readonly forecastTimestamp: string;
}

function deriveDeterministicForecastId(
  provenance: ProvenanceContext,
  stage: ForecastStage,
  modelVersion: string,
  extraSeed: string
): string {
  const hash = crypto
    .createHash('sha256')
    .update(
      [
        provenance.experimentId,
        provenance.marketId,
        provenance.eventId,
        stage,
        modelVersion,
        provenance.configHash,
        provenance.codeCommitHash,
        provenance.dataSnapshotId,
        provenance.baseRateVersion,
        provenance.ensembleVersion,
        provenance.forecastTimestamp,
        extraSeed,
      ].join('|')
    )
    .digest('hex')
    .slice(0, 32);
  return `fc_${stage}_${hash}`;
}

function freezeAbstentionReasons(
  reasons: readonly ForecastAbstentionReason[]
): readonly ForecastAbstentionReason[] {
  return Object.freeze(
    reasons.map((r) => Object.freeze({ code: r.code, detail: r.detail }))
  );
}

/**
 * Validates raw estimator output against mandatory red-team output invariants:
 * - Probability must be a finite number in [0, 1]. NaN, Infinity, -Infinity, < 0, > 1
 *   are rejected into ABSTAINED and NEVER silently clamped.
 * - Exact 0 or 1 is allowed ONLY with a non-empty `extremeProbabilityJustification`.
 * - Uncertainty interval (if supplied) must have finite lower/upper in [0, 1] with
 *   lower <= probability <= upper (never silently clamped).
 */
export function validateRawEstimatorOutput(
  raw: RawEstimatorOutput | null | undefined,
  requireUncertaintyInterval: boolean
): ValidatedStageOutput {
  if (!raw || typeof raw !== 'object') {
    return {
      status: 'ABSTAINED',
      probability: null,
      uncertaintyInterval: null,
      extremeProbabilityJustified: false,
      extremeProbabilityJustification: null,
      abstentionReasons: freezeAbstentionReasons([
        {
          code: 'ESTIMATOR_OUTPUT_MISSING',
          detail: 'Estimator returned null or undefined output.',
        },
      ]),
      featureMetadata: null,
    };
  }

  const featureMetadata =
    raw.featureMetadata && typeof raw.featureMetadata === 'object' && !Array.isArray(raw.featureMetadata)
      ? Object.freeze({ ...raw.featureMetadata })
      : null;

  if (raw.abstained === true) {
    const reasons: ForecastAbstentionReason[] =
      Array.isArray(raw.abstentionReasons) && raw.abstentionReasons.length > 0
        ? [...raw.abstentionReasons]
        : [
            {
              code: 'ESTIMATOR_ABSTAINED',
              detail: 'Estimator explicitly abstained without detailed reasons.',
            },
          ];
    return {
      status: 'ABSTAINED',
      probability: null,
      uncertaintyInterval: null,
      extremeProbabilityJustified: false,
      extremeProbabilityJustification: null,
      abstentionReasons: freezeAbstentionReasons(reasons),
      featureMetadata,
    };
  }

  const p = raw.probability;
  if (typeof p !== 'number') {
    return {
      status: 'ABSTAINED',
      probability: null,
      uncertaintyInterval: null,
      extremeProbabilityJustified: false,
      extremeProbabilityJustification: null,
      abstentionReasons: freezeAbstentionReasons([
        {
          code: 'ESTIMATOR_OUTPUT_MISSING',
          detail: `Estimator did not return a numeric probability (received ${typeof p}).`,
        },
      ]),
      featureMetadata,
    };
  }

  if (Number.isNaN(p)) {
    return {
      status: 'ABSTAINED',
      probability: null,
      uncertaintyInterval: null,
      extremeProbabilityJustified: false,
      extremeProbabilityJustification: null,
      abstentionReasons: freezeAbstentionReasons([
        {
          code: 'ESTIMATOR_OUTPUT_NAN',
          detail: 'Estimator returned NaN probability; rejected into abstention without clamping.',
        },
      ]),
      featureMetadata,
    };
  }

  if (!Number.isFinite(p)) {
    return {
      status: 'ABSTAINED',
      probability: null,
      uncertaintyInterval: null,
      extremeProbabilityJustified: false,
      extremeProbabilityJustification: null,
      abstentionReasons: freezeAbstentionReasons([
        {
          code: 'ESTIMATOR_OUTPUT_INFINITE',
          detail: `Estimator returned non-finite probability (${String(p)}); rejected into abstention without clamping.`,
        },
      ]),
      featureMetadata,
    };
  }

  if (p < 0 || p > 1) {
    return {
      status: 'ABSTAINED',
      probability: null,
      uncertaintyInterval: null,
      extremeProbabilityJustified: false,
      extremeProbabilityJustification: null,
      abstentionReasons: freezeAbstentionReasons([
        {
          code: 'ESTIMATOR_OUTPUT_OUT_OF_RANGE',
          detail: `Estimator returned out-of-range probability (${p}); must be within [0, 1] and is never silently clamped.`,
        },
      ]),
      featureMetadata,
    };
  }

  const justification =
    typeof raw.extremeProbabilityJustification === 'string' &&
    raw.extremeProbabilityJustification.trim().length > 0
      ? raw.extremeProbabilityJustification.trim()
      : null;

  const isExtreme = p === 0 || p === 1;
  if (isExtreme && !justification) {
    return {
      status: 'ABSTAINED',
      probability: null,
      uncertaintyInterval: null,
      extremeProbabilityJustified: false,
      extremeProbabilityJustification: null,
      abstentionReasons: freezeAbstentionReasons([
        {
          code: 'UNJUSTIFIED_EXTREME_PROBABILITY',
          detail: `Exact extreme probability (${p}) requires an explicit non-empty justification flag/text; rejected into abstention.`,
        },
      ]),
      featureMetadata,
    };
  }

  let validatedInterval: UncertaintyInterval | null = null;
  if (raw.uncertaintyInterval !== undefined && raw.uncertaintyInterval !== null) {
    const iv = raw.uncertaintyInterval;
    const validLower =
      typeof iv.lower === 'number' && Number.isFinite(iv.lower) && iv.lower >= 0 && iv.lower <= 1;
    const validUpper =
      typeof iv.upper === 'number' && Number.isFinite(iv.upper) && iv.upper >= 0 && iv.upper <= 1;
    const validMethod = typeof iv.method === 'string' && iv.method.trim().length > 0;
    if (!validLower || !validUpper || !validMethod || iv.lower > iv.upper || p < iv.lower || p > iv.upper) {
      return {
        status: 'ABSTAINED',
        probability: null,
        uncertaintyInterval: null,
        extremeProbabilityJustified: false,
        extremeProbabilityJustification: null,
        abstentionReasons: freezeAbstentionReasons([
          {
            code: 'INVALID_UNCERTAINTY_INTERVAL',
            detail: `Uncertainty interval [${String(iv.lower)}, ${String(iv.upper)}] is invalid or does not contain probability ${p}; rejected into abstention.`,
          },
        ]),
        featureMetadata,
      };
    }
    validatedInterval = Object.freeze({
      lower: iv.lower,
      upper: iv.upper,
      method: iv.method.trim(),
      ...(typeof iv.confidenceLevel === 'number' && Number.isFinite(iv.confidenceLevel)
        ? { confidenceLevel: iv.confidenceLevel }
        : {}),
    });
  } else if (requireUncertaintyInterval) {
    return {
      status: 'ABSTAINED',
      probability: null,
      uncertaintyInterval: null,
      extremeProbabilityJustified: false,
      extremeProbabilityJustification: null,
      abstentionReasons: freezeAbstentionReasons([
        {
          code: 'INVALID_UNCERTAINTY_INTERVAL',
          detail: 'BaseRateEstimator must return a valid uncertainty interval.',
        },
      ]),
      featureMetadata,
    };
  }

  return {
    status: 'FORECAST',
    probability: p,
    uncertaintyInterval: validatedInterval,
    extremeProbabilityJustified: isExtreme && Boolean(justification),
    extremeProbabilityJustification: isExtreme ? justification : null,
    abstentionReasons: Object.freeze([]),
    featureMetadata,
  };
}

/**
 * Validates a `ReferenceClass` before passing it to a `BaseRateEstimator`.
 */
export function validateReferenceClass(
  referenceClass: ReferenceClass | null | undefined,
  minSampleCount: number
): ForecastAbstentionReason[] {
  if (!referenceClass || typeof referenceClass !== 'object') {
    return [
      {
        code: 'MISSING_REFERENCE_CLASS',
        detail: 'No reference class provided for p_base estimation.',
      },
    ];
  }

  const reasons: ForecastAbstentionReason[] = [];
  if (typeof referenceClass.definition !== 'string' || referenceClass.definition.trim().length === 0) {
    reasons.push({
      code: 'INVALID_REFERENCE_CLASS',
      detail: 'ReferenceClass.definition must be a non-empty string.',
    });
  }
  if (
    typeof referenceClass.inclusionCriteria !== 'string' ||
    referenceClass.inclusionCriteria.trim().length === 0
  ) {
    reasons.push({
      code: 'INVALID_REFERENCE_CLASS',
      detail: 'ReferenceClass.inclusionCriteria must be a non-empty string.',
    });
  }
  if (typeof referenceClass.timeWindow !== 'string' || referenceClass.timeWindow.trim().length === 0) {
    reasons.push({
      code: 'INVALID_REFERENCE_CLASS',
      detail: 'ReferenceClass.timeWindow must be a non-empty string.',
    });
  }
  if (typeof referenceClass.source !== 'string' || referenceClass.source.trim().length === 0) {
    reasons.push({
      code: 'INVALID_REFERENCE_CLASS',
      detail: 'ReferenceClass.source must be a non-empty string.',
    });
  }

  const validSample =
    typeof referenceClass.sampleCount === 'number' &&
    Number.isInteger(referenceClass.sampleCount) &&
    referenceClass.sampleCount >= 0;
  const validPositives =
    typeof referenceClass.positiveCount === 'number' &&
    Number.isInteger(referenceClass.positiveCount) &&
    referenceClass.positiveCount >= 0;

  if (!validSample || !validPositives) {
    reasons.push({
      code: 'INVALID_REFERENCE_CLASS',
      detail: `ReferenceClass sampleCount (${String(referenceClass.sampleCount)}) and positiveCount (${String(referenceClass.positiveCount)}) must be non-negative integers.`,
    });
  } else {
    if (referenceClass.positiveCount > referenceClass.sampleCount) {
      reasons.push({
        code: 'INVALID_REFERENCE_CLASS',
        detail: `ReferenceClass positiveCount (${referenceClass.positiveCount}) exceeds sampleCount (${referenceClass.sampleCount}).`,
      });
    }
    if (referenceClass.sampleCount < minSampleCount) {
      reasons.push({
        code: 'INSUFFICIENT_SAMPLE_SIZE',
        detail: `ReferenceClass sampleCount (${referenceClass.sampleCount}) is below configured minBaseRateSampleCount (${minSampleCount}).`,
      });
    }
  }

  return reasons;
}

function buildAbstainedStageRecord(
  provenance: ProvenanceContext,
  stage: ForecastStage,
  modelVersion: string,
  reasons: readonly ForecastAbstentionReason[],
  options: {
    componentForecastIds?: readonly string[];
    ensembleMetadata?: EnsembleCombinationMetadata | null;
    referenceClass?: ReferenceClass | null;
    featureMetadata?: Readonly<Record<string, unknown>> | null;
    extraSeed?: string;
  } = {}
): ForecastRecord {
  const frozenReasons = freezeAbstentionReasons(reasons);
  const forecastId = deriveDeterministicForecastId(
    provenance,
    stage,
    modelVersion,
    `ABSTAINED:${canonicalStringify(frozenReasons)}:${options.extraSeed ?? ''}`
  );

  return Object.freeze({
    forecastId,
    experimentId: provenance.experimentId,
    marketId: provenance.marketId,
    eventId: provenance.eventId,
    eventFamilyId: provenance.eventFamilyId,
    eventFamilyDerivationVersion: provenance.eventFamilyDerivationVersion,
    forecastStage: stage,
    status: 'ABSTAINED' as const,
    probability: null,
    uncertaintyInterval: null,
    extremeProbabilityJustified: false,
    extremeProbabilityJustification: null,
    abstentionReasons: frozenReasons,
    modelVersion,
    configHash: provenance.configHash,
    codeCommitHash: provenance.codeCommitHash,
    dataSnapshotId: provenance.dataSnapshotId,
    baseRateVersion: provenance.baseRateVersion,
    ensembleVersion: provenance.ensembleVersion,
    ruleVersionId: provenance.ruleVersionId,
    componentForecastIds: Object.freeze([...(options.componentForecastIds ?? [])]),
    ensembleMetadata: options.ensembleMetadata ?? null,
    referenceClass: options.referenceClass ? Object.freeze({ ...options.referenceClass }) : null,
    featureMetadata: options.featureMetadata ? Object.freeze({ ...options.featureMetadata }) : null,
    forecastTimestamp: provenance.forecastTimestamp,
  });
}

function buildForecastStageRecord(
  provenance: ProvenanceContext,
  stage: ForecastStage,
  modelVersion: string,
  validated: ValidatedStageOutput,
  options: {
    componentForecastIds?: readonly string[];
    ensembleMetadata?: EnsembleCombinationMetadata | null;
    referenceClass?: ReferenceClass | null;
    extraSeed?: string;
  } = {}
): ForecastRecord {
  if (validated.status === 'ABSTAINED') {
    return buildAbstainedStageRecord(
      provenance,
      stage,
      modelVersion,
      validated.abstentionReasons,
      {
        componentForecastIds: options.componentForecastIds,
        ensembleMetadata: options.ensembleMetadata,
        referenceClass: options.referenceClass,
        featureMetadata: validated.featureMetadata,
        extraSeed: options.extraSeed,
      }
    );
  }

  const forecastId = deriveDeterministicForecastId(
    provenance,
    stage,
    modelVersion,
    `FORECAST:${String(validated.probability)}:${canonicalStringify(validated.uncertaintyInterval)}:${options.extraSeed ?? ''}`
  );

  return Object.freeze({
    forecastId,
    experimentId: provenance.experimentId,
    marketId: provenance.marketId,
    eventId: provenance.eventId,
    eventFamilyId: provenance.eventFamilyId,
    eventFamilyDerivationVersion: provenance.eventFamilyDerivationVersion,
    forecastStage: stage,
    status: 'FORECAST' as const,
    probability: validated.probability,
    uncertaintyInterval: validated.uncertaintyInterval,
    extremeProbabilityJustified: validated.extremeProbabilityJustified,
    extremeProbabilityJustification: validated.extremeProbabilityJustification,
    abstentionReasons: Object.freeze([]),
    modelVersion,
    configHash: provenance.configHash,
    codeCommitHash: provenance.codeCommitHash,
    dataSnapshotId: provenance.dataSnapshotId,
    baseRateVersion: provenance.baseRateVersion,
    ensembleVersion: provenance.ensembleVersion,
    ruleVersionId: provenance.ruleVersionId,
    componentForecastIds: Object.freeze([...(options.componentForecastIds ?? [])]),
    ensembleMetadata: options.ensembleMetadata ?? null,
    referenceClass: options.referenceClass ? Object.freeze({ ...options.referenceClass }) : null,
    featureMetadata: validated.featureMetadata,
    forecastTimestamp: provenance.forecastTimestamp,
  });
}

/**
 * Pure, deterministic, price-blind probability forecast engine producing three separate
 * immutable stage records: `p_base`, `p_quant`, and `p_ensemble`.
 *
 * Enforces:
 * - Only APPROVED (`auditStatus === 'CLEAR'`) contracts can produce numeric forecasts.
 * - Research snapshots are structurally stripped of all market-price / orderbook fields.
 * - No Bayesian aggregation, no EV calculation, no shrinkage toward market prices.
 * - Transparent weighted linear combination using versioned weights in `config.forecasting`.
 * - Single-stage passthrough recorded explicitly when only one stage is available.
 * - First-class abstention with machine-readable reasons; never clamps or silently defaults.
 */
export function evaluatePriceBlindForecast(
  input: EvaluatePriceBlindForecastInput
): ForecastEvaluationResult {
  const forecastTimestamp = input.forecastTimestamp ?? new Date().toISOString();
  const configHash = computeForecastConfigHash(input.config.forecasting);
  const codeCommitHash =
    typeof input.codeCommitHash === 'string' && input.codeCommitHash.trim().length > 0
      ? input.codeCommitHash.trim()
      : resolveCodeCommitHash(input.repoRootDir);

  const familyDerived =
    typeof input.contract.eventFamilyId === 'string' && input.contract.eventFamilyId.trim().length > 0
      ? {
          eventFamilyId: input.contract.eventFamilyId.trim().toUpperCase(),
          eventFamilyDerivationVersion:
            input.contract.eventFamilyDerivationVersion?.trim() || 'external-family-model',
        }
      : deriveEventFamilyId(
          input.contract.eventId,
          input.config.forecasting.eventFamilyDerivationVersion
        );

  const sanitizedSnapshot: SanitizedResearchSnapshot | null = input.researchSnapshot
    ? sanitizeResearchSnapshotPriceBlind(input.researchSnapshot)
    : null;

  const baseRateVersion = input.baseRateEstimator?.version ?? 'none';
  const quantModelVersion = input.quantEstimator?.version ?? 'none';
  const ensembleVersion = input.config.forecasting.ensembleVersion;

  const provenance: ProvenanceContext = Object.freeze({
    experimentId: input.experimentId.trim(),
    marketId: input.contract.marketId.trim(),
    eventId: input.contract.eventId.trim(),
    eventFamilyId: familyDerived.eventFamilyId,
    eventFamilyDerivationVersion: familyDerived.eventFamilyDerivationVersion,
    configHash,
    codeCommitHash,
    dataSnapshotId: sanitizedSnapshot?.dataSnapshotId || 'MISSING_SNAPSHOT',
    baseRateVersion,
    ensembleVersion,
    ruleVersionId: input.contract.ruleVersionId ?? null,
    forecastTimestamp,
  });

  // Gate 0: Only APPROVED (CLEAR) contracts from EE-01 may produce numeric forecasts
  if (input.contract.auditStatus !== 'CLEAR') {
    const contractReason: ForecastAbstentionReason = {
      code: 'CONTRACT_NOT_APPROVED_CLEAR',
      detail: `Contract "${input.contract.marketId}" has auditStatus="${input.contract.auditStatus}"; only CLEAR contracts may be forecasted.`,
    };
    const pBase = buildAbstainedStageRecord(provenance, 'p_base', baseRateVersion, [contractReason], {
      referenceClass: input.referenceClass ?? null,
    });
    const pQuant = buildAbstainedStageRecord(provenance, 'p_quant', quantModelVersion, [contractReason]);
    const pEnsemble = buildAbstainedStageRecord(
      provenance,
      'p_ensemble',
      ensembleVersion,
      [contractReason],
      { componentForecastIds: [pBase.forecastId, pQuant.forecastId] }
    );
    return Object.freeze({
      pBase,
      pQuant,
      pEnsemble,
      records: Object.freeze([pBase, pQuant, pEnsemble] as const),
    });
  }

  // Stage 1: p_base (BaseRateEstimator)
  let pBase: ForecastRecord;
  if (!input.baseRateEstimator) {
    pBase = buildAbstainedStageRecord(
      provenance,
      'p_base',
      baseRateVersion,
      [
        {
          code: 'MISSING_BASE_RATE_ESTIMATOR',
          detail: 'No BaseRateEstimator supplied for p_base stage.',
        },
      ],
      { referenceClass: input.referenceClass ?? null }
    );
  } else {
    const refClassErrors = validateReferenceClass(
      input.referenceClass,
      input.config.forecasting.minBaseRateSampleCount
    );
    if (refClassErrors.length > 0) {
      pBase = buildAbstainedStageRecord(provenance, 'p_base', baseRateVersion, refClassErrors, {
        referenceClass: input.referenceClass ?? null,
      });
    } else {
      try {
        const rawBase = input.baseRateEstimator.estimate({
          contract: input.contract,
          referenceClass: input.referenceClass!,
          minSampleCount: input.config.forecasting.minBaseRateSampleCount,
        });
        const validatedBase = validateRawEstimatorOutput(rawBase, true);
        pBase = buildForecastStageRecord(provenance, 'p_base', baseRateVersion, validatedBase, {
          referenceClass: input.referenceClass!,
          extraSeed: canonicalStringify(input.referenceClass),
        });
      } catch (err) {
        pBase = buildAbstainedStageRecord(
          provenance,
          'p_base',
          baseRateVersion,
          [
            {
              code: 'ESTIMATOR_THREW_ERROR',
              detail: `BaseRateEstimator threw: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          { referenceClass: input.referenceClass ?? null }
        );
      }
    }
  }

  // Stage 2: p_quant (QuantitativeEstimator — consumes ONLY sanitized price-blind snapshot)
  let pQuant: ForecastRecord;
  if (!input.quantEstimator) {
    pQuant = buildAbstainedStageRecord(provenance, 'p_quant', quantModelVersion, [
      {
        code: 'MISSING_QUANT_ESTIMATOR',
        detail: 'No QuantitativeEstimator supplied for p_quant stage.',
      },
    ]);
  } else if (!sanitizedSnapshot) {
    pQuant = buildAbstainedStageRecord(provenance, 'p_quant', quantModelVersion, [
      {
        code: 'MISSING_RESEARCH_SNAPSHOT',
        detail: 'No research data snapshot supplied for p_quant stage.',
      },
    ]);
  } else {
    try {
      const rawQuant = input.quantEstimator.estimate({
        contract: input.contract,
        snapshot: sanitizedSnapshot,
      });
      const validatedQuant = validateRawEstimatorOutput(rawQuant, false);
      pQuant = buildForecastStageRecord(provenance, 'p_quant', quantModelVersion, validatedQuant, {
        extraSeed: canonicalStringify(sanitizedSnapshot.features),
      });
    } catch (err) {
      pQuant = buildAbstainedStageRecord(provenance, 'p_quant', quantModelVersion, [
        {
          code: 'ESTIMATOR_THREW_ERROR',
          detail: `QuantitativeEstimator threw: ${err instanceof Error ? err.message : String(err)}`,
        },
      ]);
    }
  }

  // Stage 3: p_ensemble (deterministic weighted linear combination — NO Bayesian aggregation, NO market shrinkage)
  const configuredWeights = input.config.forecasting.ensembleWeights;
  const baseAvailable = pBase.status === 'FORECAST' && pBase.probability !== null;
  const quantAvailable = pQuant.status === 'FORECAST' && pQuant.probability !== null;

  let pEnsemble: ForecastRecord;
  if (!baseAvailable && !quantAvailable) {
    const ensembleMeta: EnsembleCombinationMetadata = Object.freeze({
      method: 'WEIGHTED_LINEAR',
      configuredWeights: Object.freeze({ ...configuredWeights }),
      effectiveWeights: Object.freeze({ p_base: 0, p_quant: 0 }),
      availableStages: Object.freeze([]),
      singleStageFallback: false,
      combinationNote: 'ABSTAINED: neither p_base nor p_quant produced a valid forecast.',
    });
    const combinedReasons: ForecastAbstentionReason[] = [
      {
        code: 'NO_AVAILABLE_STAGE_ESTIMATES',
        detail: 'Neither p_base nor p_quant produced a valid forecast; ensemble abstains without silent default.',
      },
      ...pBase.abstentionReasons,
      ...pQuant.abstentionReasons,
    ];
    pEnsemble = buildAbstainedStageRecord(
      provenance,
      'p_ensemble',
      ensembleVersion,
      combinedReasons,
      {
        componentForecastIds: [pBase.forecastId, pQuant.forecastId],
        ensembleMetadata: ensembleMeta,
      }
    );
  } else if (baseAvailable && !quantAvailable) {
    const ensembleMeta: EnsembleCombinationMetadata = Object.freeze({
      method: 'WEIGHTED_LINEAR',
      configuredWeights: Object.freeze({ ...configuredWeights }),
      effectiveWeights: Object.freeze({ p_base: 1, p_quant: 0 }),
      availableStages: Object.freeze(['p_base'] as const),
      singleStageFallback: true,
      combinationNote:
        'SINGLE_STAGE_PASSTHROUGH: only p_base is available; p_ensemble equals p_base.',
    });
    const singleValidated = validateRawEstimatorOutput(
      {
        probability: pBase.probability!,
        uncertaintyInterval: pBase.uncertaintyInterval,
        extremeProbabilityJustification: pBase.extremeProbabilityJustification,
      },
      false
    );
    pEnsemble = buildForecastStageRecord(
      provenance,
      'p_ensemble',
      ensembleVersion,
      singleValidated,
      {
        componentForecastIds: [pBase.forecastId],
        ensembleMetadata: ensembleMeta,
        extraSeed: `single:p_base:${pBase.forecastId}`,
      }
    );
  } else if (!baseAvailable && quantAvailable) {
    const ensembleMeta: EnsembleCombinationMetadata = Object.freeze({
      method: 'WEIGHTED_LINEAR',
      configuredWeights: Object.freeze({ ...configuredWeights }),
      effectiveWeights: Object.freeze({ p_base: 0, p_quant: 1 }),
      availableStages: Object.freeze(['p_quant'] as const),
      singleStageFallback: true,
      combinationNote:
        'SINGLE_STAGE_PASSTHROUGH: only p_quant is available; p_ensemble equals p_quant.',
    });
    const singleValidated = validateRawEstimatorOutput(
      {
        probability: pQuant.probability!,
        uncertaintyInterval: pQuant.uncertaintyInterval,
        extremeProbabilityJustification: pQuant.extremeProbabilityJustification,
      },
      false
    );
    pEnsemble = buildForecastStageRecord(
      provenance,
      'p_ensemble',
      ensembleVersion,
      singleValidated,
      {
        componentForecastIds: [pQuant.forecastId],
        ensembleMetadata: ensembleMeta,
        extraSeed: `single:p_quant:${pQuant.forecastId}`,
      }
    );
  } else {
    const totalWeight = configuredWeights.p_base + configuredWeights.p_quant;
    const effBase = configuredWeights.p_base / totalWeight;
    const effQuant = configuredWeights.p_quant / totalWeight;
    const combinedProb = effBase * pBase.probability! + effQuant * pQuant.probability!;

    let combinedInterval: UncertaintyInterval | null = null;
    if (pBase.uncertaintyInterval && pQuant.uncertaintyInterval) {
      combinedInterval = Object.freeze({
        lower: effBase * pBase.uncertaintyInterval.lower + effQuant * pQuant.uncertaintyInterval.lower,
        upper: effBase * pBase.uncertaintyInterval.upper + effQuant * pQuant.uncertaintyInterval.upper,
        method: 'weighted_linear_interval_bounds',
      });
    }

    const combinedJustification =
      combinedProb === 0 || combinedProb === 1
        ? [
            pBase.extremeProbabilityJustification ? `p_base: ${pBase.extremeProbabilityJustification}` : null,
            pQuant.extremeProbabilityJustification ? `p_quant: ${pQuant.extremeProbabilityJustification}` : null,
          ]
            .filter(Boolean)
            .join(' | ') || null
        : null;

    const ensembleMeta: EnsembleCombinationMetadata = Object.freeze({
      method: 'WEIGHTED_LINEAR',
      configuredWeights: Object.freeze({ ...configuredWeights }),
      effectiveWeights: Object.freeze({ p_base: effBase, p_quant: effQuant }),
      availableStages: Object.freeze(['p_base', 'p_quant'] as const),
      singleStageFallback: false,
      combinationNote: `WEIGHTED_LINEAR: ${effBase} * p_base + ${effQuant} * p_quant.`,
    });

    const combinedValidated = validateRawEstimatorOutput(
      {
        probability: combinedProb,
        uncertaintyInterval: combinedInterval,
        extremeProbabilityJustification: combinedJustification,
      },
      false
    );

    pEnsemble = buildForecastStageRecord(
      provenance,
      'p_ensemble',
      ensembleVersion,
      combinedValidated,
      {
        componentForecastIds: [pBase.forecastId, pQuant.forecastId],
        ensembleMetadata: ensembleMeta,
        extraSeed: `combined:${pBase.forecastId}:${pQuant.forecastId}`,
      }
    );
  }

  return Object.freeze({
    pBase,
    pQuant,
    pEnsemble,
    records: Object.freeze([pBase, pQuant, pEnsemble] as const),
  });
}

/**
 * Inserts a single immutable forecast record into `probability_forecasts`.
 * Strictly append-only: never updates or replaces existing rows.
 */
export function persistForecastRecord(db: DatabaseSync, record: ForecastRecord): void {
  db.prepare(
    `INSERT INTO probability_forecasts (
      forecast_id, experiment_id, market_id, event_id,
      event_family_id, event_family_derivation_version,
      forecast_stage, status, probability,
      uncertainty_lower, uncertainty_upper, uncertainty_method,
      extreme_probability_justified, extreme_probability_justification,
      abstention_reasons_json,
      model_version, config_hash, code_commit_hash,
      data_snapshot_id, base_rate_version, ensemble_version,
      rule_version_id, component_forecast_ids_json,
      ensemble_metadata_json, reference_class_json, feature_metadata_json,
      forecast_timestamp
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    record.forecastId,
    record.experimentId,
    record.marketId,
    record.eventId,
    record.eventFamilyId,
    record.eventFamilyDerivationVersion,
    record.forecastStage,
    record.status,
    record.probability,
    record.uncertaintyInterval?.lower ?? null,
    record.uncertaintyInterval?.upper ?? null,
    record.uncertaintyInterval?.method ?? null,
    record.extremeProbabilityJustified ? 1 : 0,
    record.extremeProbabilityJustification,
    JSON.stringify(record.abstentionReasons),
    record.modelVersion,
    record.configHash,
    record.codeCommitHash,
    record.dataSnapshotId,
    record.baseRateVersion,
    record.ensembleVersion,
    record.ruleVersionId,
    JSON.stringify(record.componentForecastIds),
    record.ensembleMetadata ? JSON.stringify(record.ensembleMetadata) : null,
    record.referenceClass ? JSON.stringify(record.referenceClass) : null,
    record.featureMetadata ? JSON.stringify(record.featureMetadata) : null,
    record.forecastTimestamp
  );
}

/**
 * Atomically appends a batch of immutable forecast stage records (`p_base`, `p_quant`, `p_ensemble`)
 * inside a `BEGIN IMMEDIATE` SQLite transaction.
 */
export function persistForecastBatch(
  db: DatabaseSync,
  records: readonly ForecastRecord[]
): number {
  if (records.length === 0) return 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const record of records) {
      persistForecastRecord(db, record);
    }
    db.exec('COMMIT');
    return records.length;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Ignore rollback failure
    }
    throw err;
  }
}

/**
 * Evaluates all three forecast stages (`p_base`, `p_quant`, `p_ensemble`) and persists
 * them atomically as separate immutable records in `probability_forecasts`.
 */
export function runPriceBlindForecast(
  input: RunPriceBlindForecastInput
): ForecastEvaluationResult {
  const result = evaluatePriceBlindForecast(input);
  persistForecastBatch(input.db, result.records);
  return result;
}

interface RawProbabilityForecastRow {
  forecast_id: string;
  experiment_id: string;
  market_id: string;
  event_id: string;
  event_family_id: string;
  event_family_derivation_version: string;
  forecast_stage: ForecastStage;
  status: 'FORECAST' | 'ABSTAINED';
  probability: number | null;
  uncertainty_lower: number | null;
  uncertainty_upper: number | null;
  uncertainty_method: string | null;
  extreme_probability_justified: number;
  extreme_probability_justification: string | null;
  abstention_reasons_json: string;
  model_version: string;
  config_hash: string;
  code_commit_hash: string;
  data_snapshot_id: string;
  base_rate_version: string;
  ensemble_version: string;
  rule_version_id: string | null;
  component_forecast_ids_json: string;
  ensemble_metadata_json: string | null;
  reference_class_json: string | null;
  feature_metadata_json: string | null;
  forecast_timestamp: string;
}

function mapRawForecastRow(row: RawProbabilityForecastRow): ForecastRecord {
  const uncertaintyInterval: UncertaintyInterval | null =
    row.uncertainty_lower !== null &&
    row.uncertainty_upper !== null &&
    row.uncertainty_method !== null
      ? Object.freeze({
          lower: Number(row.uncertainty_lower),
          upper: Number(row.uncertainty_upper),
          method: row.uncertainty_method,
        })
      : null;

  return Object.freeze({
    forecastId: row.forecast_id,
    experimentId: row.experiment_id,
    marketId: row.market_id,
    eventId: row.event_id,
    eventFamilyId: row.event_family_id,
    eventFamilyDerivationVersion: row.event_family_derivation_version,
    forecastStage: row.forecast_stage,
    status: row.status,
    probability: row.probability === null ? null : Number(row.probability),
    uncertaintyInterval,
    extremeProbabilityJustified: Number(row.extreme_probability_justified) === 1,
    extremeProbabilityJustification: row.extreme_probability_justification,
    abstentionReasons: Object.freeze(
      JSON.parse(row.abstention_reasons_json) as ForecastAbstentionReason[]
    ),
    modelVersion: row.model_version,
    configHash: row.config_hash,
    codeCommitHash: row.code_commit_hash,
    dataSnapshotId: row.data_snapshot_id,
    baseRateVersion: row.base_rate_version,
    ensembleVersion: row.ensemble_version,
    ruleVersionId: row.rule_version_id,
    componentForecastIds: Object.freeze(
      JSON.parse(row.component_forecast_ids_json) as string[]
    ),
    ensembleMetadata: row.ensemble_metadata_json
      ? Object.freeze(JSON.parse(row.ensemble_metadata_json) as EnsembleCombinationMetadata)
      : null,
    referenceClass: row.reference_class_json
      ? Object.freeze(JSON.parse(row.reference_class_json) as ReferenceClass)
      : null,
    featureMetadata: row.feature_metadata_json
      ? Object.freeze(JSON.parse(row.feature_metadata_json) as Record<string, unknown>)
      : null,
    forecastTimestamp: row.forecast_timestamp,
  });
}

/**
 * Queries persisted immutable forecast records for a market in chronological order.
 */
export function listForecastsForMarket(
  db: DatabaseSync,
  marketId: string
): ForecastRecord[] {
  const rows = db
    .prepare(
      `SELECT
        forecast_id, experiment_id, market_id, event_id,
        event_family_id, event_family_derivation_version,
        forecast_stage, status, probability,
        uncertainty_lower, uncertainty_upper, uncertainty_method,
        extreme_probability_justified, extreme_probability_justification,
        abstention_reasons_json,
        model_version, config_hash, code_commit_hash,
        data_snapshot_id, base_rate_version, ensemble_version,
        rule_version_id, component_forecast_ids_json,
        ensemble_metadata_json, reference_class_json, feature_metadata_json,
        forecast_timestamp
      FROM probability_forecasts
      WHERE market_id = ?
      ORDER BY forecast_timestamp ASC, rowid ASC`
    )
    .all(marketId) as unknown as RawProbabilityForecastRow[];

  return rows.map(mapRawForecastRow);
}
