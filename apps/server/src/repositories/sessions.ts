import { randomUUID } from 'node:crypto';
import type { AgentMode, PlanStep, RunStatus, SessionSummaryDto } from '@friday/shared';
import type { Db } from '../db/database.js';

interface SessionRow {
  id: string;
  project_id: string | null;
  title: string;
  mode: AgentMode;
  tool_groups: string;
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
  /** Tool groups loaded in this conversation (load_tools; see tools/groups.ts). */
  toolGroups: string[];
}

function parseGroups(json: string): string[] {
  try {
    const groups: unknown = JSON.parse(json);
    return Array.isArray(groups) ? groups.filter((g): g is string => typeof g === 'string') : [];
  } catch {
    return [];
  }
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
    mode: r.mode,
    summary: r.summary,
    summaryThroughMessageId: r.summary_through_message_id,
    plan: parsePlan(r.plan),
    toolGroups: parseGroups(r.tool_groups),
  };
}

export const DEFAULT_SESSION_TITLE = 'New conversation';

export class SessionRepo {
  constructor(private readonly db: Db) {}

  create(
    title = DEFAULT_SESSION_TITLE,
    projectId: string | null = null,
    mode: AgentMode = 'auto',
  ): SessionRecord {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        'INSERT INTO sessions (id, project_id, title, mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, projectId, title, mode, now, now);
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

  /** Add tool groups to the conversation's loaded ones; returns the full list. */
  addToolGroups(id: string, groups: string[]): string[] {
    const current = this.get(id)?.toolGroups ?? [];
    const next = [...new Set([...current, ...groups])];
    if (next.length !== current.length)
      this.db
        .prepare('UPDATE sessions SET tool_groups = ? WHERE id = ?')
        .run(JSON.stringify(next), id);
    return next;
  }

  setMode(id: string, mode: AgentMode): boolean {
    return this.db.prepare('UPDATE sessions SET mode = ? WHERE id = ?').run(mode, id).changes > 0;
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
