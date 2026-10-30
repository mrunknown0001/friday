import { randomUUID } from 'node:crypto';
import type { PlanStep, RunStatus, SessionSummaryDto } from '@friday/shared';
import type { Db } from '../db/database.js';

interface SessionRow {
  id: string;
  project_id: string | null;
  title: string;
  plan: string | null;
  summary: string | null;
  summary_through_message_id: number | null;
  created_at: string;
  updated_at: string;
  last_run_status: RunStatus | null;
}

export interface SessionRecord extends SessionSummaryDto {
  summary: string | null;
  summaryThroughMessageId: number | null;
  plan: PlanStep[] | null;
}

function parsePlan(json: string | null): PlanStep[] | null {
  if (!json) return null;
  try {
    const plan = JSON.parse(json) as PlanStep[];
    return Array.isArray(plan) ? plan : null;
  } catch {
    return null;
  }
}

const SELECT = `
  SELECT s.*, (
    SELECT r.status FROM runs r WHERE r.session_id = s.id ORDER BY r.started_at DESC, r.rowid DESC LIMIT 1
  ) AS last_run_status
  FROM sessions s`;

function toRecord(r: SessionRow): SessionRecord {
  return {
    id: r.id,
    projectId: r.project_id,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastRunStatus: r.last_run_status,
    summary: r.summary,
    summaryThroughMessageId: r.summary_through_message_id,
    plan: parsePlan(r.plan),
  };
}

export const DEFAULT_SESSION_TITLE = 'New conversation';

export class SessionRepo {
  constructor(private readonly db: Db) {}

  create(title = DEFAULT_SESSION_TITLE, projectId: string | null = null): SessionRecord {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        'INSERT INTO sessions (id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, projectId, title, now, now);
    return this.get(id)!;
  }

  get(id: string): SessionRecord | null {
    const row = this.db.prepare(`${SELECT} WHERE s.id = ?`).get(id) as SessionRow | undefined;
    return row ? toRecord(row) : null;
  }

  /** `projectId` undefined lists all sessions; null lists sessions without a project. */
  list(projectId?: string | null, limit = 200): SessionRecord[] {
    const rows =
      projectId === undefined
        ? this.db.prepare(`${SELECT} ORDER BY s.updated_at DESC LIMIT ?`).all(limit)
        : projectId === null
          ? this.db
              .prepare(`${SELECT} WHERE s.project_id IS NULL ORDER BY s.updated_at DESC LIMIT ?`)
              .all(limit)
          : this.db
              .prepare(
                // A project's list includes the conversations in its worktrees.
                `${SELECT} WHERE s.project_id = ? OR s.project_id IN (SELECT id FROM projects WHERE parent_id = ?)
               ORDER BY s.updated_at DESC LIMIT ?`,
              )
              .all(projectId, projectId, limit);
    return (rows as SessionRow[]).map(toRecord);
  }

  setPlan(id: string, plan: PlanStep[] | null): void {
    this.db
      .prepare('UPDATE sessions SET plan = ? WHERE id = ?')
      .run(plan ? JSON.stringify(plan) : null, id);
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
