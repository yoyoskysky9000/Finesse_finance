/**
 * Immutable EventEdge SQLite ledger schema & forward-only migrations.
 *
 * Matches the existing Finesse_finance backend storage pattern (`node:sqlite`
 * `DatabaseSync` in WAL mode) used by `src/server/ExecutionVault.ts`,
 * `src/server/riskGuard.ts`, and `server.ts`.
 *
 * Every ledger table is protected by SQLite `BEFORE UPDATE` and `BEFORE DELETE`
 * triggers calling `RAISE(ABORT, ...)` so persisted records are strictly
 * append-only / immutable at the database engine layer.
 */

export interface EventEdgeMigration {
  readonly version: number;
  readonly name: string;
  readonly statements: readonly string[];
}

export const EVENTEDGE_LEDGER_TABLES = [
  'market_snapshots',
  'settlement_rule_versions',
  'research_evidence',
  'agent_forecasts',
  'final_probability_estimates',
  'trade_decisions',
  'orderbook_states',
  'submitted_orders',
  'actual_fills',
  'fees',
  'settlements',
  'realized_pnl',
  'unrealized_pnl',
  'observe_run_summaries',
  'probability_forecasts',
  'experiments',
  'experiment_status_history',
  'contract_lifecycle_history',
  'shadow_decisions',
  'shadow_orders',
  'shadow_fills',
] as const;

export type EventEdgeLedgerTable = (typeof EVENTEDGE_LEDGER_TABLES)[number];

const V1_IMMUTABLE_TABLES: readonly EventEdgeLedgerTable[] = [
  'market_snapshots',
  'settlement_rule_versions',
  'research_evidence',
  'agent_forecasts',
  'final_probability_estimates',
  'trade_decisions',
  'orderbook_states',
  'submitted_orders',
  'actual_fills',
  'fees',
  'settlements',
  'realized_pnl',
  'unrealized_pnl',
];

function buildImmutabilityTriggers(tableName: EventEdgeLedgerTable): readonly string[] {
  return [
    `CREATE TRIGGER IF NOT EXISTS trg_${tableName}_no_update
     BEFORE UPDATE ON ${tableName}
     BEGIN
       SELECT RAISE(ABORT, 'EventEdge ledger table ${tableName} is immutable: UPDATE forbidden');
     END;`,
    `CREATE TRIGGER IF NOT EXISTS trg_${tableName}_no_delete
     BEFORE DELETE ON ${tableName}
     BEGIN
       SELECT RAISE(ABORT, 'EventEdge ledger table ${tableName} is immutable: DELETE forbidden');
     END;`,
  ];
}

const V1_TABLE_STATEMENTS: readonly string[] = [
  // 1. Market snapshots
  `CREATE TABLE IF NOT EXISTS market_snapshots (
    snapshot_id TEXT PRIMARY KEY,
    venue TEXT NOT NULL,
    series_ticker TEXT,
    event_ticker TEXT NOT NULL,
    market_ticker TEXT NOT NULL,
    status TEXT NOT NULL,
    yes_bid_usd REAL,
    yes_ask_usd REAL,
    last_price_usd REAL,
    volume INTEGER,
    open_interest INTEGER,
    close_time_utc TEXT,
    expiration_time_utc TEXT,
    raw_payload_json TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );`,
  `CREATE INDEX IF NOT EXISTS idx_ee_market_snapshots_ticker_time
    ON market_snapshots (market_ticker, captured_at);`,
  `CREATE INDEX IF NOT EXISTS idx_ee_market_snapshots_event
    ON market_snapshots (event_ticker, captured_at);`,

  // 2. Settlement rule versions
  `CREATE TABLE IF NOT EXISTS settlement_rule_versions (
    rule_version_id TEXT PRIMARY KEY,
    venue TEXT NOT NULL,
    event_ticker TEXT NOT NULL,
    market_ticker TEXT NOT NULL,
    rule_hash TEXT NOT NULL,
    rules_primary TEXT NOT NULL,
    rules_secondary TEXT,
    settlement_source TEXT NOT NULL,
    effective_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (market_ticker, rule_hash)
  );`,
  `CREATE INDEX IF NOT EXISTS idx_ee_settlement_rules_market
    ON settlement_rule_versions (market_ticker, effective_at);`,

  // 3. Research evidence
  `CREATE TABLE IF NOT EXISTS research_evidence (
    evidence_id TEXT PRIMARY KEY,
    event_ticker TEXT NOT NULL,
    market_ticker TEXT,
    source_type TEXT NOT NULL,
    source_uri TEXT,
    content_hash TEXT NOT NULL,
    summary TEXT NOT NULL,
    credibility_score REAL CHECK (credibility_score IS NULL OR (credibility_score >= 0.0 AND credibility_score <= 1.0)),
    metadata_json TEXT,
    observed_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );`,
  `CREATE INDEX IF NOT EXISTS idx_ee_research_evidence_event_time
    ON research_evidence (event_ticker, observed_at);`,

  // 4. Agent forecasts
  `CREATE TABLE IF NOT EXISTS agent_forecasts (
    forecast_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    event_ticker TEXT NOT NULL,
    market_ticker TEXT NOT NULL,
    snapshot_id TEXT REFERENCES market_snapshots(snapshot_id),
    rule_version_id TEXT REFERENCES settlement_rule_versions(rule_version_id),
    prob_yes REAL NOT NULL CHECK (prob_yes >= 0.0 AND prob_yes <= 1.0),
    confidence REAL NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
    reasoning_summary TEXT NOT NULL,
    evidence_ids_json TEXT NOT NULL,
    model_version TEXT,
    forecasted_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );`,
  `CREATE INDEX IF NOT EXISTS idx_ee_agent_forecasts_market_run
    ON agent_forecasts (market_ticker, run_id, forecasted_at);`,

  // 5. Final probability estimates
  `CREATE TABLE IF NOT EXISTS final_probability_estimates (
    estimate_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    event_ticker TEXT NOT NULL,
    market_ticker TEXT NOT NULL,
    snapshot_id TEXT REFERENCES market_snapshots(snapshot_id),
    rule_version_id TEXT REFERENCES settlement_rule_versions(rule_version_id),
    raw_prob_yes REAL NOT NULL CHECK (raw_prob_yes >= 0.0 AND raw_prob_yes <= 1.0),
    conservative_prob_yes REAL NOT NULL CHECK (conservative_prob_yes >= 0.0 AND conservative_prob_yes <= 1.0),
    market_implied_prob REAL NOT NULL CHECK (market_implied_prob >= 0.0 AND market_implied_prob <= 1.0),
    conservative_edge REAL NOT NULL,
    forecast_ids_json TEXT NOT NULL,
    aggregation_method TEXT NOT NULL,
    estimated_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );`,
  `CREATE INDEX IF NOT EXISTS idx_ee_final_estimates_market_time
    ON final_probability_estimates (market_ticker, estimated_at);`,

  // 6. Orderbook states (created before trade_decisions / submitted_orders so FK can reference it)
  `CREATE TABLE IF NOT EXISTS orderbook_states (
    orderbook_state_id TEXT PRIMARY KEY,
    venue TEXT NOT NULL,
    market_ticker TEXT NOT NULL,
    best_bid_usd REAL,
    best_ask_usd REAL,
    spread_usd REAL,
    yes_bid_size_fp REAL,
    yes_ask_size_fp REAL,
    lhs REAL CHECK (lhs IS NULL OR (lhs >= 0.0 AND lhs <= 1.0)),
    bids_json TEXT NOT NULL,
    asks_json TEXT NOT NULL,
    book_seq INTEGER,
    captured_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );`,
  `CREATE INDEX IF NOT EXISTS idx_ee_orderbook_states_market_time
    ON orderbook_states (market_ticker, captured_at);`,

  // 7. Trade decisions (mode CHECK strictly forbids LIVE at database layer as well)
  `CREATE TABLE IF NOT EXISTS trade_decisions (
    decision_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    estimate_id TEXT NOT NULL REFERENCES final_probability_estimates(estimate_id),
    orderbook_state_id TEXT REFERENCES orderbook_states(orderbook_state_id),
    event_ticker TEXT NOT NULL,
    market_ticker TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('OBSERVE', 'PAPER', 'DEMO')),
    action TEXT NOT NULL CHECK (action IN ('BUY_YES', 'BUY_NO', 'SELL_YES', 'SELL_NO', 'HOLD', 'REJECT')),
    approved INTEGER NOT NULL CHECK (approved IN (0, 1)),
    rejection_reason TEXT,
    conservative_edge REAL NOT NULL,
    kelly_fraction REAL NOT NULL,
    settled_cash_usd REAL NOT NULL,
    bankroll_usd REAL NOT NULL,
    requested_notional_usd REAL NOT NULL,
    approved_notional_usd REAL NOT NULL,
    target_contracts INTEGER NOT NULL,
    idempotency_hash TEXT,
    risk_checks_json TEXT NOT NULL,
    decided_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );`,
  `CREATE INDEX IF NOT EXISTS idx_ee_trade_decisions_market_time
    ON trade_decisions (market_ticker, decided_at);`,
  `CREATE INDEX IF NOT EXISTS idx_ee_trade_decisions_idempotency
    ON trade_decisions (idempotency_hash);`,

  // 8. Submitted orders (mode CHECK strictly forbids LIVE)
  `CREATE TABLE IF NOT EXISTS submitted_orders (
    submission_id TEXT PRIMARY KEY,
    decision_id TEXT NOT NULL REFERENCES trade_decisions(decision_id),
    idempotency_hash TEXT NOT NULL,
    client_order_id TEXT NOT NULL,
    venue_order_id TEXT,
    venue TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('OBSERVE', 'PAPER', 'DEMO')),
    event_ticker TEXT NOT NULL,
    market_ticker TEXT NOT NULL,
    side TEXT NOT NULL,
    order_type TEXT NOT NULL,
    post_only INTEGER NOT NULL CHECK (post_only IN (0, 1)),
    reduce_only INTEGER NOT NULL DEFAULT 0 CHECK (reduce_only IN (0, 1)),
    price_usd REAL NOT NULL,
    contracts INTEGER NOT NULL CHECK (contracts > 0),
    status TEXT NOT NULL,
    raw_request_json TEXT NOT NULL,
    raw_response_json TEXT,
    submitted_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );`,
  `CREATE INDEX IF NOT EXISTS idx_ee_submitted_orders_idempotency
    ON submitted_orders (idempotency_hash);`,
  `CREATE INDEX IF NOT EXISTS idx_ee_submitted_orders_venue_id
    ON submitted_orders (venue_order_id);`,

  // 9. Actual fills
  `CREATE TABLE IF NOT EXISTS actual_fills (
    fill_id TEXT PRIMARY KEY,
    submission_id TEXT NOT NULL REFERENCES submitted_orders(submission_id),
    venue_fill_id TEXT,
    venue_order_id TEXT,
    market_ticker TEXT NOT NULL,
    side TEXT NOT NULL,
    price_usd REAL NOT NULL,
    contracts INTEGER NOT NULL CHECK (contracts > 0),
    liquidity_role TEXT NOT NULL CHECK (liquidity_role IN ('MAKER', 'TAKER')),
    raw_fill_json TEXT NOT NULL,
    filled_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );`,
  `CREATE INDEX IF NOT EXISTS idx_ee_actual_fills_submission
    ON actual_fills (submission_id, filled_at);`,

  // 10. Fees
  `CREATE TABLE IF NOT EXISTS fees (
    fee_id TEXT PRIMARY KEY,
    submission_id TEXT REFERENCES submitted_orders(submission_id),
    fill_id TEXT REFERENCES actual_fills(fill_id),
    market_ticker TEXT NOT NULL,
    fee_type TEXT NOT NULL CHECK (fee_type IN ('ENTRY_MAKER', 'ENTRY_TAKER', 'EXIT_MAKER', 'EXIT_TAKER', 'SETTLEMENT', 'OTHER')),
    amount_usd REAL NOT NULL CHECK (amount_usd >= 0.0),
    formula_version TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );`,
  `CREATE INDEX IF NOT EXISTS idx_ee_fees_market_time
    ON fees (market_ticker, recorded_at);`,

  // 11. Settlements
  `CREATE TABLE IF NOT EXISTS settlements (
    settlement_id TEXT PRIMARY KEY,
    venue TEXT NOT NULL,
    event_ticker TEXT NOT NULL,
    market_ticker TEXT NOT NULL,
    rule_version_id TEXT REFERENCES settlement_rule_versions(rule_version_id),
    outcome TEXT NOT NULL CHECK (outcome IN ('YES', 'NO', 'VOID', 'CANCELLED')),
    settlement_price_usd REAL NOT NULL,
    settled_contracts INTEGER NOT NULL,
    payout_usd REAL NOT NULL,
    raw_settlement_json TEXT NOT NULL,
    settled_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );`,
  `CREATE INDEX IF NOT EXISTS idx_ee_settlements_market_time
    ON settlements (market_ticker, settled_at);`,

  // 12. Realized PnL
  `CREATE TABLE IF NOT EXISTS realized_pnl (
    realized_pnl_id TEXT PRIMARY KEY,
    event_ticker TEXT NOT NULL,
    market_ticker TEXT NOT NULL,
    submission_id TEXT REFERENCES submitted_orders(submission_id),
    settlement_id TEXT REFERENCES settlements(settlement_id),
    entry_cost_usd REAL NOT NULL,
    exit_or_payout_usd REAL NOT NULL,
    fees_usd REAL NOT NULL,
    gross_pnl_usd REAL NOT NULL,
    net_pnl_usd REAL NOT NULL,
    bankroll_after_usd REAL NOT NULL,
    realized_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );`,
  `CREATE INDEX IF NOT EXISTS idx_ee_realized_pnl_market_time
    ON realized_pnl (market_ticker, realized_at);`,

  // 13. Unrealized PnL
  `CREATE TABLE IF NOT EXISTS unrealized_pnl (
    unrealized_pnl_id TEXT PRIMARY KEY,
    event_ticker TEXT NOT NULL,
    market_ticker TEXT NOT NULL,
    orderbook_state_id TEXT REFERENCES orderbook_states(orderbook_state_id),
    position_contracts INTEGER NOT NULL,
    avg_entry_price_usd REAL NOT NULL,
    mark_price_usd REAL NOT NULL,
    accrued_fees_usd REAL NOT NULL,
    gross_unrealized_pnl_usd REAL NOT NULL,
    net_unrealized_pnl_usd REAL NOT NULL,
    bankroll_usd REAL NOT NULL,
    peak_bankroll_usd REAL NOT NULL,
    drawdown_pct REAL NOT NULL,
    marked_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );`,
  `CREATE INDEX IF NOT EXISTS idx_ee_unrealized_pnl_market_time
    ON unrealized_pnl (market_ticker, marked_at);`,
];

const V1_IMMUTABILITY_TRIGGERS: readonly string[] = V1_IMMUTABLE_TABLES.flatMap((table) =>
  buildImmutabilityTriggers(table)
);

const V2_EE01_STATEMENTS: readonly string[] = [
  // Extend market_snapshots for EE-01 discovery fields (category, terms/subtitle, NO bid/ask, settlement source name)
  `ALTER TABLE market_snapshots ADD COLUMN category TEXT;`,
  `ALTER TABLE market_snapshots ADD COLUMN market_terms TEXT;`,
  `ALTER TABLE market_snapshots ADD COLUMN no_bid_usd REAL;`,
  `ALTER TABLE market_snapshots ADD COLUMN no_ask_usd REAL;`,
  `ALTER TABLE market_snapshots ADD COLUMN settlement_source_name TEXT;`,
  `CREATE INDEX IF NOT EXISTS idx_ee_market_snapshots_category_close
    ON market_snapshots (category, close_time_utc);`,

  // Extend settlement_rule_versions for EE-01 resolution audit classification, reasons, and version sequence
  `ALTER TABLE settlement_rule_versions ADD COLUMN version_number INTEGER NOT NULL DEFAULT 1;`,
  `ALTER TABLE settlement_rule_versions ADD COLUMN audit_status TEXT NOT NULL DEFAULT 'AMBIGUOUS' CHECK (audit_status IN ('CLEAR', 'AMBIGUOUS'));`,
  `ALTER TABLE settlement_rule_versions ADD COLUMN ambiguity_reasons_json TEXT NOT NULL DEFAULT '[]';`,
  `ALTER TABLE settlement_rule_versions ADD COLUMN settlement_source_url TEXT;`,
  `ALTER TABLE settlement_rule_versions ADD COLUMN audited_at TEXT;`,
  `CREATE INDEX IF NOT EXISTS idx_ee_settlement_rules_status
    ON settlement_rule_versions (audit_status, market_ticker);`,

  // 14. Immutable OBSERVE-mode run summaries (discovery + resolution audit cycle telemetry)
  `CREATE TABLE IF NOT EXISTS observe_run_summaries (
    run_id TEXT PRIMARY KEY,
    mode TEXT NOT NULL CHECK (mode = 'OBSERVE'),
    started_at TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    events_fetched INTEGER NOT NULL,
    markets_fetched INTEGER NOT NULL,
    markets_filtered_out INTEGER NOT NULL,
    markets_scanned INTEGER NOT NULL,
    clear_count INTEGER NOT NULL,
    ambiguous_count INTEGER NOT NULL,
    new_rule_versions_count INTEGER NOT NULL,
    top_ambiguity_reasons_json TEXT NOT NULL,
    filter_config_json TEXT NOT NULL,
    summary_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );`,
  `CREATE INDEX IF NOT EXISTS idx_ee_observe_runs_started
    ON observe_run_summaries (started_at);`,
  ...buildImmutabilityTriggers('observe_run_summaries'),
];

const V3_EE02_STATEMENTS: readonly string[] = [
  // 15. Immutable price-blind probability forecasts (p_base, p_quant, p_ensemble; first-class abstention)
  `CREATE TABLE IF NOT EXISTS probability_forecasts (
    forecast_id TEXT PRIMARY KEY,
    experiment_id TEXT NOT NULL,
    market_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    event_family_id TEXT NOT NULL,
    event_family_derivation_version TEXT NOT NULL,
    forecast_stage TEXT NOT NULL CHECK (forecast_stage IN ('p_base', 'p_quant', 'p_ensemble')),
    status TEXT NOT NULL CHECK (status IN ('FORECAST', 'ABSTAINED')),
    probability REAL CHECK (
      (status = 'ABSTAINED' AND probability IS NULL)
      OR (status = 'FORECAST' AND probability IS NOT NULL AND probability >= 0.0 AND probability <= 1.0)
    ),
    uncertainty_lower REAL CHECK (uncertainty_lower IS NULL OR (uncertainty_lower >= 0.0 AND uncertainty_lower <= 1.0)),
    uncertainty_upper REAL CHECK (uncertainty_upper IS NULL OR (uncertainty_upper >= 0.0 AND uncertainty_upper <= 1.0)),
    uncertainty_method TEXT,
    extreme_probability_justified INTEGER NOT NULL DEFAULT 0 CHECK (extreme_probability_justified IN (0, 1)),
    extreme_probability_justification TEXT,
    abstention_reasons_json TEXT NOT NULL DEFAULT '[]',
    model_version TEXT NOT NULL,
    config_hash TEXT NOT NULL,
    code_commit_hash TEXT NOT NULL,
    data_snapshot_id TEXT NOT NULL,
    base_rate_version TEXT NOT NULL,
    ensemble_version TEXT NOT NULL,
    rule_version_id TEXT REFERENCES settlement_rule_versions(rule_version_id),
    component_forecast_ids_json TEXT NOT NULL DEFAULT '[]',
    ensemble_metadata_json TEXT,
    reference_class_json TEXT,
    feature_metadata_json TEXT,
    forecast_timestamp TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK (uncertainty_lower IS NULL OR uncertainty_upper IS NULL OR uncertainty_lower <= uncertainty_upper),
    CHECK (
      status = 'ABSTAINED'
      OR (probability > 0.0 AND probability < 1.0)
      OR (
        extreme_probability_justified = 1
        AND extreme_probability_justification IS NOT NULL
        AND length(trim(extreme_probability_justification)) > 0
      )
    )
  );`,
  `CREATE INDEX IF NOT EXISTS idx_ee_prob_forecasts_market_stage_time
    ON probability_forecasts (market_id, forecast_stage, forecast_timestamp);`,
  `CREATE INDEX IF NOT EXISTS idx_ee_prob_forecasts_experiment
    ON probability_forecasts (experiment_id, forecast_timestamp);`,
  `CREATE INDEX IF NOT EXISTS idx_ee_prob_forecasts_event_family
    ON probability_forecasts (event_family_id, forecast_timestamp);`,
  ...buildImmutabilityTriggers('probability_forecasts'),
];

const V4_EE03_STATEMENTS: readonly string[] = [
  // 16. Experiment Registry (append-only except controlled status-column transition)
  `CREATE TABLE IF NOT EXISTS experiments (
    experiment_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    hypothesis TEXT NOT NULL,
    registered_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('REGISTERED', 'RUNNING', 'COMPLETED', 'KILLED')),
    kill_criteria TEXT NOT NULL,
    sample_definition TEXT NOT NULL,
    model_version TEXT NOT NULL,
    config_hash TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );`,
  `CREATE INDEX IF NOT EXISTS idx_ee_experiments_status_time
    ON experiments (status, registered_at);`,

  // 17. Append-only Experiment Status History
  `CREATE TABLE IF NOT EXISTS experiment_status_history (
    history_id TEXT PRIMARY KEY,
    experiment_id TEXT NOT NULL REFERENCES experiments(experiment_id),
    from_status TEXT NOT NULL CHECK (from_status IN ('REGISTERED', 'RUNNING', 'COMPLETED', 'KILLED')),
    to_status TEXT NOT NULL CHECK (to_status IN ('REGISTERED', 'RUNNING', 'COMPLETED', 'KILLED')),
    reason TEXT NOT NULL,
    changed_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK (
      (from_status = 'REGISTERED' AND to_status = 'RUNNING')
      OR (from_status = 'RUNNING' AND to_status = 'COMPLETED')
      OR (from_status = 'RUNNING' AND to_status = 'KILLED')
    )
  );`,
  `CREATE INDEX IF NOT EXISTS idx_ee_exp_status_history_exp
    ON experiment_status_history (experiment_id, changed_at);`,
  ...buildImmutabilityTriggers('experiment_status_history'),

  // Controlled immutability triggers on experiments:
  // DELETE always aborts; UPDATE aborts unless ONLY status changes along a legal edge AND a
  // corresponding experiment_status_history row exists for that transition.
  `CREATE TRIGGER IF NOT EXISTS trg_experiments_no_delete
   BEFORE DELETE ON experiments
   BEGIN
     SELECT RAISE(ABORT, 'EventEdge ledger table experiments is immutable: DELETE forbidden');
   END;`,
  `CREATE TRIGGER IF NOT EXISTS trg_experiments_controlled_status_update
   BEFORE UPDATE ON experiments
   BEGIN
     SELECT CASE
       WHEN NEW.experiment_id IS NOT OLD.experiment_id
         OR NEW.title IS NOT OLD.title
         OR NEW.hypothesis IS NOT OLD.hypothesis
         OR NEW.registered_at IS NOT OLD.registered_at
         OR NEW.kill_criteria IS NOT OLD.kill_criteria
         OR NEW.sample_definition IS NOT OLD.sample_definition
         OR NEW.model_version IS NOT OLD.model_version
         OR NEW.config_hash IS NOT OLD.config_hash
         OR NEW.notes IS NOT OLD.notes
         OR NEW.created_at IS NOT OLD.created_at
       THEN RAISE(ABORT, 'EventEdge ledger table experiments is immutable: UPDATE forbidden on non-status columns')
     END;
     SELECT CASE
       WHEN NOT (
         (OLD.status = 'REGISTERED' AND NEW.status = 'RUNNING')
         OR (OLD.status = 'RUNNING' AND NEW.status = 'COMPLETED')
         OR (OLD.status = 'RUNNING' AND NEW.status = 'KILLED')
       )
       THEN RAISE(ABORT, 'EventEdge ledger table experiments: illegal status transition forbidden')
     END;
     SELECT CASE
       WHEN NOT EXISTS (
         SELECT 1 FROM experiment_status_history h
         WHERE h.experiment_id = NEW.experiment_id
           AND h.from_status = OLD.status
           AND h.to_status = NEW.status
       )
       THEN RAISE(ABORT, 'EventEdge ledger table experiments: direct status UPDATE without experiment_status_history forbidden')
     END;
   END;`,

  // 18. Append-only Contract Lifecycle History
  `CREATE TABLE IF NOT EXISTS contract_lifecycle_history (
    transition_id TEXT PRIMARY KEY,
    market_id TEXT NOT NULL,
    from_state TEXT CHECK (
      from_state IS NULL
      OR from_state IN (
        'DISCOVERED', 'AUDIT_PENDING', 'APPROVED', 'REJECTED',
        'ACTIVE', 'SETTLEMENT_PENDING', 'RESOLVED', 'DISPUTED', 'VOIDED'
      )
    ),
    to_state TEXT NOT NULL CHECK (
      to_state IN (
        'DISCOVERED', 'AUDIT_PENDING', 'APPROVED', 'REJECTED',
        'ACTIVE', 'SETTLEMENT_PENDING', 'RESOLVED', 'DISPUTED', 'VOIDED'
      )
    ),
    reason TEXT NOT NULL,
    actor TEXT NOT NULL,
    rule_version_id TEXT REFERENCES settlement_rule_versions(rule_version_id),
    transitioned_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );`,
  `CREATE INDEX IF NOT EXISTS idx_ee_contract_lifecycle_market_time
    ON contract_lifecycle_history (market_id, transitioned_at);`,
  ...buildImmutabilityTriggers('contract_lifecycle_history'),

  // Rules-revision hook trigger: whenever a new settlement_rule_versions row is inserted for a
  // contract currently in APPROVED or ACTIVE state, automatically append an AUDIT_PENDING
  // transition with reason = 'RULES_REVISED' and the new rule_version_id.
  `CREATE TRIGGER IF NOT EXISTS trg_settlement_rule_versions_lifecycle_revision
   AFTER INSERT ON settlement_rule_versions
   WHEN (
     SELECT to_state
     FROM contract_lifecycle_history
     WHERE market_id = NEW.market_ticker
     ORDER BY rowid DESC
     LIMIT 1
   ) IN ('APPROVED', 'ACTIVE')
   BEGIN
     INSERT INTO contract_lifecycle_history (
       transition_id,
       market_id,
       from_state,
       to_state,
       reason,
       actor,
       rule_version_id,
       transitioned_at
     ) VALUES (
       'lch_rev_' || NEW.rule_version_id,
       NEW.market_ticker,
       (
         SELECT to_state
         FROM contract_lifecycle_history
         WHERE market_id = NEW.market_ticker
         ORDER BY rowid DESC
         LIMIT 1
       ),
       'AUDIT_PENDING',
       'RULES_REVISED',
       'rules_revision_hook',
       NEW.rule_version_id,
       COALESCE(NEW.audited_at, NEW.effective_at)
     );
   END;`,
];

const V5_EE04_STATEMENTS: readonly string[] = [
  // Forward-only migration extending probability_forecasts.forecast_stage CHECK to include
  // 'p_calibrated' while preserving all existing rows untouched and restoring all indexes
  // and append-only immutability triggers.
  `CREATE TABLE probability_forecasts_v5 (
    forecast_id TEXT PRIMARY KEY,
    experiment_id TEXT NOT NULL,
    market_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    event_family_id TEXT NOT NULL,
    event_family_derivation_version TEXT NOT NULL,
    forecast_stage TEXT NOT NULL CHECK (forecast_stage IN ('p_base', 'p_quant', 'p_ensemble', 'p_calibrated')),
    status TEXT NOT NULL CHECK (status IN ('FORECAST', 'ABSTAINED')),
    probability REAL CHECK (
      (status = 'ABSTAINED' AND probability IS NULL)
      OR (status = 'FORECAST' AND probability IS NOT NULL AND probability >= 0.0 AND probability <= 1.0)
    ),
    uncertainty_lower REAL CHECK (uncertainty_lower IS NULL OR (uncertainty_lower >= 0.0 AND uncertainty_lower <= 1.0)),
    uncertainty_upper REAL CHECK (uncertainty_upper IS NULL OR (uncertainty_upper >= 0.0 AND uncertainty_upper <= 1.0)),
    uncertainty_method TEXT,
    extreme_probability_justified INTEGER NOT NULL DEFAULT 0 CHECK (extreme_probability_justified IN (0, 1)),
    extreme_probability_justification TEXT,
    abstention_reasons_json TEXT NOT NULL DEFAULT '[]',
    model_version TEXT NOT NULL,
    config_hash TEXT NOT NULL,
    code_commit_hash TEXT NOT NULL,
    data_snapshot_id TEXT NOT NULL,
    base_rate_version TEXT NOT NULL,
    ensemble_version TEXT NOT NULL,
    rule_version_id TEXT REFERENCES settlement_rule_versions(rule_version_id),
    component_forecast_ids_json TEXT NOT NULL DEFAULT '[]',
    ensemble_metadata_json TEXT,
    reference_class_json TEXT,
    feature_metadata_json TEXT,
    forecast_timestamp TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK (uncertainty_lower IS NULL OR uncertainty_upper IS NULL OR uncertainty_lower <= uncertainty_upper),
    CHECK (
      status = 'ABSTAINED'
      OR (probability > 0.0 AND probability < 1.0)
      OR (
        extreme_probability_justified = 1
        AND extreme_probability_justification IS NOT NULL
        AND length(trim(extreme_probability_justification)) > 0
      )
    )
  );`,
  `INSERT INTO probability_forecasts_v5 (
    forecast_id, experiment_id, market_id, event_id,
    event_family_id, event_family_derivation_version,
    forecast_stage, status, probability,
    uncertainty_lower, uncertainty_upper, uncertainty_method,
    extreme_probability_justified, extreme_probability_justification,
    abstention_reasons_json,
    model_version, config_hash, code_commit_hash,
    data_snapshot_id, base_rate_version, ensemble_version,
    rule_version_id, component_forecast_ids_json,
    ensemble_metadata_json, reference_class_json, feature_metadata_json,
    forecast_timestamp, created_at
  )
  SELECT
    forecast_id, experiment_id, market_id, event_id,
    event_family_id, event_family_derivation_version,
    forecast_stage, status, probability,
    uncertainty_lower, uncertainty_upper, uncertainty_method,
    extreme_probability_justified, extreme_probability_justification,
    abstention_reasons_json,
    model_version, config_hash, code_commit_hash,
    data_snapshot_id, base_rate_version, ensemble_version,
    rule_version_id, component_forecast_ids_json,
    ensemble_metadata_json, reference_class_json, feature_metadata_json,
    forecast_timestamp, created_at
  FROM probability_forecasts;`,
  `DROP TABLE probability_forecasts;`,
  `ALTER TABLE probability_forecasts_v5 RENAME TO probability_forecasts;`,
  `CREATE INDEX IF NOT EXISTS idx_ee_prob_forecasts_market_stage_time
    ON probability_forecasts (market_id, forecast_stage, forecast_timestamp);`,
  `CREATE INDEX IF NOT EXISTS idx_ee_prob_forecasts_experiment
    ON probability_forecasts (experiment_id, forecast_timestamp);`,
  `CREATE INDEX IF NOT EXISTS idx_ee_prob_forecasts_event_family
    ON probability_forecasts (event_family_id, forecast_timestamp);`,
  ...buildImmutabilityTriggers('probability_forecasts'),
];

const V6_EE05_STATEMENTS: readonly string[] = [
  // 19. Immutable Shadow Execution Decisions (paper-only; never touches live venues)
  `CREATE TABLE IF NOT EXISTS shadow_decisions (
    decision_id TEXT PRIMARY KEY,
    forecast_id TEXT NOT NULL REFERENCES probability_forecasts(forecast_id),
    forecast_stage TEXT NOT NULL CHECK (forecast_stage IN ('p_ensemble', 'p_calibrated')),
    experiment_id TEXT NOT NULL REFERENCES experiments(experiment_id),
    market_id TEXT NOT NULL,
    model_probability REAL NOT NULL CHECK (model_probability >= 0.0 AND model_probability <= 1.0),
    decision_timestamp TEXT NOT NULL,
    decision_book_snapshot_id TEXT NOT NULL,
    decision_book_captured_at TEXT NOT NULL,
    decision_yes_bid_usd REAL NOT NULL CHECK (decision_yes_bid_usd >= 0.0 AND decision_yes_bid_usd <= 1.0),
    decision_yes_ask_usd REAL NOT NULL CHECK (decision_yes_ask_usd >= 0.0 AND decision_yes_ask_usd <= 1.0),
    edge_yes REAL NOT NULL,
    edge_no REAL NOT NULL,
    selected_edge REAL NOT NULL,
    min_conservative_edge REAL NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('ORDER_CREATED', 'NO_EDGE')),
    side TEXT CHECK (side IS NULL OR side IN ('BUY_YES', 'BUY_NO')),
    requested_quantity INTEGER NOT NULL CHECK (requested_quantity > 0),
    config_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK (
      (outcome = 'NO_EDGE' AND side IS NULL)
      OR (outcome = 'ORDER_CREATED' AND side IS NOT NULL)
    )
  );`,
  `CREATE INDEX IF NOT EXISTS idx_ee_shadow_decisions_exp_market_time
    ON shadow_decisions (experiment_id, market_id, decision_timestamp);`,
  ...buildImmutabilityTriggers('shadow_decisions'),

  // 20. Immutable Shadow Execution Orders (only created when edge >= minConservativeEdge)
  `CREATE TABLE IF NOT EXISTS shadow_orders (
    order_id TEXT PRIMARY KEY,
    decision_id TEXT NOT NULL REFERENCES shadow_decisions(decision_id),
    experiment_id TEXT NOT NULL REFERENCES experiments(experiment_id),
    forecast_id TEXT NOT NULL REFERENCES probability_forecasts(forecast_id),
    market_id TEXT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('BUY_YES', 'BUY_NO')),
    requested_quantity INTEGER NOT NULL CHECK (requested_quantity > 0),
    decision_price_usd REAL NOT NULL CHECK (decision_price_usd >= 0.0 AND decision_price_usd <= 1.0),
    decision_book_snapshot_id TEXT NOT NULL,
    decision_timestamp TEXT NOT NULL,
    latency_model_version TEXT NOT NULL,
    latency_ms REAL NOT NULL CHECK (latency_ms >= 0.0),
    arrival_timestamp TEXT NOT NULL,
    config_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );`,
  `CREATE INDEX IF NOT EXISTS idx_ee_shadow_orders_decision
    ON shadow_orders (decision_id);`,
  `CREATE INDEX IF NOT EXISTS idx_ee_shadow_orders_exp_market
    ON shadow_orders (experiment_id, market_id, arrival_timestamp);`,
  ...buildImmutabilityTriggers('shadow_orders'),

  // 21. Immutable Shadow Execution Fills (simulated against arrival book displayed depth)
  `CREATE TABLE IF NOT EXISTS shadow_fills (
    fill_id TEXT PRIMARY KEY,
    order_id TEXT REFERENCES shadow_orders(order_id),
    decision_id TEXT NOT NULL REFERENCES shadow_decisions(decision_id),
    experiment_id TEXT NOT NULL REFERENCES experiments(experiment_id),
    market_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('FILLED', 'PARTIAL', 'NO_FILL')),
    side TEXT CHECK (side IS NULL OR side IN ('BUY_YES', 'BUY_NO')),
    requested_quantity INTEGER NOT NULL CHECK (requested_quantity > 0),
    filled_quantity INTEGER NOT NULL CHECK (filled_quantity >= 0),
    unfilled_quantity INTEGER NOT NULL CHECK (unfilled_quantity >= 0),
    fill_price_usd REAL CHECK (fill_price_usd IS NULL OR (fill_price_usd >= 0.0 AND fill_price_usd <= 1.0)),
    fee_usd REAL NOT NULL CHECK (fee_usd >= 0.0),
    fee_schedule_version TEXT NOT NULL,
    decision_book_snapshot_id TEXT NOT NULL,
    arrival_book_snapshot_id TEXT,
    arrival_book_captured_at TEXT,
    displayed_depth_at_price REAL,
    book_age_ms REAL,
    evaluated_at TEXT NOT NULL,
    reason_code TEXT CHECK (
      reason_code IS NULL
      OR reason_code IN ('NO_EDGE', 'BOOK_NOT_CAPTURED', 'STALE_BOOK', 'INSUFFICIENT_DEPTH')
    ),
    config_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK (filled_quantity + unfilled_quantity = requested_quantity),
    CHECK (
      (status = 'NO_FILL' AND filled_quantity = 0 AND reason_code IS NOT NULL)
      OR (status = 'PARTIAL' AND filled_quantity > 0 AND unfilled_quantity > 0 AND reason_code IS NULL)
      OR (status = 'FILLED' AND filled_quantity = requested_quantity AND unfilled_quantity = 0 AND reason_code IS NULL)
    ),
    CHECK (
      (reason_code = 'NO_EDGE' AND order_id IS NULL)
      OR (order_id IS NOT NULL)
    )
  );`,
  `CREATE INDEX IF NOT EXISTS idx_ee_shadow_fills_decision
    ON shadow_fills (decision_id);`,
  `CREATE INDEX IF NOT EXISTS idx_ee_shadow_fills_order
    ON shadow_fills (order_id);`,
  `CREATE INDEX IF NOT EXISTS idx_ee_shadow_fills_exp_market
    ON shadow_fills (experiment_id, market_id, evaluated_at);`,
  ...buildImmutabilityTriggers('shadow_fills'),
];

export const EVENTEDGE_MIGRATIONS: readonly EventEdgeMigration[] = Object.freeze([
  Object.freeze({
    version: 1,
    name: '001_initial_immutable_eventedge_ledger',
    statements: Object.freeze([...V1_TABLE_STATEMENTS, ...V1_IMMUTABILITY_TRIGGERS]),
  }),
  Object.freeze({
    version: 2,
    name: '002_ee01_discovery_resolution_and_observe_runs',
    statements: Object.freeze([...V2_EE01_STATEMENTS]),
  }),
  Object.freeze({
    version: 3,
    name: '003_ee02_price_blind_probability_forecasts',
    statements: Object.freeze([...V3_EE02_STATEMENTS]),
  }),
  Object.freeze({
    version: 4,
    name: '004_ee03_experiments_and_contract_lifecycle',
    statements: Object.freeze([...V4_EE03_STATEMENTS]),
  }),
  Object.freeze({
    version: 5,
    name: '005_ee04_allow_p_calibrated_forecast_stage',
    statements: Object.freeze([...V5_EE04_STATEMENTS]),
  }),
  Object.freeze({
    version: 6,
    name: '006_ee05_shadow_execution_tables',
    statements: Object.freeze([...V6_EE05_STATEMENTS]),
  }),
]);
