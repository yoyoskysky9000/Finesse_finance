# TASK_QUEUE.md — Finesse_finance Multi-Agent Backlog

> **Protocol**: Before picking up a task, read `AGENTS.md` and the last 10 lines of `AGENT_BUS.jsonl`.
> - **`[VAULT-FIX]`**: Unlocks `server.ts`, `mcp_server.py`, and `src/server/*` strictly for execution/risk-guardrail hardening.
> - **`[SANDBOX]`**: Restricted strictly to strategy/backtest files and `champion_config.json` (execution files 100% LOCKED).

---

## Active Backlog

- [x] **TASK-01 `[VAULT-FIX]`**: Audit our current order execution and sizing files in Finesse_finance and log any remaining duplicate-order, all-in sizing, or locked-exit vulnerabilities to `AGENT_BUS.jsonl`. *(Completed on initialization — see line 2 of `AGENT_BUS.jsonl` for exact file/line findings across `server.ts` and `mcp_server.py`.)*

- [ ] **TASK-02 `[VAULT-FIX]`**: Verify or build a deterministic `RiskGuard.ts` module (`src/server/riskGuard.ts`) that enforces:
  1. Deterministic idempotency hash lock (`sha256(symbol + ":" + side + ":" + strategy_id + ":" + time_bucket)`) across ALL order routes (eliminating `Date.now()` keys in `executeLivePublicBrokeragePulse`, `placePublicTakeProfitSellOrders`, `executeLiveKalshiHftPulse`, and `submitKalshiV2EventsOrder` retries).
  2. Strict **3% settled-cash cap** (`2%–5%` configurable band on `cashOnlyBuyingPowerUsd` / `kalshiCashBalanceUsd`, never `totalEquityUsd` or `buyingPowerUsd` margin) wired into every live and burst execution route in `server.ts` + `mcp_server.py`.
  3. **Pre-exit open-order cancellation sweep + balance-release confirmation + exact settled-quantity close** for both Public.com (`placePublicTakeProfitSellOrders`, stop-loss exits) and Kalshi V2 (`submitSingleKalshiSellOrder`).
  4. Unit/smoke tests in `tests/smoke.test.ts` verifying all three RiskGuard invariants.

- [ ] **TASK-03 `[SANDBOX]`**: Run a baseline backtest with real historical candle data, realistic venue fees (`feePerContract: 0.02` / Kalshi quadratic taker vs $0 maker + Public brokerage fees), slippage, and `RiskGuard` 3% settled-cash cap enabled, saving the winning parameters and verified simulation metrics to `champion_config.json`.

- [ ] **TASK-04 `[SANDBOX]`**: Multi-model variable sweep across choppy (`LOW_VOLATILITY_COMPRESSION` / range-bound) and high-volatility (`HIGH_VOLATILITY_EXPANSION` / `atrBaselineMultiplier >= 1.5x`) market regimes using real OHLCV history, updating `champion_config.json` only if out-of-sample net Sharpe and max drawdown strictly improve over the TASK-03 baseline without increasing tail risk.
