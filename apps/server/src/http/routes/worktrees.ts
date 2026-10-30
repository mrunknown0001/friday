import type { ProjectDto, WorktreeStatusDto } from '@friday/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ProjectRecord } from '../../repositories/projects.js';
import type { Services } from '../../services.js';
import { assertRootAvailable } from '../../workspace/paths.js';
import { HttpError } from '../errors.js';
import { parseInput } from '../validation.js';
import { guarded } from './projects.js';

const idParams = z.object({ id: z.uuid() });

/**
 * Task worktrees: start a conversation in a new worktree, and accept or discard its result. All of
 * these are the user's actions in the UI; the model has no tool for them.
 */
export function registerWorktreeRoutes(app: FastifyInstance, s: Services) {
  const requireProject = (id: string) => {
    const p = s.projects.get(id);
    if (!p) throw new HttpError(404, 'project_not_found', 'Project not found.');
    return p;
  };
  const toDto = async (p: ProjectRecord): Promise<ProjectDto> => ({
    ...p,
    available: await assertRootAvailable(p.rootPath).then(
      () => true,
      () => false,
    ),
  });
  /** A worktree must not change under a running task. */
  const idle = (projectId: string) =>
    s.sessions.list(projectId).every((c) => !s.runManager.activeRunId(c.id));
  const requireIdle = (projectId: string) => {
    if (!idle(projectId))
      throw new HttpError(
        409,
        'task_running',
        'A task is still running in this worktree. Wait for it, or stop it first.',
      );
  };
  const stopProcesses = async (projectId: string) => {
    for (const p of s.processes.list(projectId))
      if (p.status === 'running') await s.processes.stop(p.id, 'user');
  };

  app.post('/api/projects/:id/worktrees', async (req, reply) => {
    const { id } = parseInput(idParams, req.params);
    const body = parseInput(
      z.object({ title: z.string().trim().min(1).max(200).optional() }),
      req.body ?? {},
    );
    const parent = requireProject(id);
    const project = await guarded(() => s.worktrees.create(parent));
    const session = s.sessions.create(body.title ?? 'New task', project.id);
    s.projects.touch(parent.id);
    s.audit.record({
      sessionId: session.id,
      actor: 'user',
      action: 'worktree_created',
      details: {
        projectId: parent.id,
        worktree: project.rootPath,
        branch: project.worktree!.branch,
      },
    });
    reply.code(201);
    return { project: await toDto(project), sessionId: session.id };
  });

  app.get('/api/projects/:id/worktree', async (req): Promise<WorktreeStatusDto> => {
    const { id } = parseInput(idParams, req.params);
    const project = requireProject(id);
    const st = await guarded(() => s.worktrees.status(project));
    return {
      project: await toDto(project),
      commits: st.commits,
      uncommitted: st.uncommitted,
      target: st.target,
      idle: idle(project.id),
    };
  });

  app.post('/api/projects/:id/worktree/accept', async (req) => {
    const { id } = parseInput(idParams, req.params);
    const body = parseInput(
      z.object({
        mode: z.enum(['merge', 'squash', 'branch']),
        message: z.string().trim().min(1).max(2_000),
      }),
      req.body,
    );
    const project = requireProject(id);
    requireIdle(project.id);
    await stopProcesses(project.id);
    const info = await guarded(() => s.worktrees.accept(project, body.mode, body.message));
    s.codeMap.clear(project.id);
    s.audit.record({
      actor: 'user',
      action: 'worktree_accepted',
      details: { projectId: project.id, branch: info.branch, outcome: info.outcome },
    });
    return { project: await toDto(s.projects.get(project.id)!) };
  });

  app.post('/api/projects/:id/worktree/discard', async (req) => {
    const { id } = parseInput(idParams, req.params);
    const project = requireProject(id);
    requireIdle(project.id);
    await stopProcesses(project.id);
    const info = await guarded(() => s.worktrees.discard(project));
    s.codeMap.clear(project.id);
    s.audit.record({
      actor: 'user',
      action: 'worktree_discarded',
      details: { projectId: project.id, branch: info.branch },
    });
    return { project: await toDto(s.projects.get(project.id)!) };
  });
}
