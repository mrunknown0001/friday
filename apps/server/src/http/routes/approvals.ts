import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { revertFileChange } from '../../approvals/revert.js';
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
    s.audit.record({
      sessionId: change.sessionId,
      actor: 'user',
      action: 'file_change_reverted',
      details: { changeId: id, path: change.path, change: change.change },
    });
    return toFileChangeDto(s.fileChanges.get(id)!);
  });
}
