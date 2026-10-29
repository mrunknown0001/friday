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
