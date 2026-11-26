import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EVENTEDGE_MIGRATIONS, type EventEdgeMigration } from './schema';

export interface AppliedMigrationRecord {
  version: number;
  name: string;
  checksum: string;
  applied_at: string;
}

export interface MigrationRunResult {
  currentVersion: number;
  appliedVersions: number[];
  alreadyAppliedVersions: number[];
}

function computeMigrationChecksum(migration: EventEdgeMigration): string {
  return crypto
    .createHash('sha256')
    .update(`${migration.version}:${migration.name}:${migration.statements.join('\n')}`)
    .digest('hex');
}

/**
 * Opens an EventEdge SQLite ledger database matching the codebase's `node:sqlite`
 * (`DatabaseSync`) WAL storage convention, with foreign-key enforcement enabled.
 */
export function openEventEdgeDatabase(dbPath: string): DatabaseSync {
  if (dbPath !== ':memory:') {
    const resolved = path.resolve(dbPath);
    const dir = path.dirname(resolved);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const db = new DatabaseSync(resolved);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = NORMAL;');
    db.exec('PRAGMA busy_timeout = 5000;');
    db.exec('PRAGMA foreign_keys = ON;');
    return db;
  }

  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

function ensureMigrationsTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);
}

export function getAppliedMigrations(db: DatabaseSync): AppliedMigrationRecord[] {
  ensureMigrationsTable(db);
  return db
    .prepare(
      'SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version ASC'
    )
    .all() as unknown as AppliedMigrationRecord[];
}

/**
 * Applies all pending EventEdge schema migrations idempotently inside `BEGIN IMMEDIATE`
 * transactions and validates checksums for previously applied migrations.
 */
export function applyEventEdgeMigrations(
  db: DatabaseSync,
  migrations: readonly EventEdgeMigration[] = EVENTEDGE_MIGRATIONS
): MigrationRunResult {
  ensureMigrationsTable(db);

  const existingRows = getAppliedMigrations(db);
  const existingByVersion = new Map<number, AppliedMigrationRecord>(
    existingRows.map((row) => [Number(row.version), row])
  );

  const appliedVersions: number[] = [];
  const alreadyAppliedVersions: number[] = [];

  const sorted = [...migrations].sort((a, b) => a.version - b.version);

  for (const migration of sorted) {
    const checksum = computeMigrationChecksum(migration);
    const existing = existingByVersion.get(migration.version);
    if (existing) {
      if (existing.checksum !== checksum) {
        throw new Error(
          `EventEdge migration v${migration.version} (${migration.name}) checksum mismatch: expected ${existing.checksum}, got ${checksum}. Migrations are immutable.`
        );
      }
      alreadyAppliedVersions.push(migration.version);
      continue;
    }

    db.exec('BEGIN IMMEDIATE');
    try {
      for (const stmt of migration.statements) {
        db.exec(stmt);
      }
      db.prepare(
        'INSERT INTO schema_migrations (version, name, checksum) VALUES (?, ?, ?)'
      ).run(migration.version, migration.name, checksum);
      db.exec('COMMIT');
      appliedVersions.push(migration.version);
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Ignore rollback failure
      }
      throw err;
    }
  }

  const allVersions = [...alreadyAppliedVersions, ...appliedVersions];
  const currentVersion = allVersions.length > 0 ? Math.max(...allVersions) : 0;

  return {
    currentVersion,
    appliedVersions,
    alreadyAppliedVersions,
  };
}

export function listEventEdgeTables(db: DatabaseSync): string[] {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC"
    )
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

/**
 * Convenience bootstrap opening the database and applying all EventEdge migrations.
 */
export function initializeEventEdgeLedger(dbPath: string): {
  db: DatabaseSync;
  migrationResult: MigrationRunResult;
} {
  const db = openEventEdgeDatabase(dbPath);
  const migrationResult = applyEventEdgeMigrations(db);
  return { db, migrationResult };
}
