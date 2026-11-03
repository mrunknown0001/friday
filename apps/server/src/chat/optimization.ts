import type { TokenOptimization } from '@friday/shared';
import { z } from 'zod';
import type { SettingsRepo } from '../repositories/settings.js';

/**
 * Token optimization (Settings → Usage): "standard" unless the user turns it off. Standard offers
 * the core tools plus the groups the conversation loaded (tools/groups.ts), shrinks settled tool
 * results and caps the context (chat/context.ts). Off sends every tool and the full history up
 * to the model's window, as before.
 */
export const OPTIMIZATION_SETTING = 'usage.optimization';
export const optimizationSchema = z.enum(['standard', 'off']);

export function tokenOptimization(settings: SettingsRepo): TokenOptimization {
  return settings.get(OPTIMIZATION_SETTING, optimizationSchema) ?? 'standard';
}
