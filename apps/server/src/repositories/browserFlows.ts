import { randomUUID } from 'node:crypto';
import type { BrowserFlowDto, BrowserFlowStepDto } from '@friday/shared';
import type { Db } from '../db/database.js';

interface BrowserFlowRow {
  id: string;
  session_id: string;
  run_id: string;
  tool_call_id: string;
  project_id: string | null;
  title: string;
  start_url: string;
  width: number;
  height: number;
  engine: string;
  status: BrowserFlowDto['status'];
  duration_ms: number;
  steps: string;
  created_at: string;
}

export type NewBrowserFlow = Omit<BrowserFlowDto, 'id' | 'createdAt'>;

const toDto = (r: BrowserFlowRow): BrowserFlowDto => ({
  id: r.id,
  sessionId: r.session_id,
  runId: r.run_id,
  toolCallId: r.tool_call_id,
  projectId: r.project_id,
  title: r.title,
  startUrl: r.start_url,
  width: r.width,
  height: r.height,
  engine: r.engine,
  status: r.status,
  durationMs: r.duration_ms,
  steps: JSON.parse(r.steps) as BrowserFlowStepDto[],
  createdAt: r.created_at,
});

/** Results of browser flows, per conversation (the flow card). */
export class BrowserFlowRepo {
  constructor(private readonly db: Db) {}

  create(flow: NewBrowserFlow): BrowserFlowDto {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO browser_flows (id, session_id, run_id, tool_call_id, project_id, title, start_url, width, height, engine, status, duration_ms, steps, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        flow.sessionId,
        flow.runId,
        flow.toolCallId,
        flow.projectId,
        flow.title,
        flow.startUrl,
        flow.width,
        flow.height,
        flow.engine,
        flow.status,
        flow.durationMs,
        JSON.stringify(flow.steps),
        new Date().toISOString(),
      );
    return this.get(id)!;
  }

  get(id: string): BrowserFlowDto | null {
    const row = this.db.prepare('SELECT * FROM browser_flows WHERE id = ?').get(id) as unknown as
      BrowserFlowRow | undefined;
    return row ? toDto(row) : null;
  }

  listBySession(sessionId: string): BrowserFlowDto[] {
    return (
      this.db
        .prepare('SELECT * FROM browser_flows WHERE session_id = ? ORDER BY created_at, rowid')
        .all(sessionId) as unknown as BrowserFlowRow[]
    ).map(toDto);
  }
}
