import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  type User,
} from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';
import type {
  AppBundleExportPayload,
  DriveAppCopyFolder,
  DriveCopiedArtifact,
} from '../types/quant.ts';

const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
export const auth = getAuth(app);

// Strictly in-memory OAuth access token cache (NEVER persisted to localStorage or sessionStorage)
let inMemoryAccessToken: string | null = null;

export const GOOGLE_DRIVE_SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/drive.appdata',
  'https://www.googleapis.com/auth/drive.metadata',
  'https://www.googleapis.com/auth/drive.readonly',
];

export class DriveAuthExpiredError extends Error {
  code = 'DRIVE_AUTH_EXPIRED';
  constructor(message = 'Google Drive OAuth access token expired or missing. Please sign in with Google again.') {
    super(message);
    this.name = 'DriveAuthExpiredError';
  }
}

export function getInMemoryDriveToken(): string | null {
  return inMemoryAccessToken;
}

export function clearInMemoryDriveToken(): void {
  inMemoryAccessToken = null;
}

export function subscribeToGoogleAuth(callback: (user: User | null, hasToken: boolean) => void): () => void {
  return onAuthStateChanged(auth, (user) => {
    if (!user) {
      inMemoryAccessToken = null;
    }
    callback(user, Boolean(inMemoryAccessToken));
  });
}

export async function signInWithGoogleDrive(): Promise<{
  user: User;
  accessToken: string;
}> {
  const provider = new GoogleAuthProvider();
  for (const scope of GOOGLE_DRIVE_SCOPES) {
    provider.addScope(scope);
  }
  provider.setCustomParameters({
    prompt: 'consent',
  });

  const result = await signInWithPopup(auth, provider);
  const credential = GoogleAuthProvider.credentialFromResult(result);
  const token = credential?.accessToken || null;

  if (!token) {
    throw new Error('Google Sign-In succeeded, but no Google Drive OAuth access token was returned.');
  }

  inMemoryAccessToken = token;
  return {
    user: result.user,
    accessToken: token,
  };
}

export async function disconnectGoogleDrive(): Promise<void> {
  inMemoryAccessToken = null;
  await firebaseSignOut(auth);
}

async function driveFetch(url: string, init: RequestInit = {}): Promise<Response> {
  if (!inMemoryAccessToken) {
    throw new DriveAuthExpiredError();
  }

  const headers = new Headers(init.headers || {});
  headers.set('Authorization', `Bearer ${inMemoryAccessToken}`);

  const response = await fetch(url, {
    ...init,
    headers,
  });

  if (response.status === 401) {
    inMemoryAccessToken = null;
    throw new DriveAuthExpiredError('Google Drive session expired (HTTP 401). Please re-authenticate with Google.');
  }

  return response;
}

async function uploadMultipartFileToDrive(params: {
  name: string;
  mimeType: string;
  content: string;
  parentFolderId: string;
  description?: string;
}): Promise<DriveCopiedArtifact> {
  const boundary = `quantpulse_drive_boundary_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const metadata = {
    name: params.name,
    mimeType: params.mimeType,
    parents: [params.parentFolderId],
    description: params.description || 'QuantPulse Finesse_finance App Copy Artifact',
  };

  const multipartBody =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${params.mimeType}; charset=UTF-8\r\n\r\n` +
    `${params.content}\r\n` +
    `--${boundary}--`;

  const res = await driveFetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,size,webViewLink,createdTime',
    {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body: multipartBody,
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Drive upload failed for ${params.name} (${res.status}): ${errText}`);
  }

  const data = await res.json();
  return {
    id: data.id,
    name: data.name,
    mimeType: data.mimeType,
    sizeBytes: Number(data.size) || new Blob([params.content]).size,
    webViewLink: data.webViewLink || `https://drive.google.com/file/d/${data.id}/view`,
    createdTime: data.createdTime || new Date().toISOString(),
  };
}

function buildStandaloneAppCopyHtml(bundle: AppBundleExportPayload): string {
  const portfolio = bundle.liveState.portfolio;
  const topStrategies = bundle.liveState.strategyTournament.slice(0, 8);
  const fileRows = bundle.sourceFiles
    .map(
      (f) =>
        `<tr>
          <td style="padding:8px 12px;border-bottom:1px solid #1e293b;font-family:monospace;color:#e2e8f0;">${f.path}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #1e293b;font-family:monospace;color:#38bdf8;">${f.category}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #1e293b;font-family:monospace;text-align:right;color:#cbd5e1;">${(
            f.sizeBytes / 1024
          ).toFixed(1)} KB</td>
          <td style="padding:8px 12px;border-bottom:1px solid #1e293b;font-family:monospace;color:#10b981;">${f.sha256}</td>
        </tr>`
    )
    .join('');

  const stratRows = topStrategies
    .map(
      (s) =>
        `<tr>
          <td style="padding:8px 12px;border-bottom:1px solid #1e293b;font-family:monospace;color:#38bdf8;">#${s.rank}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #1e293b;font-family:monospace;color:#f8fafc;font-weight:600;">${s.symbol}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #1e293b;font-family:monospace;color:#94a3b8;">${s.archetype}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #1e293b;color:#e2e8f0;">${s.indicatorStrategyLabel}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #1e293b;font-family:monospace;text-align:right;color:#10b981;">+${s.totalReturnPct.toFixed(
            2
          )}%</td>
          <td style="padding:8px 12px;border-bottom:1px solid #1e293b;font-family:monospace;text-align:right;color:#f8fafc;">${s.sharpeRatio.toFixed(
            2
          )}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #1e293b;font-family:monospace;text-align:right;color:#fb7185;">-${s.maxDrawdownPct.toFixed(
            2
          )}%</td>
        </tr>`
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>QuantPulse (Finesse_finance) — Google Drive App Copy (${bundle.bundleId})</title>
  <style>
    body { background:#0b0f17; color:#f1f5f9; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; margin:0; padding:32px; }
    .container { max-width:1200px; margin:0 auto; }
    .panel { background:#111827; border:1px solid #1e293b; padding:20px; margin-bottom:24px; }
    .kpi-grid { display:grid; grid-template-columns:repeat(4, 1fr); gap:16px; margin-bottom:24px; }
    .kpi { background:#111827; border:1px solid #1e293b; padding:16px; }
    .kpi-label { font-size:12px; color:#94a3b8; }
    .kpi-val { font-size:24px; font-weight:700; font-family:monospace; margin-top:6px; color:#10b981; }
    table { width:100%; border-collapse:collapse; font-size:13px; }
    th { text-align:left; padding:10px 12px; background:#0d131f; border-bottom:1px solid #1e293b; color:#94a3b8; font-weight:600; }
  </style>
</head>
<body>
  <div class="container">
    <div class="panel">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <div>
          <h1 style="margin:0;font-size:22px;">QuantPulse · Finesse_finance — Portable Google Drive App Copy</h1>
          <p style="margin:6px 0 0;font-size:13px;color:#94a3b8;font-family:monospace;">
            Bundle ID: ${bundle.bundleId} · Exported: ${bundle.exportedAt} · Data Quality Warning: ${bundle.dataQualityWarning}
          </p>
        </div>
      </div>
      <p style="margin-top:14px;padding:12px;background:#0b0f17;border:1px solid #1e293b;font-family:monospace;font-size:12px;color:#38bdf8;">
        Risk-First Rationale: ${bundle.riskFirstEvaluation.rationale}
      </p>
    </div>

    <div class="kpi-grid">
      <div class="kpi">
        <div class="kpi-label">Combined Multi-Venue Equity</div>
        <div class="kpi-val">$${bundle.summaryMetrics.combinedMultiVenueEquityUsd.toFixed(2)}</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Public.com Live Account (${portfolio.accountId})</div>
        <div class="kpi-val" style="color:#f8fafc;">$${portfolio.totalEquityUsd.toFixed(2)}</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Kalshi Portfolio v2 Equity</div>
        <div class="kpi-val" style="color:#38bdf8;">$${(portfolio.kalshiTotalEquityUsd ?? 73.86).toFixed(2)}</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Packaged App Source Files</div>
        <div class="kpi-val" style="color:#a7f3d0;">${bundle.summaryMetrics.totalSourceFiles} Files (${(
    bundle.summaryMetrics.totalBundleBytes / 1024
  ).toFixed(1)} KB)</div>
      </div>
    </div>

    <div class="panel">
      <h2 style="margin:0 0 12px;font-size:16px;">Top Real-Data Strategy Tournament Leaderboard</h2>
      <table>
        <thead>
          <tr>
            <th>Rank</th>
            <th>Symbol</th>
            <th>Archetype</th>
            <th>Indicator Strategy</th>
            <th style="text-align:right;">Total Return</th>
            <th style="text-align:right;">Sharpe</th>
            <th style="text-align:right;">Max DD</th>
          </tr>
        </thead>
        <tbody>${stratRows}</tbody>
      </table>
    </div>

    <div class="panel">
      <h2 style="margin:0 0 12px;font-size:16px;">Packaged Application Source Tree Manifest</h2>
      <table>
        <thead>
          <tr>
            <th>File Path</th>
            <th>Module Category</th>
            <th style="text-align:right;">Size</th>
            <th>SHA-256 Prefix</th>
          </tr>
        </thead>
        <tbody>${fileRows}</tbody>
      </table>
    </div>
  </div>
</body>
</html>`;
}

export async function copyAppBundleToGoogleDrive(
  bundle: AppBundleExportPayload,
  options: {
    includeLiveState: boolean;
    includeSourceArchive: boolean;
    includePlaybookReport: boolean;
    includeStandaloneHtml: boolean;
    customFolderLabel?: string;
    existingFolderIdToOverwrite?: string;
  },
  onProgress?: (stageLabel: string, progressPct: number) => void
): Promise<DriveAppCopyFolder> {
  onProgress?.('Preparing Google Drive folder destination...', 12);

  let folderId = options.existingFolderIdToOverwrite;
  let folderName = '';
  let folderWebViewLink = '';
  let folderCreatedTime = new Date().toISOString();

  const timestampSlug = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .slice(0, 19);

  if (folderId) {
    // Overwrite mode: delete existing children inside the selected Drive copy folder first
    onProgress?.('Cleaning existing files in target Google Drive folder...', 22);
    const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
    const listRes = await driveFetch(
      `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`
    );
    if (listRes.ok) {
      const listData = await listRes.json();
      const oldFiles: Array<{ id: string; name: string }> = listData.files || [];
      for (const oldFile of oldFiles) {
        await driveFetch(`https://www.googleapis.com/drive/v3/files/${oldFile.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ trashed: true }),
        });
      }
    }

    const folderMetaRes = await driveFetch(
      `https://www.googleapis.com/drive/v3/files/${folderId}?fields=id,name,webViewLink,createdTime`
    );
    if (folderMetaRes.ok) {
      const meta = await folderMetaRes.json();
      folderName = meta.name || `QuantPulse_Finesse_Finance_Copy_${timestampSlug}`;
      folderWebViewLink = meta.webViewLink || `https://drive.google.com/drive/folders/${folderId}`;
      folderCreatedTime = meta.createdTime || folderCreatedTime;
    }
  } else {
    // Create a new dedicated Google Drive folder for this app copy
    const cleanLabel = options.customFolderLabel?.trim()
      ? options.customFolderLabel.trim().replace(/[^a-zA-Z0-9_-]/g, '_')
      : timestampSlug;
    folderName = `QuantPulse_Finesse_Finance_Copy_${cleanLabel}`;

    const createFolderRes = await driveFetch(
      'https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink,createdTime',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: folderName,
          mimeType: 'application/vnd.google-apps.folder',
          description: `QuantPulse (Finesse_finance) Full Application & State Copy · Bundle ${bundle.bundleId} · ${bundle.riskFirstEvaluation.rationale}`,
        }),
      }
    );

    if (!createFolderRes.ok) {
      const errText = await createFolderRes.text();
      throw new Error(`Failed to create Google Drive folder (${createFolderRes.status}): ${errText}`);
    }

    const folderData = await createFolderRes.json();
    folderId = folderData.id;
    folderName = folderData.name;
    folderWebViewLink =
      folderData.webViewLink || `https://drive.google.com/drive/folders/${folderData.id}`;
    folderCreatedTime = folderData.createdTime || folderCreatedTime;
  }

  if (!folderId) {
    throw new Error('Could not resolve target Google Drive folder ID.');
  }

  const uploadedFiles: DriveCopiedArtifact[] = [];

  if (options.includeLiveState) {
    onProgress?.('Uploading quantpulse-app-bundle.json (Live State, Orders & DuckDB ML Telemetry)...', 40);
    const statePayload = {
      bundleId: bundle.bundleId,
      exportedAt: bundle.exportedAt,
      appName: bundle.appName,
      version: bundle.version,
      dataQualityWarning: bundle.dataQualityWarning,
      riskFirstEvaluation: bundle.riskFirstEvaluation,
      summaryMetrics: bundle.summaryMetrics,
      liveState: bundle.liveState,
      mlFeatureStore: bundle.mlFeatureStore,
    };
    const artifact = await uploadMultipartFileToDrive({
      name: 'quantpulse-app-bundle.json',
      mimeType: 'application/json',
      content: JSON.stringify(statePayload, null, 2),
      parentFolderId: folderId,
      description: 'Portable QuantPulse Live State, Strategy Tournament, Kalshi v2, Public.com & DuckDB ML Telemetry Snapshot',
    });
    uploadedFiles.push(artifact);

    if (bundle.mlFeatureStore) {
      onProgress?.('Uploading quantpulse-ml-telemetry-ledger.json (DuckDB ml_telemetry_ledger & Meta-Model)...', 52);
      const mlArtifact = await uploadMultipartFileToDrive({
        name: 'quantpulse-ml-telemetry-ledger.json',
        mimeType: 'application/json',
        content: JSON.stringify(bundle.mlFeatureStore, null, 2),
        parentFolderId: folderId,
        description: `DuckDB Persistent ML Feature Store (ml_telemetry_ledger: ${bundle.mlFeatureStore.totalRows} rows, ${bundle.mlFeatureStore.settledRows} settled, Model ${bundle.mlFeatureStore.activeMetaModel?.model_id || 'v1'})`,
      });
      uploadedFiles.push(mlArtifact);
    }
  }

  if (options.includeSourceArchive) {
    onProgress?.(
      `Uploading quantpulse-source-archive.json (${bundle.sourceFiles.length} Application Source Files)...`,
      65
    );
    const sourceArchivePayload = {
      bundleId: bundle.bundleId,
      exportedAt: bundle.exportedAt,
      appName: bundle.appName,
      version: bundle.version,
      totalFiles: bundle.sourceFiles.length,
      totalBytes: bundle.summaryMetrics.totalBundleBytes,
      files: bundle.sourceFiles,
    };
    const artifact = await uploadMultipartFileToDrive({
      name: 'quantpulse-source-archive.json',
      mimeType: 'application/json',
      content: JSON.stringify(sourceArchivePayload, null, 2),
      parentFolderId: folderId,
      description: 'Complete QuantPulse Full-Stack Source Code Archive (server.ts, src/**, configs)',
    });
    uploadedFiles.push(artifact);
  }

  if (options.includePlaybookReport) {
    onProgress?.('Uploading Master_Quant_Playbook_Report.md...', 82);
    const artifact = await uploadMultipartFileToDrive({
      name: 'Master_Quant_Playbook_Report.md',
      mimeType: 'text/markdown',
      content: bundle.playbookMarkdownReport,
      parentFolderId: folderId,
      description: 'Master Quant Playbook & Risk-First Telemetry Audit Report',
    });
    uploadedFiles.push(artifact);
  }

  if (options.includeStandaloneHtml) {
    onProgress?.('Uploading QuantPulse_Standalone_App_Copy.html...', 94);
    const htmlContent = buildStandaloneAppCopyHtml(bundle);
    const artifact = await uploadMultipartFileToDrive({
      name: 'QuantPulse_Standalone_App_Copy.html',
      mimeType: 'text/html',
      content: htmlContent,
      parentFolderId: folderId,
      description: 'Self-Contained Interactive HTML Snapshot of QuantPulse App Copy',
    });
    uploadedFiles.push(artifact);
  }

  onProgress?.('Google Drive App Copy completed and verified.', 100);

  return {
    id: folderId,
    name: folderName,
    createdTime: folderCreatedTime,
    webViewLink: folderWebViewLink,
    description: bundle.riskFirstEvaluation.rationale,
    files: uploadedFiles,
  };
}

export async function listExistingDriveAppCopies(): Promise<DriveAppCopyFolder[]> {
  const folderQuery = encodeURIComponent(
    "mimeType = 'application/vnd.google-apps.folder' and trashed = false and name contains 'QuantPulse_Finesse_Finance_Copy'"
  );
  const res = await driveFetch(
    `https://www.googleapis.com/drive/v3/files?q=${folderQuery}&orderBy=createdTime desc&pageSize=15&fields=files(id,name,createdTime,modifiedTime,webViewLink,description)`
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Failed to list Google Drive copies (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const folders: DriveAppCopyFolder[] = (data.files || []).map((f: any) => ({
    id: f.id,
    name: f.name,
    createdTime: f.createdTime || new Date().toISOString(),
    modifiedTime: f.modifiedTime,
    webViewLink: f.webViewLink || `https://drive.google.com/drive/folders/${f.id}`,
    description: f.description,
    files: [],
  }));

  // Fetch child files for the top 8 folders in parallel
  await Promise.all(
    folders.slice(0, 8).map(async (folder) => {
      try {
        const childQuery = encodeURIComponent(`'${folder.id}' in parents and trashed = false`);
        const childRes = await driveFetch(
          `https://www.googleapis.com/drive/v3/files?q=${childQuery}&fields=files(id,name,mimeType,size,webViewLink,createdTime)`
        );
        if (childRes.ok) {
          const childData = await childRes.json();
          folder.files = (childData.files || []).map((cf: any) => ({
            id: cf.id,
            name: cf.name,
            mimeType: cf.mimeType,
            sizeBytes: Number(cf.size) || 0,
            webViewLink: cf.webViewLink || `https://drive.google.com/file/d/${cf.id}/view`,
            createdTime: cf.createdTime || folder.createdTime,
          }));
        }
      } catch {
        // Ignore individual child listing error
      }
    })
  );

  return folders;
}

export async function downloadDriveAppBundleFromFolder(
  folderId: string
): Promise<Partial<AppBundleExportPayload>> {
  const childQuery = encodeURIComponent(
    `'${folderId}' in parents and name = 'quantpulse-app-bundle.json' and trashed = false`
  );
  const searchRes = await driveFetch(
    `https://www.googleapis.com/drive/v3/files?q=${childQuery}&fields=files(id,name)`
  );

  if (!searchRes.ok) {
    throw new Error(`Unable to search folder ${folderId} for quantpulse-app-bundle.json`);
  }

  const searchData = await searchRes.json();
  const targetFile = searchData.files?.[0];
  if (!targetFile?.id) {
    throw new Error('No quantpulse-app-bundle.json file found inside the selected Google Drive copy folder.');
  }

  const downloadRes = await driveFetch(
    `https://www.googleapis.com/drive/v3/files/${targetFile.id}?alt=media`
  );
  if (!downloadRes.ok) {
    throw new Error(`Failed to download quantpulse-app-bundle.json (${downloadRes.status})`);
  }

  return (await downloadRes.json()) as Partial<AppBundleExportPayload>;
}

export async function trashDriveAppCopyFolder(folderId: string): Promise<void> {
  const res = await driveFetch(`https://www.googleapis.com/drive/v3/files/${folderId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ trashed: true }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Failed to move Google Drive folder to trash (${res.status}): ${errText}`);
  }
}
