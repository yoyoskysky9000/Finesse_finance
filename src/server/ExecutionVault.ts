import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  CHAMPION_CONFIG,
  computeLiquidityHealthScore,
  evaluateChampionExitSignal,
  evaluateRegimeAndLiquidity,
  evaluateZeroFeeSettlementHoldExemption,
  type ChampionExitEvalInput,
  type ChampionExitEvalResult,
  type ObiSample,
  type RegimeAndLiquidityInput,
  type RegimeAndLiquidityVerdict,
} from './regimeLiquidityFilter';
import {
  evaluatePortfolioCorrelationAndCap,
  getLossFraction,
  type ActiveRiskPosition,
  type CorrelationMatrix,
  type PortfolioCorrelationGuardInput,
  type PortfolioCorrelationGuardResult,
} from '../risk/PortfolioCorrelationGuard';
import {
  LEAD_LAG_CHAMPION_VERSION,
  LEAD_LAG_DEFAULT_CONFIG,
  buildLeadLag900sIdempotencyKey,
  evaluateChampion260Envelope,
  evaluateGkx5Minute1StopTightening,
  evaluateGkx5Trigger,
  evaluateLeadLagAnomalyTriggers,
  evaluateSvb60Trigger,
  evaluateXvdTrigger,
  type LeadLagCombinedEvaluationInput,
  type LeadLagCombinedEvaluationResult,
  type LeadLagTriggerId,
} from '../strategies/LeadLagAnomalyTriggers';

export {
  evaluatePortfolioCorrelationAndCap,
  getLossFraction,
  LEAD_LAG_CHAMPION_VERSION,
  LEAD_LAG_DEFAULT_CONFIG,
  buildLeadLag900sIdempotencyKey,
  evaluateChampion260Envelope,
  evaluateGkx5Minute1StopTightening,
  evaluateGkx5Trigger,
  evaluateLeadLagAnomalyTriggers,
  evaluateSvb60Trigger,
  evaluateXvdTrigger,
};
export type {
  ActiveRiskPosition,
  CorrelationMatrix,
  PortfolioCorrelationGuardInput,
  PortfolioCorrelationGuardResult,
  LeadLagCombinedEvaluationInput,
  LeadLagCombinedEvaluationResult,
  LeadLagTriggerId,
};

export type CooldownTimeframe = '5m' | '15m' | '1h';

export const VAULT_COOLDOWN_SECONDS: Record<CooldownTimeframe, number> = {
  '5m': CHAMPION_CONFIG.risk_caps.idempotency_cooldowns_seconds['5m'],
  '15m': CHAMPION_CONFIG.risk_caps.idempotency_cooldowns_seconds['15m'],
  '1h': CHAMPION_CONFIG.risk_caps.idempotency_cooldowns_seconds['1h'],
};

export interface SettledCashSizingInput {
  riskAmountUsd: number;
  stopLossDistanceUsd: number;
  settledCashUsd: number;
  unitPriceUsd?: number;
}

export interface SettledCashSizingResult {
  approved: boolean;
  targetSize: number;
  riskBasedSize: number;
  settledCashCapSize: number;
  settledCashCapUsd: number;
  estimatedNotionalUsd: number;
  settledCashUsd: number;
  reason: string;
}

export interface IdempotencyLockInput {
  symbol: string;
  side: string;
  strategyId: string;
  timeframe: CooldownTimeframe;
  timestampMs?: number;
  explicitClientKey?: string;
}

export interface IdempotencyLockRecord {
  idempotencyHash: string;
  rawTuple: string;
  symbol: string;
  side: string;
  strategyId: string;
  timeframe: CooldownTimeframe;
  cooldownSec: number;
  timeBucket: number;
  lockedAtMs: number;
  expiresAtMs: number;
  orderId?: string;
}

export interface IdempotencyLockCheckResult {
  allowed: boolean;
  duplicateBlocked: boolean;
  idempotencyHash: string;
  rawTuple: string;
  timeBucket: number;
  cooldownSec: number;
  remainingCooldownSec: number;
  existingRecord?: IdempotencyLockRecord;
}

export interface PreExitSweepInput {
  symbol: string;
  exitSide: 'SELL' | 'SELL_YES' | 'SELL_NO' | 'ask' | 'bid';
  requestedQty: number;
  bestBidUsd: number;
  bestAskUsd: number;
  bboDepthUsd: number;
  obiSamples?: ObiSample[];
  nowMs?: number;
  cancelAllOpenOrders: (symbol: string) => Promise<number | { cancelledCount: number }>;
  fetchOpenOrdersCount: (symbol: string) => Promise<number>;
  fetchSettledPositionQty: (symbol: string) => Promise<number>;
  executeLimitOrder: (params: {
    symbol: string;
    side: PreExitSweepInput['exitSide'];
    quantity: number;
    limitPriceUsd: number;
    idempotencyHash: string;
    mode: 'LIMIT_1C_INSIDE_SPREAD' | 'PASSIVE_TWAP_MICRO_TRANCHE';
    trancheIndex?: number;
    totalTranches?: number;
  }) => Promise<{ ok: boolean; orderId?: string; status?: string }>;
  balanceConfirmMaxPolls?: number;
  balanceConfirmDelayMs?: number;
}

export interface PreExitSweepResult {
  ok: boolean;
  symbol: string;
  cancelledOpenOrders: number;
  balanceReleaseConfirmed: boolean;
  remainingOpenOrders: number;
  settledPositionQty: number;
  recalculatedLhs: number;
  exitStrategy: 'LIMIT_1C_INSIDE_SPREAD' | 'PASSIVE_TWAP_MICRO_TRANCHES' | 'ABORTED_LOCKED_INVENTORY';
  tranchesExecuted: Array<{
    trancheIndex: number;
    quantity: number;
    limitPriceUsd: number;
    ok: boolean;
    orderId?: string;
  }>;
  reason: string;
}

export interface TelemetryCompletenessResult {
  verified: boolean;
  reason: 'VERIFIED' | 'UNVERIFIED_MICROSTRUCTURE_TELEMETRY';
  missingFields: string[];
}

export interface LowBalanceCompounderRestingOrder {
  orderId: string;
  ticker: string;
  status: string;
  remainingCount?: number;
}

export interface LowBalanceCompounderEntryInput {
  ticker: string;
  side: 'BUY_YES' | 'BUY_NO';
  triggerId: 'SVB-60' | 'GKX-5';
  settledCashUsd: number;
  bestBidUsd: number;
  bestAskUsd: number;
  fairValueUsd: number;
  chop14: number;
  adx: number;
  lhs: number;
  bboDepthUsd?: number;
  obiSamples?: ObiSample[];
  timeframe?: CooldownTimeframe;
  timestampMs?: number;
  explicitClientKey?: string;
  fetchRestingOrdersForTicker: (ticker: string) => Promise<LowBalanceCompounderRestingOrder[]>;
  cancelRestingOrder: (orderId: string) => Promise<{ ok: boolean; error?: string }>;
  submitPostOnlyLimitBuy: (params: {
    ticker: string;
    side: 'BUY_YES' | 'BUY_NO';
    contracts: 1;
    limitPriceUsd: number;
    postOnly: true;
    timeInForce: 'good_till_canceled';
    cancelOrderOnPause: true;
    idempotencyHash: string;
  }) => Promise<{
    ok: boolean;
    orderId?: string;
    status: 'FILLED' | 'EXECUTED' | 'RESTING' | 'REJECTED';
    error?: string;
  }>;
  fetchOrderStatus: (orderId: string) => Promise<{
    status: 'FILLED' | 'EXECUTED' | 'RESTING' | 'CANCELLED';
    filledContracts?: number;
  }>;
  /** Default 12,000 ms (12 seconds) auto-cancel timer if unfilled */
  unfilledAutoCancelMs?: number;
  /** Poll cadence while waiting on resting post_only order; default 1000 ms */
  pollIntervalMs?: number;
  /** Optional sleep hook for deterministic tests */
  sleepMs?: (ms: number) => Promise<void>;
}

export interface LowBalanceCompounderEntryResult {
  ok: boolean;
  status:
    | 'FILLED'
    | 'RESTING'
    | 'AUTO_CANCELLED_UNFILLED_12S'
    | 'COMPOUNDER_INACTIVE_ABOVE_150'
    | 'GATE_BLOCKED'
    | 'OUTSIDE_COMPOUNDER_PRICE_BAND'
    | 'INSUFFICIENT_SETTLED_CASH_3PCT_CAP'
    | 'IDEMPOTENCY_LOCK_BLOCKED'
    | 'STALE_RESTING_ORDERS_NOT_CLEARED'
    | 'VENUE_REJECTED';
  tier: string;
  contracts: number;
  limitPriceUsd: number;
  postOnly: boolean;
  neverChaseMarketOrder: true;
  staleRestingOrdersFound: number;
  staleRestingOrdersCancelled: string[];
  remainingRestingOrdersBeforeEntry: number;
  autoCancelledAfter12s: boolean;
  chasedWithMarketOrder: false;
  orderId?: string;
  idempotencyHash?: string;
  blockedReasons: string[];
  reason: string;
}

export interface LowBalanceCompounderExitInput {
  exitEval: ChampionExitEvalInput;
  sweep: PreExitSweepInput;
}

export interface LowBalanceCompounderExitResult {
  evalResult: ChampionExitEvalResult;
  exitExecuted: boolean;
  zeroFeeSettlementHoldExempt: boolean;
  rule3SweepResult: PreExitSweepResult | null;
}

export interface VaultAuditEntry {
  ts: string;
  rule:
    | 'RULE_1_SETTLED_CASH_CAP'
    | 'RULE_2_IDEMPOTENCY_LOCK'
    | 'RULE_3_PRE_EXIT_SWEEP_LHS'
    | 'REGIME_LIQUIDITY_GATE'
    | 'TELEMETRY_COMPLETENESS_GATE'
    | 'PORTFOLIO_CORRELATION_GUARD'
    | 'LOW_BALANCE_COMPOUNDER';
  symbol: string;
  outcome: 'APPROVED' | 'REJECTED' | 'EXECUTED';
  detail: string;
}

/**
 * ExecutionVault — Locked execution guardrail kernel enforcing the 3 Post-Mortem Rules:
 *  Rule 1: Settled Cash Cap (targetSize = Math.min(riskAmount / stopLossDistance, settledCash * 0.03))
 *  Rule 2: Deterministic Idempotency Lock (sha256(symbol + side + strategy_id + time_bucket), cooldowns 900s / 2700s / 14400s)
 *  Rule 3: Pre-Exit Sweep & LHS Unwind (CancelAllOpenOrders -> confirm balance release -> recalculate LHS -> 1c inside spread or passive TWAP micro-tranches)
 */
export class ExecutionVault {
  private readonly idempotencyLockLedger = new Map<string, IdempotencyLockRecord>();
  private readonly auditLog: VaultAuditEntry[] = [];
  private readonly customPersistencePath?: string;
  private sqliteDb: DatabaseSync | null = null;
  private sqliteDbPath: string | null = null;

  constructor(persistencePath?: string) {
    this.customPersistencePath = persistencePath;
    this.ensureSqliteConnection();
    this.reloadFromDisk();
  }

  public getPersistencePath(): string {
    return (
      this.customPersistencePath ||
      process.env.QUANTPULSE_VAULT_LEDGER_PATH ||
      path.resolve(process.cwd(), '.quantpulse_vault_idempotency.json')
    );
  }

  public getSqliteDbPath(): string {
    if (!this.customPersistencePath && process.env.QUANTPULSE_VAULT_SQLITE_PATH) {
      return process.env.QUANTPULSE_VAULT_SQLITE_PATH;
    }
    const jsonPath = this.getPersistencePath();
    return jsonPath.endsWith('.json')
      ? `${jsonPath.slice(0, -5)}.sqlite`
      : `${jsonPath}.sqlite`;
  }

  private ensureSqliteConnection(): DatabaseSync {
    const targetPath = this.getSqliteDbPath();
    if (this.sqliteDb && this.sqliteDbPath === targetPath) {
      return this.sqliteDb;
    }
    if (this.sqliteDb) {
      try {
        this.sqliteDb.close();
      } catch {
        // Ignore close failure
      }
      this.sqliteDb = null;
    }
    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const db = new DatabaseSync(targetPath);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;');
    db.exec(`
      CREATE TABLE IF NOT EXISTS order_ledger (
        order_id TEXT PRIMARY KEY,
        client_order_id TEXT,
        idempotency_key TEXT NOT NULL,
        venue TEXT,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        quantity TEXT,
        price TEXT,
        status TEXT NOT NULL,
        raw_venue_response TEXT,
        raw_tuple TEXT,
        strategy_id TEXT,
        timeframe TEXT,
        cooldown_sec INTEGER,
        time_bucket INTEGER,
        locked_at_ms INTEGER,
        expires_at_ms INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_order_ledger_idempotency_key
        ON order_ledger(idempotency_key);
    `);
    this.sqliteDb = db;
    this.sqliteDbPath = targetPath;
    return db;
  }

  public reloadFromDisk(nowMs = Date.now()): void {
    this.idempotencyLockLedger.clear();
    try {
      const db = this.ensureSqliteConnection();
      const rows = db
        .prepare(
          `SELECT order_id, idempotency_key, raw_tuple, symbol, side, strategy_id,
                  timeframe, cooldown_sec, time_bucket, locked_at_ms, expires_at_ms
           FROM order_ledger
           WHERE expires_at_ms > ?`
        )
        .all(nowMs) as Array<Record<string, unknown>>;
      for (const row of rows) {
        const hash = String(row.idempotency_key || '');
        if (!hash) continue;
        const ordId = String(row.order_id || '');
        this.idempotencyLockLedger.set(hash, {
          idempotencyHash: hash,
          rawTuple: String(row.raw_tuple || ''),
          symbol: String(row.symbol || ''),
          side: String(row.side || ''),
          strategyId: String(row.strategy_id || ''),
          timeframe: (String(row.timeframe || '15m') as CooldownTimeframe),
          cooldownSec: Number(row.cooldown_sec || 2700),
          timeBucket: Number(row.time_bucket || 0),
          lockedAtMs: Number(row.locked_at_ms || nowMs),
          expiresAtMs: Number(row.expires_at_ms || 0),
          orderId: ordId && !ordId.startsWith('LOCK:') ? ordId : undefined,
        });
      }
    } catch {
      // Fall back to JSON ledger if SQLite unavailable
    }
    const filePath = this.getPersistencePath();
    try {
      if (!fs.existsSync(filePath)) return;
      const raw = fs.readFileSync(filePath, 'utf8');
      if (!raw.trim()) return;
      const parsed = JSON.parse(raw) as { records?: IdempotencyLockRecord[] };
      for (const rec of parsed.records || []) {
        if (rec && typeof rec.idempotencyHash === 'string' && rec.expiresAtMs > nowMs && !this.idempotencyLockLedger.has(rec.idempotencyHash)) {
          this.idempotencyLockLedger.set(rec.idempotencyHash, rec);
        }
      }
    } catch {
      // Fail safe without crashing if ledger file is malformed/uninitialized
    }
  }

  private persistLedgerToDisk(nowMs = Date.now()): void {
    const filePath = this.getPersistencePath();
    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const activeRecords = Array.from(this.idempotencyLockLedger.values()).filter(
        (rec) => rec.expiresAtMs > nowMs
      );
      const tmpPath = `${filePath}.${process.pid}.tmp`;
      fs.writeFileSync(
        tmpPath,
        JSON.stringify({ updatedAt: new Date(nowMs).toISOString(), records: activeRecords }, null, 2),
        'utf8'
      );
      fs.renameSync(tmpPath, filePath);
    } catch {
      // Ignore write failures on read-only containers
    }
  }

  private pushAudit(entry: VaultAuditEntry): void {
    this.auditLog.unshift(entry);
    if (this.auditLog.length > 250) {
      this.auditLog.pop();
    }
  }

  public getAuditLog(): VaultAuditEntry[] {
    return [...this.auditLog];
  }

  public clearLocksForTests(): void {
    this.idempotencyLockLedger.clear();
    try {
      const db = this.ensureSqliteConnection();
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec('DELETE FROM order_ledger');
        db.exec('COMMIT');
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // Ignore rollback failure
        }
        throw err;
      }
    } catch {
      // Ignore test cleanup errors
    }
    this.persistLedgerToDisk();
  }

  public deriveDeterministicIdempotencyKey(
    input: Omit<IdempotencyLockInput, 'explicitClientKey'>
  ): {
    idempotencyHash: string;
    rawTuple: string;
    timeBucket: number;
    cooldownSec: number;
    normSymbol: string;
    normSide: string;
    normStrategy: string;
  } {
    const nowMs = input.timestampMs ?? Date.now();
    const cooldownSec = VAULT_COOLDOWN_SECONDS[input.timeframe] ?? 2700;
    const timeBucket = Math.floor(nowMs / (cooldownSec * 1000));
    const normSymbol = input.symbol.trim().toUpperCase();
    const normSide = input.side.trim().toUpperCase();
    const normStrategy = input.strategyId.trim().toUpperCase();
    const rawTuple = `${normSymbol}:${normSide}:${normStrategy}:${timeBucket}`;
    const idempotencyHash = crypto
      .createHash('sha256')
      .update(rawTuple)
      .digest('hex');
    return {
      idempotencyHash,
      rawTuple,
      timeBucket,
      cooldownSec,
      normSymbol,
      normSide,
      normStrategy,
    };
  }

  /**
   * Post-Mortem Rule 1 (Settled Cash Cap):
   * targetSize = Math.min(riskAmount / stopLossDistance, settledCash * 0.03)
   * Strictly uses settled, available cash ONLY — never equity or margin buying power.
   */
  public computeSettledCashTargetSize(
    input: SettledCashSizingInput
  ): SettledCashSizingResult {
    const capFraction = CHAMPION_CONFIG.risk_caps.settled_cash_cap_fraction; // 0.03
    const settledCashUsd = Number(Math.max(0, input.settledCashUsd).toFixed(4));
    const settledCashCapUsd = Number((settledCashUsd * capFraction).toFixed(4));
    const unitPriceUsd =
      typeof input.unitPriceUsd === 'number' && input.unitPriceUsd > 0
        ? input.unitPriceUsd
        : 1.0;

    if (settledCashUsd <= 0 || settledCashCapUsd <= 0) {
      return {
        approved: false,
        targetSize: 0,
        riskBasedSize: 0,
        settledCashCapSize: 0,
        settledCashCapUsd,
        estimatedNotionalUsd: 0,
        settledCashUsd,
        reason: `Settled available cash is $${settledCashUsd.toFixed(2)}; 0 size permitted.`,
      };
    }

    if (input.stopLossDistanceUsd <= 0 || input.riskAmountUsd <= 0) {
      return {
        approved: false,
        targetSize: 0,
        riskBasedSize: 0,
        settledCashCapSize: 0,
        settledCashCapUsd,
        estimatedNotionalUsd: 0,
        settledCashUsd,
        reason: 'Invalid riskAmountUsd or stopLossDistanceUsd (must be > 0).',
      };
    }

    const riskBasedSize = Number((input.riskAmountUsd / input.stopLossDistanceUsd).toFixed(4));
    const settledCashCapSize = Number(
      (settledCashCapUsd / Math.max(1e-6, unitPriceUsd)).toFixed(4)
    );
    // Exact contract formula requested: Math.min(riskAmount / stopLossDistance, settledCash * 0.03)
    // and notional-safe conversion when unitPriceUsd !== 1
    const rawFormulaCap = Math.min(riskBasedSize, settledCashCapUsd);
    const targetSize =
      unitPriceUsd !== 1.0
        ? Number(Math.min(riskBasedSize, settledCashCapSize).toFixed(4))
        : Number(rawFormulaCap.toFixed(4));
    const estimatedNotionalUsd = Number((targetSize * unitPriceUsd).toFixed(2));

    const approved = targetSize > 0 && estimatedNotionalUsd <= settledCashCapUsd + 0.01;
    const reason = approved
      ? `Settled-cash sizing approved: targetSize=${targetSize} ($${estimatedNotionalUsd.toFixed(2)} <= 3% cap $${settledCashCapUsd.toFixed(2)} of $${settledCashUsd.toFixed(2)} settled cash).`
      : `Rejected: estimated notional $${estimatedNotionalUsd.toFixed(2)} exceeds 3% settled-cash cap $${settledCashCapUsd.toFixed(2)}.`;

    return {
      approved,
      targetSize,
      riskBasedSize,
      settledCashCapSize,
      settledCashCapUsd,
      estimatedNotionalUsd,
      settledCashUsd,
      reason,
    };
  }

  /**
   * Post-Mortem Rule 2 (Deterministic Idempotency Lock):
   * Hash `symbol + side + strategy_id + time_bucket` with strict cooldowns:
   *  - 5m  -> 900s
   *  - 15m -> 2700s
   *  - 1h  -> 14400s
   * Blocks any duplicate order within the active bucket.
   */
  public acquireIdempotencyLock(
    input: IdempotencyLockInput
  ): IdempotencyLockCheckResult {
    const nowMs = input.timestampMs ?? Date.now();
    const cooldownSec = VAULT_COOLDOWN_SECONDS[input.timeframe] ?? 2700;
    const timeBucket = Math.floor(nowMs / (cooldownSec * 1000));
    const normSymbol = input.symbol.trim().toUpperCase();
    const normSide = input.side.trim().toUpperCase();
    const normStrategy = input.strategyId.trim().toUpperCase();
    const rawTuple = input.explicitClientKey
      ? `${normSymbol}:${normSide}:${normStrategy}:${timeBucket}:${input.explicitClientKey}`
      : `${normSymbol}:${normSide}:${normStrategy}:${timeBucket}`;

    const idempotencyHash = crypto
      .createHash('sha256')
      .update(rawTuple)
      .digest('hex');

    const expiresAtMs = nowMs + cooldownSec * 1000;
    const db = this.ensureSqliteConnection();
    let existingRecord: IdempotencyLockRecord | undefined;
    let duplicateBlocked = false;

    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(
        'DELETE FROM order_ledger WHERE idempotency_key = ? AND expires_at_ms <= ?'
      ).run(idempotencyHash, nowMs);

      const insertRes = db
        .prepare(
          `INSERT INTO order_ledger (
            order_id, client_order_id, idempotency_key, venue, symbol, side,
            quantity, price, status, raw_venue_response, raw_tuple, strategy_id,
            timeframe, cooldown_sec, time_bucket, locked_at_ms, expires_at_ms, created_at
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE NOT EXISTS (
            SELECT 1 FROM order_ledger
            WHERE idempotency_key = ?
              AND expires_at_ms > ?
          )`
        )
        .run(
          `LOCK:${idempotencyHash}`,
          idempotencyHash,
          idempotencyHash,
          'EXECUTION_VAULT',
          normSymbol,
          normSide,
          '0',
          '0',
          'LOCKED_PRE_EXCHANGE',
          '',
          rawTuple,
          normStrategy,
          input.timeframe,
          cooldownSec,
          timeBucket,
          nowMs,
          expiresAtMs,
          new Date(nowMs).toISOString(),
          idempotencyHash,
          nowMs
        );

      if (Number(insertRes.changes) === 0) {
        duplicateBlocked = true;
        const row = db
          .prepare(
            `SELECT order_id, idempotency_key, raw_tuple, symbol, side, strategy_id,
                    timeframe, cooldown_sec, time_bucket, locked_at_ms, expires_at_ms
             FROM order_ledger
             WHERE idempotency_key = ? AND expires_at_ms > ?
             LIMIT 1`
          )
          .get(idempotencyHash, nowMs) as Record<string, unknown> | undefined;
        if (row) {
          const ordId = String(row.order_id || '');
          existingRecord = {
            idempotencyHash: String(row.idempotency_key || idempotencyHash),
            rawTuple: String(row.raw_tuple || rawTuple),
            symbol: String(row.symbol || normSymbol),
            side: String(row.side || normSide),
            strategyId: String(row.strategy_id || normStrategy),
            timeframe: String(row.timeframe || input.timeframe) as CooldownTimeframe,
            cooldownSec: Number(row.cooldown_sec || cooldownSec),
            timeBucket: Number(row.time_bucket || timeBucket),
            lockedAtMs: Number(row.locked_at_ms || nowMs),
            expiresAtMs: Number(row.expires_at_ms || expiresAtMs),
            orderId: ordId && !ordId.startsWith('LOCK:') ? ordId : undefined,
          };
        }
      }
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Ignore rollback failure
      }
      throw err;
    }

    if (duplicateBlocked) {
      const activeExisting = existingRecord || this.idempotencyLockLedger.get(idempotencyHash);
      if (activeExisting) {
        this.idempotencyLockLedger.set(idempotencyHash, activeExisting);
      }
      const remainingCooldownSec = activeExisting
        ? Math.max(1, Math.ceil((activeExisting.expiresAtMs - nowMs) / 1000))
        : cooldownSec;
      this.pushAudit({
        ts: new Date(nowMs).toISOString(),
        rule: 'RULE_2_IDEMPOTENCY_LOCK',
        symbol: normSymbol,
        outcome: 'REJECTED',
        detail: `Duplicate order blocked in active ${input.timeframe} (${cooldownSec}s) bucket ${timeBucket}; remaining cooldown ${remainingCooldownSec}s.`,
      });
      return {
        allowed: false,
        duplicateBlocked: true,
        idempotencyHash,
        rawTuple,
        timeBucket,
        cooldownSec,
        remainingCooldownSec,
        existingRecord: activeExisting,
      };
    }

    const record: IdempotencyLockRecord = {
      idempotencyHash,
      rawTuple,
      symbol: normSymbol,
      side: normSide,
      strategyId: normStrategy,
      timeframe: input.timeframe,
      cooldownSec,
      timeBucket,
      lockedAtMs: nowMs,
      expiresAtMs,
    };
    this.idempotencyLockLedger.set(idempotencyHash, record);
    this.persistLedgerToDisk(nowMs);
    this.pushAudit({
      ts: new Date(nowMs).toISOString(),
      rule: 'RULE_2_IDEMPOTENCY_LOCK',
      symbol: normSymbol,
      outcome: 'APPROVED',
      detail: `Acquired deterministic lock ${idempotencyHash.slice(0, 12)} for ${normSymbol} ${normSide} (${input.timeframe} cooldown=${cooldownSec}s).`,
    });

    return {
      allowed: true,
      duplicateBlocked: false,
      idempotencyHash,
      rawTuple,
      timeBucket,
      cooldownSec,
      remainingCooldownSec: cooldownSec,
      existingRecord: record,
    };
  }

  public attachOrderIdToLock(idempotencyHash: string, orderId: string): void {
    const rec = this.idempotencyLockLedger.get(idempotencyHash);
    if (rec) {
      rec.orderId = orderId;
      this.persistLedgerToDisk();
    }
    try {
      const db = this.ensureSqliteConnection();
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare(
          "UPDATE order_ledger SET order_id = ?, status = 'ORDER_ATTACHED' WHERE idempotency_key = ?"
        ).run(orderId, idempotencyHash);
        db.exec('COMMIT');
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // Ignore rollback failure
        }
        throw err;
      }
    } catch {
      // Ignore sqlite update failure when no matching row exists
    }
  }

  /**
   * Telemetry Completeness Gate (TASK-08 / 2.6.0-PORTFOLIO-GUARD-CHAMPION):
   * Blocks basic 24h ticker snapshots or any payload missing live 5m/15m CHOP, ADX,
   * or order-book LHS depth telemetry before new entries can proceed.
   */
  public verifyMicrostructureTelemetry(
    input: RegimeAndLiquidityInput
  ): TelemetryCompletenessResult {
    const missingFields: string[] = [];
    const regCfg = CHAMPION_CONFIG.active_strategy.regime_filters;
    const bars = Array.isArray(input.bars) ? input.bars : [];
    const adxPeriod =
      input.timeframe === '5m' ? regCfg.adx_period_5m : regCfg.adx_period_15m_1h;

    if (input.is24hTickerSnapshot === true) {
      missingFields.push('24h_ticker_snapshot_only');
    }

    const hasLiveChop =
      (typeof input.metricsOverride?.chop14 === 'number' &&
        Number.isFinite(input.metricsOverride.chop14)) ||
      bars.length >= regCfg.chop14_period + 1;
    if (!hasLiveChop) {
      missingFields.push('live_5m_15m_CHOP');
    }

    const hasLiveAdx =
      (typeof input.metricsOverride?.adx === 'number' &&
        Number.isFinite(input.metricsOverride.adx)) ||
      bars.length >= adxPeriod + 2;
    if (!hasLiveAdx) {
      missingFields.push('live_5m_15m_ADX');
    }

    const hasValidBbo =
      Number.isFinite(input.bestBidUsd) &&
      input.bestBidUsd > 0 &&
      Number.isFinite(input.bestAskUsd) &&
      input.bestAskUsd >= input.bestBidUsd &&
      Number.isFinite(input.bboDepthUsd) &&
      input.bboDepthUsd > 0;
    const hasObiSamples =
      Array.isArray(input.obiSamples) &&
      input.obiSamples.some(
        (s) =>
          Number.isFinite(s.tsMs) &&
          Number.isFinite(s.bidDepthUsd) &&
          Number.isFinite(s.askDepthUsd) &&
          s.bidDepthUsd + s.askDepthUsd > 0
      );
    if (!hasValidBbo || !hasObiSamples) {
      missingFields.push('orderbook_LHS_depth_telemetry');
    }

    if (missingFields.length > 0) {
      return {
        verified: false,
        reason: 'UNVERIFIED_MICROSTRUCTURE_TELEMETRY',
        missingFields,
      };
    }

    return {
      verified: true,
      reason: 'VERIFIED',
      missingFields: [],
    };
  }

  /**
   * Executes multi-position correlation stress and 3.5% 15m drawdown ceiling guard
   * immediately after the atomic idempotency lock and before exchange routing.
   */
  public evaluatePostLockPortfolioGuard(
    input: PortfolioCorrelationGuardInput
  ): PortfolioCorrelationGuardResult {
    const result = evaluatePortfolioCorrelationAndCap(input);
    this.pushAudit({
      ts: new Date().toISOString(),
      rule: 'PORTFOLIO_CORRELATION_GUARD',
      symbol: input.candidate.symbol,
      outcome: result.allowed ? 'APPROVED' : 'REJECTED',
      detail: `${result.reason} | approvedNotional=$${result.approvedNotionalUsd.toFixed(2)}, maxRho=${result.maxRho.toFixed(3)}, stress=${result.stressMultiplier.toFixed(3)}, adjustedRisk=$${result.adjustedRiskUsd.toFixed(4)}/max=$${result.maxRiskUsd.toFixed(4)}`,
    });
    return result;
  }

  /**
   * Unified Pre-Trade Vault Gate combining:
   *  1. Telemetry Completeness Gate (UNVERIFIED_MICROSTRUCTURE_TELEMETRY block)
   *  2. Regime + Liquidity Filter + Rule 1 (Settled Cash Cap)
   *  3. Rule 2 (Atomic Idempotency Hash Lock: symbol + side + strategy_id + time_bucket)
   *  4. 2.6.0 PortfolioCorrelationGuard (executed AFTER idempotency lock, BEFORE exchange routing)
   */
  public validateEntryOrder(params: {
    regimeAndLiquidity: RegimeAndLiquidityInput;
    sizing: SettledCashSizingInput;
    idempotency: IdempotencyLockInput;
    portfolioCorrelation?: {
      activePositions?: ActiveRiskPosition[];
      correlationMatrix?: CorrelationMatrix;
      requestedNotionalUsd?: number;
      lotSizeUsd?: number;
      exchangeLotSizeContracts?: number;
      unknownCorrelation?: number;
    };
  }): {
    approved: boolean;
    reason?: string;
    telemetryCheck: TelemetryCompletenessResult;
    regimeVerdict: RegimeAndLiquidityVerdict | null;
    sizingResult: SettledCashSizingResult | null;
    lockResult: IdempotencyLockCheckResult | null;
    portfolioCorrelationResult: PortfolioCorrelationGuardResult | null;
    approvedNotionalUsd: number;
    reasons: string[];
  } {
    const telemetryCheck = this.verifyMicrostructureTelemetry(params.regimeAndLiquidity);
    if (!telemetryCheck.verified) {
      this.pushAudit({
        ts: new Date().toISOString(),
        rule: 'TELEMETRY_COMPLETENESS_GATE',
        symbol: params.idempotency.symbol,
        outcome: 'REJECTED',
        detail: `${telemetryCheck.reason}: missing [${telemetryCheck.missingFields.join(', ')}]`,
      });
      return {
        approved: false,
        reason: telemetryCheck.reason,
        telemetryCheck,
        regimeVerdict: null,
        sizingResult: null,
        lockResult: null,
        portfolioCorrelationResult: null,
        approvedNotionalUsd: 0,
        reasons: [
          telemetryCheck.reason,
          `Missing microstructure telemetry: ${telemetryCheck.missingFields.join(', ')}`,
        ],
      };
    }

    const regimeVerdict = evaluateRegimeAndLiquidity(params.regimeAndLiquidity);
    const sizingResult = this.computeSettledCashTargetSize(params.sizing);
    const reasons: string[] = [
      ...regimeVerdict.pauseReasons,
      ...regimeVerdict.blockReasons,
    ];
    if (!sizingResult.approved) {
      reasons.push(sizingResult.reason);
    }

    if (!regimeVerdict.approved || !sizingResult.approved) {
      this.pushAudit({
        ts: new Date().toISOString(),
        rule: !sizingResult.approved ? 'RULE_1_SETTLED_CASH_CAP' : 'REGIME_LIQUIDITY_GATE',
        symbol: params.idempotency.symbol,
        outcome: 'REJECTED',
        detail: reasons.join(' | '),
      });
      return {
        approved: false,
        reason: !sizingResult.approved ? 'SETTLED_CASH_CAP_BLOCKED' : 'REGIME_OR_LIQUIDITY_BLOCKED',
        telemetryCheck,
        regimeVerdict,
        sizingResult,
        lockResult: null,
        portfolioCorrelationResult: null,
        approvedNotionalUsd: 0,
        reasons,
      };
    }

    // Rule 2: Atomic Idempotency Hash Lock (symbol + side + strategy_id + time_bucket)
    const lockResult = this.acquireIdempotencyLock(params.idempotency);
    if (!lockResult.allowed) {
      const lockMsg = `Duplicate order blocked within ${lockResult.cooldownSec}s cooldown bucket (remaining ${lockResult.remainingCooldownSec}s).`;
      reasons.push(lockMsg);
      return {
        approved: false,
        reason: 'IDEMPOTENCY_LOCK_BLOCKED',
        telemetryCheck,
        regimeVerdict,
        sizingResult,
        lockResult,
        portfolioCorrelationResult: null,
        approvedNotionalUsd: 0,
        reasons,
      };
    }

    // 2.6.0-PORTFOLIO-GUARD-CHAMPION: Call evaluatePortfolioCorrelationAndCap() immediately AFTER
    // the atomic idempotency hash lock and BEFORE routing to mcp_server.py / exchange API
    const requestedNotionalUsd =
      params.portfolioCorrelation?.requestedNotionalUsd ?? sizingResult.estimatedNotionalUsd;
    const portfolioCorrelationResult = evaluatePortfolioCorrelationAndCap({
      settledCash: params.sizing.settledCashUsd,
      activePositions: params.portfolioCorrelation?.activePositions || [],
      candidate: {
        symbol: params.idempotency.symbol,
        requestedNotionalUsd,
        ask: params.regimeAndLiquidity.askPriceUsd,
        atrDollar: params.regimeAndLiquidity.atr14Usd,
        lotSizeUsd: params.portfolioCorrelation?.lotSizeUsd,
        exchangeLotSizeContracts: params.portfolioCorrelation?.exchangeLotSizeContracts,
      },
      correlationMatrix: params.portfolioCorrelation?.correlationMatrix || {},
      lotSizeUsd: params.portfolioCorrelation?.lotSizeUsd,
      unknownCorrelation: params.portfolioCorrelation?.unknownCorrelation,
    });
    this.pushAudit({
      ts: new Date().toISOString(),
      rule: 'PORTFOLIO_CORRELATION_GUARD',
      symbol: params.idempotency.symbol,
      outcome: portfolioCorrelationResult.allowed ? 'APPROVED' : 'REJECTED',
      detail: `${portfolioCorrelationResult.reason} | approvedNotional=$${portfolioCorrelationResult.approvedNotionalUsd.toFixed(2)}, maxRho=${portfolioCorrelationResult.maxRho.toFixed(3)}, stress=${portfolioCorrelationResult.stressMultiplier.toFixed(3)}, adjustedRisk=$${portfolioCorrelationResult.adjustedRiskUsd.toFixed(4)}/max=$${portfolioCorrelationResult.maxRiskUsd.toFixed(4)}`,
    });

    if (!portfolioCorrelationResult.allowed) {
      reasons.push(portfolioCorrelationResult.reason);
      return {
        approved: false,
        reason: portfolioCorrelationResult.reason,
        telemetryCheck,
        regimeVerdict,
        sizingResult,
        lockResult,
        portfolioCorrelationResult,
        approvedNotionalUsd: 0,
        reasons,
      };
    }

    return {
      approved: true,
      reason: 'APPROVED',
      telemetryCheck,
      regimeVerdict,
      sizingResult,
      lockResult,
      portfolioCorrelationResult,
      approvedNotionalUsd: portfolioCorrelationResult.approvedNotionalUsd,
      reasons: [],
    };
  }

  /**
   * Executes an entry order through the full locked sequence:
   * Telemetry Completeness Gate -> Regime/Sizing -> Atomic Idempotency Lock ->
   * PortfolioCorrelationGuard -> Exchange API routing callback.
   */
  public async executeEntryWithPortfolioGuard<TExchangeResult>(params: {
    regimeAndLiquidity: RegimeAndLiquidityInput;
    sizing: SettledCashSizingInput;
    idempotency: IdempotencyLockInput;
    portfolioCorrelation?: {
      activePositions?: ActiveRiskPosition[];
      correlationMatrix?: CorrelationMatrix;
      requestedNotionalUsd?: number;
      lotSizeUsd?: number;
      exchangeLotSizeContracts?: number;
      unknownCorrelation?: number;
    };
    routeOrderToExchange: (approvedNotionalUsd: number) => Promise<TExchangeResult>;
  }): Promise<{
    approved: boolean;
    reason?: string;
    approvedNotionalUsd: number;
    exchangeResult?: TExchangeResult;
    validation: ReturnType<ExecutionVault['validateEntryOrder']>;
  }> {
    const validation = this.validateEntryOrder({
      regimeAndLiquidity: params.regimeAndLiquidity,
      sizing: params.sizing,
      idempotency: params.idempotency,
      portfolioCorrelation: params.portfolioCorrelation,
    });
    if (!validation.approved) {
      return {
        approved: false,
        reason: validation.reason,
        approvedNotionalUsd: 0,
        validation,
      };
    }

    const exchangeResult = await params.routeOrderToExchange(validation.approvedNotionalUsd);
    return {
      approved: true,
      reason: 'EXECUTED',
      approvedNotionalUsd: validation.approvedNotionalUsd,
      exchangeResult,
      validation,
    };
  }

  /**
   * Post-Mortem Rule 3 (Pre-Exit Sweep & LHS Unwind):
   * 1. Call CancelAllOpenOrders(symbol)
   * 2. Wait for balance/collateral release confirmation (openOrders == 0 & exact settledPositionQty)
   * 3. Recalculate Liquidity Health Score (LHS)
   * 4. Execute limit exit 1 cent inside spread if LHS >= 0.65, or passive TWAP micro-tranches if LHS < 0.65
   */
  public async unwindPositionSafely(
    input: PreExitSweepInput
  ): Promise<PreExitSweepResult> {
    const sweepCfg = CHAMPION_CONFIG.risk_caps.pre_exit_sweep;
    const cancelRes = await input.cancelAllOpenOrders(input.symbol);
    const cancelledOpenOrders =
      typeof cancelRes === 'number' ? cancelRes : cancelRes.cancelledCount;

    const maxPolls = input.balanceConfirmMaxPolls ?? 3;
    const pollDelayMs = input.balanceConfirmDelayMs ?? 150;
    let remainingOpenOrders = await input.fetchOpenOrdersCount(input.symbol);
    let settledPositionQty = await input.fetchSettledPositionQty(input.symbol);

    for (let attempt = 0; attempt < maxPolls && remainingOpenOrders > 0; attempt += 1) {
      if (pollDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, pollDelayMs));
      }
      remainingOpenOrders = await input.fetchOpenOrdersCount(input.symbol);
      settledPositionQty = await input.fetchSettledPositionQty(input.symbol);
    }

    const balanceReleaseConfirmed = remainingOpenOrders === 0;
    const lhsEval = computeLiquidityHealthScore({
      bestBidUsd: input.bestBidUsd,
      bestAskUsd: input.bestAskUsd,
      bboDepthUsd: input.bboDepthUsd,
      obiSamples: input.obiSamples,
      nowMs: input.nowMs,
    });

    if (!balanceReleaseConfirmed) {
      const reason = `Aborted close on ${input.symbol}: ${remainingOpenOrders} open resting orders remain after CancelAllOpenOrders sweep; collateral not released.`;
      this.pushAudit({
        ts: new Date().toISOString(),
        rule: 'RULE_3_PRE_EXIT_SWEEP_LHS',
        symbol: input.symbol,
        outcome: 'REJECTED',
        detail: reason,
      });
      return {
        ok: false,
        symbol: input.symbol,
        cancelledOpenOrders,
        balanceReleaseConfirmed: false,
        remainingOpenOrders,
        settledPositionQty,
        recalculatedLhs: lhsEval.lhs,
        exitStrategy: 'ABORTED_LOCKED_INVENTORY',
        tranchesExecuted: [],
        reason,
      };
    }

    const exactCloseQty = Math.max(0, Math.min(input.requestedQty, settledPositionQty));
    if (exactCloseQty <= 0) {
      return {
        ok: true,
        symbol: input.symbol,
        cancelledOpenOrders,
        balanceReleaseConfirmed: true,
        remainingOpenOrders: 0,
        settledPositionQty,
        recalculatedLhs: lhsEval.lhs,
        exitStrategy: 'LIMIT_1C_INSIDE_SPREAD',
        tranchesExecuted: [],
        reason: `No settled inventory remaining on ${input.symbol} after CancelAllOpenOrders sweep.`,
      };
    }

    const insideStep = sweepCfg.lhs_limit_inside_spread_cents / 100; // $0.01
    const isSellSide =
      input.exitSide === 'SELL' ||
      input.exitSide === 'SELL_YES' ||
      input.exitSide === 'SELL_NO' ||
      input.exitSide === 'ask';

    const tranchesExecuted: PreExitSweepResult['tranchesExecuted'] = [];

    if (lhsEval.lhs >= sweepCfg.min_lhs_for_single_limit) {
      // High LHS (>= 0.65): Single limit exit 1 cent inside the spread
      const rawInsidePrice = isSellSide
        ? Math.max(input.bestBidUsd + insideStep, input.bestAskUsd - insideStep)
        : Math.min(input.bestAskUsd - insideStep, input.bestBidUsd + insideStep);
      const limitPriceUsd = Number(
        Math.max(input.bestBidUsd, Math.min(input.bestAskUsd, rawInsidePrice)).toFixed(2)
      );
      const idempotencyHash = crypto
        .createHash('sha256')
        .update(`exit:${input.symbol}:${input.exitSide}:single:${Math.floor((input.nowMs ?? Date.now()) / 15000)}`)
        .digest('hex');

      const execRes = await input.executeLimitOrder({
        symbol: input.symbol,
        side: input.exitSide,
        quantity: exactCloseQty,
        limitPriceUsd,
        idempotencyHash,
        mode: 'LIMIT_1C_INSIDE_SPREAD',
      });

      tranchesExecuted.push({
        trancheIndex: 1,
        quantity: exactCloseQty,
        limitPriceUsd,
        ok: execRes.ok,
        orderId: execRes.orderId,
      });

      this.pushAudit({
        ts: new Date().toISOString(),
        rule: 'RULE_3_PRE_EXIT_SWEEP_LHS',
        symbol: input.symbol,
        outcome: execRes.ok ? 'EXECUTED' : 'REJECTED',
        detail: `LHS=${lhsEval.lhs.toFixed(3)} >= 0.65: cancelled ${cancelledOpenOrders} orders, confirmed release, executed 1c-inside-spread limit qty=${exactCloseQty} @ $${limitPriceUsd.toFixed(2)}.`,
      });

      return {
        ok: execRes.ok,
        symbol: input.symbol,
        cancelledOpenOrders,
        balanceReleaseConfirmed: true,
        remainingOpenOrders: 0,
        settledPositionQty,
        recalculatedLhs: lhsEval.lhs,
        exitStrategy: 'LIMIT_1C_INSIDE_SPREAD',
        tranchesExecuted,
        reason: `Pre-exit sweep confirmed (${cancelledOpenOrders} cancelled); LHS=${lhsEval.lhs.toFixed(3)} >= 0.65 -> Limit 1¢ inside spread @ $${limitPriceUsd.toFixed(2)}.`,
      };
    }

    // Low LHS (< 0.65): Split into passive TWAP micro-tranches resting at passive BBO
    const numTranches = Math.max(
      2,
      Math.min(sweepCfg.passive_twap_micro_tranches, Math.ceil(exactCloseQty))
    );
    const passiveLimitPriceUsd = Number(
      (isSellSide ? input.bestAskUsd : input.bestBidUsd).toFixed(2)
    );
    const isIntegerQty = Number.isInteger(exactCloseQty);
    let remainingToAllocate = exactCloseQty;

    for (let i = 0; i < numTranches; i += 1) {
      const slicesLeft = numTranches - i;
      const sliceQty = isIntegerQty
        ? i === numTranches - 1
          ? remainingToAllocate
          : Math.max(1, Math.floor(remainingToAllocate / slicesLeft))
        : i === numTranches - 1
        ? Number(remainingToAllocate.toFixed(4))
        : Number((remainingToAllocate / slicesLeft).toFixed(4));
      if (sliceQty <= 0) continue;
      remainingToAllocate = Number((remainingToAllocate - sliceQty).toFixed(4));

      const idempotencyHash = crypto
        .createHash('sha256')
        .update(`exit:${input.symbol}:${input.exitSide}:twap:${i + 1}:${Math.floor((input.nowMs ?? Date.now()) / 15000)}`)
        .digest('hex');

      const execRes = await input.executeLimitOrder({
        symbol: input.symbol,
        side: input.exitSide,
        quantity: sliceQty,
        limitPriceUsd: passiveLimitPriceUsd,
        idempotencyHash,
        mode: 'PASSIVE_TWAP_MICRO_TRANCHE',
        trancheIndex: i + 1,
        totalTranches: numTranches,
      });

      tranchesExecuted.push({
        trancheIndex: i + 1,
        quantity: sliceQty,
        limitPriceUsd: passiveLimitPriceUsd,
        ok: execRes.ok,
        orderId: execRes.orderId,
      });
    }

    const allOk = tranchesExecuted.length > 0 && tranchesExecuted.every((t) => t.ok);
    this.pushAudit({
      ts: new Date().toISOString(),
      rule: 'RULE_3_PRE_EXIT_SWEEP_LHS',
      symbol: input.symbol,
      outcome: allOk ? 'EXECUTED' : 'REJECTED',
      detail: `LHS=${lhsEval.lhs.toFixed(3)} < 0.65: cancelled ${cancelledOpenOrders} orders, confirmed release, routed ${tranchesExecuted.length} passive TWAP micro-tranches @ $${passiveLimitPriceUsd.toFixed(2)}.`,
    });

    return {
      ok: allOk,
      symbol: input.symbol,
      cancelledOpenOrders,
      balanceReleaseConfirmed: true,
      remainingOpenOrders: 0,
      settledPositionQty,
      recalculatedLhs: lhsEval.lhs,
      exitStrategy: 'PASSIVE_TWAP_MICRO_TRANCHES',
      tranchesExecuted,
      reason: `Pre-exit sweep confirmed (${cancelledOpenOrders} cancelled); LHS=${lhsEval.lhs.toFixed(3)} < 0.65 -> ${tranchesExecuted.length} passive TWAP micro-tranches @ $${passiveLimitPriceUsd.toFixed(2)}.`,
    };
  }

  public isLowBalanceKalshiCompounderActive(settledCashUsd: number): boolean {
    const cfg = CHAMPION_CONFIG.low_balance_kalshi_compounder;
    return (
      Boolean(cfg?.enabled) &&
      Number.isFinite(settledCashUsd) &&
      settledCashUsd > 0 &&
      settledCashUsd < (cfg?.max_settled_cash_usd ?? 150)
    );
  }

  public computeLowBalanceCompounderSizing(
    settledCashUsd: number,
    entryPriceUsd: number
  ): {
    compounderActive: boolean;
    tier: string;
    cashCapUsd: number;
    maxContracts: number;
    approvedContracts: number;
    reason: string;
  } {
    const cfg = CHAMPION_CONFIG.low_balance_kalshi_compounder;
    const capFrac = cfg?.settled_cash_cap_fraction ?? 0.03;
    const maxContracts = cfg?.max_contracts_per_trade ?? 1;
    const tier = cfg?.tier_name ?? 'MICRO_LOT_30';
    const compounderActive = this.isLowBalanceKalshiCompounderActive(settledCashUsd);
    const cashCapUsd = Number((Math.max(0, settledCashUsd) * capFrac).toFixed(4));
    if (!compounderActive) {
      return {
        compounderActive: false,
        tier: 'STANDARD',
        cashCapUsd,
        maxContracts,
        approvedContracts: 0,
        reason: `Settled cash $${settledCashUsd.toFixed(2)} is not in low-balance compounder tier (0 < cash < $${cfg?.max_settled_cash_usd ?? 150}).`,
      };
    }
    const rawQty = entryPriceUsd > 0 ? Math.floor((cashCapUsd + 1e-9) / entryPriceUsd) : 0;
    const approvedContracts = Math.max(0, Math.min(maxContracts, rawQty));
    return {
      compounderActive: true,
      tier,
      cashCapUsd,
      maxContracts,
      approvedContracts,
      reason:
        approvedContracts === 1
          ? `${tier}: 3% cap=$${cashCapUsd.toFixed(4)} on $${settledCashUsd.toFixed(2)} settled cash -> strictly 1 contract @ $${entryPriceUsd.toFixed(2)}.`
          : `${tier}: 3% cap=$${cashCapUsd.toFixed(4)} cannot fund 1 contract @ $${entryPriceUsd.toFixed(2)}.`,
    };
  }

  public computeCompounderMakerBuyPrice(
    bestBidUsd: number,
    bestAskUsd: number
  ): {
    ok: boolean;
    priceUsd: number;
    withinBand: boolean;
    nonCrossing: boolean;
    reason: string;
  } {
    const band = CHAMPION_CONFIG.low_balance_kalshi_compounder?.maker_first_entry.price_band ?? [0.52, 0.74];
    const [bandMin, bandMax] = band;
    if (
      !Number.isFinite(bestBidUsd) ||
      !Number.isFinite(bestAskUsd) ||
      bestBidUsd <= 0 ||
      bestAskUsd <= bestBidUsd
    ) {
      return {
        ok: false,
        priceUsd: 0,
        withinBand: false,
        nonCrossing: false,
        reason: `Invalid BBO quote bestBid=$${bestBidUsd} bestAsk=$${bestAskUsd}.`,
      };
    }

    const priceUsd = Number(Math.min(bestAskUsd - 0.01, bestBidUsd + 0.01).toFixed(2));
    const nonCrossing = priceUsd < bestAskUsd - 1e-9 && priceUsd > 0;
    const withinBand = priceUsd >= bandMin - 1e-9 && priceUsd <= bandMax + 1e-9;

    return {
      ok: nonCrossing && withinBand,
      priceUsd,
      withinBand,
      nonCrossing,
      reason:
        nonCrossing && withinBand
          ? `Maker-first post_only price $${priceUsd.toFixed(2)} = min($${bestAskUsd.toFixed(2)}-0.01, $${bestBidUsd.toFixed(2)}+0.01) inside [$${bandMin.toFixed(2)}, $${bandMax.toFixed(2)}].`
          : !nonCrossing
          ? `Computed price $${priceUsd.toFixed(2)} crosses or meets bestAsk $${bestAskUsd.toFixed(2)}.`
          : `Computed price $${priceUsd.toFixed(2)} outside [$${bandMin.toFixed(2)}, $${bandMax.toFixed(2)}].`,
    };
  }

  /**
   * Executes Low-Balance Kalshi Compounder entry (< $150 settled cash, e.g. $32.99 MICRO_LOT_30):
   * 1. Validates SVB-60/GKX-5, FV - entry_price >= 0.18, CHOP(14) < 50, ADX >= 25, LHS >= 0.65.
   * 2. Computes post_only Maker-First limit buy at min(best_ask - 0.01, best_bid + 0.01) inside [0.52, 0.74].
   * 3. Enforces 3% settled cash cap -> strictly 1 contract per trade ($0.9897 at $32.99).
   * 4. Acquires Rule 2 deterministic idempotency lock.
   * 5. Queries open resting orders on contract; cancels any stale resting order and confirms 0 remaining before entry.
   * 6. Submits 1-contract post_only GTC limit buy; auto-cancels if unfilled after 12s (never chases market order).
   */
  public async executeLowBalanceCompounderEntry(
    input: LowBalanceCompounderEntryInput
  ): Promise<LowBalanceCompounderEntryResult> {
    const cfg = CHAMPION_CONFIG.low_balance_kalshi_compounder;
    const tier = cfg?.tier_name ?? 'MICRO_LOT_30';
    const makerCfg = cfg?.maker_first_entry;
    const minEdge = makerCfg?.min_fv_minus_entry_dollars ?? 0.18;
    const chopMax = makerCfg?.chop14_max ?? 50.0;
    const adxMin = makerCfg?.adx_min ?? 25.0;
    const lhsMin = makerCfg?.lhs_min ?? 0.65;
    const allowedTriggers = makerCfg?.allowed_triggers ?? ['SVB-60', 'GKX-5'];

    if (!this.isLowBalanceKalshiCompounderActive(input.settledCashUsd)) {
      return {
        ok: false,
        status: 'COMPOUNDER_INACTIVE_ABOVE_150',
        tier: 'STANDARD',
        contracts: 0,
        limitPriceUsd: 0,
        postOnly: true,
        neverChaseMarketOrder: true,
        staleRestingOrdersFound: 0,
        staleRestingOrdersCancelled: [],
        remainingRestingOrdersBeforeEntry: 0,
        autoCancelledAfter12s: false,
        chasedWithMarketOrder: false,
        blockedReasons: [`settledCashUsd $${input.settledCashUsd.toFixed(2)} not in (0, $${cfg?.max_settled_cash_usd ?? 150}).`],
        reason: 'Low-balance compounder only applies to accounts with 0 < settledCash < $150.',
      };
    }

    const pxEval = this.computeCompounderMakerBuyPrice(input.bestBidUsd, input.bestAskUsd);
    if (!pxEval.ok) {
      this.pushAudit({
        ts: new Date().toISOString(),
        rule: 'LOW_BALANCE_COMPOUNDER',
        symbol: input.ticker,
        outcome: 'REJECTED',
        detail: pxEval.reason,
      });
      return {
        ok: false,
        status: 'OUTSIDE_COMPOUNDER_PRICE_BAND',
        tier,
        contracts: 0,
        limitPriceUsd: pxEval.priceUsd,
        postOnly: true,
        neverChaseMarketOrder: true,
        staleRestingOrdersFound: 0,
        staleRestingOrdersCancelled: [],
        remainingRestingOrdersBeforeEntry: 0,
        autoCancelledAfter12s: false,
        chasedWithMarketOrder: false,
        blockedReasons: [pxEval.reason],
        reason: pxEval.reason,
      };
    }

    const blockedReasons: string[] = [];
    if (!allowedTriggers.includes(input.triggerId)) {
      blockedReasons.push(`Trigger ${input.triggerId} not in [${allowedTriggers.join(', ')}]`);
    }
    const edge = Number((input.fairValueUsd - pxEval.priceUsd).toFixed(4));
    if (edge < minEdge - 1e-9) {
      blockedReasons.push(`FV(N(d2)) - entry_price = ${edge.toFixed(4)} < ${minEdge.toFixed(2)}`);
    }
    if (!(input.chop14 < chopMax)) {
      blockedReasons.push(`CHOP(14)=${input.chop14.toFixed(2)} >= ${chopMax}`);
    }
    if (!(input.adx >= adxMin)) {
      blockedReasons.push(`ADX=${input.adx.toFixed(2)} < ${adxMin}`);
    }
    if (!(input.lhs >= lhsMin)) {
      blockedReasons.push(`LHS=${input.lhs.toFixed(3)} < ${lhsMin}`);
    }

    if (blockedReasons.length > 0) {
      this.pushAudit({
        ts: new Date().toISOString(),
        rule: 'LOW_BALANCE_COMPOUNDER',
        symbol: input.ticker,
        outcome: 'REJECTED',
        detail: `Gate blocked: ${blockedReasons.join(' | ')}`,
      });
      return {
        ok: false,
        status: 'GATE_BLOCKED',
        tier,
        contracts: 0,
        limitPriceUsd: pxEval.priceUsd,
        postOnly: true,
        neverChaseMarketOrder: true,
        staleRestingOrdersFound: 0,
        staleRestingOrdersCancelled: [],
        remainingRestingOrdersBeforeEntry: 0,
        autoCancelledAfter12s: false,
        chasedWithMarketOrder: false,
        blockedReasons,
        reason: blockedReasons.join(' | '),
      };
    }

    const sizing = this.computeLowBalanceCompounderSizing(input.settledCashUsd, pxEval.priceUsd);
    if (sizing.approvedContracts !== 1) {
      this.pushAudit({
        ts: new Date().toISOString(),
        rule: 'LOW_BALANCE_COMPOUNDER',
        symbol: input.ticker,
        outcome: 'REJECTED',
        detail: sizing.reason,
      });
      return {
        ok: false,
        status: 'INSUFFICIENT_SETTLED_CASH_3PCT_CAP',
        tier,
        contracts: 0,
        limitPriceUsd: pxEval.priceUsd,
        postOnly: true,
        neverChaseMarketOrder: true,
        staleRestingOrdersFound: 0,
        staleRestingOrdersCancelled: [],
        remainingRestingOrdersBeforeEntry: 0,
        autoCancelledAfter12s: false,
        chasedWithMarketOrder: false,
        blockedReasons: [sizing.reason],
        reason: sizing.reason,
      };
    }

    const lockResult = this.acquireIdempotencyLock({
      symbol: input.ticker,
      side: input.side,
      strategyId: `COMPOUNDER_${input.triggerId}`,
      timeframe: input.timeframe ?? '15m',
      timestampMs: input.timestampMs,
      explicitClientKey: input.explicitClientKey,
    });
    if (!lockResult.allowed) {
      return {
        ok: false,
        status: 'IDEMPOTENCY_LOCK_BLOCKED',
        tier,
        contracts: 0,
        limitPriceUsd: pxEval.priceUsd,
        postOnly: true,
        neverChaseMarketOrder: true,
        staleRestingOrdersFound: 0,
        staleRestingOrdersCancelled: [],
        remainingRestingOrdersBeforeEntry: 0,
        autoCancelledAfter12s: false,
        chasedWithMarketOrder: false,
        idempotencyHash: lockResult.idempotencyHash,
        blockedReasons: ['Duplicate compounder entry blocked by Rule 2 idempotency lock.'],
        reason: `Duplicate entry blocked in ${lockResult.existingRecord?.timeframe ?? input.timeframe ?? '15m'} cooldown (${lockResult.remainingCooldownSec}s left).`,
      };
    }

    // 1. Pre-Entry Resting Order Check: cancel any stale resting order on contract so settledCash is never double-locked
    const restingBefore = await input.fetchRestingOrdersForTicker(input.ticker);
    const staleCancelled: string[] = [];
    for (const ord of restingBefore) {
      if (ord.orderId) {
        const cancelRes = await input.cancelRestingOrder(ord.orderId);
        if (cancelRes.ok) {
          staleCancelled.push(ord.orderId);
        }
      }
    }
    const restingAfter =
      restingBefore.length > 0 ? await input.fetchRestingOrdersForTicker(input.ticker) : [];
    if (restingAfter.length > 0) {
      const msg = `Aborted ${input.ticker} entry: ${restingAfter.length} stale resting order(s) could not be cancelled before entry; preventing settledCash double-lock.`;
      this.pushAudit({
        ts: new Date().toISOString(),
        rule: 'LOW_BALANCE_COMPOUNDER',
        symbol: input.ticker,
        outcome: 'REJECTED',
        detail: msg,
      });
      return {
        ok: false,
        status: 'STALE_RESTING_ORDERS_NOT_CLEARED',
        tier,
        contracts: 0,
        limitPriceUsd: pxEval.priceUsd,
        postOnly: true,
        neverChaseMarketOrder: true,
        staleRestingOrdersFound: restingBefore.length,
        staleRestingOrdersCancelled: staleCancelled,
        remainingRestingOrdersBeforeEntry: restingAfter.length,
        autoCancelledAfter12s: false,
        chasedWithMarketOrder: false,
        idempotencyHash: lockResult.idempotencyHash,
        blockedReasons: [msg],
        reason: msg,
      };
    }

    // 2. Submit 1-contract post_only GTC limit buy at min(best_ask - 0.01, best_bid + 0.01) inside [0.52, 0.74]
    const subRes = await input.submitPostOnlyLimitBuy({
      ticker: input.ticker,
      side: input.side,
      contracts: 1,
      limitPriceUsd: pxEval.priceUsd,
      postOnly: true,
      timeInForce: 'good_till_canceled',
      cancelOrderOnPause: true,
      idempotencyHash: lockResult.idempotencyHash,
    });

    if (!subRes.ok || !subRes.orderId || subRes.status === 'REJECTED') {
      const msg = subRes.error || 'Venue rejected post_only maker entry order.';
      this.pushAudit({
        ts: new Date().toISOString(),
        rule: 'LOW_BALANCE_COMPOUNDER',
        symbol: input.ticker,
        outcome: 'REJECTED',
        detail: msg,
      });
      return {
        ok: false,
        status: 'VENUE_REJECTED',
        tier,
        contracts: 1,
        limitPriceUsd: pxEval.priceUsd,
        postOnly: true,
        neverChaseMarketOrder: true,
        staleRestingOrdersFound: restingBefore.length,
        staleRestingOrdersCancelled: staleCancelled,
        remainingRestingOrdersBeforeEntry: 0,
        autoCancelledAfter12s: false,
        chasedWithMarketOrder: false,
        idempotencyHash: lockResult.idempotencyHash,
        blockedReasons: [msg],
        reason: msg,
      };
    }

    this.attachOrderIdToLock(lockResult.idempotencyHash, subRes.orderId);

    if (subRes.status === 'FILLED' || subRes.status === 'EXECUTED') {
      this.pushAudit({
        ts: new Date().toISOString(),
        rule: 'LOW_BALANCE_COMPOUNDER',
        symbol: input.ticker,
        outcome: 'EXECUTED',
        detail: `${tier} 1-contract post_only FILLED @ $${pxEval.priceUsd.toFixed(2)} (trigger=${input.triggerId}, edge=${edge.toFixed(3)}, preCancelled=${staleCancelled.length}).`,
      });
      return {
        ok: true,
        status: 'FILLED',
        tier,
        contracts: 1,
        limitPriceUsd: pxEval.priceUsd,
        postOnly: true,
        neverChaseMarketOrder: true,
        staleRestingOrdersFound: restingBefore.length,
        staleRestingOrdersCancelled: staleCancelled,
        remainingRestingOrdersBeforeEntry: 0,
        autoCancelledAfter12s: false,
        chasedWithMarketOrder: false,
        orderId: subRes.orderId,
        idempotencyHash: lockResult.idempotencyHash,
        blockedReasons: [],
        reason: `1-contract post_only filled @ $${pxEval.priceUsd.toFixed(2)} (${tier}).`,
      };
    }

    // Monitor resting order up to 12 seconds; auto-cancel if unfilled (never chase with market order)
    const timeoutMs = input.unfilledAutoCancelMs ?? (makerCfg?.unfilled_auto_cancel_seconds ?? 12) * 1000;
    const pollMs = Math.max(10, input.pollIntervalMs ?? 1000);
    const sleeper =
      input.sleepMs ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    let elapsedMs = 0;

    while (elapsedMs < timeoutMs) {
      const waitStep = Math.min(pollMs, timeoutMs - elapsedMs);
      await sleeper(waitStep);
      elapsedMs += waitStep;
      const st = await input.fetchOrderStatus(subRes.orderId);
      if (st.status === 'FILLED' || st.status === 'EXECUTED') {
        this.pushAudit({
          ts: new Date().toISOString(),
          rule: 'LOW_BALANCE_COMPOUNDER',
          symbol: input.ticker,
          outcome: 'EXECUTED',
          detail: `${tier} 1-contract post_only FILLED after ${elapsedMs}ms @ $${pxEval.priceUsd.toFixed(2)}.`,
        });
        return {
          ok: true,
          status: 'FILLED',
          tier,
          contracts: 1,
          limitPriceUsd: pxEval.priceUsd,
          postOnly: true,
          neverChaseMarketOrder: true,
          staleRestingOrdersFound: restingBefore.length,
          staleRestingOrdersCancelled: staleCancelled,
          remainingRestingOrdersBeforeEntry: 0,
          autoCancelledAfter12s: false,
          chasedWithMarketOrder: false,
          orderId: subRes.orderId,
          idempotencyHash: lockResult.idempotencyHash,
          blockedReasons: [],
          reason: `1-contract post_only filled within ${elapsedMs}ms @ $${pxEval.priceUsd.toFixed(2)}.`,
        };
      }
      if (st.status === 'CANCELLED') {
        break;
      }
    }

    await input.cancelRestingOrder(subRes.orderId);
    const msg = `Unfilled 1-contract post_only order ${subRes.orderId} auto-cancelled after ${(timeoutMs / 1000).toFixed(1)}s; never chased with market order.`;
    this.pushAudit({
      ts: new Date().toISOString(),
      rule: 'LOW_BALANCE_COMPOUNDER',
      symbol: input.ticker,
      outcome: 'REJECTED',
      detail: msg,
    });
    return {
      ok: false,
      status: 'AUTO_CANCELLED_UNFILLED_12S',
      tier,
      contracts: 1,
      limitPriceUsd: pxEval.priceUsd,
      postOnly: true,
      neverChaseMarketOrder: true,
      staleRestingOrdersFound: restingBefore.length,
      staleRestingOrdersCancelled: staleCancelled,
      remainingRestingOrdersBeforeEntry: 0,
      autoCancelledAfter12s: true,
      chasedWithMarketOrder: false,
      orderId: subRes.orderId,
      idempotencyHash: lockResult.idempotencyHash,
      blockedReasons: [msg],
      reason: msg,
    };
  }

  /**
   * Evaluates and executes Low-Balance Compounder exits:
   * - Enforces Zero-Fee Settlement Hold Exemption at T - 90s when 1 contract has FV >= 0.85 & ITM > 0.25*sigma*sqrt(tau).
   * - Enforces Tight 2-Eval Inversion Stop (FV - bid < -0.04 x2 OR unrealized loss <= -$0.06) via Rule 3 sweep.
   */
  public async evaluateAndExecuteCompounderExit(
    input: LowBalanceCompounderExitInput
  ): Promise<LowBalanceCompounderExitResult> {
    const evalResult = evaluateChampionExitSignal({
      ...input.exitEval,
      compounderMode: true,
      contracts: input.exitEval.contracts ?? 1,
    });

    if (!evalResult.shouldExit) {
      return {
        evalResult,
        exitExecuted: false,
        zeroFeeSettlementHoldExempt: evalResult.reason === 'HOLD_ZERO_FEE_SETTLEMENT',
        rule3SweepResult: null,
      };
    }

    const rule3SweepResult = await this.unwindPositionSafely({
      ...input.sweep,
      requestedQty: Math.min(1, Math.max(1, input.sweep.requestedQty)),
    });

    return {
      evalResult,
      exitExecuted: rule3SweepResult.ok,
      zeroFeeSettlementHoldExempt: false,
      rule3SweepResult,
    };
  }
}

export const executionVault = new ExecutionVault();
