import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { EventEdgeConfig, EventEdgeDiscoveryConfig } from '../config/index';
import {
  fetchPublicOpenKalshiCatalog,
  type KalshiPublicClientOptions,
  type KalshiRawEvent,
  type KalshiRawMarket,
  type KalshiSettlementSource,
} from './kalshiPublicClient';

export {
  KALSHI_PUBLIC_BASE_URLS,
  KALSHI_PUBLIC_ALLOWED_HOSTS,
  EventEdgePublicClientViolationError,
  assertAllowedKalshiPublicBaseUrl,
  assertPublicMarketDataRequest,
  fetchKalshiPublicEndpoint,
  fetchOpenKalshiEvents,
  fetchOpenKalshiMarkets,
  fetchPublicOpenKalshiCatalog,
  fetchPublicKalshiMarketByTicker,
  type KalshiSettlementSource,
  type KalshiRawMarket,
  type KalshiRawEvent,
  type KalshiPublicClientOptions,
  type KalshiPublicCatalogResult,
} from './kalshiPublicClient';

export interface NormalizedMarketSnapshot {
  readonly snapshotId: string;
  readonly venue: 'KALSHI';
  readonly seriesTicker: string | null;
  readonly eventTicker: string;
  readonly marketTicker: string;
  readonly category: string | null;
  readonly marketTerms: string | null;
  readonly status: string;
  readonly yesBidUsd: number | null;
  readonly yesAskUsd: number | null;
  readonly noBidUsd: number | null;
  readonly noAskUsd: number | null;
  readonly lastPriceUsd: number | null;
  readonly volume: number | null;
  readonly openInterest: number | null;
  readonly closeTimeUtc: string | null;
  readonly expirationTimeUtc: string | null;
  readonly settlementSourceName: string | null;
  readonly rawPayloadJson: string;
  readonly capturedAt: string;
}

export type DiscoveryFilterExclusionReason =
  | 'CATEGORY_BLOCKLISTED'
  | 'MISSING_CLOSE_TIME'
  | 'ALREADY_CLOSED_OR_TOO_SOON'
  | 'BEYOND_CLOSE_HORIZON';

export interface DiscoveryFilterDecision {
  readonly included: boolean;
  readonly reason?: DiscoveryFilterExclusionReason;
  readonly detail?: string;
}

export interface ExcludedMarketRecord {
  readonly snapshot: NormalizedMarketSnapshot;
  readonly reason: DiscoveryFilterExclusionReason;
  readonly detail: string;
}

export interface MarketScanResult {
  readonly matched: NormalizedMarketSnapshot[];
  readonly excluded: ExcludedMarketRecord[];
}

export interface DiscoverAndScanOptions {
  readonly db: DatabaseSync;
  readonly config: EventEdgeConfig;
  readonly clientOptions?: KalshiPublicClientOptions;
  readonly now?: Date;
}

export interface DiscoverAndScanResult {
  readonly baseUrlUsed: string;
  readonly capturedAt: string;
  readonly eventsFetched: number;
  readonly marketsFetched: number;
  readonly snapshotsPersisted: number;
  readonly allSnapshots: NormalizedMarketSnapshot[];
  readonly scannedSnapshots: NormalizedMarketSnapshot[];
  readonly excludedMarkets: ExcludedMarketRecord[];
}

function parseOptionalDollarPrice(
  dollarsField: unknown,
  centsField: unknown
): number | null {
  if (dollarsField !== undefined && dollarsField !== null && dollarsField !== '') {
    const parsed = Number(dollarsField);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) {
      return Number(parsed.toFixed(6));
    }
  }
  if (centsField !== undefined && centsField !== null && centsField !== '') {
    const parsedCents = Number(centsField);
    if (Number.isFinite(parsedCents) && parsedCents >= 0 && parsedCents <= 100) {
      return Number((parsedCents / 100).toFixed(6));
    }
  }
  return null;
}

function parseOptionalInteger(primary: unknown, fallback?: unknown): number | null {
  for (const candidate of [primary, fallback]) {
    if (candidate !== undefined && candidate !== null && candidate !== '') {
      const parsed = Number(candidate);
      if (Number.isFinite(parsed) && parsed >= 0) {
        return Math.round(parsed);
      }
    }
  }
  return null;
}

function parseOptionalIsoTimestamp(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  const ms = Date.parse(raw.trim());
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function trimToNull(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function extractSettlementSourceNameFromPayload(
  market: KalshiRawMarket,
  event: KalshiRawEvent | null
): string | null {
  const names: string[] = [];
  const seen = new Set<string>();

  const pushName = (raw: unknown) => {
    const cleaned = trimToNull(raw);
    if (!cleaned) return;
    const key = cleaned.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      names.push(cleaned);
    }
  };

  const inspectList = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const entry of list as KalshiSettlementSource[]) {
      if (entry && typeof entry === 'object') {
        pushName(entry.name);
      }
    }
  };

  inspectList(market.settlement_sources);
  if (names.length === 0 && event) {
    inspectList(event.settlement_sources);
  }
  if (names.length === 0) {
    pushName(market.settlement_source_name);
  }
  if (names.length === 0 && market.settlement_source) {
    if (typeof market.settlement_source === 'string') {
      pushName(market.settlement_source);
    } else if (typeof market.settlement_source === 'object') {
      pushName(market.settlement_source.name);
    }
  }

  return names.length > 0 ? names.join('; ') : null;
}

/**
 * Normalizes a raw Kalshi market + optional parent event payload into a timestamped
 * `market_snapshots` ledger record. Never fabricates missing prices or metadata.
 */
export function normalizeKalshiMarketToSnapshot(
  market: KalshiRawMarket,
  event: KalshiRawEvent | null = null,
  capturedAtIso: string = new Date().toISOString()
): NormalizedMarketSnapshot {
  const marketTicker = trimToNull(market.ticker);
  if (!marketTicker) {
    throw new Error('Cannot normalize Kalshi market without a non-empty ticker.');
  }

  const eventTicker =
    trimToNull(market.event_ticker) ?? trimToNull(event?.event_ticker) ?? marketTicker;
  const seriesTicker = trimToNull(market.series_ticker) ?? trimToNull(event?.series_ticker);
  const category = trimToNull(market.category) ?? trimToNull(event?.category);

  const marketTerms =
    trimToNull(market.subtitle) ??
    trimToNull(market.yes_sub_title) ??
    trimToNull(market.title) ??
    trimToNull(event?.sub_title) ??
    trimToNull(event?.title);

  const status = trimToNull(market.status) ?? 'open';
  const yesBidUsd = parseOptionalDollarPrice(market.yes_bid_dollars, market.yes_bid);
  const yesAskUsd = parseOptionalDollarPrice(market.yes_ask_dollars, market.yes_ask);
  const noBidUsd = parseOptionalDollarPrice(market.no_bid_dollars, market.no_bid);
  const noAskUsd = parseOptionalDollarPrice(market.no_ask_dollars, market.no_ask);
  const lastPriceUsd = parseOptionalDollarPrice(market.last_price_dollars, market.last_price);

  const volume = parseOptionalInteger(market.volume, market.volume_fp);
  const openInterest = parseOptionalInteger(market.open_interest, market.open_interest_fp);

  const closeTimeUtc = parseOptionalIsoTimestamp(market.close_time);
  const expirationTimeUtc =
    parseOptionalIsoTimestamp(market.expiration_time) ??
    parseOptionalIsoTimestamp(market.latest_expiration_time);

  const settlementSourceName = extractSettlementSourceNameFromPayload(market, event);

  const rawPayloadJson = JSON.stringify({
    market,
    event: event ?? null,
  });

  return Object.freeze({
    snapshotId: `snap_${crypto.randomUUID()}`,
    venue: 'KALSHI' as const,
    seriesTicker,
    eventTicker,
    marketTicker,
    category,
    marketTerms,
    status,
    yesBidUsd,
    yesAskUsd,
    noBidUsd,
    noAskUsd,
    lastPriceUsd,
    volume,
    openInterest,
    closeTimeUtc,
    expirationTimeUtc,
    settlementSourceName,
    rawPayloadJson,
    capturedAt: capturedAtIso,
  });
}

/**
 * Inserts a single normalized market snapshot into the immutable `market_snapshots` table.
 */
export function persistMarketSnapshot(
  db: DatabaseSync,
  snapshot: NormalizedMarketSnapshot
): void {
  db.prepare(
    `INSERT INTO market_snapshots (
      snapshot_id, venue, series_ticker, event_ticker, market_ticker,
      category, market_terms, status,
      yes_bid_usd, yes_ask_usd, no_bid_usd, no_ask_usd, last_price_usd,
      volume, open_interest, close_time_utc, expiration_time_utc,
      settlement_source_name, raw_payload_json, captured_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    snapshot.snapshotId,
    snapshot.venue,
    snapshot.seriesTicker,
    snapshot.eventTicker,
    snapshot.marketTicker,
    snapshot.category,
    snapshot.marketTerms,
    snapshot.status,
    snapshot.yesBidUsd,
    snapshot.yesAskUsd,
    snapshot.noBidUsd,
    snapshot.noAskUsd,
    snapshot.lastPriceUsd,
    snapshot.volume,
    snapshot.openInterest,
    snapshot.closeTimeUtc,
    snapshot.expirationTimeUtc,
    snapshot.settlementSourceName,
    snapshot.rawPayloadJson,
    snapshot.capturedAt
  );
}

/**
 * Atomically appends a batch of market snapshots into `market_snapshots`
 * (one timestamped row per fetch; never overwrites prior snapshots).
 */
export function persistMarketSnapshots(
  db: DatabaseSync,
  snapshots: readonly NormalizedMarketSnapshot[]
): number {
  if (snapshots.length === 0) return 0;

  const stmt = db.prepare(
    `INSERT INTO market_snapshots (
      snapshot_id, venue, series_ticker, event_ticker, market_ticker,
      category, market_terms, status,
      yes_bid_usd, yes_ask_usd, no_bid_usd, no_ask_usd, last_price_usd,
      volume, open_interest, close_time_utc, expiration_time_utc,
      settlement_source_name, raw_payload_json, captured_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const s of snapshots) {
      stmt.run(
        s.snapshotId,
        s.venue,
        s.seriesTicker,
        s.eventTicker,
        s.marketTicker,
        s.category,
        s.marketTerms,
        s.status,
        s.yesBidUsd,
        s.yesAskUsd,
        s.noBidUsd,
        s.noAskUsd,
        s.lastPriceUsd,
        s.volume,
        s.openInterest,
        s.closeTimeUtc,
        s.expirationTimeUtc,
        s.settlementSourceName,
        s.rawPayloadJson,
        s.capturedAt
      );
    }
    db.exec('COMMIT');
    return snapshots.length;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Ignore rollback failure
    }
    throw err;
  }
}

function normalizeCategoryString(raw: string): string {
  return raw.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
}

function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findMatchedBlocklistedCategory(
  category: string | null,
  excludedCategories: readonly string[]
): string | null {
  if (!category || excludedCategories.length === 0) return null;
  const normalizedCategory = normalizeCategoryString(category);
  if (!normalizedCategory) return null;

  for (const rawBlocked of excludedCategories) {
    const blocked = normalizeCategoryString(rawBlocked);
    if (!blocked) continue;
    if (normalizedCategory === blocked) {
      return blocked;
    }
    const wordBounded = new RegExp(`\\b${escapeRegExpLiteral(blocked)}\\b`, 'i');
    if (wordBounded.test(normalizedCategory)) {
      return blocked;
    }
  }
  return null;
}

/**
 * Evaluates a normalized market snapshot against the EventEdge discovery filter settings
 * (close horizon and excluded category blocklist) supplied via config.
 */
export function evaluateDiscoveryFilter(
  snapshot: NormalizedMarketSnapshot,
  discoveryConfig: EventEdgeDiscoveryConfig,
  nowMs: number = Date.now()
): DiscoveryFilterDecision {
  const matchedBlock = findMatchedBlocklistedCategory(
    snapshot.category,
    discoveryConfig.excludedCategories
  );
  if (matchedBlock) {
    return {
      included: false,
      reason: 'CATEGORY_BLOCKLISTED',
      detail: `Category "${snapshot.category}" matched blocklist entry "${matchedBlock}".`,
    };
  }

  const targetCloseIso = snapshot.closeTimeUtc ?? snapshot.expirationTimeUtc;
  if (!targetCloseIso) {
    return {
      included: false,
      reason: 'MISSING_CLOSE_TIME',
      detail: 'Market has neither a valid close_time nor expiration_time.',
    };
  }

  const closeMs = Date.parse(targetCloseIso);
  if (!Number.isFinite(closeMs)) {
    return {
      included: false,
      reason: 'MISSING_CLOSE_TIME',
      detail: `Unparseable close/expiry timestamp "${targetCloseIso}".`,
    };
  }

  const minAllowedMs = nowMs + discoveryConfig.minCloseHorizonMinutes * 60_000;
  if (closeMs <= minAllowedMs) {
    return {
      included: false,
      reason: 'ALREADY_CLOSED_OR_TOO_SOON',
      detail: `Market close time ${targetCloseIso} is at or before min horizon (${discoveryConfig.minCloseHorizonMinutes}m).`,
    };
  }

  const maxAllowedMs = nowMs + discoveryConfig.maxCloseHorizonDays * 86_400_000;
  if (closeMs > maxAllowedMs) {
    return {
      included: false,
      reason: 'BEYOND_CLOSE_HORIZON',
      detail: `Market close time ${targetCloseIso} exceeds configured ${discoveryConfig.maxCloseHorizonDays}-day horizon.`,
    };
  }

  return { included: true };
}

/**
 * Filters a set of normalized market snapshots using the configured discovery horizon
 * and category blocklist from `EventEdgeDiscoveryConfig` (never hardcoded).
 */
export function scanMarkets(
  snapshots: readonly NormalizedMarketSnapshot[],
  discoveryConfig: EventEdgeDiscoveryConfig,
  nowMs: number = Date.now()
): MarketScanResult {
  const matched: NormalizedMarketSnapshot[] = [];
  const excluded: ExcludedMarketRecord[] = [];

  for (const snapshot of snapshots) {
    const decision = evaluateDiscoveryFilter(snapshot, discoveryConfig, nowMs);
    if (decision.included) {
      matched.push(snapshot);
    } else {
      excluded.push({
        snapshot,
        reason: decision.reason!,
        detail: decision.detail ?? 'Excluded by discovery filter.',
      });
    }
  }

  return { matched, excluded };
}

/**
 * Runs a full public-data Kalshi market discovery pass:
 * 1. Fetches open events & markets via public Kalshi REST endpoints only.
 * 2. Normalizes each market into a timestamped `market_snapshots` row.
 * 3. Persists all fetched snapshots to the immutable ledger.
 * 4. Filters markets using `config.discovery` (close horizon + excluded category blocklist).
 */
export async function discoverAndScanMarkets(
  options: DiscoverAndScanOptions
): Promise<DiscoverAndScanResult> {
  const now = options.now ?? new Date();
  const capturedAt = now.toISOString();

  const catalog = await fetchPublicOpenKalshiCatalog({
    maxPagesPerEndpoint: options.config.discovery.maxPagesPerEndpoint,
    pageLimit: options.config.discovery.pageLimit,
    rateLimitDelayMs: options.config.discovery.rateLimitDelayMs,
    ...options.clientOptions,
  });

  const allSnapshots = catalog.markets.map(({ market, event }) =>
    normalizeKalshiMarketToSnapshot(market, event, capturedAt)
  );

  const snapshotsPersisted = persistMarketSnapshots(options.db, allSnapshots);
  const scanResult = scanMarkets(allSnapshots, options.config.discovery, now.getTime());

  return {
    baseUrlUsed: catalog.baseUrlUsed,
    capturedAt,
    eventsFetched: catalog.events.length,
    marketsFetched: catalog.markets.length,
    snapshotsPersisted,
    allSnapshots,
    scannedSnapshots: scanResult.matched,
    excludedMarkets: scanResult.excluded,
  };
}
