import type { QuestionDto } from '@friday/shared';
import { z } from 'zod';
import { WorkspaceError } from '../workspace/paths.js';
import { defineTool } from './types.js';

/** Validity of a question is the configured approval TTL, which is at most a day. */
const MAX_WAIT_MS = 24 * 60 * 60_000 + 60_000;

export const askUser = defineTool({
  name: 'ask_user',
  description:
    'Ask the user 1-3 clarifying questions and wait for the answers. Use it when the request is ambiguous and the answer materially changes what you do (which of several approaches, scope, target environment, naming), and you cannot find the answer by reading the project. Do not use it for things you can look up, for permission (protected actions ask for approval themselves), or to confirm a plan you can just carry out. Each question offers 2-4 short options; the user can also answer in their own words or let you decide. Ask everything you need in one call.',
  category: 'agent_state',
  risk: 'none',
  requiresProject: false,
  timeoutMs: MAX_WAIT_MS,
  schema: z.object({
    questions: z
      .array(
        z.object({
          question: z.string().min(5).max(300).describe('The question, ending with "?".'),
          header: z
            .string()
            .max(24)
            .optional()
            .describe('A 1-3 word tag shown above the question, e.g. "Database".'),
          options: z
            .array(
              z.object({
                label: z.string().min(1).max(60),
                description: z.string().max(200).optional().describe('What choosing it means.'),
              }),
            )
            .min(2)
            .max(4),
          multi_select: z.boolean().default(false).describe('Several options may be chosen.'),
        }),
      )
      .min(1)
      .max(3),
  }),
  describeCall: (a) => a.questions?.[0]?.question ?? 'question',
  async execute(args, ctx) {
    if (!ctx.askUser) throw new WorkspaceError('unsupported', 'Questions are not available here.');
    const r = (s: string) => ctx.redactor.redact(s);
    const items = args.questions.map((q) => ({
      question: r(q.question),
      header: q.header?.trim() ? r(q.header.trim()) : null,
      // Duplicate labels could not be told apart in the answer.
      options: q.options
        .filter((o, i, all) => all.findIndex((x) => x.label === o.label) === i)
        .map((o) => ({ label: r(o.label), description: o.description ? r(o.description) : null })),
      multiSelect: q.multi_select,
    }));
    const result = await ctx.askUser(items);
    switch (result.outcome) {
      case 'answered':
        return {
          content: `The user answered (their answers, not tool output):\n${formatAnswers(result.question)}\nContinue with these answers.`,
          summary: 'answered',
        };
      case 'skipped':
        return {
          content:
            'The user skipped the questions and left the choice to you. Pick sensible defaults, say in one line which assumptions you made, and continue.',
          summary: 'skipped: Friday decides',
        };
      case 'expired':
        return {
          content:
            'The user did not answer in time. Do not guess what you asked: end your turn with a short message that restates the question so the user can answer it.',
          summary: 'no answer',
        };
      default:
        throw new WorkspaceError('unsupported', 'The run was cancelled before an answer.');
    }
  },
});

export function formatAnswers(q: QuestionDto): string {
  return q.questions
    .map((item, i) => {
      const a = q.answers?.[i];
      const parts = [
        ...(a?.selected ?? []),
        ...(a?.text ? [`"${a.text.replaceAll('\n', ' ')}"`] : []),
      ];
      return `${i + 1}. ${item.question}\n   Answer: ${parts.join('; ') || '(none)'}`;
    })
    .join('\n');
}
