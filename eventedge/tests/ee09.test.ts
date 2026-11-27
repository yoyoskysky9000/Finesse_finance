import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  EventEdgeLiveModeDisabledError,
  FIRST_EXPERIMENT,
  FIRST_EXPERIMENT_ID,
  KALSHI_PUBLIC_BASE_URLS,
  SECOND_EXPERIMENT,
  SECOND_EXPERIMENT_DISCOVERY_OVERRIDES,
  SECOND_EXPERIMENT_ID,
  computeEventEdgeConfigHash,
  createEventEdgeConfig,
  createSecondExperimentConfig,
  discoverAndScanMarkets,
  evaluateDiscoveryFilter,
  getExperiment,
  getExperimentStatusHistory,
  initializeEventEdgeLedger,
  listExperiments,
  normalizeKalshiMarketToSnapshot,
  parseKalshiEventTickerDate,
  registerFirstExperiment,
  registerSecondExperiment,
  resolveSeriesTickersByPrefixes,
  runPaperCycle,
  transitionExperimentStatus,
  type KalshiRawEvent,
  type KalshiRawMarket,
  type KalshiRawSeries,
} from '../index';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  [FAIL] ${name}`);
    console.error(err);
  }
}

function makeTempDb(label: string): { db: DatabaseSync; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ee09-${label}-`));
  const dbPath = path.join(dir, 'ledger.sqlite');
  const { db } = initializeEventEdgeLedger(dbPath);
  return {
    db,
    cleanup: () => {
      try {
        db.close();
      } catch {
        // ignore
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

interface StubKalshiServerConfig {
  seriesPages?: ReadonlyArray<{ series: KalshiRawSeries[]; cursor?: string }>;
  sweepEvents?: KalshiRawEvent[];
  sweepMarkets?: KalshiRawMarket[];
  eventsBySeries?: Readonly<Record<string, KalshiRawEvent[]>>;
  marketByTicker?: Readonly<Record<string, KalshiRawMarket>>;
  failMarketTickers?: ReadonlySet<string>;
}

function createRecordingKalshiFetch(cfg: StubKalshiServerConfig): {
  fetchFn: typeof fetch;
  calls: string[];
  headersLog: Array<Record<string, string>>;
} {
  const calls: string[] = [];
  const headersLog: Array<Record<string, string>> = [];

  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const urlStr =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(urlStr);

    const hdrs: Record<string, string> = {};
    if (init?.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((v, k) => {
          hdrs[k.toLowerCase()] = v;
        });
      } else if (Array.isArray(init.headers)) {
        for (const [k, v] of init.headers) hdrs[k.toLowerCase()] = v;
      } else {
        for (const [k, v] of Object.entries(init.headers)) hdrs[k.toLowerCase()] = String(v);
      }
    }
    headersLog.push(hdrs);

    const parsed = new URL(urlStr);

    // 1. /series (paginated)
    if (parsed.pathname.endsWith('/series')) {
      const pages = cfg.seriesPages ?? [{ series: [], cursor: '' }];
      const cursor = parsed.searchParams.get('cursor');
      const pageIdx = cursor ? Number(cursor.replace('ser_p', '')) : 0;
      const page = pages[pageIdx] ?? { series: [], cursor: '' };
      return new Response(
        JSON.stringify({ series: page.series, cursor: page.cursor ?? '' }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    // 2. /events (targeted when series_ticker present, sweep otherwise)
    if (parsed.pathname.endsWith('/events')) {
      const seriesTicker = parsed.searchParams.get('series_ticker');
      if (seriesTicker) {
        const events = cfg.eventsBySeries?.[seriesTicker] ?? [];
        return new Response(JSON.stringify({ events, cursor: '' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ events: cfg.sweepEvents ?? [], cursor: '' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    // 3. /markets/{ticker} (single-market enrichment)
    const singleMatch = parsed.pathname.match(/\/markets\/([^/]+)$/);
    if (singleMatch && singleMatch[1]) {
      const ticker = decodeURIComponent(singleMatch[1]);
      if (cfg.failMarketTickers?.has(ticker)) {
        return new Response(JSON.stringify({ error: 'Simulated upstream 500' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        });
      }
      const m = cfg.marketByTicker?.[ticker];
      if (!m) {
        return new Response(JSON.stringify({ error: 'Not found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ market: m }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    // 4. /markets (universe sweep)
    if (parsed.pathname.endsWith('/markets')) {
      return new Response(JSON.stringify({ markets: cfg.sweepMarkets ?? [], cursor: '' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ error: `Unhandled stub path: ${parsed.pathname}` }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  return { fetchFn, calls, headersLog };
}

async function runSuite(): Promise<void> {
  // Hard guard: ZERO live network calls permitted anywhere in EE-09 tests
  const originalGlobalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('LIVE NETWORK FORBIDDEN IN EE-09 TESTS: globalThis.fetch was invoked!');
  }) as typeof fetch;

  console.log('\n=== EventEdge EE-09 Verification Suite ===');

  try {
    // -------------------------------------------------------------------------
    // (a) Prefix resolution selects exact matching series from paginated /series
    //     payload and no others
    // -------------------------------------------------------------------------
    await test('(a) Prefix resolution selects exact matching series from paginated /series payload and no others', async () => {
      const stub = createRecordingKalshiFetch({
        seriesPages: [
          {
            series: [
              { ticker: 'KXEARNINGSMENTIONKR', title: 'Kroger Earnings Mention', category: 'Companies' },
              { ticker: 'KXCPI', title: 'CPI YoY', category: 'Economics' },
              { ticker: 'KXMVECROSSCATEGORY', title: 'Parlay Cross Category', category: 'Sports' },
              { ticker: 'OTHERKXEARNINGSMENTION', title: 'Non-prefix substring trap', category: 'Companies' },
            ],
            cursor: 'ser_p1',
          },
          {
            series: [
              { ticker: 'KXEARNINGSMENTIONAAPL', title: 'Apple Earnings Mention', category: 'Companies' },
              { ticker: 'KXFEDMENTION', title: 'Fed Chair Mention', category: 'Economics' },
              { ticker: 'KXFEDDECISION', title: 'FOMC Rate Decision', category: 'Economics' },
              { ticker: 'KXEARNINGSMENTIONKR', title: 'Duplicate entry on page 2', category: 'Companies' },
            ],
            cursor: '',
          },
        ],
      });

      const resolved = await resolveSeriesTickersByPrefixes(
        KALSHI_PUBLIC_BASE_URLS[0],
        ['KXEARNINGSMENTION', 'KXFEDMENTION'],
        { fetchFn: stub.fetchFn, rateLimitDelayMs: 0 }
      );

      assert.equal(resolved.pagesFetched, 2);
      assert.deepEqual([...resolved.seriesTickers], [
        'KXEARNINGSMENTIONKR',
        'KXEARNINGSMENTIONAAPL',
        'KXFEDMENTION',
      ]);
      // Ensure non-matching series (including substring trap & KXFEDDECISION) are excluded
      assert.equal(resolved.seriesTickers.includes('KXCPI'), false);
      assert.equal(resolved.seriesTickers.includes('KXMVECROSSCATEGORY'), false);
      assert.equal(resolved.seriesTickers.includes('OTHERKXEARNINGSMENTION'), false);
      assert.equal(resolved.seriesTickers.includes('KXFEDDECISION'), false);

      // Verify zero auth headers on public /series requests
      for (const hdrs of stub.headersLog) {
        assert.equal(hdrs['kalshi-access-key'], undefined);
        assert.equal(hdrs['authorization'], undefined);
      }
    });

    // -------------------------------------------------------------------------
    // (b) Targeted fetch merges with sweep and dedupes by market ticker with
    //     provenance recorded (SWEEP | TARGETED | BOTH)
    // -------------------------------------------------------------------------
    await test('(b) Targeted fetch merges with sweep and dedupes by market ticker with SWEEP/TARGETED/BOTH provenance', async () => {
      const { db, cleanup } = makeTempDb('merge-dedupe');
      try {
        const now = new Date('2026-11-27T12:00:00.000Z');
        const sweepOnlyMarket: KalshiRawMarket = {
          ticker: 'KXCPI-26DEC-T2.8',
          event_ticker: 'KXCPI-26DEC',
          series_ticker: 'KXCPI',
          category: 'Economics',
          title: 'CPI above 2.8%',
          status: 'open',
          yes_bid_dollars: '0.45',
          yes_ask_dollars: '0.48',
          close_time: '2026-12-05T13:30:00.000Z',
          expiration_time: '2026-12-05T14:00:00.000Z',
          rules_primary:
            'If the U.S. Bureau of Labor Statistics reports CPI-U > 2.8%, the market resolves to Yes. Otherwise, No.',
          settlement_sources: [{ name: 'U.S. Bureau of Labor Statistics' }],
        };
        const overlapMarket: KalshiRawMarket = {
          ticker: 'KXFEDDECISION-26DEC-CUT25',
          event_ticker: 'KXFEDDECISION-26DEC',
          series_ticker: 'KXFEDDECISION',
          category: 'Economics',
          title: 'FOMC 25bp cut',
          status: 'open',
          yes_bid_dollars: '0.62',
          yes_ask_dollars: '0.65',
          close_time: '2026-12-10T19:00:00.000Z',
          expiration_time: '2026-12-10T20:00:00.000Z',
          rules_primary:
            'If the Board of Governors of the Federal Reserve System cuts the target range by 25 bps, the market resolves to Yes. Otherwise, No.',
          settlement_sources: [{ name: 'Board of Governors of the Federal Reserve System' }],
        };
        const targetedOnlyMarket: KalshiRawMarket = {
          ticker: 'KXEARNINGSMENTIONKR-26DEC03-TARIFF',
          event_ticker: 'KXEARNINGSMENTIONKR-26DEC03',
          series_ticker: 'KXEARNINGSMENTIONKR',
          category: 'Companies',
          title: 'Will Kroger mention tariffs?',
          status: 'open',
          yes_bid_dollars: '0.52',
          yes_ask_dollars: '0.56',
          close_time: '2027-03-31T23:59:00.000Z',
          expiration_time: '2027-03-31T23:59:00.000Z',
          rules_primary:
            'If Kroger mentions tariffs on its Q3 earnings call transcript, the market resolves to Yes. Otherwise, No.',
          settlement_sources: [],
        };

        const stub = createRecordingKalshiFetch({
          seriesPages: [
            {
              series: [
                { ticker: 'KXEARNINGSMENTIONKR', category: 'Companies' },
                { ticker: 'KXCPI', category: 'Economics' },
              ],
            },
          ],
          sweepEvents: [
            {
              event_ticker: 'KXCPI-26DEC',
              series_ticker: 'KXCPI',
              category: 'Economics',
              markets: [sweepOnlyMarket],
            },
            {
              event_ticker: 'KXFEDDECISION-26DEC',
              series_ticker: 'KXFEDDECISION',
              category: 'Economics',
              markets: [overlapMarket],
            },
          ],
          sweepMarkets: [sweepOnlyMarket, overlapMarket],
          eventsBySeries: {
            KXEARNINGSMENTIONKR: [
              {
                event_ticker: 'KXEARNINGSMENTIONKR-26DEC03',
                series_ticker: 'KXEARNINGSMENTIONKR',
                category: 'Companies',
                markets: [targetedOnlyMarket],
              },
            ],
            KXFEDDECISION: [
              {
                event_ticker: 'KXFEDDECISION-26DEC',
                series_ticker: 'KXFEDDECISION',
                category: 'Economics',
                markets: [overlapMarket],
              },
            ],
          },
        });

        const cfg = createEventEdgeConfig(
          {
            mode: 'OBSERVE',
            discovery: {
              targetSeriesPrefixes: ['KXEARNINGSMENTION'],
              targetSeriesTickers: ['KXFEDDECISION'],
              targetedOnly: false,
            },
          },
          {}
        );

        const res = await discoverAndScanMarkets({
          db,
          config: cfg,
          clientOptions: { fetchFn: stub.fetchFn, rateLimitDelayMs: 0 },
          now,
        });

        // Deduplicated to exactly 3 unique markets, all 3 in 14-day horizon
        assert.equal(res.marketsFetched, 3);
        assert.equal(res.scannedSnapshots.length, 3);
        assert.deepEqual([...res.resolvedSeriesTickers], ['KXEARNINGSMENTIONKR', 'KXFEDDECISION']);

        const byTicker = new Map(res.scannedSnapshots.map((s) => [s.marketTicker, s]));
        assert.equal(byTicker.get('KXCPI-26DEC-T2.8')?.discoverySource, 'SWEEP');
        assert.equal(byTicker.get('KXFEDDECISION-26DEC-CUT25')?.discoverySource, 'BOTH');
        assert.equal(byTicker.get('KXEARNINGSMENTIONKR-26DEC03-TARIFF')?.discoverySource, 'TARGETED');

        // Verify persisted provenance columns in SQLite market_snapshots
        const persistedRows = db
          .prepare(
            'SELECT market_ticker, discovery_source, date_source FROM market_snapshots ORDER BY market_ticker ASC'
          )
          .all() as Array<{ market_ticker: string; discovery_source: string; date_source: string }>;
        assert.deepEqual(
          persistedRows.map((r) => [r.market_ticker, r.discovery_source, r.date_source]),
          [
            ['KXCPI-26DEC-T2.8', 'SWEEP', 'CLOSE_TIME'],
            ['KXEARNINGSMENTIONKR-26DEC03-TARIFF', 'TARGETED', 'TICKER_DATE'],
            ['KXFEDDECISION-26DEC-CUT25', 'BOTH', 'CLOSE_TIME'],
          ]
        );
      } finally {
        cleanup();
      }
    });

    // -------------------------------------------------------------------------
    // (c) Kroger event-date horizon fixture passes with date_source TICKER_DATE;
    //     control market with same 2027-03-31 close_time and no override fails
    //     BEYOND_CLOSE_HORIZON; -YYMMM is NOT an override
    // -------------------------------------------------------------------------
    await test('(c) Event-date horizon: Kroger 2027-03-31 market passes with TICKER_DATE; control & -YYMMM fail BEYOND_CLOSE_HORIZON', () => {
      const evalDateMs = Date.parse('2026-11-27T12:00:00.000Z');
      const cfg = createEventEdgeConfig({ discovery: { maxCloseHorizonDays: 14 } }, {});

      // Ticker parser unit checks: -YYMMMDD parses, -YYMMM returns null
      assert.equal(
        parseKalshiEventTickerDate('KXEARNINGSMENTIONKR-26DEC03'),
        '2026-12-03T00:00:00.000Z'
      );
      assert.equal(parseKalshiEventTickerDate('KXFEDMENTION-26DEC'), null);
      assert.equal(parseKalshiEventTickerDate('KXINVALID-26FEB30'), null);

      // 1. Kroger fixture case
      const krogerSnap = normalizeKalshiMarketToSnapshot(
        {
          ticker: 'KXEARNINGSMENTIONKR-26DEC03-INFLATION',
          event_ticker: 'KXEARNINGSMENTIONKR-26DEC03',
          series_ticker: 'KXEARNINGSMENTIONKR',
          category: 'Companies',
          close_time: '2027-03-31T23:59:00.000Z',
          expiration_time: '2027-03-31T23:59:00.000Z',
        },
        null,
        '2026-11-27T12:00:00.000Z',
        { discoverySource: 'TARGETED' }
      );
      assert.equal(krogerSnap.dateSource, 'TICKER_DATE');
      assert.equal(krogerSnap.effectiveEventDateUtc, '2026-12-03T00:00:00.000Z');
      const krogerDecision = evaluateDiscoveryFilter(krogerSnap, cfg.discovery, evalDateMs);
      assert.equal(krogerDecision.included, true);
      assert.equal(krogerDecision.dateSource, 'TICKER_DATE');

      // 2. Control market: same 2027-03-31 close_time, no parseable override -> BEYOND_CLOSE_HORIZON
      const controlSnap = normalizeKalshiMarketToSnapshot(
        {
          ticker: 'KXCONTROL-NOOVERRIDE-YES',
          event_ticker: 'KXCONTROL-NOOVERRIDE',
          category: 'Companies',
          close_time: '2027-03-31T23:59:00.000Z',
          expiration_time: '2027-03-31T23:59:00.000Z',
        },
        null,
        '2026-11-27T12:00:00.000Z'
      );
      assert.equal(controlSnap.dateSource, 'CLOSE_TIME');
      const controlDecision = evaluateDiscoveryFilter(controlSnap, cfg.discovery, evalDateMs);
      assert.equal(controlDecision.included, false);
      assert.equal(controlDecision.reason, 'BEYOND_CLOSE_HORIZON');
      assert.equal(controlDecision.dateSource, 'CLOSE_TIME');

      // 3. Month-only -YYMMM control: treated as NO override -> CLOSE_TIME -> BEYOND_CLOSE_HORIZON
      const monthOnlySnap = normalizeKalshiMarketToSnapshot(
        {
          ticker: 'KXEARNINGS-26DEC-YES',
          event_ticker: 'KXEARNINGS-26DEC',
          category: 'Companies',
          close_time: '2027-03-31T23:59:00.000Z',
          expiration_time: '2027-03-31T23:59:00.000Z',
        },
        null,
        '2026-11-27T12:00:00.000Z'
      );
      assert.equal(monthOnlySnap.dateSource, 'CLOSE_TIME');
      const monthOnlyDecision = evaluateDiscoveryFilter(monthOnlySnap, cfg.discovery, evalDateMs);
      assert.equal(monthOnlyDecision.included, false);
      assert.equal(monthOnlyDecision.reason, 'BEYOND_CLOSE_HORIZON');

      // 4. Earliest among OCCURRENCE, STRIKE_DATE, TICKER_DATE wins, and close_time still governs too-soon
      const earliestSnap = normalizeKalshiMarketToSnapshot(
        {
          ticker: 'KXMULTI-26DEC09-A',
          event_ticker: 'KXMULTI-26DEC09',
          category: 'Economics',
          occurrence_datetime: '2026-12-06T15:00:00.000Z',
          close_time: '2027-03-31T23:59:00.000Z',
        },
        {
          event_ticker: 'KXMULTI-26DEC09',
          strike_date: '2026-12-04T12:00:00.000Z',
        },
        '2026-11-27T12:00:00.000Z'
      );
      assert.equal(earliestSnap.dateSource, 'STRIKE_DATE');
      assert.equal(earliestSnap.effectiveEventDateUtc, '2026-12-04T12:00:00.000Z');
      assert.equal(evaluateDiscoveryFilter(earliestSnap, cfg.discovery, evalDateMs).included, true);

      // Too-soon is still governed by close_time even when ticker date is in horizon
      const closedSnap = normalizeKalshiMarketToSnapshot(
        {
          ticker: 'KXEARNINGSMENTIONKR-26DEC03-CLOSED',
          event_ticker: 'KXEARNINGSMENTIONKR-26DEC03',
          category: 'Companies',
          close_time: '2026-11-27T11:00:00.000Z',
        },
        null,
        '2026-11-27T12:00:00.000Z'
      );
      const closedDecision = evaluateDiscoveryFilter(closedSnap, cfg.discovery, evalDateMs);
      assert.equal(closedDecision.included, false);
      assert.equal(closedDecision.reason, 'ALREADY_CLOSED_OR_TOO_SOON');
    });

    // -------------------------------------------------------------------------
    // (d) targetedOnly mode performs NO universe sweep fetch
    // -------------------------------------------------------------------------
    await test('(d) targetedOnly mode performs no universe sweep fetch (asserted via fetch stub call log)', async () => {
      const { db, cleanup } = makeTempDb('targeted-only');
      try {
        const stub = createRecordingKalshiFetch({
          seriesPages: [
            {
              series: [
                { ticker: 'KXEARNINGSMENTIONKR', category: 'Companies' },
                { ticker: 'KXFEDMENTION', category: 'Economics' },
                { ticker: 'KXMVECROSSCATEGORY', category: 'Sports' },
              ],
            },
          ],
          eventsBySeries: {
            KXEARNINGSMENTIONKR: [
              {
                event_ticker: 'KXEARNINGSMENTIONKR-26DEC03',
                series_ticker: 'KXEARNINGSMENTIONKR',
                category: 'Companies',
                markets: [
                  {
                    ticker: 'KXEARNINGSMENTIONKR-26DEC03-MARGIN',
                    event_ticker: 'KXEARNINGSMENTIONKR-26DEC03',
                    series_ticker: 'KXEARNINGSMENTIONKR',
                    category: 'Companies',
                    status: 'open',
                    yes_bid_dollars: '0.40',
                    yes_ask_dollars: '0.44',
                    close_time: '2027-03-31T23:59:00.000Z',
                    rules_primary:
                      'If Kroger mentions gross margin on its official Q3 transcript, the market resolves to Yes. Otherwise, No.',
                    settlement_sources: [{ name: 'Kroger Investor Relations Official Transcript' }],
                  },
                ],
              },
            ],
            KXFEDMENTION: [],
            KXFEDDECISION: [],
          },
        });

        const cfg = createSecondExperimentConfig({ mode: 'OBSERVE', env: {} });
        assert.equal(cfg.discovery.targetedOnly, true);

        const res = await discoverAndScanMarkets({
          db,
          config: cfg,
          clientOptions: { fetchFn: stub.fetchFn, rateLimitDelayMs: 0 },
          now: new Date('2026-11-27T12:00:00.000Z'),
        });

        assert.equal(res.marketsFetched, 1);
        assert.equal(res.scannedSnapshots.length, 1);
        assert.equal(res.scannedSnapshots[0].discoverySource, 'TARGETED');

        // Inspect every single requested URL in the stub call log
        const parsedCalls = stub.calls.map((u) => new URL(u));
        const sweepEventCalls = parsedCalls.filter(
          (u) => u.pathname.endsWith('/events') && !u.searchParams.has('series_ticker')
        );
        const sweepMarketCalls = parsedCalls.filter((u) => u.pathname.endsWith('/markets'));
        const seriesCalls = parsedCalls.filter((u) => u.pathname.endsWith('/series'));
        const targetedEventCalls = parsedCalls.filter(
          (u) => u.pathname.endsWith('/events') && u.searchParams.has('series_ticker')
        );

        assert.equal(sweepEventCalls.length, 0, 'targetedOnly must NOT call universe /events sweep');
        assert.equal(sweepMarketCalls.length, 0, 'targetedOnly must NOT call universe /markets sweep');
        assert.equal(seriesCalls.length, 1, 'targetedOnly should resolve prefixes via /series');
        assert.deepEqual(
          targetedEventCalls.map((u) => u.searchParams.get('series_ticker')),
          ['KXEARNINGSMENTIONKR', 'KXFEDMENTION', 'KXFEDDECISION']
        );
      } finally {
        cleanup();
      }
    });

    // -------------------------------------------------------------------------
    // (e) Enrichment:
    //     1) targeted market with empty settlement_sources is enriched from
    //        single-market fixture before audit and becomes APPROVED
    //     2) enrichment failure is recorded (ENRICHMENT_FAILED) and non-fatal
    //     3) fixture mode performs NO enrichment fetch
    // -------------------------------------------------------------------------
    await test('(e) Enrichment: targeted market enriched pre-audit, failure recorded non-fatally, fixture mode performs zero enrichment fetches', async () => {
      const asOf = '2026-11-27T12:00:00.000Z';

      // Part 1 & 2: Non-fixture runner with stubbed clientOptions (one succeeds enrichment, one fails HTTP 500)
      const { db, cleanup } = makeTempDb('enrichment');
      try {
        const cfg = createSecondExperimentConfig({ mode: 'OBSERVE', env: {} });
        registerSecondExperiment(db, { config: cfg, registeredAt: '2026-11-27T00:00:00.000Z' });

        const okTicker = 'KXEARNINGSMENTIONKR-26DEC03-TARIFF';
        const failTicker = 'KXEARNINGSMENTIONKR-26DEC03-FAILSRC';

        const unenrichedOk: KalshiRawMarket = {
          ticker: okTicker,
          event_ticker: 'KXEARNINGSMENTIONKR-26DEC03',
          series_ticker: 'KXEARNINGSMENTIONKR',
          category: 'Companies',
          title: 'Will Kroger mention tariffs?',
          status: 'open',
          yes_bid_dollars: '0.45',
          yes_ask_dollars: '0.49',
          close_time: '2027-03-31T23:59:00.000Z',
          expiration_time: '2027-03-31T23:59:00.000Z',
          rules_primary:
            'If Kroger mentions the word tariff during its official Q3 earnings call, the market resolves to Yes. Otherwise, the market resolves to No.',
          rules_secondary: 'Exact word forms count per official transcript.',
          settlement_sources: [],
        };

        const unenrichedFail: KalshiRawMarket = {
          ticker: failTicker,
          event_ticker: 'KXEARNINGSMENTIONKR-26DEC03',
          series_ticker: 'KXEARNINGSMENTIONKR',
          category: 'Companies',
          title: 'Will Kroger mention shrinkage?',
          status: 'open',
          yes_bid_dollars: '0.50',
          yes_ask_dollars: '0.54',
          close_time: '2027-03-31T23:59:00.000Z',
          expiration_time: '2027-03-31T23:59:00.000Z',
          rules_primary:
            'If Kroger mentions the word shrinkage during its official Q3 earnings call, the market resolves to Yes. Otherwise, the market resolves to No.',
          settlement_sources: [],
        };

        const stub = createRecordingKalshiFetch({
          seriesPages: [{ series: [{ ticker: 'KXEARNINGSMENTIONKR', category: 'Companies' }] }],
          eventsBySeries: {
            KXEARNINGSMENTIONKR: [
              {
                event_ticker: 'KXEARNINGSMENTIONKR-26DEC03',
                series_ticker: 'KXEARNINGSMENTIONKR',
                category: 'Companies',
                settlement_sources: [],
                markets: [unenrichedOk, unenrichedFail],
              },
            ],
            KXFEDDECISION: [],
          },
          marketByTicker: {
            [okTicker]: {
              ...unenrichedOk,
              settlement_sources: [
                {
                  name: 'FactSet Official Earnings Call Transcript',
                  url: 'https://www.factset.com/',
                },
              ],
            },
          },
          failMarketTickers: new Set([failTicker]),
        });

        const cycle = await runPaperCycle(db, {
          experimentId: SECOND_EXPERIMENT_ID,
          mode: 'OBSERVE',
          asOf,
          config: cfg,
          clientOptions: {
            baseUrls: ['https://api.elections.kalshi.com/trade-api/v2'],
            fetchFn: stub.fetchFn,
            rateLimitDelayMs: 0,
          },
        });

        // Cycle completed non-fatally; okTicker enriched -> APPROVED & forecasted; failTicker -> ENRICHMENT_FAILED + AUDIT_REJECTED
        assert.equal(cycle.counts.discoveredFetched, 2);
        assert.equal(cycle.counts.scanned, 2);
        assert.equal(cycle.counts.approvedCount, 1);
        assert.equal(cycle.counts.rejectedCount, 1);

        const okOutcome = cycle.marketOutcomes.find((m) => m.marketId === okTicker);
        assert.ok(okOutcome);
        assert.equal(okOutcome.enriched, true);
        assert.equal(okOutcome.enrichmentError, null);
        assert.equal(okOutcome.discoverySource, 'TARGETED');
        assert.equal(okOutcome.dateSource, 'TICKER_DATE');
        assert.notEqual(okOutcome.status, 'AUDIT_REJECTED');

        const failOutcome = cycle.marketOutcomes.find((m) => m.marketId === failTicker);
        assert.ok(failOutcome);
        assert.equal(failOutcome.enriched, false);
        assert.equal(failOutcome.status, 'AUDIT_REJECTED');
        assert.equal(failOutcome.reasonCodes.includes('ENRICHMENT_FAILED'), true);
        assert.equal(failOutcome.reasonCodes.includes('MISSING_SETTLEMENT_SOURCE'), true);
        assert.ok(
          typeof failOutcome.enrichmentError === 'string' && failOutcome.enrichmentError.length > 0
        );

        assert.equal(cycle.enrichmentFailures.length, 1);
        assert.equal(cycle.enrichmentFailures[0].marketId, failTicker);
        assert.equal(cycle.enrichmentFailures[0].code, 'ENRICHMENT_FAILED');
        assert.ok(cycle.enrichmentFailures[0].error.includes('500'));

        // Verify /markets/{ticker} was called once for each unenriched targeted market
        const singleMarketCalls = stub.calls.filter((u) =>
          /\/markets\/[^/?]+$/.test(new URL(u).pathname)
        );
        assert.equal(singleMarketCalls.length, 2);
        const calledTickers = singleMarketCalls.map((u) =>
          decodeURIComponent(new URL(u).pathname.split('/').pop() ?? '')
        );
        assert.deepEqual(calledTickers.sort(), [failTicker, okTicker].sort());
      } finally {
        cleanup();
      }

      // Part 3: Fixture mode performs ZERO enrichment fetches even when settlement_sources is empty
      const { db: fixDb, cleanup: fixCleanup } = makeTempDb('enrichment-fixture-no-fetch');
      try {
        const cfg = createSecondExperimentConfig({ mode: 'OBSERVE', env: {} });
        registerSecondExperiment(fixDb, { config: cfg, registeredAt: '2026-11-27T00:00:00.000Z' });

        const stubFixture = createRecordingKalshiFetch({
          seriesPages: [{ series: [{ ticker: 'KXEARNINGSMENTIONKR', category: 'Companies' }] }],
          eventsBySeries: {
            KXEARNINGSMENTIONKR: [
              {
                event_ticker: 'KXEARNINGSMENTIONKR-26DEC03',
                series_ticker: 'KXEARNINGSMENTIONKR',
                category: 'Companies',
                markets: [
                  {
                    ticker: 'KXEARNINGSMENTIONKR-26DEC03-EMPTY',
                    event_ticker: 'KXEARNINGSMENTIONKR-26DEC03',
                    series_ticker: 'KXEARNINGSMENTIONKR',
                    category: 'Companies',
                    status: 'open',
                    yes_bid_dollars: '0.45',
                    yes_ask_dollars: '0.48',
                    close_time: '2027-03-31T23:59:00.000Z',
                    rules_primary:
                      'If Kroger mentions tariffs on its Q3 call, the market resolves to Yes. Otherwise, No.',
                    settlement_sources: [],
                  },
                  {
                    ticker: 'KXEARNINGSMENTIONKR-26DEC03-DIRECT',
                    event_ticker: 'KXEARNINGSMENTIONKR-26DEC03',
                    series_ticker: 'KXEARNINGSMENTIONKR',
                    category: 'Companies',
                    status: 'open',
                    yes_bid_dollars: '0.45',
                    yes_ask_dollars: '0.48',
                    close_time: '2027-03-31T23:59:00.000Z',
                    rules_primary:
                      'If Kroger mentions AI on its Q3 call, the market resolves to Yes. Otherwise, No.',
                    settlement_sources: [{ name: 'FactSet Official Earnings Call Transcript' }],
                  },
                ],
              },
            ],
            KXFEDDECISION: [],
          },
        });

        const fixCycle = await runPaperCycle(fixDb, {
          experimentId: SECOND_EXPERIMENT_ID,
          mode: 'OBSERVE',
          asOf,
          config: cfg,
          fixtures: {
            fetchFn: stubFixture.fetchFn,
          },
        });

        assert.equal(fixCycle.usedFixtures, true);
        // Zero /markets/{ticker} enrichment calls occurred in fixture mode
        const singleMarketCalls = stubFixture.calls.filter((u) =>
          /\/markets\/[^/?]+$/.test(new URL(u).pathname)
        );
        assert.equal(
          singleMarketCalls.length,
          0,
          'Fixture mode must perform zero single-market enrichment fetches'
        );
        assert.equal(fixCycle.enrichmentFailures.length, 0);
        // Direct enriched fixture audited APPROVED while empty fixture audited REJECTED
        assert.equal(fixCycle.counts.approvedCount, 1);
        assert.equal(fixCycle.counts.rejectedCount, 1);
      } finally {
        fixCleanup();
      }
    });

    // -------------------------------------------------------------------------
    // (f) SECOND_EXPERIMENT constant carries exact experiment_id, identical
    //     hypothesis & kill_criteria as FIRST_EXPERIMENT, exact void_reason,
    //     and frozen targeted discovery config
    // -------------------------------------------------------------------------
    await test('(f) SECOND_EXPERIMENT matches exact spec, shares identical hypothesis & kill_criteria with FIRST_EXPERIMENT, and includes void_reason', () => {
      assert.equal(SECOND_EXPERIMENT_ID, 'EE-V1-BASERATE-02');
      assert.equal(SECOND_EXPERIMENT.experiment_id, 'EE-V1-BASERATE-02');
      assert.equal(SECOND_EXPERIMENT.experimentId, 'EE-V1-BASERATE-02');
      assert.equal(
        SECOND_EXPERIMENT.title,
        'EventEdge v1 — reference base-rate ensemble vs market (frozen, targeted discovery)'
      );
      assert.equal(SECOND_EXPERIMENT.hypothesis, FIRST_EXPERIMENT.hypothesis);
      assert.equal(SECOND_EXPERIMENT.kill_criteria, FIRST_EXPERIMENT.kill_criteria);
      assert.equal(SECOND_EXPERIMENT.killCriteria, FIRST_EXPERIMENT.killCriteria);
      assert.equal(
        SECOND_EXPERIMENT.sample_definition,
        'All markets in the targeted families — series resolved from the prefixes KXEARNINGSMENTION and KXFEDMENTION, plus the series KXFEDDECISION — that reach APPROVED and settle during the window, with the horizon applied to the event date. The frozen sample closes at the first of: 100 settled forecasted markets, or 90 days from the RUNNING transition. The denominator includes discovered, audit-rejected, and abstained markets in the targeted families.'
      );
      assert.equal(SECOND_EXPERIMENT.supersedes, FIRST_EXPERIMENT_ID);
      assert.equal(SECOND_EXPERIMENT.void_reason.includes('Zero forecasts, zero settlements'), true);
      assert.equal(
        SECOND_EXPERIMENT.void_reason,
        'EE-V1-BASERATE-01 was voided on 2026-11-27 before any forecast was written: its universe-sweep discovery audited 3,732 markets of which 3,731 were KXMVE cross-category parlays, and the targeted families never reached audit because earnings-mention markets carry a 2027 administrative close_time that defeated the close-time horizon. Zero forecasts, zero settlements, no data contaminated.'
      );
      assert.equal(SECOND_EXPERIMENT.initialStatus, 'REGISTERED');

      // Frozen -02 config assertions
      assert.equal(SECOND_EXPERIMENT_DISCOVERY_OVERRIDES.targetedOnly, true);
      assert.deepEqual([...SECOND_EXPERIMENT_DISCOVERY_OVERRIDES.targetSeriesPrefixes], [
        'KXEARNINGSMENTION',
        'KXFEDMENTION',
      ]);
      assert.deepEqual([...SECOND_EXPERIMENT_DISCOVERY_OVERRIDES.targetSeriesTickers], [
        'KXFEDDECISION',
      ]);

      const cfg02 = createSecondExperimentConfig({ env: {} });
      assert.equal(cfg02.liveEnabled, false);
      assert.equal(cfg02.discovery.targetedOnly, true);
      assert.deepEqual([...cfg02.discovery.targetSeriesPrefixes], [
        'KXEARNINGSMENTION',
        'KXFEDMENTION',
      ]);
      assert.deepEqual([...cfg02.discovery.targetSeriesTickers], ['KXFEDDECISION']);

      // LIVE remains hard-disabled
      assert.throws(
        () => createSecondExperimentConfig({ mode: 'LIVE', env: {} }),
        EventEdgeLiveModeDisabledError
      );
    });

    // -------------------------------------------------------------------------
    // (g) Registering -02 twice is idempotent and does not alter -01 when both exist
    // -------------------------------------------------------------------------
    await test('(g) Registering -02 twice is idempotent and does not alter -01 record when both exist', () => {
      const { db, cleanup } = makeTempDb('register-idempotent');
      try {
        // Seed -01 and transition it to RUNNING to mirror production state
        const cfg01 = createEventEdgeConfig({ mode: 'OBSERVE' }, {});
        registerFirstExperiment(db, {
          config: cfg01,
          registeredAt: '2026-11-27T11:48:19.367Z',
        });
        transitionExperimentStatus(db, {
          experimentId: FIRST_EXPERIMENT_ID,
          toStatus: 'RUNNING',
          reason: 'Baseline -01 started',
          changedAt: '2026-11-27T11:48:19.368Z',
        });

        const exp01Before = getExperiment(db, FIRST_EXPERIMENT_ID);
        const hist01Before = getExperimentStatusHistory(db, FIRST_EXPERIMENT_ID);
        assert.ok(exp01Before);

        // Register -02 twice
        const cfg02 = createSecondExperimentConfig({ mode: 'OBSERVE', env: {} });
        const reg1 = registerSecondExperiment(db, {
          config: cfg02,
          registeredAt: '2026-11-27T12:30:00.000Z',
        });
        const reg2 = registerSecondExperiment(db, {
          config: cfg02,
          registeredAt: '2026-11-27T12:45:00.000Z',
        });

        assert.deepEqual(reg1, reg2);
        assert.equal(reg1.experimentId, SECOND_EXPERIMENT_ID);
        assert.equal(reg1.status, 'REGISTERED');
        assert.equal(reg1.supersedes, FIRST_EXPERIMENT_ID);
        assert.equal(reg1.voidReason, SECOND_EXPERIMENT.voidReason);
        assert.equal(reg1.configHash, computeEventEdgeConfigHash(cfg02));
        assert.notEqual(reg1.configHash, exp01Before.configHash);

        // Exactly 2 rows in registry (-01 and -02)
        const all = listExperiments(db);
        assert.equal(all.length, 2);
        assert.deepEqual(
          all.map((e) => e.experimentId),
          [FIRST_EXPERIMENT_ID, SECOND_EXPERIMENT_ID]
        );

        // -01 record and status history must be byte-for-byte unaltered
        const exp01After = getExperiment(db, FIRST_EXPERIMENT_ID);
        const hist01After = getExperimentStatusHistory(db, FIRST_EXPERIMENT_ID);
        assert.deepEqual(exp01After, exp01Before);
        assert.deepEqual(hist01After, hist01Before);

        // Immutability triggers still forbid raw UPDATE on supersedes or void_reason
        assert.throws(
          () =>
            db
              .prepare("UPDATE experiments SET void_reason = 'tampered' WHERE experiment_id = ?")
              .run(SECOND_EXPERIMENT_ID),
          /immutable: UPDATE forbidden/i
        );
        assert.throws(
          () =>
            db
              .prepare("UPDATE experiments SET supersedes = NULL WHERE experiment_id = ?")
              .run(SECOND_EXPERIMENT_ID),
          /immutable: UPDATE forbidden/i
        );
      } finally {
        cleanup();
      }
    });
  } finally {
    globalThis.fetch = originalGlobalFetch;
  }

  console.log(`\n=== EE-09 Summary: ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) {
    process.exit(1);
  }
}

runSuite().catch((err) => {
  console.error('Fatal error in EE-09 test suite:', err);
  process.exit(1);
});
