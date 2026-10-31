import type { Db } from '../db/database.js';

export interface SpokenReply {
  runId: string;
  sessionId: string;
  text: string;
  model: string;
  createdAt: string;
}

/** The spoken versions of replies, one per run. */
export class SpokenReplyRepo {
  constructor(private readonly db: Db) {}

  get(runId: string): SpokenReply | null {
    const r = this.db
      .prepare(
        'SELECT run_id, session_id, text, model, created_at FROM spoken_replies WHERE run_id = ?',
      )
      .get(runId) as
      | { run_id: string; session_id: string; text: string; model: string; created_at: string }
      | undefined;
    return r
      ? {
          runId: r.run_id,
          sessionId: r.session_id,
          text: r.text,
          model: r.model,
          createdAt: r.created_at,
        }
      : null;
  }

  save(s: Omit<SpokenReply, 'createdAt'>): SpokenReply {
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO spoken_replies (run_id, session_id, text, model, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET text = excluded.text, model = excluded.model,
           created_at = excluded.created_at`,
      )
      .run(s.runId, s.sessionId, s.text, s.model, createdAt);
    return { ...s, createdAt };
  }
}
