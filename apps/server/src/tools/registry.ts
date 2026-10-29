import type { ToolCallStatus } from '@friday/shared';
import type { ToolCall, ToolDefinition } from '../providers/types.js';
import { WorkspaceError } from '../workspace/paths.js';
import { updatePlan } from './planTool.js';
import { decide } from './policy.js';
import { toToolDefinition, type ToolContext, type ToolSpec } from './types.js';
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
      this.tools.set(s.name, s as unknown as ToolSpec<unknown>);
    }
  }

  get(name: string): ToolSpec<unknown> | undefined {
    return this.tools.get(name);
  }

  /** Tools offered to the model: only those the policy allows, and project tools only with a project. */
  definitions(hasProject: boolean): ToolDefinition[] {
    return [...this.tools.values()]
      .filter((t) => (hasProject || !t.requiresProject) && decide(t.category).action === 'allow')
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

export interface ExecuteOptions {
  timeoutMs: number;
}

function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return {
    text: `${text.slice(0, max)}\n[output truncated at ${max} characters]`,
    truncated: true,
  };
}

/**
 * Validate and run one model-proposed tool call. Never throws: every failure becomes a result the
 * model can read, so it can correct itself. The policy check happens here, on the server, for
 * every call, regardless of what tools were advertised.
 */
export async function executeToolCall(
  registry: ToolRegistry,
  call: ToolCall,
  ctx: ToolContext,
  opts: ExecuteOptions,
): Promise<ToolExecution> {
  const started = Date.now();
  const spec = registry.get(call.name);
  const done = (
    status: ToolCallStatus,
    content: string,
    summary: string,
    extra: { truncated?: boolean; label?: string } = {},
  ): ToolExecution => {
    const { text, truncated } = truncate(ctx.redactor.redact(content), ctx.maxOutputChars);
    return {
      status,
      content: text,
      summary: ctx.redactor.redact(summary),
      label: extra.label ?? call.name,
      truncated: truncated || !!extra.truncated,
      durationMs: Date.now() - started,
      category: spec?.category ?? null,
    };
  };

  const policy = decide(spec?.category);
  if (!spec || policy.action !== 'allow') {
    const reason = policy.action === 'allow' ? 'Unknown tool.' : policy.reason;
    return done('denied', `Error: tool "${call.name}" is not available. ${reason}`, reason);
  }
  if (spec.requiresProject && !ctx.project) {
    return done(
      'denied',
      'Error: this conversation has no project, so workspace tools are unavailable.',
      'No project',
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(call.argumentsJson);
  } catch {
    return done(
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
    return done(
      'error',
      `Error: invalid arguments for ${spec.name}: ${issues}`,
      'Invalid arguments',
    );
  }
  const label = `${spec.name} ${spec.describeCall(parsed.data)}`.trim();

  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), opts.timeoutMs);
  const signal = AbortSignal.any([ctx.signal, timeout.signal]);
  try {
    const result = await Promise.race([
      spec.execute(parsed.data, { ...ctx, signal }),
      new Promise<never>((_, reject) =>
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
      ),
    ]);
    return done('completed', result.content, result.summary, {
      truncated: !!result.truncated,
      label,
    });
  } catch (err) {
    if (ctx.signal.aborted)
      return done('skipped', 'Tool execution was cancelled.', 'Cancelled', { label });
    if (timeout.signal.aborted) {
      return done(
        'error',
        `Error: ${spec.name} timed out after ${opts.timeoutMs} ms.`,
        'Timed out',
        { label },
      );
    }
    if (err instanceof WorkspaceError)
      return done('error', `Error: ${err.message}`, err.message, { label });
    // Unexpected failures: do not leak stack traces or host paths to the model.
    return done('error', `Error: ${spec.name} failed unexpectedly.`, 'Unexpected error', { label });
  } finally {
    clearTimeout(timer);
  }
}
