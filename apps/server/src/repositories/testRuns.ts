import { randomUUID } from 'node:crypto';
import type { TestRunDto } from '@friday/shared';
import { type Db, transaction } from '../db/database.js';
import type { NewTestRun, TestHistoryRow } from '../tools/types.js';

interface TestRunRow {
  id: string;
  project_id: string;
  session_id: string | null;
  run_id: string;
  tool_call_id: string;
  suite: string;
  framework: string;
  tree: string | null;
  data: string;
  created_at: string;
}

/** Runs kept per project and suite; older ones (and their per-test rows) are removed. */
const KEEP_RUNS = 50;
/** Earlier runs looked at for one test's history. */
const HISTORY_RUNS = 30;

const toDto = (r: TestRunRow): TestRunDto => ({
  ...(JSON.parse(r.data) as NewTestRun),
  id: r.id,
  projectId: r.project_id,
  sessionId: r.session_id,
  runId: r.run_id,
  toolCallId: r.tool_call_id,
  createdAt: r.created_at,
});

/** Test runs (run_tests) and each test's outcome, for spotting slow and flaky tests over time. */
export class TestRunRepo {
  constructor(private readonly db: Db) {}

  create(
    meta: { projectId: string; sessionId: string; runId: string; toolCallId: string },
    run: NewTestRun,
    results: Array<{ key: string; status: TestHistoryRow['status']; durationMs: number | null }>,
    tree: string | null,
  ): TestRunDto {
    const id = randomUUID();
    const insertResult = this.db.prepare(
      'INSERT OR IGNORE INTO test_results (test_run_id, test_key, status, duration_ms) VALUES (?, ?, ?, ?)',
    );
    transaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO test_runs (id, project_id, session_id, run_id, tool_call_id, suite, framework, tree, data, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          meta.projectId,
          meta.sessionId,
          meta.runId,
          meta.toolCallId,
          run.suite,
          run.framework,
          tree,
          JSON.stringify(run),
          new Date().toISOString(),
        );
      for (const r of results) insertResult.run(id, r.key, r.status, r.durationMs);
      this.db
        .prepare(
          `DELETE FROM test_runs WHERE project_id = ? AND suite = ? AND id NOT IN (
             SELECT id FROM test_runs WHERE project_id = ? AND suite = ?
             ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
        )
        .run(meta.projectId, run.suite, meta.projectId, run.suite, KEEP_RUNS);
    });
    return this.get(id)!;
  }

  get(id: string): TestRunDto | null {
    const row = this.db.prepare('SELECT * FROM test_runs WHERE id = ?').get(id) as unknown as
      TestRunRow | undefined;
    return row ? toDto(row) : null;
  }

  listBySession(sessionId: string): TestRunDto[] {
    return (
      this.db
        .prepare('SELECT * FROM test_runs WHERE session_id = ? ORDER BY created_at, rowid')
        .all(sessionId) as unknown as TestRunRow[]
    ).map(toDto);
  }

  /** Outcomes of these tests in the suite's recent runs, newest first. */
  history(projectId: string, suite: string, keys: string[]): TestHistoryRow[] {
    if (!keys.length) return [];
    const runs = this.db
      .prepare(
        `SELECT id, tree FROM test_runs WHERE project_id = ? AND suite = ?
           ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(projectId, suite, HISTORY_RUNS) as Array<{ id: string; tree: string | null }>;
    if (!runs.length) return [];
    const tree = new Map(runs.map((r) => [r.id, r.tree]));
    const order = new Map(runs.map((r, i) => [r.id, i]));
    const wanted = new Set(keys);
    const rows: Array<TestHistoryRow & { at: number }> = [];
    const select = this.db.prepare(
      'SELECT test_key, status, duration_ms FROM test_results WHERE test_run_id = ?',
    );
    for (const r of runs) {
      for (const row of select.all(r.id) as Array<{
        test_key: string;
        status: TestHistoryRow['status'];
        duration_ms: number | null;
      }>) {
        if (!wanted.has(row.test_key)) continue;
        rows.push({
          key: row.test_key,
          status: row.status,
          durationMs: row.duration_ms,
          tree: tree.get(r.id) ?? null,
          at: order.get(r.id)!,
        });
      }
    }
    return rows.sort((a, b) => a.at - b.at).map(({ at: _at, ...r }) => r);
  }
}
