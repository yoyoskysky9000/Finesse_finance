# EventEdge Reuse Map

> **Golden Rule**: EventEdge MUST call and compose the existing battle-tested Finesse_finance (QuantPulse) execution, idempotency, pre-exit sweep, Kalshi API, MCP, and storage components below. **Never fork, duplicate, or bypass them.**
>
> All live execution and security files (`server.ts`, `mcp_server.py`, `src/server/*`) remain `[VAULT-FIX]`-locked per `AGENTS.md`.

---

## 1. ExecutionVault (Order Authority & Risk Guardrails)

| Component | Exact Path | Key Exports / Entry Points | Responsibility |
| --- | --- | --- | --- |
| **ExecutionVault** | `src/server/ExecutionVault.ts` | `ExecutionVault`, singleton `executionVault`, `validateEntryOrder` (L870), `executeEntryWithPortfolioGuard` (L1027), `computeSettledCashTargetSize` (L509), `verifyMicrostructureTelemetry` (L781), `evaluatePostLockPortfolioGuard` (L849), `executeLowBalanceCompounderEntry` (L1386), `attachOrderIdToLock` (L749) | Locked order-authority kernel enforcing Rule 1 (3% settled-cash cap), Rule 2 (atomic idempotency lock), Rule 3 (pre-exit sweep + LHS unwind), microstructure telemetry completeness (`UNVERIFIED_MICROSTRUCTURE_TELEMETRY`), and post-lock/pre-exchange `PortfolioCorrelationGuard`. |
| **RiskGuard (Secondary Live Routes)** | `src/server/riskGuard.ts` | `RiskGuard`, singleton `riskGuard`, `verifySettledCash` (L378), `evaluateEntryOrder` (L443+), `attachOrderOutcome` (L747), `executeRule3PreExitSweep` (L775) | Fail-closed settled-cash verification (`BALANCE_UNVERIFIED_BLOCK` when missing or `>60s` stale), mandatory 3% settled-cash clamp, and persistent bucket locks across secondary `server.ts` routes. |
| **Portfolio Correlation Guard** | `src/risk/PortfolioCorrelationGuard.ts` | `evaluatePortfolioCorrelationAndCap`, `getLossFraction` | Enforces 3% per-position settled-cash cap and 3.5% 15m correlated drawdown stress cap immediately after idempotency lock and before exchange routing. |
| **Regime & Liquidity Filter** | `src/server/regimeLiquidityFilter.ts` | `CHAMPION_CONFIG`, `computeLiquidityHealthScore` (L359), `evaluateRegimeAndLiquidity` (L430), `evaluateChampionExitSignal` (L723), `evaluateZeroFeeSettlementHoldExemption` (L615) | `2.6.0` regime/liquidity gates (`CHOP(14)`, `ADX`, `Kaufman_ER(10)`, `BBW`/`ATR`/`GK_VRP` percentiles, `LHS >= 0.65`) and champion exit evaluation. |
| **Kalshi Fee & Edge Math** | `src/strategies/kalshiFeeCalculator.ts` | `computeKalshiOrderFeeUsd` (L34), `evaluateLowBalanceKalshiEdge` (L68), `KALSHI_STRESSED_DRAG_FLOOR_USD` | Exact Kalshi quadratic taker fee (`ceil(100 * 0.07 * C * P * (1 - P) - 1e-9) / 100`) and `$0.00` `MAKER_POST_ONLY` fee math. |
| **Server Primary Order Route** | `server.ts` | `POST /api/agents/execute-trade` (L15986 lock call), exported `executionVault` & `riskGuard` (L24293–24294) | Authenticated (`src/server/phase1Security.ts`) HTTP entry point enforcing live cash sync, `ExecutionVault`, and `PortfolioCorrelationGuard`. |

**EventEdge Integration Rule**: Any future EventEdge execution adapter (in `PAPER` or `DEMO` mode; `LIVE` is hard-disabled in `eventedge/config`) MUST route sizing, settled-cash verification, and order authorization through `executionVault` (`src/server/ExecutionVault.ts`) and `riskGuard` (`src/server/riskGuard.ts`) rather than implementing a parallel order authority.

---

## 2. Deterministic Idempotency-Hash Implementation

| Layer | Exact Path | Functions / Tables | Hash & Bucket Specification |
| --- | --- | --- | --- |
| **Vault Idempotency Kernel** | `src/server/ExecutionVault.ts` | `deriveDeterministicIdempotencyKey` (L471), `acquireIdempotencyLock` (L584), `attachOrderIdToLock` (L749) | `SHA-256` over `${normSymbol}:${normSide}:${normStrategy}:${timeBucket}` (plus optional `:explicitClientKey`). Time bucket = `Math.floor(nowMs / (cooldownSec * 1000))` with cooldowns `5m = 900s`, `15m = 2700s`, `1h = 14400s`. Acquired atomically inside `BEGIN IMMEDIATE` SQLite transaction on `order_ledger` (`.quantpulse_vault_idempotency.sqlite`) and mirrored to `.quantpulse_vault_idempotency.json`. |
| **RiskGuard Idempotency Kernel** | `src/server/riskGuard.ts` | `deriveDeterministicKey` (L348), `evaluateEntryOrder` (L564–705) | Same `SHA-256(symbol:side:strategyId:timeBucket)` tuple with `'90s' | '5m' | '15m' | '1h'` buckets (`90s`, `900s`, `2700s`, `14400s`). Persisted to SQLite `risk_guard_locks` (`.quantpulse_risk_guard_ledger.sqlite`) + JSON mirror `.quantpulse_risk_guard_ledger.json`. |
| **Python MCP Idempotency Ledger** | `mcp_server.py` | `_acquire_idempotency_lock_atomic` (L788+), tables `idempotency_ledger` (L602), `kalshi_client_order_ledger` (L715), `order_ledger` (L731) | Atomic DuckDB/SQLite lock table preventing duplicate live tool execution; `uuid5` restricted strictly to `client_order_id`. |

**EventEdge Integration Rule**: EventEdge MUST call `executionVault.deriveDeterministicIdempotencyKey(...)` / `executionVault.acquireIdempotencyLock(...)` (or `riskGuard.deriveDeterministicKey(...)`) and record the resulting `idempotency_hash` in EventEdge's `trade_decisions` and `submitted_orders` ledger tables. Never generate keys with `Date.now()` or `Math.random()`.

---

## 3. Pre-Exit Open-Order Sweep (Rule 3)

| Layer | Exact Path | Functions | Sequence Enforced |
| --- | --- | --- | --- |
| **Vault Rule 3 Unwind Engine** | `src/server/ExecutionVault.ts` | `unwindPositionSafely(input: PreExitSweepInput)` (L1080–1278) | 1. Calls `cancelAllOpenOrders(symbol)`<br>2. Polls `fetchOpenOrdersCount(symbol)` until `0` (confirms collateral/inventory release; aborts with `ABORTED_LOCKED_INVENTORY` if any open orders remain)<br>3. Reads exact `settledPositionQty` (`min(requestedQty, settledPositionQty)`)<br>4. Recalculates `LHS` via `computeLiquidityHealthScore`<br>5. Routes 1¢-inside-spread single limit (`LHS >= 0.65`) or passive TWAP micro-tranches (`LHS < 0.65`). |
| **RiskGuard Sweep Wrapper** | `src/server/riskGuard.ts` | `executeRule3PreExitSweep(input)` (L775) | Thin delegation wrapper directly into `executionVault.unwindPositionSafely(input)`. |
| **Kalshi Server Sweep & Exit Helpers** | `server.ts` | `cancelRestingKalshiOrdersForTicker` (L9219), `cancelAllKalshiV2Orders` (L4291), `submitSingleKalshiSellOrder` (exported L24297), `evaluateRealTimeRoiAndGlobalProfitLock` (exported L24290) | Venue-level resting order cancellation and `reduce_only` IoC sell dispatch wired through `executionVault.unwindPositionSafely`. |
| **Python MCP Sweep & Cleaner** | `mcp_server.py` | `cancel_all_kalshi_v2_orders` (L4526), `get_kalshi_resting_orders_for_ticker` (L4606), `ensure_no_stale_resting_orders_before_entry` (L4630), `execute_low_balance_compounder_exit` (L4863), `run_portfolio_cleaner` (L7357), `execute_risk_mitigation` (L8460) | Dual-venue open-order cancellation, balance-release confirmation, and venue-confirmed closes. |

**EventEdge Integration Rule**: Any position close, flatten, or risk stop in EventEdge MUST invoke `executionVault.unwindPositionSafely(...)` (or `riskGuard.executeRule3PreExitSweep(...)`) with venue cancel/open-order/position callbacks.

---

## 4. Existing Kalshi API Client & MCP Server Paths

### A. TypeScript Kalshi V2 Client (`server.ts` & `scripts/`)
- **Credential & Dual-Algorithm Signing (`server.ts`)**:
  - `resolveKalshiCredentials()` (L3179): reads `KALSHI_API_ID` / `KALSHI_KEY_ID` / `KALSHI_API_KEY_ID` and `KALSHI_API_KEY` / `KALSHI_PRIVATE_KEY` / `KALSHI_SECRET`.
  - `buildKalshiHeaders(method, pathWithOrWithoutQuery)` (L3199): strips query parameters and signs `${timestamp_ms}${METHOD}${cleanPath}` via Ed25519 (default Oct 2026 spec) or RSA-PSS SHA-256.
- **Rate Governor & Signed Fetch (`server.ts`)**:
  - `kalshiRateGovernor` (L3250) + `syncKalshiAccountLimits()` (L3331): dual read/write token bucket synced to `GET /trade-api/v2/account/limits` with 30% write reserve for emergency cancels / `reduce_only` IoC exits.
  - `kalshiSignedFetch(pathWithQuery, options)` (L3361): rate-limited signed REST client with 429 backoff retry.
  - `computeKalshiTopOfBookDepthFp(m)` (L3395): reads `yes_bid_size_fp` / `yes_ask_size_fp` (never deprecated `liquidity_dollars`).
- **Order Submission & Cancellation (`server.ts`)**:
  - `submitKalshiV2EventsOrder(params)` (L3788, exported L24295)
  - `cancelAllKalshiV2Orders(reason)` (L4291)
  - `cancelRestingKalshiOrdersForTicker(ticker)` (L9219)
  - HTTP routes in `server.ts`: `POST /api/kalshi/sync` (L9150), `POST /api/kalshi/hft-burst` (L13012), `POST /api/kalshi/place-sell-orders` (L13059), `GET /api/kalshi/five-gate-brier` (L13086), `POST /api/kalshi/five-gate-evaluate` (L13110), `POST /api/kalshi/five-gate-settle` (L13215), `GET /api/kalshi/gemini-cache-status` (L13256), `POST /api/kalshi/gemini-signal` (L13304), `GET /api/kalshi/oct2026-spec` (L18321).
- **Historical Candlesticks Fetcher (`scripts/fetch_walk_forward_history.ts`)**:
  - `fetchPaginatedKalshiKxbtc15mCandles`, `buildKalshiTickerCandlestickParams` — real Kalshi v2 `period_interval='1'` / batch `/markets/candlesticks` fetcher with fail-closed `INSUFFICIENT_REAL_HISTORY`.

### B. Python FastMCP Server & Kalshi Client (`mcp_server.py`) & Node MCP Routes (`server.ts`)
- **Python Kalshi V2 Client (`mcp_server.py`)**:
  - `kalshi_signed_rest_request` (L4174), `submit_kalshi_v2_events_order` (L4266), `place_v2_maker_order` (L4497), `cancel_all_kalshi_v2_orders` (L4526), `resolve_active_kalshi_contract_ticker` (L5941).
- **FastMCP Tool Surface (`mcp_server.py`, Streamable HTTP transport)**:
  - Read/Evaluation tools: `get_kalshi_live_balance` (L2601), `get_public_brokerage_portfolio` (L2706), `evaluate_market_regime` (L2855), `evaluate_btc_lead_lag` (L2953), `scan_alpha_and_backtest` (L3031), `get_portfolio_state` (L8143), `check_mcp_venue_health` (L8197), `read_market_query` (L8223), `fetch_live_orderbook` (L8278).
  - Mutating/Risk tools (all require `idempotency_key`): `route_to_dlq` (L3134), `execute_kalshi_or_public_order` (L6426), `evaluate_5_gate_kalshi_signal` (L6884), `settle_kalshi_brier_prediction` (L6947), `deliberate_kalshi_signal_with_gemini` (L7286), `run_portfolio_cleaner` (L7357), `trigger_risk_circuit_breaker` (L7630), `train_and_optimize_meta_model` (L7683), `propose_or_execute_strategy` (L8325), `execute_risk_mitigation` (L8460).
- **Node MCP Gateway Endpoints (`server.ts`)**:
  - `POST /api/mcp` (L19747), `GET /api/mcp` (L20028), `GET /api/mcp/sse` (L20052), `GET /api/mcp/python-server` (L20071), `POST /api/mcp/prompt` (L20087), `GET /api/mcp/state` (L20112), `POST /api/mcp/invoke` (L22398), `POST /api/mcp/connect` (L22423), `GET /api/mcp/entitlements` (L19693).

---

## 5. Existing Test Setup & How Tests Are Run

| File / Script | Command | Details |
| --- | --- | --- |
| `package.json` (`scripts.test`) | `npm test` (`tsx tests/smoke.test.ts`) | Runs the main TypeScript smoke suite (`tests/smoke.test.ts`, ~2,560 lines) using Node's built-in `node:assert/strict` executed directly via `tsx`. No Jest/Vitest dependency is installed. |
| Server test harness | `QUANTPULSE_TEST_MODE=true` | Checked at `server.ts:24279` so importing `server.ts` in tests does not auto-start the port 3000 listener. |
| Type-checking | `npm run lint` (`tsc --noEmit`) | Validates all TypeScript modules across `src/`, `scripts/`, `tests/`, and `eventedge/` (`tsconfig.json` includes workspace `.ts` files). |
| Production build | `npm run build` | `vite build && esbuild server.ts --bundle --platform=node --packages=external --format=esm --outfile=dist/server.mjs` |
| EventEdge tests | `npx tsx eventedge/tests/ee00.test.ts` | Follows the exact same `tsx` + `node:assert/strict` convention with isolated `:memory:` and temporary SQLite databases. |

---

## 6. Database & Storage Approach Already in Use

| Store | Engine & Driver | Exact Paths & Tables | Pragmas / Patterns |
| --- | --- | --- | --- |
| **TypeScript Execution & Risk Ledgers** | **Node built-in `node:sqlite` (`DatabaseSync`)** | `src/server/ExecutionVault.ts` (L4, L336–361): `.quantpulse_vault_idempotency.sqlite` (`order_ledger`)<br>`src/server/riskGuard.ts` (L4, L197–221): `.quantpulse_risk_guard_ledger.sqlite` (`risk_guard_locks`)<br>`server.ts` (L10, L5973–6049): `quant_ledger.duckdb.sqlite` (`ml_telemetry_ledger`) | `PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;`, `CREATE TABLE IF NOT EXISTS`, `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` transactions, parameterized `.prepare(...).run/get/all(...)`, optional JSON mirror for lock recovery. |
| **Python MCP Analytics & Ledgers** | DuckDB with `sqlite3` WAL fallback | `mcp_server.py` (L30–42, L427–465, L602–745, L5318–5355): `quant_ledger.duckdb` / `.sqlite` (`idempotency_ledger`, `dead_letter_queue`, `cleanup_audit`, `lead_lag_signals`, `ml_telemetry_ledger`, `ml_meta_model_state`, `public_order_retry_ledger`, `kalshi_client_order_ledger`, `order_ledger`) & `kalshi_brier_calibration.sqlite` (`predictions`, `series_calibration`). | `timeout=5.0`, SQLite WAL pragmas (`_configure_sqlite_pragmas`). |
| **Dashboard UI Sync (Cloud)** | Firebase Firestore | `src/services/firestoreSyncService.ts`, `firebase-applet-config.json`, `firestore.rules` | Client-side UI checkpoint persistence only; not used for server-side execution/order ledgers. |

**EventEdge Storage Decision**: Match the TypeScript backend's native **`node:sqlite` (`DatabaseSync`)** WAL pattern directly (`eventedge/db/schema.ts` & `eventedge/db/migrations.ts`), adding `PRAGMA foreign_keys = ON`, tracked forward-only migrations (`schema_migrations`), parameterized queries, and SQLite `BEFORE UPDATE` / `BEFORE DELETE` `RAISE(ABORT, ...)` triggers on every ledger table to guarantee immutability.
