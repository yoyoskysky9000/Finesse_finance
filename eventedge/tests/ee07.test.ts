/**
 * EventEdge EE-07 Verification Suite
 *
 * Covers the quality-first, strictly read-only research dashboard:
 *  (a) Section order: assembled object section keys & rendered HTML headings appear in exact mandated order
 *      (Research Quality, Execution Realism, Data Quality, Risk, Integrity, Paper PnL (Paper Only)).
 *  (b) Verdict first: gate verdict string appears before the Execution Realism heading (and right after title).
 *  (c) PnL containment: realized paper PnL value appears ONLY after the Paper PnL heading, and the string
 *      "Paper PnL" does not appear in any earlier section.
 *  (d) Number fidelity: dashboard Brier, coverage, fill counts, fees, and PnL exactly match direct EE-04,
 *      EE-05, and EE-06 computations on a known settled + open fixture.
 *  (e) Empty state: experiment with zero settled forecasts renders INSUFFICIENT_DATA with denominator counts
 *      and zero fabricated scores.
 *  (f) Read-only: running buildDashboard twice leaves ALL ledger table row counts completely unchanged.
 *  (g) Integrity section: reports LIVE-disabled assertion as passing and lists trigger checks for EVERY
 *      table in EVENTEDGE_LEDGER_TABLES.
 *  (+) Extra guards: mandatory disclaimer, inline CSS only / zero scripts / zero external assets, HTML
 *      escaping, LIVE mode rejection, and static isolation of eventedge/dashboard/.
 *
 * Run with: npx tsx eventedge/tests/ee07.test.ts
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  DASHBOARD_MANDATORY_DISCLAIMER,
  DASHBOARD_SECTION_HEADINGS,
  DASHBOARD_SECTION_KEYS,
  EVENTEDGE_LEDGER_TABLES,
  EVENTEDGE_MIGRATIONS,
  EventEdgeLiveModeDisabledError,
  buildDashboard,
  buildPortfolioState,
  createEventEdgeConfig,
  evaluateExperiment,
  executeShadowDecision,
  formatCurrency,
  formatScore,
  initializeEventEdgeLedger,
  listShadowFillsForExperiment,
  persistOrderbookState,
  registerDiscoveredContract,
  registerExperiment,
  renderDashboardHtml,
  saveForecast,
  transitionContractLifecycle,
  type EventEdgeConfig,
} from '../index';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  [FAIL] ${name}`);
    console.error(`         ${err instanceof Error ? err.stack || err.message : String(err)}`);
  }
}

function makeTempDb(label: string): { db: DatabaseSync; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `eventedge-ee07-${label}-`));
  const dbPath = path.join(dir, 'ledger.sqlite');
  const { db } = initializeEventEdgeLedger(dbPath);
  return {
    db,
    cleanup: () => {
      try {
        db.close();
      } catch {
        // ignore close error
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function getAllTableRowCounts(db: DatabaseSync): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of EVENTEDGE_LEDGER_TABLES) {
    const row = db.prepare(`SELECT COUNT(*) AS cnt FROM ${table}`).get() as { cnt: number };
    counts[table] = row.cnt;
  }
  return counts;
}

/**
 * Seeds a rich fixture experiment with 12 settled forecasts across 3 event families (so EE-04
 * produces real Brier/log-loss, clustered CI, and calibration), plus shadow fills (FILLED,
 * PARTIAL, NO_FILL/NO_EDGE) and an open position so realized PnL != unrealized PnL != 0.
 */
function seedDashboardFixture(db: DatabaseSync): {
  experimentId: string;
  asOf: string;
  settledCash: number;
  config: EventEdgeConfig;
} {
  const experimentId = 'exp-ee07-quality-01';
  const settledCash = 2000;
  const config = createEventEdgeConfig({ mode: 'PAPER', shadow: { latencyMs: 250 } });
  const asOf = '2026-11-26T18:00:00.000Z';

  registerExperiment(db, {
    experimentId,
    title: 'EE-07 Quality-First Macro Forecast Study',
    hypothesis: 'Price-blind ensemble beats market mid Brier on macro releases.',
    killCriteria: 'Kill if forward Brier fails to beat market or 95% CI upper >= 0 after N=12.',
    sampleDefinition: JSON.stringify({
      eventFamilies: ['KXCPI', 'KXFED', 'KXGDP'],
      minSettledSample: 12,
    }),
    modelVersion: 'ee-ensemble-v1.0.0',
    configHash: 'c'.repeat(64),
    registeredAt: '2026-11-01T00:00:00.000Z',
  });

  const families = ['KXCPI', 'KXFED', 'KXGDP'] as const;

  // Seed 12 settled contracts (4 per family), alternating YES/NO outcomes with strong model signal
  for (let i = 0; i < 12; i += 1) {
    const family = families[i % families.length];
    const marketId = `${family}-26NOV-M${String(i + 1).padStart(2, '0')}`;
    const eventId = `${family}-26NOV-E${String(i + 1).padStart(2, '0')}`;
    const outcomeYes = i % 2 === 0;
    const modelProb = outcomeYes ? 0.82 : 0.18;
    const marketBid = outcomeYes ? 0.54 : 0.44;
    const marketAsk = outcomeYes ? 0.56 : 0.46;

    const baseDay = 2 + i;
    const dayStr = `2026-11-${String(baseDay).padStart(2, '0')}`;
    const forecastTs = `${dayStr}T10:00:00.000Z`;
    const arrivalTs = `${dayStr}T10:00:00.300Z`;
    const resolvedTs = `${dayStr}T16:00:00.000Z`;

    registerDiscoveredContract(db, {
      marketId,
      actor: 'ee07-fixture',
      transitionedAt: `${dayStr}T08:00:00.000Z`,
      reason: 'Discovered',
    });
    transitionContractLifecycle(db, {
      marketId,
      toState: 'AUDIT_PENDING',
      actor: 'ee07-fixture',
      reason: 'Auditing',
      transitionedAt: `${dayStr}T08:05:00.000Z`,
    });
    transitionContractLifecycle(db, {
      marketId,
      toState: 'APPROVED',
      actor: 'ee07-fixture',
      reason: 'CLEAR',
      transitionedAt: `${dayStr}T08:10:00.000Z`,
    });
    transitionContractLifecycle(db, {
      marketId,
      toState: 'ACTIVE',
      actor: 'ee07-fixture',
      reason: 'Active',
      transitionedAt: `${dayStr}T08:15:00.000Z`,
    });

    // Market snapshot <= forecastTs for EE-04 market reference
    db.prepare(
      `INSERT INTO market_snapshots (
        snapshot_id, venue, series_ticker, event_ticker, market_ticker, status,
        yes_bid_usd, yes_ask_usd, last_price_usd, volume, open_interest,
        close_time_utc, expiration_time_utc, raw_payload_json, captured_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      `ms_${marketId}`,
      'KALSHI',
      family,
      eventId,
      marketId,
      'open',
      marketBid,
      marketAsk,
      (marketBid + marketAsk) / 2,
      500,
      200,
      resolvedTs,
      resolvedTs,
      '{}',
      `${dayStr}T09:55:00.000Z`
    );

    saveForecast(db, {
      forecastId: `fc_${marketId}`,
      experimentId,
      marketId,
      eventId,
      eventFamilyId: family,
      eventFamilyDerivationVersion: 'ee-family-prefix-v1',
      forecastStage: 'p_ensemble',
      status: 'FORECAST',
      probability: modelProb,
      uncertaintyInterval: {
        lower: Math.max(0, Number((modelProb - 0.08).toFixed(4))),
        upper: Math.min(1, Number((modelProb + 0.08).toFixed(4))),
        confidenceLevel: 0.9,
        method: 'ee07-fixture',
      },
      extremeProbabilityJustified: false,
      extremeProbabilityJustification: null,
      modelVersion: 'ee-ensemble-v1.0.0',
      configHash: 'c'.repeat(64),
      codeCommitHash: 'ee07testcommit00000000000000000000000000',
      dataSnapshotId: `rs_${marketId}`,
      baseRateVersion: 'ee-base-laplace-v1',
      ensembleVersion: 'ee-ensemble-v1.0.0',
      forecastTimestamp: forecastTs,
      abstentionReasons: [],
      ruleVersionId: null,
      referenceClass: null,
      componentForecastIds: [],
      ensembleMetadata: null,
      featureMetadata: { ensembleVersion: 'ee-ensemble-v1.0.0' },
    });

    // Execute shadow fills on the first 4 settled contracts (mix of FILLED and PARTIAL)
    if (i < 4) {
      persistOrderbookState(db, {
        orderbookStateId: `ob_${marketId}_dec`,
        marketTicker: marketId,
        bestBidUsd: marketBid,
        bestAskUsd: marketAsk,
        yesBidSizeFp: 30,
        yesAskSizeFp: 30,
        capturedAt: forecastTs,
      });
      persistOrderbookState(db, {
        orderbookStateId: `ob_${marketId}_arr`,
        marketTicker: marketId,
        bestBidUsd: outcomeYes ? marketBid + 0.01 : marketBid - 0.01,
        bestAskUsd: outcomeYes ? marketAsk + 0.01 : marketAsk - 0.01, // +0.01 adverse slippage
        yesBidSizeFp: i === 3 ? 6 : 30, // i=3 is BUY_NO partial fill (6 of 10)
        yesAskSizeFp: 30,
        capturedAt: arrivalTs,
      });

      executeShadowDecision(db, {
        experimentId,
        marketId,
        requestedQuantity: 10,
        config,
        decisionTimestamp: forecastTs,
        evaluatedAt: `${dayStr}T10:00:00.500Z`, // bookAgeMs = 200ms
      });
    }

    // Resolve contract
    transitionContractLifecycle(db, {
      marketId,
      toState: 'SETTLEMENT_PENDING',
      actor: 'ee07-fixture',
      reason: 'Closed',
      transitionedAt: resolvedTs,
    });
    transitionContractLifecycle(db, {
      marketId,
      toState: 'RESOLVED',
      actor: 'ee07-fixture',
      reason: `Resolved ${outcomeYes ? 'YES' : 'NO'}`,
      transitionedAt: resolvedTs,
    });
    db.prepare(
      `INSERT INTO settlements (
        settlement_id, venue, event_ticker, market_ticker, rule_version_id,
        outcome, settlement_price_usd, settled_contracts, payout_usd,
        raw_settlement_json, settled_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      `settle_${marketId}`,
      'KALSHI',
      eventId,
      marketId,
      null,
      outcomeYes ? 'YES' : 'NO',
      outcomeYes ? 1.0 : 0.0,
      10,
      outcomeYes ? 10.0 : 0.0,
      '{}',
      resolvedTs
    );
  }

  // Add 1 open position (KXCPI) with unrealized gain and 1 NO_EDGE decision + 1 REJECTED audit market
  const openMarket = 'KXCPI-26DEC-OPEN';
  registerDiscoveredContract(db, {
    marketId: openMarket,
    actor: 'ee07-fixture',
    transitionedAt: '2026-11-26T08:00:00.000Z',
    reason: 'Discovered',
  });
  transitionContractLifecycle(db, {
    marketId: openMarket,
    toState: 'AUDIT_PENDING',
    actor: 'ee07-fixture',
    reason: 'Auditing',
    transitionedAt: '2026-11-26T08:05:00.000Z',
  });
  transitionContractLifecycle(db, {
    marketId: openMarket,
    toState: 'APPROVED',
    actor: 'ee07-fixture',
    reason: 'CLEAR',
    transitionedAt: '2026-11-26T08:10:00.000Z',
  });
  saveForecast(db, {
    forecastId: 'fc_open_1',
    experimentId,
    marketId: openMarket,
    eventId: 'KXCPI-26DEC',
    eventFamilyId: 'KXCPI',
    eventFamilyDerivationVersion: 'ee-family-prefix-v1',
    forecastStage: 'p_ensemble',
    status: 'FORECAST',
    probability: 0.72,
    uncertaintyInterval: { lower: 0.64, upper: 0.80, confidenceLevel: 0.9, method: 'ee07-fixture' },
    extremeProbabilityJustified: false,
    extremeProbabilityJustification: null,
    modelVersion: 'ee-ensemble-v1.0.0',
    configHash: 'c'.repeat(64),
    codeCommitHash: 'ee07testcommit00000000000000000000000000',
    dataSnapshotId: 'rs_open_1',
    baseRateVersion: 'ee-base-laplace-v1',
    ensembleVersion: 'ee-ensemble-v1.0.0',
    forecastTimestamp: '2026-11-26T10:00:00.000Z',
    abstentionReasons: [],
    ruleVersionId: null,
    referenceClass: null,
    componentForecastIds: [],
    ensembleMetadata: null,
    featureMetadata: { ensembleVersion: 'ee-ensemble-v1.0.0' },
  });
  persistOrderbookState(db, {
    orderbookStateId: 'ob_open_dec',
    marketTicker: openMarket,
    bestBidUsd: 0.48,
    bestAskUsd: 0.50,
    yesBidSizeFp: 50,
    yesAskSizeFp: 50,
    capturedAt: '2026-11-26T10:00:00.000Z',
  });
  persistOrderbookState(db, {
    orderbookStateId: 'ob_open_arr',
    marketTicker: openMarket,
    bestBidUsd: 0.48,
    bestAskUsd: 0.50,
    yesBidSizeFp: 50,
    yesAskSizeFp: 50,
    capturedAt: '2026-11-26T10:00:00.300Z',
  });
  executeShadowDecision(db, {
    experimentId,
    marketId: openMarket,
    requestedQuantity: 10,
    config,
    decisionTimestamp: '2026-11-26T10:00:00.000Z',
    evaluatedAt: '2026-11-26T10:00:00.600Z', // bookAgeMs = 300ms
  });
  persistOrderbookState(db, {
    orderbookStateId: 'ob_open_mark',
    marketTicker: openMarket,
    bestBidUsd: 0.58,
    bestAskUsd: 0.60,
    yesBidSizeFp: 50,
    yesAskSizeFp: 50,
    capturedAt: '2026-11-26T15:00:00.000Z',
  });

  // Add 1 NO_EDGE decision on a separate market
  const noEdgeMarket = 'KXFED-26DEC-NOEDGE';
  registerDiscoveredContract(db, {
    marketId: noEdgeMarket,
    actor: 'ee07-fixture',
    transitionedAt: '2026-11-26T09:00:00.000Z',
    reason: 'Discovered',
  });
  transitionContractLifecycle(db, {
    marketId: noEdgeMarket,
    toState: 'AUDIT_PENDING',
    actor: 'ee07-fixture',
    reason: 'Auditing',
    transitionedAt: '2026-11-26T09:05:00.000Z',
  });
  transitionContractLifecycle(db, {
    marketId: noEdgeMarket,
    toState: 'APPROVED',
    actor: 'ee07-fixture',
    reason: 'CLEAR',
    transitionedAt: '2026-11-26T09:10:00.000Z',
  });
  saveForecast(db, {
    forecastId: 'fc_noedge_1',
    experimentId,
    marketId: noEdgeMarket,
    eventId: 'KXFED-26DEC',
    eventFamilyId: 'KXFED',
    eventFamilyDerivationVersion: 'ee-family-prefix-v1',
    forecastStage: 'p_ensemble',
    status: 'FORECAST',
    probability: 0.51,
    uncertaintyInterval: { lower: 0.45, upper: 0.57, confidenceLevel: 0.9, method: 'ee07-fixture' },
    extremeProbabilityJustified: false,
    extremeProbabilityJustification: null,
    modelVersion: 'ee-ensemble-v1.0.0',
    configHash: 'c'.repeat(64),
    codeCommitHash: 'ee07testcommit00000000000000000000000000',
    dataSnapshotId: 'rs_noedge_1',
    baseRateVersion: 'ee-base-laplace-v1',
    ensembleVersion: 'ee-ensemble-v1.0.0',
    forecastTimestamp: '2026-11-26T11:00:00.000Z',
    abstentionReasons: [],
    ruleVersionId: null,
    referenceClass: null,
    componentForecastIds: [],
    ensembleMetadata: null,
    featureMetadata: { ensembleVersion: 'ee-ensemble-v1.0.0' },
  });
  persistOrderbookState(db, {
    orderbookStateId: 'ob_noedge_dec',
    marketTicker: noEdgeMarket,
    bestBidUsd: 0.49,
    bestAskUsd: 0.51,
    yesBidSizeFp: 50,
    yesAskSizeFp: 50,
    capturedAt: '2026-11-26T11:00:00.000Z',
  });
  executeShadowDecision(db, {
    experimentId,
    marketId: noEdgeMarket,
    requestedQuantity: 10,
    config,
    decisionTimestamp: '2026-11-26T11:00:00.000Z',
  });

  // Add 1 audit-rejected market
  const rejectedMarket = 'KXGDP-26DEC-AMBIG';
  registerDiscoveredContract(db, {
    marketId: rejectedMarket,
    actor: 'ee07-fixture',
    transitionedAt: '2026-11-26T09:00:00.000Z',
    reason: 'Discovered',
  });
  transitionContractLifecycle(db, {
    marketId: rejectedMarket,
    toState: 'AUDIT_PENDING',
    actor: 'ee07-fixture',
    reason: 'Auditing',
    transitionedAt: '2026-11-26T09:05:00.000Z',
  });
  transitionContractLifecycle(db, {
    marketId: rejectedMarket,
    toState: 'REJECTED',
    actor: 'ee07-fixture',
    reason: 'AMBIGUOUS_SETTLEMENT_SOURCE',
    transitionedAt: '2026-11-26T09:10:00.000Z',
  });

  return { experimentId, asOf, settledCash, config };
}

console.log('\n=== EventEdge EE-07 Verification Suite ===\n');

// ---------------------------------------------------------------------------
// (a) Section order (assembled keys + rendered HTML headings by index)
// ---------------------------------------------------------------------------
test('(a) Section order: assembled object section keys & rendered HTML headings appear in exact mandated order', () => {
  const { db, cleanup } = makeTempDb('section-order');
  try {
    const { experimentId, asOf, settledCash, config } = seedDashboardFixture(db);
    const dashboard = buildDashboard(db, experimentId, asOf, { settledCash, config });
    const html = renderDashboardHtml(dashboard);

    // Object section keys in exact order
    assert.deepEqual(Object.keys(dashboard.sections), [...DASHBOARD_SECTION_KEYS]);
    assert.deepEqual(
      Object.keys(dashboard).filter((k) =>
        (DASHBOARD_SECTION_KEYS as readonly string[]).includes(k)
      ),
      [...DASHBOARD_SECTION_KEYS]
    );

    // HTML headings in exact order (asserted by index positions)
    const expectedHeadings = [
      DASHBOARD_SECTION_HEADINGS.researchQuality,
      DASHBOARD_SECTION_HEADINGS.executionRealism,
      DASHBOARD_SECTION_HEADINGS.dataQuality,
      DASHBOARD_SECTION_HEADINGS.risk,
      DASHBOARD_SECTION_HEADINGS.integrity,
      DASHBOARD_SECTION_HEADINGS.paperPnl,
    ];

    const indices = expectedHeadings.map((h) => html.indexOf(`<h2>${h}</h2>`));
    for (let i = 0; i < indices.length; i += 1) {
      assert.ok(indices[i] > 0, `Heading "${expectedHeadings[i]}" must be present in rendered HTML`);
      if (i > 0) {
        assert.ok(
          indices[i] > indices[i - 1],
          `Heading "${expectedHeadings[i]}" (idx ${indices[i]}) must appear after "${expectedHeadings[i - 1]}" (idx ${indices[i - 1]})`
        );
      }
    }
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (b) Verdict first
// ---------------------------------------------------------------------------
test('(b) Verdict first: gate verdict is first visible element after title and precedes Execution Realism heading', () => {
  const { db, cleanup } = makeTempDb('verdict-first');
  try {
    const { experimentId, asOf, settledCash, config } = seedDashboardFixture(db);
    const dashboard = buildDashboard(db, experimentId, asOf, { settledCash, config });
    const html = renderDashboardHtml(dashboard);

    const h1End = html.indexOf('</h1>');
    const verdictBannerIdx = html.indexOf('class="verdict-banner');
    const verdictStringIdx = html.indexOf(`>${dashboard.researchQuality.verdict}<`);
    const researchHeadingIdx = html.indexOf(`<h2>${DASHBOARD_SECTION_HEADINGS.researchQuality}</h2>`);
    const execHeadingIdx = html.indexOf(`<h2>${DASHBOARD_SECTION_HEADINGS.executionRealism}</h2>`);

    assert.ok(h1End > 0);
    assert.ok(verdictBannerIdx > h1End, 'Verdict banner must appear after <h1> title');
    assert.ok(verdictStringIdx > h1End, 'Verdict string must appear after <h1> title');
    assert.ok(
      verdictStringIdx < researchHeadingIdx,
      'Gate verdict banner must appear as the first visible element before Research Quality'
    );
    assert.ok(
      verdictStringIdx < execHeadingIdx,
      'Gate verdict string must appear before Execution Realism heading'
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (c) PnL containment
// ---------------------------------------------------------------------------
test('(c) PnL containment: realized paper PnL value and "Paper PnL" string appear ONLY after the Paper PnL heading', () => {
  const { db, cleanup } = makeTempDb('pnl-containment');
  try {
    const { experimentId, asOf, settledCash, config } = seedDashboardFixture(db);
    const dashboard = buildDashboard(db, experimentId, asOf, { settledCash, config });
    const html = renderDashboardHtml(dashboard);

    assert.notEqual(dashboard.paperPnl.realizedPnlUsd, 0, 'Fixture must have non-zero realized PnL');

    const paperPnlHeading = `<h2>${DASHBOARD_SECTION_HEADINGS.paperPnl}</h2>`;
    const paperPnlHeadingIdx = html.indexOf(paperPnlHeading);
    assert.ok(paperPnlHeadingIdx > 0);

    const beforePaperPnl = html.slice(0, paperPnlHeadingIdx);
    const afterPaperPnl = html.slice(paperPnlHeadingIdx);

    const formattedRealizedSigned = formatCurrency(dashboard.paperPnl.realizedPnlUsd, {
      signed: true,
    });
    const formattedRealizedUnsigned = formatCurrency(dashboard.paperPnl.realizedPnlUsd, {
      signed: false,
    });

    // Realized PnL value MUST NOT appear before Paper PnL heading
    assert.equal(
      beforePaperPnl.includes(formattedRealizedSigned),
      false,
      `Realized PnL "${formattedRealizedSigned}" leaked before Paper PnL section`
    );
    assert.equal(
      beforePaperPnl.includes(formattedRealizedUnsigned),
      false,
      `Realized PnL "${formattedRealizedUnsigned}" leaked before Paper PnL section`
    );

    // "paper pnl" phrase MUST NOT appear in any earlier section
    assert.equal(
      /paper\s+pnl/i.test(beforePaperPnl),
      false,
      '"Paper PnL" string must not appear in any section before Paper PnL (Paper Only)'
    );

    // Realized PnL value MUST appear inside the Paper PnL section
    assert.equal(
      afterPaperPnl.includes(formattedRealizedSigned),
      true,
      `Expected realized paper PnL "${formattedRealizedSigned}" inside Paper PnL section`
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (d) Number fidelity against EE-04, EE-05, EE-06 direct calls
// ---------------------------------------------------------------------------
test('(d) Number fidelity: Brier, coverage, fill counts, fees, and PnL exactly match EE-04/EE-05/EE-06 direct outputs', () => {
  const { db, cleanup } = makeTempDb('number-fidelity');
  try {
    const { experimentId, asOf, settledCash, config } = seedDashboardFixture(db);

    const dashboard = buildDashboard(db, experimentId, asOf, { settledCash, config });

    // Direct EE-04 call (read-only)
    const directEval = evaluateExperiment(db, experimentId, {
      persistCalibratedForecasts: false,
    });
    assert.equal(dashboard.researchQuality.verdict, directEval.gate.verdict);
    assert.equal(dashboard.researchQuality.modelBrier, directEval.pooledScoring.model.brierScore);
    assert.equal(
      dashboard.researchQuality.marketBrier,
      directEval.pooledScoring.marketReference.brierScore
    );
    assert.equal(dashboard.researchQuality.modelLogLoss, directEval.pooledScoring.model.logLoss);
    assert.equal(dashboard.researchQuality.coverage, directEval.denominatorTotals.coverage);
    assert.deepEqual(
      dashboard.researchQuality.clusterBootstrapBrierDiff,
      directEval.clusterBootstrapBrierDiff
    );

    // Direct EE-05 ledger inspection
    const directFills = listShadowFillsForExperiment(db, experimentId);
    const expectedFilled = directFills.filter((f) => f.status === 'FILLED').length;
    const expectedPartial = directFills.filter((f) => f.status === 'PARTIAL').length;
    const expectedNoFill = directFills.filter((f) => f.status === 'NO_FILL').length;
    const expectedFees = Number(
      directFills
        .filter((f) => f.status === 'FILLED' || f.status === 'PARTIAL')
        .reduce((acc, f) => acc + f.feeUsd, 0)
        .toFixed(10)
    );

    assert.equal(dashboard.executionRealism.fillsByStatus.FILLED, expectedFilled);
    assert.equal(dashboard.executionRealism.fillsByStatus.PARTIAL, expectedPartial);
    assert.equal(dashboard.executionRealism.fillsByStatus.NO_FILL, expectedNoFill);
    assert.equal(dashboard.executionRealism.noFillReasons.NO_EDGE, 1);
    assert.ok(Math.abs(dashboard.executionRealism.totalFeesPaidUsd - expectedFees) < 1e-9);
    assert.ok(
      dashboard.executionRealism.averageBookAgeMs !== null &&
        dashboard.executionRealism.averageBookAgeMs > 0
    );

    // Direct EE-06 portfolio state call
    const directPortfolio = buildPortfolioState(db, experimentId, asOf, { settledCash, config });
    assert.equal(dashboard.risk.systemState, directPortfolio.systemState);
    assert.equal(dashboard.risk.deployedPct, directPortfolio.deployedPct);
    assert.deepEqual(dashboard.risk.exposureByEventFamily, directPortfolio.exposureByEventFamily);
    assert.equal(dashboard.risk.dailyPnlUsd, directPortfolio.dailyPnl);
    assert.equal(dashboard.risk.drawdownPct, directPortfolio.drawdownPct);
    assert.equal(dashboard.paperPnl.realizedPnlUsd, directPortfolio.realizedPnl);
    assert.equal(dashboard.paperPnl.unrealizedPnlUsd, directPortfolio.unrealizedPnl);

    // Formatted Brier score rendered to 4 decimal places in HTML
    const html = renderDashboardHtml(dashboard);
    assert.ok(html.includes(formatScore(directEval.pooledScoring.model.brierScore)));
    assert.ok(html.includes(formatCurrency(expectedFees)));
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (e) Empty state (no settled forecasts -> INSUFFICIENT_DATA, no fabricated scores)
// ---------------------------------------------------------------------------
test('(e) Empty state: experiment with no settled forecasts reports INSUFFICIENT_DATA and no fabricated scores', () => {
  const { db, cleanup } = makeTempDb('empty-state');
  try {
    const experimentId = 'exp-ee07-empty';
    registerExperiment(db, {
      experimentId,
      title: 'Unsettled Study',
      hypothesis: 'Testing empty-state reporting.',
      killCriteria: 'N >= 20 settled.',
      sampleDefinition: JSON.stringify({ eventFamilies: ['KXCPI'], minSettledSample: 20 }),
      modelVersion: 'ee-ensemble-v1.0.0',
      configHash: 'd'.repeat(64),
      registeredAt: '2026-11-26T00:00:00.000Z',
    });

    // Discover 1 market, no settled forecasts
    registerDiscoveredContract(db, {
      marketId: 'KXCPI-26DEC-UNSETTLED',
      actor: 'ee07-empty',
      transitionedAt: '2026-11-26T01:00:00.000Z',
      reason: 'Discovered',
    });

    const dashboard = buildDashboard(db, experimentId, '2026-11-26T12:00:00.000Z');
    assert.equal(dashboard.researchQuality.status, 'INSUFFICIENT_DATA');
    assert.equal(dashboard.researchQuality.verdict, 'INSUFFICIENT_DATA');
    assert.equal(dashboard.researchQuality.hasSettledScores, false);
    assert.equal(dashboard.researchQuality.modelBrier, null);
    assert.equal(dashboard.researchQuality.marketBrier, null);
    assert.equal(dashboard.researchQuality.modelLogLoss, null);
    assert.equal(dashboard.researchQuality.marketLogLoss, null);
    assert.equal(dashboard.researchQuality.denominatorTotals.discovered, 1);
    assert.equal(dashboard.researchQuality.denominatorTotals.settledScored, 0);

    const html = renderDashboardHtml(dashboard);
    const rqStart = html.indexOf('id="section-research-quality"');
    const rqEnd = html.indexOf('id="section-execution-realism"');
    const rqSlice = html.slice(rqStart, rqEnd);

    assert.ok(rqSlice.includes('INSUFFICIENT_DATA'));
    // Must not fabricate a 0.0000 Brier or log-loss score in the empty Research Quality section
    assert.equal(rqSlice.includes('0.0000'), false, 'Must not present fabricated 0.0000 scores');
    assert.equal(rqSlice.includes('Model Brier'), false);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (f) Read-only: running buildDashboard twice leaves all ledger table row counts unchanged
// ---------------------------------------------------------------------------
test('(f) Read-only: running buildDashboard twice leaves every ledger table row count unchanged', () => {
  const { db, cleanup } = makeTempDb('read-only');
  try {
    const { experimentId, asOf, settledCash, config } = seedDashboardFixture(db);
    const countsBefore = getAllTableRowCounts(db);

    const first = buildDashboard(db, experimentId, asOf, { settledCash, config });
    const countsAfterFirst = getAllTableRowCounts(db);
    assert.deepEqual(countsAfterFirst, countsBefore);

    const second = buildDashboard(db, experimentId, asOf, { settledCash, config });
    const countsAfterSecond = getAllTableRowCounts(db);
    assert.deepEqual(countsAfterSecond, countsBefore);

    // Deterministic output across repeated calls
    assert.deepEqual(first, second);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (g) Integrity section: LIVE-disabled passing & every ledger table trigger check listed
// ---------------------------------------------------------------------------
test('(g) Integrity section: reports LIVE-disabled assertion passing and lists trigger checks for every ledger table', () => {
  const { db, cleanup } = makeTempDb('integrity');
  try {
    const { experimentId, asOf, settledCash, config } = seedDashboardFixture(db);
    const dashboard = buildDashboard(db, experimentId, asOf, { settledCash, config });
    const html = renderDashboardHtml(dashboard);

    assert.equal(dashboard.integrity.liveDisabledAssertion.passed, true);
    assert.equal(dashboard.integrity.allTriggersPresent, true);
    assert.equal(
      dashboard.integrity.migrationVersion,
      EVENTEDGE_MIGRATIONS[EVENTEDGE_MIGRATIONS.length - 1].version
    );
    assert.equal(dashboard.integrity.configHash.length, 64);

    // Every single ledger table in EVENTEDGE_LEDGER_TABLES must be checked and passing
    assert.equal(dashboard.integrity.tableTriggerChecks.length, EVENTEDGE_LEDGER_TABLES.length);
    const checkedNames = dashboard.integrity.tableTriggerChecks.map((c) => c.tableName);
    assert.deepEqual(checkedNames, [...EVENTEDGE_LEDGER_TABLES]);
    for (const check of dashboard.integrity.tableTriggerChecks) {
      assert.equal(check.hasBeforeUpdateAbort, true, `${check.tableName} missing BEFORE UPDATE trigger`);
      assert.equal(check.hasBeforeDeleteAbort, true, `${check.tableName} missing BEFORE DELETE trigger`);
      assert.equal(check.passed, true, `${check.tableName} trigger check failed`);
      assert.ok(html.includes(`>${check.tableName}<`), `HTML missing trigger row for ${check.tableName}`);
    }
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Extra: disclaimer, inline CSS only, zero scripts/external assets, XSS escaping, LIVE lock & isolation
// ---------------------------------------------------------------------------
test('Extra: disclaimer present, zero scripts/external assets, HTML escaped, LIVE rejected, static isolation', () => {
  const { db, cleanup } = makeTempDb('guards');
  try {
    registerExperiment(db, {
      experimentId: 'exp-ee07-xss',
      title: '<script>alert("xss")</script> Macro & CPI',
      hypothesis: 'Test HTML escaping.',
      killCriteria: 'N >= 5',
      sampleDefinition: JSON.stringify({ eventFamilies: ['KXCPI'], minSettledSample: 5 }),
      modelVersion: 'ee-ensemble-v1.0.0',
      configHash: 'e'.repeat(64),
      registeredAt: '2026-11-26T00:00:00.000Z',
    });

    const dashboard = buildDashboard(db, 'exp-ee07-xss', '2026-11-26T12:00:00.000Z');
    const html = renderDashboardHtml(dashboard);

    // Mandatory disclaimer exact match
    assert.ok(html.includes(DASHBOARD_MANDATORY_DISCLAIMER));

    // Self-contained: zero <script> tags, zero <link> tags, zero external http(s) assets
    assert.equal(/<script\b/i.test(html), false, 'HTML must contain zero <script> tags');
    assert.equal(/<link\b/i.test(html), false, 'HTML must contain zero external <link> tags');
    assert.equal(/https?:\/\//i.test(html), false, 'HTML must contain zero external URLs');
    assert.ok(html.includes('<style>'), 'HTML must embed inline CSS');

    // Escaped title (no unescaped script tag)
    assert.ok(html.includes('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'));

    // Forged LIVE config rejected
    const forgedLive = {
      ...createEventEdgeConfig({ mode: 'PAPER' }),
      mode: 'LIVE',
      liveEnabled: true,
    } as unknown as EventEdgeConfig;
    assert.throws(
      () =>
        buildDashboard(db, 'exp-ee07-xss', '2026-11-26T12:00:00.000Z', {
          config: forgedLive,
        }),
      EventEdgeLiveModeDisabledError
    );

    // Static isolation scan on eventedge/dashboard/*
    const dashDir = path.resolve(process.cwd(), 'eventedge', 'dashboard');
    const dashFiles = fs.readdirSync(dashDir).filter((f) => f.endsWith('.ts'));
    assert.ok(dashFiles.length >= 4);
    for (const file of dashFiles) {
      const content = fs.readFileSync(path.join(dashDir, file), 'utf8');
      assert.doesNotMatch(
        content,
        /ExecutionVault|server\.ts|fetch\(|https?:\/\/|KALSHI_API_KEY|KALSHI_PRIVATE_KEY|PUBLIC_API_SECRET/i,
        `eventedge/dashboard/${file} must stay read-only paper-only with zero network/creds/live execution`
      );
    }
  } finally {
    cleanup();
  }
});

console.log(`\n=== EE-07 Summary: ${passed} passed, ${failed} failed ===\n`);
if (failed > 0) {
  process.exit(1);
}
