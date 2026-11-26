import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  EVENTEDGE_DEFAULT_DISCOVERY_CONFIG,
  EventEdgeConfigValidationError,
  EventEdgeLiveModeDisabledError,
  EventEdgePublicClientViolationError,
  assertAllowedKalshiPublicBaseUrl,
  assertPublicMarketDataRequest,
  auditContractResolution,
  auditDiscoveredMarkets,
  computeRuleTextHash,
  createEventEdgeConfig,
  discoverAndScanMarkets,
  initializeEventEdgeLedger,
  listSettlementRuleVersionsForMarket,
  normalizeKalshiMarketToSnapshot,
  persistSettlementRuleVersion,
  runObserveCycle,
  scanMarkets,
} from '../index';
import {
  FIXTURE_NOW,
  SAMPLE_KALSHI_EVENTS_PAGE_1,
  createFixtureKalshiFetch,
} from './fixtures/kalshiPayloads';

async function runEe01Tests(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eventedge-ee01-'));

  // Hard guard ensuring NO live network requests happen anywhere during EE-01 tests
  const originalGlobalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('LIVE NETWORK FORBIDDEN IN EE-01 TESTS: globalThis.fetch was invoked!');
  }) as typeof fetch;

  try {
    // -------------------------------------------------------------------------
    // (a) Market Discovery normalizes sample payload into market_snapshots rows
    //     with all required fields, timestamped per fetch, and config-driven filters
    // -------------------------------------------------------------------------
    const defaultCfg = createEventEdgeConfig(
      { ledgerDbPath: path.join(tempDir, 'ee01_discovery.sqlite') },
      {}
    );
    assert.equal(defaultCfg.mode, 'OBSERVE');
    assert.equal(defaultCfg.liveEnabled, false);
    assert.equal(defaultCfg.discovery.maxCloseHorizonDays, 14);
    assert.deepEqual(
      [...defaultCfg.discovery.excludedCategories],
      ['sports', 'entertainment awards']
    );
    assert.deepEqual(defaultCfg.discovery, EVENTEDGE_DEFAULT_DISCOVERY_CONFIG);

    // Public client strictly blocks authenticated/trading endpoints, non-GET, and untrusted hosts
    assert.throws(
      () => assertPublicMarketDataRequest('POST', '/portfolio/orders'),
      EventEdgePublicClientViolationError
    );
    assert.throws(
      () => assertPublicMarketDataRequest('GET', '/portfolio/balance'),
      EventEdgePublicClientViolationError
    );
    assert.throws(
      () => assertAllowedKalshiPublicBaseUrl('http://127.0.0.1:3000/trade-api/v2'),
      EventEdgePublicClientViolationError
    );
    assert.throws(
      () => assertAllowedKalshiPublicBaseUrl('https://evil.example.com/trade-api/v2'),
      EventEdgePublicClientViolationError
    );

    const { db: discDb } = initializeEventEdgeLedger(defaultCfg.ledgerDbPath);
    try {
      const fixture1 = createFixtureKalshiFetch();
      const firstPass = await discoverAndScanMarkets({
        db: discDb,
        config: defaultCfg,
        clientOptions: { fetchFn: fixture1.fetchFn, rateLimitDelayMs: 0 },
        now: FIXTURE_NOW,
      });

      assert.equal(firstPass.eventsFetched, 6);
      assert.equal(firstPass.marketsFetched, 8);
      assert.equal(firstPass.snapshotsPersisted, 8);

      // Verify zero auth headers were sent and only public /events and /markets were called
      assert.equal(fixture1.requestedUrls.length, 3); // 2 event pages + 1 markets page
      for (const hdrs of fixture1.requestedHeaders) {
        assert.equal(hdrs['kalshi-access-key'], undefined);
        assert.equal(hdrs['kalshi-access-signature'], undefined);
        assert.equal(hdrs['authorization'], undefined);
      }

      // Verify normalized fields persisted into market_snapshots for decimal & cents markets
      const cpiRow = discDb
        .prepare(
          `SELECT
            snapshot_id, market_ticker, event_ticker, category, market_terms,
            yes_bid_usd, yes_ask_usd, no_bid_usd, no_ask_usd,
            volume, open_interest, close_time_utc, expiration_time_utc,
            settlement_source_name, captured_at
          FROM market_snapshots
          WHERE market_ticker = ?`
        )
        .get('KXCPI-26NOV-T2.8') as Record<string, unknown>;

      assert.ok(cpiRow, 'Expected KXCPI-26NOV-T2.8 row in market_snapshots');
      assert.equal(cpiRow.market_ticker, 'KXCPI-26NOV-T2.8');
      assert.equal(cpiRow.event_ticker, 'KXCPI-26NOV');
      assert.equal(cpiRow.category, 'Economics');
      assert.equal(cpiRow.market_terms, 'Above 2.8% YoY CPI-U');
      assert.equal(cpiRow.yes_bid_usd, 0.42);
      assert.equal(cpiRow.yes_ask_usd, 0.45);
      assert.equal(cpiRow.no_bid_usd, 0.55);
      assert.equal(cpiRow.no_ask_usd, 0.58);
      assert.equal(cpiRow.volume, 14820);
      assert.equal(cpiRow.open_interest, 6340);
      assert.equal(cpiRow.close_time_utc, '2026-12-01T13:25:00.000Z');
      assert.equal(cpiRow.expiration_time_utc, '2026-12-01T14:00:00.000Z');
      assert.equal(cpiRow.settlement_source_name, 'U.S. Bureau of Labor Statistics');
      assert.equal(cpiRow.captured_at, FIXTURE_NOW.toISOString());

      // Verify legacy integer-cents payload normalized accurately to USD [0, 1]
      const fedRow = discDb
        .prepare(
          `SELECT yes_bid_usd, yes_ask_usd, no_bid_usd, no_ask_usd, volume, open_interest, settlement_source_name
           FROM market_snapshots WHERE market_ticker = ?`
        )
        .get('KXFED-26DEC-T4.50') as Record<string, unknown>;

      assert.equal(fedRow.yes_bid_usd, 0.61);
      assert.equal(fedRow.yes_ask_usd, 0.64);
      assert.equal(fedRow.no_bid_usd, 0.36);
      assert.equal(fedRow.no_ask_usd, 0.39);
      assert.equal(fedRow.volume, 9250);
      assert.equal(fedRow.open_interest, 4120);
      assert.equal(
        fedRow.settlement_source_name,
        'Board of Governors of the Federal Reserve System'
      );

      // Verify default filter excluded Sports, Entertainment Awards, and >14d Climate market
      const scannedTickers = firstPass.scannedSnapshots.map((s) => s.marketTicker).sort();
      assert.deepEqual(scannedTickers, [
        'KXCPI-26NOV-T2.8',
        'KXCRYPTO-26NOV-ATH',
        'KXFED-26DEC-T4.50',
        'KXPOL-26DEC-NORULES',
        'KXTECH-26DEC-MAJOR',
      ]);

      const excludedByTicker = new Map(
        firstPass.excludedMarkets.map((e) => [e.snapshot.marketTicker, e.reason])
      );
      assert.equal(excludedByTicker.get('KXNFL-26WK13-KC'), 'CATEGORY_BLOCKLISTED');
      assert.equal(excludedByTicker.get('KXAWARDS-26DEC-BESTPIC'), 'CATEGORY_BLOCKLISTED');
      assert.equal(excludedByTicker.get('KXCLIMATE-27JAN-T1.5'), 'BEYOND_CLOSE_HORIZON');

      // Verify filter behavior is driven by config (not hardcoded)
      const widerCfg = createEventEdgeConfig(
        {
          discovery: {
            maxCloseHorizonDays: 60,
            excludedCategories: [],
          },
        },
        {}
      );
      const widerScan = scanMarkets(
        firstPass.allSnapshots,
        widerCfg.discovery,
        FIXTURE_NOW.getTime()
      );
      assert.equal(widerScan.matched.length, 8);
      assert.equal(widerScan.excluded.length, 0);

      // Verify second fetch inserts a NEW timestamped snapshot row (never overwrites)
      const laterNow = new Date(FIXTURE_NOW.getTime() + 60_000);
      const fixture2 = createFixtureKalshiFetch();
      await discoverAndScanMarkets({
        db: discDb,
        config: defaultCfg,
        clientOptions: { fetchFn: fixture2.fetchFn, rateLimitDelayMs: 0 },
        now: laterNow,
      });

      const cpiSnapshotCount = discDb
        .prepare('SELECT COUNT(*) AS cnt FROM market_snapshots WHERE market_ticker = ?')
        .get('KXCPI-26NOV-T2.8') as { cnt: number };
      assert.equal(Number(cpiSnapshotCount.cnt), 2);
    } finally {
      discDb.close();
    }

    console.log(
      'PASS [EE-01 (a)]: Market discovery normalizes Kalshi public payloads into timestamped market_snapshots rows and applies config-driven filters.'
    );

    // -------------------------------------------------------------------------
    // (b) Contract Resolution Auditor classifies CLEAR fixture as CLEAR and
    //     multiple AMBIGUOUS fixtures as AMBIGUOUS with machine-readable reasons
    // -------------------------------------------------------------------------
    const { db: auditDb } = initializeEventEdgeLedger(':memory:');
    try {
      const fixture = createFixtureKalshiFetch();
      const disc = await discoverAndScanMarkets({
        db: auditDb,
        config: defaultCfg,
        clientOptions: { fetchFn: fixture.fetchFn, rateLimitDelayMs: 0 },
        now: FIXTURE_NOW,
      });

      const batch = auditDiscoveredMarkets(auditDb, disc.scannedSnapshots, FIXTURE_NOW.toISOString());

      // Only the 2 CLEAR markets flow downstream
      assert.deepEqual(
        batch.clearMarkets.map((m) => m.snapshot.marketTicker).sort(),
        ['KXCPI-26NOV-T2.8', 'KXFED-26DEC-T4.50']
      );
      for (const clearEntry of batch.clearMarkets) {
        assert.equal(clearEntry.audit.status, 'CLEAR');
        assert.equal(clearEntry.audit.eligibleForDownstream, true);
        assert.deepEqual([...clearEntry.audit.reasons], []);
        assert.equal(clearEntry.ruleVersion.auditStatus, 'CLEAR');
      }

      // All 3 AMBIGUOUS markets are persisted with machine-readable reasons & excluded downstream
      assert.deepEqual(
        batch.ambiguousMarkets.map((m) => m.snapshot.marketTicker).sort(),
        ['KXCRYPTO-26NOV-ATH', 'KXPOL-26DEC-NORULES', 'KXTECH-26DEC-MAJOR']
      );

      const ambByTicker = new Map(
        batch.ambiguousMarkets.map((m) => [m.snapshot.marketTicker, m])
      );

      // Ambiguous fixture 1: Missing rules & missing settlement source
      const noRules = ambByTicker.get('KXPOL-26DEC-NORULES')!;
      assert.equal(noRules.audit.status, 'AMBIGUOUS');
      assert.equal(noRules.audit.eligibleForDownstream, false);
      assert.equal(noRules.audit.reasonCodes.includes('MISSING_RULES_TEXT'), true);
      assert.equal(noRules.audit.reasonCodes.includes('MISSING_SETTLEMENT_SOURCE'), true);
      assert.equal(noRules.ruleVersion.auditStatus, 'AMBIGUOUS');
      assert.ok(noRules.ruleVersion.ambiguityReasons.length >= 2);

      // Ambiguous fixture 2: Multiple conflicting sources & unofficial source (Twitter/X)
      const conflicting = ambByTicker.get('KXCRYPTO-26NOV-ATH')!;
      assert.equal(conflicting.audit.status, 'AMBIGUOUS');
      assert.equal(conflicting.audit.eligibleForDownstream, false);
      assert.equal(conflicting.audit.reasonCodes.includes('MULTIPLE_CONFLICTING_SOURCES'), true);
      assert.equal(conflicting.audit.reasonCodes.includes('UNOFFICIAL_OR_UNVERIFIED_SOURCE'), true);

      // Ambiguous fixture 3: Subjective/discretionary wording & missing clear YES/NO condition
      const subjective = ambByTicker.get('KXTECH-26DEC-MAJOR')!;
      assert.equal(subjective.audit.status, 'AMBIGUOUS');
      assert.equal(subjective.audit.eligibleForDownstream, false);
      assert.equal(
        subjective.audit.reasonCodes.includes('SUBJECTIVE_OR_DISCRETIONARY_WORDING'),
        true
      );
      assert.equal(
        subjective.audit.reasonCodes.includes('MISSING_UNAMBIGUOUS_YES_NO_CONDITION'),
        true
      );

      // Verify AMBIGUOUS markets are stored in settlement_rule_versions with reasons JSON
      const persistedAmbiguousCount = auditDb
        .prepare(
          "SELECT COUNT(*) AS cnt FROM settlement_rule_versions WHERE audit_status = 'AMBIGUOUS'"
        )
        .get() as { cnt: number };
      assert.equal(Number(persistedAmbiguousCount.cnt), 3);

      // -----------------------------------------------------------------------
      // (c) Rules-text change produces a NEW rule-version row and leaves old row untouched
      // -----------------------------------------------------------------------
      const cpiEvent = SAMPLE_KALSHI_EVENTS_PAGE_1.events[0];
      const cpiMarketV1 = cpiEvent.markets![0];
      const versionsBefore = listSettlementRuleVersionsForMarket(auditDb, 'KXCPI-26NOV-T2.8');
      assert.equal(versionsBefore.length, 1);
      const originalRow = versionsBefore[0];
      assert.equal(originalRow.versionNumber, 1);
      assert.equal(
        originalRow.ruleHash,
        computeRuleTextHash(cpiMarketV1.rules_primary!, cpiMarketV1.rules_secondary ?? null)
      );

      // Re-auditing identical rules text must NOT create a duplicate version
      const sameSnap = normalizeKalshiMarketToSnapshot(
        cpiMarketV1,
        cpiEvent,
        '2026-11-26T12:15:00.000Z'
      );
      const sameAudit = auditContractResolution(sameSnap, '2026-11-26T12:15:00.000Z');
      const samePersist = persistSettlementRuleVersion(auditDb, sameAudit);
      assert.equal(samePersist.isNewVersion, false);
      assert.equal(samePersist.record.ruleVersionId, originalRow.ruleVersionId);
      assert.equal(listSettlementRuleVersionsForMarket(auditDb, 'KXCPI-26NOV-T2.8').length, 1);

      // Changing the rules text must create version 2 while leaving version 1 completely untouched
      const updatedRulesText =
        'If the U.S. Bureau of Labor Statistics reports that the 12-month percentage change in CPI-U for November 2026 is strictly greater than 2.9% (amended threshold), then the market resolves to Yes. Otherwise, the market resolves to No.';
      const cpiMarketV2 = {
        ...cpiMarketV1,
        rules_primary: updatedRulesText,
      };
      const changedSnap = normalizeKalshiMarketToSnapshot(
        cpiMarketV2,
        cpiEvent,
        '2026-11-26T12:30:00.000Z'
      );
      const changedAudit = auditContractResolution(changedSnap, '2026-11-26T12:30:00.000Z');
      const changedPersist = persistSettlementRuleVersion(auditDb, changedAudit);

      assert.equal(changedPersist.isNewVersion, true);
      assert.equal(changedPersist.record.versionNumber, 2);
      assert.notEqual(changedPersist.record.ruleVersionId, originalRow.ruleVersionId);
      assert.notEqual(changedPersist.record.ruleHash, originalRow.ruleHash);

      const versionsAfter = listSettlementRuleVersionsForMarket(auditDb, 'KXCPI-26NOV-T2.8');
      assert.equal(versionsAfter.length, 2);

      // Old row must be byte-for-byte untouched
      assert.deepEqual(versionsAfter[0], originalRow);
      assert.equal(versionsAfter[1].versionNumber, 2);
      assert.equal(versionsAfter[1].rulesPrimary, updatedRulesText);
      assert.equal(versionsAfter[1].auditStatus, 'CLEAR');

      // Database immutability trigger still forbids UPDATE on settlement_rule_versions
      assert.throws(
        () =>
          auditDb
            .prepare("UPDATE settlement_rule_versions SET rules_primary = 'tampered' WHERE rule_version_id = ?")
            .run(originalRow.ruleVersionId),
        /immutable: UPDATE forbidden/i
      );
    } finally {
      auditDb.close();
    }

    console.log(
      'PASS [EE-01 (b)]: Contract Resolution Auditor classifies CLEAR & 3 distinct AMBIGUOUS fixtures with machine-readable reasons.'
    );
    console.log(
      'PASS [EE-01 (c)]: Rules-text hash change creates a new version_number=2 row while leaving version_number=1 untouched.'
    );

    // -------------------------------------------------------------------------
    // (d) OBSERVE runner writes summary without calling any execution component
    //     named in REUSE_MAP.md
    // -------------------------------------------------------------------------
    const observeDbPath = path.join(tempDir, 'ee01_observe.sqlite');
    const summaryPath = path.join(tempDir, 'observe_summary.json');
    const fixtureObs = createFixtureKalshiFetch();

    // Non-OBSERVE modes must be rejected by the OBSERVE runner, and LIVE must raise LiveModeDisabledError
    await assert.rejects(
      () =>
        runObserveCycle({
          configInput: { mode: 'LIVE', ledgerDbPath: observeDbPath },
          env: {},
          clientOptions: { fetchFn: fixtureObs.fetchFn, rateLimitDelayMs: 0 },
        }),
      EventEdgeLiveModeDisabledError
    );

    await assert.rejects(
      () =>
        runObserveCycle({
          configInput: { mode: 'PAPER', ledgerDbPath: observeDbPath },
          env: {},
          clientOptions: { fetchFn: fixtureObs.fetchFn, rateLimitDelayMs: 0 },
        }),
      EventEdgeConfigValidationError
    );

    // Path traversal on summaryOutputPath must be rejected when summaryBaseDir is set
    await assert.rejects(
      () =>
        runObserveCycle({
          configInput: { ledgerDbPath: observeDbPath },
          env: {},
          clientOptions: { fetchFn: fixtureObs.fetchFn, rateLimitDelayMs: 0 },
          summaryOutputPath: path.join(tempDir, '..', 'escape.json'),
          summaryBaseDir: tempDir,
          now: FIXTURE_NOW,
        }),
      EventEdgeConfigValidationError
    );

    const obsResult = await runObserveCycle({
      configInput: { ledgerDbPath: observeDbPath },
      env: {},
      clientOptions: { fetchFn: fixtureObs.fetchFn, rateLimitDelayMs: 0 },
      now: FIXTURE_NOW,
      summaryOutputPath: summaryPath,
      summaryBaseDir: tempDir,
    });

    assert.equal(obsResult.summary.mode, 'OBSERVE');
    assert.equal(obsResult.summary.eventsFetched, 6);
    assert.equal(obsResult.summary.marketsFetched, 8);
    assert.equal(obsResult.summary.marketsFilteredOut, 3);
    assert.equal(obsResult.summary.marketsScanned, 5);
    assert.equal(obsResult.summary.clearCount, 2);
    assert.equal(obsResult.summary.ambiguousCount, 3);
    assert.equal(obsResult.summary.newRuleVersionsCount, 5);
    assert.deepEqual([...obsResult.summary.clearTickers].sort(), [
      'KXCPI-26NOV-T2.8',
      'KXFED-26DEC-T4.50',
    ]);
    assert.ok(
      obsResult.summary.topAmbiguityReasons.length >= 4,
      'Expected top ambiguity reasons populated in OBSERVE summary'
    );

    // Verify summary JSON file was written cleanly
    assert.equal(obsResult.summaryFilePath, path.resolve(summaryPath));
    const parsedSummaryFile = JSON.parse(fs.readFileSync(summaryPath, 'utf-8'));
    assert.equal(parsedSummaryFile.runId, obsResult.summary.runId);
    assert.equal(parsedSummaryFile.marketsScanned, 5);
    assert.equal(parsedSummaryFile.clearCount, 2);
    assert.equal(parsedSummaryFile.ambiguousCount, 3);

    // Verify immutable ledger state: observe_run_summaries populated, ZERO forecasts/orders
    const { db: verifyDb } = initializeEventEdgeLedger(observeDbPath);
    try {
      const runRow = verifyDb
        .prepare('SELECT run_id, mode, markets_scanned, clear_count, ambiguous_count FROM observe_run_summaries WHERE run_id = ?')
        .get(obsResult.summary.runId) as Record<string, unknown>;
      assert.equal(runRow.mode, 'OBSERVE');
      assert.equal(runRow.markets_scanned, 5);
      assert.equal(runRow.clear_count, 2);
      assert.equal(runRow.ambiguous_count, 3);

      // Verify observe_run_summaries is immutable
      assert.throws(
        () =>
          verifyDb
            .prepare('DELETE FROM observe_run_summaries WHERE run_id = ?')
            .run(obsResult.summary.runId),
        /immutable: DELETE forbidden/i
      );

      // Verify zero forecasts, probability estimates, trade decisions, or orders were created
      for (const emptyTable of [
        'agent_forecasts',
        'final_probability_estimates',
        'trade_decisions',
        'submitted_orders',
        'actual_fills',
      ]) {
        const countRow = verifyDb
          .prepare(`SELECT COUNT(*) AS cnt FROM ${emptyTable}`)
          .get() as { cnt: number };
        assert.equal(
          Number(countRow.cnt),
          0,
          `OBSERVE runner must not write any rows to ${emptyTable}`
        );
      }
    } finally {
      verifyDb.close();
    }

    // Static isolation audit: verify EE-01 runtime modules NEVER import or invoke any
    // execution component named in REUSE_MAP.md
    const ee01SourceFiles = [
      path.resolve('eventedge/discovery/kalshiPublicClient.ts'),
      path.resolve('eventedge/discovery/index.ts'),
      path.resolve('eventedge/resolution/auditor.ts'),
      path.resolve('eventedge/resolution/index.ts'),
      path.resolve('eventedge/runner/observeRunner.ts'),
      path.resolve('eventedge/runner/index.ts'),
    ];
    const forbiddenExecutionImportPatterns: ReadonlyArray<{ label: string; regex: RegExp }> = [
      { label: 'ExecutionVault import', regex: /from\s+['"][^'"]*ExecutionVault[^'"]*['"]/ },
      { label: 'riskGuard import', regex: /from\s+['"][^'"]*riskGuard[^'"]*['"]/ },
      {
        label: 'PortfolioCorrelationGuard import',
        regex: /from\s+['"][^'"]*PortfolioCorrelationGuard[^'"]*['"]/,
      },
      { label: 'server.ts import', regex: /from\s+['"][^'"]*server(?:\.ts)?['"]/ },
      { label: 'mcp_server invocation', regex: /mcp_server\.py/ },
      { label: 'child_process import', regex: /from\s+['"](?:node:)?child_process['"]/ },
      { label: 'submitKalshiV2EventsOrder call', regex: /\bsubmitKalshiV2EventsOrder\s*\(/ },
      { label: 'executeEntryWithPortfolioGuard call', regex: /\bexecuteEntryWithPortfolioGuard\s*\(/ },
      { label: 'unwindPositionSafely call', regex: /\bunwindPositionSafely\s*\(/ },
    ];

    for (const filePath of ee01SourceFiles) {
      const rawSrc = fs.readFileSync(filePath, 'utf-8');
      const codeOnly = rawSrc
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      for (const check of forbiddenExecutionImportPatterns) {
        assert.equal(
          check.regex.test(codeOnly),
          false,
          `EE-01 module ${path.basename(filePath)} must not reference execution component (${check.label})`
        );
      }
    }

    console.log(
      'PASS [EE-01 (d)]: OBSERVE runner writes immutable ledger + JSON summary with zero forecasts, zero orders, and zero execution-component calls.'
    );
    console.log('\nALL EVENTEDGE EE-01 TESTS PASSED.');
  } finally {
    globalThis.fetch = originalGlobalFetch;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

runEe01Tests().catch((err) => {
  console.error('EVENTEDGE EE-01 TEST FAILURE:', err);
  process.exitCode = 1;
});
