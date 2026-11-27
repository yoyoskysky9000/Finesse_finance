import type { DatabaseSync } from 'node:sqlite';
import {
  EventEdgeLiveModeDisabledError,
  assertNonLiveMode,
  computeEventEdgeConfigHash,
  createEventEdgeConfig,
  type EventEdgeAllowedMode,
  type EventEdgeConfig,
} from '../config/index';
import {
  getExperiment,
  registerExperiment,
  type ExperimentRecord,
  type ExperimentStatus,
} from '../experiments/registry';
import {
  FIRST_EXPERIMENT,
  FIRST_EXPERIMENT_DEFAULT_PAPER_BANKROLL_USD,
  FIRST_EXPERIMENT_ID,
} from './registerFirstExperiment';

export const SECOND_EXPERIMENT_ID = 'EE-V1-BASERATE-02' as const;

export const SECOND_EXPERIMENT_DISCOVERY_OVERRIDES = Object.freeze({
  targetedOnly: true,
  targetSeriesPrefixes: Object.freeze(['KXEARNINGSMENTION', 'KXFEDMENTION'] as const),
  targetSeriesTickers: Object.freeze(['KXFEDDECISION'] as const),
});

export interface SecondPreRegisteredExperimentSpec {
  readonly experimentId: typeof SECOND_EXPERIMENT_ID;
  readonly experiment_id: typeof SECOND_EXPERIMENT_ID;
  readonly title: string;
  readonly hypothesis: string;
  readonly sampleDefinition: string;
  readonly sample_definition: string;
  readonly killCriteria: string;
  readonly kill_criteria: string;
  readonly supersedes: typeof FIRST_EXPERIMENT_ID;
  readonly voidReason: string;
  readonly void_reason: string;
  readonly initialStatus: Extract<ExperimentStatus, 'REGISTERED'>;
  readonly defaultPaperBankrollUsd: number;
  readonly discoveryConfig: typeof SECOND_EXPERIMENT_DISCOVERY_OVERRIDES;
  readonly notes: string;
}

const SECOND_EXPERIMENT_TITLE =
  'EventEdge v1 — reference base-rate ensemble vs market (frozen, targeted discovery)';

const SECOND_EXPERIMENT_SAMPLE_DEFINITION =
  'All markets in the targeted families — series resolved from the prefixes KXEARNINGSMENTION and KXFEDMENTION, plus the series KXFEDDECISION — that reach APPROVED and settle during the window, with the horizon applied to the event date. The frozen sample closes at the first of: 100 settled forecasted markets, or 90 days from the RUNNING transition. The denominator includes discovered, audit-rejected, and abstained markets in the targeted families.';

const SECOND_EXPERIMENT_VOID_REASON =
  'EE-V1-BASERATE-01 was voided on 2026-11-27 before any forecast was written: its universe-sweep discovery audited 3,732 markets of which 3,731 were KXMVE cross-category parlays, and the targeted families never reached audit because earnings-mention markets carry a 2027 administrative close_time that defeated the close-time horizon. Zero forecasts, zero settlements, no data contaminated.';

/**
 * Pre-registered frozen specification for `EE-V1-BASERATE-02`, superseding `EE-V1-BASERATE-01`
 * with targeted series discovery and event-date horizon evaluation while keeping the exact
 * same falsifiable hypothesis and kill criteria.
 */
export const SECOND_EXPERIMENT: SecondPreRegisteredExperimentSpec = Object.freeze({
  experimentId: SECOND_EXPERIMENT_ID,
  experiment_id: SECOND_EXPERIMENT_ID,
  title: SECOND_EXPERIMENT_TITLE,
  hypothesis: FIRST_EXPERIMENT.hypothesis,
  sampleDefinition: SECOND_EXPERIMENT_SAMPLE_DEFINITION,
  sample_definition: SECOND_EXPERIMENT_SAMPLE_DEFINITION,
  killCriteria: FIRST_EXPERIMENT.killCriteria,
  kill_criteria: FIRST_EXPERIMENT.killCriteria,
  supersedes: FIRST_EXPERIMENT_ID,
  voidReason: SECOND_EXPERIMENT_VOID_REASON,
  void_reason: SECOND_EXPERIMENT_VOID_REASON,
  initialStatus: 'REGISTERED' as const,
  defaultPaperBankrollUsd: FIRST_EXPERIMENT_DEFAULT_PAPER_BANKROLL_USD,
  discoveryConfig: SECOND_EXPERIMENT_DISCOVERY_OVERRIDES,
  notes:
    'Pre-registered frozen EventEdge v1 targeted-discovery paper validation study superseding EE-V1-BASERATE-01. Transitioning REGISTERED -> RUNNING is a separate explicit operator action.',
});

export interface CreateSecondExperimentConfigOptions {
  /** Non-LIVE mode for the frozen config (defaults to `'PAPER'`). */
  readonly mode?: EventEdgeAllowedMode | string;
  /** Optional environment map passed to `createEventEdgeConfig`. */
  readonly env?: Record<string, string | undefined>;
  /** Optional ledger DB path override. */
  readonly ledgerDbPath?: string;
}

/**
 * Constructs the canonical frozen EventEdgeConfig for `EE-V1-BASERATE-02` with
 * `targetedOnly: true`, `targetSeriesPrefixes: ['KXEARNINGSMENTION', 'KXFEDMENTION']`,
 * and `targetSeriesTickers: ['KXFEDDECISION']`.
 */
export function createSecondExperimentConfig(
  options: CreateSecondExperimentConfigOptions = {}
): EventEdgeConfig {
  const mode = options.mode ?? 'PAPER';
  assertNonLiveMode(mode, 'createSecondExperimentConfig');
  return createEventEdgeConfig(
    {
      mode,
      ledgerDbPath: options.ledgerDbPath,
      discovery: {
        targetedOnly: SECOND_EXPERIMENT_DISCOVERY_OVERRIDES.targetedOnly,
        targetSeriesPrefixes: [...SECOND_EXPERIMENT_DISCOVERY_OVERRIDES.targetSeriesPrefixes],
        targetSeriesTickers: [...SECOND_EXPERIMENT_DISCOVERY_OVERRIDES.targetSeriesTickers],
      },
    },
    options.env ?? process.env
  );
}

export interface RegisterSecondExperimentOptions {
  /** Optional validated EventEdgeConfig (defaults to `createSecondExperimentConfig()`). */
  readonly config?: EventEdgeConfig;
  /** Optional environment map passed to `createSecondExperimentConfig` when `config` is omitted. */
  readonly env?: Record<string, string | undefined>;
  /** Optional ISO-8601 registration timestamp (defaults to current UTC time). */
  readonly registeredAt?: string;
}

/**
 * Writes `SECOND_EXPERIMENT` (`EE-V1-BASERATE-02`) into the EE-03 experiment registry
 * exactly once in `REGISTERED` state.
 *
 * - Strictly idempotent: if `EE-V1-BASERATE-02` already exists in the registry, returns the
 *   existing immutable `ExperimentRecord` unchanged without modifying or duplicating rows.
 * - Never alters `EE-V1-BASERATE-01` or any other existing experiment row.
 * - Computes `model_version` and `config_hash` deterministically at registration time.
 * - Enforces `LIVE` mode hard-disable via EE-00 `assertNonLiveMode`.
 */
export function registerSecondExperiment(
  db: DatabaseSync,
  options: RegisterSecondExperimentOptions = {}
): ExperimentRecord {
  const existing = getExperiment(db, SECOND_EXPERIMENT.experimentId);
  if (existing) {
    return existing;
  }

  const config = options.config ?? createSecondExperimentConfig({ env: options.env });

  assertNonLiveMode(config.mode, 'registerSecondExperiment');
  if (config.liveEnabled !== false) {
    throw new EventEdgeLiveModeDisabledError('registerSecondExperiment#liveEnabled');
  }

  const modelVersion = config.forecasting.ensembleVersion;
  const configHash = computeEventEdgeConfigHash(config);

  return registerExperiment(db, {
    experimentId: SECOND_EXPERIMENT.experimentId,
    title: SECOND_EXPERIMENT.title,
    hypothesis: SECOND_EXPERIMENT.hypothesis,
    killCriteria: SECOND_EXPERIMENT.killCriteria,
    sampleDefinition: SECOND_EXPERIMENT.sampleDefinition,
    modelVersion,
    configHash,
    notes: SECOND_EXPERIMENT.notes,
    supersedes: SECOND_EXPERIMENT.supersedes,
    voidReason: SECOND_EXPERIMENT.voidReason,
    registeredAt: options.registeredAt,
  });
}
