import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { EventEdgeConfig, EventEdgeDiscoveryConfig } from '../config/index';
import {
  fetchPublicOpenKalshiCatalog,
  type DiscoverySource,
  type KalshiPublicClientOptions,
  type KalshiRawEvent,
  type KalshiRawMarket,
  type KalshiSettlementSource,
} from './kalshiPublicClient';

export {
  KALSHI_PUBLIC_BASE_URLS,
  KALSHI_PUBLIC_ALLOWED_HOSTS,
  DISCOVERY_SOURCES,
  EventEdgePublicClientViolationError,
  assertAllowedKalshiPublicBaseUrl,
  assertPublicMarketDataRequest,
  fetchKalshiPublicEndpoint,
  fetchOpenKalshiEvents,
  fetchOpenKalshiMarkets,
  fetchPublicKalshiSeries,
  resolveSeriesTickersByPrefixes,
  fetchOpenKalshiEventsForSeries,
  fetchPublicOpenKalshiCatalog,
  fetchPublicKalshiMarketByTicker,
  type DiscoverySource,
  type KalshiSettlementSource,
  type KalshiRawSeries,
  type KalshiRawMarket,
  type KalshiRawEvent,
  type KalshiPublicClientOptions,
  type KalshiPublicCatalogResult,
} from './kalshiPublicClient';

export const EVENT_DATE_SOURCES = [
  'OCCURRENCE',
  'STRIKE_DATE',
  'TICKER_DATE',
  'CLOSE_TIME',
] as const;
export type EventDateSource = (typeof EVENT_DATE_SOURCES)[number];

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
  readonly discoverySource: DiscoverySource;
  readonly effectiveEventDateUtc: string | null;
  readonly dateSource: EventDateSource;
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
  readonly dateSource?: EventDateSource;
  readonly effectiveEventDateUtc?: string | null;
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
  readonly resolvedSeriesTickers: readonly string[];
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

const KALSHI_MONTH_INDEX: Readonly<Record<string, number>> = Object.freeze({
  JAN: 0,
  FEB: 1,
  MAR: 2,
  APR: 3,
  MAY: 4,
  JUN: 5,
  JUL: 6,
  AUG: 7,
  SEP: 8,
  OCT: 9,
  NOV: 10,
  DEC: 11,
});

/**
 * Parses an unambiguous trailing Kalshi `-YYMMMDD` date token (e.g. `-26DEC03`) from an
 * event ticker into a UTC ISO-8601 timestamp (`2026-12-03T00:00:00.000Z`).
 *
 * Month-only tokens like `-26DEC` (`-YYMMM`) are intentionally treated as too ambiguous
 * and return `null` (no override).
 */
export function parseKalshiEventTickerDate(eventTicker: string | null | undefined): string | null {
  if (typeof eventTicker !== 'string') return null;
  const trimmed = eventTicker.trim();
  if (!trimmed) return null;

  const match = /-(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})$/i.exec(trimmed);
  if (!match) return null;

  const year = 2000 + Number(match[1]);
  const monthIdx = KALSHI_MONTH_INDEX[match[2].toUpperCase()];
  const day = Number(match[3]);
  if (monthIdx === undefined || !Number.isInteger(day) || day < 1 || day > 31) {
    return null;
  }

  const epochMs = Date.UTC(year, monthIdx, day, 0, 0, 0, 0);
  const dt = new Date(epochMs);
  // Reject invalid calendar dates like Feb 30 or Apr 31
  if (
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() !== monthIdx ||
    dt.getUTCDate() !== day
  ) {
    return null;
  }
  return dt.toISOString();
}

/**
 * Resolves a market's effective event date as the earliest parseable override among:
 *  (a) `market.occurrence_datetime` (`OCCURRENCE`)
 *  (b) parent `event.strike_date` or `market.strike_date` (`STRIKE_DATE`)
 *  (c) unambiguous trailing `-YYMMMDD` token on `eventTicker` (`TICKER_DATE`)
 * Falls back to `close_time` (or `expiration_time`) with `CLOSE_TIME` when no override parses.
 */
export function resolveEffectiveEventDate(
  market: KalshiRawMarket,
  event: KalshiRawEvent | null,
  eventTicker: string,
  closeTimeUtc: string | null,
  expirationTimeUtc: string | null
): { readonly effectiveEventDateUtc: string | null; readonly dateSource: EventDateSource } {
  const candidates: Array<{
    readonly source: Exclude<EventDateSource, 'CLOSE_TIME'>;
    readonly iso: string;
    readonly ms: number;
  }> = [];

  const occIso = parseOptionalIsoTimestamp(market.occurrence_datetime);
  if (occIso) {
    candidates.push({ source: 'OCCURRENCE', iso: occIso, ms: Date.parse(occIso) });
  }

  const strikeIso =
    parseOptionalIsoTimestamp(event?.strike_date) ??
    parseOptionalIsoTimestamp(market.strike_date);
  if (strikeIso) {
    candidates.push({ source: 'STRIKE_DATE', iso: strikeIso, ms: Date.parse(strikeIso) });
  }

  const tickerIso = parseKalshiEventTickerDate(eventTicker);
  if (tickerIso) {
    candidates.push({ source: 'TICKER_DATE', iso: tickerIso, ms: Date.parse(tickerIso) });
  }

  if (candidates.length > 0) {
    // Earliest parseable override wins; ties preserve (a) OCCURRENCE -> (b) STRIKE_DATE -> (c) TICKER_DATE order
    let best = candidates[0];
    for (let i = 1; i < candidates.length; i += 1) {
      if (candidates[i].ms < best.ms) {
        best = candidates[i];
      }
    }
    return Object.freeze({
      effectiveEventDateUtc: best.iso,
      dateSource: best.source,
    });
  }

  return Object.freeze({
    effectiveEventDateUtc: closeTimeUtc ?? expirationTimeUtc,
    dateSource: 'CLOSE_TIME' as const,
  });
}

export interface NormalizeSnapshotOptions {
  readonly discoverySource?: DiscoverySource;
}

/**
 * Normalizes a raw Kalshi market + optional parent event payload into a timestamped
 * `market_snapshots` ledger record. Never fabricates missing prices or metadata.
 */
export function normalizeKalshiMarketToSnapshot(
  market: KalshiRawMarket,
  event: KalshiRawEvent | null = null,
  capturedAtIso: string = new Date().toISOString(),
  options: NormalizeSnapshotOptions = {}
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
  const discoverySource: DiscoverySource = options.discoverySource ?? 'SWEEP';
  const { effectiveEventDateUtc, dateSource } = resolveEffectiveEventDate(
    market,
    event,
    eventTicker,
    closeTimeUtc,
    expirationTimeUtc
  );

  const rawPayloadJson = JSON.stringify({
    market,
    event: event ?? null,
    provenance: {
      discovery_source: discoverySource,
      date_source: dateSource,
      effective_event_date_utc: effectiveEventDateUtc,
    },
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
    discoverySource,
    effectiveEventDateUtc,
    dateSource,
    rawPayloadJson,
    capturedAt: capturedAtIso,
  });
}

/**
 * Merges single-market enrichment fields (`settlement_sources`, `settlement_source`,
 * `settlement_source_name`, `rules_primary`, `rules_secondary`) fetched from
 * `GET /markets/{ticker}` into an existing normalized snapshot, preserving all original
 * discovery/date provenance and returning a new append-only `NormalizedMarketSnapshot`.
 */
export function mergeEnrichedKalshiMarketIntoSnapshot(
  snapshot: NormalizedMarketSnapshot,
  fetchedMarket: KalshiRawMarket,
  capturedAtIso: string = snapshot.capturedAt
): NormalizedMarketSnapshot {
  let existingMarket: KalshiRawMarket = {
    ticker: snapshot.marketTicker,
    event_ticker: snapshot.eventTicker,
    series_ticker: snapshot.seriesTicker ?? undefined,
    category: snapshot.category ?? undefined,
    close_time: snapshot.closeTimeUtc,
    expiration_time: snapshot.expirationTimeUtc,
  };
  let existingEvent: KalshiRawEvent | null = null;

  try {
    const parsed = JSON.parse(snapshot.rawPayloadJson) as {
      market?: KalshiRawMarket;
      event?: KalshiRawEvent | null;
    };
    if (parsed && parsed.market && typeof parsed.market === 'object') {
      existingMarket = parsed.market;
    }
    if (parsed && parsed.event && typeof parsed.event === 'object') {
      existingEvent = parsed.event;
    }
  } catch {
    // Fallback to constructed baseline market
  }

  const fetchedHasSources =
    Array.isArray(fetchedMarket.settlement_sources) &&
    fetchedMarket.settlement_sources.some(
      (s) => s && typeof s === 'object' && typeof s.name === 'string' && s.name.trim().length > 0
    );
  const existingHasSources =
    Array.isArray(existingMarket.settlement_sources) &&
    existingMarket.settlement_sources.some(
      (s) => s && typeof s === 'object' && typeof s.name === 'string' && s.name.trim().length > 0
    );

  const mergedMarket: KalshiRawMarket = {
    ...existingMarket,
    settlement_sources: fetchedHasSources
      ? fetchedMarket.settlement_sources
      : existingHasSources
        ? existingMarket.settlement_sources
        : (fetchedMarket.settlement_sources ?? existingMarket.settlement_sources ?? null),
    settlement_source:
      existingMarket.settlement_source ?? fetchedMarket.settlement_source ?? null,
    settlement_source_name:
      trimToNull(existingMarket.settlement_source_name) ??
      trimToNull(fetchedMarket.settlement_source_name),
    rules_primary:
      trimToNull(existingMarket.rules_primary) ?? trimToNull(fetchedMarket.rules_primary),
    rules_secondary:
      trimToNull(existingMarket.rules_secondary) ?? trimToNull(fetchedMarket.rules_secondary),
  };

  return normalizeKalshiMarketToSnapshot(mergedMarket, existingEvent, capturedAtIso, {
    discoverySource: snapshot.discoverySource,
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
      settlement_source_name, discovery_source, effective_event_date_utc, date_source,
      raw_payload_json, captured_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
    snapshot.discoverySource,
    snapshot.effectiveEventDateUtc,
    snapshot.dateSource,
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
      settlement_source_name, discovery_source, effective_event_date_utc, date_source,
      raw_payload_json, captured_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        s.discoverySource,
        s.effectiveEventDateUtc,
        s.dateSource,
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
      dateSource: snapshot.dateSource,
      effectiveEventDateUtc: snapshot.effectiveEventDateUtc,
    };
  }

  // Max-horizon test uses the parsed event-date override INSTEAD of close_time when present;
  // close_time still governs the too-soon check above.
  const hasOverrideDate =
    snapshot.dateSource !== 'CLOSE_TIME' &&
    typeof snapshot.effectiveEventDateUtc === 'string' &&
    Number.isFinite(Date.parse(snapshot.effectiveEventDateUtc));
  const horizonTargetIso = hasOverrideDate ? snapshot.effectiveEventDateUtc! : targetCloseIso;
  const horizonTargetMs = hasOverrideDate ? Date.parse(horizonTargetIso) : closeMs;

  const maxAllowedMs = nowMs + discoveryConfig.maxCloseHorizonDays * 86_400_000;
  if (horizonTargetMs > maxAllowedMs) {
    return {
      included: false,
      reason: 'BEYOND_CLOSE_HORIZON',
      detail: `Market effective event date ${horizonTargetIso} (date_source=${snapshot.dateSource}) exceeds configured ${discoveryConfig.maxCloseHorizonDays}-day horizon.`,
      dateSource: snapshot.dateSource,
      effectiveEventDateUtc: horizonTargetIso,
    };
  }

  return {
    included: true,
    dateSource: snapshot.dateSource,
    effectiveEventDateUtc: horizonTargetIso,
  };
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
    targetSeriesPrefixes: options.config.discovery.targetSeriesPrefixes,
    targetSeriesTickers: options.config.discovery.targetSeriesTickers,
    targetedOnly: options.config.discovery.targetedOnly,
    ...options.clientOptions,
  });

  const allSnapshots = catalog.markets.map(({ market, event, discoverySource }) =>
    normalizeKalshiMarketToSnapshot(market, event, capturedAt, { discoverySource })
  );

  const snapshotsPersisted = persistMarketSnapshots(options.db, allSnapshots);
  const scanResult = scanMarkets(allSnapshots, options.config.discovery, now.getTime());

  return {
    baseUrlUsed: catalog.baseUrlUsed,
    capturedAt,
    eventsFetched: catalog.events.length,
    marketsFetched: catalog.markets.length,
    snapshotsPersisted,
    resolvedSeriesTickers: catalog.resolvedSeriesTickers,
    allSnapshots,
    scannedSnapshots: scanResult.matched,
    excludedMarkets: scanResult.excluded,
  };
}
