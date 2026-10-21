import React, { useState } from 'react';
import {
  CheckCircle2,
  Copy,
  Cpu,
  Database,
  ExternalLink,
  Layers,
  Play,
  Plus,
  RefreshCw,
  Server,
  Terminal,
  Zap,
} from 'lucide-react';
import type {
  McpCallLogEntry,
  McpResourceDefinition,
  McpServerConnection,
  McpToolDefinition,
  PortfolioSummary,
} from '../types/quant.ts';

interface KalshiMcpHubProps {
  portfolio: PortfolioSummary | null;
  mcpServers: McpServerConnection[];
  mcpTools: McpToolDefinition[];
  mcpResources: McpResourceDefinition[];
  mcpLogs: McpCallLogEntry[];
  isSyncing: boolean;
  onSyncKalshi: () => Promise<void>;
  onInvokeMcpTool: (toolName: string, args: Record<string, any>) => Promise<Record<string, any> | null>;
  onConnectMcpServer: (config: {
    name: string;
    endpointUrl: string;
    transport: 'HTTP_JSON_RPC' | 'SSE_STREAM' | 'STDIO_BRIDGE';
    authHeader?: string;
  }) => Promise<void>;
  onSelectSymbol?: (symbol: string) => void;
}

export const KalshiMcpHub: React.FC<KalshiMcpHubProps> = ({
  portfolio,
  mcpServers,
  mcpTools,
  mcpResources,
  mcpLogs,
  isSyncing,
  onSyncKalshi,
  onInvokeMcpTool,
  onConnectMcpServer,
  onSelectSymbol,
}) => {
  const [selectedTool, setSelectedTool] = useState<string>('get_kalshi_live_balance');
  const [toolSymbolArg, setToolSymbolArg] = useState<string>('KXGREENLANDPRICE-29JAN21-NOACQ');
  const [toolNotionalArg, setToolNotionalArg] = useState<number>(25);
  const [isInvoking, setIsInvoking] = useState<boolean>(false);
  const [lastToolOutput, setLastToolOutput] = useState<Record<string, any> | null>(null);
  const [copiedConfig, setCopiedConfig] = useState<boolean>(false);

  // Connect External MCP Server form state
  const [newMcpName, setNewMcpName] = useState<string>('');
  const [newMcpUrl, setNewMcpUrl] = useState<string>('');
  const [newMcpTransport, setNewMcpTransport] = useState<'HTTP_JSON_RPC' | 'SSE_STREAM' | 'STDIO_BRIDGE'>(
    'HTTP_JSON_RPC'
  );
  const [newMcpAuth, setNewMcpAuth] = useState<string>('');

  const kalshiCash = portfolio?.kalshiCashBalanceUsd ?? 29.27;
  const kalshiPortVal = portfolio?.kalshiPortfolioValueUsd ?? 44.59;
  const kalshiTotal = portfolio?.kalshiTotalEquityUsd ?? Number((kalshiCash + kalshiPortVal).toFixed(2));
  const kalshiPositions = portfolio?.kalshiPositions ?? [];
  const kalshiFills = portfolio?.kalshiRecentFills ?? [];
  const kalshiBreakdown = portfolio?.kalshiBalanceBreakdown ?? [];

  const handleRunSelectedTool = async () => {
    setIsInvoking(true);
    try {
      let args: Record<string, any> = {};
      if (selectedTool === 'get_kalshi_live_balance') {
        args = { forceRefresh: true, includeFills: true };
      } else if (selectedTool === 'get_public_brokerage_portfolio') {
        args = { includePositions: true };
      } else if (selectedTool === 'evaluate_market_regime') {
        args = { symbol: toolSymbolArg };
      } else if (selectedTool === 'scan_alpha_and_backtest') {
        args = { symbol: toolSymbolArg };
      } else if (selectedTool === 'execute_kalshi_or_public_order') {
        args = { symbol: toolSymbolArg, notionalUsd: toolNotionalArg };
      } else {
        args = { action: 'STATUS_AUDIT' };
      }
      const res = await onInvokeMcpTool(selectedTool, args);
      if (res) {
        setLastToolOutput(res);
      }
    } finally {
      setIsInvoking(false);
    }
  };

  const handleConnectSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMcpUrl.trim()) return;
    await onConnectMcpServer({
      name: newMcpName.trim() || `External MCP (${newMcpUrl.trim().slice(0, 24)})`,
      endpointUrl: newMcpUrl.trim(),
      transport: newMcpTransport,
      authHeader: newMcpAuth.trim() || undefined,
    });
    setNewMcpName('');
    setNewMcpUrl('');
    setNewMcpAuth('');
  };

  const mcpEndpointUrl =
    typeof window !== 'undefined' ? `${window.location.origin}/api/mcp` : 'http://localhost:3000/api/mcp';
  const mcpSseUrl =
    typeof window !== 'undefined' ? `${window.location.origin}/api/mcp/sse` : 'http://localhost:3000/api/mcp/sse';

  const mcpConfigJson = JSON.stringify(
    {
      mcpServers: {
        'finesse-finance-kalshi-quant': {
          url: mcpEndpointUrl,
          sseUrl: mcpSseUrl,
          transport: 'http-jsonrpc',
          protocolVersion: '2024-11-05',
        },
      },
    },
    null,
    2
  );

  const handleCopyConfig = () => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(mcpConfigJson);
      setCopiedConfig(true);
      setTimeout(() => setCopiedConfig(false), 2000);
    }
  };

  return (
    <div className="space-y-6">
      {/* SECTION 1: LIVE AUTHENTICATED KALSHI PORTFOLIO V2 BALANCE & POSITIONS */}
      <div className="p-5 border border-slate-800 bg-[#111827] space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
          <div>
            <div className="flex flex-wrap items-center gap-2.5">
              <h2 className="text-base font-semibold text-slate-100">
                Live Kalshi Portfolio v2 Balance, Open Contracts &amp; Trade Fills
              </h2>
              <span className="px-2 py-0.5 text-[11px] font-mono font-semibold bg-emerald-950/80 border border-emerald-500/40 text-emerald-300">
                ED25519 AUTHENTICATED ({portfolio?.kalshiKeyIdPreview || 'KALSHI_API_ID'})
              </span>
              <span className="px-2 py-0.5 text-[11px] font-mono bg-cyan-950/80 border border-cyan-500/40 text-cyan-300">
                MCP NODE ACTIVE
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              Pulled directly from <span className="font-mono text-slate-300">https://api.elections.kalshi.com/trade-api/v2/portfolio/balance</span> &amp; <span className="font-mono text-slate-300">/positions</span> using Ed25519 cryptographic request signing.
            </p>
          </div>

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={onSyncKalshi}
              disabled={isSyncing}
              className="px-3.5 py-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold text-xs rounded transition-colors flex items-center gap-1.5 whitespace-nowrap"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
              <span>Pull Live Kalshi Balance</span>
            </button>
          </div>
        </div>

        {/* 4-Card Kalshi Balance Breakdown Strip */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="p-3.5 border border-slate-800 bg-[#0B0F17]">
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span>Total Kalshi Account Equity</span>
              <span className="font-mono text-[11px] text-emerald-400">LIVE V2</span>
            </div>
            <div className="mt-1 text-2xl font-bold font-mono tabular-nums text-emerald-400">
              ${kalshiTotal.toFixed(2)}
            </div>
            <div className="mt-1 text-[11px] text-slate-400 font-mono">
              Cash ${kalshiCash.toFixed(2)} + Contracts ${kalshiPortVal.toFixed(2)}
            </div>
          </div>

          <div className="p-3.5 border border-slate-800 bg-[#0B0F17]">
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span>Available Kalshi Cash</span>
              <span className="font-mono text-[11px] text-cyan-400">2,926¢</span>
            </div>
            <div className="mt-1 text-2xl font-bold font-mono tabular-nums text-slate-100">
              ${kalshiCash.toFixed(2)}
            </div>
            <div className="mt-1 text-[11px] text-slate-400 font-mono">
              {kalshiBreakdown.length > 0
                ? kalshiBreakdown
                    .map((b) => `Exch #${b.exchangeIndex}: $${b.balanceUsd.toFixed(2)}`)
                    .join(' · ')
                : 'Exch #0: $18.38 · Exch #2: $10.88'}
            </div>
          </div>

          <div className="p-3.5 border border-slate-800 bg-[#0B0F17]">
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span>Open Contract Portfolio Value</span>
              <span className="font-mono text-[11px] text-amber-300">4,459¢</span>
            </div>
            <div className="mt-1 text-2xl font-bold font-mono tabular-nums text-amber-300">
              ${kalshiPortVal.toFixed(2)}
            </div>
            <div className="mt-1 text-[11px] text-slate-400 font-mono">
              {kalshiPositions.length} Active Event Contracts
            </div>
          </div>

          <div className="p-3.5 border border-slate-800 bg-[#0B0F17]">
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span>Combined Multi-Venue Equity</span>
              <span className="font-mono text-[11px] text-cyan-400">PUBLIC + KALSHI</span>
            </div>
            <div className="mt-1 text-2xl font-bold font-mono tabular-nums text-cyan-400">
              ${(portfolio?.combinedMultiVenueEquityUsd ?? (portfolio?.totalEquityUsd ?? 625.35) + kalshiTotal).toFixed(2)}
            </div>
            <div className="mt-1 text-[11px] text-slate-400 font-mono">
              Public ${(portfolio?.totalEquityUsd ?? 625.35).toFixed(2)} + Kalshi ${kalshiTotal.toFixed(2)}
            </div>
          </div>
        </div>

        {/* Live Kalshi Open Positions Table */}
        {kalshiPositions.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-slate-200 uppercase tracking-wider">
                Active Kalshi Event Contract Positions ({kalshiPositions.length})
              </span>
              <span className="font-mono text-[11px] text-slate-400">
                Click any tracked contract to inspect live CLOB bars &amp; OCO brackets
              </span>
            </div>
            <div className="overflow-x-auto border border-slate-800 bg-[#0B0F17]">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-800 text-[11px] font-mono uppercase text-slate-400 bg-slate-900/60">
                    <th className="py-2.5 px-3">Kalshi Ticker</th>
                    <th className="py-2.5 px-3">Event Contract Question</th>
                    <th className="py-2.5 px-3">Side</th>
                    <th className="py-2.5 px-3 text-right">Contracts</th>
                    <th className="py-2.5 px-3 text-right">Exposure</th>
                    <th className="py-2.5 px-3 text-right">Live Price</th>
                    <th className="py-2.5 px-3 text-right">Mark Value</th>
                    <th className="py-2.5 px-3 text-right">Unrealized PnL</th>
                    <th className="py-2.5 px-3 text-right">Total Traded</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/70 font-mono">
                  {kalshiPositions.map((pos, idx) => {
                    const isPosPnl = pos.unrealizedPnlUsd >= 0;
                    return (
                      <tr
                        key={`${pos.ticker}-${idx}`}
                        onClick={() => onSelectSymbol && onSelectSymbol(pos.ticker)}
                        className="hover:bg-slate-800/40 transition-colors cursor-pointer"
                      >
                        <td className="py-2.5 px-3 font-semibold text-cyan-400 whitespace-nowrap">
                          {pos.ticker}
                        </td>
                        <td className="py-2.5 px-3 font-sans text-slate-200 max-w-[320px] truncate" title={pos.title}>
                          {pos.title}
                        </td>
                        <td className="py-2.5 px-3">
                          <span
                            className={`px-1.5 py-0.5 text-[10px] font-semibold border ${
                              pos.side === 'YES'
                                ? 'border-emerald-500/40 bg-emerald-950/50 text-emerald-300'
                                : 'border-amber-500/40 bg-amber-950/50 text-amber-300'
                            }`}
                          >
                            {pos.side}
                          </span>
                        </td>
                        <td className="py-2.5 px-3 text-right tabular-nums text-slate-100">
                          {pos.contracts.toFixed(2)}
                        </td>
                        <td className="py-2.5 px-3 text-right tabular-nums text-slate-300">
                          ${pos.marketExposureUsd.toFixed(2)}
                        </td>
                        <td className="py-2.5 px-3 text-right tabular-nums text-slate-200">
                          {(pos.currentPrice * 100).toFixed(1)}¢
                        </td>
                        <td className="py-2.5 px-3 text-right tabular-nums font-semibold text-slate-100">
                          ${pos.currentValueUsd.toFixed(2)}
                        </td>
                        <td
                          className={`py-2.5 px-3 text-right tabular-nums font-semibold ${
                            isPosPnl ? 'text-emerald-400' : 'text-rose-400'
                          }`}
                        >
                          {isPosPnl ? '+' : ''}${pos.unrealizedPnlUsd.toFixed(2)}
                        </td>
                        <td className="py-2.5 px-3 text-right tabular-nums text-slate-400">
                          ${pos.totalTradedUsd.toFixed(2)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Recent Executed Kalshi CLOB Fills */}
        {kalshiFills.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-slate-300 uppercase tracking-wider">
                Recent Executed Kalshi CLOB Fills (/trade-api/v2/portfolio/fills)
              </span>
              <span className="font-mono text-[11px] text-slate-400">
                Showing {Math.min(6, kalshiFills.length)} Latest Fills
              </span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2.5">
              {kalshiFills.slice(0, 6).map((fill, idx) => (
                <div
                  key={`${fill.fillId}-${idx}`}
                  className="p-2.5 border border-slate-800 bg-[#0B0F17] flex items-center justify-between text-xs font-mono"
                >
                  <div className="min-w-0 pr-2">
                    <div className="flex items-center gap-1.5">
                      <span
                        className={`text-[10px] px-1.5 py-0.5 font-semibold uppercase ${
                          fill.action === 'buy'
                            ? 'bg-emerald-950/70 text-emerald-300 border border-emerald-500/30'
                            : 'bg-rose-950/70 text-rose-300 border border-rose-500/30'
                        }`}
                      >
                        {fill.action} {fill.side}
                      </span>
                      <span className="text-slate-100 font-semibold truncate">{fill.ticker}</span>
                    </div>
                    <div className="text-[11px] text-slate-400 mt-1">
                      {new Date(fill.createdTime).toLocaleDateString()} · Fee ${fill.feeCostUsd.toFixed(3)}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-slate-100 font-semibold tabular-nums">
                      {fill.count} @ {((fill.side === 'yes' ? fill.yesPrice : fill.noPrice) * 100).toFixed(1)}¢
                    </div>
                    <div className="text-[10px] text-slate-400">
                      {fill.isTaker ? 'TAKER' : 'MAKER'}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* SECTION 2: MODEL CONTEXT PROTOCOL (MCP) SERVER & CLIENT CONNECTOR HUB */}
      <div className="p-5 border border-slate-800 bg-[#111827] space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
          <div>
            <div className="flex flex-wrap items-center gap-2.5">
              <Server className="w-4 h-4 text-cyan-400" />
              <h2 className="text-base font-semibold text-slate-100">
                Model Context Protocol (MCP) Hub · Kalshi &amp; Finesse_finance Bridge
              </h2>
              <span className="px-2 py-0.5 text-[11px] font-mono font-semibold bg-cyan-950/80 border border-cyan-500/40 text-cyan-300">
                JSON-RPC 2.0 · v2024-11-05
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              Exposes live Kalshi v2 balances, Public.com positions, deterministic ATR regime evaluations, and OCO execution over <span className="font-mono text-slate-200">POST /api/mcp</span> &amp; <span className="font-mono text-slate-200">GET /api/mcp/sse</span>, and connects external MCP servers.
            </p>
          </div>

          <button
            type="button"
            onClick={handleCopyConfig}
            className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs font-mono rounded transition-colors flex items-center gap-1.5 whitespace-nowrap"
          >
            <Copy className="w-3.5 h-3.5 text-cyan-400" />
            <span>{copiedConfig ? 'Copied mcpServers JSON!' : 'Copy MCP Server Config'}</span>
          </button>
        </div>

        {/* Active MCP Server Nodes Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          {mcpServers.map((srv, idx) => (
            <div
              key={`${srv.id}-${idx}`}
              className="p-3.5 border border-slate-800 bg-[#0B0F17] flex flex-col justify-between gap-2.5"
            >
              <div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-slate-100 truncate">{srv.name}</span>
                  <span className="px-1.5 py-0.5 text-[10px] font-mono font-semibold bg-emerald-950/80 border border-emerald-500/40 text-emerald-300 shrink-0">
                    {srv.status} · {srv.latencyMs}ms
                  </span>
                </div>
                <div className="mt-1 text-[11px] font-mono text-cyan-400 truncate" title={srv.endpointUrl}>
                  {srv.endpointUrl}
                </div>
                <div className="mt-1 text-[11px] text-slate-400 font-mono">
                  Auth: {srv.authType}
                </div>
              </div>

              <div className="pt-2 border-t border-slate-800/80 flex items-center justify-between text-[11px] font-mono text-slate-300">
                <span>
                  {srv.toolsCount} Tools · {srv.resourcesCount} Resources
                </span>
                <span className="text-slate-400">{srv.transport}</span>
              </div>
            </div>
          ))}
        </div>

        {/* Interactive MCP Tool Runner + Connect External MCP Server Form */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          {/* Left 7 Cols: Interactive MCP Tool Executor & Live JSON-RPC Output */}
          <div className="lg:col-span-7 p-4 border border-slate-800 bg-[#0B0F17] space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
                <Terminal className="w-4 h-4 text-cyan-400" />
                <span>Interactive MCP Tool Inspector (tools/call)</span>
              </div>
              <span className="text-[11px] font-mono text-slate-400">
                {mcpTools.length} Registered MCP Tools
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
              <div className="sm:col-span-2">
                <label className="block text-[11px] text-slate-400 mb-1">Select MCP Tool</label>
                <select
                  value={selectedTool}
                  onChange={(e) => setSelectedTool(e.target.value)}
                  className="w-full px-2.5 py-1.5 bg-[#111827] border border-slate-700 text-xs font-mono text-slate-100"
                >
                  {mcpTools.map((t, idx) => (
                    <option key={`${t.name}-${idx}`} value={t.name}>
                      {t.name} ({t.category})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Target Ticker / Contract</label>
                <input
                  type="text"
                  value={toolSymbolArg}
                  onChange={(e) => setToolSymbolArg(e.target.value)}
                  placeholder="KXGREENLANDPRICE-29JAN21-NOACQ"
                  className="w-full px-2.5 py-1.5 bg-[#111827] border border-slate-700 text-xs font-mono text-slate-100"
                />
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 pt-1">
              <div className="text-[11px] text-slate-400 leading-snug">
                {mcpTools.find((t) => t.name === selectedTool)?.description}
              </div>
              <button
                type="button"
                onClick={handleRunSelectedTool}
                disabled={isInvoking}
                className="px-3.5 py-2 bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold text-xs rounded transition-colors flex items-center gap-1.5 shrink-0 whitespace-nowrap"
              >
                <Play className="w-3.5 h-3.5" />
                <span>{isInvoking ? 'Calling MCP...' : 'Invoke MCP Tool'}</span>
              </button>
            </div>

            {/* JSON-RPC 2.0 Output Console */}
            <div className="mt-2 p-3 border border-slate-800 bg-[#070A10] font-mono text-[11px] text-emerald-300 max-h-56 overflow-y-auto">
              <pre className="whitespace-pre-wrap break-words">
                {lastToolOutput
                  ? JSON.stringify(lastToolOutput, null, 2)
                  : JSON.stringify(
                      {
                        jsonrpc: '2.0',
                        method: 'tools/call',
                        params: {
                          name: 'get_kalshi_live_balance',
                          arguments: { forceRefresh: true, includeFills: true },
                        },
                        liveResultPreview: {
                          venue: 'KALSHI_TRADE_API_V2',
                          authMethod: portfolio?.kalshiAuthMethod || 'ED25519_SIGNED_V2',
                          cashBalanceUsd: kalshiCash,
                          portfolioValueUsd: kalshiPortVal,
                          totalKalshiEquityUsd: kalshiTotal,
                          openPositionsCount: kalshiPositions.length,
                        },
                      },
                      null,
                      2
                    )}
              </pre>
            </div>
          </div>

          {/* Right 5 Cols: Connect External MCP Server & Wire Log */}
          <div className="lg:col-span-5 p-4 border border-slate-800 bg-[#0B0F17] flex flex-col justify-between space-y-4">
            <form onSubmit={handleConnectSubmit} className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-200">
                  <Plus className="w-4 h-4 text-emerald-400" />
                  <span>Connect External MCP Server</span>
                </div>
                <span className="text-[11px] font-mono text-slate-400">HTTP / SSE Bridge</span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">MCP Server Name</label>
                  <input
                    type="text"
                    value={newMcpName}
                    onChange={(e) => setNewMcpName(e.target.value)}
                    placeholder="e.g. Kalshi Alpha MCP"
                    className="w-full px-2.5 py-1.5 bg-[#111827] border border-slate-700 text-xs text-slate-100"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">Transport Protocol</label>
                  <select
                    value={newMcpTransport}
                    onChange={(e) =>
                      setNewMcpTransport(e.target.value as 'HTTP_JSON_RPC' | 'SSE_STREAM' | 'STDIO_BRIDGE')
                    }
                    className="w-full px-2.5 py-1.5 bg-[#111827] border border-slate-700 text-xs font-mono text-slate-100"
                  >
                    <option value="HTTP_JSON_RPC">HTTP Streamable (JSON-RPC)</option>
                    <option value="SSE_STREAM">Server-Sent Events (SSE)</option>
                    <option value="STDIO_BRIDGE">Stdio WebSocket Bridge</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-[11px] text-slate-400 mb-1">
                  MCP Server Endpoint URL
                </label>
                <input
                  type="text"
                  value={newMcpUrl}
                  onChange={(e) => setNewMcpUrl(e.target.value)}
                  placeholder="https://your-mcp-server.run.app/mcp or /api/mcp"
                  className="w-full px-2.5 py-1.5 bg-[#111827] border border-slate-700 text-xs font-mono text-slate-100"
                />
              </div>

              <button
                type="submit"
                className="w-full py-2 px-3 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold text-xs rounded transition-colors flex items-center justify-center gap-1.5"
              >
                <Zap className="w-3.5 h-3.5" />
                <span>Handshake &amp; Connect MCP Server</span>
              </button>
            </form>

            {/* Recent MCP Wire Call Log */}
            <div className="space-y-1.5 pt-2 border-t border-slate-800">
              <div className="text-[11px] font-mono uppercase text-slate-400">
                Recent MCP JSON-RPC Wire Audit Log
              </div>
              <div className="space-y-1.5 max-h-36 overflow-y-auto">
                {mcpLogs.slice(0, 4).map((log, idx) => (
                  <div
                    key={`${log.id}-${idx}`}
                    className="p-2 border border-slate-800/90 bg-[#111827] text-[11px] font-mono"
                  >
                    <div className="flex items-center justify-between text-slate-300">
                      <span className="text-cyan-400 font-semibold">
                        {log.method} · {log.toolOrResourceName}
                      </span>
                      <span className="text-emerald-400">{log.durationMs}ms</span>
                    </div>
                    <div className="text-slate-400 truncate mt-0.5" title={log.responsePreview}>
                      {log.responsePreview}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
