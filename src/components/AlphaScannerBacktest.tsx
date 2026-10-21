import React, { useEffect, useState, useCallback } from 'react';
import {
  Award,
  Play,
  RefreshCw,
  Zap,
  CheckCircle2,
  GitCompare,
  ShieldAlert,
} from 'lucide-react';
import type {
  AlphaOpportunity,
  BacktestResult,
  ComparativeBacktestResult,
  IndicatorStrategyId,
  MarketFeatureVector,
  MarketRegime,
  StrategyArchetype,
  StrategyTournamentEntry,
} from '../types/quant.ts';
import { StrategyCorrelationMatrix } from './StrategyCorrelationMatrix.tsx';

interface AlphaScannerBacktestProps {
  features: MarketFeatureVector[];
  strategyTournament?: StrategyTournamentEntry[];
  onDeployFromBacktest: (config: {
    name: string;
    archetype: StrategyArchetype;
    targetSymbol: string;
    indicatorStrategyId?: IndicatorStrategyId;
    allocatedCapitalUsd: number;
    maxDrawdownLimitPct: number;
    atrSpikeKillMultiplier: number;
  }) => Promise<void>;
  onDeployBestTournamentStrategy?: () => Promise<void>;
  onDeploy15mHftWinner?: () => Promise<void>;
  onSelectSymbolInMain: (symbol: string) => void;
}

const INDICATOR_OPTIONS: Array<{
  id: IndicatorStrategyId;
  label: string;
  formula: string;
}> = [
  {
    id: 'BTC_LEAD_LAG_SNIPER',
    label: 'Coinbase-to-Kalshi 15m Lead-Lag Sniper ($0.45–$0.82 Fee Gate + Black-Scholes d2)',
    formula: 'Ask in [$0.45, $0.82] ONLY + Black-Scholes N(d2) Net Edge > +$0.04 after $0.02 Fee + Max 25 Contracts ($18 Cap)',
  },
  {
    id: 'HFT_15M_CLOB_MICRO_SCALPER',
    label: '15m HFT CLOB Micro-Imbalance & Tape Velocity Scalper',
    formula: 'Tick Price > 15m Micro-VWAP + L2 Yes/No Depth Imbalance > +0.18 + 3-Tick Impulse',
  },
  {
    id: 'HFT_15M_GAMMA_CONVERGENCE',
    label: '15m Expiry Gamma Convergence & Strike Pinning Scalper',
    formula: 'Implied Prob > 0.60 (or < 0.40) + 9/21 Micro-EMA Alignment + Low Spread (< 20 bps)',
  },
  {
    id: 'HFT_15M_VWAP_SNAPBACK',
    label: '15m Probability Exhaustion & Micro-VWAP Snapback',
    formula: 'Micro-RSI(14) Excursion + Bollinger %B Reversion to 15m Trade-Tape VWAP',
  },
  {
    id: 'EMA_VWAP_VELOCITY',
    label: '9/21 EMA Velocity + Anchored VWAP + L2 Imbalance',
    formula: 'EMA(9) > EMA(21) AND Close > VWAP AND RSI(14) in [48, 75]',
  },
  {
    id: 'MACD_RVOL_MOMENTUM',
    label: 'MACD(12,26,9) Histogram Impulse + RVOL Surge',
    formula: 'MACD_Hist(12,26,9) > 0 AND RVOL(20) >= 1.10x AND EMA(9) >= EMA(21)',
  },
  {
    id: 'BB_SQUEEZE_BREAKOUT',
    label: 'Bollinger Band(20,2σ) Squeeze + 50/200 SMA Trend',
    formula: 'BB_%B > 0.52 after Bandwidth Compression OR Mid-Band Support',
  },
  {
    id: 'RSI_ATR_MEAN_REVERSION',
    label: 'Wilder RSI(14) Value Accumulation + ATR Compression',
    formula: 'RSI(14) <= 46 AND ATR_Mult < 1.35x AND Price near Lower BB Support',
  },
  {
    id: 'STOCH_RSI_OBV_SCALPER',
    label: 'Stochastic RSI(14) Cross + Volume Breakout Scalper',
    formula: 'StochRSI(14) crosses > 55 with positive bar return & volume flow',
  },
  {
    id: 'KALSHI_CLOB_IMBALANCE',
    label: 'Kalshi CLOB Orderbook Depth & Implied Prob Momentum',
    formula: 'Implied Prob > Trade-Tape VWAP + CLOB Bid Depth Imbalance > +0.20',
  },
];

export const AlphaScannerBacktest: React.FC<AlphaScannerBacktestProps> = ({
  features,
  strategyTournament: initialTournament = [],
  onDeployFromBacktest,
  onDeployBestTournamentStrategy,
  onDeploy15mHftWinner,
  onSelectSymbolInMain,
}) => {
  const [opportunities, setOpportunities] = useState<AlphaOpportunity[]>([]);
  const [tournament, setTournament] = useState<StrategyTournamentEntry[]>(initialTournament);
  const [tournamentFilter, setTournamentFilter] = useState<'ALL' | 'HFT_15M_ONLY'>('HFT_15M_ONLY');
  const [scannerFilter, setScannerFilter] = useState<'ALL' | 'LONG_AND_LOW' | 'SHORT_AND_FAST'>('ALL');
  const [isScanning, setIsScanning] = useState<boolean>(false);
  const [isDeployingBest, setIsDeployingBest] = useState<boolean>(false);
  const [isDeploying15mHft, setIsDeploying15mHft] = useState<boolean>(false);

  // Backtest configuration state (defaults to 15m HFT Prediction Market KXBTC15M & BTC Lead-Lag Sniper)
  const [backtestMode, setBacktestMode] = useState<'COMPARATIVE_OVERLAY' | 'SINGLE_STRATEGY'>('COMPARATIVE_OVERLAY');
  const [btSymbol, setBtSymbol] = useState<string>('KXBTC15M');
  const [btArchetype, setBtArchetype] = useState<StrategyArchetype>('SHORT_AND_FAST');
  const [btIndicatorId, setBtIndicatorId] = useState<IndicatorStrategyId>('BTC_LEAD_LAG_SNIPER');
  const [btStrategyBId, setBtStrategyBId] = useState<IndicatorStrategyId>('HFT_15M_CLOB_MICRO_SCALPER');
  const [btCapital, setBtCapital] = useState<number>(1000);
  const [btRsiLow, setBtRsiLow] = useState<number>(42);
  const [btRsiHigh, setBtRsiHigh] = useState<number>(78);
  const [btStopAtr, setBtStopAtr] = useState<number>(0.9);
  const [btTpAtr, setBtTpAtr] = useState<number>(2.5);
  const [btKillAtr, setBtKillAtr] = useState<number>(2.3);

  const [backtestResult, setBacktestResult] = useState<BacktestResult | null>(null);
  const [comparativeResult, setComparativeResult] = useState<ComparativeBacktestResult | null>(null);
  const [hoveredCompIdx, setHoveredCompIdx] = useState<number | null>(null);
  const [activeTradeLedgerSlot, setActiveTradeLedgerSlot] = useState<'STRATEGY_A' | 'STRATEGY_B'>('STRATEGY_A');
  const [isRunningBacktest, setIsRunningBacktest] = useState<boolean>(false);
  const [isDeploying, setIsDeploying] = useState<boolean>(false);

  useEffect(() => {
    if (initialTournament.length > 0) {
      setTournament(initialTournament);
    }
  }, [initialTournament]);

  const runMarketScan = useCallback(async () => {
    setIsScanning(true);
    try {
      const res = await fetch('/api/scanner/scan');
      if (res.ok) {
        const data = await res.json();
        setOpportunities(data.opportunities || []);
        if (Array.isArray(data.strategyTournament) && data.strategyTournament.length > 0) {
          setTournament(data.strategyTournament);
        }
      }
    } finally {
      setIsScanning(false);
    }
  }, []);

  const runBacktestSimulation = useCallback(
    async (overrideParams?: {
      symbol?: string;
      archetype?: StrategyArchetype;
      indicatorStrategyId?: IndicatorStrategyId;
      rsiLow?: number;
      rsiHigh?: number;
      stopAtr?: number;
      tpAtr?: number;
      killAtr?: number;
    }) => {
      setIsRunningBacktest(true);
      const symbolToRun = overrideParams?.symbol ?? btSymbol;
      const archetypeToRun = overrideParams?.archetype ?? btArchetype;
      const stratAToRun = overrideParams?.indicatorStrategyId ?? btIndicatorId;
      const stratBToRun =
        (overrideParams as { strategyBId?: IndicatorStrategyId } | undefined)?.strategyBId ??
        btStrategyBId;
      const rsiLowToRun = overrideParams?.rsiLow ?? btRsiLow;
      const rsiHighToRun = overrideParams?.rsiHigh ?? btRsiHigh;
      const stopAtrToRun = overrideParams?.stopAtr ?? btStopAtr;
      const tpAtrToRun = overrideParams?.tpAtr ?? btTpAtr;
      const killAtrToRun = overrideParams?.killAtr ?? btKillAtr;

      try {
        const singlePayload = {
          symbol: symbolToRun,
          archetype: archetypeToRun,
          indicatorStrategyId: stratAToRun,
          initialCapitalUsd: btCapital,
          rsiEntryLow: rsiLowToRun,
          rsiEntryHigh: rsiHighToRun,
          stopLossAtrMultiple: stopAtrToRun,
          takeProfitAtrMultiple: tpAtrToRun,
          atrKillMultiplier: killAtrToRun,
        };
        const comparePayload = {
          symbol: symbolToRun,
          archetype: archetypeToRun,
          strategyAId: stratAToRun,
          strategyBId: stratBToRun,
          initialCapitalUsd: btCapital,
          rsiEntryLow: rsiLowToRun,
          rsiEntryHigh: rsiHighToRun,
          stopLossAtrMultiple: stopAtrToRun,
          takeProfitAtrMultiple: tpAtrToRun,
          atrKillMultiplier: killAtrToRun,
        };

        const [singleRes, compRes] = await Promise.all([
          fetch('/api/backtest/run', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(singlePayload),
          }),
          fetch('/api/backtest/compare', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(comparePayload),
          }),
        ]);

        if (singleRes.ok) {
          const data: BacktestResult = await singleRes.json();
          setBacktestResult(data);
        }
        if (compRes.ok) {
          const compData: ComparativeBacktestResult = await compRes.json();
          setComparativeResult(compData);
          setActiveTradeLedgerSlot(compData.winnerSlot);
        }
      } finally {
        setIsRunningBacktest(false);
      }
    },
    [
      btSymbol,
      btArchetype,
      btIndicatorId,
      btStrategyBId,
      btCapital,
      btRsiLow,
      btRsiHigh,
      btStopAtr,
      btTpAtr,
      btKillAtr,
    ]
  );

  useEffect(() => {
    runMarketScan();
    runBacktestSimulation();
  }, [runMarketScan, runBacktestSimulation]);

  const handleLoadTournamentEntry = (entry: StrategyTournamentEntry) => {
    setBtSymbol(entry.symbol);
    setBtArchetype(entry.archetype);
    setBtIndicatorId(entry.indicatorStrategyId);
    setBtStopAtr(entry.recommendedStopAtr);
    setBtTpAtr(entry.recommendedTakeProfitAtr);
    onSelectSymbolInMain(entry.symbol);

    const nextRsiLow = entry.archetype === 'LONG_AND_LOW' ? 25 : 42;
    const nextRsiHigh = entry.archetype === 'LONG_AND_LOW' ? 58 : 78;
    const nextKillAtr = entry.archetype === 'LONG_AND_LOW' ? 2.6 : 2.3;

    setBtRsiLow(nextRsiLow);
    setBtRsiHigh(nextRsiHigh);
    setBtKillAtr(nextKillAtr);

    runBacktestSimulation({
      symbol: entry.symbol,
      archetype: entry.archetype,
      indicatorStrategyId: entry.indicatorStrategyId,
      rsiLow: nextRsiLow,
      rsiHigh: nextRsiHigh,
      stopAtr: entry.recommendedStopAtr,
      tpAtr: entry.recommendedTakeProfitAtr,
      killAtr: nextKillAtr,
    });
  };

  const handleLoadOpportunityIntoBacktest = (opp: AlphaOpportunity) => {
    const is15m = opp.symbol.includes('15M');
    const defaultInd: IndicatorStrategyId = is15m
      ? 'HFT_15M_CLOB_MICRO_SCALPER'
      : opp.venue === 'PREDICTION_MARKET'
      ? 'KALSHI_CLOB_IMBALANCE'
      : opp.recommendedArchetype === 'LONG_AND_LOW'
      ? 'BB_SQUEEZE_BREAKOUT'
      : 'EMA_VWAP_VELOCITY';

    setBtSymbol(opp.symbol);
    setBtArchetype(opp.recommendedArchetype);
    setBtIndicatorId(defaultInd);
    onSelectSymbolInMain(opp.symbol);

    const nextRsiLow = opp.recommendedArchetype === 'LONG_AND_LOW' ? 26 : 42;
    const nextRsiHigh = opp.recommendedArchetype === 'LONG_AND_LOW' ? 58 : 78;
    const nextStopAtr = is15m ? 1.0 : opp.recommendedArchetype === 'LONG_AND_LOW' ? 2.2 : 1.2;
    const nextTpAtr = is15m ? 2.2 : opp.recommendedArchetype === 'LONG_AND_LOW' ? 4.2 : 2.6;
    const nextKillAtr = opp.recommendedArchetype === 'LONG_AND_LOW' ? 2.6 : 2.3;

    setBtRsiLow(nextRsiLow);
    setBtRsiHigh(nextRsiHigh);
    setBtStopAtr(nextStopAtr);
    setBtTpAtr(nextTpAtr);
    setBtKillAtr(nextKillAtr);

    runBacktestSimulation({
      symbol: opp.symbol,
      archetype: opp.recommendedArchetype,
      indicatorStrategyId: defaultInd,
      rsiLow: nextRsiLow,
      rsiHigh: nextRsiHigh,
      stopAtr: nextStopAtr,
      tpAtr: nextTpAtr,
      killAtr: nextKillAtr,
    });
  };

  const handleDeployValidatedAgent = async (overrideStrategyId?: IndicatorStrategyId) => {
    const targetStratId =
      overrideStrategyId ||
      (backtestMode === 'COMPARATIVE_OVERLAY' && comparativeResult
        ? comparativeResult.winnerStrategyId
        : btIndicatorId);
    setIsDeploying(true);
    try {
      const indLabel =
        INDICATOR_OPTIONS.find((o) => o.id === targetStratId)?.label || targetStratId;
      await onDeployFromBacktest({
        name: `${btSymbol} · ${indLabel}`,
        archetype: btArchetype,
        targetSymbol: btSymbol,
        indicatorStrategyId: targetStratId,
        allocatedCapitalUsd: Math.min(250, btCapital),
        maxDrawdownLimitPct: btArchetype === 'LONG_AND_LOW' ? 3.5 : 1.5,
        atrSpikeKillMultiplier: btKillAtr,
      });
    } finally {
      setIsDeploying(false);
    }
  };

  const handleRunBestWinnerAndDiversify = async () => {
    if (!onDeployBestTournamentStrategy) return;
    setIsDeployingBest(true);
    try {
      await onDeployBestTournamentStrategy();
      if (tournament[0]) {
        handleLoadTournamentEntry(tournament[0]);
      }
    } finally {
      setIsDeployingBest(false);
    }
  };

  const handleRun15mHftWinnerAndDeploy = async () => {
    if (!onDeploy15mHftWinner) return;
    setIsDeploying15mHft(true);
    try {
      await onDeploy15mHftWinner();
      const top15m = tournament.find((t) => t.is15MinPrediction || t.symbol.includes('15M'));
      if (top15m) {
        handleLoadTournamentEntry(top15m);
      }
    } finally {
      setIsDeploying15mHft(false);
    }
  };

  const formatRegimeColor = (regime: MarketRegime) => {
    switch (regime) {
      case 'TRENDING_BULL':
        return 'text-emerald-400';
      case 'TRENDING_BEAR':
        return 'text-rose-400';
      case 'HIGH_VOLATILITY_RANGE':
        return 'text-amber-400';
      case 'LOW_VOLATILITY_COMPRESSION':
        return 'text-cyan-400';
    }
  };

  const filteredOpportunities = opportunities.filter((opp) => {
    if (scannerFilter === 'ALL') return true;
    return opp.recommendedArchetype === scannerFilter;
  });

  const fifteenMinFeatures = features.filter(
    (f) => f.is15MinPrediction || f.symbol.includes('15M')
  );
  const hft15mTournament = tournament.filter(
    (t) => t.is15MinPrediction || t.symbol.includes('15M')
  );
  const top15mWinner = hft15mTournament[0] || tournament[0];
  const displayedTournament =
    tournamentFilter === 'HFT_15M_ONLY' && hft15mTournament.length > 0
      ? hft15mTournament
      : tournament;
  const activeWinner =
    tournamentFilter === 'HFT_15M_ONLY' && top15mWinner ? top15mWinner : tournament[0];

  // Render SVG Equity Curve & Drawdown Chart
  const renderEquityCurveSvg = () => {
    if (!backtestResult || backtestResult.equityCurve.length === 0) return null;
    const pts = backtestResult.equityCurve;
    const width = 720;
    const height = 220;
    const padL = 14;
    const padR = 72;
    const padT = 18;
    const padB = 24;
    const plotW = width - padL - padR;
    const plotH = height - padT - padB;

    const allEquities = [
      ...pts.map((p) => p.strategyEquity),
      ...pts.map((p) => p.benchmarkEquity),
    ];
    const minEq = Math.min(...allEquities) * 0.992;
    const maxEq = Math.max(...allEquities) * 1.008;
    const eqRange = Math.max(1, maxEq - minEq);

    const toX = (idx: number) => padL + (idx / Math.max(1, pts.length - 1)) * plotW;
    const toY = (val: number) => padT + plotH - ((val - minEq) / eqRange) * plotH;

    const stratPolyline = pts
      .map((p, i) => `${toX(i).toFixed(1)},${toY(p.strategyEquity).toFixed(1)}`)
      .join(' ');
    const benchPolyline = pts
      .map((p, i) => `${toX(i).toFixed(1)},${toY(p.benchmarkEquity).toFixed(1)}`)
      .join(' ');

    const areaPolygon = `${toX(0).toFixed(1)},${(padT + plotH).toFixed(1)} ${stratPolyline} ${toX(
      pts.length - 1
    ).toFixed(1)},${(padT + plotH).toFixed(1)}`;

    return (
      <div className="border border-slate-800 bg-[#080C14] p-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-slate-200 font-medium">
              {backtestResult.symbol} · {backtestResult.indicatorStrategyLabel || btIndicatorId} ({backtestResult.barsTested} Real Bars)
            </span>
            <span className="px-1.5 py-0.5 bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 font-mono text-[10px]">
              {backtestResult.dataSource || 'REAL MARKET BARS · NO SYNTHETIC'}
            </span>
            <span className="font-mono text-cyan-400">
              Strategy: ${backtestResult.finalEquityUsd.toLocaleString()} (
              {backtestResult.totalReturnPct >= 0 ? '+' : ''}
              {backtestResult.totalReturnPct}%)
            </span>
            <span className="font-mono text-slate-400">
              Benchmark: ${backtestResult.benchmarkFinalEquityUsd.toLocaleString()} (
              {backtestResult.benchmarkReturnPct >= 0 ? '+' : ''}
              {backtestResult.benchmarkReturnPct}%)
            </span>
          </div>
          <span className="font-mono text-emerald-400 font-semibold">
            Net Alpha: {backtestResult.netAlphaPct >= 0 ? '+' : ''}
            {backtestResult.netAlphaPct}%
          </span>
        </div>

        <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-52 overflow-visible">
          {[0.2, 0.5, 0.8].map((r) => {
            const y = padT + plotH * r;
            const val = maxEq - r * eqRange;
            return (
              <g key={r}>
                <line
                  x1={padL}
                  y1={y}
                  x2={width - padR}
                  y2={y}
                  stroke="#1E293B"
                  strokeDasharray="2 4"
                  strokeWidth="1"
                />
                <text
                  x={width - padR + 6}
                  y={y + 3}
                  fill="#64748B"
                  fontSize="10"
                  fontFamily="JetBrains Mono, monospace"
                >
                  ${Math.round(val).toLocaleString()}
                </text>
              </g>
            );
          })}

          <polygon points={areaPolygon} fill="rgba(6, 182, 212, 0.09)" />

          <polyline
            fill="none"
            stroke="#64748B"
            strokeWidth="1.5"
            strokeDasharray="3 3"
            points={benchPolyline}
          />

          <polyline fill="none" stroke="#06B6D4" strokeWidth="2.2" points={stratPolyline} />
        </svg>
      </div>
    );
  };

  // Render Dual-Strategy Comparative Equity Curve + Underwater Drawdown Overlay SVG
  const renderComparativeEquityCurveSvg = () => {
    if (!comparativeResult || comparativeResult.equityCurve.length === 0) return null;
    const pts = comparativeResult.equityCurve;
    const width = 740;
    const eqHeight = 225;
    const ddHeight = 84;
    const padL = 14;
    const padR = 76;
    const padT = 18;
    const padB = 22;
    const plotW = width - padL - padR;
    const plotH = eqHeight - padT - padB;

    const allEquities = [
      ...pts.map((p) => p.strategyAEquity),
      ...pts.map((p) => p.strategyBEquity),
      ...pts.map((p) => p.benchmarkEquity),
    ];
    const minEq = Math.min(...allEquities) * 0.992;
    const maxEq = Math.max(...allEquities) * 1.008;
    const eqRange = Math.max(1, maxEq - minEq);

    const maxDd = Math.max(
      1.5,
      ...pts.map((p) => Math.max(p.strategyADrawdownPct, p.strategyBDrawdownPct))
    );

    const toX = (idx: number) => padL + (idx / Math.max(1, pts.length - 1)) * plotW;
    const toY = (val: number) => padT + plotH - ((val - minEq) / eqRange) * plotH;

    const ddPadT = 8;
    const ddPadB = 16;
    const ddPlotH = ddHeight - ddPadT - ddPadB;
    const toDdY = (ddPct: number) => ddPadT + (Math.min(maxDd, Math.max(0, ddPct)) / maxDd) * ddPlotH;

    const stratAPolyline = pts
      .map((p, i) => `${toX(i).toFixed(1)},${toY(p.strategyAEquity).toFixed(1)}`)
      .join(' ');
    const stratBPolyline = pts
      .map((p, i) => `${toX(i).toFixed(1)},${toY(p.strategyBEquity).toFixed(1)}`)
      .join(' ');
    const benchPolyline = pts
      .map((p, i) => `${toX(i).toFixed(1)},${toY(p.benchmarkEquity).toFixed(1)}`)
      .join(' ');

    const stratAArea = `${toX(0).toFixed(1)},${(padT + plotH).toFixed(1)} ${stratAPolyline} ${toX(
      pts.length - 1
    ).toFixed(1)},${(padT + plotH).toFixed(1)}`;
    const stratBArea = `${toX(0).toFixed(1)},${(padT + plotH).toFixed(1)} ${stratBPolyline} ${toX(
      pts.length - 1
    ).toFixed(1)},${(padT + plotH).toFixed(1)}`;

    const ddAPolyline = pts
      .map((p, i) => `${toX(i).toFixed(1)},${toDdY(p.strategyADrawdownPct).toFixed(1)}`)
      .join(' ');
    const ddBPolyline = pts
      .map((p, i) => `${toX(i).toFixed(1)},${toDdY(p.strategyBDrawdownPct).toFixed(1)}`)
      .join(' ');

    const activeIdx =
      hoveredCompIdx !== null && hoveredCompIdx >= 0 && hoveredCompIdx < pts.length
        ? hoveredCompIdx
        : pts.length - 1;
    const activePt = pts[activeIdx];
    const activeX = toX(activeIdx);

    return (
      <div className="border border-slate-800 bg-[#080C14] p-3 space-y-2.5">
        {/* Legend & Live Bar Crosshair Telemetry Header */}
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs border-b border-slate-800/80 pb-2">
          <div className="flex flex-wrap items-center gap-3 font-mono tabular-nums">
            <span className="text-slate-100 font-semibold font-sans">
              {comparativeResult.symbol} Overlay ({comparativeResult.barsTested} Real Bars)
            </span>
            <span className="flex items-center gap-1.5 text-cyan-400">
              <span className="w-2.5 h-0.5 bg-cyan-400 inline-block" />
              <span>
                A ({comparativeResult.strategyA.indicatorStrategyId}): $
                {activePt.strategyAEquity.toLocaleString()} (
                {comparativeResult.strategyA.totalReturnPct >= 0 ? '+' : ''}
                {comparativeResult.strategyA.totalReturnPct}%)
              </span>
            </span>
            <span className="flex items-center gap-1.5 text-amber-400">
              <span className="w-2.5 h-0.5 bg-amber-400 inline-block" />
              <span>
                B ({comparativeResult.strategyB.indicatorStrategyId}): $
                {activePt.strategyBEquity.toLocaleString()} (
                {comparativeResult.strategyB.totalReturnPct >= 0 ? '+' : ''}
                {comparativeResult.strategyB.totalReturnPct}%)
              </span>
            </span>
            <span className="flex items-center gap-1.5 text-slate-400">
              <span className="w-2.5 h-0.5 bg-slate-500 inline-block" />
              <span>Bench: ${activePt.benchmarkEquity.toLocaleString()}</span>
            </span>
          </div>

          <div className="flex items-center gap-2 font-mono tabular-nums text-[11px]">
            <span className="text-slate-400">
              Bar #{activePt.barIndex + 1} ·Px {activePt.underlyingPrice}
            </span>
            <span
              className={`px-1.5 py-0.5 border font-semibold ${
                activePt.equitySpreadUsd >= 0
                  ? 'bg-cyan-500/15 border-cyan-500/40 text-cyan-300'
                  : 'bg-amber-500/15 border-amber-500/40 text-amber-300'
              }`}
            >
              Spread (A−B): {activePt.equitySpreadUsd >= 0 ? '+' : ''}$
              {activePt.equitySpreadUsd.toFixed(2)}
            </span>
          </div>
        </div>

        {/* Main Overlaid Historical Equity Curve SVG */}
        <svg
          viewBox={`0 0 ${width} ${eqHeight}`}
          className="w-full h-52 overflow-visible cursor-crosshair"
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const relX = ((e.clientX - rect.left) / Math.max(1, rect.width)) * width;
            const ratio = Math.max(0, Math.min(1, (relX - padL) / Math.max(1, plotW)));
            const idx = Math.round(ratio * (pts.length - 1));
            setHoveredCompIdx(idx);
          }}
          onMouseLeave={() => setHoveredCompIdx(null)}
        >
          {[0.15, 0.5, 0.85].map((r) => {
            const y = padT + plotH * r;
            const val = maxEq - r * eqRange;
            return (
              <g key={r}>
                <line
                  x1={padL}
                  y1={y}
                  x2={width - padR}
                  y2={y}
                  stroke="#1E293B"
                  strokeDasharray="2 4"
                  strokeWidth="1"
                />
                <text
                  x={width - padR + 6}
                  y={y + 3}
                  fill="#64748B"
                  fontSize="10"
                  fontFamily="JetBrains Mono, monospace"
                >
                  ${Math.round(val).toLocaleString()}
                </text>
              </g>
            );
          })}

          {/* Area fills */}
          <polygon points={stratAArea} fill="rgba(6, 182, 212, 0.08)" />
          <polygon points={stratBArea} fill="rgba(245, 158, 11, 0.06)" />

          {/* Benchmark Dashed Line */}
          <polyline
            fill="none"
            stroke="#64748B"
            strokeWidth="1.4"
            strokeDasharray="3 3"
            points={benchPolyline}
          />

          {/* Strategy B Equity Curve (Amber) */}
          <polyline fill="none" stroke="#F59E0B" strokeWidth="2.1" points={stratBPolyline} />

          {/* Strategy A Equity Curve (Cyan) */}
          <polyline fill="none" stroke="#06B6D4" strokeWidth="2.3" points={stratAPolyline} />

          {/* Interactive Crosshair & Equity Markers */}
          <line
            x1={activeX}
            y1={padT}
            x2={activeX}
            y2={padT + plotH}
            stroke="#475569"
            strokeDasharray="2 2"
            strokeWidth="1"
          />
          <circle
            cx={activeX}
            cy={toY(activePt.strategyAEquity)}
            r="3.5"
            fill="#06B6D4"
            stroke="#080C14"
            strokeWidth="1.5"
          />
          <circle
            cx={activeX}
            cy={toY(activePt.strategyBEquity)}
            r="3.5"
            fill="#F59E0B"
            stroke="#080C14"
            strokeWidth="1.5"
          />
        </svg>

        {/* Underwater Drawdown Comparison Sub-Chart (Risk-First Downside Exposure) */}
        <div className="pt-1 border-t border-slate-800/80">
          <div className="flex items-center justify-between text-[10px] font-mono tabular-nums text-slate-400 mb-1">
            <span>
              RISK-FIRST UNDERWATER DRAWDOWN OVERLAY (MAX ALLOWED CAP: -
              {comparativeResult.riskFirstVerdict.maxAllowedDrawdownPct}%)
            </span>
            <div className="flex items-center gap-3">
              <span className="text-cyan-400">
                Strat A Bar DD: -{activePt.strategyADrawdownPct.toFixed(2)}% (Max -
                {comparativeResult.strategyA.maxDrawdownPct}%)
              </span>
              <span className="text-amber-400">
                Strat B Bar DD: -{activePt.strategyBDrawdownPct.toFixed(2)}% (Max -
                {comparativeResult.strategyB.maxDrawdownPct}%)
              </span>
            </div>
          </div>

          <svg viewBox={`0 0 ${width} ${ddHeight}`} className="w-full h-16 overflow-visible">
            <line
              x1={padL}
              y1={ddPadT}
              x2={width - padR}
              y2={ddPadT}
              stroke="#1E293B"
              strokeWidth="1"
            />
            <line
              x1={padL}
              y1={ddPadT + ddPlotH}
              x2={width - padR}
              y2={ddPadT + ddPlotH}
              stroke="#334155"
              strokeDasharray="2 4"
              strokeWidth="1"
            />
            <text
              x={width - padR + 6}
              y={ddPadT + 4}
              fill="#64748B"
              fontSize="9"
              fontFamily="JetBrains Mono, monospace"
            >
              0.0%
            </text>
            <text
              x={width - padR + 6}
              y={ddPadT + ddPlotH + 3}
              fill="#F87171"
              fontSize="9"
              fontFamily="JetBrains Mono, monospace"
            >
              -{maxDd.toFixed(1)}%
            </text>

            <polyline fill="none" stroke="#F59E0B" strokeWidth="1.6" points={ddBPolyline} />
            <polyline fill="none" stroke="#06B6D4" strokeWidth="1.8" points={ddAPolyline} />
          </svg>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      {/* SECTION 0A: LIVE 15-MINUTE HIGH-FREQUENCY KALSHI PREDICTION MARKET LAB */}
      {fifteenMinFeatures.length > 0 && (
        <div className="p-5 border border-cyan-500/40 bg-[#0B121E] space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-3.5">
            <div>
              <div className="flex items-center gap-2">
                <Zap className="w-4 h-4 text-cyan-400" />
                <h2 className="text-base font-semibold text-slate-100">
                  High-Frequency 15-Minute Prediction Market Desk (Live Kalshi `fifteen_min` CLOB Series)
                </h2>
                <span className="px-2 py-0.5 bg-cyan-500/15 border border-cyan-500/40 text-cyan-300 font-mono text-[11px]">
                  SUB-SECOND TRADE TAPE · 15M ROLLING EXPIRY
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-1">
                Tracks live rolling 15-minute binary contracts (`KXBTC15M`, `KXETH15M`, `KXSOL15M`, `KXXRP15M`, `KXDOGE15M`), sub-minute CLOB micro-bars, target strike prices, and backtests HFT scalping formulas to find the #1 top strategy.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {onDeploy15mHftWinner && top15mWinner && (
                <button
                  type="button"
                  onClick={handleRun15mHftWinnerAndDeploy}
                  disabled={isDeploying15mHft}
                  className="px-4 py-2 bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold text-xs rounded transition-colors flex items-center gap-2 whitespace-nowrap"
                >
                  <Zap className="w-4 h-4" />
                  <span>
                    {isDeploying15mHft
                      ? 'Deploying #1 15m HFT Strategy...'
                      : `Deploy #1 15m HFT Winner (${top15mWinner.symbol} · +${top15mWinner.totalReturnPct}%) & Launch 15m Fleet`}
                  </span>
                </button>
              )}
            </div>
          </div>

          {/* 5 Live 15-Minute Kalshi Series Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
            {fifteenMinFeatures.map((f) => {
              const isSelected = btSymbol === f.symbol;
              const bestStratFor15m =
                hft15mTournament.find((t) => t.symbol === f.symbol) || top15mWinner;
              const minsLeft = Math.max(1, Math.round((f.secondsToExpiry ?? 420) / 60));
              return (
                <div
                  key={f.symbol}
                  className={`p-3 border transition-colors flex flex-col justify-between gap-2.5 text-xs ${
                    isSelected
                      ? 'border-cyan-400 bg-cyan-950/20'
                      : 'border-slate-800 bg-[#080C14] hover:border-slate-700'
                  }`}
                >
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="font-mono font-bold text-slate-100">{f.symbol}</span>
                      <span className="font-mono font-bold text-emerald-400 text-sm">
                        {(f.price * 100).toFixed(1)}¢ YES
                      </span>
                    </div>
                    <div className="font-mono text-[10px] text-cyan-300 truncate">
                      {f.activeContractTicker || `${f.symbol}-LIVE`}
                    </div>
                    <div className="font-mono text-[11px] text-amber-300 truncate">
                      {f.targetStrikeLabel || 'Rolling 15m Strike'}
                    </div>
                    <div className="flex items-center justify-between text-[10px] font-mono text-slate-400 pt-1 border-t border-slate-800/80">
                      <span>Vol: {f.volume24h.toLocaleString()}</span>
                      <span>{f.tradesPerMinute ?? 65} trades/m</span>
                    </div>
                    <div className="flex items-center justify-between text-[10px] font-mono text-slate-400">
                      <span>L2 Imb: {f.orderbookImbalance >= 0 ? '+' : ''}{f.orderbookImbalance}</span>
                      <span className="text-cyan-400">{minsLeft}m to settle</span>
                    </div>
                    {f.recentSettlements && f.recentSettlements.length > 0 && (
                      <div className="flex items-center justify-between pt-1">
                        <span className="text-[10px] text-slate-400">Last 4 (15m):</span>
                        <div className="flex items-center gap-1">
                          {f.recentSettlements.map((res, rIdx) => (
                            <span
                              key={`${f.symbol}-settle-${rIdx}`}
                              className={`px-1 py-0.2 font-mono text-[9px] font-bold ${
                                res === 'YES'
                                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                                  : 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
                              }`}
                            >
                              {res}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  <button
                    type="button"
                    onClick={() => {
                      if (bestStratFor15m) {
                        handleLoadTournamentEntry(bestStratFor15m);
                      } else {
                        setBtSymbol(f.symbol);
                        setBtIndicatorId('HFT_15M_CLOB_MICRO_SCALPER');
                        runBacktestSimulation({
                          symbol: f.symbol,
                          archetype: 'SHORT_AND_FAST',
                          indicatorStrategyId: 'HFT_15M_CLOB_MICRO_SCALPER',
                        });
                      }
                    }}
                    className="w-full py-1.5 px-2 bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/40 text-cyan-300 font-mono text-[11px] rounded transition-colors"
                  >
                    Backtest Top 15m HFT ({bestStratFor15m ? `+${bestStratFor15m.totalReturnPct}%` : 'Run'})
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* SECTION 0B: REAL-DATA STRATEGY TOURNAMENT WINNER & MULTI-INDICATOR LEADERBOARD */}
      {tournament.length > 0 && (
        <div className="p-5 border border-emerald-500/40 bg-[#0D1520] space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-3.5">
            <div>
              <div className="flex items-center gap-2">
                <Award className="w-4 h-4 text-emerald-400" />
                <h2 className="text-base font-semibold text-slate-100">
                  Real-Data Strategy Tournament &amp; Top 15-Minute HFT Finder (Zero Synthetic Bars)
                </h2>
                <span className="px-2 py-0.5 bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 font-mono text-[11px]">
                  100% REAL OHLCV &amp; KALSHI 15M CLOB TRADE TAPE
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-1">
                Backtests 9 quantitative &amp; HFT indicator formulas across all live 15-minute Kalshi prediction markets and Public.com tickers to rank and deploy the #1 highest-returning strategy.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1 p-1 bg-[#080C14] border border-slate-800 rounded text-xs">
                <button
                  type="button"
                  onClick={() => setTournamentFilter('HFT_15M_ONLY')}
                  className={`px-2.5 py-1 rounded transition-colors whitespace-nowrap ${
                    tournamentFilter === 'HFT_15M_ONLY'
                      ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 font-semibold'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  15m HFT Prediction Markets ({hft15mTournament.length})
                </button>
                <button
                  type="button"
                  onClick={() => setTournamentFilter('ALL')}
                  className={`px-2.5 py-1 rounded transition-colors whitespace-nowrap ${
                    tournamentFilter === 'ALL'
                      ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 font-semibold'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  All Venues ({tournament.length})
                </button>
              </div>

              {onDeployBestTournamentStrategy && (
                <button
                  type="button"
                  onClick={handleRunBestWinnerAndDiversify}
                  disabled={isDeployingBest}
                  className="px-3.5 py-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold text-xs rounded transition-colors flex items-center gap-1.5 whitespace-nowrap"
                >
                  <Zap className="w-4 h-4" />
                  <span>
                    {isDeployingBest
                      ? 'Deploying #1 Strategy...'
                      : `Run Overall #1 & Diversify All Agents`}
                  </span>
                </button>
              )}
            </div>
          </div>

          {activeWinner && (
            <div className="p-3.5 bg-[#080C14] border border-emerald-500/30 flex flex-wrap items-center justify-between gap-4 text-xs">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="px-2 py-0.5 bg-emerald-500 text-slate-950 font-mono font-bold text-[11px]">
                    {tournamentFilter === 'HFT_15M_ONLY'
                      ? '#1 TOP 15-MINUTE HFT PREDICTION STRATEGY'
                      : '#1 BEST PERFORMING STRATEGY ON REAL DATA'}
                  </span>
                  <span className="font-mono font-bold text-slate-100 text-sm">
                    {activeWinner.symbol} · {activeWinner.indicatorStrategyLabel}
                  </span>
                  {activeWinner.activeContractTicker && (
                    <span className="font-mono text-cyan-400 text-xs">
                      [{activeWinner.activeContractTicker}]
                    </span>
                  )}
                </div>
                <div className="text-slate-400 font-mono text-[11px]">
                  Signal Formula: <span className="text-slate-200">{activeWinner.indicatorSignalFormula}</span> · Source:{' '}
                  <span className="text-emerald-400">{activeWinner.dataSource}</span> ({activeWinner.barsTested} real micro-bars)
                </div>
              </div>

              <div className="flex items-center gap-5 font-mono tabular-nums">
                <div>
                  <div className="text-[11px] text-slate-400">Real-Data Return</div>
                  <div className="text-sm font-bold text-emerald-400">
                    +{activeWinner.totalReturnPct.toFixed(2)}%
                  </div>
                </div>
                <div>
                  <div className="text-[11px] text-slate-400">Net Alpha</div>
                  <div className="text-sm font-bold text-cyan-400">
                    {activeWinner.netAlphaPct >= 0 ? '+' : ''}
                    {activeWinner.netAlphaPct.toFixed(2)}%
                  </div>
                </div>
                <div>
                  <div className="text-[11px] text-slate-400">Sharpe Ratio</div>
                  <div className="text-sm font-bold text-slate-100">
                    {activeWinner.sharpeRatio.toFixed(2)}
                  </div>
                </div>
                <div>
                  <div className="text-[11px] text-slate-400">Win Rate &amp; Fills</div>
                  <div className="text-sm font-bold text-emerald-400">
                    {activeWinner.winRatePct.toFixed(1)}% ({activeWinner.totalTrades} HFT fills)
                  </div>
                </div>
              </div>
            </div>
          )}

          <div className="overflow-x-auto max-h-64 border border-slate-800">
            <table className="w-full text-left border-collapse text-xs font-mono tabular-nums">
              <thead>
                <tr className="border-b border-slate-800 text-slate-400 bg-[#0B0F17] sticky top-0">
                  <th className="py-2 px-3">Rank &amp; Ticker</th>
                  <th className="py-2 px-3">High-Frequency / Quantitative Strategy</th>
                  <th className="py-2 px-3">Real Data Source</th>
                  <th className="py-2 px-3 text-right">Return / Alpha</th>
                  <th className="py-2 px-3 text-right">Sharpe / Win%</th>
                  <th className="py-2 px-3 text-right">Max DD</th>
                  <th className="py-2 px-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80">
                {displayedTournament.slice(0, 12).map((entry, idx) => (
                  <tr
                    key={`${entry.symbol}-${entry.indicatorStrategyId}`}
                    className={`hover:bg-slate-800/40 ${
                      idx === 0 ? 'bg-emerald-500/5' : ''
                    }`}
                  >
                    <td className="py-2.5 px-3">
                      <div className="font-bold text-slate-100 flex items-center gap-1.5">
                        <span>#{idx + 1} · {entry.symbol}</span>
                        {entry.is15MinPrediction && (
                          <span className="px-1 py-0.2 bg-cyan-500/20 border border-cyan-500/40 text-cyan-300 text-[9px]">
                            15M HFT
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] text-slate-400">
                        {entry.activeContractTicker ||
                          (entry.venue === 'PUBLIC_BROKERAGE' ? 'Public.com Live' : 'Kalshi CLOB v2')}{' '}
                        · {entry.archetype}
                      </div>
                    </td>
                    <td className="py-2.5 px-3 font-sans">
                      <div className="font-medium text-cyan-300">{entry.indicatorStrategyLabel}</div>
                      <div className="text-[11px] text-slate-400 font-mono">
                        {entry.indicatorSignalFormula}
                      </div>
                    </td>
                    <td className="py-2.5 px-3 text-[11px]">
                      <div className="text-emerald-400 flex items-center gap-1">
                        <CheckCircle2 className="w-3 h-3" />
                        <span>{entry.barsTested} Real Bars</span>
                      </div>
                      <div className="text-slate-500 text-[10px]">{entry.dataSource}</div>
                    </td>
                    <td className="py-2.5 px-3 text-right">
                      <div
                        className={`font-bold ${
                          entry.totalReturnPct >= 0 ? 'text-emerald-400' : 'text-rose-400'
                        }`}
                      >
                        {entry.totalReturnPct >= 0 ? '+' : ''}
                        {entry.totalReturnPct.toFixed(2)}%
                      </div>
                      <div className="text-[11px] text-cyan-400">
                        Alpha: {entry.netAlphaPct >= 0 ? '+' : ''}
                        {entry.netAlphaPct.toFixed(2)}%
                      </div>
                    </td>
                    <td className="py-2.5 px-3 text-right">
                      <div className="text-slate-100 font-semibold">
                        {entry.sharpeRatio.toFixed(2)} SR
                      </div>
                      <div className="text-[11px] text-slate-400">
                        {entry.winRatePct.toFixed(1)}% ({entry.totalTrades}T)
                      </div>
                    </td>
                    <td className="py-2.5 px-3 text-right text-amber-400">
                      -{entry.maxDrawdownPct.toFixed(2)}%
                    </td>
                    <td className="py-2.5 px-3 text-right whitespace-nowrap">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => handleLoadTournamentEntry(entry)}
                          className="px-2 py-1 bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/40 text-cyan-300 rounded text-[11px] font-sans font-medium"
                        >
                          Set Strat A
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setBacktestMode('COMPARATIVE_OVERLAY');
                            setBtSymbol(entry.symbol);
                            setBtStrategyBId(entry.indicatorStrategyId);
                            onSelectSymbolInMain(entry.symbol);
                            runBacktestSimulation({
                              symbol: entry.symbol,
                              archetype: entry.archetype,
                              strategyBId: entry.indicatorStrategyId,
                            } as any);
                          }}
                          className="px-2 py-1 bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-amber-300 rounded text-[11px] font-sans font-medium"
                        >
                          Compare as B
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* SECTION 1: MULTI-VENUE MARKET ALPHA SCANNER */}
      <div className="p-5 border border-slate-800 bg-[#111827] space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-3.5">
          <div>
            <h2 className="text-base font-semibold text-slate-100">
              Multi-Venue Real-Data Alpha Scanner (Public.com Quotes &amp; Kalshi API v2 CLOB)
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Continuously scans real 5m/1D OHLCV bars, rolling ATR(14), 9/21 EMA velocity, 50/200 SMA spreads, Wilder RSI(14), and live Kalshi/Public L2 orderbook imbalance.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 p-1 bg-[#0B0F17] border border-slate-800 rounded text-xs">
              <button
                type="button"
                onClick={() => setScannerFilter('ALL')}
                className={`px-2.5 py-1 rounded transition-colors whitespace-nowrap ${
                  scannerFilter === 'ALL'
                    ? 'bg-slate-800 text-slate-100 font-medium'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                All Ranked ({opportunities.length})
              </button>
              <button
                type="button"
                onClick={() => setScannerFilter('LONG_AND_LOW')}
                className={`px-2.5 py-1 rounded transition-colors whitespace-nowrap ${
                  scannerFilter === 'LONG_AND_LOW'
                    ? 'bg-slate-800 text-cyan-400 font-medium'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Long &amp; Low Alpha
              </button>
              <button
                type="button"
                onClick={() => setScannerFilter('SHORT_AND_FAST')}
                className={`px-2.5 py-1 rounded transition-colors whitespace-nowrap ${
                  scannerFilter === 'SHORT_AND_FAST'
                    ? 'bg-slate-800 text-emerald-400 font-medium'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Short &amp; Fast Alpha
              </button>
            </div>

            <button
              type="button"
              onClick={runMarketScan}
              disabled={isScanning}
              className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-100 text-xs font-medium rounded flex items-center gap-1.5 whitespace-nowrap"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isScanning ? 'animate-spin text-cyan-400' : ''}`} />
              <span>Rescan Live Markets</span>
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-800 text-slate-400 bg-[#0D131F]">
                <th className="py-2.5 px-3 font-medium">Rank &amp; Symbol</th>
                <th className="py-2.5 px-3 font-medium">Alpha Score &amp; Edge</th>
                <th className="py-2.5 px-3 font-medium">Optimal Archetype &amp; Regime</th>
                <th className="py-2.5 px-3 font-medium text-right">ATR% / RVOL / RSI</th>
                <th className="py-2.5 px-3 font-medium">Real-Data Quantitative Catalyst</th>
                <th className="py-2.5 px-3 font-medium text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80">
              {filteredOpportunities.map((opp, idx) => {
                const isSelected = opp.symbol === btSymbol;
                const decimals = opp.price < 2 ? 4 : 2;
                return (
                  <tr
                    key={opp.symbol}
                    className={`transition-colors ${
                      isSelected ? 'bg-slate-800/50' : 'hover:bg-slate-800/25'
                    }`}
                  >
                    <td className="py-3 px-3 font-mono tabular-nums">
                      <div className="font-semibold text-slate-100">
                        #{idx + 1} · {opp.symbol}
                      </div>
                      <div className="text-[11px] text-slate-400">
                        {opp.assetClass === 'PREDICTION_CONTRACT'
                          ? `${(opp.price * 100).toFixed(1)}¢`
                          : `$${opp.price.toFixed(decimals)}`}{' '}
                        · {opp.venue === 'PUBLIC_BROKERAGE' ? 'Public.com Live' : 'Kalshi CLOB v2'}
                      </div>
                    </td>

                    <td className="py-3 px-3 font-mono tabular-nums">
                      <div className="flex items-center gap-2">
                        <span
                          className={`text-sm font-bold ${
                            opp.alphaScore >= 80
                              ? 'text-emerald-400'
                              : opp.alphaScore >= 65
                              ? 'text-cyan-400'
                              : 'text-amber-400'
                          }`}
                        >
                          {opp.alphaScore}/100
                        </span>
                        <span className="text-[11px] text-slate-400">
                          +{opp.expectedEdgeBps} bps edge
                        </span>
                      </div>
                      <div className="w-28 h-1.5 bg-slate-900 mt-1 overflow-hidden">
                        <div
                          style={{ width: `${opp.alphaScore}%` }}
                          className={
                            opp.alphaScore >= 80
                              ? 'h-full bg-emerald-500'
                              : opp.alphaScore >= 65
                              ? 'h-full bg-cyan-500'
                              : 'h-full bg-amber-500'
                          }
                        />
                      </div>
                    </td>

                    <td className="py-3 px-3 font-mono text-[11px]">
                      <div
                        className={
                          opp.recommendedArchetype === 'LONG_AND_LOW'
                            ? 'text-cyan-400 font-semibold'
                            : 'text-emerald-400 font-semibold'
                        }
                      >
                        {opp.recommendedArchetype}
                      </div>
                      <div className={`${formatRegimeColor(opp.detectedRegime)} mt-0.5`}>
                        {opp.detectedRegime}
                      </div>
                    </td>

                    <td className="py-3 px-3 text-right font-mono tabular-nums text-[11px]">
                      <div className="text-slate-200">
                        ATR {opp.keyMetrics.atrPct.toFixed(2)}% ({opp.keyMetrics.atrBaselineMultiplier.toFixed(2)}x)
                      </div>
                      <div className="text-slate-400">
                        RVOL {opp.keyMetrics.rvol.toFixed(2)}x · RSI {opp.keyMetrics.rsi14.toFixed(1)}
                      </div>
                    </td>

                    <td className="py-3 px-3 text-slate-300 max-w-xs leading-snug">
                      <div>{opp.signalCatalyst}</div>
                      <div className="text-[11px] font-mono text-slate-400 mt-0.5">
                        Suggested OCO: SL {opp.suggestedStopLoss} · TP {opp.suggestedTakeProfit}
                      </div>
                    </td>

                    <td className="py-3 px-3 text-right whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => handleLoadOpportunityIntoBacktest(opp)}
                        className="px-3 py-1.5 bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/50 text-cyan-300 font-medium rounded text-[11px] transition-colors"
                      >
                        Backtest Real Bars
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* SECTION 2: REAL-DATA QUANTITATIVE STRATEGY BACKTESTER (COMPARATIVE OVERLAY A vs. B & SINGLE MODE) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
        {/* Left 4 Cols: Backtest Parameter & Strategy A vs. B Controls */}
        <div className="lg:col-span-4 p-5 border border-slate-800 bg-[#111827] flex flex-col justify-between space-y-4">
          <div className="space-y-4">
            <div className="border-b border-slate-800 pb-3 space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-base font-semibold text-slate-100 flex items-center gap-2">
                  <GitCompare className="w-4 h-4 text-cyan-400" />
                  <span>Real-Data Regime Backtester</span>
                </h3>
                <span className="px-2 py-0.5 bg-cyan-500/15 border border-cyan-500/40 text-cyan-300 font-mono text-[10px]">
                  RISK-FIRST ENGINE
                </span>
              </div>
              <p className="text-xs text-slate-400">
                Overlay two indicator strategies (A vs. B) on real historical OHLCV &amp; Kalshi CLOB bars to evaluate risk-adjusted regime superiority.
              </p>

              {/* Mode Segmented Toggle */}
              <div className="grid grid-cols-2 gap-1 p-1 bg-[#0B0F17] border border-slate-800 rounded text-xs">
                <button
                  type="button"
                  onClick={() => setBacktestMode('COMPARATIVE_OVERLAY')}
                  className={`py-1.5 px-2 rounded font-medium transition-colors ${
                    backtestMode === 'COMPARATIVE_OVERLAY'
                      ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Comparative Overlay (A vs B)
                </button>
                <button
                  type="button"
                  onClick={() => setBacktestMode('SINGLE_STRATEGY')}
                  className={`py-1.5 px-2 rounded font-medium transition-colors ${
                    backtestMode === 'SINGLE_STRATEGY'
                      ? 'bg-slate-800 text-slate-100 border border-slate-700'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Single Strategy Lab
                </button>
              </div>
            </div>

            <div className="space-y-3 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-300 font-medium mb-1">Target Instrument</label>
                  <select
                    value={btSymbol}
                    onChange={(e) => {
                      const nextSym = e.target.value;
                      setBtSymbol(nextSym);
                      onSelectSymbolInMain(nextSym);
                      runBacktestSimulation({ symbol: nextSym });
                    }}
                    className="w-full px-2.5 py-2 bg-[#0B0F17] border border-slate-800 text-slate-100 font-mono rounded focus:outline-none focus:border-cyan-400"
                  >
                    {features.map((f) => (
                      <option key={f.symbol} value={f.symbol}>
                        {f.symbol}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-slate-300 font-medium mb-1">Strategy Archetype</label>
                  <select
                    value={btArchetype}
                    onChange={(e) => {
                      const nextArch = e.target.value as StrategyArchetype;
                      setBtArchetype(nextArch);
                      if (nextArch === 'LONG_AND_LOW') {
                        setBtRsiLow(26);
                        setBtRsiHigh(58);
                        setBtStopAtr(2.2);
                        setBtTpAtr(4.2);
                        setBtKillAtr(2.6);
                      } else {
                        setBtRsiLow(46);
                        setBtRsiHigh(76);
                        setBtStopAtr(1.2);
                        setBtTpAtr(2.6);
                        setBtKillAtr(2.2);
                      }
                    }}
                    className="w-full px-2.5 py-2 bg-[#0B0F17] border border-slate-800 text-slate-100 font-mono rounded focus:outline-none focus:border-cyan-400"
                  >
                    <option value="SHORT_AND_FAST">SHORT_AND_FAST</option>
                    <option value="LONG_AND_LOW">LONG_AND_LOW</option>
                  </select>
                </div>
              </div>

              {/* Strategy A Selector */}
              <div className="p-2.5 bg-[#0B0F17] border border-cyan-500/40 space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-cyan-300 font-mono font-semibold text-[11px]">
                    {backtestMode === 'COMPARATIVE_OVERLAY'
                      ? 'STRATEGY A (CYAN EQUITY CURVE)'
                      : 'PRIMARY INDICATOR STRATEGY'}
                  </label>
                  <span className="w-2.5 h-2.5 bg-cyan-400 inline-block" />
                </div>
                <select
                  value={btIndicatorId}
                  onChange={(e) => {
                    const nextA = e.target.value as IndicatorStrategyId;
                    setBtIndicatorId(nextA);
                    runBacktestSimulation({ indicatorStrategyId: nextA });
                  }}
                  className="w-full px-2.5 py-1.5 bg-[#080C14] border border-slate-800 text-cyan-300 font-mono rounded focus:outline-none focus:border-cyan-400"
                >
                  {INDICATOR_OPTIONS.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.label}
                    </option>
                  ))}
                </select>
                <div className="text-[11px] font-mono text-slate-400 leading-tight">
                  {INDICATOR_OPTIONS.find((o) => o.id === btIndicatorId)?.formula}
                </div>
              </div>

              {/* Strategy B Selector (Shown in Comparative Overlay Mode) */}
              {backtestMode === 'COMPARATIVE_OVERLAY' && (
                <div className="p-2.5 bg-[#0B0F17] border border-amber-500/40 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label className="text-amber-300 font-mono font-semibold text-[11px]">
                      STRATEGY B (AMBER EQUITY CURVE)
                    </label>
                    <span className="w-2.5 h-2.5 bg-amber-400 inline-block" />
                  </div>
                  <select
                    value={btStrategyBId}
                    onChange={(e) => {
                      const nextB = e.target.value as IndicatorStrategyId;
                      setBtStrategyBId(nextB);
                      runBacktestSimulation({ strategyBId: nextB } as any);
                    }}
                    className="w-full px-2.5 py-1.5 bg-[#080C14] border border-slate-800 text-amber-300 font-mono rounded focus:outline-none focus:border-amber-400"
                  >
                    {INDICATOR_OPTIONS.map((opt) => (
                      <option key={opt.id} value={opt.id}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                  <div className="text-[11px] font-mono text-slate-400 leading-tight">
                    {INDICATOR_OPTIONS.find((o) => o.id === btStrategyBId)?.formula}
                  </div>

                  {/* Quick Regime Matchup Presets */}
                  <div className="pt-1.5 border-t border-slate-800/80 flex flex-wrap gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        setBtIndicatorId('BTC_LEAD_LAG_SNIPER');
                        setBtStrategyBId('HFT_15M_CLOB_MICRO_SCALPER');
                        runBacktestSimulation({
                          indicatorStrategyId: 'BTC_LEAD_LAG_SNIPER',
                          strategyBId: 'HFT_15M_CLOB_MICRO_SCALPER',
                        } as any);
                      }}
                      className="px-1.5 py-0.5 bg-slate-800 hover:bg-slate-700 text-slate-300 font-mono text-[10px] rounded"
                    >
                      Sniper vs CLOB
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setBtIndicatorId('HFT_15M_GAMMA_CONVERGENCE');
                        setBtStrategyBId('HFT_15M_VWAP_SNAPBACK');
                        runBacktestSimulation({
                          indicatorStrategyId: 'HFT_15M_GAMMA_CONVERGENCE',
                          strategyBId: 'HFT_15M_VWAP_SNAPBACK',
                        } as any);
                      }}
                      className="px-1.5 py-0.5 bg-slate-800 hover:bg-slate-700 text-slate-300 font-mono text-[10px] rounded"
                    >
                      Gamma vs Snapback
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setBtIndicatorId('EMA_VWAP_VELOCITY');
                        setBtStrategyBId('BB_SQUEEZE_BREAKOUT');
                        runBacktestSimulation({
                          indicatorStrategyId: 'EMA_VWAP_VELOCITY',
                          strategyBId: 'BB_SQUEEZE_BREAKOUT',
                        } as any);
                      }}
                      className="px-1.5 py-0.5 bg-slate-800 hover:bg-slate-700 text-slate-300 font-mono text-[10px] rounded"
                    >
                      EMA vs BB Squeeze
                    </button>
                  </div>
                </div>
              )}

              <div>
                <label className="block text-slate-300 font-medium mb-1">Initial Backtest Capital (USD)</label>
                <input
                  type="number"
                  step={100}
                  min={100}
                  value={btCapital}
                  onChange={(e) => setBtCapital(Number(e.target.value))}
                  className="w-full px-3 py-1.5 bg-[#0B0F17] border border-slate-800 text-slate-100 font-mono rounded"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-300 font-medium mb-1">RSI(14) Entry Low</label>
                  <input
                    type="number"
                    min={10}
                    max={70}
                    value={btRsiLow}
                    onChange={(e) => setBtRsiLow(Number(e.target.value))}
                    className="w-full px-3 py-1.5 bg-[#0B0F17] border border-slate-800 text-slate-100 font-mono rounded"
                  />
                </div>
                <div>
                  <label className="block text-slate-300 font-medium mb-1">RSI(14) Exhaustion Cap</label>
                  <input
                    type="number"
                    min={30}
                    max={90}
                    value={btRsiHigh}
                    onChange={(e) => setBtRsiHigh(Number(e.target.value))}
                    className="w-full px-3 py-1.5 bg-[#0B0F17] border border-slate-800 text-slate-100 font-mono rounded"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2.5">
                <div>
                  <label className="block text-slate-300 font-medium mb-1">OCO Stop (ATR×)</label>
                  <input
                    type="number"
                    step={0.1}
                    min={0.5}
                    max={5}
                    value={btStopAtr}
                    onChange={(e) => setBtStopAtr(Number(e.target.value))}
                    className="w-full px-2.5 py-1.5 bg-[#0B0F17] border border-slate-800 text-slate-100 font-mono rounded"
                  />
                </div>
                <div>
                  <label className="block text-slate-300 font-medium mb-1">OCO Target (ATR×)</label>
                  <input
                    type="number"
                    step={0.1}
                    min={1.0}
                    max={8}
                    value={btTpAtr}
                    onChange={(e) => setBtTpAtr(Number(e.target.value))}
                    className="w-full px-2.5 py-1.5 bg-[#0B0F17] border border-slate-800 text-slate-100 font-mono rounded"
                  />
                </div>
                <div>
                  <label className="block text-slate-300 font-medium mb-1">ATR Kill (×Base)</label>
                  <input
                    type="number"
                    step={0.1}
                    min={1.4}
                    max={4.5}
                    value={btKillAtr}
                    onChange={(e) => setBtKillAtr(Number(e.target.value))}
                    className="w-full px-2.5 py-1.5 bg-[#0B0F17] border border-slate-800 text-slate-100 font-mono rounded"
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="space-y-2 pt-3 border-t border-slate-800">
            <button
              type="button"
              onClick={() => runBacktestSimulation()}
              disabled={isRunningBacktest}
              className="w-full py-2 px-4 bg-slate-800 hover:bg-slate-700 text-slate-100 font-semibold text-xs rounded transition-colors flex items-center justify-center gap-1.5"
            >
              <Play className="w-3.5 h-3.5 text-cyan-400" />
              <span>
                {isRunningBacktest
                  ? 'Evaluating Real Regime Bars...'
                  : backtestMode === 'COMPARATIVE_OVERLAY'
                  ? 'Run Comparative Overlay (A vs. B)'
                  : 'Run Real-Data Backtest'}
              </span>
            </button>

            <button
              type="button"
              onClick={() => handleDeployValidatedAgent()}
              disabled={isDeploying || (!backtestResult && !comparativeResult)}
              className="w-full py-2.5 px-4 bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold text-xs rounded transition-colors flex items-center justify-center gap-1.5"
            >
              <Zap className="w-3.5 h-3.5" />
              <span>
                {isDeploying
                  ? 'Deploying Agent...'
                  : backtestMode === 'COMPARATIVE_OVERLAY' && comparativeResult
                  ? `Deploy Regime Winner (${comparativeResult.winnerStrategyId}) Live`
                  : `Deploy ${btSymbol} (${btIndicatorId}) Agent Live`}
              </span>
            </button>
          </div>
        </div>

        {/* Right 8 Cols: Comparative Strategy A vs. B Overlay OR Single Strategy Results */}
        <div className="lg:col-span-8 p-5 border border-slate-800 bg-[#111827] space-y-4">
          {backtestMode === 'COMPARATIVE_OVERLAY' && comparativeResult ? (
            <>
              {/* Risk-First Regime Verdict Banner */}
              <div className="p-3.5 bg-[#0B0F17] border border-slate-800 space-y-2 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="px-2 py-0.5 bg-emerald-500 text-slate-950 font-mono font-bold text-[11px]">
                      REGIME WINNER ({comparativeResult.winnerSlot === 'STRATEGY_A' ? 'STRATEGY A' : 'STRATEGY B'}):{' '}
                      {comparativeResult.winnerStrategyId}
                    </span>
                    <span className={`font-mono font-semibold ${formatRegimeColor(comparativeResult.detectedRegime)}`}>
                      [{comparativeResult.detectedRegime}]
                    </span>
                    <span className="font-mono text-[11px] text-slate-400">
                      Downside Winner: <span className="text-slate-200">{comparativeResult.riskFirstVerdict.downsideWinnerId}</span>
                    </span>
                  </div>

                  <div className="flex items-center gap-2 font-mono text-[11px]">
                    {comparativeResult.dataQualityWarning ? (
                      <span className="px-1.5 py-0.5 bg-amber-500/20 border border-amber-500/40 text-amber-300 flex items-center gap-1">
                        <ShieldAlert className="w-3 h-3" />
                        <span>dataQualityWarning: true</span>
                      </span>
                    ) : (
                      <span className="px-1.5 py-0.5 bg-emerald-500/15 border border-emerald-500/40 text-emerald-300">
                        dataQualityWarning: false · {comparativeResult.barsTested} Real Bars
                      </span>
                    )}
                    <span className="text-slate-400">
                      Invalidation: &gt;{comparativeResult.riskFirstVerdict.invalidationThresholdAtr}x ATR
                    </span>
                  </div>
                </div>

                <div className="font-mono text-slate-300 text-[11px] leading-relaxed">
                  <span className="text-slate-500">DETERMINISTIC RATIONALE (&lt;40w): </span>
                  {comparativeResult.riskFirstVerdict.rationale}
                </div>
              </div>

              {/* Dual-Strategy Overlaid Equity Curve & Underwater Drawdown SVG */}
              {renderComparativeEquityCurveSvg()}

              {/* Head-to-Head Risk-First Regime Scorecard Table */}
              <div className="overflow-x-auto border border-slate-800">
                <table className="w-full text-left border-collapse text-xs font-mono tabular-nums">
                  <thead>
                    <tr className="border-b border-slate-800 text-slate-400 bg-[#0D131F]">
                      <th className="py-2 px-3 font-sans">Evaluation Metric (Risk-First Order)</th>
                      <th className="py-2 px-3 text-right text-cyan-400">
                        Strategy A ({comparativeResult.strategyA.indicatorStrategyId})
                      </th>
                      <th className="py-2 px-3 text-right text-amber-400">
                        Strategy B ({comparativeResult.strategyB.indicatorStrategyId})
                      </th>
                      <th className="py-2 px-3 text-right">Δ Spread (A − B)</th>
                      <th className="py-2 px-3 text-right">Metric Edge</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/80">
                    {/* 1. Max Drawdown (Evaluated First) */}
                    <tr className="hover:bg-slate-800/25">
                      <td className="py-2 px-3 font-sans text-slate-200 font-medium">
                        1. Max Drawdown Exposure (Downside Cap -{comparativeResult.riskFirstVerdict.maxAllowedDrawdownPct}%)
                      </td>
                      <td className="py-2 px-3 text-right text-slate-100">
                        -{comparativeResult.strategyA.maxDrawdownPct}%
                      </td>
                      <td className="py-2 px-3 text-right text-slate-100">
                        -{comparativeResult.strategyB.maxDrawdownPct}%
                      </td>
                      <td
                        className={`py-2 px-3 text-right font-semibold ${
                          comparativeResult.deltas.maxDrawdownSpreadPct <= 0
                            ? 'text-emerald-400'
                            : 'text-rose-400'
                        }`}
                      >
                        {comparativeResult.deltas.maxDrawdownSpreadPct > 0 ? '+' : ''}
                        {comparativeResult.deltas.maxDrawdownSpreadPct}%
                      </td>
                      <td className="py-2 px-3 text-right">
                        <span
                          className={
                            comparativeResult.strategyA.maxDrawdownPct <=
                            comparativeResult.strategyB.maxDrawdownPct
                              ? 'text-cyan-400 font-semibold'
                              : 'text-amber-400 font-semibold'
                          }
                        >
                          {comparativeResult.strategyA.maxDrawdownPct <=
                          comparativeResult.strategyB.maxDrawdownPct
                            ? 'STRATEGY A'
                            : 'STRATEGY B'}
                        </span>
                      </td>
                    </tr>

                    {/* 2. Sortino Ratio */}
                    <tr className="hover:bg-slate-800/25">
                      <td className="py-2 px-3 font-sans text-slate-200 font-medium">
                        2. Sortino Ratio (Downside Volatility Adjusted)
                      </td>
                      <td className="py-2 px-3 text-right text-slate-100">
                        {comparativeResult.strategyA.sortinoRatio}
                      </td>
                      <td className="py-2 px-3 text-right text-slate-100">
                        {comparativeResult.strategyB.sortinoRatio}
                      </td>
                      <td
                        className={`py-2 px-3 text-right font-semibold ${
                          comparativeResult.deltas.sortinoSpread >= 0
                            ? 'text-emerald-400'
                            : 'text-rose-400'
                        }`}
                      >
                        {comparativeResult.deltas.sortinoSpread >= 0 ? '+' : ''}
                        {comparativeResult.deltas.sortinoSpread}
                      </td>
                      <td className="py-2 px-3 text-right">
                        <span
                          className={
                            comparativeResult.strategyA.sortinoRatio >=
                            comparativeResult.strategyB.sortinoRatio
                              ? 'text-cyan-400 font-semibold'
                              : 'text-amber-400 font-semibold'
                          }
                        >
                          {comparativeResult.strategyA.sortinoRatio >=
                          comparativeResult.strategyB.sortinoRatio
                            ? 'STRATEGY A'
                            : 'STRATEGY B'}
                        </span>
                      </td>
                    </tr>

                    {/* 3. Sharpe Ratio */}
                    <tr className="hover:bg-slate-800/25">
                      <td className="py-2 px-3 font-sans text-slate-200 font-medium">
                        3. Sharpe Ratio (Risk-Adjusted Return)
                      </td>
                      <td className="py-2 px-3 text-right text-slate-100">
                        {comparativeResult.strategyA.sharpeRatio}
                      </td>
                      <td className="py-2 px-3 text-right text-slate-100">
                        {comparativeResult.strategyB.sharpeRatio}
                      </td>
                      <td
                        className={`py-2 px-3 text-right font-semibold ${
                          comparativeResult.deltas.sharpeSpread >= 0
                            ? 'text-emerald-400'
                            : 'text-rose-400'
                        }`}
                      >
                        {comparativeResult.deltas.sharpeSpread >= 0 ? '+' : ''}
                        {comparativeResult.deltas.sharpeSpread}
                      </td>
                      <td className="py-2 px-3 text-right">
                        <span
                          className={
                            comparativeResult.strategyA.sharpeRatio >=
                            comparativeResult.strategyB.sharpeRatio
                              ? 'text-cyan-400 font-semibold'
                              : 'text-amber-400 font-semibold'
                          }
                        >
                          {comparativeResult.strategyA.sharpeRatio >=
                          comparativeResult.strategyB.sharpeRatio
                            ? 'STRATEGY A'
                            : 'STRATEGY B'}
                        </span>
                      </td>
                    </tr>

                    {/* 4. Net Alpha vs Benchmark */}
                    <tr className="hover:bg-slate-800/25">
                      <td className="py-2 px-3 font-sans text-slate-200 font-medium">
                        4. Net Alpha vs. Buy-and-Hold Benchmark
                      </td>
                      <td className="py-2 px-3 text-right text-emerald-400 font-semibold">
                        {comparativeResult.strategyA.netAlphaPct >= 0 ? '+' : ''}
                        {comparativeResult.strategyA.netAlphaPct}%
                      </td>
                      <td className="py-2 px-3 text-right text-emerald-400 font-semibold">
                        {comparativeResult.strategyB.netAlphaPct >= 0 ? '+' : ''}
                        {comparativeResult.strategyB.netAlphaPct}%
                      </td>
                      <td
                        className={`py-2 px-3 text-right font-semibold ${
                          comparativeResult.deltas.netAlphaSpreadPct >= 0
                            ? 'text-emerald-400'
                            : 'text-rose-400'
                        }`}
                      >
                        {comparativeResult.deltas.netAlphaSpreadPct >= 0 ? '+' : ''}
                        {comparativeResult.deltas.netAlphaSpreadPct}%
                      </td>
                      <td className="py-2 px-3 text-right">
                        <span
                          className={
                            comparativeResult.strategyA.netAlphaPct >=
                            comparativeResult.strategyB.netAlphaPct
                              ? 'text-cyan-400 font-semibold'
                              : 'text-amber-400 font-semibold'
                          }
                        >
                          {comparativeResult.strategyA.netAlphaPct >=
                          comparativeResult.strategyB.netAlphaPct
                            ? 'STRATEGY A'
                            : 'STRATEGY B'}
                        </span>
                      </td>
                    </tr>

                    {/* 5. Total Return & Final Equity */}
                    <tr className="hover:bg-slate-800/25">
                      <td className="py-2 px-3 font-sans text-slate-200 font-medium">
                        5. Total Real-Bar Return &amp; Final Equity
                      </td>
                      <td className="py-2 px-3 text-right text-slate-100">
                        {comparativeResult.strategyA.totalReturnPct >= 0 ? '+' : ''}
                        {comparativeResult.strategyA.totalReturnPct}% ($
                        {comparativeResult.strategyA.finalEquityUsd.toLocaleString()})
                      </td>
                      <td className="py-2 px-3 text-right text-slate-100">
                        {comparativeResult.strategyB.totalReturnPct >= 0 ? '+' : ''}
                        {comparativeResult.strategyB.totalReturnPct}% ($
                        {comparativeResult.strategyB.finalEquityUsd.toLocaleString()})
                      </td>
                      <td
                        className={`py-2 px-3 text-right font-semibold ${
                          comparativeResult.deltas.totalReturnSpreadPct >= 0
                            ? 'text-emerald-400'
                            : 'text-rose-400'
                        }`}
                      >
                        {comparativeResult.deltas.totalReturnSpreadPct >= 0 ? '+' : ''}
                        {comparativeResult.deltas.totalReturnSpreadPct}%
                      </td>
                      <td className="py-2 px-3 text-right">
                        <span
                          className={
                            comparativeResult.strategyA.totalReturnPct >=
                            comparativeResult.strategyB.totalReturnPct
                              ? 'text-cyan-400 font-semibold'
                              : 'text-amber-400 font-semibold'
                          }
                        >
                          {comparativeResult.strategyA.totalReturnPct >=
                          comparativeResult.strategyB.totalReturnPct
                            ? 'STRATEGY A'
                            : 'STRATEGY B'}
                        </span>
                      </td>
                    </tr>

                    {/* 6. Win Rate & Profit Factor */}
                    <tr className="hover:bg-slate-800/25">
                      <td className="py-2 px-3 font-sans text-slate-200 font-medium">
                        6. Win Rate % &amp; Profit Factor (Fills)
                      </td>
                      <td className="py-2 px-3 text-right text-slate-100">
                        {comparativeResult.strategyA.winRatePct}% ·{' '}
                        {comparativeResult.strategyA.profitFactor}x (
                        {comparativeResult.strategyA.totalTrades}T)
                      </td>
                      <td className="py-2 px-3 text-right text-slate-100">
                        {comparativeResult.strategyB.winRatePct}% ·{' '}
                        {comparativeResult.strategyB.profitFactor}x (
                        {comparativeResult.strategyB.totalTrades}T)
                      </td>
                      <td
                        className={`py-2 px-3 text-right font-semibold ${
                          comparativeResult.deltas.winRateSpreadPct >= 0
                            ? 'text-emerald-400'
                            : 'text-rose-400'
                        }`}
                      >
                        {comparativeResult.deltas.winRateSpreadPct >= 0 ? '+' : ''}
                        {comparativeResult.deltas.winRateSpreadPct}% WR
                      </td>
                      <td className="py-2 px-3 text-right">
                        <span
                          className={
                            comparativeResult.strategyA.profitFactor >=
                            comparativeResult.strategyB.profitFactor
                              ? 'text-cyan-400 font-semibold'
                              : 'text-amber-400 font-semibold'
                          }
                        >
                          {comparativeResult.strategyA.profitFactor >=
                          comparativeResult.strategyB.profitFactor
                            ? 'STRATEGY A'
                            : 'STRATEGY B'}
                        </span>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {/* Dual-Strategy Trade Ledger Inspector */}
              {(() => {
                const inspectedRes =
                  activeTradeLedgerSlot === 'STRATEGY_A'
                    ? comparativeResult.strategyA
                    : comparativeResult.strategyB;
                return (
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-slate-200">
                          Walk-Forward OCO Execution Ledger:
                        </span>
                        <div className="flex items-center gap-1 p-0.5 bg-[#0B0F17] border border-slate-800 rounded">
                          <button
                            type="button"
                            onClick={() => setActiveTradeLedgerSlot('STRATEGY_A')}
                            className={`px-2 py-1 rounded font-mono text-[11px] ${
                              activeTradeLedgerSlot === 'STRATEGY_A'
                                ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 font-semibold'
                                : 'text-slate-400 hover:text-slate-200'
                            }`}
                          >
                            Strategy A ({comparativeResult.strategyA.trades.length} Fills)
                          </button>
                          <button
                            type="button"
                            onClick={() => setActiveTradeLedgerSlot('STRATEGY_B')}
                            className={`px-2 py-1 rounded font-mono text-[11px] ${
                              activeTradeLedgerSlot === 'STRATEGY_B'
                                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40 font-semibold'
                                : 'text-slate-400 hover:text-slate-200'
                            }`}
                          >
                            Strategy B ({comparativeResult.strategyB.trades.length} Fills)
                          </button>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            handleDeployValidatedAgent(comparativeResult.strategyA.indicatorStrategyId)
                          }
                          disabled={isDeploying}
                          className="px-2.5 py-1 bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/40 text-cyan-300 font-mono text-[11px] rounded"
                        >
                          Deploy Strategy A
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            handleDeployValidatedAgent(comparativeResult.strategyB.indicatorStrategyId)
                          }
                          disabled={isDeploying}
                          className="px-2.5 py-1 bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-amber-300 font-mono text-[11px] rounded"
                        >
                          Deploy Strategy B
                        </button>
                      </div>
                    </div>

                    <div className="overflow-x-auto max-h-48 border border-slate-800">
                      <table className="w-full text-left border-collapse text-xs font-mono tabular-nums">
                        <thead>
                          <tr className="border-b border-slate-800 text-slate-400 bg-[#0D131F] sticky top-0">
                            <th className="py-2 px-3">Trade ID</th>
                            <th className="py-2 px-3">Side &amp; Qty</th>
                            <th className="py-2 px-3 text-right">Entry → Exit</th>
                            <th className="py-2 px-3">Regime at Entry</th>
                            <th className="py-2 px-3">Exit Trigger</th>
                            <th className="py-2 px-3 text-right">Realized P&amp;L</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800/80">
                          {inspectedRes.trades.map((tr) => (
                            <tr key={tr.id} className="hover:bg-slate-800/30">
                              <td className="py-2 px-3 text-slate-300">{tr.id}</td>
                              <td className="py-2 px-3">
                                <span
                                  className={
                                    tr.side === 'LONG'
                                      ? 'text-emerald-400 font-semibold'
                                      : 'text-rose-400 font-semibold'
                                  }
                                >
                                  {tr.side}
                                </span>{' '}
                                × {tr.quantity}
                              </td>
                              <td className="py-2 px-3 text-right text-slate-200">
                                {tr.entryPrice} → {tr.exitPrice}
                              </td>
                              <td className={`py-2 px-3 text-[11px] ${formatRegimeColor(tr.regimeAtEntry)}`}>
                                {tr.regimeAtEntry}
                              </td>
                              <td className="py-2 px-3 text-[11px]">
                                <span
                                  className={
                                    tr.exitReason === 'TAKE_PROFIT_OCO'
                                      ? 'text-emerald-400'
                                      : tr.exitReason === 'ATR_CIRCUIT_BREAKER'
                                      ? 'text-amber-400'
                                      : tr.exitReason === 'STOP_LOSS_OCO'
                                      ? 'text-rose-400'
                                      : 'text-slate-300'
                                  }
                                >
                                  {tr.exitReason}
                                </span>
                              </td>
                              <td
                                className={`py-2 px-3 text-right font-semibold ${
                                  tr.pnlUsd >= 0 ? 'text-emerald-400' : 'text-rose-400'
                                }`}
                              >
                                {tr.pnlUsd >= 0 ? '+' : ''}${tr.pnlUsd.toFixed(2)} ({tr.returnPct >= 0 ? '+' : ''}
                                {tr.returnPct}%)
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })()}
            </>
          ) : (
            backtestResult && (
              <>
                {/* Quantitative Backtest Summary Strip */}
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-xs font-mono tabular-nums">
                  <div className="p-3 bg-[#0B0F17] border border-slate-800">
                    <div className="text-slate-400 font-sans">Net Alpha vs Bench</div>
                    <div
                      className={`mt-1 text-base font-bold ${
                        backtestResult.netAlphaPct >= 0 ? 'text-emerald-400' : 'text-rose-400'
                      }`}
                    >
                      {backtestResult.netAlphaPct >= 0 ? '+' : ''}
                      {backtestResult.netAlphaPct}%
                    </div>
                    <div className="text-[11px] text-slate-400 mt-0.5">
                      Tot: {backtestResult.totalReturnPct >= 0 ? '+' : ''}
                      {backtestResult.totalReturnPct}%
                    </div>
                  </div>

                  <div className="p-3 bg-[#0B0F17] border border-slate-800">
                    <div className="text-slate-400 font-sans">Sharpe / Sortino</div>
                    <div className="mt-1 text-base font-bold text-cyan-400">
                      {backtestResult.sharpeRatio} / {backtestResult.sortinoRatio}
                    </div>
                    <div className="text-[11px] text-slate-400 mt-0.5">
                      PF: {backtestResult.profitFactor}x
                    </div>
                  </div>

                  <div className="p-3 bg-[#0B0F17] border border-slate-800">
                    <div className="text-slate-400 font-sans">Win Rate &amp; Fills</div>
                    <div className="mt-1 text-base font-bold text-slate-100">
                      {backtestResult.winRatePct}%
                    </div>
                    <div className="text-[11px] text-slate-400 mt-0.5">
                      {backtestResult.totalTrades} Real-Bar Fills
                    </div>
                  </div>

                  <div className="p-3 bg-[#0B0F17] border border-slate-800">
                    <div className="text-slate-400 font-sans">Max Drawdown</div>
                    <div className="mt-1 text-base font-bold text-amber-400">
                      -{backtestResult.maxDrawdownPct}%
                    </div>
                    <div className="text-[11px] text-slate-400 mt-0.5">
                      Within Risk Cap
                    </div>
                  </div>

                  <div className="p-3 bg-[#0B0F17] border border-slate-800">
                    <div className="text-slate-400 font-sans">ATR Kill Saves</div>
                    <div className="mt-1 text-base font-bold text-emerald-400">
                      {backtestResult.circuitBreakerSaves} Events
                    </div>
                    <div className="text-[11px] text-slate-400 mt-0.5">
                      Halt &gt; {backtestResult.parameters.atrKillMultiplier}x ATR
                    </div>
                  </div>
                </div>

                {/* Equity Curve SVG */}
                {renderEquityCurveSvg()}

                {/* Real-Bar Walk-Forward Trade Ledger */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold text-slate-200">
                      Real-Bar Walk-Forward OCO Executions ({backtestResult.trades.length} Fills)
                    </span>
                    <span className="text-slate-400 font-mono text-[11px]">
                      Indicator: {backtestResult.indicatorStrategyLabel || btIndicatorId} · OCO SL{' '}
                      {backtestResult.parameters.stopLossAtrMultiple}x / TP{' '}
                      {backtestResult.parameters.takeProfitAtrMultiple}x ATR
                    </span>
                  </div>

                  <div className="overflow-x-auto max-h-56 border border-slate-800">
                    <table className="w-full text-left border-collapse text-xs font-mono tabular-nums">
                      <thead>
                        <tr className="border-b border-slate-800 text-slate-400 bg-[#0D131F] sticky top-0">
                          <th className="py-2 px-3">Trade ID</th>
                          <th className="py-2 px-3">Side &amp; Qty</th>
                          <th className="py-2 px-3 text-right">Entry → Exit</th>
                          <th className="py-2 px-3">Regime at Entry</th>
                          <th className="py-2 px-3">Exit Trigger</th>
                          <th className="py-2 px-3 text-right">Realized P&amp;L</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/80">
                        {backtestResult.trades.map((tr) => (
                          <tr key={tr.id} className="hover:bg-slate-800/30">
                            <td className="py-2 px-3 text-slate-300">{tr.id}</td>
                            <td className="py-2 px-3">
                              <span
                                className={
                                  tr.side === 'LONG'
                                    ? 'text-emerald-400 font-semibold'
                                    : 'text-rose-400 font-semibold'
                                }
                              >
                                {tr.side}
                              </span>{' '}
                              × {tr.quantity}
                            </td>
                            <td className="py-2 px-3 text-right text-slate-200">
                              {tr.entryPrice} → {tr.exitPrice}
                            </td>
                            <td className={`py-2 px-3 text-[11px] ${formatRegimeColor(tr.regimeAtEntry)}`}>
                              {tr.regimeAtEntry}
                            </td>
                            <td className="py-2 px-3 text-[11px]">
                              <span
                                className={
                                  tr.exitReason === 'TAKE_PROFIT_OCO'
                                    ? 'text-emerald-400'
                                    : tr.exitReason === 'ATR_CIRCUIT_BREAKER'
                                    ? 'text-amber-400'
                                    : tr.exitReason === 'STOP_LOSS_OCO'
                                    ? 'text-rose-400'
                                    : 'text-slate-300'
                                }
                              >
                                {tr.exitReason}
                              </span>
                            </td>
                            <td
                              className={`py-2 px-3 text-right font-semibold ${
                                tr.pnlUsd >= 0 ? 'text-emerald-400' : 'text-rose-400'
                              }`}
                            >
                              {tr.pnlUsd >= 0 ? '+' : ''}${tr.pnlUsd.toFixed(2)} ({tr.returnPct >= 0 ? '+' : ''}
                              {tr.returnPct}%)
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )
          )}
        </div>
      </div>

      {/* SECTION 3: D3 STRATEGY CORRELATION MATRIX (LONG & LOW vs SHORT & FAST DIVERSIFICATION) */}
      <StrategyCorrelationMatrix
        features={features}
        opportunities={opportunities}
        selectedBacktestSymbol={btSymbol}
        selectedBacktestArchetype={btArchetype}
        onSelectPairForBacktest={(sym, arch) => {
          setBtSymbol(sym);
          setBtArchetype(arch);
          onSelectSymbolInMain(sym);
          const nextRsiLow = arch === 'LONG_AND_LOW' ? 26 : 46;
          const nextRsiHigh = arch === 'LONG_AND_LOW' ? 58 : 76;
          const nextStopAtr = arch === 'LONG_AND_LOW' ? 2.2 : 1.2;
          const nextTpAtr = arch === 'LONG_AND_LOW' ? 4.2 : 2.6;
          const nextKillAtr = arch === 'LONG_AND_LOW' ? 2.6 : 2.2;
          setBtRsiLow(nextRsiLow);
          setBtRsiHigh(nextRsiHigh);
          setBtStopAtr(nextStopAtr);
          setBtTpAtr(nextTpAtr);
          setBtKillAtr(nextKillAtr);
          runBacktestSimulation({
            symbol: sym,
            archetype: arch,
            rsiLow: nextRsiLow,
            rsiHigh: nextRsiHigh,
            stopAtr: nextStopAtr,
            tpAtr: nextTpAtr,
            killAtr: nextKillAtr,
          });
        }}
      />
    </div>
  );
};
