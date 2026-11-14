import crypto from 'node:crypto';
import {
  CHAMPION_CONFIG,
  computeLiquidityHealthScore,
  evaluateRegimeAndLiquidity,
  type ObiSample,
  type RegimeAndLiquidityInput,
  type RegimeAndLiquidityVerdict,
} from './regimeLiquidityFilter';

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

export interface VaultAuditEntry {
  ts: string;
  rule: 'RULE_1_SETTLED_CASH_CAP' | 'RULE_2_IDEMPOTENCY_LOCK' | 'RULE_3_PRE_EXIT_SWEEP_LHS' | 'REGIME_LIQUIDITY_GATE';
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

    const existing = this.idempotencyLockLedger.get(idempotencyHash);
    if (existing && nowMs < existing.expiresAtMs) {
      const remainingCooldownSec = Math.max(
        1,
        Math.ceil((existing.expiresAtMs - nowMs) / 1000)
      );
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
        existingRecord: existing,
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
      expiresAtMs: nowMs + cooldownSec * 1000,
    };
    this.idempotencyLockLedger.set(idempotencyHash, record);
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
    }
  }

  /**
   * Unified Pre-Trade Vault Gate combining Regime + Liquidity Filter + Rule 1 (Settled Cash Cap) + Rule 2 (Idempotency Lock).
   */
  public validateEntryOrder(params: {
    regimeAndLiquidity: RegimeAndLiquidityInput;
    sizing: SettledCashSizingInput;
    idempotency: IdempotencyLockInput;
  }): {
    approved: boolean;
    regimeVerdict: RegimeAndLiquidityVerdict;
    sizingResult: SettledCashSizingResult;
    lockResult: IdempotencyLockCheckResult | null;
    reasons: string[];
  } {
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
        regimeVerdict,
        sizingResult,
        lockResult: null,
        reasons,
      };
    }

    const lockResult = this.acquireIdempotencyLock(params.idempotency);
    if (!lockResult.allowed) {
      reasons.push(
        `Duplicate order blocked within ${lockResult.cooldownSec}s cooldown bucket (remaining ${lockResult.remainingCooldownSec}s).`
      );
      return {
        approved: false,
        regimeVerdict,
        sizingResult,
        lockResult,
        reasons,
      };
    }

    return {
      approved: true,
      regimeVerdict,
      sizingResult,
      lockResult,
      reasons: [],
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
}

export const executionVault = new ExecutionVault();
