import type { DatabaseSync } from 'node:sqlite';
import {
  getForecastsForMarket,
  saveForecast,
  type PersistedForecastRecord,
} from '../persistence/forecastRepository';
import {
  buildCalibratedForecastRecord,
  runTemporallyIsolatedCalibration,
} from './calibration';
import { assembleExperimentEvaluationSet } from './outcomeJoin';
import {
  computeClusterBootstrapBrierDiffCI,
  scorePairedSamples,
  scorePairedSamplesByFamily,
} from './scoring';
import {
  DEFAULT_CALIBRATION_SPLIT_FRACTIONS,
  DEFAULT_CLUSTER_BOOTSTRAP_ITERATIONS,
  LOG_LOSS_PROBABILITY_CLIP_EPSILON,
  type EvaluateExperimentOptions,
  type ExperimentEvaluationReport,
  type GateVerdict,
  type KillGateEvaluation,
} from './types';

/**
 * Evaluates a registered EventEdge experiment (EE-03 registry) against settled binary outcomes
 * and timestamp-matched market reference snapshots, runs temporally isolated calibration,
 * persists forward-segment `p_calibrated` records via the EE-03 persistence layer, and
 * computes the structured kill-gate report.
 *
 * Gate Verdict Logic (zero invented thresholds — reads registered `sample_definition` / `kill_criteria`):
 * - `INSUFFICIENT_DATA` if the settled forecasted sample is below the experiment's registered
 *   `sample_definition` minimum (or if forward test / clustered CI cannot be formed).
 * - `PASS` ONLY IF:
 *     1. Model's forward Brier is strictly below the market reference Brier on the exact same
 *        forward-test sample, AND
 *     2. The upper bound of the clustered 95% CI for `(model Brier - market Brier)` is strictly `< 0`.
 * - `FAIL` otherwise.
 */
export function evaluateExperiment(
  db: DatabaseSync,
  experimentId: string,
  options: EvaluateExperimentOptions = {}
): ExperimentEvaluationReport {
  const splitFractions = options.splitFractions ?? DEFAULT_CALIBRATION_SPLIT_FRACTIONS;
  const bootstrapIterations = options.bootstrapIterations ?? DEFAULT_CLUSTER_BOOTSTRAP_ITERATIONS;
  const logLossClipEpsilon = options.logLossClipEpsilon ?? LOG_LOSS_PROBABILITY_CLIP_EPSILON;
  const persistCalibrated = options.persistCalibratedForecasts ?? true;
  const calibratedAt = options.calibratedAt?.trim() || new Date().toISOString();

  // 1. Outcome join + denominator accounting
  const joined = assembleExperimentEvaluationSet(db, experimentId);

  // 2. Pooled & per-family scoring on the identical settled sample
  const pooledScoring = scorePairedSamples(joined.scoredSamples, logLossClipEpsilon);
  const scoringByFamily = scorePairedSamplesByFamily(joined.scoredSamples, logLossClipEpsilon);

  // 3. Clustered 95% bootstrap CI for (model Brier - market Brier), resampling event_family_id
  const clusterBootstrapBrierDiff = computeClusterBootstrapBrierDiffCI(
    joined.scoredSamples,
    joined.experiment.experimentId,
    { iterations: bootstrapIterations, confidenceLevel: 0.95 }
  );

  // 4. Temporally isolated calibration (train -> validation selection -> frozen forward test)
  const calibrationInput = joined.scoredSamples.map((row) => ({
    forecastTimestamp: row.forecastTimestamp,
    probability: row.modelProbability,
    outcome: row.outcome,
    forecastId: row.forecastId,
    marketId: row.marketId,
    marketReferenceProbability: row.marketReferenceProbability,
  }));

  const calibration = runTemporallyIsolatedCalibration(calibrationInput, {
    splitFractions,
    logLossClipEpsilon,
  });

  // 5. Write back forward-segment `p_calibrated` records via EE-03 persistence layer
  const persistedCalibratedForecasts: PersistedForecastRecord[] = [];
  if (
    persistCalibrated &&
    calibration.status === 'COMPLETED' &&
    calibration.selectedMethod !== null &&
    calibration.selectedParameters !== null &&
    calibration.trainWindow !== null &&
    calibration.validationWindow !== null &&
    calibration.forwardTestWindow !== null
  ) {
    const sourceByForecastId = new Map(
      joined.scoredSamples.map((row) => [row.forecastId, row.sourceForecast])
    );

    for (const pred of calibration.forwardPredictions) {
      const sourceForecast = sourceByForecastId.get(pred.forecastId);
      if (!sourceForecast) {
        continue;
      }

      const calibratedRecord = buildCalibratedForecastRecord({
        sourceForecast,
        calibratedProbability: pred.calibratedProbability,
        method: calibration.selectedMethod,
        parameters: calibration.selectedParameters,
        trainWindow: calibration.trainWindow,
        validationWindow: calibration.validationWindow,
        forwardTestWindow: calibration.forwardTestWindow,
        calibratedAt,
      });

      // Append-only idempotency check: if this exact deterministic forecastId already exists,
      // return the existing immutable row without touching or mutating it.
      const existingForMarket = getForecastsForMarket(db, calibratedRecord.marketId);
      const alreadyPersisted = existingForMarket.find(
        (rec) => rec.forecastId === calibratedRecord.forecastId
      );

      if (alreadyPersisted) {
        persistedCalibratedForecasts.push(alreadyPersisted);
      } else {
        const saved = saveForecast(db, calibratedRecord);
        persistedCalibratedForecasts.push(saved);
      }
    }
  }

  // 6. Kill-gate verdict computed strictly from registered sample_definition & kill_criteria
  const requiredMinSettledSample = joined.parsedDefinition.minSettledSample ?? 1;
  const observedSettledForecastedSample = joined.denominatorTotals.settledForecasted;
  const observedSettledScoredSample = joined.denominatorTotals.settledScored;

  const modelForwardBrier = calibration.forwardTestCalibrated?.brierScore ?? null;
  const modelForwardRawBrier = calibration.forwardTestRaw?.brierScore ?? null;
  const marketForwardBrier = calibration.forwardTestMarketReference?.brierScore ?? null;
  const clusterBootstrapUpper95 = clusterBootstrapBrierDiff.upper;

  const forwardBrierStrictlyBelowMarket =
    modelForwardBrier !== null &&
    marketForwardBrier !== null &&
    modelForwardBrier < marketForwardBrier;

  const clusteredCiUpperBelowZero =
    clusterBootstrapUpper95 !== null && clusterBootstrapUpper95 < 0;

  const reasons: string[] = [];
  let verdict: GateVerdict;

  if (
    observedSettledForecastedSample < requiredMinSettledSample ||
    observedSettledScoredSample < requiredMinSettledSample
  ) {
    verdict = 'INSUFFICIENT_DATA';
    reasons.push(
      `Settled scored sample (${observedSettledScoredSample}; settled forecasted=${observedSettledForecastedSample}) is below registered sample_definition minimum (${requiredMinSettledSample}).`
    );
  } else if (
    calibration.status !== 'COMPLETED' ||
    modelForwardBrier === null ||
    marketForwardBrier === null ||
    clusterBootstrapUpper95 === null
  ) {
    verdict = 'INSUFFICIENT_DATA';
    reasons.push(
      calibration.skipReason ??
        'Forward test calibration or clustered bootstrap CI could not be computed on the available settled sample.'
    );
  } else if (forwardBrierStrictlyBelowMarket && clusteredCiUpperBelowZero) {
    verdict = 'PASS';
    reasons.push(
      `Forward calibrated Brier (${modelForwardBrier.toFixed(6)}) is strictly below market reference Brier (${marketForwardBrier.toFixed(6)}) on the identical forward sample, and clustered 95% CI upper bound (${clusterBootstrapUpper95.toFixed(6)}) < 0.`
    );
  } else {
    verdict = 'FAIL';
    if (!forwardBrierStrictlyBelowMarket) {
      reasons.push(
        `Forward calibrated Brier (${modelForwardBrier.toFixed(6)}) is NOT strictly below market reference Brier (${marketForwardBrier.toFixed(6)}).`
      );
    }
    if (!clusteredCiUpperBelowZero) {
      reasons.push(
        `Clustered 95% CI upper bound for (model Brier - market Brier) is ${clusterBootstrapUpper95.toFixed(6)} (must be < 0).`
      );
    }
  }

  const gate: KillGateEvaluation = Object.freeze({
    verdict,
    reasons: Object.freeze(reasons),
    registeredKillCriteria: joined.experiment.killCriteria,
    registeredSampleDefinition: joined.experiment.sampleDefinition,
    requiredMinSettledSample,
    observedSettledForecastedSample,
    observedSettledScoredSample,
    modelForwardBrier,
    modelForwardRawBrier,
    marketForwardBrier,
    clusterBootstrapUpper95,
    forwardBrierStrictlyBelowMarket,
    clusteredCiUpperBelowZero,
  });

  return Object.freeze({
    experimentId: joined.experiment.experimentId,
    experiment: joined.experiment,
    denominatorByFamily: joined.denominatorByFamily,
    denominatorTotals: joined.denominatorTotals,
    coverage: joined.denominatorTotals.coverage,
    disputedOrVoided: joined.disputedOrVoided,
    excludedMissingMarketReference: joined.excludedMissingMarketReference,
    abstainedMarkets: joined.abstainedMarkets,
    pooledScoring,
    scoringByFamily,
    clusterBootstrapBrierDiff,
    calibration,
    persistedCalibratedForecasts: Object.freeze(persistedCalibratedForecasts),
    gate,
  });
}

/**
 * Convenience factory binding a SQLite ledger handle to expose `evaluateExperiment(experimentId)`.
 */
export function createExperimentEvaluator(db: DatabaseSync): {
  readonly evaluateExperiment: (
    experimentId: string,
    options?: EvaluateExperimentOptions
  ) => ExperimentEvaluationReport;
} {
  return Object.freeze({
    evaluateExperiment: (experimentId: string, options?: EvaluateExperimentOptions) =>
      evaluateExperiment(db, experimentId, options),
  });
}
