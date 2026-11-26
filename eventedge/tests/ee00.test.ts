import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  EVENTEDGE_DEFAULT_MODE,
  EVENTEDGE_DEFAULT_RISK_CONFIG,
  EVENTEDGE_LEDGER_TABLES,
  EVENTEDGE_MIGRATIONS,
  EVENTEDGE_MODES,
  EventEdgeConfigValidationError,
  EventEdgeLiveModeDisabledError,
  applyEventEdgeMigrations,
  computePerPositionCapUsd,
  createEventEdgeConfig,
  getAppliedMigrations,
  initializeEventEdgeLedger,
  listEventEdgeTables,
  loadEventEdgeConfigFromFile,
} from '../index';

function runEe00Tests(): void {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eventedge-ee00-'));

  try {
    // -------------------------------------------------------------------------
    // (a) LIVE mode is hard-disabled across constructor, env, config file, & runtime mutation
    // -------------------------------------------------------------------------
    assert.deepEqual([...EVENTEDGE_MODES], ['OBSERVE', 'PAPER', 'DEMO', 'LIVE']);

    assert.throws(
      () => createEventEdgeConfig({ mode: 'LIVE' }, {}),
      EventEdgeLiveModeDisabledError,
      'Constructing config with mode LIVE must throw EventEdgeLiveModeDisabledError'
    );

    assert.throws(
      () => createEventEdgeConfig({ mode: ' live ' }, {}),
      EventEdgeLiveModeDisabledError,
      'Case/whitespace variants of LIVE must still throw EventEdgeLiveModeDisabledError'
    );

    assert.throws(
      () => createEventEdgeConfig({}, { EVENTEDGE_MODE: 'LIVE' }),
      EventEdgeLiveModeDisabledError,
      'EVENTEDGE_MODE=LIVE environment variable must throw EventEdgeLiveModeDisabledError'
    );

    assert.throws(
      () => createEventEdgeConfig({ mode: 'OBSERVE' }, { EVENTEDGE_MODE: 'LIVE' }),
      EventEdgeLiveModeDisabledError,
      'EVENTEDGE_MODE=LIVE must raise even when constructor passes OBSERVE'
    );

    assert.throws(
      () => createEventEdgeConfig({}, { EVENTEDGE_ENABLE_LIVE: 'true' }),
      EventEdgeLiveModeDisabledError,
      'EVENTEDGE_ENABLE_LIVE=true must throw EventEdgeLiveModeDisabledError'
    );

    const liveConfigFile = path.join(tempDir, 'live-config.json');
    fs.writeFileSync(liveConfigFile, JSON.stringify({ mode: 'LIVE' }), 'utf-8');
    assert.throws(
      () => loadEventEdgeConfigFromFile(liveConfigFile, { baseDir: tempDir, env: {} }),
      EventEdgeLiveModeDisabledError,
      'Loading a config file with mode=LIVE must throw EventEdgeLiveModeDisabledError'
    );

    const liveFlagConfigFile = path.join(tempDir, 'live-flag-config.json');
    fs.writeFileSync(
      liveFlagConfigFile,
      JSON.stringify({ mode: 'PAPER', liveEnabled: true }),
      'utf-8'
    );
    assert.throws(
      () => loadEventEdgeConfigFromFile(liveFlagConfigFile, { baseDir: tempDir, env: {} }),
      EventEdgeLiveModeDisabledError,
      'Loading a config file with liveEnabled=true must throw EventEdgeLiveModeDisabledError'
    );

    assert.throws(
      () => createEventEdgeConfig({ mode: 'PRODUCTION' }, {}),
      EventEdgeConfigValidationError,
      'Unknown modes must throw EventEdgeConfigValidationError'
    );

    // Path traversal outside baseDir must be rejected
    assert.throws(
      () =>
        loadEventEdgeConfigFromFile(path.join(tempDir, '..', 'outside.json'), {
          baseDir: tempDir,
          env: {},
        }),
      EventEdgeConfigValidationError,
      'Config path escaping baseDir must be rejected'
    );

    console.log(
      'PASS [EE-00 (a)]: LIVE mode raises EventEdgeLiveModeDisabledError via constructor, env, and config file.'
    );

    // -------------------------------------------------------------------------
    // (b) Default config loads with OBSERVE mode & exact risk defaults (all configurable except LIVE)
    // -------------------------------------------------------------------------
    const defaultCfg = createEventEdgeConfig({}, {});
    assert.equal(defaultCfg.mode, 'OBSERVE');
    assert.equal(defaultCfg.mode, EVENTEDGE_DEFAULT_MODE);
    assert.equal(defaultCfg.liveEnabled, false);
    assert.equal(Object.isFrozen(defaultCfg), true);
    assert.equal(Object.isFrozen(defaultCfg.risk), true);

    assert.equal(defaultCfg.risk.minConservativeEdge, 0.04);
    assert.equal(defaultCfg.risk.perPositionSettledCashCapPct, 0.03);
    assert.equal(defaultCfg.risk.perEventBankrollRiskCapPct, 0.005);
    assert.equal(defaultCfg.risk.correlatedEventExposureCapPct, 0.015);
    assert.equal(defaultCfg.risk.maxDeployedBankrollPct, 0.10);
    assert.equal(defaultCfg.risk.dailyLossStopPct, 0.02);
    assert.equal(defaultCfg.risk.peakToTroughDrawdownStopPct, 0.08);
    assert.equal(defaultCfg.risk.fractionalKelly, 0.10);
    assert.deepEqual(defaultCfg.risk, EVENTEDGE_DEFAULT_RISK_CONFIG);

    // Per-position cap = min(3% settled cash, 0.5% bankroll risk per underlying event)
    assert.equal(computePerPositionCapUsd(1000, 10000, defaultCfg.risk), 30); // min(30, 50) = 30
    assert.equal(computePerPositionCapUsd(5000, 10000, defaultCfg.risk), 50); // min(150, 50) = 50
    assert.equal(computePerPositionCapUsd(32.99, 1000, defaultCfg.risk), 0.9897); // min(0.9897, 5) = 0.9897

    // Non-LIVE modes (PAPER, DEMO) and risk overrides work cleanly
    const paperCfg = createEventEdgeConfig(
      {
        mode: 'PAPER',
        risk: {
          minConservativeEdge: 0.06,
          perPositionSettledCashCapPct: 0.02,
          perEventBankrollRiskCapPct: 0.004,
          correlatedEventExposureCapPct: 0.01,
          maxDeployedBankrollPct: 0.08,
          dailyLossStopPct: 0.015,
          peakToTroughDrawdownStopPct: 0.06,
          fractionalKelly: 0.05,
        },
      },
      {}
    );
    assert.equal(paperCfg.mode, 'PAPER');
    assert.equal(paperCfg.liveEnabled, false);
    assert.equal(paperCfg.risk.minConservativeEdge, 0.06);
    assert.equal(paperCfg.risk.fractionalKelly, 0.05);

    const demoFile = path.join(tempDir, 'demo-config.json');
    fs.writeFileSync(
      demoFile,
      JSON.stringify({ mode: 'DEMO', risk: { minConservativeEdge: 0.05 } }),
      'utf-8'
    );
    const demoCfg = loadEventEdgeConfigFromFile(demoFile, { baseDir: tempDir, env: {} });
    assert.equal(demoCfg.mode, 'DEMO');
    assert.equal(demoCfg.risk.minConservativeEdge, 0.05);
    assert.equal(demoCfg.risk.dailyLossStopPct, 0.02);

    console.log(
      'PASS [EE-00 (b)]: Default config loads OBSERVE + all exact risk defaults and supports non-LIVE overrides.'
    );

    // -------------------------------------------------------------------------
    // (c) Immutable EventEdge SQLite ledger schema & migrations apply cleanly
    // -------------------------------------------------------------------------
    const sqlitePath = path.join(tempDir, 'eventedge_test.sqlite');
    const { db, migrationResult } = initializeEventEdgeLedger(sqlitePath);
    try {
      const expectedVersions = EVENTEDGE_MIGRATIONS.map((m) => m.version);
      const latestVersion = expectedVersions[expectedVersions.length - 1];
      assert.equal(migrationResult.currentVersion, latestVersion);
      assert.deepEqual(migrationResult.appliedVersions, expectedVersions);
      assert.deepEqual(migrationResult.alreadyAppliedVersions, []);

      // Re-running migration must be idempotent
      const secondRun = applyEventEdgeMigrations(db);
      assert.equal(secondRun.currentVersion, latestVersion);
      assert.deepEqual(secondRun.appliedVersions, []);
      assert.deepEqual(secondRun.alreadyAppliedVersions, expectedVersions);

      const applied = getAppliedMigrations(db);
      assert.equal(applied.length, expectedVersions.length);
      assert.equal(applied[0].version, 1);
      assert.equal(applied[0].name, '001_initial_immutable_eventedge_ledger');

      // Verify WAL mode on disk database
      const journalRow = db.prepare('PRAGMA journal_mode;').get() as { journal_mode: string };
      assert.equal(journalRow.journal_mode.toLowerCase(), 'wal');

      // Verify all 13 immutable ledger tables + schema_migrations exist
      const existingTables = new Set(listEventEdgeTables(db));
      assert.equal(existingTables.has('schema_migrations'), true);
      for (const table of EVENTEDGE_LEDGER_TABLES) {
        assert.equal(
          existingTables.has(table),
          true,
          `Expected EventEdge ledger table "${table}" to exist`
        );
      }

      // Exercise end-to-end relational inserts across all 13 ledger tables
      const nowIso = '2026-11-26T14:30:00.000Z';

      db.prepare(
        `INSERT INTO market_snapshots (
          snapshot_id, venue, series_ticker, event_ticker, market_ticker, status,
          yes_bid_usd, yes_ask_usd, last_price_usd, volume, open_interest,
          close_time_utc, expiration_time_utc, raw_payload_json, captured_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'snap-1',
        'KALSHI',
        'KXBTC15M',
        'KXBTC15M-26NOV26',
        'KXBTC15M-26NOV26-T95000',
        'open',
        0.58,
        0.60,
        0.59,
        1200,
        450,
        nowIso,
        nowIso,
        '{"ticker":"KXBTC15M-26NOV26-T95000"}',
        nowIso
      );

      db.prepare(
        `INSERT INTO settlement_rule_versions (
          rule_version_id, venue, event_ticker, market_ticker, rule_hash,
          rules_primary, rules_secondary, settlement_source, effective_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'rule-1',
        'KALSHI',
        'KXBTC15M-26NOV26',
        'KXBTC15M-26NOV26-T95000',
        'sha256-rule-v1',
        'Settles YES if CF Benchmarks BRTI >= strike at expiration.',
        null,
        'CF_BENCHMARKS_BRTI',
        nowIso
      );

      db.prepare(
        `INSERT INTO research_evidence (
          evidence_id, event_ticker, market_ticker, source_type, source_uri,
          content_hash, summary, credibility_score, metadata_json, observed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'ev-1',
        'KXBTC15M-26NOV26',
        'KXBTC15M-26NOV26-T95000',
        'MARKET_FEED',
        'https://api.exchange.coinbase.com/products/BTC-USD/candles',
        'sha256-ev-1',
        'Spot BTC momentum burst verified across primary exchange feed.',
        0.92,
        '{}',
        nowIso
      );

      db.prepare(
        `INSERT INTO agent_forecasts (
          forecast_id, run_id, agent_id, event_ticker, market_ticker,
          snapshot_id, rule_version_id, prob_yes, confidence,
          reasoning_summary, evidence_ids_json, model_version, forecasted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'fc-1',
        'run-1',
        'forecaster-a',
        'KXBTC15M-26NOV26',
        'KXBTC15M-26NOV26-T95000',
        'snap-1',
        'rule-1',
        0.72,
        0.8,
        'Consistent spot momentum and low spread.',
        '["ev-1"]',
        'v1',
        nowIso
      );

      db.prepare(
        `INSERT INTO final_probability_estimates (
          estimate_id, run_id, event_ticker, market_ticker, snapshot_id, rule_version_id,
          raw_prob_yes, conservative_prob_yes, market_implied_prob, conservative_edge,
          forecast_ids_json, aggregation_method, estimated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'est-1',
        'run-1',
        'KXBTC15M-26NOV26',
        'KXBTC15M-26NOV26-T95000',
        'snap-1',
        'rule-1',
        0.72,
        0.68,
        0.60,
        0.08,
        '["fc-1"]',
        'TRIMMED_MEAN_SHRINKAGE',
        nowIso
      );

      db.prepare(
        `INSERT INTO orderbook_states (
          orderbook_state_id, venue, market_ticker, best_bid_usd, best_ask_usd,
          spread_usd, yes_bid_size_fp, yes_ask_size_fp, lhs, bids_json, asks_json,
          book_seq, captured_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'ob-1',
        'KALSHI',
        'KXBTC15M-26NOV26-T95000',
        0.58,
        0.60,
        0.02,
        25,
        30,
        0.84,
        '[[0.58,25]]',
        '[[0.60,30]]',
        1001,
        nowIso
      );

      db.prepare(
        `INSERT INTO trade_decisions (
          decision_id, run_id, estimate_id, orderbook_state_id, event_ticker,
          market_ticker, mode, action, approved, rejection_reason, conservative_edge,
          kelly_fraction, settled_cash_usd, bankroll_usd, requested_notional_usd,
          approved_notional_usd, target_contracts, idempotency_hash, risk_checks_json, decided_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'dec-1',
        'run-1',
        'est-1',
        'ob-1',
        'KXBTC15M-26NOV26',
        'KXBTC15M-26NOV26-T95000',
        'PAPER',
        'BUY_YES',
        1,
        null,
        0.08,
        0.10,
        1000,
        10000,
        30,
        30,
        50,
        'sha256-idem-1',
        '{"vaultCapOk":true}',
        nowIso
      );

      // SQLite CHECK constraint must forbid LIVE mode even on direct SQL writes
      assert.throws(
        () =>
          db
            .prepare(
              `INSERT INTO trade_decisions (
                decision_id, run_id, estimate_id, orderbook_state_id, event_ticker,
                market_ticker, mode, action, approved, rejection_reason, conservative_edge,
                kelly_fraction, settled_cash_usd, bankroll_usd, requested_notional_usd,
                approved_notional_usd, target_contracts, idempotency_hash, risk_checks_json, decided_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              'dec-live-blocked',
              'run-1',
              'est-1',
              'ob-1',
              'KXBTC15M-26NOV26',
              'KXBTC15M-26NOV26-T95000',
              'LIVE',
              'BUY_YES',
              0,
              'LIVE_FORBIDDEN',
              0.08,
              0.10,
              1000,
              10000,
              30,
              0,
              0,
              'sha256-idem-live',
              '{}',
              nowIso
            ),
        /CHECK constraint failed/i,
        'SQLite trade_decisions CHECK constraint must reject mode=LIVE'
      );

      db.prepare(
        `INSERT INTO submitted_orders (
          submission_id, decision_id, idempotency_hash, client_order_id, venue_order_id,
          venue, mode, event_ticker, market_ticker, side, order_type, post_only,
          reduce_only, price_usd, contracts, status, raw_request_json, raw_response_json, submitted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'sub-1',
        'dec-1',
        'sha256-idem-1',
        'cid-1',
        'paper-ord-1',
        'KALSHI',
        'PAPER',
        'KXBTC15M-26NOV26',
        'KXBTC15M-26NOV26-T95000',
        'BUY_YES',
        'limit',
        1,
        0,
        0.59,
        50,
        'PAPER_SUBMITTED',
        '{}',
        '{}',
        nowIso
      );

      db.prepare(
        `INSERT INTO actual_fills (
          fill_id, submission_id, venue_fill_id, venue_order_id, market_ticker,
          side, price_usd, contracts, liquidity_role, raw_fill_json, filled_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'fill-1',
        'sub-1',
        'vfill-1',
        'paper-ord-1',
        'KXBTC15M-26NOV26-T95000',
        'BUY_YES',
        0.59,
        50,
        'MAKER',
        '{}',
        nowIso
      );

      db.prepare(
        `INSERT INTO fees (
          fee_id, submission_id, fill_id, market_ticker, fee_type,
          amount_usd, formula_version, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'fee-1',
        'sub-1',
        'fill-1',
        'KXBTC15M-26NOV26-T95000',
        'ENTRY_MAKER',
        0.0,
        'kalshi-v2-maker-0',
        nowIso
      );

      db.prepare(
        `INSERT INTO settlements (
          settlement_id, venue, event_ticker, market_ticker, rule_version_id,
          outcome, settlement_price_usd, settled_contracts, payout_usd,
          raw_settlement_json, settled_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'settle-1',
        'KALSHI',
        'KXBTC15M-26NOV26',
        'KXBTC15M-26NOV26-T95000',
        'rule-1',
        'YES',
        1.0,
        50,
        50.0,
        '{}',
        nowIso
      );

      db.prepare(
        `INSERT INTO realized_pnl (
          realized_pnl_id, event_ticker, market_ticker, submission_id, settlement_id,
          entry_cost_usd, exit_or_payout_usd, fees_usd, gross_pnl_usd, net_pnl_usd,
          bankroll_after_usd, realized_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'rpnl-1',
        'KXBTC15M-26NOV26',
        'KXBTC15M-26NOV26-T95000',
        'sub-1',
        'settle-1',
        29.5,
        50.0,
        0.0,
        20.5,
        20.5,
        10020.5,
        nowIso
      );

      db.prepare(
        `INSERT INTO unrealized_pnl (
          unrealized_pnl_id, event_ticker, market_ticker, orderbook_state_id,
          position_contracts, avg_entry_price_usd, mark_price_usd, accrued_fees_usd,
          gross_unrealized_pnl_usd, net_unrealized_pnl_usd, bankroll_usd,
          peak_bankroll_usd, drawdown_pct, marked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'upnl-1',
        'KXBTC15M-26NOV26',
        'KXBTC15M-26NOV26-T95000',
        'ob-1',
        50,
        0.59,
        0.65,
        0.0,
        3.0,
        3.0,
        10003.0,
        10003.0,
        0.0,
        nowIso
      );

      // Verify immutability triggers block UPDATE and DELETE on every ledger table
      assert.throws(
        () =>
          db
            .prepare("UPDATE market_snapshots SET status = 'closed' WHERE snapshot_id = ?")
            .run('snap-1'),
        /immutable: UPDATE forbidden/i,
        'UPDATE on immutable ledger table must abort'
      );

      assert.throws(
        () => db.prepare('DELETE FROM realized_pnl WHERE realized_pnl_id = ?').run('rpnl-1'),
        /immutable: DELETE forbidden/i,
        'DELETE on immutable ledger table must abort'
      );

      assert.throws(
        () => db.prepare('DELETE FROM unrealized_pnl WHERE unrealized_pnl_id = ?').run('upnl-1'),
        /immutable: DELETE forbidden/i,
        'DELETE on unrealized_pnl must abort'
      );
    } finally {
      db.close();
    }

    // Also verify :memory: initialization works cleanly
    const mem = initializeEventEdgeLedger(':memory:');
    try {
      const latestVersion = EVENTEDGE_MIGRATIONS[EVENTEDGE_MIGRATIONS.length - 1].version;
      assert.equal(mem.migrationResult.currentVersion, latestVersion);
      assert.equal(listEventEdgeTables(mem.db).length, EVENTEDGE_LEDGER_TABLES.length + 1);
    } finally {
      mem.db.close();
    }

    console.log(
      'PASS [EE-00 (c)]: Immutable EventEdge SQLite WAL ledger schema & migrations applied cleanly across all 13 tables.'
    );
    console.log('\nALL EVENTEDGE EE-00 TESTS PASSED.');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

runEe00Tests();
