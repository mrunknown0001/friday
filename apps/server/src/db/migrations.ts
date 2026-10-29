import type Database from 'better-sqlite3';

export interface Migration {
  version: number;
  name: string;
  up: string;
}

/**
 * Append-only list. Never edit a migration that has shipped; add a new one instead.
 * Each migration runs inside a transaction together with its bookkeeping row.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'foundation',
    up: `
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        summary TEXT,
        summary_through_message_id INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        user_message_id INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running','completed','failed','cancelled','interrupted')),
        model TEXT,
        error_kind TEXT,
        error_message TEXT,
        retryable INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE INDEX runs_session ON runs(session_id, started_at);
      CREATE INDEX runs_status ON runs(status);

      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        run_id TEXT,
        role TEXT NOT NULL CHECK (role IN ('user','assistant','system','tool')),
        content TEXT NOT NULL,
        tool_calls TEXT,
        tool_call_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('complete','partial','cancelled','error')),
        model TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX messages_session ON messages(session_id, id);

      CREATE TABLE model_capabilities (
        model TEXT PRIMARY KEY,
        streaming TEXT NOT NULL DEFAULT 'unknown',
        tool_calling TEXT NOT NULL DEFAULT 'unknown',
        context_window INTEGER,
        notes TEXT,
        probed_at TEXT
      );

      -- Telemetry only: never store prompt or response content here.
      CREATE TABLE provider_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        model TEXT NOT NULL,
        operation TEXT NOT NULL,
        status TEXT NOT NULL,
        error_kind TEXT,
        duration_ms INTEGER NOT NULL,
        attempts INTEGER NOT NULL,
        input_tokens INTEGER,
        output_tokens INTEGER
      );

      CREATE TABLE audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        session_id TEXT,
        actor TEXT NOT NULL CHECK (actor IN ('user','system','agent')),
        action TEXT NOT NULL,
        details TEXT
      );
      CREATE INDEX audit_events_session ON audit_events(session_id, id);
    `,
  },
];

export function migrate(db: Database.Database, migrations: Migration[] = MIGRATIONS): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Set(
    db
      .prepare('SELECT version FROM schema_migrations')
      .all()
      .map((r) => (r as { version: number }).version),
  );
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  const newlyApplied: number[] = [];
  for (const m of sorted) {
    if (applied.has(m.version)) continue;
    db.transaction(() => {
      db.exec(m.up);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        m.version,
        m.name,
        new Date().toISOString(),
      );
    })();
    newlyApplied.push(m.version);
  }
  return newlyApplied;
}
