import type { KalshiRawEvent, KalshiRawMarket } from '../../discovery/kalshiPublicClient';

/**
 * Fixed reference clock used across EE-01 fixture-based tests so close-horizon checks
 * are 100% deterministic with zero dependency on wall-clock time or live network.
 */
export const FIXTURE_NOW_ISO = '2026-11-26T12:00:00.000Z';
export const FIXTURE_NOW = new Date(FIXTURE_NOW_ISO);

/**
 * Sample Kalshi v2 `/events?status=open&with_nested_markets=true` fixture payload
 * covering:
 * - CLEAR Economics market within 14d horizon (decimal `_dollars` fields)
 * - CLEAR Financials market within 14d horizon (legacy integer cents fields)
 * - Sports market within 14d horizon (must be excluded by default category blocklist)
 * - Entertainment Awards market within 14d horizon (must be excluded by default blocklist)
 * - Climate market 45 days out (must be excluded by default 14-day close horizon)
 * - AMBIGUOUS Tech market within 14d horizon (subjective/discretionary wording)
 */
export const SAMPLE_KALSHI_EVENTS_PAGE_1: {
  events: KalshiRawEvent[];
  cursor: string;
} = {
  events: [
    {
      event_ticker: 'KXCPI-26NOV',
      series_ticker: 'KXCPI',
      title: 'US Consumer Price Index (YoY) for November 2026',
      sub_title: 'Bureau of Labor Statistics CPI-U 12-month release',
      category: 'Economics',
      mutually_exclusive: false,
      settlement_sources: [
        {
          name: 'U.S. Bureau of Labor Statistics',
          url: 'https://www.bls.gov/cpi/',
        },
      ],
      markets: [
        {
          ticker: 'KXCPI-26NOV-T2.8',
          event_ticker: 'KXCPI-26NOV',
          series_ticker: 'KXCPI',
          title: 'Will November 2026 CPI YoY exceed 2.8%?',
          subtitle: 'Above 2.8% YoY CPI-U',
          yes_sub_title: 'Above 2.8%',
          no_sub_title: '2.8% or below',
          status: 'open',
          yes_bid_dollars: '0.42',
          yes_ask_dollars: '0.45',
          no_bid_dollars: '0.55',
          no_ask_dollars: '0.58',
          last_price_dollars: '0.44',
          volume: 14820,
          open_interest: 6340,
          close_time: '2026-12-01T13:25:00.000Z', // +5 days
          expiration_time: '2026-12-01T14:00:00.000Z',
          rules_primary:
            'If the U.S. Bureau of Labor Statistics reports that the 12-month percentage change in the Consumer Price Index for All Urban Consumers (CPI-U) for November 2026 is strictly greater than 2.8%, then the market resolves to Yes. Otherwise, the market resolves to No.',
          rules_secondary:
            'Only the initial official release published on bls.gov is used; subsequent revisions do not alter settlement.',
          settlement_sources: [
            {
              name: 'U.S. Bureau of Labor Statistics',
              url: 'https://www.bls.gov/cpi/',
            },
          ],
        },
      ],
    },
    {
      event_ticker: 'KXFED-26DEC',
      series_ticker: 'KXFED',
      title: 'Federal Reserve Target Rate Decision — December 2026',
      sub_title: 'FOMC Federal Funds Target Range',
      category: 'Financials',
      mutually_exclusive: true,
      markets: [
        {
          ticker: 'KXFED-26DEC-T4.50',
          event_ticker: 'KXFED-26DEC',
          series_ticker: 'KXFED',
          title: 'Will the Fed upper bound be at or below 4.50%?',
          subtitle: 'Fed funds upper bound <= 4.50%',
          status: 'active',
          // Legacy integer-cents format to test normalization into USD [0, 1]
          yes_bid: 61,
          yes_ask: 64,
          no_bid: 36,
          no_ask: 39,
          last_price: 63,
          volume_fp: '9250.0',
          open_interest_fp: '4120.0',
          close_time: '2026-12-06T18:55:00.000Z', // +10 days
          expiration_time: '2026-12-06T19:30:00.000Z',
          rules_primary:
            'If the upper bound of the Federal Reserve target range for the federal funds rate announced at the December 2026 FOMC meeting is at or below 4.50%, then the market resolves to Yes. Otherwise, the market resolves to No.',
          settlement_sources: [
            {
              name: 'Board of Governors of the Federal Reserve System',
              url: 'https://www.federalreserve.gov/monetarypolicy/openmarket.htm',
            },
          ],
        },
      ],
    },
    {
      event_ticker: 'KXNFL-26WK13',
      series_ticker: 'KXNFL',
      title: 'NFL Week 13 Winner',
      sub_title: 'Kansas City vs Buffalo',
      category: 'Sports',
      markets: [
        {
          ticker: 'KXNFL-26WK13-KC',
          event_ticker: 'KXNFL-26WK13',
          subtitle: 'Kansas City wins',
          status: 'open',
          yes_bid_dollars: '0.53',
          yes_ask_dollars: '0.55',
          no_bid_dollars: '0.45',
          no_ask_dollars: '0.47',
          volume: 55000,
          open_interest: 19000,
          close_time: '2026-11-29T21:00:00.000Z', // +3 days (blocked by Sports category)
          expiration_time: '2026-11-30T03:00:00.000Z',
          rules_primary:
            'If the Kansas City Chiefs win the Week 13 game per official NFL box score, the market resolves to Yes. Otherwise, No.',
          settlement_sources: [{ name: 'National Football League', url: 'https://www.nfl.com' }],
        },
      ],
    },
  ],
  cursor: 'events-page-2',
};

export const SAMPLE_KALSHI_EVENTS_PAGE_2: {
  events: KalshiRawEvent[];
  cursor: string;
} = {
  events: [
    {
      event_ticker: 'KXAWARDS-26DEC',
      series_ticker: 'KXAWARDS',
      title: 'Winter Film Critics Best Picture',
      sub_title: 'Annual Critics Awards',
      category: 'Entertainment Awards',
      markets: [
        {
          ticker: 'KXAWARDS-26DEC-BESTPIC',
          event_ticker: 'KXAWARDS-26DEC',
          subtitle: 'Film A wins Best Picture',
          status: 'open',
          yes_bid_dollars: '0.30',
          yes_ask_dollars: '0.34',
          no_bid_dollars: '0.66',
          no_ask_dollars: '0.70',
          volume: 3100,
          open_interest: 1200,
          close_time: '2026-12-03T23:00:00.000Z', // +7 days (blocked by Entertainment Awards)
          expiration_time: '2026-12-04T04:00:00.000Z',
          rules_primary:
            'If Film A is announced as Best Picture by the Academy Awards, the market resolves to Yes. Otherwise, the market resolves to No.',
          settlement_sources: [{ name: 'Academy of Motion Picture Arts and Sciences' }],
        },
      ],
    },
    {
      event_ticker: 'KXCLIMATE-27JAN',
      series_ticker: 'KXCLIMATE',
      title: 'Global Mean Temperature Anomaly January 2027',
      sub_title: 'NOAA Monthly Global Climate Report',
      category: 'Climate and Weather',
      markets: [
        {
          ticker: 'KXCLIMATE-27JAN-T1.5',
          event_ticker: 'KXCLIMATE-27JAN',
          subtitle: 'Above +1.50C anomaly',
          status: 'open',
          yes_bid_dollars: '0.25',
          yes_ask_dollars: '0.29',
          no_bid_dollars: '0.71',
          no_ask_dollars: '0.75',
          volume: 820,
          open_interest: 510,
          close_time: '2027-01-10T18:00:00.000Z', // +45 days (beyond 14d default horizon)
          expiration_time: '2027-01-15T18:00:00.000Z',
          rules_primary:
            'If NOAA National Centers for Environmental Information reports a global temperature anomaly above +1.50C, the market resolves to Yes. Otherwise, the market resolves to No.',
          settlement_sources: [{ name: 'NOAA National Centers for Environmental Information' }],
        },
      ],
    },
    {
      event_ticker: 'KXTECH-26DEC',
      series_ticker: 'KXTECH',
      title: 'Major AI Model Launch Before Dec 10',
      sub_title: 'Product launch criteria',
      category: 'Science and Technology',
      markets: [
        {
          ticker: 'KXTECH-26DEC-MAJOR',
          event_ticker: 'KXTECH-26DEC',
          subtitle: 'Widely considered major announcement',
          status: 'open',
          yes_bid_dollars: '0.48',
          yes_ask_dollars: '0.52',
          no_bid_dollars: '0.48',
          no_ask_dollars: '0.52',
          volume: 1900,
          open_interest: 900,
          close_time: '2026-12-04T20:00:00.000Z', // +8 days (passes discovery filter, fails audit as AMBIGUOUS)
          expiration_time: '2026-12-05T00:00:00.000Z',
          rules_primary:
            'If the company releases what is widely considered a major announcement, the exchange may determine the outcome in its sole discretion.',
          settlement_sources: [{ name: 'Company Newsroom', url: 'https://example.com/news' }],
        },
      ],
    },
  ],
  cursor: '',
};

/**
 * Sample Kalshi v2 `/markets?status=open` standalone fixture payload containing:
 * - AMBIGUOUS Crypto market with conflicting & unofficial sources (passes discovery filter)
 * - AMBIGUOUS Politics market with missing rules text & missing settlement source (passes filter)
 */
export const SAMPLE_KALSHI_STANDALONE_MARKETS: {
  markets: KalshiRawMarket[];
  cursor: string;
} = {
  markets: [
    {
      ticker: 'KXCRYPTO-26NOV-ATH',
      event_ticker: 'KXCRYPTO-26NOV',
      series_ticker: 'KXCRYPTO',
      category: 'Crypto',
      subtitle: 'BTC hits new all-time high',
      status: 'open',
      yes_bid_dollars: '0.35',
      yes_ask_dollars: '0.39',
      no_bid_dollars: '0.61',
      no_ask_dollars: '0.65',
      last_price_dollars: '0.37',
      volume: 6400,
      open_interest: 2800,
      close_time: '2026-11-29T12:00:00.000Z', // +3 days
      expiration_time: '2026-11-29T13:00:00.000Z',
      rules_primary:
        'If Bitcoin trades above $120,000 according to CoinGecko or social media press reports, whichever reports first, then the market resolves to Yes. Otherwise, the market resolves to No.',
      settlement_sources: [
        { name: 'CoinGecko', url: 'https://www.coingecko.com' },
        { name: 'Twitter / X Press Reports', url: 'https://x.com' },
      ],
    },
    {
      ticker: 'KXPOL-26DEC-NORULES',
      event_ticker: 'KXPOL-26DEC',
      series_ticker: 'KXPOL',
      category: 'Politics',
      subtitle: 'Draft market pending rules publication',
      status: 'open',
      yes_bid_dollars: '0.50',
      yes_ask_dollars: '0.54',
      no_bid_dollars: '0.46',
      no_ask_dollars: '0.50',
      volume: 120,
      open_interest: 60,
      close_time: '2026-12-02T12:00:00.000Z', // +6 days
      expiration_time: '2026-12-02T15:00:00.000Z',
      rules_primary: '',
      settlement_sources: [],
    },
  ],
  cursor: '',
};

/**
 * Creates a zero-network fixture `fetch` implementation serving the recorded sample
 * Kalshi v2 public `/events` and `/markets` responses and tracking every requested URL.
 */
export function createFixtureKalshiFetch(options: {
  eventsPage1?: typeof SAMPLE_KALSHI_EVENTS_PAGE_1;
  eventsPage2?: typeof SAMPLE_KALSHI_EVENTS_PAGE_2;
  standaloneMarkets?: typeof SAMPLE_KALSHI_STANDALONE_MARKETS;
} = {}): {
  fetchFn: typeof fetch;
  requestedUrls: string[];
  requestedHeaders: Array<Record<string, string>>;
} {
  const eventsPage1 = options.eventsPage1 ?? SAMPLE_KALSHI_EVENTS_PAGE_1;
  const eventsPage2 = options.eventsPage2 ?? SAMPLE_KALSHI_EVENTS_PAGE_2;
  const standaloneMarkets = options.standaloneMarkets ?? SAMPLE_KALSHI_STANDALONE_MARKETS;

  const requestedUrls: string[] = [];
  const requestedHeaders: Array<Record<string, string>> = [];

  const fetchFn: typeof fetch = async (input, init) => {
    const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    requestedUrls.push(urlStr);

    const hdrs: Record<string, string> = {};
    if (init?.headers && typeof init.headers === 'object' && !Array.isArray(init.headers)) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        hdrs[k.toLowerCase()] = String(v);
      }
    }
    requestedHeaders.push(hdrs);

    const parsed = new URL(urlStr);
    const pathname = parsed.pathname;
    const cursor = parsed.searchParams.get('cursor');

    if (pathname.endsWith('/events')) {
      const payload = cursor === 'events-page-2' ? eventsPage2 : eventsPage1;
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (pathname.endsWith('/markets')) {
      return new Response(JSON.stringify(standaloneMarkets), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ error: `Unexpected fixture path: ${pathname}` }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  };

  return { fetchFn, requestedUrls, requestedHeaders };
}
