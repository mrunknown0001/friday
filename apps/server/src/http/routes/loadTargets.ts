import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isLocalUrl } from '../../browser/urls.js';
import type { Services } from '../../services.js';
import { LOAD_LIMITS } from '../../tools/loadTestTools.js';
import { HttpError } from '../errors.js';
import { parseInput } from '../validation.js';

const targetInput = z.strictObject({
  name: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(/^[\w.-]+$/, 'letters, digits, . _ - only'),
  origin: z.string().trim().min(1).max(500),
  environment: z.enum(['development', 'staging', 'production']),
  maxVus: z.number().int().min(1).max(LOAD_LIMITS.hard.maxVus).default(20),
  maxDurationSeconds: z
    .number()
    .int()
    .min(10)
    .max(LOAD_LIMITS.hard.maxDurationSeconds)
    .default(300),
});

/**
 * Hosts load tests may hit besides this machine, each with its own limits. Only the user adds or
 * removes them, here; the model can only name them.
 */
export function registerLoadTargetRoutes(app: FastifyInstance, s: Services) {
  app.get('/api/load-targets', async () => ({ targets: s.loadTargets.list() }));

  app.post('/api/load-targets', async (req, reply) => {
    const body = parseInput(targetInput, req.body);
    let url: URL;
    try {
      url = new URL(body.origin);
    } catch {
      throw new HttpError(
        400,
        'invalid_origin',
        'Give the site as a URL, e.g. https://staging.example.com.',
      );
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      throw new HttpError(400, 'invalid_origin', 'Only http and https sites can be load-tested.');
    if (url.username || url.password)
      throw new HttpError(400, 'invalid_origin', 'Leave credentials out of the URL.');
    if (isLocalUrl(url.toString()))
      throw new HttpError(
        400,
        'invalid_origin',
        'This machine needs no entry: load tests may always target localhost.',
      );
    if (s.loadTargets.byName(body.name))
      throw new HttpError(409, 'target_exists', `A target named "${body.name}" already exists.`);
    if (s.loadTargets.byOrigin(url.origin))
      throw new HttpError(409, 'target_exists', `${url.origin} is already a target.`);
    const t = s.loadTargets.create({ ...body, origin: url.origin });
    s.audit.record({
      actor: 'user',
      action: 'load_target_added',
      details: {
        name: t.name,
        origin: t.origin,
        environment: t.environment,
        maxVus: t.maxVus,
        maxDurationSeconds: t.maxDurationSeconds,
      },
    });
    reply.code(201);
    return t;
  });

  app.delete('/api/load-targets/:id', async (req, reply) => {
    const { id } = parseInput(z.object({ id: z.uuid() }), req.params);
    const t = s.loadTargets.delete(id);
    if (!t) throw new HttpError(404, 'target_not_found', 'Load-test target not found.');
    s.audit.record({ actor: 'user', action: 'load_target_removed', details: { name: t.name } });
    reply.code(204);
  });
}
