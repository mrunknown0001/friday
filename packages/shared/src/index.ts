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
  /** Whether the model accepts images (attachments, view_image). */
  imageInput: CapabilityState;
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
  /** The provider reported no token counts; these are Friday's estimate. */
  tokensEstimated: boolean;
}

/** A user-entered price for a model, in US dollars per million tokens. */
export interface ModelPrice {
  input: number;
  output: number;
}

export interface UsageTotals {
  /** Model requests (chat, summaries, probes, connection tests); model listings are not counted. */
  calls: number;
  errors: number;
  /** Calls whose token counts are Friday's estimate (the provider reported none). */
  estimatedCalls: number;
  /** Calls with no token counts at all: failed ones, and those recorded before Friday estimated. */
  callsWithoutTokens: number;
  inputTokens: number;
  outputTokens: number;
  /** Time spent waiting for the model. */
  durationMs: number;
  /** Estimated from the prices entered in Settings; null when none of the calls has a price. */
  cost: number | null;
}

export interface UsageSummaryDto {
  days: number;
  /** Start of the range (UTC), the local midnight `days - 1` days ago. */
  since: string;
  totals: UsageTotals;
  /** One entry per local day in the range, oldest first, including days without calls. */
  byDay: Array<UsageTotals & { day: string }>;
  byModel: Array<UsageTotals & { model: string }>;
  /** The conversations that used the most tokens, at most 20. */
  bySession: Array<UsageTotals & { sessionId: string; title: string | null; deleted: boolean }>;
  /** Calls made outside a conversation: capability probes and connection tests. */
  outsideSessions: UsageTotals;
  prices: Record<string, ModelPrice>;
}

export interface ProjectDto {
  id: string;
  name: string;
  rootPath: string;
  createdAt: string;
  lastOpenedAt: string | null;
  /** False if the folder no longer exists or is no longer a directory. */
  available: boolean;
  /** Where run_command executes for this project; null = on this machine. */
  sandbox: SandboxSettings | null;
  /** Set when this project is a git worktree Friday made for one task. */
  worktree: WorktreeInfo | null;
}

/** A git worktree for one task: its own folder and branch, made from the parent project's HEAD. */
export interface WorktreeInfo {
  parentId: string;
  branch: string;
  /** The commit it started from, and the branch the parent was on then (null if detached). */
  base: string;
  baseBranch: string | null;
  /** Dependency folders symlinked from the parent checkout (node_modules, vendor, .venv). */
  linked: string[];
  status: 'active' | 'accepted' | 'discarded';
  outcome: {
    mode: 'merge' | 'squash' | 'branch' | 'discard';
    /** Merge: the branch it went into. Branch: the branch kept. */
    branch: string | null;
    /** The resulting commit (merge or squash), or the branch's last commit. */
    commit: string | null;
    at: string;
  } | null;
  createdAt: string;
}

/** What accepting or discarding a worktree would do, for the dialogs. */
export interface WorktreeStatusDto {
  project: ProjectDto;
  /** Commits on the worktree branch since it started, newest first. */
  commits: Array<{ sha: string; subject: string }>;
  /** Files changed in the worktree but not committed yet (committed automatically on accept). */
  uncommitted: Array<{ path: string; status: string }>;
  /** The parent checkout: its current branch, and whether it has uncommitted changes to tracked files. */
  target: { branch: string | null; head: string | null; dirty: string[] };
  /** False while a task in this worktree is still running. */
  idle: boolean;
}

/** Run a project's commands in a throwaway Docker container instead of on this machine. */
export interface SandboxSettings {
  enabled: boolean;
  /** Docker image, e.g. "node:22-bookworm-slim". Must already be present locally. */
  image: string;
  /** "none": no network at all (default); "bridge": Docker's default outbound network. */
  network: 'none' | 'bridge';
}

export interface SandboxStatusDto {
  /** Docker server version, or null if Docker is not reachable. */
  docker: string | null;
  /** Image suggested for the project's stack. */
  suggestedImage: string;
  /** Whether the configured (or suggested) image is present locally. */
  imagePresent: boolean | null;
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
  | 'task_permission'
  | 'process_control'
  /** A tool of a connected MCP server: asks every time. */
  | 'mcp'
  /** An MCP tool the user allowed to run without asking. */
  | 'mcp_trusted';

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
      /** Set when the command runs in the project's container instead of on this machine. */
      sandbox: {
        image: string;
        network: 'none' | 'bridge';
        /** Credential files and folders hidden inside the container. */
        hiddenCredentials: number;
        /** .git is mounted read-only, so nothing in the container can plant git hooks. */
        gitReadOnly: boolean;
        /** Container ports published on 127.0.0.1 (background processes only). */
        ports?: number[];
      } | null;
      /** Set when the command keeps running in the background until stopped (start_process). */
      background?: { name: string } | null;
      /** Set for run_tests: what is tested, and what Friday does around the command. */
      tests?: TestCommandInfo | null;
    }
  | {
      kind: 'document';
      path: string;
      format: 'pdf' | 'docx' | 'xlsx' | 'pptx';
      change: 'create' | 'modify';
      title: string;
      /** What is inside: headings, sheets with their size, or slide titles. */
      outline: string[];
    }
  | {
      kind: 'mcp';
      /** Server name and URL as the user configured them. */
      server: string;
      serverUrl: string;
      tool: string;
      title: string | null;
      description: string;
      /** The exact arguments, pretty-printed JSON. */
      arguments: string;
      readOnly: boolean | null;
      destructive: boolean | null;
      openWorld: boolean | null;
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
      /** Pushing a branch, and optionally opening a pull request for it. */
      kind: 'git_remote';
      operation: 'push' | 'pull_request';
      remote: string;
      /** Where the push goes, with any user name or password removed. */
      remoteUrl: string;
      /** Local branch, pushed to the remote branch of the same name. */
      branch: string;
      head: string;
      /** The remote branch as last fetched; null when it is not on the remote yet. */
      remoteHead: string | null;
      /** False when the remote branch already has every commit (a pull request only). */
      needsPush: boolean;
      /** Commits the remote does not have yet, newest first (at most 50). */
      commits: Array<{ sha: string; subject: string }>;
      commitCount: number;
      /** pre-push hooks git will run. */
      hooks: string[];
      pullRequest: {
        /** OWNER/REPO, or HOST/OWNER/REPO off github.com. */
        repo: string;
        base: string;
        title: string;
        /** The exact description, including the verification section Friday adds. */
        body: string;
        draft: boolean;
      } | null;
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
    }
  | { type: 'process_updated'; process: ProcessDto }
  | { type: 'mcp_updated'; serverId: string };

/** How Friday may use one tool of a connected MCP server. */
export type McpToolPolicy = 'ask' | 'allow' | 'off';

export interface McpToolDto {
  name: string;
  title: string | null;
  description: string;
  /** The server's own hints (not guarantees). */
  readOnly: boolean | null;
  destructive: boolean | null;
  policy: McpToolPolicy;
}

/** A remote MCP server (an app) the user connected in Settings. */
export interface McpServerDto {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  /** connected: tools usable; needs_auth: sign in first; error: see `error`. */
  status: 'connected' | 'needs_auth' | 'error' | 'disconnected';
  error: string | null;
  /** Signed in with OAuth (tokens stored on this machine). */
  signedIn: boolean;
  /** A static access token was configured instead of OAuth. */
  hasToken: boolean;
  tools: McpToolDto[];
  toolsRefreshedAt: string | null;
  createdAt: string;
}

/** Code map index of a project (Project settings). */
export interface CodeMapStatusDto {
  files: number;
  symbols: number;
  /** Last refresh in this server run (null until the code map is first used after a start). */
  lastRefresh: { at: string; durationMs: number; truncated: boolean } | null;
}

/** A background process (dev server, watcher) Friday started with the user's approval. */
export interface ProcessDto {
  /** Short id the model and the API use, e.g. "proc_1a2b3c4d". */
  id: string;
  projectId: string;
  /** Conversation that started it. */
  sessionId: string;
  name: string;
  /** The command as shown on the approval card. */
  command: string;
  cwd: string;
  sandbox: { image: string; network: 'none' | 'bridge'; ports: number[] } | null;
  status: 'running' | 'stopping' | 'stopped' | 'exited';
  exitCode: number | null;
  signal: string | null;
  /** Why it could not start (e.g. command not found). */
  error: string | null;
  /** Who stopped it; null when it exited by itself. */
  stoppedBy: 'user' | 'friday' | 'shutdown' | null;
  /** Local URLs seen in its output (e.g. a dev server's address). */
  urls: string[];
  startedAt: string;
  endedAt: string | null;
}

export interface ProcessOutputDto {
  process: ProcessDto;
  output: string;
  /** Pass back as `since` to get only newer output. */
  cursor: number;
  /** True when older output was discarded (only the most recent output is kept). */
  dropped: boolean;
}

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
  /** Images attached to a user message, or returned by view_image. */
  attachments?: AttachmentDto[];
}

/** An image the user attached (or view_image loaded). The bytes are at /api/attachments/:id. */
export interface AttachmentDto {
  id: string;
  name: string | null;
  mime: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  size: number;
  width: number;
  height: number;
  createdAt: string;
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
  /** Screenshots compared before and after a change (absent in reports saved before this). */
  visuals?: VisualComparison[];
}

/** A page captured before and after a change, with the difference highlighted. */
export interface VisualComparison {
  url: string;
  width: number;
  height: number;
  fullPage: boolean;
  before: AttachmentDto;
  after: AttachmentDto;
  /** Null when nothing visible changed. */
  diff: AttachmentDto | null;
  /** Share of pixels that changed, 0–1. */
  changedRatio: number;
  /** Number of separate changed areas. */
  regions: number;
  createdAt: string;
}

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'nit';

/** What a code review looked at. */
export interface ReviewTarget {
  kind: 'uncommitted' | 'branch' | 'pull_request' | 'other';
  /** e.g. "uncommitted changes", "feature-x against main", "pull request #12". */
  label: string;
  base: string | null;
  head: string | null;
  /** The pull request's page, for pull requests. */
  url: string | null;
}

export interface ReviewFinding {
  /** 1-based, in the order shown (most severe first). */
  n: number;
  severity: FindingSeverity;
  title: string;
  file: string;
  line: number | null;
  /** Model-written: why this is a problem, with the concrete failure. */
  reason: string;
  /** An exact edit: replace old_text (copied from the file) with new_text. */
  suggestion: { oldText: string; newText: string; applies: boolean | null } | null;
  /** A described fix, when there is no exact edit. */
  fix: string | null;
  /**
   * Checked by Friday: the line is inside the reviewed change, elsewhere in the file, or the file
   * or line does not exist ("unchecked" when it could not be checked).
   */
  location: 'in_change' | 'outside_change' | 'not_found' | 'unchecked';
  status: 'open' | 'fix_requested' | 'dismissed';
}

export type TestFramework = 'vitest' | 'jest' | 'node' | 'pytest' | 'go';

/** What a run_tests approval covers beyond the command itself. */
export interface TestCommandInfo {
  framework: TestFramework;
  /** The suite's folder, relative to the project root. */
  suite: string;
  scope: 'changed' | 'files' | 'all';
  /** Changed files the related tests are chosen for (scope "changed"). */
  changedFiles: string[];
  /** Test files run (when Friday chose or was given them). */
  testFiles: string[];
  nameFilter: string | null;
  coverage: boolean;
  /** Failed tests are run once more, the same way, to tell flaky tests from real failures. */
  retryFailures: boolean;
}

export interface TestLocation {
  file: string;
  line: number | null;
}

export interface TestFailure {
  /** File and full name, e.g. "src/cart.test.ts › total › adds tax". */
  name: string;
  file: string | null;
  /** First lines of the error, without the stack. */
  message: string;
  /** First project location in the error's stack (often the code under test). */
  at: TestLocation | null;
  /** Failed in an earlier run too (the same test, any code). */
  failedBefore: number;
}

export interface TestTiming {
  name: string;
  file: string | null;
  durationMs: number;
  /** Median of this test's earlier passing runs. */
  usualMs: number | null;
}

export interface FlakyTest {
  name: string;
  file: string | null;
  /** Why it is considered flaky. */
  evidence: 'passed_on_retry' | 'mixed_on_same_code';
  detail: string;
}

export interface ChangedLineCoverage {
  file: string;
  /** Executable changed lines, and how many of them ran. */
  lines: number;
  covered: number;
  /** Changed lines that never ran, as ranges. */
  uncovered: Array<[number, number]>;
  /** The file was not loaded by the tests at all. */
  notLoaded: boolean;
}

export interface TestRunDto {
  id: string;
  sessionId: string | null;
  runId: string;
  toolCallId: string;
  projectId: string;
  suite: string;
  framework: TestFramework;
  scope: TestCommandInfo['scope'];
  command: string;
  status: 'passed' | 'failed' | 'error';
  exitCode: number | null;
  durationMs: number;
  counts: { passed: number; failed: number; skipped: number; flaky: number };
  /** Set when the command failed before any test ran (e.g. a syntax error or bad config). */
  error: string | null;
  failures: TestFailure[];
  flaky: FlakyTest[];
  slowest: TestTiming[];
  /** Null when coverage was not requested; `available: false` when it could not be measured. */
  coverage: { available: boolean; note: string | null; files: ChangedLineCoverage[] } | null;
  createdAt: string;
}

export interface ReviewDto {
  id: string;
  sessionId: string;
  runId: string;
  toolCallId: string;
  target: ReviewTarget;
  summary: string;
  findings: ReviewFinding[];
  createdAt: string;
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
  reviews: ReviewDto[];
  testRuns: TestRunDto[];
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
      /** Images the tool produced (screenshot, view_image), shown right away. */
      attachments?: AttachmentDto[];
    }
  | { seq: number; type: 'plan_updated'; plan: PlanStep[] }
  | { seq: number; type: 'approval_requested'; approval: ApprovalDto }
  | { seq: number; type: 'approval_resolved'; approval: ApprovalDto }
  | { seq: number; type: 'task_permission'; permission: TaskPermissionDto }
  | { seq: number; type: 'command_output'; callId: string; chunk: string }
  | { seq: number; type: 'deployment_plan'; plan: DeploymentPlanDto }
  | { seq: number; type: 'review'; review: ReviewDto }
  | { seq: number; type: 'test_run'; testRun: TestRunDto }
  | { seq: number; type: 'memories_used'; memories: MemoryRef[] }
  | { seq: number; type: 'memory_saved'; memory: MemoryDto }
  | { seq: number; type: 'message_saved'; message: MessageDto }
  | {
      seq: number;
      type: 'run_finished';
      run: RunDto;
    };
