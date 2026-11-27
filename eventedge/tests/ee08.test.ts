import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  EventEdgeLiveModeDisabledError,
  FIRST_EXPERIMENT,
  FIRST_EXPERIMENT_ID,
  FrozenConfigMismatchError,
  PaperRunnerModeError,
  computeEventEdgeConfigHash,
  createEventEdgeConfig,
  evaluateExperiment,
  getContractLifecycleHistory,
  getContractLifecycleState,
  getForecastsForExperiment,
  initializeEventEdgeLedger,
  listExperiments,
  listShadowDecisionsForExperiment,
  registerExperiment,
  registerFirstExperiment,
  runPaperCycle,
  type EventEdgeConfig,
  type KalshiRawEvent,
  type KalshiRawMarket,
  type PaperCycleFixtures,
  type ReferenceClass,
  type ResearchDataSnapshot,
} from '../index';
import { FIXTURE_NOW_ISO } from './fixtures/kalshiPayloads';

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ee08-${label}-`));
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

function makeClearMarket(params: {
  ticker: string;
  eventTicker: string;
  seriesTicker: string;
  category: string;
  title: string;
  yesBid: number;
  yesAsk: number;
  closeTime: string;
  expirationTime: string;
  status?: string;
  result?: string | null;
  settlementTs?: string | null;
}): KalshiRawMarket {
  const noBid = Number((1 - params.yesAsk).toFixed(2));
  const noAsk = Number((1 - params.yesBid).toFixed(2));
  return {
    ticker: params.ticker,
    event_ticker: params.eventTicker,
    series_ticker: params.seriesTicker,
    category: params.category,
    title: params.title,
    subtitle: params.title,
    status: params.status ?? 'open',
    yes_bid_dollars: params.yesBid.toFixed(2),
    yes_ask_dollars: params.yesAsk.toFixed(2),
    no_bid_dollars: noBid.toFixed(2),
    no_ask_dollars: noAsk.toFixed(2),
    last_price_dollars: ((params.yesBid + params.yesAsk) / 2).toFixed(2),
    volume: 10_000,
    open_interest: 4_000,
    close_time: params.closeTime,
    expiration_time: params.expirationTime,
    rules_primary: `If the U.S. Bureau of Labor Statistics official release for ${params.ticker} exceeds the published threshold, then the market resolves to Yes. Otherwise, the market resolves to No.`,
    rules_secondary:
      'Only the initial official publication on bls.gov is used; subsequent revisions do not alter settlement.',
    settlement_sources: [
      {
        name: 'U.S. Bureau of Labor Statistics',
        url: 'https://www.bls.gov/cpi/',
      },
    ],
    ...(params.result !== undefined ? { result: params.result } : {}),
    ...(params.settlementTs !== undefined ? { settlement_ts: params.settlementTs } : {}),
  };
}

function makeRefClass(positiveCount: number, sampleCount: number): ReferenceClass {
  return {
    definition: 'Historical macro threshold outcomes',
    inclusionCriteria: 'Monthly official BLS/FOMC releases',
    sampleCount,
    positiveCount,
    timeWindow: '2020-01-01..2026-10-31',
    source: 'ee08_fixture_reference_class',
  };
}

function makeResearchSnap(id: string, capturedAt: string, daysToClose: number): ResearchDataSnapshot {
  return {
    dataSnapshotId: id,
    capturedAt,
    source: 'ee08_fixture_price_blind',
    features: {
      days_to_close: daysToClose,
    },
  };
}

async function runSuite(): Promise<void> {
  // Hard guard: ZERO live network calls permitted anywhere in EE-08 tests
  const originalGlobalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('LIVE NETWORK FORBIDDEN IN EE-08 TESTS: globalThis.fetch was invoked!');
  }) as typeof fetch;

  console.log('\n=== EventEdge EE-08 Verification Suite ===');

  try {
    // -------------------------------------------------------------------------
    // (a) End-to-end fixture cycle
    // -------------------------------------------------------------------------
    await test('(a) End-to-end fixture cycle: discovery -> audit -> forecasts -> risk -> shadow decisions -> INSUFFICIENT_DATA dashboard', async () => {
      const { db, cleanup } = makeTempDb('e2e-cycle');
      try {
        const config = createEventEdgeConfig({ mode: 'PAPER' }, {});
        const exp = registerFirstExperiment(db, {
          config,
          registeredAt: '2026-11-26T00:00:00.000Z',
        });

        const cycle = await runPaperCycle(db, {
          experimentId: exp.experimentId,
          mode: 'PAPER',
          asOf: FIXTURE_NOW_ISO,
          config,
          settledCash: 10_000,
          fixtures: true,
        });

        assert.equal(cycle.usedFixtures, true);
        assert.equal(cycle.mode, 'PAPER');
        assert.equal(cycle.experimentId, FIRST_EXPERIMENT_ID);
        assert.equal(cycle.configHash, exp.configHash);

        // Discovery & audit counts from EE-01 fixtures:
        // 8 fetched, 3 filtered out, 5 scanned -> 2 APPROVED, 3 REJECTED
        assert.equal(cycle.counts.discoveredFetched, 8);
        assert.equal(cycle.counts.discoveryFilteredOut, 3);
        assert.equal(cycle.counts.scanned, 5);
        assert.equal(cycle.counts.newlyRegisteredDiscovered, 5);
        assert.equal(cycle.counts.auditedCount, 5);
        assert.equal(cycle.counts.approvedCount, 2);
        assert.equal(cycle.counts.rejectedCount, 3);
        assert.equal(cycle.counts.forecastedCount, 2);
        assert.equal(cycle.counts.riskEvaluatedCount, 2);
        assert.equal(cycle.counts.riskApprovedCount, 2);
        assert.equal(cycle.counts.shadowDecisionsCreated, 2);

        // Verify exact lifecycle transitions for APPROVED market (DISCOVERED -> AUDIT_PENDING -> APPROVED -> ACTIVE)
        const cpiHistory = getContractLifecycleHistory(db, 'KXCPI-26NOV-T2.8').map((h) => h.toState);
        assert.deepEqual(cpiHistory, ['DISCOVERED', 'AUDIT_PENDING', 'APPROVED', 'ACTIVE']);

        const fedHistory = getContractLifecycleHistory(db, 'KXFED-26DEC-T4.50').map((h) => h.toState);
        assert.deepEqual(fedHistory, ['DISCOVERED', 'AUDIT_PENDING', 'APPROVED', 'ACTIVE']);

        // Verify exact lifecycle transitions for REJECTED markets (DISCOVERED -> AUDIT_PENDING -> REJECTED)
        for (const rejectedTicker of [
          'KXTECH-26DEC-MAJOR',
          'KXCRYPTO-26NOV-ATH',
          'KXPOL-26DEC-NORULES',
        ]) {
          const hist = getContractLifecycleHistory(db, rejectedTicker).map((h) => h.toState);
          assert.deepEqual(hist, ['DISCOVERED', 'AUDIT_PENDING', 'REJECTED']);
        }

        // Forecasts persisted via EE-03 for approved markets (3 stages each: p_base, p_quant, p_ensemble)
        const persistedForecasts = getForecastsForExperiment(db, exp.experimentId);
        assert.equal(persistedForecasts.length, 6);
        const stagesByMarket = new Map<string, string[]>();
        for (const f of persistedForecasts) {
          const list = stagesByMarket.get(f.marketId) ?? [];
          list.push(f.forecastStage);
          stagesByMarket.set(f.marketId, list);
        }
        assert.deepEqual(stagesByMarket.get('KXCPI-26NOV-T2.8')?.sort(), [
          'p_base',
          'p_ensemble',
          'p_quant',
        ]);
        assert.deepEqual(stagesByMarket.get('KXFED-26DEC-T4.50')?.sort(), [
          'p_base',
          'p_ensemble',
          'p_quant',
        ]);

        // Shadow decisions persisted via EE-05 for risk-approved markets
        const shadowDecisions = listShadowDecisionsForExperiment(db, exp.experimentId);
        assert.equal(shadowDecisions.length, 2);
        assert.deepEqual(
          shadowDecisions.map((d) => d.marketId).sort(),
          ['KXCPI-26NOV-T2.8', 'KXFED-26DEC-T4.50']
        );

        // Risk-rejected / zero-quantity case: tiny bankroll forces quantity 0 -> explicit reason codes recorded
        const lowBankrollDb = makeTempDb('low-bankroll');
        try {
          const exp2 = registerFirstExperiment(lowBankrollDb.db, {
            config,
            registeredAt: '2026-11-26T00:00:00.000Z',
          });
          const tinyCycle = await runPaperCycle(lowBankrollDb.db, {
            experimentId: exp2.experimentId,
            mode: 'PAPER',
            asOf: FIXTURE_NOW_ISO,
            config,
            settledCash: 5, // $5 * 0.5% = $0.025 < 1 contract cost -> EVENT_RISK_CAP / qty=0
            fixtures: true,
          });
          assert.equal(tinyCycle.counts.riskRejectedCount, 2);
          assert.equal(tinyCycle.counts.shadowDecisionsCreated, 0);
          for (const ticker of ['KXCPI-26NOV-T2.8', 'KXFED-26DEC-T4.50']) {
            const outcome = tinyCycle.marketOutcomes.find((m) => m.marketId === ticker);
            assert.ok(outcome);
            assert.equal(outcome.status, 'RISK_REJECTED');
            assert.equal(outcome.approvedQuantity, 0);
            assert.ok(outcome.reasonCodes.length > 0, 'Risk rejection must include reason codes');
            assert.ok(outcome.reasonCodes.includes('EVENT_RISK_CAP'));
          }
        } finally {
          lowBankrollDb.cleanup();
        }

        // Returned EE-07 dashboard shows INSUFFICIENT_DATA before any settlement
        assert.equal(cycle.dashboard.experimentId, exp.experimentId);
        assert.equal(cycle.dashboard.researchQuality.status, 'INSUFFICIENT_DATA');
        assert.equal(cycle.dashboard.researchQuality.verdict, 'INSUFFICIENT_DATA');
        assert.equal(cycle.dashboard.researchQuality.hasSettledScores, false);
        assert.equal(cycle.dashboard.researchQuality.modelBrier, null);
        assert.equal(cycle.dashboard.integrity.liveDisabledAssertion.passed, true);
      } finally {
        cleanup();
      }
    });

    // -------------------------------------------------------------------------
    // (b) Fixture settlement across cycles + real EE-04 evaluation scores
    // -------------------------------------------------------------------------
    await test('(b) Fixture settlement: second fixture cycle resolves contracts and EE-04 produces real scores (not INSUFFICIENT_DATA)', async () => {
      const { db, cleanup } = makeTempDb('fixture-settlement');
      try {
        const config = createEventEdgeConfig({ mode: 'PAPER' }, {});
        const configHash = computeEventEdgeConfigHash(config);

        // Test-local experiment registration with small sample minimum (NOT shipped FIRST_EXPERIMENT)
        const testExpId = 'EE-TEST-LOCAL-SETTLE-01';
        registerExperiment(db, {
          experimentId: testExpId,
          title: 'Local fixture settlement test experiment',
          hypothesis: 'Fixture resolution populates real EE-04 scores.',
          killCriteria: 'PASS if forward Brier < market Brier and clustered CI upper < 0; min_settled_sample = 4.',
          sampleDefinition: JSON.stringify({
            eventFamilies: ['KXCPI', 'KXFED'],
            minSettledSample: 4,
          }),
          modelVersion: config.forecasting.ensembleVersion,
          configHash,
          registeredAt: '2026-11-20T00:00:00.000Z',
        });

        const cycle1At = '2026-11-26T12:00:00.000Z';
        const cycle1Close = '2026-11-28T12:00:00.000Z';
        const cycle1Exp = '2026-11-28T13:00:00.000Z';

        const openMarkets: KalshiRawMarket[] = [
          makeClearMarket({
            ticker: 'KXCPI-26NOV-M1',
            eventTicker: 'KXCPI-26NOV',
            seriesTicker: 'KXCPI',
            category: 'Economics',
            title: 'CPI Nov > 2.5%',
            yesBid: 0.48,
            yesAsk: 0.52,
            closeTime: cycle1Close,
            expirationTime: cycle1Exp,
          }),
          makeClearMarket({
            ticker: 'KXCPI-26NOV-M2',
            eventTicker: 'KXCPI-26NOV',
            seriesTicker: 'KXCPI',
            category: 'Economics',
            title: 'CPI Nov > 3.2%',
            yesBid: 0.48,
            yesAsk: 0.52,
            closeTime: cycle1Close,
            expirationTime: cycle1Exp,
          }),
          makeClearMarket({
            ticker: 'KXFED-26DEC-M1',
            eventTicker: 'KXFED-26DEC',
            seriesTicker: 'KXFED',
            category: 'Financials',
            title: 'Fed <= 4.50%',
            yesBid: 0.48,
            yesAsk: 0.52,
            closeTime: cycle1Close,
            expirationTime: cycle1Exp,
          }),
          makeClearMarket({
            ticker: 'KXFED-26DEC-M2',
            eventTicker: 'KXFED-26DEC',
            seriesTicker: 'KXFED',
            category: 'Financials',
            title: 'Fed <= 4.00%',
            yesBid: 0.48,
            yesAsk: 0.52,
            closeTime: cycle1Close,
            expirationTime: cycle1Exp,
          }),
        ];

        const cycle1Events: KalshiRawEvent[] = [
          {
            event_ticker: 'KXCPI-26NOV',
            series_ticker: 'KXCPI',
            category: 'Economics',
            markets: [openMarkets[0], openMarkets[1]],
          },
          {
            event_ticker: 'KXFED-26DEC',
            series_ticker: 'KXFED',
            category: 'Financials',
            markets: [openMarkets[2], openMarkets[3]],
          },
        ];

        const cycle1Fixtures: PaperCycleFixtures = {
          eventsPage1: { events: cycle1Events, cursor: '' },
          eventsPage2: { events: [], cursor: '' },
          standaloneMarkets: { markets: [], cursor: '' },
          referenceClassesByMarket: {
            'KXCPI-26NOV-M1': makeRefClass(18, 20), // high YES
            'KXCPI-26NOV-M2': makeRefClass(2, 20), // low YES (NO)
            'KXFED-26DEC-M1': makeRefClass(17, 20), // high YES
            'KXFED-26DEC-M2': makeRefClass(3, 20), // low YES (NO)
          },
          researchSnapshotsByMarket: {
            'KXCPI-26NOV-M1': makeResearchSnap('rs-m1', cycle1At, 13), // high prob
            'KXCPI-26NOV-M2': makeResearchSnap('rs-m2', cycle1At, 1), // low prob
            'KXFED-26DEC-M1': makeResearchSnap('rs-m3', cycle1At, 12), // high prob
            'KXFED-26DEC-M2': makeResearchSnap('rs-m4', cycle1At, 2), // low prob
          },
          orderbooksByMarket: {
            'KXCPI-26NOV-M1': [
              {
                orderbookStateId: 'ob-m1-dec',
                bestBidUsd: 0.48,
                bestAskUsd: 0.52,
                yesBidSizeFp: 200,
                yesAskSizeFp: 200,
                capturedAt: cycle1At,
              },
              {
                orderbookStateId: 'ob-m1-arr',
                bestBidUsd: 0.48,
                bestAskUsd: 0.52,
                yesBidSizeFp: 200,
                yesAskSizeFp: 200,
                capturedAt: '2026-11-26T12:00:00.500Z',
              },
            ],
          },
        };

        // Run Cycle 1: discovers, audits, forecasts (at distinct timestamps if needed — let's run M1..M4)
        const c1 = await runPaperCycle(db, {
          experimentId: testExpId,
          mode: 'PAPER',
          asOf: cycle1At,
          config,
          settledCash: 10_000,
          fixtures: cycle1Fixtures,
        });

        assert.equal(c1.counts.approvedCount, 4);
        assert.equal(c1.counts.forecastedCount, 4);
        assert.equal(c1.counts.shadowDecisionsCreated, 4);
        assert.equal(c1.counts.shadowFillsExecuted, 1); // M1 had arrival book captured
        assert.equal(c1.dashboard.researchQuality.verdict, 'INSUFFICIENT_DATA');

        // Intermediate cycle AFTER close time WITHOUT settlement result:
        // Must advance ACTIVE -> SETTLEMENT_PENDING and NEVER invent RESOLVED
        const afterCloseNoSettlementAt = '2026-11-28T12:05:00.000Z';
        const cPending = await runPaperCycle(db, {
          experimentId: testExpId,
          mode: 'PAPER',
          asOf: afterCloseNoSettlementAt,
          config,
          settledCash: 10_000,
          fixtures: {
            eventsPage1: { events: [], cursor: '' },
            eventsPage2: { events: [], cursor: '' },
            standaloneMarkets: { markets: [], cursor: '' },
            marketByTicker: {},
          },
        });
        assert.equal(cPending.counts.advancedToSettlementPending, 4);
        assert.equal(cPending.counts.settledCount, 0);
        for (const m of openMarkets) {
          assert.equal(getContractLifecycleState(db, m.ticker), 'SETTLEMENT_PENDING');
        }

        // Cycle 2 carrying Kalshi discovery resolution data via public `/markets/{ticker}` fixture
        const cycle2At = '2026-11-28T14:00:00.000Z';
        const settledFixtures: PaperCycleFixtures = {
          eventsPage1: { events: [], cursor: '' },
          eventsPage2: { events: [], cursor: '' },
          standaloneMarkets: { markets: [], cursor: '' },
          marketByTicker: {
            'KXCPI-26NOV-M1': makeClearMarket({
              ticker: 'KXCPI-26NOV-M1',
              eventTicker: 'KXCPI-26NOV',
              seriesTicker: 'KXCPI',
              category: 'Economics',
              title: 'CPI Nov > 2.5%',
              yesBid: 0.99,
              yesAsk: 1.0,
              closeTime: cycle1Close,
              expirationTime: cycle1Exp,
              status: 'finalized',
              result: 'yes',
              settlementTs: cycle2At,
            }),
            'KXCPI-26NOV-M2': makeClearMarket({
              ticker: 'KXCPI-26NOV-M2',
              eventTicker: 'KXCPI-26NOV',
              seriesTicker: 'KXCPI',
              category: 'Economics',
              title: 'CPI Nov > 3.2%',
              yesBid: 0.0,
              yesAsk: 0.01,
              closeTime: cycle1Close,
              expirationTime: cycle1Exp,
              status: 'finalized',
              result: 'no',
              settlementTs: cycle2At,
            }),
            'KXFED-26DEC-M1': makeClearMarket({
              ticker: 'KXFED-26DEC-M1',
              eventTicker: 'KXFED-26DEC',
              seriesTicker: 'KXFED',
              category: 'Financials',
              title: 'Fed <= 4.50%',
              yesBid: 0.99,
              yesAsk: 1.0,
              closeTime: cycle1Close,
              expirationTime: cycle1Exp,
              status: 'finalized',
              result: 'yes',
              settlementTs: cycle2At,
            }),
            'KXFED-26DEC-M2': makeClearMarket({
              ticker: 'KXFED-26DEC-M2',
              eventTicker: 'KXFED-26DEC',
              seriesTicker: 'KXFED',
              category: 'Financials',
              title: 'Fed <= 4.00%',
              yesBid: 0.0,
              yesAsk: 0.01,
              closeTime: cycle1Close,
              expirationTime: cycle1Exp,
              status: 'finalized',
              result: 'no',
              settlementTs: cycle2At,
            }),
          },
        };

        const c2 = await runPaperCycle(db, {
          experimentId: testExpId,
          mode: 'PAPER',
          asOf: cycle2At,
          config,
          settledCash: 10_000,
          fixtures: settledFixtures,
        });

        assert.equal(c2.counts.settledCount, 4);
        for (const m of openMarkets) {
          assert.equal(getContractLifecycleState(db, m.ticker), 'RESOLVED');
        }

        // EE-04 evaluation now produces real scores (NOT INSUFFICIENT_DATA)
        const evalReport = evaluateExperiment(db, testExpId, {
          persistCalibratedForecasts: false,
        });
        assert.equal(evalReport.pooledScoring.sampleCount, 4);
        assert.notEqual(evalReport.gate.verdict, 'INSUFFICIENT_DATA');
        assert.ok(
          evalReport.pooledScoring.model.brierScore !== null &&
            Number.isFinite(evalReport.pooledScoring.model.brierScore)
        );
        assert.ok(
          evalReport.pooledScoring.marketReference.brierScore !== null &&
            Number.isFinite(evalReport.pooledScoring.marketReference.brierScore)
        );
        assert.ok(
          evalReport.pooledScoring.model.brierScore <
            evalReport.pooledScoring.marketReference.brierScore,
          'Fixture model forecasts should beat the 0.50 market reference on Brier score'
        );
        assert.equal(evalReport.calibration.status, 'COMPLETED');

        // Dashboard returned by Cycle 2 reflects those exact real scores
        assert.equal(c2.dashboard.researchQuality.hasSettledScores, true);
        assert.notEqual(c2.dashboard.researchQuality.verdict, 'INSUFFICIENT_DATA');
        assert.equal(
          c2.dashboard.researchQuality.modelBrier,
          evalReport.pooledScoring.model.brierScore
        );
      } finally {
        cleanup();
      }
    });

    // -------------------------------------------------------------------------
    // (c) Mode guard: DEMO and LIVE rejected with named errors
    // -------------------------------------------------------------------------
    await test('(c) Mode guard: DEMO rejected with PaperRunnerModeError and LIVE rejected with EventEdgeLiveModeDisabledError', async () => {
      const { db, cleanup } = makeTempDb('mode-guard');
      try {
        const exp = registerFirstExperiment(db);

        await assert.rejects(
          () =>
            runPaperCycle(db, {
              experimentId: exp.experimentId,
              mode: 'DEMO',
              asOf: FIXTURE_NOW_ISO,
              fixtures: true,
            }),
          (err: unknown) => {
            assert.ok(err instanceof PaperRunnerModeError);
            assert.equal(err.code, 'EVENTEDGE_PAPER_RUNNER_MODE_REJECTED');
            assert.equal(err.requestedMode, 'DEMO');
            return true;
          }
        );

        await assert.rejects(
          () =>
            runPaperCycle(db, {
              experimentId: exp.experimentId,
              mode: 'LIVE',
              asOf: FIXTURE_NOW_ISO,
              fixtures: true,
            }),
          (err: unknown) => {
            assert.ok(err instanceof EventEdgeLiveModeDisabledError);
            assert.equal(err.code, 'EVENTEDGE_LIVE_MODE_HARD_DISABLED');
            return true;
          }
        );

        // Forged LIVE config passed with mode: 'PAPER' must also be rejected
        const forgedLive = {
          ...createEventEdgeConfig({ mode: 'PAPER' }, {}),
          mode: 'LIVE',
          liveEnabled: true,
        } as unknown as EventEdgeConfig;

        await assert.rejects(
          () =>
            runPaperCycle(db, {
              experimentId: exp.experimentId,
              mode: 'PAPER',
              asOf: FIXTURE_NOW_ISO,
              config: forgedLive,
              fixtures: true,
            }),
          EventEdgeLiveModeDisabledError
        );

        // DEMO config passed with mode: 'PAPER' must also be rejected
        const demoConfig = createEventEdgeConfig({ mode: 'DEMO' }, {});
        await assert.rejects(
          () =>
            runPaperCycle(db, {
              experimentId: exp.experimentId,
              mode: 'PAPER',
              asOf: FIXTURE_NOW_ISO,
              config: demoConfig,
              fixtures: true,
            }),
          PaperRunnerModeError
        );
      } finally {
        cleanup();
      }
    });

    // -------------------------------------------------------------------------
    // (d) Frozen config check
    // -------------------------------------------------------------------------
    await test('(d) Frozen config: tampering with any config value after registration raises FrozenConfigMismatchError', async () => {
      const { db, cleanup } = makeTempDb('frozen-config');
      try {
        const registeredConfig = createEventEdgeConfig({ mode: 'PAPER' }, {});
        const exp = registerFirstExperiment(db, {
          config: registeredConfig,
          registeredAt: '2026-11-26T00:00:00.000Z',
        });

        const tamperedConfigs: Array<{ label: string; cfg: EventEdgeConfig }> = [
          {
            label: 'risk.minConservativeEdge',
            cfg: createEventEdgeConfig({ mode: 'PAPER', risk: { minConservativeEdge: 0.05 } }, {}),
          },
          {
            label: 'discovery.maxCloseHorizonDays',
            cfg: createEventEdgeConfig({ mode: 'PAPER', discovery: { maxCloseHorizonDays: 21 } }, {}),
          },
          {
            label: 'forecasting.ensembleWeights',
            cfg: createEventEdgeConfig(
              { mode: 'PAPER', forecasting: { ensembleWeights: { p_base: 0.6, p_quant: 0.4 } } },
              {}
            ),
          },
          {
            label: 'shadow.latencyMs',
            cfg: createEventEdgeConfig({ mode: 'PAPER', shadow: { latencyMs: 500 } }, {}),
          },
        ];

        for (const item of tamperedConfigs) {
          await assert.rejects(
            () =>
              runPaperCycle(db, {
                experimentId: exp.experimentId,
                mode: 'PAPER',
                asOf: FIXTURE_NOW_ISO,
                config: item.cfg,
                fixtures: true,
              }),
            (err: unknown) => {
              assert.ok(
                err instanceof FrozenConfigMismatchError,
                `Expected FrozenConfigMismatchError when tampering with ${item.label}`
              );
              assert.equal(err.experimentId, exp.experimentId);
              assert.equal(err.registeredConfigHash, exp.configHash);
              assert.equal(err.currentConfigHash, computeEventEdgeConfigHash(item.cfg));
              return true;
            }
          );
        }

        // Verify zero market snapshots or forecasts were written during rejected cycles
        const snapCount = (
          db.prepare('SELECT COUNT(*) AS c FROM market_snapshots').get() as { c: number }
        ).c;
        const fcCount = (
          db.prepare('SELECT COUNT(*) AS c FROM probability_forecasts').get() as { c: number }
        ).c;
        assert.equal(Number(snapCount), 0);
        assert.equal(Number(fcCount), 0);
      } finally {
        cleanup();
      }
    });

    // -------------------------------------------------------------------------
    // (e) Idempotent registration
    // -------------------------------------------------------------------------
    await test('(e) Idempotent registration: registering twice yields one registry row and identical records', () => {
      const { db, cleanup } = makeTempDb('idempotent-reg');
      try {
        const config = createEventEdgeConfig({ mode: 'PAPER' }, {});
        const first = registerFirstExperiment(db, {
          config,
          registeredAt: '2026-11-26T00:00:00.000Z',
        });
        const second = registerFirstExperiment(db, {
          config,
          registeredAt: '2026-11-26T05:00:00.000Z',
        });

        assert.deepEqual(second, first);
        assert.equal(first.experimentId, 'EE-V1-BASERATE-01');
        assert.equal(first.status, 'REGISTERED');
        assert.equal(first.modelVersion, config.forecasting.ensembleVersion);
        assert.equal(first.configHash, computeEventEdgeConfigHash(config));

        const allExperiments = listExperiments(db);
        assert.equal(allExperiments.length, 1);
      } finally {
        cleanup();
      }
    });

    // -------------------------------------------------------------------------
    // (f) No-silent-skip: every discovered market appears in cycle report
    // -------------------------------------------------------------------------
    await test('(f) No-silent-skip: every discovered market in the fixture appears in marketOutcomes with an outcome or reason code', async () => {
      const { db, cleanup } = makeTempDb('no-silent-skip');
      try {
        const config = createEventEdgeConfig({ mode: 'PAPER' }, {});
        const exp = registerFirstExperiment(db, { config });

        const cycle = await runPaperCycle(db, {
          experimentId: exp.experimentId,
          mode: 'PAPER',
          asOf: FIXTURE_NOW_ISO,
          config,
          settledCash: 10_000,
          fixtures: true,
        });

        const expectedAllFixtureTickers = [
          'KXAWARDS-26DEC-BESTPIC',
          'KXCLIMATE-27JAN-T1.5',
          'KXCPI-26NOV-T2.8',
          'KXCRYPTO-26NOV-ATH',
          'KXFED-26DEC-T4.50',
          'KXNFL-26WK13-KC',
          'KXPOL-26DEC-NORULES',
          'KXTECH-26DEC-MAJOR',
        ];

        const reportedTickers = cycle.marketOutcomes.map((m) => m.marketId).sort();
        assert.deepEqual(reportedTickers, expectedAllFixtureTickers);

        for (const outcome of cycle.marketOutcomes) {
          assert.ok(outcome.status.length > 0, `Market ${outcome.marketId} missing outcome status`);
          if (outcome.status !== 'SHADOW_EXECUTED') {
            assert.ok(
              outcome.reasonCodes.length > 0,
              `Market ${outcome.marketId} (${outcome.status}) must record at least one reason code`
            );
          } else {
            assert.ok(outcome.decisionId !== null, 'SHADOW_EXECUTED must record decisionId');
          }
        }
      } finally {
        cleanup();
      }
    });

    // -------------------------------------------------------------------------
    // (g) Shipped FIRST_EXPERIMENT constant exact texts & key substrings
    // -------------------------------------------------------------------------
    await test('(g) Shipped FIRST_EXPERIMENT constant carries exact hypothesis, sample_definition, and kill_criteria texts', () => {
      assert.equal(FIRST_EXPERIMENT.experimentId, 'EE-V1-BASERATE-01');
      assert.equal(FIRST_EXPERIMENT.experiment_id, 'EE-V1-BASERATE-01');
      assert.equal(
        FIRST_EXPERIMENT.title,
        'EventEdge v1 — reference base-rate ensemble vs market (frozen)'
      );
      assert.equal(
        FIRST_EXPERIMENT.hypothesis,
        'The EE-02 reference ensemble (base-rate + fixed-transform quant, 50/50) produces probability forecasts whose Brier score on settled Kalshi markets beats the timestamp-matched market reference on the same sample.'
      );
      assert.equal(
        FIRST_EXPERIMENT.sampleDefinition,
        'All markets discovered by the EE-01 config (14-day horizon, sports and entertainment-awards excluded) that reach APPROVED and settle during the window. The frozen sample closes at the first of: 100 settled forecasted markets, or 90 days from the RUNNING transition. The denominator includes discovered, audit-rejected, and abstained markets.'
      );
      assert.equal(
        FIRST_EXPERIMENT.killCriteria,
        'KILLED (hypothesis failed) if, on the frozen sample, the EE-04 gate verdict is FAIL: model forward Brier not strictly below market Brier, or the clustered 95% CI upper bound for (model - market) Brier is not below 0. PASS requires both conditions. INSUFFICIENT_DATA at sample close also closes the experiment as KILLED with reason INSUFFICIENT_DATA. No retuning, reweighting, or threshold change is permitted inside this experiment; any change requires a new experiment_id and fresh data.'
      );
      assert.equal(FIRST_EXPERIMENT.initialStatus, 'REGISTERED');

      // Explicit required key substrings
      assert.ok(FIRST_EXPERIMENT.sampleDefinition.includes('100 settled forecasted markets'));
      assert.ok(FIRST_EXPERIMENT.sampleDefinition.includes('90 days'));
      assert.ok(FIRST_EXPERIMENT.killCriteria.includes('No retuning'));
    });

    // -------------------------------------------------------------------------
    // Extra: OBSERVE mode skips shadow execution & static isolation check on eventedge/runner/
    // -------------------------------------------------------------------------
    await test('Extra: OBSERVE mode runs without shadow execution & eventedge/runner/ has zero credentials/live execution imports', async () => {
      const { db, cleanup } = makeTempDb('observe-and-isolation');
      try {
        const obsConfig = createEventEdgeConfig({ mode: 'OBSERVE' }, {});
        const exp = registerFirstExperiment(db, { config: obsConfig });

        const cycle = await runPaperCycle(db, {
          experimentId: exp.experimentId,
          mode: 'OBSERVE',
          asOf: FIXTURE_NOW_ISO,
          config: obsConfig,
          fixtures: true,
        });

        assert.equal(cycle.mode, 'OBSERVE');
        assert.equal(cycle.counts.forecastedCount, 2);
        assert.equal(cycle.counts.riskApprovedCount, 2);
        assert.equal(cycle.counts.shadowDecisionsCreated, 0);
        assert.equal(listShadowDecisionsForExperiment(db, exp.experimentId).length, 0);

        // Static isolation scan on eventedge/runner/*
        const runnerDir = path.resolve(process.cwd(), 'eventedge', 'runner');
        const runnerFiles = fs.readdirSync(runnerDir).filter((f) => f.endsWith('.ts'));
        assert.ok(runnerFiles.includes('paperRunner.ts'));
        assert.ok(runnerFiles.includes('registerFirstExperiment.ts'));
        for (const file of runnerFiles) {
          const content = fs.readFileSync(path.join(runnerDir, file), 'utf8');
          assert.doesNotMatch(
            content,
            /ExecutionVault|server\.ts|KALSHI_API_KEY|KALSHI_PRIVATE_KEY|PUBLIC_API_SECRET|kalshi-access-signature|authorization\s*:/i,
            `eventedge/runner/${file} must not import live execution, credentials, or auth headers`
          );
        }
      } finally {
        cleanup();
      }
    });
  } finally {
    globalThis.fetch = originalGlobalFetch;
  }

  console.log(`\n=== EE-08 Summary: ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) {
    process.exit(1);
  }
}

runSuite().catch((err) => {
  console.error('EE-08 suite crashed:', err);
  process.exit(1);
});
