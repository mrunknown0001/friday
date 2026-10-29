import { randomUUID } from 'node:crypto';
import type {
  AgentLimitsDto,
  MessageDto,
  ModelCapabilities,
  PlanStep,
  RunDto,
  RunErrorKind,
  RunEvent,
  RunPhase,
} from '@friday/shared';
import { HttpError } from '../http/errors.js';
import { ProviderError } from '../providers/errors.js';
import type {
  ChatMessage,
  ChatRequest,
  FinishReason,
  LLMProvider,
  ToolCall,
  ToolDefinition,
} from '../providers/types.js';
import type { CapabilityRepo } from '../repositories/capabilities.js';
import { toMessageDto, type MessageRepo, type StoredMessage } from '../repositories/messages.js';
import type { ProjectRecord, ProjectRepo } from '../repositories/projects.js';
import { toRunDto, type RunRepo } from '../repositories/runs.js';
import { DEFAULT_SESSION_TITLE, type SessionRepo } from '../repositories/sessions.js';
import type { AuditRepo } from '../repositories/telemetry.js';
import type { ToolCallRepo } from '../repositories/toolCalls.js';
import type { ApprovalService } from '../approvals/service.js';
import type { FileChangeRepo } from '../repositories/fileChanges.js';
import type { ApprovalRepo } from '../repositories/approvals.js';
import type { Redactor } from '../security/redact.js';
import {
  makeExecution,
  runGuarded,
  validateToolCall,
  type ToolExecution,
  type ToolRegistry,
} from '../tools/registry.js';
import type { Proposal, ToolContext } from '../tools/types.js';
import { detectProject } from '../workspace/detect.js';
import type { ToolEnvironment } from '../workspace/environment.js';
import { assertRootAvailable, WorkspaceError } from '../workspace/paths.js';
import { ContextOverflowError, fitHistory, repairToolPairs, summarizeHistory } from './context.js';
import { buildSystemPrompt } from './systemPrompt.js';

export interface RunManagerDeps {
  provider: LLMProvider;
  sessions: SessionRepo;
  messages: MessageRepo;
  runs: RunRepo;
  projects: ProjectRepo;
  toolCalls: ToolCallRepo;
  approvals: ApprovalService;
  approvalRepo: ApprovalRepo;
  fileChanges: FileChangeRepo;
  capabilities: CapabilityRepo;
  audit: AuditRepo;
  redactor: Redactor;
  registry: ToolRegistry;
  toolEnv: ToolEnvironment;
  limits: AgentLimitsDto;
  resolveModel: () => string | null;
  maxOutputTokens?: number;
  /** How often partial assistant output is checkpointed to the database. */
  checkpointIntervalMs?: number;
  /** How long finished runs stay in memory for late SSE subscribers. */
  retainFinishedMs?: number;
}

type EventInput = RunEvent extends infer E
  ? E extends { seq: number }
    ? Omit<E, 'seq'>
    : never
  : never;
type Listener = (event: RunEvent) => void;

interface ActiveRun {
  id: string;
  sessionId: string;
  controller: AbortController;
  events: RunEvent[];
  listeners: Set<Listener>;
  done: boolean;
  finished: Promise<void>;
}

/** Stops the loop without being an error from the provider. */
class RunBlocked extends Error {
  constructor(
    readonly kind: RunErrorKind,
    message: string,
  ) {
    super(message);
  }
}

interface TurnResult {
  text: string;
  toolCalls: ToolCall[];
  finishReason: FinishReason;
}

const MAX_BUFFERED_EVENTS = 20_000;
export const MAX_USER_MESSAGE_CHARS = 200_000;
/** An identical call (same tool and arguments) runs at most this many times per run. */
const MAX_IDENTICAL_CALLS = 2;
/** Characters of live command output streamed to the UI per call. */
const MAX_STREAMED_OUTPUT = 256 * 1024;

export class RunManager {
  private readonly runs = new Map<string, ActiveRun>();
  private readonly activeBySession = new Map<string, string>();

  constructor(private readonly deps: RunManagerDeps) {}

  /** Start a run for a new user message. Validates configuration before persisting anything. */
  startMessage(sessionId: string, content: string): { run: RunDto; userMessage: MessageDto } {
    const model = this.preflight(sessionId);
    const text = content.trim();
    if (!text) throw new HttpError(400, 'empty_message', 'Message is empty.');
    if (text.length > MAX_USER_MESSAGE_CHARS) {
      throw new HttpError(
        413,
        'message_too_large',
        `Message exceeds ${MAX_USER_MESSAGE_CHARS} characters.`,
      );
    }
    const userMessage = this.deps.messages.insert({
      sessionId,
      role: 'user',
      content: text,
      status: 'complete',
    });
    const session = this.deps.sessions.get(sessionId)!;
    if (session.title === DEFAULT_SESSION_TITLE) {
      const title = text.split('\n')[0]!.slice(0, 60).trim() || DEFAULT_SESSION_TITLE;
      this.deps.sessions.rename(sessionId, title);
    }
    const run = this.launch(sessionId, userMessage, model);
    return { run, userMessage: toMessageDto(this.deps.messages.get(userMessage.id)!) };
  }

  /**
   * Re-run after a failed, cancelled, interrupted, or blocked run. Completed tool work stays in the
   * history, so the model continues from where it stopped rather than starting over.
   */
  retry(sessionId: string): { run: RunDto } {
    const model = this.preflight(sessionId);
    const latest = this.deps.runs.latestForSession(sessionId);
    const userMessage = this.deps.messages.lastUserMessage(sessionId);
    if (!latest || !userMessage)
      throw new HttpError(409, 'nothing_to_retry', 'There is no previous request to retry.');
    if (latest.status === 'completed') {
      throw new HttpError(409, 'nothing_to_retry', 'The last request completed successfully.');
    }
    return { run: this.launch(sessionId, userMessage, model) };
  }

  cancel(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run || run.done) return false;
    run.controller.abort();
    return true;
  }

  /**
   * Subscribe to a run's events. Buffered events after `afterSeq` are replayed first.
   * Returns null if the run is not in memory (finished long ago or from a previous process).
   */
  subscribe(
    runId: string,
    afterSeq: number,
    listener: Listener,
  ): { replay: RunEvent[]; done: boolean; unsubscribe: () => void } | null {
    const run = this.runs.get(runId);
    if (!run) return null;
    const replay = run.events.filter((e) => e.seq > afterSeq);
    if (!run.done) run.listeners.add(listener);
    return { replay, done: run.done, unsubscribe: () => run.listeners.delete(listener) };
  }

  activeRunId(sessionId: string): string | null {
    return this.activeBySession.get(sessionId) ?? null;
  }

  /** Cancel everything and wait for runs to persist their final state. */
  async shutdown(): Promise<void> {
    const pending = [...this.runs.values()].filter((r) => !r.done);
    for (const r of pending) r.controller.abort();
    await Promise.allSettled(pending.map((r) => r.finished));
  }

  /** Waits for a run to finish (used by tests and shutdown). */
  async waitFor(runId: string): Promise<void> {
    await this.runs.get(runId)?.finished;
  }

  private preflight(sessionId: string): string {
    if (!this.deps.sessions.get(sessionId))
      throw new HttpError(404, 'session_not_found', 'Session not found.');
    if (!this.deps.provider.isConfigured()) {
      throw new HttpError(400, 'not_configured', new ProviderError('not_configured').message);
    }
    const model = this.deps.resolveModel();
    if (!model) throw new HttpError(400, 'model_not_selected', 'Select a model in Settings first.');
    if (this.activeBySession.has(sessionId)) {
      throw new HttpError(
        409,
        'run_in_progress',
        'A response is already being generated for this session.',
      );
    }
    return model;
  }

  private launch(sessionId: string, userMessage: StoredMessage, model: string): RunDto {
    const id = randomUUID();
    const record = this.deps.runs.create({ id, sessionId, userMessageId: userMessage.id, model });
    this.deps.sessions.touch(sessionId);
    const active: ActiveRun = {
      id,
      sessionId,
      controller: new AbortController(),
      events: [],
      listeners: new Set(),
      done: false,
      finished: Promise.resolve(),
    };
    this.runs.set(id, active);
    this.activeBySession.set(sessionId, id);
    this.emit(active, { type: 'run_started', runId: id, sessionId, model });
    active.finished = this.execute(active, model).finally(() => {
      active.done = true;
      active.listeners.clear();
      this.activeBySession.delete(sessionId);
      setTimeout(() => this.runs.delete(id), this.deps.retainFinishedMs ?? 60_000).unref();
    });
    return toRunDto(record);
  }

  private emit(run: ActiveRun, input: EventInput): void {
    const event = { ...input, seq: (run.events.at(-1)?.seq ?? 0) + 1 } as RunEvent;
    if (run.events.length < MAX_BUFFERED_EVENTS || event.type !== 'text_delta')
      run.events.push(event);
    for (const l of run.listeners) {
      try {
        l(event);
      } catch {
        run.listeners.delete(l);
      }
    }
  }

  private phase(run: ActiveRun, phase: RunPhase, detail?: string) {
    this.emit(run, detail ? { type: 'phase', phase, detail } : { type: 'phase', phase });
  }

  private aborted(run: ActiveRun): void {
    if (run.controller.signal.aborted) throw new ProviderError('cancelled');
  }

  // ---------------------------------------------------------------- context

  private toChatMessage(m: StoredMessage): ChatMessage {
    switch (m.role) {
      case 'user':
        return { role: 'user', content: m.content };
      case 'tool':
        return { role: 'tool', toolCallId: m.toolCallId ?? '', content: m.content };
      default:
        return m.rawToolCalls.length > 0
          ? { role: 'assistant', content: m.content || null, toolCalls: m.rawToolCalls }
          : { role: 'assistant', content: m.content };
    }
  }

  private async buildContext(
    run: ActiveRun,
    model: string,
    systemPrompt: string,
  ): Promise<ChatMessage[]> {
    const { sessions, messages, capabilities } = this.deps;
    const maxOut = this.deps.maxOutputTokens ?? 8_192;
    const contextWindow =
      capabilities.get(model).contextWindow - (this.deps.provider.promptOverheadTokens ?? 0);

    const plan = () => {
      const session = sessions.get(run.sessionId)!;
      const history = repairToolPairs(
        messages
          .contextHistory(run.sessionId, session.summaryThroughMessageId ?? 0)
          .map((m) => ({ id: m.id, message: this.toChatMessage(m) })),
      );
      return {
        session,
        fit: fitHistory({
          systemPrompt,
          summary: session.summary,
          history,
          contextWindow,
          reserveOutputTokens: Math.min(maxOut, Math.floor(contextWindow / 4)),
        }),
      };
    };

    const initial = plan();
    let fit = initial.fit;
    if (fit.dropped.length > 0) {
      this.phase(run, 'compacting', `Summarizing ${fit.dropped.length} older messages`);
      try {
        const summary = await summarizeHistory(
          this.deps.provider,
          model,
          initial.session.summary,
          fit.dropped,
          run.controller.signal,
        );
        sessions.setSummary(
          run.sessionId,
          this.deps.redactor.redact(summary),
          fit.dropped.at(-1)!.id,
        );
        fit = plan().fit;
      } catch {
        this.aborted(run);
        // Fall back to plain trimming: the oldest messages are omitted from this request only.
        this.phase(
          run,
          'compacting',
          `Summary failed; omitting ${fit.dropped.length} older messages from context`,
        );
      }
    }
    return fit.messages;
  }

  // ---------------------------------------------------------------- one model turn

  private async modelTurn(
    run: ActiveRun,
    model: string,
    request: ChatRequest,
    caps: ModelCapabilities,
  ): Promise<TurnResult> {
    const { messages, provider } = this.deps;
    let text = '';
    let assistantId: number | null = null;
    let lastCheckpoint = 0;
    const checkpointEvery = this.deps.checkpointIntervalMs ?? 2_000;

    const checkpoint = () => {
      if (!text) return;
      if (assistantId === null) {
        assistantId = messages.insert({
          sessionId: run.sessionId,
          runId: run.id,
          role: 'assistant',
          content: text,
          status: 'partial',
          model,
        }).id;
        lastCheckpoint = Date.now();
      } else if (Date.now() - lastCheckpoint >= checkpointEvery) {
        messages.update(assistantId, text, 'partial');
        lastCheckpoint = Date.now();
      }
    };

    try {
      let toolCalls: ToolCall[] = [];
      let finishReason: FinishReason = 'unknown';
      if (caps.streaming === 'unsupported') {
        const result = await provider.complete(request);
        text = result.text;
        toolCalls = result.toolCalls;
        finishReason = result.finishReason;
        if (text) this.emit(run, { type: 'text_delta', delta: text });
      } else {
        let streaming = false;
        for await (const ev of provider.streamChat(request)) {
          if (ev.type === 'text') {
            if (!streaming) {
              streaming = true;
              this.phase(run, 'streaming');
            }
            text += ev.delta;
            this.emit(run, { type: 'text_delta', delta: ev.delta });
            checkpoint();
          } else if (ev.type === 'tool_call') {
            toolCalls.push(ev.call);
          } else {
            finishReason = ev.finishReason;
          }
        }
      }

      let content = text;
      if (toolCalls.length === 0) {
        if (finishReason === 'length')
          content += '\n\n_[Response truncated: the output token limit was reached.]_';
        if (finishReason === 'content_filter')
          content += '\n\n_[Response stopped by the provider content filter.]_';
        if (!content.trim()) content = '_[The model returned an empty response.]_';
      }
      const saved =
        assistantId === null
          ? messages.insert({
              sessionId: run.sessionId,
              runId: run.id,
              role: 'assistant',
              content,
              status: 'complete',
              model,
              toolCalls,
            })
          : (messages.update(assistantId, content, 'complete', toolCalls),
            messages.get(assistantId)!);
      this.emit(run, { type: 'message_saved', message: toMessageDto(saved) });
      return { text: content, toolCalls, finishReason };
    } catch (err) {
      // Keep whatever was streamed, marked so it is shown but never fed back to the model.
      const status =
        err instanceof ProviderError && err.kind === 'cancelled' ? 'cancelled' : 'error';
      if (assistantId !== null) messages.update(assistantId, text, status);
      else if (text)
        messages.insert({
          sessionId: run.sessionId,
          runId: run.id,
          role: 'assistant',
          content: text,
          status,
          model,
        });
      throw err;
    }
  }

  // ---------------------------------------------------------------- tools

  private recordToolResult(
    run: ActiveRun,
    call: ToolCall,
    exec: ToolExecution,
    approvalId: string | null = null,
  ): void {
    const message = this.deps.messages.insert({
      sessionId: run.sessionId,
      runId: run.id,
      role: 'tool',
      content: exec.content,
      status: 'complete',
      toolCallId: call.id,
    });
    this.deps.toolCalls.insert({
      sessionId: run.sessionId,
      runId: run.id,
      callId: call.id,
      resultMessageId: message.id,
      name: call.name,
      arguments: this.deps.redactor.redact(call.argumentsJson),
      category: exec.category,
      status: exec.status,
      summary: exec.summary,
      truncated: exec.truncated,
      durationMs: exec.durationMs,
      approvalId,
    });
    this.emit(run, {
      type: 'tool_finished',
      callId: call.id,
      name: call.name,
      status: exec.status,
      summary: exec.summary,
      durationMs: exec.durationMs,
    });
  }

  private skipped(
    call: ToolCall,
    reason: string,
    category: ToolExecution['category'] = null,
  ): ToolExecution {
    return {
      status: 'skipped',
      content: `Not executed: ${reason}`,
      summary: reason,
      label: call.name,
      truncated: false,
      durationMs: 0,
      category,
    };
  }

  // ---------------------------------------------------------------- the agent loop

  private async execute(run: ActiveRun, model: string): Promise<void> {
    const { limits, registry } = this.deps;
    let iterations = 0;
    let toolCallsUsed = this.deps.toolCalls.countForRun(run.id);
    let consecutiveFailures = 0;
    const callCounts = new Map<string, number>();

    try {
      this.phase(run, 'preparing');
      const session = this.deps.sessions.get(run.sessionId)!;
      const project = session.projectId ? this.deps.projects.get(session.projectId) : null;
      const caps = this.deps.capabilities.get(model);
      const tools: ToolDefinition[] =
        caps.toolCalling === 'unsupported' ? [] : registry.definitions(!!project);
      const systemPrompt = buildSystemPrompt({
        project,
        detection: project ? await this.detect(project) : null,
        toolsEnabled: tools.length > 0,
      });

      for (;;) {
        this.aborted(run);
        if (iterations >= limits.maxIterations) {
          throw new RunBlocked(
            'limit_reached',
            `Stopped after ${limits.maxIterations} model turns without a final answer. Send a follow-up (or Retry) to let it continue.`,
          );
        }
        iterations++;
        const context = await this.buildContext(run, model, systemPrompt);
        this.aborted(run);
        this.phase(run, iterations === 1 ? 'waiting_for_model' : 'reading_results');

        const turn = await this.modelTurn(
          run,
          model,
          {
            model,
            messages: context,
            maxOutputTokens: this.deps.maxOutputTokens ?? 8_192,
            signal: run.controller.signal,
            operation: 'chat',
            ...(tools.length ? { tools, toolChoice: 'auto' as const } : {}),
          },
          caps,
        );
        this.deps.runs.recordProgress(run.id, iterations, toolCallsUsed);

        if (turn.toolCalls.length === 0) {
          this.finish(run, 'completed');
          return;
        }

        let blocked: RunBlocked | null = null;
        let rejected = false;
        for (const call of turn.toolCalls) {
          if (run.controller.signal.aborted) {
            this.recordToolResult(run, call, this.skipped(call, 'the run was cancelled'));
            continue;
          }
          if (blocked) {
            this.recordToolResult(run, call, this.skipped(call, 'the run stopped'));
            continue;
          }
          if (rejected) {
            // Later calls in the same turn may depend on the rejected one.
            this.recordToolResult(
              run,
              call,
              this.skipped(
                call,
                'the user rejected an earlier action in this turn; ask before continuing',
              ),
            );
            continue;
          }
          if (toolCallsUsed >= limits.maxToolCalls) {
            blocked = new RunBlocked(
              'limit_reached',
              `Reached the limit of ${limits.maxToolCalls} tool calls for one request. Send a follow-up (or Retry) to let it continue.`,
            );
            this.recordToolResult(run, call, this.skipped(call, 'tool-call limit reached'));
            continue;
          }
          toolCallsUsed++;
          this.emit(run, {
            type: 'tool_started',
            callId: call.id,
            name: call.name,
            arguments: call.argumentsJson.slice(0, 500),
          });
          this.phase(run, 'running_tool', call.name);

          const key = `${call.name}\u0000${canonicalArgs(call.argumentsJson)}`;
          const seen = (callCounts.get(key) ?? 0) + 1;
          callCounts.set(key, seen);
          const result =
            seen > MAX_IDENTICAL_CALLS
              ? {
                  exec: this.skipped(
                    call,
                    `identical ${call.name} call already made ${seen - 1} times in this request; use the earlier result or change the arguments`,
                    registry.get(call.name)?.category ?? null,
                  ),
                  approvalId: null,
                  outcome: 'none' as const,
                }
              : await this.runToolCall(run, project, call);
          const exec = result.exec;
          this.recordToolResult(run, call, exec, result.approvalId);
          if (result.outcome === 'rejected') rejected = true;
          if (result.outcome === 'expired') {
            blocked = new RunBlocked(
              'approval_expired',
              'An approval request expired without a decision, so the run stopped. Send a message (or Continue) to pick up where it left off.',
            );
            continue;
          }

          // A rejection is a user decision, not a tool failure.
          consecutiveFailures =
            exec.status === 'completed' || result.outcome === 'rejected'
              ? 0
              : consecutiveFailures + 1;
          if (consecutiveFailures >= limits.maxConsecutiveToolFailures) {
            blocked = new RunBlocked(
              'repeated_failures',
              `Stopped after ${consecutiveFailures} consecutive failed tool calls. Check the tool errors above, then send guidance or Retry.`,
            );
          }
        }
        this.deps.runs.recordProgress(run.id, iterations, toolCallsUsed);
        this.aborted(run);
        if (blocked) throw blocked;
      }
    } catch (raw) {
      if (raw instanceof RunBlocked) {
        this.finish(run, 'blocked', { kind: raw.kind, message: raw.message, retryable: true });
        return;
      }
      const err =
        raw instanceof ProviderError
          ? raw
          : raw instanceof ContextOverflowError
            ? new ProviderError('bad_request', raw.message)
            : new ProviderError(
                'unknown',
                this.deps.redactor.redact(raw instanceof Error ? raw.message : String(raw)),
              );
      if (err.kind === 'cancelled') this.finish(run, 'cancelled');
      else {
        this.finish(run, 'failed', {
          kind: raw instanceof ContextOverflowError ? 'context_overflow' : err.kind,
          message: err.message,
          retryable: err.retryable || err.kind === 'unknown',
          status: err.status,
        });
      }
    }
  }

  private async detect(project: ProjectRecord) {
    try {
      await assertRootAvailable(project.rootPath);
      return await detectProject(project.rootPath);
    } catch {
      return null;
    }
  }

  private toolContext(run: ActiveRun, project: ProjectRecord | null, callId: string): ToolContext {
    let streamed = 0;
    return {
      project,
      sessionId: run.sessionId,
      runId: run.id,
      signal: run.controller.signal,
      redactor: this.deps.redactor,
      env: this.deps.toolEnv,
      maxOutputChars: this.deps.limits.maxToolOutputChars,
      setPlan: (plan: PlanStep[]) => {
        this.deps.sessions.setPlan(run.sessionId, plan);
        this.emit(run, { type: 'plan_updated', plan });
      },
      emitOutput: (chunk: string) => {
        // Live terminal view only; the persisted result has its own limits.
        if (streamed > MAX_STREAMED_OUTPUT) return;
        streamed += chunk.length;
        this.emit(run, { type: 'command_output', callId, chunk: this.deps.redactor.redact(chunk) });
      },
    };
  }

  /**
   * Execute one validated tool call. Allowed tools run directly. Protected tools are prepared
   * (no side effects), shown to the user, and run only after an approval whose action hash still
   * matches freshly re-checked preconditions. Every path ends in a result for the model.
   */
  private async runToolCall(
    run: ActiveRun,
    project: ProjectRecord | null,
    call: ToolCall,
  ): Promise<{
    exec: ToolExecution;
    approvalId: string | null;
    outcome: 'none' | 'rejected' | 'expired';
  }> {
    const { registry, limits, approvals } = this.deps;
    const ctx = this.toolContext(run, project, call.id);
    const v = validateToolCall(registry, call, ctx);
    if (!v.ok) return { exec: v.execution, approvalId: null, outcome: 'none' };
    const { spec, args, label } = v;

    if (v.policy.action === 'allow') {
      const execute = spec.execute!;
      const exec = await runGuarded(
        (c) => execute(args, c),
        call,
        spec,
        label,
        ctx,
        limits.toolTimeoutMs,
      );
      return { exec, approvalId: null, outcome: 'none' };
    }

    const started = Date.now();
    const result = (status: ToolExecution['status'], content: string, summary: string) =>
      makeExecution(ctx, call, started, spec.category, status, content, summary, { label });
    const prepare = async (): Promise<Proposal | string> => {
      try {
        return await spec.prepare!(args, ctx);
      } catch (err) {
        return err instanceof WorkspaceError ? err.message : `${spec.name} could not be prepared.`;
      }
    };

    const proposal = await prepare();
    if (typeof proposal === 'string') {
      return {
        exec: result('error', `Error: ${proposal}`, proposal),
        approvalId: null,
        outcome: 'none',
      };
    }

    const reason = (args as { reason?: unknown }).reason;
    const approval = approvals.request({
      sessionId: run.sessionId,
      runId: run.id,
      projectId: project?.id ?? null,
      toolCallId: call.id,
      toolName: spec.name,
      category: proposal.category,
      risk: proposal.risk,
      title: proposal.title,
      summary: proposal.summary,
      reason: this.deps.redactor.redact(typeof reason === 'string' ? reason : ''),
      details: proposal.details,
      projectRoot: project?.rootPath ?? null,
      args,
      fingerprint: proposal.fingerprint,
    });
    this.deps.runs.setActiveStatus(run.id, 'awaiting_approval');
    this.emit(run, { type: 'approval_requested', approval });
    this.phase(run, 'awaiting_approval', proposal.title);

    const decision = await approvals.wait(approval, run.controller.signal);
    this.deps.runs.setActiveStatus(run.id, 'running');
    const resolved = () => this.deps.approvalRepo.get(approval.id)!;
    this.emit(run, { type: 'approval_resolved', approval: resolved() });

    switch (decision.outcome) {
      case 'cancelled':
        return {
          exec: this.skipped(call, 'the run was cancelled', spec.category),
          approvalId: approval.id,
          outcome: 'none',
        };
      case 'expired':
        return {
          exec: result(
            'denied',
            'Not executed: the approval request expired without a decision.',
            'Approval expired',
          ),
          approvalId: approval.id,
          outcome: 'expired',
        };
      case 'rejected':
        return {
          exec: result(
            'denied',
            `The user rejected this action; it was not executed.${decision.note ? ` Their note: "${decision.note}"` : ''} Do not retry the same action. Ask the user how to proceed, or propose a different approach.`,
            decision.note ? `Rejected: ${decision.note}` : 'Rejected by user',
          ),
          approvalId: approval.id,
          outcome: 'rejected',
        };
      case 'approved':
        break;
    }

    // Re-check preconditions: the approval covers exactly what was reviewed.
    this.phase(run, 'running_tool', spec.name);
    const fresh = await prepare();
    const freshHash =
      typeof fresh === 'string'
        ? null
        : approvals.hashFor(approval, project?.rootPath ?? null, args, fresh.fingerprint);
    if (typeof fresh === 'string' || freshHash !== approval.actionHash) {
      const why =
        typeof fresh === 'string'
          ? fresh
          : 'the target changed after it was reviewed (for example, the file was edited)';
      approvals.complete(approval.id, 'stale', `Not executed: ${why}`);
      this.emit(run, { type: 'approval_resolved', approval: resolved() });
      return {
        exec: result(
          'error',
          `Not executed: ${why}. Re-read the current state and propose the change again.`,
          'Stale: changed after review',
        ),
        approvalId: approval.id,
        outcome: 'none',
      };
    }

    const execCtx: ToolContext = {
      ...ctx,
      recordFileChange: (change) =>
        this.deps.fileChanges.insert({
          approvalId: approval.id,
          sessionId: run.sessionId,
          projectId: project!.id,
          ...change,
        }),
    };
    const exec = await runGuarded(
      (c) => fresh.apply(c),
      call,
      spec,
      label,
      execCtx,
      fresh.timeoutMs ?? limits.toolTimeoutMs,
    );
    approvals.complete(
      approval.id,
      exec.status === 'completed' ? 'executed' : 'failed',
      exec.summary,
    );
    this.emit(run, { type: 'approval_resolved', approval: resolved() });
    return { exec, approvalId: approval.id, outcome: 'none' };
  }

  private finish(
    run: ActiveRun,
    status: 'completed' | 'cancelled' | 'failed' | 'blocked',
    err?: { kind: RunErrorKind; message: string; retryable: boolean; status?: number | null },
  ) {
    const record = this.deps.runs.finish(
      run.id,
      status,
      err ? { kind: err.kind, message: err.message, retryable: err.retryable } : undefined,
    );
    this.deps.sessions.touch(run.sessionId);
    if (err) {
      this.deps.audit.record({
        sessionId: run.sessionId,
        actor: 'system',
        action: status === 'blocked' ? 'run_blocked' : 'run_failed',
        details: { runId: run.id, kind: err.kind, status: err.status ?? null },
      });
    }
    this.emit(run, { type: 'run_finished', run: toRunDto(record) });
  }
}

/** Normalize argument JSON so `{"a":1,"b":2}` and `{ "b": 2, "a": 1 }` count as the same call. */
function canonicalArgs(json: string): string {
  try {
    const sortKeys = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(sortKeys)
        : v && typeof v === 'object'
          ? Object.fromEntries(
              Object.keys(v)
                .sort()
                .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
            )
          : v;
    return JSON.stringify(sortKeys(JSON.parse(json)));
  } catch {
    return json;
  }
}
