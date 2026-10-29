import { randomUUID } from 'node:crypto';
import type { RunStatus, SessionSummaryDto } from '@friday/shared';
import type { Db } from '../db/database.js';

interface SessionRow {
  id: string;
  title: string;
  summary: string | null;
  summary_through_message_id: number | null;
  created_at: string;
  updated_at: string;
  last_run_status: RunStatus | null;
}

export interface SessionRecord extends SessionSummaryDto {
  summary: string | null;
  summaryThroughMessageId: number | null;
}

const SELECT = `
  SELECT s.*, (
    SELECT r.status FROM runs r WHERE r.session_id = s.id ORDER BY r.started_at DESC, r.rowid DESC LIMIT 1
  ) AS last_run_status
  FROM sessions s`;

function toRecord(r: SessionRow): SessionRecord {
  return {
    id: r.id,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastRunStatus: r.last_run_status,
    summary: r.summary,
    summaryThroughMessageId: r.summary_through_message_id,
  };
}

export const DEFAULT_SESSION_TITLE = 'New conversation';

export class SessionRepo {
  constructor(private readonly db: Db) {}

  create(title = DEFAULT_SESSION_TITLE): SessionRecord {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare('INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(id, title, now, now);
    return this.get(id)!;
  }

  get(id: string): SessionRecord | null {
    const row = this.db.prepare(`${SELECT} WHERE s.id = ?`).get(id) as SessionRow | undefined;
    return row ? toRecord(row) : null;
  }

  list(limit = 200): SessionRecord[] {
    return (
      this.db.prepare(`${SELECT} ORDER BY s.updated_at DESC LIMIT ?`).all(limit) as SessionRow[]
    ).map(toRecord);
  }

  rename(id: string, title: string): boolean {
    return (
      this.db
        .prepare('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?')
        .run(title, new Date().toISOString(), id).changes > 0
    );
  }

  touch(id: string): void {
    this.db
      .prepare('UPDATE sessions SET updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), id);
  }

  setSummary(id: string, summary: string, throughMessageId: number): void {
    this.db
      .prepare('UPDATE sessions SET summary = ?, summary_through_message_id = ? WHERE id = ?')
      .run(summary, throughMessageId, id);
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id).changes > 0;
  }
}
