# Cloud Persistence, Firestore Rules & Google Drive OAuth Deployment Plan

## 1. Executive Answer: Do You Need Permissions & Cloud Redeployment?
- **Current Dev Status (`ais-dev`)**: Your `#1` top-performing agent (`agent-hft-15m-kxbtc` — `BTC Lead-Lag Sniper Agent`, Sharpe `3.68`, Win Rate `80.0%`) is **already live and funded (`$65.00 USD` total = `$30.00` Kalshi CLOB v2 Direct + `$35.00` Public.com Event Contracts)** using `KALSHI_CLOB_V2` + Coinbase BTC-USD spot data inside your active environment.
- **Why Permissions & Cloud Deployment Matter**:
  1. **Firestore & Local DuckDB Persistence**: When a Cloud Run container scales to zero or restarts on redeploy, in-memory state resets unless backed by your provisioned Firestore database (`ai-studio-tradepulseai-5afcfb28-f923-42f2-a189-b764775d8ca2`) and local DuckDB file (`tradepulse_quant.duckdb`). Deploying `firestore.rules` and syncing agent state + ML telemetry to Firestore ensures your `$65.00` dual-venue allocation and `ml_telemetry_ledger` survive every restart.
  2. **Google Drive OAuth (`drive.file`)**: Authorizing the `https://www.googleapis.com/auth/drive.file` scope enables one-click export and restore of your DuckDB ML training ledger and quantitative agent bundle directly to your Google Drive Vault (`GoogleDriveCopyPanel.tsx`).
  3. **Cloud Run Production Redeployment (`ais-pre`)**: Once Firestore rules and OAuth are active, clicking **Share / Deploy** in AI Studio publishes the container with `"start": "tsx server.ts"` so your public Cloud Run URL runs the exact same dual-venue agent state.

---

## 2. Architecture & Implementation Phases

### Phase 1: Firebase Firestore Schema, Security Rules & Cloud Sync
1. **Create `/firebase-blueprint.json`**:
   - Define structured entities for:
     - `/agents/{agentId}`: Stores autonomous agent state (`id`, `name`, `status`, `allocatedCapitalUsd`, `kalshiAllocatedUsd`, `publicAllocatedUsd`, `predictionMarketDataSource`, `executionVenues`, `sharpe`, `winRate`, `totalPnlUsd`, `updatedAt`).
     - `/executed_orders/{orderId}`: Stores dual-venue Kalshi CLOB v2 and Public.com `EVENTCONTRACT` executions (`id`, `agentId`, `venue`, `symbol`, `side`, `count`, `priceDollars`, `status`, `createdAt`).
     - `/ml_telemetry_ledger/{rowId}`: Mirrors DuckDB feature store snapshots and calibrated meta-model weights (`timestamp_utc`, `symbol`, `venue`, `spot_price`, `strike`, `nd2_fair_prob`, `ml_calibrated_prob`, `net_edge_dollars`, `sniper_action`, `ownerUid`).
2. **Create & Deploy `/firestore.rules`**:
   - Enforce strict owner-based and authenticated validation (`isAuthenticated()`, owner `lakeskyler904@gmail.com` admin verification, strict field and type checks, zero open `allow read, write: if true` rules).
   - Deploy rules to `ai-studio-tradepulseai-5afcfb28-f923-42f2-a189-b764775d8ca2` via the Firebase `DeployRules` RPC action.
3. **Wire Firestore Sync in Frontend & Backend**:
   - Create `/src/firebase.ts` initialized from `/firebase-applet-config.json` with Google Auth sign-in and automatic Firestore hydration/backup for `autonomousAgents`, `executedOrders`, and `ml_telemetry_ledger` checkpoints alongside local DuckDB storage.

### Phase 2: Google Drive OAuth Permissions (`drive.file`)
1. **Trigger OAuth Provisioning (`set_up_oauth`)**:
   - Request scope `https://www.googleapis.com/auth/drive.file` so you can approve Google Drive Vault access directly in the AI Studio prompt card.
2. **Connect `GoogleDriveCopyPanel.tsx` to DuckDB ML Ledger & Agent State**:
   - Ensure the Google Drive Vault export/import bundle includes the live `ml_telemetry_ledger` rows (`/api/ml-store/export` and `/api/ml-store/import`) plus the `$65.00` dual-venue Kalshi + Public.com agent allocation state.

### Phase 3: Cloud Run Production Verification
1. **Verify Production Start Script & Stateless MCP Transport**:
   - Confirm `package.json` defines `"start": "tsx server.ts"` and `POST /api/mcp` operates strictly via stateless Streamable HTTP (`200 OK`) for zero-cost Cloud Run scale-to-zero compliance.
   - Run `compile_applet` and verify live telemetry and persistence endpoints.
