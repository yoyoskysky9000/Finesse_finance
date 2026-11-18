import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  executionVault,
  type PreExitSweepInput,
  type PreExitSweepResult,
} from './ExecutionVault';

export const RISK_GUARD_SETTLED_CASH_CAP_PCT = 0.03; // Mandatory default-on 3% settled cash cap (within 2%-5% rule)
export const RISK_GUARD_BALANCE_MAX_AGE_MS = 60_000; // Fail-closed if > 60s stale

export type RiskGuardVenue = 'KALSHI' | 'PUBLIC_BROKERAGE';

/**
 * Supported bucket timeframes for deterministic idempotency:
 * - '90s': Explicit 90-second bucket preserving Kalshi HFT sniper stale-Maker auto-recycle requote behavior without Date.now() keys.
 * - '5m': 900s (15 min) cooldown matching ExecutionVault / champion_config.json.
 * - '15m': 2700s (45 min) cooldown matching ExecutionVault / champion_config.json.
 * - '1h': 14400s (4 hour) cooldown matching ExecutionVault / champion_config.json.
 */
export type RiskGuardTimeframe = '90s' | '5m' | '15m' | '1h';

export const RISK_GUARD_COOLDOWN_SECONDS: Record<RiskGuardTimeframe, number> = {
  '90s': 90,
  '5m': 900,
  '15m': 2700,
  '1h': 14400,
};

export interface SettledCashSnapshot {
  venue: RiskGuardVenue;
  settledCashUsd: number | null | undefined;
  syncOk: boolean;
  lastSyncAtMs: number | null | undefined;
  syncError?: string | null;
  nowMs?: number;
}

export interface VerifiedSettledCashResult {
  verified: boolean;
  code: 'VERIFIED' | 'BALANCE_UNVERIFIED_BLOCK' | 'INSUFFICIENT_SETTLED_CASH';
  settledCashUsd: number;
  settledCashCapUsd: number;
  syncAgeMs: number | null;
  reason: string;
}

export interface DeterministicKeyInput {
  symbol: string;
  side: string;
  strategyId: string;
  timeframe: RiskGuardTimeframe;
  timestampMs?: number;
  explicitBucket?: number;
}

export interface DeterministicKeyResult {
  idempotencyHash: string;
  rawTuple: string;
  symbol: string;
  side: string;
  strategyId: string;
  timeframe: RiskGuardTimeframe;
  cooldownSec: number;
  timeBucket: number;
}

export interface RiskGuardLockOutcome {
  orderId?: string;
  venueOrderId?: string;
  status?: string;
  approvedNotionalUsd?: number;
  approvedQuantity?: number;
  updatedAt?: string;
}

export interface RiskGuardLockRecord {
  idempotencyHash: string;
  rawTuple: string;
  venue: RiskGuardVenue;
  symbol: string;
  side: string;
  strategyId: string;
  timeframe: RiskGuardTimeframe;
  cooldownSec: number;
  timeBucket: number;
  lockedAtMs: number;
  expiresAtMs: number;
  outcome?: RiskGuardLockOutcome;
}

export interface RiskGuardEntryRequest {
  venue: RiskGuardVenue;
  symbol: string;
  side: string;
  strategyId: string;
  timeframe: RiskGuardTimeframe;
  requestedNotionalUsd?: number;
  requestedQuantity?: number;
  unitPriceUsd: number;
  isIntegerContracts?: boolean;
  settledCash: SettledCashSnapshot;
  timestampMs?: number;
  explicitBucket?: number;
  killSwitchActive?: boolean;
  killSwitchReason?: string;
  skipBucketLock?: boolean;
}

export type RiskGuardRejectionCode =
  | 'APPROVED'
  | 'GLOBAL_KILL_SWITCH_ACTIVE'
  | 'BALANCE_UNVERIFIED_BLOCK'
  | 'INSUFFICIENT_SETTLED_CASH'
  | 'SETTLED_CASH_3PCT_CAP_ZERO'
  | 'DUPLICATE_ORDER_IDEMPOTENCY_BLOCK';

export interface RiskGuardEntryDecision {
  ok: boolean;
  approved: boolean;
  code: RiskGuardRejectionCode;
  duplicateBlocked: boolean;
  venue: RiskGuardVenue;
  symbol: string;
  side: string;
  strategyId: string;
  timeframe: RiskGuardTimeframe;
  idempotencyHash: string;
  rawTuple: string;
  timeBucket: number;
  cooldownSec: number;
  remainingCooldownSec: number;
  settledCashUsd: number;
  settledCashCapUsd: number;
  requestedNotionalUsd: number;
  approvedNotionalUsd: number;
  approvedQuantity: number;
  approvedContracts: number;
  wasCapped: boolean;
  replayedOutcome?: RiskGuardLockOutcome;
  reason: string;
}

export class RiskGuard {
  private readonly lockLedger = new Map<string, RiskGuardLockRecord>();
  private readonly approvedHashCaps = new Map<
    string,
    { venue: RiskGuardVenue; approvedNotionalUsd: number; approvedContracts: number; expiresAtMs: number }
  >();
  private readonly customLedgerPath?: string;
  private sqliteDb: DatabaseSync | null = null;
  private sqliteDbPath: string | null = null;

  constructor(ledgerPath?: string) {
    this.customLedgerPath = ledgerPath;
    this.reloadFromDisk();
  }

  private getLedgerFilePath(): string {
    return (
      this.customLedgerPath ||
      process.env.QUANTPULSE_RISK_GUARD_PATH ||
      path.resolve(process.cwd(), '.quantpulse_risk_guard_ledger.json')
    );
  }

  private getSqliteFilePath(): string {
    const jsonPath = this.getLedgerFilePath();
    if (jsonPath.endsWith('.json')) {
      return `${jsonPath.slice(0, -5)}.sqlite`;
    }
    return `${jsonPath}.sqlite`;
  }

  private ensureSqliteConnection(): DatabaseSync {
    const targetPath = this.getSqliteFilePath();
    if (this.sqliteDb && this.sqliteDbPath === targetPath) {
      return this.sqliteDb;
    }
    if (this.sqliteDb) {
      try {
        this.sqliteDb.close();
      } catch {
        // Ignore close errors during test path swaps
      }
      this.sqliteDb = null;
    }

    let db: DatabaseSync;
    try {
      const dir = path.dirname(targetPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      db = new DatabaseSync(targetPath);
    } catch {
      db = new DatabaseSync(':memory:');
    }

    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA busy_timeout = 5000;');
    db.exec(`
      CREATE TABLE IF NOT EXISTS risk_guard_locks (
        idempotency_hash TEXT PRIMARY KEY,
        raw_tuple TEXT NOT NULL,
        venue TEXT NOT NULL,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        strategy_id TEXT NOT NULL,
        timeframe TEXT NOT NULL,
        cooldown_sec INTEGER NOT NULL,
        time_bucket INTEGER NOT NULL,
        locked_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        outcome_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_risk_guard_expires
        ON risk_guard_locks (expires_at_ms);
    `);

    this.sqliteDb = db;
    this.sqliteDbPath = targetPath;
    return db;
  }

  public reloadFromDisk(nowMs = Date.now()): void {
    this.lockLedger.clear();
    const ledgerPath = this.getLedgerFilePath();
    if (fs.existsSync(ledgerPath)) {
      try {
        const raw = fs.readFileSync(ledgerPath, 'utf-8');
        const parsed = JSON.parse(raw) as { locks?: RiskGuardLockRecord[] };
        if (Array.isArray(parsed.locks)) {
          for (const rec of parsed.locks) {
            if (rec && rec.idempotencyHash && rec.expiresAtMs > nowMs) {
              this.lockLedger.set(rec.idempotencyHash, rec);
            }
          }
        }
      } catch {
        // Ignore malformed disk ledger on load
      }
    }

    try {
      const db = this.ensureSqliteConnection();
      db.prepare('DELETE FROM risk_guard_locks WHERE expires_at_ms <= ?').run(nowMs);
      const rows = db
        .prepare(
          `SELECT idempotency_hash, raw_tuple, venue, symbol, side, strategy_id, timeframe,
                  cooldown_sec, time_bucket, locked_at_ms, expires_at_ms, outcome_json
           FROM risk_guard_locks WHERE expires_at_ms > ?`
        )
        .all(nowMs) as Array<{
        idempotency_hash: string;
        raw_tuple: string;
        venue: RiskGuardVenue;
        symbol: string;
        side: string;
        strategy_id: string;
        timeframe: RiskGuardTimeframe;
        cooldown_sec: number;
        time_bucket: number;
        locked_at_ms: number;
        expires_at_ms: number;
        outcome_json: string | null;
      }>;
      for (const r of rows) {
        let outcome: RiskGuardLockOutcome | undefined;
        if (r.outcome_json) {
          try {
            outcome = JSON.parse(r.outcome_json) as RiskGuardLockOutcome;
          } catch {
            outcome = undefined;
          }
        }
        this.lockLedger.set(r.idempotency_hash, {
          idempotencyHash: r.idempotency_hash,
          rawTuple: r.raw_tuple,
          venue: r.venue,
          symbol: r.symbol,
          side: r.side,
          strategyId: r.strategy_id,
          timeframe: r.timeframe,
          cooldownSec: Number(r.cooldown_sec),
          timeBucket: Number(r.time_bucket),
          lockedAtMs: Number(r.locked_at_ms),
          expiresAtMs: Number(r.expires_at_ms),
          outcome,
        });
      }
    } catch {
      // Fall back to JSON ledger if sqlite unavailable
    }
  }

  private persistLedgerToDisk(nowMs = Date.now()): void {
    const activeLocks: RiskGuardLockRecord[] = [];
    for (const [key, rec] of this.lockLedger.entries()) {
      if (rec.expiresAtMs > nowMs) {
        activeLocks.push(rec);
      } else {
        this.lockLedger.delete(key);
      }
    }
    try {
      const ledgerPath = this.getLedgerFilePath();
      const dir = path.dirname(ledgerPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(
        ledgerPath,
        JSON.stringify({ updatedAt: new Date(nowMs).toISOString(), locks: activeLocks }, null, 2),
        'utf-8'
      );
    } catch {
      // Non-fatal in read-only environments
    }
  }

  public clearLocksForTests(): void {
    this.lockLedger.clear();
    this.approvedHashCaps.clear();
    try {
      const db = this.ensureSqliteConnection();
      db.exec('DELETE FROM risk_guard_locks');
    } catch {
      // Ignore
    }
    const ledgerPath = this.getLedgerFilePath();
    if (fs.existsSync(ledgerPath)) {
      try {
        fs.unlinkSync(ledgerPath);
      } catch {
        // Ignore
      }
    }
  }

  /**
   * Derives a deterministic SHA-256 idempotency hash from:
   *   normalize(symbol) + ":" + normalize(side) + ":" + normalize(strategyId) + ":" + timeBucket
   * Never uses unbucketed Date.now() or Math.random().
   */
  public deriveDeterministicKey(input: DeterministicKeyInput): DeterministicKeyResult {
    const cooldownSec = RISK_GUARD_COOLDOWN_SECONDS[input.timeframe] ?? 2700;
    const nowMs = input.timestampMs ?? Date.now();
    const timeBucket =
      typeof input.explicitBucket === 'number' && Number.isFinite(input.explicitBucket)
        ? Math.floor(input.explicitBucket)
        : Math.floor(nowMs / (cooldownSec * 1000));
    const normSymbol = input.symbol.trim().toUpperCase();
    const normSide = input.side.trim().toUpperCase();
    const normStrategy = input.strategyId.trim().toUpperCase();
    const rawTuple = `${normSymbol}:${normSide}:${normStrategy}:${timeBucket}`;
    const idempotencyHash = crypto.createHash('sha256').update(rawTuple).digest('hex');

    return {
      idempotencyHash,
      rawTuple,
      symbol: normSymbol,
      side: normSide,
      strategyId: normStrategy,
      timeframe: input.timeframe,
      cooldownSec,
      timeBucket,
    };
  }

  /**
   * Fail-closed settled-cash check:
   * - Rejects null/non-finite balances, failed syncs, missing lastSyncAtMs, or syncs > 60s old with BALANCE_UNVERIFIED_BLOCK.
   * - Computes mandatory default-on 3% settled-cash cap solely from settled cash (never total equity or margin buying power).
   */
  public verifySettledCash(snapshot: SettledCashSnapshot): VerifiedSettledCashResult {
    const nowMs = snapshot.nowMs ?? Date.now();
    const syncAgeMs =
      snapshot.lastSyncAtMs !== null &&
      snapshot.lastSyncAtMs !== undefined &&
      Number.isFinite(snapshot.lastSyncAtMs)
        ? Math.max(0, nowMs - snapshot.lastSyncAtMs)
        : null;

    if (
      snapshot.settledCashUsd === null ||
      snapshot.settledCashUsd === undefined ||
      !Number.isFinite(snapshot.settledCashUsd) ||
      !snapshot.syncOk ||
      syncAgeMs === null ||
      syncAgeMs > RISK_GUARD_BALANCE_MAX_AGE_MS
    ) {
      const detail =
        snapshot.syncError ||
        (syncAgeMs === null
          ? `${snapshot.venue} settled cash has never been verified`
          : syncAgeMs > RISK_GUARD_BALANCE_MAX_AGE_MS
          ? `${snapshot.venue} settled cash sync is stale (${syncAgeMs}ms > ${RISK_GUARD_BALANCE_MAX_AGE_MS}ms)`
          : `${snapshot.venue} settled cash unavailable`);
      return {
        verified: false,
        code: 'BALANCE_UNVERIFIED_BLOCK',
        settledCashUsd: 0,
        settledCashCapUsd: 0,
        syncAgeMs,
        reason: `BALANCE_UNVERIFIED_BLOCK: ${detail}. Live order refused before routing.`,
      };
    }

    const settledCashUsd = Number(snapshot.settledCashUsd);
    if (settledCashUsd <= 0) {
      return {
        verified: false,
        code: 'INSUFFICIENT_SETTLED_CASH',
        settledCashUsd,
        settledCashCapUsd: 0,
        syncAgeMs,
        reason: `${snapshot.venue} settled cash is $${settledCashUsd.toFixed(2)} (<= $0.00); cannot open new position.`,
      };
    }

    const settledCashCapUsd = Number((settledCashUsd * RISK_GUARD_SETTLED_CASH_CAP_PCT).toFixed(4));
    return {
      verified: true,
      code: 'VERIFIED',
      settledCashUsd,
      settledCashCapUsd,
      syncAgeMs,
      reason: `Verified ${snapshot.venue} settled cash $${settledCashUsd.toFixed(2)} (3% cap = $${settledCashCapUsd.toFixed(2)}).`,
    };
  }

  /**
   * Unified Entry Gate:
   * 1) Kill-switch pre-check
   * 2) Fail-closed settled cash check (BALANCE_UNVERIFIED_BLOCK on null/failed/>60s stale)
   * 3) Mandatory 3% settled-cash size-down cap (before burning idempotency lock)
   * 4) Persistent SQLite + JSON SHA-256 bucket lock on symbol:side:strategy_id:time_bucket
   */
  public evaluateEntryOrder(req: RiskGuardEntryRequest): RiskGuardEntryDecision {
    const nowMs = req.timestampMs ?? Date.now();
    const keyInfo = this.deriveDeterministicKey({
      symbol: req.symbol,
      side: req.side,
      strategyId: req.strategyId,
      timeframe: req.timeframe,
      timestampMs: nowMs,
      explicitBucket: req.explicitBucket,
    });

    const unitPriceUsd = Math.max(0.01, Number.isFinite(req.unitPriceUsd) ? req.unitPriceUsd : 0.01);
    const requestedNotionalUsd =
      typeof req.requestedNotionalUsd === 'number' &&
      Number.isFinite(req.requestedNotionalUsd) &&
      req.requestedNotionalUsd > 0
        ? Number(req.requestedNotionalUsd.toFixed(4))
        : Number(
            (Math.max(0, req.requestedQuantity ?? 1) * unitPriceUsd).toFixed(4)
          );

    const makeReject = (
      code: Exclude<RiskGuardRejectionCode, 'APPROVED'>,
      reason: string,
      opts?: {
        duplicateBlocked?: boolean;
        settledCashUsd?: number;
        settledCashCapUsd?: number;
        remainingCooldownSec?: number;
        replayedOutcome?: RiskGuardLockOutcome;
        wasCapped?: boolean;
      }
    ): RiskGuardEntryDecision => ({
      ok: false,
      approved: false,
      code,
      duplicateBlocked: opts?.duplicateBlocked ?? false,
      venue: req.venue,
      symbol: keyInfo.symbol,
      side: keyInfo.side,
      strategyId: keyInfo.strategyId,
      timeframe: req.timeframe,
      idempotencyHash: keyInfo.idempotencyHash,
      rawTuple: keyInfo.rawTuple,
      timeBucket: keyInfo.timeBucket,
      cooldownSec: keyInfo.cooldownSec,
      remainingCooldownSec: opts?.remainingCooldownSec ?? 0,
      settledCashUsd: opts?.settledCashUsd ?? 0,
      settledCashCapUsd: opts?.settledCashCapUsd ?? 0,
      requestedNotionalUsd,
      approvedNotionalUsd: 0,
      approvedQuantity: 0,
      approvedContracts: 0,
      wasCapped: opts?.wasCapped ?? false,
      replayedOutcome: opts?.replayedOutcome,
      reason,
    });

    if (req.killSwitchActive) {
      return makeReject(
        'GLOBAL_KILL_SWITCH_ACTIVE',
        `Blocked by global kill switch: ${req.killSwitchReason || 'ACTIVE'}`
      );
    }

    const cashCheck = this.verifySettledCash({ ...req.settledCash, nowMs });
    if (!cashCheck.verified) {
      return makeReject(
        cashCheck.code === 'INSUFFICIENT_SETTLED_CASH'
          ? 'INSUFFICIENT_SETTLED_CASH'
          : 'BALANCE_UNVERIFIED_BLOCK',
        cashCheck.reason,
        {
          settledCashUsd: cashCheck.settledCashUsd,
          settledCashCapUsd: cashCheck.settledCashCapUsd,
        }
      );
    }

    const settledCashUsd = cashCheck.settledCashUsd;
    const settledCashCapUsd = cashCheck.settledCashCapUsd;
    const effectiveNotionalUsd = Number(
      Math.min(requestedNotionalUsd, settledCashCapUsd).toFixed(4)
    );
    const wasCapped = requestedNotionalUsd > settledCashCapUsd + 1e-6;

    let approvedContracts = 0;
    let approvedQuantity = 0;
    let approvedNotionalUsd = 0;

    if (req.isIntegerContracts) {
      approvedContracts = Math.floor(effectiveNotionalUsd / unitPriceUsd + 1e-9);
      approvedQuantity = approvedContracts;
      approvedNotionalUsd = Number((approvedContracts * unitPriceUsd).toFixed(4));
      if (approvedContracts < 1) {
        return makeReject(
          'SETTLED_CASH_3PCT_CAP_ZERO',
          `3% settled-cash cap ($${settledCashCapUsd.toFixed(2)} on $${settledCashUsd.toFixed(2)} settled cash) is below minimum 1-contract cost ($${unitPriceUsd.toFixed(2)}).`,
          {
            settledCashUsd,
            settledCashCapUsd,
            wasCapped: true,
          }
        );
      }
    } else {
      approvedQuantity = Number((effectiveNotionalUsd / unitPriceUsd).toFixed(4));
      approvedNotionalUsd = Number((approvedQuantity * unitPriceUsd).toFixed(4));
      approvedContracts = Math.floor(approvedQuantity);
      if (approvedQuantity <= 0 || approvedNotionalUsd <= 0) {
        return makeReject(
          'SETTLED_CASH_3PCT_CAP_ZERO',
          `3% settled-cash cap ($${settledCashCapUsd.toFixed(2)} on $${settledCashUsd.toFixed(2)}) yielded 0 executable quantity.`,
          {
            settledCashUsd,
            settledCashCapUsd,
            wasCapped: true,
          }
        );
      }
    }

    // Rule 2: Persistent SHA-256 idempotency lock across memory + SQLite + JSON disk ledger
    const expiresAtMs = nowMs + keyInfo.cooldownSec * 1000;
    let duplicateBlocked = false;
    let existingRecord = this.lockLedger.get(keyInfo.idempotencyHash);
    if (existingRecord && existingRecord.expiresAtMs <= nowMs) {
      this.lockLedger.delete(keyInfo.idempotencyHash);
      existingRecord = undefined;
    }

    if (!req.skipBucketLock) {
      try {
        const db = this.ensureSqliteConnection();
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare('DELETE FROM risk_guard_locks WHERE expires_at_ms <= ?').run(nowMs);
          const dbRow = db
            .prepare(
              `SELECT idempotency_hash, raw_tuple, venue, symbol, side, strategy_id, timeframe,
                      cooldown_sec, time_bucket, locked_at_ms, expires_at_ms, outcome_json
               FROM risk_guard_locks
               WHERE idempotency_hash = ? AND expires_at_ms > ?`
            )
            .get(keyInfo.idempotencyHash, nowMs) as
            | {
                idempotency_hash: string;
                raw_tuple: string;
                venue: RiskGuardVenue;
                symbol: string;
                side: string;
                strategy_id: string;
                timeframe: RiskGuardTimeframe;
                cooldown_sec: number;
                time_bucket: number;
                locked_at_ms: number;
                expires_at_ms: number;
                outcome_json: string | null;
              }
            | undefined;

          if (dbRow) {
            duplicateBlocked = true;
            let outcome: RiskGuardLockOutcome | undefined;
            if (dbRow.outcome_json) {
              try {
                outcome = JSON.parse(dbRow.outcome_json) as RiskGuardLockOutcome;
              } catch {
                outcome = undefined;
              }
            }
            existingRecord = {
              idempotencyHash: dbRow.idempotency_hash,
              rawTuple: dbRow.raw_tuple,
              venue: dbRow.venue,
              symbol: dbRow.symbol,
              side: dbRow.side,
              strategyId: dbRow.strategy_id,
              timeframe: dbRow.timeframe,
              cooldownSec: Number(dbRow.cooldown_sec),
              timeBucket: Number(dbRow.time_bucket),
              lockedAtMs: Number(dbRow.locked_at_ms),
              expiresAtMs: Number(dbRow.expires_at_ms),
              outcome,
            };
            db.exec('COMMIT');
          } else {
            const insertRes = db
              .prepare(
                `INSERT OR IGNORE INTO risk_guard_locks (
                  idempotency_hash, raw_tuple, venue, symbol, side, strategy_id, timeframe,
                  cooldown_sec, time_bucket, locked_at_ms, expires_at_ms, outcome_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
              )
              .run(
                keyInfo.idempotencyHash,
                keyInfo.rawTuple,
                req.venue,
                keyInfo.symbol,
                keyInfo.side,
                keyInfo.strategyId,
                req.timeframe,
                keyInfo.cooldownSec,
                keyInfo.timeBucket,
                nowMs,
                expiresAtMs
              );
            db.exec('COMMIT');
            if (Number(insertRes.changes) === 0) {
              duplicateBlocked = true;
            }
          }
        } catch (err) {
          try {
            db.exec('ROLLBACK');
          } catch {
            // Ignore rollback failure
          }
          throw err;
        }
      } catch {
        if (existingRecord && existingRecord.expiresAtMs > nowMs) {
          duplicateBlocked = true;
        }
      }

      if (!duplicateBlocked && existingRecord && existingRecord.expiresAtMs > nowMs) {
        duplicateBlocked = true;
      }

      if (duplicateBlocked) {
        const remainingCooldownSec = existingRecord
          ? Math.max(1, Math.ceil((existingRecord.expiresAtMs - nowMs) / 1000))
          : keyInfo.cooldownSec;
        return makeReject(
          'DUPLICATE_ORDER_IDEMPOTENCY_BLOCK',
          `Duplicate order blocked on ${keyInfo.symbol} (${keyInfo.side}, ${req.timeframe}=${keyInfo.cooldownSec}s bucket ${keyInfo.timeBucket}; remaining ${remainingCooldownSec}s).`,
          {
            duplicateBlocked: true,
            settledCashUsd,
            settledCashCapUsd,
            remainingCooldownSec,
            replayedOutcome: existingRecord?.outcome,
            wasCapped,
          }
        );
      }

      const lockRec: RiskGuardLockRecord = {
        idempotencyHash: keyInfo.idempotencyHash,
        rawTuple: keyInfo.rawTuple,
        venue: req.venue,
        symbol: keyInfo.symbol,
        side: keyInfo.side,
        strategyId: keyInfo.strategyId,
        timeframe: req.timeframe,
        cooldownSec: keyInfo.cooldownSec,
        timeBucket: keyInfo.timeBucket,
        lockedAtMs: nowMs,
        expiresAtMs,
      };
      this.lockLedger.set(keyInfo.idempotencyHash, lockRec);
      this.persistLedgerToDisk(nowMs);
    }

    this.approvedHashCaps.set(keyInfo.idempotencyHash, {
      venue: req.venue,
      approvedNotionalUsd,
      approvedContracts,
      expiresAtMs,
    });

    return {
      ok: true,
      approved: true,
      code: 'APPROVED',
      duplicateBlocked: false,
      venue: req.venue,
      symbol: keyInfo.symbol,
      side: keyInfo.side,
      strategyId: keyInfo.strategyId,
      timeframe: req.timeframe,
      idempotencyHash: keyInfo.idempotencyHash,
      rawTuple: keyInfo.rawTuple,
      timeBucket: keyInfo.timeBucket,
      cooldownSec: keyInfo.cooldownSec,
      remainingCooldownSec: keyInfo.cooldownSec,
      settledCashUsd,
      settledCashCapUsd,
      requestedNotionalUsd,
      approvedNotionalUsd,
      approvedQuantity,
      approvedContracts,
      wasCapped,
      reason: wasCapped
        ? `Approved & clamped to 3% settled-cash cap ($${approvedNotionalUsd.toFixed(2)} <= $${settledCashCapUsd.toFixed(2)} of $${settledCashUsd.toFixed(2)}).`
        : `Approved within 3% settled-cash cap ($${approvedNotionalUsd.toFixed(2)} <= $${settledCashCapUsd.toFixed(2)} of $${settledCashUsd.toFixed(2)}).`,
    };
  }

  public isActiveApprovedHash(hash: string, nowMs = Date.now()): boolean {
    const rec = this.approvedHashCaps.get(hash);
    return Boolean(rec && rec.expiresAtMs > nowMs);
  }

  public attachOrderOutcome(idempotencyHash: string, outcome: RiskGuardLockOutcome): void {
    const rec = this.lockLedger.get(idempotencyHash);
    const enriched: RiskGuardLockOutcome = {
      ...outcome,
      updatedAt: new Date().toISOString(),
    };
    if (rec) {
      rec.outcome = enriched;
      this.persistLedgerToDisk();
    }
    try {
      const db = this.ensureSqliteConnection();
      db.prepare('UPDATE risk_guard_locks SET outcome_json = ? WHERE idempotency_hash = ?').run(
        JSON.stringify(enriched),
        idempotencyHash
      );
    } catch {
      // Non-fatal
    }
  }

  /**
   * Rule 3 Pre-Exit Sweep:
   * 1. CancelAllOpenOrders(symbol)
   * 2. Poll fetchOpenOrdersCount(symbol) until 0 (balance/collateral release confirmed)
   * 3. Query exact settledPositionQty
   * 4. Dispatch venue close order strictly for min(requestedQty, settledPositionQty)
   */
  public async executeRule3PreExitSweep(input: PreExitSweepInput): Promise<PreExitSweepResult> {
    return executionVault.unwindPositionSafely(input);
  }
}

export const riskGuard = new RiskGuard();
