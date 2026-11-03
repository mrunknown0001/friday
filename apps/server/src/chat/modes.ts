import type { AgentMode, PermissionCategory } from '@friday/shared';

export const AGENT_MODES = ['auto', 'code', 'plan', 'debug', 'ask'] as const satisfies AgentMode[];

/**
 * Tool categories ask and plan mode may use: reading, the web, Friday's own state (plan, questions,
 * memory) and read-only database queries (each still approved). Editing, commands, git writes,
 * remote hosts, browsers, load tests and connected apps are not offered, and refused if called.
 */
const READING: ReadonlySet<PermissionCategory> = new Set([
  'read_only',
  'network',
  'agent_state',
  'database',
]);

export function readsOnly(mode: AgentMode): boolean {
  return mode === 'ask' || mode === 'plan';
}

/** Whether a tool of this category may run in the mode. */
export function modeAllows(mode: AgentMode, category: PermissionCategory | undefined): boolean {
  return !readsOnly(mode) || (category !== undefined && READING.has(category));
}

/** Tools only some modes have. */
export function modeOffers(mode: AgentMode, tool: string): boolean {
  // Suggesting a mode only makes sense when Friday chose the approach itself.
  if (tool === 'suggest_mode') return mode === 'auto';
  // Asking for a bundle of edit and command permissions is for modes that change things.
  if (tool === 'request_task_permissions') return !readsOnly(mode);
  return true;
}

export const MODE_LABEL: Record<AgentMode, string> = {
  auto: 'Auto',
  code: 'Code',
  plan: 'Plan',
  debug: 'Debug',
  ask: 'Ask',
};

/** The system prompt's section for the mode; auto has none (Friday chooses, as before). */
export function modePrompt(mode: AgentMode): string | null {
  switch (mode) {
    case 'auto':
      return `## Mode: auto
Choose the approach from the request. When it clearly fits a dedicated mode better (a question that needs no changes: ask; a large or risky change that should be agreed first: plan; a bug or failure to track down: debug), you may call suggest_mode once in your final message. The user decides; carry on with the request either way.`;
    case 'ask':
      return `## Mode: ask
This overrides the workflow above: the user wants answers and explanations, not changes. Read, search and explain, citing path:line. You have only read-only tools and cannot edit files, run commands or commit in this mode. If the user asks for a change, do not attempt it and do not say you are making it: say exactly what you would change (files and lines), and that switching to Code mode will do it. Never write tool calls as text.`;
    case 'plan':
      return `## Mode: plan
This overrides the workflow above: investigate and plan, and change nothing (you have only read-only tools). Read what the change touches first. Then publish the plan with update_plan (every step pending) and explain it: the approach, the files and why, risks, how it will be verified, and anything the user must decide (ask with ask_user if it changes the plan). Do not start the work: end by saying the user can accept the plan to have it built, or ask for changes.`;
    case 'code':
      return `## Mode: code
Implement what the user asks. Read the relevant code first, make focused changes that match the project's style, and verify them (run the tests, type-check or build the project uses) before you say it is done. If a plan is already in this conversation, follow it and keep its steps up to date with update_plan.`;
    case 'debug':
      return `## Mode: debug
Find and fix the cause of a problem, in this order:
1. Reproduce it first: run the failing test, command or request and quote the actual failure. If you cannot reproduce it, say so and what you tried before changing anything.
2. Find the root cause with evidence (the code path, values, logs), not a guess. Say what the cause is before fixing it.
3. Make the smallest fix for that cause; do not refactor along the way.
4. Run the reproduction again and show it now passes; add a regression test when the project has tests.`;
  }
}
