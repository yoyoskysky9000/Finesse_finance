import {
  computeKalshiOrderFeeUsd,
  KALSHI_STRESSED_DRAG_FLOOR_USD,
  type KalshiFeeMode,
} from './kalshiFeeCalculator';

export const MICRO_LOT_30_TIER = 'MICRO_LOT_30' as const;
export const MICRO_LOT_30_MAX_CONTRACTS = 1 as const;
export const MICRO_LOT_30_ASK_MIN_USD = 0.52 as const;
export const MICRO_LOT_30_ASK_MAX_USD = 0.74 as const;
export const MICRO_LOT_30_MIN_LHS = 0.65 as const;
export const MICRO_LOT_30_DEFAULT_MAX_SPREAD_CENTS = 3 as const;
export const MICRO_LOT_30_MIN_TOP_DEPTH_CONTRACTS = 1 as const;
export const MICRO_LOT_30_TARGET_DEPTH_CONTRACTS = 5 as const;
export const MICRO_LOT_30_MAX_SETTLED_CASH_USD = 150.0 as const;
export const MICRO_LOT_30_SETTLED_CASH_CAP_FRACTION = 0.03 as const;
export const MICRO_LOT_30_DEFAULT_MAX_BOOK_AGE_MS = 1500 as const;
export const MICRO_LOT_30_MIN_FV_MINUS_ENTRY_USD = 0.18 as const;
export const MICRO_LOT_30_CHOP14_MAX = 50.0 as const;
export const MICRO_LOT_30_ADX_MIN = 25.0 as const;
export const MICRO_LOT_30_UNFILLED_CANCEL_SECONDS = 12 as const;
export const MICRO_LOT_30_ALLOWED_TRIGGERS = ['SVB-60', 'GKX-5'] as const;

export type MicroLotAllowedTrigger = (typeof MICRO_LOT_30_ALLOWED_TRIGGERS)[number];

export interface MicroLotOrderbookLevel {
  priceUsd?: number;
  sizeContracts?: number;
  /** Optional Kalshi V2 fixed-point string/numeric representations */
  priceDollars?: string | number;
  sizeFp?: string | number;
}

export interface MicroLotObiSample {
  tsMs: number;
  bidSizeContracts: number;
  askSizeContracts: number;
}

/**
 * Pure orderbook telemetry snapshot for MICRO_LOT_30 liquidity evaluation.
 * Never relies on deprecated `liquidity_dollars`; evaluates depth and OBI strictly
 * from real level sizes or Kalshi V2 `yes_bid_size_fp` / `yes_ask_size_fp`.
 */
export interface MicroLotOrderbookSnapshot {
  bids?: ReadonlyArray<MicroLotOrderbookLevel>;
  asks?: ReadonlyArray<MicroLotOrderbookLevel>;
  bestBidUsd?: number;
  bestAskUsd?: number;
  yesBidSizeFp?: number | string;
  yesAskSizeFp?: number | string;
  bidSizeContracts?: number;
  askSizeContracts?: number;
  obiSamples?: ReadonlyArray<MicroLotObiSample>;
  bookTimestampMs?: number;
  nowMs?: number;
  bookAgeMs?: number;
  isStale?: boolean;
  seqDesync?: boolean;
  /** Optional pre-computed LHS in [0, 1]; combined conservatively via Math.min with live book LHS. */
  lhsOverride?: number;
}

export interface MicroLotLiquidityConfig {
  /** Maximum allowed bid-ask spread in cents (defaults to 3 cents / $0.03). */
  maxSpreadCents?: number;
  /** Minimum top-of-book size in contracts required for a 1-contract fill (enforced >= 1). */
  minTopDepthContracts?: number;
  /** Target top-of-book contract depth where depth sub-score reaches >= 0.75 (defaults to 5). */
  targetDepthContracts?: number;
  /** Minimum Liquidity Health Score threshold (enforced >= 0.65). */
  minLhs?: number;
  /** Maximum allowed orderbook telemetry age in milliseconds when timestamps/age are provided (defaults to 1500ms). */
  maxBookAgeMs?: number;
  /** TWAP OBI lookback window in milliseconds (defaults to 1000ms). */
  twapObiWindowMs?: number;
}

export interface MicroLotLiquidityResult {
  allowed: boolean;
  reason?: string;
  lhs: number;
  spreadCents: number;
}

export interface MicroLotMakerPriceResult {
  valid: boolean;
  reason?: string;
  limitPriceUsd: number | null;
  withinAskBounds: boolean;
  withinLimitBounds: boolean;
  nonCrossing: boolean;
}

export interface MicroLotEntryPreCheckInput {
  ticker: string;
  settledCashUsd: number;
  orderbook: MicroLotOrderbookSnapshot | null | undefined;
  requestedContracts?: number;
  executionMode?: KalshiFeeMode;
  postOnly?: boolean;
  openRestingOrdersCount?: number;
  triggerId?: string;
  fairValueUsd?: number;
  atr14ProbUsd?: number;
  chop14?: number;
  adx?: number;
  liquidityConfig?: MicroLotLiquidityConfig;
}

export interface MicroLotEntryPreCheckResult {
  allowed: boolean;
  reason?: string;
  tier: typeof MICRO_LOT_30_TIER;
  contracts: 0 | 1;
  executionMode: 'MAKER_POST_ONLY';
  postOnly: true;
  limitPriceUsd: number | null;
  bestBidUsd: number | null;
  bestAskUsd: number | null;
  cashCapUsd: number;
  entryFeeUsd: number;
  unfilledAutoCancelSeconds: number;
  liquidity: MicroLotLiquidityResult;
}

export type MicroLotExitMode = 'PASSIVE_MAKER' | 'EMERGENCY_IOC_REDUCE_ONLY';

export interface MicroLotExitPreCheckInput {
  ticker: string;
  settledPositionContracts: number;
  openRestingOrdersCount: number;
  cancelSweepConfirmed: boolean;
  orderbook: MicroLotOrderbookSnapshot | null | undefined;
  exitMode?: MicroLotExitMode;
  liquidityConfig?: MicroLotLiquidityConfig;
}

export interface MicroLotExitPreCheckResult {
  allowed: boolean;
  reason?: string;
  tier: typeof MICRO_LOT_30_TIER;
  contractsToClose: 0 | 1;
  exitMode: MicroLotExitMode;
  passiveLimitPriceUsd: number | null;
  expectedExitFeeUsd: number;
  liquidity: MicroLotLiquidityResult;
}

interface ParsedTopOfBook {
  bestBidUsd: number;
  bestAskUsd: number;
  topBidContracts: number;
  topAskContracts: number;
}

function parseFiniteNumeric(val: number | string | undefined): number {
  if (typeof val === 'number') {
    return Number.isFinite(val) ? val : NaN;
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (trimmed.length === 0) return NaN;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : NaN;
  }
  return NaN;
}

function extractTopOfBook(snapshot: MicroLotOrderbookSnapshot): ParsedTopOfBook | null {
  const hasBidsArray = Array.isArray(snapshot.bids);
  const hasAsksArray = Array.isArray(snapshot.asks);

  if (hasBidsArray || hasAsksArray) {
    if (!hasBidsArray || !hasAsksArray) {
      return null;
    }
    const bids = snapshot.bids ?? [];
    const asks = snapshot.asks ?? [];
    if (bids.length === 0 || asks.length === 0) {
      return null;
    }

    let bestBidUsd = -Infinity;
    let topBidContracts = 0;
    for (const level of bids) {
      if (!level || typeof level !== 'object') return null;
      const px = Number.isFinite(level.priceUsd)
        ? (level.priceUsd as number)
        : parseFiniteNumeric(level.priceDollars);
      const sz = Number.isFinite(level.sizeContracts)
        ? (level.sizeContracts as number)
        : parseFiniteNumeric(level.sizeFp);
      if (!Number.isFinite(px) || !Number.isFinite(sz) || px <= 0 || px >= 1 || sz < 0) {
        return null;
      }
      if (px > bestBidUsd + 1e-9) {
        bestBidUsd = px;
        topBidContracts = sz;
      } else if (Math.abs(px - bestBidUsd) <= 1e-9) {
        topBidContracts += sz;
      }
    }

    let bestAskUsd = Infinity;
    let topAskContracts = 0;
    for (const level of asks) {
      if (!level || typeof level !== 'object') return null;
      const px = Number.isFinite(level.priceUsd)
        ? (level.priceUsd as number)
        : parseFiniteNumeric(level.priceDollars);
      const sz = Number.isFinite(level.sizeContracts)
        ? (level.sizeContracts as number)
        : parseFiniteNumeric(level.sizeFp);
      if (!Number.isFinite(px) || !Number.isFinite(sz) || px <= 0 || px >= 1 || sz < 0) {
        return null;
      }
      if (px < bestAskUsd - 1e-9) {
        bestAskUsd = px;
        topAskContracts = sz;
      } else if (Math.abs(px - bestAskUsd) <= 1e-9) {
        topAskContracts += sz;
      }
    }

    if (
      !Number.isFinite(bestBidUsd) ||
      !Number.isFinite(bestAskUsd) ||
      bestBidUsd <= 0 ||
      bestAskUsd >= 1 ||
      bestBidUsd >= bestAskUsd
    ) {
      return null;
    }

    return {
      bestBidUsd,
      bestAskUsd,
      topBidContracts,
      topAskContracts,
    };
  }

  const bestBidUsd = parseFiniteNumeric(snapshot.bestBidUsd);
  const bestAskUsd = parseFiniteNumeric(snapshot.bestAskUsd);
  const topBidContracts = Number.isFinite(snapshot.bidSizeContracts)
    ? (snapshot.bidSizeContracts as number)
    : parseFiniteNumeric(snapshot.yesBidSizeFp);
  const topAskContracts = Number.isFinite(snapshot.askSizeContracts)
    ? (snapshot.askSizeContracts as number)
    : parseFiniteNumeric(snapshot.yesAskSizeFp);

  if (
    !Number.isFinite(bestBidUsd) ||
    !Number.isFinite(bestAskUsd) ||
    !Number.isFinite(topBidContracts) ||
    !Number.isFinite(topAskContracts) ||
    bestBidUsd <= 0 ||
    bestAskUsd >= 1 ||
    bestBidUsd >= bestAskUsd ||
    topBidContracts < 0 ||
    topAskContracts < 0
  ) {
    return null;
  }

  return {
    bestBidUsd,
    bestAskUsd,
    topBidContracts,
    topAskContracts,
  };
}

/**
 * Pure, deterministic liquidity filter for `MICRO_LOT_30` Kalshi execution.
 * Rejects trades when:
 *   1. Real orderbook data is missing, empty, stale, sequence-desynchronized, or `NaN` (`MISSING_OR_INVALID_ORDERBOOK`).
 *   2. Bid-ask spread exceeds `maxSpreadCents` (`SPREAD_EXCEEDS_MAX`).
 *   3. Top-of-book depth cannot support a 1-contract fill (`INSUFFICIENT_TOP_OF_BOOK_DEPTH`).
 *   4. Liquidity Health Score (`LHS`) is below `0.65` (`LHS_BELOW_THRESHOLD`).
 */
export function evaluateMicroLotLiquidity(
  orderbook: MicroLotOrderbookSnapshot | null | undefined,
  config: MicroLotLiquidityConfig = {}
): MicroLotLiquidityResult {
  if (!orderbook || typeof orderbook !== 'object') {
    return {
      allowed: false,
      reason: 'MISSING_OR_INVALID_ORDERBOOK',
      lhs: 0,
      spreadCents: 0,
    };
  }

  if (orderbook.isStale === true || orderbook.seqDesync === true) {
    return {
      allowed: false,
      reason: 'MISSING_OR_INVALID_ORDERBOOK',
      lhs: 0,
      spreadCents: 0,
    };
  }

  const maxBookAgeMs =
    typeof config.maxBookAgeMs === 'number' &&
    Number.isFinite(config.maxBookAgeMs) &&
    config.maxBookAgeMs > 0
      ? config.maxBookAgeMs
      : MICRO_LOT_30_DEFAULT_MAX_BOOK_AGE_MS;

  if (orderbook.bookAgeMs !== undefined) {
    if (
      !Number.isFinite(orderbook.bookAgeMs) ||
      orderbook.bookAgeMs < 0 ||
      orderbook.bookAgeMs > maxBookAgeMs
    ) {
      return {
        allowed: false,
        reason: 'MISSING_OR_INVALID_ORDERBOOK',
        lhs: 0,
        spreadCents: 0,
      };
    }
  }

  if (orderbook.bookTimestampMs !== undefined) {
    if (!Number.isFinite(orderbook.bookTimestampMs) || orderbook.bookTimestampMs <= 0) {
      return {
        allowed: false,
        reason: 'MISSING_OR_INVALID_ORDERBOOK',
        lhs: 0,
        spreadCents: 0,
      };
    }
    if (orderbook.nowMs !== undefined) {
      if (!Number.isFinite(orderbook.nowMs)) {
        return {
          allowed: false,
          reason: 'MISSING_OR_INVALID_ORDERBOOK',
          lhs: 0,
          spreadCents: 0,
        };
      }
      const computedAgeMs = orderbook.nowMs - orderbook.bookTimestampMs;
      if (computedAgeMs < 0 || computedAgeMs > maxBookAgeMs) {
        return {
          allowed: false,
          reason: 'MISSING_OR_INVALID_ORDERBOOK',
          lhs: 0,
          spreadCents: 0,
        };
      }
    }
  }

  if (orderbook.lhsOverride !== undefined) {
    if (
      !Number.isFinite(orderbook.lhsOverride) ||
      orderbook.lhsOverride < 0 ||
      orderbook.lhsOverride > 1
    ) {
      return {
        allowed: false,
        reason: 'MISSING_OR_INVALID_ORDERBOOK',
        lhs: 0,
        spreadCents: 0,
      };
    }
  }

  const top = extractTopOfBook(orderbook);
  if (!top) {
    return {
      allowed: false,
      reason: 'MISSING_OR_INVALID_ORDERBOOK',
      lhs: 0,
      spreadCents: 0,
    };
  }

  const maxSpreadCents =
    typeof config.maxSpreadCents === 'number' &&
    Number.isFinite(config.maxSpreadCents) &&
    config.maxSpreadCents > 0
      ? config.maxSpreadCents
      : MICRO_LOT_30_DEFAULT_MAX_SPREAD_CENTS;

  const minTopDepthContracts = Math.max(
    MICRO_LOT_30_MIN_TOP_DEPTH_CONTRACTS,
    typeof config.minTopDepthContracts === 'number' && Number.isFinite(config.minTopDepthContracts)
      ? config.minTopDepthContracts
      : MICRO_LOT_30_MIN_TOP_DEPTH_CONTRACTS
  );

  const targetDepthContracts = Math.max(
    minTopDepthContracts,
    typeof config.targetDepthContracts === 'number' &&
      Number.isFinite(config.targetDepthContracts) &&
      config.targetDepthContracts > 0
      ? config.targetDepthContracts
      : MICRO_LOT_30_TARGET_DEPTH_CONTRACTS
  );

  const effectiveMinLhs = Math.max(
    MICRO_LOT_30_MIN_LHS,
    typeof config.minLhs === 'number' && Number.isFinite(config.minLhs)
      ? config.minLhs
      : MICRO_LOT_30_MIN_LHS
  );

  const twapWindowMs =
    typeof config.twapObiWindowMs === 'number' &&
    Number.isFinite(config.twapObiWindowMs) &&
    config.twapObiWindowMs > 0
      ? config.twapObiWindowMs
      : 1000;

  const spreadUsd = top.bestAskUsd - top.bestBidUsd;
  const spreadCents = Number((spreadUsd * 100).toFixed(2));

  // 1. Spread sub-score (weight 0.45): 1.0 at 0c, 0.65 at maxSpreadCents, decays linearly above
  const spreadScore =
    spreadCents <= maxSpreadCents
      ? Math.max(0.65, 1.0 - (spreadCents / maxSpreadCents) * 0.35)
      : Math.max(0, 0.65 - ((spreadCents - maxSpreadCents) / maxSpreadCents) * 0.65);

  // 2. Depth sub-score (weight 0.40): anchored to the weaker top-of-book side vs targetDepthContracts
  const minSideContracts = Math.min(top.topBidContracts, top.topAskContracts);
  const depthRatio = minSideContracts / targetDepthContracts;
  const depthScore =
    depthRatio >= 1
      ? Math.min(1.0, 0.75 + (depthRatio - 1) * 0.25)
      : Math.max(0, depthRatio * 0.6);

  // 3. OBI stability sub-score (weight 0.15): TWAP OBI if valid samples exist, else instantaneous BBO OBI
  let twapObi = 0;
  const totalTopContracts = top.topBidContracts + top.topAskContracts;
  if (Array.isArray(orderbook.obiSamples) && orderbook.obiSamples.length > 0) {
    const validObis: number[] = [];
    for (const sample of orderbook.obiSamples) {
      if (
        !sample ||
        !Number.isFinite(sample.tsMs) ||
        !Number.isFinite(sample.bidSizeContracts) ||
        !Number.isFinite(sample.askSizeContracts) ||
        sample.bidSizeContracts < 0 ||
        sample.askSizeContracts < 0
      ) {
        return {
          allowed: false,
          reason: 'MISSING_OR_INVALID_ORDERBOOK',
          lhs: 0,
          spreadCents,
        };
      }
      if (orderbook.nowMs !== undefined && Number.isFinite(orderbook.nowMs)) {
        const sampleAge = orderbook.nowMs - sample.tsMs;
        if (sampleAge < 0 || sampleAge > twapWindowMs) {
          continue;
        }
      }
      const sampleTotal = sample.bidSizeContracts + sample.askSizeContracts;
      if (sampleTotal > 0) {
        validObis.push((sample.bidSizeContracts - sample.askSizeContracts) / sampleTotal);
      }
    }
    if (validObis.length > 0) {
      twapObi = validObis.reduce((acc, v) => acc + v, 0) / validObis.length;
    } else if (totalTopContracts > 0) {
      twapObi = (top.topBidContracts - top.topAskContracts) / totalTopContracts;
    }
  } else if (totalTopContracts > 0) {
    twapObi = (top.topBidContracts - top.topAskContracts) / totalTopContracts;
  }

  const obiScore = Math.max(0.3, 1.0 - Math.min(0.7, Math.abs(twapObi) * 0.7));
  const computedLhs = Number(
    (spreadScore * 0.45 + depthScore * 0.4 + obiScore * 0.15).toFixed(4)
  );
  const lhs =
    orderbook.lhsOverride !== undefined
      ? Number(Math.min(computedLhs, orderbook.lhsOverride).toFixed(4))
      : computedLhs;

  if (spreadCents > maxSpreadCents + 1e-9) {
    return {
      allowed: false,
      reason: `SPREAD_EXCEEDS_MAX (${spreadCents.toFixed(2)}c > ${maxSpreadCents.toFixed(2)}c)`,
      lhs,
      spreadCents,
    };
  }

  if (
    top.topAskContracts < minTopDepthContracts - 1e-9 ||
    top.topBidContracts < minTopDepthContracts - 1e-9
  ) {
    return {
      allowed: false,
      reason: `INSUFFICIENT_TOP_OF_BOOK_DEPTH (bid=${top.topBidContracts}, ask=${top.topAskContracts}, required>=${minTopDepthContracts})`,
      lhs,
      spreadCents,
    };
  }

  if (lhs < effectiveMinLhs - 1e-9) {
    return {
      allowed: false,
      reason: `LHS_BELOW_THRESHOLD (${lhs.toFixed(4)} < ${effectiveMinLhs.toFixed(2)})`,
      lhs,
      spreadCents,
    };
  }

  return {
    allowed: true,
    lhs,
    spreadCents,
  };
}

/**
 * Pure helper computing the `MICRO_LOT_30` `MAKER_POST_ONLY` entry limit price:
 * `min(best_ask - 0.01, best_bid + 0.01)` strictly inside `[0.52, 0.74]` and below `best_ask`.
 */
export function computeMicroLotMakerEntryPrice(
  bestBidUsd: number,
  bestAskUsd: number
): MicroLotMakerPriceResult {
  if (
    !Number.isFinite(bestBidUsd) ||
    !Number.isFinite(bestAskUsd) ||
    bestBidUsd <= 0 ||
    bestAskUsd >= 1 ||
    bestBidUsd >= bestAskUsd
  ) {
    return {
      valid: false,
      reason: 'MISSING_OR_INVALID_ORDERBOOK',
      limitPriceUsd: null,
      withinAskBounds: false,
      withinLimitBounds: false,
      nonCrossing: false,
    };
  }

  const withinAskBounds =
    bestAskUsd >= MICRO_LOT_30_ASK_MIN_USD - 1e-9 &&
    bestAskUsd <= MICRO_LOT_30_ASK_MAX_USD + 1e-9;

  const limitPriceUsd = Number(Math.min(bestAskUsd - 0.01, bestBidUsd + 0.01).toFixed(2));
  const nonCrossing = limitPriceUsd > 0 && limitPriceUsd < bestAskUsd - 1e-9;
  const withinLimitBounds =
    limitPriceUsd >= MICRO_LOT_30_ASK_MIN_USD - 1e-9 &&
    limitPriceUsd <= MICRO_LOT_30_ASK_MAX_USD + 1e-9;

  if (!withinAskBounds) {
    return {
      valid: false,
      reason: `ASK_OUTSIDE_BOUNDS ($${bestAskUsd.toFixed(2)} not in [$${MICRO_LOT_30_ASK_MIN_USD.toFixed(2)}, $${MICRO_LOT_30_ASK_MAX_USD.toFixed(2)}])`,
      limitPriceUsd,
      withinAskBounds,
      withinLimitBounds,
      nonCrossing,
    };
  }

  if (!nonCrossing) {
    return {
      valid: false,
      reason: `MAKER_PRICE_CROSSES_BOOK (limit $${limitPriceUsd.toFixed(2)} >= ask $${bestAskUsd.toFixed(2)})`,
      limitPriceUsd,
      withinAskBounds,
      withinLimitBounds,
      nonCrossing,
    };
  }

  if (!withinLimitBounds) {
    return {
      valid: false,
      reason: `MAKER_LIMIT_OUTSIDE_BOUNDS ($${limitPriceUsd.toFixed(2)} not in [$${MICRO_LOT_30_ASK_MIN_USD.toFixed(2)}, $${MICRO_LOT_30_ASK_MAX_USD.toFixed(2)}])`,
      limitPriceUsd,
      withinAskBounds,
      withinLimitBounds,
      nonCrossing,
    };
  }

  return {
    valid: true,
    limitPriceUsd,
    withinAskBounds: true,
    withinLimitBounds: true,
    nonCrossing: true,
  };
}

/**
 * Pure entry pre-check for `MICRO_LOT_30` (`low_balance_kalshi_compounder`), wiring
 * `evaluateMicroLotLiquidity` ahead of sizing, `[0.52, 0.74]` ask/maker bounds,
 * `MAKER_POST_ONLY` enforcement, 1-contract hard cap, and regime/edge checks.
 */
export function evaluateMicroLotEntryPreCheck(
  input: MicroLotEntryPreCheckInput
): MicroLotEntryPreCheckResult {
  const liquidity = evaluateMicroLotLiquidity(input.orderbook, input.liquidityConfig);
  const safeCashCapUsd =
    Number.isFinite(input.settledCashUsd) && input.settledCashUsd > 0
      ? Number((input.settledCashUsd * MICRO_LOT_30_SETTLED_CASH_CAP_FRACTION).toFixed(4))
      : 0;

  if (!liquidity.allowed) {
    return {
      allowed: false,
      reason: liquidity.reason ?? 'MISSING_OR_INVALID_ORDERBOOK',
      tier: MICRO_LOT_30_TIER,
      contracts: 0,
      executionMode: 'MAKER_POST_ONLY',
      postOnly: true,
      limitPriceUsd: null,
      bestBidUsd: null,
      bestAskUsd: null,
      cashCapUsd: safeCashCapUsd,
      entryFeeUsd: 0,
      unfilledAutoCancelSeconds: MICRO_LOT_30_UNFILLED_CANCEL_SECONDS,
      liquidity,
    };
  }

  const top = extractTopOfBook(input.orderbook as MicroLotOrderbookSnapshot);
  if (!top) {
    return {
      allowed: false,
      reason: 'MISSING_OR_INVALID_ORDERBOOK',
      tier: MICRO_LOT_30_TIER,
      contracts: 0,
      executionMode: 'MAKER_POST_ONLY',
      postOnly: true,
      limitPriceUsd: null,
      bestBidUsd: null,
      bestAskUsd: null,
      cashCapUsd: safeCashCapUsd,
      entryFeeUsd: 0,
      unfilledAutoCancelSeconds: MICRO_LOT_30_UNFILLED_CANCEL_SECONDS,
      liquidity: {
        allowed: false,
        reason: 'MISSING_OR_INVALID_ORDERBOOK',
        lhs: 0,
        spreadCents: 0,
      },
    };
  }

  if (!input.ticker || input.ticker.trim().length === 0) {
    return {
      allowed: false,
      reason: 'MISSING_TICKER',
      tier: MICRO_LOT_30_TIER,
      contracts: 0,
      executionMode: 'MAKER_POST_ONLY',
      postOnly: true,
      limitPriceUsd: null,
      bestBidUsd: top.bestBidUsd,
      bestAskUsd: top.bestAskUsd,
      cashCapUsd: safeCashCapUsd,
      entryFeeUsd: 0,
      unfilledAutoCancelSeconds: MICRO_LOT_30_UNFILLED_CANCEL_SECONDS,
      liquidity,
    };
  }

  const mode = input.executionMode ?? 'MAKER_POST_ONLY';
  if (mode !== 'MAKER_POST_ONLY' || input.postOnly === false) {
    return {
      allowed: false,
      reason: 'MAKER_POST_ONLY_REQUIRED',
      tier: MICRO_LOT_30_TIER,
      contracts: 0,
      executionMode: 'MAKER_POST_ONLY',
      postOnly: true,
      limitPriceUsd: null,
      bestBidUsd: top.bestBidUsd,
      bestAskUsd: top.bestAskUsd,
      cashCapUsd: safeCashCapUsd,
      entryFeeUsd: 0,
      unfilledAutoCancelSeconds: MICRO_LOT_30_UNFILLED_CANCEL_SECONDS,
      liquidity,
    };
  }

  const requestedContracts = input.requestedContracts ?? MICRO_LOT_30_MAX_CONTRACTS;
  if (
    !Number.isInteger(requestedContracts) ||
    requestedContracts < 1 ||
    requestedContracts > MICRO_LOT_30_MAX_CONTRACTS
  ) {
    return {
      allowed: false,
      reason:
        requestedContracts > MICRO_LOT_30_MAX_CONTRACTS
          ? `MAX_CONTRACTS_EXCEEDED (requested=${requestedContracts}, max=${MICRO_LOT_30_MAX_CONTRACTS})`
          : `INVALID_CONTRACT_COUNT (${requestedContracts})`,
      tier: MICRO_LOT_30_TIER,
      contracts: 0,
      executionMode: 'MAKER_POST_ONLY',
      postOnly: true,
      limitPriceUsd: null,
      bestBidUsd: top.bestBidUsd,
      bestAskUsd: top.bestAskUsd,
      cashCapUsd: safeCashCapUsd,
      entryFeeUsd: 0,
      unfilledAutoCancelSeconds: MICRO_LOT_30_UNFILLED_CANCEL_SECONDS,
      liquidity,
    };
  }

  if (!Number.isFinite(input.settledCashUsd) || input.settledCashUsd <= 0) {
    return {
      allowed: false,
      reason: 'BALANCE_UNVERIFIED_BLOCK',
      tier: MICRO_LOT_30_TIER,
      contracts: 0,
      executionMode: 'MAKER_POST_ONLY',
      postOnly: true,
      limitPriceUsd: null,
      bestBidUsd: top.bestBidUsd,
      bestAskUsd: top.bestAskUsd,
      cashCapUsd: 0,
      entryFeeUsd: 0,
      unfilledAutoCancelSeconds: MICRO_LOT_30_UNFILLED_CANCEL_SECONDS,
      liquidity,
    };
  }

  if (input.settledCashUsd >= MICRO_LOT_30_MAX_SETTLED_CASH_USD) {
    return {
      allowed: false,
      reason: `OUTSIDE_MICRO_LOT_30_CASH_TIER ($${input.settledCashUsd.toFixed(2)} >= $${MICRO_LOT_30_MAX_SETTLED_CASH_USD.toFixed(2)})`,
      tier: MICRO_LOT_30_TIER,
      contracts: 0,
      executionMode: 'MAKER_POST_ONLY',
      postOnly: true,
      limitPriceUsd: null,
      bestBidUsd: top.bestBidUsd,
      bestAskUsd: top.bestAskUsd,
      cashCapUsd: safeCashCapUsd,
      entryFeeUsd: 0,
      unfilledAutoCancelSeconds: MICRO_LOT_30_UNFILLED_CANCEL_SECONDS,
      liquidity,
    };
  }

  if (
    input.openRestingOrdersCount !== undefined &&
    (!Number.isFinite(input.openRestingOrdersCount) || input.openRestingOrdersCount !== 0)
  ) {
    return {
      allowed: false,
      reason: `OPEN_RESTING_ORDERS_PRESENT (${input.openRestingOrdersCount})`,
      tier: MICRO_LOT_30_TIER,
      contracts: 0,
      executionMode: 'MAKER_POST_ONLY',
      postOnly: true,
      limitPriceUsd: null,
      bestBidUsd: top.bestBidUsd,
      bestAskUsd: top.bestAskUsd,
      cashCapUsd: safeCashCapUsd,
      entryFeeUsd: 0,
      unfilledAutoCancelSeconds: MICRO_LOT_30_UNFILLED_CANCEL_SECONDS,
      liquidity,
    };
  }

  const makerPrice = computeMicroLotMakerEntryPrice(top.bestBidUsd, top.bestAskUsd);
  if (!makerPrice.valid || makerPrice.limitPriceUsd === null) {
    return {
      allowed: false,
      reason: makerPrice.reason ?? 'MAKER_LIMIT_OUTSIDE_BOUNDS',
      tier: MICRO_LOT_30_TIER,
      contracts: 0,
      executionMode: 'MAKER_POST_ONLY',
      postOnly: true,
      limitPriceUsd: makerPrice.limitPriceUsd,
      bestBidUsd: top.bestBidUsd,
      bestAskUsd: top.bestAskUsd,
      cashCapUsd: safeCashCapUsd,
      entryFeeUsd: 0,
      unfilledAutoCancelSeconds: MICRO_LOT_30_UNFILLED_CANCEL_SECONDS,
      liquidity,
    };
  }

  const limitPriceUsd = makerPrice.limitPriceUsd;
  if (safeCashCapUsd + 1e-9 < limitPriceUsd) {
    return {
      allowed: false,
      reason: `SETTLED_CASH_3PCT_CAP_EXCEEDED (cap=$${safeCashCapUsd.toFixed(4)} < limit=$${limitPriceUsd.toFixed(2)})`,
      tier: MICRO_LOT_30_TIER,
      contracts: 0,
      executionMode: 'MAKER_POST_ONLY',
      postOnly: true,
      limitPriceUsd,
      bestBidUsd: top.bestBidUsd,
      bestAskUsd: top.bestAskUsd,
      cashCapUsd: safeCashCapUsd,
      entryFeeUsd: 0,
      unfilledAutoCancelSeconds: MICRO_LOT_30_UNFILLED_CANCEL_SECONDS,
      liquidity,
    };
  }

  if (input.triggerId !== undefined) {
    const allowedTriggers: ReadonlyArray<string> = MICRO_LOT_30_ALLOWED_TRIGGERS;
    if (!allowedTriggers.includes(input.triggerId)) {
      return {
        allowed: false,
        reason: `UNSUPPORTED_MICRO_LOT_TRIGGER (${input.triggerId})`,
        tier: MICRO_LOT_30_TIER,
        contracts: 0,
        executionMode: 'MAKER_POST_ONLY',
        postOnly: true,
        limitPriceUsd,
        bestBidUsd: top.bestBidUsd,
        bestAskUsd: top.bestAskUsd,
        cashCapUsd: safeCashCapUsd,
        entryFeeUsd: 0,
        unfilledAutoCancelSeconds: MICRO_LOT_30_UNFILLED_CANCEL_SECONDS,
        liquidity,
      };
    }
  }

  if (input.chop14 !== undefined) {
    if (!Number.isFinite(input.chop14) || input.chop14 >= MICRO_LOT_30_CHOP14_MAX) {
      return {
        allowed: false,
        reason: `CHOP14_ABOVE_MAX (${input.chop14} >= ${MICRO_LOT_30_CHOP14_MAX})`,
        tier: MICRO_LOT_30_TIER,
        contracts: 0,
        executionMode: 'MAKER_POST_ONLY',
        postOnly: true,
        limitPriceUsd,
        bestBidUsd: top.bestBidUsd,
        bestAskUsd: top.bestAskUsd,
        cashCapUsd: safeCashCapUsd,
        entryFeeUsd: 0,
        unfilledAutoCancelSeconds: MICRO_LOT_30_UNFILLED_CANCEL_SECONDS,
        liquidity,
      };
    }
  }

  if (input.adx !== undefined) {
    if (!Number.isFinite(input.adx) || input.adx < MICRO_LOT_30_ADX_MIN) {
      return {
        allowed: false,
        reason: `ADX_BELOW_MIN (${input.adx} < ${MICRO_LOT_30_ADX_MIN})`,
        tier: MICRO_LOT_30_TIER,
        contracts: 0,
        executionMode: 'MAKER_POST_ONLY',
        postOnly: true,
        limitPriceUsd,
        bestBidUsd: top.bestBidUsd,
        bestAskUsd: top.bestAskUsd,
        cashCapUsd: safeCashCapUsd,
        entryFeeUsd: 0,
        unfilledAutoCancelSeconds: MICRO_LOT_30_UNFILLED_CANCEL_SECONDS,
        liquidity,
      };
    }
  }

  if (input.fairValueUsd !== undefined) {
    if (!Number.isFinite(input.fairValueUsd) || input.fairValueUsd <= 0 || input.fairValueUsd >= 1) {
      return {
        allowed: false,
        reason: 'INVALID_FAIR_VALUE',
        tier: MICRO_LOT_30_TIER,
        contracts: 0,
        executionMode: 'MAKER_POST_ONLY',
        postOnly: true,
        limitPriceUsd,
        bestBidUsd: top.bestBidUsd,
        bestAskUsd: top.bestAskUsd,
        cashCapUsd: safeCashCapUsd,
        entryFeeUsd: 0,
        unfilledAutoCancelSeconds: MICRO_LOT_30_UNFILLED_CANCEL_SECONDS,
        liquidity,
      };
    }
    const safeAtr =
      input.atr14ProbUsd !== undefined && Number.isFinite(input.atr14ProbUsd) && input.atr14ProbUsd > 0
        ? input.atr14ProbUsd
        : 0;
    const requiredGrossEdgeUsd = Math.max(
      MICRO_LOT_30_MIN_FV_MINUS_ENTRY_USD,
      KALSHI_STRESSED_DRAG_FLOOR_USD + 1.1 * safeAtr
    );
    const grossEdgeUsd = Number((input.fairValueUsd - limitPriceUsd).toFixed(4));
    if (grossEdgeUsd < requiredGrossEdgeUsd - 1e-9) {
      return {
        allowed: false,
        reason: `INSUFFICIENT_MAKER_EDGE (gross=$${grossEdgeUsd.toFixed(4)} < required=$${requiredGrossEdgeUsd.toFixed(4)})`,
        tier: MICRO_LOT_30_TIER,
        contracts: 0,
        executionMode: 'MAKER_POST_ONLY',
        postOnly: true,
        limitPriceUsd,
        bestBidUsd: top.bestBidUsd,
        bestAskUsd: top.bestAskUsd,
        cashCapUsd: safeCashCapUsd,
        entryFeeUsd: 0,
        unfilledAutoCancelSeconds: MICRO_LOT_30_UNFILLED_CANCEL_SECONDS,
        liquidity,
      };
    }
  }

  const entryFeeUsd = computeKalshiOrderFeeUsd(
    MICRO_LOT_30_MAX_CONTRACTS,
    limitPriceUsd,
    'MAKER_POST_ONLY'
  );

  return {
    allowed: true,
    tier: MICRO_LOT_30_TIER,
    contracts: 1,
    executionMode: 'MAKER_POST_ONLY',
    postOnly: true,
    limitPriceUsd,
    bestBidUsd: top.bestBidUsd,
    bestAskUsd: top.bestAskUsd,
    cashCapUsd: safeCashCapUsd,
    entryFeeUsd,
    unfilledAutoCancelSeconds: MICRO_LOT_30_UNFILLED_CANCEL_SECONDS,
    liquidity,
  };
}

/**
 * Pure exit pre-check for `MICRO_LOT_30` positions, enforcing:
 *   1. Rule 3 Pre-Exit Sweep verification (`cancelSweepConfirmed === true` and `openRestingOrdersCount === 0`).
 *   2. Settled position size strictly equal to `1` contract.
 *   3. `evaluateMicroLotLiquidity` gate (`LHS >= 0.65`, valid real orderbook, spread cap, 1-contract top depth)
 *      before permitting passive exits (and requiring a valid non-synthetic orderbook + 1-contract bid depth
 *      even on emergency `reduce_only` IOC closes).
 */
export function evaluateMicroLotExitPreCheck(
  input: MicroLotExitPreCheckInput
): MicroLotExitPreCheckResult {
  const exitMode: MicroLotExitMode = input.exitMode ?? 'PASSIVE_MAKER';
  const liquidity = evaluateMicroLotLiquidity(input.orderbook, input.liquidityConfig);

  if (!input.ticker || input.ticker.trim().length === 0) {
    return {
      allowed: false,
      reason: 'MISSING_TICKER',
      tier: MICRO_LOT_30_TIER,
      contractsToClose: 0,
      exitMode,
      passiveLimitPriceUsd: null,
      expectedExitFeeUsd: 0,
      liquidity,
    };
  }

  if (!input.cancelSweepConfirmed || input.openRestingOrdersCount !== 0) {
    return {
      allowed: false,
      reason: `RULE3_PRE_EXIT_SWEEP_UNCONFIRMED (cancelConfirmed=${input.cancelSweepConfirmed}, openResting=${input.openRestingOrdersCount})`,
      tier: MICRO_LOT_30_TIER,
      contractsToClose: 0,
      exitMode,
      passiveLimitPriceUsd: null,
      expectedExitFeeUsd: 0,
      liquidity,
    };
  }

  if (
    !Number.isInteger(input.settledPositionContracts) ||
    input.settledPositionContracts !== MICRO_LOT_30_MAX_CONTRACTS
  ) {
    return {
      allowed: false,
      reason: `INVALID_SETTLED_POSITION_SIZE (settled=${input.settledPositionContracts}, expected=${MICRO_LOT_30_MAX_CONTRACTS})`,
      tier: MICRO_LOT_30_TIER,
      contractsToClose: 0,
      exitMode,
      passiveLimitPriceUsd: null,
      expectedExitFeeUsd: 0,
      liquidity,
    };
  }

  const top = input.orderbook ? extractTopOfBook(input.orderbook) : null;
  if (!top) {
    return {
      allowed: false,
      reason: 'MISSING_OR_INVALID_ORDERBOOK',
      tier: MICRO_LOT_30_TIER,
      contractsToClose: 0,
      exitMode,
      passiveLimitPriceUsd: null,
      expectedExitFeeUsd: 0,
      liquidity: {
        allowed: false,
        reason: 'MISSING_OR_INVALID_ORDERBOOK',
        lhs: 0,
        spreadCents: 0,
      },
    };
  }

  if (exitMode === 'PASSIVE_MAKER') {
    if (!liquidity.allowed || liquidity.lhs < MICRO_LOT_30_MIN_LHS - 1e-9) {
      return {
        allowed: false,
        reason: liquidity.reason ?? `LHS_BELOW_THRESHOLD (${liquidity.lhs.toFixed(4)} < ${MICRO_LOT_30_MIN_LHS.toFixed(2)})`,
        tier: MICRO_LOT_30_TIER,
        contractsToClose: 0,
        exitMode,
        passiveLimitPriceUsd: null,
        expectedExitFeeUsd: 0,
        liquidity,
      };
    }

    // 1c inside spread (or non-crossing bestAsk - 0.01 when spread == 1c -> falls back to bestAsk for passive maker sell above bestBid)
    const rawPassiveSell =
      top.bestAskUsd - top.bestBidUsd >= 0.02 - 1e-9
        ? Math.max(top.bestBidUsd + 0.01, top.bestAskUsd - 0.01)
        : top.bestAskUsd;
    const passiveLimitPriceUsd = Number(
      Math.max(0.01, Math.min(0.99, rawPassiveSell)).toFixed(2)
    );
    const expectedExitFeeUsd = computeKalshiOrderFeeUsd(
      MICRO_LOT_30_MAX_CONTRACTS,
      passiveLimitPriceUsd,
      'MAKER_POST_ONLY'
    );

    return {
      allowed: true,
      tier: MICRO_LOT_30_TIER,
      contractsToClose: 1,
      exitMode,
      passiveLimitPriceUsd,
      expectedExitFeeUsd,
      liquidity,
    };
  }

  // EMERGENCY_IOC_REDUCE_ONLY: still requires real orderbook (no NaN/stale/missing) and >= 1 contract bid depth
  if (liquidity.reason === 'MISSING_OR_INVALID_ORDERBOOK') {
    return {
      allowed: false,
      reason: 'MISSING_OR_INVALID_ORDERBOOK',
      tier: MICRO_LOT_30_TIER,
      contractsToClose: 0,
      exitMode,
      passiveLimitPriceUsd: null,
      expectedExitFeeUsd: 0,
      liquidity,
    };
  }

  if (top.topBidContracts < MICRO_LOT_30_MIN_TOP_DEPTH_CONTRACTS - 1e-9) {
    return {
      allowed: false,
      reason: `INSUFFICIENT_TOP_OF_BOOK_DEPTH (bid=${top.topBidContracts}, required>=${MICRO_LOT_30_MIN_TOP_DEPTH_CONTRACTS})`,
      tier: MICRO_LOT_30_TIER,
      contractsToClose: 0,
      exitMode,
      passiveLimitPriceUsd: null,
      expectedExitFeeUsd: 0,
      liquidity,
    };
  }

  const expectedExitFeeUsd = computeKalshiOrderFeeUsd(
    MICRO_LOT_30_MAX_CONTRACTS,
    top.bestBidUsd,
    'TAKER'
  );

  return {
    allowed: true,
    tier: MICRO_LOT_30_TIER,
    contractsToClose: 1,
    exitMode,
    passiveLimitPriceUsd: null,
    expectedExitFeeUsd,
    liquidity,
  };
}
