import { randomUUID } from 'node:crypto';
import type { LoadTargetDto, LoadTargetInput, LoadTestDto } from '@friday/shared';
import { z } from 'zod';
import type { Db } from '../db/database.js';
import type { SettingsRepo } from './settings.js';

interface LoadTestRow {
  id: string;
  session_id: string;
  run_id: string;
  tool_call_id: string;
  project_id: string | null;
  status: LoadTestDto['status'];
  data: string;
  created_at: string;
}

export type NewLoadTest = Omit<
  LoadTestDto,
  'id' | 'createdAt' | 'sessionId' | 'runId' | 'toolCallId' | 'projectId'
>;

const toDto = (r: LoadTestRow): LoadTestDto => ({
  ...(JSON.parse(r.data) as NewLoadTest),
  id: r.id,
  sessionId: r.session_id,
  runId: r.run_id,
  toolCallId: r.tool_call_id,
  projectId: r.project_id,
  status: r.status,
  createdAt: r.created_at,
});

/** Results of k6 runs, per conversation. */
export class LoadTestRepo {
  constructor(private readonly db: Db) {}

  create(
    meta: { sessionId: string; runId: string; toolCallId: string; projectId: string | null },
    result: NewLoadTest,
  ): LoadTestDto {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO load_tests (id, session_id, run_id, tool_call_id, project_id, status, data, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        meta.sessionId,
        meta.runId,
        meta.toolCallId,
        meta.projectId,
        result.status,
        JSON.stringify(result),
        new Date().toISOString(),
      );
    return this.get(id)!;
  }

  get(id: string): LoadTestDto | null {
    const row = this.db.prepare('SELECT * FROM load_tests WHERE id = ?').get(id) as unknown as
      LoadTestRow | undefined;
    return row ? toDto(row) : null;
  }

  listBySession(sessionId: string): LoadTestDto[] {
    return (
      this.db
        .prepare('SELECT * FROM load_tests WHERE session_id = ? ORDER BY created_at, rowid')
        .all(sessionId) as unknown as LoadTestRow[]
    ).map(toDto);
  }
}

const TARGETS_KEY = 'loadTargets';

const targetsSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    origin: z.string(),
    environment: z.enum(['development', 'staging', 'production']),
    maxVus: z.number(),
    maxDurationSeconds: z.number(),
    createdAt: z.string(),
  }),
);

/**
 * Hosts the user allows load tests against, with their limits (Settings). Only the user changes
 * them (HTTP routes); this machine needs no entry.
 */
export class LoadTargetRepo {
  constructor(private readonly settings: SettingsRepo) {}

  list(): LoadTargetDto[] {
    return this.settings.get(TARGETS_KEY, targetsSchema) ?? [];
  }

  byName(name: string): LoadTargetDto | null {
    return this.list().find((t) => t.name.toLowerCase() === name.toLowerCase()) ?? null;
  }

  byOrigin(origin: string): LoadTargetDto | null {
    return this.list().find((t) => t.origin === origin) ?? null;
  }

  create(input: LoadTargetInput): LoadTargetDto {
    const target: LoadTargetDto = {
      ...input,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    this.settings.set(TARGETS_KEY, [...this.list(), target]);
    return target;
  }

  delete(id: string): LoadTargetDto | null {
    const all = this.list();
    const gone = all.find((t) => t.id === id) ?? null;
    if (gone)
      this.settings.set(
        TARGETS_KEY,
        all.filter((t) => t.id !== id),
      );
    return gone;
  }
}
