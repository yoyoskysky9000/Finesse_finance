# Executed Trade Fill & OCO Bracket Visualization on PriceEnvelopeChart

Enhances the `PriceEnvelopeChart` visualization component to plot historical and active autonomous agent trade executions directly on the time-series price and ATR volatility envelope canvas, complete with directional fill markers, OCO stop-loss/take-profit bracket projections, and an interactive inspection popover.

## User Review & Critical Decisions

> [!IMPORTANT]
> The following visualization and interaction decisions have been confirmed from your clarifications:

- **Confirmed Chart Overlay Mode**: **Directional Fill Markers with Active OCO Stop-Loss & Take-Profit Bracket Lines** — Executed trades for the selected symbol are mapped to their closest historical OHLCV bar timestamp on the X-axis and `fillPrice` on the Y-axis, displaying directional entry markers (`BUY` / `BUY_YES` upward emerald triangles, `SELL` / `BUY_NO` downward rose triangles) alongside projected OCO `stopLossPrice` and `takeProfitPrice` bracket lines.
- **Confirmed Inspection Interaction**: **Interactive Hover & Click Popover** — Hovering or clicking any plotted trade fill marker opens a high-density telemetry popover displaying the executing agent's name, order ID, side & quantity, `regimeAtEntry`, `fillPrice`, OCO `stopLossPrice` / `takeProfitPrice` levels, and real-time unrealized/realized P&L calculated against the current market price.

---

## 1. Overview & Core Concept

- **What It Does**: Bridges the gap between time-series market features (OHLCV, Anchored VWAP, $\pm 1\text{ ATR}$ volatility channel) and autonomous agent execution history by plotting every executed trade for the selected symbol directly onto the chart canvas. Operators can immediately see where "Long and Low" or "Short and Fast" agents entered relative to VWAP and ATR bands, how wide their OCO risk brackets sit relative to deterministic support/resistance, and how much unrealized P&L each fill is generating.
- **Target Audience / Persona**: Quantitative portfolio operators auditing whether autonomous agents are executing entries at optimal mean-reversion or breakout levels and verifying that OCO stop-loss brackets align with rolling ATR envelopes.
- **Key Value**: Provides instant visual verification of historical agent execution quality, entry timing, and active risk-to-reward geometry without cross-referencing raw order tables.

---

## 2. User Experience & Visual Design

- **Key User Flows**:
  1. **Automatic Trade Marker Plotting**: Selecting any tracked instrument (e.g., `NVDA`, `TLT`, `KX-FED-CUT-25BPS`) filters the executed order ledger for matching symbol fills and plots each trade at its corresponding bar index and fill price.
  2. **OCO Bracket Visualization Toggle**: Users can toggle the visibility of trade fill markers and OCO bracket projections (`Show Fills & OCO Brackets`) in the chart header toolbar.
  3. **Interactive Marker Hover & Pinning**: Hovering over or clicking a trade marker highlights that specific order's `takeProfitPrice` (emerald dashed segment) and `stopLossPrice` (crimson dashed segment) connected by a vertical risk-reward stem, and opens the inspection popover with live P&L telemetry.
  4. **Historical Execution Summary Strip**: Directly beneath the SVG canvas, a compact execution strip lists all plotted fills on the current chart so users can also click an order chip to focus and pin its marker on the chart.
- **Visual Identity & Theme**:
  - *Aesthetic Direction*: Institutional quantitative terminal precision—crisp vector geometry, tabular numerals (`JetBrains Mono`), and high-contrast semantic markers on the `#080C14` chart canvas.
  - *Marker & Bracket Color Semantics*:
    - `BUY` / `BUY_YES` Fill Marker: Emerald (`#10B981`) upward-pointing vector triangle with subtle outer halo when selected.
    - `SELL` / `BUY_NO` Fill Marker: Rose (`#EF4444`) downward-pointing vector triangle.
    - Active OCO Brackets: Emerald horizontal target segment for `takeProfitPrice` and Rose horizontal stop segment for `stopLossPrice`, linked to the fill marker via a vertical hairline connector.
    - Cancelled / Halted Orders: Muted amber/slate marker ring (`#F59E0B`) indicating the OCO bracket was terminated by the circuit breaker.

---

## 3. Key Product Decisions & Trade-Offs

- **Decision 1: Dynamic Y-Axis Domain Scaling for OCO Brackets**
  - *Chosen Approach*: Include plotted trade `fillPrice` values—and, when an order is focused or OCO brackets are toggled on, its `stopLossPrice` and `takeProfitPrice`—in the SVG Y-axis min/max domain calculation.
  - *Why*: Ensures that wide "Long and Low" OCO brackets ($2.5\times\text{ATR}$ stop / $4.5\times\text{ATR}$ target) never clip outside the SVG viewport.
- **Decision 2: Deterministic Bar Timestamp Alignment & Seeded Multi-Fill History**
  - *Chosen Approach*: Match each `ExecutedOrder.timestamp` to the closest `OHLCVBar.timestamp` in the 36-bar window, and seed realistic historical fills across all tracked symbols (`NVDA`, `TLT`, `KX-FED-CUT-25BPS`, `SOL-USD`, `SPY`, `KX-CPI-SUB-2.4`) aligned with historical bar timestamps.
  - *Why*: Guarantees every instrument in the watchlist immediately showcases rich, multi-bar historical agent execution markers as soon as the user switches symbols, while new live orders plot at the latest right-edge bar.

---

## 4. Technical Architecture & Data Strategy *(Technical Reference)*

### Architecture & Component Diagram

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│                         COMMAND CENTER VIEWPORT (App.tsx)                            │
│   Passes `feature`, `assessment`, and symbol-filtered `orders` to PriceEnvelopeChart │
└──────────────────────────────────────────┬───────────────────────────────────────────┘
                                           │
                                           ▼
┌──────────────────────────────────────────────────────────────────────────────────────┐
│                     PriceEnvelopeChart Component (SVG + Popover)                     │
│  ┌────────────────────────────────────────────────────────────────────────────────┐  │
│  │ Chart Toolbar: Price · VWAP · ±1 ATR Band · [Toggle Fills & OCO Brackets]      │  │
│  ├────────────────────────────────────────────────────────────────────────────────┤  │
│  │ SVG Viewport (760x260)                                                         │  │
│  │  - Layer 1: Reference Grid & Shaded ±1 ATR(14) Volatility Channel              │  │
│  │  - Layer 2: Deterministic Support & Resistance Dashed Lines                    │  │
│  │  - Layer 3: OHLC High/Low Wicks, Anchored VWAP Curve, Close Price Polyline     │  │
│  │  - Layer 4: OCO Risk-Reward Vertical Stem + TP/SL Bracket Projections          │  │
│  │  - Layer 5: Interactive Directional Fill Markers (▲ BUY / ▼ SELL)              │  │
│  ├────────────────────────────────────────────────────────────────────────────────┤  │
│  │ Interactive Trade Inspection Popover & Plotted Fill Selector Strip             │  │
│  │  - Agent Name · Order ID · Side × Qty · Fill Price · Entry Regime              │  │
│  │  - OCO Stop-Loss & Take-Profit · Live Unrealized P&L ($ and %)                 │  │
│  └────────────────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

### Interactive Component & State Mapping

- **`PriceEnvelopeChartProps`**: Expanded to accept `orders: ExecutedOrder[]` and `currentPrice: number`.
- **State Hooks inside `PriceEnvelopeChart`**:
  - `showTradeOverlay: boolean` (default `true`): Toggles trade fill markers and OCO bracket lines on/off.
  - `activeOrderId: string | null`: Tracks the currently hovered or clicked trade marker to render its expanded OCO bracket lines and telemetry inspection card.
- **Live P&L Computation**: For each plotted trade fill, calculates `livePnlUsd = (side === 'BUY' || side === 'BUY_YES' ? currentPrice - fillPrice : fillPrice - currentPrice) * quantity` and `livePnlPct`, displaying exact tabular figures in both the popover and the plotted fill strip.
