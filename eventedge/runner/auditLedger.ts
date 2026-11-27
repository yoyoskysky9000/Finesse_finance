import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { getDefaultEventEdgeLedgerDbPath } from '../config/index';

type SafeQueryResult<T> = { ok: true; rows: T[] } | { ok: false; label: string; error: string };

function runSafeQuery<T = Record<string, unknown>>(
  db: DatabaseSync,
  label: string,
  sql: string,
  params: readonly (string | number | null)[] = []
): SafeQueryResult<T> {
  try {
    const stmt = db.prepare(sql);
    const rows = stmt.all(...params) as unknown as T[];
    return { ok: true, rows };
  } catch (err) {
    return {
      ok: false,
      label,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function unwrapQuery<T>(result: SafeQueryResult<T>): T[] | { error: string } {
  if ('rows' in result) {
    return result.rows;
  }
  return { error: result.error };
}

export function auditEventEdgeLedgerReadOnly(
  explicitPath?: string
): { ledgerPath: string; sizeBytes: number | null; migrationCount: number | null } {
  const ledgerPath = path.resolve(
    explicitPath ?? process.env.EVENTEDGE_LEDGER_DB ?? getDefaultEventEdgeLedgerDbPath()
  );

  if (!fs.existsSync(ledgerPath)) {
    const missingOutput = {
      ledger_path: ledgerPath,
      exists: false,
      error: `ENOENT: ledger file does not exist at ${ledgerPath}`,
    };
    console.log('=== 1. LEDGER FILE & SCHEMA MIGRATIONS ===');
    console.log(JSON.stringify(missingOutput, null, 2));
    return { ledgerPath, sizeBytes: null, migrationCount: null };
  }

  const stat = fs.statSync(ledgerPath);
  const sizeBytes = stat.size;

  // Strictly read-only handle — SQLite refuses any write, migration, or mutation
  const db = new DatabaseSync(ledgerPath, { readOnly: true });
  try {
    // 1. Ledger file path, byte size, and full schema_migrations contents
    const migrations = runSafeQuery(
      db,
      'schema_migrations',
      `SELECT * FROM schema_migrations ORDER BY version ASC`
    );
    const migrationCount = 'rows' in migrations ? migrations.rows.length : null;

    console.log('=== 1. LEDGER FILE & SCHEMA MIGRATIONS ===');
    console.log(
      JSON.stringify(
        {
          ledger_path: ledgerPath,
          size_bytes: sizeBytes,
          schema_migrations: unwrapQuery(migrations),
        },
        null,
        2
      )
    );

    // 2. Every row of experiments (all columns verbatim) + full status history per experiment
    const experiments = runSafeQuery(
      db,
      'experiments',
      `SELECT * FROM experiments ORDER BY registered_at ASC, rowid ASC`
    );
    const statusHistory = runSafeQuery(
      db,
      'experiment_status_history',
      `SELECT * FROM experiment_status_history ORDER BY experiment_id ASC, rowid ASC`
    );

    console.log('\n=== 2. EXPERIMENTS & STATUS HISTORY ===');
    console.log(
      JSON.stringify(
        {
          experiments: unwrapQuery(experiments),
          experiment_status_history: unwrapQuery(statusHistory),
        },
        null,
        2
      )
    );

    // 3. Grouped row counts
    const snapshotsTotal = runSafeQuery(
      db,
      'market_snapshots_total',
      `SELECT COUNT(*) AS count FROM market_snapshots`
    );
    const snapshotsByTargetEvents = runSafeQuery(
      db,
      'market_snapshots_by_target_events',
      `SELECT event_ticker, COUNT(*) AS count
       FROM market_snapshots
       WHERE event_ticker LIKE 'KXEARNINGSMENTIONKR-26DEC03%'
          OR event_ticker LIKE 'KXEARNINGSMENTIONCBRL-26DEC08%'
          OR event_ticker LIKE 'KXEARNINGSMENTIONAZO-26DEC08%'
          OR event_ticker LIKE 'KXFEDMENTION-26DEC%'
          OR event_ticker LIKE 'KXFEDDECISION-26DEC%'
       GROUP BY event_ticker
       ORDER BY event_ticker ASC`
    );
    const contractsByLifecycleState = runSafeQuery(
      db,
      'contracts_by_lifecycle_state',
      `SELECT latest.to_state AS lifecycle_state, COUNT(*) AS count
       FROM contract_lifecycle_history latest
       INNER JOIN (
         SELECT market_id, MAX(rowid) AS max_rowid
         FROM contract_lifecycle_history
         GROUP BY market_id
       ) m ON latest.market_id = m.market_id AND latest.rowid = m.max_rowid
       GROUP BY latest.to_state
       ORDER BY latest.to_state ASC`
    );
    const forecastsGrouped = runSafeQuery(
      db,
      'forecasts_by_experiment_and_stage',
      `SELECT experiment_id, forecast_stage AS stage, COUNT(*) AS count
       FROM probability_forecasts
       GROUP BY experiment_id, forecast_stage
       ORDER BY experiment_id ASC, forecast_stage ASC`
    );
    const shadowDecisionsTotal = runSafeQuery(
      db,
      'shadow_decisions_total',
      `SELECT COUNT(*) AS count FROM shadow_decisions`
    );
    const settlementsTotal = runSafeQuery(
      db,
      'settlements_total',
      `SELECT COUNT(*) AS count FROM settlements`
    );

    console.log('\n=== 3. ROW COUNTS (GROUPED) ===');
    console.log(
      JSON.stringify(
        {
          a_snapshots_total: unwrapQuery(snapshotsTotal),
          a_snapshots_by_target_event_prefixes: unwrapQuery(snapshotsByTargetEvents),
          b_contracts_by_lifecycle_state: unwrapQuery(contractsByLifecycleState),
          c_forecasts_by_experiment_and_stage: unwrapQuery(forecastsGrouped),
          d_shadow_decisions_total: unwrapQuery(shadowDecisionsTotal),
          e_settlements_total: unwrapQuery(settlementsTotal),
        },
        null,
        2
      )
    );

    // 4. 15 most recent forecast rows verbatim
    const recentForecasts = runSafeQuery(
      db,
      'recent_forecasts',
      `SELECT
        pf.market_id AS market_ticker,
        pf.experiment_id,
        pf.forecast_stage AS stage,
        CASE
          WHEN pf.forecast_stage = 'p_base' THEN pf.probability
          ELSE (
            SELECT s.probability
            FROM probability_forecasts s
            WHERE s.experiment_id = pf.experiment_id
              AND s.market_id = pf.market_id
              AND s.forecast_timestamp = pf.forecast_timestamp
              AND s.forecast_stage = 'p_base'
            ORDER BY s.rowid DESC
            LIMIT 1
          )
        END AS p_base,
        CASE
          WHEN pf.forecast_stage = 'p_quant' THEN pf.probability
          ELSE (
            SELECT s.probability
            FROM probability_forecasts s
            WHERE s.experiment_id = pf.experiment_id
              AND s.market_id = pf.market_id
              AND s.forecast_timestamp = pf.forecast_timestamp
              AND s.forecast_stage = 'p_quant'
            ORDER BY s.rowid DESC
            LIMIT 1
          )
        END AS p_quant,
        CASE
          WHEN pf.forecast_stage = 'p_ensemble' THEN pf.probability
          ELSE (
            SELECT s.probability
            FROM probability_forecasts s
            WHERE s.experiment_id = pf.experiment_id
              AND s.market_id = pf.market_id
              AND s.forecast_timestamp = pf.forecast_timestamp
              AND s.forecast_stage = 'p_ensemble'
            ORDER BY s.rowid DESC
            LIMIT 1
          )
        END AS p_ensemble,
        (
          SELECT CASE
            WHEN ms.yes_bid_usd IS NOT NULL AND ms.yes_ask_usd IS NOT NULL
              THEN (ms.yes_bid_usd + ms.yes_ask_usd) / 2.0
            WHEN ms.yes_ask_usd IS NOT NULL THEN ms.yes_ask_usd
            ELSE ms.last_price_usd
          END
          FROM market_snapshots ms
          WHERE ms.market_ticker = pf.market_id
            AND ms.captured_at <= pf.forecast_timestamp
          ORDER BY ms.captured_at DESC, ms.rowid DESC
          LIMIT 1
        ) AS market_reference_probability,
        pf.created_at
      FROM probability_forecasts pf
      ORDER BY pf.created_at DESC, pf.rowid DESC
      LIMIT 15`
    );

    console.log('\n=== 4. 15 MOST RECENT FORECAST ROWS ===');
    console.log(JSON.stringify(unwrapQuery(recentForecasts), null, 2));

    return { ledgerPath, sizeBytes, migrationCount };
  } finally {
    db.close();
  }
}

const isMain =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  auditEventEdgeLedgerReadOnly();
}
