import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from './migrations.js';

export type Db = Database.Database;

/** Open (creating if needed) the SQLite database and apply pending migrations. */
export function openDatabase(file: string): Db {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  }
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  migrate(db);
  if (file !== ':memory:') {
    // The database holds conversation history; keep it private to the current user.
    fs.chmodSync(file, 0o600);
  }
  return db;
}
