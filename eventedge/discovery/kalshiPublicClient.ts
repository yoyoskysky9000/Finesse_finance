import { RATE_LIMIT_DELAY_MS, sleep } from '../../scripts/fetch_walk_forward_history';

/**
 * Public-only Kalshi v2 REST market-data hosts matching `scripts/fetch_walk_forward_history.ts`
 * (documented in `eventedge/REUSE_MAP.md` §4A).
 */
export const KALSHI_PUBLIC_BASE_URLS: readonly string[] = Object.freeze([
  'https://api.elections.kalshi.com/trade-api/v2',
  'https://trading-api.kalshi.com/trade-api/v2',
]);

/**
 * Explicit HTTPS hostname allowlist for Kalshi public market-data calls.
 */
export const KALSHI_PUBLIC_ALLOWED_HOSTS: ReadonlySet<string> = new Set([
  'api.elections.kalshi.com',
  'trading-api.kalshi.com',
  'demo-api.kalshi.co',
  'external-api.kalshi.com',
  'external-api.demo.kalshi.co',
]);

const ALLOWED_PUBLIC_PATH_PREFIXES = ['/events', '/markets', '/series'] as const;
const FORBIDDEN_AUTH_OR_TRADING_SEGMENTS = [
  '/portfolio',
  '/orders',
  '/account',
  '/exchange/user_data',
  '/communications',
  '/rfq',
  '/quotes',
];

export class EventEdgePublicClientViolationError extends Error {
  public readonly code = 'EVENTEDGE_PUBLIC_CLIENT_VIOLATION' as const;

  constructor(message: string) {
    super(message);
    this.name = 'EventEdgePublicClientViolationError';
  }
}

export interface KalshiSettlementSource {
  name?: string;
  url?: string;
}

export interface KalshiRawMarket {
  ticker: string;
  event_ticker?: string;
  series_ticker?: string;
  category?: string;
  market_type?: string;
  title?: string;
  subtitle?: string;
  yes_sub_title?: string;
  no_sub_title?: string;
  status?: string;
  yes_bid?: number | null;
  yes_ask?: number | null;
  no_bid?: number | null;
  no_ask?: number | null;
  last_price?: number | null;
  yes_bid_dollars?: string | number | null;
  yes_ask_dollars?: string | number | null;
  no_bid_dollars?: string | number | null;
  no_ask_dollars?: string | number | null;
  last_price_dollars?: string | number | null;
  volume?: number | null;
  volume_fp?: string | number | null;
  open_interest?: number | null;
  open_interest_fp?: string | number | null;
  close_time?: string | null;
  expiration_time?: string | null;
  latest_expiration_time?: string | null;
  open_time?: string | null;
  occurrence_datetime?: string | null;
  strike_date?: string | null;
  rules_primary?: string | null;
  rules_secondary?: string | null;
  settlement_sources?: KalshiSettlementSource[] | null;
  settlement_source?: string | KalshiSettlementSource | null;
  settlement_source_name?: string | null;
  result?: string | null;
  settlement_ts?: string | null;
  settlement_value?: number | null;
  strike_type?: string | null;
  custom_strike?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface KalshiRawEvent {
  event_ticker: string;
  series_ticker?: string;
  title?: string;
  sub_title?: string;
  category?: string;
  mutually_exclusive?: boolean;
  collateral_return_type?: string;
  strike_date?: string | null;
  settlement_sources?: KalshiSettlementSource[] | null;
  markets?: KalshiRawMarket[];
  [key: string]: unknown;
}

export interface KalshiRawSeries {
  ticker: string;
  title?: string;
  category?: string;
  frequency?: string;
  settlement_sources?: KalshiSettlementSource[] | null;
  [key: string]: unknown;
}

export const DISCOVERY_SOURCES = ['SWEEP', 'TARGETED', 'BOTH'] as const;
export type DiscoverySource = (typeof DISCOVERY_SOURCES)[number];

export interface KalshiPublicClientOptions {
  fetchFn?: typeof fetch;
  baseUrls?: readonly string[];
  rateLimitDelayMs?: number;
  maxPagesPerEndpoint?: number;
  pageLimit?: number;
  maxRetries429?: number;
  targetSeriesPrefixes?: readonly string[];
  targetSeriesTickers?: readonly string[];
  targetedOnly?: boolean;
}

export interface KalshiPublicCatalogResult {
  baseUrlUsed: string;
  events: KalshiRawEvent[];
  markets: Array<{
    market: KalshiRawMarket;
    event: KalshiRawEvent | null;
    discoverySource: DiscoverySource;
  }>;
  eventPagesFetched: number;
  marketPagesFetched: number;
  seriesPagesFetched: number;
  targetedSeriesEventPagesFetched: number;
  resolvedSeriesTickers: readonly string[];
}

/**
 * Validates that a base URL uses HTTPS and targets an allowlisted Kalshi host.
 */
export function assertAllowedKalshiPublicBaseUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new EventEdgePublicClientViolationError(
      `Invalid Kalshi public base URL "${rawUrl}".`
    );
  }
  if (parsed.protocol !== 'https:') {
    throw new EventEdgePublicClientViolationError(
      `Kalshi public client requires https: protocol (received "${parsed.protocol}").`
    );
  }
  const hostname = parsed.hostname.toLowerCase();
  if (!KALSHI_PUBLIC_ALLOWED_HOSTS.has(hostname)) {
    throw new EventEdgePublicClientViolationError(
      `Host "${hostname}" is not in the allowlisted Kalshi public market-data host list.`
    );
  }
  return rawUrl.replace(/\/+$/, '');
}

/**
 * Enforces strictly unauthenticated GET requests against public Kalshi market-data paths.
 */
export function assertPublicMarketDataRequest(method: string, endpointPath: string): string {
  if (method.toUpperCase() !== 'GET') {
    throw new EventEdgePublicClientViolationError(
      `Kalshi public discovery client only allows GET requests (blocked "${method}").`
    );
  }
  const normalizedPath = endpointPath.startsWith('/') ? endpointPath : `/${endpointPath}`;
  const pathWithoutQuery = normalizedPath.split('?')[0].toLowerCase();

  for (const forbidden of FORBIDDEN_AUTH_OR_TRADING_SEGMENTS) {
    if (pathWithoutQuery === forbidden || pathWithoutQuery.startsWith(`${forbidden}/`)) {
      throw new EventEdgePublicClientViolationError(
        `Endpoint "${endpointPath}" is authenticated or trading-scoped and blocked in public discovery client.`
      );
    }
  }

  const isAllowed = ALLOWED_PUBLIC_PATH_PREFIXES.some(
    (prefix) => pathWithoutQuery === prefix || pathWithoutQuery.startsWith(`${prefix}/`)
  );
  if (!isAllowed) {
    throw new EventEdgePublicClientViolationError(
      `Endpoint "${endpointPath}" is not an allowed Kalshi public market-data path (${ALLOWED_PUBLIC_PATH_PREFIXES.join(', ')}).`
    );
  }

  return normalizedPath;
}

async function fetchPublicJsonWithRetry(
  url: string,
  fetchImpl: typeof fetch,
  paceMs: number,
  maxRetries429: number
): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': 'EventEdge-MarketDiscovery/1.0',
  };

  let res = await fetchImpl(url, { method: 'GET', headers });
  for (let retry = 0; retry < maxRetries429 && res.status === 429; retry += 1) {
    const retryAfterHdr = Number(res.headers?.get?.('retry-after') ?? NaN);
    const backoffMs =
      Number.isFinite(retryAfterHdr) && retryAfterHdr > 0
        ? Math.min(5000, Math.ceil(retryAfterHdr * 1000))
        : Math.max(250, Math.min(4000, Math.max(paceMs, 200) * (retry + 2)));
    if (backoffMs > 0) {
      await sleep(backoffMs);
    }
    res = await fetchImpl(url, { method: 'GET', headers });
  }
  return res;
}

/**
 * Executes a validated, unauthenticated GET call against a Kalshi public market-data endpoint.
 */
export async function fetchKalshiPublicEndpoint<T = Record<string, unknown>>(
  baseUrl: string,
  endpointPath: string,
  options: Pick<KalshiPublicClientOptions, 'fetchFn' | 'rateLimitDelayMs' | 'maxRetries429'> = {}
): Promise<T> {
  const safeBase = assertAllowedKalshiPublicBaseUrl(baseUrl);
  const safePath = assertPublicMarketDataRequest('GET', endpointPath);
  const fetchImpl = options.fetchFn ?? fetch;
  const paceMs = options.rateLimitDelayMs ?? RATE_LIMIT_DELAY_MS;
  const maxRetries = options.maxRetries429 ?? 5;

  const response = await fetchPublicJsonWithRetry(
    `${safeBase}${safePath}`,
    fetchImpl,
    paceMs,
    maxRetries
  );

  if (!response.ok) {
    throw new Error(
      `Kalshi public market-data GET ${safePath} failed with HTTP ${response.status}`
    );
  }

  return (await response.json()) as T;
}

/**
 * Fetches paginated open Kalshi events (with nested markets) from the public `/events` endpoint.
 */
export async function fetchOpenKalshiEvents(
  baseUrl: string,
  options: KalshiPublicClientOptions = {}
): Promise<{ events: KalshiRawEvent[]; pagesFetched: number }> {
  const safeBase = assertAllowedKalshiPublicBaseUrl(baseUrl);
  const paceMs = options.rateLimitDelayMs ?? RATE_LIMIT_DELAY_MS;
  const maxPages = Math.max(1, Math.floor(options.maxPagesPerEndpoint ?? 20));
  const pageLimit = Math.max(1, Math.min(200, Math.floor(options.pageLimit ?? 200)));

  const events: KalshiRawEvent[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let pagesFetched = 0;

  while (pagesFetched < maxPages) {
    if (pagesFetched > 0 && paceMs > 0) {
      await sleep(paceMs);
    }
    const qs = new URLSearchParams({
      status: 'open',
      with_nested_markets: 'true',
      limit: String(pageLimit),
    });
    if (cursor) qs.set('cursor', cursor);

    const payload = await fetchKalshiPublicEndpoint<{
      events?: KalshiRawEvent[];
      cursor?: string;
    }>(safeBase, `/events?${qs.toString()}`, options);

    pagesFetched += 1;
    const pageEvents = Array.isArray(payload.events) ? payload.events : [];
    for (const ev of pageEvents) {
      if (ev && typeof ev === 'object' && typeof ev.event_ticker === 'string' && ev.event_ticker) {
        events.push(ev);
      }
    }

    const nextCursor =
      typeof payload.cursor === 'string' && payload.cursor.trim().length > 0
        ? payload.cursor.trim()
        : undefined;
    if (!nextCursor || seenCursors.has(nextCursor) || pageEvents.length === 0) {
      break;
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  return { events, pagesFetched };
}

/**
 * Fetches paginated open Kalshi markets from the public `/markets` endpoint.
 */
export async function fetchOpenKalshiMarkets(
  baseUrl: string,
  options: KalshiPublicClientOptions = {}
): Promise<{ markets: KalshiRawMarket[]; pagesFetched: number }> {
  const safeBase = assertAllowedKalshiPublicBaseUrl(baseUrl);
  const paceMs = options.rateLimitDelayMs ?? RATE_LIMIT_DELAY_MS;
  const maxPages = Math.max(1, Math.floor(options.maxPagesPerEndpoint ?? 20));
  const pageLimit = Math.max(1, Math.min(200, Math.floor(options.pageLimit ?? 200)));

  const markets: KalshiRawMarket[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let pagesFetched = 0;

  while (pagesFetched < maxPages) {
    if (pagesFetched > 0 && paceMs > 0) {
      await sleep(paceMs);
    }
    const qs = new URLSearchParams({
      status: 'open',
      limit: String(pageLimit),
    });
    if (cursor) qs.set('cursor', cursor);

    const payload = await fetchKalshiPublicEndpoint<{
      markets?: KalshiRawMarket[];
      cursor?: string;
    }>(safeBase, `/markets?${qs.toString()}`, options);

    pagesFetched += 1;
    const pageMarkets = Array.isArray(payload.markets) ? payload.markets : [];
    for (const m of pageMarkets) {
      if (m && typeof m === 'object' && typeof m.ticker === 'string' && m.ticker) {
        markets.push(m);
      }
    }

    const nextCursor =
      typeof payload.cursor === 'string' && payload.cursor.trim().length > 0
        ? payload.cursor.trim()
        : undefined;
    if (!nextCursor || seenCursors.has(nextCursor) || pageMarkets.length === 0) {
      break;
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  return { markets, pagesFetched };
}

/**
 * Fetches paginated Kalshi series definitions from the unauthenticated public `/series` endpoint.
 */
export async function fetchPublicKalshiSeries(
  baseUrl: string,
  options: KalshiPublicClientOptions = {}
): Promise<{ series: KalshiRawSeries[]; pagesFetched: number }> {
  const safeBase = assertAllowedKalshiPublicBaseUrl(baseUrl);
  const paceMs = options.rateLimitDelayMs ?? RATE_LIMIT_DELAY_MS;
  const maxPages = Math.max(1, Math.floor(options.maxPagesPerEndpoint ?? 20));
  const pageLimit = Math.max(1, Math.min(200, Math.floor(options.pageLimit ?? 200)));

  const series: KalshiRawSeries[] = [];
  const seenTickers = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let pagesFetched = 0;

  while (pagesFetched < maxPages) {
    if (pagesFetched > 0 && paceMs > 0) {
      await sleep(paceMs);
    }
    const qs = new URLSearchParams({
      limit: String(pageLimit),
    });
    if (cursor) qs.set('cursor', cursor);

    const payload = await fetchKalshiPublicEndpoint<{
      series?: KalshiRawSeries[];
      cursor?: string;
    }>(safeBase, `/series?${qs.toString()}`, options);

    pagesFetched += 1;
    const pageSeries = Array.isArray(payload.series) ? payload.series : [];
    for (const s of pageSeries) {
      if (s && typeof s === 'object' && typeof s.ticker === 'string') {
        const cleaned = s.ticker.trim();
        if (cleaned.length > 0 && !seenTickers.has(cleaned)) {
          seenTickers.add(cleaned);
          series.push(s);
        }
      }
    }

    const nextCursor =
      typeof payload.cursor === 'string' && payload.cursor.trim().length > 0
        ? payload.cursor.trim()
        : undefined;
    if (!nextCursor || seenCursors.has(nextCursor) || pageSeries.length === 0) {
      break;
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  return { series, pagesFetched };
}

/**
 * Resolves series tickers whose ticker starts with any of the configured prefixes
 * using the paginated public `/series` endpoint.
 */
export async function resolveSeriesTickersByPrefixes(
  baseUrl: string,
  prefixes: readonly string[],
  options: KalshiPublicClientOptions = {}
): Promise<{
  readonly seriesTickers: readonly string[];
  readonly matchedSeries: readonly KalshiRawSeries[];
  readonly pagesFetched: number;
}> {
  const normalizedPrefixes = Array.from(
    new Set(
      prefixes
        .map((p) => (typeof p === 'string' ? p.trim().toUpperCase() : ''))
        .filter((p) => p.length > 0)
    )
  );
  if (normalizedPrefixes.length === 0) {
    return Object.freeze({
      seriesTickers: Object.freeze([]),
      matchedSeries: Object.freeze([]),
      pagesFetched: 0,
    });
  }

  const { series, pagesFetched } = await fetchPublicKalshiSeries(baseUrl, options);
  const matchedSeries: KalshiRawSeries[] = [];
  const matchedTickers: string[] = [];
  const seen = new Set<string>();

  for (const entry of series) {
    const tickerUpper = entry.ticker.trim().toUpperCase();
    if (
      normalizedPrefixes.some((prefix) => tickerUpper.startsWith(prefix)) &&
      !seen.has(entry.ticker.trim())
    ) {
      seen.add(entry.ticker.trim());
      matchedTickers.push(entry.ticker.trim());
      matchedSeries.push(entry);
    }
  }

  return Object.freeze({
    seriesTickers: Object.freeze(matchedTickers),
    matchedSeries: Object.freeze(matchedSeries),
    pagesFetched,
  });
}

/**
 * Fetches paginated open Kalshi events (with nested markets) for a single `series_ticker`
 * via the public `/events` endpoint.
 */
export async function fetchOpenKalshiEventsForSeries(
  baseUrl: string,
  seriesTicker: string,
  options: KalshiPublicClientOptions = {}
): Promise<{ events: KalshiRawEvent[]; pagesFetched: number }> {
  const trimmedSeries = seriesTicker.trim();
  if (!trimmedSeries) {
    throw new EventEdgePublicClientViolationError('Series ticker must be a non-empty string.');
  }

  const safeBase = assertAllowedKalshiPublicBaseUrl(baseUrl);
  const paceMs = options.rateLimitDelayMs ?? RATE_LIMIT_DELAY_MS;
  const maxPages = Math.max(1, Math.floor(options.maxPagesPerEndpoint ?? 20));
  const pageLimit = Math.max(1, Math.min(200, Math.floor(options.pageLimit ?? 200)));

  const events: KalshiRawEvent[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let pagesFetched = 0;

  while (pagesFetched < maxPages) {
    if (pagesFetched > 0 && paceMs > 0) {
      await sleep(paceMs);
    }
    const qs = new URLSearchParams({
      status: 'open',
      with_nested_markets: 'true',
      series_ticker: trimmedSeries,
      limit: String(pageLimit),
    });
    if (cursor) qs.set('cursor', cursor);

    const payload = await fetchKalshiPublicEndpoint<{
      events?: KalshiRawEvent[];
      cursor?: string;
    }>(safeBase, `/events?${qs.toString()}`, options);

    pagesFetched += 1;
    const pageEvents = Array.isArray(payload.events) ? payload.events : [];
    for (const ev of pageEvents) {
      if (ev && typeof ev === 'object' && typeof ev.event_ticker === 'string' && ev.event_ticker) {
        events.push(ev);
      }
    }

    const nextCursor =
      typeof payload.cursor === 'string' && payload.cursor.trim().length > 0
        ? payload.cursor.trim()
        : undefined;
    if (!nextCursor || seenCursors.has(nextCursor) || pageEvents.length === 0) {
      break;
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  return { events, pagesFetched };
}

function hasNonEmptySettlementSources(list: unknown): list is KalshiSettlementSource[] {
  return (
    Array.isArray(list) &&
    list.some((item) => item && typeof item === 'object' && typeof item.name === 'string' && item.name.trim().length > 0)
  );
}

function nonEmptyStringOrNull(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function mergeRawMarketRecords(
  existing: KalshiRawMarket | undefined,
  incoming: KalshiRawMarket,
  parentEvent: KalshiRawEvent | null
): KalshiRawMarket {
  const mergedSettlementSources = hasNonEmptySettlementSources(incoming.settlement_sources)
    ? incoming.settlement_sources
    : hasNonEmptySettlementSources(existing?.settlement_sources)
      ? existing!.settlement_sources
      : hasNonEmptySettlementSources(parentEvent?.settlement_sources)
        ? parentEvent!.settlement_sources
        : (incoming.settlement_sources ?? existing?.settlement_sources ?? parentEvent?.settlement_sources ?? null);

  return {
    ...(existing ?? {}),
    ...incoming,
    event_ticker: incoming.event_ticker ?? existing?.event_ticker ?? parentEvent?.event_ticker,
    series_ticker: incoming.series_ticker ?? existing?.series_ticker ?? parentEvent?.series_ticker,
    category: incoming.category ?? existing?.category ?? parentEvent?.category,
    occurrence_datetime: incoming.occurrence_datetime ?? existing?.occurrence_datetime ?? null,
    strike_date: incoming.strike_date ?? existing?.strike_date ?? parentEvent?.strike_date ?? null,
    rules_primary:
      nonEmptyStringOrNull(incoming.rules_primary) ??
      nonEmptyStringOrNull(existing?.rules_primary) ??
      null,
    rules_secondary:
      nonEmptyStringOrNull(incoming.rules_secondary) ??
      nonEmptyStringOrNull(existing?.rules_secondary) ??
      null,
    settlement_sources: mergedSettlementSources,
  };
}

/**
 * Fetches open Kalshi events and open markets via public market-data endpoints,
 * trying the configured public Kalshi base URLs in order, optionally running targeted
 * series fetches (via prefix resolution on `/series` and/or explicit `targetSeriesTickers`),
 * and deduplicating markets by ticker while recording `discoverySource` (`SWEEP | TARGETED | BOTH`).
 */
export async function fetchPublicOpenKalshiCatalog(
  options: KalshiPublicClientOptions = {}
): Promise<KalshiPublicCatalogResult> {
  const candidateUrls =
    options.baseUrls && options.baseUrls.length > 0
      ? options.baseUrls
      : KALSHI_PUBLIC_BASE_URLS;

  // Validate all candidate URLs upfront (fail closed before any network call)
  const validatedUrls = candidateUrls.map((u) => assertAllowedKalshiPublicBaseUrl(u));

  const targetSeriesPrefixes = Array.from(
    new Set(
      (options.targetSeriesPrefixes ?? [])
        .map((p) => p.trim().toUpperCase())
        .filter((p) => p.length > 0)
    )
  );
  const explicitSeriesTickers = Array.from(
    new Set(
      (options.targetSeriesTickers ?? [])
        .map((t) => t.trim().toUpperCase())
        .filter((t) => t.length > 0)
    )
  );
  const targetedOnly = options.targetedOnly === true;
  const hasTargeting = targetSeriesPrefixes.length > 0 || explicitSeriesTickers.length > 0;

  let lastError: unknown = null;
  for (const baseUrl of validatedUrls) {
    try {
      const eventsByTicker = new Map<string, KalshiRawEvent>();
      const mergedMarkets = new Map<
        string,
        {
          market: KalshiRawMarket;
          event: KalshiRawEvent | null;
          discoverySource: DiscoverySource;
        }
      >();

      let eventPagesFetched = 0;
      let marketPagesFetched = 0;
      let seriesPagesFetched = 0;
      let targetedSeriesEventPagesFetched = 0;
      const resolvedSeriesTickers: string[] = [];

      // 1. Universe sweep phase (skipped when targetedOnly === true)
      if (!targetedOnly) {
        const eventRes = await fetchOpenKalshiEvents(baseUrl, options);
        const marketRes = await fetchOpenKalshiMarkets(baseUrl, options);
        eventPagesFetched = eventRes.pagesFetched;
        marketPagesFetched = marketRes.pagesFetched;

        for (const ev of eventRes.events) {
          eventsByTicker.set(ev.event_ticker, ev);
          if (Array.isArray(ev.markets)) {
            for (const nested of ev.markets) {
              if (nested && typeof nested.ticker === 'string' && nested.ticker.trim().length > 0) {
                const existing = mergedMarkets.get(nested.ticker);
                mergedMarkets.set(nested.ticker, {
                  market: mergeRawMarketRecords(existing?.market, nested, ev),
                  event: ev,
                  discoverySource: 'SWEEP',
                });
              }
            }
          }
        }

        for (const m of marketRes.markets) {
          const parentEvent =
            (typeof m.event_ticker === 'string' ? eventsByTicker.get(m.event_ticker) : undefined) ??
            null;
          const existing = mergedMarkets.get(m.ticker);
          mergedMarkets.set(m.ticker, {
            market: mergeRawMarketRecords(existing?.market, m, parentEvent ?? existing?.event ?? null),
            event: parentEvent ?? existing?.event ?? null,
            discoverySource: 'SWEEP',
          });
        }
      }

      // 2. Targeted series phase (runs whenever targetSeriesPrefixes or targetSeriesTickers is non-empty)
      if (hasTargeting) {
        const seriesSet = new Set<string>();
        const addSeries = (ticker: string) => {
          const normalized = ticker.trim().toUpperCase();
          if (normalized.length > 0 && !seriesSet.has(normalized)) {
            seriesSet.add(normalized);
            resolvedSeriesTickers.push(ticker.trim());
          }
        };

        if (targetSeriesPrefixes.length > 0) {
          const resolved = await resolveSeriesTickersByPrefixes(
            baseUrl,
            targetSeriesPrefixes,
            options
          );
          seriesPagesFetched += resolved.pagesFetched;
          for (const st of resolved.seriesTickers) {
            addSeries(st);
          }
        }

        for (const explicitTicker of explicitSeriesTickers) {
          addSeries(explicitTicker);
        }

        const paceMs = options.rateLimitDelayMs ?? RATE_LIMIT_DELAY_MS;
        for (let idx = 0; idx < resolvedSeriesTickers.length; idx += 1) {
          if (idx > 0 && paceMs > 0) {
            await sleep(paceMs);
          }
          const seriesTicker = resolvedSeriesTickers[idx];
          const seriesEventsRes = await fetchOpenKalshiEventsForSeries(
            baseUrl,
            seriesTicker,
            options
          );
          targetedSeriesEventPagesFetched += seriesEventsRes.pagesFetched;

          for (const ev of seriesEventsRes.events) {
            const existingEv = eventsByTicker.get(ev.event_ticker);
            const mergedEvent: KalshiRawEvent = {
              ...(existingEv ?? {}),
              ...ev,
              series_ticker: ev.series_ticker ?? existingEv?.series_ticker ?? seriesTicker,
              strike_date: ev.strike_date ?? existingEv?.strike_date ?? null,
              settlement_sources: hasNonEmptySettlementSources(ev.settlement_sources)
                ? ev.settlement_sources
                : hasNonEmptySettlementSources(existingEv?.settlement_sources)
                  ? existingEv!.settlement_sources
                  : (ev.settlement_sources ?? existingEv?.settlement_sources ?? null),
            };
            eventsByTicker.set(ev.event_ticker, mergedEvent);

            if (Array.isArray(ev.markets)) {
              for (const nested of ev.markets) {
                if (
                  nested &&
                  typeof nested.ticker === 'string' &&
                  nested.ticker.trim().length > 0
                ) {
                  const existing = mergedMarkets.get(nested.ticker);
                  const nextSource: DiscoverySource =
                    existing?.discoverySource === 'SWEEP' || existing?.discoverySource === 'BOTH'
                      ? 'BOTH'
                      : 'TARGETED';
                  mergedMarkets.set(nested.ticker, {
                    market: mergeRawMarketRecords(existing?.market, nested, mergedEvent),
                    event: mergedEvent,
                    discoverySource: nextSource,
                  });
                }
              }
            }
          }
        }
      }

      return {
        baseUrlUsed: baseUrl,
        events: Array.from(eventsByTicker.values()),
        markets: Array.from(mergedMarkets.values()),
        eventPagesFetched,
        marketPagesFetched,
        seriesPagesFetched,
        targetedSeriesEventPagesFetched,
        resolvedSeriesTickers: Object.freeze(resolvedSeriesTickers),
      };
    } catch (err) {
      if (err instanceof EventEdgePublicClientViolationError) {
        throw err;
      }
      lastError = err;
    }
  }

  throw new Error(
    `Failed to fetch open Kalshi public catalog from all configured base URLs: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}

/**
 * Fetches a single Kalshi market by ticker via the unauthenticated public
 * `GET /markets/{ticker}` endpoint (no auth headers; allowlisted public hosts only).
 * Returns `market: null` if the public endpoint responds with HTTP 404.
 */
export async function fetchPublicKalshiMarketByTicker(
  ticker: string,
  options: KalshiPublicClientOptions = {}
): Promise<{ readonly baseUrlUsed: string; readonly market: KalshiRawMarket | null }> {
  const trimmedTicker = ticker.trim();
  if (!trimmedTicker) {
    throw new EventEdgePublicClientViolationError('Market ticker must be a non-empty string.');
  }

  const candidateUrls =
    options.baseUrls && options.baseUrls.length > 0
      ? options.baseUrls
      : KALSHI_PUBLIC_BASE_URLS;
  const validatedUrls = candidateUrls.map((u) => assertAllowedKalshiPublicBaseUrl(u));
  const safePath = assertPublicMarketDataRequest(
    'GET',
    `/markets/${encodeURIComponent(trimmedTicker)}`
  );
  const fetchImpl = options.fetchFn ?? fetch;
  const paceMs = options.rateLimitDelayMs ?? RATE_LIMIT_DELAY_MS;
  const maxRetries = options.maxRetries429 ?? 5;

  let lastError: unknown = null;
  for (const baseUrl of validatedUrls) {
    try {
      const response = await fetchPublicJsonWithRetry(
        `${baseUrl}${safePath}`,
        fetchImpl,
        paceMs,
        maxRetries
      );
      if (response.status === 404) {
        return Object.freeze({ baseUrlUsed: baseUrl, market: null });
      }
      if (!response.ok) {
        throw new Error(
          `Kalshi public market-data GET ${safePath} failed with HTTP ${response.status}`
        );
      }
      const payload = (await response.json()) as Record<string, unknown> | null;
      let market: KalshiRawMarket | null = null;
      if (payload && typeof payload === 'object') {
        const candidate =
          payload.market && typeof payload.market === 'object'
            ? (payload.market as Record<string, unknown>)
            : payload;
        if (typeof candidate.ticker === 'string' && candidate.ticker.trim().length > 0) {
          market = candidate as KalshiRawMarket;
        }
      }
      return Object.freeze({ baseUrlUsed: baseUrl, market });
    } catch (err) {
      if (err instanceof EventEdgePublicClientViolationError) {
        throw err;
      }
      lastError = err;
    }
  }

  throw new Error(
    `Failed to fetch public Kalshi market "${trimmedTicker}" from all configured base URLs: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}
