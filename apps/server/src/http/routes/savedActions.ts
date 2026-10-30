import type { FastifyInstance } from 'fastify';
import type { SavedActionInput } from '@friday/shared';
import { z } from 'zod';
import type { Services } from '../../services.js';
import { HttpError } from '../errors.js';
import { parseInput } from '../validation.js';

const step = z.object({
  title: z.string().trim().min(1).max(120),
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('local'), cwd: z.string().trim().max(1024).default('.') }),
    z.object({ kind: z.literal('ssh'), hostId: z.uuid() }),
  ]),
  command: z.string().trim().min(1).max(4_000),
  timeoutSeconds: z.number().int().min(5).max(1_800).default(300),
  continueOnError: z.boolean().default(false),
});

export const savedActionInput = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(/^[\w .:/-]+$/, 'letters, digits, spaces and . _ : / - only'),
  description: z.string().trim().max(500).default(''),
  risk: z.enum(['low', 'medium', 'high', 'critical']),
  steps: z.array(step).min(1).max(30),
});

/**
 * Saved actions are created, changed and deleted only here, by the user through the UI (these
 * routes need the browser client header like every other change). The model can list them and
 * ask to run one; it has no way to edit them.
 */
export function registerSavedActionRoutes(app: FastifyInstance, s: Services) {
  const requireProject = (id: string) => {
    const p = s.projects.get(id);
    if (!p) throw new HttpError(404, 'project_not_found', 'Project not found.');
    // A task worktree uses its parent project's actions.
    return p.worktree ? (s.projects.get(p.worktree.parentId) ?? p) : p;
  };

  const check = (projectId: string, body: SavedActionInput, exceptId: string | null) => {
    for (const st of body.steps)
      if (st.target.kind === 'ssh' && !s.sshHosts.get(st.target.hostId))
        throw new HttpError(
          400,
          'unknown_host',
          `Step "${st.title}" uses an SSH host that no longer exists.`,
        );
    const same = s.savedActions.byName(projectId, body.name);
    if (same && same.id !== exceptId)
      throw new HttpError(
        409,
        'action_exists',
        `This project already has an action named "${body.name}".`,
      );
  };

  const audit = (action: string, a: { name: string; projectId: string }) =>
    s.audit.record({ actor: 'user', action, details: { name: a.name, projectId: a.projectId } });

  app.get('/api/projects/:id/actions', async (req) => {
    const { id } = parseInput(z.object({ id: z.uuid() }), req.params);
    const project = requireProject(id);
    return { projectId: project.id, actions: s.savedActions.listByProject(project.id) };
  });

  app.post('/api/projects/:id/actions', async (req, reply) => {
    const { id } = parseInput(z.object({ id: z.uuid() }), req.params);
    const project = requireProject(id);
    const body = parseInput(savedActionInput, req.body);
    check(project.id, body, null);
    const action = s.savedActions.create(project.id, body);
    audit('saved_action_created', action);
    reply.code(201);
    return action;
  });

  app.put('/api/actions/:id', async (req) => {
    const { id } = parseInput(z.object({ id: z.uuid() }), req.params);
    const existing = s.savedActions.get(id);
    if (!existing) throw new HttpError(404, 'action_not_found', 'Saved action not found.');
    const body = parseInput(savedActionInput, req.body);
    check(existing.projectId, body, id);
    const action = s.savedActions.update(id, body)!;
    audit('saved_action_changed', action);
    return action;
  });

  app.delete('/api/actions/:id', async (req, reply) => {
    const { id } = parseInput(z.object({ id: z.uuid() }), req.params);
    const existing = s.savedActions.get(id);
    if (!existing) throw new HttpError(404, 'action_not_found', 'Saved action not found.');
    s.savedActions.delete(id);
    audit('saved_action_deleted', existing);
    reply.code(204);
  });
}
