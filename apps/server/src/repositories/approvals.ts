import type {
  ApprovalDetails,
  ApprovalDto,
  ApprovalStatus,
  PermissionCategory,
  RiskLevel,
} from '@friday/shared';
import { canTransition } from '../approvals/stateMachine.js';
import type { Db } from '../db/database.js';

interface ApprovalRow {
  id: string;
  session_id: string;
  run_id: string;
  project_id: string | null;
  tool_call_id: string;
  tool_name: string;
  category: PermissionCategory;
  risk: RiskLevel;
  title: string;
  summary: string;
  reason: string;
  details: string;
  action_hash: string;
  status: ApprovalStatus;
  decision_note: string | null;
  result_summary: string | null;
  created_at: string;
  expires_at: string;
  decided_at: string | null;
}

const toDto = (r: ApprovalRow): ApprovalDto => ({
  id: r.id,
  sessionId: r.session_id,
  runId: r.run_id,
  projectId: r.project_id,
  toolCallId: r.tool_call_id,
  toolName: r.tool_name,
  category: r.category,
  risk: r.risk,
  title: r.title,
  summary: r.summary,
  reason: r.reason,
  details: JSON.parse(r.details) as ApprovalDetails,
  actionHash: r.action_hash,
  status: r.status,
  decisionNote: r.decision_note,
  resultSummary: r.result_summary,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  decidedAt: r.decided_at,
});

export type NewApproval = Omit<
  ApprovalDto,
  'status' | 'decisionNote' | 'resultSummary' | 'createdAt' | 'decidedAt'
>;

export class ApprovalRepo {
  constructor(private readonly db: Db) {}

  create(a: NewApproval): ApprovalDto {
    this.db
      .prepare(
        `INSERT INTO approvals (id, session_id, run_id, project_id, tool_call_id, tool_name, category, risk,
           title, summary, reason, details, action_hash, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        a.id,
        a.sessionId,
        a.runId,
        a.projectId,
        a.toolCallId,
        a.toolName,
        a.category,
        a.risk,
        a.title,
        a.summary,
        a.reason,
        JSON.stringify(a.details),
        a.actionHash,
        new Date().toISOString(),
        a.expiresAt,
      );
    return this.get(a.id)!;
  }

  get(id: string): ApprovalDto | null {
    const row = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as
      ApprovalRow | undefined;
    return row ? toDto(row) : null;
  }

  listBySession(sessionId: string): ApprovalDto[] {
    return (
      this.db
        .prepare('SELECT * FROM approvals WHERE session_id = ? ORDER BY created_at, rowid')
        .all(sessionId) as ApprovalRow[]
    ).map(toDto);
  }

  listByRun(runId: string): ApprovalDto[] {
    return (
      this.db
        .prepare('SELECT * FROM approvals WHERE run_id = ? ORDER BY created_at, rowid')
        .all(runId) as ApprovalRow[]
    ).map(toDto);
  }

  /**
   * Compare-and-set transition. Succeeds only if the row is still in `from`, so two concurrent
   * decisions (or a replayed request) cannot both win. Returns the updated approval or null.
   */
  transition(
    id: string,
    from: ApprovalStatus,
    to: ApprovalStatus,
    fields: { decisionNote?: string | null; resultSummary?: string | null } = {},
  ): ApprovalDto | null {
    if (!canTransition(from, to)) throw new Error(`Illegal approval transition ${from} -> ${to}`);
    const now = new Date().toISOString();
    const decided = from === 'pending';
    const terminal = !['approved'].includes(to);
    const info = this.db
      .prepare(
        `UPDATE approvals SET status = ?,
           decision_note = COALESCE(?, decision_note),
           result_summary = COALESCE(?, result_summary),
           decided_at = CASE WHEN ? THEN ? ELSE decided_at END,
           completed_at = CASE WHEN ? THEN ? ELSE completed_at END
         WHERE id = ? AND status = ?`,
      )
      .run(
        to,
        fields.decisionNote ?? null,
        fields.resultSummary ?? null,
        decided ? 1 : 0,
        now,
        terminal ? 1 : 0,
        now,
        id,
        from,
      );
    return info.changes > 0 ? this.get(id) : null;
  }

  /** At startup no run can still be waiting, so open approvals can never be executed. */
  cancelOrphans(): number {
    return this.db
      .prepare(
        `UPDATE approvals SET status = 'cancelled', completed_at = ?,
           decision_note = COALESCE(decision_note, 'Server restarted before this action ran.')
         WHERE status IN ('pending', 'approved')`,
      )
      .run(new Date().toISOString()).changes;
  }
}
