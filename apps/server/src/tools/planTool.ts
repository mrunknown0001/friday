import { z } from 'zod';
import { defineTool } from './types.js';

export const updatePlan = defineTool({
  name: 'update_plan',
  description:
    'Publish or update the task plan shown to the user as a checklist. Use for multi-step work: send the full list each time, marking steps pending, in_progress, completed, or blocked. Keep steps short and concrete.',
  category: 'agent_state',
  risk: 'none',
  requiresProject: false,
  schema: z.object({
    steps: z
      .array(
        z.object({
          title: z.string().min(1).max(200),
          status: z.enum(['pending', 'in_progress', 'completed', 'blocked']),
        }),
      )
      .min(1)
      .max(20),
  }),
  describeCall: (a) => `${a.steps?.length ?? 0} steps`,
  async execute(args, ctx) {
    ctx.setPlan(args.steps);
    const done = args.steps.filter((s) => s.status === 'completed').length;
    return {
      content: 'Plan updated and shown to the user.',
      summary: `${done}/${args.steps.length} steps completed`,
    };
  },
});

export const suggestNextSteps = defineTool({
  name: 'suggest_next_steps',
  description:
    'Offer the user 1-3 likely follow-ups as one-click suggestions. Call it in the same message as your final answer (not as a separate step). Each needs a short label (max 40 characters) and the exact prompt the user would send. Only concrete, useful next actions; skip it if there are none. Friday also adds its own suggestions from what actually happened (e.g. failing tests), so do not repeat those.',
  category: 'agent_state',
  risk: 'none',
  requiresProject: false,
  schema: z.object({
    steps: z
      .array(z.object({ label: z.string().min(2).max(40), prompt: z.string().min(5).max(400) }))
      .min(1)
      .max(3),
  }),
  describeCall: (a) => `${a.steps?.length ?? 0} suggestions`,
  async execute(args, ctx) {
    ctx.setNextSteps?.(args.steps);
    return {
      content: 'Suggestions recorded.',
      summary: args.steps.map((s) => s.label).join(' · '),
    };
  },
});

export const suggestMode = defineTool({
  name: 'suggest_mode',
  description:
    'Offer the user a one-click switch to another mode when the request clearly fits it better: ask (questions, no changes), plan (agree on a plan before a large or risky change), debug (track down a bug or failure), code (implement). Call it at most once, in the same message as your final answer. It only shows a button; the mode changes only if the user clicks it.',
  category: 'agent_state',
  risk: 'none',
  requiresProject: false,
  schema: z.object({
    mode: z.enum(['code', 'plan', 'debug', 'ask']),
    reason: z.string().min(5).max(200).describe('Why this mode fits, in a few words.'),
  }),
  describeCall: (a) => `${a.mode ?? ''}`,
  async execute(args, ctx) {
    ctx.setModeSuggestion?.({ mode: args.mode, reason: args.reason });
    return { content: 'Suggestion recorded.', summary: `${args.mode}: ${args.reason}` };
  },
});
