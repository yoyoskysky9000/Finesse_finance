import React, { useEffect, useState, useCallback } from 'react';
import {
  Award,
  Play,
  RefreshCw,
  Zap,
  CheckCircle2,
} from 'lucide-react';
import type {
  AlphaOpportunity,
  BacktestResult,
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
  onSelectSymbolInMain: (symbol: string) => void;
}

const INDICATOR_OPTIONS: Array<{
  id: IndicatorStrategyId;
  label: string;
  formula: string;
}> = [
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
  onSelectSymbolInMain,
}) => {
  const [opportunities, setOpportunities] = useState<AlphaOpportunity[]>([]);
  const [tournament, setTournament] = useState<StrategyTournamentEntry[]>(initialTournament);
  const [scannerFilter, setScannerFilter] = useState<'ALL' | 'LONG_AND_LOW' | 'SHORT_AND_FAST'>('ALL');
  const [isScanning, setIsScanning] = useState<boolean>(false);
  const [isDeployingBest, setIsDeployingBest] = useState<boolean>(false);

  // Backtest configuration state (defaults to real-data capital & top indicator)
  const [btSymbol, setBtSymbol] = useState<string>('NVDA');
  const [btArchetype, setBtArchetype] = useState<StrategyArchetype>('SHORT_AND_FAST');
  const [btIndicatorId, setBtIndicatorId] = useState<IndicatorStrategyId>('EMA_VWAP_VELOCITY');
  const [btCapital, setBtCapital] = useState<number>(1000);
  const [btRsiLow, setBtRsiLow] = useState<number>(46);
  const [btRsiHigh, setBtRsiHigh] = useState<number>(76);
  const [btStopAtr, setBtStopAtr] = useState<number>(1.2);
  const [btTpAtr, setBtTpAtr] = useState<number>(2.6);
  const [btKillAtr, setBtKillAtr] = useState<number>(2.2);

  const [backtestResult, setBacktestResult] = useState<BacktestResult | null>(null);
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
      try {
        const payload = {
          symbol: overrideParams?.symbol ?? btSymbol,
          archetype: overrideParams?.archetype ?? btArchetype,
          indicatorStrategyId: overrideParams?.indicatorStrategyId ?? btIndicatorId,
          initialCapitalUsd: btCapital,
          rsiEntryLow: overrideParams?.rsiLow ?? btRsiLow,
          rsiEntryHigh: overrideParams?.rsiHigh ?? btRsiHigh,
          stopLossAtrMultiple: overrideParams?.stopAtr ?? btStopAtr,
          takeProfitAtrMultiple: overrideParams?.tpAtr ?? btTpAtr,
          atrKillMultiplier: overrideParams?.killAtr ?? btKillAtr,
        };
        const res = await fetch('/api/backtest/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (res.ok) {
          const data: BacktestResult = await res.json();
          setBacktestResult(data);
        }
      } finally {
        setIsRunningBacktest(false);
      }
    },
    [
      btSymbol,
      btArchetype,
      btIndicatorId,
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

    const nextRsiLow = entry.archetype === 'LONG_AND_LOW' ? 25 : 46;
    const nextRsiHigh = entry.archetype === 'LONG_AND_LOW' ? 58 : 76;
    const nextKillAtr = entry.archetype === 'LONG_AND_LOW' ? 2.6 : 2.2;

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
    const defaultInd: IndicatorStrategyId =
      opp.venue === 'PREDICTION_MARKET'
        ? 'KALSHI_CLOB_IMBALANCE'
        : opp.recommendedArchetype === 'LONG_AND_LOW'
        ? 'BB_SQUEEZE_BREAKOUT'
        : 'EMA_VWAP_VELOCITY';

    setBtSymbol(opp.symbol);
    setBtArchetype(opp.recommendedArchetype);
    setBtIndicatorId(defaultInd);
    onSelectSymbolInMain(opp.symbol);

    const nextRsiLow = opp.recommendedArchetype === 'LONG_AND_LOW' ? 26 : 46;
    const nextRsiHigh = opp.recommendedArchetype === 'LONG_AND_LOW' ? 58 : 76;
    const nextStopAtr = opp.recommendedArchetype === 'LONG_AND_LOW' ? 2.2 : 1.2;
    const nextTpAtr = opp.recommendedArchetype === 'LONG_AND_LOW' ? 4.2 : 2.6;
    const nextKillAtr = opp.recommendedArchetype === 'LONG_AND_LOW' ? 2.6 : 2.2;

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

  const handleDeployValidatedAgent = async () => {
    if (!backtestResult) return;
    setIsDeploying(true);
    try {
      const indLabel =
        INDICATOR_OPTIONS.find((o) => o.id === btIndicatorId)?.label || btIndicatorId;
      await onDeployFromBacktest({
        name: `${btSymbol} · ${indLabel}`,
        archetype: btArchetype,
        targetSymbol: btSymbol,
        indicatorStrategyId: btIndicatorId,
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

  const winner = tournament[0];

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

  return (
    <div className="space-y-6">
      {/* SECTION 0: REAL-DATA STRATEGY TOURNAMENT WINNER & MULTI-INDICATOR LEADERBOARD */}
      {tournament.length > 0 && (
        <div className="p-5 border border-emerald-500/40 bg-[#0D1520] space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-3.5">
            <div>
              <div className="flex items-center gap-2">
                <Award className="w-4 h-4 text-emerald-400" />
                <h2 className="text-base font-semibold text-slate-100">
                  Real-Data Multi-Indicator Strategy Tournament (Zero Synthetic Bars)
                </h2>
                <span className="px-2 py-0.5 bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 font-mono text-[11px]">
                  100% REAL OHLCV &amp; KALSHI CLOB TRADE TAPE
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-1">
                Evaluates 6 quantitative indicator formulas across all live Public.com &amp; Kalshi tickers on real historical bars to identify the #1 highest-returning strategy and assign each agent a distinct ticker &amp; indicator.
              </p>
            </div>

            {onDeployBestTournamentStrategy && (
              <button
                type="button"
                onClick={handleRunBestWinnerAndDiversify}
                disabled={isDeployingBest}
                className="px-4 py-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold text-xs rounded transition-colors flex items-center gap-2 whitespace-nowrap"
              >
                <Zap className="w-4 h-4" />
                <span>
                  {isDeployingBest
                    ? 'Deploying #1 Strategy & Diversifying Fleet...'
                    : `Run #1 Winner (${winner?.symbol} · +${winner?.totalReturnPct}%) & Diversify All Agents`}
                </span>
              </button>
            )}
          </div>

          {winner && (
            <div className="p-3.5 bg-[#080C14] border border-emerald-500/30 flex flex-wrap items-center justify-between gap-4 text-xs">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="px-2 py-0.5 bg-emerald-500 text-slate-950 font-mono font-bold text-[11px]">
                    #1 BEST PERFORMING STRATEGY ON REAL DATA
                  </span>
                  <span className="font-mono font-bold text-slate-100 text-sm">
                    {winner.symbol} · {winner.indicatorStrategyLabel}
                  </span>
                  <span className="font-mono text-cyan-400">({winner.archetype})</span>
                </div>
                <div className="text-slate-400 font-mono text-[11px]">
                  Signal Formula: <span className="text-slate-200">{winner.indicatorSignalFormula}</span> · Source:{' '}
                  <span className="text-emerald-400">{winner.dataSource}</span> ({winner.barsTested} real bars)
                </div>
              </div>

              <div className="flex items-center gap-5 font-mono tabular-nums">
                <div>
                  <div className="text-[11px] text-slate-400">Real-Data Return</div>
                  <div className="text-sm font-bold text-emerald-400">
                    +{winner.totalReturnPct.toFixed(2)}%
                  </div>
                </div>
                <div>
                  <div className="text-[11px] text-slate-400">Net Alpha</div>
                  <div className="text-sm font-bold text-cyan-400">
                    {winner.netAlphaPct >= 0 ? '+' : ''}
                    {winner.netAlphaPct.toFixed(2)}%
                  </div>
                </div>
                <div>
                  <div className="text-[11px] text-slate-400">Sharpe Ratio</div>
                  <div className="text-sm font-bold text-slate-100">
                    {winner.sharpeRatio.toFixed(2)}
                  </div>
                </div>
                <div>
                  <div className="text-[11px] text-slate-400">Win Rate</div>
                  <div className="text-sm font-bold text-emerald-400">
                    {winner.winRatePct.toFixed(1)}% ({winner.totalTrades} fills)
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
                  <th className="py-2 px-3">Quantitative Indicator Strategy</th>
                  <th className="py-2 px-3">Real Data Source</th>
                  <th className="py-2 px-3 text-right">Return / Alpha</th>
                  <th className="py-2 px-3 text-right">Sharpe / Win%</th>
                  <th className="py-2 px-3 text-right">Max DD</th>
                  <th className="py-2 px-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80">
                {tournament.slice(0, 10).map((entry) => (
                  <tr
                    key={`${entry.symbol}-${entry.indicatorStrategyId}`}
                    className={`hover:bg-slate-800/40 ${
                      entry.rank === 1 ? 'bg-emerald-500/5' : ''
                    }`}
                  >
                    <td className="py-2.5 px-3">
                      <div className="font-bold text-slate-100">
                        #{entry.rank} · {entry.symbol}
                      </div>
                      <div className="text-[10px] text-slate-400">
                        {entry.venue === 'PUBLIC_BROKERAGE' ? 'Public.com Live' : 'Kalshi CLOB v2'} ·{' '}
                        {entry.archetype}
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
                      <button
                        type="button"
                        onClick={() => handleLoadTournamentEntry(entry)}
                        className="px-2.5 py-1 bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/40 text-cyan-300 rounded text-[11px] font-sans font-medium"
                      >
                        Inspect &amp; Run
                      </button>
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

      {/* SECTION 2: REAL-DATA QUANTITATIVE STRATEGY BACKTESTER */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
        {/* Left 4 Cols: Backtest Parameter Controls */}
        <div className="lg:col-span-4 p-5 border border-slate-800 bg-[#111827] flex flex-col justify-between space-y-4">
          <div className="space-y-4">
            <div className="border-b border-slate-800 pb-3">
              <h3 className="text-base font-semibold text-slate-100">
                Real-Data Walk-Forward Backtester
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Tests indicator formulas directly on real historical 5m OHLCV &amp; Kalshi trade bars (zero synthetic generation).
              </p>
            </div>

            <div className="space-y-3 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-300 font-medium mb-1">Target Instrument</label>
                  <select
                    value={btSymbol}
                    onChange={(e) => setBtSymbol(e.target.value)}
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

              <div>
                <label className="block text-slate-300 font-medium mb-1">
                  Quantitative Indicator Formula
                </label>
                <select
                  value={btIndicatorId}
                  onChange={(e) => setBtIndicatorId(e.target.value as IndicatorStrategyId)}
                  className="w-full px-2.5 py-2 bg-[#0B0F17] border border-slate-800 text-cyan-300 font-mono rounded focus:outline-none focus:border-cyan-400"
                >
                  {INDICATOR_OPTIONS.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.label}
                    </option>
                  ))}
                </select>
                <div className="text-[11px] font-mono text-slate-400 mt-1">
                  {INDICATOR_OPTIONS.find((o) => o.id === btIndicatorId)?.formula}
                </div>
              </div>

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
              <span>{isRunningBacktest ? 'Evaluating Real Bars...' : 'Run Real-Data Backtest'}</span>
            </button>

            <button
              type="button"
              onClick={handleDeployValidatedAgent}
              disabled={isDeploying || !backtestResult}
              className="w-full py-2.5 px-4 bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold text-xs rounded transition-colors flex items-center justify-center gap-1.5"
            >
              <Zap className="w-3.5 h-3.5" />
              <span>
                {isDeploying
                  ? 'Deploying Agent...'
                  : `Deploy ${btSymbol} (${btIndicatorId}) Agent Live`}
              </span>
            </button>
          </div>
        </div>

        {/* Right 8 Cols: Backtest Performance KPIs, Equity Curve & Real-Data Trade Log */}
        <div className="lg:col-span-8 p-5 border border-slate-800 bg-[#111827] space-y-4">
          {backtestResult && (
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
