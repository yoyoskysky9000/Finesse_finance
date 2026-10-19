import React, { useState } from 'react';
import type {
  ExecutedOrder,
  MarketFeatureVector,
  QuantitativeRegimeAssessment,
} from '../types/quant.ts';

interface PriceEnvelopeChartProps {
  feature: MarketFeatureVector;
  assessment: QuantitativeRegimeAssessment;
  orders?: ExecutedOrder[];
}

export const PriceEnvelopeChart: React.FC<PriceEnvelopeChartProps> = ({
  feature,
  assessment,
  orders = [],
}) => {
  const [showTradeOverlay, setShowTradeOverlay] = useState<boolean>(true);
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [hoveredOrderId, setHoveredOrderId] = useState<string | null>(null);

  const bars = feature.bars || [];
  if (bars.length === 0) {
    return (
      <div className="h-64 flex items-center justify-center border border-slate-800 bg-slate-900/40 text-sm text-slate-400">
        No time-series bar history available for {feature.symbol}.
      </div>
    );
  }

  // Filter executed orders belonging to the currently selected instrument
  const symbolOrders = orders.filter((o) => o.symbol === feature.symbol);
  const activeInspectOrderId = hoveredOrderId || selectedOrderId || symbolOrders[0]?.id || null;
  const inspectedOrder = symbolOrders.find((o) => o.id === activeInspectOrderId) || null;

  const width = 760;
  const height = 256;
  const padLeft = 14;
  const padRight = 72;
  const padTop = 20;
  const padBottom = 26;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  // Include trade fill prices and active OCO stop-loss / take-profit brackets in Y-axis domain
  const tradeValues: number[] = [];
  if (showTradeOverlay && symbolOrders.length > 0) {
    for (const ord of symbolOrders) {
      tradeValues.push(ord.fillPrice);
      if (ord.id === activeInspectOrderId || ord.status === 'WORKING_OCO') {
        tradeValues.push(ord.stopLossPrice, ord.takeProfitPrice);
      }
    }
  }

  const allValues = [
    ...bars.map((b) => b.high),
    ...bars.map((b) => b.low),
    ...bars.map((b) => b.vwap),
    assessment.support_level,
    assessment.resistance_level,
    feature.price + feature.atr14,
    Math.max(0.01, feature.price - feature.atr14),
    ...tradeValues,
  ];

  const minPrice = Math.min(...allValues) * 0.995;
  const maxPrice = Math.max(...allValues) * 1.005;
  const range = Math.max(0.0001, maxPrice - minPrice);

  const toX = (idx: number) => padLeft + (idx / Math.max(1, bars.length - 1)) * plotW;
  const toY = (val: number) => padTop + plotH - ((val - minPrice) / range) * plotH;

  // Map each order timestamp to the closest OHLCV bar index
  const mapOrderToBarIndex = (orderTimestamp: string, fallbackIdx: number): number => {
    const targetMs = new Date(orderTimestamp).getTime();
    if (Number.isNaN(targetMs)) return Math.min(bars.length - 1, Math.max(0, fallbackIdx));
    let bestIdx = bars.length - 1;
    let bestDiff = Infinity;
    bars.forEach((b, idx) => {
      const diff = Math.abs(new Date(b.timestamp).getTime() - targetMs);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestIdx = idx;
      }
    });
    return bestIdx;
  };

  // Compute live P&L for an executed order relative to current market price
  const computeOrderPnl = (ord: ExecutedOrder) => {
    const isLong = ord.side === 'BUY' || ord.side === 'BUY_YES';
    const priceDiff = isLong ? feature.price - ord.fillPrice : ord.fillPrice - feature.price;
    const pnlUsd = priceDiff * ord.quantity;
    const pnlPct = (priceDiff / Math.max(0.0001, ord.fillPrice)) * 100;
    return { pnlUsd, pnlPct, isLong };
  };

  // Build SVG polyline paths for Close Price, VWAP, and Upper/Lower ATR envelope
  const closePoints = bars.map((b, i) => `${toX(i).toFixed(1)},${toY(b.close).toFixed(1)}`).join(' ');
  const vwapPoints = bars.map((b, i) => `${toX(i).toFixed(1)},${toY(b.vwap).toFixed(1)}`).join(' ');

  const upperAtrPoints = bars
    .map((b, i) => `${toX(i).toFixed(1)},${toY(b.close + feature.atr14).toFixed(1)}`)
    .join(' ');
  const lowerAtrPoints = [...bars]
    .reverse()
    .map((b, revIdx) => {
      const i = bars.length - 1 - revIdx;
      return `${toX(i).toFixed(1)},${toY(Math.max(0.01, b.close - feature.atr14)).toFixed(1)}`;
    })
    .join(' ');
  const atrBandPolygon = `${upperAtrPoints} ${lowerAtrPoints}`;

  const yResistance = toY(assessment.resistance_level);
  const ySupport = toY(assessment.support_level);
  const yCurrent = toY(feature.price);
  const decimals = feature.price < 2 ? 4 : 2;

  return (
    <div className="w-full space-y-2.5">
      {/* Chart Header & Overlay Controls */}
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-slate-400">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="text-slate-200 font-medium">{feature.symbol} Price & Volatility Envelope</span>
          <span aria-hidden="true">·</span>
          <span className="font-mono tabular-nums text-cyan-400">Close {feature.price.toFixed(decimals)}</span>
          <span aria-hidden="true">·</span>
          <span className="font-mono tabular-nums text-amber-400">VWAP {feature.vwap.toFixed(decimals)}</span>
          <span aria-hidden="true">·</span>
          <span className="font-mono tabular-nums text-slate-300">
            ±1 ATR ({feature.atr14.toFixed(decimals)})
          </span>
        </div>
        <div className="flex items-center gap-3">
          <div className="hidden sm:flex items-center gap-2 font-mono tabular-nums text-[11px]">
            <span className="text-emerald-400">RES {assessment.resistance_level.toFixed(decimals)}</span>
            <span aria-hidden="true">·</span>
            <span className="text-rose-400">SUP {assessment.support_level.toFixed(decimals)}</span>
          </div>
          <button
            type="button"
            onClick={() => setShowTradeOverlay((prev) => !prev)}
            className={`px-2.5 py-1 rounded text-[11px] font-medium border transition-colors whitespace-nowrap ${
              showTradeOverlay
                ? 'bg-cyan-950/50 border-cyan-500/50 text-cyan-300'
                : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
            }`}
          >
            {showTradeOverlay
              ? `Fills & OCO Brackets (${symbolOrders.length})`
              : `Show Trade Fills (${symbolOrders.length})`}
          </button>
        </div>
      </div>

      {/* SVG Price, Envelope & Executed Fill Canvas */}
      <div className="border border-slate-800 bg-[#080C14] p-2 relative">
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-60 overflow-visible">
          {/* Horizontal Reference Grid Lines */}
          {[0.2, 0.5, 0.8].map((ratio) => {
            const y = padTop + plotH * ratio;
            const val = maxPrice - ratio * range;
            return (
              <g key={ratio}>
                <line
                  x1={padLeft}
                  y1={y}
                  x2={width - padRight}
                  y2={y}
                  stroke="#1E293B"
                  strokeDasharray="2 4"
                  strokeWidth="1"
                />
                <text
                  x={width - padRight + 6}
                  y={y + 3}
                  fill="#64748B"
                  fontSize="10"
                  fontFamily="JetBrains Mono, monospace"
                >
                  {val.toFixed(decimals)}
                </text>
              </g>
            );
          })}

          {/* Shaded Rolling ±1 ATR(14) Volatility Channel */}
          <polygon points={atrBandPolygon} fill="rgba(6, 182, 212, 0.08)" />

          {/* Resistance Envelope Line */}
          <line
            x1={padLeft}
            y1={yResistance}
            x2={width - padRight}
            y2={yResistance}
            stroke="#10B981"
            strokeDasharray="4 4"
            strokeWidth="1.2"
          />
          <text
            x={width - padRight + 6}
            y={yResistance + 3}
            fill="#10B981"
            fontSize="10"
            fontFamily="JetBrains Mono, monospace"
          >
            R {assessment.resistance_level.toFixed(decimals)}
          </text>

          {/* Support Envelope Line */}
          <line
            x1={padLeft}
            y1={ySupport}
            x2={width - padRight}
            y2={ySupport}
            stroke="#EF4444"
            strokeDasharray="4 4"
            strokeWidth="1.2"
          />
          <text
            x={width - padRight + 6}
            y={ySupport + 3}
            fill="#EF4444"
            fontSize="10"
            fontFamily="JetBrains Mono, monospace"
          >
            S {assessment.support_level.toFixed(decimals)}
          </text>

          {/* Anchored VWAP Line */}
          <polyline
            fill="none"
            stroke="#F59E0B"
            strokeWidth="1.5"
            strokeDasharray="3 3"
            points={vwapPoints}
          />

          {/* OHLC High-Low Wicks */}
          {bars.map((bar, idx) => {
            const x = toX(idx);
            const isUp = bar.close >= bar.open;
            return (
              <line
                key={`${bar.timestamp}-${idx}`}
                x1={x}
                y1={toY(bar.high)}
                x2={x}
                y2={toY(bar.low)}
                stroke={isUp ? 'rgba(16, 185, 129, 0.35)' : 'rgba(239, 68, 68, 0.35)'}
                strokeWidth="1.5"
              />
            );
          })}

          {/* Primary Close Price Line */}
          <polyline fill="none" stroke="#06B6D4" strokeWidth="2" points={closePoints} />

          {/* Latest Price Anchor */}
          <circle cx={toX(bars.length - 1)} cy={yCurrent} r="3.5" fill="#06B6D4" />

          {/* Executed Trade Fill Markers & Active OCO Stop-Loss / Take-Profit Bracket Lines */}
          {showTradeOverlay &&
            symbolOrders.map((ord, orderIndex) => {
              const barIdx = mapOrderToBarIndex(ord.timestamp, bars.length - 1 - orderIndex * 6);
              const cx = toX(barIdx);
              const cy = toY(ord.fillPrice);
              const yTP = toY(ord.takeProfitPrice);
              const ySL = toY(ord.stopLossPrice);
              const isBuy = ord.side === 'BUY' || ord.side === 'BUY_YES';
              const isFocused = ord.id === activeInspectOrderId;
              const isHalted = ord.status === 'CANCELLED_BY_KILL_SWITCH';
              const markerColor = isHalted ? '#F59E0B' : isBuy ? '#10B981' : '#EF4444';
              const bracketEndX = Math.min(width - padRight, cx + (isFocused ? 140 : 52));

              // Directional Triangle Polygon Points
              const triPoints = isBuy
                ? `${cx},${cy - 7} ${cx - 6.5},${cy + 5.5} ${cx + 6.5},${cy + 5.5}`
                : `${cx},${cy + 7} ${cx - 6.5},${cy - 5.5} ${cx + 6.5},${cy - 5.5}`;

              return (
                <g
                  key={ord.id}
                  className="cursor-pointer"
                  onMouseEnter={() => setHoveredOrderId(ord.id)}
                  onMouseLeave={() => setHoveredOrderId(null)}
                  onClick={() => setSelectedOrderId(ord.id)}
                >
                  {/* Vertical Risk-Reward OCO Bracket Stem & Horizontal TP/SL Projections */}
                  {(isFocused || ord.status === 'WORKING_OCO') && (
                    <g opacity={isFocused ? 0.95 : 0.45}>
                      {/* Vertical stem connecting Take-Profit, Fill Price, and Stop-Loss */}
                      <line
                        x1={cx}
                        y1={yTP}
                        x2={cx}
                        y2={ySL}
                        stroke="#64748B"
                        strokeDasharray="2 2"
                        strokeWidth={isFocused ? '1.3' : '1'}
                      />
                      {/* Take-Profit OCO Bracket Projection */}
                      <line
                        x1={cx}
                        y1={yTP}
                        x2={bracketEndX}
                        y2={yTP}
                        stroke="#10B981"
                        strokeDasharray="3 2"
                        strokeWidth={isFocused ? '1.5' : '1'}
                      />
                      {/* Stop-Loss OCO Bracket Projection */}
                      <line
                        x1={cx}
                        y1={ySL}
                        x2={bracketEndX}
                        y2={ySL}
                        stroke="#EF4444"
                        strokeDasharray="3 2"
                        strokeWidth={isFocused ? '1.5' : '1'}
                      />
                      {/* Fill Entry Projection Line */}
                      <line
                        x1={cx}
                        y1={cy}
                        x2={bracketEndX}
                        y2={cy}
                        stroke={markerColor}
                        strokeWidth="1"
                        strokeOpacity="0.6"
                      />
                      {isFocused && (
                        <>
                          <text
                            x={bracketEndX + 4}
                            y={yTP + 3}
                            fill="#10B981"
                            fontSize="9.5"
                            fontFamily="JetBrains Mono, monospace"
                          >
                            TP {ord.takeProfitPrice.toFixed(decimals)}
                          </text>
                          <text
                            x={bracketEndX + 4}
                            y={ySL + 3}
                            fill="#EF4444"
                            fontSize="9.5"
                            fontFamily="JetBrains Mono, monospace"
                          >
                            SL {ord.stopLossPrice.toFixed(decimals)}
                          </text>
                        </>
                      )}
                    </g>
                  )}

                  {/* Outer Focus Halo when Inspected */}
                  {isFocused && (
                    <circle
                      cx={cx}
                      cy={cy}
                      r="11"
                      fill="none"
                      stroke={markerColor}
                      strokeWidth="1.5"
                      strokeOpacity="0.55"
                    />
                  )}

                  {/* Directional Fill Marker Triangle */}
                  <polygon
                    points={triPoints}
                    fill={markerColor}
                    stroke="#080C14"
                    strokeWidth="1.5"
                  />

                  {/* Inline Fill Price Tag */}
                  <text
                    x={cx}
                    y={isBuy ? cy + 16 : cy - 11}
                    textAnchor="middle"
                    fill={isFocused ? '#F8FAFC' : '#94A3B8'}
                    fontSize="9.5"
                    fontWeight={isFocused ? '600' : '400'}
                    fontFamily="JetBrains Mono, monospace"
                  >
                    {ord.side} {ord.fillPrice.toFixed(decimals)}
                  </text>
                </g>
              );
            })}
        </svg>
      </div>

      {/* Interactive Trade Fill Inspection Popover & Plotted Execution Selector Strip */}
      {showTradeOverlay && symbolOrders.length > 0 && (
        <div className="border border-slate-800 bg-[#0B0F17] p-3 space-y-2.5 text-xs">
          {/* Plotted Trade Fill Selector Buttons */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-slate-400 font-medium">
              Plotted Agent Executions ({symbolOrders.length}) — Click or hover marker to inspect OCO brackets:
            </span>
            <div className="flex flex-wrap items-center gap-1.5">
              {symbolOrders.map((ord) => {
                const isSelected = ord.id === activeInspectOrderId;
                const { pnlUsd } = computeOrderPnl(ord);
                return (
                  <button
                    key={ord.id}
                    type="button"
                    onClick={() => setSelectedOrderId(ord.id)}
                    onMouseEnter={() => setHoveredOrderId(ord.id)}
                    onMouseLeave={() => setHoveredOrderId(null)}
                    className={`px-2.5 py-1 rounded font-mono text-[11px] border transition-colors whitespace-nowrap ${
                      isSelected
                        ? 'bg-slate-800 border-cyan-500/60 text-slate-100'
                        : 'bg-[#080C14] border-slate-800 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <span>
                      {ord.side === 'BUY' || ord.side === 'BUY_YES' ? '▲' : '▼'} {ord.id} @{' '}
                      {ord.fillPrice.toFixed(decimals)}
                    </span>
                    <span
                      className={`ml-1.5 ${
                        pnlUsd >= 0 ? 'text-emerald-400' : 'text-rose-400'
                      }`}
                    >
                      ({pnlUsd >= 0 ? '+' : ''}${pnlUsd.toFixed(0)})
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Detailed Inspection Card for Active Trade Marker */}
          {inspectedOrder && (() => {
            const { pnlUsd, pnlPct } = computeOrderPnl(inspectedOrder);
            return (
              <div className="pt-2 border-t border-slate-800/90 grid grid-cols-1 sm:grid-cols-12 gap-3 items-center">
                <div className="sm:col-span-5">
                  <div className="font-semibold text-slate-100 truncate">
                    {inspectedOrder.agentName}
                  </div>
                  <div className="text-[11px] text-slate-400 font-mono mt-0.5">
                    {inspectedOrder.id} · {inspectedOrder.side} × {inspectedOrder.quantity} ·{' '}
                    <span className="text-cyan-400">{inspectedOrder.regimeAtEntry}</span> ·{' '}
                    <span>{inspectedOrder.status}</span>
                  </div>
                </div>

                <div className="sm:col-span-4 font-mono tabular-nums text-[11px] flex items-center gap-3">
                  <div>
                    <span className="text-slate-400 block">Fill Price</span>
                    <span className="text-slate-100 font-semibold">
                      {inspectedOrder.fillPrice.toFixed(decimals)}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400 block">OCO Stop</span>
                    <span className="text-rose-400 font-semibold">
                      {inspectedOrder.stopLossPrice.toFixed(decimals)}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400 block">OCO Target</span>
                    <span className="text-emerald-400 font-semibold">
                      {inspectedOrder.takeProfitPrice.toFixed(decimals)}
                    </span>
                  </div>
                </div>

                <div className="sm:col-span-3 sm:text-right font-mono tabular-nums">
                  <div className="text-[11px] text-slate-400">Live Fill Performance</div>
                  <div
                    className={`text-xs font-bold ${
                      pnlUsd >= 0 ? 'text-emerald-400' : 'text-rose-400'
                    }`}
                  >
                    {pnlUsd >= 0 ? '+' : ''}${pnlUsd.toFixed(2)} ({pnlPct >= 0 ? '+' : ''}
                    {pnlPct.toFixed(2)}%)
                  </div>
                </div>
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
};
