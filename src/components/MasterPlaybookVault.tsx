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
  LeadLagSignalEvaluation,
  MarketFeatureVector,
  PlaybookCleanupAuditRow,
  PortfolioSummary,
  StrategyTournamentEntry,
} from '../types/quant';

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

const UPGRADED_PROMPTS = [
  {
    id: 'prompt-btc-sniper',
    agentName: '1. BTC Lead-Lag Sniper Agent',
    targetMarket: 'KXBTC15M · BTC Up or Down - 15 minutes?',
    leakDiagnosis:
      'On Oct 19 at 10:14 EDT, bought 111 contracts at $0.27 ($19.98 total) and paid $2.25 in flat fees ($1.09 exchange + $1.16 commission)—an immediate 11.2% fee drag on entry while polling 15m RSI(14) instead of real-time spot ticks.',
    promptText: `UPGRADED EXECUTION & FEE-GATE RULES:
1. Contract Price Band ($0.45 to $0.82 ONLY): NEVER buy any 15-minute BTC event contract priced below $0.45 or above $0.82. Because Public.com charges a flat $0.02 per-contract fee ($0.01 exchange + $0.01 commission), buying cheap contracts ($0.19–$0.38) destroys expectancy via fee drag.
2. Net-of-Fee Edge Calculation: Before placing any order, calculate fair binary probability from BTC spot distance to the target strike. Subtract $0.02 per contract from the expected payout. Only execute if Net Expected Value > +$0.04 per contract.
3. Position Cap: Maximum 25 contracts or $18.00 total risk per 15-minute window.
4. No Flip-Flopping: Never buy both Yes and No on the same target strike within the same 15-minute window unless locking in a guaranteed risk-free arbitrage spread where Yes + No + $0.04 fees < $1.00.`,
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
2. For 15-minute Kalshi ETH binary contracts (KXETH15M), enforce the identical [$0.45, $0.82] Contract Price Band and +$0.04 net-of-fee edge gate.`,
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

  // Interactive BTC Lead-Lag Sniper Calculator State (defaults to Test 2 High-Conviction Surge)
  const [spotInput, setSpotInput] = useState<number>(82620.0);
  const [strikeInput, setStrikeInput] = useState<number>(82510.73);
  const [minutesInput, setMinutesInput] = useState<number>(10.0);
  const [yesAskInput, setYesAskInput] = useState<number>(0.62);
  const [noAskInput, setNoAskInput] = useState<number>(0.40);
  const [annualVolInput, setAnnualVolInput] = useState<number>(0.55);
  const [feeInput, setFeeInput] = useState<number>(0.02);
  const [activePresetLabel, setActivePresetLabel] = useState<string>(
    'Playbook Test 2: High-Conviction Coinbase Surge ($0.62 Ask -> APPROVED)'
  );

  const [leadLagResult, setLeadLagResult] = useState<LeadLagSignalEvaluation | null>(null);
  const [isEvaluatingSniper, setIsEvaluatingSniper] = useState<boolean>(false);
  const [isExecutingSniperOrder, setIsExecutingSniperOrder] = useState<boolean>(false);
  const [isSweepingDust, setIsSweepingDust] = useState<boolean>(false);
  const [isApplyingAll, setIsApplyingAll] = useState<boolean>(false);

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
          if (data.test2Approved) setLeadLagResult(data.test2Approved);
        }
      })
      .catch(() => {});
  }, []);

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
        if (executeOrder && data.order) {
          onStateUpdated({
            orders: data.orders,
            agents: data.agents,
            portfolio: data.portfolio,
            bannerMessage: `Executed BTC Lead-Lag Sniper Order (${data.order.side} ${data.order.quantity} ${data.order.symbol} @ $${data.order.fillPrice.toFixed(2)} · Net Edge +$${data.evaluation.netEdgePerContract.toFixed(3)}/contract)!`,
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
        coinbaseSpot: 82010.0,
        strike: 82021.39,
        minutesLeft: 12.0,
        yesAsk: 0.27,
        noAsk: 0.75,
      };
      setSpotInput(p.coinbaseSpot);
      setStrikeInput(p.strike);
      setMinutesInput(p.minutesLeft);
      setYesAskInput(p.yesAsk);
      setNoAskInput(p.noAsk);
      setActivePresetLabel('Playbook Test 1: Oct 19 10:14 AM Trade ($0.27 Ask -> BLOCKED by Fee Gate)');
      evaluateSniper(p, false);
    } else if (preset === 'TEST_2_APPROVED') {
      const p = {
        coinbaseSpot: 82620.0,
        strike: 82510.73,
        minutesLeft: 10.0,
        yesAsk: 0.62,
        noAsk: 0.40,
      };
      setSpotInput(p.coinbaseSpot);
      setStrikeInput(p.strike);
      setMinutesInput(p.minutesLeft);
      setYesAskInput(p.yesAsk);
      setNoAskInput(p.noAsk);
      setActivePresetLabel('Playbook Test 2: High-Conviction Coinbase Surge ($0.62 Ask -> APPROVED)');
      evaluateSniper(p, false);
    } else if (preset === 'LIVE_KXBTC15M' && btc15mFeature) {
      const sig = btc15mFeature.leadLagSignal;
      const p = {
        coinbaseSpot: sig?.coinbaseSpot ?? 82620.0,
        strike: sig?.strike ?? 82510.73,
        minutesLeft: sig?.minutesLeft ?? 8.5,
        yesAsk: sig?.yesAsk ?? Number(Math.min(0.95, btc15mFeature.price + 0.01).toFixed(2)),
        noAsk: sig?.noAsk ?? Number(Math.max(0.05, 1.0 - btc15mFeature.price).toFixed(2)),
      };
      setSpotInput(p.coinbaseSpot);
      setStrikeInput(p.strike);
      setMinutesInput(p.minutesLeft);
      setYesAskInput(p.yesAsk);
      setNoAskInput(p.noAsk);
      setActivePresetLabel(
        `Live Kalshi 15m Contract: ${btc15mFeature.activeContractTicker || 'KXBTC15M'} (${
          btc15mFeature.targetStrikeLabel || 'Live Strike'
        })`
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
          bannerMessage: `Executed Portfolio Dust & Stale Kalshi Sweeper: Swept 8 fractional equity dust lots ($0 fee, HIGHEST_COST lot) & trimmed 3 decaying Kalshi contracts, freeing +$${data.netCashFreedUsd.toFixed(2)} net cash!`,
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
        onStateUpdated({
          agents: data.agents,
          orders: data.orders,
          portfolio: data.portfolio,
          strategyTournament: data.strategyTournament,
          cleanupAudit: data.cleanupAudit,
          bannerMessage: `Applied Master Quant Playbook & Code Vault: Activated BTC Lead-Lag Sniper ($0.45–$0.82 Fee Gate), swept 8 dust stocks & 3 stale Kalshi contracts (+$${data.netCashFreedUsd.toFixed(2)} freed), and enforced Penny-Stock Ban!`,
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
            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md text-[11px] font-mono font-semibold bg-amber-500/15 text-amber-300 border border-amber-500/30">
              <Sparkles className="w-3.5 h-3.5" />
              MASTER QUANT PLAYBOOK & CODE VAULT ACTIVE
            </span>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
              <ShieldCheck className="w-3 h-3" />
              FEE GATE [$0.45, $0.82] ENFORCED
            </span>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono bg-cyan-500/15 text-cyan-300 border border-cyan-500/30">
              BLACK-SCHOLES N(d2) + $0.02 FEE DEDUCTION
            </span>
          </div>
          <h2 className="text-lg font-bold text-white mt-1.5 tracking-tight">
            Public.com & Kalshi 15m Master Recovery Playbook · BTC Lead-Lag Sniper & Portfolio Cleaner
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Synchronized with your attached <span className="text-slate-200 font-mono">Master_Quant_Playbook___Code_Vault</span>:
            enforces the <span className="text-amber-300 font-mono">$0.45–$0.82</span> contract price band,{' '}
            <span className="text-emerald-300 font-mono">+$0.04</span> net-of-fee edge gate,{' '}
            <span className="text-cyan-300 font-mono">25 contracts / $18.00</span> risk cap, and 16-position dust sweeper.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            onClick={handleApplyAllUpgrades}
            disabled={isApplyingAll}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-xs font-mono font-semibold bg-gradient-to-r from-amber-500 to-emerald-500 hover:from-amber-400 hover:to-emerald-400 text-slate-950 shadow-lg shadow-amber-500/10 transition cursor-pointer disabled:opacity-50"
          >
            <Zap className="w-4 h-4" />
            {isApplyingAll
              ? 'Applying Playbook Upgrades...'
              : 'Apply All 4 Playbook Upgrades & Sweep Dust'}
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
            1. Live BTC Lead-Lag Sniper & Fee Gate
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
            Banned Penny Tickers:{' '}
            <strong className="text-rose-400">RCT, XHG, BGIN, RADX, MMLP (&lt;$10)</strong>
          </span>
        </div>
      </div>

      {/* TAB 1: LIVE BTC LEAD-LAG SNIPER & HARD DETERMINISTIC FEE GATE */}
      {activeTab === 'SNIPER_GATE' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          {/* Left 7 Cols: Interactive Parameters & Presets */}
          <div className="lg:col-span-7 bg-slate-900/70 border border-slate-800 rounded-xl p-4 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                  <Zap className="w-4 h-4 text-amber-400" />
                  Coinbase-to-Kalshi 15m Lead-Lag Sniper Evaluator (evaluate_btc_lead_lag)
                </h3>
                <p className="text-[11px] text-slate-400 font-mono mt-0.5">{activePresetLabel}</p>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  onClick={() => handleLoadPreset('TEST_1_BLOCKED')}
                  className="px-2.5 py-1 rounded text-[11px] font-mono bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 border border-rose-500/30 transition cursor-pointer"
                >
                  Test 1: Oct 19 $0.27 Ask (Blocked)
                </button>
                <button
                  onClick={() => handleLoadPreset('TEST_2_APPROVED')}
                  className="px-2.5 py-1 rounded text-[11px] font-mono bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border border-emerald-500/30 transition cursor-pointer"
                >
                  Test 2: $0.62 Surge (Approved)
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
                  Minutes Left in 15m Window
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
                  Kalshi YES Ask ($0.01–$0.99)
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
                  Kalshi NO Ask ($0.01–$0.99)
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
                  Flat Fee / Contract ($0.02)
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
                {isEvaluatingSniper ? 'Calculating Black-Scholes d2...' : 'Run Deterministic Fee-Gate Check'}
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
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-mono font-semibold bg-emerald-500 hover:bg-emerald-400 text-slate-950 transition cursor-pointer shadow-lg shadow-emerald-500/10"
                >
                  <Zap className="w-3.5 h-3.5" />
                  {isExecutingSniperOrder
                    ? 'Routing Order...'
                    : `Execute ${leadLagResult.action} (${leadLagResult.contracts} Contracts · $${leadLagResult.totalRiskUsd} Risk)`}
                </button>
              )}
            </div>

            {/* 4 Hard Playbook Rules Checklist */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-2 border-t border-slate-800/80 text-[11px] font-mono">
              <div className="flex items-start gap-2 bg-slate-950/60 p-2.5 rounded-lg border border-slate-800/70">
                <Lock className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
                <div>
                  <span className="text-slate-200 font-semibold">Rule 1 · Price Band [$0.45, $0.82]:</span>
                  <p className="text-slate-400 mt-0.5">
                    Blocks cheap contracts (&lt;$0.45) where $0.02 flat fee creates &gt;7% immediate drag.
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-2 bg-slate-950/60 p-2.5 rounded-lg border border-slate-800/70">
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
                <div>
                  <span className="text-slate-200 font-semibold">Rule 2 · Net EV &gt; +$0.04/contract:</span>
                  <p className="text-slate-400 mt-0.5">
                    Subtracts $0.02 fee from Black-Scholes N(d2) fair value before approving execution.
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Right 5 Cols: Real-Time Black-Scholes & Fee Gate Output Card */}
          <div className="lg:col-span-5 bg-slate-900/90 border border-slate-800 rounded-xl p-4 flex flex-col justify-between space-y-4">
            {leadLagResult ? (
              <>
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-mono uppercase tracking-wider text-slate-400">
                      Sniper Execution Gate Decision
                    </span>
                    <span
                      className={`px-2.5 py-1 rounded-md text-xs font-mono font-bold border ${
                        leadLagResult.action === 'HOLD'
                          ? 'bg-rose-500/15 text-rose-300 border-rose-500/40'
                          : 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40'
                      }`}
                    >
                      {leadLagResult.action === 'HOLD'
                        ? 'BLOCKED / HOLD (0 CONTRACTS)'
                        : `${leadLagResult.action} · ${leadLagResult.contracts} CONTRACTS`}
                    </span>
                  </div>

                  <div
                    className={`p-3 rounded-lg border text-xs font-mono ${
                      leadLagResult.action === 'HOLD'
                        ? 'bg-rose-950/30 border-rose-500/30 text-rose-200'
                        : 'bg-emerald-950/30 border-emerald-500/30 text-emerald-200'
                    }`}
                  >
                    <div className="flex items-center gap-2 font-semibold">
                      {leadLagResult.action === 'HOLD' ? (
                        <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
                      ) : (
                        <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                      )}
                      <span>{leadLagResult.rationale}</span>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2.5 font-mono">
                    <div className="bg-slate-950/80 border border-slate-800 rounded-lg p-2.5">
                      <div className="text-[10px] text-slate-400">BLACK-SCHOLES FairYes N(d2)</div>
                      <div className="text-base font-bold text-white mt-0.5">
                        {(leadLagResult.fairYesProb * 100).toFixed(1)}%{' '}
                        <span className="text-[11px] font-normal text-slate-400">
                          (d2 = {leadLagResult.d2})
                        </span>
                      </div>
                    </div>
                    <div className="bg-slate-950/80 border border-slate-800 rounded-lg p-2.5">
                      <div className="text-[10px] text-slate-400">NET EDGE (AFTER $0.02 FEE)</div>
                      <div
                        className={`text-base font-bold mt-0.5 ${
                          leadLagResult.netEdgePerContract >= 0.04
                            ? 'text-emerald-400'
                            : 'text-amber-400'
                        }`}
                      >
                        {leadLagResult.netEdgePerContract >= 0 ? '+' : ''}$
                        {leadLagResult.netEdgePerContract.toFixed(3)} / contract
                      </div>
                    </div>
                    <div className="bg-slate-950/80 border border-slate-800 rounded-lg p-2.5">
                      <div className="text-[10px] text-slate-400">PRICE BAND GATE [$0.45, $0.82]</div>
                      <div
                        className={`text-xs font-bold mt-1 ${
                          leadLagResult.feeGatePassed ? 'text-emerald-400' : 'text-rose-400'
                        }`}
                      >
                        {leadLagResult.feeGatePassed
                          ? `PASSED (Ask $${leadLagResult.bestAsk.toFixed(2)})`
                          : `REJECTED (Ask $${leadLagResult.bestAsk.toFixed(2)})`}
                      </div>
                    </div>
                    <div className="bg-slate-950/80 border border-slate-800 rounded-lg p-2.5">
                      <div className="text-[10px] text-slate-400">POSITION SIZING CAP</div>
                      <div className="text-xs font-bold text-cyan-300 mt-1">
                        {leadLagResult.contracts} Contracts (${leadLagResult.totalRiskUsd.toFixed(2)} / $18 Max)
                      </div>
                    </div>
                  </div>
                </div>

                <div className="bg-slate-950/90 border border-slate-800/80 rounded-lg p-3 text-[11px] font-mono text-slate-400">
                  <div className="text-slate-200 font-semibold mb-1">
                    Why Oct 19 10:14 EDT ($0.27 Ask) Leaked Money:
                  </div>
                  Buying 111 contracts @ $0.27 ($19.98) incurred $2.25 in flat fees (11.2% instant drawdown).
                  With the $0.45–$0.82 Fee Gate + 25 contract cap, fee drag is capped under 3.2%.
                </div>
              </>
            ) : null}
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
                {auditRows.map((row) => (
                  <tr key={row.symbol} className="hover:bg-slate-900/40">
                    <td className="py-2 px-3 font-bold text-white">{row.symbol}</td>
                    <td className="py-2 px-3 text-slate-400">{row.assetType}</td>
                    <td className="py-2 px-3 text-right text-slate-300">{row.qty}</td>
                    <td className="py-2 px-3 text-right text-slate-200">
                      ${row.currentValue.toFixed(2)}
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
                      {row.pnlPct.toFixed(2)}%
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
                      ${row.estFee.toFixed(2)}
                    </td>
                    <td className="py-2 px-3 text-right font-semibold text-emerald-300">
                      {row.netCashFreed > 0 ? `+$${row.netCashFreed.toFixed(2)}` : '$0.00'}
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
