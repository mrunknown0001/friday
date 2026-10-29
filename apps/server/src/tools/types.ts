import type {
  ApprovalDetails,
  DeploymentPlanDto,
  MemoryDto,
  PermissionCategory,
  PlanStep,
  RiskLevel,
} from '@friday/shared';
import { z } from 'zod';
import type { ImageInfo } from '../attachments/image.js';
import type { ToolDefinition } from '../providers/types.js';
import type { DeploymentPlanRepo, LogSourceRepo, SshHostRepo } from '../repositories/devops.js';
import type { ProposeInput, ProposeOutcome } from '../memory/service.js';
import type { CodeMap } from '../codemap/index.js';
import type { ProcessManager } from '../processes/manager.js';
import type { ProjectRecord } from '../repositories/projects.js';
import type { SshService } from '../ssh/ssh.js';
import type { Redactor } from '../security/redact.js';
import type { ToolEnvironment } from '../workspace/environment.js';

export interface ToolContext {
  /** The session's project (canonical root). Null for sessions without a project. */
  project: ProjectRecord | null;
  sessionId: string;
  runId: string;
  /** Id of the tool call being executed. */
  callId?: string;
  /** Names of tool calls issued earlier in the same model turn (their results were unseen). */
  earlierCallsThisTurn?: string[];
  signal: AbortSignal;
  redactor: Redactor;
  env: ToolEnvironment;
  maxOutputChars: number;
  setPlan: (plan: PlanStep[]) => void;
  /** Stream live output (e.g. a running command) to the UI. */
  emitOutput?: (chunk: string) => void;
  /** Memory access scoped to this session (absent when memory is unavailable). */
  memory?: MemoryContext;
  /** Store follow-up suggestions for the end of the run. */
  setNextSteps?: (steps: Array<{ label: string; prompt: string }>) => void;
  /** Show a recorded deployment plan to the user immediately. */
  emitDeploymentPlan?: (plan: DeploymentPlanDto) => void;
  /** DevOps configuration (SSH hosts, authorized log sources, deployment plans). */
  devops?: DevopsContext;
  /** Symbol index of the project (code_map, find_symbol). */
  codeMap?: CodeMap;
  /** Background processes (dev servers, watchers) started with start_process. */
  processes?: ProcessManager;
  /** Record an applied file change for the change list and undo. */
  recordFileChange?: (change: AppliedFileChange) => void;
  /**
   * Activate the task permission the user just approved (only available while applying an
   * approved request_task_permissions call). Returns its expiry.
   */
  grantTaskPermission?: (grant: {
    files: string[];
    commands: string[][];
    maxActions: number;
    minutes: number;
  }) => { expiresAt: string };
}

export interface MemoryContext {
  propose: (input: ProposeInput) => { memory: MemoryDto; outcome: ProposeOutcome };
  search: (query: string) => MemoryDto[];
  /** Expand an id prefix (as shown in the prompt) to a full id visible in this session. */
  resolveId: (prefix: string) => string;
}

export interface DevopsContext {
  hosts: SshHostRepo;
  ssh: SshService;
  logSources: LogSourceRepo;
  plans: DeploymentPlanRepo;
}

export interface AppliedFileChange {
  path: string;
  fromPath: string | null;
  change: 'create' | 'modify' | 'delete' | 'move';
  beforeContent: Buffer | null;
  beforeHash: string | null;
  afterHash: string | null;
}

/**
 * A fully computed, side-effect-free description of a protected action. `apply` performs exactly
 * this action and may only be called after the user approved it and the fingerprint was re-checked.
 */
export interface Proposal {
  title: string;
  summary: string;
  category: PermissionCategory;
  risk: RiskLevel;
  details: ApprovalDetails;
  /** Preconditions observed now (e.g. file hashes). Must be identical when re-checked. */
  fingerprint: string;
  /** Per-call execution timeout override (commands set their own). */
  timeoutMs?: number;
  /** Text the user must type to approve (production safeguard). Enforced server-side. */
  confirmationRequired?: string;
  /** Shorter approval validity for sensitive actions. */
  approvalTtlMs?: number;
  apply: (ctx: ToolContext) => Promise<ToolOutput>;
}

/** An image a tool returns for the model to look at (sent right after the tool results). */
export interface ToolImage {
  data: Buffer;
  info: ImageInfo;
  name: string;
}

export interface ToolOutput {
  /** Text returned to the model. Untrusted data from the workspace may appear here. */
  content: string;
  images?: ToolImage[];
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
  /** Read-only and agent-state tools run directly. */
  execute?: (args: A, ctx: ToolContext) => Promise<ToolOutput>;
  /** Protected tools describe their action first; it runs only after approval. */
  prepare?: (args: A, ctx: ToolContext) => Promise<Proposal>;
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
