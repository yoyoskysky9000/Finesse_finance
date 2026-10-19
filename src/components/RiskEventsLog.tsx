import React, { useState, useMemo } from 'react';
import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  Clock,
  Filter,
  Search,
  ShieldAlert,
  Zap,
} from 'lucide-react';
import type {
  RiskEventNotification,
  RiskEventType,
  StrategyArchetype,
} from '../types/quant.ts';

interface RiskEventsLogProps {
  events: RiskEventNotification[];
  selectedSymbol: string;
  onAcknowledgeEvent: (eventId?: string, acknowledgeAll?: boolean) => Promise<void>;
  onSimulateAtrShock: (symbol: string) => Promise<void>;
  onSelectSymbol?: (symbol: string) => void;
}

const EVENT_TYPE_LABELS: Record<
  RiskEventType,
  { label: string; shortLabel: string; textClass: string; borderClass: string; bgClass: string }
> = {
  ATR_SPIKE_HALT: {
    label: 'ATR Volatility Spike Halt',
    shortLabel: 'ATR_SPIKE_HALT',
    textClass: 'text-rose-400',
    borderClass: 'border-rose-500/40',
    bgClass: 'bg-rose-950/25',
  },
  MAX_DRAWDOWN_BREACH: {
    label: 'Max Drawdown Limit Breach',
    shortLabel: 'MAX_DRAWDOWN_BREACH',
    textClass: 'text-amber-400',
    borderClass: 'border-amber-500/40',
    bgClass: 'bg-amber-950/25',
  },
  GLOBAL_KILL_SWITCH: {
    label: 'Global Emergency Kill-Switch',
    shortLabel: 'GLOBAL_KILL_SWITCH',
    textClass: 'text-rose-300',
    borderClass: 'border-rose-500/60',
    bgClass: 'bg-rose-950/40',
  },
  SPREAD_LIQUIDITY_GUARD: {
    label: 'CLOB Spread & Liquidity Guard',
    shortLabel: 'SPREAD_LIQUIDITY_GUARD',
    textClass: 'text-cyan-400',
    borderClass: 'border-cyan-500/40',
    bgClass: 'bg-cyan-950/25',
  },
  CIRCUIT_BREAKER_RESET: {
    label: 'Circuit-Breaker Normalized / Reset',
    shortLabel: 'CIRCUIT_BREAKER_RESET',
    textClass: 'text-emerald-400',
    borderClass: 'border-emerald-500/40',
    bgClass: 'bg-emerald-950/20',
  },
};

export const RiskEventsLog: React.FC<RiskEventsLogProps> = ({
  events,
  selectedSymbol,
  onAcknowledgeEvent,
  onSimulateAtrShock,
  onSelectSymbol,
}) => {
  const [typeFilter, setTypeFilter] = useState<'ALL' | RiskEventType>('ALL');
  const [archetypeFilter, setArchetypeFilter] = useState<'ALL' | StrategyArchetype>('ALL');
  const [onlyUnacknowledged, setOnlyUnacknowledged] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');

  const filteredEvents = useMemo(() => {
    return events.filter((ev) => {
      if (typeFilter !== 'ALL' && ev.eventType !== typeFilter) return false;
      if (archetypeFilter !== 'ALL' && ev.archetype !== archetypeFilter) return false;
      if (onlyUnacknowledged && ev.acknowledged) return false;
      if (searchQuery.trim().length > 0) {
        const q = searchQuery.toLowerCase();
        const matchAgent = ev.agentName.toLowerCase().includes(q) || ev.agentId.toLowerCase().includes(q);
        const matchSymbol = ev.symbol.toLowerCase().includes(q);
        const matchMetric = ev.triggerMetric.toLowerCase().includes(q);
        const matchOrders = ev.cancelledOrderIds.some((id) => id.toLowerCase().includes(q));
        if (!matchAgent && !matchSymbol && !matchMetric && !matchOrders) return false;
      }
      return true;
    });
  }, [events, typeFilter, archetypeFilter, onlyUnacknowledged, searchQuery]);

  const unacknowledgedCount = useMemo(
    () => events.filter((e) => !e.acknowledged).length,
    [events]
  );
  const atrHaltCount = useMemo(
    () => events.filter((e) => e.eventType === 'ATR_SPIKE_HALT').length,
    [events]
  );
  const drawdownBreachCount = useMemo(
    () => events.filter((e) => e.eventType === 'MAX_DRAWDOWN_BREACH').length,
    [events]
  );

  const formatTimestamp = (iso: string) => {
    const d = new Date(iso);
    const timeStr = d.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    const dateStr = d.toLocaleDateString([], { month: 'short', day: '2-digit' });
    const diffMin = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
    const relStr =
      diffMin === 0
        ? 'Just now'
        : diffMin < 60
        ? `${diffMin}m ago`
        : `${Math.floor(diffMin / 60)}h ${diffMin % 60}m ago`;
    return { timeStr, dateStr, relStr };
  };

  return (
    <div className="p-5 border border-slate-800 bg-[#111827] space-y-4">
      {/* Header & Summary Telemetry Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-3.5">
        <div>
          <div className="flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 text-amber-400" />
            <h2 className="text-base font-semibold text-slate-100">
              Risk Events &amp; Historical Circuit-Breaker Notification Log
            </h2>
            {unacknowledgedCount > 0 && (
              <span className="px-2 py-0.5 text-[11px] font-mono font-semibold bg-rose-950/80 border border-rose-500/50 text-rose-300">
                {unacknowledgedCount} UNACKNOWLEDGED
              </span>
            )}
          </div>
          <p className="text-xs text-slate-400 mt-0.5">
            Real-time and historical audit trail of autonomous ATR volatility spike halts, max drawdown breaches, CLOB liquidity guards, and OCO cancellations.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => onSimulateAtrShock(selectedSymbol)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 border border-amber-500/30 rounded transition-colors"
          >
            <Zap className="w-3.5 h-3.5" />
            Trigger {selectedSymbol} ATR Spike Drill
          </button>
          {unacknowledgedCount > 0 && (
            <button
              type="button"
              onClick={() => onAcknowledgeEvent(undefined, true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded transition-colors"
            >
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
              Acknowledge All ({unacknowledgedCount})
            </button>
          )}
        </div>
      </div>

      {/* KPI Counter Row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
        <div className="p-3 bg-[#0B0F17] border border-slate-800">
          <div className="text-slate-400">Total Logged Triggers</div>
          <div className="text-lg font-bold font-mono text-slate-100 tabular-nums mt-0.5">
            {events.length}
          </div>
          <div className="text-[11px] text-slate-400 font-mono">
            Showing {filteredEvents.length} matching filter
          </div>
        </div>
        <div className="p-3 bg-[#0B0F17] border border-slate-800">
          <div className="text-slate-400">ATR Volatility Spike Halts</div>
          <div className="text-lg font-bold font-mono text-rose-400 tabular-nums mt-0.5">
            {atrHaltCount}
          </div>
          <div className="text-[11px] text-slate-400 font-mono">
            Rolling ATR(14) &gt; threshold
          </div>
        </div>
        <div className="p-3 bg-[#0B0F17] border border-slate-800">
          <div className="text-slate-400">Max Drawdown Breaches</div>
          <div className="text-lg font-bold font-mono text-amber-400 tabular-nums mt-0.5">
            {drawdownBreachCount}
          </div>
          <div className="text-[11px] text-slate-400 font-mono">
            Trailing equity stop-out
          </div>
        </div>
        <div className="p-3 bg-[#0B0F17] border border-slate-800">
          <div className="text-slate-400">Active Unacknowledged Alerts</div>
          <div
            className={`text-lg font-bold font-mono tabular-nums mt-0.5 ${
              unacknowledgedCount > 0 ? 'text-rose-400' : 'text-emerald-400'
            }`}
          >
            {unacknowledgedCount}
          </div>
          <div className="text-[11px] text-slate-400 font-mono">
            {unacknowledgedCount > 0 ? 'Operator review required' : 'All triggers reviewed'}
          </div>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
        {/* Trigger Type Filter Buttons */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] font-mono text-slate-400 flex items-center gap-1 mr-1">
            <Filter className="w-3 h-3" /> TRIGGER:
          </span>
          {(
            [
              { id: 'ALL', label: 'All Events' },
              { id: 'ATR_SPIKE_HALT', label: 'ATR Spike Halts' },
              { id: 'MAX_DRAWDOWN_BREACH', label: 'Max Drawdown' },
              { id: 'GLOBAL_KILL_SWITCH', label: 'Global Kill-Switch' },
              { id: 'SPREAD_LIQUIDITY_GUARD', label: 'Spread Guard' },
              { id: 'CIRCUIT_BREAKER_RESET', label: 'Resets' },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setTypeFilter(tab.id)}
              className={`px-2.5 py-1 text-xs font-mono rounded border transition-colors ${
                typeFilter === tab.id
                  ? 'bg-cyan-500/15 text-cyan-300 border-cyan-500/40 font-semibold'
                  : 'bg-[#0B0F17] text-slate-400 border-slate-800 hover:text-slate-200'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Archetype, Unacknowledged Toggle & Search Input */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center bg-[#0B0F17] border border-slate-800 rounded p-0.5 text-xs">
            <button
              type="button"
              onClick={() => setArchetypeFilter('ALL')}
              className={`px-2 py-1 rounded ${
                archetypeFilter === 'ALL' ? 'bg-slate-800 text-slate-100' : 'text-slate-400'
              }`}
            >
              All Strategies
            </button>
            <button
              type="button"
              onClick={() => setArchetypeFilter('LONG_AND_LOW')}
              className={`px-2 py-1 rounded ${
                archetypeFilter === 'LONG_AND_LOW' ? 'bg-slate-800 text-cyan-400' : 'text-slate-400'
              }`}
            >
              Long &amp; Low
            </button>
            <button
              type="button"
              onClick={() => setArchetypeFilter('SHORT_AND_FAST')}
              className={`px-2 py-1 rounded ${
                archetypeFilter === 'SHORT_AND_FAST' ? 'bg-slate-800 text-emerald-400' : 'text-slate-400'
              }`}
            >
              Short &amp; Fast
            </button>
          </div>

          <button
            type="button"
            onClick={() => setOnlyUnacknowledged(!onlyUnacknowledged)}
            className={`px-2.5 py-1.5 text-xs font-mono border rounded transition-colors ${
              onlyUnacknowledged
                ? 'bg-rose-950/50 border-rose-500/50 text-rose-300'
                : 'bg-[#0B0F17] border-slate-800 text-slate-400 hover:text-slate-200'
            }`}
          >
            <Bell className="w-3 h-3 inline mr-1" />
            Unread Only
          </button>

          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter agent, symbol, order ID..."
              className="pl-8 pr-3 py-1.5 text-xs bg-[#0B0F17] border border-slate-800 text-slate-100 rounded focus:outline-none focus:border-cyan-400 w-52"
            />
          </div>
        </div>
      </div>

      {/* Notification Log Entries */}
      <div className="space-y-2.5">
        {filteredEvents.length === 0 ? (
          <div className="p-8 text-center border border-slate-800 bg-[#0B0F17] text-xs text-slate-400">
            No circuit-breaker or risk notification events match the active filter criteria.
          </div>
        ) : (
          filteredEvents.map((ev) => {
            const meta = EVENT_TYPE_LABELS[ev.eventType];
            const ts = formatTimestamp(ev.timestamp);
            return (
              <div
                key={ev.id}
                className={`p-3.5 border transition-colors ${
                  !ev.acknowledged
                    ? `${meta.borderClass} ${meta.bgClass}`
                    : 'border-slate-800 bg-[#0B0F17]/90 hover:border-slate-700'
                }`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  {/* Left: Timestamp, Severity, Event Badge & Agent Details */}
                  <div className="space-y-1.5 flex-1 min-w-[280px]">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="font-mono text-slate-400 flex items-center gap-1 tabular-nums">
                        <Clock className="w-3 h-3 text-slate-500" />
                        {ts.dateStr} {ts.timeStr}
                        <span className="text-slate-500">({ts.relStr})</span>
                      </span>

                      <span className="text-slate-600">·</span>

                      <span className={`font-mono font-semibold ${meta.textClass}`}>
                        {meta.shortLabel}
                      </span>

                      <span className="text-slate-600">·</span>

                      <button
                        type="button"
                        onClick={() => {
                          if (onSelectSymbol && ev.symbol !== 'ALL-VENUES') {
                            onSelectSymbol(ev.symbol);
                          }
                        }}
                        className="font-mono font-bold text-slate-100 hover:text-cyan-400 transition-colors"
                      >
                        {ev.symbol}
                      </button>

                      <span className="font-mono text-[11px] text-slate-400">
                        [{ev.archetype} · {ev.venue === 'PUBLIC_BROKERAGE' ? 'Public.com' : 'Prediction CLOB'}]
                      </span>

                      <span className="font-mono text-[11px] text-slate-500">ID: {ev.id}</span>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-semibold text-slate-100">{ev.agentName}</span>
                      <span className="text-[11px] font-mono text-slate-400">({ev.agentId})</span>
                    </div>

                    <p className="text-xs text-slate-300 leading-relaxed">{ev.actionTaken}</p>
                  </div>

                  {/* Right: Threshold vs Observed Telemetry & Acknowledge Control */}
                  <div className="flex flex-col sm:items-end justify-between gap-2 shrink-0">
                    <div className="p-2 bg-[#080C14] border border-slate-800/90 text-[11px] font-mono tabular-nums space-y-0.5 min-w-[250px]">
                      <div className="text-slate-400 truncate">{ev.triggerMetric}</div>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-slate-500">Threshold:</span>
                        <span className="text-slate-300">{ev.thresholdValue}</span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-slate-500">Observed:</span>
                        <span className={`font-semibold ${meta.textClass}`}>{ev.observedValue}</span>
                      </div>
                      {ev.cancelledOrderIds.length > 0 && (
                        <div className="flex items-center justify-between gap-3 pt-0.5 border-t border-slate-800/80">
                          <span className="text-slate-500">Cancelled OCO:</span>
                          <span className="text-rose-400">{ev.cancelledOrderIds.join(', ')}</span>
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-2 self-end">
                      <button
                        type="button"
                        onClick={() => onAcknowledgeEvent(ev.id, false)}
                        className={`px-2.5 py-1 text-[11px] font-mono rounded border transition-colors flex items-center gap-1 ${
                          ev.acknowledged
                            ? 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                            : 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/25'
                        }`}
                      >
                        {ev.acknowledged ? (
                          <>
                            <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                            Acknowledged
                          </>
                        ) : (
                          <>
                            <AlertTriangle className="w-3 h-3 text-amber-400" />
                            Acknowledge Trigger
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
