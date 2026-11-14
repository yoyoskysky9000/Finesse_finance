import assert from 'node:assert/strict';
import http from 'node:http';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

process.env.QUANTPULSE_TEST_MODE = 'true';
delete process.env.STRICT_API_AUTH_REQUIRED;

async function runSmokeSuite() {
  const { setCustomTokenVerifier } = await import('../src/server/phase1Security');
  const {
    app,
    autonomousAgents,
    executedOrders,
    marketFeatures,
    venueOrderSubmissionCount,
    resetVenueOrderSubmissionCount,
    setTestLiveCashBalances,
    orderRejectionLog,
    exitMonitorEvaluationLog,
    evaluateRealTimeRoiAndGlobalProfitLock,
  } = await import('../server');
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
        skipLiveCashSync: true,
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
      venueOrderSubmissionCount,
      0,
      `Expected 0 venue calls on position-cap rejection, got ${venueOrderSubmissionCount}`
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
        skipLiveCashSync: true,
      }),
    });
    assert.equal(firstExecRes.status, 200, `Expected 200 on first submission, got ${firstExecRes.status}`);
    const firstExecBody = (await firstExecRes.json()) as Record<string, any>;
    assert.equal(firstExecBody.idempotentReplay, false);
    assert.equal(firstExecBody.order.idempotencyKey, sharedIdempotencyKey);

    const ordersCountAfterFirst = executedOrders.length;
    const venueCallsAfterFirst = venueOrderSubmissionCount;

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
        skipLiveCashSync: true,
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
      venueOrderSubmissionCount,
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
    // Smoke Test (e): A position whose price crosses its take-profit gets an exit action from the daemon evaluation
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

    const evalSummary = await evaluateRealTimeRoiAndGlobalProfitLock({
      forceStepDownNow: false,
      applyYesterdayProfitableSetup: false,
    });

    assert.equal(
      testWorkingOrder.status,
      'FILLED',
      `Expected position crossing take-profit to be exited (status=FILLED), got ${testWorkingOrder.status}`
    );
    assert.equal(
      testWorkingOrder.lastExitEvaluationResult,
      'TRIGGERED_TAKE_PROFIT',
      `Expected lastExitEvaluationResult=TRIGGERED_TAKE_PROFIT, got ${testWorkingOrder.lastExitEvaluationResult}`
    );
    assert(
      Boolean(testWorkingOrder.lastExitEvaluatedAt),
      'Expected lastExitEvaluatedAt timestamp to be populated on open position'
    );
    assert(
      evalSummary.roiSellsTriggered >= 1,
      'Expected roiSellsTriggered >= 1 when take-profit is crossed'
    );
    const matchingLogEntry = exitMonitorEvaluationLog.find(
      (entry) => entry.targetId === testWorkingOrder.id
    );
    assert(
      matchingLogEntry && matchingLogEntry.result === 'TRIGGERED_TAKE_PROFIT',
      'Expected exitMonitorEvaluationLog to record TRIGGERED_TAKE_PROFIT for the position'
    );
    spyFeature.price = originalSpyPrice;
    console.log(
      'PASS [Smoke Test (e)]: Open position crossing take-profit received exit action and log entry from daemon evaluation.'
    );

    console.log('\nALL 5 SMOKE TESTS (a)-(e) PASSED.');
  } finally {
    setCustomTokenVerifier(null);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

runSmokeSuite().catch((err) => {
  console.error('SMOKE TEST FAILURE:', err);
  process.exit(1);
});
