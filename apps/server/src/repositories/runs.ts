import type { ProviderErrorKind, RunDto, RunStatus } from '@friday/shared';
import type { Db } from '../db/database.js';

interface RunRow {
  id: string;
  session_id: string;
  user_message_id: number;
  status: RunStatus;
  model: string | null;
  error_kind: ProviderErrorKind | null;
  error_message: string | null;
  retryable: number;
  started_at: string;
  finished_at: string | null;
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
    status: Exclude<RunStatus, 'running'>,
    error?: { kind: ProviderErrorKind; message: string; retryable: boolean },
  ): RunRecord {
    this.db
      .prepare(
        `UPDATE runs SET status = ?, error_kind = ?, error_message = ?, retryable = ?, finished_at = ?
         WHERE id = ? AND status = 'running'`,
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

  /** Called at startup: runs left 'running' by a crash or restart can no longer progress. */
  markInterrupted(): number {
    return this.db
      .prepare(
        `UPDATE runs SET status = 'interrupted', retryable = 1, finished_at = ?,
           error_message = 'The server stopped while this run was in progress.'
         WHERE status = 'running'`,
      )
      .run(new Date().toISOString()).changes;
  }
}
