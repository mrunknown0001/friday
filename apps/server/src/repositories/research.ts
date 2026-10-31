import { randomUUID } from 'node:crypto';
import type { ResearchDto } from '@friday/shared';
import type { Db } from '../db/database.js';
import type { ResearchState } from '../web/research.js';

interface ResearchRow {
  id: string;
  session_id: string;
  run_id: string;
  tool_call_id: string;
  project_id: string | null;
  status: ResearchDto['status'];
  data: string;
  created_at: string;
}

const toDto = (r: ResearchRow): ResearchDto => ({
  ...(JSON.parse(r.data) as ResearchState),
  id: r.id,
  sessionId: r.session_id,
  runId: r.run_id,
  toolCallId: r.tool_call_id,
  projectId: r.project_id,
  status: r.status,
});

/** Deep research, per conversation; updated as it runs so a reload shows its progress. */
export class ResearchRepo {
  constructor(private readonly db: Db) {}

  create(
    meta: { sessionId: string; runId: string; toolCallId: string; projectId: string | null },
    state: ResearchState,
  ): ResearchDto {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO research (id, session_id, run_id, tool_call_id, project_id, status, data, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        meta.sessionId,
        meta.runId,
        meta.toolCallId,
        meta.projectId,
        state.status,
        JSON.stringify(state),
        new Date().toISOString(),
      );
    return this.get(id)!;
  }

  update(id: string, state: ResearchState): ResearchDto | null {
    this.db
      .prepare('UPDATE research SET status = ?, data = ? WHERE id = ?')
      .run(state.status, JSON.stringify(state), id);
    return this.get(id);
  }

  get(id: string): ResearchDto | null {
    const row = this.db.prepare('SELECT * FROM research WHERE id = ?').get(id) as unknown as
      ResearchRow | undefined;
    return row ? toDto(row) : null;
  }

  listBySession(sessionId: string): ResearchDto[] {
    return (
      this.db
        .prepare('SELECT * FROM research WHERE session_id = ? ORDER BY created_at, rowid')
        .all(sessionId) as unknown as ResearchRow[]
    ).map(toDto);
  }

  /** At startup: research that was running when Friday stopped can't continue. */
  stopUnfinished(): number {
    const rows = this.db
      .prepare("SELECT * FROM research WHERE status = 'running'")
      .all() as unknown as ResearchRow[];
    for (const r of rows) {
      const state = JSON.parse(r.data) as ResearchState;
      this.update(r.id, {
        ...state,
        status: 'stopped',
        phase: 'done',
        note: 'Friday was restarted while this research was running.',
        finishedAt: state.finishedAt ?? new Date().toISOString(),
      });
    }
    return rows.length;
  }
}
