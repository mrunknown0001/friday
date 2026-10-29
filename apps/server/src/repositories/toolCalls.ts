import type { PermissionCategory, ToolCallStatus } from '@friday/shared';
import type { Db } from '../db/database.js';

export interface NewToolCallRecord {
  sessionId: string;
  runId: string;
  callId: string;
  resultMessageId: number;
  name: string;
  arguments: string;
  category: PermissionCategory | null;
  status: ToolCallStatus;
  summary: string;
  truncated: boolean;
  durationMs: number;
  approvalId?: string | null;
}

/** Display arguments are capped; the full arguments live in the assistant message. */
const MAX_STORED_ARGUMENT_CHARS = 4_000;

export class ToolCallRepo {
  constructor(private readonly db: Db) {}

  insert(r: NewToolCallRecord): void {
    this.db
      .prepare(
        `INSERT INTO tool_calls (session_id, run_id, call_id, result_message_id, name, arguments, category,
                                 status, summary, truncated, duration_ms, created_at, approval_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.sessionId,
        r.runId,
        r.callId,
        r.resultMessageId,
        r.name,
        r.arguments.slice(0, MAX_STORED_ARGUMENT_CHARS),
        r.category,
        r.status,
        r.summary.slice(0, 500),
        r.truncated ? 1 : 0,
        r.durationMs,
        new Date().toISOString(),
        r.approvalId ?? null,
      );
  }

  countForRun(runId: string): number {
    return (
      this.db.prepare('SELECT COUNT(*) AS n FROM tool_calls WHERE run_id = ?').get(runId) as {
        n: number;
      }
    ).n;
  }
}
