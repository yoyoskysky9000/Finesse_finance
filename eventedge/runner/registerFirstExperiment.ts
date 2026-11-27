import type { DatabaseSync } from 'node:sqlite';
import {
  EventEdgeLiveModeDisabledError,
  assertNonLiveMode,
  computeEventEdgeConfigHash,
  createEventEdgeConfig,
  type EventEdgeConfig,
} from '../config/index';
import {
  getExperiment,
  registerExperiment,
  type ExperimentRecord,
  type ExperimentStatus,
} from '../experiments/registry';

export const FIRST_EXPERIMENT_ID = 'EE-V1-BASERATE-01' as const;

export const FIRST_EXPERIMENT_DEFAULT_PAPER_BANKROLL_USD = 10_000 as const;

export interface PreRegisteredExperimentSpec {
  readonly experimentId: typeof FIRST_EXPERIMENT_ID;
  readonly experiment_id: typeof FIRST_EXPERIMENT_ID;
  readonly title: string;
  readonly hypothesis: string;
  readonly sampleDefinition: string;
  readonly sample_definition: string;
  readonly killCriteria: string;
  readonly kill_criteria: string;
  readonly initialStatus: Extract<ExperimentStatus, 'REGISTERED'>;
  readonly defaultPaperBankrollUsd: number;
  readonly notes: string;
}

const FIRST_EXPERIMENT_TITLE =
  'EventEdge v1 — reference base-rate ensemble vs market (frozen)';

const FIRST_EXPERIMENT_HYPOTHESIS =
  'The EE-02 reference ensemble (base-rate + fixed-transform quant, 50/50) produces probability forecasts whose Brier score on settled Kalshi markets beats the timestamp-matched market reference on the same sample.';

const FIRST_EXPERIMENT_SAMPLE_DEFINITION =
  'All markets discovered by the EE-01 config (14-day horizon, sports and entertainment-awards excluded) that reach APPROVED and settle during the window. The frozen sample closes at the first of: 100 settled forecasted markets, or 90 days from the RUNNING transition. The denominator includes discovered, audit-rejected, and abstained markets.';

const FIRST_EXPERIMENT_KILL_CRITERIA =
  'KILLED (hypothesis failed) if, on the frozen sample, the EE-04 gate verdict is FAIL: model forward Brier not strictly below market Brier, or the clustered 95% CI upper bound for (model - market) Brier is not below 0. PASS requires both conditions. INSUFFICIENT_DATA at sample close also closes the experiment as KILLED with reason INSUFFICIENT_DATA. No retuning, reweighting, or threshold change is permitted inside this experiment; any change requires a new experiment_id and fresh data.';

/**
 * Pre-registered frozen specification for the first EventEdge paper validation study.
 *
 * `model_version` and `config_hash` are deliberately NOT hard-coded here: they are
 * derived deterministically from the active `EventEdgeConfig` at registration time by
 * `registerFirstExperiment(db)`.
 */
export const FIRST_EXPERIMENT: PreRegisteredExperimentSpec = Object.freeze({
  experimentId: FIRST_EXPERIMENT_ID,
  experiment_id: FIRST_EXPERIMENT_ID,
  title: FIRST_EXPERIMENT_TITLE,
  hypothesis: FIRST_EXPERIMENT_HYPOTHESIS,
  sampleDefinition: FIRST_EXPERIMENT_SAMPLE_DEFINITION,
  sample_definition: FIRST_EXPERIMENT_SAMPLE_DEFINITION,
  killCriteria: FIRST_EXPERIMENT_KILL_CRITERIA,
  kill_criteria: FIRST_EXPERIMENT_KILL_CRITERIA,
  initialStatus: 'REGISTERED' as const,
  defaultPaperBankrollUsd: FIRST_EXPERIMENT_DEFAULT_PAPER_BANKROLL_USD,
  notes:
    'Pre-registered frozen EventEdge v1 paper validation study. Transitioning REGISTERED -> RUNNING is a separate explicit operator action.',
});

export interface RegisterFirstExperimentOptions {
  /** Optional validated EventEdgeConfig (defaults to PAPER-mode default config). */
  readonly config?: EventEdgeConfig;
  /** Optional environment map passed to `createEventEdgeConfig` when `config` is omitted. */
  readonly env?: Record<string, string | undefined>;
  /** Optional ISO-8601 registration timestamp (defaults to current UTC time). */
  readonly registeredAt?: string;
}

/**
 * Writes `FIRST_EXPERIMENT` into the EE-03 experiment registry exactly once in `REGISTERED` state.
 *
 * - Strictly idempotent: if `EE-V1-BASERATE-01` already exists in the registry, returns the
 *   existing immutable `ExperimentRecord` unchanged without modifying or duplicating rows.
 * - Computes `model_version` from `config.forecasting.ensembleVersion` and `config_hash` from
 *   `computeEventEdgeConfigHash(config)` at registration time (never hard-coded).
 * - Enforces `LIVE` mode hard-disable via EE-00 `assertNonLiveMode`.
 */
export function registerFirstExperiment(
  db: DatabaseSync,
  options: RegisterFirstExperimentOptions = {}
): ExperimentRecord {
  const existing = getExperiment(db, FIRST_EXPERIMENT.experimentId);
  if (existing) {
    return existing;
  }

  const config =
    options.config ?? createEventEdgeConfig({ mode: 'PAPER' }, options.env ?? process.env);

  assertNonLiveMode(config.mode, 'registerFirstExperiment');
  if (config.liveEnabled !== false) {
    throw new EventEdgeLiveModeDisabledError('registerFirstExperiment#liveEnabled');
  }

  const modelVersion = config.forecasting.ensembleVersion;
  const configHash = computeEventEdgeConfigHash(config);

  return registerExperiment(db, {
    experimentId: FIRST_EXPERIMENT.experimentId,
    title: FIRST_EXPERIMENT.title,
    hypothesis: FIRST_EXPERIMENT.hypothesis,
    killCriteria: FIRST_EXPERIMENT.killCriteria,
    sampleDefinition: FIRST_EXPERIMENT.sampleDefinition,
    modelVersion,
    configHash,
    notes: FIRST_EXPERIMENT.notes,
    registeredAt: options.registeredAt,
  });
}
