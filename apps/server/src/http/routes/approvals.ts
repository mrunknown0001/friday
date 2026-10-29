import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { revertChanges, revertFileChange } from '../../approvals/revert.js';
import { buildRunReport, taskRunIds } from '../../reports/runReport.js';
import { toRunDto } from '../../repositories/runs.js';
import { toFileChangeDto } from '../../repositories/fileChanges.js';
import type { Services } from '../../services.js';
import { HttpError } from '../errors.js';
import { parseInput } from '../validation.js';

export function registerApprovalRoutes(app: FastifyInstance, s: Services) {
  /**
   * The only way an approval can be granted. It requires the browser client header (CSRF guard),
   * the exact action hash the user reviewed, and the session the approval belongs to.
   */
  app.post('/api/approvals/:id/decision', async (req) => {
    const { id } = parseInput(z.object({ id: z.uuid() }), req.params);
    const body = parseInput(
      z.object({
        decision: z.enum(['approve', 'reject']),
        actionHash: z.string().regex(/^[0-9a-f]{64}$/),
        sessionId: z.uuid(),
        note: z.string().max(2_000).optional(),
        confirmation: z.string().max(200).optional(),
      }),
      req.body,
    );
    return s.approvals.decide(id, body);
  });

  app.get('/api/sessions/:id/changes', async (req) => {
    const { id } = parseInput(z.object({ id: z.uuid() }), req.params);
    if (!s.sessions.get(id)) throw new HttpError(404, 'session_not_found', 'Session not found.');
    return { changes: s.fileChanges.listBySession(id).map(toFileChangeDto) };
  });

  // Undo is a direct user action (a click in the UI), so it does not go through agent approvals.
  app.post('/api/file-changes/:id/revert', async (req) => {
    const { id } = parseInput(z.object({ id: z.coerce.number().int().positive() }), req.params);
    const change = s.fileChanges.get(id);
    if (!change) throw new HttpError(404, 'change_not_found', 'Change not found.');
    if (change.revertedAt)
      throw new HttpError(409, 'already_reverted', 'This change was already undone.');
    if (s.fileChanges.laterChangesToPath(change) > 0) {
      throw new HttpError(
        409,
        'later_changes',
        `Undo the later changes to "${change.path}" first.`,
      );
    }
    const project = s.projects.get(change.projectId);
    if (!project)
      throw new HttpError(409, 'project_removed', 'The project for this change was removed.');
    await revertFileChange(change, project.rootPath);
    s.fileChanges.markReverted(id);
    const runId = change.approvalId ? s.approvalRepo.get(change.approvalId)?.runId : null;
    if (runId && s.runs.get(runId)?.report) s.runs.setReport(runId, buildRunReport(runId, s));
    s.audit.record({
      sessionId: change.sessionId,
      actor: 'user',
      action: 'file_change_reverted',
      details: { changeId: id, path: change.path, change: change.change },
    });
    return toFileChangeDto(s.fileChanges.get(id)!);
  });

  /** Undo every file change a run made (newest first). All-or-nothing validation up front. */
  app.post('/api/runs/:id/rollback', async (req) => {
    const { id } = parseInput(z.object({ id: z.uuid() }), req.params);
    const run = s.runs.get(id);
    if (!run) throw new HttpError(404, 'run_not_found', 'Run not found.');
    if (s.runManager.activeRunId(run.sessionId) === id) {
      throw new HttpError(409, 'run_in_progress', 'Stop the run before rolling it back.');
    }
    // Roll back the whole task: this run plus the unfinished attempts it continued.
    const chain = taskRunIds(id, s.runs);
    const pending = chain
      .flatMap((rid) => s.fileChanges.listByRun(rid))
      .filter((c) => !c.revertedAt);
    if (pending.length === 0)
      throw new HttpError(409, 'nothing_to_roll_back', 'This run has no file changes to undo.');
    const runIds = new Set(pending.map((c) => c.id));
    for (const c of pending) {
      // Changes from later runs to the same files must be undone first.
      const later = s.fileChanges
        .listBySession(run.sessionId)
        .filter(
          (o) =>
            o.id > c.id &&
            !o.revertedAt &&
            !runIds.has(o.id) &&
            (o.path === c.path || o.fromPath === c.path),
        );
      if (later.length)
        throw new HttpError(
          409,
          'later_changes',
          `"${c.path}" was changed again later; undo those changes first.`,
        );
    }
    const project = s.projects.get(pending[0]!.projectId);
    if (!project)
      throw new HttpError(409, 'project_removed', 'The project for this change was removed.');
    const reverted: string[] = [];
    await revertChanges(pending, project.rootPath, (c) => {
      s.fileChanges.markReverted(c.id);
      reverted.push(c.path);
    });
    for (const rid of chain)
      if (s.runs.get(rid)?.report) s.runs.setReport(rid, buildRunReport(rid, s));
    s.audit.record({
      sessionId: run.sessionId,
      actor: 'user',
      action: 'run_rolled_back',
      details: { runId: id, files: reverted },
    });
    return { reverted, run: toRunDto(s.runs.get(id)!) };
  });
}
