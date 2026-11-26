import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export const EXPERIMENT_STATUSES = ['REGISTERED', 'RUNNING', 'COMPLETED', 'KILLED'] as const;
export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number];

/**
 * Explicit allowed status transition table for registered experiments:
 *   REGISTERED -> RUNNING
 *   RUNNING    -> COMPLETED | KILLED
 *   COMPLETED  -> (terminal)
 *   KILLED     -> (terminal)
 */
export const EXPERIMENT_STATUS_TRANSITIONS: Readonly<
  Record<ExperimentStatus, readonly ExperimentStatus[]>
> = Object.freeze({
  REGISTERED: Object.freeze(['RUNNING'] as const),
  RUNNING: Object.freeze(['COMPLETED', 'KILLED'] as const),
  COMPLETED: Object.freeze([] as const),
  KILLED: Object.freeze([] as const),
});

export class InvalidExperimentInputError extends Error {
  public readonly code = 'EVENTEDGE_EXPERIMENT_INVALID_INPUT' as const;

  constructor(message: string) {
    super(message);
    this.name = 'InvalidExperimentInputError';
  }
}

export class ExperimentAlreadyExistsError extends Error {
  public readonly code = 'EVENTEDGE_EXPERIMENT_ALREADY_EXISTS' as const;
  public readonly experimentId: string;

  constructor(experimentId: string) {
    super(`Experiment "${experimentId}" is already registered and cannot be overwritten.`);
    this.name = 'ExperimentAlreadyExistsError';
    this.experimentId = experimentId;
  }
}

export class ExperimentNotFoundError extends Error {
  public readonly code = 'EVENTEDGE_EXPERIMENT_NOT_FOUND' as const;
  public readonly experimentId: string;

  constructor(experimentId: string) {
    super(`Experiment "${experimentId}" does not exist in the EventEdge experiment registry.`);
    this.name = 'ExperimentNotFoundError';
    this.experimentId = experimentId;
  }
}

export class IllegalExperimentStatusTransitionError extends Error {
  public readonly code = 'EVENTEDGE_EXPERIMENT_ILLEGAL_TRANSITION' as const;
  public readonly experimentId: string;
  public readonly fromStatus: ExperimentStatus;
  public readonly toStatus: ExperimentStatus;

  constructor(experimentId: string, fromStatus: ExperimentStatus, toStatus: ExperimentStatus) {
    super(
      `Illegal experiment status transition for "${experimentId}": ${fromStatus} -> ${toStatus} is not permitted.`
    );
    this.name = 'IllegalExperimentStatusTransitionError';
    this.experimentId = experimentId;
    this.fromStatus = fromStatus;
    this.toStatus = toStatus;
  }
}

export interface RegisterExperimentInput {
  readonly experimentId: string;
  readonly title: string;
  /** Falsifiable scientific/quantitative hypothesis tested by this experiment. */
  readonly hypothesis: string;
  /** Explicit kill criteria written up front at registration. */
  readonly killCriteria: string;
  /** Event families, denominator definition, and frozen sample size or end condition. */
  readonly sampleDefinition: string;
  readonly modelVersion: string;
  readonly configHash: string;
  readonly notes?: string;
  readonly registeredAt?: string;
}

export interface ExperimentRecord {
  readonly experimentId: string;
  readonly title: string;
  readonly hypothesis: string;
  readonly registeredAt: string;
  readonly status: ExperimentStatus;
  readonly killCriteria: string;
  readonly sampleDefinition: string;
  readonly modelVersion: string;
  readonly configHash: string;
  readonly notes: string;
  readonly createdAt: string;
}

export interface ExperimentStatusHistoryRecord {
  readonly historyId: string;
  readonly experimentId: string;
  readonly fromStatus: ExperimentStatus;
  readonly toStatus: ExperimentStatus;
  readonly reason: string;
  readonly changedAt: string;
  readonly createdAt: string;
}

export interface TransitionExperimentStatusInput {
  readonly experimentId: string;
  readonly toStatus: ExperimentStatus;
  readonly reason: string;
  readonly changedAt?: string;
}

export interface TransitionExperimentStatusResult {
  readonly experiment: ExperimentRecord;
  readonly historyEntry: ExperimentStatusHistoryRecord;
}

interface RawExperimentRow {
  experiment_id: string;
  title: string;
  hypothesis: string;
  registered_at: string;
  status: ExperimentStatus;
  kill_criteria: string;
  sample_definition: string;
  model_version: string;
  config_hash: string;
  notes: string;
  created_at: string;
}

interface RawExperimentHistoryRow {
  history_id: string;
  experiment_id: string;
  from_status: ExperimentStatus;
  to_status: ExperimentStatus;
  reason: string;
  changed_at: string;
  created_at: string;
}

function requireNonEmptyText(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidExperimentInputError(
      `Experiment field "${fieldName}" must be a non-empty string.`
    );
  }
  return value.trim();
}

function mapRawExperimentRow(row: RawExperimentRow): ExperimentRecord {
  return Object.freeze({
    experimentId: row.experiment_id,
    title: row.title,
    hypothesis: row.hypothesis,
    registeredAt: row.registered_at,
    status: row.status,
    killCriteria: row.kill_criteria,
    sampleDefinition: row.sample_definition,
    modelVersion: row.model_version,
    configHash: row.config_hash,
    notes: row.notes,
    createdAt: row.created_at,
  });
}

function mapRawHistoryRow(row: RawExperimentHistoryRow): ExperimentStatusHistoryRecord {
  return Object.freeze({
    historyId: row.history_id,
    experimentId: row.experiment_id,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    reason: row.reason,
    changedAt: row.changed_at,
    createdAt: row.created_at,
  });
}

/**
 * Registers a new falsifiable experiment in `experiments` with initial status `REGISTERED`.
 * All non-status columns are immutable once written.
 */
export function registerExperiment(
  db: DatabaseSync,
  input: RegisterExperimentInput
): ExperimentRecord {
  const experimentId = requireNonEmptyText(input.experimentId, 'experimentId');
  const title = requireNonEmptyText(input.title, 'title');
  const hypothesis = requireNonEmptyText(input.hypothesis, 'hypothesis');
  const killCriteria = requireNonEmptyText(input.killCriteria, 'killCriteria');
  const sampleDefinition = requireNonEmptyText(input.sampleDefinition, 'sampleDefinition');
  const modelVersion = requireNonEmptyText(input.modelVersion, 'modelVersion');
  const configHash = requireNonEmptyText(input.configHash, 'configHash');
  const notes = typeof input.notes === 'string' ? input.notes.trim() : '';
  const registeredAt = input.registeredAt?.trim() || new Date().toISOString();

  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = db
      .prepare('SELECT experiment_id FROM experiments WHERE experiment_id = ? LIMIT 1')
      .get(experimentId) as { experiment_id: string } | undefined;

    if (existing) {
      throw new ExperimentAlreadyExistsError(experimentId);
    }

    db.prepare(
      `INSERT INTO experiments (
        experiment_id, title, hypothesis, registered_at, status,
        kill_criteria, sample_definition, model_version, config_hash, notes
      ) VALUES (?, ?, ?, ?, 'REGISTERED', ?, ?, ?, ?, ?)`
    ).run(
      experimentId,
      title,
      hypothesis,
      registeredAt,
      killCriteria,
      sampleDefinition,
      modelVersion,
      configHash,
      notes
    );

    const inserted = db
      .prepare(
        `SELECT
          experiment_id, title, hypothesis, registered_at, status,
          kill_criteria, sample_definition, model_version, config_hash, notes, created_at
        FROM experiments
        WHERE experiment_id = ?`
      )
      .get(experimentId) as unknown as RawExperimentRow;

    db.exec('COMMIT');
    return mapRawExperimentRow(inserted);
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Ignore rollback error
    }
    throw err;
  }
}

export function getExperiment(db: DatabaseSync, experimentId: string): ExperimentRecord | null {
  const row = db
    .prepare(
      `SELECT
        experiment_id, title, hypothesis, registered_at, status,
        kill_criteria, sample_definition, model_version, config_hash, notes, created_at
      FROM experiments
      WHERE experiment_id = ?
      LIMIT 1`
    )
    .get(experimentId.trim()) as unknown as RawExperimentRow | undefined;

  return row ? mapRawExperimentRow(row) : null;
}

export function listExperiments(db: DatabaseSync): ExperimentRecord[] {
  const rows = db
    .prepare(
      `SELECT
        experiment_id, title, hypothesis, registered_at, status,
        kill_criteria, sample_definition, model_version, config_hash, notes, created_at
      FROM experiments
      ORDER BY registered_at ASC, rowid ASC`
    )
    .all() as unknown as RawExperimentRow[];

  return rows.map(mapRawExperimentRow);
}

/**
 * The ONLY permitted status-transition path for an experiment.
 * Validates the transition against `EXPERIMENT_STATUS_TRANSITIONS`, appends an immutable
 * row to `experiment_status_history`, and updates ONLY the `status` column on `experiments`
 * inside a single atomic `BEGIN IMMEDIATE` transaction.
 */
export function transitionExperimentStatus(
  db: DatabaseSync,
  input: TransitionExperimentStatusInput
): TransitionExperimentStatusResult {
  const experimentId = requireNonEmptyText(input.experimentId, 'experimentId');
  const reason = requireNonEmptyText(input.reason, 'reason');
  const toStatus = input.toStatus;
  if (!EXPERIMENT_STATUSES.includes(toStatus)) {
    throw new InvalidExperimentInputError(
      `Unknown experiment status "${String(toStatus)}". Valid: ${EXPERIMENT_STATUSES.join(', ')}.`
    );
  }
  const changedAt = input.changedAt?.trim() || new Date().toISOString();

  db.exec('BEGIN IMMEDIATE');
  try {
    const current = db
      .prepare(
        `SELECT
          experiment_id, title, hypothesis, registered_at, status,
          kill_criteria, sample_definition, model_version, config_hash, notes, created_at
        FROM experiments
        WHERE experiment_id = ?
        LIMIT 1`
      )
      .get(experimentId) as unknown as RawExperimentRow | undefined;

    if (!current) {
      throw new ExperimentNotFoundError(experimentId);
    }

    const fromStatus = current.status;
    const allowedTargets = EXPERIMENT_STATUS_TRANSITIONS[fromStatus];
    if (!allowedTargets.includes(toStatus)) {
      throw new IllegalExperimentStatusTransitionError(experimentId, fromStatus, toStatus);
    }

    const historyId = `exph_${crypto.randomUUID()}`;

    // 1. Append immutable history record first (required by trg_experiments_controlled_status_update)
    db.prepare(
      `INSERT INTO experiment_status_history (
        history_id, experiment_id, from_status, to_status, reason, changed_at
      ) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(historyId, experimentId, fromStatus, toStatus, reason, changedAt);

    // 2. Update ONLY the status column on experiments
    db.prepare('UPDATE experiments SET status = ? WHERE experiment_id = ?').run(
      toStatus,
      experimentId
    );

    const updated = db
      .prepare(
        `SELECT
          experiment_id, title, hypothesis, registered_at, status,
          kill_criteria, sample_definition, model_version, config_hash, notes, created_at
        FROM experiments
        WHERE experiment_id = ?`
      )
      .get(experimentId) as unknown as RawExperimentRow;

    const historyRow = db
      .prepare(
        `SELECT
          history_id, experiment_id, from_status, to_status, reason, changed_at, created_at
        FROM experiment_status_history
        WHERE history_id = ?`
      )
      .get(historyId) as unknown as RawExperimentHistoryRow;

    db.exec('COMMIT');
    return Object.freeze({
      experiment: mapRawExperimentRow(updated),
      historyEntry: mapRawHistoryRow(historyRow),
    });
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Ignore rollback error
    }
    throw err;
  }
}

export function getExperimentStatusHistory(
  db: DatabaseSync,
  experimentId: string
): ExperimentStatusHistoryRecord[] {
  const rows = db
    .prepare(
      `SELECT
        history_id, experiment_id, from_status, to_status, reason, changed_at, created_at
      FROM experiment_status_history
      WHERE experiment_id = ?
      ORDER BY changed_at ASC, rowid ASC`
    )
    .all(experimentId.trim()) as unknown as RawExperimentHistoryRow[];

  return rows.map(mapRawHistoryRow);
}
