/**
 * SQLite access layer, built on Node's native `node:sqlite` module.
 *
 * Why node:sqlite instead of better-sqlite3: no native addon to compile,
 * so `npm install` works on Windows without Visual Studio Build Tools.
 * The API is synchronous, which is fine (and fast) for a single-user app:
 * each query takes microseconds and there is no connection pool to manage.
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from './migrations.js';

export type Db = DatabaseSync;

/**
 * Open (or create) the database and bring its schema up to date.
 * @param path file path, or ":memory:" for tests.
 */
export function openDatabase(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });

  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;     -- readers never block the writer
    PRAGMA synchronous = NORMAL;   -- safe with WAL, much faster than FULL
    PRAGMA foreign_keys = ON;      -- enforce ON DELETE CASCADE
    PRAGMA busy_timeout = 5000;
  `);
  migrate(db);
  return db;
}

/**
 * Apply pending migrations. The schema version is stored in SQLite's
 * built-in `user_version` pragma; each migration runs in a transaction so a
 * failure never leaves a half-migrated database.
 */
export function migrate(db: Db): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  const current = row.user_version;

  if (current > MIGRATIONS.length) {
    throw new Error(
      `Database schema v${current} is newer than this app supports (v${MIGRATIONS.length}). Update girllm.`,
    );
  }

  for (let version = current + 1; version <= MIGRATIONS.length; version++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[version - 1]!);
      // PRAGMA doesn't accept bound parameters; `version` is a trusted integer.
      db.exec(`PRAGMA user_version = ${version}`);
    });
  }
}

/** Run `fn` atomically: committed if it returns, rolled back if it throws. */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
