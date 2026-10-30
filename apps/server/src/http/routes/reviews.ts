import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Services } from '../../services.js';
import { HttpError } from '../errors.js';
import { parseInput } from '../validation.js';

/** The user's decision on a review finding: dismiss it, restore it, or note a fix was asked for. */
export function registerReviewRoutes(app: FastifyInstance, s: Services) {
  app.patch('/api/reviews/:id/findings/:n', async (req) => {
    const { id, n } = parseInput(
      z.object({ id: z.uuid(), n: z.coerce.number().int().min(1).max(100) }),
      req.params,
    );
    const { status } = parseInput(
      z.object({ status: z.enum(['open', 'fix_requested', 'dismissed']) }),
      req.body,
    );
    const review = s.reviews.setStatus(id, n, status);
    if (!review) throw new HttpError(404, 'finding_not_found', 'Finding not found.');
    return review;
  });
}
