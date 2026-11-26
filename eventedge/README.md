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
│   └── index.ts          # Mode guard (OBSERVE | PAPER | DEMO; LIVE hard-disabled) & risk defaults
├── db/
│   ├── schema.ts         # Immutable 13-table EventEdge SQLite ledger schema + immutability triggers
│   └── migrations.ts     # node:sqlite (DatabaseSync) WAL opener & transactional migration runner
└── tests/
    └── ee00.test.ts      # EE-00 automated verification suite (LIVE lock, defaults, ledger migrations)
```

### 1. Execution Mode Guard (`eventedge/config/index.ts`)
- Four defined modes: `OBSERVE`, `PAPER`, `DEMO`, `LIVE`.
- **Default mode**: `OBSERVE`.
- **`LIVE` is hard-disabled**: attempting to construct or load a configuration with `mode = "LIVE"` via constructor input, `EVENTEDGE_MODE`, `EVENTEDGE_ENABLE_LIVE`, or a JSON config file raises `EventEdgeLiveModeDisabledError`. Returned configs are deeply frozen (`Object.freeze`) with `liveEnabled: false`, and the database schema also enforces `CHECK (mode IN ('OBSERVE', 'PAPER', 'DEMO'))`.

### 2. Configurable Risk Defaults (`EVENTEDGE_DEFAULT_RISK_CONFIG`)
All risk parameters are configurable via constructor overrides, environment variables, or config file (except the hard `LIVE` lock):
- Minimum conservative edge: **`0.04`** (`minConservativeEdge`)
- Per-position cap: **`min(3% of settled cash, 0.5% of bankroll risk per underlying event)`** (`perPositionSettledCashCapPct = 0.03`, `perEventBankrollRiskCapPct = 0.005`, helper `computePerPositionCapUsd`)
- Correlated event exposure cap: **`1.5%`** (`correlatedEventExposureCapPct = 0.015`)
- Maximum deployed bankroll: **`10%`** (`maxDeployedBankrollPct = 0.10`)
- Daily loss stop: **`2%`** (`dailyLossStopPct = 0.02`)
- Peak-to-trough drawdown stop: **`8%`** (`peakToTroughDrawdownStopPct = 0.08`)
- Fractional Kelly: **`0.10`** (`fractionalKelly = 0.10`)

### 3. Immutable Ledger (`eventedge/db/schema.ts`, `eventedge/db/migrations.ts`)
Uses Node's built-in `node:sqlite` (`DatabaseSync`) in WAL mode (`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;`), matching `src/server/ExecutionVault.ts`, `src/server/riskGuard.ts`, and `server.ts`.

Forward-only migrations (`schema_migrations`) provision 13 append-only tables protected by `BEFORE UPDATE` and `BEFORE DELETE` SQLite triggers (`RAISE(ABORT, ...)`):
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

---

## Running Tests & Type Checks

```bash
# Run EventEdge EE-00 automated tests
npx tsx eventedge/tests/ee00.test.ts

# Type-check entire workspace including eventedge/
npm run lint
```
