import React, { useEffect, useState, useCallback } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  CloudUpload,
  Download,
  ExternalLink,
  FileCode2,
  FolderCheck,
  HardDrive,
  LogOut,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import type { User } from 'firebase/auth';
import type {
  AppBundleExportPayload,
  AutonomousAgent,
  DataFeedSpec,
  DriveAppCopyFolder,
  ExecutedOrder,
  MarketFeatureVector,
  PlaybookCleanupAuditRow,
  PortfolioSummary,
  RiskEventNotification,
  StrategyTournamentEntry,
} from '../types/quant.ts';
import {
  copyAppBundleToGoogleDrive,
  disconnectGoogleDrive,
  downloadDriveAppBundleFromFolder,
  DriveAuthExpiredError,
  getInMemoryDriveToken,
  listExistingDriveAppCopies,
  signInWithGoogleDrive,
  subscribeToGoogleAuth,
  trashDriveAppCopyFolder,
} from '../services/googleDriveService.ts';

interface GoogleDriveCopyPanelProps {
  onStateRestored: (restored: {
    portfolio?: PortfolioSummary;
    feeds?: DataFeedSpec[];
    features?: MarketFeatureVector[];
    agents?: AutonomousAgent[];
    orders?: ExecutedOrder[];
    riskEvents?: RiskEventNotification[];
    strategyTournament?: StrategyTournamentEntry[];
    playbookCleanupAudit?: PlaybookCleanupAuditRow[];
    bannerMessage?: string;
  }) => void;
}

type PendingConfirmation =
  | {
      type: 'OVERWRITE_DRIVE_COPY';
      folder: DriveAppCopyFolder;
    }
  | {
      type: 'RESTORE_FROM_DRIVE';
      folder: DriveAppCopyFolder;
    }
  | {
      type: 'DELETE_DRIVE_COPY';
      folder: DriveAppCopyFolder;
    };

export const GoogleDriveCopyPanel: React.FC<GoogleDriveCopyPanelProps> = ({
  onStateRestored,
}) => {
  const [googleUser, setGoogleUser] = useState<User | null>(null);
  const [hasDriveToken, setHasDriveToken] = useState<boolean>(Boolean(getInMemoryDriveToken()));
  const [bundlePreview, setBundlePreview] = useState<AppBundleExportPayload | null>(null);
  const [isLoadingBundle, setIsLoadingBundle] = useState<boolean>(true);
  const [driveCopies, setDriveCopies] = useState<DriveAppCopyFolder[]>([]);
  const [isLoadingCopies, setIsLoadingCopies] = useState<boolean>(false);

  // Copy options
  const [includeLiveState, setIncludeLiveState] = useState<boolean>(true);
  const [includeSourceArchive, setIncludeSourceArchive] = useState<boolean>(true);
  const [includePlaybookReport, setIncludePlaybookReport] = useState<boolean>(true);
  const [includeStandaloneHtml, setIncludeStandaloneHtml] = useState<boolean>(true);
  const [customFolderLabel, setCustomFolderLabel] = useState<string>('');
  const [selectedSourceFilter, setSelectedSourceFilter] = useState<
    'ALL' | 'BACKEND' | 'FRONTEND' | 'CONFIG' | 'PLAYBOOK_VAULT'
  >('ALL');
  const [selectedFileForInspect, setSelectedFileForInspect] = useState<string | null>(null);

  // Execution & Progress states
  const [isCopyingToDrive, setIsCopyingToDrive] = useState<boolean>(false);
  const [copyStageLabel, setCopyStageLabel] = useState<string>('');
  const [copyProgressPct, setCopyProgressPct] = useState<number>(0);
  const [lastCreatedFolder, setLastCreatedFolder] = useState<DriveAppCopyFolder | null>(null);
  const [feedbackBanner, setFeedbackBanner] = useState<{
    type: 'success' | 'warn' | 'error';
    message: string;
  } | null>(null);

  // Confirmation modal state for mutating/destructive operations
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation | null>(null);
  const [isExecutingConfirmedAction, setIsExecutingConfirmedAction] = useState<boolean>(false);

  const fetchAppBundlePreview = useCallback(async () => {
    setIsLoadingBundle(true);
    try {
      const res = await fetch('/api/app-bundle/export');
      if (!res.ok) {
        throw new Error(`Export endpoint returned HTTP ${res.status}`);
      }
      const data = (await res.json()) as AppBundleExportPayload;
      setBundlePreview(data);
    } catch (err) {
      setFeedbackBanner({
        type: 'error',
        message:
          err instanceof Error
            ? `Failed to build application bundle preview: ${err.message}`
            : 'Failed to build application bundle preview.',
      });
    } finally {
      setIsLoadingBundle(false);
    }
  }, []);

  const refreshDriveCopiesList = useCallback(async () => {
    if (!getInMemoryDriveToken()) return;
    setIsLoadingCopies(true);
    try {
      const folders = await listExistingDriveAppCopies();
      setDriveCopies(folders);
    } catch (err) {
      if (err instanceof DriveAuthExpiredError) {
        setHasDriveToken(false);
        setFeedbackBanner({
          type: 'warn',
          message: err.message,
        });
      } else {
        setFeedbackBanner({
          type: 'error',
          message:
            err instanceof Error
              ? `Could not list existing Google Drive copies: ${err.message}`
              : 'Could not list existing Google Drive copies.',
        });
      }
    } finally {
      setIsLoadingCopies(false);
    }
  }, []);

  useEffect(() => {
    fetchAppBundlePreview();
    const unsub = subscribeToGoogleAuth((user, tokenReady) => {
      setGoogleUser(user);
      setHasDriveToken(tokenReady);
    });
    return () => unsub();
  }, [fetchAppBundlePreview]);

  useEffect(() => {
    if (hasDriveToken) {
      refreshDriveCopiesList();
    }
  }, [hasDriveToken, refreshDriveCopiesList]);

  const handleGoogleSignIn = async () => {
    setFeedbackBanner(null);
    try {
      const { user } = await signInWithGoogleDrive();
      setGoogleUser(user);
      setHasDriveToken(true);
      setFeedbackBanner({
        type: 'success',
        message: `Connected Google Drive (${user.email || user.displayName || 'Authenticated'}) with active in-memory OAuth token.`,
      });
    } catch (err) {
      setFeedbackBanner({
        type: 'error',
        message:
          err instanceof Error
            ? `Google Drive Sign-In failed: ${err.message}`
            : 'Google Drive Sign-In was cancelled or failed.',
      });
    }
  };

  const handleGoogleSignOut = async () => {
    await disconnectGoogleDrive();
    setGoogleUser(null);
    setHasDriveToken(false);
    setDriveCopies([]);
    setLastCreatedFolder(null);
    setFeedbackBanner({
      type: 'warn',
      message: 'Cleared in-memory Google Drive OAuth token and disconnected account.',
    });
  };

  const executeCopyToGoogleDrive = async (existingFolderIdToOverwrite?: string) => {
    if (!hasDriveToken) {
      setFeedbackBanner({
        type: 'warn',
        message: 'Please sign in with Google first to authorize Google Drive access.',
      });
      return;
    }

    setIsCopyingToDrive(true);
    setCopyProgressPct(5);
    setCopyStageLabel('Fetching fresh live application bundle & source files...');
    setFeedbackBanner(null);

    try {
      const freshRes = await fetch('/api/app-bundle/export');
      if (!freshRes.ok) {
        throw new Error('Unable to snapshot live app bundle from server.');
      }
      const freshBundle = (await freshRes.json()) as AppBundleExportPayload;
      setBundlePreview(freshBundle);

      const createdFolder = await copyAppBundleToGoogleDrive(
        freshBundle,
        {
          includeLiveState,
          includeSourceArchive,
          includePlaybookReport,
          includeStandaloneHtml,
          customFolderLabel,
          existingFolderIdToOverwrite,
        },
        (stage, pct) => {
          setCopyStageLabel(stage);
          setCopyProgressPct(pct);
        }
      );

      setLastCreatedFolder(createdFolder);
      setFeedbackBanner({
        type: 'success',
        message: `Copied QuantPulse app bundle (${createdFolder.files?.length || 0} artifacts · ${(
          freshBundle.summaryMetrics.totalBundleBytes / 1024
        ).toFixed(1)} KB source) to Google Drive folder "${createdFolder.name}".`,
      });
      await refreshDriveCopiesList();
    } catch (err) {
      if (err instanceof DriveAuthExpiredError) {
        setHasDriveToken(false);
        setFeedbackBanner({
          type: 'warn',
          message: err.message,
        });
      } else {
        setFeedbackBanner({
          type: 'error',
          message:
            err instanceof Error
              ? `Google Drive copy failed: ${err.message}`
              : 'Google Drive copy failed.',
        });
      }
    } finally {
      setIsCopyingToDrive(false);
    }
  };

  const handleConfirmPendingAction = async () => {
    if (!pendingConfirmation) return;
    setIsExecutingConfirmedAction(true);

    try {
      if (pendingConfirmation.type === 'OVERWRITE_DRIVE_COPY') {
        const folderId = pendingConfirmation.folder.id;
        setPendingConfirmation(null);
        await executeCopyToGoogleDrive(folderId);
      } else if (pendingConfirmation.type === 'RESTORE_FROM_DRIVE') {
        const downloadedBundle = await downloadDriveAppBundleFromFolder(
          pendingConfirmation.folder.id
        );
        const restoreRes = await fetch('/api/app-bundle/restore', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bundle: downloadedBundle }),
        });
        if (!restoreRes.ok) {
          const errJson = await restoreRes.json();
          throw new Error(errJson.error || 'Failed to restore state from Drive copy.');
        }
        const restoredData = await restoreRes.json();
        onStateRestored({
          portfolio: restoredData.portfolio,
          feeds: restoredData.feeds,
          features: restoredData.features,
          agents: restoredData.agents,
          orders: restoredData.orders,
          riskEvents: restoredData.riskEvents,
          strategyTournament: restoredData.strategyTournament,
          playbookCleanupAudit: restoredData.playbookCleanupAudit,
          bannerMessage: restoredData.rationale,
        });
        setFeedbackBanner({
          type: 'success',
          message: `Restored live state from Google Drive folder "${pendingConfirmation.folder.name}" (${restoredData.rationale}).`,
        });
        setPendingConfirmation(null);
        await fetchAppBundlePreview();
      } else if (pendingConfirmation.type === 'DELETE_DRIVE_COPY') {
        await trashDriveAppCopyFolder(pendingConfirmation.folder.id);
        setFeedbackBanner({
          type: 'warn',
          message: `Moved Google Drive copy folder "${pendingConfirmation.folder.name}" to Drive Trash.`,
        });
        setPendingConfirmation(null);
        await refreshDriveCopiesList();
      }
    } catch (err) {
      if (err instanceof DriveAuthExpiredError) {
        setHasDriveToken(false);
      }
      setFeedbackBanner({
        type: 'error',
        message:
          err instanceof Error ? err.message : 'Action failed while communicating with Google Drive.',
      });
      setPendingConfirmation(null);
    } finally {
      setIsExecutingConfirmedAction(false);
    }
  };

  const handleDownloadLocalJsonCopy = () => {
    if (!bundlePreview) return;
    const blob = new Blob([JSON.stringify(bundlePreview, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `QuantPulse_Finesse_Finance_${bundlePreview.bundleId}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const filteredSourceFiles = (bundlePreview?.sourceFiles || []).filter((f) => {
    if (selectedSourceFilter === 'ALL') return true;
    return f.category === selectedSourceFilter;
  });

  const inspectedFileObj =
    bundlePreview?.sourceFiles.find((f) => f.path === selectedFileForInspect) ||
    filteredSourceFiles[0] ||
    null;

  return (
    <div className="space-y-6">
      {/* Top Status / Error Notification */}
      {feedbackBanner && (
        <div
          className={`flex items-center justify-between px-4 py-3 border text-xs ${
            feedbackBanner.type === 'error'
              ? 'border-rose-500/50 bg-rose-950/30 text-rose-200'
              : feedbackBanner.type === 'warn'
              ? 'border-amber-500/50 bg-amber-950/30 text-amber-200'
              : 'border-emerald-500/50 bg-emerald-950/30 text-emerald-200'
          }`}
        >
          <div className="flex items-center gap-2">
            {feedbackBanner.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            ) : (
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
            )}
            <span>{feedbackBanner.message}</span>
          </div>
          <button
            type="button"
            onClick={() => setFeedbackBanner(null)}
            className="text-slate-400 hover:text-slate-200 ml-4 whitespace-nowrap shrink-0"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Section 1: Google Drive OAuth Connection Header & Risk-First Pre-Copy Audit */}
      <div className="p-5 border border-slate-800 bg-[#111827] space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
          <div>
            <h2 className="text-base font-semibold text-slate-100">
              Google Drive App Copy &amp; Quantitative Vault Sync
            </h2>
            <p className="text-xs text-slate-400 mt-1">
              Copy the complete QuantPulse application source codebase, live multi-venue portfolio state, strategy tournament rankings, and Master Quant Playbook directly into your Google Drive.
            </p>
          </div>

          {/* Official Google Sign-In Button or Connected Account Controls */}
          <div className="flex items-center gap-3 shrink-0">
            {!hasDriveToken ? (
              <button
                type="button"
                onClick={handleGoogleSignIn}
                className="inline-flex items-center gap-2.5 px-4 py-2 bg-white hover:bg-slate-100 text-slate-900 font-medium text-xs rounded border border-slate-300 transition-colors whitespace-nowrap shrink-0"
              >
                {/* Official 4-color Google 'G' SVG mark */}
                <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    fill="#4285F4"
                    d="M23.49 12.275c0-.85-.075-1.665-.215-2.45H12v4.635h6.445c-.28 1.495-1.12 2.76-2.385 3.61v3.005h3.86c2.26-2.08 3.57-5.145 3.57-8.8z"
                  />
                  <path
                    fill="#34A853"
                    d="M12 24c3.24 0 5.955-1.075 7.94-2.91l-3.86-3.005c-1.075.72-2.45 1.15-4.08 1.15-3.135 0-5.79-2.115-6.74-4.96H1.27v3.1C3.245 21.3 7.31 24 12 24z"
                  />
                  <path
                    fill="#FBBC05"
                    d="M5.26 14.275c-.24-.72-.38-1.49-.38-2.275s.14-1.555.38-2.275v-3.1H1.27C.46 8.235 0 10.065 0 12s.46 3.765 1.27 5.375l3.99-3.1z"
                  />
                  <path
                    fill="#EA4335"
                    d="M12 4.765c1.76 0 3.34.605 4.585 1.795l3.435-3.435C17.95 1.19 15.235 0 12 0 7.31 0 3.245 2.7 1.27 6.625l3.99 3.1c.95-2.845 3.605-4.96 6.74-4.96z"
                  />
                </svg>
                <span>Sign in with Google</span>
              </button>
            ) : (
              <div className="flex items-center gap-3">
                <div className="text-right text-xs">
                  <div className="text-slate-100 font-medium">
                    {googleUser?.displayName || googleUser?.email || 'Google Drive Connected'}
                  </div>
                  <div className="text-[11px] text-emerald-400 font-mono">
                    {googleUser?.email} · Drive v3 OAuth Active (In-Memory Token)
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleGoogleSignIn}
                  className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs rounded transition-colors whitespace-nowrap shrink-0"
                >
                  Refresh Token
                </button>
                <button
                  type="button"
                  onClick={handleGoogleSignOut}
                  className="px-3 py-1.5 border border-slate-700 hover:bg-slate-800 text-slate-300 text-xs rounded transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  <span>Disconnect</span>
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Risk-First Pre-Copy Audit & Bundle Metrics */}
        {bundlePreview && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-xs">
              <div className="p-3.5 border border-slate-800 bg-[#0B0F17]">
                <div className="text-slate-400">Packaged Application Source</div>
                <div className="mt-1 text-xl font-bold font-mono tabular-nums text-emerald-400">
                  {bundlePreview.summaryMetrics.totalSourceFiles} Files ·{' '}
                  {(bundlePreview.summaryMetrics.totalBundleBytes / 1024).toFixed(1)} KB
                </div>
                <div className="mt-1 text-[11px] text-slate-400 font-mono">
                  server.ts · src/** · Playbook Vault
                </div>
              </div>

              <div className="p-3.5 border border-slate-800 bg-[#0B0F17]">
                <div className="text-slate-400">Multi-Venue State Snapshot</div>
                <div className="mt-1 text-xl font-bold font-mono tabular-nums text-cyan-400">
                  ${bundlePreview.summaryMetrics.combinedMultiVenueEquityUsd.toFixed(2)}
                </div>
                <div className="mt-1 text-[11px] text-slate-400 font-mono">
                  {bundlePreview.summaryMetrics.activeAgentsCount} Active Agents ·{' '}
                  {bundlePreview.summaryMetrics.workingOrdersCount} OCO Orders
                </div>
              </div>

              <div className="p-3.5 border border-slate-800 bg-[#0B0F17]">
                <div className="text-slate-400">Downside &amp; Drawdown Exposure</div>
                <div className="mt-1 text-xl font-bold font-mono tabular-nums text-slate-100">
                  {bundlePreview.riskFirstEvaluation.portfolioDrawdownPct.toFixed(2)}% /{' '}
                  {bundlePreview.riskFirstEvaluation.maxAllowedDrawdownPct.toFixed(1)}%
                </div>
                <div className="mt-1 text-[11px] text-slate-400 font-mono">
                  Invalidation Gate: {bundlePreview.riskFirstEvaluation.invalidationThresholdAtr}x ATR
                </div>
              </div>

              <div className="p-3.5 border border-slate-800 bg-[#0B0F17]">
                <div className="text-slate-400">Data Integrity Posture</div>
                <div
                  className={`mt-1 text-xl font-bold font-mono tabular-nums ${
                    bundlePreview.dataQualityWarning ? 'text-amber-400' : 'text-emerald-400'
                  }`}
                >
                  {bundlePreview.dataQualityWarning ? 'WARN_HOLD' : 'VERIFIED_OK'}
                </div>
                <div className="mt-1 text-[11px] text-slate-400 font-mono">
                  dataQualityWarning: {String(bundlePreview.dataQualityWarning)}
                </div>
              </div>
            </div>

            <div className="p-3.5 border border-slate-800 bg-[#0B0F17] flex flex-wrap items-center justify-between gap-4 text-xs">
              <div className="flex items-center gap-2.5">
                <ShieldCheck className="w-4 h-4 text-cyan-400 shrink-0" />
                <div>
                  <span className="font-semibold text-slate-200">
                    Risk-First Evaluation Rationale:{' '}
                  </span>
                  <span className="text-slate-300 font-mono">
                    {bundlePreview.riskFirstEvaluation.rationale}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={fetchAppBundlePreview}
                  disabled={isLoadingBundle}
                  className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isLoadingBundle ? 'animate-spin' : ''}`} />
                  <span>Refresh Snapshot</span>
                </button>
                <button
                  type="button"
                  onClick={handleDownloadLocalJsonCopy}
                  className="px-3 py-1.5 border border-slate-700 hover:bg-slate-800 text-slate-200 rounded transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Download Local JSON</span>
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Section 2: Copy Configuration & One-Click Copy to Google Drive */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left 5 Cols: Copy Manifest Builder & Trigger */}
        <div className="lg:col-span-5 p-5 border border-slate-800 bg-[#111827] space-y-4">
          <div className="border-b border-slate-800 pb-3">
            <h3 className="text-sm font-semibold text-slate-100">
              1. Configure Google Drive App Copy Package
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Select the artifacts to generate inside your dedicated Google Drive copy folder.
            </p>
          </div>

          <div className="space-y-3 text-xs">
            <div>
              <label className="block text-slate-300 font-medium mb-1">
                Optional Drive Folder Suffix Label
              </label>
              <input
                type="text"
                value={customFolderLabel}
                onChange={(e) => setCustomFolderLabel(e.target.value)}
                placeholder="e.g., Production_v2_Backup (defaults to UTC timestamp)"
                className="w-full px-3 py-2 bg-[#0B0F17] border border-slate-800 text-slate-100 font-mono rounded focus:outline-none focus:border-cyan-400"
              />
            </div>

            <div className="space-y-2 pt-1">
              <label className="flex items-start gap-2.5 p-2.5 border border-slate-800 bg-[#0B0F17] cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeSourceArchive}
                  onChange={(e) => setIncludeSourceArchive(e.target.checked)}
                  className="mt-0.5 accent-cyan-400"
                />
                <div>
                  <div className="font-semibold text-slate-100">
                    Full Application Source Code Archive (<code className="text-cyan-400">quantpulse-source-archive.json</code>)
                  </div>
                  <div className="text-[11px] text-slate-400 mt-0.5">
                    Includes all {bundlePreview?.summaryMetrics.totalSourceFiles ?? 21} project files (<code className="font-mono">server.ts</code>, <code className="font-mono">src/**</code>, <code className="font-mono">package.json</code>, Playbook Vault) with SHA-256 integrity hashes.
                  </div>
                </div>
              </label>

              <label className="flex items-start gap-2.5 p-2.5 border border-slate-800 bg-[#0B0F17] cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeLiveState}
                  onChange={(e) => setIncludeLiveState(e.target.checked)}
                  className="mt-0.5 accent-cyan-400"
                />
                <div>
                  <div className="font-semibold text-slate-100">
                    Live Quantitative State &amp; Portfolio Ledger (<code className="text-cyan-400">quantpulse-app-bundle.json</code>)
                  </div>
                  <div className="text-[11px] text-slate-400 mt-0.5">
                    Restorable snapshot of Public.com &amp; Kalshi v2 positions, active agents, OCO orders, and strategy tournament leaderboard.
                  </div>
                </div>
              </label>

              <label className="flex items-start gap-2.5 p-2.5 border border-slate-800 bg-[#0B0F17] cursor-pointer">
                <input
                  type="checkbox"
                  checked={includePlaybookReport}
                  onChange={(e) => setIncludePlaybookReport(e.target.checked)}
                  className="mt-0.5 accent-cyan-400"
                />
                <div>
                  <div className="font-semibold text-slate-100">
                    Master Quant Playbook &amp; Risk Telemetry Report (<code className="text-cyan-400">Master_Quant_Playbook_Report.md</code>)
                  </div>
                  <div className="text-[11px] text-slate-400 mt-0.5">
                    Formatted Markdown documentation of strategy tournament scores, fee gates, and source manifest.
                  </div>
                </div>
              </label>

              <label className="flex items-start gap-2.5 p-2.5 border border-slate-800 bg-[#0B0F17] cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeStandaloneHtml}
                  onChange={(e) => setIncludeStandaloneHtml(e.target.checked)}
                  className="mt-0.5 accent-cyan-400"
                />
                <div>
                  <div className="font-semibold text-slate-100">
                    Standalone Portable HTML Dashboard (<code className="text-cyan-400">QuantPulse_Standalone_App_Copy.html</code>)
                  </div>
                  <div className="text-[11px] text-slate-400 mt-0.5">
                    Self-contained HTML copy viewable directly from Google Drive without a local server.
                  </div>
                </div>
              </label>
            </div>

            {isCopyingToDrive && (
              <div className="p-3 border border-cyan-500/40 bg-[#0B0F17] space-y-2">
                <div className="flex items-center justify-between text-[11px] font-mono">
                  <span className="text-cyan-300">{copyStageLabel}</span>
                  <span className="tabular-nums text-slate-200">{copyProgressPct}%</span>
                </div>
                <div className="w-full h-1.5 bg-slate-800 overflow-hidden">
                  <div
                    className="h-full bg-cyan-400 transition-transform duration-150 origin-left"
                    style={{ transform: `scaleX(${copyProgressPct / 100})` }}
                  />
                </div>
              </div>
            )}

            <button
              type="button"
              disabled={
                isCopyingToDrive ||
                (!includeLiveState &&
                  !includeSourceArchive &&
                  !includePlaybookReport &&
                  !includeStandaloneHtml)
              }
              onClick={() => {
                if (!hasDriveToken) {
                  handleGoogleSignIn();
                } else {
                  executeCopyToGoogleDrive();
                }
              }}
              className="w-full py-2.5 px-4 bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 text-slate-950 font-semibold text-xs rounded transition-colors flex items-center justify-center gap-2 whitespace-nowrap"
            >
              <CloudUpload className="w-4 h-4" />
              <span>
                {!hasDriveToken
                  ? 'Sign in with Google to Copy App to Drive'
                  : isCopyingToDrive
                  ? 'Copying App Bundle to Google Drive...'
                  : 'Copy App to Google Drive Now'}
              </span>
            </button>

            {lastCreatedFolder && (
              <div className="p-3.5 border border-emerald-500/40 bg-emerald-950/20 space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-emerald-300 flex items-center gap-1.5">
                    <FolderCheck className="w-4 h-4" />
                    <span>Latest Drive Copy Ready</span>
                  </span>
                  <a
                    href={lastCreatedFolder.webViewLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-cyan-300 hover:underline inline-flex items-center gap-1 font-mono text-[11px] whitespace-nowrap"
                  >
                    <span>Open Folder in Drive</span>
                    <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
                <div className="font-mono text-[11px] text-slate-200 truncate">
                  {lastCreatedFolder.name}
                </div>
                {lastCreatedFolder.files && lastCreatedFolder.files.length > 0 && (
                  <div className="pt-1.5 border-t border-emerald-500/20 space-y-1">
                    {lastCreatedFolder.files.map((file) => (
                      <div
                        key={file.id}
                        className="flex items-center justify-between text-[11px] font-mono text-slate-300"
                      >
                        <span className="truncate max-w-[210px]">{file.name}</span>
                        <a
                          href={file.webViewLink}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-emerald-400 hover:underline inline-flex items-center gap-1"
                        >
                          <span>{(file.sizeBytes / 1024).toFixed(1)} KB</span>
                          <ExternalLink className="w-2.5 h-2.5" />
                        </a>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Right 7 Cols: Existing Google Drive App Copies Manager & Restore */}
        <div className="lg:col-span-7 p-5 border border-slate-800 bg-[#111827] space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-100">
                2. Existing Google Drive App Copies &amp; State Restoration
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Inspect versioned app copies stored in your Google Drive, open files directly in Drive, or restore a saved state snapshot.
              </p>
            </div>
            {hasDriveToken && (
              <button
                type="button"
                onClick={refreshDriveCopiesList}
                disabled={isLoadingCopies}
                className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs rounded transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isLoadingCopies ? 'animate-spin' : ''}`} />
                <span>Sync Drive Folder List</span>
              </button>
            )}
          </div>

          {!hasDriveToken ? (
            <div className="p-8 border border-slate-800 bg-[#0B0F17] text-center space-y-3">
              <HardDrive className="w-8 h-8 text-slate-500 mx-auto" />
              <div className="text-sm font-medium text-slate-200">
                Authenticate with Google Drive to View &amp; Manage Your App Copies
              </div>
              <p className="text-xs text-slate-400 max-w-md mx-auto">
                Sign in with your Google account above to create a dedicated <code className="font-mono text-cyan-400">QuantPulse_Finesse_Finance_Copy</code> folder in your Google Drive or restore a previous snapshot.
              </p>
              <div>
                <button
                  type="button"
                  onClick={handleGoogleSignIn}
                  className="inline-flex items-center gap-2.5 px-4 py-2 bg-white hover:bg-slate-100 text-slate-900 font-medium text-xs rounded border border-slate-300 transition-colors whitespace-nowrap"
                >
                  <span>Sign in with Google</span>
                </button>
              </div>
            </div>
          ) : isLoadingCopies ? (
            <div className="space-y-2">
              {[1, 2, 3].map((idx) => (
                <div
                  key={idx}
                  className="h-16 border border-slate-800 bg-[#0B0F17] animate-pulse px-4 py-3"
                />
              ))}
            </div>
          ) : driveCopies.length === 0 ? (
            <div className="p-8 border border-slate-800 bg-[#0B0F17] text-center space-y-3">
              <div className="text-sm font-medium text-slate-200">
                No QuantPulse App Copies Found in Your Google Drive Yet
              </div>
              <p className="text-xs text-slate-400 max-w-md mx-auto">
                Click <strong>Copy App to Google Drive Now</strong> on the left panel to create your first complete application and state copy in Google Drive.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-800 text-slate-400 bg-[#0D131F]">
                    <th className="py-2.5 px-3 font-medium">Google Drive Folder &amp; Created Time</th>
                    <th className="py-2.5 px-3 font-medium">Included Artifacts</th>
                    <th className="py-2.5 px-3 font-medium text-right">Drive Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/80">
                  {driveCopies.map((folder) => (
                    <tr key={folder.id} className="hover:bg-slate-800/30 align-top">
                      <td className="py-3 px-3">
                        <div className="font-mono font-semibold text-slate-100 break-all">
                          {folder.name}
                        </div>
                        <div className="text-[11px] text-slate-400 font-mono tabular-nums mt-0.5">
                          Created: {new Date(folder.createdTime).toLocaleString()} · ID: {folder.id.slice(0, 10)}
                        </div>
                      </td>
                      <td className="py-3 px-3">
                        {folder.files && folder.files.length > 0 ? (
                          <div className="space-y-1">
                            {folder.files.map((f) => (
                              <div
                                key={f.id}
                                className="flex items-center justify-between gap-2 text-[11px] font-mono"
                              >
                                <a
                                  href={f.webViewLink}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-cyan-400 hover:underline truncate max-w-[190px]"
                                >
                                  {f.name}
                                </a>
                                <span className="text-slate-400 tabular-nums shrink-0">
                                  {(f.sizeBytes / 1024).toFixed(1)} KB
                                </span>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <span className="text-[11px] text-slate-400 font-mono">
                            Drive Copy Folder
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-3 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1.5">
                          <a
                            href={folder.webViewLink}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-cyan-300 rounded text-[11px] font-medium inline-flex items-center gap-1"
                          >
                            <span>Open</span>
                            <ExternalLink className="w-3 h-3" />
                          </a>
                          <button
                            type="button"
                            onClick={() =>
                              setPendingConfirmation({
                                type: 'RESTORE_FROM_DRIVE',
                                folder,
                              })
                            }
                            className="px-2.5 py-1 bg-emerald-950/70 hover:bg-emerald-900/70 border border-emerald-500/40 text-emerald-300 rounded text-[11px] font-medium inline-flex items-center gap-1"
                          >
                            <RotateCcw className="w-3 h-3" />
                            <span>Restore</span>
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              setPendingConfirmation({
                                type: 'OVERWRITE_DRIVE_COPY',
                                folder,
                              })
                            }
                            className="px-2.5 py-1 border border-slate-700 hover:bg-slate-800 text-slate-200 rounded text-[11px]"
                          >
                            Overwrite
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              setPendingConfirmation({
                                type: 'DELETE_DRIVE_COPY',
                                folder,
                              })
                            }
                            className="px-2 py-1 border border-rose-500/40 hover:bg-rose-950/50 text-rose-300 rounded text-[11px]"
                            title="Move copy folder to Google Drive Trash"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Section 3: Application Source Code & Checksum Inspector */}
      {bundlePreview && (
        <div className="p-5 border border-slate-800 bg-[#111827] space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
                <FileCode2 className="w-4 h-4 text-cyan-400" />
                <span>3. Packaged Application Source Code &amp; SHA-256 Integrity Manifest</span>
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Every source file below is packaged into <code className="font-mono text-cyan-400">quantpulse-source-archive.json</code> when copying your app to Google Drive.
              </p>
            </div>

            <div className="flex items-center gap-1 p-1 bg-[#0B0F17] border border-slate-800 rounded">
              {(['ALL', 'BACKEND', 'FRONTEND', 'CONFIG', 'PLAYBOOK_VAULT'] as const).map((cat) => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setSelectedSourceFilter(cat)}
                  className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap ${
                    selectedSourceFilter === cat
                      ? 'bg-slate-800 text-cyan-400'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {cat}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
            <div className="lg:col-span-5 overflow-x-auto border border-slate-800 bg-[#0B0F17] max-h-[360px] overflow-y-auto">
              <table className="w-full text-left border-collapse text-xs font-mono tabular-nums">
                <thead>
                  <tr className="border-b border-slate-800 text-slate-400 bg-[#0D131F]">
                    <th className="py-2 px-3">File Path</th>
                    <th className="py-2 px-3 text-right">Size</th>
                    <th className="py-2 px-3 text-right">SHA-256</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/80">
                  {filteredSourceFiles.map((file) => {
                    const isSelected = inspectedFileObj?.path === file.path;
                    return (
                      <tr
                        key={file.path}
                        onClick={() => setSelectedFileForInspect(file.path)}
                        className={`cursor-pointer transition-colors ${
                          isSelected ? 'bg-slate-800/80 text-cyan-300' : 'hover:bg-slate-800/40 text-slate-300'
                        }`}
                      >
                        <td className="py-2 px-3 truncate max-w-[200px]">{file.path}</td>
                        <td className="py-2 px-3 text-right text-slate-400">
                          {(file.sizeBytes / 1024).toFixed(1)} KB
                        </td>
                        <td className="py-2 px-3 text-right text-emerald-400">
                          {file.sha256.slice(0, 8)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="lg:col-span-7 border border-slate-800 bg-[#080C14] flex flex-col max-h-[360px]">
              <div className="px-3.5 py-2 border-b border-slate-800 bg-[#0D131F] flex items-center justify-between text-xs font-mono">
                <span className="text-slate-200 font-semibold">
                  {inspectedFileObj ? inspectedFileObj.path : 'Select a file to inspect'}
                </span>
                {inspectedFileObj && (
                  <span className="text-slate-400 tabular-nums">
                    {inspectedFileObj.category} · {(inspectedFileObj.sizeBytes / 1024).toFixed(1)} KB · sha256:{inspectedFileObj.sha256}
                  </span>
                )}
              </div>
              <pre className="p-3.5 text-[11px] font-mono text-slate-300 overflow-auto flex-1 leading-relaxed">
                {inspectedFileObj
                  ? inspectedFileObj.content.slice(0, 6000) +
                    (inspectedFileObj.content.length > 6000
                      ? `\n\n... [Full file (${(inspectedFileObj.sizeBytes / 1024).toFixed(
                          1
                        )} KB) included in Google Drive archive] ...`
                      : '')
                  : 'No file selected.'}
              </pre>
            </div>
          </div>
        </div>
      )}

      {/* Mandatory Confirmation Modal for Overwrite, Restore, or Delete Operations */}
      {pendingConfirmation && (
        <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4">
          <div className="w-full max-w-md border border-slate-700 bg-[#111827] p-5 space-y-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
              <div>
                <h4 className="text-sm font-semibold text-slate-100">
                  {pendingConfirmation.type === 'OVERWRITE_DRIVE_COPY'
                    ? 'Confirm Overwriting Existing Google Drive Copy'
                    : pendingConfirmation.type === 'RESTORE_FROM_DRIVE'
                    ? 'Confirm Restoring Application State from Google Drive'
                    : 'Confirm Moving Google Drive Copy Folder to Trash'}
                </h4>
                <p className="text-xs text-slate-300 mt-1 leading-relaxed">
                  {pendingConfirmation.type === 'OVERWRITE_DRIVE_COPY'
                    ? `This will replace the existing files inside Google Drive folder "${pendingConfirmation.folder.name}" with a fresh snapshot of the current QuantPulse application and state.`
                    : pendingConfirmation.type === 'RESTORE_FROM_DRIVE'
                    ? `This will overwrite your currently active autonomous agents, working OCO orders, and feed states with the snapshot stored in "${pendingConfirmation.folder.name}".`
                    : `This will move the Google Drive folder "${pendingConfirmation.folder.name}" and its packaged artifacts to your Google Drive Trash.`}
                </p>
              </div>
            </div>

            <div className="p-3 border border-slate-800 bg-[#0B0F17] text-[11px] font-mono text-slate-400 space-y-1">
              <div>Target Folder: {pendingConfirmation.folder.name}</div>
              <div>Drive Folder ID: {pendingConfirmation.folder.id}</div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-800">
              <button
                type="button"
                disabled={isExecutingConfirmedAction}
                onClick={() => setPendingConfirmation(null)}
                className="px-3.5 py-1.5 border border-slate-700 hover:bg-slate-800 text-slate-300 text-xs rounded transition-colors whitespace-nowrap"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isExecutingConfirmedAction}
                onClick={handleConfirmPendingAction}
                className={`px-4 py-1.5 font-semibold text-xs rounded transition-colors whitespace-nowrap ${
                  pendingConfirmation.type === 'DELETE_DRIVE_COPY'
                    ? 'bg-rose-600 hover:bg-rose-500 text-white'
                    : 'bg-cyan-500 hover:bg-cyan-400 text-slate-950'
                }`}
              >
                {isExecutingConfirmedAction
                  ? 'Executing...'
                  : pendingConfirmation.type === 'OVERWRITE_DRIVE_COPY'
                  ? 'Confirm Overwrite in Drive'
                  : pendingConfirmation.type === 'RESTORE_FROM_DRIVE'
                  ? 'Confirm Restore State'
                  : 'Confirm Move to Trash'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
