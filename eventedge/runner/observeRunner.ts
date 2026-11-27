import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import {
  EventEdgeConfigValidationError,
  createEventEdgeConfig,
  type EventEdgeConfig,
  type EventEdgeConfigInput,
  type EventEdgeDiscoveryConfig,
} from '../config/index';
import { initializeEventEdgeLedger } from '../db/migrations';
import {
  discoverAndScanMarkets,
  type DiscoverAndScanResult,
  type KalshiPublicClientOptions,
  type NormalizedMarketSnapshot,
} from '../discovery/index';
import {
  auditDiscoveredMarkets,
  type AmbiguityReason,
  type AmbiguityReasonCount,
  type AuditedMarketEntry,
} from '../resolution/index';

export interface ObserveRunSummary {
  readonly runId: string;
  readonly mode: 'OBSERVE';
  readonly startedAt: string;
  readonly completedAt: string;
  readonly baseUrlUsed: string;
  readonly eventsFetched: number;
  readonly marketsFetched: number;
  readonly marketsFilteredOut: number;
  readonly marketsScanned: number;
  readonly clearCount: number;
  readonly ambiguousCount: number;
  readonly newRuleVersionsCount: number;
  readonly topAmbiguityReasons: readonly AmbiguityReasonCount[];
  readonly clearTickers: readonly string[];
  readonly ambiguousMarkets: readonly {
    readonly marketTicker: string;
    readonly eventTicker: string;
    readonly reasons: readonly AmbiguityReason[];
  }[];
  readonly filterConfig: EventEdgeDiscoveryConfig;
}

export interface RunObserveCycleOptions {
  /** Pre-constructed EventEdgeConfig (must be mode === 'OBSERVE'). */
  readonly config?: EventEdgeConfig;
  /** Optional config input used if `config` is not provided (mode defaults to OBSERVE; LIVE raises). */
  readonly configInput?: EventEdgeConfigInput;
  /** Optional env map forwarded to `createEventEdgeConfig`. */
  readonly env?: Record<string, string | undefined>;
  /** Optional already-initialized ledger DB (if omitted, opens & migrates `config.ledgerDbPath`). */
  readonly db?: DatabaseSync;
  /** Optional public Kalshi client options (e.g., fixture `fetchFn` in tests). */
  readonly clientOptions?: KalshiPublicClientOptions;
  /** Optional deterministic clock for tests. */
  readonly now?: Date;
  /** Optional JSON file path to write the run summary in addition to the SQLite ledger. */
  readonly summaryOutputPath?: string;
  /** Optional base directory confining `summaryOutputPath` against path traversal. */
  readonly summaryBaseDir?: string;
  /** Optional pre-audit hook allowing callers (e.g. paperRunner enrichment) to enrich scanned snapshots before auditing. */
  readonly beforeAudit?: (
    snapshots: readonly NormalizedMarketSnapshot[]
  ) => Promise<readonly NormalizedMarketSnapshot[]>;
}

export interface RunObserveCycleResult {
  readonly summary: ObserveRunSummary;
  readonly discovery: DiscoverAndScanResult;
  readonly clearMarkets: readonly AuditedMarketEntry[];
  readonly ambiguousMarkets: readonly AuditedMarketEntry[];
  readonly summaryFilePath: string | null;
}

function resolveSafeSummaryOutputPath(outputPath: string, baseDir?: string): string {
  const resolved = path.resolve(outputPath);
  if (baseDir) {
    const resolvedBase = path.resolve(baseDir);
    const prefix = resolvedBase.endsWith(path.sep)
      ? resolvedBase
      : `${resolvedBase}${path.sep}`;
    if (!resolved.startsWith(prefix)) {
      throw new EventEdgeConfigValidationError(
        `Summary output path "${outputPath}" escapes allowed base directory.`
      );
    }
  }
  return resolved;
}

function persistObserveRunSummary(db: DatabaseSync, summary: ObserveRunSummary): void {
  db.prepare(
    `INSERT INTO observe_run_summaries (
      run_id, mode, started_at, completed_at,
      events_fetched, markets_fetched, markets_filtered_out, markets_scanned,
      clear_count, ambiguous_count, new_rule_versions_count,
      top_ambiguity_reasons_json, filter_config_json, summary_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    summary.runId,
    summary.mode,
    summary.startedAt,
    summary.completedAt,
    summary.eventsFetched,
    summary.marketsFetched,
    summary.marketsFilteredOut,
    summary.marketsScanned,
    summary.clearCount,
    summary.ambiguousCount,
    summary.newRuleVersionsCount,
    JSON.stringify(summary.topAmbiguityReasons),
    JSON.stringify(summary.filterConfig),
    JSON.stringify(summary)
  );
}

/**
 * Single OBSERVE-mode entry point that executes one Market Discovery + Contract Resolution Audit
 * cycle and writes an immutable run summary to `observe_run_summaries` (and optional JSON file).
 *
 * Strictly read-only with respect to trading: generates NO forecasts, submits NO orders,
 * and invokes ZERO order-authority, risk-guard, or brokerage execution components.
 */
export async function runObserveCycle(
  options: RunObserveCycleOptions = {}
): Promise<RunObserveCycleResult> {
  const config =
    options.config ?? createEventEdgeConfig(options.configInput ?? {}, options.env ?? process.env);

  if (config.mode !== 'OBSERVE') {
    throw new EventEdgeConfigValidationError(
      `OBSERVE runner requires config.mode === "OBSERVE" (received "${config.mode}").`
    );
  }

  // Fail closed: validate summaryOutputPath confinement BEFORE opening DB or fetching markets
  const safeSummaryOut = options.summaryOutputPath
    ? resolveSafeSummaryOutputPath(options.summaryOutputPath, options.summaryBaseDir)
    : null;

  const startedDate = options.now ?? new Date();
  const startedAt = startedDate.toISOString();
  const runId = `obs_${crypto.randomUUID()}`;

  const ownsDb = !options.db;
  const db = options.db ?? initializeEventEdgeLedger(config.ledgerDbPath).db;

  try {
    const rawDiscovery = await discoverAndScanMarkets({
      db,
      config,
      clientOptions: options.clientOptions,
      now: startedDate,
    });

    const scannedSnapshotsForAudit = options.beforeAudit
      ? [...(await options.beforeAudit(rawDiscovery.scannedSnapshots))]
      : rawDiscovery.scannedSnapshots;

    const discovery: DiscoverAndScanResult = options.beforeAudit
      ? {
          ...rawDiscovery,
          scannedSnapshots: scannedSnapshotsForAudit,
        }
      : rawDiscovery;

    const auditBatch = auditDiscoveredMarkets(db, discovery.scannedSnapshots, startedAt);
    const completedAt = options.now ? startedAt : new Date().toISOString();

    const summary: ObserveRunSummary = Object.freeze({
      runId,
      mode: 'OBSERVE' as const,
      startedAt,
      completedAt,
      baseUrlUsed: discovery.baseUrlUsed,
      eventsFetched: discovery.eventsFetched,
      marketsFetched: discovery.marketsFetched,
      marketsFilteredOut: discovery.excludedMarkets.length,
      marketsScanned: discovery.scannedSnapshots.length,
      clearCount: auditBatch.clearMarkets.length,
      ambiguousCount: auditBatch.ambiguousMarkets.length,
      newRuleVersionsCount: auditBatch.newRuleVersionsCount,
      topAmbiguityReasons: Object.freeze([...auditBatch.topAmbiguityReasons]),
      clearTickers: Object.freeze(auditBatch.clearMarkets.map((m) => m.snapshot.marketTicker)),
      ambiguousMarkets: Object.freeze(
        auditBatch.ambiguousMarkets.map((m) =>
          Object.freeze({
            marketTicker: m.snapshot.marketTicker,
            eventTicker: m.snapshot.eventTicker,
            reasons: m.audit.reasons,
          })
        )
      ),
      filterConfig: config.discovery,
    });

    persistObserveRunSummary(db, summary);

    let summaryFilePath: string | null = null;
    if (safeSummaryOut) {
      fs.mkdirSync(path.dirname(safeSummaryOut), { recursive: true });
      fs.writeFileSync(safeSummaryOut, `${JSON.stringify(summary, null, 2)}\n`, 'utf-8');
      summaryFilePath = safeSummaryOut;
    }

    return {
      summary,
      discovery,
      clearMarkets: auditBatch.clearMarkets,
      ambiguousMarkets: auditBatch.ambiguousMarkets,
      summaryFilePath,
    };
  } finally {
    if (ownsDb) {
      db.close();
    }
  }
}

const __filename = fileURLToPath(import.meta.url);
const isMainModule =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(__filename);

if (isMainModule) {
  runObserveCycle()
    .then((result) => {
      console.log(JSON.stringify(result.summary, null, 2));
    })
    .catch((err) => {
      console.error('[EventEdge OBSERVE Runner] Failed:', err);
      process.exitCode = 1;
    });
}
