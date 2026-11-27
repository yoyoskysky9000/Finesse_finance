import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { NormalizedMarketSnapshot } from '../discovery/index';
import {
  auditContractResolution,
  persistSettlementRuleVersion,
  type ContractResolutionAuditResult,
  type PersistedRuleVersionRecord,
} from '../resolution/index';

export const CONTRACT_LIFECYCLE_STATES = [
  'DISCOVERED',
  'AUDIT_PENDING',
  'APPROVED',
  'REJECTED',
  'ACTIVE',
  'SETTLEMENT_PENDING',
  'RESOLVED',
  'DISPUTED',
  'VOIDED',
] as const;

export type ContractLifecycleState = (typeof CONTRACT_LIFECYCLE_STATES)[number];

/**
 * Explicit contract resolution lifecycle transition table:
 * - Happy path: DISCOVERED -> AUDIT_PENDING -> APPROVED | REJECTED -> ACTIVE -> SETTLEMENT_PENDING -> RESOLVED
 * - DISPUTED reachable ONLY from SETTLEMENT_PENDING and RESOLVED
 * - VOIDED reachable ONLY from ACTIVE and SETTLEMENT_PENDING
 * - AUDIT_PENDING also reachable from APPROVED or ACTIVE strictly for RULES_REVISED
 */
export const CONTRACT_LIFECYCLE_TRANSITIONS: Readonly<
  Record<ContractLifecycleState, readonly ContractLifecycleState[]>
> = Object.freeze({
  DISCOVERED: Object.freeze(['AUDIT_PENDING'] as const),
  AUDIT_PENDING: Object.freeze(['APPROVED', 'REJECTED'] as const),
  APPROVED: Object.freeze(['ACTIVE', 'AUDIT_PENDING'] as const),
  REJECTED: Object.freeze([] as const),
  ACTIVE: Object.freeze(['SETTLEMENT_PENDING', 'VOIDED', 'AUDIT_PENDING'] as const),
  SETTLEMENT_PENDING: Object.freeze(['RESOLVED', 'DISPUTED', 'VOIDED'] as const),
  RESOLVED: Object.freeze(['DISPUTED'] as const),
  DISPUTED: Object.freeze([] as const),
  VOIDED: Object.freeze([] as const),
});

/**
 * Only contracts in APPROVED (or later non-voided, non-disputed) lifecycle states are
 * eligible for forecast persistence.
 */
export const FORECAST_ELIGIBLE_LIFECYCLE_STATES: ReadonlySet<ContractLifecycleState> = new Set([
  'APPROVED',
  'ACTIVE',
  'SETTLEMENT_PENDING',
  'RESOLVED',
]);

export const RULES_REVISED_REASON = 'RULES_REVISED' as const;

export class ContractLifecycleNotFoundError extends Error {
  public readonly code = 'EVENTEDGE_CONTRACT_LIFECYCLE_NOT_FOUND' as const;
  public readonly marketId: string;

  constructor(marketId: string) {
    super(`Contract "${marketId}" has no lifecycle history; register it as DISCOVERED first.`);
    this.name = 'ContractLifecycleNotFoundError';
    this.marketId = marketId;
  }
}

export class ContractLifecycleAlreadyInitializedError extends Error {
  public readonly code = 'EVENTEDGE_CONTRACT_LIFECYCLE_ALREADY_INITIALIZED' as const;
  public readonly marketId: string;
  public readonly currentState: ContractLifecycleState;

  constructor(marketId: string, currentState: ContractLifecycleState) {
    super(
      `Contract "${marketId}" already has lifecycle state "${currentState}" and cannot be re-initialized as DISCOVERED.`
    );
    this.name = 'ContractLifecycleAlreadyInitializedError';
    this.marketId = marketId;
    this.currentState = currentState;
  }
}

export class IllegalContractLifecycleTransitionError extends Error {
  public readonly code = 'EVENTEDGE_CONTRACT_ILLEGAL_TRANSITION' as const;
  public readonly marketId: string;
  public readonly fromState: ContractLifecycleState | null;
  public readonly toState: ContractLifecycleState;

  constructor(
    marketId: string,
    fromState: ContractLifecycleState | null,
    toState: ContractLifecycleState,
    detail?: string
  ) {
    const suffix = detail ? ` (${detail})` : '';
    super(
      `Illegal contract lifecycle transition for "${marketId}": ${fromState ?? 'NONE'} -> ${toState} is not permitted${suffix}.`
    );
    this.name = 'IllegalContractLifecycleTransitionError';
    this.marketId = marketId;
    this.fromState = fromState;
    this.toState = toState;
  }
}

export interface ContractLifecycleHistoryRecord {
  readonly transitionId: string;
  readonly marketId: string;
  readonly fromState: ContractLifecycleState | null;
  readonly toState: ContractLifecycleState;
  readonly reason: string;
  readonly actor: string;
  readonly ruleVersionId: string | null;
  readonly transitionedAt: string;
  readonly createdAt: string;
}

export interface RegisterDiscoveredContractInput {
  readonly marketId: string;
  readonly actor?: string;
  readonly reason?: string;
  readonly transitionedAt?: string;
}

export interface TransitionContractLifecycleInput {
  readonly marketId: string;
  readonly toState: ContractLifecycleState;
  readonly reason: string;
  readonly actor: string;
  readonly ruleVersionId?: string | null;
  readonly transitionedAt?: string;
}

export interface AuditContractInLifecycleOptions {
  readonly actor?: string;
  readonly auditedAt?: string;
}

export interface AuditContractInLifecycleResult {
  readonly audit: ContractResolutionAuditResult;
  readonly ruleVersion: PersistedRuleVersionRecord;
  readonly isNewRuleVersion: boolean;
  readonly transition: ContractLifecycleHistoryRecord;
}

export interface RecordRuleVersionWithLifecycleResult {
  readonly record: PersistedRuleVersionRecord;
  readonly isNewVersion: boolean;
  readonly lifecycleStateAfter: ContractLifecycleState | null;
  readonly revisionTransition: ContractLifecycleHistoryRecord | null;
}

interface RawLifecycleHistoryRow {
  transition_id: string;
  market_id: string;
  from_state: ContractLifecycleState | null;
  to_state: ContractLifecycleState;
  reason: string;
  actor: string;
  rule_version_id: string | null;
  transitioned_at: string;
  created_at: string;
}

function mapRawLifecycleRow(row: RawLifecycleHistoryRow): ContractLifecycleHistoryRecord {
  return Object.freeze({
    transitionId: row.transition_id,
    marketId: row.market_id,
    fromState: row.from_state,
    toState: row.to_state,
    reason: row.reason,
    actor: row.actor,
    ruleVersionId: row.rule_version_id,
    transitionedAt: row.transitioned_at,
    createdAt: row.created_at,
  });
}

function getLatestLifecycleRow(
  db: DatabaseSync,
  marketId: string
): RawLifecycleHistoryRow | undefined {
  return db
    .prepare(
      `SELECT
        transition_id, market_id, from_state, to_state,
        reason, actor, rule_version_id, transitioned_at, created_at
      FROM contract_lifecycle_history
      WHERE market_id = ?
      ORDER BY rowid DESC
      LIMIT 1`
    )
    .get(marketId.trim()) as unknown as RawLifecycleHistoryRow | undefined;
}

/**
 * Returns the current lifecycle state of a contract (latest appended row), or `null` if untracked.
 */
export function getContractLifecycleState(
  db: DatabaseSync,
  marketId: string
): ContractLifecycleState | null {
  const row = getLatestLifecycleRow(db, marketId);
  return row ? row.to_state : null;
}

/**
 * Returns true if the contract's current lifecycle state is APPROVED (or a later eligible state).
 */
export function isContractEligibleForForecast(db: DatabaseSync, marketId: string): boolean {
  const state = getContractLifecycleState(db, marketId);
  return state !== null && FORECAST_ELIGIBLE_LIFECYCLE_STATES.has(state);
}

/**
 * Lists the full append-only lifecycle transition history for a contract in chronological order.
 */
export function getContractLifecycleHistory(
  db: DatabaseSync,
  marketId: string
): ContractLifecycleHistoryRecord[] {
  const rows = db
    .prepare(
      `SELECT
        transition_id, market_id, from_state, to_state,
        reason, actor, rule_version_id, transitioned_at, created_at
      FROM contract_lifecycle_history
      WHERE market_id = ?
      ORDER BY rowid ASC`
    )
    .all(marketId.trim()) as unknown as RawLifecycleHistoryRow[];

  return rows.map(mapRawLifecycleRow);
}

/**
 * Initializes a newly discovered contract into the `DISCOVERED` lifecycle state.
 */
export function registerDiscoveredContract(
  db: DatabaseSync,
  input: RegisterDiscoveredContractInput
): ContractLifecycleHistoryRecord {
  const marketId = input.marketId.trim();
  if (!marketId) {
    throw new Error('Contract marketId must be a non-empty string.');
  }
  const actor = input.actor?.trim() || 'ee01_market_discovery';
  const reason = input.reason?.trim() || 'MARKET_DISCOVERED';
  const transitionedAt = input.transitionedAt?.trim() || new Date().toISOString();

  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = getLatestLifecycleRow(db, marketId);
    if (existing) {
      throw new ContractLifecycleAlreadyInitializedError(marketId, existing.to_state);
    }

    const transitionId = `lch_${crypto.randomUUID()}`;
    db.prepare(
      `INSERT INTO contract_lifecycle_history (
        transition_id, market_id, from_state, to_state,
        reason, actor, rule_version_id, transitioned_at
      ) VALUES (?, ?, NULL, 'DISCOVERED', ?, ?, NULL, ?)`
    ).run(transitionId, marketId, reason, actor, transitionedAt);

    const inserted = db
      .prepare(
        `SELECT
          transition_id, market_id, from_state, to_state,
          reason, actor, rule_version_id, transitioned_at, created_at
        FROM contract_lifecycle_history
        WHERE transition_id = ?`
      )
      .get(transitionId) as unknown as RawLifecycleHistoryRow;

    db.exec('COMMIT');
    return mapRawLifecycleRow(inserted);
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Ignore rollback error
    }
    throw err;
  }
}

/**
 * Validates and appends a contract lifecycle state transition to `contract_lifecycle_history`.
 * Rejects any illegal transition with `IllegalContractLifecycleTransitionError`.
 */
export function transitionContractLifecycle(
  db: DatabaseSync,
  input: TransitionContractLifecycleInput
): ContractLifecycleHistoryRecord {
  const marketId = input.marketId.trim();
  const reason = input.reason.trim();
  const actor = input.actor.trim();
  const toState = input.toState;
  const ruleVersionId = input.ruleVersionId?.trim() || null;
  const transitionedAt = input.transitionedAt?.trim() || new Date().toISOString();

  if (!marketId || !reason || !actor) {
    throw new Error('marketId, reason, and actor must all be non-empty strings.');
  }

  if (!CONTRACT_LIFECYCLE_STATES.includes(toState)) {
    throw new IllegalContractLifecycleTransitionError(
      marketId,
      null,
      toState,
      `unknown target state "${String(toState)}"`
    );
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    const latest = getLatestLifecycleRow(db, marketId);
    if (!latest) {
      throw new ContractLifecycleNotFoundError(marketId);
    }

    const fromState = latest.to_state;
    const allowedTargets = CONTRACT_LIFECYCLE_TRANSITIONS[fromState];
    if (!allowedTargets.includes(toState)) {
      throw new IllegalContractLifecycleTransitionError(marketId, fromState, toState);
    }

    // Returning to AUDIT_PENDING from APPROVED or ACTIVE is strictly reserved for RULES_REVISED
    if ((fromState === 'APPROVED' || fromState === 'ACTIVE') && toState === 'AUDIT_PENDING') {
      if (reason !== RULES_REVISED_REASON || !ruleVersionId) {
        throw new IllegalContractLifecycleTransitionError(
          marketId,
          fromState,
          toState,
          `transition to AUDIT_PENDING from ${fromState} requires reason="${RULES_REVISED_REASON}" and a ruleVersionId`
        );
      }
    }

    const transitionId = `lch_${crypto.randomUUID()}`;
    db.prepare(
      `INSERT INTO contract_lifecycle_history (
        transition_id, market_id, from_state, to_state,
        reason, actor, rule_version_id, transitioned_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(transitionId, marketId, fromState, toState, reason, actor, ruleVersionId, transitionedAt);

    const inserted = db
      .prepare(
        `SELECT
          transition_id, market_id, from_state, to_state,
          reason, actor, rule_version_id, transitioned_at, created_at
        FROM contract_lifecycle_history
        WHERE transition_id = ?`
      )
      .get(transitionId) as unknown as RawLifecycleHistoryRow;

    db.exec('COMMIT');
    return mapRawLifecycleRow(inserted);
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Ignore rollback error
    }
    throw err;
  }
}

/**
 * Binds the EE-01 Contract Resolution Auditor directly into the lifecycle state machine.
 *
 * - Calls EE-01's `auditContractResolution` and `persistSettlementRuleVersion` without rewriting them.
 * - Requires the contract to be in `AUDIT_PENDING`.
 * - CLEAR verdict -> transitions `AUDIT_PENDING -> APPROVED`.
 * - AMBIGUOUS verdict -> transitions `AUDIT_PENDING -> REJECTED` with the auditor's reasons recorded.
 */
export function auditContractInLifecycle(
  db: DatabaseSync,
  snapshot: NormalizedMarketSnapshot,
  options: AuditContractInLifecycleOptions = {}
): AuditContractInLifecycleResult {
  const marketId = snapshot.marketTicker;
  const currentState = getContractLifecycleState(db, marketId);
  if (currentState === null) {
    throw new ContractLifecycleNotFoundError(marketId);
  }
  if (currentState !== 'AUDIT_PENDING') {
    throw new IllegalContractLifecycleTransitionError(
      marketId,
      currentState,
      'APPROVED',
      `contract must be in AUDIT_PENDING before running auditor binding (current: ${currentState})`
    );
  }

  const auditedAt = options.auditedAt?.trim() || new Date().toISOString();
  const actor = options.actor?.trim() || 'ee01_resolution_auditor';

  // Delegate directly to EE-01 auditor & append-only rule version persistence
  const audit = auditContractResolution(snapshot, auditedAt);
  const { record: ruleVersion, isNewVersion: isNewRuleVersion } = persistSettlementRuleVersion(
    db,
    audit
  );

  if (audit.status === 'CLEAR') {
    const transition = transitionContractLifecycle(db, {
      marketId,
      toState: 'APPROVED',
      reason: 'AUDITOR_CLEAR',
      actor,
      ruleVersionId: ruleVersion.ruleVersionId,
      transitionedAt: auditedAt,
    });
    return Object.freeze({
      audit,
      ruleVersion,
      isNewRuleVersion,
      transition,
    });
  }

  const ambiguitySummary = `AUDITOR_AMBIGUOUS [${audit.reasonCodes.join(', ')}]: ${audit.reasons
    .map((r) => r.detail)
    .join(' | ')}`;

  const transition = transitionContractLifecycle(db, {
    marketId,
    toState: 'REJECTED',
    reason: ambiguitySummary,
    actor,
    ruleVersionId: ruleVersion.ruleVersionId,
    transitionedAt: auditedAt,
  });

  return Object.freeze({
    audit,
    ruleVersion,
    isNewRuleVersion,
    transition,
  });
}

/**
 * Persists a settlement rule version via EE-01's `persistSettlementRuleVersion` and exposes
 * the resulting lifecycle revision transition when a new rule version causes an `APPROVED`
 * or `ACTIVE` contract to return to `AUDIT_PENDING` with reason `RULES_REVISED`.
 */
export function recordRuleVersionWithLifecycleHook(
  db: DatabaseSync,
  audit: ContractResolutionAuditResult
): RecordRuleVersionWithLifecycleResult {
  const { record, isNewVersion } = persistSettlementRuleVersion(db, audit);
  const latest = getLatestLifecycleRow(db, audit.marketTicker);
  const revisionTransition =
    isNewVersion &&
    latest &&
    latest.to_state === 'AUDIT_PENDING' &&
    latest.reason === RULES_REVISED_REASON &&
    latest.rule_version_id === record.ruleVersionId
      ? mapRawLifecycleRow(latest)
      : null;

  return Object.freeze({
    record,
    isNewVersion,
    lifecycleStateAfter: latest ? latest.to_state : null,
    revisionTransition,
  });
}

export interface ContractLifecycleSummaryEntry {
  readonly marketId: string;
  readonly state: ContractLifecycleState;
  readonly ruleVersionId: string | null;
  readonly transitionedAt: string;
}

/**
 * Lists all contracts whose current (latest appended) lifecycle state is in `states`.
 */
export function listContractsInLifecycleStates(
  db: DatabaseSync,
  states: readonly ContractLifecycleState[]
): readonly ContractLifecycleSummaryEntry[] {
  if (states.length === 0) {
    return Object.freeze([]);
  }
  const stateSet = new Set<ContractLifecycleState>(states);
  const rows = db
    .prepare(
      `SELECT l.market_id, l.to_state, l.rule_version_id, l.transitioned_at
       FROM contract_lifecycle_history l
       INNER JOIN (
         SELECT market_id, MAX(rowid) AS max_rowid
         FROM contract_lifecycle_history
         GROUP BY market_id
       ) latest ON latest.market_id = l.market_id AND latest.max_rowid = l.rowid
       ORDER BY l.market_id ASC`
    )
    .all() as unknown as Array<{
    market_id: string;
    to_state: ContractLifecycleState;
    rule_version_id: string | null;
    transitioned_at: string;
  }>;

  const matched: ContractLifecycleSummaryEntry[] = [];
  for (const row of rows) {
    if (stateSet.has(row.to_state)) {
      matched.push(
        Object.freeze({
          marketId: row.market_id,
          state: row.to_state,
          ruleVersionId: row.rule_version_id,
          transitionedAt: row.transitioned_at,
        })
      );
    }
  }
  return Object.freeze(matched);
}

export type SettlementOutcomeCode = 'YES' | 'NO' | 'VOID' | 'CANCELLED';

export interface RecordContractSettlementInput {
  readonly marketId: string;
  readonly eventTicker: string;
  readonly outcome: SettlementOutcomeCode;
  readonly settledAt: string;
  readonly rawSettlementJson: string;
  readonly actor?: string;
  readonly reason?: string;
  readonly venue?: string;
  readonly ruleVersionId?: string | null;
}

export interface RecordContractSettlementResult {
  readonly settlementId: string;
  readonly marketId: string;
  readonly outcome: SettlementOutcomeCode;
  readonly settledAt: string;
  readonly alreadySettled: boolean;
  readonly transitions: readonly ContractLifecycleHistoryRecord[];
  readonly lifecycleStateAfter: ContractLifecycleState;
}

/**
 * Records a discovery-sourced contract settlement into the immutable `settlements` table
 * and advances contract lifecycle to `RESOLVED` (for `YES`/`NO`) or `VOIDED` (for `VOID`/`CANCELLED`).
 *
 * Strictly append-only and idempotent: if a settlement row already exists for `marketId` and the
 * contract is already in `RESOLVED` or `VOIDED`, returns the existing record without modifying state.
 */
export function recordContractSettlement(
  db: DatabaseSync,
  input: RecordContractSettlementInput
): RecordContractSettlementResult {
  const marketId = input.marketId.trim();
  const eventTicker = input.eventTicker.trim();
  const outcome = input.outcome;
  const settledAt = input.settledAt.trim();
  const actor = input.actor?.trim() || 'ee01_discovery_settlement';
  const venue = input.venue?.trim() || 'KALSHI';
  const ruleVersionId = input.ruleVersionId?.trim() || null;

  if (!marketId || !eventTicker) {
    throw new Error('recordContractSettlement requires non-empty marketId and eventTicker.');
  }
  if (!['YES', 'NO', 'VOID', 'CANCELLED'].includes(outcome)) {
    throw new Error(`Invalid settlement outcome "${String(outcome)}".`);
  }
  if (!Number.isFinite(Date.parse(settledAt))) {
    throw new Error(`Invalid settledAt timestamp "${settledAt}".`);
  }

  const currentState = getContractLifecycleState(db, marketId);
  if (currentState === null) {
    throw new ContractLifecycleNotFoundError(marketId);
  }

  const existingSettlement = db
    .prepare(
      `SELECT settlement_id, outcome, settled_at
       FROM settlements
       WHERE market_ticker = ?
       ORDER BY rowid DESC
       LIMIT 1`
    )
    .get(marketId) as
    | { settlement_id: string; outcome: SettlementOutcomeCode; settled_at: string }
    | undefined;

  if (existingSettlement && (currentState === 'RESOLVED' || currentState === 'VOIDED')) {
    return Object.freeze({
      settlementId: existingSettlement.settlement_id,
      marketId,
      outcome: existingSettlement.outcome,
      settledAt: existingSettlement.settled_at,
      alreadySettled: true,
      transitions: Object.freeze([]),
      lifecycleStateAfter: currentState,
    });
  }

  const transitions: ContractLifecycleHistoryRecord[] = [];
  let state = currentState;

  if (state === 'APPROVED') {
    const t = transitionContractLifecycle(db, {
      marketId,
      toState: 'ACTIVE',
      reason: 'ACTIVATED_BEFORE_SETTLEMENT',
      actor,
      ruleVersionId,
      transitionedAt: settledAt,
    });
    transitions.push(t);
    state = t.toState;
  }

  if (state === 'ACTIVE') {
    const t = transitionContractLifecycle(db, {
      marketId,
      toState: 'SETTLEMENT_PENDING',
      reason: 'CLOSE_TIME_PASSED_FOR_SETTLEMENT',
      actor,
      ruleVersionId,
      transitionedAt: settledAt,
    });
    transitions.push(t);
    state = t.toState;
  }

  const targetState: ContractLifecycleState =
    outcome === 'YES' || outcome === 'NO' ? 'RESOLVED' : 'VOIDED';

  let settlementId = existingSettlement?.settlement_id;
  if (!settlementId) {
    const digest = crypto
      .createHash('sha256')
      .update(`${venue}|${eventTicker}|${marketId}|${outcome}|${settledAt}`)
      .digest('hex')
      .slice(0, 24);
    settlementId = `set_${digest}`;
    const settlementPriceUsd = outcome === 'YES' ? 1 : 0;

    db.prepare(
      `INSERT INTO settlements (
        settlement_id, venue, event_ticker, market_ticker, rule_version_id,
        outcome, settlement_price_usd, settled_contracts, payout_usd,
        raw_settlement_json, settled_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      settlementId,
      venue,
      eventTicker,
      marketId,
      ruleVersionId,
      outcome,
      settlementPriceUsd,
      0,
      0,
      input.rawSettlementJson,
      settledAt
    );
  }

  if (state !== targetState) {
    const t = transitionContractLifecycle(db, {
      marketId,
      toState: targetState,
      reason: input.reason?.trim() || `DISCOVERY_SETTLEMENT_${outcome}`,
      actor,
      ruleVersionId,
      transitionedAt: settledAt,
    });
    transitions.push(t);
    state = t.toState;
  }

  return Object.freeze({
    settlementId,
    marketId,
    outcome,
    settledAt,
    alreadySettled: false,
    transitions: Object.freeze(transitions),
    lifecycleStateAfter: state,
  });
}
