import type { ProcessDto, ProcessOutputDto } from '@friday/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PROCESS_ID } from '../../processes/manager.js';
import type { Services } from '../../services.js';
import { HttpError } from '../errors.js';
import { parseInput } from '../validation.js';

const processParams = z.object({ id: z.string().regex(PROCESS_ID) });

/**
 * Background processes for the Processes panel: list, follow output, stop, dismiss. Starting one
 * is only possible through an approved start_process call.
 */
export function registerProcessRoutes(app: FastifyInstance, s: Services) {
  const requireProcess = (id: string): ProcessDto => {
    const p = s.processes.get(id);
    if (!p) throw new HttpError(404, 'process_not_found', 'Process not found.');
    return p;
  };

  // Nothing Friday started outlives the server.
  app.addHook('onClose', async () => {
    await s.processes.shutdown();
  });

  app.get('/api/projects/:id/processes', async (req) => {
    const { id } = parseInput(z.object({ id: z.uuid() }), req.params);
    if (!s.projects.get(id)) throw new HttpError(404, 'project_not_found', 'Project not found.');
    return { processes: s.processes.list(id) };
  });

  app.get('/api/processes/:id/output', async (req): Promise<ProcessOutputDto> => {
    const { id } = parseInput(processParams, req.params);
    const q = parseInput(
      z.object({
        since: z.coerce.number().int().min(0).optional(),
        tail: z.coerce.number().int().min(1).max(5_000).optional(),
      }),
      req.query,
    );
    requireProcess(id);
    return s.processes.read(id, {
      ...(q.since !== undefined ? { since: q.since } : {}),
      tailLines: q.tail ?? 1_000,
    })!;
  });

  app.post('/api/processes/:id/stop', async (req) => {
    const { id } = parseInput(processParams, req.params);
    requireProcess(id);
    return (await s.processes.stop(id, 'user'))!;
  });

  app.delete('/api/processes/:id', async (req, reply) => {
    const { id } = parseInput(processParams, req.params);
    const p = requireProcess(id);
    if (!s.processes.dismiss(id))
      throw new HttpError(409, 'process_running', `Stop "${p.name}" before removing it.`);
    reply.code(204);
  });
}
