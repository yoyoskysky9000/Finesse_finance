import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { EVENTEDGE_DEFAULT_RISK_CONFIG, type EventEdgeRiskConfig } from '../config/index';
import {
  IllegalRiskStateTransitionError,
  RISK_SYSTEM_STATES,
  RiskValidationError,
  type ApplySystemStateEvaluationOptions,
  type ApplySystemStateEvaluationResult,
  type OperatorRiskActionInput,
  type RiskStateHistoryRecord,
  type RiskSystemState,
  type SystemStateEvaluationInputs,
  type SystemStateEvaluationResult,
  type TransitionRiskStateInput,
} from './types';

const FLOAT_EPSILON = 1e-12;

/**
 * Legal state-machine edges for `risk_state_history`:
 * - `RECONCILIATION_REQUIRED` and `DATA_QUARANTINE` MUST enter `RECOVERY_PENDING` via
 *   an explicit operator recovery action before returning to `HEALTHY` (direct jump forbidden).
 * - `RECOVERY_PENDING` returns to `HEALTHY` only via an explicit operator clearance action.
 * - `HALTED` returns to `HEALTHY` only via an explicit operator reset action (never auto-reset).
 */
export const RISK_STATE_TRANSITIONS: Readonly<
  Record<RiskSystemState, readonly RiskSystemState[]>
> = Object.freeze({
  HEALTHY: Object.freeze(['DEGRADED', 'HALTED', 'DATA_QUARANTINE', 'RECONCILIATION_REQUIRED'] as const),
  DEGRADED: Object.freeze(['HEALTHY', 'HALTED', 'DATA_QUARANTINE', 'RECONCILIATION_REQUIRED'] as const),
  HALTED: Object.freeze(['HEALTHY', 'DATA_QUARANTINE', 'RECONCILIATION_REQUIRED'] as const),
  RECONCILIATION_REQUIRED: Object.freeze(['RECOVERY_PENDING'] as const),
  DATA_QUARANTINE: Object.freeze(['RECOVERY_PENDING', 'RECONCILIATION_REQUIRED'] as const),
  RECOVERY_PENDING: Object.freeze(['HEALTHY', 'HALTED', 'DATA_QUARANTINE', 'RECONCILIATION_REQUIRED'] as const),
});

/**
 * Pure deterministic system-state evaluator.
 *
 * Precedence (strict fail-closed order):
 * 1. `reconciliationPending || !ledgerIntegrityOk` -> `RECONCILIATION_REQUIRED`
 * 2. `!dataFresh` -> `DATA_QUARANTINE`
 * 3. `dailyLossPct >= dailyLossStopPct || drawdownPct >= peakToTroughDrawdownStopPct` -> `HALTED`
 * 4. `degradedReason` present (non-empty) -> `DEGRADED`
 * 5. Otherwise -> `HEALTHY`
 */
export function evaluateSystemState(
  inputs: SystemStateEvaluationInputs,
  riskConfig: EventEdgeRiskConfig = EVENTEDGE_DEFAULT_RISK_CONFIG
): SystemStateEvaluationResult {
  if (!inputs || typeof inputs !== 'object') {
    throw new RiskValidationError('SystemStateEvaluationInputs object is required.');
  }
  if (!Number.isFinite(inputs.dailyLossPct) || inputs.dailyLossPct < 0) {
    throw new RiskValidationError(
      `dailyLossPct must be a non-negative finite number (received ${String(inputs.dailyLossPct)}).`
    );
  }
  if (!Number.isFinite(inputs.drawdownPct) || inputs.drawdownPct < 0) {
    throw new RiskValidationError(
      `drawdownPct must be a non-negative finite number (received ${String(inputs.drawdownPct)}).`
    );
  }

  const dailyStop = inputs.dailyLossStopPct ?? riskConfig.dailyLossStopPct;
  const drawdownStop = inputs.peakToTroughDrawdownStopPct ?? riskConfig.peakToTroughDrawdownStopPct;

  if (inputs.reconciliationPending || !inputs.ledgerIntegrityOk) {
    const causes: string[] = [];
    if (inputs.reconciliationPending) causes.push('reconciliationPending=true');
    if (!inputs.ledgerIntegrityOk) causes.push('ledgerIntegrityOk=false');
    return Object.freeze({
      state: 'RECONCILIATION_REQUIRED' as const,
      reason: `Reconciliation required: ${causes.join(', ')}`,
    });
  }

  if (!inputs.dataFresh) {
    return Object.freeze({
      state: 'DATA_QUARANTINE' as const,
      reason: 'Data freshness check failed (dataFresh=false)',
    });
  }

  const dailyBreached = inputs.dailyLossPct >= dailyStop - FLOAT_EPSILON;
  const drawdownBreached = inputs.drawdownPct >= drawdownStop - FLOAT_EPSILON;
  if (dailyBreached || drawdownBreached) {
    const causes: string[] = [];
    if (dailyBreached) {
      causes.push(
        `DAILY_LOSS_STOP (${(inputs.dailyLossPct * 100).toFixed(4)}% >= ${(dailyStop * 100).toFixed(4)}%)`
      );
    }
    if (drawdownBreached) {
      causes.push(
        `DRAWDOWN_STOP (${(inputs.drawdownPct * 100).toFixed(4)}% >= ${(drawdownStop * 100).toFixed(4)}%)`
      );
    }
    return Object.freeze({
      state: 'HALTED' as const,
      reason: `Trading halted: ${causes.join('; ')}`,
    });
  }

  const trimmedDegraded = inputs.degradedReason?.trim() ?? '';
  if (trimmedDegraded.length > 0) {
    return Object.freeze({
      state: 'DEGRADED' as const,
      reason: `Degraded mode: ${trimmedDegraded}`,
    });
  }

  return Object.freeze({
    state: 'HEALTHY' as const,
    reason: 'All integrity, freshness, and loss-stop checks passed',
  });
}

interface RawRiskStateRow {
  transition_id: string;
  from_state: RiskSystemState | null;
  to_state: RiskSystemState;
  reason: string;
  actor: string;
  recorded_at: string;
  created_at: string;
}

function mapRiskStateRow(row: RawRiskStateRow): RiskStateHistoryRecord {
  return Object.freeze({
    transitionId: row.transition_id,
    fromState: row.from_state,
    toState: row.to_state,
    reason: row.reason,
    actor: row.actor,
    recordedAt: row.recorded_at,
    createdAt: row.created_at,
  });
}

/**
 * Returns the full append-only `risk_state_history` log ordered oldest-to-newest.
 */
export function getRiskSystemStateHistory(db: DatabaseSync): readonly RiskStateHistoryRecord[] {
  const rows = db
    .prepare(
      `SELECT transition_id, from_state, to_state, reason, actor, recorded_at, created_at
       FROM risk_state_history
       ORDER BY rowid ASC`
    )
    .all() as unknown as RawRiskStateRow[];
  return Object.freeze(rows.map(mapRiskStateRow));
}

/**
 * Reads the current system state from the latest row in `risk_state_history`.
 * If `asOf` is supplied, reads the latest state recorded at or before `asOf`.
 * Fails closed (`RECONCILIATION_REQUIRED`) if the history table is unexpectedly empty.
 */
export function getCurrentRiskSystemState(
  db: DatabaseSync,
  asOf?: string
): RiskSystemState {
  if (asOf !== undefined) {
    const asOfEpochMs = Date.parse(asOf);
    if (!Number.isFinite(asOfEpochMs)) {
      throw new RiskValidationError(`Invalid asOf timestamp "${asOf}".`);
    }
    const rows = db
      .prepare(
        `SELECT transition_id, from_state, to_state, reason, actor, recorded_at, created_at
         FROM risk_state_history
         ORDER BY rowid ASC`
      )
      .all() as unknown as RawRiskStateRow[];

    let latest: RawRiskStateRow | null = null;
    for (const row of rows) {
      const rowMs = Date.parse(row.recorded_at);
      if (Number.isFinite(rowMs) && rowMs <= asOfEpochMs) {
        latest = row;
      }
    }
    return latest ? latest.to_state : 'RECONCILIATION_REQUIRED';
  }

  const latest = db
    .prepare(
      `SELECT to_state
       FROM risk_state_history
       ORDER BY rowid DESC
       LIMIT 1`
    )
    .get() as { to_state: RiskSystemState } | undefined;

  return latest ? latest.to_state : 'RECONCILIATION_REQUIRED';
}

function appendRiskStateTransitionRow(
  db: DatabaseSync,
  fromState: RiskSystemState,
  toState: RiskSystemState,
  reason: string,
  actor: string,
  recordedAt: string
): RiskStateHistoryRecord {
  const transitionId = `rsh_${crypto.randomUUID()}`;
  db.prepare(
    `INSERT INTO risk_state_history (
      transition_id, from_state, to_state, reason, actor, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(transitionId, fromState, toState, reason, actor, recordedAt);

  const inserted = db
    .prepare(
      `SELECT transition_id, from_state, to_state, reason, actor, recorded_at, created_at
       FROM risk_state_history
       WHERE transition_id = ?`
    )
    .get(transitionId) as unknown as RawRiskStateRow;

  return mapRiskStateRow(inserted);
}

/**
 * Validates and appends a state transition to `risk_state_history`.
 * Enforces the state-machine transition graph (forbidding direct jumps from
 * `RECONCILIATION_REQUIRED` or `DATA_QUARANTINE` to `HEALTHY`).
 */
export function transitionRiskSystemState(
  db: DatabaseSync,
  input: TransitionRiskStateInput
): RiskStateHistoryRecord {
  const toState = input.toState;
  const reason = input.reason?.trim() ?? '';
  const actor = input.actor?.trim() ?? '';
  const recordedAt = input.recordedAt?.trim() || new Date().toISOString();

  if (!RISK_SYSTEM_STATES.includes(toState)) {
    throw new RiskValidationError(`Unknown target risk system state "${String(toState)}".`);
  }
  if (!reason || !actor) {
    throw new RiskValidationError('Both reason and actor must be non-empty strings.');
  }
  if (!Number.isFinite(Date.parse(recordedAt))) {
    throw new RiskValidationError(`Invalid recordedAt timestamp "${recordedAt}".`);
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    const current = getCurrentRiskSystemState(db);
    const allowed = RISK_STATE_TRANSITIONS[current];
    if (!allowed.includes(toState)) {
      throw new IllegalRiskStateTransitionError(
        current,
        toState,
        current === 'RECONCILIATION_REQUIRED' || current === 'DATA_QUARANTINE'
          ? 'must enter RECOVERY_PENDING via operator recovery action before clearance to HEALTHY'
          : undefined
      );
    }

    const record = appendRiskStateTransitionRow(db, current, toState, reason, actor, recordedAt);
    db.exec('COMMIT');
    return record;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore rollback error
    }
    throw err;
  }
}

/**
 * Explicit operator recovery action:
 * enters `RECOVERY_PENDING` strictly from `RECONCILIATION_REQUIRED` or `DATA_QUARANTINE`.
 */
export function initiateOperatorRecovery(
  db: DatabaseSync,
  input: OperatorRiskActionInput
): RiskStateHistoryRecord {
  const current = getCurrentRiskSystemState(db);
  if (current !== 'RECONCILIATION_REQUIRED' && current !== 'DATA_QUARANTINE') {
    throw new IllegalRiskStateTransitionError(
      current,
      'RECOVERY_PENDING',
      'operator recovery is permitted only from RECONCILIATION_REQUIRED or DATA_QUARANTINE'
    );
  }
  return transitionRiskSystemState(db, {
    toState: 'RECOVERY_PENDING',
    actor: input.actor,
    reason: input.reason,
    recordedAt: input.recordedAt,
  });
}

/**
 * Explicit operator clearance action:
 * re-enters `HEALTHY` strictly from `RECOVERY_PENDING`.
 */
export function completeOperatorClearance(
  db: DatabaseSync,
  input: OperatorRiskActionInput
): RiskStateHistoryRecord {
  const current = getCurrentRiskSystemState(db);
  if (current !== 'RECOVERY_PENDING') {
    throw new IllegalRiskStateTransitionError(
      current,
      'HEALTHY',
      'operator clearance to HEALTHY is permitted only from RECOVERY_PENDING'
    );
  }
  return transitionRiskSystemState(db, {
    toState: 'HEALTHY',
    actor: input.actor,
    reason: input.reason,
    recordedAt: input.recordedAt,
  });
}

/**
 * Explicit operator reset action:
 * returns to `HEALTHY` strictly from `HALTED` (since HALTED never auto-resets).
 */
export function operatorResetFromHalted(
  db: DatabaseSync,
  input: OperatorRiskActionInput
): RiskStateHistoryRecord {
  const current = getCurrentRiskSystemState(db);
  if (current !== 'HALTED') {
    throw new IllegalRiskStateTransitionError(
      current,
      'HEALTHY',
      'operator reset from HALTED is permitted only when current state is HALTED'
    );
  }
  return transitionRiskSystemState(db, {
    toState: 'HEALTHY',
    actor: input.actor,
    reason: input.reason,
    recordedAt: input.recordedAt,
  });
}

/**
 * Runs deterministic `evaluateSystemState(inputs)` and persists a transition to
 * `risk_state_history` when allowed by the fail-closed governance rules:
 * - `HALTED` NEVER auto-resets to `HEALTHY` or `DEGRADED` (even as time passes or daily loss clears).
 * - `RECONCILIATION_REQUIRED`, `DATA_QUARANTINE`, and `RECOVERY_PENDING` NEVER auto-clear to
 *   `HEALTHY` or `DEGRADED`; they require the explicit operator recovery + clearance sequence.
 * - Escalations to a more severe fault state (`RECONCILIATION_REQUIRED`, `DATA_QUARANTINE`, `HALTED`)
 *   are recorded immediately.
 */
export function applySystemStateEvaluation(
  db: DatabaseSync,
  inputs: SystemStateEvaluationInputs,
  options: ApplySystemStateEvaluationOptions = {}
): ApplySystemStateEvaluationResult {
  const evalResult = evaluateSystemState(inputs, options.riskConfig);
  const actor = options.actor?.trim() || 'system_risk_evaluator';
  const recordedAt = options.recordedAt?.trim() || new Date().toISOString();
  if (!Number.isFinite(Date.parse(recordedAt))) {
    throw new RiskValidationError(`Invalid recordedAt timestamp "${recordedAt}".`);
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    const previousState = getCurrentRiskSystemState(db);
    const evaluatedState = evalResult.state;

    if (previousState === evaluatedState) {
      db.exec('COMMIT');
      return Object.freeze({
        previousState,
        evaluatedState,
        currentState: previousState,
        transitioned: false,
        blockedAutoReset: false,
        reason: evalResult.reason,
        historyRecord: null,
      });
    }

    // Fail-closed: sticky states never auto-reset back to HEALTHY or DEGRADED
    const isStickyState =
      previousState === 'HALTED' ||
      previousState === 'RECONCILIATION_REQUIRED' ||
      previousState === 'DATA_QUARANTINE' ||
      previousState === 'RECOVERY_PENDING';

    if (isStickyState && (evaluatedState === 'HEALTHY' || evaluatedState === 'DEGRADED')) {
      db.exec('COMMIT');
      return Object.freeze({
        previousState,
        evaluatedState,
        currentState: previousState,
        transitioned: false,
        blockedAutoReset: true,
        reason: `Auto-reset from ${previousState} to ${evaluatedState} blocked; explicit operator action required.`,
        historyRecord: null,
      });
    }

    const allowedTargets = RISK_STATE_TRANSITIONS[previousState];
    if (!allowedTargets.includes(evaluatedState)) {
      db.exec('COMMIT');
      return Object.freeze({
        previousState,
        evaluatedState,
        currentState: previousState,
        transitioned: false,
        blockedAutoReset: true,
        reason: `Automated transition ${previousState} -> ${evaluatedState} is not permitted; state held at ${previousState}.`,
        historyRecord: null,
      });
    }

    const historyRecord = appendRiskStateTransitionRow(
      db,
      previousState,
      evaluatedState,
      evalResult.reason,
      actor,
      recordedAt
    );

    db.exec('COMMIT');
    return Object.freeze({
      previousState,
      evaluatedState,
      currentState: evaluatedState,
      transitioned: true,
      blockedAutoReset: false,
      reason: evalResult.reason,
      historyRecord,
    });
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore rollback error
    }
    throw err;
  }
}
