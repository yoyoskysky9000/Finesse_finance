# TASK_QUEUE.md — Finesse_finance Multi-Agent Backlog

> **Protocol**: Before picking up a task, read `AGENTS.md` and the last 10 lines of `AGENT_BUS.jsonl`.
> - **`[VAULT-FIX]`**: Unlocks `server.ts`, `mcp_server.py`, and `src/server/*` strictly for execution/risk-guardrail hardening.
> - **`[SANDBOX]`**: Restricted strictly to strategy/backtest files and `champion_config.json` (execution files 100% LOCKED).

---

## Active Backlog

- [x] **TASK-01 `[VAULT-FIX]`**: Audit our current order execution and sizing files in Finesse_finance and log any remaining duplicate-order, all-in sizing, or locked-exit vulnerabilities to `AGENT_BUS.jsonl`. *(Completed — see line 2 of `AGENT_BUS.jsonl`.)*

- [x] **TASK-02 `[VAULT-FIX]`**: Deep Research on Regime & Liquidity Filters (Agent 01) + RiskGuard design. *(Completed prior to TASK-04 promotion.)*

- [x] **TASK-03A/B `[SANDBOX]`**: Agent 03 Muse/Brill parameter calibration & Agent 04 2x Fee/Slippage Stress Test. *(Completed prior to TASK-04 promotion.)*

- [x] **TASK-04 `[VAULT-FIX]`**: Champion Config Promotion (`2.5.0-UNIFIED-CHAMPION` in `champion_config.json`) & Execution Vault Upgrade (`src/server/ExecutionVault.ts` + `src/server/regimeLiquidityFilter.ts` wired into `server.ts`) enforcing:
  1. **Rule 1 (Settled Cash Cap)**: `targetSize = Math.min(riskAmount / stopLossDistance, settledCash * 0.03)` using ONLY settled, available cash.
  2. **Rule 2 (Deterministic Idempotency Lock)**: Hash `symbol + side + strategy_id + time_bucket` with strict cooldowns of `900s` (5m), `2700s` (15m), and `14400s` (1h), blocking duplicates within the active bucket.
  3. **Rule 3 (Pre-Exit Sweep & LHS Unwind)**: `CancelAllOpenOrders(symbol)` -> confirm balance release -> recalculate Liquidity Health Score (`LHS`) -> 1¢-inside-spread limit exit if `LHS >= 0.65` or passive TWAP micro-tranches if `LHS < 0.65`.
  4. **Regime, Liquidity & Exit Filters**: `CHOP(14)`, `ADX(10/14)`, `Kaufman_ER(10)`, 125-bar `BBW_percentile`, `ATR_ratio_percentile`, `Garman_Klass_VRP_percentile`, `LHS` over `1000ms` TWAP OBI window, 2x15s confirmed stop-loss, `+1.2 * atr14_usd` 50% trailing lock, 6m dead-trade stop, and `T - 90s` forced flat.

- [x] **TASK-04B `[VAULT-FIX]`**: External verification audit fixes A–F (fail-closed live cash sync rejecting missing/`>60s` stale balances and removing `skipLiveCashSync` bypass; mandatory default 3% settled-cash cap in `/api/agents/execute-trade`; Fix C parameter consolidation removing duplicate lead-lag fields from `champion_config.json`; deterministic SHA-256 fallback idempotency + disk-persisted ledgers across `ExecutionVault` and `executeTradeIdempotencyStore`; Rule 3 pre-exit sweep + venue-confirmed Kalshi `reduce_only` IoC / Public `SELL` exits in `evaluateRealTimeRoiAndGlobalProfitLock`; `"test": "tsx tests/smoke.test.ts"` in `package.json` with smoke checks `(a)–(j)` + `Fixes A–F` passing).

- [x] **TASK-08 `[SANDBOX]`**: Agent 04 Multi-Position Correlation & Portfolio Drawdown Stress-Test + Live OKX Telemetry Gate (logged in Section 8 of `Finesse_Finance_Master_Agent_Hub`).

- [x] **TASK-09 `[VAULT-FIX]`**: Implement `2.6.0-PORTFOLIO-GUARD-CHAMPION` upgrade (`src/risk/PortfolioCorrelationGuard.ts` with `evaluatePortfolioCorrelationAndCap()` & `getLossFraction()`, `ExecutionVault.ts` Telemetry Completeness Gate `UNVERIFIED_MICROSTRUCTURE_TELEMETRY` + post-lock/pre-exchange wiring, `server.ts` `/api/agents/execute-trade` enforcement, and `champion_config.json` `portfolio_correlation_rules`).

- [x] **TASK-10 `[VAULT-FIX]`**: Execute mandatory live-production upgrade across `mcp_server.py`, `src/risk/PortfolioCorrelationGuard.ts`, and `src/server/ExecutionVault.ts` (`README.md.brill` Audit + `TASK-08` Section 8): strip all fabricated order IDs and mock execution states (`PAPER_LOGGED_BY_GATE_3`, `LOCAL_OCO_STAGED`), remove hardcoded balance constants (`$625.35`/`$435.08`/`$459.34`/`$555.81`) and fail closed with `settledCash = 0` & `status = "BALANCE_UNVERIFIED_BLOCK"`, wire `run_portfolio_cleaner` to Rule 3 `CancelAllOpenOrders` pre-exit sweep + balance release confirmation + live closes, fix `ml_meta_model_state` SQL `INSERT` with explicit column names, filter ML training with `WHERE is_synthetic = 0 AND source = 'LIVE_VENUE'`, and enforce `evaluatePortfolioCorrelationAndCap` post-idempotency-lock / pre-exchange.

- [x] **TASK-06 `[VAULT-FIX]`**: Execute Section 9 of `Agent03_TASK06_DeSim_Spec_2026-11-14.md` (`2.7.0-LEAD-LAG-LIVE-CHAMPION`): (Part 1) Surgical de-simulation of `mcp_server.py` passing all 5 Brill post-push grep & round-trip verification gates (a)–(e) (`order_ledger` persistence with real venue-returned `order_id` and `raw_venue_response`, `uuid5` restricted strictly to `client_order_id`, `<= 60s` balance cache TTL with `BALANCE_UNVERIFIED_BLOCK` & `settledCash: 0`, dual-venue live open-order/position fetch & Rule 3 sweep in `run_portfolio_cleaner` emitting `LIVE_EXECUTED` only with venue confirmation IDs, explicit 13-column `ml_meta_model_state` `INSERT`, and `is_synthetic INTEGER DEFAULT 0` with `WHERE is_synthetic = 0` + `excluded_synthetic_rows` logging); (Part 2) Create `src/strategies/LeadLagAnomalyTriggers.ts` and wire `"lead_lag_triggers"` into `champion_config.json` implementing `SVB-60`, `GKX-5` (with minute-1 sign-flip `-$0.03` SL tightening), and `XVD` (`1.5%` settled-cash half-cap) inside the `2.6.0-PORTFOLIO-GUARD-CHAMPION` envelope.

- [ ] **TASK-05 `[SANDBOX]`**: Run walk-forward out-of-sample verification on `2.7.0-LEAD-LAG-LIVE-CHAMPION` over live Coinbase/Kalshi 5m & 15m datasets and populate numeric metrics in `champion_config.json`.


