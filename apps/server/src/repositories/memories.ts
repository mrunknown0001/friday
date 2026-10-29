import { randomUUID } from 'node:crypto';
import type {
  MemoryCategory,
  MemoryDto,
  MemoryRef,
  MemoryScope,
  MemoryStatus,
} from '@friday/shared';
import { type Db, transaction } from '../db/database.js';

interface MemoryRow {
  id: string;
  scope: MemoryScope;
  category: MemoryCategory;
  content: string;
  project_id: string | null;
  session_id: string | null;
  status: MemoryStatus;
  confidence: 'confirmed' | 'assumed';
  pinned: number;
  source: 'agent' | 'user';
  source_run_id: string | null;
  supersedes_id: string | null;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  use_count: number;
}

const toDto = (r: MemoryRow): MemoryDto => ({
  id: r.id,
  scope: r.scope,
  category: r.category,
  content: r.content,
  projectId: r.project_id,
  sessionId: r.session_id,
  status: r.status,
  confidence: r.confidence,
  pinned: r.pinned === 1,
  source: r.source,
  sourceRunId: r.source_run_id,
  supersedesId: r.supersedes_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  lastUsedAt: r.last_used_at,
  useCount: r.use_count,
});

/**
 * Turn free text into a safe FTS5 query: words only (no FTS operators or quotes from the
 * input), OR-ed so any overlap counts, ranked by BM25.
 */
export function ftsQuery(text: string, maxTerms = 24): string | null {
  const STOP = new Set([
    'the',
    'and',
    'for',
    'with',
    'that',
    'this',
    'what',
    'how',
    'are',
    'you',
    'can',
    'please',
    'from',
    'into',
    'have',
    'does',
    'will',
    'should',
    'about',
    'there',
    'here',
    'they',
    'them',
    'then',
    'than',
    'when',
    'where',
    'which',
    'would',
    'could',
  ]);
  const terms = [
    ...new Set((text.toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) ?? []).filter((t) => !STOP.has(t))),
  ].slice(0, maxTerms);
  return terms.length ? terms.map((t) => `"${t}"`).join(' OR ') : null;
}

/** Visibility filter for one session: user memories, this project's, this session's, and operational. */
export interface MemoryVisibility {
  projectId: string | null;
  sessionId: string | null;
}

const VISIBLE = `(
  m.scope = 'user'
  OR (m.scope = 'project' AND m.project_id IS NOT NULL AND m.project_id = @projectId)
  OR (m.scope = 'session' AND m.session_id = @sessionId)
  OR (m.scope = 'operational' AND (m.project_id IS NULL OR m.project_id = @projectId))
)`;

export type NewMemory = Pick<
  MemoryDto,
  'scope' | 'category' | 'content' | 'projectId' | 'sessionId' | 'status' | 'confidence' | 'source'
> & {
  sourceRunId?: string | null;
  supersedesId?: string | null;
  pinned?: boolean;
};

export class MemoryRepo {
  constructor(private readonly db: Db) {}

  create(m: NewMemory): MemoryDto {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO memories (id, scope, category, content, project_id, session_id, status, confidence, pinned,
           source, source_run_id, supersedes_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        m.scope,
        m.category,
        m.content,
        m.projectId,
        m.sessionId,
        m.status,
        m.confidence,
        m.pinned ? 1 : 0,
        m.source,
        m.sourceRunId ?? null,
        m.supersedesId ?? null,
        now,
        now,
      );
    return this.get(id)!;
  }

  get(id: string): MemoryDto | null {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as
      MemoryRow | undefined;
    return row ? toDto(row) : null;
  }

  update(
    id: string,
    fields: Partial<Pick<MemoryDto, 'content' | 'category' | 'pinned' | 'confidence' | 'status'>>,
  ): MemoryDto | null {
    const current = this.get(id);
    if (!current) return null;
    const next = { ...current, ...fields };
    this.db
      .prepare(
        `UPDATE memories SET content = ?, category = ?, pinned = ?, confidence = ?, status = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        next.content,
        next.category,
        next.pinned ? 1 : 0,
        next.confidence,
        next.status,
        new Date().toISOString(),
        id,
      );
    return this.get(id);
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM memories WHERE id = ?').run(id).changes > 0;
  }

  /** Listing for the memory browser. `projectId` narrows project/operational memories to one project. */
  list(
    filter: {
      scope?: MemoryScope;
      projectId?: string | null;
      status?: MemoryStatus;
      query?: string;
      limit?: number;
    } = {},
  ): MemoryDto[] {
    const where: string[] = [];
    const params: Record<string, unknown> = { limit: filter.limit ?? 500 };
    if (filter.scope) {
      where.push('m.scope = @scope');
      params.scope = filter.scope;
    }
    if (filter.projectId !== undefined) {
      where.push(filter.projectId === null ? 'm.project_id IS NULL' : 'm.project_id = @projectId');
      params.projectId = filter.projectId;
    }
    if (filter.status) {
      where.push('m.status = @status');
      params.status = filter.status;
    }
    const q = filter.query ? ftsQuery(filter.query) : null;
    if (filter.query && !q) return [];
    const sql = q
      ? `SELECT m.* FROM memories_fts f JOIN memories m ON m.rowid = f.rowid
         WHERE memories_fts MATCH @q ${where.length ? `AND ${where.join(' AND ')}` : ''}
         ORDER BY bm25(memories_fts) LIMIT @limit`
      : `SELECT m.* FROM memories m ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY m.pinned DESC, m.updated_at DESC LIMIT @limit`;
    if (q) params.q = q;
    return (this.db.prepare(sql).all(params) as MemoryRow[]).map(toDto);
  }

  /** Active memories visible to a session, most relevant to `query` first (BM25). */
  searchVisible(vis: MemoryVisibility, query: string, limit: number): MemoryDto[] {
    const q = ftsQuery(query);
    if (!q) return [];
    return (
      this.db
        .prepare(
          `SELECT m.* FROM memories_fts f JOIN memories m ON m.rowid = f.rowid
           WHERE memories_fts MATCH @q AND m.status = 'active' AND ${VISIBLE}
           ORDER BY bm25(memories_fts) LIMIT @limit`,
        )
        .all({ q, limit, projectId: vis.projectId, sessionId: vis.sessionId }) as MemoryRow[]
    ).map(toDto);
  }

  /** All active memories visible to a session (used for pinned/session context and dedup). */
  visible(vis: MemoryVisibility, extra: 'pinned' | 'session' | 'preferences' | 'all'): MemoryDto[] {
    const cond =
      extra === 'pinned'
        ? 'AND m.pinned = 1'
        : extra === 'session'
          ? "AND m.scope = 'session'"
          : extra === 'preferences'
            ? "AND m.scope = 'user' AND m.category = 'preference'"
            : '';
    return (
      this.db
        .prepare(
          `SELECT m.* FROM memories m WHERE m.status = 'active' AND ${VISIBLE} ${cond} ORDER BY m.updated_at DESC LIMIT 500`,
        )
        .all({ projectId: vis.projectId, sessionId: vis.sessionId }) as MemoryRow[]
    ).map(toDto);
  }

  countPendingFromRun(runId: string): number {
    return (
      this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM memories WHERE source_run_id = ? AND status = 'pending'",
        )
        .get(runId) as { n: number }
    ).n;
  }

  countActive(scope: MemoryScope, projectId: string | null): number {
    return (
      this.db
        .prepare(
          'SELECT COUNT(*) AS n FROM memories WHERE scope = ? AND project_id IS ? AND status = ?',
        )
        .get(scope, projectId, 'active') as { n: number }
    ).n;
  }

  recordUsage(runId: string, refs: MemoryRef[]): void {
    const now = new Date().toISOString();
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO run_memories (run_id, memory_id, reason, snapshot) VALUES (?, ?, ?, ?)',
    );
    const bump = this.db.prepare(
      'UPDATE memories SET use_count = use_count + 1, last_used_at = ? WHERE id = ?',
    );
    transaction(this.db, () => {
      for (const r of refs) {
        insert.run(runId, r.id, r.reason, JSON.stringify(r));
        bump.run(now, r.id);
      }
    });
  }

  /** Snapshots (as shown at the time) of memories used per run in a session. */
  usageBySession(sessionId: string): Record<string, MemoryRef[]> {
    const rows = this.db
      .prepare(
        `SELECT rm.run_id, rm.snapshot FROM run_memories rm JOIN runs r ON r.id = rm.run_id
         WHERE r.session_id = ? ORDER BY rm.rowid`,
      )
      .all(sessionId) as Array<{ run_id: string; snapshot: string }>;
    const out: Record<string, MemoryRef[]> = {};
    for (const r of rows) (out[r.run_id] ??= []).push(JSON.parse(r.snapshot) as MemoryRef);
    return out;
  }
}
