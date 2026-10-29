import type {
  NextStep,
  RunCheckpoint,
  RunDto,
  RunErrorKind,
  RunReport,
  RunStatus,
} from '@friday/shared';
import type { Db } from '../db/database.js';

interface RunRow {
  id: string;
  session_id: string;
  user_message_id: number;
  status: RunStatus;
  model: string | null;
  error_kind: RunErrorKind | null;
  error_message: string | null;
  retryable: number;
  started_at: string;
  finished_at: string | null;
  checkpoint: string | null;
  report: string | null;
  suggestions: string | null;
}

function parseJson<T>(json: string | null): T | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

export interface RunRecord extends RunDto {
  userMessageId: number;
}

function toRecord(r: RunRow): RunRecord {
  return {
    id: r.id,
    sessionId: r.session_id,
    userMessageId: r.user_message_id,
    status: r.status,
    model: r.model,
    errorKind: r.error_kind,
    errorMessage: r.error_message,
    retryable: r.retryable === 1,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    checkpoint: parseJson<RunCheckpoint>(r.checkpoint),
    report: parseJson<RunReport>(r.report),
    suggestions: parseJson<NextStep[]>(r.suggestions),
  };
}

export function toRunDto(r: RunRecord): RunDto {
  const { userMessageId: _ignored, ...dto } = r;
  return dto;
}

export class RunRepo {
  constructor(private readonly db: Db) {}

  create(r: { id: string; sessionId: string; userMessageId: number; model: string }): RunRecord {
    this.db
      .prepare(
        `INSERT INTO runs (id, session_id, user_message_id, status, model, started_at)
         VALUES (?, ?, ?, 'running', ?, ?)`,
      )
      .run(r.id, r.sessionId, r.userMessageId, r.model, new Date().toISOString());
    return this.get(r.id)!;
  }

  get(id: string): RunRecord | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined;
    return row ? toRecord(row) : null;
  }

  latestForSession(sessionId: string): RunRecord | null {
    const row = this.db
      .prepare(
        'SELECT * FROM runs WHERE session_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1',
      )
      .get(sessionId) as RunRow | undefined;
    return row ? toRecord(row) : null;
  }

  finish(
    id: string,
    status: Exclude<RunStatus, 'running' | 'awaiting_approval'>,
    error?: { kind: RunErrorKind; message: string; retryable: boolean },
  ): RunRecord {
    this.db
      .prepare(
        `UPDATE runs SET status = ?, error_kind = ?, error_message = ?, retryable = ?, finished_at = ?
         WHERE id = ? AND status IN ('running', 'awaiting_approval')`,
      )
      .run(
        status,
        error?.kind ?? null,
        error?.message ?? null,
        error?.retryable ? 1 : 0,
        new Date().toISOString(),
        id,
      );
    return this.get(id)!;
  }

  setCheckpoint(id: string, checkpoint: RunCheckpoint): void {
    this.db
      .prepare('UPDATE runs SET checkpoint = ? WHERE id = ?')
      .run(JSON.stringify(checkpoint), id);
  }

  setSuggestions(id: string, suggestions: NextStep[]): void {
    this.db
      .prepare('UPDATE runs SET suggestions = ? WHERE id = ?')
      .run(JSON.stringify(suggestions), id);
  }

  setReport(id: string, report: RunReport): void {
    this.db.prepare('UPDATE runs SET report = ? WHERE id = ?').run(JSON.stringify(report), id);
  }

  listBySession(sessionId: string): RunRecord[] {
    return (
      this.db
        .prepare('SELECT * FROM runs WHERE session_id = ? ORDER BY started_at, rowid')
        .all(sessionId) as RunRow[]
    ).map(toRecord);
  }

  /** Most recent run before `beforeRunId` in the same session. */
  previousRun(sessionId: string, beforeStartedAt: string): RunRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM runs WHERE session_id = ? AND started_at < ?
         ORDER BY started_at DESC, rowid DESC LIMIT 1`,
      )
      .get(sessionId, beforeStartedAt) as RunRow | undefined;
    return row ? toRecord(row) : null;
  }

  /** Toggle between running and awaiting_approval while the run is active. */
  setActiveStatus(id: string, status: 'running' | 'awaiting_approval'): void {
    this.db
      .prepare(
        `UPDATE runs SET status = ? WHERE id = ? AND status IN ('running', 'awaiting_approval')`,
      )
      .run(status, id);
  }

  recordProgress(id: string, iterations: number, toolCallCount: number): void {
    this.db
      .prepare('UPDATE runs SET iterations = ?, tool_call_count = ? WHERE id = ?')
      .run(iterations, toolCallCount, id);
  }

  /** Called at startup: runs left 'running' by a crash or restart can no longer progress. */
  markInterrupted(): number {
    return this.db
      .prepare(
        `UPDATE runs SET status = 'interrupted', retryable = 1, finished_at = ?,
           error_message = 'The server stopped while this run was in progress.'
         WHERE status IN ('running', 'awaiting_approval')`,
      )
      .run(new Date().toISOString()).changes;
  }
}
