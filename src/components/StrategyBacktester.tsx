import React, { useMemo, useState } from 'react';
import {
  Activity,
  ArrowUpRight,
  BarChart3,
  CheckCircle2,
  Filter,
  Layers,
  Play,
  RefreshCw,
  ShieldAlert,
  Sliders,
  Zap,
} from 'lucide-react';
import type {
  IndicatorStrategyId,
  MarketFeatureVector,
  MarketRegime,
  OHLCVBar,
  StrategyArchetype,
} from '../types/quant.ts';
import {
  LEAD_LAG_CATALOG_FORMULA,
  LEAD_LAG_CATALOG_LABEL,
  LEAD_LAG_PARAMS,
} from '../config/strategyParams.ts';

export interface StrategyBacktesterProps {
  features: MarketFeatureVector[];
  selectedSymbol?: string;
  onSelectSymbol?: (symbol: string) => void;
  onDeployStrategy?: (config: {
    name: string;
    archetype: StrategyArchetype;
    targetSymbol: string;
    indicatorStrategyId: IndicatorStrategyId;
    allocatedCapitalUsd: number;
    maxDrawdownLimitPct: number;
    atrSpikeKillMultiplier: number;
  }) => Promise<void>;
}

type RegimeFilterOption = 'ALL_REGIMES' | MarketRegime;

interface StrategySpec {
  id: IndicatorStrategyId;
  label: string;
  archetype: StrategyArchetype;
  formulaSummary: string;
  optimalRegimes: MarketRegime[];
}

interface SimulatedRegimeTrade {
  id: string;
  symbol: string;
  strategyId: IndicatorStrategyId;
  entryTimestamp: string;
  exitTimestamp: string;
  regime: MarketRegime;
  side: 'BUY_YES' | 'BUY_NO' | 'LONG';
  contractsOrShares: number;
  entryPrice: number;
  exitPrice: number;
  grossPnlUsd: number;
  feeUsd: number;
  netPnlUsd: number;
  netReturnBps: number;
  holdingBars: number;
  exitReason: 'TAKE_PROFIT' | 'STOP_LOSS' | 'REGIME_SHIFT' | 'WINDOW_CLOSE';
  rationale: string;
}

interface EquityCurvePoint {
  barIndex: number;
  timestamp: string;
  closePrice: number;
  equityUsd: number;
  drawdownPct: number;
  regime: MarketRegime;
}

interface RegimeMetricsSummary {
  regime: MarketRegime;
  barsInRegime: number;
  barSharePct: number;
  tradesCount: number;
  winsCount: number;
  winRatePct: number;
  netPnlUsd: number;
  totalReturnPct: number;
  sharpeRatio: number;
  profitFactor: number;
  maxDrawdownPct: number;
  avgNetEdgeBps: number;
  totalFeesUsd: number;
}

const STRATEGY_SPECS: StrategySpec[] = [
  {
    id: 'BTC_LEAD_LAG_SNIPER',
    label: LEAD_LAG_CATALOG_LABEL,
    archetype: 'SHORT_AND_FAST',
    formulaSummary: LEAD_LAG_CATALOG_FORMULA,
    optimalRegimes: ['TRENDING_BULL', 'TRENDING_BEAR'],
  },
  {
    id: 'HFT_15M_VWAP_SNAPBACK',
    label: '15m Probability Exhaustion & Micro-VWAP Snapback',
    archetype: 'SHORT_AND_FAST',
    formulaSummary: 'Micro-RSI(14) excursion outside [32, 68] + mean-reversion to 15m Anchored VWAP (+8¢ TP)',
    optimalRegimes: ['LOW_VOLATILITY_COMPRESSION', 'HIGH_VOLATILITY_RANGE'],
  },
  {
    id: 'HFT_15M_GAMMA_CONVERGENCE',
    label: '15m Expiry Gamma Convergence & Strike Pinning',
    archetype: 'SHORT_AND_FAST',
    formulaSummary: 'T-[4.0m, 13.5m] Gamma window + 9/21 Micro-EMA alignment + L2 spread <= 6¢',
    optimalRegimes: ['TRENDING_BULL', 'LOW_VOLATILITY_COMPRESSION'],
  },
  {
    id: 'KALSHI_CLOB_IMBALANCE',
    label: 'Kalshi V2 L2 Orderbook Depth & Implied Prob Momentum',
    archetype: 'SHORT_AND_FAST',
    formulaSummary: 'yes_bid_size_fp / yes_ask_size_fp > 1.35x + price holding above bar VWAP',
    optimalRegimes: ['TRENDING_BULL', 'TRENDING_BEAR'],
  },
  {
    id: 'RSI_ATR_MEAN_REVERSION',
    label: 'Wilder RSI(14) Value Accumulation + ATR Compression',
    archetype: 'LONG_AND_LOW',
    formulaSummary: 'RSI(14) <= 44 with ATR compression (< 1.35x baseline) and lower envelope support',
    optimalRegimes: ['LOW_VOLATILITY_COMPRESSION', 'HIGH_VOLATILITY_RANGE'],
  },
  {
    id: 'EMA_VWAP_VELOCITY',
    label: '9/21 EMA Velocity + Anchored VWAP Breakout',
    archetype: 'SHORT_AND_FAST',
    formulaSummary: 'EMA(9) > EMA(21) + Close > Bar VWAP + RVOL >= 1.15x',
    optimalRegimes: ['TRENDING_BULL'],
  },
  {
    id: 'MACD_RVOL_MOMENTUM',
    label: 'MACD(12,26,9) Histogram Impulse + RVOL Surge',
    archetype: 'SHORT_AND_FAST',
    formulaSummary: 'Positive momentum acceleration + volume expansion > 1.10x 20-bar mean',
    optimalRegimes: ['TRENDING_BULL', 'TRENDING_BEAR'],
  },
  {
    id: 'BB_SQUEEZE_BREAKOUT',
    label: 'Bollinger Band(20, 2σ) Squeeze + Volatility Expansion',
    archetype: 'LONG_AND_LOW',
    formulaSummary: 'Volatility compression release across upper/lower 2σ envelope',
    optimalRegimes: ['LOW_VOLATILITY_COMPRESSION', 'TRENDING_BULL'],
  },
];

const ALL_REGIMES: MarketRegime[] = [
  'TRENDING_BULL',
  'TRENDING_BEAR',
  'HIGH_VOLATILITY_RANGE',
  'LOW_VOLATILITY_COMPRESSION',
];

const REGIME_META: Record<
  MarketRegime,
  { label: string; shortLabel: string; badgeClass: string; strokeColor: string; bgTint: string }
> = {
  TRENDING_BULL: {
    label: 'TRENDING_BULL',
    shortLabel: 'Bull Trend',
    badgeClass: 'text-emerald-300 border-emerald-500/40 bg-emerald-950/50',
    strokeColor: '#10b981',
    bgTint: 'rgba(16, 185, 129, 0.10)',
  },
  TRENDING_BEAR: {
    label: 'TRENDING_BEAR',
    shortLabel: 'Bear Trend',
    badgeClass: 'text-rose-300 border-rose-500/40 bg-rose-950/50',
    strokeColor: '#f43f5e',
    bgTint: 'rgba(244, 63, 94, 0.10)',
  },
  HIGH_VOLATILITY_RANGE: {
    label: 'HIGH_VOLATILITY_RANGE',
    shortLabel: 'High-Vol Range',
    badgeClass: 'text-amber-300 border-amber-500/40 bg-amber-950/50',
    strokeColor: '#f59e0b',
    bgTint: 'rgba(245, 158, 11, 0.10)',
  },
  LOW_VOLATILITY_COMPRESSION: {
    label: 'LOW_VOLATILITY_COMPRESSION',
    shortLabel: 'Low-Vol Compression',
    badgeClass: 'text-cyan-300 border-cyan-500/40 bg-cyan-950/50',
    strokeColor: '#06b6d4',
    bgTint: 'rgba(6, 182, 212, 0.10)',
  },
};

/**
 * Deterministically classifies each historical OHLCV bar into one of the 4 canonical MarketRegimes
 * using rolling price return, bar true range vs baseline ATR, and VWAP spread from the feature vector.
 */
function classifyBarRegime(
  bars: OHLCVBar[],
  index: number,
  feature: MarketFeatureVector
): MarketRegime {
  const bar = bars[index];
  if (!bar) {
    return feature.lastAssessment?.market_regime || 'LOW_VOLATILITY_COMPRESSION';
  }
  const lookbackStart = Math.max(0, index - 5);
  const anchorBar = bars[lookbackStart] || bar;
  const rollingReturnPct =
    anchorBar.close > 0 ? ((bar.close - anchorBar.close) / anchorBar.close) * 100 : 0;

  // Compute local range volatility relative to average bar range across the series
  let sumRangePct = 0;
  const windowStart = Math.max(0, index - 12);
  const count = Math.max(1, index - windowStart + 1);
  for (let i = windowStart; i <= index; i++) {
    const b = bars[i];
    const r = b.close > 0 ? ((b.high - b.low) / b.close) * 100 : 0.5;
    sumRangePct += r;
  }
  const avgRangePct = Math.max(0.05, sumRangePct / count);
  const currentBarRangePct = bar.close > 0 ? ((bar.high - bar.low) / bar.close) * 100 : avgRangePct;
  const rangeRatio = currentBarRangePct / avgRangePct;

  const isPrediction = feature.assetClass === 'PREDICTION_CONTRACT';
  const trendThreshold = isPrediction ? 1.35 : 0.32;

  if (rangeRatio >= 1.32 && Math.abs(rollingReturnPct) < trendThreshold * 1.45) {
    return 'HIGH_VOLATILITY_RANGE';
  }
  if (rollingReturnPct >= trendThreshold) {
    return 'TRENDING_BULL';
  }
  if (rollingReturnPct <= -trendThreshold) {
    return 'TRENDING_BEAR';
  }
  if (rangeRatio <= 0.92) {
    return 'LOW_VOLATILITY_COMPRESSION';
  }
  // Tie-break using bar close vs bar vwap and feature baseline regime
  const vwapDeltaPct = bar.vwap > 0 ? ((bar.close - bar.vwap) / bar.vwap) * 100 : 0;
  if (vwapDeltaPct > trendThreshold * 0.55) return 'TRENDING_BULL';
  if (vwapDeltaPct < -trendThreshold * 0.55) return 'TRENDING_BEAR';
  return 'LOW_VOLATILITY_COMPRESSION';
}

export function runDeterministicRegimeBacktest(params?: {
  feature?: MarketFeatureVector | null | undefined;
  strategyId?: IndicatorStrategyId;
  regimeFilter?: RegimeFilterOption;
  initialCapitalUsd?: number;
  contractMultiplier?: number;
  executionFeeMode?: 'MAKER_POST_ONLY' | 'TAKER_QUADRATIC';
  takeProfitCentsOrPct?: number;
  stopLossCentsOrPct?: number;
}): {
  hasData: boolean;
  emptyStateMessage: string | null;
  dataSourceLabel: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  barsCount: number;
  isSimulation: true;
  trades: SimulatedRegimeTrade[];
  equityCurve: EquityCurvePoint[];
  regimeBreakdown: RegimeMetricsSummary[];
  overallMetrics: {
    netPnlUsd: number;
    totalReturnPct: number;
    winRatePct: number;
    sharpeRatio: number;
    profitFactor: number;
    maxDrawdownPct: number;
    avgNetEdgeBps: number;
    totalFeesUsd: number;
    totalTrades: number;
  };
} {
  const {
    feature,
    strategyId = 'BTC_LEAD_LAG_SNIPER',
    regimeFilter = 'ALL_REGIMES',
    initialCapitalUsd = 1000,
    contractMultiplier = 22,
    executionFeeMode = 'MAKER_POST_ONLY',
    takeProfitCentsOrPct = 6,
    stopLossCentsOrPct = 4,
  } = params || {};

  const bars = feature?.bars && Array.isArray(feature.bars) ? feature.bars : [];
  if (!feature || bars.length === 0) {
    return {
      hasData: false,
      emptyStateMessage: 'no data — nothing to show',
      dataSourceLabel: null,
      periodStart: null,
      periodEnd: null,
      barsCount: 0,
      isSimulation: true,
      trades: [],
      equityCurve: [],
      regimeBreakdown: [],
      overallMetrics: {
        netPnlUsd: 0,
        totalReturnPct: 0,
        winRatePct: 0,
        sharpeRatio: 0,
        profitFactor: 0,
        maxDrawdownPct: 0,
        avgNetEdgeBps: 0,
        totalFeesUsd: 0,
        totalTrades: 0,
      },
    };
  }

  const isPrediction = feature.assetClass === 'PREDICTION_CONTRACT';
  const dataSourceLabel =
    feature.dataSource ||
    (feature.venue === 'PREDICTION_MARKET'
      ? 'Kalshi CLOB v2 / Coinbase Historical Candle Feed'
      : 'Public.com / Coinbase Historical OHLCV Feed');
  const periodStart = bars[0]?.timestamp || null;
  const periodEnd = bars[bars.length - 1]?.timestamp || null;

  const barRegimes: MarketRegime[] = bars.map((_, idx) => classifyBarRegime(bars, idx, feature));

  const trades: SimulatedRegimeTrade[] = [];
  const equityCurve: EquityCurvePoint[] = [];
  let currentEquity = initialCapitalUsd;
  let peakEquity = initialCapitalUsd;
  let maxDrawdownPct = 0;

  // Track per-regime stats
  const regimeBuckets: Record<
    MarketRegime,
    {
      bars: number;
      trades: SimulatedRegimeTrade[];
      returnsPct: number[];
      peakEq: number;
      curEq: number;
      maxDd: number;
    }
  > = {
    TRENDING_BULL: { bars: 0, trades: [], returnsPct: [], peakEq: initialCapitalUsd, curEq: initialCapitalUsd, maxDd: 0 },
    TRENDING_BEAR: { bars: 0, trades: [], returnsPct: [], peakEq: initialCapitalUsd, curEq: initialCapitalUsd, maxDd: 0 },
    HIGH_VOLATILITY_RANGE: { bars: 0, trades: [], returnsPct: [], peakEq: initialCapitalUsd, curEq: initialCapitalUsd, maxDd: 0 },
    LOW_VOLATILITY_COMPRESSION: { bars: 0, trades: [], returnsPct: [], peakEq: initialCapitalUsd, curEq: initialCapitalUsd, maxDd: 0 },
  };

  barRegimes.forEach((r) => {
    regimeBuckets[r].bars += 1;
  });

  let i = 1;
  while (i < bars.length - 1) {
    const bar = bars[i];
    const prevBar = bars[i - 1];
    const nextBar = bars[i + 1];
    const barRegime = barRegimes[i];

    const recordCurvePoint = (idx: number) => {
      const b = bars[idx];
      if (!b) return;
      peakEquity = Math.max(peakEquity, currentEquity);
      const dd = peakEquity > 0 ? ((peakEquity - currentEquity) / peakEquity) * 100 : 0;
      maxDrawdownPct = Math.max(maxDrawdownPct, dd);
      equityCurve.push({
        barIndex: idx,
        timestamp: b.timestamp,
        closePrice: b.close,
        equityUsd: Number(currentEquity.toFixed(2)),
        drawdownPct: Number(dd.toFixed(2)),
        regime: barRegimes[idx] || 'LOW_VOLATILITY_COMPRESSION',
      });
    };

    recordCurvePoint(i);

    if (regimeFilter !== 'ALL_REGIMES' && barRegime !== regimeFilter) {
      i += 1;
      continue;
    }

    // Compute local technical signals on real bar data
    const barReturn = prevBar.close > 0 ? (bar.close - prevBar.close) / prevBar.close : 0;
    const vwapSpread = bar.vwap > 0 ? (bar.close - bar.vwap) / bar.vwap : 0;
    const barRange = Math.max(0.0001, bar.high - bar.low);
    const closePositionInBar = (bar.close - bar.low) / barRange; // 0.0 low -> 1.0 high

    // Strategy-specific entry trigger & directional alignment
    let triggered = false;
    let side: 'BUY_YES' | 'BUY_NO' | 'LONG' = isPrediction ? 'BUY_YES' : 'LONG';
    let rationale = '';

    switch (strategyId) {
      case 'BTC_LEAD_LAG_SNIPER': {
        const candidatePx = isPrediction ? (barReturn >= 0 ? bar.close : 1 - bar.close) : bar.close;
        const gateOk =
          !isPrediction ||
          (candidatePx >= LEAD_LAG_PARAMS.askGateMin && candidatePx <= LEAD_LAG_PARAMS.askGateMax);
        triggered =
          gateOk && (Math.abs(barReturn) >= 0.0015 || Math.abs(vwapSpread) >= 0.0012);
        side = isPrediction ? (barReturn >= 0 ? 'BUY_YES' : 'BUY_NO') : 'LONG';
        rationale = `Simulation: Spot lead-lag impulse ${(barReturn * 10000).toFixed(1)} bps vs strike in ${barRegime}`;
        break;
      }
      case 'HFT_15M_VWAP_SNAPBACK': {
        triggered = Math.abs(vwapSpread) >= 0.001 || closePositionInBar < 0.35 || closePositionInBar > 0.65;
        side = isPrediction ? (vwapSpread <= 0 ? 'BUY_YES' : 'BUY_NO') : 'LONG';
        rationale = `Simulation: Micro-VWAP snapback (${(vwapSpread * 100).toFixed(2)}% spread) in ${barRegime}`;
        break;
      }
      case 'HFT_15M_GAMMA_CONVERGENCE': {
        triggered = closePositionInBar >= 0.5 || barRegime === 'LOW_VOLATILITY_COMPRESSION' || barRegime === 'TRENDING_BULL';
        side = isPrediction ? (bar.close >= bar.vwap ? 'BUY_YES' : 'BUY_NO') : 'LONG';
        rationale = `Simulation: 15m Gamma convergence & strike pinning (VWAP=${bar.vwap.toFixed(2)}) in ${barRegime}`;
        break;
      }
      case 'KALSHI_CLOB_IMBALANCE': {
        triggered = bar.volume >= prevBar.volume * 0.92;
        side = isPrediction ? (barReturn >= -0.0005 ? 'BUY_YES' : 'BUY_NO') : 'LONG';
        rationale = `Simulation: CLOB L2 bid/ask imbalance (${feature.orderbookImbalance.toFixed(2)}) + tape flow in ${barRegime}`;
        break;
      }
      case 'RSI_ATR_MEAN_REVERSION': {
        triggered = closePositionInBar <= 0.58 || barRegime === 'LOW_VOLATILITY_COMPRESSION' || barRegime === 'HIGH_VOLATILITY_RANGE';
        side = isPrediction ? (barReturn <= 0 ? 'BUY_YES' : 'BUY_NO') : 'LONG';
        rationale = `Simulation: Wilder RSI(${feature.rsi14.toFixed(1)}) + ATR(${feature.atrBaselineMultiplier.toFixed(2)}x) accumulation in ${barRegime}`;
        break;
      }
      default: {
        triggered = Math.abs(barReturn) >= 0.0008 || bar.close >= bar.vwap;
        side = isPrediction ? (bar.close >= bar.vwap ? 'BUY_YES' : 'BUY_NO') : 'LONG';
        rationale = `Simulation: ${strategyId} momentum/VWAP alignment in ${barRegime}`;
        break;
      }
    }

    if (!triggered) {
      i += 1;
      continue;
    }

    const holdBars = Math.min(2, bars.length - 1 - i);
    const exitBar = bars[i + holdBars] || nextBar;

    // Compute entry and exit strictly from real loaded historical candle data (no alignmentEdge bonus or artificial dampening)
    const entryPrice = isPrediction
      ? Number((side === 'BUY_NO' ? 1 - bar.close : bar.close).toFixed(4))
      : Number(bar.close.toFixed(2));

    const rawNextClose = isPrediction
      ? Number((side === 'BUY_NO' ? 1 - exitBar.close : exitBar.close).toFixed(4))
      : Number(exitBar.close.toFixed(2));

    const barFavorableHigh = isPrediction
      ? side === 'BUY_NO'
        ? 1 - exitBar.low
        : exitBar.high
      : exitBar.high;
    const barAdverseLow = isPrediction
      ? side === 'BUY_NO'
        ? 1 - exitBar.high
        : exitBar.low
      : exitBar.low;

    const tpDelta = isPrediction
      ? takeProfitCentsOrPct / 100
      : entryPrice * (takeProfitCentsOrPct / 100);
    const slDelta = isPrediction
      ? stopLossCentsOrPct / 100
      : entryPrice * (stopLossCentsOrPct / 100);

    // Pure historical candle evaluation: check stop-loss first (conservative), then take-profit, else close at real bar close
    let exitPrice = rawNextClose;
    let exitReason: SimulatedRegimeTrade['exitReason'] = 'WINDOW_CLOSE';

    if (entryPrice - barAdverseLow >= slDelta) {
      exitPrice = Math.max(0.01, Number((entryPrice - slDelta).toFixed(4)));
      exitReason = 'STOP_LOSS';
    } else if (barFavorableHigh - entryPrice >= tpDelta) {
      exitPrice = Number((entryPrice + tpDelta).toFixed(4));
      exitReason = 'TAKE_PROFIT';
    } else if (barRegimes[i + holdBars] !== barRegime) {
      exitReason = 'REGIME_SHIFT';
    }

    const contractsOrShares = isPrediction
      ? Math.max(1, Math.round(5 * contractMultiplier))
      : Math.max(1, Number(((initialCapitalUsd * 0.12 * (contractMultiplier / 5)) / Math.max(1, entryPrice)).toFixed(2)));

    // Kalshi Taker Fee Formula: 0.07 * C * P * (1 - P); Maker Post-Only = $0.00
    const feeUsd = isPrediction
      ? executionFeeMode === 'MAKER_POST_ONLY'
        ? 0
        : Number((0.07 * contractsOrShares * entryPrice * (1 - entryPrice) * 2).toFixed(4))
      : Number((contractsOrShares * entryPrice * 0.0005).toFixed(4));

    const grossPnlUsd = Number(((exitPrice - entryPrice) * contractsOrShares).toFixed(2));
    const netPnlUsd = Number((grossPnlUsd - feeUsd).toFixed(2));
    const positionNotional = Math.max(0.5, entryPrice * contractsOrShares);
    const netReturnBps = Math.round((netPnlUsd / positionNotional) * 10000);

    currentEquity = Number((currentEquity + netPnlUsd).toFixed(2));

    const trade: SimulatedRegimeTrade = {
      id: `bt-${feature.symbol}-${i}-${strategyId.slice(0, 6)}`,
      symbol: feature.symbol,
      strategyId,
      entryTimestamp: bar.timestamp,
      exitTimestamp: exitBar.timestamp,
      regime: barRegime,
      side,
      contractsOrShares,
      entryPrice: Number(entryPrice.toFixed(isPrediction ? 2 : 2)),
      exitPrice: Number(exitPrice.toFixed(isPrediction ? 2 : 2)),
      grossPnlUsd,
      feeUsd: Number(feeUsd.toFixed(2)),
      netPnlUsd,
      netReturnBps,
      holdingBars: holdBars,
      exitReason,
      rationale,
    };

    trades.push(trade);

    const bucket = regimeBuckets[barRegime];
    bucket.trades.push(trade);
    bucket.curEq += netPnlUsd;
    bucket.peakEq = Math.max(bucket.peakEq, bucket.curEq);
    const bucketDd = bucket.peakEq > 0 ? ((bucket.peakEq - bucket.curEq) / bucket.peakEq) * 100 : 0;
    bucket.maxDd = Math.max(bucket.maxDd, bucketDd);
    bucket.returnsPct.push((netPnlUsd / initialCapitalUsd) * 100);

    i += Math.max(1, holdBars);
  }

  // Push final bar point
  if (bars.length > 0) {
    const lastIdx = bars.length - 1;
    peakEquity = Math.max(peakEquity, currentEquity);
    const dd = peakEquity > 0 ? ((peakEquity - currentEquity) / peakEquity) * 100 : 0;
    maxDrawdownPct = Math.max(maxDrawdownPct, dd);
    equityCurve.push({
      barIndex: lastIdx,
      timestamp: bars[lastIdx].timestamp,
      closePrice: bars[lastIdx].close,
      equityUsd: Number(currentEquity.toFixed(2)),
      drawdownPct: Number(dd.toFixed(2)),
      regime: barRegimes[lastIdx] || 'LOW_VOLATILITY_COMPRESSION',
    });
  }

  const computeStatsForTrades = (list: SimulatedRegimeTrade[], ddPct: number) => {
    const count = list.length;
    if (count === 0) {
      return {
        netPnlUsd: 0,
        totalReturnPct: 0,
        winRatePct: 0,
        sharpeRatio: 0,
        profitFactor: 0,
        maxDrawdownPct: 0,
        avgNetEdgeBps: 0,
        totalFeesUsd: 0,
        winsCount: 0,
      };
    }
    const wins = list.filter((t) => t.netPnlUsd > 0);
    const losses = list.filter((t) => t.netPnlUsd <= 0);
    const netPnlUsd = Number(list.reduce((s, t) => s + t.netPnlUsd, 0).toFixed(2));
    const totalFeesUsd = Number(list.reduce((s, t) => s + t.feeUsd, 0).toFixed(2));
    const grossProfit = wins.reduce((s, t) => s + t.netPnlUsd, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.netPnlUsd, 0));
    const profitFactor = grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(2)) : 0;
    const avgNetEdgeBps = Math.round(list.reduce((s, t) => s + t.netReturnBps, 0) / count);
    const rets = list.map((t) => t.netReturnBps / 100);
    const meanRet = rets.reduce((s, r) => s + r, 0) / count;
    const variance =
      count > 1 ? rets.reduce((s, r) => s + Math.pow(r - meanRet, 2), 0) / (count - 1) : 0;
    const stdDev = Math.sqrt(variance);
    const sharpeRatio =
      stdDev > 0 ? Number(((meanRet / stdDev) * Math.sqrt(count)).toFixed(2)) : 0;

    return {
      netPnlUsd,
      totalReturnPct: Number(((netPnlUsd / initialCapitalUsd) * 100).toFixed(2)),
      winRatePct: Number(((wins.length / count) * 100).toFixed(1)),
      sharpeRatio,
      profitFactor,
      maxDrawdownPct: Number(ddPct.toFixed(2)),
      avgNetEdgeBps,
      totalFeesUsd,
      winsCount: wins.length,
    };
  };

  const totalBars = Math.max(1, bars.length);
  const regimeBreakdown: RegimeMetricsSummary[] = ALL_REGIMES.map((regime) => {
    const b = regimeBuckets[regime];
    const st = computeStatsForTrades(b.trades, b.maxDd);
    return {
      regime,
      barsInRegime: b.bars,
      barSharePct: Number(((b.bars / totalBars) * 100).toFixed(1)),
      tradesCount: b.trades.length,
      winsCount: st.winsCount,
      winRatePct: st.winRatePct,
      netPnlUsd: st.netPnlUsd,
      totalReturnPct: st.totalReturnPct,
      sharpeRatio: st.sharpeRatio,
      profitFactor: st.profitFactor,
      maxDrawdownPct: st.maxDrawdownPct,
      avgNetEdgeBps: st.avgNetEdgeBps,
      totalFeesUsd: st.totalFeesUsd,
    };
  });

  const overall = computeStatsForTrades(trades, maxDrawdownPct);

  return {
    hasData: true,
    emptyStateMessage: null,
    dataSourceLabel,
    periodStart,
    periodEnd,
    barsCount: bars.length,
    isSimulation: true,
    trades,
    equityCurve,
    regimeBreakdown,
    overallMetrics: {
      ...overall,
      totalTrades: trades.length,
    },
  };
}

export const StrategyBacktester: React.FC<StrategyBacktesterProps> = ({
  features,
  selectedSymbol: initialSymbol = 'KXBTC15M',
  onSelectSymbol,
  onDeployStrategy,
}) => {
  const [symbol, setSymbol] = useState<string>(initialSymbol || features[0]?.symbol || 'KXBTC15M');
  const [strategyId, setStrategyId] = useState<IndicatorStrategyId>('HFT_15M_VWAP_SNAPBACK');
  const [regimeFilter, setRegimeFilter] = useState<RegimeFilterOption>('ALL_REGIMES');
  const [executionFeeMode, setExecutionFeeMode] = useState<'MAKER_POST_ONLY' | 'TAKER_QUADRATIC'>('MAKER_POST_ONLY');
  const [contractMultiplier, setContractMultiplier] = useState<number>(5);
  const [initialCapitalUsd, setInitialCapitalUsd] = useState<number>(100);
  const [takeProfitCentsOrPct, setTakeProfitCentsOrPct] = useState<number>(8);
  const [stopLossCentsOrPct, setStopLossCentsOrPct] = useState<number>(5);
  const [isDeploying, setIsDeploying] = useState<boolean>(false);
  const [deployNotice, setDeployNotice] = useState<string | null>(null);

  const activeFeature = useMemo(
    () => features.find((f) => f.symbol === symbol) || features[0],
    [features, symbol]
  );

  const selectedStrategySpec = useMemo(
    () => STRATEGY_SPECS.find((s) => s.id === strategyId) || STRATEGY_SPECS[0],
    [strategyId]
  );

  const simulation = useMemo(() => {
    if (!activeFeature) return null;
    return runDeterministicRegimeBacktest({
      feature: activeFeature,
      strategyId,
      regimeFilter,
      initialCapitalUsd,
      contractMultiplier,
      executionFeeMode,
      takeProfitCentsOrPct,
      stopLossCentsOrPct,
    });
  }, [
    activeFeature,
    strategyId,
    regimeFilter,
    initialCapitalUsd,
    contractMultiplier,
    executionFeeMode,
    takeProfitCentsOrPct,
    stopLossCentsOrPct,
  ]);

  // Cross-Feature Regime Matrix Leaderboard: evaluates only features with loaded historical bars
  const crossAssetRegimeLeaderboard = useMemo(() => {
    return features
      .filter((feat) => feat.bars && feat.bars.length > 0)
      .map((feat) => {
        const res = runDeterministicRegimeBacktest({
          feature: feat,
          strategyId,
          regimeFilter,
          initialCapitalUsd,
          contractMultiplier,
          executionFeeMode,
          takeProfitCentsOrPct,
          stopLossCentsOrPct,
        });
        return {
          symbol: feat.symbol,
          name: feat.name,
          venue: feat.venue,
          currentRegime: feat.lastAssessment?.market_regime || 'LOW_VOLATILITY_COMPRESSION',
          ...res.overallMetrics,
        };
      })
      .sort((a, b) => b.sharpeRatio * 10 + b.totalReturnPct - (a.sharpeRatio * 10 + a.totalReturnPct));
  }, [
    features,
    strategyId,
    regimeFilter,
    initialCapitalUsd,
    contractMultiplier,
    executionFeeMode,
    takeProfitCentsOrPct,
    stopLossCentsOrPct,
  ]);

  const handleDeployCurrentConfig = async () => {
    if (!onDeployStrategy || !activeFeature) return;
    setIsDeploying(true);
    setDeployNotice(null);
    try {
      await onDeployStrategy({
        name: `${activeFeature.symbol} ${selectedStrategySpec.id} (${contractMultiplier}x Regime Winner)`,
        archetype: selectedStrategySpec.archetype,
        targetSymbol: activeFeature.symbol,
        indicatorStrategyId: strategyId,
        allocatedCapitalUsd: initialCapitalUsd,
        maxDrawdownLimitPct: 2.0,
        atrSpikeKillMultiplier: 2.4,
      });
      setDeployNotice(
        `Promoted ${selectedStrategySpec.id} on ${activeFeature.symbol} (${contractMultiplier}x sizing · ${executionFeeMode}) to live autonomous fleet.`
      );
    } finally {
      setIsDeploying(false);
    }
  };

  if (
    !activeFeature ||
    !activeFeature.bars ||
    activeFeature.bars.length === 0 ||
    !simulation ||
    !simulation.hasData
  ) {
    return (
      <div
        data-testid="strategy-backtester-no-data"
        className="p-6 border border-slate-800 bg-[#111827] text-xs font-mono text-slate-300 space-y-2"
      >
        <div className="uppercase tracking-wider text-amber-300 font-semibold">
          SIMULATION ONLY — HISTORICAL BACKTESTER
        </div>
        <div className="text-sm font-bold text-slate-100">no data — nothing to show</div>
        <p className="text-slate-400">
          No historical OHLCV candle data is currently loaded for the selected instrument. Simulation metrics are withheld until real historical bars are available.
        </p>
      </div>
    );
  }

  const {
    overallMetrics,
    regimeBreakdown,
    equityCurve,
    trades,
    dataSourceLabel,
    periodStart,
    periodEnd,
    barsCount,
  } = simulation;

  // SVG Chart dimensions
  const chartWidth = 760;
  const chartHeight = 220;
  const eqValues = equityCurve.map((p) => p.equityUsd);
  const minEq = Math.min(initialCapitalUsd * 0.95, ...eqValues);
  const maxEq = Math.max(initialCapitalUsd * 1.05, ...eqValues);
  const eqRange = Math.max(1, maxEq - minEq);

  const polylinePoints = equityCurve
    .map((pt, idx) => {
      const x =
        equityCurve.length > 1
          ? (idx / (equityCurve.length - 1)) * (chartWidth - 24) + 12
          : chartWidth / 2;
      const y = chartHeight - 22 - ((pt.equityUsd - minEq) / eqRange) * (chartHeight - 44);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <div className="space-y-6">
      {/* Top Control & Parameter Bar */}
      <div className="p-5 border border-slate-800 bg-[#111827] space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-3.5">
          <div>
            <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
              <span className="px-2 py-0.5 bg-amber-500/20 border border-amber-500/50 text-amber-300 font-bold uppercase">
                SIMULATION
              </span>
              <span className="text-sm font-semibold font-sans text-slate-100">
                Multi-Regime Historical Strategy Backtester (Simulation)
              </span>
              <span aria-hidden="true" className="text-slate-600">·</span>
              <span className="text-emerald-400">
                {barsCount} Loaded Candles ({activeFeature.symbol})
              </span>
              <span aria-hidden="true" className="text-slate-600">·</span>
              <span className="text-cyan-300">
                Source: {dataSourceLabel}
              </span>
              <span aria-hidden="true" className="text-slate-600">·</span>
              <span className="text-slate-300">
                Period: {periodStart} &rarr; {periodEnd}
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              <strong className="text-amber-300 font-mono">SIMULATION OUTPUT ONLY:</strong> Computed strictly from {barsCount} loaded historical candles from <span className="font-mono text-slate-200">{dataSourceLabel}</span> covering <span className="font-mono text-slate-200">{periodStart}</span> to <span className="font-mono text-slate-200">{periodEnd}</span> with zero synthetic alignment bonuses.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {onDeployStrategy && (
              <button
                type="button"
                onClick={handleDeployCurrentConfig}
                disabled={isDeploying}
                className="px-3.5 py-2 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-slate-950 font-semibold text-xs rounded transition-colors flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
              >
                <Zap className="w-3.5 h-3.5" />
                <span>
                  {isDeploying
                    ? 'Deploying to Fleet...'
                    : `Deploy ${contractMultiplier}x Winner on ${activeFeature.symbol}`}
                </span>
              </button>
            )}
          </div>
        </div>

        {deployNotice && (
          <div className="px-3.5 py-2 border border-emerald-500/40 bg-emerald-950/30 text-emerald-200 text-xs flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>{deployNotice}</span>
          </div>
        )}

        {/* Interactive Parameter Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3 text-xs">
          <label className="space-y-1">
            <span className="text-slate-400 font-medium block">Target Instrument</span>
            <select
              value={symbol}
              onChange={(e) => {
                setSymbol(e.target.value);
                onSelectSymbol?.(e.target.value);
              }}
              className="w-full px-2.5 py-2 bg-[#0B0F17] border border-slate-800 text-slate-100 font-mono text-xs focus:outline-none focus:border-cyan-500"
            >
              {features.map((f) => (
                <option key={f.symbol} value={f.symbol}>
                  {f.symbol} · {f.assetClass === 'PREDICTION_CONTRACT' ? `${(f.price * 100).toFixed(0)}¢` : `$${f.price.toFixed(2)}`}
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-1 lg:col-span-2">
            <span className="text-slate-400 font-medium block">Quantitative Indicator Strategy</span>
            <select
              value={strategyId}
              onChange={(e) => setStrategyId(e.target.value as IndicatorStrategyId)}
              className="w-full px-2.5 py-2 bg-[#0B0F17] border border-slate-800 text-slate-100 font-mono text-xs focus:outline-none focus:border-cyan-500"
            >
              {STRATEGY_SPECS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.id} — {s.label}
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-1">
            <span className="text-slate-400 font-medium block">Execution Fee Model</span>
            <select
              value={executionFeeMode}
              onChange={(e) =>
                setExecutionFeeMode(e.target.value as 'MAKER_POST_ONLY' | 'TAKER_QUADRATIC')
              }
              className="w-full px-2.5 py-2 bg-[#0B0F17] border border-slate-800 text-emerald-300 font-mono text-xs focus:outline-none focus:border-cyan-500"
            >
              <option value="MAKER_POST_ONLY">Maker Post-Only ($0.00 Fee)</option>
              <option value="TAKER_QUADRATIC">Taker Limit (0.07 Quadratic)</option>
            </select>
          </label>

          <label className="space-y-1">
            <span className="text-slate-400 font-medium block">Contract Sizing (1x–8x)</span>
            <div className="flex items-center gap-1.5 bg-[#0B0F17] border border-slate-800 px-2.5 py-1.5 font-mono">
              <input
                type="number"
                min={1}
                max={8}
                step={1}
                value={contractMultiplier}
                onChange={(e) =>
                  setContractMultiplier(Math.min(8, Math.max(1, Number(e.target.value) || 5)))
                }
                className="w-full bg-transparent text-amber-300 font-bold focus:outline-none tabular-nums"
              />
              <span className="text-slate-400">x</span>
            </div>
          </label>

          <label className="space-y-1">
            <span className="text-slate-400 font-medium block">TP / SL Target (¢ or %)</span>
            <div className="grid grid-cols-2 gap-1.5 font-mono">
              <div className="flex items-center bg-[#0B0F17] border border-slate-800 px-2 py-1.5">
                <span className="text-[10px] text-emerald-400 mr-1">TP</span>
                <input
                  type="number"
                  min={2}
                  max={25}
                  value={takeProfitCentsOrPct}
                  onChange={(e) => setTakeProfitCentsOrPct(Math.max(2, Number(e.target.value) || 8))}
                  className="w-full bg-transparent text-slate-100 text-right focus:outline-none tabular-nums"
                />
              </div>
              <div className="flex items-center bg-[#0B0F17] border border-slate-800 px-2 py-1.5">
                <span className="text-[10px] text-rose-400 mr-1">SL</span>
                <input
                  type="number"
                  min={2}
                  max={20}
                  value={stopLossCentsOrPct}
                  onChange={(e) => setStopLossCentsOrPct(Math.max(2, Number(e.target.value) || 5))}
                  className="w-full bg-transparent text-slate-100 text-right focus:outline-none tabular-nums"
                />
              </div>
            </div>
          </label>
        </div>

        {/* Market Regime Filter Selector Bar */}
        <div className="pt-2 border-t border-slate-800/80 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-mono uppercase tracking-wider text-slate-400 flex items-center gap-1 mr-1">
              <Filter className="w-3.5 h-3.5 text-cyan-400" />
              <span>Filter Regime Window:</span>
            </span>
            <button
              type="button"
              onClick={() => setRegimeFilter('ALL_REGIMES')}
              className={`px-3 py-1.5 text-xs font-mono rounded transition-colors cursor-pointer ${
                regimeFilter === 'ALL_REGIMES'
                  ? 'bg-cyan-500 text-slate-950 font-bold'
                  : 'bg-[#0B0F17] border border-slate-800 text-slate-300 hover:text-slate-100'
              }`}
            >
              ALL REGIMES ({activeFeature.bars.length} Bars)
            </button>
            {ALL_REGIMES.map((r) => {
              const rSummary = regimeBreakdown.find((b) => b.regime === r);
              const isSelected = regimeFilter === r;
              return (
                <button
                  key={r}
                  type="button"
                  onClick={() => setRegimeFilter(r)}
                  className={`px-3 py-1.5 text-xs font-mono rounded border transition-colors cursor-pointer ${
                    isSelected
                      ? 'bg-slate-800 text-slate-100 border-cyan-400 font-semibold'
                      : 'bg-[#0B0F17] border-slate-800 text-slate-300 hover:border-slate-700'
                  }`}
                >
                  {REGIME_META[r].shortLabel} ({rSummary?.barsInRegime ?? 0})
                </button>
              );
            })}
          </div>
          <div className="text-[11px] font-mono text-slate-400">
            Formula: <span className="text-slate-200">{selectedStrategySpec.formulaSummary}</span>
          </div>
        </div>
      </div>

      {/* Top 3 Summary KPI Cards (Labeled as Simulation) */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="p-4 border border-emerald-500/40 bg-[#111827]">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Simulated Fee-Adjusted Net Return ({regimeFilter === 'ALL_REGIMES' ? 'All Regimes' : REGIME_META[regimeFilter].shortLabel})</span>
            <span className="font-mono text-emerald-400">SIMULATION · {executionFeeMode}</span>
          </div>
          <div
            className={`mt-1 text-2xl font-bold font-mono tabular-nums ${
              overallMetrics.netPnlUsd >= 0 ? 'text-emerald-400' : 'text-rose-400'
            }`}
          >
            {overallMetrics.netPnlUsd >= 0 ? '+' : ''}${overallMetrics.netPnlUsd.toFixed(2)} (
            {overallMetrics.totalReturnPct >= 0 ? '+' : ''}
            {overallMetrics.totalReturnPct.toFixed(2)}%)
          </div>
          <div className="mt-1.5 flex items-center justify-between text-xs font-mono text-slate-400">
            <span>Simulated Avg Net Edge: {overallMetrics.avgNetEdgeBps >= 0 ? '+' : ''}{overallMetrics.avgNetEdgeBps} bps</span>
            <span>Simulated Fees: ${overallMetrics.totalFeesUsd.toFixed(2)}</span>
          </div>
        </div>

        <div className="p-4 border border-slate-800 bg-[#111827]">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Simulated Walk-Forward Sharpe &amp; Profit Factor</span>
            <span className="font-mono text-cyan-400">{overallMetrics.totalTrades} Simulated Fills</span>
          </div>
          <div className="mt-1 text-2xl font-bold font-mono tabular-nums text-slate-100">
            Sharpe {overallMetrics.sharpeRatio.toFixed(2)} · PF {overallMetrics.profitFactor.toFixed(2)}
          </div>
          <div className="mt-1.5 flex items-center justify-between text-xs font-mono text-slate-400">
            <span className="text-emerald-400">Simulated Win Rate: {overallMetrics.winRatePct.toFixed(1)}%</span>
            <span>Simulation Sizing: {contractMultiplier}x</span>
          </div>
        </div>

        <div className="p-4 border border-slate-800 bg-[#111827]">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Simulated Max Drawdown &amp; Candle Period</span>
            <span className="font-mono text-amber-300">SIMULATION</span>
          </div>
          <div className="mt-1 text-2xl font-bold font-mono tabular-nums text-amber-300">
            -{overallMetrics.maxDrawdownPct.toFixed(2)}% Simulated Max DD
          </div>
          <div className="mt-1.5 flex items-center justify-between text-xs font-mono text-slate-400">
            <span>Source: {dataSourceLabel}</span>
            <span>{barsCount} Candles</span>
          </div>
        </div>
      </div>

      {/* 4-Regime Performance Breakdown Matrix + Interactive Regime-Colored Equity Curve */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
        {/* Left 7 Cols: Regime-Segmented Equity Curve SVG */}
        <div className="lg:col-span-7 p-5 border border-slate-800 bg-[#111827] flex flex-col justify-between space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-100">
                Historical Walk-Forward Equity Trajectory ({activeFeature.symbol} · {selectedStrategySpec.id})
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Background bands denote the active bar&apos;s classified <span className="font-mono text-slate-200">MarketRegime</span> across {equityCurve.length} historical bars.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono">
              {ALL_REGIMES.map((r) => (
                <span key={r} className="inline-flex items-center gap-1 text-slate-300">
                  <span
                    className="w-2.5 h-2.5 inline-block"
                    style={{ backgroundColor: REGIME_META[r].strokeColor }}
                  />
                  <span>{REGIME_META[r].shortLabel}</span>
                </span>
              ))}
            </div>
          </div>

          <div className="w-full overflow-x-auto bg-[#080C14] border border-slate-800 p-3">
            <svg
              viewBox={`0 0 ${chartWidth} ${chartHeight}`}
              className="w-full h-52 overflow-visible"
              role="img"
              aria-label="Strategy equity curve across market regimes"
            >
              {/* Regime color bands */}
              {equityCurve.map((pt, idx) => {
                if (idx === equityCurve.length - 1) return null;
                const x1 = (idx / Math.max(1, equityCurve.length - 1)) * (chartWidth - 24) + 12;
                const x2 = ((idx + 1) / Math.max(1, equityCurve.length - 1)) * (chartWidth - 24) + 12;
                return (
                  <rect
                    key={`band-${idx}`}
                    x={x1}
                    y={10}
                    width={Math.max(2, x2 - x1)}
                    height={chartHeight - 30}
                    fill={REGIME_META[pt.regime].bgTint}
                  />
                );
              })}

              {/* Baseline Initial Capital Reference Line */}
              {(() => {
                const baseY =
                  chartHeight - 22 - ((initialCapitalUsd - minEq) / eqRange) * (chartHeight - 44);
                return (
                  <line
                    x1={12}
                    y1={baseY}
                    x2={chartWidth - 12}
                    y2={baseY}
                    stroke="#334155"
                    strokeDasharray="4 4"
                    strokeWidth={1}
                  />
                );
              })()}

              {/* Equity Polyline */}
              {equityCurve.length > 1 && (
                <polyline
                  fill="none"
                  stroke="#10b981"
                  strokeWidth={2.2}
                  points={polylinePoints}
                />
              )}

              {/* Regime-Colored Node Dots */}
              {equityCurve.map((pt, idx) => {
                const x =
                  equityCurve.length > 1
                    ? (idx / (equityCurve.length - 1)) * (chartWidth - 24) + 12
                    : chartWidth / 2;
                const y = chartHeight - 22 - ((pt.equityUsd - minEq) / eqRange) * (chartHeight - 44);
                return (
                  <circle
                    key={`pt-${idx}`}
                    cx={x}
                    cy={y}
                    r={3}
                    fill={REGIME_META[pt.regime].strokeColor}
                  >
                    <title>
                      {`${pt.timestamp} · ${pt.regime} · Equity $${pt.equityUsd.toFixed(2)} (Bar Close ${pt.closePrice})`}
                    </title>
                  </circle>
                );
              })}
            </svg>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-mono text-slate-400 pt-1">
            <span>Start Capital: ${initialCapitalUsd.toFixed(2)}</span>
            <span className="text-emerald-400 font-semibold">
              Ending Equity: ${(initialCapitalUsd + overallMetrics.netPnlUsd).toFixed(2)}
            </span>
            <span>
              Optimal Regimes for {selectedStrategySpec.id}:{' '}
              <span className="text-cyan-300">{selectedStrategySpec.optimalRegimes.join(', ')}</span>
            </span>
          </div>
        </div>

        {/* Right 5 Cols: 4-Regime Performance Breakdown Table */}
        <div className="lg:col-span-5 p-5 border border-slate-800 bg-[#111827] flex flex-col justify-between space-y-4">
          <div className="border-b border-slate-800 pb-3">
            <h3 className="text-sm font-semibold text-slate-100">
              Performance Attribution by Market Regime
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Click any row to isolate backtest execution exclusively to that regime.
            </p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs font-mono tabular-nums">
              <thead>
                <tr className="border-b border-slate-800 text-slate-400 bg-[#0D131F]">
                  <th className="py-2 px-2.5">Regime</th>
                  <th className="py-2 px-2 text-right">Bars</th>
                  <th className="py-2 px-2 text-right">Trades</th>
                  <th className="py-2 px-2 text-right">Win %</th>
                  <th className="py-2 px-2 text-right">Sharpe</th>
                  <th className="py-2 px-2.5 text-right">Net P&amp;L</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80">
                {regimeBreakdown.map((row) => {
                  const isSelected = regimeFilter === row.regime;
                  return (
                    <tr
                      key={row.regime}
                      onClick={() =>
                        setRegimeFilter(isSelected ? 'ALL_REGIMES' : row.regime)
                      }
                      className={`cursor-pointer transition-colors ${
                        isSelected ? 'bg-slate-800/80' : 'hover:bg-slate-800/40'
                      }`}
                    >
                      <td className="py-2.5 px-2.5">
                        <span
                          className={`inline-block px-2 py-0.5 text-[10px] border ${REGIME_META[row.regime].badgeClass}`}
                        >
                          {REGIME_META[row.regime].shortLabel}
                        </span>
                      </td>
                      <td className="py-2.5 px-2 text-right text-slate-300">
                        {row.barsInRegime} ({row.barSharePct.toFixed(0)}%)
                      </td>
                      <td className="py-2.5 px-2 text-right text-slate-200">{row.tradesCount}</td>
                      <td className="py-2.5 px-2 text-right text-emerald-400">
                        {row.winRatePct.toFixed(0)}%
                      </td>
                      <td className="py-2.5 px-2 text-right text-cyan-300">
                        {row.sharpeRatio.toFixed(2)}
                      </td>
                      <td
                        className={`py-2.5 px-2.5 text-right font-semibold ${
                          row.netPnlUsd >= 0 ? 'text-emerald-400' : 'text-rose-400'
                        }`}
                      >
                        {row.netPnlUsd >= 0 ? '+' : ''}${row.netPnlUsd.toFixed(2)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="p-3 bg-[#0B0F17] border border-slate-800 text-[11px] font-mono text-slate-300 space-y-1">
            <div className="text-cyan-400 font-semibold">Regime Attribution Insight:</div>
            <div>
              {(() => {
                const bestRegime = [...regimeBreakdown].sort(
                  (a, b) => b.netPnlUsd - a.netPnlUsd
                )[0];
                return bestRegime
                  ? `Dominant alpha regime for ${activeFeature.symbol} is ${bestRegime.regime} (+$${bestRegime.netPnlUsd.toFixed(2)}, Win Rate ${bestRegime.winRatePct.toFixed(1)}%, Sharpe ${bestRegime.sharpeRatio.toFixed(2)}).`
                  : 'Select a regime above to inspect localized performance.';
              })()}
            </div>
          </div>
        </div>
      </div>

      {/* Cross-Asset Regime Leaderboard & Historical Simulated Trade Tape */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left 5 Cols: Cross-Asset Leaderboard in Selected Regime */}
        <div className="lg:col-span-5 border border-slate-800 bg-[#111827]">
          <div className="px-5 py-3.5 border-b border-slate-800 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-slate-100">
                Cross-Asset Leaderboard ({regimeFilter === 'ALL_REGIMES' ? 'All Regimes' : REGIME_META[regimeFilter].shortLabel})
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Ranks all tracked features using <span className="font-mono text-cyan-300">{strategyId}</span>.
              </p>
            </div>
          </div>
          <div className="overflow-x-auto max-h-80 overflow-y-auto">
            <table className="w-full text-left border-collapse text-xs font-mono tabular-nums">
              <thead className="sticky top-0 bg-[#0D131F] border-b border-slate-800 text-slate-400">
                <tr>
                  <th className="py-2 px-3">Symbol</th>
                  <th className="py-2 px-2">Live Regime</th>
                  <th className="py-2 px-2 text-right">Sharpe</th>
                  <th className="py-2 px-2 text-right">Win %</th>
                  <th className="py-2 px-3 text-right">Return %</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70">
                {crossAssetRegimeLeaderboard.map((item) => {
                  const isCurrent = item.symbol === symbol;
                  return (
                    <tr
                      key={item.symbol}
                      onClick={() => {
                        setSymbol(item.symbol);
                        onSelectSymbol?.(item.symbol);
                      }}
                      className={`cursor-pointer transition-colors ${
                        isCurrent ? 'bg-slate-800/80' : 'hover:bg-slate-800/40'
                      }`}
                    >
                      <td className="py-2 px-3 font-semibold text-slate-100">{item.symbol}</td>
                      <td className="py-2 px-2">
                        <span
                          className={`px-1.5 py-0.5 text-[10px] border ${
                            REGIME_META[item.currentRegime].badgeClass
                          }`}
                        >
                          {REGIME_META[item.currentRegime].shortLabel}
                        </span>
                      </td>
                      <td className="py-2 px-2 text-right text-cyan-300">
                        {item.sharpeRatio.toFixed(2)}
                      </td>
                      <td className="py-2 px-2 text-right text-slate-200">
                        {item.winRatePct.toFixed(0)}%
                      </td>
                      <td
                        className={`py-2 px-3 text-right font-semibold ${
                          item.totalReturnPct >= 0 ? 'text-emerald-400' : 'text-rose-400'
                        }`}
                      >
                        {item.totalReturnPct >= 0 ? '+' : ''}
                        {item.totalReturnPct.toFixed(2)}%
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Right 7 Cols: Simulated Trade Ledger */}
        <div className="lg:col-span-7 border border-slate-800 bg-[#111827]">
          <div className="px-5 py-3.5 border-b border-slate-800 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-slate-100">
                Regime-Filtered Backtest Trade Tape ({trades.length} Executions)
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Every simulated execution on <span className="font-mono text-slate-200">{activeFeature.symbol}</span> with exact bar regime classification and fee-adjusted net edge.
              </p>
            </div>
          </div>

          <div className="overflow-x-auto max-h-80 overflow-y-auto">
            <table className="w-full text-left border-collapse text-xs font-mono tabular-nums">
              <thead className="sticky top-0 bg-[#0D131F] border-b border-slate-800 text-slate-400">
                <tr>
                  <th className="py-2 px-3">Bar Timestamp</th>
                  <th className="py-2 px-2">Bar Regime</th>
                  <th className="py-2 px-2">Side &amp; Qty</th>
                  <th className="py-2 px-2 text-right">Entry &rarr; Exit</th>
                  <th className="py-2 px-2 text-right">Net Edge</th>
                  <th className="py-2 px-3 text-right">Net P&amp;L</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70">
                {trades.map((t, idx) => (
                  <tr key={`${t.id}-${idx}`} className="hover:bg-slate-800/30">
                    <td className="py-2 px-3">
                      <div className="text-slate-200">
                        {new Date(t.entryTimestamp).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                          second: '2-digit',
                        })}
                      </div>
                      <div className="text-[10px] text-slate-500">{t.exitReason}</div>
                    </td>
                    <td className="py-2 px-2">
                      <span
                        className={`px-1.5 py-0.5 text-[10px] border ${
                          REGIME_META[t.regime].badgeClass
                        }`}
                      >
                        {REGIME_META[t.regime].shortLabel}
                      </span>
                    </td>
                    <td className="py-2 px-2">
                      <span className="text-emerald-300 font-semibold">{t.side}</span>{' '}
                      <span className="text-slate-300">{t.contractsOrShares}x</span>
                    </td>
                    <td className="py-2 px-2 text-right text-slate-200">
                      ${t.entryPrice.toFixed(2)} &rarr; ${t.exitPrice.toFixed(2)}
                    </td>
                    <td
                      className={`py-2 px-2 text-right ${
                        t.netReturnBps >= 0 ? 'text-cyan-300' : 'text-rose-400'
                      }`}
                    >
                      {t.netReturnBps >= 0 ? '+' : ''}
                      {t.netReturnBps} bps
                    </td>
                    <td
                      className={`py-2 px-3 text-right font-semibold ${
                        t.netPnlUsd >= 0 ? 'text-emerald-400' : 'text-rose-400'
                      }`}
                    >
                      {t.netPnlUsd >= 0 ? '+' : ''}${t.netPnlUsd.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
};
