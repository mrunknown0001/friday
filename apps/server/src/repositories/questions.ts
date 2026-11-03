import type { QuestionAnswer, QuestionDto, QuestionItem, QuestionStatus } from '@friday/shared';
import type { Db } from '../db/database.js';

interface QuestionRow {
  id: string;
  session_id: string;
  run_id: string;
  tool_call_id: string;
  status: QuestionStatus;
  questions: string;
  answers: string | null;
  created_at: string;
  expires_at: string;
  answered_at: string | null;
}

const toDto = (r: QuestionRow): QuestionDto => ({
  id: r.id,
  sessionId: r.session_id,
  runId: r.run_id,
  toolCallId: r.tool_call_id,
  questions: JSON.parse(r.questions) as QuestionItem[],
  answers: r.answers ? (JSON.parse(r.answers) as QuestionAnswer[]) : null,
  status: r.status,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  answeredAt: r.answered_at,
});

export interface NewQuestion {
  id: string;
  sessionId: string;
  runId: string;
  toolCallId: string;
  questions: QuestionItem[];
  expiresAt: string;
}

/** Clarifying questions asked during runs (ask_user), per conversation. */
export class QuestionRepo {
  constructor(private readonly db: Db) {}

  create(q: NewQuestion): QuestionDto {
    this.db
      .prepare(
        `INSERT INTO questions (id, session_id, run_id, tool_call_id, status, questions, created_at, expires_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .run(
        q.id,
        q.sessionId,
        q.runId,
        q.toolCallId,
        JSON.stringify(q.questions),
        new Date().toISOString(),
        q.expiresAt,
      );
    return this.get(q.id)!;
  }

  get(id: string): QuestionDto | null {
    const row = this.db.prepare('SELECT * FROM questions WHERE id = ?').get(id) as unknown as
      QuestionRow | undefined;
    return row ? toDto(row) : null;
  }

  listBySession(sessionId: string): QuestionDto[] {
    return (
      this.db
        .prepare('SELECT * FROM questions WHERE session_id = ? ORDER BY created_at, rowid')
        .all(sessionId) as unknown as QuestionRow[]
    ).map(toDto);
  }

  /** Moves a pending question on; null when it was no longer pending. */
  settle(
    id: string,
    status: Exclude<QuestionStatus, 'pending'>,
    answers: QuestionAnswer[] | null = null,
  ): QuestionDto | null {
    const result = this.db
      .prepare(
        `UPDATE questions SET status = ?, answers = ?, answered_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(status, answers ? JSON.stringify(answers) : null, new Date().toISOString(), id);
    return result.changes ? this.get(id) : null;
  }

  /** At startup: no run is waiting for questions asked before Friday stopped. */
  cancelPending(): number {
    return Number(
      this.db
        .prepare(
          `UPDATE questions SET status = 'cancelled', answered_at = ? WHERE status = 'pending'`,
        )
        .run(new Date().toISOString()).changes,
    );
  }
}
