import type { z } from 'zod';
import { HttpError } from './errors.js';

export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input ?? {});
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
      .join('; ');
    throw new HttpError(400, 'invalid_request', detail);
  }
  return result.data;
}
