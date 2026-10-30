import { randomUUID } from 'node:crypto';
import type { ReviewDto, ReviewFinding, ReviewTarget } from '@friday/shared';
import type { Db } from '../db/database.js';

interface ReviewRow {
  id: string;
  session_id: string;
  run_id: string;
  tool_call_id: string;
  target: string;
  summary: string;
  findings: string;
  created_at: string;
}

const toDto = (r: ReviewRow): ReviewDto => ({
  id: r.id,
  sessionId: r.session_id,
  runId: r.run_id,
  toolCallId: r.tool_call_id,
  target: JSON.parse(r.target) as ReviewTarget,
  summary: r.summary,
  findings: JSON.parse(r.findings) as ReviewFinding[],
  createdAt: r.created_at,
});

/** Code reviews and their findings, with the user's decision on each finding. */
export class ReviewRepo {
  constructor(private readonly db: Db) {}

  create(r: Omit<ReviewDto, 'id' | 'createdAt'>): ReviewDto {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO reviews (id, session_id, run_id, tool_call_id, target, summary, findings, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        r.sessionId,
        r.runId,
        r.toolCallId,
        JSON.stringify(r.target),
        r.summary,
        JSON.stringify(r.findings),
        new Date().toISOString(),
      );
    return this.get(id)!;
  }

  get(id: string): ReviewDto | null {
    const row = this.db.prepare('SELECT * FROM reviews WHERE id = ?').get(id) as unknown as
      ReviewRow | undefined;
    return row ? toDto(row) : null;
  }

  listBySession(sessionId: string): ReviewDto[] {
    return (
      this.db
        .prepare('SELECT * FROM reviews WHERE session_id = ? ORDER BY created_at, rowid')
        .all(sessionId) as unknown as ReviewRow[]
    ).map(toDto);
  }

  setStatus(id: string, n: number, status: ReviewFinding['status']): ReviewDto | null {
    const review = this.get(id);
    const finding = review?.findings.find((f) => f.n === n);
    if (!review || !finding) return null;
    finding.status = status;
    this.db
      .prepare('UPDATE reviews SET findings = ? WHERE id = ?')
      .run(JSON.stringify(review.findings), id);
    return review;
  }
}
