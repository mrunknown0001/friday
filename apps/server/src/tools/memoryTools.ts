import { z } from 'zod';
import { MEMORY_CATEGORIES, MemoryError } from '../memory/service.js';
import { WorkspaceError } from '../workspace/paths.js';
import { defineTool } from './types.js';

/** Tools whose results are not evidence about the project. */
const NON_EVIDENCE = new Set(['remember', 'search_memory', 'update_plan']);

export const remember = defineTool({
  name: 'remember',
  description:
    'Save one durable, useful fact for future conversations. Scopes: "project" (architecture, stack, build/test commands, decisions and why, known issues; needs a project), "operational" (troubleshooting or deployment procedures and lessons that worked), "session" (this conversation\'s objective, progress, rejected approaches, blockers), "user" (the user\'s long-term preferences; the user must approve these). Only facts likely to matter later; never secrets, credentials or code. Use replaces_id (the id in brackets from the Memory section) to correct an outdated memory.',
  category: 'agent_state',
  risk: 'none',
  requiresProject: false,
  schema: z.object({
    scope: z.enum(['user', 'project', 'session', 'operational']),
    category: z.enum(MEMORY_CATEGORIES),
    content: z.string().min(1).max(1_000).describe('One fact, in a sentence or two.'),
    confidence: z
      .enum(['confirmed', 'assumed'])
      .describe(
        '"confirmed" if verified by a tool result or stated by the user; otherwise "assumed".',
      ),
    replaces_id: z.string().min(8).max(64).optional(),
  }),
  describeCall: (a) => `${a.scope}/${a.category}`,
  async execute(args, ctx) {
    if (!ctx.memory) throw new WorkspaceError('unsupported', 'Memory is not available here.');
    // A fact about the project cannot be "confirmed" by results the model has not seen yet: tool
    // calls issued in the same turn run before their results are returned.
    const unseen = (ctx.earlierCallsThisTurn ?? []).filter((n) => !NON_EVIDENCE.has(n));
    if (
      args.confidence === 'confirmed' &&
      (args.scope === 'project' || args.scope === 'operational') &&
      unseen.length
    ) {
      throw new WorkspaceError(
        'unsupported',
        `Not saved: remember was called in the same step as ${[...new Set(unseen)].join(', ')}, before those results were available, so this cannot be confirmed. Check the results, then call remember again (or save it as "assumed").`,
      );
    }
    try {
      const replacesId = args.replaces_id ? ctx.memory.resolveId(args.replaces_id) : undefined;
      const { memory, outcome } = ctx.memory.propose({
        scope: args.scope,
        category: args.category,
        content: args.content,
        confidence: args.confidence,
        replacesId,
      });
      const result = {
        created: `Saved ${memory.scope} memory [${memory.id.slice(0, 8)}].`,
        pending: `Proposed user memory [${memory.id.slice(0, 8)}]; it takes effect once the user approves it.`,
        duplicate: `Already remembered as [${memory.id.slice(0, 8)}]; no new memory created.`,
        replaced: `Saved [${memory.id.slice(0, 8)}], replacing the outdated memory.`,
      }[outcome];
      return { content: result, summary: `${outcome}: ${memory.content.slice(0, 80)}` };
    } catch (err) {
      if (err instanceof MemoryError)
        throw new WorkspaceError('unsupported', `Not saved: ${err.message}`);
      throw err;
    }
  },
});

export const searchMemory = defineTool({
  name: 'search_memory',
  description:
    'Search saved memories visible in this conversation (your preferences, this project, this session, operational notes) by keywords. Relevant ones are already listed in the system prompt; use this to look further.',
  category: 'read_only',
  risk: 'none',
  requiresProject: false,
  schema: z.object({ query: z.string().min(2).max(300) }),
  describeCall: (a) => `"${a.query}"`,
  async execute(args, ctx) {
    if (!ctx.memory) throw new WorkspaceError('unsupported', 'Memory is not available here.');
    const hits = ctx.memory.search(args.query);
    if (!hits.length)
      return { content: `No memories match "${args.query}".`, summary: 'no matches' };
    return {
      content: hits
        .map(
          (m) => `- [${m.id.slice(0, 8)}] (${m.scope}/${m.category}, ${m.confidence}) ${m.content}`,
        )
        .join('\n'),
      summary: `${hits.length} memories`,
    };
  },
});
