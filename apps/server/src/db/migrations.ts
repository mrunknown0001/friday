import { type Db, transaction } from './database.js';

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
  {
    version: 2,
    name: 'projects_and_tools',
    up: `
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        last_opened_at TEXT
      );

      -- A session is bound to at most one project for its whole life (no cross-project context).
      ALTER TABLE sessions ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;
      ALTER TABLE sessions ADD COLUMN plan TEXT;
      CREATE INDEX sessions_project ON sessions(project_id, updated_at);

      -- SQLite cannot alter a CHECK constraint, so rebuild runs with the new statuses
      -- ('blocked' now, 'awaiting_approval' for the Phase 3 approval engine).
      CREATE TABLE runs_v2 (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        user_message_id INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN
          ('running','awaiting_approval','completed','failed','cancelled','interrupted','blocked')),
        model TEXT,
        error_kind TEXT,
        error_message TEXT,
        retryable INTEGER NOT NULL DEFAULT 0,
        iterations INTEGER NOT NULL DEFAULT 0,
        tool_call_count INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );
      INSERT INTO runs_v2 (id, session_id, user_message_id, status, model, error_kind, error_message,
                           retryable, started_at, finished_at)
        SELECT id, session_id, user_message_id, status, model, error_kind, error_message,
               retryable, started_at, finished_at FROM runs;
      DROP TABLE runs;
      ALTER TABLE runs_v2 RENAME TO runs;
      CREATE INDEX runs_session ON runs(session_id, started_at);
      CREATE INDEX runs_status ON runs(status);

      CREATE TABLE tool_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL,
        call_id TEXT NOT NULL,
        result_message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        arguments TEXT NOT NULL,
        category TEXT,
        status TEXT NOT NULL CHECK (status IN ('completed','error','denied','skipped')),
        summary TEXT NOT NULL,
        truncated INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX tool_calls_run ON tool_calls(run_id);
      CREATE INDEX tool_calls_message ON tool_calls(result_message_id);
    `,
  },
  {
    version: 3,
    name: 'approvals_and_file_changes',
    up: `
      -- Every protected action the agent proposes. Status transitions are enforced in code
      -- (approvals/stateMachine.ts) with compare-and-set updates, so a decision cannot be replayed.
      CREATE TABLE approvals (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL,
        project_id TEXT,
        tool_call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        category TEXT NOT NULL,
        risk TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        reason TEXT NOT NULL,
        details TEXT NOT NULL,
        action_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN
          ('pending','approved','rejected','expired','cancelled','executed','failed','stale')),
        decision_note TEXT,
        result_summary TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        decided_at TEXT,
        completed_at TEXT
      );
      CREATE INDEX approvals_session ON approvals(session_id, created_at);
      CREATE INDEX approvals_status ON approvals(status);

      -- Applied file changes with the previous content, for undo.
      CREATE TABLE file_changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        approval_id TEXT REFERENCES approvals(id) ON DELETE SET NULL,
        session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        project_id TEXT NOT NULL,
        path TEXT NOT NULL,
        from_path TEXT,
        change TEXT NOT NULL CHECK (change IN ('create','modify','delete','move')),
        before_content BLOB,
        before_hash TEXT,
        after_hash TEXT,
        created_at TEXT NOT NULL,
        reverted_at TEXT
      );
      CREATE INDEX file_changes_session ON file_changes(session_id, id);

      ALTER TABLE tool_calls ADD COLUMN approval_id TEXT;
    `,
  },
  {
    version: 4,
    name: 'run_checkpoints_and_reports',
    up: `
      -- Progress snapshot updated during a run (for resume after interruption).
      ALTER TABLE runs ADD COLUMN checkpoint TEXT;
      -- Verification report generated from records when the run ends.
      ALTER TABLE runs ADD COLUMN report TEXT;
    `,
  },
  {
    version: 5,
    name: 'devops',
    up: `
      -- SSH targets configured by the user. Only paths to key files are stored, never key material
      -- or passwords. A host is unusable until the user trusts a host-key fingerprint.
      CREATE TABLE ssh_hosts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        hostname TEXT NOT NULL,
        port INTEGER NOT NULL,
        username TEXT NOT NULL,
        identity_file TEXT,
        environment TEXT NOT NULL CHECK (environment IN ('development','staging','production')),
        trusted_fingerprints TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );

      -- Log files outside projects that the user authorized for read-only access.
      CREATE TABLE log_sources (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL UNIQUE,
        path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );

      CREATE TABLE deployment_plans (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        environment TEXT NOT NULL,
        plan TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX deployment_plans_session ON deployment_plans(session_id, created_at);

      -- Text the user must type to approve (production safeguard).
      ALTER TABLE approvals ADD COLUMN confirmation_required TEXT;
    `,
  },
  {
    version: 6,
    name: 'memory',
    up: `
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK (scope IN ('user','project','session','operational')),
        category TEXT NOT NULL,
        content TEXT NOT NULL,
        -- Deleting a project or session deletes the memories that belong to it.
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('active','pending','superseded','rejected')),
        confidence TEXT NOT NULL CHECK (confidence IN ('confirmed','assumed')),
        pinned INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL CHECK (source IN ('agent','user')),
        source_run_id TEXT,
        supersedes_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_used_at TEXT,
        use_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX memories_scope ON memories(scope, project_id, status);
      CREATE INDEX memories_session ON memories(session_id);

      -- Full-text index (BM25 ranking) kept in sync by triggers.
      CREATE VIRTUAL TABLE memories_fts USING fts5(content, category, content='memories', content_rowid='rowid');
      CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content, category) VALUES (new.rowid, new.content, new.category);
      END;
      CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, category) VALUES ('delete', old.rowid, old.content, old.category);
      END;
      CREATE TRIGGER memories_au AFTER UPDATE OF content, category ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, category) VALUES ('delete', old.rowid, old.content, old.category);
        INSERT INTO memories_fts(rowid, content, category) VALUES (new.rowid, new.content, new.category);
      END;

      -- Which memories were shown to the model in which run (for "memories used" disclosure).
      CREATE TABLE run_memories (
        run_id TEXT NOT NULL,
        memory_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        snapshot TEXT NOT NULL,
        PRIMARY KEY (run_id, memory_id)
      );
    `,
  },
  {
    version: 7,
    name: 'run_suggestions',
    up: `
      -- Follow-up chips computed when a run ends (from records and from the model).
      ALTER TABLE runs ADD COLUMN suggestions TEXT;
    `,
  },
  {
    version: 8,
    name: 'approval_granted_by',
    up: `
      -- Actions approved automatically under a task permission point to the approval that
      -- granted it (the user's decision), so every automatic approval stays traceable.
      ALTER TABLE approvals ADD COLUMN granted_by TEXT REFERENCES approvals(id);
    `,
  },
  {
    version: 9,
    name: 'project_sandbox',
    up: `
      -- Per-project command sandbox settings (JSON: enabled, image, network). NULL = off.
      ALTER TABLE projects ADD COLUMN sandbox TEXT;
    `,
  },
  {
    version: 10,
    name: 'attachments',
    up: `
      -- Images attached to messages. Uploaded first (message_id NULL, pending), then bound to the
      -- user message that sends them; pending uploads are removed after a day.
      CREATE TABLE attachments (
        id TEXT PRIMARY KEY,
        session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
        message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
        name TEXT,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        data BLOB NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX attachments_message ON attachments(message_id);
      ALTER TABLE model_capabilities ADD COLUMN image_input TEXT NOT NULL DEFAULT 'unknown';
    `,
  },
  {
    version: 11,
    name: 'code_map',
    up: `
      -- Code map: symbol definitions per project file, refreshed on demand by size and mtime.
      CREATE TABLE code_files (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtime_ms INTEGER NOT NULL,
        symbol_count INTEGER NOT NULL,
        PRIMARY KEY (project_id, path)
      );
      CREATE TABLE code_symbols (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        line INTEGER NOT NULL,
        container TEXT,
        signature TEXT NOT NULL,
        exported INTEGER NOT NULL
      );
      CREATE INDEX code_symbols_name ON code_symbols(project_id, name COLLATE NOCASE);
      CREATE INDEX code_symbols_path ON code_symbols(project_id, path);
    `,
  },
  {
    version: 12,
    name: 'mcp_servers',
    up: `
      -- Remote MCP servers the user connected. Credentials (a static token, or OAuth client
      -- registration and tokens) live only here, in the 0600 database; never sent to the UI.
      CREATE TABLE mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        url TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        access_token TEXT,
        oauth TEXT,
        tools TEXT,
        tools_refreshed_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE mcp_tool_policies (
        server_id TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
        tool TEXT NOT NULL,
        policy TEXT NOT NULL CHECK (policy IN ('ask', 'allow', 'off')),
        PRIMARY KEY (server_id, tool)
      );
    `,
  },
];

export function migrate(db: Db, migrations: Migration[] = MIGRATIONS): number[] {
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
    transaction(db, () => {
      db.exec(m.up);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        m.version,
        m.name,
        new Date().toISOString(),
      );
    });
    newlyApplied.push(m.version);
  }
  return newlyApplied;
}
