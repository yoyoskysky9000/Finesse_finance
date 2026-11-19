import rawChampionConfig from '../../champion_config.json';
import { LEAD_LAG_PARAMS } from '../config/strategyParams';
import type { OHLCVBar } from '../types/quant';

export interface UnifiedChampionConfig {
  schema_version: string;
  champion_id: string;
  active_strategy: {
    id: string;
    label: string;
    timeframe: string;
    execution_mode: string;
    entry: {
      min_edge_floor_usd: number;
      min_edge_base_usd: number;
      min_edge_atr_mult: number;
      ask_gate: [number, number];
      window_minutes: [number, number];
      drag_floor_usd: number;
    };
    regime_filters: {
      chop14_period: number;
      chop14_entry_max: number;
      chop14_regime_flip_pause: number;
      adx_period_5m: number;
      adx_period_15m_1h: number;
      adx_min_entry: number;
      adx_pause_below: number;
      kaufman_er_period: number;
      kaufman_er_min: number;
      bbw_lookback_bars: number;
      bbw_percentile_min: number;
      atr_ratio_lookback_bars: number;
      atr_ratio_percentile_min: number;
      garman_klass_vrp_percentile_max: number;
    };
    liquidity_filters: {
      max_bid_ask_spread_usd: number;
      min_bbo_depth_usd: number;
      twap_obi_window_ms: number;
      min_lhs_threshold: number;
    };
    exit_rules: {
      take_profit_floor_usd: number;
      take_profit_atr_mult: number;
      take_profit_fv_bid_gap_max_usd: number;
      trailing_lock_atr_mult: number;
      trailing_lock_gain_protect_pct: number;
      stop_loss_floor_usd: number;
      stop_loss_atr_mult: number;
      stop_loss_fv_bid_gap_threshold_usd: number;
      stop_loss_consecutive_15s_confirmations: number;
      dead_trade_time_stop_minutes: number;
      dead_trade_min_pnl_atr_mult: number;
      forced_flat_seconds_before_expiry: number;
    };
  };
  risk_caps: {
    sizing_basis: string;
    settled_cash_cap_fraction: number;
    max_risk_per_trade_pct_of_settled_cash: number;
    idempotency_key_format: string;
    idempotency_cooldowns_seconds: {
      '5m': number;
      '15m': number;
      '1h': number;
    };
    pre_exit_sweep: {
      cancel_all_open_orders_first: boolean;
      confirm_balance_release: boolean;
      recalculate_lhs_before_exit: boolean;
      lhs_limit_inside_spread_cents: number;
      min_lhs_for_single_limit: number;
      passive_twap_micro_tranches: number;
    };
  };
  portfolio_correlation_rules: {
    per_position_settled_cash_cap_pct: number;
    max_aggregate_drawdown_pct_15m: number;
    max_aggregate_notional_pct_at_reference: number;
    correlation_stress_model: string;
    unknown_correlation_default: number;
  };
  low_balance_kalshi_compounder?: {
    enabled: boolean;
    tier_name: string;
    max_settled_cash_usd: number;
    settled_cash_cap_fraction: number;
    max_contracts_per_trade: number;
    pre_entry_resting_order_check: {
      enabled: boolean;
      cancel_stale_resting_orders_first: boolean;
      confirm_zero_resting_orders_before_entry: boolean;
    };
    maker_first_entry: {
      post_only: boolean;
      time_in_force: string;
      cancel_order_on_pause: boolean;
      allowed_triggers: string[];
      min_fv_minus_entry_dollars: number;
      chop14_max: number;
      adx_min: number;
      lhs_min: number;
      price_band: [number, number];
      price_formula: string;
      unfilled_auto_cancel_seconds: number;
      never_chase_market_order: boolean;
    };
    zero_fee_settlement_hold_exemption: {
      enabled: boolean;
      max_contracts: number;
      t_minus_seconds: number;
      min_fv_nd2: number;
      min_itm_sigma_sqrt_tau_mult: number;
      settlement_fee_usd: number;
    };
    tight_2eval_inversion_stop: {
      enabled: boolean;
      fv_minus_bid_threshold_usd: number;
      consecutive_15s_checks: number;
      max_unrealized_loss_usd: number;
      trigger_rule3_pre_exit_sweep: boolean;
    };
  };
}

const baseChampion = rawChampionConfig as unknown as UnifiedChampionConfig;
export const CHAMPION_CONFIG: UnifiedChampionConfig = {
  ...baseChampion,
  active_strategy: {
    ...baseChampion.active_strategy,
    entry: {
      ...baseChampion.active_strategy.entry,
      min_edge_floor_usd: LEAD_LAG_PARAMS.minNetEdgeDollars,
      ask_gate: [LEAD_LAG_PARAMS.askGateMin, LEAD_LAG_PARAMS.askGateMax],
      window_minutes: [...LEAD_LAG_PARAMS.timeWindowMinutes] as [number, number],
    },
  },
};

export interface ObiSample {
  tsMs: number;
  bidDepthUsd: number;
  askDepthUsd: number;
}

export interface LiquidityHealthResult {
  lhs: number;
  passed: boolean;
  spreadUsd: number;
  bboDepthUsd: number;
  twapObi: number;
  spreadScore: number;
  depthScore: number;
  obiScore: number;
  reasons: string[];
}

export interface RegimeMetricsSnapshot {
  chop14: number;
  adx: number;
  adxPeriod: number;
  kaufmanEr10: number;
  bbwPercentile125: number;
  atrRatioPercentile125: number;
  garmanKlassVrpPercentile: number;
}

export interface RegimeAndLiquidityInput {
  timeframe: '5m' | '15m' | '1h';
  bars?: OHLCVBar[];
  metricsOverride?: Partial<RegimeMetricsSnapshot>;
  askPriceUsd: number;
  bestBidUsd: number;
  bestAskUsd: number;
  fairValueUsd: number;
  atr14Usd: number;
  minutesRemaining: number;
  dragUsd?: number;
  bboDepthUsd: number;
  obiSamples?: ObiSample[];
  nowMs?: number;
  is24hTickerSnapshot?: boolean;
}

export interface RegimeAndLiquidityVerdict {
  approved: boolean;
  regimeFlipPause: boolean;
  adxPause: boolean;
  entryEdgeRequiredUsd: number;
  requiredGrossEdgeUsd: number;
  observedGrossEdgeUsd: number;
  observedNetEdgeUsd: number;
  metrics: RegimeMetricsSnapshot;
  liquidity: LiquidityHealthResult;
  blockReasons: string[];
  pauseReasons: string[];
}

function percentileRank(series: number[], value: number): number {
  if (series.length === 0) return 0.5;
  let lessOrEqual = 0;
  for (const v of series) {
    if (v <= value) lessOrEqual += 1;
  }
  return Number((lessOrEqual / series.length).toFixed(4));
}

export function computeChop14(bars: OHLCVBar[], period = 14): number {
  if (bars.length < period + 1) return 45;
  const slice = bars.slice(-period - 1);
  let trSum = 0;
  let highestHigh = -Infinity;
  let lowestLow = Infinity;
  for (let i = 1; i < slice.length; i += 1) {
    const prev = slice[i - 1];
    const curr = slice[i];
    const tr = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low - prev.close)
    );
    trSum += tr;
    if (curr.high > highestHigh) highestHigh = curr.high;
    if (curr.low < lowestLow) lowestLow = curr.low;
  }
  const range = Math.max(1e-9, highestHigh - lowestLow);
  const ratio = Math.max(1, trSum / range);
  const chop = (100 * Math.log10(ratio)) / Math.log10(period);
  return Number(Math.max(0, Math.min(100, chop)).toFixed(2));
}

export function computeWilderAdx(bars: OHLCVBar[], period: number): number {
  if (bars.length < period + 2) return 26;
  const slice = bars.slice(-(period * 3 + 2));
  let smoothedTr = 0;
  let smoothedPlusDm = 0;
  let smoothedMinusDm = 0;
  const dxList: number[] = [];

  for (let i = 1; i < slice.length; i += 1) {
    const prev = slice[i - 1];
    const curr = slice[i];
    const upMove = curr.high - prev.high;
    const downMove = prev.low - curr.low;
    const plusDm = upMove > downMove && upMove > 0 ? upMove : 0;
    const minusDm = downMove > upMove && downMove > 0 ? downMove : 0;
    const tr = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low - prev.close)
    );

    if (i <= period) {
      smoothedTr += tr;
      smoothedPlusDm += plusDm;
      smoothedMinusDm += minusDm;
      if (i === period && smoothedTr > 0) {
        const pDi = (smoothedPlusDm / smoothedTr) * 100;
        const mDi = (smoothedMinusDm / smoothedTr) * 100;
        const diSum = pDi + mDi;
        dxList.push(diSum > 0 ? (Math.abs(pDi - mDi) / diSum) * 100 : 0);
      }
    } else {
      smoothedTr = smoothedTr - smoothedTr / period + tr;
      smoothedPlusDm = smoothedPlusDm - smoothedPlusDm / period + plusDm;
      smoothedMinusDm = smoothedMinusDm - smoothedMinusDm / period + minusDm;
      if (smoothedTr > 0) {
        const pDi = (smoothedPlusDm / smoothedTr) * 100;
        const mDi = (smoothedMinusDm / smoothedTr) * 100;
        const diSum = pDi + mDi;
        dxList.push(diSum > 0 ? (Math.abs(pDi - mDi) / diSum) * 100 : 0);
      }
    }
  }

  if (dxList.length === 0) return 25;
  const recentDx = dxList.slice(-period);
  const adx = recentDx.reduce((a, b) => a + b, 0) / recentDx.length;
  return Number(adx.toFixed(2));
}

export function computeKaufmanEr(bars: OHLCVBar[], period = 10): number {
  if (bars.length < period + 1) return 0.4;
  const slice = bars.slice(-period - 1);
  const netChange = Math.abs(slice[slice.length - 1].close - slice[0].close);
  let pathLength = 0;
  for (let i = 1; i < slice.length; i += 1) {
    pathLength += Math.abs(slice[i].close - slice[i - 1].close);
  }
  if (pathLength <= 1e-12) return 0;
  return Number(Math.min(1, netChange / pathLength).toFixed(4));
}

export function computeBbwPercentile(bars: OHLCVBar[], lookback = 125, bbPeriod = 20): number {
  if (bars.length < bbPeriod + 2) return 0.5;
  const windowBars = bars.slice(-(lookback + bbPeriod));
  const widths: number[] = [];
  for (let i = bbPeriod - 1; i < windowBars.length; i += 1) {
    const sub = windowBars.slice(i - bbPeriod + 1, i + 1);
    const mean = sub.reduce((a, b) => a + b.close, 0) / bbPeriod;
    const variance =
      sub.reduce((acc, b) => acc + Math.pow(b.close - mean, 2), 0) / bbPeriod;
    const std = Math.sqrt(variance);
    widths.push(mean > 0 ? (4 * std) / mean : 0);
  }
  const latest = widths[widths.length - 1] ?? 0;
  return percentileRank(widths, latest);
}

export function computeAtrRatioPercentile(bars: OHLCVBar[], lookback = 125): number {
  if (bars.length < 30) return 0.5;
  const windowBars = bars.slice(-(lookback + 20));
  const trs: number[] = [];
  for (let i = 1; i < windowBars.length; i += 1) {
    const prev = windowBars[i - 1];
    const curr = windowBars[i];
    trs.push(
      Math.max(
        curr.high - curr.low,
        Math.abs(curr.high - prev.close),
        Math.abs(curr.low - prev.close)
      )
    );
  }
  const ratios: number[] = [];
  for (let i = 14; i < trs.length; i += 1) {
    const atr5 = trs.slice(i - 5, i).reduce((a, b) => a + b, 0) / 5;
    const atr14 = trs.slice(i - 14, i).reduce((a, b) => a + b, 0) / 14;
    ratios.push(atr14 > 0 ? atr5 / atr14 : 1);
  }
  const latest = ratios[ratios.length - 1] ?? 1;
  return percentileRank(ratios, latest);
}

export function computeGarmanKlassVrpPercentile(bars: OHLCVBar[], lookback = 125): number {
  if (bars.length < 20) return 0.5;
  const windowBars = bars.slice(-Math.max(20, lookback));
  const gkSeries: number[] = [];
  const ln2Minus1 = 2 * Math.LN2 - 1;
  for (let i = 1; i < windowBars.length; i += 1) {
    const b = windowBars[i];
    const prevClose = Math.max(1e-9, windowBars[i - 1].close);
    const hl = Math.log(Math.max(1e-9, b.high) / Math.max(1e-9, b.low));
    const co = Math.log(Math.max(1e-9, b.close) / Math.max(1e-9, b.open));
    const gkVar = Math.max(0, 0.5 * hl * hl - ln2Minus1 * co * co);
    const ccRet = Math.log(Math.max(1e-9, b.close) / prevClose);
    const ccVar = ccRet * ccRet;
    gkSeries.push(gkVar + 0.25 * ccVar);
  }
  const latest = gkSeries[gkSeries.length - 1] ?? 0;
  return percentileRank(gkSeries, latest);
}

/**
 * Computes Liquidity Health Score (LHS in [0, 1]) over a 1000ms TWAP OBI window,
 * spread <= $0.03, and BBO depth >= $5,000.
 */
export function computeLiquidityHealthScore(params: {
  bestBidUsd: number;
  bestAskUsd: number;
  bboDepthUsd: number;
  obiSamples?: ObiSample[];
  nowMs?: number;
}): LiquidityHealthResult {
  const cfg = CHAMPION_CONFIG.active_strategy.liquidity_filters;
  const nowMs = params.nowMs ?? Date.now();
  const spreadUsd = Number(Math.max(0, params.bestAskUsd - params.bestBidUsd).toFixed(4));
  const bboDepthUsd = Math.max(0, params.bboDepthUsd);

  const recentSamples = (params.obiSamples || []).filter(
    (s) => nowMs - s.tsMs <= cfg.twap_obi_window_ms && nowMs - s.tsMs >= 0
  );
  let twapObi = 0;
  if (recentSamples.length > 0) {
    const obis = recentSamples.map((s) => {
      const total = s.bidDepthUsd + s.askDepthUsd;
      return total > 0 ? (s.bidDepthUsd - s.askDepthUsd) / total : 0;
    });
    twapObi = obis.reduce((a, b) => a + b, 0) / obis.length;
  }

  // Spread sub-score: 1.0 when spread == 0, 0.65 at max_bid_ask_spread_usd ($0.03), decays rapidly above
  const spreadScore =
    spreadUsd <= cfg.max_bid_ask_spread_usd
      ? Math.max(0.65, 1.0 - (spreadUsd / cfg.max_bid_ask_spread_usd) * 0.35)
      : Math.max(0, 0.65 - ((spreadUsd - cfg.max_bid_ask_spread_usd) / cfg.max_bid_ask_spread_usd) * 0.65);

  // BBO depth sub-score: saturates at 1.0 at >= 1.5x min_bbo_depth_usd ($7,500), 0.75 at $5,000
  const depthRatio = bboDepthUsd / Math.max(1, cfg.min_bbo_depth_usd);
  const depthScore =
    depthRatio >= 1
      ? Math.min(1.0, 0.75 + (depthRatio - 1) * 0.25)
      : Math.max(0, depthRatio * 0.6);

  // Orderbook imbalance stability sub-score over TWAP 1000ms window
  const obiScore = Math.max(0.3, 1.0 - Math.min(0.7, Math.abs(twapObi) * 0.7));

  const lhs = Number((spreadScore * 0.45 + depthScore * 0.4 + obiScore * 0.15).toFixed(4));
  const reasons: string[] = [];
  if (spreadUsd > cfg.max_bid_ask_spread_usd) {
    reasons.push(`Spread $${spreadUsd.toFixed(4)} > max $${cfg.max_bid_ask_spread_usd.toFixed(2)}`);
  }
  if (bboDepthUsd < cfg.min_bbo_depth_usd) {
    reasons.push(`BBO depth $${bboDepthUsd.toFixed(0)} < min $${cfg.min_bbo_depth_usd}`);
  }
  if (lhs < cfg.min_lhs_threshold) {
    reasons.push(`LHS ${lhs.toFixed(3)} < min threshold ${cfg.min_lhs_threshold.toFixed(2)}`);
  }

  return {
    lhs,
    passed:
      spreadUsd <= cfg.max_bid_ask_spread_usd &&
      bboDepthUsd >= cfg.min_bbo_depth_usd &&
      lhs >= cfg.min_lhs_threshold,
    spreadUsd,
    bboDepthUsd,
    twapObi: Number(twapObi.toFixed(4)),
    spreadScore: Number(spreadScore.toFixed(4)),
    depthScore: Number(depthScore.toFixed(4)),
    obiScore: Number(obiScore.toFixed(4)),
    reasons,
  };
}

/**
 * Evaluates all TASK-04 Champion Entry, Regime, and Liquidity Filters.
 */
export function evaluateRegimeAndLiquidity(
  input: RegimeAndLiquidityInput
): RegimeAndLiquidityVerdict {
  const cfg = CHAMPION_CONFIG.active_strategy;
  const entryCfg = cfg.entry;
  const regCfg = cfg.regime_filters;
  const bars = input.bars || [];
  const adxPeriod =
    input.timeframe === '5m' ? regCfg.adx_period_5m : regCfg.adx_period_15m_1h;

  const metrics: RegimeMetricsSnapshot = {
    chop14: input.metricsOverride?.chop14 ?? computeChop14(bars, regCfg.chop14_period),
    adx: input.metricsOverride?.adx ?? computeWilderAdx(bars, adxPeriod),
    adxPeriod,
    kaufmanEr10:
      input.metricsOverride?.kaufmanEr10 ??
      computeKaufmanEr(bars, regCfg.kaufman_er_period),
    bbwPercentile125:
      input.metricsOverride?.bbwPercentile125 ??
      computeBbwPercentile(bars, regCfg.bbw_lookback_bars),
    atrRatioPercentile125:
      input.metricsOverride?.atrRatioPercentile125 ??
      computeAtrRatioPercentile(bars, regCfg.atr_ratio_lookback_bars),
    garmanKlassVrpPercentile:
      input.metricsOverride?.garmanKlassVrpPercentile ??
      computeGarmanKlassVrpPercentile(bars, regCfg.bbw_lookback_bars),
  };

  const liquidity = computeLiquidityHealthScore({
    bestBidUsd: input.bestBidUsd,
    bestAskUsd: input.bestAskUsd,
    bboDepthUsd: input.bboDepthUsd,
    obiSamples: input.obiSamples,
    nowMs: input.nowMs,
  });

  const blockReasons: string[] = [];
  const pauseReasons: string[] = [];

  // Entry edge & gate checks (SECTION-74-FOLLOWUP: single drag deduction matching LeadLagAnomalyTriggers)
  // grossEdge = FV - ask; pass requires grossEdge >= max(0.18, 0.12 + 1.1 * atr14Usd)
  // equivalently netEdgeAfterDrag = grossEdge - dragFloor >= max(0.06, 1.1 * atr14Usd)
  const safeAtr14Usd = Number.isFinite(input.atr14Usd) && input.atr14Usd > 0 ? input.atr14Usd : 0;
  const dragFloor = Math.max(
    entryCfg.drag_floor_usd,
    typeof input.dragUsd === 'number' && Number.isFinite(input.dragUsd)
      ? input.dragUsd
      : entryCfg.drag_floor_usd
  );
  const minNetEdgeAfterDragFloorUsd = 0.06; // $0.18 gross floor minus $0.12 stressed drag floor
  const requiredNetEdgeAfterDragUsd = Number(
    Math.max(
      minNetEdgeAfterDragFloorUsd,
      entryCfg.min_edge_atr_mult * safeAtr14Usd
    ).toFixed(6)
  );
  const requiredGrossEdgeUsd = Number(
    (dragFloor + requiredNetEdgeAfterDragUsd).toFixed(6)
  );
  const observedGrossEdgeUsd = Number((input.fairValueUsd - input.askPriceUsd).toFixed(6));
  const observedNetEdgeUsd = Number((observedGrossEdgeUsd - dragFloor).toFixed(6));
  const entryEdgeRequiredUsd = Number(requiredNetEdgeAfterDragUsd.toFixed(4));

  if (
    input.askPriceUsd < entryCfg.ask_gate[0] ||
    input.askPriceUsd > entryCfg.ask_gate[1]
  ) {
    blockReasons.push(
      `Ask $${input.askPriceUsd.toFixed(2)} outside gate [$${entryCfg.ask_gate[0].toFixed(2)}, $${entryCfg.ask_gate[1].toFixed(2)}]`
    );
  }
  if (
    input.minutesRemaining < entryCfg.window_minutes[0] ||
    input.minutesRemaining > entryCfg.window_minutes[1]
  ) {
    blockReasons.push(
      `Window T-${input.minutesRemaining.toFixed(1)}m outside [${entryCfg.window_minutes[0]}, ${entryCfg.window_minutes[1]}]m`
    );
  }
  const edgeGatePassed =
    Number.isFinite(observedGrossEdgeUsd) &&
    Number.isFinite(observedNetEdgeUsd) &&
    observedGrossEdgeUsd >= requiredGrossEdgeUsd - 1e-9 &&
    observedNetEdgeUsd >= requiredNetEdgeAfterDragUsd - 1e-9;
  if (!edgeGatePassed) {
    blockReasons.push(
      `Edge below floor: gross $${observedGrossEdgeUsd.toFixed(4)} < required $${requiredGrossEdgeUsd.toFixed(4)} (net $${observedNetEdgeUsd.toFixed(4)} after $${dragFloor.toFixed(2)} drag < required $${requiredNetEdgeAfterDragUsd.toFixed(4)})`
    );
  }

  // Regime checks
  const regimeFlipPause = metrics.chop14 > regCfg.chop14_regime_flip_pause;
  if (regimeFlipPause) {
    pauseReasons.push(
      `CHOP(14)=${metrics.chop14.toFixed(2)} > ${regCfg.chop14_regime_flip_pause} triggers regime-flip pause`
    );
  }
  if (metrics.chop14 >= regCfg.chop14_entry_max) {
    blockReasons.push(
      `CHOP(14)=${metrics.chop14.toFixed(2)} >= entry ceiling ${regCfg.chop14_entry_max}`
    );
  }

  const adxPause = metrics.adx < regCfg.adx_pause_below;
  if (adxPause) {
    pauseReasons.push(
      `ADX(${adxPeriod})=${metrics.adx.toFixed(2)} < ${regCfg.adx_pause_below} triggers trend pause`
    );
  }
  if (metrics.adx < regCfg.adx_min_entry) {
    blockReasons.push(
      `ADX(${adxPeriod})=${metrics.adx.toFixed(2)} < min entry ${regCfg.adx_min_entry}`
    );
  }

  if (metrics.kaufmanEr10 < regCfg.kaufman_er_min) {
    blockReasons.push(
      `Kaufman_ER(10)=${metrics.kaufmanEr10.toFixed(3)} < ${regCfg.kaufman_er_min}`
    );
  }
  if (metrics.bbwPercentile125 < regCfg.bbw_percentile_min) {
    blockReasons.push(
      `BBW_percentile=${metrics.bbwPercentile125.toFixed(3)} < ${regCfg.bbw_percentile_min}`
    );
  }
  if (metrics.atrRatioPercentile125 < regCfg.atr_ratio_percentile_min) {
    blockReasons.push(
      `ATR_ratio_percentile=${metrics.atrRatioPercentile125.toFixed(3)} < ${regCfg.atr_ratio_percentile_min}`
    );
  }
  if (metrics.garmanKlassVrpPercentile > regCfg.garman_klass_vrp_percentile_max) {
    blockReasons.push(
      `Garman_Klass_VRP_percentile=${metrics.garmanKlassVrpPercentile.toFixed(3)} > ${regCfg.garman_klass_vrp_percentile_max}`
    );
  }

  if (!liquidity.passed) {
    blockReasons.push(...liquidity.reasons);
  }

  return {
    approved: blockReasons.length === 0 && pauseReasons.length === 0,
    regimeFlipPause,
    adxPause,
    entryEdgeRequiredUsd,
    requiredGrossEdgeUsd: Number(requiredGrossEdgeUsd.toFixed(4)),
    observedGrossEdgeUsd: Number(observedGrossEdgeUsd.toFixed(4)),
    observedNetEdgeUsd: Number(observedNetEdgeUsd.toFixed(4)),
    metrics,
    liquidity,
    blockReasons,
    pauseReasons,
  };
}

export interface ChampionExitEvalInput {
  positionId: string;
  entryPriceUsd: number;
  liveBidUsd: number;
  fairValueUsd: number;
  atr14Usd: number;
  peakGainUsd: number;
  elapsedMinutes: number;
  secondsToExpiry: number;
  consecutiveFvGapBreaches: number;
  regimeFlipPause?: boolean;
  /** Optional low_balance_kalshi_compounder telemetry (< $150 settled cash) */
  settledCashUsd?: number;
  compounderMode?: boolean;
  contracts?: number;
  side?: 'YES' | 'NO' | 'BUY_YES' | 'BUY_NO';
  spotPriceUsd?: number;
  strikePriceUsd?: number;
  annualizedSigma?: number;
}

export interface ZeroFeeSettlementExemptionResult {
  exempt: boolean;
  fvNd2: number;
  signedItmLogDistance: number;
  requiredSigmaSqrtTau: number;
  tauYears: number;
  reason: string;
}

export function evaluateZeroFeeSettlementHoldExemption(params: {
  contracts: number;
  fairValueUsd: number;
  secondsToExpiry: number;
  side?: 'YES' | 'NO' | 'BUY_YES' | 'BUY_NO';
  spotPriceUsd?: number;
  strikePriceUsd?: number;
  annualizedSigma?: number;
}): ZeroFeeSettlementExemptionResult {
  const cfg = CHAMPION_CONFIG.low_balance_kalshi_compounder?.zero_fee_settlement_hold_exemption;
  const maxContracts = cfg?.max_contracts ?? 1;
  const tMinusSec = cfg?.t_minus_seconds ?? 90;
  const minFv = cfg?.min_fv_nd2 ?? 0.85;
  const mult = cfg?.min_itm_sigma_sqrt_tau_mult ?? 0.25;

  const tauYears = Math.max(params.secondsToExpiry, 0.1) / (365.25 * 24 * 3600);
  const sigma = params.annualizedSigma ?? 0;
  const spot = params.spotPriceUsd ?? 0;
  const strike = params.strikePriceUsd ?? 0;

  if (params.contracts !== maxContracts || params.contracts <= 0) {
    return {
      exempt: false,
      fvNd2: params.fairValueUsd,
      signedItmLogDistance: 0,
      requiredSigmaSqrtTau: 0,
      tauYears,
      reason: `Contracts=${params.contracts} != ${maxContracts} (exemption applies to 1-contract compounder positions).`,
    };
  }
  if (params.secondsToExpiry > tMinusSec) {
    return {
      exempt: false,
      fvNd2: params.fairValueUsd,
      signedItmLogDistance: 0,
      requiredSigmaSqrtTau: 0,
      tauYears,
      reason: `T-${params.secondsToExpiry.toFixed(0)}s > T-${tMinusSec}s cutoff.`,
    };
  }
  if (params.fairValueUsd < minFv) {
    return {
      exempt: false,
      fvNd2: params.fairValueUsd,
      signedItmLogDistance: 0,
      requiredSigmaSqrtTau: 0,
      tauYears,
      reason: `FV(N(d2))=${params.fairValueUsd.toFixed(3)} < ${minFv.toFixed(2)} minimum for zero-fee settlement hold.`,
    };
  }
  if (!(spot > 0 && strike > 0 && sigma > 0)) {
    return {
      exempt: false,
      fvNd2: params.fairValueUsd,
      signedItmLogDistance: 0,
      requiredSigmaSqrtTau: 0,
      tauYears,
      reason: 'Missing spotPriceUsd, strikePriceUsd, or annualizedSigma for ITM > 0.25*sigma*sqrt(tau) check.',
    };
  }

  const sigmaSqrtTau = sigma * Math.sqrt(tauYears);
  const requiredSigmaSqrtTau = mult * sigmaSqrtTau;
  const isNo = params.side === 'NO' || params.side === 'BUY_NO';
  const signedItmLogDistance = isNo ? Math.log(strike / spot) : Math.log(spot / strike);
  const itmPasses = signedItmLogDistance > requiredSigmaSqrtTau;

  return {
    exempt: itmPasses,
    fvNd2: params.fairValueUsd,
    signedItmLogDistance: Number(signedItmLogDistance.toFixed(6)),
    requiredSigmaSqrtTau: Number(requiredSigmaSqrtTau.toFixed(6)),
    tauYears,
    reason: itmPasses
      ? `ZERO_FEE_SETTLEMENT_HOLD_EXEMPT: 1 contract with FV(N(d2))=${params.fairValueUsd.toFixed(3)} >= ${minFv} and ITM ${signedItmLogDistance.toFixed(5)} > ${mult}*sigma*sqrt(tau)=${requiredSigmaSqrtTau.toFixed(5)}; skipping T-${tMinusSec}s taker exit to settle at $1.00 ($0.00 fee).`
      : `ITM distance ${signedItmLogDistance.toFixed(5)} <= ${mult}*sigma*sqrt(tau)=${requiredSigmaSqrtTau.toFixed(5)}.`,
  };
}

export interface ChampionExitEvalResult {
  shouldExit: boolean;
  reason:
    | 'HOLD'
    | 'HOLD_ZERO_FEE_SETTLEMENT'
    | 'FORCED_FLAT_T_MINUS_90S'
    | 'TAKE_PROFIT_ATR_OR_FV_GAP'
    | 'TRAILING_LOCK_50PCT_GAIN'
    | 'STOP_LOSS_2X_15S_CONFIRMED'
    | 'STOP_LOSS_COMPOUNDER_INVERSION'
    | 'DEAD_TRADE_6M_TIME_STOP'
    | 'REGIME_FLIP_FLATTEN';
  updatedConsecutiveFvGapBreaches: number;
  updatedPeakGainUsd: number;
  trailingFloorGainUsd: number | null;
  zeroFeeSettlementHoldExempt?: boolean;
  compounderActive?: boolean;
  detail: string;
}

/**
 * Evaluates TASK-04 Champion Exit Rules + low_balance_kalshi_compounder rules on every 15s daemon pass:
 * - Take profit at max(0.16, 2.5 * atr14_usd) OR FV - bid <= 0.03
 * - Trailing lock at +1.2 * atr14_usd (protecting 50% gain)
 * - Stop-loss at -max(0.07, 0.9 * atr14_usd) ONLY after 2 consecutive 15s evals where FV - bid < -0.04
 *   (In low_balance_kalshi_compounder mode: triggers if FV - bid < -0.04 for 2 consecutive 15s checks OR unrealized loss <= -$0.06)
 * - 6-minute dead-trade time-stop if |PnL| < 0.3 * atr14_usd
 * - Forced flat at T - 90s (EXEMPT in compounder mode when 1 contract has FV >= 0.85 and ITM > 0.25*sigma*sqrt(tau) to ride to $1.00 $0-fee settlement)
 */
export function evaluateChampionExitSignal(
  input: ChampionExitEvalInput
): ChampionExitEvalResult {
  const exitCfg = CHAMPION_CONFIG.active_strategy.exit_rules;
  const compounderCfg = CHAMPION_CONFIG.low_balance_kalshi_compounder;
  const isCompounderActive =
    Boolean(compounderCfg?.enabled) &&
    (input.compounderMode === true ||
      (typeof input.settledCashUsd === 'number' &&
        Number.isFinite(input.settledCashUsd) &&
        input.settledCashUsd > 0 &&
        input.settledCashUsd < (compounderCfg?.max_settled_cash_usd ?? 150)));

  const pnlUsd = input.liveBidUsd - input.entryPriceUsd;
  const fvMinusBid = input.fairValueUsd - input.liveBidUsd;
  const updatedPeakGainUsd = Math.max(input.peakGainUsd, pnlUsd);

  const fvThreshold = isCompounderActive
    ? compounderCfg?.tight_2eval_inversion_stop.fv_minus_bid_threshold_usd ?? -0.04
    : exitCfg.stop_loss_fv_bid_gap_threshold_usd;
  const fvGapBreached = fvMinusBid < fvThreshold;
  const updatedConsecutiveFvGapBreaches = fvGapBreached
    ? input.consecutiveFvGapBreaches + 1
    : 0;

  if (input.regimeFlipPause) {
    return {
      shouldExit: true,
      reason: 'REGIME_FLIP_FLATTEN',
      updatedConsecutiveFvGapBreaches,
      updatedPeakGainUsd,
      trailingFloorGainUsd: null,
      compounderActive: isCompounderActive,
      detail: 'CHOP(14) > 61.8 regime-flip pause triggered; flattening via Pre-Exit Sweep.',
    };
  }

  // Compounder Tight 2-Eval Inversion Stop: (FV - bid < -0.04 for 2 consecutive 15s checks) OR (unrealized loss <= -$0.06)
  if (isCompounderActive && compounderCfg?.tight_2eval_inversion_stop.enabled) {
    const consecReq = compounderCfg.tight_2eval_inversion_stop.consecutive_15s_checks;
    const maxLossUsd = compounderCfg.tight_2eval_inversion_stop.max_unrealized_loss_usd;
    const inversionConfirmed = updatedConsecutiveFvGapBreaches >= consecReq;
    const lossFloorHit = pnlUsd <= maxLossUsd + 1e-9;
    if (inversionConfirmed || lossFloorHit) {
      return {
        shouldExit: true,
        reason: 'STOP_LOSS_COMPOUNDER_INVERSION',
        updatedConsecutiveFvGapBreaches,
        updatedPeakGainUsd,
        trailingFloorGainUsd: null,
        compounderActive: true,
        detail: `Compounder Tight Inversion Stop (${inversionConfirmed ? `${updatedConsecutiveFvGapBreaches}x15s FV-bid=${fvMinusBid.toFixed(3)} < ${fvThreshold}` : `unrealized PnL $${pnlUsd.toFixed(3)} <= $${maxLossUsd.toFixed(2)}`}); execute Rule 3 CancelAllOpenOrders & close 1 contract.`,
      };
    }
  }

  if (input.secondsToExpiry <= exitCfg.forced_flat_seconds_before_expiry) {
    if (isCompounderActive && compounderCfg?.zero_fee_settlement_hold_exemption.enabled) {
      const exemption = evaluateZeroFeeSettlementHoldExemption({
        contracts: input.contracts ?? 1,
        fairValueUsd: input.fairValueUsd,
        secondsToExpiry: input.secondsToExpiry,
        side: input.side,
        spotPriceUsd: input.spotPriceUsd,
        strikePriceUsd: input.strikePriceUsd,
        annualizedSigma: input.annualizedSigma,
      });
      if (exemption.exempt) {
        return {
          shouldExit: false,
          reason: 'HOLD_ZERO_FEE_SETTLEMENT',
          updatedConsecutiveFvGapBreaches,
          updatedPeakGainUsd,
          trailingFloorGainUsd: null,
          zeroFeeSettlementHoldExempt: true,
          compounderActive: true,
          detail: exemption.reason,
        };
      }
    }

    return {
      shouldExit: true,
      reason: 'FORCED_FLAT_T_MINUS_90S',
      updatedConsecutiveFvGapBreaches,
      updatedPeakGainUsd,
      trailingFloorGainUsd: null,
      zeroFeeSettlementHoldExempt: false,
      compounderActive: isCompounderActive,
      detail: `Forced flat at T-${input.secondsToExpiry.toFixed(0)}s <= ${exitCfg.forced_flat_seconds_before_expiry}s.`,
    };
  }

  const tpTargetUsd = Math.max(
    exitCfg.take_profit_floor_usd,
    exitCfg.take_profit_atr_mult * input.atr14Usd
  );
  const fvConvergenceTp =
    pnlUsd > 0 &&
    fvMinusBid >= 0 &&
    fvMinusBid <= exitCfg.take_profit_fv_bid_gap_max_usd;
  if (pnlUsd >= tpTargetUsd || fvConvergenceTp) {
    return {
      shouldExit: true,
      reason: 'TAKE_PROFIT_ATR_OR_FV_GAP',
      updatedConsecutiveFvGapBreaches,
      updatedPeakGainUsd,
      trailingFloorGainUsd: null,
      compounderActive: isCompounderActive,
      detail: `Take-profit hit: PnL $${pnlUsd.toFixed(3)} (target $${tpTargetUsd.toFixed(3)}) or FV-bid $${fvMinusBid.toFixed(3)} <= $${exitCfg.take_profit_fv_bid_gap_max_usd.toFixed(2)}.`,
    };
  }

  const trailingActivateUsd = exitCfg.trailing_lock_atr_mult * input.atr14Usd;
  let trailingFloorGainUsd: number | null = null;
  if (updatedPeakGainUsd >= trailingActivateUsd) {
    trailingFloorGainUsd = Number(
      (updatedPeakGainUsd * (exitCfg.trailing_lock_gain_protect_pct / 100)).toFixed(4)
    );
    if (pnlUsd <= trailingFloorGainUsd) {
      return {
        shouldExit: true,
        reason: 'TRAILING_LOCK_50PCT_GAIN',
        updatedConsecutiveFvGapBreaches,
        updatedPeakGainUsd,
        trailingFloorGainUsd,
        compounderActive: isCompounderActive,
        detail: `Trailing lock triggered: peak gain $${updatedPeakGainUsd.toFixed(3)} >= +${trailingActivateUsd.toFixed(3)}; PnL $${pnlUsd.toFixed(3)} <= 50% protected floor $${trailingFloorGainUsd.toFixed(3)}.`,
      };
    }
  }

  const stopLossDistanceUsd = Math.max(
    exitCfg.stop_loss_floor_usd,
    exitCfg.stop_loss_atr_mult * input.atr14Usd
  );
  if (
    pnlUsd <= -stopLossDistanceUsd &&
    updatedConsecutiveFvGapBreaches >= exitCfg.stop_loss_consecutive_15s_confirmations
  ) {
    return {
      shouldExit: true,
      reason: 'STOP_LOSS_2X_15S_CONFIRMED',
      updatedConsecutiveFvGapBreaches,
      updatedPeakGainUsd,
      trailingFloorGainUsd,
      compounderActive: isCompounderActive,
      detail: `Stop-loss -$${stopLossDistanceUsd.toFixed(3)} confirmed after ${updatedConsecutiveFvGapBreaches} consecutive 15s evals with FV-bid ${fvMinusBid.toFixed(3)} < ${exitCfg.stop_loss_fv_bid_gap_threshold_usd}.`,
    };
  }

  if (
    input.elapsedMinutes >= exitCfg.dead_trade_time_stop_minutes &&
    Math.abs(pnlUsd) < exitCfg.dead_trade_min_pnl_atr_mult * input.atr14Usd
  ) {
    return {
      shouldExit: true,
      reason: 'DEAD_TRADE_6M_TIME_STOP',
      updatedConsecutiveFvGapBreaches,
      updatedPeakGainUsd,
      trailingFloorGainUsd,
      compounderActive: isCompounderActive,
      detail: `6-minute dead-trade time-stop (${input.elapsedMinutes.toFixed(1)}m >= ${exitCfg.dead_trade_time_stop_minutes}m) with |PnL| $${Math.abs(pnlUsd).toFixed(3)} < ${(exitCfg.dead_trade_min_pnl_atr_mult * input.atr14Usd).toFixed(3)}.`,
    };
  }

  return {
    shouldExit: false,
    reason: 'HOLD',
    updatedConsecutiveFvGapBreaches,
    updatedPeakGainUsd,
    trailingFloorGainUsd,
    compounderActive: isCompounderActive,
    detail: `Hold: PnL $${pnlUsd.toFixed(3)}, FV-bid $${fvMinusBid.toFixed(3)}, consecutiveBreaches=${updatedConsecutiveFvGapBreaches}.`,
  };
}
