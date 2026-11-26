import type { ExperimentRecord } from '../experiments/registry';
import type { ForecastRecord } from '../forecasting/types';
import type { ContractLifecycleState } from '../lifecycle/contractLifecycle';
import type { PersistedForecastRecord } from '../persistence/forecastRepository';

export const LOG_LOSS_PROBABILITY_CLIP_EPSILON = 1e-6 as const;
export const LOG_LOSS_PROBABILITY_CLIP_MIN = LOG_LOSS_PROBABILITY_CLIP_EPSILON;
export const LOG_LOSS_PROBABILITY_CLIP_MAX = 1 - LOG_LOSS_PROBABILITY_CLIP_EPSILON;

export const CALIBRATION_METHOD_ORDER = ['beta', 'platt', 'temperature'] as const;
export type CalibrationMethod = (typeof CALIBRATION_METHOD_ORDER)[number];

export const DEFAULT_CALIBRATION_SPLIT_FRACTIONS = Object.freeze({
  trainFraction: 0.5,
  validationFraction: 0.25,
  testFraction: 0.25,
});

export const DEFAULT_CLUSTER_BOOTSTRAP_ITERATIONS = 2000 as const;

export const GATE_VERDICTS = ['PASS', 'FAIL', 'INSUFFICIENT_DATA'] as const;
export type GateVerdict = (typeof GATE_VERDICTS)[number];

export type BinaryOutcome = 0 | 1;

export type MarketReferenceMethod = 'YES_MID' | 'YES_ASK';

export interface LogLossClipReport {
  readonly epsilon: number;
  readonly min: number;
  readonly max: number;
  readonly clippedCount: number;
}

export interface ScoringMetrics {
  readonly count: number;
  readonly brierScore: number | null;
  readonly logLoss: number | null;
  readonly logLossClip: LogLossClipReport;
}

export interface PairedScoringSample {
  readonly marketId: string;
  readonly eventFamilyId: string;
  readonly forecastId: string;
  readonly forecastTimestamp: string;
  readonly modelProbability: number;
  readonly marketReferenceProbability: number;
  readonly outcome: BinaryOutcome;
}

export interface PairedScoringSummary {
  readonly sampleCount: number;
  readonly marketIds: readonly string[];
  readonly model: ScoringMetrics;
  readonly marketReference: ScoringMetrics;
  /** model.brierScore - marketReference.brierScore (negative means model beats market). */
  readonly brierDiff: number | null;
  /** model.logLoss - marketReference.logLoss (negative means model beats market). */
  readonly logLossDiff: number | null;
}

export interface EventFamilyScoringSummary extends PairedScoringSummary {
  readonly eventFamilyId: string;
}

export interface ClusterBootstrapOptions {
  readonly iterations?: number;
  readonly confidenceLevel?: number;
}

export interface ClusterBootstrapResult {
  readonly pointEstimate: number | null;
  readonly lower: number | null;
  readonly upper: number | null;
  readonly confidenceLevel: number;
  readonly iterations: number;
  readonly clusterCount: number;
  readonly sampleCount: number;
  readonly resampleUnit: 'event_family_id';
  readonly seedExperimentId: string;
  readonly seedHex: string;
  readonly distinctReplicateSampleSizes: readonly number[];
  readonly distinctReplicateValuesCount: number;
}

export interface ParsedSampleDefinition {
  readonly eventFamilies: readonly string[];
  readonly minSettledSample: number | null;
  readonly rawSampleDefinition: string;
  readonly rawKillCriteria: string;
}

export interface SettledEvaluationRow extends PairedScoringSample {
  readonly eventId: string;
  readonly settledAt: string;
  readonly settlementOutcome: 'YES' | 'NO';
  readonly marketSnapshotId: string;
  readonly marketSnapshotCapturedAt: string;
  readonly marketReferenceMethod: MarketReferenceMethod;
  readonly sourceForecast: ForecastRecord;
}

export interface ExcludedDisputedOrVoidedRow {
  readonly marketId: string;
  readonly eventFamilyId: string;
  readonly lifecycleState: ContractLifecycleState | null;
  readonly settlementOutcome: 'YES' | 'NO' | 'VOID' | 'CANCELLED' | null;
  readonly forecastId: string | null;
  readonly forecastStatus: 'FORECAST' | 'ABSTAINED' | null;
}

export interface ExcludedMissingMarketRefRow {
  readonly marketId: string;
  readonly eventFamilyId: string;
  readonly forecastId: string;
  readonly forecastTimestamp: string;
  readonly outcome: BinaryOutcome;
  readonly reason: string;
}

export interface AbstainedMarketRow {
  readonly marketId: string;
  readonly eventFamilyId: string;
  readonly forecastId: string;
  readonly forecastTimestamp: string;
  readonly lifecycleState: ContractLifecycleState | null;
  readonly abstentionReasonCodes: readonly string[];
}

export interface EventFamilyDenominatorReport {
  readonly eventFamilyId: string;
  readonly discovered: number;
  readonly rejectedByAudit: number;
  readonly abstained: number;
  readonly forecasted: number;
  readonly settled: number;
  readonly settledForecasted: number;
  readonly settledScored: number;
  readonly disputed: number;
  readonly voided: number;
  /** forecasted / discovered (0 when discovered === 0). */
  readonly coverage: number;
}

export interface DenominatorTotals {
  readonly discovered: number;
  readonly rejectedByAudit: number;
  readonly abstained: number;
  readonly forecasted: number;
  readonly settled: number;
  readonly settledForecasted: number;
  readonly settledScored: number;
  readonly disputed: number;
  readonly voided: number;
  /** forecasted / discovered (0 when discovered === 0). */
  readonly coverage: number;
}

export interface OutcomeJoinResult {
  readonly experiment: ExperimentRecord;
  readonly parsedDefinition: ParsedSampleDefinition;
  readonly eventFamilies: readonly string[];
  readonly scoredSamples: readonly SettledEvaluationRow[];
  readonly disputedOrVoided: readonly ExcludedDisputedOrVoidedRow[];
  readonly excludedMissingMarketReference: readonly ExcludedMissingMarketRefRow[];
  readonly abstainedMarkets: readonly AbstainedMarketRow[];
  readonly denominatorByFamily: readonly EventFamilyDenominatorReport[];
  readonly denominatorTotals: DenominatorTotals;
}

export interface CalibrationPoint {
  readonly forecastTimestamp: string;
  readonly probability: number;
  readonly outcome: BinaryOutcome;
  readonly forecastId?: string;
  readonly marketId?: string;
  readonly marketReferenceProbability?: number;
}

export interface CalibrationSplitFractions {
  readonly trainFraction: number;
  readonly validationFraction: number;
  readonly testFraction: number;
}

export interface TimeWindowSummary {
  readonly start: string;
  readonly end: string;
  readonly count: number;
}

export interface FittedCalibrator {
  readonly method: CalibrationMethod;
  readonly parameters: Readonly<Record<string, number>>;
  readonly trainSampleCount: number;
  transform(probability: number): number;
}

export interface ProbabilityCalibrator {
  readonly method: CalibrationMethod;
  fit(trainData: readonly CalibrationPoint[]): FittedCalibrator;
}

export interface CalibrationMethodValidationEntry {
  readonly method: CalibrationMethod;
  readonly validationBrier: number;
  readonly validationLogLoss: number;
  readonly parameters: Readonly<Record<string, number>>;
}

export interface CalibratedForwardPoint {
  readonly forecastId: string;
  readonly marketId: string;
  readonly forecastTimestamp: string;
  readonly rawProbability: number;
  readonly calibratedProbability: number;
  readonly outcome: BinaryOutcome;
  readonly marketReferenceProbability: number | null;
}

export interface TemporalCalibrationResult {
  readonly status: 'COMPLETED' | 'SKIPPED_INSUFFICIENT_DATA';
  readonly skipReason: string | null;
  readonly splitFractions: CalibrationSplitFractions;
  readonly trainWindow: TimeWindowSummary | null;
  readonly validationWindow: TimeWindowSummary | null;
  readonly forwardTestWindow: TimeWindowSummary | null;
  readonly validationResults: readonly CalibrationMethodValidationEntry[];
  readonly selectedMethod: CalibrationMethod | null;
  readonly selectedParameters: Readonly<Record<string, number>> | null;
  readonly forwardTestRaw: ScoringMetrics | null;
  readonly forwardTestCalibrated: ScoringMetrics | null;
  readonly forwardTestMarketReference: ScoringMetrics | null;
  readonly forwardPredictions: readonly CalibratedForwardPoint[];
}

export interface CalibrationProvenanceMetadata {
  readonly method: CalibrationMethod;
  readonly parameters: Readonly<Record<string, number>>;
  readonly sourceForecastId: string;
  readonly rawProbability: number;
  readonly trainWindow: TimeWindowSummary;
  readonly validationWindow: TimeWindowSummary;
  readonly forwardTestWindow: TimeWindowSummary;
  readonly calibratedAt: string;
}

export interface EvaluateExperimentOptions {
  readonly splitFractions?: CalibrationSplitFractions;
  readonly bootstrapIterations?: number;
  readonly logLossClipEpsilon?: number;
  readonly persistCalibratedForecasts?: boolean;
  readonly calibratedAt?: string;
}

export interface KillGateEvaluation {
  readonly verdict: GateVerdict;
  readonly reasons: readonly string[];
  readonly registeredKillCriteria: string;
  readonly registeredSampleDefinition: string;
  readonly requiredMinSettledSample: number;
  readonly observedSettledForecastedSample: number;
  readonly observedSettledScoredSample: number;
  readonly modelForwardBrier: number | null;
  readonly modelForwardRawBrier: number | null;
  readonly marketForwardBrier: number | null;
  readonly clusterBootstrapUpper95: number | null;
  readonly forwardBrierStrictlyBelowMarket: boolean;
  readonly clusteredCiUpperBelowZero: boolean;
}

export interface ExperimentEvaluationReport {
  readonly experimentId: string;
  readonly experiment: ExperimentRecord;
  readonly denominatorByFamily: readonly EventFamilyDenominatorReport[];
  readonly denominatorTotals: DenominatorTotals;
  readonly coverage: number;
  readonly disputedOrVoided: readonly ExcludedDisputedOrVoidedRow[];
  readonly excludedMissingMarketReference: readonly ExcludedMissingMarketRefRow[];
  readonly abstainedMarkets: readonly AbstainedMarketRow[];
  readonly pooledScoring: PairedScoringSummary;
  readonly scoringByFamily: readonly EventFamilyScoringSummary[];
  readonly clusterBootstrapBrierDiff: ClusterBootstrapResult;
  readonly calibration: TemporalCalibrationResult;
  readonly persistedCalibratedForecasts: readonly PersistedForecastRecord[];
  readonly gate: KillGateEvaluation;
}
