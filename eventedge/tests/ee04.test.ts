import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  EVENTEDGE_MIGRATIONS,
  EventEdgeLiveModeDisabledError,
  LOG_LOSS_PROBABILITY_CLIP_EPSILON,
  assembleExperimentEvaluationSet,
  brierScore,
  computeClusterBootstrapBrierDiffCI,
  computeForecastConfigHash,
  computeScoringMetrics,
  createBetaCalibrator,
  createDefaultCalibrators,
  createEventEdgeConfig,
  createExperimentEvaluator,
  createPlattCalibrator,
  createTemperatureCalibrator,
  evaluateExperiment,
  evaluatePriceBlindForecast,
  getForecastsForMarket,
  initializeEventEdgeLedger,
  logLoss,
  registerDiscoveredContract,
  registerExperiment,
  runTemporallyIsolatedCalibration,
  saveForecast,
  splitChronologically,
  transitionContractLifecycle,
  transitionExperimentStatus,
  type ApprovedContractInput,
  type BinaryOutcome,
  type CalibrationPoint,
  type CalibrationProvenanceMetadata,
  type PairedScoringSample,
  type ProbabilityCalibrator,
  type QuantitativeEstimator,
} from '../index';

function insertSnapshot(
  db: DatabaseSync,
  params: {
    snapshotId: string;
    eventTicker: string;
    marketTicker: string;
    yesBid: number | null;
    yesAsk: number | null;
    capturedAt: string;
  }
): void {
  db.prepare(
    `INSERT INTO market_snapshots (
      snapshot_id, venue, series_ticker, event_ticker, market_ticker, status,
      yes_bid_usd, yes_ask_usd, last_price_usd, volume, open_interest,
      close_time_utc, expiration_time_utc, raw_payload_json, captured_at
    ) VALUES (?, 'KALSHI', ?, ?, ?, 'open', ?, ?, ?, 1000, 500, ?, ?, '{}', ?)`
  ).run(
    params.snapshotId,
    params.eventTicker.split('-')[0],
    params.eventTicker,
    params.marketTicker,
    params.yesBid,
    params.yesAsk,
    params.yesBid !== null && params.yesAsk !== null
      ? (params.yesBid + params.yesAsk) / 2
      : params.yesAsk,
    params.capturedAt,
    params.capturedAt,
    params.capturedAt
  );
}

function insertSettlement(
  db: DatabaseSync,
  params: {
    settlementId: string;
    eventTicker: string;
    marketTicker: string;
    outcome: 'YES' | 'NO' | 'VOID' | 'CANCELLED';
    settledAt: string;
  }
): void {
  const price = params.outcome === 'YES' ? 1.0 : 0.0;
  db.prepare(
    `INSERT INTO settlements (
      settlement_id, venue, event_ticker, market_ticker, rule_version_id,
      outcome, settlement_price_usd, settled_contracts, payout_usd,
      raw_settlement_json, settled_at
    ) VALUES (?, 'KALSHI', ?, ?, NULL, ?, ?, 10, ?, '{}', ?)`
  ).run(
    params.settlementId,
    params.eventTicker,
    params.marketTicker,
    params.outcome,
    price,
    price * 10,
    params.settledAt
  );
}

function advanceLifecycleToApproved(db: DatabaseSync, marketId: string, ts: string): void {
  registerDiscoveredContract(db, { marketId, transitionedAt: ts });
  transitionContractLifecycle(db, {
    marketId,
    toState: 'AUDIT_PENDING',
    reason: 'Entered audit queue',
    actor: 'ee04_test',
    transitionedAt: ts,
  });
  transitionContractLifecycle(db, {
    marketId,
    toState: 'APPROVED',
    reason: 'AUDITOR_CLEAR',
    actor: 'ee04_test',
    transitionedAt: ts,
  });
}

function advanceApprovedToResolved(db: DatabaseSync, marketId: string, ts: string): void {
  transitionContractLifecycle(db, {
    marketId,
    toState: 'ACTIVE',
    reason: 'Activated',
    actor: 'ee04_test',
    transitionedAt: ts,
  });
  transitionContractLifecycle(db, {
    marketId,
    toState: 'SETTLEMENT_PENDING',
    reason: 'Closed awaiting settlement',
    actor: 'ee04_test',
    transitionedAt: ts,
  });
  transitionContractLifecycle(db, {
    marketId,
    toState: 'RESOLVED',
    reason: 'Venue settled',
    actor: 'ee04_test',
    transitionedAt: ts,
  });
}

function buildApprovedContract(marketId: string, eventId: string): ApprovedContractInput {
  return Object.freeze({
    marketId,
    eventId,
    category: 'Economics',
    marketTerms: `Contract terms for ${marketId}`,
    closeTimeUtc: '2026-12-01T14:00:00.000Z',
    expirationTimeUtc: '2026-12-01T15:00:00.000Z',
    ruleVersionId: null,
    ruleHash: `hash-${marketId}`,
    settlementSource: 'Official Agency',
    auditStatus: 'CLEAR' as const,
  });
}

function persistDirectQuantEnsemble(params: {
  db: DatabaseSync;
  cfg: ReturnType<typeof createEventEdgeConfig>;
  experimentId: string;
  marketId: string;
  eventId: string;
  probability: number | null;
  forecastTimestamp: string;
  tempDir: string;
}): ReturnType<typeof evaluatePriceBlindForecast> {
  const quantEstimator: QuantitativeEstimator = {
    id: 'ee04-fixture-quant',
    version: 'ee04-fixture-quant-v1',
    estimate: () => {
      if (params.probability === null) {
        return {
          abstained: true,
          abstentionReasons: [
            { code: 'ESTIMATOR_ABSTAINED', detail: 'Fixture explicit abstention.' },
          ],
        };
      }
      return { probability: params.probability };
    },
  };

  const evaluated = evaluatePriceBlindForecast({
    experimentId: params.experimentId,
    contract: buildApprovedContract(params.marketId, params.eventId),
    config: params.cfg,
    researchSnapshot: {
      dataSnapshotId: `rsnap_${params.marketId}`,
      capturedAt: params.forecastTimestamp,
      features: { signal: 1 },
    },
    referenceClass: null,
    baseRateEstimator: null,
    quantEstimator,
    forecastTimestamp: params.forecastTimestamp,
    repoRootDir: params.tempDir,
  });

  saveForecast(params.db, evaluated.pBase);
  saveForecast(params.db, evaluated.pQuant);
  saveForecast(params.db, evaluated.pEnsemble);
  return evaluated;
}

function runEe04Tests(): void {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eventedge-ee04-'));

  try {
    // Confirm LIVE remains hard-disabled
    assert.throws(
      () => createEventEdgeConfig({ mode: 'LIVE' }, {}),
      EventEdgeLiveModeDisabledError
    );

    const cfg = createEventEdgeConfig(
      {
        ledgerDbPath: path.join(tempDir, 'ee04_ledger.sqlite'),
      },
      {}
    );
    const configHash = computeForecastConfigHash(cfg.forecasting);

    // -------------------------------------------------------------------------
    // (a) SCORING CORRECTNESS on a small hand-computable fixture
    // -------------------------------------------------------------------------
    const handPairs: ReadonlyArray<{ probability: number; outcome: BinaryOutcome }> = [
      { probability: 0.8, outcome: 1 },
      { probability: 0.2, outcome: 0 },
      { probability: 0.6, outcome: 0 },
      { probability: 0.0, outcome: 1 }, // triggers lower clip to 1e-6 for log loss only
    ];

    const expectedBrier = ((0.8 - 1) ** 2 + (0.2 - 0) ** 2 + (0.6 - 0) ** 2 + (0.0 - 1) ** 2) / 4;
    // (0.04 + 0.04 + 0.36 + 1.0) / 4 = 0.36
    assert.ok(Math.abs(expectedBrier - 0.36) < 1e-12);

    const eps = LOG_LOSS_PROBABILITY_CLIP_EPSILON;
    const expectedLogLoss =
      (-Math.log(0.8) - Math.log(1 - 0.2) - Math.log(1 - 0.6) - Math.log(eps)) / 4;

    const handMetrics = computeScoringMetrics(handPairs);
    assert.equal(handMetrics.count, 4);
    assert.ok(Math.abs(handMetrics.brierScore! - expectedBrier) < 1e-12);
    assert.ok(Math.abs(handMetrics.logLoss! - expectedLogLoss) < 1e-12);
    assert.equal(handMetrics.logLossClip.epsilon, 1e-6);
    assert.equal(handMetrics.logLossClip.min, 1e-6);
    assert.equal(handMetrics.logLossClip.max, 1 - 1e-6);
    assert.equal(handMetrics.logLossClip.clippedCount, 1);

    // Spot-check single-point helpers
    assert.ok(Math.abs(brierScore(0.75, 1) - 0.0625) < 1e-12);
    assert.ok(Math.abs(logLoss(1.0, 0) - -Math.log(1e-6)) < 1e-12);

    console.log(
      'PASS [EE-04 (a)]: Hand-computable Brier score, log loss, and [1e-6, 1-1e-6] clip reporting verified.'
    );

    const { db, migrationResult } = initializeEventEdgeLedger(cfg.ledgerDbPath);
    try {
      assert.equal(
        migrationResult.currentVersion,
        EVENTEDGE_MIGRATIONS[EVENTEDGE_MIGRATIONS.length - 1].version
      );
      assert.equal(migrationResult.appliedVersions.includes(5), true);

      // -----------------------------------------------------------------------
      // (b) IDENTICAL-SAMPLE GUARANTEE & timestamp-matched market reference
      // -----------------------------------------------------------------------
      const expIdenticalId = 'exp-ee04-identical-sample';
      registerExperiment(db, {
        experimentId: expIdenticalId,
        title: 'Identical Sample Guarantee Fixture',
        hypothesis: 'Model beats market on matched settled sample.',
        killCriteria: 'PASS iff forward Brier < market Brier and CI upper < 0',
        sampleDefinition: 'Event families: KXID; min_settled = 2',
        modelVersion: 'ee04-fixture-v1',
        configHash,
      });
      transitionExperimentStatus(db, {
        experimentId: expIdenticalId,
        toStatus: 'RUNNING',
        reason: 'Start identical sample fixture',
      });

      // Market 1: RESOLVED YES, has snapshots BEFORE (0.40/0.44 -> 0.42), CLOSER BEFORE (0.50/0.54 -> 0.52), and AFTER (0.90/0.94 -> MUST NOT BE USED!)
      const m1 = 'KXID-26NOV-M1';
      advanceLifecycleToApproved(db, m1, '2026-11-01T10:00:00.000Z');
      insertSnapshot(db, {
        snapshotId: 'snap-m1-early',
        eventTicker: 'KXID-26NOV',
        marketTicker: m1,
        yesBid: 0.40,
        yesAsk: 0.44,
        capturedAt: '2026-11-01T10:00:00.000Z',
      });
      insertSnapshot(db, {
        snapshotId: 'snap-m1-closest',
        eventTicker: 'KXID-26NOV',
        marketTicker: m1,
        yesBid: 0.50,
        yesAsk: 0.54,
        capturedAt: '2026-11-01T11:55:00.000Z',
      });
      insertSnapshot(db, {
        snapshotId: 'snap-m1-future-leak',
        eventTicker: 'KXID-26NOV',
        marketTicker: m1,
        yesBid: 0.90,
        yesAsk: 0.94,
        capturedAt: '2026-11-01T12:05:00.000Z', // AFTER forecastTimestamp
      });
      persistDirectQuantEnsemble({
        db,
        cfg,
        experimentId: expIdenticalId,
        marketId: m1,
        eventId: 'KXID-26NOV',
        probability: 0.80,
        forecastTimestamp: '2026-11-01T12:00:00.000Z',
        tempDir,
      });
      advanceApprovedToResolved(db, m1, '2026-11-02T12:00:00.000Z');
      insertSettlement(db, {
        settlementId: 'settle-m1',
        eventTicker: 'KXID-26NOV',
        marketTicker: m1,
        outcome: 'YES',
        settledAt: '2026-11-02T12:00:00.000Z',
      });

      // Market 2: RESOLVED NO, has ask-only snapshot at exact forecast_timestamp (0.48)
      const m2 = 'KXID-26NOV-M2';
      advanceLifecycleToApproved(db, m2, '2026-11-01T10:00:00.000Z');
      insertSnapshot(db, {
        snapshotId: 'snap-m2-exact',
        eventTicker: 'KXID-26NOV',
        marketTicker: m2,
        yesBid: null,
        yesAsk: 0.48,
        capturedAt: '2026-11-01T13:00:00.000Z',
      });
      persistDirectQuantEnsemble({
        db,
        cfg,
        experimentId: expIdenticalId,
        marketId: m2,
        eventId: 'KXID-26NOV',
        probability: 0.20,
        forecastTimestamp: '2026-11-01T13:00:00.000Z',
        tempDir,
      });
      advanceApprovedToResolved(db, m2, '2026-11-02T13:00:00.000Z');
      insertSettlement(db, {
        settlementId: 'settle-m2',
        eventTicker: 'KXID-26NOV',
        marketTicker: m2,
        outcome: 'NO',
        settledAt: '2026-11-02T13:00:00.000Z',
      });

      // Market 3: RESOLVED YES, forecasted, but ONLY has a post-forecast snapshot -> excluded from BOTH model & market scoring
      const m3 = 'KXID-26NOV-M3';
      advanceLifecycleToApproved(db, m3, '2026-11-01T10:00:00.000Z');
      insertSnapshot(db, {
        snapshotId: 'snap-m3-after-only',
        eventTicker: 'KXID-26NOV',
        marketTicker: m3,
        yesBid: 0.60,
        yesAsk: 0.64,
        capturedAt: '2026-11-01T14:01:00.000Z',
      });
      persistDirectQuantEnsemble({
        db,
        cfg,
        experimentId: expIdenticalId,
        marketId: m3,
        eventId: 'KXID-26NOV',
        probability: 0.90,
        forecastTimestamp: '2026-11-01T14:00:00.000Z',
        tempDir,
      });
      advanceApprovedToResolved(db, m3, '2026-11-02T14:00:00.000Z');
      insertSettlement(db, {
        settlementId: 'settle-m3',
        eventTicker: 'KXID-26NOV',
        marketTicker: m3,
        outcome: 'YES',
        settledAt: '2026-11-02T14:00:00.000Z',
      });

      // Market 4: DISPUTED -> reported separately, excluded from scoring
      const m4 = 'KXID-26NOV-M4';
      advanceLifecycleToApproved(db, m4, '2026-11-01T10:00:00.000Z');
      insertSnapshot(db, {
        snapshotId: 'snap-m4',
        eventTicker: 'KXID-26NOV',
        marketTicker: m4,
        yesBid: 0.50,
        yesAsk: 0.52,
        capturedAt: '2026-11-01T14:00:00.000Z',
      });
      persistDirectQuantEnsemble({
        db,
        cfg,
        experimentId: expIdenticalId,
        marketId: m4,
        eventId: 'KXID-26NOV',
        probability: 0.70,
        forecastTimestamp: '2026-11-01T15:00:00.000Z',
        tempDir,
      });
      advanceApprovedToResolved(db, m4, '2026-11-02T15:00:00.000Z');
      transitionContractLifecycle(db, {
        marketId: m4,
        toState: 'DISPUTED',
        reason: 'Contested outcome',
        actor: 'ee04_test',
        transitionedAt: '2026-11-02T16:00:00.000Z',
      });

      // Market 5: VOIDED -> reported separately, excluded from scoring
      const m5 = 'KXID-26NOV-M5';
      advanceLifecycleToApproved(db, m5, '2026-11-01T10:00:00.000Z');
      insertSnapshot(db, {
        snapshotId: 'snap-m5',
        eventTicker: 'KXID-26NOV',
        marketTicker: m5,
        yesBid: 0.45,
        yesAsk: 0.49,
        capturedAt: '2026-11-01T14:00:00.000Z',
      });
      persistDirectQuantEnsemble({
        db,
        cfg,
        experimentId: expIdenticalId,
        marketId: m5,
        eventId: 'KXID-26NOV',
        probability: 0.65,
        forecastTimestamp: '2026-11-01T16:00:00.000Z',
        tempDir,
      });
      transitionContractLifecycle(db, {
        marketId: m5,
        toState: 'ACTIVE',
        reason: 'Active',
        actor: 'ee04_test',
        transitionedAt: '2026-11-01T16:05:00.000Z',
      });
      transitionContractLifecycle(db, {
        marketId: m5,
        toState: 'VOIDED',
        reason: 'Event cancelled by exchange',
        actor: 'ee04_test',
        transitionedAt: '2026-11-02T16:05:00.000Z',
      });

      const joinedIdentical = assembleExperimentEvaluationSet(db, expIdenticalId);
      assert.equal(joinedIdentical.scoredSamples.length, 2);
      assert.deepEqual(
        joinedIdentical.scoredSamples.map((s) => s.marketId),
        [m1, m2]
      );
      // Confirm closest pre-forecast snapshot chosen (0.52 mid, NOT 0.42 early and NOT 0.92 future!)
      assert.equal(joinedIdentical.scoredSamples[0].marketSnapshotId, 'snap-m1-closest');
      assert.ok(Math.abs(joinedIdentical.scoredSamples[0].marketReferenceProbability - 0.52) < 1e-12);
      assert.equal(joinedIdentical.scoredSamples[0].marketReferenceMethod, 'YES_MID');
      // Confirm ask-only fallback at exact timestamp
      assert.equal(joinedIdentical.scoredSamples[1].marketSnapshotId, 'snap-m2-exact');
      assert.ok(Math.abs(joinedIdentical.scoredSamples[1].marketReferenceProbability - 0.48) < 1e-12);
      assert.equal(joinedIdentical.scoredSamples[1].marketReferenceMethod, 'YES_ASK');

      // Confirm missing market ref & disputed/voided reported separately and excluded
      assert.equal(joinedIdentical.excludedMissingMarketReference.length, 1);
      assert.equal(joinedIdentical.excludedMissingMarketReference[0].marketId, m3);
      assert.equal(joinedIdentical.disputedOrVoided.length, 2);
      assert.deepEqual(
        joinedIdentical.disputedOrVoided.map((d) => `${d.marketId}:${d.lifecycleState}`).sort(),
        [`${m4}:DISPUTED`, `${m5}:VOIDED`].sort()
      );

      const identicalReport = evaluateExperiment(db, expIdenticalId, {
        persistCalibratedForecasts: false,
        bootstrapIterations: 500,
      });
      assert.equal(identicalReport.pooledScoring.sampleCount, 2);
      assert.equal(identicalReport.pooledScoring.model.count, 2);
      assert.equal(identicalReport.pooledScoring.marketReference.count, 2);
      assert.deepEqual([...identicalReport.pooledScoring.marketIds], [m1, m2]);

      console.log(
        'PASS [EE-04 (b)]: Identical-sample guarantee, pre-forecast snapshot matching, and DISPUTED/VOIDED separation verified.'
      );

      // -----------------------------------------------------------------------
      // (c) DENOMINATOR ACCOUNTING across two event families (KXCPI & KXFED)
      // -----------------------------------------------------------------------
      const expDenomId = 'exp-ee04-denominator';
      registerExperiment(db, {
        experimentId: expDenomId,
        title: 'Two-Family Denominator Accounting',
        hypothesis: 'All denominator counts including abstentions remain visible.',
        killCriteria: 'Brier diff CI upper < 0',
        sampleDefinition: JSON.stringify({
          eventFamilies: ['KXDENA', 'KXDENB'],
          minSettledSample: 4,
        }),
        modelVersion: 'ee04-fixture-v1',
        configHash,
      });
      transitionExperimentStatus(db, {
        experimentId: expDenomId,
        toStatus: 'RUNNING',
        reason: 'Start denominator test',
      });

      // Family KXDENA (6 discovered): 1 rejected, 1 abstained, 4 forecasted (3 settled RESOLVED, 1 DISPUTED)
      // Rejected market
      registerDiscoveredContract(db, { marketId: 'KXDENA-26NOV-REJ' });
      transitionContractLifecycle(db, {
        marketId: 'KXDENA-26NOV-REJ',
        toState: 'AUDIT_PENDING',
        reason: 'Audit',
        actor: 'ee04_test',
      });
      transitionContractLifecycle(db, {
        marketId: 'KXDENA-26NOV-REJ',
        toState: 'REJECTED',
        reason: 'AUDITOR_AMBIGUOUS',
        actor: 'ee04_test',
      });

      // Abstained market (approved, abstained p_ensemble, settled RESOLVED)
      advanceLifecycleToApproved(db, 'KXDENA-26NOV-ABS', '2026-11-05T10:00:00.000Z');
      persistDirectQuantEnsemble({
        db,
        cfg,
        experimentId: expDenomId,
        marketId: 'KXDENA-26NOV-ABS',
        eventId: 'KXDENA-26NOV',
        probability: null,
        forecastTimestamp: '2026-11-05T11:00:00.000Z',
        tempDir,
      });
      advanceApprovedToResolved(db, 'KXDENA-26NOV-ABS', '2026-11-06T11:00:00.000Z');
      insertSettlement(db, {
        settlementId: 'settle-dena-abs',
        eventTicker: 'KXDENA-26NOV',
        marketTicker: 'KXDENA-26NOV-ABS',
        outcome: 'YES',
        settledAt: '2026-11-06T11:00:00.000Z',
      });

      // 3 forecasted & settled RESOLVED
      for (let i = 1; i <= 3; i += 1) {
        const mk = `KXDENA-26NOV-F${i}`;
        const fTs = `2026-11-05T12:0${i}:00.000Z`;
        advanceLifecycleToApproved(db, mk, '2026-11-05T10:00:00.000Z');
        insertSnapshot(db, {
          snapshotId: `snap-dena-f${i}`,
          eventTicker: 'KXDENA-26NOV',
          marketTicker: mk,
          yesBid: 0.48,
          yesAsk: 0.52,
          capturedAt: fTs,
        });
        persistDirectQuantEnsemble({
          db,
          cfg,
          experimentId: expDenomId,
          marketId: mk,
          eventId: 'KXDENA-26NOV',
          probability: i % 2 === 1 ? 0.75 : 0.25,
          forecastTimestamp: fTs,
          tempDir,
        });
        advanceApprovedToResolved(db, mk, '2026-11-06T12:00:00.000Z');
        insertSettlement(db, {
          settlementId: `settle-dena-f${i}`,
          eventTicker: 'KXDENA-26NOV',
          marketTicker: mk,
          outcome: i % 2 === 1 ? 'YES' : 'NO',
          settledAt: '2026-11-06T12:00:00.000Z',
        });
      }

      // 1 forecasted & DISPUTED
      advanceLifecycleToApproved(db, 'KXDENA-26NOV-DISP', '2026-11-05T10:00:00.000Z');
      persistDirectQuantEnsemble({
        db,
        cfg,
        experimentId: expDenomId,
        marketId: 'KXDENA-26NOV-DISP',
        eventId: 'KXDENA-26NOV',
        probability: 0.65,
        forecastTimestamp: '2026-11-05T13:00:00.000Z',
        tempDir,
      });
      transitionContractLifecycle(db, {
        marketId: 'KXDENA-26NOV-DISP',
        toState: 'ACTIVE',
        reason: 'Active',
        actor: 'ee04_test',
      });
      transitionContractLifecycle(db, {
        marketId: 'KXDENA-26NOV-DISP',
        toState: 'SETTLEMENT_PENDING',
        reason: 'Pending',
        actor: 'ee04_test',
      });
      transitionContractLifecycle(db, {
        marketId: 'KXDENA-26NOV-DISP',
        toState: 'DISPUTED',
        reason: 'Disputed source',
        actor: 'ee04_test',
      });

      // Family KXDENB (5 discovered): 1 rejected, 1 abstained, 3 forecasted (2 settled RESOLVED, 1 VOIDED)
      registerDiscoveredContract(db, { marketId: 'KXDENB-26NOV-REJ' });
      transitionContractLifecycle(db, {
        marketId: 'KXDENB-26NOV-REJ',
        toState: 'AUDIT_PENDING',
        reason: 'Audit',
        actor: 'ee04_test',
      });
      transitionContractLifecycle(db, {
        marketId: 'KXDENB-26NOV-REJ',
        toState: 'REJECTED',
        reason: 'AUDITOR_AMBIGUOUS',
        actor: 'ee04_test',
      });

      advanceLifecycleToApproved(db, 'KXDENB-26NOV-ABS', '2026-11-05T10:00:00.000Z');
      persistDirectQuantEnsemble({
        db,
        cfg,
        experimentId: expDenomId,
        marketId: 'KXDENB-26NOV-ABS',
        eventId: 'KXDENB-26NOV',
        probability: null,
        forecastTimestamp: '2026-11-05T11:30:00.000Z',
        tempDir,
      });

      for (let i = 1; i <= 2; i += 1) {
        const mk = `KXDENB-26NOV-F${i}`;
        const fTs = `2026-11-05T14:0${i}:00.000Z`;
        advanceLifecycleToApproved(db, mk, '2026-11-05T10:00:00.000Z');
        insertSnapshot(db, {
          snapshotId: `snap-denb-f${i}`,
          eventTicker: 'KXDENB-26NOV',
          marketTicker: mk,
          yesBid: 0.45,
          yesAsk: 0.55,
          capturedAt: fTs,
        });
        persistDirectQuantEnsemble({
          db,
          cfg,
          experimentId: expDenomId,
          marketId: mk,
          eventId: 'KXDENB-26NOV',
          probability: i === 1 ? 0.8 : 0.2,
          forecastTimestamp: fTs,
          tempDir,
        });
        advanceApprovedToResolved(db, mk, '2026-11-06T14:00:00.000Z');
        insertSettlement(db, {
          settlementId: `settle-denb-f${i}`,
          eventTicker: 'KXDENB-26NOV',
          marketTicker: mk,
          outcome: i === 1 ? 'YES' : 'NO',
          settledAt: '2026-11-06T14:00:00.000Z',
        });
      }

      advanceLifecycleToApproved(db, 'KXDENB-26NOV-VOID', '2026-11-05T10:00:00.000Z');
      persistDirectQuantEnsemble({
        db,
        cfg,
        experimentId: expDenomId,
        marketId: 'KXDENB-26NOV-VOID',
        eventId: 'KXDENB-26NOV',
        probability: 0.6,
        forecastTimestamp: '2026-11-05T15:00:00.000Z',
        tempDir,
      });
      transitionContractLifecycle(db, {
        marketId: 'KXDENB-26NOV-VOID',
        toState: 'ACTIVE',
        reason: 'Active',
        actor: 'ee04_test',
      });
      transitionContractLifecycle(db, {
        marketId: 'KXDENB-26NOV-VOID',
        toState: 'VOIDED',
        reason: 'Cancelled',
        actor: 'ee04_test',
      });

      const denomReport = evaluateExperiment(db, expDenomId, {
        persistCalibratedForecasts: false,
        bootstrapIterations: 500,
      });

      assert.equal(denomReport.denominatorByFamily.length, 2);
      const famA = denomReport.denominatorByFamily.find((f) => f.eventFamilyId === 'KXDENA')!;
      const famB = denomReport.denominatorByFamily.find((f) => f.eventFamilyId === 'KXDENB')!;

      // KXDENA: 6 discovered, 1 rejected, 1 abstained, 4 forecasted, 4 settled (3 forecasted + 1 abstained), 3 settledForecasted, 1 disputed
      assert.equal(famA.discovered, 6);
      assert.equal(famA.rejectedByAudit, 1);
      assert.equal(famA.abstained, 1);
      assert.equal(famA.forecasted, 4);
      assert.equal(famA.settled, 4);
      assert.equal(famA.settledForecasted, 3);
      assert.equal(famA.settledScored, 3);
      assert.equal(famA.disputed, 1);
      assert.equal(famA.voided, 0);
      assert.ok(Math.abs(famA.coverage - 4 / 6) < 1e-12);

      // KXDENB: 5 discovered, 1 rejected, 1 abstained, 3 forecasted, 2 settled, 2 settledForecasted, 1 voided
      assert.equal(famB.discovered, 5);
      assert.equal(famB.rejectedByAudit, 1);
      assert.equal(famB.abstained, 1);
      assert.equal(famB.forecasted, 3);
      assert.equal(famB.settled, 2);
      assert.equal(famB.settledForecasted, 2);
      assert.equal(famB.settledScored, 2);
      assert.equal(famB.disputed, 0);
      assert.equal(famB.voided, 1);
      assert.ok(Math.abs(famB.coverage - 3 / 5) < 1e-12);

      // Totals & visible abstentions
      assert.equal(denomReport.denominatorTotals.discovered, 11);
      assert.equal(denomReport.denominatorTotals.rejectedByAudit, 2);
      assert.equal(denomReport.denominatorTotals.abstained, 2);
      assert.equal(denomReport.denominatorTotals.forecasted, 7);
      assert.equal(denomReport.denominatorTotals.settled, 6);
      assert.ok(Math.abs(denomReport.coverage - 7 / 11) < 1e-12);
      assert.deepEqual(
        denomReport.abstainedMarkets.map((a) => a.marketId).sort(),
        ['KXDENA-26NOV-ABS', 'KXDENB-26NOV-ABS']
      );

      console.log(
        'PASS [EE-04 (c)]: Per-family denominator accounting (discovered/rejected/abstained/forecasted/settled + coverage) verified.'
      );

      // -----------------------------------------------------------------------
      // (d) TEMPORAL ISOLATION: train-only fit, validation-Brier selection,
      //     tie-breaking order Beta > Platt > Temperature, zero future leakage
      // -----------------------------------------------------------------------
      const temporalSeries: CalibrationPoint[] = [];
      // 12 train points (overconfident upward-biased model: outputs 0.85/0.35 -> outcomes mostly match directional signal with upward bias)
      const trainSpec: Array<[number, BinaryOutcome]> = [
        [0.92, 1],
        [0.88, 1],
        [0.85, 0],
        [0.82, 1],
        [0.78, 0],
        [0.75, 1],
        [0.42, 0],
        [0.38, 0],
        [0.35, 1],
        [0.30, 0],
        [0.25, 0],
        [0.20, 0],
      ];
      // 6 validation points
      const valSpec: Array<[number, BinaryOutcome]> = [
        [0.86, 1],
        [0.80, 1],
        [0.72, 0],
        [0.36, 0],
        [0.28, 0],
        [0.22, 0],
      ];
      // 6 forward-test points with an EXTREME opposite future regime (all inverted outcomes!)
      const forwardOppositeSpec: Array<[number, BinaryOutcome]> = [
        [0.95, 0],
        [0.90, 0],
        [0.85, 0],
        [0.10, 1],
        [0.15, 1],
        [0.20, 1],
      ];
      const forwardAlignedSpec: Array<[number, BinaryOutcome]> = [
        [0.95, 1],
        [0.90, 1],
        [0.85, 1],
        [0.10, 0],
        [0.15, 0],
        [0.20, 0],
      ];

      const buildSeries = (future: Array<[number, BinaryOutcome]>): CalibrationPoint[] => {
        const all = [...trainSpec, ...valSpec, ...future];
        return all.map(([p, y], idx) => ({
          forecastTimestamp: new Date(Date.UTC(2026, 10, 1, idx, 0, 0)).toISOString(),
          probability: p,
          outcome: y,
          forecastId: `fc_temp_${idx}`,
          marketId: `KXTEMP-${idx}`,
        }));
      };

      const seriesOppositeFuture = buildSeries(forwardOppositeSpec);
      const seriesAlignedFuture = buildSeries(forwardAlignedSpec);

      // Intentionally shuffle input order to prove chronological sorting enforces strict time split
      const shuffledOpposite = [...seriesOppositeFuture].reverse();
      const calOpposite = runTemporallyIsolatedCalibration(shuffledOpposite, {
        splitFractions: { trainFraction: 0.5, validationFraction: 0.25, testFraction: 0.25 },
      });
      const calAligned = runTemporallyIsolatedCalibration(seriesAlignedFuture, {
        splitFractions: { trainFraction: 0.5, validationFraction: 0.25, testFraction: 0.25 },
      });

      assert.equal(calOpposite.status, 'COMPLETED');
      assert.equal(calOpposite.trainWindow?.count, 12);
      assert.equal(calOpposite.validationWindow?.count, 6);
      assert.equal(calOpposite.forwardTestWindow?.count, 6);

      // Strict temporal ordering invariant
      assert.ok(Date.parse(calOpposite.trainWindow!.end) < Date.parse(calOpposite.validationWindow!.start));
      assert.ok(
        Date.parse(calOpposite.validationWindow!.end) < Date.parse(calOpposite.forwardTestWindow!.start)
      );

      // Fitting on train ONLY: parameters must be IDENTICAL regardless of future outcomes
      assert.equal(calOpposite.selectedMethod, calAligned.selectedMethod);
      assert.deepEqual(calOpposite.selectedParameters, calAligned.selectedParameters);
      assert.deepEqual(calOpposite.validationResults, calAligned.validationResults);

      // Compare directly against standalone fit(trainOnly)
      const { train: trainOnly } = splitChronologically(seriesOppositeFuture, {
        trainFraction: 0.5,
        validationFraction: 0.25,
        testFraction: 0.25,
      });
      const standaloneCalibrators = createDefaultCalibrators();
      const trainOnlyWinner = standaloneCalibrators[calOpposite.selectedMethod!].fit(trainOnly);
      assert.deepEqual(calOpposite.selectedParameters, trainOnlyWinner.parameters);

      // Prove that leaking future opposite outcomes into fit() WOULD have changed parameters substantially
      const leakyFit = standaloneCalibrators[calOpposite.selectedMethod!].fit(seriesOppositeFuture);
      assert.notDeepEqual(
        calOpposite.selectedParameters,
        leakyFit.parameters,
        'Fitting on future data would have altered parameters; train-only isolation prevented leakage'
      );

      // Verify selected method equals the exact validation-Brier winner
      const minValBrier = Math.min(...calOpposite.validationResults.map((v) => v.validationBrier));
      const selectedValEntry = calOpposite.validationResults.find(
        (v) => v.method === calOpposite.selectedMethod
      )!;
      assert.ok(Math.abs(selectedValEntry.validationBrier - minValBrier) < 1e-12);

      // Verify deterministic tie-breaking order: Beta > Platt > Temperature
      const constantCalibrator = (
        method: 'beta' | 'platt' | 'temperature',
        outProb: number
      ): ProbabilityCalibrator => ({
        method,
        fit: (tr) => ({
          method,
          parameters: { fixed: outProb },
          trainSampleCount: tr.length,
          transform: () => outProb,
        }),
      });
      const tieAllThree = runTemporallyIsolatedCalibration(seriesAlignedFuture, {
        calibrators: {
          beta: constantCalibrator('beta', 0.5),
          platt: constantCalibrator('platt', 0.5),
          temperature: constantCalibrator('temperature', 0.5),
        },
      });
      assert.equal(tieAllThree.selectedMethod, 'beta');

      const tiePlattTemp = runTemporallyIsolatedCalibration(seriesAlignedFuture, {
        calibrators: {
          beta: constantCalibrator('beta', 0.99), // worse on validation
          platt: constantCalibrator('platt', 0.5),
          temperature: constantCalibrator('temperature', 0.5),
        },
      });
      assert.equal(tiePlattTemp.selectedMethod, 'platt');

      // Exercise all three calibrators individually to verify finite (0,1) outputs
      const betaFit = createBetaCalibrator().fit(trainOnly);
      const plattFit = createPlattCalibrator().fit(trainOnly);
      const tempFit = createTemperatureCalibrator().fit(trainOnly);
      for (const fitted of [betaFit, plattFit, tempFit]) {
        const pOut = fitted.transform(0.7);
        assert.ok(Number.isFinite(pOut) && pOut > 0 && pOut < 1);
      }

      // Silence unused helper variable lint check
      assert.equal(temporalSeries.length, 0);

      console.log(
        'PASS [EE-04 (d)]: Temporal isolation (train-only fit, validation-Brier selection, tie-breaking Beta > Platt > Temperature, zero future leakage) verified.'
      );

      // -----------------------------------------------------------------------
      // (e) CLUSTERED BOOTSTRAP: deterministic by experiment_id & resamples families
      // -----------------------------------------------------------------------
      const unequalFamilySamples: PairedScoringSample[] = [
        // FAM_SMALL: 1 market with modelBrier = 0.04, marketBrier = 0.34 -> diff = -0.30
        {
          marketId: 'SMALL-1',
          eventFamilyId: 'FAM_SMALL',
          forecastId: 'fc-s1',
          forecastTimestamp: '2026-11-10T01:00:00.000Z',
          modelProbability: 0.8, // (0.8 - 1)^2 = 0.04
          marketReferenceProbability: 1 - Math.sqrt(0.34), // diff = -0.30
          outcome: 1,
        },
        // FAM_LARGE: 9 markets each with modelBrier = 0.36, marketBrier = 0.26 -> diff = +0.10
        ...Array.from({ length: 9 }, (_, i) => ({
          marketId: `LARGE-${i + 1}`,
          eventFamilyId: 'FAM_LARGE',
          forecastId: `fc-l${i + 1}`,
          forecastTimestamp: `2026-11-10T0${i + 1}:10:00.000Z`,
          modelProbability: 0.4, // (0.4 - 1)^2 = 0.36
          marketReferenceProbability: 1 - Math.sqrt(0.26), // diff = +0.10
          outcome: 1 as BinaryOutcome,
        })),
      ];

      const bootRun1 = computeClusterBootstrapBrierDiffCI(
        unequalFamilySamples,
        'exp-cluster-det-seed',
        { iterations: 2000 }
      );
      const bootRun2 = computeClusterBootstrapBrierDiffCI(
        unequalFamilySamples,
        'exp-cluster-det-seed',
        { iterations: 2000 }
      );
      const bootDiffSeed = computeClusterBootstrapBrierDiffCI(
        unequalFamilySamples,
        'exp-cluster-other-seed',
        { iterations: 2000 }
      );

      // Deterministic for fixed experiment_id
      assert.deepEqual(bootRun1, bootRun2);
      assert.notEqual(bootRun1.seedHex, bootDiffSeed.seedHex);
      assert.equal(bootRun1.resampleUnit, 'event_family_id');
      assert.equal(bootRun1.clusterCount, 2);

      // Resample unit by construction: drawing 2 clusters with replacement from sizes {1, 9}
      // can ONLY yield replicate market counts {1+1=2, 1+9=10, 9+9=18} and ONLY 3 distinct values!
      assert.deepEqual([...bootRun1.distinctReplicateSampleSizes], [2, 10, 18]);
      assert.equal(bootRun1.distinctReplicateValuesCount, 3);
      assert.ok(Math.abs(bootRun1.pointEstimate! - (-0.3 + 9 * 0.1) / 10) < 1e-10);

      console.log(
        'PASS [EE-04 (e)]: Clustered bootstrap determinism and family-level resampling unit (sizes [2, 10, 18] & 3 distinct values) verified.'
      );

      // -----------------------------------------------------------------------
      // (f) & (g) GATE VERDICT (PASS / FAIL / INSUFFICIENT_DATA) + p_calibrated PERSISTENCE
      // -----------------------------------------------------------------------
      const populateMultiFamilyExperiment = (opts: {
        experimentId: string;
        familyPrefix: string;
        minSettledSample: number;
        totalMarkets: number;
        modelSkill: 'STRONG' | 'WEAK';
      }): void => {
        const families = [
          `${opts.familyPrefix}A`,
          `${opts.familyPrefix}B`,
          `${opts.familyPrefix}C`,
          `${opts.familyPrefix}D`,
        ];

        registerExperiment(db, {
          experimentId: opts.experimentId,
          title: `Gate Verdict Experiment (${opts.modelSkill})`,
          hypothesis: 'Model Brier strictly beats market Brier across families.',
          killCriteria: 'PASS iff forward Brier < market Brier AND 95% clustered CI upper < 0',
          sampleDefinition: JSON.stringify({
            eventFamilies: families,
            minSettledSample: opts.minSettledSample,
          }),
          modelVersion: 'ee04-fixture-v1',
          configHash,
        });
        transitionExperimentStatus(db, {
          experimentId: opts.experimentId,
          toStatus: 'RUNNING',
          reason: 'Start gate fixture',
        });

        for (let i = 0; i < opts.totalMarkets; i += 1) {
          const fam = families[i % families.length];
          const eventTicker = `${fam}-26NOV${String(i + 1).padStart(2, '0')}`;
          const marketId = `${eventTicker}-M1`;
          const outcome: 'YES' | 'NO' = i % 2 === 0 ? 'YES' : 'NO';

          const forecastTs = new Date(Date.UTC(2026, 10, 12, i, 0, 0)).toISOString();
          const snapTs = new Date(Date.UTC(2026, 10, 12, i, 0, 0) - 60_000).toISOString();
          const settleTs = new Date(Date.UTC(2026, 10, 20, i, 0, 0)).toISOString();

          advanceLifecycleToApproved(db, marketId, snapTs);

          // Strong model predicts well (0.85 for YES, 0.15 for NO) vs noisy market (0.45 / 0.55)
          // Weak model is uninformative (0.52 / 0.48 independent of outcome) vs accurate market (0.80 / 0.20)
          const modelProb =
            opts.modelSkill === 'STRONG'
              ? outcome === 'YES'
                ? 0.85
                : 0.15
              : i % 3 === 0
                ? 0.52
                : 0.48;
          const mktMid =
            opts.modelSkill === 'STRONG'
              ? outcome === 'YES'
                ? 0.45
                : 0.55
              : outcome === 'YES'
                ? 0.80
                : 0.20;

          insertSnapshot(db, {
            snapshotId: `snap-${opts.experimentId}-${i}`,
            eventTicker,
            marketTicker: marketId,
            yesBid: Number((mktMid - 0.02).toFixed(4)),
            yesAsk: Number((mktMid + 0.02).toFixed(4)),
            capturedAt: snapTs,
          });

          persistDirectQuantEnsemble({
            db,
            cfg,
            experimentId: opts.experimentId,
            marketId,
            eventId: eventTicker,
            probability: modelProb,
            forecastTimestamp: forecastTs,
            tempDir,
          });

          advanceApprovedToResolved(db, marketId, settleTs);
          insertSettlement(db, {
            settlementId: `settle-${opts.experimentId}-${i}`,
            eventTicker,
            marketTicker: marketId,
            outcome,
            settledAt: settleTs,
          });
        }
      };

      // 1. PASS fixture (24 settled markets across 4 families, minSettledSample = 12, strong model)
      const expPassId = 'exp-ee04-gate-pass';
      populateMultiFamilyExperiment({
        experimentId: expPassId,
        familyPrefix: 'KXPASS',
        minSettledSample: 12,
        totalMarkets: 24,
        modelSkill: 'STRONG',
      });

      // Snapshot original p_ensemble rows BEFORE evaluation so we can assert they are unchanged
      const originalForwardMarketId = 'KXPASSA-26NOV21-M1';
      const beforeRows = getForecastsForMarket(db, originalForwardMarketId);
      const originalEnsembleBefore = beforeRows.find((r) => r.forecastStage === 'p_ensemble')!;
      assert.ok(originalEnsembleBefore);

      const evaluator = createExperimentEvaluator(db);
      const passReport = evaluator.evaluateExperiment(expPassId, {
        calibratedAt: '2026-11-26T15:00:00.000Z',
      });

      assert.equal(passReport.gate.verdict, 'PASS');
      assert.equal(passReport.gate.requiredMinSettledSample, 12);
      assert.equal(passReport.gate.observedSettledScoredSample, 24);
      assert.equal(passReport.gate.forwardBrierStrictlyBelowMarket, true);
      assert.equal(passReport.gate.clusteredCiUpperBelowZero, true);
      assert.ok(passReport.gate.modelForwardBrier! < passReport.gate.marketForwardBrier!);
      assert.ok(passReport.gate.clusterBootstrapUpper95! < 0);

      // 2. FAIL fixture (24 settled markets across 4 families, minSettledSample = 12, weak model)
      const expFailId = 'exp-ee04-gate-fail';
      populateMultiFamilyExperiment({
        experimentId: expFailId,
        familyPrefix: 'KXFAIL',
        minSettledSample: 12,
        totalMarkets: 24,
        modelSkill: 'WEAK',
      });
      const failReport = evaluator.evaluateExperiment(expFailId, {
        calibratedAt: '2026-11-26T15:00:00.000Z',
      });
      assert.equal(failReport.gate.verdict, 'FAIL');
      assert.equal(failReport.gate.forwardBrierStrictlyBelowMarket, false);
      assert.equal(failReport.gate.clusteredCiUpperBelowZero, false);

      // 3. INSUFFICIENT_DATA fixture (only 12 settled markets, but registered sample_definition minimum = 50)
      const expInsuffId = 'exp-ee04-gate-insuff';
      populateMultiFamilyExperiment({
        experimentId: expInsuffId,
        familyPrefix: 'KXINS',
        minSettledSample: 50,
        totalMarkets: 12,
        modelSkill: 'STRONG',
      });
      const insuffReport = evaluator.evaluateExperiment(expInsuffId, {
        calibratedAt: '2026-11-26T15:00:00.000Z',
      });
      assert.equal(insuffReport.gate.verdict, 'INSUFFICIENT_DATA');
      assert.equal(insuffReport.gate.requiredMinSettledSample, 50);
      assert.equal(insuffReport.gate.observedSettledScoredSample, 12);

      console.log(
        'PASS [EE-04 (f)]: Kill-gate verdicts PASS, FAIL, and INSUFFICIENT_DATA verified against registered sample_definition.'
      );

      // -----------------------------------------------------------------------
      // (g) p_calibrated PERSISTENCE: stage='p_calibrated', full provenance,
      //     original records unchanged, append-only triggers enforced, idempotent
      // -----------------------------------------------------------------------
      assert.equal(passReport.persistedCalibratedForecasts.length, 6); // 25% of 24 = 6 forward-test markets

      for (const calRec of passReport.persistedCalibratedForecasts) {
        assert.equal(calRec.forecastStage, 'p_calibrated');
        assert.equal(calRec.status, 'FORECAST');
        assert.ok(calRec.probability !== null && calRec.probability > 0 && calRec.probability < 1);
        assert.equal(calRec.componentForecastIds.length, 1);

        const calMeta = calRec.featureMetadata?.calibration as
          | CalibrationProvenanceMetadata
          | undefined;
        assert.ok(calMeta, 'p_calibrated record must carry featureMetadata.calibration provenance');
        assert.equal(calMeta.method, passReport.calibration.selectedMethod);
        assert.equal(calMeta.sourceForecastId, calRec.componentForecastIds[0]);
        assert.deepEqual(calMeta.trainWindow, passReport.calibration.trainWindow);
        assert.deepEqual(calMeta.validationWindow, passReport.calibration.validationWindow);

        // Ensure market reference price is NEVER written into any forecast record
        const serializedRecord = JSON.stringify(calRec);
        assert.equal(/marketReference|yes_bid|yes_ask|yesBid|yesAsk/i.test(serializedRecord), false);
      }

      // Verify original p_ensemble record is 100% unchanged in SQLite
      const afterRows = getForecastsForMarket(db, originalForwardMarketId);
      const originalEnsembleAfter = afterRows.find(
        (r) => r.forecastId === originalEnsembleBefore.forecastId
      )!;
      assert.deepEqual(originalEnsembleAfter, originalEnsembleBefore);
      assert.equal(
        afterRows.some((r) => r.forecastStage === 'p_calibrated'),
        true
      );

      // Verify append-only immutability triggers still protect probability_forecasts after Migration v5
      const firstCalibratedId = passReport.persistedCalibratedForecasts[0].forecastId;
      assert.throws(
        () =>
          db
            .prepare('UPDATE probability_forecasts SET probability = 0.5 WHERE forecast_id = ?')
            .run(firstCalibratedId),
        /immutable: UPDATE forbidden/i
      );
      assert.throws(
        () =>
          db
            .prepare('DELETE FROM probability_forecasts WHERE forecast_id = ?')
            .run(firstCalibratedId),
        /immutable: DELETE forbidden/i
      );

      // Re-evaluating the same experiment is deterministic & idempotent (does not fail or duplicate rows)
      const passReportSecondRun = evaluator.evaluateExperiment(expPassId, {
        calibratedAt: '2026-11-26T15:00:00.000Z',
      });
      assert.deepEqual(
        passReportSecondRun.persistedCalibratedForecasts.map((r) => r.forecastId),
        passReport.persistedCalibratedForecasts.map((r) => r.forecastId)
      );
      assert.equal(
        getForecastsForMarket(db, originalForwardMarketId).filter(
          (r) => r.forecastStage === 'p_calibrated'
        ).length,
        1
      );

      console.log(
        'PASS [EE-04 (g)]: p_calibrated persistence, full provenance, original record immutability, and append-only triggers verified.'
      );
    } finally {
      db.close();
    }

    // -------------------------------------------------------------------------
    // (h) ISOLATION: evaluation module is NOT imported by eventedge/forecasting/
    // -------------------------------------------------------------------------
    const forecastingDir = path.resolve('eventedge/forecasting');
    const forecastingFiles = fs
      .readdirSync(forecastingDir)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => path.join(forecastingDir, f));
    assert.ok(forecastingFiles.length >= 4);

    const forbiddenEvaluationPatterns: ReadonlyArray<{ label: string; regex: RegExp }> = [
      { label: 'evaluation module import', regex: /from\s+['"][^'"]*evaluation[^'"]*['"]/ },
      { label: 'outcomeJoin import', regex: /from\s+['"][^'"]*outcomeJoin[^'"]*['"]/ },
      { label: 'scoring import', regex: /from\s+['"][^'"]*scoring[^'"]*['"]/ },
      { label: 'calibration import', regex: /from\s+['"][^'"]*calibration[^'"]*['"]/ },
      { label: 'killGate import', regex: /from\s+['"][^'"]*killGate[^'"]*['"]/ },
      { label: 'evaluateExperiment call', regex: /\bevaluateExperiment\s*\(/ },
      { label: 'market_snapshots reference', regex: /\bmarket_snapshots\b/ },
    ];

    for (const filePath of forecastingFiles) {
      const rawSrc = fs.readFileSync(filePath, 'utf-8');
      const codeOnly = rawSrc
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      for (const check of forbiddenEvaluationPatterns) {
        assert.equal(
          check.regex.test(codeOnly),
          false,
          `Evaluation isolation violation: ${path.basename(filePath)} matched forbidden pattern (${check.label})`
        );
      }
    }

    console.log(
      'PASS [EE-04 (h)]: Structural import scan confirmed eventedge/forecasting/ does not import eventedge/evaluation/ or market_snapshots.'
    );
    console.log('\nALL EVENTEDGE EE-04 TESTS PASSED.');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

runEe04Tests();
