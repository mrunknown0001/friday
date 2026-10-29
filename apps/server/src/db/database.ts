import fs from 'node:fs';
import path from 'node:path';
import type * as Sqlite from 'node:sqlite';
import { migrate } from './migrations.js';

/**
 * The slice of `node:sqlite`'s DatabaseSync that Friday uses. Rows come back untyped; each
 * repository casts them to its own row type at the boundary. `readBigInts` stays off, so counts
 * and row ids are plain numbers.
 */
export interface Statement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
export interface Db {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  close(): void;
}

/**
 * Node's built-in SQLite (no native addon, so the same code runs under plain Node and inside the
 * Electron app). Loaded lazily so the one-time "experimental feature" warning can be silenced
 * without hiding any other warning.
 */
function loadSqlite(): typeof Sqlite {
  const emit = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const message = typeof warning === 'string' ? warning : warning.message;
    if (message.startsWith('SQLite is an experimental feature')) return;
    return (emit as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return process.getBuiltinModule('node:sqlite') as typeof Sqlite;
  } finally {
    process.emitWarning = emit;
  }
}

/** A bare connection with no migrations applied (tests use it to exercise `migrate`). */
export function openSqlite(file: string): Db {
  return new (loadSqlite().DatabaseSync)(file) as Db;
}

/** Open (creating if needed) the SQLite database and apply pending migrations. */
export function openDatabase(file: string): Db {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  }
  const db = openSqlite(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA synchronous = NORMAL;
  `);
  migrate(db);
  if (file !== ':memory:') {
    // The database holds conversation history; keep it private to the current user.
    fs.chmodSync(file, 0o600);
  }
  return db;
}

/** Run `fn` atomically: committed if it returns, rolled back if it throws. Not reentrant. */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // SQLite already rolled back (e.g. disk full); the original error is what matters.
    }
    throw err;
  }
}
