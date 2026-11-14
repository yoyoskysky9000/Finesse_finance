import type { Request, Response, NextFunction, RequestHandler } from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { initializeApp, getApps, applicationDefault, type App } from 'firebase-admin/app';
import { getAuth, type DecodedIdToken } from 'firebase-admin/auth';
import { getFirestore, Timestamp, type Firestore } from 'firebase-admin/firestore';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export type ExecutionMode = 'PAPER' | 'LIVE';

export interface RouteAccessEntry {
  method: 'GET' | 'POST';
  path: string;
  access: 'PUBLIC' | 'AUTHED';
  requireAdmin?: boolean;
  description: string;
}

export interface AuthenticatedRequest extends Request {
  firebaseUser?: DecodedIdToken;
}

export interface AllocationValidationInput {
  allocatedCapitalUsd?: number;
  kalshiAllocatedUsd?: number;
  publicAllocatedUsd?: number;
}

export interface LiveVenueBalances {
  kalshiCashUsd: number;
  publicCashUsd: number;
  combinedNlvUsd: number;
}

export interface AllocationValidationResult {
  valid: boolean;
  errors: string[];
  limits: {
    maxTotalAllocationUsd: number;
    maxKalshiAllocationUsd: number;
    maxPublicAllocationUsd: number;
    maxSingleAssetNlvUsd: number;
    availableKalshiCashUsd: number;
    availablePublicCashUsd: number;
  };
  validated: {
    allocatedCapitalUsd: number;
    kalshiAllocatedUsd: number;
    publicAllocatedUsd: number;
  };
}

export interface GlobalKillSwitchStateSnapshot {
  active: boolean;
  executionMode: ExecutionMode;
  sources: {
    envKillSwitch: boolean;
    memoryKillSwitch: boolean;
    fiveGateLocked: boolean;
    firestoreKillSwitch: boolean;
  };
  reason: string;
  checkedAt: string;
}

interface AppletFirebaseConfigFile {
  projectId?: string;
  firestoreDatabaseId?: string;
}

function readAppletFirebaseConfig(): AppletFirebaseConfigFile {
  try {
    const configPath = path.resolve(__dirname, '../../firebase-applet-config.json');
    const raw = fs.readFileSync(configPath, 'utf8');
    return JSON.parse(raw) as AppletFirebaseConfigFile;
  } catch {
    return {};
  }
}

const appletConfig = readAppletFirebaseConfig();
export const FIREBASE_PROJECT_ID =
  process.env.FIREBASE_PROJECT_ID || appletConfig.projectId || 'gen-lang-client-0057136781';
export const FIRESTORE_DATABASE_ID =
  process.env.FIRESTORE_DATABASE_ID ||
  appletConfig.firestoreDatabaseId ||
  'ai-studio-tradepulseai-5afcfb28-f923-42f2-a189-b764775d8ca2';

let adminApp: App | null = null;
let adminFirestore: Firestore | null = null;

export function getFirebaseAdminApp(): App {
  if (adminApp) return adminApp;
  const existing = getApps();
  if (existing.length > 0) {
    adminApp = existing[0]!;
    return adminApp;
  }
  try {
    adminApp = initializeApp({
      credential: applicationDefault(),
      projectId: FIREBASE_PROJECT_ID,
    });
  } catch {
    adminApp = initializeApp({
      projectId: FIREBASE_PROJECT_ID,
    });
  }
  return adminApp;
}

export function getAdminFirestore(): Firestore | null {
  if (adminFirestore) return adminFirestore;
  try {
    const app = getFirebaseAdminApp();
    adminFirestore = getFirestore(app, FIRESTORE_DATABASE_ID);
    return adminFirestore;
  } catch {
    return null;
  }
}

// ============================================================================
// EXECUTION MODE & GLOBAL KILL SWITCH (ENV + MEMORY + FIRESTORE)
// ============================================================================

let runtimeExecutionModeOverride: ExecutionMode | null = 'LIVE';

export function setRuntimeExecutionMode(mode: ExecutionMode): void {
  runtimeExecutionModeOverride = mode;
}

export function getConfiguredExecutionMode(): ExecutionMode {
  if (runtimeExecutionModeOverride) {
    return runtimeExecutionModeOverride;
  }
  const rawMode = (process.env.EXECUTION_MODE || 'LIVE').trim().toUpperCase();
  const allowLive = (process.env.ALLOW_LIVE_ORDERS || 'true').trim().toLowerCase() !== 'false';
  if (rawMode === 'LIVE' && allowLive) {
    return 'LIVE';
  }
  return 'PAPER';
}

export function isPaperModeEnabled(): boolean {
  return getConfiguredExecutionMode() === 'PAPER';
}

export function isEnvKillSwitchActive(): boolean {
  const val = (process.env.GLOBAL_KILL_SWITCH || '').trim().toLowerCase();
  return val === 'true' || val === '1' || val === 'yes' || val === 'on';
}

let cachedFirestoreKillSwitch: {
  active: boolean;
  reason: string;
  fetchedAtMs: number;
} = {
  active: false,
  reason: '',
  fetchedAtMs: 0,
};

const FIRESTORE_KILL_SWITCH_CACHE_TTL_MS = 2500;

export async function readFirestoreKillSwitchFlag(forceRefresh = false): Promise<{
  active: boolean;
  reason: string;
}> {
  const now = Date.now();
  if (!forceRefresh && now - cachedFirestoreKillSwitch.fetchedAtMs < FIRESTORE_KILL_SWITCH_CACHE_TTL_MS) {
    return {
      active: cachedFirestoreKillSwitch.active,
      reason: cachedFirestoreKillSwitch.reason,
    };
  }

  const db = getAdminFirestore();
  if (!db) {
    cachedFirestoreKillSwitch = { active: false, reason: '', fetchedAtMs: now };
    return { active: false, reason: '' };
  }

  try {
    const docRef = db.collection('system_controls').doc('kill_switch');
    const snap = await Promise.race([
      docRef.get(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 900)),
    ]);
    if (snap && snap.exists) {
      const data = snap.data() as Record<string, unknown> | undefined;
      const active = Boolean(data?.globalKillSwitchActive);
      const reason = typeof data?.reason === 'string' ? data.reason : 'Firestore /system_controls/kill_switch active';
      cachedFirestoreKillSwitch = { active, reason, fetchedAtMs: now };
      return { active, reason };
    }
  } catch {
    // Fallback to cached value if Admin SDK credentials are not provisioned in local container
  }

  cachedFirestoreKillSwitch = {
    active: cachedFirestoreKillSwitch.active,
    reason: cachedFirestoreKillSwitch.reason,
    fetchedAtMs: now,
  };
  return {
    active: cachedFirestoreKillSwitch.active,
    reason: cachedFirestoreKillSwitch.reason,
  };
}

export async function writeFirestoreKillSwitchFlag(params: {
  active: boolean;
  reason: string;
  updatedBy: string;
}): Promise<boolean> {
  cachedFirestoreKillSwitch = {
    active: params.active,
    reason: params.reason,
    fetchedAtMs: Date.now(),
  };

  const db = getAdminFirestore();
  if (!db) return false;

  try {
    const docRef = db.collection('system_controls').doc('kill_switch');
    await Promise.race([
      docRef.set(
        {
          controlId: 'kill_switch',
          globalKillSwitchActive: params.active,
          executionMode: getConfiguredExecutionMode(),
          reason: params.reason.slice(0, 256),
          updatedBy: params.updatedBy.slice(0, 128),
          updatedAt: Timestamp.now(),
        },
        { merge: true }
      ),
      new Promise<void>((resolve) => setTimeout(() => resolve(), 1200)),
    ]);
    return true;
  } catch {
    return false;
  }
}

export async function evaluateGlobalKillSwitch(params: {
  memoryKillSwitchActive: boolean;
  fiveGateLocked: boolean;
  forceFirestoreRefresh?: boolean;
}): Promise<GlobalKillSwitchStateSnapshot> {
  const envActive = isEnvKillSwitchActive();
  const fsState = await readFirestoreKillSwitchFlag(Boolean(params.forceFirestoreRefresh));
  const active =
    envActive || params.memoryKillSwitchActive || params.fiveGateLocked || fsState.active;

  let reason = 'NOMINAL';
  if (envActive) {
    reason = 'Blocked by GLOBAL_KILL_SWITCH environment variable';
  } else if (fsState.active) {
    reason = fsState.reason || 'Blocked by Firestore /system_controls/kill_switch flag';
  } else if (params.memoryKillSwitchActive) {
    reason = 'Blocked by in-memory globalKillSwitchActive operator flag';
  } else if (params.fiveGateLocked) {
    reason = 'Blocked by Gate 5 daily drawdown circuit breaker';
  }

  return {
    active,
    executionMode: getConfiguredExecutionMode(),
    sources: {
      envKillSwitch: envActive,
      memoryKillSwitch: params.memoryKillSwitchActive,
      fiveGateLocked: params.fiveGateLocked,
      firestoreKillSwitch: fsState.active,
    },
    reason,
    checkedAt: new Date().toISOString(),
  };
}

// ============================================================================
// SERVER-SIDE CAPITAL ALLOCATION VALIDATOR (PHASE 1.2)
// ============================================================================

export function validateServerSideCapitalAllocation(
  input: AllocationValidationInput,
  liveBalances: LiveVenueBalances
): AllocationValidationResult {
  const maxTotalAllocationUsd = Math.max(
    10,
    Number(process.env.MAX_TOTAL_AGENT_ALLOCATION_USD) || 250
  );
  const maxKalshiAllocationUsd = Math.max(
    5,
    Number(process.env.MAX_KALSHI_AGENT_ALLOCATION_USD) || 100
  );
  const maxPublicAllocationUsd = Math.max(
    5,
    Number(process.env.MAX_PUBLIC_AGENT_ALLOCATION_USD) || 150
  );
  const maxNlvFraction = Math.min(
    0.5,
    Math.max(0.01, Number(process.env.MAX_SINGLE_AGENT_NLV_FRACTION) || 0.12)
  );

  const availableKalshiCashUsd = Math.max(0, Number(liveBalances.kalshiCashUsd.toFixed(2)));
  const availablePublicCashUsd = Math.max(0, Number(liveBalances.publicCashUsd.toFixed(2)));
  const combinedNlvUsd = Math.max(
    availableKalshiCashUsd + availablePublicCashUsd,
    Number(liveBalances.combinedNlvUsd.toFixed(2))
  );
  const maxSingleAssetNlvUsd = Number((combinedNlvUsd * maxNlvFraction).toFixed(2));

  const errors: string[] = [];

  const reqKalshi =
    input.kalshiAllocatedUsd !== undefined ? Number(input.kalshiAllocatedUsd) : 0;
  const reqPublic =
    input.publicAllocatedUsd !== undefined ? Number(input.publicAllocatedUsd) : 0;
  const reqTotal =
    input.allocatedCapitalUsd !== undefined
      ? Number(input.allocatedCapitalUsd)
      : reqKalshi + reqPublic;

  if (!Number.isFinite(reqTotal) || reqTotal < 0) {
    errors.push('allocatedCapitalUsd must be a non-negative finite number.');
  }
  if (!Number.isFinite(reqKalshi) || reqKalshi < 0) {
    errors.push('kalshiAllocatedUsd must be a non-negative finite number.');
  }
  if (!Number.isFinite(reqPublic) || reqPublic < 0) {
    errors.push('publicAllocatedUsd must be a non-negative finite number.');
  }

  if (reqKalshi > maxKalshiAllocationUsd) {
    errors.push(
      `kalshiAllocatedUsd ($${reqKalshi.toFixed(2)}) exceeds configured max ($${maxKalshiAllocationUsd.toFixed(2)}).`
    );
  }
  if (reqKalshi > availableKalshiCashUsd) {
    errors.push(
      `kalshiAllocatedUsd ($${reqKalshi.toFixed(2)}) exceeds live Kalshi cash balance ($${availableKalshiCashUsd.toFixed(2)}).`
    );
  }

  if (reqPublic > maxPublicAllocationUsd) {
    errors.push(
      `publicAllocatedUsd ($${reqPublic.toFixed(2)}) exceeds configured max ($${maxPublicAllocationUsd.toFixed(2)}).`
    );
  }
  if (reqPublic > availablePublicCashUsd) {
    errors.push(
      `publicAllocatedUsd ($${reqPublic.toFixed(2)}) exceeds live Public.com cash balance ($${availablePublicCashUsd.toFixed(2)}).`
    );
  }

  const totalAvailableCash = Number((availableKalshiCashUsd + availablePublicCashUsd).toFixed(2));
  if (reqTotal > maxTotalAllocationUsd) {
    errors.push(
      `allocatedCapitalUsd ($${reqTotal.toFixed(2)}) exceeds configured max ($${maxTotalAllocationUsd.toFixed(2)}).`
    );
  }
  if (reqTotal > totalAvailableCash) {
    errors.push(
      `allocatedCapitalUsd ($${reqTotal.toFixed(2)}) exceeds combined live available cash ($${totalAvailableCash.toFixed(2)}).`
    );
  }
  if (reqTotal > maxSingleAssetNlvUsd && maxSingleAssetNlvUsd > 0) {
    errors.push(
      `allocatedCapitalUsd ($${reqTotal.toFixed(2)}) exceeds single-agent NLV cap ($${maxSingleAssetNlvUsd.toFixed(2)}).`
    );
  }

  const safeKalshi = Number(
    Math.max(0, Math.min(reqKalshi || 0, maxKalshiAllocationUsd, availableKalshiCashUsd)).toFixed(2)
  );
  const safePublic = Number(
    Math.max(0, Math.min(reqPublic || 0, maxPublicAllocationUsd, availablePublicCashUsd)).toFixed(2)
  );
  const safeTotal = Number(
    Math.max(
      0,
      Math.min(
        reqTotal || 0,
        maxTotalAllocationUsd,
        totalAvailableCash,
        maxSingleAssetNlvUsd > 0 ? maxSingleAssetNlvUsd : maxTotalAllocationUsd
      )
    ).toFixed(2)
  );

  return {
    valid: errors.length === 0,
    errors,
    limits: {
      maxTotalAllocationUsd,
      maxKalshiAllocationUsd,
      maxPublicAllocationUsd,
      maxSingleAssetNlvUsd,
      availableKalshiCashUsd,
      availablePublicCashUsd,
    },
    validated: {
      allocatedCapitalUsd: safeTotal,
      kalshiAllocatedUsd: safeKalshi,
      publicAllocatedUsd: safePublic,
    },
  };
}

// ============================================================================
// ADMIN SDK SERVER-ONLY AGENT SYNC (/quant_agents/{agentId})
// ============================================================================

export interface ServerAgentSyncRecord {
  id: string;
  ownerUid: string;
  name: string;
  targetSymbol: string;
  status: 'ACTIVE' | 'PAUSED' | 'KILLED_BY_RISK' | 'HALTED_BY_KILL_SWITCH';
  allocatedCapitalUsd: number;
  kalshiAllocatedUsd: number;
  publicAllocatedUsd: number;
  predictionMarketDataSource: string;
  sharpe: number;
  winRate: number;
  totalPnlUsd: number;
}

export async function syncAgentsViaAdminSdk(
  records: ServerAgentSyncRecord[]
): Promise<{ syncedCount: number; error?: string }> {
  const db = getAdminFirestore();
  if (!db) {
    return { syncedCount: 0, error: 'Admin Firestore instance unavailable' };
  }

  let syncedCount = 0;
  try {
    for (const rec of records) {
      const docRef = db.collection('quant_agents').doc(rec.id);
      const existing = await docRef.get();
      const nowTs = Timestamp.now();
      const createdAtTs =
        existing.exists && existing.data()?.createdAt ? existing.data()?.createdAt : nowTs;

      await docRef.set(
        {
          id: rec.id,
          ownerUid: rec.ownerUid,
          name: rec.name.slice(0, 120),
          targetSymbol: rec.targetSymbol.slice(0, 32),
          status: rec.status,
          allocatedCapitalUsd: Math.min(1000, Math.max(0, Number(rec.allocatedCapitalUsd) || 0)),
          kalshiAllocatedUsd: Math.min(500, Math.max(0, Number(rec.kalshiAllocatedUsd) || 0)),
          publicAllocatedUsd: Math.min(500, Math.max(0, Number(rec.publicAllocatedUsd) || 0)),
          predictionMarketDataSource: rec.predictionMarketDataSource.slice(0, 64),
          sharpe: Number.isFinite(rec.sharpe) ? rec.sharpe : 0,
          winRate: Math.min(100, Math.max(0, Number(rec.winRate) || 0)),
          totalPnlUsd: Number.isFinite(rec.totalPnlUsd) ? rec.totalPnlUsd : 0,
          createdAt: createdAtTs,
          updatedAt: nowTs,
        },
        { merge: true }
      );
      syncedCount += 1;
    }
    return { syncedCount };
  } catch (err: unknown) {
    return {
      syncedCount,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ============================================================================
// EXPRESS ROUTE ACCESS MANIFEST & MIDDLEWARE (PHASE 1.4)
// ============================================================================

export const API_ROUTE_ACCESS_MANIFEST: RouteAccessEntry[] = [
  // Public Read-Only Telemetry & Specification Routes
  { method: 'GET', path: '/api/security/routes', access: 'PUBLIC', description: 'Route access manifest, kill-switch status, and execution mode inspection' },
  { method: 'GET', path: '/api/state', access: 'PUBLIC', description: 'Read-only dashboard state snapshot' },
  { method: 'GET', path: '/api/playbook/state', access: 'PUBLIC', description: 'Read-only quant playbook and paper sniper state' },
  { method: 'GET', path: '/api/telemetry/bottlenecks', access: 'PUBLIC', description: 'Read-only pipeline latency telemetry' },
  { method: 'GET', path: '/api/kalshi/five-gate-brier', access: 'PUBLIC', description: 'Read-only 5-gate Brier calibration decomposition' },
  { method: 'GET', path: '/api/kalshi/gemini-cache-status', access: 'PUBLIC', description: 'Read-only Gemini context cache status' },
  { method: 'GET', path: '/api/kalshi/oct2026-spec', access: 'PUBLIC', description: 'Read-only Kalshi Oct 2026 specification telemetry' },
  { method: 'GET', path: '/api/mentions/state', access: 'PUBLIC', description: 'Read-only mention sniper state' },
  { method: 'GET', path: '/api/profit-lock/state', access: 'PUBLIC', description: 'Read-only profit-lock state' },
  { method: 'GET', path: '/api/scanner/scan', access: 'PUBLIC', description: 'Read-only alpha opportunity scanner' },
  { method: 'GET', path: '/api/backtest/tournament', access: 'PUBLIC', description: 'Read-only strategy tournament leaderboard' },
  { method: 'GET', path: '/api/mcp/entitlements', access: 'PUBLIC', description: 'Read-only MCP tier entitlements' },
  { method: 'GET', path: '/api/mcp', access: 'PUBLIC', description: 'Read-only MCP server metadata' },
  { method: 'GET', path: '/api/mcp/sse', access: 'PUBLIC', description: 'Read-only MCP SSE stream' },
  { method: 'GET', path: '/api/mcp/python-server', access: 'PUBLIC', description: 'Read-only mcp_server.py source view' },
  { method: 'GET', path: '/api/mcp/state', access: 'PUBLIC', description: 'Read-only MCP connections and tool logs' },
  { method: 'GET', path: '/api/ml-store/export', access: 'PUBLIC', description: 'Read-only ML feature store snapshot' },
  { method: 'GET', path: '/api/deep-dive/package', access: 'PUBLIC', description: 'Read-only 15m post-mortem analysis package' },
  { method: 'GET', path: '/api/app-bundle/export', access: 'PUBLIC', description: 'Read-only application bundle export' },
  { method: 'GET', path: '/api/meta-learning/state', access: 'PUBLIC', description: 'Read-only meta-learning bandit state' },
  { method: 'GET', path: '/api/orchestrator/state', access: 'PUBLIC', description: 'Read-only 3-Phase Autonomous Orchestrator & PostgreSQL 16 telemetry snapshot' },
  { method: 'GET', path: '/api/lead-lag/zero-hold-state', access: 'PUBLIC', description: 'Read-only Zero-Hold Latency Lead-Lag Micro-Scalper & 5-Series matrix state' },

  // Authenticated State-Mutating, Account-Sync, & Execution Routes (Verify Firebase ID Token)
  { method: 'POST', path: '/api/telemetry/bottlenecks/benchmark', access: 'AUTHED', description: 'Run live latency probe benchmark' },
  { method: 'POST', path: '/api/telemetry/bottlenecks/optimize', access: 'AUTHED', description: 'Toggle connection pooling optimization' },
  { method: 'POST', path: '/api/playbook/tweak-lead-lag-paper', access: 'AUTHED', description: 'Configure Lead-Lag Sniper paper mode parameters' },
  { method: 'POST', path: '/api/playbook/evaluate-lead-lag', access: 'AUTHED', description: 'Evaluate Lead-Lag Sniper signal (paper mode)' },
  { method: 'POST', path: '/api/playbook/sweep-dust', access: 'AUTHED', description: 'Run portfolio dust sweeper (paper mode)' },
  { method: 'POST', path: '/api/playbook/apply-upgrades', access: 'AUTHED', description: 'Apply quant playbook configuration upgrades' },
  { method: 'POST', path: '/api/public/sync', access: 'AUTHED', description: 'Trigger authenticated Public.com account sync' },
  { method: 'POST', path: '/api/kalshi/sync', access: 'AUTHED', description: 'Trigger authenticated Kalshi portfolio sync' },
  { method: 'POST', path: '/api/public/execute-burst', access: 'AUTHED', description: 'Execute Public.com strategy pulse (paper-gated & kill-switch checked)' },
  { method: 'POST', path: '/api/public/place-sell-orders', access: 'AUTHED', description: 'Stage Public.com take-profit sells (paper-gated & kill-switch checked)' },
  { method: 'POST', path: '/api/kalshi/hft-burst', access: 'AUTHED', description: 'Execute Kalshi 15m pulse (paper-gated & kill-switch checked)' },
  { method: 'POST', path: '/api/kalshi/place-sell-orders', access: 'AUTHED', description: 'Stage Kalshi take-profit sells (paper-gated & kill-switch checked)' },
  { method: 'POST', path: '/api/kalshi/five-gate-evaluate', access: 'AUTHED', description: 'Evaluate 5-gate risk engine (paper-gated & kill-switch checked)' },
  { method: 'POST', path: '/api/kalshi/five-gate-settle', access: 'AUTHED', description: 'Settle Brier prediction row' },
  { method: 'POST', path: '/api/kalshi/gemini-signal', access: 'AUTHED', description: 'Run Gemini structured signal deliberation' },
  { method: 'POST', path: '/api/mentions/analyze-speaker', access: 'AUTHED', description: 'Analyze speaker transcript cadence' },
  { method: 'POST', path: '/api/mentions/trigger-sniper', access: 'AUTHED', description: 'Trigger mention sniper evaluation (paper-gated & kill-switch checked)' },
  { method: 'POST', path: '/api/market/tick', access: 'AUTHED', description: 'Advance simulated market tick' },
  { method: 'POST', path: '/api/profit-lock/evaluate', access: 'AUTHED', description: 'Evaluate ROI profit-lock parameters (paper-gated & kill-switch checked)' },
  { method: 'POST', path: '/api/quant/evaluate', access: 'AUTHED', description: 'Run Gemini regime evaluation' },
  { method: 'POST', path: '/api/feeds/toggle', access: 'AUTHED', description: 'Toggle market data feed subscription' },
  { method: 'POST', path: '/api/agents/spawn', access: 'AUTHED', description: 'Spawn agent with server-validated capital allocation' },
  { method: 'POST', path: '/api/agents/update-allocation', access: 'AUTHED', description: 'Update agent capital allocation (validated against live account balances)' },
  { method: 'POST', path: '/api/agents/sync-firestore', access: 'AUTHED', description: 'Server-side Admin SDK sync of agent status & metrics to Firestore' },
  { method: 'POST', path: '/api/agents/deploy-best-strategy', access: 'AUTHED', description: 'Deploy top tournament strategy to agent (paper-gated)' },
  { method: 'POST', path: '/api/agents/deploy-15m-hft-winner', access: 'AUTHED', description: 'Deploy 15m HFT strategy to agent (paper-gated)' },
  { method: 'POST', path: '/api/agents/meta-optimize', access: 'AUTHED', description: 'Run agent meta-optimization' },
  { method: 'POST', path: '/api/agents/execute-trade', access: 'AUTHED', description: 'Execute agent trade (paper-gated & kill-switch checked)' },
  { method: 'POST', path: '/api/agents/toggle-status', access: 'AUTHED', description: 'Toggle agent status (admin required to clear KILLED_BY_RISK / HALTED_BY_KILL_SWITCH)' },
  { method: 'POST', path: '/api/agents/fund-top-agent', access: 'AUTHED', description: 'Fund top agent with server-side balance & cap validation (paper-gated)' },
  { method: 'POST', path: '/api/agents/auto-rebalance', access: 'AUTHED', description: 'Toggle or execute periodic UCB1 bandit auto-rebalance shifting capital from underperforming agents to top 2 highest-Sharpe agents' },
  { method: 'POST', path: '/api/risk/stress-test', access: 'AUTHED', description: 'Simulate ATR volatility shock circuit breaker' },
  { method: 'POST', path: '/api/risk/global-kill-switch', access: 'AUTHED', description: 'Toggle global kill switch in memory and Firestore (/system_controls/kill_switch)' },
  { method: 'POST', path: '/api/risk/acknowledge', access: 'AUTHED', description: 'Acknowledge risk event notifications' },
  { method: 'POST', path: '/api/backtest/run', access: 'AUTHED', description: 'Run single-strategy backtest' },
  { method: 'POST', path: '/api/backtest/compare', access: 'AUTHED', description: 'Run comparative strategy backtest' },
  { method: 'POST', path: '/api/mcp/license/generate', access: 'AUTHED', description: 'Generate MCP license key' },
  { method: 'POST', path: '/api/mcp', access: 'AUTHED', description: 'Invoke JSON-RPC 2.0 MCP endpoint' },
  { method: 'POST', path: '/api/mcp/prompt', access: 'AUTHED', description: 'Execute MCP prompt template' },
  { method: 'POST', path: '/api/mcp/invoke', access: 'AUTHED', description: 'Invoke MCP tool from inspector' },
  { method: 'POST', path: '/api/mcp/connect', access: 'AUTHED', description: 'Connect external MCP node' },
  { method: 'POST', path: '/api/ml-store/import', access: 'AUTHED', description: 'Import ML telemetry ledger snapshot' },
  { method: 'POST', path: '/api/ml-store/optimize', access: 'AUTHED', description: 'Train and optimize ML meta-model' },
  { method: 'POST', path: '/api/deep-dive/package', access: 'AUTHED', description: 'Generate 15m post-mortem analysis package' },
  { method: 'POST', path: '/api/app-bundle/restore', access: 'AUTHED', description: 'Restore application state from Drive bundle' },
  { method: 'POST', path: '/api/meta-learning/run-closed-loop', access: 'AUTHED', description: 'Run closed-loop meta-learning cycle (paper-gated & kill-switch checked)' },
  { method: 'POST', path: '/api/accounts/reset-and-allocate-100', access: 'AUTHED', description: 'Reset and validate account allocations (paper-gated & kill-switch checked)' },
  { method: 'POST', path: '/api/orchestrator/run-cycle', access: 'AUTHED', description: 'Execute 3-Phase Autonomous Quantitative Execution & Risk Orchestrator cycle (4-call MCP budget)' },
  { method: 'POST', path: '/api/orchestrator/sql-query', access: 'AUTHED', description: 'Execute validated PostgreSQL 16 read_market_query against portfolio_positions & market_signals' },
  { method: 'POST', path: '/api/lead-lag/execute-zero-hold-scalp', access: 'AUTHED', description: 'Execute sub-250ms Zero-Hold Latency Lead-Lag scalp with 15-45s time-stop and 75% profit vaulting' },
];

const PUBLIC_GET_PATHS = new Set<string>(
  API_ROUTE_ACCESS_MANIFEST.filter((r) => r.access === 'PUBLIC' && r.method === 'GET').map(
    (r) => r.path
  )
);

export const securityHeadersMiddleware = helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
});

function resolveRateLimitClientKey(req: Request): string {
  const forwardedHeader = req.headers.forwarded;
  if (typeof forwardedHeader === 'string' && forwardedHeader.length > 0) {
    const forMatch = forwardedHeader.match(/for="?\[?([^;\],"]+)/i);
    if (forMatch?.[1]) {
      return forMatch[1].trim();
    }
  }
  const xForwardedFor = req.headers['x-forwarded-for'];
  if (typeof xForwardedFor === 'string' && xForwardedFor.length > 0) {
    const firstIp = xForwardedFor.split(',')[0]?.trim();
    if (firstIp) {
      return firstIp;
    }
  }
  return req.ip || req.socket?.remoteAddress || '127.0.0.1';
}

export const apiGeneralRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.API_RATE_LIMIT_PER_MIN) || 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: resolveRateLimitClientKey,
  validate: {
    xForwardedForHeader: false,
    forwardedHeader: false,
    trustProxy: false,
    default: false,
  },
  message: {
    error: 'Too many API requests from this IP; please retry after 60 seconds.',
    code: 'RATE_LIMIT_EXCEEDED',
  },
});

export const apiMutationRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.API_MUTATION_RATE_LIMIT_PER_MIN) || 35,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: resolveRateLimitClientKey,
  validate: {
    xForwardedForHeader: false,
    forwardedHeader: false,
    trustProxy: false,
    default: false,
  },
  skip: (req: Request) => req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS',
  message: {
    error: 'Too many state-mutating requests; rate limit exceeded.',
    code: 'MUTATION_RATE_LIMIT_EXCEEDED',
  },
});

let customTokenVerifier: ((token: string) => Promise<DecodedIdToken | null>) | null = null;

export function setCustomTokenVerifier(
  verifier: ((token: string) => Promise<DecodedIdToken | null>) | null
): void {
  customTokenVerifier = verifier;
}

export const firebaseIdTokenAuthMiddleware: RequestHandler = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const cleanPath = req.path.startsWith('/api') ? req.path : `/api${req.path}`;
  const methodUpper = req.method.toUpperCase();

  if (methodUpper === 'OPTIONS') {
    next();
    return;
  }

  // Allow explicitly listed read-only PUBLIC GET routes without requiring an ID token
  if (methodUpper === 'GET' && PUBLIC_GET_PATHS.has(cleanPath)) {
    next();
    return;
  }

  const authHeader = req.headers.authorization || '';
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  const idToken = bearerMatch?.[1]?.trim() || '';

  // Strict auth is the default (fail closed). Only an explicit STRICT_API_AUTH_REQUIRED=false acts as a loudly-logged dev override.
  const strictAuthRequired =
    (process.env.STRICT_API_AUTH_REQUIRED || 'true').trim().toLowerCase() !== 'false';

  if (!idToken) {
    if (!strictAuthRequired) {
      console.warn(
        `[SECURITY WARNING] Development override STRICT_API_AUTH_REQUIRED=false is active: bypassing token check for ${methodUpper} ${cleanPath} (no session fabricated).`
      );
      next();
      return;
    }
    res.status(401).json({
      error: 'Authentication required: provide a valid Firebase ID token in the Authorization: Bearer <token> header.',
      code: 'FIREBASE_ID_TOKEN_REQUIRED',
      method: methodUpper,
      path: cleanPath,
    });
    return;
  }

  try {
    if (customTokenVerifier) {
      const customDecoded = await customTokenVerifier(idToken);
      if (!customDecoded) {
        res.status(401).json({
          error: 'Firebase ID token verification failed: token rejected by verifier.',
          code: 'INVALID_FIREBASE_ID_TOKEN',
          method: methodUpper,
          path: cleanPath,
        });
        return;
      }
      req.firebaseUser = customDecoded;
      next();
      return;
    }
    getFirebaseAdminApp();
    const decoded = await getAuth().verifyIdToken(idToken);
    req.firebaseUser = decoded;
    next();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Invalid Firebase ID token';
    res.status(401).json({
      error: `Firebase ID token verification failed: ${msg}`,
      code: 'INVALID_FIREBASE_ID_TOKEN',
      method: methodUpper,
      path: cleanPath,
    });
  }
};

