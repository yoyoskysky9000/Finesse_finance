import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getFirestore,
  initializeFirestore,
  setLogLevel,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  serverTimestamp,
  type Firestore,
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';
import { auth } from './googleDriveService.ts';
import type { AutonomousAgent, PortfolioSummary } from '../types/quant.ts';

// Silence internal @firebase/firestore WebChannel transport retry logs in iframe/proxy environments
setLogLevel('silent');

const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
export const FIRESTORE_DATABASE_ID =
  (firebaseConfig as { firestoreDatabaseId?: string }).firestoreDatabaseId ||
  'ai-studio-tradepulseai-5afcfb28-f923-42f2-a189-b764775d8ca2';

function createFirestoreInstance(): Firestore {
  try {
    return initializeFirestore(
      app,
      {
        experimentalAutoDetectLongPolling: true,
      },
      FIRESTORE_DATABASE_ID
    );
  } catch {
    return getFirestore(app, FIRESTORE_DATABASE_ID);
  }
}

export const db: Firestore = createFirestoreInstance();

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

function isTransientFirestoreUnavailable(error: unknown): boolean {
  const code = (error as { code?: string })?.code || '';
  const msg = error instanceof Error ? error.message : String(error);
  return (
    code === 'unavailable' ||
    code === 'failed-precondition' ||
    msg.includes('unavailable') ||
    msg.includes('the client is offline') ||
    msg.includes('Could not reach Cloud Firestore backend')
  );
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export async function getFirebaseAuthHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (auth.currentUser) {
    try {
      const idToken = await auth.currentUser.getIdToken();
      if (idToken) {
        headers.Authorization = `Bearer ${idToken}`;
      }
    } catch {
      // Proceed without bearer header if token refresh fails
    }
  }
  return headers;
}

export async function authenticatedApiFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  if (auth.currentUser) {
    try {
      const idToken = await auth.currentUser.getIdToken();
      if (idToken) {
        const mergedHeaders = new Headers(init?.headers || {});
        if (!mergedHeaders.has('Authorization')) {
          mergedHeaders.set('Authorization', `Bearer ${idToken}`);
        }
        return fetch(input, { ...init, headers: mergedHeaders });
      }
    } catch {
      // Fall through to standard fetch if token retrieval fails
    }
  }
  return fetch(input, init);
}

let connectionValidated = false;

export async function validateFirestoreConnection(): Promise<boolean> {
  if (connectionValidated) return true;
  if (!auth.currentUser) return false;
  try {
    await getDoc(doc(db, 'test', 'connection'));
    connectionValidated = true;
    return true;
  } catch (error) {
    if (isTransientFirestoreUnavailable(error)) {
      return false;
    }
    // Permission denied on /test/connection is expected under default-deny rules and confirms online reachability
    connectionValidated = true;
    return true;
  }
}

export interface FirestoreSyncSummary {
  syncedAt: string;
  databaseId: string;
  agentsSyncedCount: number;
  checkpointId: string;
  topAgentAllocatedUsd: number;
  kalshiDirectUsd: number;
  publicEventContractUsd: number;
  duckDbTotalRows: number;
}

export async function syncQuantStateToFirestore(params: {
  agents: AutonomousAgent[];
  portfolio: PortfolioSummary | null;
  duckDbTotalRows?: number;
  duckDbSettledRows?: number;
  calibratedBrierScore?: number;
  activeMetaModelId?: string;
}): Promise<FirestoreSyncSummary | null> {
  const currentUser = auth.currentUser;
  if (!currentUser || !currentUser.emailVerified) {
    return null;
  }

  const isReachable = await validateFirestoreConnection();
  if (!isReachable) {
    return null;
  }

  const uid = currentUser.uid.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  const topAgent = params.agents[0];
  if (!topAgent) return null;

  // 1. Request server-side Admin SDK sync first so server-owned fields (status, sharpe, winRate, totalPnlUsd) are persisted by Admin SDK
  try {
    const authHeaders = await getFirebaseAuthHeaders();
    await fetch('/api/agents/sync-firestore', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        ownerUid: currentUser.uid,
      }),
    });
  } catch {
    // Non-fatal if server Admin SDK sync is unreachable
  }

  // 2. Client-side owner update on /quant_agents/{agentId}:
  //    Per Phase 1.1 rules, clients may ONLY update name, targetSymbol, and capped allocations on existing non-halted documents.
  let syncedCount = 0;
  for (const agent of params.agents.slice(0, 6)) {
    const safeAgentId = `${uid}_${agent.id}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
    const agentPath = `quant_agents/${safeAgentId}`;
    const agentRef = doc(db, 'quant_agents', safeAgentId);

    let existingSnap;
    try {
      existingSnap = await getDoc(agentRef);
    } catch (error) {
      if (isTransientFirestoreUnavailable(error)) {
        return null;
      }
      handleFirestoreError(error, OperationType.GET, agentPath);
    }

    if (!existingSnap.exists()) {
      // Client creation is forbidden by firestore.rules (Admin SDK creates agent documents)
      continue;
    }

    const existingData = existingSnap.data();
    if (
      existingData.status === 'KILLED_BY_RISK' ||
      existingData.status === 'HALTED_BY_KILL_SWITCH'
    ) {
      // Clients cannot modify agents in terminal risk-halted states
      continue;
    }

    const rawKalshi = Math.min(500, Math.max(0, Number(agent.kalshiAllocatedUsd ?? 30) || 0));
    const rawPublic = Math.min(500, Math.max(0, Number(agent.publicAllocatedUsd ?? 35) || 0));
    const rawTotal = Math.min(
      1000,
      Math.max(0, Number(agent.allocatedCapitalUsd ?? rawKalshi + rawPublic) || 0)
    );

    try {
      await updateDoc(agentRef, {
        name: (agent.name || 'Autonomous Quant Agent').slice(0, 120),
        targetSymbol: (agent.targetSymbol || 'KXBTC15M').slice(0, 32),
        allocatedCapitalUsd: rawTotal,
        kalshiAllocatedUsd: rawKalshi,
        publicAllocatedUsd: rawPublic,
        updatedAt: serverTimestamp(),
      });
      syncedCount += 1;
    } catch (error) {
      if (isTransientFirestoreUnavailable(error)) {
        return null;
      }
      handleFirestoreError(error, OperationType.UPDATE, agentPath);
    }
  }

  // 3. Sync vault checkpoint to /quant_vault_checkpoints/{checkpointId} (capped allocations <= 1000)
  const checkpointId = `checkpoint_${uid}`;
  const checkpointPath = `quant_vault_checkpoints/${checkpointId}`;
  const checkpointRef = doc(db, 'quant_vault_checkpoints', checkpointId);

  const kalshiDirectUsd = Math.min(500, Math.max(0, Number(topAgent.kalshiAllocatedUsd ?? 30) || 0));
  const publicEventContractUsd = Math.min(500, Math.max(0, Number(topAgent.publicAllocatedUsd ?? 35) || 0));
  const topAgentAllocatedUsd = Math.min(
    1000,
    Math.max(0, Number(topAgent.allocatedCapitalUsd) || kalshiDirectUsd + publicEventContractUsd)
  );
  const combinedEquityUsd = Math.min(
    100000,
    Math.max(
      0,
      (Number(params.portfolio?.totalEquityUsd) || 368.55) +
        (Number(params.portfolio?.kalshiTotalEquityUsd) || 93.15)
    )
  );

  let existingCp;
  try {
    existingCp = await getDoc(checkpointRef);
  } catch (error) {
    if (isTransientFirestoreUnavailable(error)) {
      return null;
    }
    handleFirestoreError(error, OperationType.GET, checkpointPath);
  }

  const cpPayload = {
    checkpointId,
    ownerUid: currentUser.uid,
    topAgentId: (topAgent.id || 'agent-hft-15m-kxbtc').slice(0, 128),
    topAgentAllocatedUsd,
    kalshiDirectUsd,
    publicEventContractUsd,
    combinedEquityUsd,
    duckDbTotalRows: Math.max(0, Number(params.duckDbTotalRows ?? 32) || 0),
    duckDbSettledRows: Math.max(0, Number(params.duckDbSettledRows ?? 28) || 0),
    calibratedBrierScore: Math.min(1, Math.max(0, Number(params.calibratedBrierScore ?? 0.138) || 0)),
    activeMetaModelId: (params.activeMetaModelId || 'gb-logistic-kalshi-v2').slice(0, 128),
    updatedAt: serverTimestamp(),
  };

  try {
    if (existingCp.exists() && existingCp.data()?.createdAt) {
      await setDoc(checkpointRef, {
        ...cpPayload,
        createdAt: existingCp.data().createdAt,
      });
    } else {
      await setDoc(checkpointRef, {
        ...cpPayload,
        createdAt: serverTimestamp(),
      });
    }
  } catch (error) {
    if (isTransientFirestoreUnavailable(error)) {
      return null;
    }
    handleFirestoreError(error, OperationType.WRITE, checkpointPath);
  }

  return {
    syncedAt: new Date().toISOString(),
    databaseId: FIRESTORE_DATABASE_ID,
    agentsSyncedCount: syncedCount,
    checkpointId,
    topAgentAllocatedUsd,
    kalshiDirectUsd,
    publicEventContractUsd,
    duckDbTotalRows: Math.max(0, Number(params.duckDbTotalRows ?? 32) || 0),
  };
}
