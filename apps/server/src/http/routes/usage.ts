import type { ModelPrice, UsageSummaryDto } from '@friday/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Services } from '../../services.js';
import { parseInput } from '../validation.js';

export const PRICES_SETTING = 'usage.prices';

const price = z.number().finite().min(0).max(10_000);
const pricesSchema = z
  .record(z.string().trim().min(1).max(200), z.object({ input: price, output: price }))
  .refine((p) => Object.keys(p).length <= 200, 'Too many models.');

/**
 * The usage view: tokens, calls and model time per day, model and conversation, from the provider
 * call records (metadata only). Cost is an estimate from prices the user enters; NoTokenLimit
 * reports no prices of its own.
 */
export function registerUsageRoutes(app: FastifyInstance, s: Services) {
  const prices = (): Record<string, ModelPrice> =>
    s.settings.get(PRICES_SETTING, pricesSchema) ?? {};

  app.get('/api/usage', async (req): Promise<UsageSummaryDto> => {
    const q = parseInput(
      z.object({
        days: z.coerce.number().int().min(1).max(365).default(30),
        // Minutes east of UTC; real offsets run from -12:00 to +14:00.
        tz: z.coerce.number().int().min(-720).max(840).default(0),
      }),
      req.query,
    );
    return s.usage.summary({ days: q.days, tzOffsetMinutes: q.tz, prices: prices() });
  });

  app.put('/api/usage/prices', async (req) => {
    const body = parseInput(z.object({ prices: pricesSchema }), req.body);
    if (Object.keys(body.prices).length) s.settings.set(PRICES_SETTING, body.prices);
    else s.settings.delete(PRICES_SETTING);
    return { prices: prices() };
  });
}
