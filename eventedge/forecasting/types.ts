/**
 * Pure price-blind domain types for the EventEdge EE-02 probability engine.
 *
 * STRUCTURAL ISOLATION CONTRACT:
 * This module must NEVER import market-price, orderbook, discovery-client,
 * or execution modules. Contracts enter strictly as price-blind metadata.
 */

export const FORECAST_STAGES = ['p_base', 'p_quant', 'p_ensemble'] as const;
export type ForecastStage = (typeof FORECAST_STAGES)[number];

export const FORECAST_STATUSES = ['FORECAST', 'ABSTAINED'] as const;
export type ForecastStatus = (typeof FORECAST_STATUSES)[number];

export const FORECAST_ABSTENTION_REASON_CODES = [
  'CONTRACT_NOT_APPROVED_CLEAR',
  'MISSING_REFERENCE_CLASS',
  'INVALID_REFERENCE_CLASS',
  'INSUFFICIENT_SAMPLE_SIZE',
  'MISSING_BASE_RATE_ESTIMATOR',
  'MISSING_QUANT_ESTIMATOR',
  'MISSING_RESEARCH_SNAPSHOT',
  'MISSING_REQUIRED_FEATURE',
  'INVALID_FEATURE_VALUE',
  'FORBIDDEN_PRICE_FEATURE_REQUESTED',
  'ESTIMATOR_THREW_ERROR',
  'ESTIMATOR_OUTPUT_MISSING',
  'ESTIMATOR_OUTPUT_NAN',
  'ESTIMATOR_OUTPUT_INFINITE',
  'ESTIMATOR_OUTPUT_OUT_OF_RANGE',
  'UNJUSTIFIED_EXTREME_PROBABILITY',
  'INVALID_UNCERTAINTY_INTERVAL',
  'NO_AVAILABLE_STAGE_ESTIMATES',
  'ESTIMATOR_ABSTAINED',
] as const;

export type ForecastAbstentionReasonCode = (typeof FORECAST_ABSTENTION_REASON_CODES)[number];

export interface ForecastAbstentionReason {
  readonly code: ForecastAbstentionReasonCode;
  readonly detail: string;
}

export interface UncertaintyInterval {
  readonly lower: number;
  readonly upper: number;
  readonly method: string;
  readonly confidenceLevel?: number;
}

/**
 * Price-blind representation of an EE-01 APPROVED (CLEAR) contract.
 * Contains ZERO bid/ask/last prices, ZERO volume/open-interest, and ZERO orderbook data.
 */
export interface ApprovedContractInput {
  readonly marketId: string;
  readonly eventId: string;
  readonly eventFamilyId?: string | null;
  readonly eventFamilyDerivationVersion?: string | null;
  readonly category: string | null;
  readonly marketTerms: string | null;
  readonly closeTimeUtc: string | null;
  readonly expirationTimeUtc: string | null;
  readonly ruleVersionId?: string | null;
  readonly ruleHash?: string | null;
  readonly settlementSource: string;
  readonly auditStatus: 'CLEAR' | 'AMBIGUOUS';
}

/**
 * Structured historical reference class input for `BaseRateEstimator` (`p_base`).
 */
export interface ReferenceClass {
  readonly definition: string;
  readonly inclusionCriteria: string;
  readonly sampleCount: number;
  readonly positiveCount: number;
  readonly timeWindow: string;
  readonly source: string;
}

/**
 * Raw research data snapshot supplied by caller.
 * Any accidental market-price or orderbook fields are stripped structurally
 * by `sanitizeResearchSnapshotPriceBlind` before any estimator runs.
 */
export interface ResearchDataSnapshot {
  readonly dataSnapshotId: string;
  readonly capturedAt: string;
  readonly features: Readonly<Record<string, unknown>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly [extraKey: string]: unknown;
}

/**
 * Price-blind sanitized research snapshot passed into quantitative estimators.
 */
export interface SanitizedResearchSnapshot {
  readonly dataSnapshotId: string;
  readonly capturedAt: string;
  readonly features: Readonly<Record<string, unknown>>;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly strippedPriceKeysCount: number;
}

/**
 * Raw output returned by a `BaseRateEstimator` or `QuantitativeEstimator`
 * prior to invariant validation by the engine.
 */
export interface RawEstimatorOutput {
  readonly abstained?: boolean;
  readonly abstentionReasons?: readonly ForecastAbstentionReason[];
  readonly probability?: number;
  readonly uncertaintyInterval?: UncertaintyInterval | null;
  /**
   * Required non-empty justification string if and only if `probability === 0` or `probability === 1`.
   * Exact 0 or 1 without an explicit justification is rejected into ABSTAINED (never clamped).
   */
  readonly extremeProbabilityJustification?: string | null;
  readonly featureMetadata?: Readonly<Record<string, unknown>> | null;
}

export interface BaseRateEstimator {
  readonly id: string;
  readonly version: string;
  readonly isReferenceOnly?: boolean;
  estimate(input: {
    readonly contract: ApprovedContractInput;
    readonly referenceClass: ReferenceClass;
    readonly minSampleCount: number;
  }): RawEstimatorOutput;
}

export interface QuantitativeEstimator {
  readonly id: string;
  readonly version: string;
  readonly isReferenceOnly?: boolean;
  estimate(input: {
    readonly contract: ApprovedContractInput;
    readonly snapshot: SanitizedResearchSnapshot;
  }): RawEstimatorOutput;
}

export interface EnsembleCombinationMetadata {
  readonly method: 'WEIGHTED_LINEAR';
  readonly configuredWeights: Readonly<{ p_base: number; p_quant: number }>;
  readonly effectiveWeights: Readonly<{ p_base: number; p_quant: number }>;
  readonly availableStages: readonly ('p_base' | 'p_quant')[];
  readonly singleStageFallback: boolean;
  readonly combinationNote: string;
}

/**
 * Immutable, fully provenanced probability forecast record for a single stage
 * (`p_base`, `p_quant`, or `p_ensemble`).
 */
export interface ForecastRecord {
  readonly forecastId: string;
  readonly experimentId: string;
  readonly marketId: string;
  readonly eventId: string;
  readonly eventFamilyId: string;
  readonly eventFamilyDerivationVersion: string;
  readonly forecastStage: ForecastStage;
  readonly status: ForecastStatus;
  readonly probability: number | null;
  readonly uncertaintyInterval: UncertaintyInterval | null;
  readonly extremeProbabilityJustified: boolean;
  readonly extremeProbabilityJustification: string | null;
  readonly abstentionReasons: readonly ForecastAbstentionReason[];
  readonly modelVersion: string;
  readonly configHash: string;
  readonly codeCommitHash: string;
  readonly dataSnapshotId: string;
  readonly baseRateVersion: string;
  readonly ensembleVersion: string;
  readonly ruleVersionId: string | null;
  readonly componentForecastIds: readonly string[];
  readonly ensembleMetadata: EnsembleCombinationMetadata | null;
  readonly referenceClass: ReferenceClass | null;
  readonly featureMetadata: Readonly<Record<string, unknown>> | null;
  readonly forecastTimestamp: string;
}

export interface ForecastEvaluationResult {
  readonly pBase: ForecastRecord;
  readonly pQuant: ForecastRecord;
  readonly pEnsemble: ForecastRecord;
  readonly records: readonly [ForecastRecord, ForecastRecord, ForecastRecord];
}
