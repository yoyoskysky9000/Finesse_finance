# AGENTS.md — Finesse_finance (QuantPulse) Multi-Agent Governance & Architecture

This repository houses **Finesse_finance (QuantPulse)**, an autonomous quantitative trading, backtesting, and multi-venue execution system spanning **Kalshi CLOB v2**, **Public.com Brokerage**, **Coinbase Spot/Candles**, and **MCP (Model Context Protocol)** orchestration.

All AI coding agents (GitHub Copilot, Claude, Gemini, overnight GitHub Actions bots, and local autonomous agents) collaborating in this repository MUST follow the rules, file boundaries, historical post-mortem safeguards, and `AGENT_BUS.jsonl` handoff protocol below.

---

## 1. Exact Repository File & Folder Map

Agents must understand the strict separation between **(A) Strategy & Backtest Sandbox**, **(B) Live Execution & Security Vault [LOCKED]**, and **(C) UI / Telemetry Dashboard**.

### A. Strategy, Parameter & Backtesting Files (`[SANDBOX]` — Open for Strategy Optimization)
Agents running parameter sweeps, indicator research, and simulation improvements MAY edit these files (and `champion_config.json`):
- `champion_config.json` — Active champion strategy parameters, 2%–5% (3% default) settled-cash risk caps, slippage/fee assumptions, and baseline/latest walk-forward metrics.
- `strategy_params.json` — Single source of truth for BTC 15m Lead-Lag Sniper V3 parameters (`askGateMin`, `askGateMax`, `minNetEdgeDollars`, `timeWindowMinutes`, volatility cushions, `nd2Weight`, `mlWeight`, `stopAtr`, `tpAtr`).
- `src/config/strategyParams.ts` — Typed loader exposing `strategy_params.json` (`LEAD_LAG_PARAMS`) to TypeScript modules.
- `src/components/StrategyBacktester.tsx` — Deterministic historical candle backtester (`runDeterministicRegimeBacktest`); computes strictly from real loaded OHLCV bars, states source/period, displays `"no data — nothing to show"` on empty bars, and labels all outputs as simulation.
- `src/components/AlphaScannerBacktest.tsx` — Multi-asset alpha scanner & strategy comparator UI.
- `src/components/ArchetypeVarianceD3Lab.tsx` — D3 variance and archetype comparison lab.
- `src/components/StrategyCorrelationMatrix.tsx` — Inter-strategy return correlation matrix.
- `src/components/PortfolioTradeCorrelationMatrix.tsx` — Portfolio/trade correlation matrix component.
- `tests/smoke.test.ts` — Automated smoke verification suite (`npx tsx tests/smoke.test.ts`).

### B. Live Execution, Order-Routing & Security Vault Files (`[VAULT-FIX]` ONLY — LOCKED BY DEFAULT)
These files touch real brokerage/exchange credentials, live cash balances, order placement, exit daemons, and API authentication. **LOCKED against strategy-optimization edits:**
- `server.ts` — Primary Express + Vite Node server (~21k lines). Contains:
  - Venue clients & order routers (`submitKalshiV2EventsOrder`, `cancelAllKalshiV2Orders`, `cancelRestingKalshiOrdersForTicker`, `submitSingleKalshiSellOrder`, `submitPublicOrderWithExponentialRetry`, `executeLiveKalshiHftPulse`, `executeLivePublicBrokeragePulse`)
  - Pre-trade caps, cash checks, and idempotency (`POST /api/agents/execute-trade`, `orderRejectionLog`, `executeTradeIdempotencyStore`)
  - 15-second Exit Monitor & Cloud Daemon (`evaluateRealTimeRoiAndGlobalProfitLock`, `runCloudAutonomousDaemonTick`, `exitMonitorEvaluationLog`)
  - Mutating `/api/*` endpoints (`/api/agents/*`, `/api/kalshi/*`, `/api/public/*`, `/api/lead-lag/*`, `/api/risk/*`)
- `mcp_server.py` — Python FastMCP server exposing Kalshi/Public/Coinbase/DuckDB tools (`execute_kalshi_or_public_order`, `execute_risk_mitigation`, `run_portfolio_cleaner`, `trigger_risk_circuit_breaker`, `route_to_dlq`, `idempotency_ledger`).
- `src/server/phase1Security.ts` — Fail-closed Firebase ID token auth middleware (`firebaseIdTokenAuthMiddleware`, `STRICT_API_AUTH_REQUIRED` defaulting to `true`), rate limiting, and audit security controls.
- `src/server/ExecutionVault.ts` — Locked Execution Vault enforcing Rule 1 (3% settled-cash cap `Math.min(riskAmount / stopLossDistance, settledCash * 0.03)`), Rule 2 (deterministic `symbol:side:strategy_id:time_bucket` idempotency lock with `900s`/`2700s`/`14400s` cooldowns), and Rule 3 (pre-exit `CancelAllOpenOrders(symbol)` sweep, balance-release confirmation, `LHS` recalculation, and 1¢-inside-spread vs passive TWAP micro-tranches).
- `src/server/regimeLiquidityFilter.ts` — `2.5.0-UNIFIED-CHAMPION` `evaluateRegimeAndLiquidity` (`CHOP(14)`, `ADX`, `Kaufman_ER(10)`, `BBW_percentile`, `ATR_ratio_percentile`, `Garman_Klass_VRP_percentile`, `LHS`) and `evaluateChampionExitSignal` exit engine.
- `security_spec.md` — Security & authentication architecture specification.
- `firestore.rules`, `firebase-blueprint.json`, `firebase-applet-config.json` — Database access control and schema config.
- `scripts/set-admin-claim.ts`, `scripts/git-hygiene-untrack.sh` — Admin claim and repository security scripts.

### C. UI, Telemetry & Shared Service Files (Read-Only Unless UI Task Requested)
- `src/App.tsx` — Main QuantPulse command center dashboard, live positions table (showing `lastExitEvaluatedAt` & `lastExitEvaluationResult`), orders table, agent fleet controls, and kill switch UI.
- `src/types/quant.ts` — Shared TypeScript domain interfaces (`ExecutedOrder`, `AutonomousAgent`, `MarketFeatureVector`, `KalshiPosition`, `PublicApiPosition`, `PortfolioSummary`, etc.).
- `src/services/firestoreSyncService.ts` — Client-side Firestore checkpoint sync.
- `src/services/googleDriveService.ts` — Google Docs / Drive OAuth integration service.
- `src/components/KalshiMcpHub.tsx`, `src/components/MasterPlaybookVault.tsx`, `src/components/MentionLipReadSniperLab.tsx`, `src/components/PerformanceBottlenecksPanel.tsx`, `src/components/PriceEnvelopeChart.tsx`, `src/components/RiskEventsLog.tsx`, `src/components/GoogleDriveCopyPanel.tsx` — Specialized UI views & read-only telemetry panels.
- `index.html`, `src/main.tsx`, `src/index.css`, `vite.config.ts`, `tsconfig.json`, `package.json`, `metadata.json`.

---

## 2. STRICT EXECUTION-LOCK GOVERNANCE RULE

> **MANDATORY BOUNDARY:**
> AI agents optimizing strategies, indicators, thresholds, or backtests **MAY ONLY edit strategy/backtest files** (`strategy_params.json`, `src/config/strategyParams.ts`, `src/components/StrategyBacktester.tsx`, `tests/*`) **and `champion_config.json`**.
>
> **All execution, order-routing, sizing, auth, and brokerage files (`server.ts`, `mcp_server.py`, `src/server/*`, `firestore.rules`, `scripts/*`) are 100% LOCKED** unless the assigned task in `TASK_QUEUE.md` is explicitly tagged **`[VAULT-FIX]`**.
>
> Any PR, commit, or patch touching a locked file on a `[SANDBOX]` or un-tagged task MUST be rejected immediately and logged as a governance violation in `AGENT_BUS.jsonl`.

---

## 3. Historical Post-Mortem — 3 Critical Production Bugs to Actively Prevent

Every `[VAULT-FIX]` and `[SANDBOX]` task must explicitly guard against the 3 historical production failures that caused real capital/margin incidents in October–November 2026:

### (a) Going "All-In" / Equity-Based Over-Sizing
- **What happened**: Legacy paths sized orders as 25%–35% of `allocatedCapitalUsd` or fallback `buyingPower` (and secondary routes placed 22x contracts at $0.84 near expiry) without checking `maxPositionNotionalUsd` or **settled cash**, triggering negative cash balances and margin calls.
- **Invariant required everywhere**:
  - Single-trade notional MUST be strictly capped at **2%–5% (default 3.0%) of settled, available cash** (`cashOnlyBuyingPowerUsd` / `kalshiCashBalanceUsd`) — **NEVER total equity, unrealized PnL, or margin buying power**.
  - `maxPositionNotionalUsd` and live settled cash checks MUST reject violating orders **before** any venue API call.

### (b) Duplicate Orders on API Lag or Retries
- **What happened**: Order placement paths built IDs/seeds using `Date.now()` and `Math.random()`. When Kalshi/Public API latency spiked or exponential retry triggered, retries generated new `client_order_id`s and fired duplicate live orders.
- **Invariant required everywhere**:
  - Every order signal and execution call MUST require a deterministic idempotency key:
    `hash(symbol + ":" + side + ":" + strategy_id + ":" + time_bucket)`
  - Never inject `Date.now()` or `Math.random()` inside retry loops or order seeds. Duplicate submissions with the same idempotency key MUST replay the persisted order record without touching the exchange.

### (c) "Insufficient Funds" / Locked Inventory on Exit or Cash-Out
- **What happened**: Closing or flattening a position submitted a new `SELL` / `reduce_only` order while an earlier resting Maker take-profit or open order was still holding the contracts/shares/cash as collateral, causing venue `"insufficient funds"` / `"insufficient shares"` errors or unintended position flips.
- **Invariant required everywhere**:
  - Any close, flatten, stop-loss, or cash-out call MUST execute a strict 3-step sequence:
    1. **Cancel** all open resting orders on that `symbol` / `ticker` at the venue.
    2. **Confirm balance & collateral release** (verify open orders count for that asset is `0` and inspect refreshed settled cash/shares).
    3. **Close the exact settled position size** (using `reduce_only: true` + `immediate_or_cancel` on Kalshi V2, or exact settled `quantity` on Public.com).

---

## 4. `AGENT_BUS.jsonl` Multi-Agent Collaboration Protocol

`AGENT_BUS.jsonl` in the project root is the append-only coordination log shared across Copilot, Claude, Gemini, and GitHub Actions.

1. **Read Before Acting**: Before starting ANY task, read the **last 10 lines** of `AGENT_BUS.jsonl` (and check `TASK_QUEUE.md` + `champion_config.json`) to understand current blockers, vault status, and the previous model's findings.
2. **Respect Locks**: Verify whether your task is tagged `[SANDBOX]` or `[VAULT-FIX]`. Never cross the execution boundary on a `[SANDBOX]` task.
3. **Verify Before Logging**: Run `npm run lint` (`tsc --noEmit`) and `npx tsx tests/smoke.test.ts` before declaring any code task complete.
4. **Append Exactly One JSON Line**: Upon finishing or handing off a task, append **one single-line JSON object** to `AGENT_BUS.jsonl` containing:
   ```json
   {
     "ts": "ISO-8601 timestamp",
     "agent": "model-or-runner-id",
     "task_id": "TASK-XX",
     "tag": "[VAULT-FIX] | [SANDBOX] | [INIT]",
     "status": "COMPLETED | IN_PROGRESS | BLOCKED",
     "files_changed": ["relative/paths"],
     "backtest_metrics": { "net_return_pct": null, "sharpe": null, "max_drawdown_pct": null, "win_rate_pct": null, "trades": null, "data_source": null },
     "verification": "commands run and results",
     "handoff_note": "Concrete next step or warning for the next AI model"
   }
   ```
5. **Update `TASK_QUEUE.md`**: Mark your completed task `[x]` and add any newly discovered `[VAULT-FIX]` or `[SANDBOX]` follow-ups cleanly.
