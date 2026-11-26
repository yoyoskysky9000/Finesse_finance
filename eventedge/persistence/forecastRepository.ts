import type { DatabaseSync } from 'node:sqlite';
import { getExperiment } from '../experiments/registry';
import {
  FORECAST_STAGES,
  FORECAST_STATUSES,
  listForecastsForMarket,
  persistForecastRecord,
  type EnsembleCombinationMetadata,
  type ForecastAbstentionReason,
  type ForecastRecord,
  type ReferenceClass,
  type UncertaintyInterval,
} from '../forecasting/index';
import {
  FORECAST_ELIGIBLE_LIFECYCLE_STATES,
  getContractLifecycleState,
  type ContractLifecycleState,
} from '../lifecycle/contractLifecycle';

export const PERSISTED_FORECAST_STAGES = [...FORECAST_STAGES, 'p_calibrated'] as const;
export type PersistedForecastStage = (typeof PERSISTED_FORECAST_STAGES)[number];

export interface PersistedForecastRecord extends Omit<ForecastRecord, 'forecastStage'> {
  readonly forecastStage: PersistedForecastStage;
}

/**
 * Thrown by `saveForecast` when `record.experimentId` does not exist in `experiments`.
 */
export class UnregisteredExperimentError extends Error {
  public readonly code = 'EVENTEDGE_UNREGISTERED_EXPERIMENT' as const;
  public readonly experimentId: string;

  constructor(experimentId: string) {
    super(
      `Cannot persist forecast: experiment "${experimentId}" is not registered in the EventEdge experiment registry.`
    );
    this.name = 'UnregisteredExperimentError';
    this.experimentId = experimentId;
  }
}

/**
 * Thrown by `saveForecast` when the contract's current lifecycle state is not APPROVED (or later).
 */
export class ContractNotEligibleForForecastError extends Error {
  public readonly code = 'EVENTEDGE_CONTRACT_NOT_ELIGIBLE_FOR_FORECAST' as const;
  public readonly marketId: string;
  public readonly currentState: ContractLifecycleState | null;

  constructor(marketId: string, currentState: ContractLifecycleState | null) {
    super(
      `Cannot persist forecast for contract "${marketId}": lifecycle state is "${
        currentState ?? 'UNTRACKED'
      }" (must be APPROVED or later eligible state).`
    );
    this.name = 'ContractNotEligibleForForecastError';
    this.marketId = marketId;
    this.currentState = currentState;
  }
}

/**
 * Thrown by `saveForecast` when a forecast record violates any EE-02 output or provenance invariant
 * re-checked at the persistence boundary.
 */
export class ForecastInvariantViolationError extends Error {
  public readonly code = 'EVENTEDGE_FORECAST_INVARIANT_VIOLATION' as const;
  public readonly violations: readonly string[];

  constructor(violations: readonly string[]) {
    super(`Forecast record failed EE-02 persistence invariants: ${violations.join('; ')}`);
    this.name = 'ForecastInvariantViolationError';
    this.violations = Object.freeze([...violations]);
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Re-validates all EE-02 output & provenance invariants at the persistence boundary.
 * Throws `ForecastInvariantViolationError` if any invariant fails.
 */
export function assertForecastRecordInvariants(
  record: ForecastRecord | PersistedForecastRecord
): void {
  const violations: string[] = [];

  if (!record || typeof record !== 'object') {
    throw new ForecastInvariantViolationError(['Forecast record must be an object.']);
  }

  // Provenance completeness
  const requiredStringFields: ReadonlyArray<keyof PersistedForecastRecord> = [
    'forecastId',
    'experimentId',
    'marketId',
    'eventId',
    'eventFamilyId',
    'eventFamilyDerivationVersion',
    'modelVersion',
    'configHash',
    'codeCommitHash',
    'dataSnapshotId',
    'baseRateVersion',
    'ensembleVersion',
    'forecastTimestamp',
  ];
  for (const field of requiredStringFields) {
    if (!isNonEmptyString(record[field])) {
      violations.push(`Missing or empty provenance field "${field}".`);
    }
  }

  if (!PERSISTED_FORECAST_STAGES.includes(record.forecastStage)) {
    violations.push(`Invalid forecastStage "${String(record.forecastStage)}".`);
  }

  if (record.forecastStage === 'p_calibrated') {
    const calMeta =
      record.featureMetadata &&
      typeof record.featureMetadata === 'object' &&
      'calibration' in record.featureMetadata &&
      record.featureMetadata.calibration &&
      typeof record.featureMetadata.calibration === 'object'
        ? (record.featureMetadata.calibration as Record<string, unknown>)
        : null;

    const sourceForecastId =
      Array.isArray(record.componentForecastIds) && record.componentForecastIds.length > 0
        ? record.componentForecastIds[0]
        : null;

    if (!isNonEmptyString(sourceForecastId)) {
      violations.push('p_calibrated record must list its source forecast_id in componentForecastIds.');
    }
    if (!calMeta) {
      violations.push('p_calibrated record must include featureMetadata.calibration provenance.');
    } else {
      if (!isNonEmptyString(calMeta.method)) {
        violations.push('p_calibrated provenance must name calibration method.');
      }
      if (!isNonEmptyString(calMeta.sourceForecastId) || calMeta.sourceForecastId !== sourceForecastId) {
        violations.push(
          'p_calibrated provenance sourceForecastId must be non-empty and match componentForecastIds[0].'
        );
      }
      const trainWindow = calMeta.trainWindow as Record<string, unknown> | null | undefined;
      const valWindow = calMeta.validationWindow as Record<string, unknown> | null | undefined;
      if (
        !trainWindow ||
        typeof trainWindow !== 'object' ||
        !isNonEmptyString(trainWindow.start) ||
        !isNonEmptyString(trainWindow.end)
      ) {
        violations.push('p_calibrated provenance must include trainWindow { start, end }.');
      }
      if (
        !valWindow ||
        typeof valWindow !== 'object' ||
        !isNonEmptyString(valWindow.start) ||
        !isNonEmptyString(valWindow.end)
      ) {
        violations.push('p_calibrated provenance must include validationWindow { start, end }.');
      }
    }
  }

  if (!FORECAST_STATUSES.includes(record.status)) {
    violations.push(`Invalid forecast status "${String(record.status)}".`);
  }

  if (record.status === 'ABSTAINED') {
    if (record.probability !== null) {
      violations.push(
        `ABSTAINED forecast must have probability === null (received ${String(record.probability)}).`
      );
    }
    if (record.uncertaintyInterval !== null) {
      violations.push('ABSTAINED forecast must have uncertaintyInterval === null.');
    }
    if (record.extremeProbabilityJustified !== false) {
      violations.push('ABSTAINED forecast must not set extremeProbabilityJustified = true.');
    }
    if (!Array.isArray(record.abstentionReasons) || record.abstentionReasons.length === 0) {
      violations.push('ABSTAINED forecast must include at least one machine-readable abstention reason.');
    }
  } else if (record.status === 'FORECAST') {
    const p = record.probability;
    if (typeof p !== 'number' || Number.isNaN(p) || !Number.isFinite(p)) {
      violations.push(`FORECAST probability must be a finite number (received ${String(p)}).`);
    } else {
      if (p < 0 || p > 1) {
        violations.push(`FORECAST probability must be within [0, 1] (received ${p}).`);
      } else if (p === 0 || p === 1) {
        if (
          record.extremeProbabilityJustified !== true ||
          !isNonEmptyString(record.extremeProbabilityJustification)
        ) {
          violations.push(
            `Exact extreme probability (${p}) requires extremeProbabilityJustified=true and a non-empty justification.`
          );
        }
      } else if (record.extremeProbabilityJustified === true) {
        violations.push(
          `Non-extreme probability (${p}) must not set extremeProbabilityJustified=true.`
        );
      }

      if (record.uncertaintyInterval !== null && record.uncertaintyInterval !== undefined) {
        const iv = record.uncertaintyInterval;
        const validLower =
          typeof iv.lower === 'number' && Number.isFinite(iv.lower) && iv.lower >= 0 && iv.lower <= 1;
        const validUpper =
          typeof iv.upper === 'number' && Number.isFinite(iv.upper) && iv.upper >= 0 && iv.upper <= 1;
        if (
          !validLower ||
          !validUpper ||
          !isNonEmptyString(iv.method) ||
          iv.lower > iv.upper ||
          p < iv.lower ||
          p > iv.upper
        ) {
          violations.push(
            `Invalid uncertaintyInterval [${String(iv.lower)}, ${String(iv.upper)}] for probability ${p}.`
          );
        }
      } else if (record.forecastStage === 'p_base') {
        violations.push('p_base FORECAST record must include a valid uncertaintyInterval.');
      }
    }

    if (Array.isArray(record.abstentionReasons) && record.abstentionReasons.length > 0) {
      violations.push('FORECAST record must not carry non-empty abstentionReasons.');
    }
  }

  if (violations.length > 0) {
    throw new ForecastInvariantViolationError(violations);
  }
}

interface RawProbabilityForecastRow {
  forecast_id: string;
  experiment_id: string;
  market_id: string;
  event_id: string;
  event_family_id: string;
  event_family_derivation_version: string;
  forecast_stage: PersistedForecastStage;
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

function mapRawForecastRow(row: RawProbabilityForecastRow): PersistedForecastRecord {
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
 * Append-only persistence of one EE-02 stage forecast record into `probability_forecasts`.
 *
 * Enforces three mandatory guards before writing:
 * 1. Re-validates all EE-02 invariants (`ForecastInvariantViolationError`).
 * 2. Requires `record.experimentId` to exist in `experiments` (`UnregisteredExperimentError`).
 * 3. Requires `record.marketId` to be in an `APPROVED` (or later eligible) lifecycle state
 *    (`ContractNotEligibleForForecastError`).
 *
 * No update or delete operations exist on this repository.
 */
export function saveForecast<T extends ForecastRecord | PersistedForecastRecord>(
  db: DatabaseSync,
  record: T
): T {
  // 1. Re-check EE-02 invariants at the persistence boundary
  assertForecastRecordInvariants(record);

  // 2. Verify experiment_id exists in the experiment registry
  const experiment = getExperiment(db, record.experimentId);
  if (!experiment) {
    throw new UnregisteredExperimentError(record.experimentId);
  }

  // 3. Verify contract lifecycle state is APPROVED (or later eligible state)
  const lifecycleState = getContractLifecycleState(db, record.marketId);
  if (lifecycleState === null || !FORECAST_ELIGIBLE_LIFECYCLE_STATES.has(lifecycleState)) {
    throw new ContractNotEligibleForForecastError(record.marketId, lifecycleState);
  }

  // 4. Append-only parameterized insert into probability_forecasts
  persistForecastRecord(db, record as ForecastRecord);
  return record;
}

/**
 * Returns all immutable forecast stage records persisted for a market in chronological order.
 */
export function getForecastsForMarket(
  db: DatabaseSync,
  marketId: string
): PersistedForecastRecord[] {
  return listForecastsForMarket(db, marketId) as unknown as PersistedForecastRecord[];
}

/**
 * Returns all immutable forecast stage records persisted under a given registered experiment.
 */
export function getForecastsForExperiment(
  db: DatabaseSync,
  experimentId: string
): PersistedForecastRecord[] {
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
      WHERE experiment_id = ?
      ORDER BY forecast_timestamp ASC, rowid ASC`
    )
    .all(experimentId.trim()) as unknown as RawProbabilityForecastRow[];

  return rows.map(mapRawForecastRow);
}

/**
 * Returns the latest `p_ensemble` record persisted for a market, or `null` if none exists.
 */
export function getEnsembleForMarket(
  db: DatabaseSync,
  marketId: string
): ForecastRecord | null {
  const row = db
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
      WHERE market_id = ? AND forecast_stage = 'p_ensemble'
      ORDER BY forecast_timestamp DESC, rowid DESC
      LIMIT 1`
    )
    .get(marketId.trim()) as unknown as RawProbabilityForecastRow | undefined;

  return row ? (mapRawForecastRow(row) as ForecastRecord) : null;
}

export interface ForecastRepository {
  readonly saveForecast: <T extends ForecastRecord | PersistedForecastRecord>(record: T) => T;
  readonly getForecastsForMarket: (marketId: string) => PersistedForecastRecord[];
  readonly getForecastsForExperiment: (experimentId: string) => PersistedForecastRecord[];
  readonly getEnsembleForMarket: (marketId: string) => ForecastRecord | null;
}

/**
 * Creates a bound, append-only `ForecastRepository` instance exposing strictly
 * save/read operations (no update or delete methods exist).
 */
export function createForecastRepository(db: DatabaseSync): ForecastRepository {
  return Object.freeze({
    saveForecast: <T extends ForecastRecord | PersistedForecastRecord>(record: T) =>
      saveForecast(db, record),
    getForecastsForMarket: (marketId: string) => getForecastsForMarket(db, marketId),
    getForecastsForExperiment: (experimentId: string) =>
      getForecastsForExperiment(db, experimentId),
    getEnsembleForMarket: (marketId: string) => getEnsembleForMarket(db, marketId),
  });
}
