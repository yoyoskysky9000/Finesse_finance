import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  EVENTEDGE_DEFAULT_FORECASTING_CONFIG,
  EventEdgeLiveModeDisabledError,
  computeForecastConfigHash,
  createEventEdgeConfig,
  createReferenceFeatureTransformQuantEstimator,
  createReferenceLaplaceBaseRateEstimator,
  deriveEventFamilyId,
  evaluatePriceBlindForecast,
  initializeEventEdgeLedger,
  listForecastsForMarket,
  persistForecastRecord,
  resolveCodeCommitHash,
  runPriceBlindForecast,
  type ApprovedContractInput,
  type BaseRateEstimator,
  type QuantitativeEstimator,
  type ReferenceClass,
  type ResearchDataSnapshot,
} from '../index';

const FIXED_TIMESTAMP = '2026-11-26T15:00:00.000Z';

const APPROVED_CPI_CONTRACT: ApprovedContractInput = Object.freeze({
  marketId: 'KXCPI-26NOV-T2.8',
  eventId: 'KXCPI-26NOV',
  category: 'Economics',
  marketTerms: 'Above 2.8% YoY CPI-U',
  closeTimeUtc: '2026-12-01T13:25:00.000Z',
  expirationTimeUtc: '2026-12-01T14:00:00.000Z',
  ruleVersionId: null,
  ruleHash: 'sha256-cpi-clear-v1',
  settlementSource: 'U.S. Bureau of Labor Statistics',
  auditStatus: 'CLEAR' as const,
});

const SAMPLE_REFERENCE_CLASS: ReferenceClass = Object.freeze({
  definition: 'US monthly CPI-U YoY prints exceeding prior-month Cleveland Fed nowcast - 0.1pp',
  inclusionCriteria: 'Official initial BLS CPI-U releases excluding government shutdown delays',
  sampleCount: 18,
  positiveCount: 11,
  timeWindow: '2025-05-01/2026-10-31',
  source: 'U.S. Bureau of Labor Statistics Historical Series',
});

const SAMPLE_RESEARCH_SNAPSHOT: ResearchDataSnapshot = Object.freeze({
  dataSnapshotId: 'rsnap_cpi_2026_11_26_a',
  capturedAt: '2026-11-26T14:55:00.000Z',
  features: Object.freeze({
    cpi_nowcast_minus_strike_pp: 0.5,
    gasoline_mom_pct: 1.2,
  }),
  metadata: Object.freeze({
    provider: 'Federal Reserve Bank of Cleveland Inflation Nowcasting',
  }),
});

function runEe02Tests(): void {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eventedge-ee02-'));

  try {
    // Verify LIVE stays hard-disabled
    assert.throws(
      () => createEventEdgeConfig({ mode: 'LIVE' }, {}),
      EventEdgeLiveModeDisabledError
    );

    const cfg = createEventEdgeConfig(
      {
        ledgerDbPath: path.join(tempDir, 'ee02_ledger.sqlite'),
        forecasting: {
          ensembleVersion: 'ee-ensemble-v1.0.0',
          ensembleWeights: { p_base: 0.4, p_quant: 0.6 },
        },
      },
      {}
    );

    assert.equal(cfg.mode, 'OBSERVE');
    assert.equal(cfg.liveEnabled, false);
    assert.equal(Object.isFrozen(cfg.forecasting), true);
    assert.equal(Object.isFrozen(cfg.forecasting.ensembleWeights), true);
    assert.equal(
      createEventEdgeConfig({}, {}).forecasting.ensembleVersion,
      EVENTEDGE_DEFAULT_FORECASTING_CONFIG.ensembleVersion
    );

    const refBaseEstimator = createReferenceLaplaceBaseRateEstimator();
    const refQuantEstimator = createReferenceFeatureTransformQuantEstimator({
      featureName: 'cpi_nowcast_minus_strike_pp',
      center: 0,
      scale: 0.5,
      intervalHalfWidth: 0.08,
    });
    assert.equal(refBaseEstimator.isReferenceOnly, true);
    assert.equal(refQuantEstimator.isReferenceOnly, true);

    // -------------------------------------------------------------------------
    // 1) Separate immutable forecast stages (p_base, p_quant, p_ensemble),
    //    single-stage passthrough, and first-class abstention
    // -------------------------------------------------------------------------
    const { db } = initializeEventEdgeLedger(cfg.ledgerDbPath);
    try {
      const fullRun = runPriceBlindForecast({
        db,
        experimentId: 'exp-ee02-ref-001',
        contract: APPROVED_CPI_CONTRACT,
        config: cfg,
        researchSnapshot: SAMPLE_RESEARCH_SNAPSHOT,
        referenceClass: SAMPLE_REFERENCE_CLASS,
        baseRateEstimator: refBaseEstimator,
        quantEstimator: refQuantEstimator,
        forecastTimestamp: FIXED_TIMESTAMP,
        repoRootDir: tempDir, // isolated dir with no .git -> literal 'unknown'
      });

      assert.equal(fullRun.records.length, 3);
      assert.equal(fullRun.pBase.forecastStage, 'p_base');
      assert.equal(fullRun.pQuant.forecastStage, 'p_quant');
      assert.equal(fullRun.pEnsemble.forecastStage, 'p_ensemble');

      // Reference Laplace base rate: (11 + 1) / (18 + 2) = 12 / 20 = 0.60
      assert.equal(fullRun.pBase.status, 'FORECAST');
      assert.equal(fullRun.pBase.probability, 0.6);
      assert.ok(fullRun.pBase.uncertaintyInterval);
      assert.ok(fullRun.pBase.uncertaintyInterval.lower < 0.6);
      assert.ok(fullRun.pBase.uncertaintyInterval.upper > 0.6);

      // Reference fixed logistic quant: 1 / (1 + exp(-(0.5 - 0) / 0.5)) = 1 / (1 + exp(-1))
      const expectedQuant = 1 / (1 + Math.exp(-1));
      assert.equal(fullRun.pQuant.status, 'FORECAST');
      assert.ok(Math.abs(fullRun.pQuant.probability! - expectedQuant) < 1e-12);

      // Deterministic weighted linear combination: 0.4 * 0.6 + 0.6 * expectedQuant
      const expectedEnsemble = 0.4 * 0.6 + 0.6 * expectedQuant;
      assert.equal(fullRun.pEnsemble.status, 'FORECAST');
      assert.ok(Math.abs(fullRun.pEnsemble.probability! - expectedEnsemble) < 1e-12);
      assert.equal(fullRun.pEnsemble.ensembleMetadata?.method, 'WEIGHTED_LINEAR');
      assert.equal(fullRun.pEnsemble.ensembleMetadata?.singleStageFallback, false);
      assert.deepEqual([...fullRun.pEnsemble.componentForecastIds], [
        fullRun.pBase.forecastId,
        fullRun.pQuant.forecastId,
      ]);

      // Verify all 3 persisted as separate rows in probability_forecasts
      const persisted = listForecastsForMarket(db, APPROVED_CPI_CONTRACT.marketId);
      assert.equal(persisted.length, 3);
      assert.deepEqual(
        persisted.map((r) => r.forecastStage),
        ['p_base', 'p_quant', 'p_ensemble']
      );

      // Single-stage fallback (only p_base available -> p_ensemble equals p_base and says so)
      const baseOnly = evaluatePriceBlindForecast({
        experimentId: 'exp-ee02-base-only',
        contract: APPROVED_CPI_CONTRACT,
        config: cfg,
        researchSnapshot: {
          dataSnapshotId: 'rsnap_missing_feature',
          capturedAt: FIXED_TIMESTAMP,
          features: { unrelated_metric: 42 },
        },
        referenceClass: SAMPLE_REFERENCE_CLASS,
        baseRateEstimator: refBaseEstimator,
        quantEstimator: refQuantEstimator,
        forecastTimestamp: FIXED_TIMESTAMP,
        repoRootDir: tempDir,
      });
      assert.equal(baseOnly.pBase.status, 'FORECAST');
      assert.equal(baseOnly.pQuant.status, 'ABSTAINED');
      assert.equal(baseOnly.pQuant.probability, null);
      assert.equal(baseOnly.pQuant.abstentionReasons[0].code, 'MISSING_REQUIRED_FEATURE');
      assert.equal(baseOnly.pEnsemble.status, 'FORECAST');
      assert.equal(baseOnly.pEnsemble.probability, baseOnly.pBase.probability);
      assert.equal(baseOnly.pEnsemble.ensembleMetadata?.singleStageFallback, true);
      assert.deepEqual([...(baseOnly.pEnsemble.ensembleMetadata?.availableStages ?? [])], ['p_base']);
      assert.match(baseOnly.pEnsemble.ensembleMetadata?.combinationNote ?? '', /p_ensemble equals p_base/i);

      // Single-stage fallback (only p_quant available -> p_ensemble equals p_quant and says so)
      const quantOnly = evaluatePriceBlindForecast({
        experimentId: 'exp-ee02-quant-only',
        contract: APPROVED_CPI_CONTRACT,
        config: cfg,
        researchSnapshot: SAMPLE_RESEARCH_SNAPSHOT,
        referenceClass: null,
        baseRateEstimator: refBaseEstimator,
        quantEstimator: refQuantEstimator,
        forecastTimestamp: FIXED_TIMESTAMP,
        repoRootDir: tempDir,
      });
      assert.equal(quantOnly.pBase.status, 'ABSTAINED');
      assert.equal(quantOnly.pBase.abstentionReasons[0].code, 'MISSING_REFERENCE_CLASS');
      assert.equal(quantOnly.pQuant.status, 'FORECAST');
      assert.equal(quantOnly.pEnsemble.status, 'FORECAST');
      assert.equal(quantOnly.pEnsemble.probability, quantOnly.pQuant.probability);
      assert.equal(quantOnly.pEnsemble.ensembleMetadata?.singleStageFallback, true);
      assert.deepEqual([...(quantOnly.pEnsemble.ensembleMetadata?.availableStages ?? [])], ['p_quant']);
      assert.match(quantOnly.pEnsemble.ensembleMetadata?.combinationNote ?? '', /p_ensemble equals p_quant/i);

      // Both stages abstained -> p_ensemble MUST abstain (never silent default like 0.5)
      const bothAbstained = runPriceBlindForecast({
        db,
        experimentId: 'exp-ee02-all-abstain',
        contract: APPROVED_CPI_CONTRACT,
        config: cfg,
        researchSnapshot: null,
        referenceClass: { ...SAMPLE_REFERENCE_CLASS, sampleCount: 0, positiveCount: 0 },
        baseRateEstimator: refBaseEstimator,
        quantEstimator: refQuantEstimator,
        forecastTimestamp: FIXED_TIMESTAMP,
        repoRootDir: tempDir,
      });
      assert.equal(bothAbstained.pBase.status, 'ABSTAINED');
      assert.equal(bothAbstained.pBase.probability, null);
      assert.equal(
        bothAbstained.pBase.abstentionReasons.some((r) => r.code === 'INSUFFICIENT_SAMPLE_SIZE'),
        true
      );
      assert.equal(bothAbstained.pQuant.status, 'ABSTAINED');
      assert.equal(bothAbstained.pEnsemble.status, 'ABSTAINED');
      assert.equal(bothAbstained.pEnsemble.probability, null);
      assert.equal(
        bothAbstained.pEnsemble.abstentionReasons.some(
          (r) => r.code === 'NO_AVAILABLE_STAGE_ESTIMATES'
        ),
        true
      );

      // Non-CLEAR (AMBIGUOUS) contract must abstain across all 3 stages
      const unapproved = evaluatePriceBlindForecast({
        experimentId: 'exp-ee02-unapproved',
        contract: { ...APPROVED_CPI_CONTRACT, auditStatus: 'AMBIGUOUS' },
        config: cfg,
        researchSnapshot: SAMPLE_RESEARCH_SNAPSHOT,
        referenceClass: SAMPLE_REFERENCE_CLASS,
        baseRateEstimator: refBaseEstimator,
        quantEstimator: refQuantEstimator,
        forecastTimestamp: FIXED_TIMESTAMP,
        repoRootDir: tempDir,
      });
      for (const rec of unapproved.records) {
        assert.equal(rec.status, 'ABSTAINED');
        assert.equal(rec.probability, null);
        assert.equal(rec.abstentionReasons[0].code, 'CONTRACT_NOT_APPROVED_CLEAR');
      }

      console.log(
        'PASS [EE-02 (1)]: Separate immutable stages (p_base, p_quant, p_ensemble), single-stage passthrough, and first-class abstention verified.'
      );

      // -----------------------------------------------------------------------
      // 2) Full provenance on every forecast record + git HEAD & 'unknown' resolution
      // -----------------------------------------------------------------------
      const expectedConfigHash = computeForecastConfigHash(cfg.forecasting);
      const expectedFamily = deriveEventFamilyId('KXCPI-26NOV', cfg.forecasting.eventFamilyDerivationVersion);
      assert.equal(expectedFamily.eventFamilyId, 'KXCPI');
      assert.equal(deriveEventFamilyId('KXBTC15M-26NOV26').eventFamilyId, 'KXBTC15M');

      for (const rec of fullRun.records) {
        assert.ok(rec.forecastId.startsWith(`fc_${rec.forecastStage}_`));
        assert.equal(rec.experimentId, 'exp-ee02-ref-001');
        assert.equal(rec.marketId, 'KXCPI-26NOV-T2.8');
        assert.equal(rec.eventId, 'KXCPI-26NOV');
        assert.equal(rec.eventFamilyId, 'KXCPI');
        assert.equal(rec.eventFamilyDerivationVersion, 'ee-family-prefix-v1');
        assert.ok(rec.modelVersion.length > 0);
        assert.equal(rec.configHash, expectedConfigHash);
        assert.equal(rec.codeCommitHash, 'unknown');
        assert.equal(rec.dataSnapshotId, 'rsnap_cpi_2026_11_26_a');
        assert.equal(rec.baseRateVersion, refBaseEstimator.version);
        assert.equal(rec.ensembleVersion, cfg.forecasting.ensembleVersion);
        assert.equal(rec.forecastTimestamp, FIXED_TIMESTAMP);
      }

      // Test shell-free git HEAD commit resolution (branch ref, detached SHA, and missing .git -> 'unknown')
      const mockGitRepoDir = path.join(tempDir, 'mock-git-repo');
      const fakeSha = '0123456789abcdef0123456789abcdef01234567';
      fs.mkdirSync(path.join(mockGitRepoDir, '.git', 'refs', 'heads'), { recursive: true });
      fs.writeFileSync(path.join(mockGitRepoDir, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf-8');
      fs.writeFileSync(
        path.join(mockGitRepoDir, '.git', 'refs', 'heads', 'main'),
        `${fakeSha}\n`,
        'utf-8'
      );
      assert.equal(resolveCodeCommitHash(mockGitRepoDir), fakeSha);

      const detachedSha = 'fedcba9876543210fedcba9876543210fedcba98';
      fs.writeFileSync(path.join(mockGitRepoDir, '.git', 'HEAD'), `${detachedSha}\n`, 'utf-8');
      assert.equal(resolveCodeCommitHash(mockGitRepoDir), detachedSha);

      const noGitDir = path.join(tempDir, 'no-git-dir');
      fs.mkdirSync(noGitDir, { recursive: true });
      assert.equal(resolveCodeCommitHash(noGitDir), 'unknown');

      console.log(
        'PASS [EE-02 (2)]: Full provenance (including deterministic event_family_id, config_hash, and git HEAD / unknown) verified on every record.'
      );

      // -----------------------------------------------------------------------
      // 3) Structural AND behavioral price-blindness tests
      // -----------------------------------------------------------------------
      const forecastingDir = path.resolve('eventedge/forecasting');
      const forecastingFiles = fs
        .readdirSync(forecastingDir)
        .filter((f) => f.endsWith('.ts'))
        .map((f) => path.join(forecastingDir, f));
      assert.ok(forecastingFiles.length >= 4);

      const forbiddenForecastingPatterns: ReadonlyArray<{ label: string; regex: RegExp }> = [
        { label: 'discovery import', regex: /from\s+['"][^'"]*discovery[^'"]*['"]/ },
        { label: 'kalshiPublicClient import', regex: /from\s+['"][^'"]*kalshiPublicClient[^'"]*['"]/ },
        { label: 'resolution import', regex: /from\s+['"][^'"]*resolution[^'"]*['"]/ },
        { label: 'orderbook module import', regex: /from\s+['"][^'"]*orderbook[^'"]*['"]/i },
        { label: 'ExecutionVault import', regex: /from\s+['"][^'"]*ExecutionVault[^'"]*['"]/ },
        { label: 'riskGuard import', regex: /from\s+['"][^'"]*riskGuard[^'"]*['"]/ },
        {
          label: 'PortfolioCorrelationGuard import',
          regex: /from\s+['"][^'"]*PortfolioCorrelationGuard[^'"]*['"]/,
        },
        {
          label: 'regimeLiquidityFilter import',
          regex: /from\s+['"][^'"]*regimeLiquidityFilter[^'"]*['"]/,
        },
        {
          label: 'kalshiFeeCalculator import',
          regex: /from\s+['"][^'"]*kalshiFeeCalculator[^'"]*['"]/,
        },
        { label: 'server.ts import', regex: /from\s+['"][^'"]*server(?:\.ts)?['"]/ },
        { label: 'mcp_server reference', regex: /mcp_server\.py/ },
        { label: 'child_process import', regex: /from\s+['"](?:node:)?child_process['"]/ },
        { label: 'direct fetch call', regex: /\bfetch\s*\(/ },
        { label: 'submitKalshiV2EventsOrder call', regex: /\bsubmitKalshiV2EventsOrder\s*\(/ },
        { label: 'executeEntryWithPortfolioGuard call', regex: /\bexecuteEntryWithPortfolioGuard\s*\(/ },
        { label: 'unwindPositionSafely call', regex: /\bunwindPositionSafely\s*\(/ },
      ];

      for (const filePath of forecastingFiles) {
        const rawSrc = fs.readFileSync(filePath, 'utf-8');
        const codeOnly = rawSrc
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/.*$/gm, '');
        for (const check of forbiddenForecastingPatterns) {
          assert.equal(
            check.regex.test(codeOnly),
            false,
            `Price-blind violation: ${path.basename(filePath)} matched forbidden pattern (${check.label})`
          );
        }
      }

      // Behavioral price-blindness test: two snapshots differing ONLY in market price & orderbook fields
      // must produce byte-for-byte identical forecasts across all three stages.
      const snapshotLowMarketPrice: ResearchDataSnapshot = {
        dataSnapshotId: 'rsnap_price_blind_test',
        capturedAt: FIXED_TIMESTAMP,
        yes_bid_usd: 0.08,
        yes_ask_usd: 0.10,
        no_bid_usd: 0.90,
        no_ask_usd: 0.92,
        last_price_usd: 0.09,
        market_implied_prob: 0.09,
        orderbook: { bids: [[0.08, 250]], asks: [[0.10, 300]] },
        features: {
          cpi_nowcast_minus_strike_pp: 0.5,
          yes_bid: 8,
          yes_ask: 10,
          mid_price: 0.09,
          spread_usd: 0.02,
          implied_probability: 0.09,
          orderbook: { best_bid: 0.08, best_ask: 0.10 },
        },
      };

      const snapshotHighMarketPrice: ResearchDataSnapshot = {
        dataSnapshotId: 'rsnap_price_blind_test',
        capturedAt: FIXED_TIMESTAMP,
        yes_bid_usd: 0.89,
        yes_ask_usd: 0.92,
        no_bid_usd: 0.08,
        no_ask_usd: 0.11,
        last_price_usd: 0.91,
        market_implied_prob: 0.905,
        orderbook: { bids: [[0.89, 1000]], asks: [[0.92, 950]] },
        features: {
          cpi_nowcast_minus_strike_pp: 0.5,
          yes_bid: 89,
          yes_ask: 92,
          mid_price: 0.905,
          spread_usd: 0.03,
          implied_probability: 0.905,
          orderbook: { best_bid: 0.89, best_ask: 0.92 },
        },
      };

      const forecastLow = evaluatePriceBlindForecast({
        experimentId: 'exp-ee02-price-blind',
        contract: APPROVED_CPI_CONTRACT,
        config: cfg,
        researchSnapshot: snapshotLowMarketPrice,
        referenceClass: SAMPLE_REFERENCE_CLASS,
        baseRateEstimator: refBaseEstimator,
        quantEstimator: refQuantEstimator,
        forecastTimestamp: FIXED_TIMESTAMP,
        repoRootDir: tempDir,
      });

      const forecastHigh = evaluatePriceBlindForecast({
        experimentId: 'exp-ee02-price-blind',
        contract: APPROVED_CPI_CONTRACT,
        config: cfg,
        researchSnapshot: snapshotHighMarketPrice,
        referenceClass: SAMPLE_REFERENCE_CLASS,
        baseRateEstimator: refBaseEstimator,
        quantEstimator: refQuantEstimator,
        forecastTimestamp: FIXED_TIMESTAMP,
        repoRootDir: tempDir,
      });

      assert.deepEqual(forecastLow.pBase, forecastHigh.pBase);
      assert.deepEqual(forecastLow.pQuant, forecastHigh.pQuant);
      assert.deepEqual(forecastLow.pEnsemble, forecastHigh.pEnsemble);

      // An estimator attempting to read a market-price field abstains cleanly
      const roguePriceQuant = createReferenceFeatureTransformQuantEstimator({
        featureName: 'yes_ask_usd',
      });
      const rogueResult = evaluatePriceBlindForecast({
        experimentId: 'exp-ee02-rogue-price',
        contract: APPROVED_CPI_CONTRACT,
        config: cfg,
        researchSnapshot: snapshotHighMarketPrice,
        referenceClass: SAMPLE_REFERENCE_CLASS,
        baseRateEstimator: refBaseEstimator,
        quantEstimator: roguePriceQuant,
        forecastTimestamp: FIXED_TIMESTAMP,
        repoRootDir: tempDir,
      });
      assert.equal(rogueResult.pQuant.status, 'ABSTAINED');
      assert.equal(rogueResult.pQuant.abstentionReasons[0].code, 'FORBIDDEN_PRICE_FEATURE_REQUESTED');

      console.log(
        'PASS [EE-02 (3)]: Structural import isolation & behavioral price-invariance tests verified.'
      );

      // -----------------------------------------------------------------------
      // 4) Output invariants: NaN/Infinity/out-of-range rejected (never clamped),
      //    exact 0/1 requires justification, determinism, and append-only immutability
      // -----------------------------------------------------------------------
      const badQuantOutputs: Array<{
        label: string;
        output: { probability: number; extremeProbabilityJustification?: string };
        expectedCode: string;
      }> = [
        { label: 'NaN', output: { probability: Number.NaN }, expectedCode: 'ESTIMATOR_OUTPUT_NAN' },
        {
          label: '+Infinity',
          output: { probability: Number.POSITIVE_INFINITY },
          expectedCode: 'ESTIMATOR_OUTPUT_INFINITE',
        },
        {
          label: '-Infinity',
          output: { probability: Number.NEGATIVE_INFINITY },
          expectedCode: 'ESTIMATOR_OUTPUT_INFINITE',
        },
        {
          label: 'negative (-0.05)',
          output: { probability: -0.05 },
          expectedCode: 'ESTIMATOR_OUTPUT_OUT_OF_RANGE',
        },
        {
          label: 'above 1 (1.05)',
          output: { probability: 1.05 },
          expectedCode: 'ESTIMATOR_OUTPUT_OUT_OF_RANGE',
        },
        {
          label: 'unjustified exact 0',
          output: { probability: 0 },
          expectedCode: 'UNJUSTIFIED_EXTREME_PROBABILITY',
        },
        {
          label: 'unjustified exact 1',
          output: { probability: 1 },
          expectedCode: 'UNJUSTIFIED_EXTREME_PROBABILITY',
        },
      ];

      for (const testCase of badQuantOutputs) {
        const badEstimator: QuantitativeEstimator = {
          id: `bad-quant-${testCase.label}`,
          version: 'test-bad-v1',
          estimate: () => testCase.output,
        };
        const res = evaluatePriceBlindForecast({
          experimentId: `exp-bad-${testCase.label}`,
          contract: APPROVED_CPI_CONTRACT,
          config: cfg,
          researchSnapshot: SAMPLE_RESEARCH_SNAPSHOT,
          referenceClass: null,
          baseRateEstimator: null,
          quantEstimator: badEstimator,
          forecastTimestamp: FIXED_TIMESTAMP,
          repoRootDir: tempDir,
        });
        assert.equal(
          res.pQuant.status,
          'ABSTAINED',
          `${testCase.label} must be rejected into ABSTAINED, never clamped`
        );
        assert.equal(res.pQuant.probability, null);
        assert.equal(res.pQuant.abstentionReasons[0].code, testCase.expectedCode);
        assert.equal(res.pEnsemble.status, 'ABSTAINED');
        assert.equal(res.pEnsemble.probability, null);
      }

      // Invalid uncertainty interval (e.g., upper < probability) must also abstain, never clamp
      const badIntervalBase: BaseRateEstimator = {
        id: 'bad-interval-base',
        version: 'test-bad-interval-v1',
        estimate: () => ({
          probability: 0.7,
          uncertaintyInterval: { lower: 0.2, upper: 0.5, method: 'broken' },
        }),
      };
      const badIntervalRes = evaluatePriceBlindForecast({
        experimentId: 'exp-bad-interval',
        contract: APPROVED_CPI_CONTRACT,
        config: cfg,
        researchSnapshot: null,
        referenceClass: SAMPLE_REFERENCE_CLASS,
        baseRateEstimator: badIntervalBase,
        quantEstimator: null,
        forecastTimestamp: FIXED_TIMESTAMP,
        repoRootDir: tempDir,
      });
      assert.equal(badIntervalRes.pBase.status, 'ABSTAINED');
      assert.equal(badIntervalRes.pBase.abstentionReasons[0].code, 'INVALID_UNCERTAINTY_INTERVAL');

      // Exact 0 or 1 IS allowed when explicit justification flag/text is provided
      const justifiedZeroQuant: QuantitativeEstimator = {
        id: 'justified-zero-quant',
        version: 'test-justified-v1',
        estimate: () => ({
          probability: 0,
          extremeProbabilityJustification:
            'Official statutory deadline has already passed with zero filings recorded in authoritative registry.',
        }),
      };
      const justifiedRes = runPriceBlindForecast({
        db,
        experimentId: 'exp-justified-zero',
        contract: APPROVED_CPI_CONTRACT,
        config: cfg,
        researchSnapshot: SAMPLE_RESEARCH_SNAPSHOT,
        referenceClass: null,
        baseRateEstimator: null,
        quantEstimator: justifiedZeroQuant,
        forecastTimestamp: FIXED_TIMESTAMP,
        repoRootDir: tempDir,
      });
      assert.equal(justifiedRes.pQuant.status, 'FORECAST');
      assert.equal(justifiedRes.pQuant.probability, 0);
      assert.equal(justifiedRes.pQuant.extremeProbabilityJustified, true);
      assert.ok(justifiedRes.pQuant.extremeProbabilityJustification);
      assert.equal(justifiedRes.pEnsemble.status, 'FORECAST');
      assert.equal(justifiedRes.pEnsemble.probability, 0);
      assert.equal(justifiedRes.pEnsemble.extremeProbabilityJustified, true);

      // Determinism test: identical inputs reproduce identical forecast records
      const detRunA = evaluatePriceBlindForecast({
        experimentId: 'exp-ee02-det',
        contract: APPROVED_CPI_CONTRACT,
        config: cfg,
        researchSnapshot: SAMPLE_RESEARCH_SNAPSHOT,
        referenceClass: SAMPLE_REFERENCE_CLASS,
        baseRateEstimator: refBaseEstimator,
        quantEstimator: refQuantEstimator,
        forecastTimestamp: FIXED_TIMESTAMP,
        repoRootDir: tempDir,
      });
      const detRunB = evaluatePriceBlindForecast({
        experimentId: 'exp-ee02-det',
        contract: APPROVED_CPI_CONTRACT,
        config: cfg,
        researchSnapshot: SAMPLE_RESEARCH_SNAPSHOT,
        referenceClass: SAMPLE_REFERENCE_CLASS,
        baseRateEstimator: refBaseEstimator,
        quantEstimator: refQuantEstimator,
        forecastTimestamp: FIXED_TIMESTAMP,
        repoRootDir: tempDir,
      });
      assert.deepEqual(detRunA, detRunB);

      // Append-only / immutability tests on probability_forecasts
      assert.throws(
        () =>
          db
            .prepare('UPDATE probability_forecasts SET probability = 0.99 WHERE forecast_id = ?')
            .run(fullRun.pBase.forecastId),
        /immutable: UPDATE forbidden/i,
        'UPDATE on probability_forecasts must abort via EE-00 immutability trigger'
      );

      assert.throws(
        () =>
          db
            .prepare('DELETE FROM probability_forecasts WHERE forecast_id = ?')
            .run(fullRun.pBase.forecastId),
        /immutable: DELETE forbidden/i,
        'DELETE on probability_forecasts must abort via EE-00 immutability trigger'
      );

      // Duplicate insert of an existing forecast_id must fail (never overwrite)
      assert.throws(
        () => persistForecastRecord(db, fullRun.pBase),
        /UNIQUE constraint failed/i
      );

      // Database CHECK constraint must reject direct SQL insert of unjustified exact 0/1
      assert.throws(
        () =>
          db
            .prepare(
              `INSERT INTO probability_forecasts (
                forecast_id, experiment_id, market_id, event_id,
                event_family_id, event_family_derivation_version,
                forecast_stage, status, probability,
                extreme_probability_justified, extreme_probability_justification,
                abstention_reasons_json, model_version, config_hash, code_commit_hash,
                data_snapshot_id, base_rate_version, ensemble_version, forecast_timestamp
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              'fc_sql_unjustified_one',
              'exp-sql-check',
              'KXCPI-26NOV-T2.8',
              'KXCPI-26NOV',
              'KXCPI',
              'ee-family-prefix-v1',
              'p_quant',
              'FORECAST',
              1.0,
              0,
              null,
              '[]',
              'v1',
              expectedConfigHash,
              'unknown',
              'snap-1',
              'none',
              'ee-ensemble-v1.0.0',
              FIXED_TIMESTAMP
            ),
        /CHECK constraint failed/i,
        'SQLite CHECK constraint must forbid exact 1.0 without extreme_probability_justified=1'
      );

      console.log(
        'PASS [EE-02 (4)]: Output invariants (no clamping, extreme-value justification, determinism, and append-only SQLite immutability) verified.'
      );
      console.log('\nALL EVENTEDGE EE-02 TESTS PASSED.');
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

runEe02Tests();
