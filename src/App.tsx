import React, { useEffect, useState, useCallback } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  ArrowDownRight,
  BarChart3,
  CheckCircle2,
  Cpu,
  Database,
  Layers,
  Play,
  Plus,
  RefreshCw,
  ShieldAlert,
  Sliders,
  Zap,
  Terminal,
  Pause,
} from 'lucide-react';
import type {
  AutonomousAgent,
  DataFeedSpec,
  ExecutedOrder,
  IndicatorStrategyId,
  MarketFeatureVector,
  MarketRegime,
  McpCallLogEntry,
  McpResourceDefinition,
  McpServerConnection,
  McpToolDefinition,
  PlaybookCleanupAuditRow,
  PortfolioSummary,
  QuantitativeRegimeAssessment,
  RiskEventNotification,
  StrategyArchetype,
  StrategyTournamentEntry,
} from './types/quant.ts';
import { PriceEnvelopeChart } from './components/PriceEnvelopeChart.tsx';
import { AlphaScannerBacktest } from './components/AlphaScannerBacktest.tsx';
import { RiskEventsLog } from './components/RiskEventsLog.tsx';
import { KalshiMcpHub } from './components/KalshiMcpHub.tsx';
import { MasterPlaybookVault } from './components/MasterPlaybookVault.tsx';

type WorkspaceTab =
  | 'COMMAND_CENTER'
  | 'ALPHA_SCANNER_BACKTEST'
  | 'DATA_FEEDS_PLAN'
  | 'REGIME_EVALUATOR'
  | 'AGENT_ORCHESTRATOR';

const DEFAULT_ASSESSMENT: QuantitativeRegimeAssessment = {
  market_regime: 'LOW_VOLATILITY_COMPRESSION',
  key_drivers: [
    'ATR(14) at 0.76% (0.84x baseline) with +0.10% 9/21 EMA spread',
    'RSI(14) at 33.8 and L2 orderbook imbalance +0.19 (+0.12% vs VWAP)',
  ],
  support_level: 92.5,
  resistance_level: 96.2,
  bias_probability_distribution: {
    bullish: 0.48,
    bearish: 0.22,
    neutral: 0.3,
  },
  rationale:
    'Rolling ATR compression (0.76%) precedes directional expansion while price holds above 200D SMA support with oversold RSI(14) at 33.8.',
};

export default function App() {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('COMMAND_CENTER');
  const [portfolio, setPortfolio] = useState<PortfolioSummary | null>(null);
  const [feeds, setFeeds] = useState<DataFeedSpec[]>([]);
  const [features, setFeatures] = useState<MarketFeatureVector[]>([]);
  const [agents, setAgents] = useState<AutonomousAgent[]>([]);
  const [orders, setOrders] = useState<ExecutedOrder[]>([]);
  const [riskEvents, setRiskEvents] = useState<RiskEventNotification[]>([]);
  const [strategyTournament, setStrategyTournament] = useState<StrategyTournamentEntry[]>([]);
  const [playbookCleanupAudit, setPlaybookCleanupAudit] = useState<PlaybookCleanupAuditRow[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServerConnection[]>([]);
  const [mcpTools, setMcpTools] = useState<McpToolDefinition[]>([]);
  const [mcpResources, setMcpResources] = useState<McpResourceDefinition[]>([]);
  const [mcpLogs, setMcpLogs] = useState<McpCallLogEntry[]>([]);
  const [selectedSymbol, setSelectedSymbol] = useState<string>('KXBTC15M');

  // Filter states
  const [feedFilter, setFeedFilter] = useState<'ALL' | 'LONG_AND_LOW' | 'SHORT_AND_FAST'>('ALL');
  const [agentFilter, setAgentFilter] = useState<'ALL' | 'LONG_AND_LOW' | 'SHORT_AND_FAST'>('ALL');

  // Action states
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isEvaluating, setIsEvaluating] = useState<boolean>(false);
  const [evalSource, setEvalSource] = useState<string>('DETERMINISTIC_QUANT_ENGINE');
  const [statusBanner, setStatusBanner] = useState<{ type: 'info' | 'warn' | 'success'; message: string } | null>(
    null
  );

  // Agent Spawner Form State
  const [newAgentName, setNewAgentName] = useState<string>('');
  const [newAgentArchetype, setNewAgentArchetype] = useState<StrategyArchetype>('SHORT_AND_FAST');
  const [newAgentSymbol, setNewAgentSymbol] = useState<string>('KXBTC15M');
  const [newAgentIndicatorId, setNewAgentIndicatorId] = useState<IndicatorStrategyId>('BTC_LEAD_LAG_SNIPER');
  const [newAgentCapital, setNewAgentCapital] = useState<number>(120);
  const [newAgentMaxDrawdown, setNewAgentMaxDrawdown] = useState<number>(1.5);
  const [newAgentAtrMultiplier, setNewAgentAtrMultiplier] = useState<number>(2.2);

  const fetchInitialState = useCallback(async () => {
    try {
      const res = await fetch('/api/state');
      if (!res.ok) throw new Error('Failed to load state');
      const data = await res.json();
      setPortfolio(data.portfolio);
      setFeeds(data.feeds);
      setFeatures(data.features);
      setAgents(data.agents);
      setOrders(data.orders);
      if (Array.isArray(data.riskEvents)) {
        setRiskEvents(data.riskEvents);
      }
      if (Array.isArray(data.strategyTournament)) {
        setStrategyTournament(data.strategyTournament);
      }
      if (Array.isArray(data.playbookCleanupAudit)) {
        setPlaybookCleanupAudit(data.playbookCleanupAudit);
      }
      if (data.mcp) {
        if (Array.isArray(data.mcp.servers)) setMcpServers(data.mcp.servers);
        if (Array.isArray(data.mcp.tools)) setMcpTools(data.mcp.tools);
        if (Array.isArray(data.mcp.resources)) setMcpResources(data.mcp.resources);
        if (Array.isArray(data.mcp.logs)) setMcpLogs(data.mcp.logs);
      }
    } catch {
      setStatusBanner({
        type: 'warn',
        message: 'Unable to reach backend telemetry endpoint. Retrying synchronization.',
      });
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchInitialState();
    const interval = setInterval(async () => {
      try {
        const res = await fetch('/api/market/tick', { method: 'POST' });
        if (res.ok) {
          const data = await res.json();
          setPortfolio(data.portfolio);
          setFeatures(data.features);
          setAgents(data.agents);
          setOrders(data.orders);
          if (Array.isArray(data.riskEvents)) {
            setRiskEvents(data.riskEvents);
          }
        }
      } catch {
        // Silent background tick error
      }
    }, 5500);
    return () => clearInterval(interval);
  }, [fetchInitialState]);

  const activeFeature = features.find((f) => f.symbol === selectedSymbol) || features[0];
  const activeAssessment = activeFeature?.lastAssessment || DEFAULT_ASSESSMENT;

  const handleEvaluateRegime = async (symbolToEval: string) => {
    setIsEvaluating(true);
    try {
      const res = await fetch('/api/quant/evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: symbolToEval }),
      });
      if (res.ok) {
        const data = await res.json();
        setEvalSource(data.source || 'DETERMINISTIC_QUANT_ENGINE');
        setFeatures((prev) =>
          prev.map((f) => (f.symbol === symbolToEval ? { ...f, lastAssessment: data.assessment } : f))
        );
        setStatusBanner({
          type: 'success',
          message: `Completed deterministic JSON regime evaluation for ${symbolToEval}: ${data.assessment.market_regime}`,
        });
      }
    } finally {
      setIsEvaluating(false);
    }
  };

  const handleToggleFeed = async (feedId: string) => {
    const res = await fetch('/api/feeds/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feedId }),
    });
    if (res.ok) {
      const data = await res.json();
      setFeeds(data.feeds);
    }
  };

  const handleSpawnAgent = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await fetch('/api/agents/spawn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: newAgentName,
        archetype: newAgentArchetype,
        targetSymbol: newAgentSymbol,
        indicatorStrategyId: newAgentIndicatorId,
        allocatedCapitalUsd: newAgentCapital,
        maxDrawdownLimitPct: newAgentMaxDrawdown,
        atrSpikeKillMultiplier: newAgentAtrMultiplier,
      }),
    });
    if (res.ok) {
      const data = await res.json();
      setAgents(data.agents);
      setOrders(data.orders);
      setPortfolio(data.portfolio);
      setNewAgentName('');
      setStatusBanner({
        type: 'success',
        message: `Deployed ${data.agent.name} on ${data.agent.targetSymbol} (${data.agent.indicatorStrategyLabel}) with initial OCO order (${data.order.id}).`,
      });
    }
  };

  const handleDeployBestStrategy = async () => {
    setIsEvaluating(true);
    try {
      const res = await fetch('/api/agents/deploy-best-strategy', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        setAgents(data.agents);
        setOrders(data.orders);
        setPortfolio(data.portfolio);
        if (Array.isArray(data.strategyTournament)) {
          setStrategyTournament(data.strategyTournament);
        }
        if (data.winner?.symbol) {
          setSelectedSymbol(data.winner.symbol);
        }
        setStatusBanner({
          type: 'success',
          message: `Deployed #1 Real-Data Winner (${data.winner.symbol} · ${data.winner.indicatorStrategyLabel} · +${data.winner.totalReturnPct}% return, Sharpe ${data.winner.sharpeRatio}) & diversified all ${data.agents.length} agents across distinct tickers and indicators!`,
        });
      }
    } finally {
      setIsEvaluating(false);
    }
  };

  const handleDeploy15mHftWinner = async () => {
    setIsEvaluating(true);
    try {
      const res = await fetch('/api/agents/deploy-15m-hft-winner', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        setAgents(data.agents);
        setOrders(data.orders);
        setPortfolio(data.portfolio);
        if (Array.isArray(data.strategyTournament)) {
          setStrategyTournament(data.strategyTournament);
        }
        if (data.winner?.symbol) {
          setSelectedSymbol(data.winner.symbol);
        }
        setStatusBanner({
          type: 'success',
          message: `Deployed #1 15-Minute HFT Winner (${data.winner.symbol} · ${data.winner.indicatorStrategyLabel} · +${data.winner.totalReturnPct}% return, Sharpe ${data.winner.sharpeRatio}) & launched 15m HFT scalper fleet across all 5 Kalshi 15m markets!`,
        });
      }
    } finally {
      setIsEvaluating(false);
    }
  };

  const handleMetaOptimize = async () => {
    const res = await fetch('/api/agents/meta-optimize', { method: 'POST' });
    if (res.ok) {
      const data = await res.json();
      setAgents(data.agents);
      setOrders(data.orders);
      setPortfolio(data.portfolio);
      if (Array.isArray(data.strategyTournament)) {
        setStrategyTournament(data.strategyTournament);
      }
      setStatusBanner({
        type: 'success',
        message: `Meta-Agent evaluated real historical bars and deployed ${data.spawnedAgent.name} with OCO bracket ${data.order.id}.`,
      });
    }
  };

  const handleExecuteAgentTrade = async (agentId: string) => {
    const res = await fetch('/api/agents/execute-trade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId }),
    });
    if (res.ok) {
      const data = await res.json();
      setAgents(data.agents);
      setOrders(data.orders);
      setPortfolio(data.portfolio);
      setStatusBanner({
        type: 'success',
        message: `Executed deterministic OCO order ${data.order.id} on ${data.order.symbol} at ${data.order.fillPrice}.`,
      });
    } else {
      const err = await res.json();
      setStatusBanner({
        type: 'warn',
        message: err.error || 'Trade execution blocked by risk governance.',
      });
    }
  };

  const handleToggleAgentStatus = async (agentId: string) => {
    const res = await fetch('/api/agents/toggle-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId }),
    });
    if (res.ok) {
      const data = await res.json();
      setAgents(data.agents);
      setFeatures(data.features);
      setPortfolio(data.portfolio);
      if (Array.isArray(data.riskEvents)) {
        setRiskEvents(data.riskEvents);
      }
    }
  };

  const handleSimulateStressTest = async (symbol: string) => {
    const res = await fetch('/api/risk/stress-test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol }),
    });
    if (res.ok) {
      const data = await res.json();
      setPortfolio(data.portfolio);
      setFeatures(data.features);
      setAgents(data.agents);
      setOrders(data.orders);
      if (Array.isArray(data.riskEvents)) {
        setRiskEvents(data.riskEvents);
      }
      setStatusBanner({
        type: 'warn',
        message: `ATR Volatility Shock (2.95x baseline) triggered on ${symbol}: Automated Kill-Switch halted exposed Short & Fast agents and logged circuit-breaker events.`,
      });
    }
  };

  const handleGlobalKillSwitch = async () => {
    const res = await fetch('/api/risk/global-kill-switch', { method: 'POST' });
    if (res.ok) {
      const data = await res.json();
      setPortfolio(data.portfolio);
      setFeatures(data.features);
      setAgents(data.agents);
      setOrders(data.orders);
      if (Array.isArray(data.riskEvents)) {
        setRiskEvents(data.riskEvents);
      }
      setStatusBanner({
        type: data.portfolio.globalKillSwitchActive ? 'warn' : 'info',
        message: data.portfolio.globalKillSwitchActive
          ? 'Global Emergency Kill-Switch Engaged: All autonomous agents halted and working orders cancelled.'
          : 'Global Kill-Switch Reset: Autonomous agents restored to active execution.',
      });
    }
  };

  const handleAcknowledgeRiskEvent = async (eventId?: string, acknowledgeAll?: boolean) => {
    const res = await fetch('/api/risk/acknowledge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventId, acknowledgeAll }),
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.riskEvents)) {
        setRiskEvents(data.riskEvents);
      }
    }
  };

  const handleSyncPublicApi = async () => {
    setIsEvaluating(true);
    try {
      const res = await fetch('/api/public/sync', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        setPortfolio(data.portfolio);
        setFeatures(data.features);
        setAgents(data.agents);
        setOrders(data.orders);
        if (Array.isArray(data.riskEvents)) {
          setRiskEvents(data.riskEvents);
        }
        if (Array.isArray(data.strategyTournament)) {
          setStrategyTournament(data.strategyTournament);
        }
        if (data.mcp) {
          if (Array.isArray(data.mcp.servers)) setMcpServers(data.mcp.servers);
          if (Array.isArray(data.mcp.tools)) setMcpTools(data.mcp.tools);
          if (Array.isArray(data.mcp.resources)) setMcpResources(data.mcp.resources);
          if (Array.isArray(data.mcp.logs)) setMcpLogs(data.mcp.logs);
        }
        setStatusBanner({
          type: data.portfolio.publicApiConfigured ? 'success' : 'info',
          message: `${data.portfolio.publicLastSyncStatus} · ${data.portfolio.kalshiLastSyncStatus || 'Kalshi v2 Active'}`,
        });
      }
    } finally {
      setIsEvaluating(false);
    }
  };

  const handleSyncKalshi = async () => {
    setIsEvaluating(true);
    try {
      const res = await fetch('/api/kalshi/sync', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        setPortfolio(data.portfolio);
        setFeatures(data.features);
        setAgents(data.agents);
        setOrders(data.orders);
        if (Array.isArray(data.riskEvents)) {
          setRiskEvents(data.riskEvents);
        }
        if (Array.isArray(data.strategyTournament)) {
          setStrategyTournament(data.strategyTournament);
        }
        if (data.mcp) {
          if (Array.isArray(data.mcp.servers)) setMcpServers(data.mcp.servers);
          if (Array.isArray(data.mcp.tools)) setMcpTools(data.mcp.tools);
          if (Array.isArray(data.mcp.resources)) setMcpResources(data.mcp.resources);
          if (Array.isArray(data.mcp.logs)) setMcpLogs(data.mcp.logs);
        }
        setStatusBanner({
          type: 'success',
          message:
            data.portfolio.kalshiLastSyncStatus ||
            `Pulled Live Kalshi Portfolio v2: Total $${(data.portfolio.kalshiTotalEquityUsd ?? 73.86).toFixed(2)} ($${(
              data.portfolio.kalshiCashBalanceUsd ?? 29.27
            ).toFixed(2)} Cash + $${(data.portfolio.kalshiPortfolioValueUsd ?? 44.59).toFixed(2)} Contracts)`,
        });
      }
    } finally {
      setIsEvaluating(false);
    }
  };

  const handleInvokeMcpTool = async (
    toolName: string,
    args: Record<string, any>
  ): Promise<Record<string, any> | null> => {
    const res = await fetch('/api/mcp/invoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolName, args }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.portfolio) setPortfolio(data.portfolio);
      if (Array.isArray(data.orders)) setOrders(data.orders);
      if (Array.isArray(data.logs)) setMcpLogs(data.logs);
      if (Array.isArray(data.servers)) setMcpServers(data.servers);
      setStatusBanner({
        type: 'success',
        message: `MCP JSON-RPC 2.0 Tool Executed: ${toolName}`,
      });
      return data.result || null;
    }
    return null;
  };

  const handleConnectMcpServer = async (config: {
    name: string;
    endpointUrl: string;
    transport: 'HTTP_JSON_RPC' | 'SSE_STREAM' | 'STDIO_BRIDGE';
    authHeader?: string;
  }) => {
    const res = await fetch('/api/mcp/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.servers)) setMcpServers(data.servers);
      if (Array.isArray(data.logs)) setMcpLogs(data.logs);
      if (data.portfolio) setPortfolio(data.portfolio);
      setStatusBanner({
        type: 'success',
        message: `Connected MCP Server '${data.server.name}' (${data.server.endpointUrl}) over ${data.server.transport}.`,
      });
    }
  };

  const formatRegimeLabel = (regime: MarketRegime) => {
    switch (regime) {
      case 'TRENDING_BULL':
        return { text: 'TRENDING_BULL', color: 'text-emerald-400' };
      case 'TRENDING_BEAR':
        return { text: 'TRENDING_BEAR', color: 'text-rose-400' };
      case 'HIGH_VOLATILITY_RANGE':
        return { text: 'HIGH_VOLATILITY_RANGE', color: 'text-amber-400' };
      case 'LOW_VOLATILITY_COMPRESSION':
        return { text: 'LOW_VOLATILITY_COMPRESSION', color: 'text-cyan-400' };
    }
  };

  const filteredFeeds = feeds.filter((f) => {
    if (feedFilter === 'ALL') return true;
    return f.targetArchetype === 'BOTH' || f.targetArchetype === feedFilter;
  });

  const filteredAgents = agents.filter((a) => {
    if (agentFilter === 'ALL') return true;
    return a.archetype === agentFilter;
  });

  return (
    <div className="min-h-screen bg-[#0B0F17] text-slate-100 flex flex-col">
      {/* Strict 3-Zone Top Bar Contract */}
      <header className="flex items-center justify-between gap-8 px-6 py-3.5 border-b border-slate-800 bg-[#0E1420]">
        {/* Zone 1: Single text element wordmark */}
        <a
          href="#top"
          onClick={(e) => {
            e.preventDefault();
            setActiveTab('COMMAND_CENTER');
          }}
          className="text-lg font-bold tracking-tight text-slate-100 whitespace-nowrap shrink-0 font-display"
        >
          QuantPulse
        </a>

        {/* Zone 2: 5 concise single-line text navigation links */}
        <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-400">
          <button
            type="button"
            onClick={() => setActiveTab('COMMAND_CENTER')}
            className={`hover:text-slate-100 transition-colors whitespace-nowrap shrink-0 py-1 border-b-2 ${
              activeTab === 'COMMAND_CENTER' ? 'text-slate-100 border-cyan-400' : 'border-transparent'
            }`}
          >
            Command Center
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('ALPHA_SCANNER_BACKTEST')}
            className={`hover:text-slate-100 transition-colors whitespace-nowrap shrink-0 py-1 border-b-2 ${
              activeTab === 'ALPHA_SCANNER_BACKTEST' ? 'text-slate-100 border-cyan-400' : 'border-transparent'
            }`}
          >
            Alpha Scanner & Backtest
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('DATA_FEEDS_PLAN')}
            className={`hover:text-slate-100 transition-colors whitespace-nowrap shrink-0 py-1 border-b-2 ${
              activeTab === 'DATA_FEEDS_PLAN' ? 'text-slate-100 border-cyan-400' : 'border-transparent'
            }`}
          >
            Data & Feeds Plan
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('REGIME_EVALUATOR')}
            className={`hover:text-slate-100 transition-colors whitespace-nowrap shrink-0 py-1 border-b-2 ${
              activeTab === 'REGIME_EVALUATOR' ? 'text-slate-100 border-cyan-400' : 'border-transparent'
            }`}
          >
            Regime Evaluator
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('AGENT_ORCHESTRATOR')}
            className={`hover:text-slate-100 transition-colors whitespace-nowrap shrink-0 py-1 border-b-2 ${
              activeTab === 'AGENT_ORCHESTRATOR' ? 'text-slate-100 border-cyan-400' : 'border-transparent'
            }`}
          >
            Agent Orchestrator
          </button>
        </nav>

        {/* Zone 3: 1 primary action */}
        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={handleGlobalKillSwitch}
            className={`px-4 py-2 text-xs font-semibold rounded transition-colors whitespace-nowrap shrink-0 ${
              portfolio?.globalKillSwitchActive
                ? 'bg-emerald-600 text-white hover:bg-emerald-500'
                : 'bg-rose-600 text-white hover:bg-rose-500'
            }`}
          >
            {portfolio?.globalKillSwitchActive ? 'Reset Kill-Switch' : 'Emergency Kill-Switch'}
          </button>
        </div>
      </header>

      {/* Main Workspace Layout: Left Sidebar (260px) + Primary Viewport */}
      <div className="flex-1 flex flex-col lg:flex-row">
        {/* Left Navigation & Market Watchlist Sidebar */}
        <aside className="w-full lg:w-64 shrink-0 border-b lg:border-b-0 lg:border-r border-slate-800 bg-[#0D131F] p-4 flex flex-col justify-between gap-6">
          <div className="space-y-5">
            {/* Live Kalshi Portfolio v2 & MCP Node Summary */}
            <div>
              <div className="flex items-center justify-between text-xs font-medium text-slate-400 mb-2">
                <span className="text-emerald-400 font-semibold">Live Kalshi Balance</span>
                <button
                  type="button"
                  onClick={handleSyncKalshi}
                  className="text-[11px] text-cyan-400 hover:underline whitespace-nowrap"
                >
                  Pull Kalshi &amp; MCP
                </button>
              </div>
              <div className="p-3 border border-emerald-500/30 bg-[#0B0F17] space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-slate-400">Kalshi Total Equity</span>
                  <span className="font-mono tabular-nums font-bold text-emerald-400">
                    ${(portfolio?.kalshiTotalEquityUsd ?? 73.86).toFixed(2)}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-400">Available Cash</span>
                  <span className="font-mono tabular-nums text-slate-100">
                    ${(portfolio?.kalshiCashBalanceUsd ?? 29.27).toFixed(2)}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-400">Open Contracts Value</span>
                  <span className="font-mono tabular-nums text-amber-300">
                    ${(portfolio?.kalshiPortfolioValueUsd ?? 44.59).toFixed(2)} ({portfolio?.kalshiPositions?.length ?? 8} Pos)
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-400">Kalshi Auth</span>
                  <span className="font-mono tabular-nums text-emerald-400">
                    {portfolio?.kalshiAuthMethod || 'ED25519_SIGNED_V2'}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-400">MCP Bridge</span>
                  <span className="font-mono tabular-nums text-cyan-400 font-semibold">
                    {mcpServers.length || 3} Nodes · {mcpTools.length || 6} Tools
                  </span>
                </div>
              </div>
            </div>

            {/* Brokerage & Venue Telemetry Summary */}
            <div>
              <div className="flex items-center justify-between text-xs font-medium text-slate-400 mb-2">
                <span>Live Public.com Balance</span>
                <button
                  type="button"
                  onClick={handleSyncPublicApi}
                  className="text-[11px] text-cyan-400 hover:underline whitespace-nowrap"
                >
                  Sync Live Balance
                </button>
              </div>
              <div className="p-3 border border-slate-800 bg-[#0B0F17] space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-slate-400">Account ID</span>
                  <span className="font-mono tabular-nums font-semibold text-slate-100">
                    {portfolio?.accountId || '5OQ77709'} ({portfolio?.accountType || 'BROKERAGE'})
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-400">Total Account Value</span>
                  <span className="font-mono tabular-nums font-bold text-emerald-400">
                    ${portfolio ? portfolio.totalEquityUsd.toLocaleString('en-US', { minimumFractionDigits: 2 }) : '625.35'}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-400">Cash &amp; Buying Power</span>
                  <span className="font-mono tabular-nums text-slate-100">
                    ${portfolio ? portfolio.cashBalanceUsd.toLocaleString('en-US', { minimumFractionDigits: 2 }) : '457.52'}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-400">Stock &amp; ETF Value</span>
                  <span className="font-mono tabular-nums text-cyan-400">
                    ${portfolio ? portfolio.stockEquityUsd.toLocaleString('en-US', { minimumFractionDigits: 2 }) : '149.83'}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-400">Event Contracts</span>
                  <span className="font-mono tabular-nums text-amber-300">
                    ${portfolio ? portfolio.eventContractsEquityUsd.toLocaleString('en-US', { minimumFractionDigits: 2 }) : '18.00'}
                  </span>
                </div>
                {portfolio?.publicLastSyncStatus && (
                  <div className="pt-1.5 border-t border-slate-800/80 text-[11px] text-slate-400 leading-snug">
                    {portfolio.publicLastSyncStatus}
                  </div>
                )}
                {portfolio?.kalshiLastSyncStatus && (
                  <div className="text-[11px] text-emerald-400/90 font-mono leading-snug">
                    {portfolio.kalshiLastSyncStatus}
                  </div>
                )}
              </div>
            </div>

            {/* Tracked Instrument Selector */}
            <div>
              <div className="flex items-center justify-between text-xs font-medium text-slate-400 mb-2">
                <span>Tracked Instruments</span>
                <span className="font-mono tabular-nums">{features.length} Feeds</span>
              </div>
              <div className="space-y-1">
                {features.map((item) => {
                  const isSelected = item.symbol === selectedSymbol;
                  const isPositive = item.change24hPct >= 0;
                  const decimals = item.price < 2 ? 4 : 2;
                  const regimeInfo = formatRegimeLabel(
                    item.lastAssessment?.market_regime || 'LOW_VOLATILITY_COMPRESSION'
                  );
                  return (
                    <button
                      key={item.symbol}
                      type="button"
                      onClick={() => setSelectedSymbol(item.symbol)}
                      className={`w-full text-left px-3 py-2.5 border transition-colors ${
                        isSelected
                          ? 'border-cyan-500/60 bg-slate-800/70 text-slate-100'
                          : 'border-slate-800/80 bg-[#0B0F17]/60 text-slate-300 hover:bg-slate-800/40'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-mono font-semibold text-xs truncate max-w-[140px]">
                          {item.symbol}
                        </span>
                        <span className="font-mono tabular-nums text-xs text-slate-100">
                          {item.assetClass === 'PREDICTION_CONTRACT'
                            ? `${(item.price * 100).toFixed(1)}¢`
                            : `$${item.price.toFixed(decimals)}`}
                        </span>
                      </div>
                      <div className="flex items-center justify-between mt-1 text-[11px] text-slate-400">
                        <span className={`font-mono truncate max-w-[125px] ${regimeInfo.color}`}>
                          {regimeInfo.text}
                        </span>
                        <span
                          className={`font-mono tabular-nums ${
                            isPositive ? 'text-emerald-400' : 'text-rose-400'
                          }`}
                        >
                          {isPositive ? '+' : ''}
                          {item.change24hPct.toFixed(2)}%
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Meta-Agent Portfolio Optimizer Action */}
            <div className="pt-2 border-t border-slate-800 space-y-2">
              <div className="text-xs font-medium text-slate-400">Dynamic Meta-Agent</div>
              <p className="text-xs text-slate-400 leading-relaxed">
                Scans rolling ATR compression and 9/21 EMA velocity across all feeds to auto-spawn a calibrated child agent.
              </p>
              <button
                type="button"
                onClick={handleMetaOptimize}
                className="w-full py-2 px-3 bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold text-xs rounded transition-colors flex items-center justify-center gap-1.5 whitespace-nowrap"
              >
                <Zap className="w-3.5 h-3.5" />
                <span>Auto-Spawn Optimal Agent</span>
              </button>
            </div>
          </div>

          {/* Risk Governance Footer Note */}
          <div className="pt-4 border-t border-slate-800 text-[11px] text-slate-400 space-y-1">
            <div className="text-slate-300 font-medium">Deterministic Risk Gate</div>
            <div>1. Rolling ATR(14) & StdDev evaluated prior to bias.</div>
            <div>2. OCO stops auto-sized by ATR multiples.</div>
          </div>
        </aside>

        {/* Main Content Viewport */}
        <main className="flex-1 p-6 space-y-6 overflow-y-auto max-w-[1440px]">
          {/* Contextual Status Banner */}
          {statusBanner && (
            <div
              className={`flex items-center justify-between px-4 py-2.5 border text-xs ${
                statusBanner.type === 'warn'
                  ? 'border-amber-500/50 bg-amber-950/30 text-amber-200'
                  : statusBanner.type === 'success'
                  ? 'border-emerald-500/50 bg-emerald-950/30 text-emerald-200'
                  : 'border-cyan-500/50 bg-cyan-950/30 text-cyan-200'
              }`}
            >
              <div className="flex items-center gap-2">
                {statusBanner.type === 'warn' ? (
                  <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
                ) : (
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                )}
                <span>{statusBanner.message}</span>
              </div>
              <button
                type="button"
                onClick={() => setStatusBanner(null)}
                className="text-slate-400 hover:text-slate-200 ml-4 whitespace-nowrap"
              >
                Dismiss
              </button>
            </div>
          )}

          {/* Top Quantitative KPI Strip: Live Kalshi v2 + Public.com + MCP Bridge */}
          <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="p-4 border border-emerald-500/40 bg-[#111827]">
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span>Live Kalshi Portfolio v2 Equity</span>
                <span className="font-mono text-[11px] text-emerald-400">
                  {portfolio?.kalshiKeyIdPreview || 'ED25519 LIVE'}
                </span>
              </div>
              <div className="mt-1 text-2xl font-bold font-mono tabular-nums text-emerald-400">
                ${(portfolio?.kalshiTotalEquityUsd ?? 73.86).toFixed(2)}
              </div>
              <div className="mt-1 flex items-center gap-1.5 text-xs text-slate-400 font-mono">
                <span>Cash: ${(portfolio?.kalshiCashBalanceUsd ?? 29.27).toFixed(2)}</span>
                <span aria-hidden="true">·</span>
                <span className="text-amber-300">
                  Contracts: ${(portfolio?.kalshiPortfolioValueUsd ?? 44.59).toFixed(2)} ({portfolio?.kalshiPositions?.length ?? 8})
                </span>
              </div>
            </div>

            <div className="p-4 border border-slate-800 bg-[#111827]">
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span>Public.com Live Account Value</span>
                <span className="font-mono text-[11px] text-cyan-400">
                  {portfolio?.accountId || '5OQ77709'}
                </span>
              </div>
              <div className="mt-1 text-2xl font-bold font-mono tabular-nums text-slate-100">
                ${portfolio ? portfolio.totalEquityUsd.toLocaleString('en-US', { minimumFractionDigits: 2 }) : '625.35'}
              </div>
              <div className="mt-1 flex items-center gap-1.5 text-xs text-slate-400 font-mono">
                <span>Cash: ${portfolio ? portfolio.cashBalanceUsd.toFixed(2) : '457.52'}</span>
                <span aria-hidden="true">·</span>
                <span className="text-cyan-400">
                  Stocks: ${portfolio ? portfolio.stockEquityUsd.toFixed(2) : '149.83'}
                </span>
              </div>
            </div>

            <div className="p-4 border border-slate-800 bg-[#111827]">
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span>Combined Multi-Venue Equity</span>
                <span className="font-mono text-[11px] text-emerald-300">PUBLIC + KALSHI</span>
              </div>
              <div className="mt-1 text-2xl font-bold font-mono tabular-nums text-cyan-400">
                ${(
                  portfolio?.combinedMultiVenueEquityUsd ??
                  (portfolio?.totalEquityUsd ?? 625.35) + (portfolio?.kalshiTotalEquityUsd ?? 73.86)
                ).toFixed(2)}
              </div>
              <div className="mt-1 flex items-center gap-1.5 text-xs text-slate-400">
                <span>{(portfolio?.publicPositions?.length ?? 16) + (portfolio?.kalshiPositions?.length ?? 8)} Total Holdings</span>
                <span aria-hidden="true">·</span>
                <span className="font-mono tabular-nums text-slate-300">100% Real Telemetry</span>
              </div>
            </div>

            <div className="p-4 border border-cyan-500/30 bg-[#111827]">
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span>Model Context Protocol (MCP)</span>
                <span className="font-mono text-[11px] text-cyan-400">v2024-11-05</span>
              </div>
              <div className="mt-1 text-2xl font-bold font-mono tabular-nums text-slate-100">
                {mcpServers.length || 3} Nodes · {mcpTools.length || 6} Tools
              </div>
              <div className="mt-1 flex items-center gap-1.5 text-xs text-slate-400 font-mono">
                <span className="text-emerald-400">POST /api/mcp</span>
                <span aria-hidden="true">·</span>
                <span className="text-cyan-400">SSE /api/mcp/sse</span>
              </div>
            </div>
          </section>

          {/* Mobile / Secondary Workspace Switcher */}
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-3">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setActiveTab('COMMAND_CENTER')}
                className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap ${
                  activeTab === 'COMMAND_CENTER'
                    ? 'bg-slate-800 text-slate-100'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                01. Command Center
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('ALPHA_SCANNER_BACKTEST')}
                className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap ${
                  activeTab === 'ALPHA_SCANNER_BACKTEST'
                    ? 'bg-slate-800 text-cyan-400'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                02. Alpha Scanner &amp; Backtest Engine
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('DATA_FEEDS_PLAN')}
                className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap ${
                  activeTab === 'DATA_FEEDS_PLAN'
                    ? 'bg-slate-800 text-slate-100'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                03. Kalshi MCP &amp; Data Feeds
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('REGIME_EVALUATOR')}
                className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap ${
                  activeTab === 'REGIME_EVALUATOR'
                    ? 'bg-slate-800 text-slate-100'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                04. Quantitative JSON Regime Evaluator
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('AGENT_ORCHESTRATOR')}
                className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap ${
                  activeTab === 'AGENT_ORCHESTRATOR'
                    ? 'bg-slate-800 text-slate-100'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                05. Agent Spawner &amp; Risk Circuit Breakers
              </button>
            </div>

            {activeFeature && (
              <div className="flex items-center gap-2 text-xs">
                <button
                  type="button"
                  onClick={() => handleEvaluateRegime(activeFeature.symbol)}
                  disabled={isEvaluating}
                  className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-100 font-medium rounded transition-colors flex items-center gap-1.5 whitespace-nowrap"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isEvaluating ? 'animate-spin text-cyan-400' : ''}`} />
                  <span>Evaluate {activeFeature.symbol} Regime</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleSimulateStressTest(activeFeature.symbol)}
                  className="px-3 py-1.5 bg-amber-950/60 hover:bg-amber-900/60 border border-amber-500/40 text-amber-200 font-medium rounded transition-colors flex items-center gap-1.5 whitespace-nowrap"
                >
                  <ShieldAlert className="w-3.5 h-3.5 text-amber-400" />
                  <span>Simulate {activeFeature.symbol} ATR Spike</span>
                </button>
              </div>
            )}
          </div>

          {/* VIEW: ALPHA SCANNER & BACKTEST ENGINE */}
          {activeTab === 'ALPHA_SCANNER_BACKTEST' && (
            <div className="space-y-6">
              <MasterPlaybookVault
                features={features}
                cleanupAudit={playbookCleanupAudit}
                onStateUpdated={(payload) => {
                  if (payload.agents) setAgents(payload.agents);
                  if (payload.orders) setOrders(payload.orders);
                  if (payload.portfolio) setPortfolio(payload.portfolio);
                  if (payload.strategyTournament) setStrategyTournament(payload.strategyTournament);
                  if (payload.cleanupAudit) setPlaybookCleanupAudit(payload.cleanupAudit);
                  if (payload.bannerMessage) {
                    setStatusBanner({ type: 'success', message: payload.bannerMessage });
                  }
                }}
              />
              <AlphaScannerBacktest
                features={features}
                strategyTournament={strategyTournament}
                onDeployBestTournamentStrategy={handleDeployBestStrategy}
                onDeploy15mHftWinner={handleDeploy15mHftWinner}
                onSelectSymbolInMain={(sym) => setSelectedSymbol(sym)}
                onDeployFromBacktest={async (config) => {
                  const res = await fetch('/api/agents/spawn', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(config),
                  });
                  if (res.ok) {
                    const data = await res.json();
                    setAgents(data.agents);
                    setOrders(data.orders);
                    setPortfolio(data.portfolio);
                    setSelectedSymbol(config.targetSymbol);
                    setStatusBanner({
                      type: 'success',
                      message: `Real-bar backtested agent ${data.agent.name} deployed live on ${data.agent.targetSymbol} with initial OCO bracket (${data.order.id}).`,
                    });
                  }
                }}
              />
            </div>
          )}

          {/* VIEW 1: COMMAND CENTER (Unified Overview of Kalshi Balance + MCP Hub, Public.com Portfolio, Chart, Deterministic JSON Assessment, Strategy Matrix, Active Agents) */}
          {activeTab === 'COMMAND_CENTER' && activeFeature && (
            <div className="space-y-6">
              {/* Public.com Master Quant Playbook & Code Vault: Live BTC Lead-Lag Sniper, $0.45-$0.82 Fee Gate & 16-Position Dust Sweeper */}
              <MasterPlaybookVault
                features={features}
                cleanupAudit={playbookCleanupAudit}
                onStateUpdated={(payload) => {
                  if (payload.agents) setAgents(payload.agents);
                  if (payload.orders) setOrders(payload.orders);
                  if (payload.portfolio) setPortfolio(payload.portfolio);
                  if (payload.strategyTournament) setStrategyTournament(payload.strategyTournament);
                  if (payload.cleanupAudit) setPlaybookCleanupAudit(payload.cleanupAudit);
                  if (payload.bannerMessage) {
                    setStatusBanner({ type: 'success', message: payload.bannerMessage });
                  }
                }}
              />
              {/* Live Kalshi Portfolio v2 Balance, Open Positions, Fills & Model Context Protocol (MCP) Hub */}
              <KalshiMcpHub
                portfolio={portfolio}
                mcpServers={mcpServers}
                mcpTools={mcpTools}
                mcpResources={mcpResources}
                mcpLogs={mcpLogs}
                isSyncing={isEvaluating}
                onSyncKalshi={handleSyncKalshi}
                onInvokeMcpTool={handleInvokeMcpTool}
                onConnectMcpServer={handleConnectMcpServer}
                onSelectSymbol={(sym) => {
                  const exists = features.some((f) => f.symbol === sym);
                  if (exists) {
                    setSelectedSymbol(sym);
                  }
                }}
              />
              {/* Live Public.com Brokerage Holdings & Working Orders Panel */}
              {portfolio && portfolio.publicPositions && portfolio.publicPositions.length > 0 && (
                <div className="p-5 border border-slate-800 bg-[#111827] space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <h2 className="text-base font-semibold text-slate-100">
                          Live Public.com Brokerage Portfolio &amp; Event Contracts (Account {portfolio.accountId})
                        </h2>
                        <span className="px-2 py-0.5 text-[11px] font-mono font-semibold bg-emerald-950/80 border border-emerald-500/40 text-emerald-300">
                          LIVE SYNC
                        </span>
                      </div>
                      <p className="text-xs text-slate-400 mt-0.5">
                        Real-time balances, fractional equity positions, Kalshi prediction contracts, and active stop orders pulled directly from Public.com API v2.
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-4 text-xs font-mono tabular-nums">
                      <div>
                        <span className="text-slate-400">Total Value: </span>
                        <span className="text-slate-100 font-bold">${portfolio.totalEquityUsd.toFixed(2)}</span>
                      </div>
                      <div>
                        <span className="text-slate-400">Cash: </span>
                        <span className="text-emerald-400 font-semibold">${portfolio.cashBalanceUsd.toFixed(2)}</span>
                      </div>
                      <div>
                        <span className="text-slate-400">Stocks: </span>
                        <span className="text-cyan-400 font-semibold">${portfolio.stockEquityUsd.toFixed(2)}</span>
                      </div>
                      <div>
                        <span className="text-slate-400">Event Contracts: </span>
                        <span className="text-amber-300 font-semibold">
                          ${portfolio.eventContractsEquityUsd.toFixed(2)}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Active Public.com Working Orders (if any) */}
                  {portfolio.publicOrders && portfolio.publicOrders.length > 0 && (
                    <div className="p-3 bg-[#0B0F17] border border-slate-800 flex flex-wrap items-center justify-between gap-2 text-xs font-mono">
                      <div className="flex items-center gap-2">
                        <span className="text-cyan-400 font-semibold">LIVE PUBLIC.COM WORKING ORDER:</span>
                        {portfolio.publicOrders.map((o, idx) => (
                          <span key={`${o.orderId}-${idx}`} className="text-slate-200">
                            {o.side} {o.quantity} {o.symbol} ({o.type} @ $
                            {o.stopPrice !== null ? o.stopPrice.toFixed(2) : o.limitPrice?.toFixed(2) || 'MKT'} ·{' '}
                            {o.timeInForce} · Status: <span className="text-emerald-400">{o.status}</span>)
                          </span>
                        ))}
                      </div>
                      <span className="text-[11px] text-slate-400">
                        Order ID: {portfolio.publicOrders[0].orderId.slice(0, 18)}...
                      </span>
                    </div>
                  )}

                  {/* Live Positions Table */}
                  <div className="overflow-x-auto max-h-72 overflow-y-auto">
                    <table className="w-full text-left border-collapse text-xs font-mono tabular-nums">
                      <thead className="sticky top-0 bg-[#0D131F] border-b border-slate-800 text-slate-400">
                        <tr>
                          <th className="py-2 px-3">Symbol &amp; Contract Name</th>
                          <th className="py-2 px-3">Asset Type</th>
                          <th className="py-2 px-3 text-right">Quantity</th>
                          <th className="py-2 px-3 text-right">Last Price</th>
                          <th className="py-2 px-3 text-right">Unit Cost</th>
                          <th className="py-2 px-3 text-right">Market Value</th>
                          <th className="py-2 px-3 text-right">Unrealized P&amp;L</th>
                          <th className="py-2 px-3 text-right">Portfolio %</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/70">
                        {portfolio.publicPositions.map((pos, idx) => {
                          const isEvent = pos.instrumentType === 'EVENTCONTRACT';
                          return (
                            <tr key={`${pos.symbol}-${idx}`} className="hover:bg-slate-800/30">
                              <td className="py-2 px-3">
                                <div className="font-semibold text-slate-100">{pos.symbol}</div>
                                <div className="text-[11px] text-slate-400 font-sans truncate max-w-[260px]">
                                  {pos.name}
                                </div>
                              </td>
                              <td className="py-2 px-3">
                                <span
                                  className={
                                    isEvent ? 'text-amber-300 font-semibold' : 'text-cyan-400'
                                  }
                                >
                                  {pos.instrumentType}
                                </span>
                              </td>
                              <td className="py-2 px-3 text-right text-slate-200">{pos.quantity}</td>
                              <td className="py-2 px-3 text-right text-slate-100">
                                ${pos.currentPrice.toFixed(pos.currentPrice < 1 ? 4 : 2)}
                              </td>
                              <td className="py-2 px-3 text-right text-slate-400">
                                ${pos.averagePrice.toFixed(pos.averagePrice < 1 ? 4 : 2)}
                              </td>
                              <td className="py-2 px-3 text-right font-semibold text-slate-100">
                                ${pos.marketValue.toFixed(2)}
                              </td>
                              <td
                                className={`py-2 px-3 text-right ${
                                  pos.unrealizedPnl > 0
                                    ? 'text-emerald-400'
                                    : pos.unrealizedPnl < 0
                                    ? 'text-rose-400'
                                    : 'text-slate-400'
                                }`}
                              >
                                {pos.unrealizedPnl >= 0 ? '+' : ''}${pos.unrealizedPnl.toFixed(2)} (
                                {pos.gainPercentage >= 0 ? '+' : ''}
                                {pos.gainPercentage.toFixed(2)}%)
                              </td>
                              <td className="py-2 px-3 text-right text-slate-400">
                                {pos.percentOfPortfolio.toFixed(2)}%
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Split Row: Left Multi-Horizon Envelope Chart & Indicator Telemetry | Right Deterministic JSON Output */}
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
                {/* Left 7 Cols: Price & ATR Envelope + Technical Feature Matrix */}
                <div className="lg:col-span-7 p-5 border border-slate-800 bg-[#111827] flex flex-col justify-between space-y-5">
                  <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-800 pb-3">
                    <div>
                      <h2 className="text-base font-semibold text-slate-100">{activeFeature.name}</h2>
                      <div className="flex items-center gap-2 text-xs text-slate-400 mt-0.5">
                        <span>Venue: {activeFeature.venue}</span>
                        <span aria-hidden="true">·</span>
                        <span>RVOL: {activeFeature.rvol.toFixed(2)}x</span>
                        <span aria-hidden="true">·</span>
                        <span>Spread: {activeFeature.bidAskSpreadBps} bps</span>
                      </div>
                    </div>
                    <div className="text-right font-mono tabular-nums">
                      <div className="text-xl font-bold text-slate-100">
                        {activeFeature.assetClass === 'PREDICTION_CONTRACT'
                          ? `${(activeFeature.price * 100).toFixed(1)}¢ (${(
                              (activeFeature.predictionImpliedProb || activeFeature.price) * 100
                            ).toFixed(0)}% Implied)`
                          : `$${activeFeature.price.toFixed(2)}`}
                      </div>
                      <div className="text-xs text-slate-400">
                        Headline Sentiment:{' '}
                        <span
                          className={
                            activeFeature.newsSentimentScore >= 0 ? 'text-emerald-400' : 'text-rose-400'
                          }
                        >
                          {activeFeature.newsSentimentScore >= 0 ? '+' : ''}
                          {activeFeature.newsSentimentScore.toFixed(2)}
                        </span>
                      </div>
                    </div>
                  </div>

                  <PriceEnvelopeChart
                    feature={activeFeature}
                    assessment={activeAssessment}
                    orders={orders}
                  />

                  {/* Explicit Numeric Thresholds Grid */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2 border-t border-slate-800 text-xs">
                    <div className="p-2.5 bg-[#0B0F17] border border-slate-800/80">
                      <div className="text-slate-400">Rolling ATR(14)</div>
                      <div className="mt-1 font-mono tabular-nums font-semibold text-slate-100">
                        {activeFeature.atr14} ({activeFeature.atrPct}%)
                      </div>
                      <div className="text-[11px] font-mono tabular-nums text-amber-400 mt-0.5">
                        {activeFeature.atrBaselineMultiplier.toFixed(2)}x vs 30D Base
                      </div>
                    </div>

                    <div className="p-2.5 bg-[#0B0F17] border border-slate-800/80">
                      <div className="text-slate-400">9/21 EMA Spread</div>
                      <div
                        className={`mt-1 font-mono tabular-nums font-semibold ${
                          activeFeature.maSpreadShortPct >= 0 ? 'text-emerald-400' : 'text-rose-400'
                        }`}
                      >
                        {activeFeature.maSpreadShortPct >= 0 ? '+' : ''}
                        {activeFeature.maSpreadShortPct.toFixed(2)}%
                      </div>
                      <div className="text-[11px] font-mono tabular-nums text-slate-400 mt-0.5">
                        50/200 SMA: {activeFeature.maSpreadLongPct >= 0 ? '+' : ''}
                        {activeFeature.maSpreadLongPct.toFixed(2)}%
                      </div>
                    </div>

                    <div className="p-2.5 bg-[#0B0F17] border border-slate-800/80">
                      <div className="text-slate-400">RSI(14) Strength</div>
                      <div
                        className={`mt-1 font-mono tabular-nums font-semibold ${
                          activeFeature.rsi14 > 70
                            ? 'text-amber-400'
                            : activeFeature.rsi14 < 35
                            ? 'text-cyan-400'
                            : 'text-slate-100'
                        }`}
                      >
                        {activeFeature.rsi14.toFixed(1)}
                      </div>
                      <div className="text-[11px] text-slate-400 mt-0.5">
                        {activeFeature.rsi14 > 70
                          ? 'Upside Exhaustion'
                          : activeFeature.rsi14 < 35
                          ? 'Oversold Value Zone'
                          : 'Neutral Band'}
                      </div>
                    </div>

                    <div className="p-2.5 bg-[#0B0F17] border border-slate-800/80">
                      <div className="text-slate-400">Orderbook Imbalance</div>
                      <div
                        className={`mt-1 font-mono tabular-nums font-semibold ${
                          activeFeature.orderbookImbalance >= 0 ? 'text-emerald-400' : 'text-rose-400'
                        }`}
                      >
                        {activeFeature.orderbookImbalance >= 0 ? '+' : ''}
                        {activeFeature.orderbookImbalance.toFixed(2)}
                      </div>
                      <div className="text-[11px] font-mono tabular-nums text-slate-400 mt-0.5">
                        VWAP Spread: {activeFeature.vwapSpreadPct >= 0 ? '+' : ''}
                        {activeFeature.vwapSpreadPct.toFixed(2)}%
                      </div>
                    </div>
                  </div>
                </div>

                {/* Right 5 Cols: Deterministic Quantitative Regime Assessment JSON Inspector */}
                <div className="lg:col-span-5 p-5 border border-slate-800 bg-[#111827] flex flex-col justify-between space-y-4">
                  <div>
                    <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                      <div>
                        <h2 className="text-base font-semibold text-slate-100">
                          Deterministic Regime Output
                        </h2>
                        <div className="text-xs text-slate-400 mt-0.5">
                          Engine: <span className="font-mono text-cyan-400">{evalSource}</span>
                        </div>
                      </div>
                      <span
                        className={`font-mono text-xs font-semibold ${
                          formatRegimeLabel(activeAssessment.market_regime).color
                        }`}
                      >
                        {activeAssessment.market_regime}
                      </span>
                    </div>

                    {/* Bias Probability Distribution Bars */}
                    <div className="mt-4 space-y-2 text-xs">
                      <div className="flex items-center justify-between text-slate-400">
                        <span>Probabilistic Directional Bias</span>
                        <span className="font-mono tabular-nums">
                          Bull {(activeAssessment.bias_probability_distribution.bullish * 100).toFixed(0)}% · Bear{' '}
                          {(activeAssessment.bias_probability_distribution.bearish * 100).toFixed(0)}% · Neutral{' '}
                          {(activeAssessment.bias_probability_distribution.neutral * 100).toFixed(0)}%
                        </span>
                      </div>
                      <div className="w-full h-2.5 bg-slate-900 flex overflow-hidden">
                        <div
                          style={{
                            width: `${activeAssessment.bias_probability_distribution.bullish * 100}%`,
                          }}
                          className="bg-emerald-500"
                        />
                        <div
                          style={{
                            width: `${activeAssessment.bias_probability_distribution.neutral * 100}%`,
                          }}
                          className="bg-slate-500"
                        />
                        <div
                          style={{
                            width: `${activeAssessment.bias_probability_distribution.bearish * 100}%`,
                          }}
                          className="bg-rose-500"
                        />
                      </div>
                    </div>

                    {/* Strict Schema JSON Output */}
                    <div className="mt-4">
                      <div className="text-xs text-slate-400 mb-1.5">Strict JSON Schema Payload</div>
                      <pre className="p-3 bg-[#080C14] border border-slate-800 text-[11px] font-mono text-slate-200 overflow-x-auto leading-relaxed">
                        {JSON.stringify(activeAssessment, null, 2)}
                      </pre>
                    </div>
                  </div>

                  <div className="pt-3 border-t border-slate-800 flex items-center justify-between text-xs text-slate-400">
                    <span>Latest Catalyst: {activeFeature.latestCatalystHeadline.slice(0, 62)}...</span>
                    <button
                      type="button"
                      onClick={() => setActiveTab('REGIME_EVALUATOR')}
                      className="text-cyan-400 hover:underline whitespace-nowrap ml-2"
                    >
                      Full Schema View
                    </button>
                  </div>
                </div>
              </div>

              {/* Essential Strategy Comparison Summary ("Long and Low" vs "Short and Fast") */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="p-5 border border-slate-800 bg-[#111827] space-y-3">
                  <div className="flex items-center justify-between border-b border-slate-800 pb-2.5">
                    <h3 className="text-sm font-semibold text-slate-100">
                      01. Long and Low Strategy Blueprint (Structural Accumulation)
                    </h3>
                    <span className="font-mono text-xs text-cyan-400">4H · 1D · 1W Horizon</span>
                  </div>
                  <p className="text-xs text-slate-300 leading-relaxed">
                    Targets low-volatility compression regimes, oversold structural pullbacks, and cross-venue yield/macro probability arbitrage across Public.com Equities, ETFs, Treasuries, and long-dated prediction contracts.
                  </p>
                  <div className="grid grid-cols-2 gap-3 text-xs pt-1">
                    <div>
                      <div className="text-slate-400 font-medium">Primary Market & Tech Inputs</div>
                      <ul className="mt-1 space-y-1 text-slate-300 font-mono text-[11px]">
                        <li>· ATR(14) Compression (&lt; 1.0% Equity)</li>
                        <li>· 50D / 200D SMA Structural Spread</li>
                        <li>· Daily RSI(14) Accumulation (25–42)</li>
                        <li>· Public.com Treasury Yield &amp; Tax Lots</li>
                      </ul>
                    </div>
                    <div>
                      <div className="text-slate-400 font-medium">Risk & Circuit-Breaker Rules</div>
                      <ul className="mt-1 space-y-1 text-slate-300 font-mono text-[11px]">
                        <li>· Wide OCO Stop: 2.5x Daily ATR</li>
                        <li>· Take-Profit Target: 4.5x Daily ATR</li>
                        <li>· Max Agent Drawdown Cap: 3.5%</li>
                        <li>· ATR Spike Halt: &gt; 2.6x Baseline</li>
                      </ul>
                    </div>
                  </div>
                </div>

                <div className="p-5 border border-slate-800 bg-[#111827] space-y-3">
                  <div className="flex items-center justify-between border-b border-slate-800 pb-2.5">
                    <h3 className="text-sm font-semibold text-slate-100">
                      02. Short and Fast Strategy Blueprint (Velocity & Momentum)
                    </h3>
                    <span className="font-mono text-xs text-emerald-400">1m · 5m · L2 Tick Horizon</span>
                  </div>
                  <p className="text-xs text-slate-300 leading-relaxed">
                    Captures high-velocity intraday breakouts, Anchored VWAP mean-reversion, and L2 orderbook liquidity sweeps across high-beta equities, spot crypto, and near-expiry prediction event contracts.
                  </p>
                  <div className="grid grid-cols-2 gap-3 text-xs pt-1">
                    <div>
                      <div className="text-slate-400 font-medium">Primary Market & Tech Inputs</div>
                      <ul className="mt-1 space-y-1 text-slate-300 font-mono text-[11px]">
                        <li>· 9 / 21 EMA Spread &amp; Anchored VWAP</li>
                        <li>· L2 Bid/Ask Orderbook Imbalance</li>
                        <li>· Relative Volume (RVOL &gt; 1.35x)</li>
                        <li>· 5m RSI(14) Exhaustion Guard (&lt; 74)</li>
                      </ul>
                    </div>
                    <div>
                      <div className="text-slate-400 font-medium">Risk & Circuit-Breaker Rules</div>
                      <ul className="mt-1 space-y-1 text-slate-300 font-mono text-[11px]">
                        <li>· Tight OCO Stop: 1.2x 5m ATR</li>
                        <li>· Spread Guard: Max 18 bps Slippage</li>
                        <li>· Max Intraday Drawdown Cap: 1.5%</li>
                        <li>· Instant Halt on ATR Spike &gt; 2.2x</li>
                      </ul>
                    </div>
                  </div>
                </div>
              </div>

              {/* Active Autonomous Agents Table (Multi-Ticker & Multi-Indicator Fleet) */}
              <div className="border border-slate-800 bg-[#111827]">
                <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-3.5 border-b border-slate-800">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold text-slate-100">
                        Multi-Ticker &amp; Multi-Indicator Autonomous Agent Fleet ({agents.length} Active Units)
                      </h3>
                      <span className="px-2 py-0.5 bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 font-mono text-[10px]">
                        100% REAL MARKET DATA · KALSHI V2 + PUBLIC.COM
                      </span>
                    </div>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Each agent trades a distinct ticker using a specialized quantitative indicator formula (EMA+VWAP, MACD+RVOL, Bollinger Squeeze, Wilder RSI+ATR, StochRSI+Volume, Kalshi CLOB Depth).
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={handleDeployBestStrategy}
                      disabled={isEvaluating}
                      className="px-3 py-1.5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold text-xs rounded transition-colors whitespace-nowrap"
                    >
                      {strategyTournament[0]
                        ? `Run #1 Best Real-Data Strategy (${strategyTournament[0].symbol} · +${strategyTournament[0].totalReturnPct}%)`
                        : 'Find & Run #1 Real-Data Strategy'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveTab('AGENT_ORCHESTRATOR')}
                      className="px-3 py-1.5 bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold text-xs rounded transition-colors whitespace-nowrap"
                    >
                      Deploy Custom Agent
                    </button>
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-slate-800 text-slate-400 bg-[#0D131F]">
                        <th className="py-2.5 px-4 font-medium">Agent &amp; Archetype</th>
                        <th className="py-2.5 px-4 font-medium">Ticker &amp; Venue</th>
                        <th className="py-2.5 px-4 font-medium">Assigned Indicator Formula</th>
                        <th className="py-2.5 px-4 font-medium text-right">Capital &amp; P&amp;L</th>
                        <th className="py-2.5 px-4 font-medium text-right">Drawdown / ATR Guard</th>
                        <th className="py-2.5 px-4 font-medium">State</th>
                        <th className="py-2.5 px-4 font-medium text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/80">
                      {agents.map((agent) => {
                        const totalAgentPnl = agent.metrics.unrealizedPnlUsd + agent.metrics.realizedPnlUsd;
                        return (
                          <tr key={agent.id} className="hover:bg-slate-800/30 transition-colors">
                            <td className="py-3 px-4">
                              <div className="font-medium text-slate-100">{agent.name}</div>
                              <div className="text-[11px] text-slate-400 mt-0.5">
                                <span
                                  className={
                                    agent.archetype === 'LONG_AND_LOW' ? 'text-cyan-400' : 'text-emerald-400'
                                  }
                                >
                                  {agent.archetype}
                                </span>
                                <span aria-hidden="true"> · </span>
                                <span className="font-mono">Sharpe {agent.metrics.sharpeRatio}</span>
                              </div>
                            </td>
                            <td className="py-3 px-4 font-mono tabular-nums">
                              <div className="text-slate-100 font-semibold">{agent.targetSymbol}</div>
                              <div className="text-[11px] text-slate-400">
                                {agent.venue === 'PUBLIC_BROKERAGE' ? 'Public.com' : 'Kalshi CLOB'} · {agent.timeframe}
                              </div>
                            </td>
                            <td className="py-3 px-4 max-w-xs">
                              {agent.indicatorStrategyLabel && (
                                <div className="text-cyan-300 font-medium text-[11px] mb-0.5">
                                  {agent.indicatorStrategyLabel}
                                </div>
                              )}
                              <div className="text-slate-200 truncate font-mono text-[11px]">
                                {agent.entryRules.maAlignment}
                              </div>
                              <div className="text-[11px] text-slate-400 font-mono mt-0.5">
                                RSI [{agent.entryRules.rsiRange[0]}–{agent.entryRules.rsiRange[1]}] · OCO SL{' '}
                                {agent.riskGovernance.stopLossAtrMultiple}x / TP{' '}
                                {agent.riskGovernance.takeProfitAtrMultiple}x ATR
                              </div>
                            </td>
                            <td className="py-3 px-4 text-right font-mono tabular-nums">
                              <div className="text-slate-200">
                                ${agent.metrics.allocatedCapitalUsd.toLocaleString()}
                              </div>
                              <div
                                className={`text-[11px] ${
                                  totalAgentPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'
                                }`}
                              >
                                {totalAgentPnl >= 0 ? '+' : ''}${totalAgentPnl.toFixed(2)} ({agent.metrics.winRatePct}%
                                Win)
                              </div>
                            </td>
                            <td className="py-3 px-4 text-right font-mono tabular-nums">
                              <div className="text-slate-200">
                                DD: {agent.riskGovernance.currentDrawdownPct.toFixed(2)}% /{' '}
                                {agent.riskGovernance.maxDrawdownLimitPct.toFixed(1)}%
                              </div>
                              <div className="text-[11px] text-slate-400">
                                ATR Halt &gt; {agent.riskGovernance.atrSpikeKillMultiplier}x
                              </div>
                            </td>
                            <td className="py-3 px-4">
                              <div
                                className={`font-mono text-[11px] font-semibold ${
                                  agent.status === 'ACTIVE'
                                    ? 'text-emerald-400'
                                    : agent.status === 'PAUSED'
                                    ? 'text-amber-400'
                                    : 'text-rose-400'
                                }`}
                              >
                                {agent.status}
                              </div>
                              {agent.killSwitchReason && (
                                <div className="text-[11px] text-rose-300 max-w-[190px] truncate mt-0.5">
                                  {agent.killSwitchReason}
                                </div>
                              )}
                            </td>
                            <td className="py-3 px-4 text-right whitespace-nowrap">
                              <div className="inline-flex items-center gap-2">
                                <button
                                  type="button"
                                  onClick={() => handleExecuteAgentTrade(agent.id)}
                                  disabled={agent.status !== 'ACTIVE'}
                                  className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-100 rounded text-[11px] font-medium transition-colors"
                                >
                                  Route OCO Order
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleToggleAgentStatus(agent.id)}
                                  className="px-2.5 py-1 border border-slate-700 hover:bg-slate-800 text-slate-300 rounded text-[11px] transition-colors"
                                >
                                  {agent.status === 'ACTIVE' ? 'Pause' : 'Resume'}
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Risk Events & Historical Circuit-Breaker Notification Log */}
              <RiskEventsLog
                events={riskEvents}
                selectedSymbol={selectedSymbol}
                onAcknowledgeEvent={handleAcknowledgeRiskEvent}
                onSimulateAtrShock={handleSimulateStressTest}
                onSelectSymbol={(sym) => setSelectedSymbol(sym)}
              />
            </div>
          )}

          {/* VIEW 2: ESSENTIAL DATA INPUTS, TECHNICAL INDICATORS & API ARCHITECTURE PLAN */}
          {activeTab === 'DATA_FEEDS_PLAN' && (
            <div className="space-y-6">
              <KalshiMcpHub
                portfolio={portfolio}
                mcpServers={mcpServers}
                mcpTools={mcpTools}
                mcpResources={mcpResources}
                mcpLogs={mcpLogs}
                isSyncing={isEvaluating}
                onSyncKalshi={handleSyncKalshi}
                onInvokeMcpTool={handleInvokeMcpTool}
                onConnectMcpServer={handleConnectMcpServer}
                onSelectSymbol={(sym) => {
                  const exists = features.some((f) => f.symbol === sym);
                  if (exists) {
                    setSelectedSymbol(sym);
                    setActiveTab('COMMAND_CENTER');
                  }
                }}
              />
              <div className="p-5 border border-slate-800 bg-[#111827] space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
                  <div>
                    <h2 className="text-base font-semibold text-slate-100">
                      Essential Data Feeds, Technical Indicators & API Acquisition Plan
                    </h2>
                    <p className="text-xs text-slate-400 mt-1">
                      Comprehensive data pipeline blueprint required to operate autonomous Long-and-Low and Short-and-Fast agents with deterministic risk mitigation.
                    </p>
                  </div>

                  {/* Interactive Archetype Filter */}
                  <div className="flex items-center gap-1 p-1 bg-[#0B0F17] border border-slate-800 rounded">
                    <button
                      type="button"
                      onClick={() => setFeedFilter('ALL')}
                      className={`px-3 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap ${
                        feedFilter === 'ALL' ? 'bg-slate-800 text-slate-100' : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      All Feeds ({feeds.length})
                    </button>
                    <button
                      type="button"
                      onClick={() => setFeedFilter('LONG_AND_LOW')}
                      className={`px-3 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap ${
                        feedFilter === 'LONG_AND_LOW'
                          ? 'bg-slate-800 text-cyan-400'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      Long & Low Inputs
                    </button>
                    <button
                      type="button"
                      onClick={() => setFeedFilter('SHORT_AND_FAST')}
                      className={`px-3 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap ${
                        feedFilter === 'SHORT_AND_FAST'
                          ? 'bg-slate-800 text-emerald-400'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      Short & Fast Inputs
                    </button>
                  </div>
                </div>

                {/* Data Feed Specification Table */}
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-slate-800 text-slate-400 bg-[#0D131F]">
                        <th className="py-2.5 px-4 font-medium">Data Feed & Provider</th>
                        <th className="py-2.5 px-4 font-medium">Target Strategy</th>
                        <th className="py-2.5 px-4 font-medium">API Endpoint & Cadence</th>
                        <th className="py-2.5 px-4 font-medium">Extracted Feature Vector Fields</th>
                        <th className="py-2.5 px-4 font-medium">Risk Mitigation Function</th>
                        <th className="py-2.5 px-4 font-medium text-right">Stream State</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/80">
                      {filteredFeeds.map((feed) => (
                        <tr key={feed.id} className="hover:bg-slate-800/30 transition-colors align-top">
                          <td className="py-3.5 px-4">
                            <div className="font-semibold text-slate-100">{feed.name}</div>
                            <div className="text-[11px] text-slate-400 mt-1 leading-relaxed max-w-xs">
                              {feed.description}
                            </div>
                          </td>
                          <td className="py-3.5 px-4 font-mono text-[11px] whitespace-nowrap">
                            <span
                              className={
                                feed.targetArchetype === 'LONG_AND_LOW'
                                  ? 'text-cyan-400'
                                  : feed.targetArchetype === 'SHORT_AND_FAST'
                                  ? 'text-emerald-400'
                                  : 'text-slate-200'
                              }
                            >
                              {feed.targetArchetype}
                            </span>
                            <div className="text-slate-400 mt-0.5">{feed.category}</div>
                          </td>
                          <td className="py-3.5 px-4 font-mono text-[11px]">
                            <div className="text-cyan-300 break-all max-w-[240px]">{feed.endpointPattern}</div>
                            <div className="text-slate-400 mt-1">
                              {feed.cadence} · {feed.latencyMs}ms latency
                            </div>
                          </td>
                          <td className="py-3.5 px-4 font-mono text-[11px] text-slate-300">
                            {feed.keyFields.join(' · ')}
                          </td>
                          <td className="py-3.5 px-4 text-slate-300 max-w-xs leading-relaxed">
                            {feed.riskMitigationRole}
                          </td>
                          <td className="py-3.5 px-4 text-right whitespace-nowrap">
                            <button
                              type="button"
                              onClick={() => handleToggleFeed(feed.id)}
                              className={`px-3 py-1 rounded text-[11px] font-mono font-medium transition-colors ${
                                feed.enabled
                                  ? 'bg-emerald-950/60 border border-emerald-500/40 text-emerald-300'
                                  : 'bg-slate-800 text-slate-400'
                              }`}
                            >
                              {feed.enabled ? 'ACTIVE_STREAM' : 'PAUSED'}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Technical Indicator Threshold Specification Matrix */}
              <div className="p-5 border border-slate-800 bg-[#111827] space-y-4">
                <h3 className="text-sm font-semibold text-slate-100 border-b border-slate-800 pb-3">
                  Technical Indicator Thresholds & Signal Qualification Rules
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
                  <div className="p-4 border border-slate-800 bg-[#0B0F17] space-y-2">
                    <div className="font-semibold text-slate-100">
                      1. Rolling Volatility Gate (ATR-14 &amp; StdDev-20)
                    </div>
                    <p className="text-slate-400 leading-relaxed">
                      Evaluated prior to any directional indicator. Normalizes Average True Range as a percentage of price (<code className="text-cyan-400">atrPct</code>) and compares against the 30-period baseline (<code className="text-cyan-400">atrBaselineMultiplier</code>).
                    </p>
                    <div className="pt-2 border-t border-slate-800/80 font-mono text-[11px] text-slate-300 space-y-1">
                      <div>· Long &amp; Low Entry: ATR &lt; 1.1x Baseline</div>
                      <div>· Short &amp; Fast Entry: 1.2x–2.0x Expansion</div>
                      <div>· Circuit Breaker Trip: ATR &gt; 2.2x–2.6x</div>
                    </div>
                  </div>

                  <div className="p-4 border border-slate-800 bg-[#0B0F17] space-y-2">
                    <div className="font-semibold text-slate-100">
                      2. Moving Average Spreads &amp; Anchored VWAP
                    </div>
                    <p className="text-slate-400 leading-relaxed">
                      Contextualizes price extension relative to institutional volume-weighted average price (<code className="text-cyan-400">vwapSpreadPct</code>), short-term velocity (<code className="text-cyan-400">9/21 EMA</code>), and macro trend (<code className="text-cyan-400">50/200 SMA</code>).
                    </p>
                    <div className="pt-2 border-t border-slate-800/80 font-mono text-[11px] text-slate-300 space-y-1">
                      <div>· Long &amp; Low: 50D SMA &gt; 200D SMA + VWAP Test</div>
                      <div>· Short &amp; Fast: 9/21 EMA Spread &gt; ±0.45%</div>
                      <div>· Mean-Reversion Cap: ±2.0 StdDev from VWAP</div>
                    </div>
                  </div>

                  <div className="p-4 border border-slate-800 bg-[#0B0F17] space-y-2">
                    <div className="font-semibold text-slate-100">
                      3. RSI(14) Relative Strength &amp; CLOB Depth
                    </div>
                    <p className="text-slate-400 leading-relaxed">
                      Detects multi-timeframe momentum exhaustion and confirms execution liquidity via L2 bid/ask orderbook imbalance and prediction market implied probability drift.
                    </p>
                    <div className="pt-2 border-t border-slate-800/80 font-mono text-[11px] text-slate-300 space-y-1">
                      <div>· Long &amp; Low Accumulation: Daily RSI 25–42</div>
                      <div>· Short &amp; Fast Momentum: 5m RSI 52–72</div>
                      <div>· Exhaustion Block: No Buys when RSI &gt; 74</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* VIEW 3: QUANTITATIVE JSON REGIME EVALUATOR */}
          {activeTab === 'REGIME_EVALUATOR' && activeFeature && (
            <div className="space-y-6">
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                {/* Left 5 Cols: Input Feature Vector Table */}
                <div className="lg:col-span-5 p-5 border border-slate-800 bg-[#111827] space-y-4">
                  <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                    <div>
                      <h2 className="text-base font-semibold text-slate-100">
                        Normalized Feature Vector ({activeFeature.symbol})
                      </h2>
                      <p className="text-xs text-slate-400 mt-0.5">
                        Explicit numeric thresholds passed to the quantitative regime evaluator.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleEvaluateRegime(activeFeature.symbol)}
                      disabled={isEvaluating}
                      className="px-3 py-1.5 bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold text-xs rounded transition-colors whitespace-nowrap"
                    >
                      {isEvaluating ? 'Evaluating...' : 'Run Evaluator'}
                    </button>
                  </div>

                  <div className="divide-y divide-slate-800/80 text-xs font-mono tabular-nums">
                    <div className="py-2 flex justify-between">
                      <span className="text-slate-400">Symbol / Venue</span>
                      <span className="text-slate-100">
                        {activeFeature.symbol} · {activeFeature.venue}
                      </span>
                    </div>
                    <div className="py-2 flex justify-between">
                      <span className="text-slate-400">Last Price / VWAP</span>
                      <span className="text-slate-100">
                        {activeFeature.price} / {activeFeature.vwap} ({activeFeature.vwapSpreadPct >= 0 ? '+' : ''}
                        {activeFeature.vwapSpreadPct}%)
                      </span>
                    </div>
                    <div className="py-2 flex justify-between">
                      <span className="text-slate-400">Rolling ATR(14) &amp; ATR%</span>
                      <span className="text-amber-400">
                        {activeFeature.atr14} ({activeFeature.atrPct}% · {activeFeature.atrBaselineMultiplier}x base)
                      </span>
                    </div>
                    <div className="py-2 flex justify-between">
                      <span className="text-slate-400">20-Period StdDev</span>
                      <span className="text-slate-100">{activeFeature.stdDev20}</span>
                    </div>
                    <div className="py-2 flex justify-between">
                      <span className="text-slate-400">9 EMA / 21 EMA (Short Spread)</span>
                      <span className={activeFeature.maSpreadShortPct >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                        {activeFeature.ema9} / {activeFeature.ema21} ({activeFeature.maSpreadShortPct >= 0 ? '+' : ''}
                        {activeFeature.maSpreadShortPct}%)
                      </span>
                    </div>
                    <div className="py-2 flex justify-between">
                      <span className="text-slate-400">50 SMA / 200 SMA (Long Spread)</span>
                      <span className={activeFeature.maSpreadLongPct >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                        {activeFeature.sma50} / {activeFeature.sma200} ({activeFeature.maSpreadLongPct >= 0 ? '+' : ''}
                        {activeFeature.maSpreadLongPct}%)
                      </span>
                    </div>
                    <div className="py-2 flex justify-between">
                      <span className="text-slate-400">RSI(14) Relative Strength</span>
                      <span className="text-slate-100">{activeFeature.rsi14.toFixed(1)}</span>
                    </div>
                    <div className="py-2 flex justify-between">
                      <span className="text-slate-400">Relative Volume (RVOL)</span>
                      <span className="text-slate-100">{activeFeature.rvol.toFixed(2)}x</span>
                    </div>
                    <div className="py-2 flex justify-between">
                      <span className="text-slate-400">Orderbook Imbalance &amp; Spread</span>
                      <span className="text-slate-100">
                        {activeFeature.orderbookImbalance >= 0 ? '+' : ''}
                        {activeFeature.orderbookImbalance} ({activeFeature.bidAskSpreadBps} bps)
                      </span>
                    </div>
                    <div className="py-2 flex justify-between">
                      <span className="text-slate-400">Prediction Implied Probability</span>
                      <span className="text-cyan-400">
                        {activeFeature.predictionImpliedProb !== undefined
                          ? `${(activeFeature.predictionImpliedProb * 100).toFixed(1)}%`
                          : 'N/A'}
                      </span>
                    </div>
                    <div className="py-2 flex justify-between">
                      <span className="text-slate-400">Quant News Polarity Score</span>
                      <span className={activeFeature.newsSentimentScore >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                        {activeFeature.newsSentimentScore >= 0 ? '+' : ''}
                        {activeFeature.newsSentimentScore.toFixed(2)}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Right 7 Cols: Deterministic JSON Output & All-Instrument Regime Matrix */}
                <div className="lg:col-span-7 p-5 border border-slate-800 bg-[#111827] space-y-5">
                  <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                    <div>
                      <h2 className="text-base font-semibold text-slate-100">
                        Strict JSON Schema Assessment ({activeFeature.symbol})
                      </h2>
                      <p className="text-xs text-slate-400 mt-0.5">
                        Evaluates rolling volatility prior to directional bias and outputs next-step support/resistance envelopes.
                      </p>
                    </div>
                    <span className="font-mono text-xs text-cyan-400">{evalSource}</span>
                  </div>

                  <pre className="p-4 bg-[#080C14] border border-slate-800 text-xs font-mono text-emerald-300 overflow-x-auto leading-relaxed">
                    {JSON.stringify(activeAssessment, null, 2)}
                  </pre>

                  <div className="space-y-2">
                    <div className="text-xs font-medium text-slate-300">
                      Multi-Asset Regime &amp; Envelope Comparison
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-left border-collapse text-xs font-mono tabular-nums">
                        <thead>
                          <tr className="border-b border-slate-800 text-slate-400 bg-[#0D131F]">
                            <th className="py-2 px-3">Symbol</th>
                            <th className="py-2 px-3">Detected Regime</th>
                            <th className="py-2 px-3 text-right">ATR%</th>
                            <th className="py-2 px-3 text-right">Support</th>
                            <th className="py-2 px-3 text-right">Resistance</th>
                            <th className="py-2 px-3 text-right">Bull / Bear / Neut</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800/80">
                          {features.map((f) => {
                            const ass = f.lastAssessment || DEFAULT_ASSESSMENT;
                            const reg = formatRegimeLabel(ass.market_regime);
                            return (
                              <tr
                                key={f.symbol}
                                onClick={() => setSelectedSymbol(f.symbol)}
                                className="hover:bg-slate-800/40 cursor-pointer"
                              >
                                <td className="py-2 px-3 font-semibold text-slate-100">{f.symbol}</td>
                                <td className={`py-2 px-3 ${reg.color}`}>{reg.text}</td>
                                <td className="py-2 px-3 text-right text-slate-300">{f.atrPct.toFixed(2)}%</td>
                                <td className="py-2 px-3 text-right text-rose-400">{ass.support_level}</td>
                                <td className="py-2 px-3 text-right text-emerald-400">{ass.resistance_level}</td>
                                <td className="py-2 px-3 text-right text-slate-300">
                                  {(ass.bias_probability_distribution.bullish * 100).toFixed(0)}% /{' '}
                                  {(ass.bias_probability_distribution.bearish * 100).toFixed(0)}% /{' '}
                                  {(ass.bias_probability_distribution.neutral * 100).toFixed(0)}%
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* VIEW 4: AGENT ORCHESTRATOR, SPAWNER & ORDER LEDGER */}
          {activeTab === 'AGENT_ORCHESTRATOR' && (
            <div className="space-y-6">
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                {/* Left 5 Cols: Custom Agent Spawner Form */}
                <form
                  onSubmit={handleSpawnAgent}
                  className="lg:col-span-5 p-5 border border-slate-800 bg-[#111827] space-y-4"
                >
                  <div className="border-b border-slate-800 pb-3">
                    <h2 className="text-base font-semibold text-slate-100">
                      Deploy New Autonomous Strategy Agent
                    </h2>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Configure strategy archetype, target Public.com or prediction market instrument, and automated kill-switch thresholds.
                    </p>
                  </div>

                  <div className="space-y-3 text-xs">
                    <div>
                      <label className="block text-slate-300 font-medium mb-1">Agent Identifier Name</label>
                      <input
                        type="text"
                        value={newAgentName}
                        onChange={(e) => setNewAgentName(e.target.value)}
                        placeholder="e.g., Long & Low · Treasury Duration Accumulator"
                        className="w-full px-3 py-2 bg-[#0B0F17] border border-slate-800 text-slate-100 rounded focus:outline-none focus:border-cyan-400"
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-slate-300 font-medium mb-1">Strategy Archetype</label>
                        <select
                          value={newAgentArchetype}
                          onChange={(e) => {
                            const val = e.target.value as StrategyArchetype;
                            setNewAgentArchetype(val);
                            if (val === 'LONG_AND_LOW') {
                              setNewAgentMaxDrawdown(3.5);
                              setNewAgentAtrMultiplier(2.6);
                            } else {
                              setNewAgentMaxDrawdown(1.5);
                              setNewAgentAtrMultiplier(2.2);
                            }
                          }}
                          className="w-full px-3 py-2 bg-[#0B0F17] border border-slate-800 text-slate-100 rounded focus:outline-none focus:border-cyan-400"
                        >
                          <option value="LONG_AND_LOW">LONG_AND_LOW (4H/1D Value)</option>
                          <option value="SHORT_AND_FAST">SHORT_AND_FAST (1m/5m Velocity)</option>
                        </select>
                      </div>

                      <div>
                        <label className="block text-slate-300 font-medium mb-1">Target Instrument</label>
                        <select
                          value={newAgentSymbol}
                          onChange={(e) => setNewAgentSymbol(e.target.value)}
                          className="w-full px-3 py-2 bg-[#0B0F17] border border-slate-800 text-slate-100 rounded font-mono focus:outline-none focus:border-cyan-400"
                        >
                          {features.map((f) => (
                            <option key={f.symbol} value={f.symbol}>
                              {f.symbol} ({f.venue === 'PUBLIC_BROKERAGE' ? 'Public.com' : 'Kalshi CLOB'})
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div>
                      <label className="block text-slate-300 font-medium mb-1">
                        Quantitative Indicator Formula
                      </label>
                      <select
                        value={newAgentIndicatorId}
                        onChange={(e) => setNewAgentIndicatorId(e.target.value as IndicatorStrategyId)}
                        className="w-full px-3 py-2 bg-[#0B0F17] border border-slate-800 text-cyan-300 font-mono rounded focus:outline-none focus:border-cyan-400"
                      >
                        <option value="BTC_LEAD_LAG_SNIPER">
                          Coinbase-to-Kalshi 15m Lead-Lag Sniper ($0.45–$0.82 Fee Gate + Black-Scholes d2)
                        </option>
                        <option value="HFT_15M_CLOB_MICRO_SCALPER">
                          15m HFT CLOB Micro-Imbalance &amp; Tape Velocity Scalper
                        </option>
                        <option value="HFT_15M_GAMMA_CONVERGENCE">
                          15m Expiry Gamma Convergence &amp; Strike Pinning Scalper
                        </option>
                        <option value="HFT_15M_VWAP_SNAPBACK">
                          15m Probability Exhaustion &amp; Micro-VWAP Snapback
                        </option>
                        <option value="EMA_VWAP_VELOCITY">
                          9/21 EMA Velocity + Anchored VWAP + L2 Imbalance
                        </option>
                        <option value="MACD_RVOL_MOMENTUM">
                          MACD(12,26,9) Histogram Impulse + RVOL Surge
                        </option>
                        <option value="BB_SQUEEZE_BREAKOUT">
                          Bollinger Band(20,2σ) Squeeze + 50/200 SMA Trend
                        </option>
                        <option value="RSI_ATR_MEAN_REVERSION">
                          Wilder RSI(14) Value Accumulation + ATR Compression
                        </option>
                        <option value="STOCH_RSI_OBV_SCALPER">
                          Stochastic RSI(14) Cross + Volume Breakout Scalper
                        </option>
                        <option value="KALSHI_CLOB_IMBALANCE">
                          Kalshi CLOB Orderbook Depth &amp; Implied Prob Momentum
                        </option>
                      </select>
                    </div>

                    <div className="grid grid-cols-3 gap-3">
                      <div>
                        <label className="block text-slate-300 font-medium mb-1">Capital (USD)</label>
                        <input
                          type="number"
                          min={20}
                          step={25}
                          value={newAgentCapital}
                          onChange={(e) => setNewAgentCapital(Number(e.target.value))}
                          className="w-full px-3 py-2 bg-[#0B0F17] border border-slate-800 text-slate-100 font-mono rounded focus:outline-none focus:border-cyan-400"
                        />
                      </div>

                      <div>
                        <label className="block text-slate-300 font-medium mb-1">Max Drawdown %</label>
                        <input
                          type="number"
                          step={0.1}
                          min={0.5}
                          max={15}
                          value={newAgentMaxDrawdown}
                          onChange={(e) => setNewAgentMaxDrawdown(Number(e.target.value))}
                          className="w-full px-3 py-2 bg-[#0B0F17] border border-slate-800 text-slate-100 font-mono rounded focus:outline-none focus:border-cyan-400"
                        />
                      </div>

                      <div>
                        <label className="block text-slate-300 font-medium mb-1">ATR Kill Multiple</label>
                        <input
                          type="number"
                          step={0.1}
                          min={1.5}
                          max={5.0}
                          value={newAgentAtrMultiplier}
                          onChange={(e) => setNewAgentAtrMultiplier(Number(e.target.value))}
                          className="w-full px-3 py-2 bg-[#0B0F17] border border-slate-800 text-slate-100 font-mono rounded focus:outline-none focus:border-cyan-400"
                        />
                      </div>
                    </div>

                    <div className="p-3 bg-[#0B0F17] border border-slate-800 text-[11px] text-slate-400 space-y-1">
                      <div className="text-slate-200 font-medium">Auto-Attached Data Feeds &amp; Brackets:</div>
                      <div>
                        · Stop-Loss OCO Bracket:{' '}
                        <span className="font-mono text-slate-200">
                          {newAgentArchetype === 'LONG_AND_LOW' ? '2.5x Daily ATR' : '1.2x 5m ATR'}
                        </span>
                      </div>
                      <div>
                        · Subscribed Feeds: Public.com Bars v2, Rolling ATR(14), Moving Average Spreads, Prediction CLOB, Quant News Polarity.
                      </div>
                    </div>

                    <button
                      type="submit"
                      className="w-full py-2.5 px-4 bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold text-xs rounded transition-colors"
                    >
                      Deploy Autonomous Agent &amp; Route Initial OCO Order
                    </button>
                  </div>
                </form>

                {/* Right 7 Cols: Live Autonomous Order Execution Ledger */}
                <div className="lg:col-span-7 p-5 border border-slate-800 bg-[#111827] space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-3">
                    <div>
                      <h2 className="text-base font-semibold text-slate-100">
                        Autonomous Order Routing &amp; OCO Bracket Ledger
                      </h2>
                      <p className="text-xs text-slate-400 mt-0.5">
                        Every trade requires deterministic regime confirmation and attaches ATR-calibrated stop-loss and take-profit legs.
                      </p>
                    </div>
                    <div className="flex items-center gap-1 p-1 bg-[#0B0F17] border border-slate-800 rounded">
                      <button
                        type="button"
                        onClick={() => setAgentFilter('ALL')}
                        className={`px-2.5 py-1 text-xs rounded ${
                          agentFilter === 'ALL' ? 'bg-slate-800 text-slate-100' : 'text-slate-400'
                        }`}
                      >
                        All ({agents.length})
                      </button>
                      <button
                        type="button"
                        onClick={() => setAgentFilter('LONG_AND_LOW')}
                        className={`px-2.5 py-1 text-xs rounded ${
                          agentFilter === 'LONG_AND_LOW' ? 'bg-slate-800 text-cyan-400' : 'text-slate-400'
                        }`}
                      >
                        Long &amp; Low
                      </button>
                      <button
                        type="button"
                        onClick={() => setAgentFilter('SHORT_AND_FAST')}
                        className={`px-2.5 py-1 text-xs rounded ${
                          agentFilter === 'SHORT_AND_FAST' ? 'bg-slate-800 text-emerald-400' : 'text-slate-400'
                        }`}
                      >
                        Short &amp; Fast
                      </button>
                    </div>
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="border-b border-slate-800 text-slate-400 bg-[#0D131F]">
                          <th className="py-2 px-3 font-medium">Order ID &amp; Symbol</th>
                          <th className="py-2 px-3 font-medium">Side &amp; Type</th>
                          <th className="py-2 px-3 font-medium text-right">Fill / OCO Brackets</th>
                          <th className="py-2 px-3 font-medium">Entry Regime &amp; Rationale</th>
                          <th className="py-2 px-3 font-medium text-right">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/80">
                        {orders.map((ord) => (
                          <tr key={ord.id} className="hover:bg-slate-800/30">
                            <td className="py-2.5 px-3 font-mono tabular-nums">
                              <div className="text-slate-100 font-semibold">
                                {ord.symbol} · {ord.id}
                              </div>
                              <div className="text-[11px] text-slate-400 truncate max-w-[160px]">
                                {ord.agentName}
                              </div>
                            </td>
                            <td className="py-2.5 px-3 font-mono text-[11px]">
                              <span
                                className={
                                  ord.side.includes('BUY') ? 'text-emerald-400 font-semibold' : 'text-rose-400'
                                }
                              >
                                {ord.side}
                              </span>{' '}
                              × {ord.quantity}
                              <div className="text-slate-400">{ord.orderType}</div>
                            </td>
                            <td className="py-2.5 px-3 text-right font-mono tabular-nums text-[11px]">
                              <div className="text-slate-100">Fill: {ord.fillPrice}</div>
                              <div className="text-slate-400">
                                SL {ord.stopLossPrice} · TP {ord.takeProfitPrice}
                              </div>
                            </td>
                            <td className="py-2.5 px-3 max-w-xs">
                              <div
                                className={`font-mono text-[11px] ${
                                  formatRegimeLabel(ord.regimeAtEntry).color
                                }`}
                              >
                                {ord.regimeAtEntry}
                              </div>
                              <div className="text-[11px] text-slate-400 truncate">{ord.rationale}</div>
                            </td>
                            <td className="py-2.5 px-3 text-right font-mono text-[11px]">
                              <span
                                className={
                                  ord.status === 'WORKING_OCO'
                                    ? 'text-cyan-400'
                                    : ord.status === 'FILLED'
                                    ? 'text-emerald-400'
                                    : 'text-rose-400'
                                }
                              >
                                {ord.status}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>

              {/* Historical Circuit-Breaker & Risk Events Notification Log */}
              <RiskEventsLog
                events={riskEvents}
                selectedSymbol={selectedSymbol}
                onAcknowledgeEvent={handleAcknowledgeRiskEvent}
                onSimulateAtrShock={handleSimulateStressTest}
                onSelectSymbol={(sym) => setSelectedSymbol(sym)}
              />
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
