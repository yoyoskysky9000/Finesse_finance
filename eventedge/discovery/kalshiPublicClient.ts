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
  rules_primary?: string | null;
  rules_secondary?: string | null;
  settlement_sources?: KalshiSettlementSource[] | null;
  settlement_source?: string | KalshiSettlementSource | null;
  settlement_source_name?: string | null;
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
  settlement_sources?: KalshiSettlementSource[] | null;
  markets?: KalshiRawMarket[];
  [key: string]: unknown;
}

export interface KalshiPublicClientOptions {
  fetchFn?: typeof fetch;
  baseUrls?: readonly string[];
  rateLimitDelayMs?: number;
  maxPagesPerEndpoint?: number;
  pageLimit?: number;
  maxRetries429?: number;
}

export interface KalshiPublicCatalogResult {
  baseUrlUsed: string;
  events: KalshiRawEvent[];
  markets: Array<{
    market: KalshiRawMarket;
    event: KalshiRawEvent | null;
  }>;
  eventPagesFetched: number;
  marketPagesFetched: number;
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
 * Fetches open Kalshi events and open markets via public market-data endpoints,
 * trying the configured public Kalshi base URLs in order and deduplicating markets
 * by ticker while attaching parent event metadata (category, series, settlement sources).
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

  let lastError: unknown = null;
  for (const baseUrl of validatedUrls) {
    try {
      const eventRes = await fetchOpenKalshiEvents(baseUrl, options);
      const marketRes = await fetchOpenKalshiMarkets(baseUrl, options);

      const eventsByTicker = new Map<string, KalshiRawEvent>();
      const mergedMarkets = new Map<
        string,
        { market: KalshiRawMarket; event: KalshiRawEvent | null }
      >();

      for (const ev of eventRes.events) {
        eventsByTicker.set(ev.event_ticker, ev);
        if (Array.isArray(ev.markets)) {
          for (const nested of ev.markets) {
            if (nested && typeof nested.ticker === 'string' && nested.ticker.trim().length > 0) {
              mergedMarkets.set(nested.ticker, {
                market: {
                  ...nested,
                  event_ticker: nested.event_ticker ?? ev.event_ticker,
                  series_ticker: nested.series_ticker ?? ev.series_ticker,
                  category: nested.category ?? ev.category,
                },
                event: ev,
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
        const enrichedMarket: KalshiRawMarket = {
          ...(existing?.market ?? {}),
          ...m,
          event_ticker: m.event_ticker ?? existing?.market.event_ticker ?? parentEvent?.event_ticker,
          series_ticker:
            m.series_ticker ?? existing?.market.series_ticker ?? parentEvent?.series_ticker,
          category: m.category ?? existing?.market.category ?? parentEvent?.category,
          rules_primary: m.rules_primary ?? existing?.market.rules_primary ?? null,
          rules_secondary: m.rules_secondary ?? existing?.market.rules_secondary ?? null,
          settlement_sources:
            m.settlement_sources ??
            existing?.market.settlement_sources ??
            parentEvent?.settlement_sources ??
            null,
        };
        mergedMarkets.set(m.ticker, {
          market: enrichedMarket,
          event: parentEvent ?? existing?.event ?? null,
        });
      }

      return {
        baseUrlUsed: baseUrl,
        events: eventRes.events,
        markets: Array.from(mergedMarkets.values()),
        eventPagesFetched: eventRes.pagesFetched,
        marketPagesFetched: marketRes.pagesFetched,
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
