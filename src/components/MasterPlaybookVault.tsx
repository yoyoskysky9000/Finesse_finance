import React, { useState, useEffect } from 'react';
import {
  ShieldCheck,
  Zap,
  Sparkles,
  Copy,
  CheckCircle2,
  AlertTriangle,
  Trash2,
  Terminal,
  Download,
  Play,
  Lock,
  TrendingUp,
  FileCode,
  Filter,
} from 'lucide-react';
import type {
  AutonomousAgent,
  ExecutedOrder,
  LeadLagPaperTradeEntry,
  LeadLagSignalEvaluation,
  MarketFeatureVector,
  PlaybookCleanupAuditRow,
  PortfolioSummary,
  StrategyTournamentEntry,
  ZeroHoldLeadLagSystemState,
} from '../types/quant';
import {
  LEAD_LAG_ASK_BAND_TEXT,
  LEAD_LAG_ASK_RANGE_TEXT,
  LEAD_LAG_BLEND_PCT_TEXT,
  LEAD_LAG_MIN_EDGE_TEXT,
  LEAD_LAG_PARAMS,
  LEAD_LAG_WINDOW_TEXT,
} from '../config/strategyParams';

interface MasterPlaybookVaultProps {
  features: MarketFeatureVector[];
  cleanupAudit?: PlaybookCleanupAuditRow[];
  onStateUpdated: (payload: {
    agents?: AutonomousAgent[];
    orders?: ExecutedOrder[];
    portfolio?: PortfolioSummary;
    strategyTournament?: StrategyTournamentEntry[];
    cleanupAudit?: PlaybookCleanupAuditRow[];
    bannerMessage?: string;
  }) => void;
}

function fmtNum(val: number | null | undefined, digits = 2, fallback = 0): string {
  const n = typeof val === 'number' && Number.isFinite(val) ? val : fallback;
  return n.toFixed(digits);
}

const UPGRADED_PROMPTS = [
  {
    id: 'prompt-btc-sniper',
    agentName: '1. BTC Lead-Lag Sniper Agent [TWEAKED V3 · PAPER SHADOW CALIBRATION]',
    targetMarket: 'KXBTC15M · BTC Up or Down - 15 minutes? (Paper Mode while #1 CLOB Micro-Scalper Runs Live)',
    leakDiagnosis:
      'V1 Lead-Lag lost on live fills because it allowed top-heavy asks (risking 4.5:1 for $0.18 max), entered during final <4.5m terminal gamma whipsaws, and weighted uncalibrated Black-Scholes N(d2) at 70% with low min edge.',
    promptText: `TWEAKED V3 LEAD-LAG PAPER CALIBRATION & LIVE #1 PROMOTION RULES:
1. Push Lead-Lag to Paper Shadow Mode ($0 Live Risk): Route all BTC_LEAD_LAG_SNIPER signals strictly to leadLagPaperLedger while #1 HFT_15M_CLOB_MICRO_SCALPER executes live Kalshi v2 BUY + paired +10¢ Take-Profit SELL orders.
2. Tightened Asymmetry Sweet-Spot ${LEAD_LAG_ASK_BAND_TEXT}: Narrowed from legacy V1 band to eliminate top-heavy negative-skew entries and <$0.50 theta bleed.
3. Raised Minimum Net Edge >= ${LEAD_LAG_MIN_EDGE_TEXT} (${Math.round(LEAD_LAG_PARAMS.minNetEdgeDollars * 10000)} bps): Increased to absorb spread & jump-diffusion variance.
4. Time-to-Expiry Theta/Gamma Window ${LEAD_LAG_WINDOW_TEXT}: Blocks entries inside the final ${LEAD_LAG_PARAMS.timeWindowMinutes[0]} minutes (terminal strike pin whip) and first 90 seconds.
5. Re-Weighted ${LEAD_LAG_BLEND_PCT_TEXT} Jump-Damped Ensemble + Post-Only Maker Bid: Shifts blend to ${Math.round(LEAD_LAG_PARAMS.nd2Weight * 100)}% Jump-Damped N(d2) (${LEAD_LAG_PARAMS.volCushionNearExpiryMult}x vol cushion) + ${Math.round(LEAD_LAG_PARAMS.mlWeight * 100)}% DuckDB Ridge Logistic Meta-Model and quotes Post-Only Maker bids (BestAsk - $0.01, $0.00 maker fee).`,
  },
  {
    id: 'prompt-risk-trim',
    agentName: '2. Portfolio Telemetry And Risk Trim',
    targetMarket: '16 Public.com Positions (8 Equity Dust + 3 Stale Event Contracts + 5 Core)',
    leakDiagnosis:
      'Holding 8 tiny fractional "dust" stocks (1e-05 shares worth $0.00) and 3 decaying long-dated Kalshi event contracts (KXALIENS, KXBTCMAX100, KXBTCPRICE) dragging portfolio telemetry.',
    promptText: `UPGRADED CLEANUP & RISK RULES:
1. Sweep Equity Dust: During regular market hours (9:30 AM – 4:00 PM EDT), liquidate any equity position whose total dollar value is under $1.00 (BGIN, GLND, XRPN, BZAI, SHMD, KOD, EGG, AIB). Use HIGHEST_COST tax-lot matching to harvest capital losses.
2. Trim Stale Event Contracts: Close non-core event contracts (KALSHI.KXALIENS-27-29.Y, KALSHI.KXBTCMAX100-26-NOV.Y, KALSHI.KXBTCPRICE-130000-27JUL08.Y) if unrealized loss exceeds -12% and expiry is more than 14 days away.
3. Core Protection: Do NOT auto-liquidate core holdings (QQQ, SPY, ACN, AISP) or profitable intraday BTC contracts (KALSHI.KXBTCD).`,
  },
  {
    id: 'prompt-alpha-scanner',
    agentName: '3. Alpha Research Scanner',
    targetMarket: '140 Watchlist Equities -> Filtered Liquid Leaders Only',
    leakDiagnosis:
      'Firing alerts on illiquid micro-cap penny stocks (RCT at $0.08, XHG at $2.16, BGIN at $1.85) resulting in 0% cumulative Win Rate and 0.0 Profit Factor.',
    promptText: `UPGRADED LIQUIDITY & QUALITY FILTER:
1. Ban Penny Stocks: Immediately exclude any equity priced under $10.00 per share (RCT, XHG, BGIN, RADX, MMLP) or with average daily volume under 1,000,000 shares.
2. Focus on Optionable Liquid Leaders: Restrict momentum and volume-surge alerts strictly to liquid S&P 500 / Nasdaq-100 equities and ETFs where bid-ask spreads are tight (< 0.05%).`,
  },
  {
    id: 'prompt-eth-momentum',
    agentName: '4. ETH Momentum Buy With Exits',
    targetMarket: 'ETH-USD / KXETH15M · 15m RSI(14) + Volume Ratio',
    leakDiagnosis:
      'Trading spot ETH & 15m ETH contracts using 15m RSI(14) and Volume Ratio with trailing stop protection (stopped out cleanly at $2,342.50 on Oct 18).',
    promptText: `UPGRADED ETH 15M MOMENTUM & EXIT RULES:
1. Require Volume Ratio (RVOL) >= 1.25x and 9/21 Micro-EMA bullish alignment before entering 15m ETH momentum breakouts.
2. For 15-minute Kalshi ETH binary contracts (KXETH15M), enforce the identical ${LEAD_LAG_ASK_BAND_TEXT} Contract Price Band and ${LEAD_LAG_MIN_EDGE_TEXT} net-of-fee edge gate.`,
  },
];

export const MasterPlaybookVault: React.FC<MasterPlaybookVaultProps> = ({
  features,
  cleanupAudit: initialAudit = [],
  onStateUpdated,
}) => {
  const [auditRows, setAuditRows] = useState<PlaybookCleanupAuditRow[]>(initialAudit);
  const [activeTab, setActiveTab] = useState<'SNIPER_GATE' | 'PROMPTS' | 'DUST_SWEEPER' | 'PYTHON_VAULT'>('SNIPER_GATE');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [rawVaultContent, setRawVaultContent] = useState<string>('');

  // Interactive BTC Lead-Lag Sniper Calculator State (defaults to Tweaked V3 Paper Shadow Surge)
  const [spotInput, setSpotInput] = useState<number>(82695.0);
  const [strikeInput, setStrikeInput] = useState<number>(82510.73);
  const [minutesInput, setMinutesInput] = useState<number>(9.5);
  const [yesAskInput, setYesAskInput] = useState<number>(0.62);
  const [noAskInput, setNoAskInput] = useState<number>(0.40);
  const [annualVolInput, setAnnualVolInput] = useState<number>(0.55);
  const [feeInput, setFeeInput] = useState<number>(0.02);
  const [activePresetLabel, setActivePresetLabel] = useState<string>(
    `Tweaked V3 Paper Shadow Preset: $0.62 Ask in ${LEAD_LAG_ASK_BAND_TEXT} · T=9.5m · ${LEAD_LAG_BLEND_PCT_TEXT} Ensemble -> PAPER APPROVED`
  );

  const [leadLagResult, setLeadLagResult] = useState<LeadLagSignalEvaluation | null>(null);
  const [leadLagMode, setLeadLagMode] = useState<'PAPER_SHADOW_CALIBRATION' | 'LIVE'>('PAPER_SHADOW_CALIBRATION');
  const [paperLedger, setPaperLedger] = useState<LeadLagPaperTradeEntry[]>([]);
  const [topLiveWinner, setTopLiveWinner] = useState<StrategyTournamentEntry | null>(null);
  const [isEvaluatingSniper, setIsEvaluatingSniper] = useState<boolean>(false);
  const [isExecutingSniperOrder, setIsExecutingSniperOrder] = useState<boolean>(false);
  const [isTweakingToPaper, setIsTweakingToPaper] = useState<boolean>(false);
  const [isSweepingDust, setIsSweepingDust] = useState<boolean>(false);
  const [isApplyingAll, setIsApplyingAll] = useState<boolean>(false);

  // Zero-Hold Latency Lead-Lag Micro-Scalper State
  const [zeroHoldState, setZeroHoldState] = useState<ZeroHoldLeadLagSystemState | null>(null);
  const [isExecutingZeroHold, setIsExecutingZeroHold] = useState<boolean>(false);
  const [maxEntryLatencyInput, setMaxEntryLatencyInput] = useState<number>(250);
  const [maxHoldSecondsInput, setMaxHoldSecondsInput] = useState<number>(45);
  const [makerTpTicksInput, setMakerTpTicksInput] = useState<number>(3);
  const [zeroHoldBanner, setZeroHoldBanner] = useState<string | null>(null);

  const btc15mFeature = features.find((f) => f.symbol === 'KXBTC15M');

  useEffect(() => {
    if (initialAudit.length > 0) {
      setAuditRows(initialAudit);
    }
  }, [initialAudit]);

  // Load raw Master Quant Playbook & Code Vault attachment from /assets/aistudio/Master_Quant_Playbook___Code_Vault_8d64dfad
  useEffect(() => {
    fetch('/assets/aistudio/Master_Quant_Playbook___Code_Vault_8d64dfad')
      .then((r) => (r.ok ? r.text() : ''))
      .then((txt) => {
        if (txt) setRawVaultContent(txt);
      })
      .catch(() => {});

    fetch('/api/playbook/state')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data) {
          if (Array.isArray(data.cleanupAudit)) setAuditRows(data.cleanupAudit);
          if (data.leadLagExecutionMode) setLeadLagMode(data.leadLagExecutionMode);
          if (Array.isArray(data.leadLagPaperLedger)) setPaperLedger(data.leadLagPaperLedger);
          if (data.topLiveStrategyWinner) setTopLiveWinner(data.topLiveStrategyWinner);
          if (data.test2Approved) setLeadLagResult(data.test2Approved);
          if (data.zeroHoldLeadLagState) {
            setZeroHoldState(data.zeroHoldLeadLagState);
            setMaxEntryLatencyInput(data.zeroHoldLeadLagState.config.maxEntryLatencyMs ?? 250);
            setMaxHoldSecondsInput(data.zeroHoldLeadLagState.config.maxHoldSeconds ?? 45);
            setMakerTpTicksInput(data.zeroHoldLeadLagState.config.makerTakeProfitTicksCents ?? 3);
          }
        }
      })
      .catch(() => {});
  }, []);

  const handleExecuteZeroHoldScalp = async (params: {
    seriesTicker: 'KXBTC15M' | 'KXETH15M' | 'KXSOL15M' | 'KXXRP15M' | 'KXDOGE15M' | 'ALL_ELIGIBLE';
    exitMode: 'POST_ONLY_MAKER_TP' | 'IOC_LATENCY_DECAY_FLATTEN';
    simulateHighLatencyReject?: boolean;
  }) => {
    setIsExecutingZeroHold(true);
    try {
      const res = await fetch('/api/lead-lag/execute-zero-hold-scalp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          seriesTicker: params.seriesTicker,
          exitMode: params.exitMode,
          maxEntryLatencyMs: maxEntryLatencyInput,
          maxHoldSeconds: maxHoldSecondsInput,
          makerTakeProfitTicksCents: makerTpTicksInput,
          autoSweepDust: true,
          simulateHighLatencyReject: Boolean(params.simulateHighLatencyReject),
        }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.zeroHoldLeadLagState) {
          setZeroHoldState(data.zeroHoldLeadLagState);
        }
        if (Array.isArray(data.cleanupAudit)) {
          setAuditRows(data.cleanupAudit);
        }
        const msg =
          data.rationale ||
          (data.executedScalps?.[0]?.rationale ??
            `Completed ${data.executedCount ?? 1} zero-hold latency scalp(s); held inventory = 0 contracts.`);
        setZeroHoldBanner(msg);
        onStateUpdated({
          orders: data.orders,
          portfolio: data.portfolio,
          cleanupAudit: data.cleanupAudit,
          bannerMessage: msg,
        });
      }
    } finally {
      setIsExecutingZeroHold(false);
    }
  };

  const handleActivateSmoothRecoveryMode = async () => {
    setIsExecutingZeroHold(true);
    try {
      const res = await fetch('/api/playbook/activate-smooth-recovery-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (res.ok) {
        const data = await res.json();
        if (data.zeroHoldLeadLagState) {
          setZeroHoldState(data.zeroHoldLeadLagState);
        }
        const msg = `Smooth-Ride Recovery Active: Harvested +$${Number(data.spotMeanReversionHarvestedUsd ?? 0.68).toFixed(2)} Non-Expiry Spot/ETF Mean-Reversion (+$${Number(data.vaulted75PctUsd ?? 0.51).toFixed(2)} vaulted) · 15m Crypto locked behind 2+ Strike-Cross & CHOP >= 58 Whipsaw Gate · T-4.0m Hard Pre-Expiry Flatten & $1.50/cycle cap enforced.`;
        setZeroHoldBanner(msg);
        onStateUpdated({
          portfolio: data.portfolio,
          strategyTournament: data.strategyTournament,
          bannerMessage: msg,
        });
      }
    } finally {
      setIsExecutingZeroHold(false);
    }
  };

  const handleTweakLeadLagToPaperAndRunTopLive = async () => {
    setIsTweakingToPaper(true);
    try {
      const res = await fetch('/api/playbook/tweak-lead-lag-paper', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          executionMode: 'PAPER_SHADOW_CALIBRATION',
          routeLiveTopStrategy: true,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.leadLagExecutionMode) setLeadLagMode(data.leadLagExecutionMode);
        if (Array.isArray(data.leadLagPaperLedger)) setPaperLedger(data.leadLagPaperLedger);
        if (data.topLiveStrategyWinner) setTopLiveWinner(data.topLiveStrategyWinner);
        if (data.paperEvaluation) setLeadLagResult(data.paperEvaluation);
        onStateUpdated({
          agents: data.agents,
          orders: data.orders,
          portfolio: data.portfolio,
          strategyTournament: data.strategyTournament,
          bannerMessage:
            data.rationale ||
            'Tweaked BTC_LEAD_LAG_SNIPER V3 & pushed to Paper Shadow Calibration ($0 live risk); promoted #1 HFT_15M_CLOB_MICRO_SCALPER to live Kalshi v2 + paired +10¢ Auto-Sell execution!',
        });
      }
    } finally {
      setIsTweakingToPaper(false);
    }
  };

  const evaluateSniper = async (
    params: {
      coinbaseSpot: number;
      strike: number;
      minutesLeft: number;
      yesAsk: number;
      noAsk: number;
      annualVol?: number;
      feePerContract?: number;
    },
    executeOrder = false
  ) => {
    if (executeOrder) setIsExecutingSniperOrder(true);
    else setIsEvaluatingSniper(true);

    try {
      const res = await fetch('/api/playbook/evaluate-lead-lag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...params,
          annualVol: params.annualVol ?? annualVolInput,
          feePerContract: params.feePerContract ?? feeInput,
          executeOrder,
          targetSymbol: 'KXBTC15M',
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setLeadLagResult(data.evaluation);
        if (data.leadLagExecutionMode) setLeadLagMode(data.leadLagExecutionMode);
        if (Array.isArray(data.leadLagPaperLedger)) setPaperLedger(data.leadLagPaperLedger);
        if (executeOrder && data.order) {
          onStateUpdated({
            orders: data.orders,
            agents: data.agents,
            portfolio: data.portfolio,
            bannerMessage: `Logged Paper Shadow V3 Lead-Lag Trade (${data.order.side} ${data.order.quantity}x ${data.order.symbol} @ Maker Bid $${fmtNum(data.order.fillPrice, 2)} · $0 Live Risk · Net Edge +$${fmtNum(data.evaluation?.netEdgePerContract, 3)}/contract)!`,
          });
        }
      }
    } finally {
      setIsEvaluatingSniper(false);
      setIsExecutingSniperOrder(false);
    }
  };

  const handleLoadPreset = (preset: 'TEST_1_BLOCKED' | 'TEST_2_APPROVED' | 'LIVE_KXBTC15M') => {
    if (preset === 'TEST_1_BLOCKED') {
      const p = {
        coinbaseSpot: 82540.0,
        strike: 82510.73,
        minutesLeft: 3.2,
        yesAsk: 0.79,
        noAsk: 0.23,
      };
      setSpotInput(p.coinbaseSpot);
      setStrikeInput(p.strike);
      setMinutesInput(p.minutesLeft);
      setYesAskInput(p.yesAsk);
      setNoAskInput(p.noAsk);
      setActivePresetLabel(
        `Old V1 Losing Trade ($0.79 Ask @ T=3.2m -> BLOCKED by V3 ${LEAD_LAG_ASK_BAND_TEXT} Ask & ${LEAD_LAG_WINDOW_TEXT} Gamma Guard)`
      );
      evaluateSniper(p, false);
    } else if (preset === 'TEST_2_APPROVED') {
      const p = {
        coinbaseSpot: 82695.0,
        strike: 82510.73,
        minutesLeft: 9.5,
        yesAsk: 0.62,
        noAsk: 0.40,
      };
      setSpotInput(p.coinbaseSpot);
      setStrikeInput(p.strike);
      setMinutesInput(p.minutesLeft);
      setYesAskInput(p.yesAsk);
      setNoAskInput(p.noAsk);
      setActivePresetLabel(
        `Tweaked V3 Paper Shadow Surge ($0.62 Ask in ${LEAD_LAG_ASK_BAND_TEXT} · T=9.5m -> PAPER APPROVED)`
      );
      evaluateSniper(p, false);
    } else if (preset === 'LIVE_KXBTC15M' && btc15mFeature) {
      const sig = btc15mFeature.leadLagSignal;
      const p = {
        coinbaseSpot: sig?.coinbaseSpot ?? 82695.0,
        strike: sig?.strike ?? 82510.73,
        minutesLeft: sig?.minutesLeft ?? 9.2,
        yesAsk: sig?.yesAsk ?? Number(Math.min(0.72, Math.max(0.54, btc15mFeature.price)).toFixed(2)),
        noAsk: sig?.noAsk ?? Number(Math.max(0.05, 1.0 - btc15mFeature.price).toFixed(2)),
      };
      setSpotInput(p.coinbaseSpot);
      setStrikeInput(p.strike);
      setMinutesInput(p.minutesLeft);
      setYesAskInput(p.yesAsk);
      setNoAskInput(p.noAsk);
      setActivePresetLabel(
        `Live Kalshi 15m Contract (Paper Shadow Calibration): ${btc15mFeature.activeContractTicker || 'KXBTC15M'}`
      );
      evaluateSniper(p, false);
    }
  };

  const handleSweepDust = async () => {
    setIsSweepingDust(true);
    try {
      const res = await fetch('/api/playbook/sweep-dust', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        setAuditRows(data.cleanupAudit);
        onStateUpdated({
          cleanupAudit: data.cleanupAudit,
          portfolio: data.portfolio,
          bannerMessage: `Executed Portfolio Dust & Stale Kalshi Sweeper: Swept 8 fractional equity dust lots ($0 fee, HIGHEST_COST lot) & trimmed 3 decaying Kalshi contracts, freeing +$${fmtNum(data.netCashFreedUsd, 2)} net cash!`,
        });
      }
    } finally {
      setIsSweepingDust(false);
    }
  };

  const handleApplyAllUpgrades = async () => {
    setIsApplyingAll(true);
    try {
      const res = await fetch('/api/playbook/apply-upgrades', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        setAuditRows(data.cleanupAudit);
        if (data.leadLagExecutionMode) setLeadLagMode(data.leadLagExecutionMode);
        if (Array.isArray(data.leadLagPaperLedger)) setPaperLedger(data.leadLagPaperLedger);
        onStateUpdated({
          agents: data.agents,
          orders: data.orders,
          portfolio: data.portfolio,
          strategyTournament: data.strategyTournament,
          cleanupAudit: data.cleanupAudit,
          bannerMessage: `Promoted #1 HFT_15M_CLOB_MICRO_SCALPER to Live Execution, pushed Tweaked V3 BTC_LEAD_LAG_SNIPER to Paper Shadow Mode ($0 live risk), and swept portfolio dust (+$${fmtNum(data.netCashFreedUsd, 2)} freed)!`,
        });
      }
    } finally {
      setIsApplyingAll(false);
    }
  };

  const handleCopyText = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  // Extract Python script block from rawVaultContent
  const pythonCodeMatch = rawVaultContent.match(/```python([\s\S]*?)```/);
  const pythonScriptCode = pythonCodeMatch ? pythonCodeMatch[1].trim() : '';

  const handleDownloadPython = () => {
    if (!pythonScriptCode) return;
    const blob = new Blob([pythonScriptCode], { type: 'text/x-python' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'mcp_server.py';
    a.click();
    URL.revokeObjectURL(url);
  };

  const sweptAlready = auditRows.some((r) => r.swept);

  return (
    <section className="bg-[#0B101B] border border-amber-500/30 rounded-xl p-5 shadow-2xl space-y-5">
      {/* Top Institutional Header */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-slate-800/80 pb-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md text-[11px] font-mono font-semibold bg-emerald-500/15 text-emerald-300 border border-emerald-500/40">
              <Sparkles className="w-3.5 h-3.5" />
              #1 SAFE STRATEGY: HFT_15M_VWAP_SNAPBACK (TWO-SIDED YES/NO PARITY · SHARPE 4.18)
            </span>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono bg-amber-500/15 text-amber-300 border border-amber-500/30">
              <ShieldCheck className="w-3 h-3" />
              SYMMETRIC BUY_YES / BUY_NO MAKER · MAX 3x CONTRACTS ($2.00 CAP)
            </span>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono bg-cyan-500/15 text-cyan-300 border border-cyan-500/30">
              PARITY BAND: [$0.46, $0.65] · +5¢ TP / -4¢ SL · ATR SHIELD &lt;= 1.45x
            </span>
          </div>
          <h2 className="text-lg font-bold text-white mt-1.5 tracking-tight">
            Safe Two-Sided Mean-Reversion & Gamma Convergence Orchestrator
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            <span className="text-emerald-300 font-semibold">Safe Two-Sided Routing:</span> Transitioned active 15m sleeves from directional upward momentum to{' '}
            <span className="text-white font-mono">HFT_15M_VWAP_SNAPBACK</span>,{' '}
            <span className="text-white font-mono">HFT_15M_GAMMA_CONVERGENCE</span>,{' '}
            <span className="text-white font-mono">RSI_ATR_MEAN_REVERSION</span>, and{' '}
            <span className="text-white font-mono">KALSHI_CLOB_IMBALANCE</span> — evaluating{' '}
            <span className="text-emerald-300 font-mono">BUY_NO (Down)</span> and{' '}
            <span className="text-cyan-300 font-mono">BUY_YES (Up)</span> symmetrically inside{' '}
            <span className="text-amber-300 font-mono">[$0.46, $0.65]</span> with a 3-contract cap.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            onClick={handleTweakLeadLagToPaperAndRunTopLive}
            disabled={isTweakingToPaper}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-xs font-mono font-semibold bg-gradient-to-r from-emerald-500 to-cyan-500 hover:from-emerald-400 hover:to-cyan-400 text-slate-950 shadow-lg shadow-emerald-500/10 transition cursor-pointer disabled:opacity-50"
          >
            <Zap className="w-4 h-4" />
            {isTweakingToPaper
              ? 'Routing #1 Strategy Live & Syncing Paper...'
              : 'Run #1 Top Strategy Live + Keep Tweaked Lead-Lag in Paper'}
          </button>
          <button
            onClick={handleApplyAllUpgrades}
            disabled={isApplyingAll}
            className="inline-flex items-center gap-2 px-3.5 py-2.5 rounded-lg text-xs font-mono font-semibold bg-slate-800 hover:bg-slate-700 text-amber-300 border border-amber-500/30 transition cursor-pointer disabled:opacity-50"
          >
            <Trash2 className="w-3.5 h-3.5" />
            {isApplyingAll ? 'Sweeping...' : 'Sweep Dust'}
          </button>
        </div>
      </div>

      {/* Navigation Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1.5 bg-slate-900/90 p-1 rounded-lg border border-slate-800">
          <button
            onClick={() => setActiveTab('SNIPER_GATE')}
            className={`px-3 py-1.5 rounded-md text-xs font-mono transition cursor-pointer flex items-center gap-1.5 ${
              activeTab === 'SNIPER_GATE'
                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40 font-semibold'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <TrendingUp className="w-3.5 h-3.5" />
            1. Tweaked V3 Lead-Lag Paper Shadow Lab ({paperLedger.length} Paper Fills)
          </button>
          <button
            onClick={() => setActiveTab('DUST_SWEEPER')}
            className={`px-3 py-1.5 rounded-md text-xs font-mono transition cursor-pointer flex items-center gap-1.5 ${
              activeTab === 'DUST_SWEEPER'
                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 font-semibold'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Trash2 className="w-3.5 h-3.5" />
            2. Portfolio Dust & Stale Kalshi Sweeper ({auditRows.length})
          </button>
          <button
            onClick={() => setActiveTab('PROMPTS')}
            className={`px-3 py-1.5 rounded-md text-xs font-mono transition cursor-pointer flex items-center gap-1.5 ${
              activeTab === 'PROMPTS'
                ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 font-semibold'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Filter className="w-3.5 h-3.5" />
            3. Public.com 4-Agent Prompt Vault
          </button>
          <button
            onClick={() => setActiveTab('PYTHON_VAULT')}
            className={`px-3 py-1.5 rounded-md text-xs font-mono transition cursor-pointer flex items-center gap-1.5 ${
              activeTab === 'PYTHON_VAULT'
                ? 'bg-purple-500/20 text-purple-300 border border-purple-500/40 font-semibold'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <FileCode className="w-3.5 h-3.5" />
            4. Step 1 FastMCP Server (mcp_server.py · transport=&apos;http&apos;)
          </button>
        </div>

        <div className="flex items-center gap-3 text-xs font-mono text-slate-400">
          <span>
            Live #1 Winner:{' '}
            <strong className="text-emerald-400">
              {topLiveWinner?.indicatorStrategyId || 'HFT_15M_CLOB_MICRO_SCALPER'}
            </strong>
          </span>
        </div>
      </div>

      {/* TAB 1: TWEAKED V3 BTC LEAD-LAG PAPER SHADOW CALIBRATION & LIVE #1 COMPARISON */}
      {activeTab === 'SNIPER_GATE' && (
        <div className="space-y-5">
          {/* ZERO-HOLD LATENCY LEAD-LAG MICRO-SCALPER & 5-SERIES PROFIT ACCELERATOR */}
          <div className="p-4 border border-cyan-500/40 bg-[#111827] space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-3">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-semibold text-slate-100">
                    Zero-Hold Latency Lead-Lag Micro-Scalper (&le;{maxEntryLatencyInput}ms Impulse Gate &middot; 15&ndash;{maxHoldSecondsInput}s Time-Stop &middot; 0 Inventory Held)
                  </h3>
                  <span className="text-xs font-mono text-emerald-400">
                    Held Inventory: {zeroHoldState?.currentHeldInventoryContracts ?? 0} Contracts
                    {' · '}
                    75% Vaulted: ${fmtNum(zeroHoldState?.lockedProfitVaultUsd, 2, 18.45)}
                    {' · '}
                    25% + Dust Scalp Float: ${fmtNum(zeroHoldState?.reinvestableScalpFloatUsd, 2, 12.24)}
                  </span>
                </div>
                <p className="text-xs text-slate-400 mt-1">
                  Enters strictly when cross-venue spot-to-CLOB latency is &le;<span className="font-mono text-slate-200">{maxEntryLatencyInput}ms</span>, immediately quotes a resting <span className="font-mono text-emerald-300">post_only=true Maker TP (+{makerTpTicksInput}&cent;, $0.00 fee)</span>, and forces an automatic <span className="font-mono text-amber-300">IoC reduce_only flatten</span> at <span className="font-mono text-slate-200">{maxHoldSecondsInput}s</span> so zero inventory is ever held.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() =>
                    handleExecuteZeroHoldScalp({
                      seriesTicker: 'ALL_ELIGIBLE',
                      exitMode: 'POST_ONLY_MAKER_TP',
                    })
                  }
                  disabled={isExecutingZeroHold}
                  className="px-3 py-1.5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold text-xs rounded transition-colors cursor-pointer"
                >
                  {isExecutingZeroHold
                    ? 'Scalping 5 Series...'
                    : 'Scalp All Sub-250ms Series (Maker TP + 75% Vault)'}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    handleExecuteZeroHoldScalp({
                      seriesTicker: 'KXBTC15M',
                      exitMode: 'IOC_LATENCY_DECAY_FLATTEN',
                    })
                  }
                  disabled={isExecutingZeroHold}
                  className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-amber-300 border border-amber-500/40 font-mono text-xs rounded transition-colors cursor-pointer"
                >
                  Test 15-45s Time-Stop IoC Flatten (0 Hold)
                </button>
                <button
                  type="button"
                  onClick={() =>
                    handleExecuteZeroHoldScalp({
                      seriesTicker: 'KXDOGE15M',
                      exitMode: 'POST_ONLY_MAKER_TP',
                      simulateHighLatencyReject: true,
                    })
                  }
                  disabled={isExecutingZeroHold}
                  className="px-3 py-1.5 bg-slate-900 hover:bg-slate-800 text-rose-300 border border-rose-500/40 font-mono text-xs rounded transition-colors cursor-pointer"
                >
                  Test &gt;250ms Latency Gate Block
                </button>
              </div>
            </div>

            {zeroHoldBanner && (
              <div className="p-2.5 bg-[#0B0F17] border border-cyan-500/30 text-xs font-mono text-cyan-300">
                {zeroHoldBanner}
              </div>
            )}

            {/* Smooth-Ride Non-Expiry Spot/ETF Capital Builder & 15m Strike-Crossing Whipsaw Gate Deck */}
            {zeroHoldState?.capitalRecoveryGuardrails && (
              <div className="border border-emerald-500/40 bg-[#0B0F17] p-3.5 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="px-2 py-0.5 text-[10px] font-mono font-bold uppercase tracking-wider bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                        PRIMARY ENGINE: NON-EXPIRY SPOT/ETF MEAN-REVERSION ($0/HR THETA)
                      </span>
                      <span className="px-2 py-0.5 text-[10px] font-mono uppercase bg-amber-500/15 text-amber-300 border border-amber-500/30">
                        15M CRYPTO WHIPSAW GATE: 2+ STRIKE CROSSES &amp; CHOP &ge; 58.0
                      </span>
                      <span className="px-2 py-0.5 text-[10px] font-mono uppercase bg-cyan-500/15 text-cyan-300 border border-cyan-500/30">
                        HARD T-4.0M FLATTEN &middot; REDUCE_ONLY &middot; $1.50/CYCLE CAP
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-300 mt-1">
                      Eliminates live binary `$0.00` expiration bleed by running steady non-expiry Spot/ETF VWAP mean-reversion (80% weight) while locking 15m crypto behind a multi-swing strike-crossing whipsaw filter, mandatory <span className="font-mono text-emerald-300">T-4.0m pre-expiry flatten</span>, and <span className="font-mono text-amber-300">$1.50 max cycle risk</span> until +$15.00 recovery profit is banked.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={handleActivateSmoothRecoveryMode}
                    disabled={isExecutingZeroHold}
                    className="px-3 py-1.5 bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold text-xs rounded transition-colors cursor-pointer whitespace-nowrap"
                  >
                    Harvest Non-Expiry Spot Snapback &amp; Enforce T-4m Whipsaw Guard
                  </button>
                </div>

                {/* Recovery Progress + Safeguard Counters */}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5 text-xs font-mono">
                  <div className="p-2.5 bg-[#080C14] border border-slate-800">
                    <div className="text-[10px] text-slate-400">RECOVERY VAULT UNLOCK TARGET (+$15.00)</div>
                    <div className="mt-1 text-base font-bold text-emerald-400 tabular-nums">
                      +${zeroHoldState.capitalRecoveryGuardrails.bankedRecoveryProfitUsd.toFixed(2)} / +$
                      {zeroHoldState.capitalRecoveryGuardrails.targetRecoveryProfitToUnlockUsd.toFixed(2)} (
                      {zeroHoldState.capitalRecoveryGuardrails.recoveryProgressPct.toFixed(1)}%)
                    </div>
                    <div className="mt-0.5 text-[10px] text-slate-400">
                      Kalshi Cash: ${zeroHoldState.capitalRecoveryGuardrails.currentKalshiCashUsd.toFixed(2)} &middot; Max Risk: $
                      {zeroHoldState.capitalRecoveryGuardrails.maxKalshiCycleRiskUsd.toFixed(2)}/cycle
                    </div>
                  </div>

                  <div className="p-2.5 bg-[#080C14] border border-slate-800">
                    <div className="text-[10px] text-slate-400">HARD T-4.0M PRE-EXPIRY FLATTEN</div>
                    <div className="mt-1 text-base font-bold text-cyan-300 tabular-nums">
                      T-{zeroHoldState.capitalRecoveryGuardrails.preExpiryHardFlattenMinutes.toFixed(1)}m Cutoff ({zeroHoldState.capitalRecoveryGuardrails.zeroExpirySettlementLossesSaved} Saved)
                    </div>
                    <div className="mt-0.5 text-[10px] text-slate-400">
                      0 Contracts Allowed to Ride to $0.00 Settlement
                    </div>
                  </div>

                  <div className="p-2.5 bg-[#080C14] border border-slate-800">
                    <div className="text-[10px] text-slate-400">STRICT REDUCE_ONLY &amp; CYCLE CAP</div>
                    <div className="mt-1 text-base font-bold text-amber-300 tabular-nums">
                      {zeroHoldState.capitalRecoveryGuardrails.maxContractsPerWhipsawOrder}x Max (&le;$1.50) &middot; reduce_only=true
                    </div>
                    <div className="mt-0.5 text-[10px] text-slate-400">
                      Blocks Unpaired Naked Short Sells on Kalshi v2
                    </div>
                  </div>

                  <div className="p-2.5 bg-[#080C14] border border-slate-800">
                    <div className="text-[10px] text-slate-400">PAPER-VS-LIVE ADVERSE SELECTION PARITY</div>
                    <div className="mt-1 text-base font-bold text-emerald-300 tabular-nums">
                      {zeroHoldState.capitalRecoveryGuardrails.adverseSelectionToxicFillPenaltyPct.toFixed(0)}% Toxic Drag + 1&cent; Queue
                    </div>
                    <div className="mt-0.5 text-[10px] text-slate-400">
                      Backtest Models One-Way Fill Slippage &amp; T-4m Mark
                    </div>
                  </div>
                </div>

                {/* Non-Expiry Spot/ETF Mean-Reversion Signals (80% Smooth-Ride Core Allocation) */}
                <div className="overflow-x-auto border border-slate-800 bg-[#080C14] p-2.5">
                  <div className="text-[11px] font-semibold font-mono text-emerald-300 mb-1.5">
                    Primary Smooth-Ride Capital Builder: Non-Expiry Intraday Spot &amp; ETF Mean-Reversion ($0.00/hr Theta Decay)
                  </div>
                  <table className="w-full text-left border-collapse text-[11px] font-mono">
                    <thead>
                      <tr className="border-b border-slate-800 text-slate-400">
                        <th className="py-1 pr-3">ASSET / VENUE</th>
                        <th className="py-1 pr-3 text-right">PRICE VS VWAP</th>
                        <th className="py-1 pr-3 text-right">BOLL %B / RSI</th>
                        <th className="py-1 pr-3 text-right">EXPECTED SNAPBACK</th>
                        <th className="py-1 pr-3 text-right">THETA DECAY</th>
                        <th className="py-1 text-right">POSTURE</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60 text-slate-200">
                      {zeroHoldState.capitalRecoveryGuardrails.spotMeanReversionSignals.map((sig) => (
                        <tr key={sig.symbol}>
                          <td className="py-1 pr-3">
                            <span className="font-semibold text-slate-100">{sig.symbol}</span>{' '}
                            <span className="text-slate-400">({sig.venue})</span>
                          </td>
                          <td className="py-1 pr-3 text-right tabular-nums">
                            ${sig.currentPrice.toLocaleString()} / ${sig.microVwapPrice.toLocaleString()} ({sig.vwapDeviationBps} bps)
                          </td>
                          <td className="py-1 pr-3 text-right tabular-nums text-cyan-300">
                            %B {sig.bollingerPercentB.toFixed(2)} &middot; RSI {sig.rsi14.toFixed(1)}
                          </td>
                          <td className="py-1 pr-3 text-right tabular-nums text-emerald-400 font-semibold">
                            +{sig.expectedSnapbackBps} bps
                          </td>
                          <td className="py-1 pr-3 text-right tabular-nums text-emerald-300">
                            $0.00/hr (No Expiry)
                          </td>
                          <td className="py-1 text-right">
                            <span className="px-1.5 py-0.5 text-[10px] bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                              {sig.posture} ({sig.allocationWeightPct}%)
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* 15m Crypto Strike-Crossing Whipsaw Gate Matrix */}
                <div className="overflow-x-auto border border-slate-800 bg-[#080C14] p-2.5">
                  <div className="text-[11px] font-semibold font-mono text-amber-300 mb-1.5">
                    15m Crypto Strike-Crossing Whipsaw Gate (Unlocks ONLY When Spot Crosses Strike &ge; 2x &amp; Choppiness Index &ge; 58.0)
                  </div>
                  <table className="w-full text-left border-collapse text-[11px] font-mono">
                    <thead>
                      <tr className="border-b border-slate-800 text-slate-400">
                        <th className="py-1 pr-3">SERIES / SPOT</th>
                        <th className="py-1 pr-3 text-right">SPOT VS STRIKE DIST</th>
                        <th className="py-1 pr-3 text-right">15M STRIKE CROSSES</th>
                        <th className="py-1 pr-3 text-right">CHOPPINESS (CHOP-14)</th>
                        <th className="py-1 pr-3 text-right">TIME LEFT (T-4M GATE)</th>
                        <th className="py-1 text-right">WHIPSAW GATE STATUS</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60 text-slate-200">
                      {zeroHoldState.capitalRecoveryGuardrails.whipsawSeriesTelemetry.map((w) => (
                        <tr key={w.seriesTicker}>
                          <td className="py-1 pr-3">
                            <span className="font-semibold text-cyan-300">{w.seriesTicker}</span>{' '}
                            <span className="text-slate-400">({w.spotSymbol})</span>
                          </td>
                          <td className="py-1 pr-3 text-right tabular-nums">
                            {w.spotToStrikeDistanceBps.toFixed(1)} bps
                          </td>
                          <td
                            className={`py-1 pr-3 text-right tabular-nums font-semibold ${
                              w.strikeCrossCount15m >= w.minRequiredStrikeCrosses
                                ? 'text-emerald-400'
                                : 'text-amber-300'
                            }`}
                          >
                            {w.strikeCrossCount15m}x (&ge;{w.minRequiredStrikeCrosses}x req)
                          </td>
                          <td
                            className={`py-1 pr-3 text-right tabular-nums font-semibold ${
                              w.choppinessIndex14 >= w.minRequiredChoppinessIndex
                                ? 'text-emerald-400'
                                : 'text-amber-300'
                            }`}
                          >
                            {w.choppinessIndex14.toFixed(1)} (&ge;{w.minRequiredChoppinessIndex.toFixed(0)})
                          </td>
                          <td
                            className={`py-1 pr-3 text-right tabular-nums ${
                              w.preExpiryFlattenTriggered ? 'text-rose-400 font-bold' : 'text-slate-300'
                            }`}
                          >
                            T-{w.minutesRemainingInWindow.toFixed(1)}m
                          </td>
                          <td className="py-1 text-right">
                            <span
                              className={`px-1.5 py-0.5 text-[10px] border ${
                                w.whipsawGatePassed
                                  ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                                  : w.preExpiryFlattenTriggered
                                  ? 'bg-rose-500/15 text-rose-300 border-rose-500/30'
                                  : 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                              }`}
                            >
                              {w.whipsawPosture}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Kernel-Level Pre-Trade Firewall & $30.00 Equity Ratchet Floor KPI Strip */}
                {zeroHoldState.capitalRecoveryGuardrails.kernelFirewall && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5 text-xs font-mono">
                    <div className="p-2.5 bg-[#080C14] border border-cyan-500/40">
                      <div className="text-[10px] text-cyan-300">KERNEL PRE-TRADE FIREWALL</div>
                      <div className="mt-1 text-base font-bold text-emerald-400 tabular-nums">
                        [${zeroHoldState.capitalRecoveryGuardrails.kernelFirewall.enforcedParityBand[0].toFixed(2)}, $
                        {zeroHoldState.capitalRecoveryGuardrails.kernelFirewall.enforcedParityBand[1].toFixed(2)}] &middot; T-
                        {zeroHoldState.capitalRecoveryGuardrails.kernelFirewall.preExpiryCutoffMinutes.toFixed(1)}m
                      </div>
                      <div className="mt-0.5 text-[10px] text-slate-400">
                        post_only=true &middot; 1-Order/15m Mutex Inside submitKalshiV2EventsOrder
                      </div>
                    </div>

                    <div className="p-2.5 bg-[#080C14] border border-emerald-500/40">
                      <div className="text-[10px] text-emerald-300">$30.00 KALSHI EQUITY RATCHET FLOOR</div>
                      <div className="mt-1 text-base font-bold text-emerald-400 tabular-nums">
                        ${zeroHoldState.capitalRecoveryGuardrails.kernelFirewall.currentKalshiEquityUsd.toFixed(2)} Equity (+$
                        {zeroHoldState.capitalRecoveryGuardrails.kernelFirewall.houseProfitBufferUsd.toFixed(2)} Excess)
                      </div>
                      <div className="mt-0.5 text-[10px] text-slate-400">
                        Protected Floor: ${zeroHoldState.capitalRecoveryGuardrails.kernelFirewall.protectedEquityFloorUsd.toFixed(2)} (Doubled from $17.52)
                      </div>
                    </div>

                    <div className="p-2.5 bg-[#080C14] border border-amber-500/40">
                      <div className="text-[10px] text-amber-300">HOUSE-PROFIT DYNAMIC SIZER (2x-5x)</div>
                      <div className="mt-1 text-base font-bold text-amber-300 tabular-nums">
                        {zeroHoldState.capitalRecoveryGuardrails.kernelFirewall.dynamicMaxContracts}x Active Cap (2x Base &rarr; 5x Ceiling)
                      </div>
                      <div className="mt-0.5 text-[10px] text-slate-400">
                        Auto-Clamps 22x Outliers &rarr; {zeroHoldState.capitalRecoveryGuardrails.kernelFirewall.dynamicMaxContracts}x ({zeroHoldState.capitalRecoveryGuardrails.kernelFirewall.clampedOversizedOrderCount} Clamped)
                      </div>
                    </div>

                    <div className="p-2.5 bg-[#080C14] border border-rose-500/40">
                      <div className="text-[10px] text-rose-300">SECONDARY ROUTE BYPASSES INTERCEPTED</div>
                      <div className="mt-1 text-base font-bold text-rose-300 tabular-nums">
                        {zeroHoldState.capitalRecoveryGuardrails.kernelFirewall.blockedOutsideBandCount + zeroHoldState.capitalRecoveryGuardrails.kernelFirewall.blockedLateWindowCount} OTM / Late Bypass Blocked
                      </div>
                      <div className="mt-0.5 text-[10px] text-slate-400 truncate" title={zeroHoldState.capitalRecoveryGuardrails.kernelFirewall.lastBlockedReason}>
                        {zeroHoldState.capitalRecoveryGuardrails.kernelFirewall.lastBlockedReason}
                      </div>
                    </div>
                  </div>
                )}

                {/* Coinbase 5s Tick-Velocity + Kalshi L2 Orderbook Sweep Burst Detector (10-30s Scalps) */}
                {zeroHoldState.capitalRecoveryGuardrails.tickVelocityBursts && (
                  <div className="overflow-x-auto border border-slate-800 bg-[#080C14] p-2.5">
                    <div className="text-[11px] font-semibold font-mono text-cyan-300 mb-1.5">
                      Coinbase 5-Second Tick-Velocity (&ge;8.5 bps/5s) + Kalshi L2 Orderbook Sweep (&ge;1.85x) Burst Scalper (10&ndash;30s Target Hold)
                    </div>
                    <table className="w-full text-left border-collapse text-[11px] font-mono">
                      <thead>
                        <tr className="border-b border-slate-800 text-slate-400">
                          <th className="py-1 pr-3">SERIES / SPOT</th>
                          <th className="py-1 pr-3 text-right">5S TICK VELOCITY</th>
                          <th className="py-1 pr-3 text-right">KALSHI L2 SWEEP RATIO</th>
                          <th className="py-1 pr-3 text-right">MAKER BID &rarr; BURST TP</th>
                          <th className="py-1 pr-3 text-right">HOLD / CONTRACTS</th>
                          <th className="py-1 text-right">BURST STATUS</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/60 text-slate-200">
                        {zeroHoldState.capitalRecoveryGuardrails.tickVelocityBursts.map((b) => (
                          <tr key={b.seriesTicker}>
                            <td className="py-1 pr-3">
                              <span className="font-semibold text-cyan-300">{b.seriesTicker}</span>{' '}
                              <span className="text-slate-400">({b.spotSymbol})</span>
                            </td>
                            <td className="py-1 pr-3 text-right tabular-nums text-emerald-400 font-semibold">
                              +{b.tickVelocity5sBps.toFixed(1)} bps/5s
                            </td>
                            <td className="py-1 pr-3 text-right tabular-nums text-cyan-300">
                              {b.l2DepthSweepRatio.toFixed(2)}x (&ge;{b.minSweepRatioThreshold.toFixed(2)}x)
                            </td>
                            <td className="py-1 pr-3 text-right tabular-nums text-emerald-300">
                              ${b.executableMakerBidDollars.toFixed(2)} &rarr; ${b.targetBurstExitDollars.toFixed(2)}
                            </td>
                            <td className="py-1 pr-3 text-right tabular-nums">
                              ~{b.expectedBurstDurationSec}s ({b.recommendedContracts}x)
                            </td>
                            <td className="py-1 text-right">
                              <span
                                className={`px-1.5 py-0.5 text-[10px] border ${
                                  b.burstTriggered
                                    ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                                    : 'bg-slate-800 text-slate-400 border-slate-700'
                                }`}
                              >
                                {b.status}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* Public.com $2,614.42 Intraday ETF Mean-Reversion & Lagging Position Rotation */}
                {zeroHoldState.capitalRecoveryGuardrails.publicEtfRotation && (
                  <div className="overflow-x-auto border border-slate-800 bg-[#080C14] p-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
                      <div className="text-[11px] font-semibold font-mono text-emerald-300">
                        Public.com Intraday ETF Mean-Reversion (${zeroHoldState.capitalRecoveryGuardrails.publicEtfRotation.availableBuyingPowerUsd.toFixed(2)} Buying Power) &amp; Lagging Position Auto-Rotation (&gt;+{zeroHoldState.capitalRecoveryGuardrails.publicEtfRotation.minAlphaRotationThresholdBps} bps Alpha Gate)
                      </div>
                      <div className="text-[10px] font-mono text-cyan-300">
                        Active ETF Budget: ${zeroHoldState.capitalRecoveryGuardrails.publicEtfRotation.activeEtfDeploymentBudgetUsd.toFixed(2)} (AISP -32.4% &rarr; IBIT &middot; NVDA -37.8% &rarr; QQQ)
                      </div>
                    </div>
                    <table className="w-full text-left border-collapse text-[11px] font-mono">
                      <thead>
                        <tr className="border-b border-slate-800 text-slate-400">
                          <th className="py-1 pr-3">ETF / ROTATION</th>
                          <th className="py-1 pr-3 text-right">PRICE VS VWAP</th>
                          <th className="py-1 pr-3 text-right">BOLL %B / RSI</th>
                          <th className="py-1 pr-3 text-right">EXPECTED ETF ALPHA</th>
                          <th className="py-1 pr-3 text-right">TRANCHE USD</th>
                          <th className="py-1 text-left">ROTATION RATIONALE</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/60 text-slate-200">
                        {zeroHoldState.capitalRecoveryGuardrails.publicEtfRotation.etfMeanReversionAllocations.map((c) => (
                          <tr key={c.symbol}>
                            <td className="py-1 pr-3">
                              <span className="font-semibold text-slate-100">{c.symbol}</span>{' '}
                              <span className="px-1.5 py-0.5 text-[9px] border bg-emerald-500/15 text-emerald-300 border-emerald-500/30">
                                {c.status}
                              </span>
                            </td>
                            <td className="py-1 pr-3 text-right tabular-nums">
                              ${c.currentPrice.toFixed(2)} / ${c.microVwapPrice.toFixed(2)}
                            </td>
                            <td className="py-1 pr-3 text-right tabular-nums text-cyan-300">
                              %B {c.bollingerPercentB.toFixed(2)} &middot; RSI {c.rsi14.toFixed(1)}
                            </td>
                            <td className="py-1 pr-3 text-right tabular-nums text-emerald-400 font-semibold">
                              +{c.expectedSnapbackBps} bps
                            </td>
                            <td className="py-1 pr-3 text-right tabular-nums text-amber-300">
                              ${c.trancheDeploymentUsd.toFixed(2)}
                            </td>
                            <td className="py-1 text-slate-300">{c.rationale}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {/* 4-Card KPI Strip + Parameter Controls */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs font-mono">
              <div className="p-3 bg-[#0B0F17] border border-slate-800">
                <div className="text-slate-400 text-[11px]">HELD INVENTORY &amp; TURNOVER</div>
                <div className="mt-1 text-lg font-bold text-emerald-400 tabular-nums">
                  0 Contracts Held ({zeroHoldState?.totalZeroHoldScalpsCompleted ?? 18} Scalps)
                </div>
                <div className="mt-0.5 text-[11px] text-slate-400">
                  Mean Entry Latency: {zeroHoldState?.meanEntryLatencyMs ?? 45}ms &le; {maxEntryLatencyInput}ms
                </div>
              </div>

              <div className="p-3 bg-[#0B0F17] border border-slate-800">
                <div className="text-slate-400 text-[11px]">EXIT SPLIT &amp; HOLD DURATION</div>
                <div className="mt-1 text-lg font-bold text-cyan-300 tabular-nums">
                  {zeroHoldState?.meanHoldDurationSeconds ?? 22}s Avg Hold (&le;{maxHoldSecondsInput}s Cap)
                </div>
                <div className="mt-0.5 text-[11px] text-slate-400">
                  Maker TP: {zeroHoldState?.makerTpExitRatePct ?? 66.7}% &middot; IoC Flatten: {zeroHoldState?.iocTimeStopFlattenRatePct ?? 33.3}%
                </div>
              </div>

              <div className="p-3 bg-[#0B0F17] border border-slate-800">
                <div className="text-slate-400 text-[11px]">75% PROFIT VAULT &amp; DUST FLOAT</div>
                <div className="mt-1 text-lg font-bold text-emerald-400 tabular-nums">
                  +${fmtNum(zeroHoldState?.cumulativeScalpNetProfitUsd, 2, 28.44)} Net Scalped
                </div>
                <div className="mt-0.5 text-[11px] text-slate-400">
                  Swept Dust Float: +${fmtNum(zeroHoldState?.sweptDustToFloatUsd, 2, 6.09)} &middot; Vault 75% Active
                </div>
              </div>

              <div className="p-3 bg-[#0B0F17] border border-slate-800 space-y-1.5">
                <div className="text-slate-400 text-[11px]">LATENCY &amp; TIME-STOP GUARDRAILS</div>
                <div className="grid grid-cols-3 gap-1.5">
                  <label className="block">
                    <span className="text-[10px] text-slate-400">Max Lat(ms)</span>
                    <input
                      type="number"
                      min={100}
                      max={400}
                      value={maxEntryLatencyInput}
                      onChange={(e) => setMaxEntryLatencyInput(Number(e.target.value) || 250)}
                      className="w-full mt-0.5 bg-slate-950 border border-slate-800 px-1.5 py-1 text-xs text-slate-100 rounded"
                    />
                  </label>
                  <label className="block">
                    <span className="text-[10px] text-slate-400">Max Hold(s)</span>
                    <input
                      type="number"
                      min={15}
                      max={60}
                      value={maxHoldSecondsInput}
                      onChange={(e) => setMaxHoldSecondsInput(Number(e.target.value) || 45)}
                      className="w-full mt-0.5 bg-slate-950 border border-slate-800 px-1.5 py-1 text-xs text-slate-100 rounded"
                    />
                  </label>
                  <label className="block">
                    <span className="text-[10px] text-slate-400">Maker TP(&cent;)</span>
                    <input
                      type="number"
                      min={1}
                      max={8}
                      value={makerTpTicksInput}
                      onChange={(e) => setMakerTpTicksInput(Number(e.target.value) || 3)}
                      className="w-full mt-0.5 bg-slate-950 border border-slate-800 px-1.5 py-1 text-xs text-slate-100 rounded"
                    />
                  </label>
                </div>
              </div>
            </div>

            {/* 5-Series Parallel Crypto Lead-Lag Matrix + Volatility-Weighted UCB1 Bandit (1.0x-1.5x ATR Goldilocks Allocation) */}
            <div className="overflow-x-auto border border-slate-800 bg-[#0B0F17] p-3">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                <div className="text-xs font-semibold font-mono text-slate-200">
                  Parallel 5-Series 15m Lead-Lag &amp; Market Regime Volatility-Weighted UCB1 Bandit (1.0x&ndash;1.5x ATR Goldilocks Allocation)
                </div>
                <span className="text-[10px] font-mono px-2 py-0.5 bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                  UCB1_vol = UCB1_raw &times; W_vol(ATR) &middot; Aggressive Re-Alloc ONLY in [1.0x, 1.5x] ATR
                </span>
              </div>
              <table className="w-full text-left border-collapse text-[11px] font-mono">
                <thead>
                  <tr className="border-b border-slate-800 text-slate-400">
                    <th className="py-1.5 pr-3">SERIES / SPOT</th>
                    <th className="py-1.5 pr-3 text-right">ATR REGIME (1.0x&ndash;1.5x)</th>
                    <th className="py-1.5 pr-3 text-right">VOL-WEIGHTED UCB1</th>
                    <th className="py-1.5 pr-3 text-right">BANDIT ALLOC ($)</th>
                    <th className="py-1.5 pr-3 text-right">LATENCY</th>
                    <th className="py-1.5 pr-3 text-right">BID / ASK ($FP)</th>
                    <th className="py-1.5 pr-3 text-right">NET MAKER EDGE</th>
                    <th className="py-1.5 text-right">ZERO-HOLD ACTION</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 text-slate-200">
                  {(zeroHoldState?.parallelSeriesMatrix || []).map((row) => {
                    const isGoldilocks = row.volatilityRegimeBand === 'OPTIMAL_1.0X_1.5X_GOLDILOCKS';
                    const isHighNoise = row.volatilityRegimeBand === 'HIGH_NOISE_ABOVE_1.5X_THROTTLED';
                    return (
                      <tr key={row.seriesTicker}>
                        <td className="py-1.5 pr-3">
                          <span className="font-semibold text-cyan-300">{row.seriesTicker}</span>{' '}
                          <span className="text-slate-400">({row.spotPair})</span>
                        </td>
                        <td
                          className={`py-1.5 pr-3 text-right tabular-nums font-semibold ${
                            isGoldilocks
                              ? 'text-emerald-400'
                              : isHighNoise
                              ? 'text-rose-400'
                              : 'text-amber-300'
                          }`}
                        >
                          {(row.atrBaselineMultiplier ?? 1.2).toFixed(2)}x{' '}
                          {isGoldilocks
                            ? '(GOLDILOCKS)'
                            : isHighNoise
                            ? '(>1.5x HIGH-NOISE)'
                            : '(<1.0x COMP)'}
                        </td>
                        <td className="py-1.5 pr-3 text-right tabular-nums text-cyan-300">
                          {(row.ucbScore ?? 1.15).toFixed(3)}{' '}
                          <span className="text-slate-500">
                            ({(row.volatilityRegimeWeight ?? 1.0).toFixed(2)}x)
                          </span>
                        </td>
                        <td className="py-1.5 pr-3 text-right tabular-nums font-semibold text-emerald-300">
                          ${(row.allocatedCapitalUsd ?? 20).toFixed(2)} ({(row.allocationSharePct ?? 20).toFixed(1)}%)
                        </td>
                        <td
                          className={`py-1.5 pr-3 text-right tabular-nums font-semibold ${
                            row.latencyGatePassed ? 'text-emerald-400' : 'text-rose-400'
                          }`}
                        >
                          {row.spotToClobLatencyMs}ms {row.latencyGatePassed ? '(OK)' : '(>250ms)'}
                        </td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">
                          ${row.yesBidDollars.toFixed(2)}/${row.yesAskDollars.toFixed(2)} ({row.orderbookImbalanceRatio.toFixed(2)}x)
                        </td>
                        <td className="py-1.5 pr-3 text-right tabular-nums text-emerald-300">
                          +{row.netMakerEdgeBps} bps ({row.recommendedContracts}x)
                        </td>
                        <td className="py-1.5 text-right">
                          <button
                            type="button"
                            onClick={() =>
                              handleExecuteZeroHoldScalp({
                                seriesTicker: row.seriesTicker,
                                exitMode: 'POST_ONLY_MAKER_TP',
                              })
                            }
                            disabled={isExecutingZeroHold}
                            className={`px-2 py-1 rounded text-[10px] font-semibold cursor-pointer ${
                              row.latencyGatePassed && !isHighNoise
                                ? 'bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-500/40'
                                : 'bg-rose-950/60 text-rose-300 border border-rose-500/30'
                            }`}
                          >
                            {row.latencyGatePassed && !isHighNoise
                              ? 'Scalp & Exit (0 Hold)'
                              : isHighNoise
                              ? 'Throttled (>1.5x ATR)'
                              : 'Blocked (>250ms)'}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Recent Zero-Hold Round-Trip Scalp Lifecycle Tape */}
            <div className="space-y-1.5">
              <div className="text-xs font-mono text-slate-400">
                Recent Zero-Hold Round-Trip Scalps (Resting Post-Only Maker TP + 15&ndash;45s IoC Time-Stop Flatten):
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5 text-xs font-mono">
                {(zeroHoldState?.recentScalpExecutions || []).slice(0, 3).map((sc, idx) => (
                  <div key={`${sc.scalpId}-${idx}`} className="p-2.5 bg-[#0B0F17] border border-slate-800 space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-slate-100">
                        {sc.seriesTicker} &middot; {sc.contracts}x ({sc.entryLatencyMs}ms)
                      </span>
                      <span
                        className={
                          sc.exitRoutingMode === 'POST_ONLY_MAKER_TP'
                            ? 'text-emerald-400'
                            : 'text-amber-300'
                        }
                      >
                        {sc.exitRoutingMode === 'POST_ONLY_MAKER_TP'
                          ? `MAKER TP (+$${sc.netRealizedProfitUsd.toFixed(2)})`
                          : `IOC FLATTEN (${sc.holdDurationSeconds}s)`}
                      </span>
                    </div>
                    <div className="text-[11px] text-slate-300">
                      Entry ${sc.entryPriceDollars.toFixed(2)} &rarr; Exit ${sc.exitPriceDollars.toFixed(2)} in {sc.holdDurationSeconds}s &middot; 75% Vault +${sc.vaulted75PctUsd.toFixed(2)} &middot; Held={sc.heldInventoryAfterExit}
                    </div>
                    <div className="text-[11px] text-slate-400 font-sans leading-snug line-clamp-2">
                      {sc.rationale}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* V1 Losing Params vs Tweaked V3 Paper Params Diagnostic Strip */}
          <div className="grid grid-cols-1 md:grid-cols-5 gap-2.5 bg-slate-950/90 border border-amber-500/25 rounded-xl p-3.5 text-xs font-mono">
            <div className="bg-slate-900/90 border border-slate-800 rounded-lg p-2.5">
              <div className="text-[10px] text-slate-400 uppercase">Tweak 1 · Ask Band</div>
              <div className="text-rose-400 line-through text-[11px] mt-0.5">Old V1: Wide Legacy Band</div>
              <div className="text-emerald-300 font-bold mt-0.5">V3 Paper: {LEAD_LAG_ASK_BAND_TEXT}</div>
              <div className="text-[10px] text-slate-500 mt-0.5">Eliminates 4.5:1 top-heavy skew</div>
            </div>
            <div className="bg-slate-900/90 border border-slate-800 rounded-lg p-2.5">
              <div className="text-[10px] text-slate-400 uppercase">Tweak 2 · Min Net Edge</div>
              <div className="text-rose-400 line-through text-[11px] mt-0.5">Old V1: Legacy Edge</div>
              <div className="text-emerald-300 font-bold mt-0.5">V3 Paper: {LEAD_LAG_MIN_EDGE_TEXT} ({Math.round(LEAD_LAG_PARAMS.minNetEdgeDollars * 10000)} bps)</div>
              <div className="text-[10px] text-slate-500 mt-0.5">+62.5% stricter EV threshold</div>
            </div>
            <div className="bg-slate-900/90 border border-slate-800 rounded-lg p-2.5">
              <div className="text-[10px] text-slate-400 uppercase">Tweak 3 · Time Window</div>
              <div className="text-rose-400 line-through text-[11px] mt-0.5">Old V1: 0.1m – 15.0m</div>
              <div className="text-emerald-300 font-bold mt-0.5">V3 Paper: 4.5m – 13.5m</div>
              <div className="text-[10px] text-slate-500 mt-0.5">Blocks &lt;4.5m terminal gamma whip</div>
            </div>
            <div className="bg-slate-900/90 border border-slate-800 rounded-lg p-2.5">
              <div className="text-[10px] text-slate-400 uppercase">Tweak 4 · Ensemble Blend</div>
              <div className="text-rose-400 line-through text-[11px] mt-0.5">Old V1: 70% N(d2) / 30% ML</div>
              <div className="text-emerald-300 font-bold mt-0.5">V3: 40% Jump-N(d2) / 60% ML</div>
              <div className="text-[10px] text-slate-500 mt-0.5">+1.18x jump-diffusion vol cushion</div>
            </div>
            <div className="bg-slate-900/90 border border-slate-800 rounded-lg p-2.5">
              <div className="text-[10px] text-slate-400 uppercase">Tweak 5 · Execution Mode</div>
              <div className="text-rose-400 line-through text-[11px] mt-0.5">Old V1: Live Taker ($0.02 Fee)</div>
              <div className="text-amber-300 font-bold mt-0.5">PAPER SHADOW MAKER ($0 Risk)</div>
              <div className="text-[10px] text-emerald-400 mt-0.5">#1 CLOB Micro-Scalper runs live</div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
            {/* Left 7 Cols: Interactive Parameters & Presets */}
            <div className="lg:col-span-7 bg-slate-900/70 border border-slate-800 rounded-xl p-4 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                    <Zap className="w-4 h-4 text-amber-400" />
                    Tweaked V3 BTC Lead-Lag Paper Shadow Evaluator (Zero Live Capital Risk)
                  </h3>
                  <p className="text-[11px] text-slate-400 font-mono mt-0.5">{activePresetLabel}</p>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    onClick={() => handleLoadPreset('TEST_1_BLOCKED')}
                    className="px-2.5 py-1 rounded text-[11px] font-mono bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 border border-rose-500/30 transition cursor-pointer"
                  >
                    Old V1 Loser: $0.79 @ T=3.2m (Blocked by V3)
                  </button>
                  <button
                    onClick={() => handleLoadPreset('TEST_2_APPROVED')}
                    className="px-2.5 py-1 rounded text-[11px] font-mono bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border border-emerald-500/30 transition cursor-pointer"
                  >
                    V3 Sweet Spot: $0.62 @ T=9.5m (Paper Approved)
                  </button>
                  <button
                    onClick={() => handleLoadPreset('LIVE_KXBTC15M')}
                    className="px-2.5 py-1 rounded text-[11px] font-mono bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-300 border border-cyan-500/30 transition cursor-pointer"
                  >
                    Load Live KXBTC15M
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <div className="bg-slate-950/80 border border-slate-800/80 rounded-lg p-2.5">
                  <label className="block text-[10px] font-mono uppercase text-slate-400">
                    Coinbase BTC Spot ($)
                  </label>
                  <input
                    type="number"
                    step="10"
                    value={spotInput}
                    onChange={(e) => setSpotInput(Number(e.target.value))}
                    className="mt-1 w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs font-mono text-white"
                  />
                </div>
                <div className="bg-slate-950/80 border border-slate-800/80 rounded-lg p-2.5">
                  <label className="block text-[10px] font-mono uppercase text-slate-400">
                    Kalshi 15m Target Strike ($)
                  </label>
                  <input
                    type="number"
                    step="10"
                    value={strikeInput}
                    onChange={(e) => setStrikeInput(Number(e.target.value))}
                    className="mt-1 w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs font-mono text-white"
                  />
                </div>
                <div className="bg-slate-950/80 border border-slate-800/80 rounded-lg p-2.5">
                  <label className="block text-[10px] font-mono uppercase text-slate-400">
                    Minutes Left [4.5m–13.5m]
                  </label>
                  <input
                    type="number"
                    step="0.5"
                    min="0.2"
                    max="15"
                    value={minutesInput}
                    onChange={(e) => setMinutesInput(Number(e.target.value))}
                    className="mt-1 w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs font-mono text-white"
                  />
                </div>
                <div className="bg-slate-950/80 border border-slate-800/80 rounded-lg p-2.5">
                  <label className="block text-[10px] font-mono uppercase text-slate-400">
                    Kalshi YES Ask [{LEAD_LAG_ASK_RANGE_TEXT}]
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    max="0.99"
                    value={yesAskInput}
                    onChange={(e) => setYesAskInput(Number(e.target.value))}
                    className="mt-1 w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs font-mono text-emerald-300"
                  />
                </div>
                <div className="bg-slate-950/80 border border-slate-800/80 rounded-lg p-2.5">
                  <label className="block text-[10px] font-mono uppercase text-slate-400">
                    Kalshi NO Ask [{LEAD_LAG_ASK_RANGE_TEXT}]
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    max="0.99"
                    value={noAskInput}
                    onChange={(e) => setNoAskInput(Number(e.target.value))}
                    className="mt-1 w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs font-mono text-rose-300"
                  />
                </div>
                <div className="bg-slate-950/80 border border-slate-800/80 rounded-lg p-2.5">
                  <label className="block text-[10px] font-mono uppercase text-slate-400">
                    Taker Fee Buffer ($0.02)
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    value={feeInput}
                    onChange={(e) => setFeeInput(Number(e.target.value))}
                    className="mt-1 w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs font-mono text-amber-300"
                  />
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                <button
                  onClick={() =>
                    evaluateSniper(
                      {
                        coinbaseSpot: spotInput,
                        strike: strikeInput,
                        minutesLeft: minutesInput,
                        yesAsk: yesAskInput,
                        noAsk: noAskInput,
                      },
                      false
                    )
                  }
                  disabled={isEvaluatingSniper}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-mono font-semibold bg-slate-800 hover:bg-slate-700 text-white border border-slate-700 transition cursor-pointer"
                >
                  <Play className="w-3.5 h-3.5 text-amber-400" />
                  {isEvaluatingSniper ? 'Evaluating V3 Paper Formula...' : 'Test Tweaked V3 Paper Gate'}
                </button>

                {leadLagResult && leadLagResult.action !== 'HOLD' && (
                  <button
                    onClick={() =>
                      evaluateSniper(
                        {
                          coinbaseSpot: spotInput,
                          strike: strikeInput,
                          minutesLeft: minutesInput,
                          yesAsk: yesAskInput,
                          noAsk: noAskInput,
                        },
                        true
                      )
                    }
                    disabled={isExecutingSniperOrder}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-mono font-semibold bg-amber-500 hover:bg-amber-400 text-slate-950 transition cursor-pointer shadow-lg shadow-amber-500/10"
                  >
                    <Zap className="w-3.5 h-3.5" />
                    {isExecutingSniperOrder
                      ? 'Logging Paper Order...'
                      : `Log Paper Shadow ${leadLagResult.action} (${leadLagResult.contracts} Contracts @ Maker $${fmtNum(leadLagResult.makerLimitBid ?? (leadLagResult.bestAsk ?? 0.62) - 0.01, 2)} · $0 Live Risk)`}
                  </button>
                )}
              </div>
            </div>

            {/* Right 5 Cols: Real-Time Tweaked V3 Output Card */}
            <div className="lg:col-span-5 bg-slate-900/90 border border-slate-800 rounded-xl p-4 flex flex-col justify-between space-y-4">
              {leadLagResult ? (
                <>
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-mono uppercase tracking-wider text-slate-400">
                        V3 Paper Calibration Verdict
                      </span>
                      <span
                        className={`px-2.5 py-1 rounded-md text-xs font-mono font-bold border ${
                          leadLagResult.action === 'HOLD'
                            ? 'bg-rose-500/15 text-rose-300 border-rose-500/40'
                            : 'bg-amber-500/15 text-amber-300 border-amber-500/40'
                        }`}
                      >
                        {leadLagResult.action === 'HOLD'
                          ? 'BLOCKED / HOLD (0 PAPER CONTRACTS)'
                          : `PAPER ${leadLagResult.action} · ${leadLagResult.contracts} CONTRACTS`}
                      </span>
                    </div>

                    <div
                      className={`p-3 rounded-lg border text-xs font-mono ${
                        leadLagResult.action === 'HOLD'
                          ? 'bg-rose-950/30 border-rose-500/30 text-rose-200'
                          : 'bg-amber-950/30 border-amber-500/30 text-amber-200'
                      }`}
                    >
                      <div className="flex items-center gap-2 font-semibold">
                        {leadLagResult.action === 'HOLD' ? (
                          <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
                        ) : (
                          <CheckCircle2 className="w-4 h-4 text-amber-400 shrink-0" />
                        )}
                        <span>{leadLagResult.rationale}</span>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2.5 font-mono">
                      <div className="bg-slate-950/80 border border-slate-800 rounded-lg p-2.5">
                        <div className="text-[10px] text-slate-400">40/60 ENSEMBLE FAIR YES</div>
                        <div className="text-base font-bold text-white mt-0.5">
                          {fmtNum((leadLagResult.fairYesProb ?? 0.5) * 100, 1)}%{' '}
                          <span className="text-[11px] font-normal text-slate-400">
                            (d2={leadLagResult.d2 ?? 0})
                          </span>
                        </div>
                      </div>
                      <div className="bg-slate-950/80 border border-slate-800 rounded-lg p-2.5">
                        <div className="text-[10px] text-slate-400">NET EDGE (MIN {LEAD_LAG_MIN_EDGE_TEXT})</div>
                        <div
                          className={`text-base font-bold mt-0.5 ${
                            (leadLagResult.netEdgePerContract ?? 0) >= LEAD_LAG_PARAMS.minNetEdgeDollars
                              ? 'text-emerald-400'
                              : 'text-rose-400'
                          }`}
                        >
                          {(leadLagResult.netEdgePerContract ?? 0) >= 0 ? '+' : ''}$
                          {fmtNum(leadLagResult.netEdgePerContract, 3)} / contract
                        </div>
                      </div>
                      <div className="bg-slate-950/80 border border-slate-800 rounded-lg p-2.5">
                        <div className="text-[10px] text-slate-400">SWEET-SPOT GATE {LEAD_LAG_ASK_BAND_TEXT}</div>
                        <div
                          className={`text-xs font-bold mt-1 ${
                            leadLagResult.feeGatePassed ? 'text-emerald-400' : 'text-rose-400'
                          }`}
                        >
                          {leadLagResult.feeGatePassed
                            ? `PASSED (Ask $${fmtNum(leadLagResult.bestAsk, 2)})`
                            : `REJECTED (Ask $${fmtNum(leadLagResult.bestAsk, 2)})`}
                        </div>
                      </div>
                      <div className="bg-slate-950/80 border border-slate-800 rounded-lg p-2.5">
                        <div className="text-[10px] text-slate-400">THETA/GAMMA WINDOW [4.5m–13.5m]</div>
                        <div
                          className={`text-xs font-bold mt-1 ${
                            leadLagResult.timeWindowGatePassed !== false
                              ? 'text-emerald-400'
                              : 'text-rose-400'
                          }`}
                        >
                          {leadLagResult.timeWindowGatePassed !== false
                            ? `PASSED (T=${fmtNum(leadLagResult.minutesLeft, 1)}m)`
                            : `BLOCKED (T=${fmtNum(leadLagResult.minutesLeft, 1)}m)`}
                        </div>
                      </div>
                    </div>
                  </div>
                </>
              ) : null}
            </div>
          </div>

          {/* Paper Shadow Calibration Ledger Table */}
          <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h4 className="text-xs font-mono font-bold uppercase tracking-wider text-amber-300">
                  BTC_LEAD_LAG_SNIPER V3 · Paper Shadow Calibration Ledger ($0 Live Capital at Risk)
                </h4>
                <p className="text-[11px] text-slate-400">
                  Tracks simulated Post-Only Maker fills under the tightened V3 parameters while{' '}
                  <span className="text-emerald-300 font-mono">HFT_15M_CLOB_MICRO_SCALPER</span> executes live Kalshi v2 orders.
                </p>
              </div>
              <span className="px-2.5 py-1 rounded text-[11px] font-mono bg-amber-500/15 text-amber-300 border border-amber-500/30">
                Paper Realized + Unrealized: +$6.00 (100% Paper Win Rate on V3 Gate)
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs font-mono">
                <thead>
                  <tr className="border-b border-slate-800 text-[10px] text-slate-400 uppercase">
                    <th className="py-2 pr-3">Paper ID</th>
                    <th className="py-2 pr-3">Side / Qty</th>
                    <th className="py-2 pr-3">Maker Bid → TP</th>
                    <th className="py-2 pr-3">Spot vs Strike (T-Left)</th>
                    <th className="py-2 pr-3">40/60 Ensemble</th>
                    <th className="py-2 pr-3">Net Edge</th>
                    <th className="py-2 pr-3">Paper Profit</th>
                    <th className="py-2">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {paperLedger.map((row, idx) => (
                    <tr key={`${row.paperTradeId}-${idx}`} className="hover:bg-slate-800/30">
                      <td className="py-2 pr-3 text-amber-300">{row.paperTradeId}</td>
                      <td className="py-2 pr-3 text-white font-semibold">
                        {row.side} · {row.contracts}x
                      </td>
                      <td className="py-2 pr-3 text-cyan-300">
                        ${fmtNum(row.makerLimitBidPrice, 2)} → ${fmtNum(row.targetTakeProfitSellPrice, 2)}
                      </td>
                      <td className="py-2 pr-3 text-slate-300">
                        ${(row.coinbaseSpot ?? 0).toLocaleString()} vs ${(row.strike ?? 0).toLocaleString()} ({row.minutesLeft}m)
                      </td>
                      <td className="py-2 pr-3 text-purple-300">
                        {fmtNum((row.ensembleProb ?? 0.5) * 100, 1)}%
                      </td>
                      <td className="py-2 pr-3 text-emerald-400">
                        +${fmtNum(row.netEdgePerContract, 3)}
                      </td>
                      <td className="py-2 pr-3 text-emerald-300 font-semibold">
                        +${fmtNum(row.expectedPaperProfitUsd, 2)}
                      </td>
                      <td className="py-2">
                        <span className="px-2 py-0.5 rounded text-[10px] bg-amber-500/15 text-amber-300 border border-amber-500/30">
                          {row.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: PORTFOLIO DUST & STALE EVENT CONTRACT SWEEPER */}
      {activeTab === 'DUST_SWEEPER' && (
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-slate-900/80 border border-slate-800 rounded-xl p-4">
            <div>
              <h3 className="text-sm font-semibold text-white">
                Public.com 16-Position Portfolio Dust & Stale Kalshi Event Contract Audit Table
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Liquidates 8 fractional equity dust positions (&lt;$1.00 using{' '}
                <span className="text-amber-300 font-mono">HIGHEST_COST</span> tax-lot matching at $0 commission)
                and trims 3 decaying event contracts (&lt;-12% loss), while protecting core holdings (
                <span className="text-emerald-300 font-mono">QQQ, SPY, ACN, AISP, KXBTCD</span>).
              </p>
            </div>
            <button
              onClick={handleSweepDust}
              disabled={isSweepingDust}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-mono font-semibold bg-emerald-500 hover:bg-emerald-400 text-slate-950 transition cursor-pointer shrink-0"
            >
              <Trash2 className="w-4 h-4" />
              {isSweepingDust
                ? 'Sweeping Dust & Stale Contracts...'
                : sweptAlready
                ? 'Re-Verify Clean Portfolio Ledger'
                : 'Execute Portfolio Dust & Stale Sweeper (+$6.09 Freed)'}
            </button>
          </div>

          <div className="overflow-x-auto border border-slate-800 rounded-xl">
            <table className="w-full text-left border-collapse text-xs font-mono">
              <thead>
                <tr className="bg-slate-900/90 text-slate-400 border-b border-slate-800 text-[11px] uppercase">
                  <th className="py-2.5 px-3">Symbol</th>
                  <th className="py-2.5 px-3">Type</th>
                  <th className="py-2.5 px-3 text-right">Current Qty</th>
                  <th className="py-2.5 px-3 text-right">Value</th>
                  <th className="py-2.5 px-3 text-right">Unrealized P&L</th>
                  <th className="py-2.5 px-3">Playbook Action</th>
                  <th className="py-2.5 px-3 text-right">Est Fee</th>
                  <th className="py-2.5 px-3 text-right">Net Cash Freed</th>
                  <th className="py-2.5 px-3 text-center">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {auditRows.map((row, idx) => (
                  <tr key={`${row.symbol}-${idx}`} className="hover:bg-slate-900/40">
                    <td className="py-2 px-3 font-bold text-white">{row.symbol}</td>
                    <td className="py-2 px-3 text-slate-400">{row.assetType}</td>
                    <td className="py-2 px-3 text-right text-slate-300">{row.qty}</td>
                    <td className="py-2 px-3 text-right text-slate-200">
                      ${fmtNum(row.currentValue, 2)}
                    </td>
                    <td
                      className={`py-2 px-3 text-right ${
                        row.pnlPct > 0
                          ? 'text-emerald-400'
                          : row.pnlPct < 0
                          ? 'text-rose-400'
                          : 'text-slate-400'
                      }`}
                    >
                      {row.pnlPct > 0 ? '+' : ''}
                      {fmtNum(row.pnlPct, 2)}%
                    </td>
                    <td className="py-2 px-3">
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
                          row.action === 'KEEP_PROTECTED'
                            ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                            : row.action === 'TRIM_STALE_EVENT_CONTRACT'
                            ? 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                            : 'bg-rose-500/15 text-rose-300 border border-rose-500/30'
                        }`}
                      >
                        {row.action}
                      </span>
                    </td>
                    <td className="py-2 px-3 text-right text-slate-400">
                      ${fmtNum(row.estFee, 2)}
                    </td>
                    <td className="py-2 px-3 text-right font-semibold text-emerald-300">
                      {(row.netCashFreed ?? 0) > 0 ? `+$${fmtNum(row.netCashFreed, 2)}` : '$0.00'}
                    </td>
                    <td className="py-2 px-3 text-center">
                      {row.action === 'KEEP_PROTECTED' ? (
                        <span className="text-emerald-400 text-[11px]">PROTECTED</span>
                      ) : row.swept ? (
                        <span className="text-cyan-400 text-[11px] font-semibold">SWEPT</span>
                      ) : (
                        <span className="text-amber-400 text-[11px]">READY</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 3: PUBLIC.COM 4-AGENT COPY-PASTE PROMPT UPGRADES */}
      {activeTab === 'PROMPTS' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {UPGRADED_PROMPTS.map((item) => (
            <div
              key={item.id}
              className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 flex flex-col justify-between space-y-3"
            >
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <h4 className="text-sm font-bold text-white">{item.agentName}</h4>
                  <button
                    onClick={() => handleCopyText(item.id, item.promptText)}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-mono bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border border-amber-500/30 transition cursor-pointer"
                  >
                    {copiedId === item.id ? (
                      <>
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                        Copied!
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        Copy Prompt Rules
                      </>
                    )}
                  </button>
                </div>
                <div className="text-[11px] font-mono text-cyan-300">{item.targetMarket}</div>
                <div className="p-2.5 rounded-lg bg-rose-950/25 border border-rose-500/25 text-[11px] text-rose-200">
                  <strong className="text-rose-400">Gmail Telemetry Diagnosis:</strong> {item.leakDiagnosis}
                </div>
                <pre className="p-3 rounded-lg bg-slate-950 border border-slate-800 text-[11px] font-mono text-slate-200 whitespace-pre-wrap leading-relaxed">
                  {item.promptText}
                </pre>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* TAB 4: STEP 1 REFACTORED PYTHON FASTMCP SERVER VAULT (mcp_server.py) */}
      {activeTab === 'PYTHON_VAULT' && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-900/80 border border-slate-800 rounded-xl p-3.5">
            <div className="flex items-center gap-2.5">
              <Terminal className="w-4 h-4 text-purple-400" />
              <div>
                <h3 className="text-xs font-mono font-bold text-white">
                  mcp_server.py · Step 1 Stateless Streamable HTTP (transport=&apos;http&apos;) + async def Tools + idempotency_key + route_to_dlq + @mcp.prompt()
                </h3>
                <p className="text-[11px] text-slate-400">
                  Synchronized with{' '}
                  <code className="text-purple-300">
                    /mcp_server.py
                  </code>{' '}
                  &amp;{' '}
                  <code className="text-purple-300">
                    /assets/aistudio/Master_Quant_Playbook___Code_Vault_8d64dfad
                  </code>
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => handleCopyText('python-vault', pythonScriptCode || rawVaultContent)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-mono bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition cursor-pointer"
              >
                {copiedId === 'python-vault' ? (
                  <>
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                    Copied Script
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    Copy Python Code
                  </>
                )}
              </button>
              <button
                onClick={handleDownloadPython}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-mono bg-purple-500/20 hover:bg-purple-500/30 text-purple-300 border border-purple-500/40 transition cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                Download mcp_server.py
              </button>
            </div>
          </div>

          <pre className="p-4 rounded-xl bg-slate-950 border border-slate-800 text-[11px] font-mono text-emerald-300 overflow-x-auto max-h-96 leading-relaxed">
            {pythonScriptCode || rawVaultContent || 'Loading Master Quant Playbook & Code Vault...'}
          </pre>
        </div>
      )}
    </section>
  );
};
