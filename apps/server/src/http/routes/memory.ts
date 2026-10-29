import fs from 'node:fs/promises';
import path from 'node:path';
import type { MemoryDto } from '@friday/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MEMORY_CATEGORIES, MemoryError, rejectReason } from '../../memory/service.js';
import type { Services } from '../../services.js';
import { assertRootAvailable, resolveForWrite, WorkspaceError } from '../../workspace/paths.js';
import { HttpError } from '../errors.js';
import { parseInput } from '../validation.js';

const scope = z.enum(['user', 'project', 'session', 'operational']);
const category = z.enum(MEMORY_CATEGORIES);

function exportMarkdown(projectName: string, memories: MemoryDto[]): string {
  const byCategory = new Map<string, MemoryDto[]>();
  for (const m of memories) byCategory.set(m.category, [...(byCategory.get(m.category) ?? []), m]);
  const lines = [
    `# Project memory: ${projectName}`,
    '',
    'Exported from Friday. Facts recorded during earlier work; verify before relying on them.',
    '',
  ];
  for (const [cat, items] of byCategory) {
    lines.push(`## ${cat.replace(/_/g, ' ')}`, '');
    for (const m of items)
      lines.push(
        `- ${m.content.replace(/\n/g, ' ')}${m.confidence === 'assumed' ? ' _(assumed)_' : ''}`,
      );
    lines.push('');
  }
  return lines.join('\n');
}

export function registerMemoryRoutes(app: FastifyInstance, s: Services) {
  const requireMemory = (id: string) => {
    const m = s.memoryRepo.get(id);
    if (!m) throw new HttpError(404, 'memory_not_found', 'Memory not found.');
    return m;
  };

  app.get('/api/memories', async (req) => {
    const q = parseInput(
      z.object({
        scope: scope.optional(),
        projectId: z.union([z.uuid(), z.literal('none')]).optional(),
        status: z.enum(['active', 'pending', 'superseded', 'rejected']).optional(),
        q: z.string().max(300).optional(),
      }),
      req.query,
    );
    return {
      memories: s.memoryRepo.list({
        ...(q.scope ? { scope: q.scope } : {}),
        ...(q.projectId ? { projectId: q.projectId === 'none' ? null : q.projectId } : {}),
        ...(q.status ? { status: q.status } : {}),
        ...(q.q ? { query: q.q } : {}),
      }),
    };
  });

  app.post('/api/memories', async (req, reply) => {
    const body = parseInput(
      z.strictObject({
        scope: z.enum(['user', 'project', 'operational']),
        category,
        content: z.string().min(1).max(1_000),
        projectId: z.uuid().nullable().default(null),
      }),
      req.body,
    );
    if (body.projectId && !s.projects.get(body.projectId))
      throw new HttpError(404, 'project_not_found', 'Project not found.');
    try {
      const { memory } = s.memory.propose(
        {
          scope: body.scope,
          category: body.category,
          content: body.content,
          confidence: 'confirmed',
        },
        { projectId: body.projectId, sessionId: null, runId: null, source: 'user' },
      );
      s.audit.record({
        actor: 'user',
        action: 'memory_created',
        details: { id: memory.id, scope: memory.scope },
      });
      reply.code(201);
      return memory;
    } catch (err) {
      if (err instanceof MemoryError) throw new HttpError(400, 'memory_rejected', err.message);
      throw err;
    }
  });

  /** Edit, pin, approve (pending → active) or reject a memory. Always a user action. */
  app.patch('/api/memories/:id', async (req) => {
    const { id } = parseInput(z.object({ id: z.uuid() }), req.params);
    const body = parseInput(
      z.strictObject({
        content: z.string().min(1).max(1_000).optional(),
        category: category.optional(),
        pinned: z.boolean().optional(),
        confidence: z.enum(['confirmed', 'assumed']).optional(),
        status: z.enum(['active', 'rejected']).optional(),
      }),
      req.body,
    );
    const current = requireMemory(id);
    if (body.content !== undefined) {
      const reason = rejectReason(body.content, s.redactor);
      if (reason) throw new HttpError(400, 'memory_rejected', reason);
    }
    const updated = s.memoryRepo.update(id, {
      ...body,
      ...(body.content !== undefined ? { content: body.content.trim() } : {}),
      // Editing a memory is the user confirming it.
      ...(body.content !== undefined && body.confidence === undefined
        ? { confidence: 'confirmed' as const }
        : {}),
    })!;
    // Approving a replacement retires the memory it replaces.
    if (current.status === 'pending' && body.status === 'active' && current.supersedesId) {
      s.memoryRepo.update(current.supersedesId, { status: 'superseded' });
    }
    s.audit.record({
      actor: 'user',
      action: 'memory_updated',
      details: { id, changes: Object.keys(body) },
    });
    return updated;
  });

  app.delete('/api/memories/:id', async (req, reply) => {
    const { id } = parseInput(z.object({ id: z.uuid() }), req.params);
    requireMemory(id);
    s.memoryRepo.delete(id);
    s.audit.record({ actor: 'user', action: 'memory_deleted', details: { id } });
    reply.code(204);
  });

  app.get('/api/memory/settings', async () => s.memory.getSettings());

  app.put('/api/memory/settings', async (req) => {
    const body = parseInput(
      z.strictObject({ enabled: z.boolean(), disabledProjectIds: z.array(z.uuid()).max(500) }),
      req.body,
    );
    const settings = s.memory.setSettings(body);
    s.audit.record({ actor: 'user', action: 'memory_settings_changed', details: settings });
    return settings;
  });

  /** Write the project's active memories to .friday/memory.md (a user action; the file is then read as guidance). */
  app.post('/api/projects/:id/memory/export', async (req) => {
    const { id } = parseInput(z.object({ id: z.uuid() }), req.params);
    const project = s.projects.get(id);
    if (!project) throw new HttpError(404, 'project_not_found', 'Project not found.');
    const memories = s.memoryRepo
      .list({ projectId: id, status: 'active' })
      .filter((m) => m.scope === 'project' || m.scope === 'operational');
    if (!memories.length)
      throw new HttpError(409, 'nothing_to_export', 'This project has no active memories.');
    try {
      await assertRootAvailable(project.rootPath);
      const target = await resolveForWrite(project.rootPath, '.friday/memory.md');
      await fs.mkdir(path.dirname(target.abs), { recursive: true });
      await fs.writeFile(target.abs, exportMarkdown(project.name, memories));
      s.audit.record({
        actor: 'user',
        action: 'memory_exported',
        details: { projectId: id, count: memories.length },
      });
      return { path: target.rel, count: memories.length };
    } catch (err) {
      if (err instanceof WorkspaceError) throw new HttpError(409, err.code, err.message);
      throw err;
    }
  });
}
