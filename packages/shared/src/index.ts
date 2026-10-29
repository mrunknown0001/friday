// Type-only contract between the Friday server and web client.
// Keep this file free of runtime code so it can be imported with `import type`.

export type ProviderErrorKind =
  | 'not_configured'
  | 'auth'
  | 'permission'
  | 'rate_limit'
  | 'quota'
  | 'timeout'
  | 'network'
  | 'bad_request'
  | 'model_not_found'
  | 'unsupported'
  | 'server'
  | 'malformed'
  | 'cancelled'
  | 'unknown';

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    retryable?: boolean;
  };
}

export interface ModelInfo {
  id: string;
  name?: string;
  description?: string;
  tier?: string;
}

export type CapabilityState = 'unknown' | 'supported' | 'unsupported';

export interface ModelCapabilities {
  model: string;
  streaming: CapabilityState;
  toolCalling: CapabilityState;
  /** Context window in tokens. `contextWindowSource` says whether it was assumed or configured. */
  contextWindow: number;
  contextWindowSource: 'assumed' | 'configured';
  probedAt: string | null;
  notes: string | null;
}

export interface SettingsDto {
  model: string | null;
  modelSource: 'settings' | 'env' | 'none';
  apiKeyConfigured: boolean;
  /** Absolute path of the file the server reads NTL_* settings from. */
  envFile: string;
  baseUrl: string;
  timeoutMs: number;
  maxRetries: number;
}

export interface ConnectionTestResult {
  ok: boolean;
  model: string | null;
  latencyMs: number;
  modelListed: boolean | null;
  reply?: string;
  error?: { kind: ProviderErrorKind; message: string };
}

export interface ProviderCallDto {
  id: number;
  createdAt: string;
  model: string;
  operation: string;
  status: 'ok' | 'error' | 'cancelled';
  errorKind: ProviderErrorKind | null;
  durationMs: number;
  attempts: number;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface ProjectDto {
  id: string;
  name: string;
  rootPath: string;
  createdAt: string;
  lastOpenedAt: string | null;
  /** False if the folder no longer exists or is no longer a directory. */
  available: boolean;
}

export interface ProjectOverviewDto {
  project: ProjectDto;
  stack: string[];
  packageManagers: string[];
  manifests: string[];
  isGitRepo: boolean;
}

export interface TreeEntryDto {
  name: string;
  path: string;
  type: 'file' | 'dir' | 'symlink';
  size: number | null;
}

export interface FileViewDto {
  path: string;
  size: number;
  binary: boolean;
  tooLarge: boolean;
  content: string | null;
  language: string | null;
}

export interface SystemInfoDto {
  ripgrep: string | null;
  platform: string;
  node: string;
  agentLimits: AgentLimitsDto;
}

export interface AgentLimitsDto {
  maxIterations: number;
  maxToolCalls: number;
  maxToolOutputChars: number;
  toolTimeoutMs: number;
  maxConsecutiveToolFailures: number;
}

export type PermissionCategory =
  | 'read_only'
  | 'agent_state'
  | 'file_create'
  | 'file_modify'
  | 'file_delete'
  | 'shell'
  | 'network'
  | 'git'
  | 'remote'
  | 'database'
  | 'deployment'
  | 'task_permission';

export type RiskLevel = 'none' | 'low' | 'medium' | 'high' | 'critical';

export type ToolCallStatus = 'completed' | 'error' | 'denied' | 'skipped';

// ------------------------------------------------------------------ approvals (Phase 3)

export type ApprovalStatus =
  'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled' | 'executed' | 'failed' | 'stale';

export interface FileChangePreview {
  path: string;
  change: 'create' | 'modify' | 'delete' | 'move';
  fromPath?: string;
  /** Unified diff (empty for binary files). */
  diff: string;
  added: number;
  removed: number;
}

export type ApprovalDetails =
  | { kind: 'file_change'; changes: FileChangePreview[] }
  | {
      kind: 'command';
      /** Exact argument vector when no shell is involved. */
      argv: string[] | null;
      /** Exact shell script when shell interpretation is requested. */
      shellCommand: string | null;
      shell: boolean;
      cwd: string;
      host: 'local';
      timeoutSeconds: number;
      /** Names of environment variables passed to the process (values are not shown). */
      env: string[];
      network: boolean;
      riskReasons: string[];
    }
  | {
      kind: 'git';
      operation: 'commit' | 'create_branch';
      /** Current branch (null when HEAD is detached). */
      branch: string | null;
      head: string | null;
      message: string | null;
      newBranch: string | null;
      /** What the commit will contain. */
      files: FileChangePreview[];
      /** True if the repository has hooks that git will run (e.g. pre-commit). */
      hooks: string[];
    }
  | {
      kind: 'remote';
      host: {
        name: string;
        hostname: string;
        port: number;
        username: string;
        environment: HostEnvironment;
      };
      /** Exact command string executed by the remote user's shell. */
      command: string;
      /** For predefined diagnostics, the check name; null for free-form commands. */
      check: string | null;
      expectedImpact: string;
      downtime: string;
      rollback: string;
      verification: string;
      riskReasons: string[];
      timeoutSeconds: number;
    }
  | {
      kind: 'task_permissions';
      /** The task, step by step, as the agent describes it. */
      plan: string[];
      /** Project files that may be created or modified; entries ending in "/" cover a folder. */
      files: string[];
      /** Exact commands (argv, no shell) that may run in the project root. */
      commands: string[][];
      maxActions: number;
      minutes: number;
    };

export type HostEnvironment = 'development' | 'staging' | 'production';

export interface SshHostDto {
  id: string;
  name: string;
  hostname: string;
  port: number;
  username: string;
  /** Path to a private key file (its contents are never read by Friday), or null to use ssh-agent. */
  identityFile: string | null;
  environment: HostEnvironment;
  /** SHA256 fingerprints trusted for this host. Empty means untrusted: connections are refused. */
  trustedFingerprints: string[];
  createdAt: string;
}

export interface LogSourceDto {
  id: string;
  label: string;
  path: string;
  createdAt: string;
}

// ------------------------------------------------------------------ memory (Phase 6)

export type MemoryScope = 'user' | 'project' | 'session' | 'operational';

export type MemoryCategory =
  | 'preference'
  | 'architecture'
  | 'stack'
  | 'command'
  | 'environment'
  | 'deployment'
  | 'known_issue'
  | 'decision'
  | 'objective'
  | 'progress'
  | 'discovery'
  | 'rejected_approach'
  | 'blocker'
  | 'procedure'
  | 'lesson';

/** pending: proposed by the agent, waiting for the user (user-scope memories only). */
export type MemoryStatus = 'active' | 'pending' | 'superseded' | 'rejected';

export interface MemoryDto {
  id: string;
  scope: MemoryScope;
  category: MemoryCategory;
  content: string;
  projectId: string | null;
  sessionId: string | null;
  status: MemoryStatus;
  /** confirmed: verified by a tool result or stated by the user; assumed: inferred. */
  confidence: 'confirmed' | 'assumed';
  pinned: boolean;
  source: 'agent' | 'user';
  sourceRunId: string | null;
  supersedesId: string | null;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  useCount: number;
}

export interface MemorySettingsDto {
  enabled: boolean;
  disabledProjectIds: string[];
}

/** A memory as it was shown to the model for one run. */
export interface MemoryRef {
  id: string;
  scope: MemoryScope;
  category: MemoryCategory;
  content: string;
  /** Why it was included: pinned, an approved user preference, session context, or relevance. */
  reason: 'pinned' | 'preference' | 'session' | 'relevant';
}

export interface DeploymentStep {
  title: string;
  /** Exact command, if the step is a command. */
  command: string | null;
  /** "local", or the name of a configured SSH host. */
  where: string;
  risk: RiskLevel;
  causesDowntime: boolean;
  reversible: boolean;
  rollback: string | null;
}

export interface DeploymentPlanDto {
  id: string;
  sessionId: string;
  runId: string;
  toolCallId: string;
  title: string;
  environment: HostEnvironment;
  target: string;
  summary: string;
  preChecks: string[];
  steps: DeploymentStep[];
  verification: string[];
  rollbackPlan: string;
  dataLossRisk: string;
  downtimeEstimate: string;
  createdAt: string;
}

export interface ApprovalDto {
  id: string;
  sessionId: string;
  runId: string;
  projectId: string | null;
  toolCallId: string;
  toolName: string;
  category: PermissionCategory;
  risk: RiskLevel;
  title: string;
  /** What will happen, in one or two sentences. */
  summary: string;
  /** Why the agent says the action is needed. Model-written: treat as a claim, not a fact. */
  reason: string;
  details: ApprovalDetails;
  /** The client must echo this when approving, proving which exact action was reviewed. */
  actionHash: string;
  status: ApprovalStatus;
  decisionNote: string | null;
  resultSummary: string | null;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  /**
   * When set, approving requires typing this exact text (e.g. the production host name).
   * Enforced by the server, not just the UI.
   */
  confirmationRequired: string | null;
  /**
   * Set when this action was approved automatically because it fell within a task permission
   * the user approved: the id of that task-permission approval.
   */
  grantedBy: string | null;
}

/**
 * App-wide notices streamed from GET /api/events, for every conversation: only what is needed to
 * notify the user (titles are the same text the approval card shows).
 */
export type AppNotice =
  | {
      type: 'approval_requested';
      sessionId: string;
      runId: string;
      approvalId: string;
      title: string;
      risk: RiskLevel;
    }
  | {
      type: 'run_finished';
      sessionId: string;
      runId: string;
      status: RunStatus;
      durationMs: number | null;
    };

/** State of the task permission active in a run (see request_task_permissions). */
export interface TaskPermissionDto {
  /** The approval in which the user granted it. */
  approvalId: string;
  runId: string;
  files: string[];
  commands: string[][];
  maxActions: number;
  used: number;
  expiresAt: string;
  active: boolean;
  /** Why it is no longer active. */
  ended: 'revoked' | 'expired' | 'used_up' | 'replaced' | null;
}

export interface FileChangeDto {
  id: number;
  approvalId: string | null;
  sessionId: string | null;
  path: string;
  fromPath: string | null;
  change: 'create' | 'modify' | 'delete' | 'move';
  createdAt: string;
  revertedAt: string | null;
}

export interface PlanStep {
  title: string;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
}

/** Execution metadata for a tool result message. */
export interface ToolExecutionDto {
  callId: string;
  name: string;
  /** Model-supplied arguments (JSON text, truncated for display). */
  arguments: string;
  status: ToolCallStatus;
  summary: string;
  durationMs: number;
  truncated: boolean;
  approvalId: string | null;
}

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';
export type MessageStatus = 'complete' | 'partial' | 'cancelled' | 'error';

export interface MessageDto {
  id: number;
  sessionId: string;
  runId: string | null;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  model: string | null;
  createdAt: string;
  /** Assistant messages: tool calls the model requested. */
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  /** Tool messages: the call this result answers, plus execution metadata. */
  toolCallId?: string;
  tool?: ToolExecutionDto;
}

export type RunStatus =
  | 'running'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'blocked';

/** Why a run stopped without completing. Provider errors plus agent-loop safeguards. */
export type RunErrorKind =
  | ProviderErrorKind
  | 'limit_reached'
  | 'repeated_failures'
  | 'context_overflow'
  | 'approval_expired';

export interface RunCheckpoint {
  iteration: number;
  toolCalls: number;
  filesChanged: string[];
  lastCommand: { title: string; result: string } | null;
  plan: PlanStep[] | null;
  updatedAt: string;
}

export type VerificationStatus = 'verified' | 'failed' | 'unverified' | 'no_changes';

export interface RunReport {
  status: VerificationStatus;
  /** One-sentence explanation of the status, generated from records (not by the model). */
  note: string;
  files: Array<{
    path: string;
    change: 'create' | 'modify' | 'delete' | 'move';
    fromPath: string | null;
    reverted: boolean;
    /** The file no longer matches what Friday wrote (edited elsewhere afterwards). */
    modifiedSince: boolean;
  }>;
  commands: Array<{
    title: string;
    result: string;
    exitCode: number | null;
    /** Looks like a test, build, lint or type-check command. */
    verification: boolean;
    /** Ran after the last file change in this run. */
    afterLastChange: boolean;
  }>;
  commits: string[];
}

/** A suggested follow-up shown as a chip after a run. */
export interface NextStep {
  label: string;
  /** For action "prompt": the exact message sent when the chip is clicked. */
  prompt: string;
  action: 'prompt' | 'open_memory';
  /** records: derived by Friday from what actually happened; model: proposed by the model. */
  source: 'records' | 'model';
}

export interface RunDto {
  id: string;
  sessionId: string;
  status: RunStatus;
  model: string | null;
  errorKind: RunErrorKind | null;
  errorMessage: string | null;
  retryable: boolean;
  startedAt: string;
  finishedAt: string | null;
  checkpoint: RunCheckpoint | null;
  report: RunReport | null;
  suggestions: NextStep[] | null;
}

export interface SessionSummaryDto {
  id: string;
  projectId: string | null;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastRunStatus: RunStatus | null;
}

export interface SessionDetailDto extends SessionSummaryDto {
  messages: MessageDto[];
  latestRun: RunDto | null;
  hasSummary: boolean;
  plan: PlanStep[] | null;
  approvals: ApprovalDto[];
  /** Every run in the session, oldest first (for per-run reports). */
  runs: RunDto[];
  deploymentPlans: DeploymentPlanDto[];
  /** Memories shown to the model, per run id. */
  memoryUsage: Record<string, MemoryRef[]>;
}

export type RunPhase =
  | 'preparing'
  | 'compacting'
  | 'waiting_for_model'
  | 'streaming'
  | 'running_tool'
  | 'reading_results'
  | 'awaiting_approval';

/** Server-Sent Event payloads for a run. `seq` is also sent as the SSE `id`. */
export type RunEvent =
  | { seq: number; type: 'run_started'; runId: string; sessionId: string; model: string }
  | { seq: number; type: 'phase'; phase: RunPhase; detail?: string }
  | { seq: number; type: 'text_delta'; delta: string }
  | { seq: number; type: 'tool_started'; callId: string; name: string; arguments: string }
  | {
      seq: number;
      type: 'tool_finished';
      callId: string;
      name: string;
      status: ToolCallStatus;
      summary: string;
      durationMs: number;
    }
  | { seq: number; type: 'plan_updated'; plan: PlanStep[] }
  | { seq: number; type: 'approval_requested'; approval: ApprovalDto }
  | { seq: number; type: 'approval_resolved'; approval: ApprovalDto }
  | { seq: number; type: 'task_permission'; permission: TaskPermissionDto }
  | { seq: number; type: 'command_output'; callId: string; chunk: string }
  | { seq: number; type: 'deployment_plan'; plan: DeploymentPlanDto }
  | { seq: number; type: 'memories_used'; memories: MemoryRef[] }
  | { seq: number; type: 'memory_saved'; memory: MemoryDto }
  | { seq: number; type: 'message_saved'; message: MessageDto }
  | {
      seq: number;
      type: 'run_finished';
      run: RunDto;
    };
