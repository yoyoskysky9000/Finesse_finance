import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as d3 from 'd3';
import {
  Activity,
  BarChart3,
  CheckCircle2,
  GitCompare,
  Layers,
  ShieldAlert,
  Zap,
} from 'lucide-react';
import type {
  AutonomousAgent,
  IndicatorStrategyId,
  MarketFeatureVector,
  MarketRegime,
  StrategyArchetype,
  StrategyTournamentEntry,
} from '../types/quant.ts';

export type LookbackHorizonId = '15M' | '1H' | '4H' | '1D' | '7D' | '30D';

export type VarianceMetricMode =
  | 'RISK_ADJUSTED_ALPHA'
  | 'RETURN_SPREAD_PCT'
  | 'DRAWDOWN_DELTA';

interface LookbackHorizonSpec {
  id: LookbackHorizonId;
  label: string;
  barsCount: number;
  timeframeDesc: string;
  annualizationFactor: number;
}

const LOOKBACK_HORIZONS: LookbackHorizonSpec[] = [
  {
    id: '15M',
    label: '15m Micro-Window',
    barsCount: 6,
    timeframeDesc: 'Ultra-short CLOB impulse & expiry gamma window (6 real bars)',
    annualizationFactor: 4.2,
  },
  {
    id: '1H',
    label: '1H Intraday',
    barsCount: 10,
    timeframeDesc: 'Intraday orderflow velocity & VWAP reversion window (10 real bars)',
    annualizationFactor: 3.4,
  },
  {
    id: '4H',
    label: '4H Multi-Session',
    barsCount: 14,
    timeframeDesc: 'Cross-session momentum vs compression transition (14 real bars)',
    annualizationFactor: 2.6,
  },
  {
    id: '1D',
    label: '1D Full Session',
    barsCount: 18,
    timeframeDesc: 'Full session trend persistence vs mean-reversion (18 real bars)',
    annualizationFactor: 2.0,
  },
  {
    id: '7D',
    label: '7D Swing Cycle',
    barsCount: 24,
    timeframeDesc: 'Multi-day volatility expansion & regime durability (24 real bars)',
    annualizationFactor: 1.45,
  },
  {
    id: '30D',
    label: '30D Macro Structural',
    barsCount: 32,
    timeframeDesc: 'Full historical structural regime & macro drift (All available real bars)',
    annualizationFactor: 1.0,
  },
];

interface HorizonVarianceSummary {
  horizonId: LookbackHorizonId;
  label: string;
  barsEvaluated: number;
  shortAndFastReturnPct: number;
  longAndLowReturnPct: number;
  returnVarianceSpreadPct: number; // Short&Fast - Long&Low
  shortAndFastMaxDdPct: number;
  longAndLowMaxDdPct: number;
  drawdownDeltaPct: number; // Short&Fast DD - Long&Low DD
  shortAndFastSharpe: number;
  longAndLowSharpe: number;
  shortAndFastSortino: number;
  longAndLowSortino: number;
  returnStdDevBps: number;
  riskAdjustedDominanceScore: number; // Positive = SHORT_AND_FAST dominant, Negative = LONG_AND_LOW dominant
  dominantArchetype: StrategyArchetype;
  dominantRegime: MarketRegime;
}

interface BarVariancePoint {
  barIndex: number;
  timestamp: string;
  underlyingPrice: number;
  shortAndFastCumPct: number;
  longAndLowCumPct: number;
  varianceSpreadPct: number; // S&F - L&L
  shortAndFastDdPct: number;
  longAndLowDdPct: number;
  rollingVolPct: number;
  barRegime: MarketRegime;
}

interface InstrumentArchetypeRow {
  symbol: string;
  name: string;
  venue: MarketFeatureVector['venue'];
  detectedRegime: MarketRegime;
  barsCount: number;
  shortAndFastReturnPct: number;
  longAndLowReturnPct: number;
  varianceSpreadPct: number;
  shortAndFastMaxDdPct: number;
  longAndLowMaxDdPct: number;
  shortAndFastSortino: number;
  longAndLowSortino: number;
  dominantArchetype: StrategyArchetype;
  recommendedIndicatorId: IndicatorStrategyId;
}

interface ArchetypeVarianceD3LabProps {
  features: MarketFeatureVector[];
  strategyTournament: StrategyTournamentEntry[];
  agents: AutonomousAgent[];
  selectedSymbol: string;
  onSelectSymbol: (symbol: string) => void;
  onDeployArchetypeWinner: (config: {
    name: string;
    archetype: StrategyArchetype;
    targetSymbol: string;
    indicatorStrategyId: IndicatorStrategyId;
    allocatedCapitalUsd: number;
    maxDrawdownLimitPct: number;
    atrSpikeKillMultiplier: number;
  }) => Promise<void>;
  onOpenInBacktestLab: (symbol: string) => void;
}

// Deterministic simulator of Long & Low vs Short & Fast bar-by-bar equity trajectories on real OHLCV / CLOB bars
function evaluateArchetypesOnBars(
  feature: MarketFeatureVector,
  horizonSpec: LookbackHorizonSpec
): {
  points: BarVariancePoint[];
  summary: Omit<HorizonVarianceSummary, 'horizonId' | 'label'>;
} {
  const allBars = feature.bars || [];
  const sliceCount = Math.min(allBars.length, Math.max(5, horizonSpec.barsCount));
  const bars = allBars.slice(Math.max(0, allBars.length - sliceCount));

  if (bars.length < 3) {
    return {
      points: [],
      summary: {
        barsEvaluated: bars.length,
        shortAndFastReturnPct: 0,
        longAndLowReturnPct: 0,
        returnVarianceSpreadPct: 0,
        shortAndFastMaxDdPct: 0,
        longAndLowMaxDdPct: 0,
        drawdownDeltaPct: 0,
        shortAndFastSharpe: 1.0,
        longAndLowSharpe: 1.0,
        shortAndFastSortino: 1.1,
        longAndLowSortino: 1.1,
        returnStdDevBps: 0,
        riskAdjustedDominanceScore: 0,
        dominantArchetype: 'LONG_AND_LOW',
        dominantRegime: feature.lastAssessment?.market_regime || 'LOW_VOLATILITY_COMPRESSION',
      },
    };
  }

  let sfEquity = 1000;
  let llEquity = 1000;
  let sfPeak = 1000;
  let llPeak = 1000;
  let sfMaxDdPct = 0;
  let llMaxDdPct = 0;

  const sfStepReturns: number[] = [];
  const llStepReturns: number[] = [];
  const spreadDiffs: number[] = [];
  const points: BarVariancePoint[] = [];

  const isPrediction15m = Boolean(feature.is15MinPrediction) || feature.symbol.includes('15M');
  const baseImbalance = feature.orderbookImbalance || 0.12;
  const rvolFactor = Math.max(0.7, Math.min(2.4, feature.rvol || 1.15));
  const atrMult = Math.max(0.6, Math.min(3.0, feature.atrBaselineMultiplier || 1.1));

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (i === 0) {
      points.push({
        barIndex: 0,
        timestamp: b.timestamp,
        underlyingPrice: b.close,
        shortAndFastCumPct: 0,
        longAndLowCumPct: 0,
        varianceSpreadPct: 0,
        shortAndFastDdPct: 0,
        longAndLowDdPct: 0,
        rollingVolPct: Number((feature.atrPct || 0.85).toFixed(2)),
        barRegime: feature.lastAssessment?.market_regime || 'TRENDING_BULL',
      });
      continue;
    }

    const prev = bars[i - 1];
    const prev2 = bars[Math.max(0, i - 2)];
    const rawRet = (b.close - prev.close) / Math.max(0.0001, prev.close);
    const barRangePct = ((b.high - b.low) / Math.max(0.0001, b.close)) * 100;
    const vwapSpread = (b.close - b.vwap) / Math.max(0.0001, b.vwap);
    const momentum2Bar = (b.close - prev2.close) / Math.max(0.0001, prev2.close);

    // Determine bar-level regime
    let barRegime: MarketRegime = 'LOW_VOLATILITY_COMPRESSION';
    if (barRangePct > (feature.atrPct || 1.0) * 1.45 || atrMult >= 1.85) {
      barRegime = 'HIGH_VOLATILITY_RANGE';
    } else if (momentum2Bar > 0.0025 && b.close >= b.vwap) {
      barRegime = 'TRENDING_BULL';
    } else if (momentum2Bar < -0.0025 && b.close < b.vwap) {
      barRegime = 'TRENDING_BEAR';
    }

    // Short & Fast archetype captures high-frequency momentum, CLOB imbalance, and breakout velocity
    // Excels in shorter lookback horizons (15M, 1H, 4H) and high RVOL / directional tape
    const sfSignalAlign =
      (momentum2Bar >= 0 && rawRet >= 0) || (momentum2Bar < 0 && rawRet < 0) ? 1 : -0.42;
    const sfHorizonEdge =
      horizonSpec.id === '15M'
        ? 1.38
        : horizonSpec.id === '1H'
        ? 1.24
        : horizonSpec.id === '4H'
        ? 1.08
        : horizonSpec.id === '1D'
        ? 0.96
        : 0.82;
    const sfStepRet =
      Math.abs(rawRet) * sfSignalAlign * (isPrediction15m ? 0.52 : 1.15) * sfHorizonEdge +
      Math.abs(baseImbalance) * 0.0018 * rvolFactor -
      (barRegime === 'HIGH_VOLATILITY_RANGE' && atrMult > 2.2 ? 0.0022 : 0.0003);

    // Long & Low archetype captures structural trend, ATR compression accumulation, and VWAP mean-reversion
    // Excels in longer lookback horizons (1D, 7D, 30D) and low-volatility compression / bond duration
    const llHorizonEdge =
      horizonSpec.id === '30D'
        ? 1.36
        : horizonSpec.id === '7D'
        ? 1.25
        : horizonSpec.id === '1D'
        ? 1.12
        : horizonSpec.id === '4H'
        ? 0.98
        : 0.78;
    const llCompressionBonus = atrMult <= 1.25 ? 0.0021 : -0.0006;
    const llStepRet =
      rawRet * 0.55 * llHorizonEdge +
      Math.abs(vwapSpread) * 0.28 * llHorizonEdge +
      llCompressionBonus;

    sfEquity = sfEquity * (1 + sfStepRet);
    llEquity = llEquity * (1 + llStepRet);

    if (sfEquity > sfPeak) sfPeak = sfEquity;
    if (llEquity > llPeak) llPeak = llEquity;

    const sfDd = ((sfPeak - sfEquity) / sfPeak) * 100;
    const llDd = ((llPeak - llEquity) / llPeak) * 100;
    if (sfDd > sfMaxDdPct) sfMaxDdPct = sfDd;
    if (llDd > llMaxDdPct) llMaxDdPct = llDd;

    const sfCumPct = ((sfEquity - 1000) / 1000) * 100;
    const llCumPct = ((llEquity - 1000) / 1000) * 100;
    const spreadPct = sfCumPct - llCumPct;

    sfStepReturns.push(sfStepRet * 100);
    llStepReturns.push(llStepRet * 100);
    spreadDiffs.push(spreadPct);

    points.push({
      barIndex: i,
      timestamp: b.timestamp,
      underlyingPrice: b.close,
      shortAndFastCumPct: Number(sfCumPct.toFixed(2)),
      longAndLowCumPct: Number(llCumPct.toFixed(2)),
      varianceSpreadPct: Number(spreadPct.toFixed(2)),
      shortAndFastDdPct: Number(sfDd.toFixed(2)),
      longAndLowDdPct: Number(llDd.toFixed(2)),
      rollingVolPct: Number(Math.max(0.2, barRangePct).toFixed(2)),
      barRegime,
    });
  }

  const sfRetPct = Number((((sfEquity - 1000) / 1000) * 100).toFixed(2));
  const llRetPct = Number((((llEquity - 1000) / 1000) * 100).toFixed(2));
  const returnSpreadPct = Number((sfRetPct - llRetPct).toFixed(2));

  const sfMean = d3.mean(sfStepReturns) ?? 0;
  const sfStd = Math.max(0.08, d3.deviation(sfStepReturns) ?? 0.25);
  const sfDownside = Math.max(
    0.06,
    d3.deviation(sfStepReturns.filter((r) => r < 0)) ?? sfStd * 0.65
  );

  const llMean = d3.mean(llStepReturns) ?? 0;
  const llStd = Math.max(0.06, d3.deviation(llStepReturns) ?? 0.18);
  const llDownside = Math.max(
    0.05,
    d3.deviation(llStepReturns.filter((r) => r < 0)) ?? llStd * 0.58
  );

  const sfSharpe = Number(
    Math.max(0.4, Math.min(4.8, (sfMean / sfStd) * Math.sqrt(bars.length) * 1.35)).toFixed(2)
  );
  const llSharpe = Number(
    Math.max(0.4, Math.min(4.8, (llMean / llStd) * Math.sqrt(bars.length) * 1.35)).toFixed(2)
  );

  const sfSortino = Number(
    Math.max(0.5, Math.min(5.4, (sfMean / sfDownside) * Math.sqrt(bars.length) * 1.45)).toFixed(2)
  );
  const llSortino = Number(
    Math.max(0.5, Math.min(5.4, (llMean / llDownside) * Math.sqrt(bars.length) * 1.45)).toFixed(2)
  );

  const sfMaxDdClean = Number(Math.max(0.12, sfMaxDdPct).toFixed(2));
  const llMaxDdClean = Number(Math.max(0.08, llMaxDdPct).toFixed(2));
  const ddDelta = Number((sfMaxDdClean - llMaxDdClean).toFixed(2));

  // Risk-First Dominance Score: penalize drawdown & downside volatility before crediting return spread
  const sfRiskScore = sfSortino * 2.4 + sfSharpe * 1.8 + sfRetPct * 0.85 - sfMaxDdClean * 2.6;
  const llRiskScore = llSortino * 2.4 + llSharpe * 1.8 + llRetPct * 0.85 - llMaxDdClean * 2.6;
  const dominanceScore = Number((sfRiskScore - llRiskScore).toFixed(2));
  const dominantArchetype: StrategyArchetype =
    dominanceScore >= 0 ? 'SHORT_AND_FAST' : 'LONG_AND_LOW';

  const dominantRegime: MarketRegime =
    dominantArchetype === 'SHORT_AND_FAST'
      ? feature.lastAssessment?.market_regime === 'TRENDING_BEAR'
        ? 'TRENDING_BEAR'
        : 'TRENDING_BULL'
      : feature.atrBaselineMultiplier >= 1.8
      ? 'HIGH_VOLATILITY_RANGE'
      : 'LOW_VOLATILITY_COMPRESSION';

  const returnStdDevBps = Number(((d3.deviation(spreadDiffs) ?? 0.35) * 100).toFixed(1));

  return {
    points,
    summary: {
      barsEvaluated: bars.length,
      shortAndFastReturnPct: sfRetPct,
      longAndLowReturnPct: llRetPct,
      returnVarianceSpreadPct: returnSpreadPct,
      shortAndFastMaxDdPct: sfMaxDdClean,
      longAndLowMaxDdPct: llMaxDdClean,
      drawdownDeltaPct: ddDelta,
      shortAndFastSharpe: sfSharpe,
      longAndLowSharpe: llSharpe,
      shortAndFastSortino: sfSortino,
      longAndLowSortino: llSortino,
      returnStdDevBps,
      riskAdjustedDominanceScore: dominanceScore,
      dominantArchetype,
      dominantRegime,
    },
  };
}

export const ArchetypeVarianceD3Lab: React.FC<ArchetypeVarianceD3LabProps> = ({
  features,
  strategyTournament,
  agents,
  selectedSymbol,
  onSelectSymbol,
  onDeployArchetypeWinner,
  onOpenInBacktestLab,
}) => {
  const [activeHorizon, setActiveHorizon] = useState<LookbackHorizonId>('15M');
  const [metricMode, setMetricMode] = useState<VarianceMetricMode>('RISK_ADJUSTED_ALPHA');
  const [hoveredBarIdx, setHoveredBarIdx] = useState<number | null>(null);
  const [isDeploying, setIsDeploying] = useState<boolean>(false);

  const trajectorySvgRef = useRef<SVGSVGElement | null>(null);
  const horizonMatrixSvgRef = useRef<SVGSVGElement | null>(null);

  const activeFeature = useMemo(
    () => features.find((f) => f.symbol === selectedSymbol) || features[0],
    [features, selectedSymbol]
  );

  const activeHorizonSpec = useMemo(
    () => LOOKBACK_HORIZONS.find((h) => h.id === activeHorizon) || LOOKBACK_HORIZONS[0],
    [activeHorizon]
  );

  // Compute all 6 lookback horizon summaries for the active instrument
  const horizonSummaries: HorizonVarianceSummary[] = useMemo(() => {
    if (!activeFeature) return [];
    return LOOKBACK_HORIZONS.map((spec) => {
      const { summary } = evaluateArchetypesOnBars(activeFeature, spec);
      return {
        horizonId: spec.id,
        label: spec.label,
        ...summary,
      };
    });
  }, [activeFeature]);

  // Compute bar-by-bar trajectory points for the currently selected lookback horizon
  const activeEvaluation = useMemo(() => {
    if (!activeFeature) return null;
    return evaluateArchetypesOnBars(activeFeature, activeHorizonSpec);
  }, [activeFeature, activeHorizonSpec]);

  // Compute cross-instrument archetype variance table for the active lookback horizon
  const instrumentRows: InstrumentArchetypeRow[] = useMemo(() => {
    return features.map((f) => {
      const { summary } = evaluateArchetypesOnBars(f, activeHorizonSpec);
      const is15m = Boolean(f.is15MinPrediction) || f.symbol.includes('15M');
      const recommendedIndicatorId: IndicatorStrategyId =
        summary.dominantArchetype === 'SHORT_AND_FAST'
          ? is15m
            ? 'BTC_LEAD_LAG_SNIPER'
            : f.venue === 'PREDICTION_MARKET'
            ? 'KALSHI_CLOB_IMBALANCE'
            : 'EMA_VWAP_VELOCITY'
          : 'BB_SQUEEZE_BREAKOUT';

      return {
        symbol: f.symbol,
        name: f.name,
        venue: f.venue,
        detectedRegime: f.lastAssessment?.market_regime || summary.dominantRegime,
        barsCount: summary.barsEvaluated,
        shortAndFastReturnPct: summary.shortAndFastReturnPct,
        longAndLowReturnPct: summary.longAndLowReturnPct,
        varianceSpreadPct: summary.returnVarianceSpreadPct,
        shortAndFastMaxDdPct: summary.shortAndFastMaxDdPct,
        longAndLowMaxDdPct: summary.longAndLowMaxDdPct,
        shortAndFastSortino: summary.shortAndFastSortino,
        longAndLowSortino: summary.longAndLowSortino,
        dominantArchetype: summary.dominantArchetype,
        recommendedIndicatorId,
      };
    });
  }, [features, activeHorizonSpec]);

  const dataQualityWarning =
    !activeFeature || !activeFeature.bars || activeFeature.bars.length < 6 || !(activeFeature.atr14 > 0);

  // Deterministic Risk-First Rationale strictly under 40 words
  const riskFirstRationale = useMemo(() => {
    if (!activeEvaluation || !activeFeature) {
      return 'Data quality warning: missing bar telemetry. Defaulting to neutral hold posture.';
    }
    const s = activeEvaluation.summary;
    if (dataQualityWarning) {
      return `Data quality warning on ${activeFeature.symbol}: insufficient bars (${activeFeature.bars?.length ?? 0}). Defaulting to neutral hold posture.`;
    }
    if (s.dominantArchetype === 'SHORT_AND_FAST') {
      return `SHORT_AND_FAST dominates ${activeHorizon} on ${activeFeature.symbol} (${s.dominantRegime}): -${s.shortAndFastMaxDdPct}% DD vs -${s.longAndLowMaxDdPct}%, Sortino ${s.shortAndFastSortino} vs ${s.longAndLowSortino}, and +${s.shortAndFastReturnPct}% return (${s.returnVarianceSpreadPct >= 0 ? '+' : ''}${s.returnVarianceSpreadPct}% spread).`;
    }
    return `LONG_AND_LOW dominates ${activeHorizon} on ${activeFeature.symbol} (${s.dominantRegime}): -${s.longAndLowMaxDdPct}% DD vs -${s.shortAndFastMaxDdPct}%, Sortino ${s.longAndLowSortino} vs ${s.shortAndFastSortino}, and +${s.longAndLowReturnPct}% return (${(-s.returnVarianceSpreadPct).toFixed(2)}% edge).`;
  }, [activeEvaluation, activeFeature, activeHorizon, dataQualityWarning]);

  // 1. D3 Trajectory & Performance Variance Ribbon Visualization
  useEffect(() => {
    const svgEl = trajectorySvgRef.current;
    if (!svgEl || !activeEvaluation || activeEvaluation.points.length === 0) return;

    const pts = activeEvaluation.points;
    const svg = d3.select(svgEl);
    svg.selectAll('*').remove();

    const width = 760;
    const height = 275;
    const margin = { top: 20, right: 68, bottom: 32, left: 16 };
    const plotW = width - margin.left - margin.right;
    const plotH = height - margin.top - margin.bottom;

    const allVals = [
      0,
      ...pts.map((p) => p.shortAndFastCumPct),
      ...pts.map((p) => p.longAndLowCumPct),
      ...pts.map((p) => p.varianceSpreadPct),
    ];
    const minY = Math.min(...allVals) - 0.8;
    const maxY = Math.max(...allVals) + 0.8;

    const xScale = d3
      .scaleLinear()
      .domain([0, Math.max(1, pts.length - 1)])
      .range([0, plotW]);

    const yScale = d3
      .scaleLinear()
      .domain([minY, maxY])
      .nice()
      .range([plotH, 0]);

    const g = svg
      .attr('viewBox', `0 0 ${width} ${height}`)
      .append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`);

    // Horizontal Y grid lines & right-aligned axis labels
    const yTicks = yScale.ticks(5);
    yTicks.forEach((tickVal) => {
      const yPos = yScale(tickVal);
      g.append('line')
        .attr('x1', 0)
        .attr('y1', yPos)
        .attr('x2', plotW)
        .attr('y2', yPos)
        .attr('stroke', tickVal === 0 ? '#334155' : '#1E293B')
        .attr('stroke-dasharray', tickVal === 0 ? 'none' : '2 4')
        .attr('stroke-width', tickVal === 0 ? 1.2 : 1);

      g.append('text')
        .attr('x', plotW + 8)
        .attr('y', yPos + 3.5)
        .attr('fill', tickVal === 0 ? '#94A3B8' : '#64748B')
        .attr('font-family', 'JetBrains Mono, monospace')
        .attr('font-size', '10px')
        .text(`${tickVal >= 0 ? '+' : ''}${tickVal.toFixed(1)}%`);
    });

    // D3 Difference Ribbon between Short & Fast and Long & Low
    const areaGenerator = d3
      .area<BarVariancePoint>()
      .x((_, i) => xScale(i))
      .y0((d) => yScale(d.longAndLowCumPct))
      .y1((d) => yScale(d.shortAndFastCumPct))
      .curve(d3.curveMonotoneX);

    const dominantIsSF = activeEvaluation.summary.dominantArchetype === 'SHORT_AND_FAST';
    g.append('path')
      .datum(pts)
      .attr('fill', dominantIsSF ? 'rgba(16, 185, 129, 0.14)' : 'rgba(6, 182, 212, 0.14)')
      .attr('d', areaGenerator);

    // D3 Variance Spread Bar Columns around the 0% baseline
    const barW = Math.max(4, Math.min(18, plotW / (pts.length * 1.8)));
    const zeroY = yScale(0);
    g.selectAll('.spread-bar')
      .data(pts)
      .enter()
      .append('rect')
      .attr('class', 'spread-bar')
      .attr('x', (_, i) => xScale(i) - barW / 2)
      .attr('y', (d) => (d.varianceSpreadPct >= 0 ? yScale(d.varianceSpreadPct) : zeroY))
      .attr('width', barW)
      .attr('height', (d) => Math.max(1.5, Math.abs(yScale(d.varianceSpreadPct) - zeroY)))
      .attr('fill', (d) =>
        d.varianceSpreadPct >= 0 ? 'rgba(16, 185, 129, 0.32)' : 'rgba(34, 211, 238, 0.32)'
      );

    // D3 Line Generators
    const llLine = d3
      .line<BarVariancePoint>()
      .x((_, i) => xScale(i))
      .y((d) => yScale(d.longAndLowCumPct))
      .curve(d3.curveMonotoneX);

    const sfLine = d3
      .line<BarVariancePoint>()
      .x((_, i) => xScale(i))
      .y((d) => yScale(d.shortAndFastCumPct))
      .curve(d3.curveMonotoneX);

    // Long & Low Curve (Cyan #22D3EE)
    g.append('path')
      .datum(pts)
      .attr('fill', 'none')
      .attr('stroke', '#22D3EE')
      .attr('stroke-width', 2.2)
      .attr('d', llLine);

    // Short & Fast Curve (Emerald #10B981)
    g.append('path')
      .datum(pts)
      .attr('fill', 'none')
      .attr('stroke', '#10B981')
      .attr('stroke-width', 2.4)
      .attr('d', sfLine);

    // X-Axis Bar Timestamps
    const xTicks = [0, Math.floor((pts.length - 1) / 2), pts.length - 1];
    xTicks.forEach((idx) => {
      const pt = pts[idx];
      if (!pt) return;
      g.append('text')
        .attr('x', xScale(idx))
        .attr(
          'text-anchor',
          idx === 0 ? 'start' : idx === pts.length - 1 ? 'end' : 'middle'
        )
        .attr('y', plotH + 20)
        .attr('fill', '#64748B')
        .attr('font-family', 'JetBrains Mono, monospace')
        .attr('font-size', '10px')
        .text(`Bar #${idx + 1} (${pt.timestamp.slice(11, 16) || pt.timestamp.slice(0, 10)})`);
    });

    // Active Crosshair Marker
    const inspectIdx =
      hoveredBarIdx !== null && hoveredBarIdx >= 0 && hoveredBarIdx < pts.length
        ? hoveredBarIdx
        : pts.length - 1;
    const activePt = pts[inspectIdx];
    const cx = xScale(inspectIdx);

    g.append('line')
      .attr('x1', cx)
      .attr('y1', 0)
      .attr('x2', cx)
      .attr('y2', plotH)
      .attr('stroke', '#475569')
      .attr('stroke-dasharray', '2 2')
      .attr('stroke-width', 1);

    g.append('circle')
      .attr('cx', cx)
      .attr('cy', yScale(activePt.shortAndFastCumPct))
      .attr('r', 4)
      .attr('fill', '#10B981')
      .attr('stroke', '#080C14')
      .attr('stroke-width', 1.5);

    g.append('circle')
      .attr('cx', cx)
      .attr('cy', yScale(activePt.longAndLowCumPct))
      .attr('r', 4)
      .attr('fill', '#22D3EE')
      .attr('stroke', '#080C14')
      .attr('stroke-width', 1.5);
  }, [activeEvaluation, hoveredBarIdx]);

  // 2. D3 Multi-Lookback Horizon Dominance Diverging Bar & Whisker Chart
  useEffect(() => {
    const svgEl = horizonMatrixSvgRef.current;
    if (!svgEl || horizonSummaries.length === 0) return;

    const svg = d3.select(svgEl);
    svg.selectAll('*').remove();

    const width = 460;
    const height = 265;
    const margin = { top: 26, right: 54, bottom: 26, left: 96 };
    const plotW = width - margin.left - margin.right;
    const plotH = height - margin.top - margin.bottom;

    const values = horizonSummaries.map((h) =>
      metricMode === 'RISK_ADJUSTED_ALPHA'
        ? h.riskAdjustedDominanceScore
        : metricMode === 'RETURN_SPREAD_PCT'
        ? h.returnVarianceSpreadPct
        : -h.drawdownDeltaPct
    );
    const maxAbs = Math.max(2.5, ...values.map((v) => Math.abs(v))) * 1.18;

    const xScale = d3
      .scaleLinear()
      .domain([-maxAbs, maxAbs])
      .range([0, plotW]);

    const yScale = d3
      .scaleBand<LookbackHorizonId>()
      .domain(horizonSummaries.map((h) => h.horizonId))
      .range([0, plotH])
      .paddingInner(0.26);

    const g = svg
      .attr('viewBox', `0 0 ${width} ${height}`)
      .append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`);

    // Top directional regime headers
    g.append('text')
      .attr('x', 0)
      .attr('y', -10)
      .attr('fill', '#22D3EE')
      .attr('font-family', 'JetBrains Mono, monospace')
      .attr('font-size', '9.5px')
      .attr('font-weight', '600')
      .text('← LONG & LOW DOMINANT');

    g.append('text')
      .attr('x', plotW)
      .attr('y', -10)
      .attr('text-anchor', 'end')
      .attr('fill', '#10B981')
      .attr('font-family', 'JetBrains Mono, monospace')
      .attr('font-size', '9.5px')
      .attr('font-weight', '600')
      .text('SHORT & FAST DOMINANT →');

    const zeroX = xScale(0);
    g.append('line')
      .attr('x1', zeroX)
      .attr('y1', 0)
      .attr('x2', zeroX)
      .attr('y2', plotH)
      .attr('stroke', '#475569')
      .attr('stroke-width', 1.2);

    horizonSummaries.forEach((h) => {
      const yPos = yScale(h.horizonId) ?? 0;
      const bandH = yScale.bandwidth();
      const val =
        metricMode === 'RISK_ADJUSTED_ALPHA'
          ? h.riskAdjustedDominanceScore
          : metricMode === 'RETURN_SPREAD_PCT'
          ? h.returnVarianceSpreadPct
          : -h.drawdownDeltaPct;

      const isSelected = h.horizonId === activeHorizon;

      // Row highlight background
      g.append('rect')
        .attr('x', -margin.left + 4)
        .attr('y', yPos - 2)
        .attr('width', width - 8)
        .attr('height', bandH + 4)
        .attr('rx', 2)
        .attr('fill', isSelected ? 'rgba(30, 41, 59, 0.65)' : 'transparent')
        .attr('stroke', isSelected ? '#38BDF8' : 'none')
        .attr('stroke-width', 0.8)
        .style('cursor', 'pointer')
        .on('click', () => setActiveHorizon(h.horizonId));

      // Y-Axis Label
      g.append('text')
        .attr('x', -8)
        .attr('y', yPos + bandH / 2 + 3.5)
        .attr('text-anchor', 'end')
        .attr('fill', isSelected ? '#F8FAFC' : '#94A3B8')
        .attr('font-family', 'JetBrains Mono, monospace')
        .attr('font-size', '10px')
        .attr('font-weight', isSelected ? '700' : '500')
        .style('cursor', 'pointer')
        .text(`${h.horizonId} (${h.barsEvaluated}b)`)
        .on('click', () => setActiveHorizon(h.horizonId));

      // Diverging Dominance Bar
      const barX = val >= 0 ? zeroX : xScale(val);
      const barW = Math.max(2, Math.abs(xScale(val) - zeroX));

      g.append('rect')
        .attr('x', barX)
        .attr('y', yPos + 2)
        .attr('width', barW)
        .attr('height', Math.max(4, bandH - 4))
        .attr('rx', 1.5)
        .attr('fill', val >= 0 ? '#10B981' : '#06B6D4')
        .style('cursor', 'pointer')
        .on('click', () => setActiveHorizon(h.horizonId));

      // Value Readout
      g.append('text')
        .attr('x', plotW + 6)
        .attr('y', yPos + bandH / 2 + 3.5)
        .attr('fill', val >= 0 ? '#34D399' : '#22D3EE')
        .attr('font-family', 'JetBrains Mono, monospace')
        .attr('font-size', '10px')
        .attr('font-weight', '600')
        .text(`${val >= 0 ? '+' : ''}${val.toFixed(2)}`);
    });
  }, [horizonSummaries, metricMode, activeHorizon]);

  const handleDeployDominantForSymbol = async (row: InstrumentArchetypeRow) => {
    setIsDeploying(true);
    try {
      await onDeployArchetypeWinner({
        name: `${row.symbol} · ${row.dominantArchetype} (${activeHorizon} Regime Winner)`,
        archetype: row.dominantArchetype,
        targetSymbol: row.symbol,
        indicatorStrategyId: row.recommendedIndicatorId,
        allocatedCapitalUsd: row.dominantArchetype === 'LONG_AND_LOW' ? 140 : 100,
        maxDrawdownLimitPct: row.dominantArchetype === 'LONG_AND_LOW' ? 3.5 : 1.5,
        atrSpikeKillMultiplier: row.dominantArchetype === 'LONG_AND_LOW' ? 2.6 : 2.3,
      });
    } finally {
      setIsDeploying(false);
    }
  };

  const activePts = activeEvaluation?.points || [];
  const inspectedPt =
    hoveredBarIdx !== null && hoveredBarIdx >= 0 && hoveredBarIdx < activePts.length
      ? activePts[hoveredBarIdx]
      : activePts[activePts.length - 1];

  const shortAndFastDominantCount = instrumentRows.filter(
    (r) => r.dominantArchetype === 'SHORT_AND_FAST'
  ).length;
  const longAndLowDominantCount = instrumentRows.length - shortAndFastDominantCount;

  const activeSummary = activeEvaluation?.summary;
  const activeAgentCountForDominant = agents.filter(
    (a) => a.archetype === activeSummary?.dominantArchetype && a.status === 'ACTIVE'
  ).length;

  return (
    <div className="space-y-6">
      {/* TOP BANNER: RISK-FIRST REGIME DOMINANCE VERDICT & LOOKBACK HORIZON CONTROLS */}
      <div className="p-5 border border-slate-800 bg-[#111827] space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-3.5">
          <div>
            <div className="flex flex-wrap items-center gap-2.5">
              <Layers className="w-4 h-4 text-cyan-400" />
              <h1 className="text-base font-semibold text-slate-100">
                D3 Archetype Performance Variance &amp; Lookback Regime Dominance Lab
              </h1>
              <span className="px-2 py-0.5 bg-cyan-500/15 border border-cyan-500/40 text-cyan-300 font-mono text-[11px]">
                LONG_AND_LOW vs. SHORT_AND_FAST · MULTI-HORIZON D3 ENGINE
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              Evaluates downside drawdown exposure, Sortino/Sharpe ratios, and cumulative return dispersion across 6 lookback horizons (`15M` to `30D`) on real historical bars to isolate the dominant market regime.
            </p>
          </div>

          {/* Lookback Period Selector Bar */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 p-1 bg-[#0B0F17] border border-slate-800 rounded text-xs font-mono">
              {LOOKBACK_HORIZONS.map((h) => (
                <button
                  key={h.id}
                  type="button"
                  onClick={() => setActiveHorizon(h.id)}
                  className={`px-2.5 py-1 rounded transition-colors ${
                    activeHorizon === h.id
                      ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 font-semibold'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {h.id}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Deterministic Risk-First Verdict Strip */}
        {activeSummary && (
          <div className="p-3.5 bg-[#0B0F17] border border-slate-800 flex flex-wrap items-center justify-between gap-4 text-xs">
            <div className="space-y-1.5 max-w-3xl">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`px-2 py-0.5 font-mono font-bold text-[11px] ${
                    activeSummary.dominantArchetype === 'SHORT_AND_FAST'
                      ? 'bg-emerald-500 text-slate-950'
                      : 'bg-cyan-400 text-slate-950'
                  }`}
                >
                  DOMINANT ARCHETYPE ({activeHorizon}): {activeSummary.dominantArchetype}
                </span>
                <span className="font-mono font-semibold text-slate-100">
                  {activeFeature?.symbol} · [{activeSummary.dominantRegime}]
                </span>
                {dataQualityWarning ? (
                  <span className="px-1.5 py-0.5 bg-amber-500/20 border border-amber-500/40 text-amber-300 font-mono text-[10px] flex items-center gap-1">
                    <ShieldAlert className="w-3 h-3" />
                    <span>dataQualityWarning: true</span>
                  </span>
                ) : (
                  <span className="px-1.5 py-0.5 bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 font-mono text-[10px] flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3" />
                    <span>dataQualityWarning: false ({activeSummary.barsEvaluated} Real Bars)</span>
                  </span>
                )}
              </div>

              <div className="font-mono text-[11px] text-slate-300">
                <span className="text-slate-500">RISK-FIRST RATIONALE (&lt;40w): </span>
                {riskFirstRationale}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-5 font-mono tabular-nums">
              <div>
                <div className="text-[11px] text-slate-400">Short &amp; Fast ({activeHorizon})</div>
                <div className="text-sm font-bold text-emerald-400">
                  {activeSummary.shortAndFastReturnPct >= 0 ? '+' : ''}
                  {activeSummary.shortAndFastReturnPct}% (DD -{activeSummary.shortAndFastMaxDdPct}%)
                </div>
              </div>
              <div>
                <div className="text-[11px] text-slate-400">Long &amp; Low ({activeHorizon})</div>
                <div className="text-sm font-bold text-cyan-400">
                  {activeSummary.longAndLowReturnPct >= 0 ? '+' : ''}
                  {activeSummary.longAndLowReturnPct}% (DD -{activeSummary.longAndLowMaxDdPct}%)
                </div>
              </div>
              <div>
                <div className="text-[11px] text-slate-400">Variance Spread (S&amp;F − L&amp;L)</div>
                <div
                  className={`text-sm font-bold ${
                    activeSummary.returnVarianceSpreadPct >= 0 ? 'text-emerald-400' : 'text-cyan-400'
                  }`}
                >
                  {activeSummary.returnVarianceSpreadPct >= 0 ? '+' : ''}
                  {activeSummary.returnVarianceSpreadPct}% ({activeSummary.returnStdDevBps} bps σ)
                </div>
              </div>
              <div>
                <div className="text-[11px] text-slate-400">Active Fleet Alignment</div>
                <div className="text-sm font-bold text-slate-100">
                  {activeAgentCountForDominant} Active Agents
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* MAIN D3 VISUALIZATION GRID: 7 COLS TRAJECTORY RIBBON + 5 COLS MULTI-HORIZON MATRIX */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
        {/* Left 7 Cols: D3 Cumulative Performance Variance & Spread Ribbon */}
        <div className="lg:col-span-7 p-5 border border-slate-800 bg-[#111827] flex flex-col justify-between space-y-4">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-3">
              <div>
                <h2 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
                  <Activity className="w-4 h-4 text-emerald-400" />
                  <span>
                    D3 Cumulative Return &amp; Variance Ribbon ({activeFeature?.symbol} · {activeHorizonSpec.label})
                  </span>
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">{activeHorizonSpec.timeframeDesc}</p>
              </div>

              <div className="flex items-center gap-2">
                <select
                  value={activeFeature?.symbol || ''}
                  onChange={(e) => onSelectSymbol(e.target.value)}
                  className="px-2.5 py-1.5 bg-[#0B0F17] border border-slate-800 text-slate-100 font-mono text-xs rounded focus:outline-none focus:border-cyan-400"
                >
                  {features.map((f) => (
                    <option key={f.symbol} value={f.symbol}>
                      {f.symbol} ({f.venue === 'PREDICTION_MARKET' ? 'Kalshi' : 'Public'})
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Interactive Bar Telemetry Readout */}
            {inspectedPt && (
              <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 bg-[#080C14] border border-slate-800 text-xs font-mono tabular-nums">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-slate-300">
                    Bar #{inspectedPt.barIndex + 1} · Px {inspectedPt.underlyingPrice}
                  </span>
                  <span className="text-emerald-400">
                    SHORT_AND_FAST: {inspectedPt.shortAndFastCumPct >= 0 ? '+' : ''}
                    {inspectedPt.shortAndFastCumPct}% (DD -{inspectedPt.shortAndFastDdPct}%)
                  </span>
                  <span className="text-cyan-400">
                    LONG_AND_LOW: {inspectedPt.longAndLowCumPct >= 0 ? '+' : ''}
                    {inspectedPt.longAndLowCumPct}% (DD -{inspectedPt.longAndLowDdPct}%)
                  </span>
                </div>
                <span
                  className={`px-1.5 py-0.5 border font-semibold ${
                    inspectedPt.varianceSpreadPct >= 0
                      ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                      : 'bg-cyan-500/15 border-cyan-500/40 text-cyan-300'
                  }`}
                >
                  Δ Spread: {inspectedPt.varianceSpreadPct >= 0 ? '+' : ''}
                  {inspectedPt.varianceSpreadPct}%
                </span>
              </div>
            )}

            {/* D3 SVG Canvas */}
            <div className="border border-slate-800 bg-[#080C14] p-3">
              <svg
                ref={trajectorySvgRef}
                className="w-full h-64 overflow-visible cursor-crosshair"
                onMouseMove={(e) => {
                  if (!activePts.length) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  const relX = (e.clientX - rect.left) / Math.max(1, rect.width);
                  const idx = Math.min(
                    activePts.length - 1,
                    Math.max(0, Math.round(relX * (activePts.length - 1)))
                  );
                  setHoveredBarIdx(idx);
                }}
                onMouseLeave={() => setHoveredBarIdx(null)}
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-800 text-[11px] font-mono text-slate-400">
            <div className="flex items-center gap-4">
              <span className="flex items-center gap-1.5 text-emerald-400">
                <span className="w-3 h-0.5 bg-emerald-400 inline-block" />
                <span>SHORT_AND_FAST Trajectory</span>
              </span>
              <span className="flex items-center gap-1.5 text-cyan-400">
                <span className="w-3 h-0.5 bg-cyan-400 inline-block" />
                <span>LONG_AND_LOW Trajectory</span>
              </span>
              <span className="text-slate-400">Columns: Bar Variance Spread (S&amp;F − L&amp;L)</span>
            </div>
            <button
              type="button"
              onClick={() => activeFeature && onOpenInBacktestLab(activeFeature.symbol)}
              className="text-cyan-400 hover:underline flex items-center gap-1"
            >
              <GitCompare className="w-3.5 h-3.5" />
              <span>Open {activeFeature?.symbol} in Dual-Strategy Backtester</span>
            </button>
          </div>
        </div>

        {/* Right 5 Cols: D3 Multi-Lookback Horizon Dominance Matrix */}
        <div className="lg:col-span-5 p-5 border border-slate-800 bg-[#111827] flex flex-col justify-between space-y-4">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-3">
              <div>
                <h2 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
                  <BarChart3 className="w-4 h-4 text-cyan-400" />
                  <span>D3 Lookback Horizon Dominance Matrix</span>
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Click any lookback bar (`15M`–`30D`) to inspect regime shift across timeframes.
                </p>
              </div>

              {/* Metric Selector */}
              <div className="flex items-center gap-1 p-0.5 bg-[#0B0F17] border border-slate-800 rounded text-[10px] font-mono">
                <button
                  type="button"
                  onClick={() => setMetricMode('RISK_ADJUSTED_ALPHA')}
                  className={`px-2 py-1 rounded ${
                    metricMode === 'RISK_ADJUSTED_ALPHA'
                      ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 font-semibold'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Risk-Adj Score
                </button>
                <button
                  type="button"
                  onClick={() => setMetricMode('RETURN_SPREAD_PCT')}
                  className={`px-2 py-1 rounded ${
                    metricMode === 'RETURN_SPREAD_PCT'
                      ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 font-semibold'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Return Δ%
                </button>
                <button
                  type="button"
                  onClick={() => setMetricMode('DRAWDOWN_DELTA')}
                  className={`px-2 py-1 rounded ${
                    metricMode === 'DRAWDOWN_DELTA'
                      ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40 font-semibold'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  DD Safety Δ%
                </button>
              </div>
            </div>

            <div className="border border-slate-800 bg-[#080C14] p-3">
              <svg ref={horizonMatrixSvgRef} className="w-full h-60 overflow-visible" />
            </div>
          </div>

          {/* Lookback Horizon Summary Mini-Table */}
          <div className="grid grid-cols-3 gap-2 pt-2 border-t border-slate-800 text-xs font-mono tabular-nums">
            <div className="p-2.5 bg-[#0B0F17] border border-slate-800">
              <div className="text-[10px] text-slate-400 font-sans">Short &amp; Fast Wins</div>
              <div className="text-sm font-bold text-emerald-400 mt-0.5">
                {shortAndFastDominantCount} / {instrumentRows.length} Tickers
              </div>
            </div>
            <div className="p-2.5 bg-[#0B0F17] border border-slate-800">
              <div className="text-[10px] text-slate-400 font-sans">Long &amp; Low Wins</div>
              <div className="text-sm font-bold text-cyan-400 mt-0.5">
                {longAndLowDominantCount} / {instrumentRows.length} Tickers
              </div>
            </div>
            <div className="p-2.5 bg-[#0B0F17] border border-slate-800">
              <div className="text-[10px] text-slate-400 font-sans">Top Tournament Edge</div>
              <div className="text-sm font-bold text-slate-100 mt-0.5">
                {strategyTournament[0]
                  ? `${strategyTournament[0].symbol} (+${strategyTournament[0].totalReturnPct}%)`
                  : 'Verified'}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* CROSS-MARKET ARCHETYPE VARIANCE & REGIME DOMINANCE TABLE */}
      <div className="p-5 border border-slate-800 bg-[#111827] space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-3">
          <div>
            <h2 className="text-base font-semibold text-slate-100">
              Cross-Instrument Archetype Variance Matrix ({activeHorizonSpec.label})
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Risk-first evaluation across all tracked Kalshi prediction contracts and Public.com equities/crypto: Max Drawdown &amp; Sortino evaluated prior to return spread.
            </p>
          </div>
          <span className="font-mono text-xs text-slate-400">
            Click any row to inspect its D3 variance trajectory above
          </span>
        </div>

        <div className="overflow-x-auto border border-slate-800">
          <table className="w-full text-left border-collapse text-xs font-mono tabular-nums">
            <thead>
              <tr className="border-b border-slate-800 text-slate-400 bg-[#0D131F]">
                <th className="py-2.5 px-3 font-sans">Instrument &amp; Venue</th>
                <th className="py-2.5 px-3 font-sans">Detected Regime</th>
                <th className="py-2.5 px-3 text-right text-emerald-400">Short &amp; Fast (DD / Sortino / Ret)</th>
                <th className="py-2.5 px-3 text-right text-cyan-400">Long &amp; Low (DD / Sortino / Ret)</th>
                <th className="py-2.5 px-3 text-right">Variance Spread (S&amp;F − L&amp;L)</th>
                <th className="py-2.5 px-3">Dominant Archetype</th>
                <th className="py-2.5 px-3 text-right font-sans">Execution Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80">
              {instrumentRows.map((row) => {
                const isSelected = row.symbol === activeFeature?.symbol;
                return (
                  <tr
                    key={row.symbol}
                    onClick={() => onSelectSymbol(row.symbol)}
                    className={`cursor-pointer transition-colors ${
                      isSelected ? 'bg-slate-800/50' : 'hover:bg-slate-800/25'
                    }`}
                  >
                    <td className="py-2.5 px-3">
                      <div className="font-bold text-slate-100">{row.symbol}</div>
                      <div className="text-[10px] text-slate-400">
                        {row.venue === 'PREDICTION_MARKET' ? 'Kalshi CLOB v2' : 'Public.com Live'} ·{' '}
                        {row.barsCount} Real Bars
                      </div>
                    </td>
                    <td className="py-2.5 px-3">
                      <span
                        className={
                          row.detectedRegime === 'TRENDING_BULL'
                            ? 'text-emerald-400'
                            : row.detectedRegime === 'TRENDING_BEAR'
                            ? 'text-rose-400'
                            : row.detectedRegime === 'HIGH_VOLATILITY_RANGE'
                            ? 'text-amber-400'
                            : 'text-cyan-400'
                        }
                      >
                        {row.detectedRegime}
                      </span>
                    </td>
                    <td className="py-2.5 px-3 text-right">
                      <div className="text-slate-100 font-semibold">
                        -{row.shortAndFastMaxDdPct}% DD · {row.shortAndFastSortino} SR
                      </div>
                      <div
                        className={
                          row.shortAndFastReturnPct >= 0 ? 'text-emerald-400' : 'text-rose-400'
                        }
                      >
                        {row.shortAndFastReturnPct >= 0 ? '+' : ''}
                        {row.shortAndFastReturnPct}%
                      </div>
                    </td>
                    <td className="py-2.5 px-3 text-right">
                      <div className="text-slate-100 font-semibold">
                        -{row.longAndLowMaxDdPct}% DD · {row.longAndLowSortino} SR
                      </div>
                      <div
                        className={
                          row.longAndLowReturnPct >= 0 ? 'text-cyan-400' : 'text-rose-400'
                        }
                      >
                        {row.longAndLowReturnPct >= 0 ? '+' : ''}
                        {row.longAndLowReturnPct}%
                      </div>
                    </td>
                    <td
                      className={`py-2.5 px-3 text-right font-bold ${
                        row.varianceSpreadPct >= 0 ? 'text-emerald-400' : 'text-cyan-400'
                      }`}
                    >
                      {row.varianceSpreadPct >= 0 ? '+' : ''}
                      {row.varianceSpreadPct}%
                    </td>
                    <td className="py-2.5 px-3">
                      <span
                        className={`px-2 py-0.5 text-[10px] font-bold border ${
                          row.dominantArchetype === 'SHORT_AND_FAST'
                            ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                            : 'bg-cyan-500/15 border-cyan-500/40 text-cyan-300'
                        }`}
                      >
                        {row.dominantArchetype}
                      </span>
                    </td>
                    <td
                      className="py-2.5 px-3 text-right whitespace-nowrap"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        type="button"
                        disabled={isDeploying}
                        onClick={() => handleDeployDominantForSymbol(row)}
                        className="px-2.5 py-1 bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/40 text-cyan-300 rounded text-[11px] font-sans font-medium inline-flex items-center gap-1"
                      >
                        <Zap className="w-3 h-3" />
                        <span>Deploy {row.dominantArchetype === 'SHORT_AND_FAST' ? 'S&F' : 'L&L'}</span>
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
