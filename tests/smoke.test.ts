import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const tempLedgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quantpulse-smoke-'));
process.env.QUANTPULSE_TEST_MODE = 'true';
process.env.QUANTPULSE_VAULT_LEDGER_PATH = path.join(tempLedgerDir, 'vault-ledger.json');
process.env.QUANTPULSE_EXEC_IDEMPOTENCY_PATH = path.join(tempLedgerDir, 'exec-idempotency.json');
process.env.QUANTPULSE_RISK_GUARD_PATH = path.join(tempLedgerDir, 'risk-guard-ledger.json');
delete process.env.STRICT_API_AUTH_REQUIRED;

async function runSmokeSuite() {
  const { setCustomTokenVerifier } = await import('../src/server/phase1Security');
  const { ExecutionVault } = await import('../src/server/ExecutionVault');
  const { LEAD_LAG_PARAMS } = await import('../src/config/strategyParams');
  const serverMod = await import('../server');
  const {
    app,
    autonomousAgents,
    executedOrders,
    marketFeatures,
    livePublicPositions,
    riskGuard,
    resetVenueOrderSubmissionCount,
    setTestLiveCashBalances,
    setTestVenueExitHooks,
    orderRejectionLog,
    exitMonitorEvaluationLog,
    evaluateRealTimeRoiAndGlobalProfitLock,
    executeTradeIdempotencyStore,
    loadExecuteTradeIdempotencyStoreFromDisk,
    syncLiveKalshiPortfolio,
    computePortfolioSummary,
    executeLivePublicBrokeragePulse,
    placePublicTakeProfitSellOrders,
  } = serverMod;
  const { StrategyBacktester, runDeterministicRegimeBacktest } = await import(
    '../src/components/StrategyBacktester'
  );

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  assert(address && typeof address === 'object', 'Failed to bind ephemeral test port');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  // Configure deterministic test token verifier so authenticated requests pass only with valid token
  setCustomTokenVerifier(async (token: string) => {
    if (token === 'valid-test-operator-token') {
      return { uid: 'test-operator-uid', email: 'operator@quantpulse.test' } as any;
    }
    return null as any;
  });

  try {
    // -------------------------------------------------------------------------
    // Smoke Test (c): A mutating request with no token returns 401
    // -------------------------------------------------------------------------
    const unauthRes = await fetch(`${baseUrl}/api/agents/execute-trade`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: autonomousAgents[0].id }),
    });
    assert.equal(
      unauthRes.status,
      401,
      `Expected 401 on mutating request with no token, got ${unauthRes.status}`
    );
    const unauthBody = (await unauthRes.json()) as Record<string, any>;
    assert.equal(unauthBody.code, 'FIREBASE_ID_TOKEN_REQUIRED');
    console.log('PASS [Smoke Test (c)]: Mutating request with no token returned HTTP 401.');

    // -------------------------------------------------------------------------
    // Smoke Test (a): An order that exceeds the position cap is rejected and no venue call is made
    // -------------------------------------------------------------------------
    const targetAgent = autonomousAgents[0];
    const originalCap = targetAgent.riskGovernance.maxPositionNotionalUsd;
    targetAgent.riskGovernance.maxPositionNotionalUsd = 15;
    setTestLiveCashBalances({ kalshiCashUsd: 500, publicCashUsd: 500, publicBuyingPowerUsd: 500 });
    resetVenueOrderSubmissionCount();
    const ordersBeforeCapTest = executedOrders.length;
    const rejectionsBeforeCapTest = orderRejectionLog.length;

    const capRes = await fetch(`${baseUrl}/api/agents/execute-trade`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid-test-operator-token',
      },
      body: JSON.stringify({
        agentId: targetAgent.id,
        notionalUsd: 50, // Exceeds $15 maxPositionNotionalUsd cap
      }),
    });
    assert.equal(
      capRes.status,
      400,
      `Expected 400 when order exceeds position cap, got ${capRes.status}`
    );
    const capBody = (await capRes.json()) as Record<string, any>;
    assert.equal(capBody.rejected, true);
    assert.equal(capBody.code, 'POSITION_CAP_EXCEEDED');
    assert.equal(
      serverMod.venueOrderSubmissionCount,
      0,
      `Expected 0 venue calls on position-cap rejection, got ${serverMod.venueOrderSubmissionCount}`
    );
    assert.equal(
      executedOrders.length,
      ordersBeforeCapTest,
      'No order record should be added when rejected by position cap'
    );
    assert.equal(
      orderRejectionLog.length,
      rejectionsBeforeCapTest + 1,
      'Rejection should be logged in orderRejectionLog'
    );
    targetAgent.riskGovernance.maxPositionNotionalUsd = originalCap;
    console.log(
      'PASS [Smoke Test (a)]: Order exceeding position cap rejected pre-venue with 0 venue calls.'
    );

    // -------------------------------------------------------------------------
    // Smoke Test (b): The same idempotency key submitted twice creates/returns the exact same single order
    // -------------------------------------------------------------------------
    targetAgent.riskGovernance.maxPositionNotionalUsd = 100;
    setTestLiveCashBalances({ kalshiCashUsd: 500, publicCashUsd: 500, publicBuyingPowerUsd: 500 });
    const sharedIdempotencyKey = 'smoke-idempotency-key-2026-11-13-001';

    const firstExecRes = await fetch(`${baseUrl}/api/agents/execute-trade`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid-test-operator-token',
      },
      body: JSON.stringify({
        agentId: targetAgent.id,
        idempotencyKey: sharedIdempotencyKey,
        notionalUsd: 10,
      }),
    });
    assert.equal(firstExecRes.status, 200, `Expected 200 on first submission, got ${firstExecRes.status}`);
    const firstExecBody = (await firstExecRes.json()) as Record<string, any>;
    assert.equal(firstExecBody.idempotentReplay, false);
    assert.equal(firstExecBody.order.idempotencyKey, sharedIdempotencyKey);

    const ordersCountAfterFirst = executedOrders.length;
    const venueCallsAfterFirst = serverMod.venueOrderSubmissionCount;

    const secondExecRes = await fetch(`${baseUrl}/api/agents/execute-trade`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid-test-operator-token',
      },
      body: JSON.stringify({
        agentId: targetAgent.id,
        idempotencyKey: sharedIdempotencyKey,
        notionalUsd: 10,
      }),
    });
    assert.equal(
      secondExecRes.status,
      200,
      `Expected 200 on duplicate idempotency submission, got ${secondExecRes.status}`
    );
    const secondExecBody = (await secondExecRes.json()) as Record<string, any>;
    assert.equal(secondExecBody.idempotentReplay, true);
    assert.equal(
      secondExecBody.order.id,
      firstExecBody.order.id,
      'Duplicate submission must return the exact same order ID'
    );
    assert.equal(
      executedOrders.length,
      ordersCountAfterFirst,
      'Duplicate idempotency submission must not create a second order'
    );
    assert.equal(
      serverMod.venueOrderSubmissionCount,
      venueCallsAfterFirst,
      'Duplicate idempotency submission must not invoke any venue calls'
    );
    const matchingPrimaryOrders = executedOrders.filter(
      (o) => o.idempotencyKey === sharedIdempotencyKey
    );
    assert.equal(
      matchingPrimaryOrders.length,
      1,
      `Expected exactly 1 order with idempotencyKey=${sharedIdempotencyKey}, found ${matchingPrimaryOrders.length}`
    );
    console.log(
      'PASS [Smoke Test (b)]: Same idempotency key submitted twice created exactly one order and replayed it.'
    );

    // -------------------------------------------------------------------------
    // Smoke Test (d): StrategyBacktester with no data loaded shows the no-data state, not profits
    // -------------------------------------------------------------------------
    const emptyBacktestComputation = runDeterministicRegimeBacktest({ feature: undefined });
    assert.equal(
      emptyBacktestComputation.hasData,
      false,
      'runDeterministicRegimeBacktest must return hasData=false when no candle data is loaded'
    );
    assert.equal(
      emptyBacktestComputation.emptyStateMessage,
      'no data — nothing to show',
      'runDeterministicRegimeBacktest must return "no data — nothing to show" when no data is loaded'
    );
    const emptyMarkup = renderToStaticMarkup(
      React.createElement(StrategyBacktester, {
        features: [],
        selectedSymbol: 'KXBTC15M',
        onSelectSymbol: () => {},
      })
    );
    assert(
      emptyMarkup.includes('no data — nothing to show'),
      'StrategyBacktester with no data must render "no data — nothing to show"'
    );
    assert(
      !emptyMarkup.includes('+$') && !emptyMarkup.includes('3.40'),
      'StrategyBacktester with no data must not render fabricated profit figures or hardcoded 3.40 profit factor'
    );
    console.log(
      'PASS [Smoke Test (d)]: StrategyBacktester with no data loaded displays "no data — nothing to show" and no profits.'
    );

    // -------------------------------------------------------------------------
    // Smoke Test (e): Exit monitor dispatches Rule 3 pre-sweep + venue close order and updates status ONLY on confirmation
    // -------------------------------------------------------------------------
    const testSymbol = 'SPY';
    const spyFeature = marketFeatures.find((f) => f.symbol === testSymbol) || marketFeatures[0];
    const originalSpyPrice = spyFeature.price;
    spyFeature.price = 520.0;

    const testWorkingOrder: (typeof executedOrders)[number] = {
      id: 'ord-smoke-tp-eval-001',
      idempotencyKey: 'smoke-tp-eval-key-001',
      notionalUsd: 500,
      timestamp: new Date().toISOString(),
      agentId: targetAgent.id,
      agentName: targetAgent.name,
      symbol: spyFeature.symbol,
      venue: 'PUBLIC_BROKERAGE',
      side: 'BUY',
      orderType: 'LIMIT_OCO',
      quantity: 1,
      fillPrice: 500.0,
      stopLossPrice: 485.0,
      takeProfitPrice: 515.0, // Current live price 520.00 crosses takeProfitPrice 515.00
      regimeAtEntry: 'TRENDING_BULL',
      status: 'WORKING_OCO',
      rationale: 'Smoke test open position for take-profit daemon evaluation',
    };
    executedOrders.unshift(testWorkingOrder);

    // 1) Venue rejects close -> must NOT mark FILLED; must log EXIT_VENUE_REJECTED
    let sweepCancelCalls = 0;
    setTestVenueExitHooks({
      cancelOpenOrders: async () => {
        sweepCancelCalls += 1;
        return 1;
      },
      getOpenOrdersCount: async () => 0,
      getSettledPositionQty: async () => 1,
      submitPublicExit: async () => ({
        ok: false,
        liveSubmitted: false,
        orderId: 'pub-exit-rejected-001',
        lastErrorMessage: 'Simulated Public.com SELL rejection',
      }),
    });

    await evaluateRealTimeRoiAndGlobalProfitLock({
      forceStepDownNow: false,
      applyYesterdayProfitableSetup: false,
    });
    assert.equal(
      testWorkingOrder.status,
      'WORKING_OCO',
      `Expected order to remain WORKING_OCO when venue rejects exit, got ${testWorkingOrder.status}`
    );
    assert.equal(testWorkingOrder.lastExitEvaluationResult, 'EXIT_VENUE_REJECTED');
    assert(sweepCancelCalls >= 1, 'Expected Rule 3 CancelAllOpenOrders sweep before exit');

    // 2) Venue confirms close -> status transitions to FILLED + logs TRIGGERED_TAKE_PROFIT
    const submittedKalshiExitFlags: Array<{ reduceOnly: boolean; timeInForce: string }> = [];
    setTestVenueExitHooks({
      cancelOpenOrders: async () => {
        sweepCancelCalls += 1;
        return 1;
      },
      getOpenOrdersCount: async () => 0,
      getSettledPositionQty: async (_venue, sym) => (sym.startsWith('KX') ? 2 : 1),
      submitPublicExit: async () => ({
        ok: true,
        liveSubmitted: true,
        orderId: 'pub-exit-confirmed-001',
      }),
      submitKalshiExit: async (p) => {
        submittedKalshiExitFlags.push({ reduceOnly: p.reduceOnly, timeInForce: p.timeInForce });
        return {
          ok: true,
          exchangeOrderId: 'kalshi-exit-confirmed-001',
          statusLabel: 'LIVE_KALSHI_IOC_FILLED',
          fillCount: p.contracts,
          remainingCount: 0,
        };
      },
    });

    const testKalshiWorkingOrder: (typeof executedOrders)[number] = {
      id: 'ord-smoke-kalshi-tp-001',
      idempotencyKey: 'smoke-kalshi-tp-key-001',
      notionalUsd: 1.20,
      timestamp: new Date().toISOString(),
      agentId: targetAgent.id,
      agentName: targetAgent.name,
      symbol: 'KXSOL15M-SMOKE',
      venue: 'PREDICTION_MARKET',
      side: 'BUY_YES',
      orderType: 'LIMIT_OCO',
      quantity: 2,
      fillPrice: 0.55,
      stopLossPrice: 0.45,
      takeProfitPrice: 0.60,
      regimeAtEntry: 'TRENDING_BULL',
      status: 'WORKING_OCO',
      rationale: 'Smoke test Kalshi position for reduce_only IoC exit',
    };
    const solFeature = marketFeatures.find((f) => f.symbol === 'KXSOL15M') || marketFeatures[0];
    const origSolFeaturePx = solFeature.price;
    solFeature.price = 0.64;
    executedOrders.unshift(testKalshiWorkingOrder);

    const venueCallsBeforeExit = serverMod.venueOrderSubmissionCount;
    const evalSummary = await evaluateRealTimeRoiAndGlobalProfitLock({
      forceStepDownNow: false,
      applyYesterdayProfitableSetup: false,
    });

    assert.equal(
      testWorkingOrder.status,
      'FILLED',
      `Expected Public position crossing take-profit to be exited (status=FILLED), got ${testWorkingOrder.status}`
    );
    assert.equal(
      testWorkingOrder.lastExitEvaluationResult,
      'TRIGGERED_TAKE_PROFIT',
      `Expected lastExitEvaluationResult=TRIGGERED_TAKE_PROFIT, got ${testWorkingOrder.lastExitEvaluationResult}`
    );
    assert.equal(
      testKalshiWorkingOrder.status,
      'FILLED',
      `Expected Kalshi position crossing take-profit to be exited (status=FILLED), got ${testKalshiWorkingOrder.status}`
    );
    assert(
      submittedKalshiExitFlags.some((f) => f.reduceOnly === true && f.timeInForce === 'immediate_or_cancel'),
      'Expected Kalshi exit to submit reduce_only immediate_or_cancel order'
    );
    assert(
      serverMod.venueOrderSubmissionCount > venueCallsBeforeExit,
      'Expected real venue exit submission counter to increment'
    );
    assert(
      Boolean(testWorkingOrder.lastExitEvaluatedAt),
      'Expected lastExitEvaluatedAt timestamp to be populated on open position'
    );
    assert(
      evalSummary.roiSellsTriggered >= 2,
      'Expected roiSellsTriggered >= 2 when Public and Kalshi take-profits are venue-confirmed'
    );
    const matchingLogEntry = exitMonitorEvaluationLog.find(
      (entry) => entry.targetId === testWorkingOrder.id && entry.status === 'TRIGGERED'
    );
    assert(
      matchingLogEntry && matchingLogEntry.result === 'TRIGGERED_TAKE_PROFIT',
      'Expected exitMonitorEvaluationLog to record TRIGGERED_TAKE_PROFIT for the position'
    );
    setTestVenueExitHooks(null);
    spyFeature.price = originalSpyPrice;
    solFeature.price = origSolFeaturePx;
    console.log(
      'PASS [Smoke Test (e)]: Exit monitor enforced Rule 3 sweep, withheld FILLED on rejection, and confirmed Public SELL + Kalshi reduce_only IoC exits.'
    );

    // -------------------------------------------------------------------------
    // TASK-04 / TASK-08 Smoke Test (f): Champion Config 2.6.0-PORTFOLIO-GUARD-CHAMPION thresholds
    // -------------------------------------------------------------------------
    const {
      executionVault,
      evaluatePortfolioCorrelationAndCap,
      getLossFraction,
      evaluateRegimeAndLiquidity,
      evaluateChampionExitSignal,
      CHAMPION_CONFIG,
    } = await import('../server');
    assert.equal(CHAMPION_CONFIG.champion_id, '2.6.0-PORTFOLIO-GUARD-CHAMPION');
    assert.equal(CHAMPION_CONFIG.portfolio_correlation_rules.per_position_settled_cash_cap_pct, 0.03);
    assert.equal(CHAMPION_CONFIG.portfolio_correlation_rules.max_aggregate_drawdown_pct_15m, 0.035);
    assert.equal(
      CHAMPION_CONFIG.portfolio_correlation_rules.max_aggregate_notional_pct_at_reference,
      0.1105263158
    );
    assert.equal(
      CHAMPION_CONFIG.portfolio_correlation_rules.correlation_stress_model,
      'MAX_PAIRWISE_LINEAR'
    );
    assert.equal(CHAMPION_CONFIG.portfolio_correlation_rules.unknown_correlation_default, 1.0);
    assert.equal(CHAMPION_CONFIG.active_strategy.entry.drag_floor_usd, 0.12);
    assert.equal(
      CHAMPION_CONFIG.active_strategy.entry.min_edge_floor_usd,
      LEAD_LAG_PARAMS.minNetEdgeDollars
    );
    assert.deepEqual(
      CHAMPION_CONFIG.active_strategy.entry.ask_gate,
      [LEAD_LAG_PARAMS.askGateMin, LEAD_LAG_PARAMS.askGateMax]
    );
    assert.deepEqual(
      CHAMPION_CONFIG.active_strategy.entry.window_minutes,
      LEAD_LAG_PARAMS.timeWindowMinutes
    );
    assert.equal(CHAMPION_CONFIG.active_strategy.regime_filters.chop14_entry_max, 50);
    assert.equal(CHAMPION_CONFIG.active_strategy.regime_filters.chop14_regime_flip_pause, 61.8);
    assert.equal(CHAMPION_CONFIG.active_strategy.liquidity_filters.min_lhs_threshold, 0.65);
    assert.equal(CHAMPION_CONFIG.risk_caps.idempotency_cooldowns_seconds['5m'], 900);
    assert.equal(CHAMPION_CONFIG.risk_caps.idempotency_cooldowns_seconds['15m'], 2700);
    assert.equal(CHAMPION_CONFIG.risk_caps.idempotency_cooldowns_seconds['1h'], 14400);

    // -------------------------------------------------------------------------
    // TASK-04 Smoke Test (g): evaluateRegimeAndLiquidity + CHOP>61.8 flip pause + LHS gate
    // -------------------------------------------------------------------------
    const nowMs = Date.now();
    const healthyObi = [
      { tsMs: nowMs - 800, bidDepthUsd: 3000, askDepthUsd: 2800 },
      { tsMs: nowMs - 300, bidDepthUsd: 3100, askDepthUsd: 2900 },
    ];
    const passRegime = evaluateRegimeAndLiquidity({
      timeframe: '15m',
      askPriceUsd: 0.58,
      bestBidUsd: 0.56,
      bestAskUsd: 0.58,
      fairValueUsd: 0.90, // FV - ask (0.32) - drag (0.12) = 0.20 >= max(0.18, 0.12 + 1.1*0.04=0.164)
      atr14Usd: 0.04,
      minutesRemaining: 8.5,
      bboDepthUsd: 6200,
      obiSamples: healthyObi,
      nowMs,
      metricsOverride: {
        chop14: 44.2,
        adx: 29.5,
        kaufmanEr10: 0.42,
        bbwPercentile125: 0.45,
        atrRatioPercentile125: 0.38,
        garmanKlassVrpPercentile: 0.62,
      },
    });
    assert.equal(passRegime.approved, true, `Expected regime & liquidity filter pass: ${passRegime.blockReasons.join('; ')}`);
    assert(passRegime.liquidity.lhs >= 0.65, `Expected LHS >= 0.65, got ${passRegime.liquidity.lhs}`);

    const flipPauseRegime = evaluateRegimeAndLiquidity({
      timeframe: '5m',
      askPriceUsd: 0.58,
      bestBidUsd: 0.56,
      bestAskUsd: 0.58,
      fairValueUsd: 0.90,
      atr14Usd: 0.04,
      minutesRemaining: 8.5,
      bboDepthUsd: 6200,
      obiSamples: healthyObi,
      nowMs,
      metricsOverride: {
        chop14: 64.5, // > 61.8 -> regime-flip pause
        adx: 18.0, // < 20 -> adx pause
        kaufmanEr10: 0.42,
        bbwPercentile125: 0.45,
        atrRatioPercentile125: 0.38,
        garmanKlassVrpPercentile: 0.62,
      },
    });
    assert.equal(flipPauseRegime.approved, false);
    assert.equal(flipPauseRegime.regimeFlipPause, true);
    assert.equal(flipPauseRegime.adxPause, true);

    // -------------------------------------------------------------------------
    // TASK-04 Smoke Test (h): ExecutionVault Rule 1 (Settled Cash 3% Cap) & Rule 2 (Cooldown Lock)
    // -------------------------------------------------------------------------
    const sizing = executionVault.computeSettledCashTargetSize({
      riskAmountUsd: 10,
      stopLossDistanceUsd: 0.1, // riskBasedSize = 100
      settledCashUsd: 500, // settledCash * 0.03 = 15
    });
    assert.equal(sizing.approved, true);
    assert.equal(sizing.targetSize, 15, `Expected min(100, 500*0.03=15)=15, got ${sizing.targetSize}`);

    executionVault.clearLocksForTests();
    const lock1 = executionVault.acquireIdempotencyLock({
      symbol: 'KXBTC15M',
      side: 'BUY_YES',
      strategyId: 'BTC_LEAD_LAG_SNIPER',
      timeframe: '15m',
      timestampMs: 2_700_000_000,
    });
    assert.equal(lock1.allowed, true);
    assert.equal(lock1.cooldownSec, 2700);
    const lock2 = executionVault.acquireIdempotencyLock({
      symbol: 'KXBTC15M',
      side: 'BUY_YES',
      strategyId: 'BTC_LEAD_LAG_SNIPER',
      timeframe: '15m',
      timestampMs: 2_700_120_000, // Same 2700s bucket
    });
    assert.equal(lock2.allowed, false);
    assert.equal(lock2.duplicateBlocked, true);

    // -------------------------------------------------------------------------
    // TASK-04 Smoke Test (i): ExecutionVault Rule 3 (Pre-Exit Sweep + LHS >= 0.65 vs < 0.65)
    // -------------------------------------------------------------------------
    let openCountHigh = 2;
    const highLhsCalls: Array<{ limitPriceUsd: number; mode: string }> = [];
    const highLhsUnwind = await executionVault.unwindPositionSafely({
      symbol: 'KXBTC15M-TEST',
      exitSide: 'SELL_YES',
      requestedQty: 10,
      bestBidUsd: 0.60,
      bestAskUsd: 0.62,
      bboDepthUsd: 8000,
      obiSamples: healthyObi,
      nowMs,
      balanceConfirmDelayMs: 0,
      cancelAllOpenOrders: async () => {
        const c = openCountHigh;
        openCountHigh = 0;
        return c;
      },
      fetchOpenOrdersCount: async () => openCountHigh,
      fetchSettledPositionQty: async () => 10,
      executeLimitOrder: async ({ limitPriceUsd, mode }) => {
        highLhsCalls.push({ limitPriceUsd, mode });
        return { ok: true, orderId: 'exit-1c-inside' };
      },
    });
    assert.equal(highLhsUnwind.ok, true);
    assert.equal(highLhsUnwind.cancelledOpenOrders, 2);
    assert.equal(highLhsUnwind.balanceReleaseConfirmed, true);
    assert.equal(highLhsUnwind.exitStrategy, 'LIMIT_1C_INSIDE_SPREAD');
    assert.equal(highLhsCalls[0].limitPriceUsd, 0.61);

    let openCountLow = 1;
    const lowLhsCalls: Array<{ quantity: number; mode: string }> = [];
    const lowLhsUnwind = await executionVault.unwindPositionSafely({
      symbol: 'KXBTC15M-THIN',
      exitSide: 'SELL_YES',
      requestedQty: 10,
      bestBidUsd: 0.50,
      bestAskUsd: 0.58, // $0.08 spread -> LHS < 0.65
      bboDepthUsd: 900, // Low depth -> LHS < 0.65
      nowMs,
      balanceConfirmDelayMs: 0,
      cancelAllOpenOrders: async () => {
        openCountLow = 0;
        return 1;
      },
      fetchOpenOrdersCount: async () => openCountLow,
      fetchSettledPositionQty: async () => 10,
      executeLimitOrder: async ({ quantity, mode }) => {
        lowLhsCalls.push({ quantity, mode });
        return { ok: true, orderId: 'exit-twap-slice' };
      },
    });
    assert.equal(lowLhsUnwind.ok, true);
    assert.equal(lowLhsUnwind.exitStrategy, 'PASSIVE_TWAP_MICRO_TRANCHES');
    assert(lowLhsCalls.length >= 2, 'Expected multiple passive TWAP micro-tranches when LHS < 0.65');
    assert.equal(
      lowLhsCalls.reduce((s, t) => s + t.quantity, 0),
      10,
      'Passive TWAP tranches must sum to exact settled position size'
    );

    // -------------------------------------------------------------------------
    // TASK-04 Smoke Test (j): evaluateChampionExitSignal rules (2x15s SL, trailing, dead-trade, T-90s)
    // -------------------------------------------------------------------------
    const slEval1 = evaluateChampionExitSignal({
      positionId: 'pos-sl',
      entryPriceUsd: 0.60,
      liveBidUsd: 0.50, // PnL -0.10 <= -max(0.07, 0.9*0.05=0.045)
      fairValueUsd: 0.44, // FV - bid = -0.06 < -0.04
      atr14Usd: 0.05,
      peakGainUsd: 0,
      elapsedMinutes: 2,
      secondsToExpiry: 400,
      consecutiveFvGapBreaches: 0,
    });
    assert.equal(slEval1.shouldExit, false, '1st 15s breach must NOT trigger stop-loss yet');
    assert.equal(slEval1.updatedConsecutiveFvGapBreaches, 1);

    const slEval2 = evaluateChampionExitSignal({
      positionId: 'pos-sl',
      entryPriceUsd: 0.60,
      liveBidUsd: 0.50,
      fairValueUsd: 0.44,
      atr14Usd: 0.05,
      peakGainUsd: 0,
      elapsedMinutes: 2.25,
      secondsToExpiry: 385,
      consecutiveFvGapBreaches: slEval1.updatedConsecutiveFvGapBreaches,
    });
    assert.equal(slEval2.shouldExit, true, '2nd consecutive 15s breach must trigger stop-loss');
    assert.equal(slEval2.reason, 'STOP_LOSS_2X_15S_CONFIRMED');

    const deadTrade = evaluateChampionExitSignal({
      positionId: 'pos-dead',
      entryPriceUsd: 0.60,
      liveBidUsd: 0.605,
      fairValueUsd: 0.66,
      atr14Usd: 0.05,
      peakGainUsd: 0.01,
      elapsedMinutes: 6.1,
      secondsToExpiry: 300,
      consecutiveFvGapBreaches: 0,
    });
    assert.equal(deadTrade.shouldExit, true);
    assert.equal(deadTrade.reason, 'DEAD_TRADE_6M_TIME_STOP');

    const forcedFlat = evaluateChampionExitSignal({
      positionId: 'pos-flat',
      entryPriceUsd: 0.60,
      liveBidUsd: 0.61,
      fairValueUsd: 0.66,
      atr14Usd: 0.05,
      peakGainUsd: 0.01,
      elapsedMinutes: 4,
      secondsToExpiry: 85,
      consecutiveFvGapBreaches: 0,
    });
    assert.equal(forcedFlat.shouldExit, true);
    assert.equal(forcedFlat.reason, 'FORCED_FLAT_T_MINUS_90S');

    console.log(
      'PASS [TASK-04 Tests (f)-(j)]: Champion 2.6.0 config, Regime/LHS filter, ExecutionVault Rules 1-3, and Champion exits passed.'
    );

    // -------------------------------------------------------------------------
    // Fix A Tests: Fail-closed live cash check & no false connected status without creds
    // -------------------------------------------------------------------------
    setTestLiveCashBalances({
      kalshiCashUsd: null,
      kalshiSyncOk: false,
      kalshiSyncError: 'Simulated sync failure',
    });
    resetVenueOrderSubmissionCount();
    const rejCountBeforeFixA = orderRejectionLog.length;

    const missingCashRes = await fetch(`${baseUrl}/api/agents/execute-trade`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid-test-operator-token',
      },
      body: JSON.stringify({
        agentId: targetAgent.id,
        notionalUsd: 10,
        skipLiveCashSync: true, // Bypass flag must have NO effect
      }),
    });
    assert.equal(missingCashRes.status, 400);
    const missingCashBody = (await missingCashRes.json()) as Record<string, any>;
    assert.equal(missingCashBody.code, 'BALANCE_SYNC_UNAVAILABLE');
    assert.equal(serverMod.venueOrderSubmissionCount, 0);
    assert.equal(orderRejectionLog.length, rejCountBeforeFixA + 1);

    // Stale cash (> 60s old) must also fail closed even if skipLiveCashSync=true is sent
    setTestLiveCashBalances({
      kalshiCashUsd: 500,
      kalshiSyncedAtMs: Date.now() - 120_000,
      kalshiSyncOk: true,
    });
    const staleCashRes = await fetch(`${baseUrl}/api/agents/execute-trade`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid-test-operator-token',
      },
      body: JSON.stringify({
        agentId: targetAgent.id,
        notionalUsd: 10,
        skipLiveCashSync: true,
      }),
    });
    assert.equal(staleCashRes.status, 400);
    const staleCashBody = (await staleCashRes.json()) as Record<string, any>;
    assert.equal(staleCashBody.code, 'BALANCE_SYNC_UNAVAILABLE');
    assert.equal(serverMod.venueOrderSubmissionCount, 0);

    // syncLiveKalshiPortfolio must NOT report kalshiApiConnected=true when credentials are absent
    const savedKeyId = process.env.KALSHI_API_KEY_ID;
    const savedPem = process.env.KALSHI_PRIVATE_KEY_PEM;
    delete process.env.KALSHI_API_KEY_ID;
    delete process.env.KALSHI_PRIVATE_KEY_PEM;
    await syncLiveKalshiPortfolio(5);
    assert.equal(
      computePortfolioSummary().kalshiApiConnected,
      false,
      'kalshiApiConnected must be false when Kalshi credentials are missing'
    );
    if (savedKeyId !== undefined) process.env.KALSHI_API_KEY_ID = savedKeyId;
    if (savedPem !== undefined) process.env.KALSHI_PRIVATE_KEY_PEM = savedPem;
    console.log(
      'PASS [Fix A]: Fail-closed cash sync rejects missing/stale balances, ignores skipLiveCashSync, and reports disconnected without creds.'
    );

    // -------------------------------------------------------------------------
    // Fix B Tests: Default 3% settled-cash cap (cannot be disabled)
    // -------------------------------------------------------------------------
    setTestLiveCashBalances({
      kalshiCashUsd: 500, // 3% cap = $15.00
      publicCashUsd: 500,
      publicBuyingPowerUsd: 500,
      publicCashOnlyBuyingPowerUsd: 500,
    });
    targetAgent.riskGovernance.maxPositionNotionalUsd = 100;
    resetVenueOrderSubmissionCount();

    const capBypassAttemptRes = await fetch(`${baseUrl}/api/agents/execute-trade`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid-test-operator-token',
      },
      body: JSON.stringify({
        agentId: targetAgent.id,
        notionalUsd: 20, // Exceeds 3% of $500 ($15.00) even with enforceSettledCash3PctCap=false
        enforceSettledCash3PctCap: false,
      }),
    });
    assert.equal(capBypassAttemptRes.status, 400);
    const capBypassBody = (await capBypassAttemptRes.json()) as Record<string, any>;
    assert.equal(capBypassBody.code, 'SETTLED_CASH_CAP_EXCEEDED');
    assert.equal(serverMod.venueOrderSubmissionCount, 0);
    console.log(
      'PASS [Fix B]: 3% settled-cash cap enforced by default pre-venue and cannot be disabled by request flags.'
    );

    // -------------------------------------------------------------------------
    // Fix D Tests: Deterministic fallback SHA-256 key & disk persistence across restarts
    // -------------------------------------------------------------------------
    const secondAgent = autonomousAgents.find((a) => a.id !== targetAgent.id) || targetAgent;
    secondAgent.riskGovernance.maxPositionNotionalUsd = 100;
    setTestLiveCashBalances({
      kalshiCashUsd: 500,
      publicCashUsd: 500,
      publicBuyingPowerUsd: 500,
      publicCashOnlyBuyingPowerUsd: 500,
    });
    resetVenueOrderSubmissionCount();

    const noKeyFirstRes = await fetch(`${baseUrl}/api/agents/execute-trade`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid-test-operator-token',
      },
      body: JSON.stringify({
        agentId: secondAgent.id,
        notionalUsd: 10,
      }),
    });
    assert.equal(noKeyFirstRes.status, 200);
    const noKeyFirstBody = (await noKeyFirstRes.json()) as Record<string, any>;
    assert.equal(noKeyFirstBody.idempotentReplay, false);
    assert(
      /^[a-f0-9]{64}$/.test(noKeyFirstBody.idempotencyKey),
      `Expected deterministic 64-char SHA-256 fallback key, got ${noKeyFirstBody.idempotencyKey}`
    );

    const venueCallsAfterNoKeyFirst = serverMod.venueOrderSubmissionCount;
    const noKeySecondRes = await fetch(`${baseUrl}/api/agents/execute-trade`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid-test-operator-token',
      },
      body: JSON.stringify({
        agentId: secondAgent.id,
        notionalUsd: 10,
      }),
    });
    assert.equal(noKeySecondRes.status, 200);
    const noKeySecondBody = (await noKeySecondRes.json()) as Record<string, any>;
    assert.equal(noKeySecondBody.idempotentReplay, true);
    assert.equal(noKeySecondBody.idempotencyKey, noKeyFirstBody.idempotencyKey);
    assert.equal(noKeySecondBody.order.id, noKeyFirstBody.order.id);
    assert.equal(serverMod.venueOrderSubmissionCount, venueCallsAfterNoKeyFirst);

    // Simulate server restart: wipe in-memory map + orders and reload from disk
    executeTradeIdempotencyStore.clear();
    const orderIdx = executedOrders.findIndex((o) => o.idempotencyKey === noKeyFirstBody.idempotencyKey);
    if (orderIdx >= 0) executedOrders.splice(orderIdx, 1);
    loadExecuteTradeIdempotencyStoreFromDisk();

    const noKeyAfterRestartRes = await fetch(`${baseUrl}/api/agents/execute-trade`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid-test-operator-token',
      },
      body: JSON.stringify({
        agentId: secondAgent.id,
        notionalUsd: 10,
      }),
    });
    assert.equal(noKeyAfterRestartRes.status, 200);
    const noKeyAfterRestartBody = (await noKeyAfterRestartRes.json()) as Record<string, any>;
    assert.equal(noKeyAfterRestartBody.idempotentReplay, true);
    assert.equal(noKeyAfterRestartBody.order.id, noKeyFirstBody.order.id);
    assert.equal(serverMod.venueOrderSubmissionCount, venueCallsAfterNoKeyFirst);

    // Also verify ExecutionVault disk ledger reloads active locks across simulated restarts
    const activeBucketMs = Math.floor(Date.now() / (2700 * 1000)) * 2700 * 1000 + 1000;
    const preRestartLock = executionVault.acquireIdempotencyLock({
      symbol: 'KXSOL15M-PERSIST',
      side: 'BUY_YES',
      strategyId: 'BTC_LEAD_LAG_SNIPER',
      timeframe: '15m',
      timestampMs: activeBucketMs,
    });
    assert.equal(preRestartLock.allowed, true);
    const restartedVault = new ExecutionVault(process.env.QUANTPULSE_VAULT_LEDGER_PATH);
    const lockAcrossRestart = restartedVault.acquireIdempotencyLock({
      symbol: 'KXSOL15M-PERSIST',
      side: 'BUY_YES',
      strategyId: 'BTC_LEAD_LAG_SNIPER',
      timeframe: '15m',
      timestampMs: activeBucketMs + 5000, // Same active 2700s bucket after restart
    });
    assert.equal(lockAcrossRestart.allowed, false);
    assert.equal(lockAcrossRestart.duplicateBlocked, true);
    console.log(
      'PASS [Fix D]: Deterministic SHA-256 fallback deduplicates keyless calls and both idempotency stores survive simulated restarts.'
    );

    // -------------------------------------------------------------------------
    // TASK-08 / 2.6.0-PORTFOLIO-GUARD-CHAMPION Tests:
    //   1. PortfolioCorrelationGuard (lossFraction, duplicate symbol, negative/missing rho,
    //      stressMultiplier, 3.5% aggregate cap, lot rounding)
    //   2. Telemetry Completeness Gate (UNVERIFIED_MICROSTRUCTURE_TELEMETRY)
    //   3. Post-lock -> Pre-exchange execution ordering in ExecutionVault + /api/agents/execute-trade
    // -------------------------------------------------------------------------
    // (1) Exact lossFraction formula
    assert(
      Math.abs(getLossFraction(0.60, 0.05) - (0.07 + 0.12) / 0.60) < 1e-12,
      'lossFraction floor should use max(0.07, 0.9*atr) + 0.12'
    );
    assert(
      Math.abs(getLossFraction(0.60, 0.10) - (0.09 + 0.12) / 0.60) < 1e-12,
      'lossFraction ATR branch should use 0.9*atr + 0.12'
    );

    // (2) Immediate rejection if candidate.symbol already exists in activePositions
    const dupSymbolGuard = evaluatePortfolioCorrelationAndCap({
      settledCash: 1000,
      activePositions: [{ symbol: 'kxbtc15m', notionalUsd: 10, ask: 0.60, atrDollar: 0.05 }],
      candidate: { symbol: 'KXBTC15M', requestedNotionalUsd: 10, ask: 0.60, atrDollar: 0.05 },
      correlationMatrix: {},
    });
    assert.equal(dupSymbolGuard.allowed, false);
    assert(dupSymbolGuard.reason.startsWith('DUPLICATE_ACTIVE_SYMBOL'));

    // (3) Negative correlation clamped to 0; allows up to min(requested, 3% settledCash, remaining risk)
    const negCorrGuard = evaluatePortfolioCorrelationAndCap({
      settledCash: 1000, // 3% cap = 30, 3.5% maxRisk = 35
      activePositions: [{ symbol: 'KXBTC15M', notionalUsd: 30, ask: 0.60, atrDollar: 0.05 }], // existingRisk = 30 * (0.19/0.60) = 9.50
      candidate: { symbol: 'KXSOL15M', requestedNotionalUsd: 30, ask: 0.60, atrDollar: 0.05 },
      correlationMatrix: { KXBTC15M: { KXSOL15M: -0.45 } },
      lotSizeUsd: 0.60,
    });
    assert.equal(negCorrGuard.allowed, true);
    assert.equal(negCorrGuard.maxRho, 0);
    assert.equal(negCorrGuard.stressMultiplier, 1);
    assert.equal(negCorrGuard.correlationPenalty, 1);
    assert.equal(negCorrGuard.approvedNotionalUsd, 30);

    // (4) Missing correlation pair defaults to 1.0 -> doubles stressMultiplier for 2 positions & enforces lot floor
    const missingCorrGuard = evaluatePortfolioCorrelationAndCap({
      settledCash: 1000, // maxRisk = 35; with stress=2 -> 35/2 = 17.50
      activePositions: [{ symbol: 'KXBTC15M', notionalUsd: 30, ask: 0.60, atrDollar: 0.05 }], // existingRisk = 9.50
      candidate: { symbol: 'KXETH15M', requestedNotionalUsd: 30, ask: 0.60, atrDollar: 0.05 }, // availableRisk = 8.00 -> raw = 25.263 -> floor to $0.60 lot = $25.20
      correlationMatrix: {},
      lotSizeUsd: 0.60,
    });
    assert.equal(missingCorrGuard.allowed, true);
    assert.equal(missingCorrGuard.maxRho, 1.0);
    assert.equal(missingCorrGuard.stressMultiplier, 2.0);
    assert.equal(missingCorrGuard.correlationPenalty, 0.5);
    assert.equal(missingCorrGuard.approvedNotionalUsd, 25.2);
    assert.equal(missingCorrGuard.approvedContracts, 42);
    assert(missingCorrGuard.adjustedRiskUsd <= missingCorrGuard.maxRiskUsd);

    // (5) High correlation + already exhausted risk budget -> blocked (approvedNotionalUsd <= 0)
    const blockedCorrGuard = evaluatePortfolioCorrelationAndCap({
      settledCash: 1000, // maxRisk = 35
      activePositions: [
        { symbol: 'KXBTC15M', notionalUsd: 30, ask: 0.60, atrDollar: 0.05 },
        { symbol: 'KXETH15M', notionalUsd: 30, ask: 0.60, atrDollar: 0.05 },
      ], // existingRisk = 19.00; with 3 positions & rho=0.8 -> stress = 1 + 0.8*2 = 2.6 -> 35/2.6 = 13.46 < 19.00
      candidate: { symbol: 'KXSOL15M', requestedNotionalUsd: 10, ask: 0.60, atrDollar: 0.05 },
      correlationMatrix: {
        KXBTC15M: { KXETH15M: 0.8, KXSOL15M: 0.7 },
        KXETH15M: { KXSOL15M: 0.6 },
      },
    });
    assert.equal(blockedCorrGuard.allowed, false);
    assert.equal(blockedCorrGuard.approvedNotionalUsd, 0);

    // (6) Telemetry Completeness Gate: 24h snapshot or missing CHOP/ADX/LHS blocks with UNVERIFIED_MICROSTRUCTURE_TELEMETRY
    executionVault.clearLocksForTests();
    let routeCallbackCount = 0;
    const unverified24h = await executionVault.executeEntryWithPortfolioGuard({
      regimeAndLiquidity: {
        timeframe: '15m',
        askPriceUsd: 0.58,
        bestBidUsd: 0.56,
        bestAskUsd: 0.58,
        fairValueUsd: 0.90,
        atr14Usd: 0.04,
        minutesRemaining: 8.5,
        bboDepthUsd: 6200,
        obiSamples: healthyObi,
        nowMs,
        is24hTickerSnapshot: true,
        metricsOverride: {
          chop14: 44.2,
          adx: 29.5,
          kaufmanEr10: 0.42,
          bbwPercentile125: 0.45,
          atrRatioPercentile125: 0.38,
          garmanKlassVrpPercentile: 0.62,
        },
      },
      sizing: { riskAmountUsd: 10, stopLossDistanceUsd: 0.1, settledCashUsd: 1000, unitPriceUsd: 0.58 },
      idempotency: {
        symbol: 'KXBTC15M-TELEM',
        side: 'BUY_YES',
        strategyId: 'BTC_LEAD_LAG_SNIPER',
        timeframe: '15m',
        timestampMs: nowMs,
      },
      routeOrderToExchange: async () => {
        routeCallbackCount += 1;
        return { ok: true };
      },
    });
    assert.equal(unverified24h.approved, false);
    assert.equal(unverified24h.reason, 'UNVERIFIED_MICROSTRUCTURE_TELEMETRY');
    assert.equal(routeCallbackCount, 0);

    const missingChopOrLhs = executionVault.verifyMicrostructureTelemetry({
      timeframe: '15m',
      askPriceUsd: 0.58,
      bestBidUsd: 0.56,
      bestAskUsd: 0.58,
      fairValueUsd: 0.90,
      atr14Usd: 0.04,
      minutesRemaining: 8.5,
      bboDepthUsd: 6200,
      obiSamples: [], // Missing live OBI/LHS samples
      nowMs,
    });
    assert.equal(missingChopOrLhs.verified, false);
    assert.equal(missingChopOrLhs.reason, 'UNVERIFIED_MICROSTRUCTURE_TELEMETRY');

    // (7) Post-lock, pre-exchange execution ordering in ExecutionVault
    executionVault.clearLocksForTests();
    const lockedThenBlocked = await executionVault.executeEntryWithPortfolioGuard({
      regimeAndLiquidity: {
        timeframe: '15m',
        askPriceUsd: 0.58,
        bestBidUsd: 0.56,
        bestAskUsd: 0.58,
        fairValueUsd: 0.90,
        atr14Usd: 0.04,
        minutesRemaining: 8.5,
        bboDepthUsd: 6200,
        obiSamples: healthyObi,
        nowMs,
        metricsOverride: {
          chop14: 44.2,
          adx: 29.5,
          kaufmanEr10: 0.42,
          bbwPercentile125: 0.45,
          atrRatioPercentile125: 0.38,
          garmanKlassVrpPercentile: 0.62,
        },
      },
      sizing: { riskAmountUsd: 15, stopLossDistanceUsd: 0.5, settledCashUsd: 1000, unitPriceUsd: 0.58 },
      idempotency: {
        symbol: 'KXSOL15M-LOCKFIRST',
        side: 'BUY_YES',
        strategyId: 'BTC_LEAD_LAG_SNIPER',
        timeframe: '15m',
        timestampMs: nowMs,
      },
      portfolioCorrelation: {
        activePositions: [
          { symbol: 'KXBTC15M', notionalUsd: 30, ask: 0.60, atrDollar: 0.05 },
          { symbol: 'KXETH15M', notionalUsd: 30, ask: 0.60, atrDollar: 0.05 },
        ],
        correlationMatrix: {
          KXBTC15M: { KXETH15M: 0.9, 'KXSOL15M-LOCKFIRST': 0.9 },
          KXETH15M: { 'KXSOL15M-LOCKFIRST': 0.9 },
        },
        requestedNotionalUsd: 17.4,
      },
      routeOrderToExchange: async () => {
        routeCallbackCount += 1;
        return { ok: true };
      },
    });
    assert.equal(lockedThenBlocked.approved, false);
    assert.equal(routeCallbackCount, 0, 'Exchange callback must NOT be invoked when correlation guard blocks');
    assert.equal(lockedThenBlocked.validation.lockResult?.allowed, true, 'Idempotency lock must execute before correlation guard');
    const recentVaultAudit = executionVault.getAuditLog();
    assert.equal(recentVaultAudit[0].rule, 'PORTFOLIO_CORRELATION_GUARD');
    assert.equal(recentVaultAudit[0].outcome, 'REJECTED');
    assert.equal(recentVaultAudit[1].rule, 'RULE_2_IDEMPOTENCY_LOCK');
    assert.equal(recentVaultAudit[1].outcome, 'APPROVED');

    // (8) Approved execution forwards correlation-capped notional to exchange callback
    executionVault.clearLocksForTests();
    let forwardedNotional = 0;
    const approvedEntry = await executionVault.executeEntryWithPortfolioGuard({
      regimeAndLiquidity: {
        timeframe: '15m',
        askPriceUsd: 0.60,
        bestBidUsd: 0.58,
        bestAskUsd: 0.60,
        fairValueUsd: 0.92,
        atr14Usd: 0.04,
        minutesRemaining: 8.5,
        bboDepthUsd: 6200,
        obiSamples: healthyObi,
        nowMs,
        metricsOverride: {
          chop14: 44.2,
          adx: 29.5,
          kaufmanEr10: 0.42,
          bbwPercentile125: 0.45,
          atrRatioPercentile125: 0.38,
          garmanKlassVrpPercentile: 0.62,
        },
      },
      sizing: { riskAmountUsd: 18, stopLossDistanceUsd: 0.6, settledCashUsd: 1000, unitPriceUsd: 0.60 },
      idempotency: {
        symbol: 'KXETH15M-APPROVED',
        side: 'BUY_YES',
        strategyId: 'BTC_LEAD_LAG_SNIPER',
        timeframe: '15m',
        timestampMs: nowMs,
      },
      portfolioCorrelation: {
        activePositions: [{ symbol: 'KXBTC15M', notionalUsd: 30, ask: 0.60, atrDollar: 0.05 }],
        correlationMatrix: {}, // Unknown rho=1.0 -> stress=2.0 -> cap $25.20 @ $0.60 lot
        requestedNotionalUsd: 30,
        lotSizeUsd: 0.60,
      },
      routeOrderToExchange: async (approvedUsd) => {
        routeCallbackCount += 1;
        forwardedNotional = approvedUsd;
        return { orderId: 'ord-guard-approved-1' };
      },
    });
    assert.equal(approvedEntry.approved, true);
    assert.equal(routeCallbackCount, 1);
    assert.equal(forwardedNotional, 25.2);

    // (9) HTTP /api/agents/execute-trade Telemetry + PortfolioCorrelationGuard pre-venue rejection
    setTestLiveCashBalances({
      kalshiCashUsd: 1000,
      publicCashUsd: 1000,
      publicBuyingPowerUsd: 1000,
      publicCashOnlyBuyingPowerUsd: 1000,
    });
    targetAgent.riskGovernance.maxPositionNotionalUsd = 100;
    resetVenueOrderSubmissionCount();

    const httpTelemetryBlockRes = await fetch(`${baseUrl}/api/agents/execute-trade`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid-test-operator-token',
      },
      body: JSON.stringify({
        agentId: targetAgent.id,
        idempotencyKey: 'smoke-260-telem-block-001',
        notionalUsd: 10,
        enforceTelemetryGate: true,
        is24hTickerSnapshot: true,
      }),
    });
    assert.equal(httpTelemetryBlockRes.status, 400);
    const httpTelemetryBody = (await httpTelemetryBlockRes.json()) as Record<string, any>;
    assert.equal(httpTelemetryBody.code, 'UNVERIFIED_MICROSTRUCTURE_TELEMETRY');
    assert.equal(serverMod.venueOrderSubmissionCount, 0);

    const httpCorrBlockRes = await fetch(`${baseUrl}/api/agents/execute-trade`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid-test-operator-token',
      },
      body: JSON.stringify({
        agentId: targetAgent.id,
        idempotencyKey: 'smoke-260-corr-block-001',
        notionalUsd: 15,
        enforcePortfolioCorrelationGuard: true,
        activePositions: [
          { symbol: 'KXETH15M', notionalUsd: 30, ask: 0.60, atrDollar: 0.05 },
          { symbol: 'KXSOL15M', notionalUsd: 30, ask: 0.60, atrDollar: 0.05 },
        ],
      }),
    });
    assert.equal(httpCorrBlockRes.status, 400);
    const httpCorrBody = (await httpCorrBlockRes.json()) as Record<string, any>;
    assert.equal(httpCorrBody.code, 'PORTFOLIO_CORRELATION_BLOCKED');
    assert.equal(serverMod.venueOrderSubmissionCount, 0);
    assert.equal(blockedCorrGuard.maxPairwiseRho, 0.8);

    // (10) Verify mcp_server.py 100% live-production wiring invariants (Part 1 Gates a-e)
    const mcpSource = fs.readFileSync(path.resolve(process.cwd(), 'mcp_server.py'), 'utf-8');
    assert(!mcpSource.includes('625.35'), 'mcp_server.py must not contain hardcoded $625.35 balance');
    assert(!mcpSource.includes('435.08'), 'mcp_server.py must not contain hardcoded $435.08 cash');
    assert(!mcpSource.includes('459.34'), 'mcp_server.py must not contain hardcoded $459.34 cash');
    assert(!mcpSource.includes('555.81'), 'mcp_server.py must not contain hardcoded $555.81 NLV');
    assert(!mcpSource.includes('PORTFOLIO_SNAPSHOT: List'), 'mcp_server.py must not contain hardcoded PORTFOLIO_SNAPSHOT');
    assert(!mcpSource.includes('PAPER_LOGGED_BY_GATE_3'), 'mcp_server.py must not contain simulated PAPER_LOGGED_BY_GATE_3 state');
    assert(mcpSource.includes('BALANCE_UNVERIFIED_BLOCK'), 'mcp_server.py must return BALANCE_UNVERIFIED_BLOCK when live balance verification fails');
    assert(
      mcpSource.includes('BALANCE_CACHE_TTL_SECONDS: float = 60.0'),
      'mcp_server.py must enforce <= 60s balance cache TTL'
    );
    assert(
      mcpSource.includes('/trade-api/v2/portfolio/orders'),
      'mcp_server.py must route live Kalshi orders through /trade-api/v2/portfolio/orders'
    );
    assert(
      mcpSource.includes('INSERT OR REPLACE INTO order_ledger ('),
      'mcp_server.py must persist venue-returned order_id and raw_venue_response to order_ledger'
    );
    assert(
      mcpSource.includes('INSERT OR REPLACE INTO ml_meta_model_state (\n                model_id,'),
      'mcp_server.py must use explicit column names on INSERT INTO ml_meta_model_state'
    );
    assert(
      mcpSource.includes('is_synthetic INTEGER DEFAULT 0'),
      'mcp_server.py must define is_synthetic INTEGER DEFAULT 0 on ml_telemetry_ledger'
    );
    assert(
      mcpSource.includes("WHERE is_synthetic = 0 AND source = 'LIVE_VENUE'"),
      'mcp_server.py must filter ML training queries with WHERE is_synthetic = 0 AND source = \'LIVE_VENUE\''
    );
    assert(
      mcpSource.includes('excluded_synthetic_rows'),
      'mcp_server.py must log excluded_synthetic_rows in train_and_optimize_meta_model'
    );
    assert(
      mcpSource.includes('final_status = "LIVE_EXECUTED"'),
      'mcp_server.py run_portfolio_cleaner must emit LIVE_EXECUTED only when real venue confirmation IDs are attached'
    );
    assert(
      mcpSource.includes('def evaluate_portfolio_correlation_and_cap('),
      'mcp_server.py must enforce evaluate_portfolio_correlation_and_cap'
    );

    // (11) Verify TASK-06 Cross-Market Lead-Lag Triggers (2.7.0-LEAD-LAG-LIVE-CHAMPION: SVB-60, GKX-5, XVD)
    const {
      LEAD_LAG_CHAMPION_VERSION,
      evaluateSvb60Trigger,
      evaluateGkx5Trigger,
      evaluateGkx5Minute1StopTightening,
      evaluateXvdTrigger,
      evaluateLeadLagAnomalyTriggers,
    } = await import('../src/strategies/LeadLagAnomalyTriggers');

    const rawChampionJson = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), 'champion_config.json'), 'utf-8')
    ) as Record<string, any>;
    assert.equal(rawChampionJson.lead_lag_triggers?.version, '2.7.0-LEAD-LAG-LIVE-CHAMPION');
    assert.equal(rawChampionJson.lead_lag_triggers?.envelope, '2.6.0-PORTFOLIO-GUARD-CHAMPION');
    assert.equal(rawChampionJson.lead_lag_triggers?.['SVB-60']?.min_abs_z_velocity, 2.75);
    assert.equal(rawChampionJson.lead_lag_triggers?.['GKX-5']?.min_r_gk_vs_30d_tod_median, 1.6);
    assert.equal(rawChampionJson.lead_lag_triggers?.['XVD']?.settled_cash_cap_fraction, 0.015);

    // Trigger 1: SVB-60 pass & stale-feed breaker test
    const svbPass = evaluateSvb60Trigger({
      zVelocityChecks5s: [2.82, 3.05],
      coinbaseSpotUsd: 91250,
      krakenSpotUsd: 91241,
      kalshiAskMove10sDollars: 0.01,
      fairValueProb: 0.82,
      kalshiAskDollars: 0.62,
      minutesRemaining: 9.0,
      spotLatencyMs: 120,
      kalshiLatencyMs: 240,
      interVenueSkewMs: 45,
    });
    assert.equal(svbPass.triggered, true);
    assert.equal(svbPass.direction, 'BUY_YES');

    const svbStale = evaluateSvb60Trigger({
      zVelocityChecks5s: [2.9, 3.1],
      coinbaseSpotUsd: 91250,
      krakenSpotUsd: 91245,
      kalshiAskMove10sDollars: 0.0,
      fairValueProb: 0.82,
      kalshiAskDollars: 0.62,
      minutesRemaining: 9.0,
      spotLatencyMs: 1150, // > 1000ms trips breaker
      kalshiLatencyMs: 240,
      interVenueSkewMs: 45,
    });
    assert.equal(svbStale.triggered, false);
    assert.equal(svbStale.staleFeedBreakerTripped, true);

    // Trigger 2: GKX-5 pass & minute-1 sign flip -$0.03 stop tightening
    const gkxPass = evaluateGkx5Trigger({
      rGkRatio: 1.75,
      zVelocity5m: 2.35,
      intraCandleVelocitySigns: [0.8, 1.4, 2.1, 2.35],
      deltaFvProjDollars: 0.27,
      fairValueProb: 0.81,
      kalshiAskDollars: 0.60,
      candleFinalizationLatencyMs: 420,
      kalshiLatencyMs: 310,
      minute1ZVelocity5m: -0.45, // sign flipped in minute 1 -> tightens SL to -$0.03
      entryPriceDollars: 0.60,
    });
    assert.equal(gkxPass.triggered, true);
    assert.equal(gkxPass.stopLossDeltaDollars, -0.03);
    assert.equal(gkxPass.minute1StopTightening.signFlippedInMinute1, true);
    assert.equal(gkxPass.minute1StopTightening.effectiveStopLossPriceDollars, 0.57);

    const slNoFlip = evaluateGkx5Minute1StopTightening(2.35, 1.85, 0.60, -0.12);
    assert.equal(slNoFlip.signFlippedInMinute1, false);
    assert.equal(slNoFlip.tightenedStopLossDeltaDollars, -0.12);

    // Trigger 3: XVD pass & half-cap (1.5% settled cash) sizing inside 2.6.0 envelope
    const xvdCombined = evaluateLeadLagAnomalyTriggers({
      envelope: {
        symbol: 'KXBTC15M',
        side: 'BUY_YES',
        chop14: 38.4,
        adx14: 31.2,
        lhs: 0.78,
        ask: 0.60,
        atrDollar: 0.05,
        settledCashUsd: 1000,
        activePositions: [],
        correlationMatrix: {},
        timestampMs: 1763193600000,
      },
      xvd: {
        snapshots: [
          { timestampMs: 1000, kalshiProb: 0.60, polymarketProb: 0.72 },
          { timestampMs: 2600, kalshiProb: 0.60, polymarketProb: 0.73 },
          { timestampMs: 4200, kalshiProb: 0.60, polymarketProb: 0.74 },
        ],
        identicalSettlementSource: true,
        spotFairValueProb: 0.76,
        leadingVenueProb: 0.74,
        laggingVenueAskDollars: 0.58,
        kalshiLatencyMs: 220,
        polymarketLatencyMs: 310,
        spotLatencyMs: 95,
        interVenueSkewMs: 140,
      },
    });
    assert.equal(xvdCombined.version, LEAD_LAG_CHAMPION_VERSION);
    assert.equal(xvdCombined.triggered, true);
    assert.equal(xvdCombined.activeTriggerId, 'XVD');
    assert.equal(xvdCombined.settledCashCapFraction, 0.015);
    assert.equal(xvdCombined.approvedNotionalUsd, 15.0); // 1.5% of $1,000 settled cash = $15.00
    assert.equal(xvdCombined.approvedContracts, 25); // $15.00 / $0.60 = 25 contracts

    console.log(
      'PASS [TASK-06 & TASK-08 / 2.7.0-LEAD-LAG-LIVE-CHAMPION]: PortfolioCorrelationGuard, Telemetry Gate, mcp_server.py de-sim Gates (a)-(e), and LeadLagAnomalyTriggers (SVB-60, GKX-5, XVD) passed.'
    );

    // -------------------------------------------------------------------------
    // LOW-BALANCE KALSHI COMPOUNDER TESTS ($32.99 MICRO_LOT_30 < $150 settled cash)
    // -------------------------------------------------------------------------
    const compVault = new ExecutionVault(path.join(tempLedgerDir, 'compounder-vault.json'));
    compVault.clearLocksForTests();
    assert.equal(compVault.isLowBalanceKalshiCompounderActive(32.99), true);
    assert.equal(compVault.isLowBalanceKalshiCompounderActive(150.0), false);

    // 1. MICRO_LOT_30 sizing: $32.99 * 0.03 = $0.9897 -> strictly 1 contract
    const compSizing = compVault.computeLowBalanceCompounderSizing(32.99, 0.58);
    assert.equal(compSizing.tier, 'MICRO_LOT_30');
    assert.equal(compSizing.approvedContracts, 1);
    assert.equal(compSizing.maxContracts, 1);
    assert.ok(Math.abs(compSizing.cashCapUsd - 0.9897) < 0.001);

    // 2. Price formula: min(best_ask - 0.01, best_bid + 0.01) inside [0.52, 0.74]
    const compPx = compVault.computeCompounderMakerBuyPrice(0.57, 0.61);
    assert.equal(compPx.ok, true);
    assert.equal(compPx.priceUsd, 0.58);
    const outOfBandPx = compVault.computeCompounderMakerBuyPrice(0.75, 0.80);
    assert.equal(outOfBandPx.ok, false);

    // 3. Pre-Entry Resting Order Check + Maker-First post_only 1-contract fill
    let restingOrdersSim = [{ orderId: 'stale-ord-1', ticker: 'KXBTC15M-COMP', status: 'resting' }];
    const cancelledOrdersLog: string[] = [];
    let submittedOrderParams: Record<string, unknown> | null = null;
    const compFilledRes = await compVault.executeLowBalanceCompounderEntry({
      ticker: 'KXBTC15M-COMP',
      side: 'BUY_YES',
      triggerId: 'SVB-60',
      settledCashUsd: 32.99,
      bestBidUsd: 0.57,
      bestAskUsd: 0.61,
      fairValueUsd: 0.78, // 0.78 - 0.58 = 0.20 >= 0.18
      chop14: 41.2,
      adx: 29.5,
      lhs: 0.78,
      timestampMs: 1763290000000,
      explicitClientKey: 'comp-fill-1',
      fetchRestingOrdersForTicker: async () => [...restingOrdersSim],
      cancelRestingOrder: async (oid) => {
        cancelledOrdersLog.push(oid);
        restingOrdersSim = restingOrdersSim.filter((o) => o.orderId !== oid);
        return { ok: true };
      },
      submitPostOnlyLimitBuy: async (p) => {
        submittedOrderParams = p as unknown as Record<string, unknown>;
        return { ok: true, orderId: 'comp-live-1', status: 'FILLED' };
      },
      fetchOrderStatus: async () => ({ status: 'FILLED' }),
    });
    assert.equal(compFilledRes.ok, true);
    assert.equal(compFilledRes.contracts, 1);
    assert.equal(compFilledRes.limitPriceUsd, 0.58);
    assert.equal(compFilledRes.postOnly, true);
    assert.deepEqual(compFilledRes.staleRestingOrdersCancelled, ['stale-ord-1']);
    assert.equal((submittedOrderParams as Record<string, unknown> | null)?.contracts, 1);
    assert.equal((submittedOrderParams as Record<string, unknown> | null)?.postOnly, true);

    // 4. 12-second unfilled auto-cancel (never chases market order)
    let cancelled12s = false;
    const compTimeoutRes = await compVault.executeLowBalanceCompounderEntry({
      ticker: 'KXBTC15M-COMP2',
      side: 'BUY_YES',
      triggerId: 'GKX-5',
      settledCashUsd: 32.99,
      bestBidUsd: 0.56,
      bestAskUsd: 0.60,
      fairValueUsd: 0.77, // 0.77 - 0.57 = 0.20 >= 0.18
      chop14: 39.0,
      adx: 31.0,
      lhs: 0.72,
      timestampMs: 1763290000000,
      explicitClientKey: 'comp-timeout-12s',
      unfilledAutoCancelMs: 12000,
      pollIntervalMs: 4000,
      sleepMs: async () => {},
      fetchRestingOrdersForTicker: async () => [],
      cancelRestingOrder: async (oid) => {
        if (oid === 'comp-rest-12s') cancelled12s = true;
        return { ok: true };
      },
      submitPostOnlyLimitBuy: async () => ({ ok: true, orderId: 'comp-rest-12s', status: 'RESTING' }),
      fetchOrderStatus: async () => ({ status: 'RESTING' }),
    });
    assert.equal(compTimeoutRes.ok, false);
    assert.equal(compTimeoutRes.status, 'AUTO_CANCELLED_UNFILLED_12S');
    assert.equal(compTimeoutRes.autoCancelledAfter12s, true);
    assert.equal(compTimeoutRes.chasedWithMarketOrder, false);
    assert.equal(cancelled12s, true);

    // 5. Zero-Fee Settlement Hold Exemption at T - 90s (FV >= 0.85 and ITM > 0.25*sigma*sqrt(tau))
    const settleHoldEval = evaluateChampionExitSignal({
      positionId: 'pos-comp-settle',
      entryPriceUsd: 0.58,
      liveBidUsd: 0.88,
      fairValueUsd: 0.90,
      atr14Usd: 0.05,
      peakGainUsd: 0.30,
      elapsedMinutes: 13.8,
      secondsToExpiry: 75, // <= 90s
      consecutiveFvGapBreaches: 0,
      settledCashUsd: 32.99,
      contracts: 1,
      side: 'BUY_YES',
      spotPriceUsd: 90200,
      strikePriceUsd: 90000,
      annualizedSigma: 0.55,
    });
    assert.equal(settleHoldEval.shouldExit, false);
    assert.equal(settleHoldEval.reason, 'HOLD_ZERO_FEE_SETTLEMENT');
    assert.equal(settleHoldEval.zeroFeeSettlementHoldExempt, true);

    // 6. Tight 2-Eval Inversion Stop (FV - bid < -0.04 x2 OR loss <= -$0.06 -> Rule 3 unwind)
    const inv1 = evaluateChampionExitSignal({
      positionId: 'pos-comp-inv',
      entryPriceUsd: 0.58,
      liveBidUsd: 0.56, // -0.02 unrealized (> -0.06), wait for 2nd breach
      fairValueUsd: 0.51, // FV - bid = -0.05 < -0.04
      atr14Usd: 0.05,
      peakGainUsd: 0,
      elapsedMinutes: 2.0,
      secondsToExpiry: 500,
      consecutiveFvGapBreaches: 0,
      settledCashUsd: 32.99,
      contracts: 1,
    });
    assert.equal(inv1.shouldExit, false);
    assert.equal(inv1.updatedConsecutiveFvGapBreaches, 1);

    let compSweepCancelled = false;
    let compExitQty = 0;
    const inv2Exec = await compVault.evaluateAndExecuteCompounderExit({
      exitEval: {
        positionId: 'pos-comp-inv',
        entryPriceUsd: 0.58,
        liveBidUsd: 0.56,
        fairValueUsd: 0.51,
        atr14Usd: 0.05,
        peakGainUsd: 0,
        elapsedMinutes: 2.25,
        secondsToExpiry: 485,
        consecutiveFvGapBreaches: inv1.updatedConsecutiveFvGapBreaches,
        settledCashUsd: 32.99,
        contracts: 1,
      },
      sweep: {
        symbol: 'KXBTC15M-COMP',
        exitSide: 'SELL_YES',
        requestedQty: 1,
        bestBidUsd: 0.56,
        bestAskUsd: 0.58,
        bboDepthUsd: 8000,
        cancelAllOpenOrders: async () => {
          compSweepCancelled = true;
          return 1;
        },
        fetchOpenOrdersCount: async () => 0,
        fetchSettledPositionQty: async () => 1,
        executeLimitOrder: async ({ quantity }) => {
          compExitQty = quantity;
          return { ok: true, orderId: 'comp-exit-1' };
        },
      },
    });
    assert.equal(inv2Exec.evalResult.shouldExit, true);
    assert.equal(inv2Exec.evalResult.reason, 'STOP_LOSS_COMPOUNDER_INVERSION');
    assert.equal(inv2Exec.exitExecuted, true);
    assert.equal(compSweepCancelled, true);
    assert.equal(compExitQty, 1);

    // -$0.06 unrealized loss immediate stop even on 1st check
    const lossFloorStop = evaluateChampionExitSignal({
      positionId: 'pos-comp-loss',
      entryPriceUsd: 0.58,
      liveBidUsd: 0.52, // -$0.06 loss
      fairValueUsd: 0.53,
      atr14Usd: 0.05,
      peakGainUsd: 0,
      elapsedMinutes: 1.5,
      secondsToExpiry: 600,
      consecutiveFvGapBreaches: 0,
      settledCashUsd: 32.99,
      contracts: 1,
    });
    assert.equal(lossFloorStop.shouldExit, true);
    assert.equal(lossFloorStop.reason, 'STOP_LOSS_COMPOUNDER_INVERSION');

    console.log(
      'PASS [LOW_BALANCE_KALSHI_COMPOUNDER]: MICRO_LOT_30 ($32.99 -> 1 contract), Pre-Entry Resting Order Check, Maker-First post_only [0.52, 0.74] + 12s auto-cancel, Zero-Fee Settlement Hold Exemption, and Tight 2-Eval Inversion Stop passed.'
    );

    // -------------------------------------------------------------------------
    // TASK-14 [VAULT-FIX]: Secondary Live Routes RiskGuard Verification
    // -------------------------------------------------------------------------
    const authHeaders = {
      'Content-Type': 'application/json',
      Authorization: 'Bearer valid-test-operator-token',
    };

    // (a1) Missing / unverified balance blocks all secondary live routes with BALANCE_UNVERIFIED_BLOCK & 0 venue calls
    riskGuard.clearLocksForTests();
    setTestLiveCashBalances({
      kalshiCashUsd: null,
      kalshiSyncOk: false,
      publicCashUsd: null,
      publicBuyingPowerUsd: null,
      publicCashOnlyBuyingPowerUsd: null,
      publicSyncOk: false,
    });
    resetVenueOrderSubmissionCount();

    const unverifiedChecks: Array<{ label: string; url: string; body: Record<string, unknown> }> = [
      {
        label: '/api/kalshi/five-gate-evaluate',
        url: `${baseUrl}/api/kalshi/five-gate-evaluate`,
        body: {
          market_ticker: 'KXBTC15M-SMOKE14A',
          series_ticker: 'KXBTC15M',
          kalshi_mid_prob: 0.50,
          yes_bid_dollars: 0.49,
          yes_ask_dollars: 0.51,
          execution_price: 0.50,
          calibrated_yes_prob: 0.78,
          confidence_band: 0.06,
          is_maker: true,
          recommended_side: 'yes',
          timeframe: '5m',
        },
      },
      {
        label: '/api/kalshi/gemini-signal',
        url: `${baseUrl}/api/kalshi/gemini-signal`,
        body: {
          market_ticker: 'KXETH15M-SMOKE14A',
          series_ticker: 'KXETH15M',
          kalshi_mid_prob: 0.50,
          yes_bid_dollars: 0.49,
          yes_ask_dollars: 0.51,
          calibrated_yes_prob_hint: 0.78,
          confidence_band_hint: 0.06,
          timeframe: '5m',
        },
      },
      {
        label: '/api/public/execute-burst',
        url: `${baseUrl}/api/public/execute-burst`,
        body: { symbols: ['SPY'], notionalPerTradeUsd: 50, timeframe: '5m' },
      },
      {
        label: '/api/kalshi/hft-burst',
        url: `${baseUrl}/api/kalshi/hft-burst`,
        body: { series: ['KXBTC15M'], contractsPerOrder: 5 },
      },
      {
        label: '/api/agents/deploy-best-strategy',
        url: `${baseUrl}/api/agents/deploy-best-strategy`,
        body: { symbol: 'SPY', notionalUsd: 65, timeframe: '5m', strategyId: 'SMOKE14_UNVERIFIED' },
      },
      {
        label: '/api/agents/deploy-15m-hft-winner',
        url: `${baseUrl}/api/agents/deploy-15m-hft-winner`,
        body: { symbol: 'KXSOL15M', requestedContracts: 10, timeframe: '5m' },
      },
      {
        label: '/api/lead-lag/execute-zero-hold-scalp',
        url: `${baseUrl}/api/lead-lag/execute-zero-hold-scalp`,
        body: { seriesTicker: 'KXBTC15M', requestedContracts: 10, timeframe: '5m' },
      },
    ];

    for (const chk of unverifiedChecks) {
      const resp = await fetch(chk.url, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify(chk.body),
      });
      const data = (await resp.json()) as Record<string, any>;
      assert.equal(
        resp.status,
        400,
        `Expected HTTP 400 BALANCE_UNVERIFIED_BLOCK on ${chk.label}, got ${resp.status} (${JSON.stringify(data)})`
      );
      assert.equal(
        data.code,
        'BALANCE_UNVERIFIED_BLOCK',
        `Expected BALANCE_UNVERIFIED_BLOCK on ${chk.label}, got ${data.code}`
      );
    }
    assert.equal(
      serverMod.venueOrderSubmissionCount,
      0,
      `Expected 0 venue calls when settled cash is unverified across secondary routes, got ${serverMod.venueOrderSubmissionCount}`
    );

    // (a2) Stale (>60s) cash sync must also fail closed with BALANCE_UNVERIFIED_BLOCK
    setTestLiveCashBalances({
      kalshiCashUsd: 500,
      kalshiSyncOk: true,
      kalshiSyncedAtMs: Date.now() - 120_000,
      publicCashUsd: 500,
      publicBuyingPowerUsd: 500,
      publicCashOnlyBuyingPowerUsd: 500,
      publicSyncOk: true,
      publicSyncedAtMs: Date.now() - 120_000,
    });
    const stalePubRes = await fetch(`${baseUrl}/api/public/execute-burst`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ symbols: ['NVDA'], notionalPerTradeUsd: 10, timeframe: '5m' }),
    });
    const stalePubData = (await stalePubRes.json()) as Record<string, any>;
    assert.equal(stalePubRes.status, 400);
    assert.equal(stalePubData.code, 'BALANCE_UNVERIFIED_BLOCK');
    const staleKalshiRes = await fetch(`${baseUrl}/api/kalshi/five-gate-evaluate`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(unverifiedChecks[0].body),
    });
    const staleKalshiData = (await staleKalshiRes.json()) as Record<string, any>;
    assert.equal(staleKalshiRes.status, 400);
    assert.equal(staleKalshiData.code, 'BALANCE_UNVERIFIED_BLOCK');
    assert.equal(serverMod.venueOrderSubmissionCount, 0);
    console.log(
      'PASS [TASK-14 (a)]: Missing and >60s-stale settled balances refused with BALANCE_UNVERIFIED_BLOCK and 0 venue calls across all secondary routes.'
    );

    // (b) Duplicate identical secondary-route orders in the same bucket produce exactly ONE venue call (+ 90s bucket unlock check)
    riskGuard.clearLocksForTests();
    setTestLiveCashBalances({
      kalshiCashUsd: 500,
      kalshiSyncOk: true,
      publicCashUsd: 500,
      publicBuyingPowerUsd: 500,
      publicCashOnlyBuyingPowerUsd: 500,
      publicSyncOk: true,
    });
    resetVenueOrderSubmissionCount();

    const deployDupPayload = {
      symbol: 'SPY',
      notionalUsd: 10,
      timeframe: '5m',
      strategyId: 'SMOKE14_DUP_DEPLOY',
    };
    const depFirst = await fetch(`${baseUrl}/api/agents/deploy-best-strategy`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(deployDupPayload),
    });
    const depFirstData = (await depFirst.json()) as Record<string, any>;
    assert.equal(depFirst.status, 200);
    assert(depFirstData.order?.id, 'Expected first deploy-best-strategy call to execute');
    const callsAfterDepFirst = serverMod.venueOrderSubmissionCount;
    assert.equal(callsAfterDepFirst, 1, 'Expected 1 venue submission after first deploy-best-strategy call');

    const depSecond = await fetch(`${baseUrl}/api/agents/deploy-best-strategy`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(deployDupPayload),
    });
    const depSecondData = (await depSecond.json()) as Record<string, any>;
    assert.equal(depSecond.status, 200);
    assert.equal(depSecondData.duplicateBlocked, true);
    assert.equal(depSecondData.code, 'DUPLICATE_ORDER_IDEMPOTENCY_BLOCK');
    assert.equal(
      serverMod.venueOrderSubmissionCount,
      callsAfterDepFirst,
      'Expected second identical deploy-best-strategy in same bucket to make 0 additional venue calls'
    );

    // Public burst helper twice in same bucket -> 1 venue call
    const pubPulse1 = await executeLivePublicBrokeragePulse({
      symbols: ['NVDA'],
      notionalPerTradeUsd: 10,
      timeframe: '5m',
    });
    assert.equal(pubPulse1.executedCount, 1);
    const callsAfterPubPulse1 = serverMod.venueOrderSubmissionCount;
    assert.equal(callsAfterPubPulse1, callsAfterDepFirst + 1);

    const pubPulse2 = await executeLivePublicBrokeragePulse({
      symbols: ['NVDA'],
      notionalPerTradeUsd: 10,
      timeframe: '5m',
    });
    assert.equal(pubPulse2.executedCount, 0);
    assert.equal(pubPulse2.duplicateBlocked, true);
    assert.equal(pubPulse2.code, 'DUPLICATE_ORDER_IDEMPOTENCY_BLOCK');
    assert.equal(serverMod.venueOrderSubmissionCount, callsAfterPubPulse1);

    // 5-Gate route twice in same bucket -> 1 venue call
    const fgPayload = {
      market_ticker: 'KXBTC15M-SMOKE14DUP',
      series_ticker: 'KXBTC15M',
      kalshi_mid_prob: 0.50,
      yes_bid_dollars: 0.49,
      yes_ask_dollars: 0.51,
      execution_price: 0.50,
      calibrated_yes_prob: 0.78,
      confidence_band: 0.06,
      is_maker: true,
      recommended_side: 'yes',
      timeframe: '5m',
    };
    const fgFirst = await fetch(`${baseUrl}/api/kalshi/five-gate-evaluate`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(fgPayload),
    });
    const fgFirstData = (await fgFirst.json()) as Record<string, any>;
    assert.equal(fgFirst.status, 200);
    assert.equal(fgFirstData.ok, true);
    assert.equal(fgFirstData.v2_maker_order?.ok, true);
    const callsAfterFg1 = serverMod.venueOrderSubmissionCount;
    assert.equal(callsAfterFg1, callsAfterPubPulse1 + 1);

    const fgSecond = await fetch(`${baseUrl}/api/kalshi/five-gate-evaluate`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(fgPayload),
    });
    const fgSecondData = (await fgSecond.json()) as Record<string, any>;
    assert.equal(fgSecond.status, 200);
    assert.equal(fgSecondData.duplicateBlocked, true);
    assert.equal(fgSecondData.code, 'DUPLICATE_ORDER_IDEMPOTENCY_BLOCK');
    assert.equal(serverMod.venueOrderSubmissionCount, callsAfterFg1);

    // Zero-hold scalp twice in same bucket -> 1 venue call
    const scalpPayload = { seriesTicker: 'KXBTC15M', requestedContracts: 2, timeframe: '5m' };
    const scalp1 = await fetch(`${baseUrl}/api/lead-lag/execute-zero-hold-scalp`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(scalpPayload),
    });
    const scalp1Data = (await scalp1.json()) as Record<string, any>;
    assert.equal(scalp1.status, 200);
    assert.equal(scalp1Data.executedCount, 1);
    const callsAfterScalp1 = serverMod.venueOrderSubmissionCount;
    assert.equal(callsAfterScalp1, callsAfterFg1 + 1);

    const scalp2 = await fetch(`${baseUrl}/api/lead-lag/execute-zero-hold-scalp`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(scalpPayload),
    });
    const scalp2Data = (await scalp2.json()) as Record<string, any>;
    assert.equal(scalp2.status, 200);
    assert.equal(scalp2Data.executedCount, 0);
    assert.equal(scalp2Data.duplicateBlocked, true);
    assert.equal(serverMod.venueOrderSubmissionCount, callsAfterScalp1);

    // Explicit 90s bucket preserves stale-Maker auto-recycle without Date.now()
    const baseBucketTs = 1_800_000_000_000;
    const sniperB1 = riskGuard.evaluateEntryOrder({
      venue: 'KALSHI',
      symbol: 'KXBTC15M-RECYCLE',
      side: 'BUY_YES',
      strategyId: 'KALSHI_HFT_SNIPER',
      timeframe: '90s',
      requestedNotionalUsd: 2.0,
      unitPriceUsd: 0.50,
      isIntegerContracts: true,
      timestampMs: baseBucketTs,
      settledCash: {
        venue: 'KALSHI',
        settledCashUsd: 500,
        syncOk: true,
        lastSyncAtMs: baseBucketTs,
        nowMs: baseBucketTs,
      },
    });
    assert.equal(sniperB1.ok, true);
    const sniperSameBucket = riskGuard.evaluateEntryOrder({
      venue: 'KALSHI',
      symbol: 'KXBTC15M-RECYCLE',
      side: 'BUY_YES',
      strategyId: 'KALSHI_HFT_SNIPER',
      timeframe: '90s',
      requestedNotionalUsd: 2.0,
      unitPriceUsd: 0.50,
      isIntegerContracts: true,
      timestampMs: baseBucketTs + 45_000,
      settledCash: {
        venue: 'KALSHI',
        settledCashUsd: 500,
        syncOk: true,
        lastSyncAtMs: baseBucketTs + 45_000,
        nowMs: baseBucketTs + 45_000,
      },
    });
    assert.equal(sniperSameBucket.ok, false);
    assert.equal(sniperSameBucket.code, 'DUPLICATE_ORDER_IDEMPOTENCY_BLOCK');
    const sniperNextBucket = riskGuard.evaluateEntryOrder({
      venue: 'KALSHI',
      symbol: 'KXBTC15M-RECYCLE',
      side: 'BUY_YES',
      strategyId: 'KALSHI_HFT_SNIPER',
      timeframe: '90s',
      requestedNotionalUsd: 2.0,
      unitPriceUsd: 0.50,
      isIntegerContracts: true,
      timestampMs: baseBucketTs + 90_000,
      settledCash: {
        venue: 'KALSHI',
        settledCashUsd: 500,
        syncOk: true,
        lastSyncAtMs: baseBucketTs + 90_000,
        nowMs: baseBucketTs + 90_000,
      },
    });
    assert.equal(sniperNextBucket.ok, true);
    console.log(
      'PASS [TASK-14 (b)]: Identical secondary-route orders in same bucket produced single venue call; explicit 90s bucket unlocks next recycle window.'
    );

    // (c) Secondary-route orders above 3% settled-cash cap are sized down strictly to <= 3% settled cash (never equity or margin buying power)
    riskGuard.clearLocksForTests();
    setTestLiveCashBalances({
      kalshiCashUsd: 30, // 3% = $0.90 -> max 1 contract @ $0.50-$0.56
      kalshiSyncOk: true,
      publicCashUsd: 500, // 3% = $15.00
      publicCashOnlyBuyingPowerUsd: 500,
      publicBuyingPowerUsd: 10000, // Deliberately 20x higher margin buying power to ensure cap uses settled cash ($500), NOT buying power ($10,000)
      publicSyncOk: true,
    });
    resetVenueOrderSubmissionCount();

    const oversizedPubRes = await executeLivePublicBrokeragePulse({
      symbols: ['SPY'],
      notionalPerTradeUsd: 120, // Requested $120 > $15 (3% of $500 settled cash), well below 3% of $10k buying power ($300)
      timeframe: '5m',
    });
    assert.equal(oversizedPubRes.executedCount, 1);
    const cappedPubNotional = oversizedPubRes.publicBuyOrders[0].notionalUsd ?? 0;
    assert(
      cappedPubNotional <= 15.05 && cappedPubNotional > 0,
      `Expected Public burst order notional to clamp to <= $15.00 (3% settled cash), got $${cappedPubNotional}`
    );

    const oversizedHftWinnerRes = await fetch(`${baseUrl}/api/agents/deploy-15m-hft-winner`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ symbol: 'KXSOL15M', requestedContracts: 20, timeframe: '5m' }),
    });
    const oversizedHftWinnerData = (await oversizedHftWinnerRes.json()) as Record<string, any>;
    assert.equal(oversizedHftWinnerRes.status, 200);
    assert.equal(oversizedHftWinnerData.wasCapped, true);
    assert.equal(
      oversizedHftWinnerData.order?.quantity,
      1,
      `Expected deploy-15m-hft-winner 20 contracts on $30 settled cash to clamp to 1 contract, got ${oversizedHftWinnerData.order?.quantity}`
    );

    const oversizedScalpRes = await fetch(`${baseUrl}/api/lead-lag/execute-zero-hold-scalp`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ seriesTicker: 'KXBTC15M', requestedContracts: 20, timeframe: '5m' }),
    });
    const oversizedScalpData = (await oversizedScalpRes.json()) as Record<string, any>;
    assert.equal(oversizedScalpRes.status, 200);
    assert.equal(oversizedScalpData.executedCount, 1);
    assert.equal(
      oversizedScalpData.executedScalps?.[0]?.contracts,
      1,
      `Expected zero-hold-scalp 20 contracts on $30 settled cash to clamp to 1 contract, got ${oversizedScalpData.executedScalps?.[0]?.contracts}`
    );

    const oversizedFiveGateRes = await fetch(`${baseUrl}/api/kalshi/five-gate-evaluate`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        market_ticker: 'KXBTC15M-SMOKE14CAP',
        series_ticker: 'KXBTC15M',
        kalshi_mid_prob: 0.50,
        yes_bid_dollars: 0.49,
        yes_ask_dollars: 0.51,
        execution_price: 0.50,
        calibrated_yes_prob: 0.78,
        confidence_band: 0.06,
        is_maker: true,
        recommended_side: 'yes',
        timeframe: '5m',
      }),
    });
    const oversizedFiveGateData = (await oversizedFiveGateRes.json()) as Record<string, any>;
    assert.equal(oversizedFiveGateRes.status, 200);
    assert.equal(oversizedFiveGateData.ok, true);
    assert.equal(oversizedFiveGateData.v2_maker_order?.ok, true);
    assert.equal(
      oversizedFiveGateData.gates?.gate4_half_kelly_sizing?.contractsSized,
      1,
      `Expected five-gate-evaluate on $30 settled cash to clamp to 1 contract, got ${oversizedFiveGateData.gates?.gate4_half_kelly_sizing?.contractsSized}`
    );
    console.log(
      'PASS [TASK-14 (c)]: Secondary routes clamped oversized orders strictly to 3% settled cash (Public <= $15 on $500 cash despite $10k margin; Kalshi 1 contract on $30 cash).'
    );

    // (d) Rule 3 Pre-Exit Sweep on placePublicTakeProfitSellOrders (CancelAllOpenOrders -> confirm 0 resting -> sell exact settled qty)
    const savedPubPositions = livePublicPositions.splice(0, livePublicPositions.length);
    try {
      livePublicPositions.push({
        symbol: 'SPY',
        name: 'SPDR S&P 500 ETF Trust',
        instrumentType: 'EQUITY',
        quantity: 3,
        marketValue: 1515,
        currentPrice: 505,
        averagePrice: 500,
        unrealizedPnl: 15,
        gainPercentage: 1.0,
        dailyGainUsd: 7.5,
        percentOfPortfolio: 100,
      });

      let openOrderCountToReturn = 2; // First simulate 2 stuck open orders blocking balance release
      let cancelInvocations = 0;
      let submittedExitTotalQty = 0;

      setTestVenueExitHooks({
        cancelOpenOrders: async () => {
          cancelInvocations += 1;
          return openOrderCountToReturn;
        },
        getOpenOrdersCount: async () => openOrderCountToReturn,
        getSettledPositionQty: async () => 2, // Settled qty is 2 (smaller than nominal pos.quantity=3)
        submitPublicExit: async (params) => {
          submittedExitTotalQty += Number(params.quantity);
          return { ok: true, liveSubmitted: true, orderId: 'pub-rule3-confirmed-1' };
        },
      });

      const blockedExit = await placePublicTakeProfitSellOrders({ force: true });
      assert.equal(
        blockedExit.placedCount,
        0,
        'Expected Rule 3 sweep to withhold exit when resting open orders do not reach 0'
      );

      openOrderCountToReturn = 0; // Now simulate clean balance/collateral release
      cancelInvocations = 0;
      submittedExitTotalQty = 0;
      const confirmedExit = await placePublicTakeProfitSellOrders({ force: true });
      assert.equal(confirmedExit.placedCount, 1);
      assert(cancelInvocations >= 1, 'Expected Rule 3 sweep to call cancelAllOpenOrders before SELL');
      assert.equal(
        submittedExitTotalQty,
        2,
        `Expected Rule 3 exit tranches to sum to exact settled qty 2, got ${submittedExitTotalQty}`
      );
      assert.equal(
        confirmedExit.publicSellOrders[0].quantity,
        2,
        `Expected recorded SELL order quantity to be 2, got ${confirmedExit.publicSellOrders[0].quantity}`
      );
      console.log(
        'PASS [TASK-14 (d)]: placePublicTakeProfitSellOrders enforced Rule 3 sweep (withheld when openOrders>0, cancelled & sold exact settled qty=2).'
      );
    } finally {
      setTestVenueExitHooks(null);
      livePublicPositions.splice(0, livePublicPositions.length, ...savedPubPositions);
    }

    // -------------------------------------------------------------------------
    // SECTION-74-FIX [VAULT-FIX]: Single-Drag Net-Edge Gate, Fail-Closed Fetcher, Shadow Lock
    // -------------------------------------------------------------------------
    const {
      evaluateSingleDragEdgeGate,
      evaluateOrderFlowToxicityAndBasis,
    } = await import('../src/strategies/LeadLagAnomalyTriggers');

    // (a) Net-edge single deduction: $0.12 stressed drag charged exactly once
    // grossEdge = $0.20 with small atr14ProbUsd = $0.04 (0.12 + 1.1*0.04 = 0.164 < 0.20, floor 0.18 <= 0.20) -> PASS
    // grossEdge = $0.15 with small atr14ProbUsd = $0.02 (0.15 < 0.18) -> FAIL
    // grossEdge = $0.20 with large atr14ProbUsd = $0.10 (0.12 + 1.1*0.10 = 0.23 > 0.20) -> FAIL
    const gatePass20 = evaluateSingleDragEdgeGate(0.80, 0.60, 0.04);
    assert.equal(gatePass20.passed, true);
    assert.equal(gatePass20.grossEdgeDollars, 0.2);
    assert.equal(gatePass20.netEdgeAfterDragDollars, 0.08);
    assert.equal(gatePass20.requiredGrossEdgeDollars, 0.18);

    const gateFail15 = evaluateSingleDragEdgeGate(0.75, 0.60, 0.02);
    assert.equal(gateFail15.passed, false);
    assert.equal(gateFail15.grossEdgeDollars, 0.15);
    assert.equal(gateFail15.netEdgeAfterDragDollars, 0.03);

    const gateFailHighAtr = evaluateSingleDragEdgeGate(0.80, 0.60, 0.10);
    assert.equal(gateFailHighAtr.passed, false);
    assert.equal(gateFailHighAtr.requiredGrossEdgeDollars, 0.23);

    // SVB-60 single-drag check
    const svbPass20 = evaluateSvb60Trigger({
      zVelocityChecks5s: [2.85, 3.02],
      coinbaseSpotUsd: 91250,
      krakenSpotUsd: 91244,
      kalshiAskMove10sDollars: 0.005,
      fairValueProb: 0.80,
      kalshiAskDollars: 0.60,
      atr14ProbUsd: 0.04,
      minutesRemaining: 9.0,
      spotLatencyMs: 120,
      kalshiLatencyMs: 220,
      interVenueSkewMs: 35,
    });
    assert.equal(svbPass20.fvEdgePassed, true);
    assert.equal(svbPass20.triggered, true);
    assert.equal(svbPass20.netEdgeAfterDragDollars, 0.08);

    const svbFail15 = evaluateSvb60Trigger({
      zVelocityChecks5s: [2.85, 3.02],
      coinbaseSpotUsd: 91250,
      krakenSpotUsd: 91244,
      kalshiAskMove10sDollars: 0.005,
      fairValueProb: 0.75,
      kalshiAskDollars: 0.60,
      atr14ProbUsd: 0.02,
      minutesRemaining: 9.0,
      spotLatencyMs: 120,
      kalshiLatencyMs: 220,
      interVenueSkewMs: 35,
    });
    assert.equal(svbFail15.fvEdgePassed, false);
    assert.equal(svbFail15.triggered, false);

    // GKX-5 single-drag check
    const gkxPass20 = evaluateGkx5Trigger({
      rGkRatio: 1.78,
      zVelocity5m: 2.3,
      intraCandleVelocitySigns: [0.9, 1.5, 2.3],
      deltaFvProjDollars: 0.26,
      fairValueProb: 0.80,
      kalshiAskDollars: 0.60,
      atr14ProbUsd: 0.04,
      candleFinalizationLatencyMs: 350,
      kalshiLatencyMs: 240,
    });
    assert.equal(gkxPass20.fvEdgePassed, true);
    assert.equal(gkxPass20.triggered, true);
    assert.equal(gkxPass20.netEdgeAfterDragDollars, 0.08);

    const gkxFail15 = evaluateGkx5Trigger({
      rGkRatio: 1.78,
      zVelocity5m: 2.3,
      intraCandleVelocitySigns: [0.9, 1.5, 2.3],
      deltaFvProjDollars: 0.26,
      fairValueProb: 0.75,
      kalshiAskDollars: 0.60,
      atr14ProbUsd: 0.02,
      candleFinalizationLatencyMs: 350,
      kalshiLatencyMs: 240,
    });
    assert.equal(gkxFail15.fvEdgePassed, false);
    assert.equal(gkxFail15.triggered, false);

    // XVD single-drag check
    const xvdPass20 = evaluateXvdTrigger({
      snapshots: [
        { timestampMs: 1000, kalshiProb: 0.60, polymarketProb: 0.79 },
        { timestampMs: 2600, kalshiProb: 0.60, polymarketProb: 0.79 },
        { timestampMs: 4200, kalshiProb: 0.60, polymarketProb: 0.79 },
      ],
      identicalSettlementSource: true,
      spotFairValueProb: 0.80,
      leadingVenueProb: 0.79,
      laggingVenueAskDollars: 0.60,
      atr14ProbUsd: 0.04,
      kalshiLatencyMs: 200,
      polymarketLatencyMs: 220,
      spotLatencyMs: 90,
      interVenueSkewMs: 80,
    });
    assert.equal(xvdPass20.fvEdgePassed, true);
    assert.equal(xvdPass20.triggered, true);
    assert.equal(xvdPass20.netEdgeAfterDragDollars, 0.08);

    const xvdFail15 = evaluateXvdTrigger({
      snapshots: [
        { timestampMs: 1000, kalshiProb: 0.60, polymarketProb: 0.74 },
        { timestampMs: 2600, kalshiProb: 0.60, polymarketProb: 0.74 },
        { timestampMs: 4200, kalshiProb: 0.60, polymarketProb: 0.74 },
      ],
      identicalSettlementSource: true,
      spotFairValueProb: 0.75,
      leadingVenueProb: 0.74,
      laggingVenueAskDollars: 0.60,
      atr14ProbUsd: 0.02,
      kalshiLatencyMs: 200,
      polymarketLatencyMs: 220,
      spotLatencyMs: 90,
      interVenueSkewMs: 80,
    });
    assert.equal(xvdFail15.fvEdgePassed, false);
    assert.equal(xvdFail15.triggered, false);

    // Order-flow toxicity helper single-drag check (previously double-counted reserves against 0.18)
    const toxPass20 = evaluateOrderFlowToxicityAndBasis({
      trigger: 'SVB-60',
      feedAgeMs: 120,
      fv: 0.80,
      ask: 0.60,
      atr14ProbUsd: 0.04,
      feesPerShare: 0.12,
      basisBp: 4,
      vpin: [0.42, 0.45],
    });
    assert.equal(toxPass20.allowed, true);
    assert.equal(toxPass20.code, 'OK');
    assert.equal(toxPass20.netEdgeAfterReserves, 0.08);

    const toxFail15 = evaluateOrderFlowToxicityAndBasis({
      trigger: 'SVB-60',
      feedAgeMs: 120,
      fv: 0.75,
      ask: 0.60,
      atr14ProbUsd: 0.02,
      feesPerShare: 0.12,
      basisBp: 4,
      vpin: [0.42, 0.45],
    });
    assert.equal(toxFail15.allowed, false);
    assert.equal(toxFail15.code, 'EDGE_BELOW_FLOOR');

    console.log(
      'PASS [SECTION-74-FIX (a)]: Single drag deduction verified across evaluateSingleDragEdgeGate, SVB-60, GKX-5, XVD, and evaluateOrderFlowToxicityAndBasis ($0.20 gross / small ATR passes; $0.15 gross fails; high ATR hurdle fails).'
    );

    // (b) Fetcher fail-closed: missing real history yields INSUFFICIENT_REAL_HISTORY and 0 generated bars
    const {
      runWalkForwardEvaluation,
      alignRealWalkForwardBars,
      fetchPaginatedKalshiKxbtc15mCandles,
    } = await import('../scripts/fetch_walk_forward_history');

    const emptyFetchMock: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('coinbase.com')) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ markets: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const wfEndSec = 1_763_424_000;
    const wfStartSec = wfEndSec - 300 * 10;
    const missingHistRes = await runWalkForwardEvaluation({
      startSec: wfStartSec,
      endSec: wfEndSec,
      requiredCoinbaseBars: 10,
      fetchFn: emptyFetchMock,
      rateLimitDelayMs: 0,
      writeConfig: false,
    });
    assert.equal(missingHistRes.status, 'INSUFFICIENT_REAL_HISTORY');
    assert.equal(missingHistRes.code, 'INSUFFICIENT_REAL_HISTORY');
    assert.equal(missingHistRes.generatedBarsCount, 0);
    assert.equal(missingHistRes.coinbaseBarsCount, 0);
    assert.equal(missingHistRes.kalshiCandlesCount, 0);
    assert.equal(missingHistRes.alignedBarsCount, 0);
    assert.equal(missingHistRes.baseline_metrics, null);
    assert.equal(missingHistRes.oos_metrics, null);
    assert(
      missingHistRes.gaps.some((g) => g.ticker === 'BTC-USD' && g.code === 'INSUFFICIENT_REAL_HISTORY'),
      'Expected INSUFFICIENT_REAL_HISTORY gap recorded for BTC-USD'
    );
    assert(
      missingHistRes.gaps.some((g) => g.ticker === 'KXBTC15M' && g.code === 'INSUFFICIENT_REAL_HISTORY'),
      'Expected INSUFFICIENT_REAL_HISTORY gap recorded for KXBTC15M'
    );

    // Alignment with real Coinbase bars but missing Kalshi quotes must skip all steps and generate 0 synthetic quotes
    const sampleRealCbBars = Array.from({ length: 5 }, (_, idx) => ({
      timestamp: new Date((wfStartSec + idx * 300) * 1000).toISOString(),
      open: 90000 + idx * 10,
      high: 90050 + idx * 10,
      low: 89950 + idx * 10,
      close: 90020 + idx * 10,
      volume: 15,
      vwap: 90006.67,
    }));
    const alignMissingKalshi = alignRealWalkForwardBars(sampleRealCbBars, new Map());
    assert.equal(alignMissingKalshi.status, 'INSUFFICIENT_REAL_HISTORY');
    assert.equal(alignMissingKalshi.alignedBars.length, 0);
    assert.equal(alignMissingKalshi.skippedSteps, 5);
    assert.equal(alignMissingKalshi.generatedBarsCount, 0);
    assert.equal(alignMissingKalshi.gaps[0]?.ticker, 'KXBTC15M');

    // Verify artificial 40-ticker cap is removed: 45 tickers across 2 cursor pages must all be queried
    const page1Markets = Array.from({ length: 25 }, (_, idx) => ({
      ticker: `KXBTC15M-UNIV-${String(idx + 1).padStart(2, '0')}`,
      close_time: new Date(wfEndSec * 1000).toISOString(),
    }));
    const page2Markets = Array.from({ length: 20 }, (_, idx) => ({
      ticker: `KXBTC15M-UNIV-${String(idx + 26).padStart(2, '0')}`,
      close_time: new Date(wfEndSec * 1000).toISOString(),
    }));
    const paginationFetchMock: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('/markets?')) {
        const isPage2 = url.includes('cursor=page2');
        return new Response(
          JSON.stringify(
            isPage2
              ? { markets: page2Markets }
              : { markets: page1Markets, cursor: 'page2' }
          ),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.includes('KXBTC15M-UNIV-45')) {
        // Deliberately omit yes_bid/yes_ask to prove no synthetic 0.58 quote is fabricated
        return new Response(
          JSON.stringify({
            candlesticks: [{ end_period_ts: wfEndSec, price: {} }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(
        JSON.stringify({
          candlesticks: [
            {
              end_period_ts: wfStartSec + 300,
              yes_bid: { close_dollars: '0.57' },
              yes_ask: { close_dollars: '0.59' },
              price: { close_dollars: '0.58' },
              volume: 120,
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };
    const kalshiUniverse = await fetchPaginatedKalshiKxbtc15mCandles(wfStartSec, wfEndSec, {
      fetchFn: paginationFetchMock,
      rateLimitDelayMs: 0,
    });
    assert.equal(
      kalshiUniverse.tickersQueried.length,
      45,
      `Expected all 45 Kalshi tickers across paginated universe to be queried (no 40-ticker cap), got ${kalshiUniverse.tickersQueried.length}`
    );
    assert(
      kalshiUniverse.gaps.some((g) => g.ticker === 'KXBTC15M-UNIV-45' && g.code === 'INSUFFICIENT_REAL_HISTORY'),
      'Expected incomplete candlestick on KXBTC15M-UNIV-45 to record INSUFFICIENT_REAL_HISTORY without fabricating 0.58 quote'
    );

    console.log(
      'PASS [SECTION-74-FIX (b)]: Walk-forward history fetcher fails closed with INSUFFICIENT_REAL_HISTORY, generates 0 synthetic bars/quotes, and paginates full ticker universe (>40 tickers).'
    );

    // (c) Shadow lock in champion_config.json
    const freshChampionConfig = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), 'champion_config.json'), 'utf-8')
    ) as Record<string, any>;
    assert.equal(
      freshChampionConfig.lead_lag_triggers?.mode,
      'shadow',
      `Expected champion_config.json lead_lag_triggers.mode === 'shadow', got ${freshChampionConfig.lead_lag_triggers?.mode}`
    );
    assert.equal(
      freshChampionConfig.task07c?.live_enabled,
      false,
      `Expected champion_config.json task07c.live_enabled === false, got ${freshChampionConfig.task07c?.live_enabled}`
    );
    assert.equal(
      freshChampionConfig.task07c?.mode,
      'shadow',
      `Expected champion_config.json task07c.mode === 'shadow', got ${freshChampionConfig.task07c?.mode}`
    );
    console.log(
      'PASS [SECTION-74-FIX (c)]: champion_config.json shadow lock verified (lead_lag_triggers.mode="shadow", task07c.live_enabled=false).'
    );

    // -------------------------------------------------------------------------
    // SECTION-74-FOLLOWUP [VAULT-FIX]: regimeLiquidityFilter.ts Single-Drag Gate & Parity
    // -------------------------------------------------------------------------
    const followupNowMs = Date.now();
    const followupHealthyObi = [
      { tsMs: followupNowMs - 600, bidDepthUsd: 3400, askDepthUsd: 3100 },
      { tsMs: followupNowMs - 200, bidDepthUsd: 3500, askDepthUsd: 3000 },
    ];
    const followupHealthyMetrics = {
      chop14: 42.0,
      adx: 30.0,
      kaufmanEr10: 0.45,
      bbwPercentile125: 0.45,
      atrRatioPercentile125: 0.40,
      garmanKlassVrpPercentile: 0.55,
    };
    const evalRegimeEdgeCase = (grossEdge: number, atr14Usd: number) =>
      evaluateRegimeAndLiquidity({
        timeframe: '15m',
        askPriceUsd: 0.60,
        bestBidUsd: 0.58,
        bestAskUsd: 0.60,
        fairValueUsd: Number((0.60 + grossEdge).toFixed(6)),
        atr14Usd,
        minutesRemaining: 8.5,
        bboDepthUsd: 6500,
        obiSamples: followupHealthyObi,
        nowMs: followupNowMs,
        metricsOverride: followupHealthyMetrics,
      });

    // (a) Single drag deduction in evaluateRegimeAndLiquidity:
    // grossEdge = $0.20, atr14 = $0.04 (0.12 + 1.1*0.04 = 0.164 < 0.20, floor $0.18 <= 0.20) -> PASS
    const regPass20 = evalRegimeEdgeCase(0.20, 0.04);
    assert.equal(
      regPass20.approved,
      true,
      `Expected grossEdge=$0.20 / atr=$0.04 to PASS evaluateRegimeAndLiquidity, got blockReasons=${regPass20.blockReasons.join('; ')}`
    );
    assert.equal(regPass20.observedGrossEdgeUsd, 0.2);
    assert.equal(regPass20.observedNetEdgeUsd, 0.08);
    assert.equal(regPass20.requiredGrossEdgeUsd, 0.18);
    assert.equal(regPass20.entryEdgeRequiredUsd, 0.06);

    // grossEdge = $0.15, atr14 = $0.02 -> FAIL
    const regFail15 = evalRegimeEdgeCase(0.15, 0.02);
    assert.equal(regFail15.approved, false);
    assert.equal(regFail15.observedGrossEdgeUsd, 0.15);
    assert.equal(regFail15.observedNetEdgeUsd, 0.03);
    assert(
      regFail15.blockReasons.some((r) => r.includes('Edge below floor')),
      `Expected edge block reason on grossEdge=$0.15, got ${regFail15.blockReasons.join('; ')}`
    );

    // grossEdge = $0.20, atr14 = $0.10 (0.12 + 1.1*0.10 = 0.23 > 0.20) -> FAIL
    const regFailHighAtr = evalRegimeEdgeCase(0.20, 0.10);
    assert.equal(regFailHighAtr.approved, false);
    assert.equal(regFailHighAtr.requiredGrossEdgeUsd, 0.23);

    console.log(
      'PASS [SECTION-74-FOLLOWUP (a)]: evaluateRegimeAndLiquidity charges $0.12 drag once ($0.20 gross / small ATR passes; $0.15 gross fails; high ATR hurdle fails).'
    );

    // (b) Exact pass/fail & threshold consistency between regimeLiquidityFilter.ts and LeadLagAnomalyTriggers.ts
    const parityMatrix: Array<{ grossEdge: number; atr14Usd: number; expectedPass: boolean }> = [
      { grossEdge: 0.20, atr14Usd: 0.04, expectedPass: true },
      { grossEdge: 0.18, atr14Usd: 0.05, expectedPass: true },
      { grossEdge: 0.179, atr14Usd: 0.05, expectedPass: false },
      { grossEdge: 0.15, atr14Usd: 0.02, expectedPass: false },
      { grossEdge: 0.20, atr14Usd: 0.10, expectedPass: false },
      { grossEdge: 0.23, atr14Usd: 0.10, expectedPass: true },
      { grossEdge: 0.229, atr14Usd: 0.10, expectedPass: false },
      { grossEdge: 0.26, atr14Usd: 0.12, expectedPass: true },
    ];
    for (const row of parityMatrix) {
      const regVerdict = evalRegimeEdgeCase(row.grossEdge, row.atr14Usd);
      const trigGate = evaluateSingleDragEdgeGate(
        Number((0.60 + row.grossEdge).toFixed(6)),
        0.60,
        row.atr14Usd
      );
      assert.equal(
        regVerdict.approved,
        row.expectedPass,
        `Unexpected regimeLiquidityFilter verdict for grossEdge=${row.grossEdge}, atr=${row.atr14Usd}`
      );
      assert.equal(
        regVerdict.approved,
        trigGate.passed,
        `Parity mismatch between regimeLiquidityFilter (${regVerdict.approved}) and LeadLagAnomalyTriggers (${trigGate.passed}) for grossEdge=${row.grossEdge}, atr=${row.atr14Usd}`
      );
      assert.equal(
        regVerdict.requiredGrossEdgeUsd,
        Number(trigGate.requiredGrossEdgeDollars.toFixed(4)),
        `Required gross edge mismatch for grossEdge=${row.grossEdge}, atr=${row.atr14Usd}`
      );
      assert.equal(
        regVerdict.observedNetEdgeUsd,
        Number(trigGate.netEdgeAfterDragDollars.toFixed(4)),
        `Observed net edge mismatch for grossEdge=${row.grossEdge}, atr=${row.atr14Usd}`
      );
    }
    console.log(
      `PASS [SECTION-74-FOLLOWUP (b)]: Parity verified across all ${parityMatrix.length} (grossEdge, ATR) test cases between evaluateRegimeAndLiquidity and evaluateSingleDragEdgeGate.`
    );

    // -------------------------------------------------------------------------
    // FIX G [VAULT-FIX]: Kalshi Candlestick Fetch Interval=1 & <=5,000-Candle Lifetime Clip
    // -------------------------------------------------------------------------
    const {
      buildKalshiTickerCandlestickParams,
      KALSHI_MAX_CANDLES_PER_REQUEST,
      TOTAL_BARS_5M,
      GRANULARITY_SECONDS,
    } = await import('../scripts/fetch_walk_forward_history');

    const fixGWindowEndSec = 1_795_200_000;
    const fixGWindowStartSec = fixGWindowEndSec - TOTAL_BARS_5M * GRANULARITY_SECONDS; // full 37d+60m window
    const knownCloseSec = fixGWindowEndSec - 86_400; // 1 day before window end
    const capturedCandleUrls: URL[] = [];

    const fixGFetchMock: typeof fetch = async (input) => {
      const urlStr = String(input);
      if (urlStr.includes('/markets?')) {
        return new Response(
          JSON.stringify({
            markets: [
              {
                ticker: 'KXBTC15M-FIXG-KNOWN',
                close_time: new Date(knownCloseSec * 1000).toISOString(),
              },
              {
                ticker: 'KXBTC15M-FIXG-NOCLOSE',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      capturedCandleUrls.push(new URL(urlStr));
      return new Response(
        JSON.stringify({
          candlesticks: [
            {
              end_period_ts: knownCloseSec - 60,
              yes_bid: { close_dollars: '0.56' },
              yes_ask: { close_dollars: '0.58' },
              price: { close_dollars: '0.57' },
              volume: 42,
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const fixGRes = await fetchPaginatedKalshiKxbtc15mCandles(
      fixGWindowStartSec,
      fixGWindowEndSec,
      { fetchFn: fixGFetchMock, rateLimitDelayMs: 0 }
    );
    assert.equal(fixGRes.tickersQueried.length, 2);
    assert.equal(capturedCandleUrls.length, 2);

    const knownUrl = capturedCandleUrls.find((u) => u.pathname.includes('KXBTC15M-FIXG-KNOWN'));
    const noCloseUrl = capturedCandleUrls.find((u) => u.pathname.includes('KXBTC15M-FIXG-NOCLOSE'));
    assert(knownUrl, 'Expected candlestick request for KXBTC15M-FIXG-KNOWN');
    assert(noCloseUrl, 'Expected candlestick request for KXBTC15M-FIXG-NOCLOSE');

    // (a) Candlestick request for known-close ticker uses valid period_interval='1' (never invalid '5')
    assert.equal(knownUrl.searchParams.get('period_interval'), '1');

    // (c) Known-close ticker gets clipped lifetime window: [max(windowStart, closeSec - 7200), min(windowEnd, closeSec + 300)]
    const knownStartTs = Number(knownUrl.searchParams.get('start_ts'));
    const knownEndTs = Number(knownUrl.searchParams.get('end_ts'));
    assert.equal(knownStartTs, Math.max(fixGWindowStartSec, knownCloseSec - 7200));
    assert.equal(knownEndTs, Math.min(fixGWindowEndSec, knownCloseSec + 300));
    assert(knownEndTs - knownStartTs === 7500, `Expected clipped 7500s span, got ${knownEndTs - knownStartTs}`);

    // (b) Every per-ticker request stays strictly <= 5,000 candles at its requested interval
    for (const u of capturedCandleUrls) {
      const intervalMin = Number(u.searchParams.get('period_interval'));
      assert(
        intervalMin === 1 || intervalMin === 60 || intervalMin === 1440,
        `Invalid Kalshi period_interval=${intervalMin} (must be 1, 60, or 1440)`
      );
      const sTs = Number(u.searchParams.get('start_ts'));
      const eTs = Number(u.searchParams.get('end_ts'));
      const candlesRequested = Math.ceil((eTs - sTs) / (intervalMin * 60));
      assert(
        candlesRequested <= KALSHI_MAX_CANDLES_PER_REQUEST,
        `Per-ticker request ${u.pathname} requested ${candlesRequested} candles > cap ${KALSHI_MAX_CANDLES_PER_REQUEST}`
      );
    }

    // Fallback check: ticker with no parseable close_time uses period_interval='60' over full 37d window (<= 5,000 candles)
    assert.equal(noCloseUrl.searchParams.get('period_interval'), '60');
    assert.equal(Number(noCloseUrl.searchParams.get('start_ts')), fixGWindowStartSec);
    assert.equal(Number(noCloseUrl.searchParams.get('end_ts')), fixGWindowEndSec);

    // Pathological 1-year window with null closeSec also stays <= 5,000 candles
    const longFallback = buildKalshiTickerCandlestickParams(
      fixGWindowEndSec - 365 * 86_400,
      fixGWindowEndSec,
      null
    );
    assert(longFallback !== null);
    assert.equal(longFallback.periodInterval, '60');
    assert(longFallback.estimatedCandles <= KALSHI_MAX_CANDLES_PER_REQUEST);

    // Batch mode check: adjacent tickers group under period_interval='1', span <= 5,000, and tickers * span <= 10,000
    const capturedBatchUrls: URL[] = [];
    const batchMock: typeof fetch = async (input) => {
      const urlStr = String(input);
      if (urlStr.includes('/markets?')) {
        return new Response(
          JSON.stringify({
            markets: [
              { ticker: 'KXBTC15M-BATCH-1', close_time: new Date((knownCloseSec - 900) * 1000).toISOString() },
              { ticker: 'KXBTC15M-BATCH-2', close_time: new Date(knownCloseSec * 1000).toISOString() },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      capturedBatchUrls.push(new URL(urlStr));
      return new Response(
        JSON.stringify({
          markets: [
            {
              market_ticker: 'KXBTC15M-BATCH-1',
              candlesticks: [
                {
                  end_period_ts: knownCloseSec - 960,
                  yes_bid: { close_dollars: '0.54' },
                  yes_ask: { close_dollars: '0.56' },
                  price: { close_dollars: '0.55' },
                  volume: 10,
                },
              ],
            },
            {
              market_ticker: 'KXBTC15M-BATCH-2',
              candlesticks: [
                {
                  end_period_ts: knownCloseSec - 60,
                  yes_bid: { close_dollars: '0.57' },
                  yes_ask: { close_dollars: '0.59' },
                  price: { close_dollars: '0.58' },
                  volume: 12,
                },
              ],
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };
    const batchRes = await fetchPaginatedKalshiKxbtc15mCandles(
      fixGWindowStartSec,
      fixGWindowEndSec,
      { fetchFn: batchMock, rateLimitDelayMs: 0, batchSize: 20 }
    );
    assert.equal(batchRes.tickersQueried.length, 2);
    assert.equal(batchRes.candles.size, 2);
    assert.equal(capturedBatchUrls.length, 1);
    assert.equal(capturedBatchUrls[0].searchParams.get('period_interval'), '1');
    const bSpanMin = Math.ceil(
      (Number(capturedBatchUrls[0].searchParams.get('end_ts')) -
        Number(capturedBatchUrls[0].searchParams.get('start_ts'))) /
        60
    );
    assert(bSpanMin <= KALSHI_MAX_CANDLES_PER_REQUEST, `Batch span ${bSpanMin} exceeds 5,000 cap`);
    assert(2 * bSpanMin <= 10_000, `Batch total candles ${2 * bSpanMin} exceeds 10,000 Kalshi cap`);

    console.log(
      'PASS [FIX G (a)-(c)]: Kalshi candlestick requests use period_interval=1 with clipped [close-7200, close+300] lifetime window (<=125 candles), period_interval=60 fallback when close time is missing, batch cap <=10,000 total candles, and never exceed 5,000 candles/ticker.'
    );

    console.log('\nALL SMOKE TESTS (a)-(j) + FIXES (A)-(G) + 2.6.0-PORTFOLIO-GUARD + 2.7.0-LEAD-LAG-LIVE-CHAMPION + LOW_BALANCE_COMPOUNDER + TASK-14-RISK-GUARD + SECTION-74-FIX + SECTION-74-FOLLOWUP PASSED.');
  } finally {
    setTestVenueExitHooks(null);
    setCustomTokenVerifier(null);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tempLedgerDir, { recursive: true, force: true });
  }
}

runSmokeSuite().catch((err) => {
  console.error('SMOKE TEST FAILURE:', err);
  process.exit(1);
});
