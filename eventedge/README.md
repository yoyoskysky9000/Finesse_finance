# EventEdge (`eventedge/`)

EventEdge is a modular research, probability-estimation, risk-gated decision, and immutable ledger package built on top of Finesse_finance (QuantPulse).

> **Mandatory Reuse Contract**: EventEdge never forks or reimplements order authority, deterministic idempotency locks, Rule 3 pre-exit open-order sweeps, Kalshi V2 signing/rate-governing, or MCP tools. See [`REUSE_MAP.md`](./REUSE_MAP.md) for the exact file paths and entry points EventEdge delegates to.

---

## Architecture Overview

```text
eventedge/
├── REUSE_MAP.md          # Authoritative inventory of existing Finesse_finance modules to reuse
├── README.md             # Package overview & usage
├── index.ts              # Public barrel exports
├── config/
│   └── index.ts          # Mode guard (OBSERVE | PAPER | DEMO; LIVE hard-disabled), risk, discovery, forecasting & shadow defaults + config_hash
├── db/
│   ├── schema.ts         # Immutable 21-table EventEdge SQLite ledger schema + forward-only migrations (v1..v6)
│   └── migrations.ts     # node:sqlite (DatabaseSync) WAL opener & transactional migration runner
├── discovery/
│   ├── kalshiPublicClient.ts  # Public-only Kalshi v2 REST client (no auth/trading calls)
│   └── index.ts          # Market normalization, market_snapshots persistence, config-driven scan filter
├── resolution/
│   ├── auditor.ts        # Contract Resolution Auditor (CLEAR vs AMBIGUOUS) & append-only rule versioning
│   └── index.ts          # Resolution barrel exports
├── forecasting/
│   ├── types.ts          # Price-blind domain types, estimator interfaces & abstention codes
│   ├── priceBlindGuard.ts # Market-price/orderbook key stripping, event family derivation, config hash & git HEAD lookup
│   ├── engine.ts         # Deterministic p_base, p_quant, p_ensemble engine + append-only SQLite persistence
│   ├── referenceEstimators.ts # Reference-only test fixture estimators (NOT production models)
│   └── index.ts          # Forecasting barrel exports
├── experiments/
│   ├── registry.ts       # Experiment registry + controlled status transitions & status history
│   └── index.ts          # Experiments barrel exports
├── lifecycle/
│   ├── contractLifecycle.ts # Contract resolution state machine, EE-01 auditor binding & rules-revision hook
│   └── index.ts          # Lifecycle barrel exports
├── persistence/
│   ├── forecastRepository.ts # Append-only ForecastRepository (registry, lifecycle & invariant guards; supports p_calibrated)
│   └── index.ts          # Persistence barrel exports
├── evaluation/
│   ├── types.ts          # Evaluation, calibration, cluster bootstrap & kill-gate report types
│   ├── scoring.ts        # Deterministic Brier, clipped log-loss & family-clustered bootstrap CI
│   ├── outcomeJoin.ts    # Outcome join, timestamp-matched market reference & denominator accounting
│   ├── calibration.ts    # Temporally isolated Beta, Platt & Temperature calibration + p_calibrated builder
│   ├── killGate.ts       # evaluateExperiment kill-gate report & p_calibrated persistence
│   └── index.ts          # Evaluation barrel exports
├── shadow/
│   ├── types.ts          # Paper-only shadow decision, order, fill & reason-code types
│   ├── fees.ts           # Versioned Kalshi taker fee wrapper (kalshi-taker-v1 via src/strategies/kalshiFeeCalculator.ts)
│   ├── bookReader.ts     # Captured book snapshot reader (orderbook_states / market_snapshots)
│   ├── engine.ts         # Deterministic edge-gate, arrival-book latency, partial-fill & ledger persistence engine
│   └── index.ts          # Shadow execution barrel exports
├── runner/
│   ├── observeRunner.ts  # OBSERVE-mode single-cycle runner (discovery + audit + run summary, zero execution)
│   └── index.ts          # Runner barrel exports
└── tests/
    ├── fixtures/
    │   └── kalshiPayloads.ts  # Deterministic recorded-shape Kalshi public payloads (zero live network)
    ├── ee00.test.ts      # EE-00 verification suite (LIVE lock, defaults, ledger migrations)
    ├── ee01.test.ts      # EE-01 verification suite (discovery, resolution auditor, rule versions, OBSERVE runner)
    ├── ee02.test.ts      # EE-02 verification suite (price-blindness, stages, provenance, invariants, determinism)
    ├── ee03.test.ts      # EE-03 verification suite (experiment registry, persistence layer, lifecycle & hooks)
    ├── ee04.test.ts      # EE-04 verification suite (scoring, denominator, temporal calibration, cluster bootstrap, kill-gate)
    └── ee05.test.ts      # EE-05 verification suite (shadow edge gate, arrival book, latency, partial fill, fees, determinism, append-only, config_hash)
```

### 1. Execution Mode Guard (`eventedge/config/index.ts`)
- Four defined modes: `OBSERVE`, `PAPER`, `DEMO`, `LIVE`.
- **Default mode**: `OBSERVE`.
- **`LIVE` is hard-disabled**: attempting to construct or load a configuration with `mode = "LIVE"` via constructor input, `EVENTEDGE_MODE`, `EVENTEDGE_ENABLE_LIVE`, or a JSON config file raises `EventEdgeLiveModeDisabledError`. Returned configs are deeply frozen (`Object.freeze`) with `liveEnabled: false`, and the database schema also enforces `CHECK (mode IN ('OBSERVE', 'PAPER', 'DEMO'))`.

### 2. Configurable Risk, Discovery & Forecasting Defaults (`eventedge/config/index.ts`)
All risk, discovery, and forecasting settings are configurable via constructor overrides, environment variables, or config file (except the hard `LIVE` lock):
- **Risk defaults (`EVENTEDGE_DEFAULT_RISK_CONFIG`)**:
  - Minimum conservative edge: **`0.04`** (`minConservativeEdge`)
  - Per-position cap: **`min(3% of settled cash, 0.5% of bankroll risk per underlying event)`** (`perPositionSettledCashCapPct = 0.03`, `perEventBankrollRiskCapPct = 0.005`, helper `computePerPositionCapUsd`)
  - Correlated event exposure cap: **`1.5%`** (`correlatedEventExposureCapPct = 0.015`)
  - Maximum deployed bankroll: **`10%`** (`maxDeployedBankrollPct = 0.10`)
  - Daily loss stop: **`2%`** (`dailyLossStopPct = 0.02`)
  - Peak-to-trough drawdown stop: **`8%`** (`peakToTroughDrawdownStopPct = 0.08`)
  - Fractional Kelly: **`0.10`** (`fractionalKelly = 0.10`)
- **Discovery filter defaults (`EVENTEDGE_DEFAULT_DISCOVERY_CONFIG`)**:
  - Max close horizon: **`14` days** (`maxCloseHorizonDays`)
  - Min close horizon: **`0` minutes** (`minCloseHorizonMinutes`)
  - Excluded categories blocklist: **`['sports', 'entertainment awards']`** (`excludedCategories`)
  - Pagination & pacing: **`maxPagesPerEndpoint = 20`**, **`pageLimit = 200`**, **`rateLimitDelayMs = 250`**
- **Forecasting defaults (`EVENTEDGE_DEFAULT_FORECASTING_CONFIG`)**:
  - Ensemble version: **`'ee-ensemble-v1.0.0'`** (`ensembleVersion`)
  - Ensemble weights (deterministic weighted linear combination): **`{ p_base: 0.5, p_quant: 0.5 }`** (`ensembleWeights`)
  - Event family derivation version: **`'ee-family-prefix-v1'`** (`eventFamilyDerivationVersion`)
  - Minimum base-rate sample count: **`1`** (`minBaseRateSampleCount`)

- **Shadow execution defaults (`EVENTEDGE_DEFAULT_SHADOW_CONFIG`, hashed into `computeEventEdgeConfigHash`)**:
  - Latency model version: **`'ee-latency-fixed-v1'`** (`latencyModelVersion`)
  - Arrival latency: **`250` ms** (`latencyMs`)
  - Max arrival book age: **`5000` ms** (`maxBookAgeMs`)
  - Fee schedule version: **`'kalshi-taker-v1'`** (`feeScheduleVersion`)

### 3. Immutable Ledger (`eventedge/db/schema.ts`, `eventedge/db/migrations.ts`)
Uses Node's built-in `node:sqlite` (`DatabaseSync`) in WAL mode (`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;`), matching `src/server/ExecutionVault.ts`, `src/server/riskGuard.ts`, and `server.ts`.

Forward-only migrations (`schema_migrations`, currently v1..v6) provision 21 append-only tables protected by SQLite immutability triggers (`RAISE(ABORT, ...)`):
1. `market_snapshots`
2. `settlement_rule_versions`
3. `research_evidence`
4. `agent_forecasts`
5. `final_probability_estimates`
6. `orderbook_states`
7. `trade_decisions`
8. `submitted_orders`
9. `actual_fills`
10. `fees`
11. `settlements`
12. `realized_pnl`
13. `unrealized_pnl`
14. `observe_run_summaries`
15. `probability_forecasts` (stages `p_base`, `p_quant`, `p_ensemble`, `p_calibrated` via v5)
16. `experiments` (append-only except controlled `status` transitions logged in `experiment_status_history`)
17. `experiment_status_history`
18. `contract_lifecycle_history` (plus automatic `RULES_REVISED` trigger on new `settlement_rule_versions` for `APPROVED`/`ACTIVE` contracts)
19. `shadow_decisions` (v6: immutable paper shadow-fill decisions)
20. `shadow_orders` (v6: immutable paper shadow orders with latency & arrival timestamps)
21. `shadow_fills` (v6: immutable paper shadow fills with decision + arrival book IDs, depth, age, fee & schedule version)

---

## Running Tests & Type Checks

```bash
# Run EventEdge EE-00 through EE-05 automated tests (zero live network)
npx tsx eventedge/tests/ee00.test.ts
npx tsx eventedge/tests/ee01.test.ts
npx tsx eventedge/tests/ee02.test.ts
npx tsx eventedge/tests/ee03.test.ts
npx tsx eventedge/tests/ee04.test.ts
npx tsx eventedge/tests/ee05.test.ts

# Type-check entire workspace including eventedge/
npm run lint
```
