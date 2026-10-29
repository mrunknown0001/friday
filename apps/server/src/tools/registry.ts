import type { ToolCallStatus } from '@friday/shared';
import type { ToolCall, ToolDefinition } from '../providers/types.js';
import { WorkspaceError } from '../workspace/paths.js';
import { runCommand } from './commandTool.js';
import { deleteFile, editFile, editFiles, moveFile, writeFile } from './fileTools.js';
import {
  gitBranches,
  gitCommit,
  gitCreateBranch,
  gitDiff,
  gitLog,
  gitShow,
  gitStatus,
} from './gitTools.js';
import { updatePlan } from './planTool.js';
import { decide, type PolicyDecision } from './policy.js';
import { toToolDefinition, type ToolContext, type ToolOutput, type ToolSpec } from './types.js';
import {
  fileInfo,
  findFiles,
  inspectProject,
  listDirectory,
  readFile,
  searchCode,
} from './workspaceTools.js';

export class ToolRegistry {
  private readonly tools = new Map<string, ToolSpec<unknown>>();

  constructor(specs: Array<ToolSpec<never>> = DEFAULT_TOOLS) {
    for (const s of specs) {
      if (this.tools.has(s.name)) throw new Error(`Duplicate tool ${s.name}`);
      const direct = s.category === 'read_only' || s.category === 'agent_state';
      // Protected tools must go through prepare() so nothing can run before approval.
      if (direct ? !s.execute : !s.prepare || s.execute) {
        throw new Error(
          `Tool ${s.name}: ${direct ? 'execute' : 'prepare (and no execute)'} is required`,
        );
      }
      this.tools.set(s.name, s as unknown as ToolSpec<unknown>);
    }
  }

  get(name: string): ToolSpec<unknown> | undefined {
    return this.tools.get(name);
  }

  /** Tools offered to the model: not denied by policy, and project tools only with a project. */
  definitions(hasProject: boolean): ToolDefinition[] {
    return [...this.tools.values()]
      .filter((t) => (hasProject || !t.requiresProject) && decide(t.category).action !== 'deny')
      .map(toToolDefinition);
  }
}

export const DEFAULT_TOOLS = [
  inspectProject,
  listDirectory,
  readFile,
  fileInfo,
  searchCode,
  findFiles,
  updatePlan,
  writeFile,
  editFile,
  editFiles,
  deleteFile,
  moveFile,
  runCommand,
  gitStatus,
  gitDiff,
  gitLog,
  gitShow,
  gitBranches,
  gitCommit,
  gitCreateBranch,
] as unknown as Array<ToolSpec<never>>;

export interface ToolExecution {
  status: ToolCallStatus;
  /** Returned to the model as the tool result. */
  content: string;
  summary: string;
  label: string;
  truncated: boolean;
  durationMs: number;
  category: ToolSpec['category'] | null;
}

function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return {
    text: `${text.slice(0, max)}\n[output truncated at ${max} characters]`,
    truncated: true,
  };
}

/** Build a ToolExecution with redaction and output limits applied. */
export function makeExecution(
  ctx: ToolContext,
  call: ToolCall,
  started: number,
  category: ToolSpec['category'] | null,
  status: ToolCallStatus,
  content: string,
  summary: string,
  extra: { truncated?: boolean; label?: string } = {},
): ToolExecution {
  const { text, truncated } = truncate(ctx.redactor.redact(content), ctx.maxOutputChars);
  return {
    status,
    content: text,
    summary: ctx.redactor.redact(summary),
    label: extra.label ?? call.name,
    truncated: truncated || !!extra.truncated,
    durationMs: Date.now() - started,
    category,
  };
}

export type ValidatedCall =
  | { ok: true; spec: ToolSpec<unknown>; args: unknown; label: string; policy: PolicyDecision }
  | { ok: false; execution: ToolExecution };

/** Policy check, JSON parse, and schema validation. Never throws. */
export function validateToolCall(
  registry: ToolRegistry,
  call: ToolCall,
  ctx: ToolContext,
): ValidatedCall {
  const started = Date.now();
  const spec = registry.get(call.name);
  const fail = (status: ToolCallStatus, content: string, summary: string) => ({
    ok: false as const,
    execution: makeExecution(ctx, call, started, spec?.category ?? null, status, content, summary),
  });

  const policy = decide(spec?.category);
  if (!spec || policy.action === 'deny') {
    const reason = policy.action === 'deny' ? policy.reason : 'Unknown tool.';
    return fail('denied', `Error: tool "${call.name}" is not available. ${reason}`, reason);
  }
  if (spec.requiresProject && !ctx.project) {
    return fail(
      'denied',
      'Error: this conversation has no project, so workspace tools are unavailable.',
      'No project',
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(call.argumentsJson);
  } catch {
    return fail(
      'error',
      'Error: tool arguments were not valid JSON. Send a JSON object matching the schema.',
      'Invalid JSON arguments',
    );
  }
  const parsed = spec.schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return fail(
      'error',
      `Error: invalid arguments for ${spec.name}: ${issues}`,
      'Invalid arguments',
    );
  }
  return {
    ok: true,
    spec,
    args: parsed.data,
    label: `${spec.name} ${spec.describeCall(parsed.data)}`.trim(),
    policy,
  };
}

/**
 * Run tool code with a timeout and the run's cancellation signal. Failures become results the
 * model can read; unexpected errors are reported without stack traces or host details.
 */
export async function runGuarded(
  fn: (ctx: ToolContext) => Promise<ToolOutput>,
  call: ToolCall,
  spec: ToolSpec<unknown>,
  label: string,
  ctx: ToolContext,
  timeoutMs: number,
): Promise<ToolExecution> {
  const started = Date.now();
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  const signal = AbortSignal.any([ctx.signal, timeout.signal]);
  const done = (status: ToolCallStatus, content: string, summary: string, truncated = false) =>
    makeExecution(ctx, call, started, spec.category, status, content, summary, {
      truncated,
      label,
    });
  try {
    const result = await Promise.race([
      fn({ ...ctx, signal }),
      new Promise<never>((_, reject) =>
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
      ),
    ]);
    return done('completed', result.content, result.summary, !!result.truncated);
  } catch (err) {
    if (ctx.signal.aborted) return done('skipped', 'Tool execution was cancelled.', 'Cancelled');
    if (timeout.signal.aborted)
      return done('error', `Error: ${spec.name} timed out after ${timeoutMs} ms.`, 'Timed out');
    if (err instanceof WorkspaceError) return done('error', `Error: ${err.message}`, err.message);
    return done('error', `Error: ${spec.name} failed unexpectedly.`, 'Unexpected error');
  } finally {
    clearTimeout(timer);
  }
}

export interface ExecuteOptions {
  timeoutMs: number;
}

/**
 * Validate and run a tool call that needs no approval. Protected tools are refused here: they
 * only run through the agent loop's approval flow.
 */
export async function executeToolCall(
  registry: ToolRegistry,
  call: ToolCall,
  ctx: ToolContext,
  opts: ExecuteOptions,
): Promise<ToolExecution> {
  const v = validateToolCall(registry, call, ctx);
  if (!v.ok) return v.execution;
  if (v.policy.action !== 'allow' || !v.spec.execute) {
    return makeExecution(
      ctx,
      call,
      Date.now(),
      v.spec.category,
      'denied',
      `Error: ${call.name} requires the user's approval.`,
      'Requires approval',
      { label: v.label },
    );
  }
  const execute = v.spec.execute;
  return runGuarded((c) => execute(v.args, c), call, v.spec, v.label, ctx, opts.timeoutMs);
}
