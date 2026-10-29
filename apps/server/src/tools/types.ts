import type { PermissionCategory, PlanStep, RiskLevel } from '@friday/shared';
import { z } from 'zod';
import type { ToolDefinition } from '../providers/types.js';
import type { ProjectRecord } from '../repositories/projects.js';
import type { Redactor } from '../security/redact.js';
import type { ToolEnvironment } from '../workspace/environment.js';

export interface ToolContext {
  /** The session's project (canonical root). Null for sessions without a project. */
  project: ProjectRecord | null;
  sessionId: string;
  runId: string;
  signal: AbortSignal;
  redactor: Redactor;
  env: ToolEnvironment;
  maxOutputChars: number;
  setPlan: (plan: PlanStep[]) => void;
}

export interface ToolOutput {
  /** Text returned to the model. Untrusted data from the workspace may appear here. */
  content: string;
  /** One-line, human-readable result for the activity timeline. */
  summary: string;
  truncated?: boolean;
}

export interface ToolSpec<A = unknown> {
  name: string;
  description: string;
  category: PermissionCategory;
  risk: RiskLevel;
  requiresProject: boolean;
  schema: z.ZodType<A>;
  /** Short label for the UI, e.g. "src/app.ts:1-120". */
  describeCall: (args: A) => string;
  execute: (args: A, ctx: ToolContext) => Promise<ToolOutput>;
}

export function defineTool<A>(spec: ToolSpec<A>): ToolSpec<A> {
  return spec;
}

/** Strip noise zod adds that some OpenAI-compatible backends reject or ignore. */
function cleanSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(cleanSchema);
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === '$schema') continue;
    if ((k === 'maximum' || k === 'minimum') && Math.abs(Number(v)) >= Number.MAX_SAFE_INTEGER)
      continue;
    out[k] = cleanSchema(v);
  }
  return out;
}

export function toToolDefinition(spec: ToolSpec<unknown>): ToolDefinition {
  return {
    name: spec.name,
    description: spec.description,
    parameters: cleanSchema(z.toJSONSchema(spec.schema, { io: 'input' })) as Record<
      string,
      unknown
    >,
  };
}
