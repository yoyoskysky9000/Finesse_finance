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

    // (10) Verify mcp_server.py 100% live-production wiring invariants (Part 1 & Part 2)
    const mcpSource = fs.readFileSync(path.resolve(process.cwd(), 'mcp_server.py'), 'utf-8');
    assert(!mcpSource.includes('625.35'), 'mcp_server.py must not contain hardcoded $625.35 balance');
    assert(!mcpSource.includes('435.08'), 'mcp_server.py must not contain hardcoded $435.08 cash');
    assert(!mcpSource.includes('459.34'), 'mcp_server.py must not contain hardcoded $459.34 cash');
    assert(!mcpSource.includes('555.81'), 'mcp_server.py must not contain hardcoded $555.81 NLV');
    assert(!mcpSource.includes('PORTFOLIO_SNAPSHOT: List'), 'mcp_server.py must not contain hardcoded PORTFOLIO_SNAPSHOT');
    assert(!mcpSource.includes('PAPER_LOGGED_BY_GATE_3'), 'mcp_server.py must not contain simulated PAPER_LOGGED_BY_GATE_3 state');
    assert(mcpSource.includes('BALANCE_UNVERIFIED_BLOCK'), 'mcp_server.py must return BALANCE_UNVERIFIED_BLOCK when live balance verification fails');
    assert(
      mcpSource.includes('INSERT OR REPLACE INTO ml_meta_model_state (\n                model_id,'),
      'mcp_server.py must use explicit column names on INSERT INTO ml_meta_model_state'
    );
    assert(
      mcpSource.includes("WHERE is_synthetic = FALSE AND source = 'LIVE_VENUE'"),
      'mcp_server.py must filter ML training queries with WHERE is_synthetic = FALSE AND source = \'LIVE_VENUE\''
    );
    assert(
      mcpSource.includes('def evaluate_portfolio_correlation_and_cap('),
      'mcp_server.py must enforce evaluate_portfolio_correlation_and_cap'
    );

    console.log(
      'PASS [TASK-08 / 2.6.0-PORTFOLIO-GUARD-CHAMPION]: PortfolioCorrelationGuard, Telemetry Completeness Gate, mcp_server.py 100% live wiring, and post-lock pre-exchange ordering passed.'
    );

    console.log('\nALL SMOKE TESTS (a)-(j) + FIXES (A)-(F) + 2.6.0-PORTFOLIO-GUARD + MCP LIVE WIRING PASSED.');
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
