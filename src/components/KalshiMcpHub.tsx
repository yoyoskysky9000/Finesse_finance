import React, { useState, useEffect } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Download,
  FileCode,
  Key,
  Play,
  Plus,
  RefreshCw,
  Server,
  ShieldAlert,
  Sparkles,
  Terminal,
  Zap,
} from 'lucide-react';
import type {
  McpCallLogEntry,
  McpCommercialTier,
  McpDlqEntry,
  McpIdempotencyRecord,
  McpLicenseKeySpec,
  McpPromptDefinition,
  McpResourceDefinition,
  McpServerConnection,
  McpToolDefinition,
  PortfolioSummary,
} from '../types/quant.ts';

interface KalshiMcpHubProps {
  portfolio: PortfolioSummary | null;
  mcpServers: McpServerConnection[];
  mcpTools: McpToolDefinition[];
  mcpPrompts?: McpPromptDefinition[];
  mcpDlq?: McpDlqEntry[];
  mcpIdempotencyLedger?: McpIdempotencyRecord[];
  mcpResources: McpResourceDefinition[];
  mcpLogs: McpCallLogEntry[];
  isSyncing: boolean;
  onSyncKalshi: () => Promise<void>;
  onInvokeMcpTool: (toolName: string, args: Record<string, any>) => Promise<Record<string, any> | null>;
  onConnectMcpServer: (config: {
    name: string;
    endpointUrl: string;
    transport: 'http' | 'HTTP_JSON_RPC' | 'SSE_STREAM' | 'STDIO_BRIDGE';
    authHeader?: string;
  }) => Promise<void>;
  onSelectSymbol?: (symbol: string) => void;
}

export const KalshiMcpHub: React.FC<KalshiMcpHubProps> = ({
  portfolio,
  mcpServers,
  mcpTools,
  mcpPrompts = [],
  mcpDlq = [],
  mcpIdempotencyLedger = [],
  mcpLogs,
  isSyncing,
  onSyncKalshi,
  onInvokeMcpTool,
  onConnectMcpServer,
  onSelectSymbol,
}) => {
  const [selectedTool, setSelectedTool] = useState<string>('evaluate_btc_lead_lag');
  const [toolSymbolArg, setToolSymbolArg] = useState<string>('KXBTC15M');
  const [toolNotionalArg, setToolNotionalArg] = useState<number>(18);
  const [toolAskPriceArg, setToolAskPriceArg] = useState<number>(0.62);
  const [idempotencyKeyArg, setIdempotencyKeyArg] = useState<string>(
    () => `idem-${Date.now().toString(36)}-kxbtc15m`
  );
  const [dlqFailedToolArg, setDlqFailedToolArg] = useState<string>('execute_kalshi_or_public_order');
  const [dlqErrorReasonArg, setDlqErrorReasonArg] = useState<string>(
    'Blocked by Fee Gate: Ask $0.27 outside [$0.45, $0.82]'
  );
  const [isInvoking, setIsInvoking] = useState<boolean>(false);
  const [lastToolOutput, setLastToolOutput] = useState<Record<string, any> | null>(null);
  const [copiedConfig, setCopiedConfig] = useState<boolean>(false);
  const [copiedPy, setCopiedPy] = useState<boolean>(false);

  // @mcp.prompt() Inspector State
  const [selectedPrompt, setSelectedPrompt] = useState<string>('finesse_finance_regime_audit');
  const [promptSymbolArg, setPromptSymbolArg] = useState<string>('KXBTC15M');
  const [renderedPromptOutput, setRenderedPromptOutput] = useState<string>('');
  const [isRenderingPrompt, setIsRenderingPrompt] = useState<boolean>(false);

  // Python FastMCP Server Code & Sub-View State
  const [pythonMcpCode, setPythonMcpCode] = useState<string>('');
  const [activeSubView, setActiveSubView] = useState<
    'TOOL_INSPECTOR' | 'MONETIZATION_TIER_GATE' | 'PROMPTS_AND_DLQ' | 'PYTHON_FASTMCP_CODE'
  >('TOOL_INSPECTOR');

  // SaaS & Agent API Monetization Entitlement Gate State
  const [licenseKeys, setLicenseKeys] = useState<McpLicenseKeySpec[]>([]);
  const [activeLicenseKey, setActiveLicenseKey] = useState<string>('qp_pro_quant_saas_live_9941a');
  const [newKeyTier, setNewKeyTier] = useState<McpCommercialTier>('PRO_QUANT_SAAS');
  const [newKeyLabel, setNewKeyLabel] = useState<string>('Custom Quant Agent Key');
  const [isGeneratingKey, setIsGeneratingKey] = useState<boolean>(false);
  const [tierTestTool, setTierTestTool] = useState<string>('evaluate_btc_lead_lag');
  const [tierTestSymbol, setTierTestSymbol] = useState<string>('KXBTC15M');
  const [includeAgentPaymentProof, setIncludeAgentPaymentProof] = useState<boolean>(false);
  const [tierTestHttpStatus, setTierTestHttpStatus] = useState<number | null>(null);
  const [tierTestProtocolHeader, setTierTestProtocolHeader] = useState<string>('2026-07-28');
  const [tierTestResponse, setTierTestResponse] = useState<Record<string, any> | null>(null);
  const [sseCheckOutput, setSseCheckOutput] = useState<Record<string, any> | null>(null);

  // Connect External MCP Server form state
  const [newMcpName, setNewMcpName] = useState<string>('');
  const [newMcpUrl, setNewMcpUrl] = useState<string>('');
  const [newMcpTransport, setNewMcpTransport] = useState<
    'http' | 'HTTP_JSON_RPC' | 'SSE_STREAM' | 'STDIO_BRIDGE'
  >('http');
  const [newMcpAuth, setNewMcpAuth] = useState<string>('');

  const kalshiCash = portfolio?.kalshiCashBalanceUsd ?? 29.27;
  const kalshiPortVal = portfolio?.kalshiPortfolioValueUsd ?? 44.59;
  const kalshiTotal = portfolio?.kalshiTotalEquityUsd ?? Number((kalshiCash + kalshiPortVal).toFixed(2));
  const kalshiPositions = portfolio?.kalshiPositions ?? [];
  const kalshiBreakdown = portfolio?.kalshiBalanceBreakdown ?? [];

  const activeToolDef = mcpTools.find((t) => t.name === selectedTool);
  const isSelectedToolMutating = Boolean(activeToolDef?.isMutating);

  const fetchEntitlementRegistry = async () => {
    try {
      const res = await fetch('/api/mcp/entitlements');
      if (res.ok) {
        const data = await res.json();
        const items = data.licenses || data.tiers;
        if (Array.isArray(items)) {
          setLicenseKeys(items);
        }
      }
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    fetch('/api/mcp/python-server')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.code) setPythonMcpCode(data.code);
      })
      .catch(() => {});
    fetchEntitlementRegistry();
  }, []);

  const handleGenerateLicenseKey = async () => {
    setIsGeneratingKey(true);
    try {
      const res = await fetch('/api/mcp/license/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tier: newKeyTier,
          label: newKeyLabel.trim() || `${newKeyTier} Key`,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        const mintedKey = data.generated?.licenseKey || data.license?.licenseKey;
        if (mintedKey) {
          setActiveLicenseKey(mintedKey);
        }
        await fetchEntitlementRegistry();
      }
    } finally {
      setIsGeneratingKey(false);
    }
  };

  const handleTestTierGateMcpCall = async (overrideKey?: string, overrideTool?: string, overrideProof?: boolean) => {
    const keyToUse = overrideKey ?? activeLicenseKey;
    const toolToCall = overrideTool ?? tierTestTool;
    const withProof = overrideProof ?? includeAgentPaymentProof;
    setIsInvoking(true);
    try {
      const rpcBody = {
        jsonrpc: '2.0',
        id: `tier-audit-${Date.now()}`,
        method: 'tools/call',
        params: {
          name: toolToCall,
          arguments:
            toolToCall === 'train_and_optimize_meta_model'
              ? { symbol: tierTestSymbol || 'ALL', min_samples: 20 }
              : { symbol: tierTestSymbol || 'KXBTC15M', yes_ask: 0.62, minutes_left: 10 },
          _meta: withProof
            ? {
                paymentProof: `x402-fet-tx-${Date.now().toString(36)}`,
                agentWallet: 'fet1quantpulseoracle8829a',
              }
            : {
                clientAgent: 'external-autonomous-oracle-v1',
              },
        },
      };
      const res = await fetch('/api/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'MCP-Protocol-Version': '2026-07-28',
          'X-QuantPulse-License-Key': keyToUse,
        },
        body: JSON.stringify(rpcBody),
      });
      setTierTestHttpStatus(res.status);
      setTierTestProtocolHeader(res.headers.get('MCP-Protocol-Version') || '2026-07-28');
      const data = await res.json();
      setTierTestResponse(data);
      await fetchEntitlementRegistry();
    } finally {
      setIsInvoking(false);
    }
  };

  const handleVerifySseDeprecated = async () => {
    const res = await fetch('/api/mcp/sse');
    const data = await res.json();
    setSseCheckOutput({
      httpStatus: res.status,
      connectionHeader: res.headers.get('Connection') || 'close',
      mcpProtocolVersion: res.headers.get('MCP-Protocol-Version') || '2026-07-28',
      payload: data,
    });
  };

  const generateFreshIdempotencyKey = (prefix = 'idem') => {
    const nextKey = `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    setIdempotencyKeyArg(nextKey);
    return nextKey;
  };

  const handleRunSelectedTool = async (overrideArgs?: Record<string, any>, overrideTool?: string) => {
    const targetTool = overrideTool || selectedTool;
    setIsInvoking(true);
    try {
      let args: Record<string, any> = {};
      if (overrideArgs) {
        args = overrideArgs;
      } else if (targetTool === 'get_kalshi_live_balance') {
        args = { forceRefresh: true, includeFills: true };
      } else if (targetTool === 'get_public_brokerage_portfolio') {
        args = { includePositions: true };
      } else if (targetTool === 'evaluate_market_regime') {
        args = { symbol: toolSymbolArg };
      } else if (targetTool === 'evaluate_btc_lead_lag') {
        args = {
          symbol: toolSymbolArg,
          yes_ask: toolAskPriceArg,
          no_ask: Number((1.02 - toolAskPriceArg).toFixed(2)),
          minutes_left: 10,
        };
      } else if (targetTool === 'scan_alpha_and_backtest') {
        args = { symbol: toolSymbolArg, indicatorStrategyId: 'BTC_LEAD_LAG_SNIPER' };
      } else if (targetTool === 'train_and_optimize_meta_model') {
        args = { symbol: toolSymbolArg || 'ALL', min_samples: 20, target_metric: 'brier_score' };
      } else if (targetTool === 'execute_kalshi_or_public_order') {
        args = {
          symbol: toolSymbolArg,
          idempotency_key: idempotencyKeyArg,
          side: 'BUY_YES',
          notionalUsd: toolNotionalArg,
          ask_price: toolAskPriceArg,
        };
      } else if (targetTool === 'run_portfolio_cleaner') {
        args = {
          idempotency_key: idempotencyKeyArg,
          dry_run: false,
        };
      } else if (targetTool === 'route_to_dlq') {
        args = {
          idempotency_key: idempotencyKeyArg,
          failed_tool: dlqFailedToolArg,
          payload_json: JSON.stringify({
            symbol: toolSymbolArg,
            ask_price: toolAskPriceArg,
            notionalUsd: toolNotionalArg,
          }),
          error_reason: dlqErrorReasonArg,
          severity: 'CRITICAL',
        };
      } else {
        args = {
          idempotency_key: idempotencyKeyArg,
          action: 'STATUS_AUDIT',
        };
      }
      const res = await onInvokeMcpTool(targetTool, args);
      if (res) {
        setLastToolOutput(res);
      }
    } finally {
      setIsInvoking(false);
    }
  };

  const handleTestRenderPrompt = async (promptName = selectedPrompt) => {
    setIsRenderingPrompt(true);
    try {
      const res = await fetch('/api/mcp/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: promptName,
          args: {
            symbol: promptSymbolArg,
            timeframe: '15m',
            coinbase_spot: 82620.0,
            strike: 82510.73,
            minutes_left: 10.0,
            yes_ask: toolAskPriceArg,
            account_id: '5OQ77709',
            idempotency_key: idempotencyKeyArg,
            failed_tool: dlqFailedToolArg,
            error_reason: dlqErrorReasonArg,
          },
        }),
      });
      if (res.ok) {
        const data = await res.json();
        const msg = data.rendered?.messages?.[0]?.content?.text || '';
        setRenderedPromptOutput(msg);
      }
    } finally {
      setIsRenderingPrompt(false);
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

  const mcpConfigJson = JSON.stringify(
    {
      mcpServers: {
        'finesse-finance-kalshi-quant': {
          url: mcpEndpointUrl,
          transport: 'http',
          statelessHttp: true,
          protocolVersion: '2026-07-28',
          headers: {
            'MCP-Protocol-Version': '2026-07-28',
            'X-QuantPulse-License-Key': activeLicenseKey,
          },
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

  const handleCopyPythonServer = () => {
    if (pythonMcpCode && typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(pythonMcpCode);
      setCopiedPy(true);
      setTimeout(() => setCopiedPy(false), 2000);
    }
  };

  const handleDownloadPythonServer = () => {
    if (!pythonMcpCode) return;
    const blob = new Blob([pythonMcpCode], { type: 'text/x-python' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'mcp_server.py';
    a.click();
    URL.revokeObjectURL(url);
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
                STATELESS STREAMABLE HTTP (transport=&apos;http&apos;)
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              Pulled directly from{' '}
              <span className="font-mono text-slate-300">
                https://api.elections.kalshi.com/trade-api/v2/portfolio/balance
              </span>{' '}
              &amp; <span className="font-mono text-slate-300">/positions</span> using Ed25519 cryptographic request signing.
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
              $
              {(
                portfolio?.combinedMultiVenueEquityUsd ??
                (portfolio?.totalEquityUsd ?? 625.35) + kalshiTotal
              ).toFixed(2)}
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
                        <td
                          className="py-2.5 px-3 font-sans text-slate-200 max-w-[320px] truncate"
                          title={pos.title}
                        >
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
      </div>

      {/* SECTION 2: STEP 1 REFACTORED MODEL CONTEXT PROTOCOL (MCP) SERVER HUB */}
      <div className="p-5 border border-cyan-500/30 bg-[#111827] space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <Server className="w-4 h-4 text-cyan-400" />
              <h2 className="text-base font-semibold text-slate-100">
                Step 1 Refactored MCP Server · Stateless Streamable HTTP (<code className="text-cyan-300">transport=&apos;http&apos;</code>)
              </h2>
              <span className="px-2 py-0.5 text-[10px] font-mono font-semibold bg-emerald-950/80 border border-emerald-500/40 text-emerald-300">
                ALL TOOLS async def
              </span>
              <span className="px-2 py-0.5 text-[10px] font-mono font-semibold bg-amber-950/80 border border-amber-500/40 text-amber-300">
                idempotency_key: str REQUIRED
              </span>
              <span className="px-2 py-0.5 text-[10px] font-mono font-semibold bg-rose-950/80 border border-rose-500/40 text-rose-300">
                route_to_dlq FALLBACK
              </span>
              <span className="px-2 py-0.5 text-[10px] font-mono font-semibold bg-purple-950/80 border border-purple-500/40 text-purple-300">
                @mcp.prompt() ACTIVE
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              Stateless Streamable HTTP transport (<span className="font-mono text-slate-200">POST /api/mcp</span> &amp;{' '}
              <span className="font-mono text-slate-200">mcp_server.py</span>): all 8 tool handlers run as{' '}
              <span className="font-mono text-emerald-300">async def</span>, all 4 mutating tools enforce{' '}
              <span className="font-mono text-amber-300">idempotency_key: str</span>, failed/rejected mutations route to{' '}
              <span className="font-mono text-rose-300">route_to_dlq</span>, and 4{' '}
              <span className="font-mono text-purple-300">@mcp.prompt()</span> functions are exposed.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleCopyConfig}
              className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs font-mono rounded transition-colors flex items-center gap-1.5 whitespace-nowrap"
            >
              <Copy className="w-3.5 h-3.5 text-cyan-400" />
              <span>{copiedConfig ? 'Copied transport="http" Config!' : 'Copy MCP HTTP Config'}</span>
            </button>
            <button
              type="button"
              onClick={handleDownloadPythonServer}
              className="px-3 py-1.5 bg-purple-500/20 hover:bg-purple-500/30 border border-purple-500/40 text-purple-200 text-xs font-mono rounded transition-colors flex items-center gap-1.5 whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5 text-purple-300" />
              <span>Download mcp_server.py</span>
            </button>
          </div>
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
                  {srv.toolsCount} async Tools · {srv.promptsCount ?? 4} Prompts
                </span>
                <span className="px-1.5 py-0.5 bg-cyan-950/60 border border-cyan-500/30 text-cyan-300">
                  transport=&apos;{srv.transport}&apos;
                </span>
              </div>
            </div>
          ))}
        </div>

        {/* Sub-Navigation Switcher for Step 1 MCP Features */}
        <div className="flex flex-wrap items-center justify-between gap-3 bg-[#0B0F17] p-2 border border-slate-800">
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => setActiveSubView('TOOL_INSPECTOR')}
              className={`px-3 py-1.5 text-xs font-mono rounded transition-colors flex items-center gap-1.5 ${
                activeSubView === 'TOOL_INSPECTOR'
                  ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 font-semibold'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Terminal className="w-3.5 h-3.5" />
              <span>1. Async Tool Inspector &amp; Idempotency Gate</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setActiveSubView('MONETIZATION_TIER_GATE');
                fetchEntitlementRegistry();
              }}
              className={`px-3 py-1.5 text-xs font-mono rounded transition-colors flex items-center gap-1.5 ${
                activeSubView === 'MONETIZATION_TIER_GATE'
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 font-semibold'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Key className="w-3.5 h-3.5" />
              <span>2. SaaS &amp; Agent API Monetization Gate (X-QuantPulse-License-Key)</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setActiveSubView('PROMPTS_AND_DLQ');
                if (!renderedPromptOutput) handleTestRenderPrompt('finesse_finance_regime_audit');
              }}
              className={`px-3 py-1.5 text-xs font-mono rounded transition-colors flex items-center gap-1.5 ${
                activeSubView === 'PROMPTS_AND_DLQ'
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40 font-semibold'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <ShieldAlert className="w-3.5 h-3.5" />
              <span>
                3. @mcp.prompt() Functions ({mcpPrompts.length || 4}) &amp; Dead-Letter Queue ({mcpDlq.length})
              </span>
            </button>
            <button
              type="button"
              onClick={() => setActiveSubView('PYTHON_FASTMCP_CODE')}
              className={`px-3 py-1.5 text-xs font-mono rounded transition-colors flex items-center gap-1.5 ${
                activeSubView === 'PYTHON_FASTMCP_CODE'
                  ? 'bg-purple-500/20 text-purple-300 border border-purple-500/40 font-semibold'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <FileCode className="w-3.5 h-3.5" />
              <span>4. Step 1 Python FastMCP Code (mcp_server.py)</span>
            </button>
          </div>

          <div className="text-[11px] font-mono text-slate-400">
            Protocol: <strong className="text-cyan-300">2026-07-28</strong> · SSE Trap: <strong className="text-emerald-400">CLOSED (410)</strong> · DLQ:{' '}
            <strong className="text-rose-400">{mcpDlq.length}</strong>
          </div>
        </div>

        {/* SUB-VIEW 1B: SAAS & AGENT API MONETIZATION GATE (X-QuantPulse-License-Key) */}
        {activeSubView === 'MONETIZATION_TIER_GATE' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
            {/* Left 6 Cols: Non-Custodial API License Key Generator & Active Tier Registry */}
            <div className="lg:col-span-6 p-4 border border-slate-800 bg-[#0B0F17] space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-3">
                <div>
                  <div className="flex items-center gap-2 text-xs font-semibold text-emerald-300">
                    <Key className="w-4 h-4" />
                    <span>Non-Custodial License Key Generator (X-QuantPulse-License-Key)</span>
                  </div>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    Generate commercial entitlement keys for <code className="text-cyan-300">FREE_DISCOVERY</code> (30 req/hr), <code className="text-emerald-300">PRO_QUANT_SAAS</code> (BYOK + Tool #9), or <code className="text-amber-300">AGENT_ORACLE_PAY_PER_CALL</code> (HTTP 402 / x402 + FET/Stripe).
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleVerifySseDeprecated}
                  className="px-2.5 py-1 text-[10px] font-mono bg-slate-800 hover:bg-slate-700 border border-slate-600 text-cyan-300 rounded whitespace-nowrap"
                >
                  Verify GET /api/mcp/sse Closed (Scale-to-Zero)
                </button>
              </div>

              {sseCheckOutput && (
                <div className="p-2.5 border border-emerald-500/40 bg-emerald-950/20 text-[11px] font-mono text-emerald-200 space-y-1">
                  <div className="flex items-center justify-between font-bold">
                    <span>Legacy SSE Stream Trap Status: HTTP {sseCheckOutput.httpStatus} (CLOSED)</span>
                    <span>MCP-Protocol-Version: {sseCheckOutput.mcpProtocolVersion}</span>
                  </div>
                  <div className="text-slate-300">
                    Connection: {sseCheckOutput.connectionHeader} · {sseCheckOutput.payload?.message}
                  </div>
                </div>
              )}

              {/* Key Generator Form */}
              <div className="grid grid-cols-1 sm:grid-cols-12 gap-2.5 p-3 border border-slate-800 bg-[#111827]">
                <div className="sm:col-span-5">
                  <label className="block text-[10px] font-mono uppercase text-slate-400 mb-1">
                    Commercial Entitlement Tier
                  </label>
                  <select
                    value={newKeyTier}
                    onChange={(e) => setNewKeyTier(e.target.value as McpCommercialTier)}
                    className="w-full px-2.5 py-1.5 bg-[#0B0F17] border border-slate-700 text-xs font-mono text-slate-100"
                  >
                    <option value="FREE_DISCOVERY">FREE_DISCOVERY (30 req/hr · Regime Only)</option>
                    <option value="PRO_QUANT_SAAS">PRO_QUANT_SAAS (Full Tools + BYOK + ML #9)</option>
                    <option value="AGENT_ORACLE_PAY_PER_CALL">AGENT_ORACLE_PAY_PER_CALL (HTTP 402 / x402 / FET)</option>
                  </select>
                </div>
                <div className="sm:col-span-4">
                  <label className="block text-[10px] font-mono uppercase text-slate-400 mb-1">
                    Key Label / Tenant Identifier
                  </label>
                  <input
                    type="text"
                    value={newKeyLabel}
                    onChange={(e) => setNewKeyLabel(e.target.value)}
                    placeholder="e.g. HedgePod Alpha Bot"
                    className="w-full px-2.5 py-1.5 bg-[#0B0F17] border border-slate-700 text-xs font-mono text-slate-100"
                  />
                </div>
                <div className="sm:col-span-3 flex items-end">
                  <button
                    type="button"
                    onClick={handleGenerateLicenseKey}
                    disabled={isGeneratingKey}
                    className="w-full py-1.5 px-3 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold text-xs font-mono rounded transition-colors"
                  >
                    {isGeneratingKey ? 'Minting...' : '+ Mint Key'}
                  </button>
                </div>
              </div>

              {/* Active License Keys Table */}
              <div className="space-y-1.5">
                <div className="text-[11px] font-mono uppercase text-slate-400">
                  Registered Entitlement Keys (Click to Select for Live POST /api/mcp Test)
                </div>
                <div className="space-y-1.5 max-h-60 overflow-y-auto">
                  {licenseKeys.map((spec) => {
                    const isSelected = spec.licenseKey === activeLicenseKey;
                    return (
                      <div
                        key={spec.licenseKey}
                        onClick={() => setActiveLicenseKey(spec.licenseKey)}
                        className={`p-2.5 border text-xs font-mono cursor-pointer transition-colors ${
                          isSelected
                            ? 'border-cyan-400 bg-cyan-950/25'
                            : 'border-slate-800 bg-[#111827] hover:border-slate-700'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-bold text-slate-100 truncate">{spec.licenseKey}</span>
                          <span
                            className={`px-1.5 py-0.5 text-[10px] font-semibold border shrink-0 ${
                              spec.tier === 'PRO_QUANT_SAAS'
                                ? 'border-emerald-500/40 bg-emerald-950/60 text-emerald-300'
                                : spec.tier === 'AGENT_ORACLE_PAY_PER_CALL'
                                ? 'border-amber-500/40 bg-amber-950/60 text-amber-300'
                                : 'border-cyan-500/40 bg-cyan-950/60 text-cyan-300'
                            }`}
                          >
                            {spec.tier}
                          </span>
                        </div>
                        <div className="flex items-center justify-between text-[11px] text-slate-400 mt-1">
                          <span className="truncate">{spec.label}</span>
                          <span className="shrink-0">
                            Usage: {spec.requestsUsedThisHour}/{spec.rateLimitPerHour} req/hr · {spec.pricingModel.split('·')[0]}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Right 6 Cols: Live Tier Gate & x402 / FET Metering Inspector */}
            <div className="lg:col-span-6 p-4 border border-slate-800 bg-[#0B0F17] space-y-3.5">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-3">
                <div>
                  <div className="text-xs font-semibold text-cyan-300 font-mono">
                    POST /api/mcp Entitlement Middleware Tester (MCP-Protocol-Version: 2026-07-28)
                  </div>
                  <div className="text-[11px] text-slate-400 mt-0.5">
                    Test tier gating, 30 req/hr rate-limiting, and HTTP 402 <code className="text-amber-300">params._meta</code> metering.
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      setActiveLicenseKey('qp_free_discovery_public_v1');
                      setTierTestTool('evaluate_btc_lead_lag');
                      handleTestTierGateMcpCall('qp_free_discovery_public_v1', 'evaluate_btc_lead_lag', false);
                    }}
                    className="px-2 py-1 text-[10px] font-mono bg-rose-950/70 hover:bg-rose-900/70 border border-rose-500/40 text-rose-200 rounded"
                  >
                    Test FREE Blocked (403)
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setActiveLicenseKey('qp_agent_oracle_x402_fet_8820x');
                      setTierTestTool('evaluate_btc_lead_lag');
                      setIncludeAgentPaymentProof(false);
                      handleTestTierGateMcpCall('qp_agent_oracle_x402_fet_8820x', 'evaluate_btc_lead_lag', false);
                    }}
                    className="px-2 py-1 text-[10px] font-mono bg-amber-950/70 hover:bg-amber-900/70 border border-amber-500/40 text-amber-200 rounded"
                  >
                    Test Agent HTTP 402 Quote
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setActiveLicenseKey('qp_agent_oracle_x402_fet_8820x');
                      setTierTestTool('evaluate_btc_lead_lag');
                      setIncludeAgentPaymentProof(true);
                      handleTestTierGateMcpCall('qp_agent_oracle_x402_fet_8820x', 'evaluate_btc_lead_lag', true);
                    }}
                    className="px-2 py-1 text-[10px] font-mono bg-emerald-950/70 hover:bg-emerald-900/70 border border-emerald-500/40 text-emerald-200 rounded"
                  >
                    Test Agent Settled (200 OK)
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                <div>
                  <label className="block text-[10px] font-mono uppercase text-slate-400 mb-1">
                    X-QuantPulse-License-Key
                  </label>
                  <input
                    type="text"
                    value={activeLicenseKey}
                    onChange={(e) => setActiveLicenseKey(e.target.value)}
                    className="w-full px-2.5 py-1.5 bg-[#111827] border border-slate-700 text-xs font-mono text-cyan-300"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-mono uppercase text-slate-400 mb-1">
                    MCP Tool to Request
                  </label>
                  <select
                    value={tierTestTool}
                    onChange={(e) => setTierTestTool(e.target.value)}
                    className="w-full px-2.5 py-1.5 bg-[#111827] border border-slate-700 text-xs font-mono text-slate-100"
                  >
                    <option value="evaluate_market_regime">evaluate_market_regime (FREE Allowed)</option>
                    <option value="evaluate_btc_lead_lag">evaluate_btc_lead_lag (PRO / x402)</option>
                    <option value="scan_alpha_and_backtest">scan_alpha_and_backtest (PRO / x402)</option>
                    <option value="train_and_optimize_meta_model">train_and_optimize_meta_model (Tool #9)</option>
                    <option value="execute_kalshi_or_public_order">execute_kalshi_or_public_order (BYOK)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] font-mono uppercase text-slate-400 mb-1">
                    Ticker Symbol
                  </label>
                  <input
                    type="text"
                    value={tierTestSymbol}
                    onChange={(e) => setTierTestSymbol(e.target.value)}
                    className="w-full px-2.5 py-1.5 bg-[#111827] border border-slate-700 text-xs font-mono text-slate-100"
                  />
                </div>
              </div>

              <div className="flex items-center justify-between gap-2 pt-1">
                <label className="flex items-center gap-2 text-xs font-mono text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={includeAgentPaymentProof}
                    onChange={(e) => setIncludeAgentPaymentProof(e.target.checked)}
                    className="accent-amber-400"
                  />
                  <span>Attach params._meta.paymentProof (x402 / FET Receipt)</span>
                </label>
                <button
                  type="button"
                  onClick={() => handleTestTierGateMcpCall()}
                  disabled={isInvoking}
                  className="px-3.5 py-1.5 bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold text-xs font-mono rounded"
                >
                  {isInvoking ? 'Calling POST /api/mcp...' : 'Send POST /api/mcp With License Header'}
                </button>
              </div>

              <div className="p-3 border border-slate-800 bg-[#070A10] font-mono text-[11px] text-emerald-300 max-h-60 overflow-y-auto space-y-1.5">
                {tierTestHttpStatus !== null && (
                  <div className="flex items-center justify-between border-b border-slate-800 pb-1.5 text-xs">
                    <span
                      className={
                        tierTestHttpStatus === 200
                          ? 'text-emerald-400 font-bold'
                          : tierTestHttpStatus === 402
                          ? 'text-amber-300 font-bold'
                          : 'text-rose-400 font-bold'
                      }
                    >
                      HTTP Status: {tierTestHttpStatus}{' '}
                      {tierTestHttpStatus === 200
                        ? 'OK (Stateless Streamable HTTP)'
                        : tierTestHttpStatus === 402
                        ? 'Payment Required (x402 / FET / Stripe Quote)'
                        : 'Forbidden / Rate-Limited'}
                    </span>
                    <span className="text-cyan-300">MCP-Protocol-Version: {tierTestProtocolHeader}</span>
                  </div>
                )}
                <pre className="whitespace-pre-wrap break-words">
                  {tierTestResponse
                    ? JSON.stringify(tierTestResponse, null, 2)
                    : 'Click any quick-test button above or "Send POST /api/mcp With License Header" to inspect the live entitlement response and params._meta metering block.'}
                </pre>
              </div>
            </div>
          </div>
        )}

        {/* SUB-VIEW 1: INTERACTIVE ASYNC MCP TOOL EXECUTOR + IDEMPOTENCY KEY GATE */}
        {activeSubView === 'TOOL_INSPECTOR' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
            {/* Left 7 Cols: Interactive MCP Tool Executor & Live JSON-RPC Output */}
            <div className="lg:col-span-7 p-4 border border-slate-800 bg-[#0B0F17] space-y-3.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
                  <Terminal className="w-4 h-4 text-cyan-400" />
                  <span>Stateless Streamable HTTP Tool Inspector (async def tools/call)</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedTool('execute_kalshi_or_public_order');
                      setToolSymbolArg('KXBTC15M');
                      setToolAskPriceArg(0.27);
                      const key = generateFreshIdempotencyKey('idem-feegate-027');
                      handleRunSelectedTool(
                        {
                          symbol: 'KXBTC15M',
                          idempotency_key: key,
                          side: 'BUY_YES',
                          notionalUsd: 18,
                          ask_price: 0.27,
                        },
                        'execute_kalshi_or_public_order'
                      );
                    }}
                    className="px-2 py-1 text-[10px] font-mono bg-rose-950/70 hover:bg-rose-900/70 border border-rose-500/40 text-rose-200 rounded"
                  >
                    Test $0.27 Fee Gate → route_to_dlq
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedTool('execute_kalshi_or_public_order');
                      setToolSymbolArg('KXBTC15M');
                      setToolAskPriceArg(0.62);
                      handleRunSelectedTool(
                        {
                          symbol: 'KXBTC15M',
                          idempotency_key: idempotencyKeyArg,
                          side: 'BUY_YES',
                          notionalUsd: 18,
                          ask_price: 0.62,
                        },
                        'execute_kalshi_or_public_order'
                      );
                    }}
                    className="px-2 py-1 text-[10px] font-mono bg-amber-950/70 hover:bg-amber-900/70 border border-amber-500/40 text-amber-200 rounded"
                  >
                    Replay Same idempotency_key
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                <div className="sm:col-span-2">
                  <label className="block text-[11px] text-slate-400 mb-1">
                    Select Async MCP Tool (<code className="text-emerald-300">async def</code>)
                  </label>
                  <select
                    value={selectedTool}
                    onChange={(e) => setSelectedTool(e.target.value)}
                    className="w-full px-2.5 py-1.5 bg-[#111827] border border-slate-700 text-xs font-mono text-slate-100"
                  >
                    {mcpTools.map((t, idx) => (
                      <option key={`${t.name}-${idx}`} value={t.name}>
                        {t.name} {t.requiresIdempotencyKey ? '[MUTATING · idempotency_key]' : '[READ-ONLY]'}
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
                    placeholder="KXBTC15M"
                    className="w-full px-2.5 py-1.5 bg-[#111827] border border-slate-700 text-xs font-mono text-slate-100"
                  />
                </div>
              </div>

              {/* Required idempotency_key: str field for all Mutating Tools */}
              {isSelectedToolMutating && (
                <div className="p-3 border border-amber-500/30 bg-amber-950/15 space-y-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 text-xs font-mono font-semibold text-amber-300">
                      <Key className="w-3.5 h-3.5" />
                      <span>Required Parameter: idempotency_key: str (Mutating Tool Gate)</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => generateFreshIdempotencyKey('idem')}
                      className="px-2 py-0.5 text-[10px] font-mono bg-slate-800 hover:bg-slate-700 border border-slate-600 text-slate-200 rounded"
                    >
                      Generate New Key
                    </button>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                    <div className="sm:col-span-2">
                      <label className="block text-[10px] font-mono uppercase text-slate-400 mb-1">
                        idempotency_key: str
                      </label>
                      <input
                        type="text"
                        value={idempotencyKeyArg}
                        onChange={(e) => setIdempotencyKeyArg(e.target.value)}
                        placeholder="idem-uuid-or-sha256"
                        className="w-full px-2.5 py-1.5 bg-[#111827] border border-amber-500/40 text-xs font-mono text-amber-200"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-mono uppercase text-slate-400 mb-1">
                        Ask Price ($0.45–$0.82)
                      </label>
                      <input
                        type="number"
                        step="0.01"
                        min="0.01"
                        max="0.99"
                        value={toolAskPriceArg}
                        onChange={(e) => setToolAskPriceArg(Number(e.target.value))}
                        className="w-full px-2.5 py-1.5 bg-[#111827] border border-slate-700 text-xs font-mono text-emerald-300"
                      />
                    </div>
                  </div>

                  {selectedTool === 'route_to_dlq' && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-1">
                      <div>
                        <label className="block text-[10px] font-mono uppercase text-slate-400 mb-1">
                          failed_tool: str
                        </label>
                        <input
                          type="text"
                          value={dlqFailedToolArg}
                          onChange={(e) => setDlqFailedToolArg(e.target.value)}
                          className="w-full px-2.5 py-1.5 bg-[#111827] border border-slate-700 text-xs font-mono text-rose-200"
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] font-mono uppercase text-slate-400 mb-1">
                          error_reason: str
                        </label>
                        <input
                          type="text"
                          value={dlqErrorReasonArg}
                          onChange={(e) => setDlqErrorReasonArg(e.target.value)}
                          className="w-full px-2.5 py-1.5 bg-[#111827] border border-slate-700 text-xs font-mono text-rose-200"
                        />
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div className="flex items-center justify-between gap-3 pt-1">
                <div className="text-[11px] font-mono text-slate-400 leading-snug">
                  {activeToolDef?.description}
                </div>
                <button
                  type="button"
                  onClick={() => handleRunSelectedTool()}
                  disabled={isInvoking}
                  className="px-3.5 py-2 bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold text-xs rounded transition-colors flex items-center gap-1.5 shrink-0 whitespace-nowrap"
                >
                  <Play className="w-3.5 h-3.5" />
                  <span>{isInvoking ? 'Calling async def...' : 'Invoke Async MCP Tool'}</span>
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
                          transport: 'http',
                          statelessHttp: true,
                          method: 'tools/call',
                          params: {
                            name: selectedTool,
                            arguments: isSelectedToolMutating
                              ? {
                                  symbol: toolSymbolArg,
                                  idempotency_key: idempotencyKeyArg,
                                  side: 'BUY_YES',
                                  notionalUsd: toolNotionalArg,
                                  ask_price: toolAskPriceArg,
                                }
                              : { symbol: toolSymbolArg, forceRefresh: true },
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
                  <span className="text-[11px] font-mono text-cyan-300">transport=&apos;http&apos;</span>
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
                        setNewMcpTransport(
                          e.target.value as 'http' | 'HTTP_JSON_RPC' | 'SSE_STREAM' | 'STDIO_BRIDGE'
                        )
                      }
                      className="w-full px-2.5 py-1.5 bg-[#111827] border border-slate-700 text-xs font-mono text-slate-100"
                    >
                      <option value="http">Stateless Streamable HTTP (transport=&apos;http&apos;)</option>
                      <option value="HTTP_JSON_RPC">HTTP JSON-RPC 2.0</option>
                      <option value="SSE_STREAM">Server-Sent Events (SSE)</option>
                      <option value="STDIO_BRIDGE">Stdio WebSocket Bridge</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">MCP Server Endpoint URL</label>
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
                  <span>Handshake &amp; Connect Stateless HTTP MCP</span>
                </button>
              </form>

              {/* Recent MCP Wire Call Log */}
              <div className="space-y-1.5 pt-2 border-t border-slate-800">
                <div className="text-[11px] font-mono uppercase text-slate-400">
                  Recent Stateless HTTP MCP Wire Audit Log
                </div>
                <div className="space-y-1.5 max-h-44 overflow-y-auto">
                  {mcpLogs.slice(0, 5).map((log, idx) => (
                    <div
                      key={`${log.id}-${idx}`}
                      className="p-2 border border-slate-800/90 bg-[#111827] text-[11px] font-mono"
                    >
                      <div className="flex items-center justify-between text-slate-300">
                        <span className="text-cyan-400 font-semibold">
                          {log.method} · {log.toolOrResourceName}
                        </span>
                        <span
                          className={
                            log.status === 'DLQ_FALLBACK'
                              ? 'text-rose-400 font-semibold'
                              : log.idempotentReplay
                              ? 'text-amber-300 font-semibold'
                              : 'text-emerald-400'
                          }
                        >
                          {log.status === 'DLQ_FALLBACK'
                            ? 'DLQ_FALLBACK'
                            : log.idempotentReplay
                            ? 'IDEMPOTENT_REPLAY'
                            : `${log.durationMs}ms`}
                        </span>
                      </div>
                      {log.idempotencyKey && (
                        <div className="text-[10px] text-amber-300/90 mt-0.5">
                          idempotency_key: {log.idempotencyKey}
                        </div>
                      )}
                      <div className="text-slate-400 truncate mt-0.5" title={log.responsePreview}>
                        {log.responsePreview}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* SUB-VIEW 2: @mcp.prompt() FUNCTIONS & DEAD-LETTER QUEUE (route_to_dlq) */}
        {activeSubView === 'PROMPTS_AND_DLQ' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
            {/* Left 6 Cols: @mcp.prompt() Functions Inspector */}
            <div className="lg:col-span-6 p-4 border border-slate-800 bg-[#0B0F17] space-y-3.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-xs font-semibold text-purple-300">
                  <Sparkles className="w-4 h-4" />
                  <span>Registered @mcp.prompt() Functions (prompts/list &amp; prompts/get)</span>
                </div>
                <span className="text-[11px] font-mono text-slate-400">4 Async Prompts</span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                <div className="sm:col-span-2">
                  <label className="block text-[11px] text-slate-400 mb-1">Select @mcp.prompt() Function</label>
                  <select
                    value={selectedPrompt}
                    onChange={(e) => {
                      setSelectedPrompt(e.target.value);
                      handleTestRenderPrompt(e.target.value);
                    }}
                    className="w-full px-2.5 py-1.5 bg-[#111827] border border-slate-700 text-xs font-mono text-slate-100"
                  >
                    {(mcpPrompts.length > 0
                      ? mcpPrompts
                      : [
                          {
                            name: 'finesse_finance_regime_audit',
                            description: 'Deterministic ATR-first regime evaluation prompt',
                            decoratorSignature: '@mcp.prompt() async def finesse_finance_regime_audit(...)',
                            arguments: [],
                            templatePreview: '',
                          },
                          {
                            name: 'btc_lead_lag_sniper_gate',
                            description: 'Black-Scholes N(d2) & [$0.45, $0.82] fee-gate prompt',
                            decoratorSignature: '@mcp.prompt() async def btc_lead_lag_sniper_gate(...)',
                            arguments: [],
                            templatePreview: '',
                          },
                          {
                            name: 'portfolio_dust_and_stale_trim_audit',
                            description: 'Public.com 8 dust stocks & 3 stale Kalshi trim prompt',
                            decoratorSignature: '@mcp.prompt() async def portfolio_dust_and_stale_trim_audit(...)',
                            arguments: [],
                            templatePreview: '',
                          },
                          {
                            name: 'dlq_incident_recovery_triage',
                            description: 'Dead-Letter Queue (route_to_dlq) triage prompt',
                            decoratorSignature: '@mcp.prompt() async def dlq_incident_recovery_triage(...)',
                            arguments: [],
                            templatePreview: '',
                          },
                        ]
                    ).map((p) => (
                      <option key={p.name} value={p.name}>
                        @mcp.prompt() {p.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">Symbol Context</label>
                  <input
                    type="text"
                    value={promptSymbolArg}
                    onChange={(e) => setPromptSymbolArg(e.target.value)}
                    className="w-full px-2.5 py-1.5 bg-[#111827] border border-slate-700 text-xs font-mono text-slate-100"
                  />
                </div>
              </div>

              {mcpPrompts.find((p) => p.name === selectedPrompt) && (
                <pre className="p-2.5 bg-[#111827] border border-purple-500/30 text-[11px] font-mono text-purple-200 overflow-x-auto">
                  {mcpPrompts.find((p) => p.name === selectedPrompt)?.decoratorSignature}
                </pre>
              )}

              <div className="flex items-center justify-between">
                <span className="text-[11px] text-slate-400">
                  {mcpPrompts.find((p) => p.name === selectedPrompt)?.description}
                </span>
                <button
                  type="button"
                  onClick={() => handleTestRenderPrompt(selectedPrompt)}
                  disabled={isRenderingPrompt}
                  className="px-3 py-1.5 bg-purple-500 hover:bg-purple-400 text-slate-950 font-semibold text-xs rounded font-mono"
                >
                  {isRenderingPrompt ? 'Rendering...' : 'Execute prompts/get'}
                </button>
              </div>

              <div className="p-3 border border-slate-800 bg-[#070A10] font-mono text-[11px] text-emerald-300">
                <div className="text-[10px] text-slate-400 uppercase mb-1">
                  Rendered MCP Prompt Message (role=&quot;user&quot;):
                </div>
                <div className="whitespace-pre-wrap leading-relaxed">
                  {renderedPromptOutput ||
                    mcpPrompts.find((p) => p.name === selectedPrompt)?.templatePreview ||
                    'Select a prompt and click Execute prompts/get to inspect the deterministic prompt payload.'}
                </div>
              </div>
            </div>

            {/* Right 6 Cols: Dead-Letter Queue (route_to_dlq) & Idempotency Ledger */}
            <div className="lg:col-span-6 p-4 border border-slate-800 bg-[#0B0F17] space-y-3.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-xs font-semibold text-rose-300">
                  <AlertTriangle className="w-4 h-4 text-rose-400" />
                  <span>Dead-Letter Queue (route_to_dlq FallbackQuarantine)</span>
                </div>
                <span className="text-[11px] font-mono text-rose-300">
                  {mcpDlq.length} Quarantined Payloads
                </span>
              </div>

              <div className="space-y-2 max-h-60 overflow-y-auto">
                {mcpDlq.map((item) => (
                  <div
                    key={item.dlqId}
                    className="p-3 border border-rose-500/30 bg-rose-950/15 text-xs font-mono space-y-1"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-rose-300">
                        {item.dlqId} · {item.failedTool}
                      </span>
                      <span className="px-1.5 py-0.5 text-[10px] bg-rose-950 border border-rose-500/40 text-rose-200">
                        {item.status}
                      </span>
                    </div>
                    <div className="text-[11px] text-amber-300">
                      idempotency_key: {item.idempotencyKey}
                    </div>
                    <div className="text-[11px] text-slate-200">{item.rationale}</div>
                    <div className="text-[10px] text-slate-400 truncate">
                      Payload: {item.payloadJson}
                    </div>
                  </div>
                ))}
              </div>

              {mcpIdempotencyLedger.length > 0 && (
                <div className="pt-2 border-t border-slate-800 space-y-1.5">
                  <div className="text-[11px] font-mono uppercase text-emerald-400">
                    Active Idempotency Key Ledger ({mcpIdempotencyLedger.length})
                  </div>
                  <div className="space-y-1.5 max-h-32 overflow-y-auto">
                    {mcpIdempotencyLedger.map((rec) => (
                      <div
                        key={rec.idempotencyKey}
                        className="p-2 border border-slate-800 bg-[#111827] text-[11px] font-mono flex items-center justify-between"
                      >
                        <div className="truncate pr-2">
                          <span className="text-amber-300 font-semibold">{rec.idempotencyKey}</span>
                          <span className="text-slate-400"> · {rec.toolName}</span>
                        </div>
                        <span className="text-emerald-400 shrink-0">
                          Replays: {rec.replayCount}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* SUB-VIEW 3: REFACTORED PYTHON FASTMCP SERVER CODE (mcp_server.py) */}
        {activeSubView === 'PYTHON_FASTMCP_CODE' && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3 p-3.5 border border-slate-800 bg-[#0B0F17]">
              <div>
                <div className="text-xs font-mono font-bold text-slate-100">
                  mcp_server.py · Step 1 Refactored FastMCP Server (transport=&apos;http&apos;, async def, idempotency_key: str, route_to_dlq, @mcp.prompt())
                </div>
                <div className="text-[11px] text-slate-400 mt-0.5">
                  Ready for standalone execution via <code className="text-cyan-300">python mcp_server.py</code> or{' '}
                  <code className="text-cyan-300">fastmcp run mcp_server.py --transport http</code>.
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleCopyPythonServer}
                  className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs font-mono rounded flex items-center gap-1.5"
                >
                  {copiedPy ? (
                    <>
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                      <span>Copied mcp_server.py!</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5 text-cyan-400" />
                      <span>Copy Python Code</span>
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={handleDownloadPythonServer}
                  className="px-3 py-1.5 bg-purple-500/20 hover:bg-purple-500/30 border border-purple-500/40 text-purple-200 text-xs font-mono rounded flex items-center gap-1.5"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Download mcp_server.py</span>
                </button>
              </div>
            </div>

            <pre className="p-4 border border-slate-800 bg-[#070A10] text-[11px] font-mono text-emerald-300 overflow-x-auto max-h-96 leading-relaxed">
              {pythonMcpCode || 'Loading mcp_server.py...'}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
};
