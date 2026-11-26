import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ContractNotEligibleForForecastError,
  EVENTEDGE_MIGRATIONS,
  EventEdgeLiveModeDisabledError,
  ExperimentAlreadyExistsError,
  ForecastInvariantViolationError,
  IllegalContractLifecycleTransitionError,
  IllegalExperimentStatusTransitionError,
  RULES_REVISED_REASON,
  UnregisteredExperimentError,
  auditContractInLifecycle,
  auditContractResolution,
  computeForecastConfigHash,
  createEventEdgeConfig,
  createForecastRepository,
  createReferenceFeatureTransformQuantEstimator,
  createReferenceLaplaceBaseRateEstimator,
  evaluatePriceBlindForecast,
  getContractLifecycleHistory,
  getContractLifecycleState,
  getEnsembleForMarket,
  getExperiment,
  getExperimentStatusHistory,
  getForecastsForExperiment,
  getForecastsForMarket,
  initializeEventEdgeLedger,
  isContractEligibleForForecast,
  normalizeKalshiMarketToSnapshot,
  persistSettlementRuleVersion,
  recordRuleVersionWithLifecycleHook,
  registerDiscoveredContract,
  registerExperiment,
  saveForecast,
  transitionContractLifecycle,
  transitionExperimentStatus,
  type ApprovedContractInput,
  type ContractLifecycleState,
  type ForecastRecord,
  type ReferenceClass,
  type ResearchDataSnapshot,
} from '../index';
import {
  FIXTURE_NOW_ISO,
  SAMPLE_KALSHI_EVENTS_PAGE_1,
  SAMPLE_KALSHI_STANDALONE_MARKETS,
} from './fixtures/kalshiPayloads';

const SAMPLE_REFERENCE_CLASS: ReferenceClass = Object.freeze({
  definition: 'US monthly CPI-U YoY prints exceeding threshold',
  inclusionCriteria: 'Initial official BLS CPI-U release',
  sampleCount: 18,
  positiveCount: 11,
  timeWindow: '2025-05-01/2026-10-31',
  source: 'U.S. Bureau of Labor Statistics',
});

const SAMPLE_RESEARCH_SNAPSHOT: ResearchDataSnapshot = Object.freeze({
  dataSnapshotId: 'rsnap_ee03_cpi_001',
  capturedAt: FIXTURE_NOW_ISO,
  features: Object.freeze({
    cpi_nowcast_minus_strike_pp: 0.5,
  }),
});

function buildApprovedContract(marketId: string, eventId: string, ruleVersionId: string): ApprovedContractInput {
  return Object.freeze({
    marketId,
    eventId,
    category: 'Economics',
    marketTerms: 'Above 2.8% YoY CPI-U',
    closeTimeUtc: '2026-12-01T13:25:00.000Z',
    expirationTimeUtc: '2026-12-01T14:00:00.000Z',
    ruleVersionId,
    ruleHash: 'rule-hash-cpi',
    settlementSource: 'U.S. Bureau of Labor Statistics',
    auditStatus: 'CLEAR' as const,
  });
}

function runEe03Tests(): void {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eventedge-ee03-'));

  try {
    // Confirm LIVE stays hard-disabled
    assert.throws(
      () => createEventEdgeConfig({ mode: 'LIVE' }, {}),
      EventEdgeLiveModeDisabledError
    );

    const cfg = createEventEdgeConfig(
      {
        ledgerDbPath: path.join(tempDir, 'ee03_ledger.sqlite'),
        forecasting: {
          ensembleVersion: 'ee-ensemble-v1.0.0',
          ensembleWeights: { p_base: 0.5, p_quant: 0.5 },
        },
      },
      {}
    );
    const configHash = computeForecastConfigHash(cfg.forecasting);
    const refBase = createReferenceLaplaceBaseRateEstimator();
    const refQuant = createReferenceFeatureTransformQuantEstimator({
      featureName: 'cpi_nowcast_minus_strike_pp',
      center: 0,
      scale: 0.5,
    });

    const { db, migrationResult } = initializeEventEdgeLedger(cfg.ledgerDbPath);
    try {
      assert.equal(migrationResult.appliedVersions.includes(4), true);
      assert.equal(
        migrationResult.currentVersion,
        EVENTEDGE_MIGRATIONS[EVENTEDGE_MIGRATIONS.length - 1].version
      );

      // -----------------------------------------------------------------------
      // (a) EXPERIMENT REGISTRY: create, reject duplicate, legal transitions,
      //     reject illegal transitions, status history written, raw mutations blocked,
      //     reject forecast under unregistered experiment_id
      // -----------------------------------------------------------------------
      const expCompleted = registerExperiment(db, {
        experimentId: 'exp-ee03-cpi-01',
        title: 'CPI Laplace + Nowcast Logistic Baseline',
        hypothesis:
          'Price-blind reference ensemble achieves Brier score < 0.22 across 50 resolved CPI-U contracts.',
        killCriteria: 'Kill immediately if Brier score > 0.28 after 20 resolved contracts.',
        sampleDefinition:
          'Event family KXCPI; denominator = all CLEAR contracts reaching RESOLVED; frozen N = 50.',
        modelVersion: 'ee-ensemble-v1.0.0',
        configHash,
        notes: 'Initial EE-03 registry verification experiment',
        registeredAt: '2026-11-26T15:00:00.000Z',
      });
      assert.equal(expCompleted.status, 'REGISTERED');
      assert.equal(getExperiment(db, 'exp-ee03-cpi-01')?.hypothesis, expCompleted.hypothesis);

      // Duplicate registration rejected with named error
      assert.throws(
        () =>
          registerExperiment(db, {
            experimentId: 'exp-ee03-cpi-01',
            title: 'Duplicate',
            hypothesis: 'Duplicate',
            killCriteria: 'None',
            sampleDefinition: 'KXCPI N=10',
            modelVersion: 'v1',
            configHash,
          }),
        ExperimentAlreadyExistsError
      );

      // Direct raw UPDATE of non-status field must ABORT via trigger
      assert.throws(
        () =>
          db
            .prepare("UPDATE experiments SET hypothesis = 'tampered' WHERE experiment_id = ?")
            .run('exp-ee03-cpi-01'),
        /immutable: UPDATE forbidden/i
      );

      // Direct raw UPDATE of status bypassing transitionExperimentStatus (no history row) must ABORT
      assert.throws(
        () =>
          db
            .prepare("UPDATE experiments SET status = 'RUNNING' WHERE experiment_id = ?")
            .run('exp-ee03-cpi-01'),
        /without experiment_status_history forbidden/i
      );

      // Direct raw DELETE on experiments must ABORT
      assert.throws(
        () => db.prepare('DELETE FROM experiments WHERE experiment_id = ?').run('exp-ee03-cpi-01'),
        /immutable: DELETE forbidden/i
      );

      // Illegal transitions from REGISTERED: REGISTERED -> COMPLETED and REGISTERED -> KILLED
      assert.throws(
        () =>
          transitionExperimentStatus(db, {
            experimentId: 'exp-ee03-cpi-01',
            toStatus: 'COMPLETED',
            reason: 'Skip RUNNING',
          }),
        IllegalExperimentStatusTransitionError
      );
      assert.throws(
        () =>
          transitionExperimentStatus(db, {
            experimentId: 'exp-ee03-cpi-01',
            toStatus: 'KILLED',
            reason: 'Skip RUNNING',
          }),
        IllegalExperimentStatusTransitionError
      );

      // Legal transition: REGISTERED -> RUNNING -> COMPLETED
      const toRunning = transitionExperimentStatus(db, {
        experimentId: 'exp-ee03-cpi-01',
        toStatus: 'RUNNING',
        reason: 'Approved to begin OBSERVE data collection',
        changedAt: '2026-11-26T15:05:00.000Z',
      });
      assert.equal(toRunning.experiment.status, 'RUNNING');
      assert.equal(toRunning.historyEntry.fromStatus, 'REGISTERED');
      assert.equal(toRunning.historyEntry.toStatus, 'RUNNING');

      const toCompleted = transitionExperimentStatus(db, {
        experimentId: 'exp-ee03-cpi-01',
        toStatus: 'COMPLETED',
        reason: 'Reached frozen sample size N=50',
        changedAt: '2026-11-26T15:10:00.000Z',
      });
      assert.equal(toCompleted.experiment.status, 'COMPLETED');

      // Illegal transition: COMPLETED -> RUNNING rejected with named error
      assert.throws(
        () =>
          transitionExperimentStatus(db, {
            experimentId: 'exp-ee03-cpi-01',
            toStatus: 'RUNNING',
            reason: 'Cannot reopen completed experiment',
          }),
        IllegalExperimentStatusTransitionError
      );

      // Verify status history rows written and immutable
      const exp1History = getExperimentStatusHistory(db, 'exp-ee03-cpi-01');
      assert.equal(exp1History.length, 2);
      assert.deepEqual(
        exp1History.map((h) => `${h.fromStatus}->${h.toStatus}`),
        ['REGISTERED->RUNNING', 'RUNNING->COMPLETED']
      );
      assert.throws(
        () =>
          db
            .prepare("UPDATE experiment_status_history SET reason = 'edit' WHERE history_id = ?")
            .run(exp1History[0].historyId),
        /immutable: UPDATE forbidden/i
      );

      // Legal transition: REGISTERED -> RUNNING -> KILLED, then KILLED -> RUNNING rejected
      registerExperiment(db, {
        experimentId: 'exp-ee03-kill-02',
        title: 'Experiment to test KILLED terminal state',
        hypothesis: 'Test hypothesis',
        killCriteria: 'Kill on test trigger',
        sampleDefinition: 'KXFED N=20',
        modelVersion: 'ee-ensemble-v1.0.0',
        configHash,
      });
      transitionExperimentStatus(db, {
        experimentId: 'exp-ee03-kill-02',
        toStatus: 'RUNNING',
        reason: 'Started',
      });
      const killed = transitionExperimentStatus(db, {
        experimentId: 'exp-ee03-kill-02',
        toStatus: 'KILLED',
        reason: 'Kill criteria tripped',
      });
      assert.equal(killed.experiment.status, 'KILLED');
      assert.throws(
        () =>
          transitionExperimentStatus(db, {
            experimentId: 'exp-ee03-kill-02',
            toStatus: 'RUNNING',
            reason: 'Cannot resurrect killed experiment',
          }),
        IllegalExperimentStatusTransitionError
      );

      // Register an active RUNNING experiment for forecast persistence tests
      registerExperiment(db, {
        experimentId: 'exp-ee03-active',
        title: 'Active Forecast Persistence Experiment',
        hypothesis: 'Reference estimators remain well-calibrated on CLEAR CPI contracts.',
        killCriteria: 'Brier > 0.30 at N=25',
        sampleDefinition: 'KXCPI CLEAR contracts, N=25',
        modelVersion: 'ee-ensemble-v1.0.0',
        configHash,
      });
      transitionExperimentStatus(db, {
        experimentId: 'exp-ee03-active',
        toStatus: 'RUNNING',
        reason: 'Active run started',
      });

      // Prepare an APPROVED contract first so we isolate the UnregisteredExperimentError check
      const cpiEvent = SAMPLE_KALSHI_EVENTS_PAGE_1.events[0];
      const cpiMarket = cpiEvent.markets![0];
      const cpiSnapshot = normalizeKalshiMarketToSnapshot(cpiMarket, cpiEvent, FIXTURE_NOW_ISO);
      registerDiscoveredContract(db, { marketId: cpiSnapshot.marketTicker });
      transitionContractLifecycle(db, {
        marketId: cpiSnapshot.marketTicker,
        toState: 'AUDIT_PENDING',
        reason: 'Queued for resolution audit',
        actor: 'ee03_test',
      });
      const cpiAuditLifecycle = auditContractInLifecycle(db, cpiSnapshot, {
        auditedAt: FIXTURE_NOW_ISO,
      });
      assert.equal(cpiAuditLifecycle.transition.toState, 'APPROVED');

      const unregisteredEval = evaluatePriceBlindForecast({
        experimentId: 'exp-DOES-NOT-EXIST',
        contract: buildApprovedContract(
          cpiSnapshot.marketTicker,
          cpiSnapshot.eventTicker,
          cpiAuditLifecycle.ruleVersion.ruleVersionId
        ),
        config: cfg,
        researchSnapshot: SAMPLE_RESEARCH_SNAPSHOT,
        referenceClass: SAMPLE_REFERENCE_CLASS,
        baseRateEstimator: refBase,
        quantEstimator: refQuant,
        forecastTimestamp: FIXTURE_NOW_ISO,
        repoRootDir: tempDir,
      });

      assert.throws(
        () => saveForecast(db, unregisteredEval.pBase),
        UnregisteredExperimentError,
        'saveForecast must reject an unregistered experiment_id'
      );

      console.log(
        'PASS [EE-03 (a)]: Experiment registry creation, legal/illegal status transitions, status history, immutability triggers, and unregistered-experiment rejection verified.'
      );

      // -----------------------------------------------------------------------
      // (b) FORECAST PERSISTENCE LAYER: save & read back p_base, p_quant, p_ensemble,
      //     getForecastsForExperiment, getEnsembleForMarket, invariant re-check,
      //     no update/delete methods, raw UPDATE/DELETE aborts via trigger
      // -----------------------------------------------------------------------
      const repo = createForecastRepository(db);
      // Verify repository exposes NO update or delete methods
      const repoKeys = Object.keys(repo).sort();
      assert.deepEqual(repoKeys, [
        'getEnsembleForMarket',
        'getForecastsForExperiment',
        'getForecastsForMarket',
        'saveForecast',
      ]);

      // Before saving any forecast, getEnsembleForMarket returns null
      assert.equal(repo.getEnsembleForMarket(cpiSnapshot.marketTicker), null);

      const validEval = evaluatePriceBlindForecast({
        experimentId: 'exp-ee03-active',
        contract: buildApprovedContract(
          cpiSnapshot.marketTicker,
          cpiSnapshot.eventTicker,
          cpiAuditLifecycle.ruleVersion.ruleVersionId
        ),
        config: cfg,
        researchSnapshot: SAMPLE_RESEARCH_SNAPSHOT,
        referenceClass: SAMPLE_REFERENCE_CLASS,
        baseRateEstimator: refBase,
        quantEstimator: refQuant,
        forecastTimestamp: FIXTURE_NOW_ISO,
        repoRootDir: tempDir,
      });

      repo.saveForecast(validEval.pBase);
      repo.saveForecast(validEval.pQuant);
      repo.saveForecast(validEval.pEnsemble);

      const marketForecasts = getForecastsForMarket(db, cpiSnapshot.marketTicker);
      assert.equal(marketForecasts.length, 3);
      assert.deepEqual(
        marketForecasts.map((f) => f.forecastStage),
        ['p_base', 'p_quant', 'p_ensemble']
      );

      const expForecasts = getForecastsForExperiment(db, 'exp-ee03-active');
      assert.equal(expForecasts.length, 3);
      assert.deepEqual(
        expForecasts.map((f) => f.forecastId),
        [validEval.pBase.forecastId, validEval.pQuant.forecastId, validEval.pEnsemble.forecastId]
      );

      const ensemble = getEnsembleForMarket(db, cpiSnapshot.marketTicker);
      assert.ok(ensemble);
      assert.equal(ensemble.forecastStage, 'p_ensemble');
      assert.equal(ensemble.forecastId, validEval.pEnsemble.forecastId);
      assert.equal(ensemble.probability, validEval.pEnsemble.probability);

      // Re-checking EE-02 invariants at the persistence boundary rejects forged invalid records
      const forgedOutOfRange: ForecastRecord = {
        ...validEval.pQuant,
        forecastId: 'fc_forged_oor',
        probability: 1.25,
      };
      assert.throws(
        () => repo.saveForecast(forgedOutOfRange),
        ForecastInvariantViolationError
      );

      const forgedUnjustifiedOne: ForecastRecord = {
        ...validEval.pQuant,
        forecastId: 'fc_forged_one',
        probability: 1.0,
        extremeProbabilityJustified: false,
        extremeProbabilityJustification: null,
      };
      assert.throws(
        () => repo.saveForecast(forgedUnjustifiedOne),
        ForecastInvariantViolationError
      );

      const forgedAbstainedWithProb: ForecastRecord = {
        ...validEval.pQuant,
        forecastId: 'fc_forged_abstain',
        status: 'ABSTAINED',
        probability: 0.5,
        abstentionReasons: [{ code: 'ESTIMATOR_ABSTAINED', detail: 'bad' }],
      };
      assert.throws(
        () => repo.saveForecast(forgedAbstainedWithProb),
        ForecastInvariantViolationError
      );

      // Raw UPDATE / DELETE on probability_forecasts aborts via EE-00/EE-02 triggers
      assert.throws(
        () =>
          db
            .prepare('UPDATE probability_forecasts SET probability = 0.01 WHERE forecast_id = ?')
            .run(validEval.pEnsemble.forecastId),
        /immutable: UPDATE forbidden/i
      );
      assert.throws(
        () =>
          db
            .prepare('DELETE FROM probability_forecasts WHERE forecast_id = ?')
            .run(validEval.pEnsemble.forecastId),
        /immutable: DELETE forbidden/i
      );

      console.log(
        'PASS [EE-03 (b)]: Forecast persistence save/read (market, experiment, ensemble), invariant re-check, and append-only triggers verified.'
      );

      // -----------------------------------------------------------------------
      // (c) RESOLUTION LIFECYCLE: full happy path, illegal jumps rejected,
      //     DISPUTED and VOIDED reachable ONLY from their allowed states
      // -----------------------------------------------------------------------
      const happyMarket = 'KXLIFE-HAPPY-01';
      registerDiscoveredContract(db, { marketId: happyMarket });
      assert.equal(getContractLifecycleState(db, happyMarket), 'DISCOVERED');

      // Illegal jump: DISCOVERED -> ACTIVE rejected
      assert.throws(
        () =>
          transitionContractLifecycle(db, {
            marketId: happyMarket,
            toState: 'ACTIVE',
            reason: 'Illegal jump',
            actor: 'ee03_test',
          }),
        IllegalContractLifecycleTransitionError
      );

      // Illegal jump: DISCOVERED -> DISPUTED and DISCOVERED -> VOIDED rejected
      assert.throws(
        () =>
          transitionContractLifecycle(db, {
            marketId: happyMarket,
            toState: 'DISPUTED',
            reason: 'Illegal',
            actor: 'ee03_test',
          }),
        IllegalContractLifecycleTransitionError
      );
      assert.throws(
        () =>
          transitionContractLifecycle(db, {
            marketId: happyMarket,
            toState: 'VOIDED',
            reason: 'Illegal',
            actor: 'ee03_test',
          }),
        IllegalContractLifecycleTransitionError
      );

      // Full happy path: DISCOVERED -> AUDIT_PENDING -> APPROVED -> ACTIVE -> SETTLEMENT_PENDING -> RESOLVED
      const happySteps: Array<{ to: ContractLifecycleState; reason: string }> = [
        { to: 'AUDIT_PENDING', reason: 'Entered audit queue' },
        { to: 'APPROVED', reason: 'Cleared resolution audit' },
        { to: 'ACTIVE', reason: 'Activated for forecasting' },
        { to: 'SETTLEMENT_PENDING', reason: 'Market closed; awaiting venue settlement' },
        { to: 'RESOLVED', reason: 'Official settlement confirmed' },
      ];
      for (const step of happySteps) {
        const t = transitionContractLifecycle(db, {
          marketId: happyMarket,
          toState: step.to,
          reason: step.reason,
          actor: 'ee03_test',
        });
        assert.equal(t.toState, step.to);
      }
      assert.equal(getContractLifecycleState(db, happyMarket), 'RESOLVED');

      // Illegal jump: RESOLVED -> ACTIVE and RESOLVED -> VOIDED rejected
      assert.throws(
        () =>
          transitionContractLifecycle(db, {
            marketId: happyMarket,
            toState: 'ACTIVE',
            reason: 'Cannot reactivate resolved contract',
            actor: 'ee03_test',
          }),
        IllegalContractLifecycleTransitionError
      );
      assert.throws(
        () =>
          transitionContractLifecycle(db, {
            marketId: happyMarket,
            toState: 'VOIDED',
            reason: 'Cannot void resolved contract',
            actor: 'ee03_test',
          }),
        IllegalContractLifecycleTransitionError
      );

      // Legal: RESOLVED -> DISPUTED
      const resolvedToDisputed = transitionContractLifecycle(db, {
        marketId: happyMarket,
        toState: 'DISPUTED',
        reason: 'Post-resolution dispute filed',
        actor: 'ee03_test',
      });
      assert.equal(resolvedToDisputed.toState, 'DISPUTED');

      // Verify full append-only lifecycle history & trigger protection
      const happyHistory = getContractLifecycleHistory(db, happyMarket);
      assert.deepEqual(
        happyHistory.map((h) => h.toState),
        [
          'DISCOVERED',
          'AUDIT_PENDING',
          'APPROVED',
          'ACTIVE',
          'SETTLEMENT_PENDING',
          'RESOLVED',
          'DISPUTED',
        ]
      );
      assert.throws(
        () =>
          db
            .prepare("UPDATE contract_lifecycle_history SET reason = 'edit' WHERE transition_id = ?")
            .run(happyHistory[0].transitionId),
        /immutable: UPDATE forbidden/i
      );
      assert.throws(
        () =>
          db
            .prepare('DELETE FROM contract_lifecycle_history WHERE transition_id = ?')
            .run(happyHistory[0].transitionId),
        /immutable: DELETE forbidden/i
      );

      // Verify DISPUTED reachable from SETTLEMENT_PENDING (and NOT from APPROVED/ACTIVE)
      const dispMarket = 'KXLIFE-DISPUTE-02';
      registerDiscoveredContract(db, { marketId: dispMarket });
      transitionContractLifecycle(db, {
        marketId: dispMarket,
        toState: 'AUDIT_PENDING',
        reason: 'Audit',
        actor: 'ee03_test',
      });
      transitionContractLifecycle(db, {
        marketId: dispMarket,
        toState: 'APPROVED',
        reason: 'Approved',
        actor: 'ee03_test',
      });
      assert.throws(
        () =>
          transitionContractLifecycle(db, {
            marketId: dispMarket,
            toState: 'DISPUTED',
            reason: 'Illegal from APPROVED',
            actor: 'ee03_test',
          }),
        IllegalContractLifecycleTransitionError
      );
      assert.throws(
        () =>
          transitionContractLifecycle(db, {
            marketId: dispMarket,
            toState: 'VOIDED',
            reason: 'Illegal from APPROVED',
            actor: 'ee03_test',
          }),
        IllegalContractLifecycleTransitionError
      );
      transitionContractLifecycle(db, {
        marketId: dispMarket,
        toState: 'ACTIVE',
        reason: 'Active',
        actor: 'ee03_test',
      });
      assert.throws(
        () =>
          transitionContractLifecycle(db, {
            marketId: dispMarket,
            toState: 'DISPUTED',
            reason: 'Illegal from ACTIVE',
            actor: 'ee03_test',
          }),
        IllegalContractLifecycleTransitionError
      );
      transitionContractLifecycle(db, {
        marketId: dispMarket,
        toState: 'SETTLEMENT_PENDING',
        reason: 'Pending settlement',
        actor: 'ee03_test',
      });
      transitionContractLifecycle(db, {
        marketId: dispMarket,
        toState: 'DISPUTED',
        reason: 'Settlement source contested',
        actor: 'ee03_test',
      });
      assert.equal(getContractLifecycleState(db, dispMarket), 'DISPUTED');

      // Verify VOIDED reachable from ACTIVE and from SETTLEMENT_PENDING
      const voidFromActive = 'KXLIFE-VOID-ACTIVE';
      registerDiscoveredContract(db, { marketId: voidFromActive });
      transitionContractLifecycle(db, {
        marketId: voidFromActive,
        toState: 'AUDIT_PENDING',
        reason: 'Audit',
        actor: 'ee03_test',
      });
      transitionContractLifecycle(db, {
        marketId: voidFromActive,
        toState: 'APPROVED',
        reason: 'Approved',
        actor: 'ee03_test',
      });
      transitionContractLifecycle(db, {
        marketId: voidFromActive,
        toState: 'ACTIVE',
        reason: 'Active',
        actor: 'ee03_test',
      });
      transitionContractLifecycle(db, {
        marketId: voidFromActive,
        toState: 'VOIDED',
        reason: 'Exchange voided event prior to close',
        actor: 'ee03_test',
      });
      assert.equal(getContractLifecycleState(db, voidFromActive), 'VOIDED');

      const voidFromPending = 'KXLIFE-VOID-PENDING';
      registerDiscoveredContract(db, { marketId: voidFromPending });
      transitionContractLifecycle(db, {
        marketId: voidFromPending,
        toState: 'AUDIT_PENDING',
        reason: 'Audit',
        actor: 'ee03_test',
      });
      transitionContractLifecycle(db, {
        marketId: voidFromPending,
        toState: 'APPROVED',
        reason: 'Approved',
        actor: 'ee03_test',
      });
      transitionContractLifecycle(db, {
        marketId: voidFromPending,
        toState: 'ACTIVE',
        reason: 'Active',
        actor: 'ee03_test',
      });
      transitionContractLifecycle(db, {
        marketId: voidFromPending,
        toState: 'SETTLEMENT_PENDING',
        reason: 'Pending',
        actor: 'ee03_test',
      });
      transitionContractLifecycle(db, {
        marketId: voidFromPending,
        toState: 'VOIDED',
        reason: 'Exchange voided during settlement',
        actor: 'ee03_test',
      });
      assert.equal(getContractLifecycleState(db, voidFromPending), 'VOIDED');

      console.log(
        'PASS [EE-03 (c)]: Contract lifecycle happy path, illegal jump rejections, DISPUTED/VOIDED guards, and append-only history verified.'
      );

      // -----------------------------------------------------------------------
      // (d) AUDITOR BINDING: CLEAR verdict approves; AMBIGUOUS verdict rejects
      //     with auditor reason recorded; REJECTED -> ACTIVE rejected
      // -----------------------------------------------------------------------
      const fedEvent = SAMPLE_KALSHI_EVENTS_PAGE_1.events[1];
      const fedMarket = fedEvent.markets![0];
      const fedSnapshot = normalizeKalshiMarketToSnapshot(fedMarket, fedEvent, FIXTURE_NOW_ISO);
      registerDiscoveredContract(db, { marketId: fedSnapshot.marketTicker });
      transitionContractLifecycle(db, {
        marketId: fedSnapshot.marketTicker,
        toState: 'AUDIT_PENDING',
        reason: 'Queued for EE-01 auditor',
        actor: 'ee03_test',
      });
      const clearBinding = auditContractInLifecycle(db, fedSnapshot, {
        auditedAt: FIXTURE_NOW_ISO,
      });
      assert.equal(clearBinding.audit.status, 'CLEAR');
      assert.equal(clearBinding.transition.fromState, 'AUDIT_PENDING');
      assert.equal(clearBinding.transition.toState, 'APPROVED');
      assert.equal(clearBinding.transition.ruleVersionId, clearBinding.ruleVersion.ruleVersionId);
      assert.equal(getContractLifecycleState(db, fedSnapshot.marketTicker), 'APPROVED');

      // Ambiguous fixture (conflicting & unofficial sources) -> REJECTED with reasons recorded
      const ambMarket = SAMPLE_KALSHI_STANDALONE_MARKETS.markets[0];
      const ambSnapshot = normalizeKalshiMarketToSnapshot(ambMarket, null, FIXTURE_NOW_ISO);
      registerDiscoveredContract(db, { marketId: ambSnapshot.marketTicker });
      transitionContractLifecycle(db, {
        marketId: ambSnapshot.marketTicker,
        toState: 'AUDIT_PENDING',
        reason: 'Queued for EE-01 auditor',
        actor: 'ee03_test',
      });
      const ambBinding = auditContractInLifecycle(db, ambSnapshot, {
        auditedAt: FIXTURE_NOW_ISO,
      });
      assert.equal(ambBinding.audit.status, 'AMBIGUOUS');
      assert.equal(ambBinding.transition.fromState, 'AUDIT_PENDING');
      assert.equal(ambBinding.transition.toState, 'REJECTED');
      assert.match(ambBinding.transition.reason, /MULTIPLE_CONFLICTING_SOURCES/);
      assert.match(ambBinding.transition.reason, /UNOFFICIAL_OR_UNVERIFIED_SOURCE/);
      assert.equal(getContractLifecycleState(db, ambSnapshot.marketTicker), 'REJECTED');

      // Illegal jump: REJECTED -> ACTIVE rejected
      assert.throws(
        () =>
          transitionContractLifecycle(db, {
            marketId: ambSnapshot.marketTicker,
            toState: 'ACTIVE',
            reason: 'Illegal jump from REJECTED',
            actor: 'ee03_test',
          }),
        IllegalContractLifecycleTransitionError
      );

      console.log(
        'PASS [EE-03 (d)]: EE-01 auditor binding approves CLEAR contracts and rejects AMBIGUOUS contracts with reasons.'
      );

      // -----------------------------------------------------------------------
      // (e) RULES REVISION HOOK: new settlement_rule_versions row for an ACTIVE
      //     (or APPROVED) contract returns it to AUDIT_PENDING with RULES_REVISED
      //     and new rule_version_id recorded in history
      // -----------------------------------------------------------------------
      // Move CPI contract from APPROVED -> ACTIVE
      transitionContractLifecycle(db, {
        marketId: cpiSnapshot.marketTicker,
        toState: 'ACTIVE',
        reason: 'Promoted to ACTIVE',
        actor: 'ee03_test',
      });
      assert.equal(getContractLifecycleState(db, cpiSnapshot.marketTicker), 'ACTIVE');

      // Create a revised rules snapshot for the ACTIVE CPI contract
      const revisedCpiMarket = {
        ...cpiMarket,
        rules_primary:
          'If the U.S. Bureau of Labor Statistics reports that the 12-month percentage change in CPI-U for November 2026 is strictly greater than 2.9% (revised cutoff), then the market resolves to Yes. Otherwise, the market resolves to No.',
      };
      const revisedSnap = normalizeKalshiMarketToSnapshot(
        revisedCpiMarket,
        cpiEvent,
        '2026-11-26T16:00:00.000Z'
      );
      const revisedAudit = auditContractResolution(revisedSnap, '2026-11-26T16:00:00.000Z');
      const hookResult = recordRuleVersionWithLifecycleHook(db, revisedAudit);

      assert.equal(hookResult.isNewVersion, true);
      assert.equal(hookResult.record.versionNumber, 2);
      assert.equal(hookResult.lifecycleStateAfter, 'AUDIT_PENDING');
      assert.ok(hookResult.revisionTransition);
      assert.equal(hookResult.revisionTransition.fromState, 'ACTIVE');
      assert.equal(hookResult.revisionTransition.toState, 'AUDIT_PENDING');
      assert.equal(hookResult.revisionTransition.reason, RULES_REVISED_REASON);
      assert.equal(hookResult.revisionTransition.ruleVersionId, hookResult.record.ruleVersionId);
      assert.equal(getContractLifecycleState(db, cpiSnapshot.marketTicker), 'AUDIT_PENDING');

      // Also verify direct EE-01 persistSettlementRuleVersion on an APPROVED contract triggers RULES_REVISED
      const revisedFedMarket = {
        ...fedMarket,
        rules_primary:
          'If the upper bound of the Federal Reserve target range after the December 2026 FOMC meeting is at or below 4.25% (revised threshold), then the market resolves to Yes. Otherwise, the market resolves to No.',
      };
      const revisedFedSnap = normalizeKalshiMarketToSnapshot(
        revisedFedMarket,
        fedEvent,
        '2026-11-26T16:05:00.000Z'
      );
      const revisedFedAudit = auditContractResolution(revisedFedSnap, '2026-11-26T16:05:00.000Z');
      const fedV2 = persistSettlementRuleVersion(db, revisedFedAudit);
      assert.equal(fedV2.isNewVersion, true);
      assert.equal(getContractLifecycleState(db, fedSnapshot.marketTicker), 'AUDIT_PENDING');
      const fedHist = getContractLifecycleHistory(db, fedSnapshot.marketTicker);
      const latestFedTransition = fedHist[fedHist.length - 1];
      assert.equal(latestFedTransition.fromState, 'APPROVED');
      assert.equal(latestFedTransition.toState, 'AUDIT_PENDING');
      assert.equal(latestFedTransition.reason, RULES_REVISED_REASON);
      assert.equal(latestFedTransition.ruleVersionId, fedV2.record.ruleVersionId);

      console.log(
        'PASS [EE-03 (e)]: Rules-revision hook returns ACTIVE and APPROVED contracts to AUDIT_PENDING with RULES_REVISED and new rule_version_id.'
      );

      // -----------------------------------------------------------------------
      // (f) ELIGIBILITY: saveForecast for a contract in AUDIT_PENDING or REJECTED
      //     (or DISCOVERED / untracked) is refused with ContractNotEligibleForForecastError
      // -----------------------------------------------------------------------
      // 1. Contract returned to AUDIT_PENDING after RULES_REVISED is NO LONGER eligible
      assert.equal(isContractEligibleForForecast(db, cpiSnapshot.marketTicker), false);
      const postRevisionEval = evaluatePriceBlindForecast({
        experimentId: 'exp-ee03-active',
        contract: buildApprovedContract(
          cpiSnapshot.marketTicker,
          cpiSnapshot.eventTicker,
          hookResult.record.ruleVersionId
        ),
        config: cfg,
        researchSnapshot: SAMPLE_RESEARCH_SNAPSHOT,
        referenceClass: SAMPLE_REFERENCE_CLASS,
        baseRateEstimator: refBase,
        quantEstimator: refQuant,
        forecastTimestamp: '2026-11-26T16:10:00.000Z',
        repoRootDir: tempDir,
      });
      assert.throws(
        () => saveForecast(db, postRevisionEval.pEnsemble),
        ContractNotEligibleForForecastError,
        'saveForecast must refuse a contract in AUDIT_PENDING state'
      );

      // 2. Contract in REJECTED state is refused
      assert.equal(isContractEligibleForForecast(db, ambSnapshot.marketTicker), false);
      const rejectedContractEval = evaluatePriceBlindForecast({
        experimentId: 'exp-ee03-active',
        contract: buildApprovedContract(
          ambSnapshot.marketTicker,
          ambSnapshot.eventTicker,
          ambBinding.ruleVersion.ruleVersionId
        ),
        config: cfg,
        researchSnapshot: SAMPLE_RESEARCH_SNAPSHOT,
        referenceClass: SAMPLE_REFERENCE_CLASS,
        baseRateEstimator: refBase,
        quantEstimator: refQuant,
        forecastTimestamp: '2026-11-26T16:11:00.000Z',
        repoRootDir: tempDir,
      });
      assert.throws(
        () => saveForecast(db, rejectedContractEval.pEnsemble),
        ContractNotEligibleForForecastError,
        'saveForecast must refuse a contract in REJECTED state'
      );

      // 3. Contract in DISCOVERED state is refused
      registerDiscoveredContract(db, { marketId: 'KX-DISCOVERED-ONLY' });
      const discoveredOnlyEval = evaluatePriceBlindForecast({
        experimentId: 'exp-ee03-active',
        contract: buildApprovedContract('KX-DISCOVERED-ONLY', 'KX-DISCOVERED', cpiAuditLifecycle.ruleVersion.ruleVersionId),
        config: cfg,
        researchSnapshot: SAMPLE_RESEARCH_SNAPSHOT,
        referenceClass: SAMPLE_REFERENCE_CLASS,
        baseRateEstimator: refBase,
        quantEstimator: refQuant,
        forecastTimestamp: '2026-11-26T16:12:00.000Z',
        repoRootDir: tempDir,
      });
      assert.throws(
        () => saveForecast(db, discoveredOnlyEval.pEnsemble),
        ContractNotEligibleForForecastError,
        'saveForecast must refuse a contract in DISCOVERED state'
      );

      // 4. Once re-audited CLEAR and back to APPROVED, saveForecast succeeds again
      const reAudit = auditContractInLifecycle(db, revisedSnap, {
        auditedAt: '2026-11-26T16:15:00.000Z',
      });
      assert.equal(reAudit.transition.toState, 'APPROVED');
      assert.equal(isContractEligibleForForecast(db, cpiSnapshot.marketTicker), true);
      repo.saveForecast(postRevisionEval.pEnsemble);
      assert.equal(
        getEnsembleForMarket(db, cpiSnapshot.marketTicker)?.forecastId,
        postRevisionEval.pEnsemble.forecastId
      );

      console.log(
        'PASS [EE-03 (f)]: Forecast eligibility guard refuses AUDIT_PENDING, REJECTED, and DISCOVERED contracts and permits APPROVED+ contracts.'
      );
      console.log('\nALL EVENTEDGE EE-03 TESTS PASSED.');
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

runEe03Tests();
