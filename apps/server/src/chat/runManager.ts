import { randomUUID } from 'node:crypto';
import type {
  AppNotice,
  NextStep,
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
  ImageInput,
  LLMProvider,
  ToolCall,
  ToolDefinition,
} from '../providers/types.js';
import { IMAGE_LIMITS } from '../attachments/image.js';
import { toAttachmentDto, type AttachmentRepo } from '../repositories/attachments.js';
import type { CapabilityRepo } from '../repositories/capabilities.js';
import { toMessageDto, type MessageRepo, type StoredMessage } from '../repositories/messages.js';
import type { ProjectRecord, ProjectRepo } from '../repositories/projects.js';
import { toRunDto, type RunRepo } from '../repositories/runs.js';
import { DEFAULT_SESSION_TITLE, type SessionRepo } from '../repositories/sessions.js';
import type { AuditRepo } from '../repositories/telemetry.js';
import type { ToolCallRepo } from '../repositories/toolCalls.js';
import type { ApprovalOutcome, ApprovalService } from '../approvals/service.js';
import {
  covers,
  similarScope,
  TASK_PERMISSION_LIMITS,
  toDto as taskPermissionDto,
  type TaskPermission,
} from '../approvals/taskPermission.js';
import type { FileChangeRepo } from '../repositories/fileChanges.js';
import type { ApprovalRepo } from '../repositories/approvals.js';
import type { McpManager } from '../mcp/manager.js';
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
import {
  ContextOverflowError,
  estimateTokens,
  fitHistory,
  repairToolPairs,
  summarizeHistory,
  type HistoryItem,
} from './context.js';
import { buildSystemPrompt } from './systemPrompt.js';
import { buildSuggestions } from '../reports/suggestions.js';
import { assertRepoRoot, repoStatus } from '../git/git.js';
import { MemoryError, memoryPromptSection, type MemoryService } from '../memory/service.js';
import type { MemoryRepo } from '../repositories/memories.js';
import { readGuidance } from '../workspace/guidance.js';
import {
  buildCheckpoint,
  buildRunReport,
  resumeContext,
  taskRunIds,
} from '../reports/runReport.js';

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
  attachments: AttachmentRepo;
  devops?: ToolContext['devops'];
  processes?: ToolContext['processes'];
  codeMap?: ToolContext['codeMap'];
  capture?: ToolContext['capture'];
  /** Connected apps (MCP servers): their tools join each run's registry. */
  mcp?: McpManager;
  memory?: MemoryService;
  memoryRepo?: MemoryRepo;
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
  /** Progress counters for checkpoints. */
  iteration: number;
  toolCalls: number;
  /** Latest follow-ups the model proposed with suggest_next_steps. */
  modelSuggestions: Array<{ label: string; prompt: string }>;
  /** Task permission the user approved for this run, if any (see request_task_permissions). */
  permission: TaskPermission | null;
  /** Built-in tools plus the connected apps' tools as they were when the run started. */
  registry: ToolRegistry;
}

/** Tools that only annotate the final answer: a turn of just these ends the run, no extra model call. */
const FINAL_TOOLS = new Set(['suggest_next_steps']);

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
  private readonly noticeListeners = new Set<(notice: AppNotice) => void>();
  private readonly activeBySession = new Map<string, string>();

  constructor(private readonly deps: RunManagerDeps) {}

  /** Start a run for a new user message. Validates configuration before persisting anything. */
  startMessage(
    sessionId: string,
    content: string,
    attachmentIds: string[] = [],
  ): { run: RunDto; userMessage: MessageDto } {
    const model = this.preflight(sessionId);
    const text = content.trim();
    const ids = [...new Set(attachmentIds)];
    if (!text && !ids.length) throw new HttpError(400, 'empty_message', 'Message is empty.');
    if (ids.length) this.checkAttachments(sessionId, ids, model);
    if (text.length > MAX_USER_MESSAGE_CHARS) {
      throw new HttpError(
        413,
        'message_too_large',
        `Message exceeds ${MAX_USER_MESSAGE_CHARS} characters.`,
      );
    }
    const inserted = this.deps.messages.insert({
      sessionId,
      role: 'user',
      content: text,
      status: 'complete',
    });
    if (ids.length) this.deps.attachments.bind(ids, sessionId, inserted.id);
    const userMessage = this.deps.messages.get(inserted.id)!;
    const session = this.deps.sessions.get(sessionId)!;
    if (session.title === DEFAULT_SESSION_TITLE) {
      const title =
        text.split('\n')[0]!.slice(0, 60).trim() || (ids.length ? 'Image' : DEFAULT_SESSION_TITLE);
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

  /** App-wide notices (approvals waiting for the user, finished runs) for notifications. */
  onNotice(listener: (notice: AppNotice) => void): () => void {
    this.noticeListeners.add(listener);
    return () => this.noticeListeners.delete(listener);
  }

  private notice(n: AppNotice): void {
    for (const l of this.noticeListeners) {
      try {
        l(n);
      } catch {
        this.noticeListeners.delete(l);
      }
    }
  }

  /**
   * The user approved an action with "allow similar for this task": extend the run's task
   * permission (or start one) with exactly this action's files or command.
   */
  private allowSimilar(run: ActiveRun, approvalId: string, toolName: string, proposal: Proposal) {
    const scope = similarScope(toolName, proposal);
    if (!scope) return;
    let p = run.permission;
    if (p && taskPermissionDto(p).active) {
      for (const f of scope.files) if (!p.files.includes(f)) p.files.push(f);
      for (const c of scope.commands)
        if (!p.commands.some((x) => x.join('\0') === c.join('\0'))) p.commands.push(c);
    } else {
      p = {
        approvalId,
        runId: run.id,
        files: scope.files,
        commands: scope.commands,
        maxActions: TASK_PERMISSION_LIMITS.defaultActions,
        used: 0,
        expiresAt: Date.now() + TASK_PERMISSION_LIMITS.defaultMinutes * 60_000,
        ended: null,
      };
      run.permission = p;
    }
    this.deps.audit.record({
      sessionId: run.sessionId,
      actor: 'user',
      action: 'task_permission_extended',
      details: { runId: run.id, approvalId, files: scope.files, commands: scope.commands },
    });
    this.emit(run, { type: 'task_permission', permission: taskPermissionDto(p) });
  }

  /** End a run's task permission early; later actions ask the user again. */
  revokeTaskPermission(runId: string): boolean {
    const run = this.runs.get(runId);
    const p = run?.permission;
    if (!run || run.done || !p || !taskPermissionDto(p).active) return false;
    p.ended = 'revoked';
    this.deps.audit.record({
      sessionId: run.sessionId,
      actor: 'user',
      action: 'task_permission_revoked',
      details: { runId, approvalId: p.approvalId, used: p.used },
    });
    this.emit(run, { type: 'task_permission', permission: taskPermissionDto(p) });
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

  /** Attachments must be this user's pending uploads, few enough, for a model that sees images. */
  private checkAttachments(sessionId: string, ids: string[], model: string): void {
    if (ids.length > IMAGE_LIMITS.perMessage)
      throw new HttpError(
        400,
        'too_many_attachments',
        `Attach at most ${IMAGE_LIMITS.perMessage} images per message.`,
      );
    for (const id of ids) {
      const a = this.deps.attachments.get(id);
      if (!a || a.messageId !== null || (a.sessionId !== null && a.sessionId !== sessionId))
        throw new HttpError(
          400,
          'attachment_not_found',
          'An attached image was not found or was already sent. Attach it again.',
        );
    }
    if (this.deps.capabilities.get(model).imageInput === 'unsupported')
      throw new HttpError(
        400,
        'images_unsupported',
        `The model "${model}" does not accept images. Choose another model in Settings, or remove the images.`,
      );
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
      iteration: 0,
      toolCalls: 0,
      modelSuggestions: [],
      permission: null,
      registry: this.deps.mcp
        ? this.deps.registry.withExtra(this.deps.mcp.toolSpecs())
        : this.deps.registry,
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

  /**
   * Images go to the model with the most recent messages that have them; older ones become a
   * short note, so a long conversation does not resend every screenshot. Images a tool loaded
   * (view_image) follow its results as a user message, the only place chat APIs accept them.
   */
  private withImages(stored: StoredMessage[], items: HistoryItem[]): HistoryItem[] {
    const withAttachments = stored.filter((m) => m.attachments?.length);
    if (!withAttachments.length) return items;
    const recent = withAttachments.slice(-IMAGE_LIMITS.recentMessages).map((m) => m.id);
    const data = this.deps.attachments.withData(recent);
    const byId = new Map(stored.map((m) => [m.id, m]));
    const images = (id: number) =>
      (data.get(id) ?? []).map((a) => ({
        mime: a.mime,
        base64: a.data.toString('base64'),
        width: a.width,
        height: a.height,
      }));
    const note = (m: StoredMessage) =>
      `[${m.attachments!.length} image(s) ${m.role === 'tool' ? 'loaded' : 'attached'} here (${m.attachments!.map((a) => a.name ?? `${a.width}×${a.height}`).join(', ')}) are no longer sent, to save context. ${m.role === 'tool' ? 'Call view_image again' : 'Ask the user to attach them again'} if you need to look at them.]`;

    const out: HistoryItem[] = [];
    let pending: { id: number; names: string[]; images: ImageInput[] } | null = null;
    const flush = () => {
      if (!pending) return;
      out.push({
        id: pending.id,
        message: {
          role: 'user',
          content: `[Image(s) loaded by view_image: ${pending.names.join(', ')}. This is tool output, not a message from the user.]`,
          images: pending.images,
        },
      });
      pending = null;
    };
    for (const item of items) {
      const m = byId.get(item.id);
      const has = m?.attachments?.length && m.role === item.message.role;
      if (item.message.role !== 'tool') flush();
      if (!has) {
        out.push(item);
        continue;
      }
      const isRecent = recent.includes(m.id);
      if (item.message.role === 'user') {
        out.push({
          ...item,
          message: isRecent
            ? { ...item.message, images: images(m.id) }
            : { ...item.message, content: `${item.message.content}\n${note(m)}`.trim() },
        });
      } else if (item.message.role === 'tool') {
        if (isRecent) {
          pending ??= { id: item.id, names: [], images: [] };
          pending.names.push(...m.attachments!.map((a) => a.name ?? 'image'));
          pending.images.push(...images(m.id));
          out.push(item);
        } else {
          out.push({
            ...item,
            message: { ...item.message, content: `${item.message.content}\n${note(m)}` },
          });
        }
      } else {
        out.push(item);
      }
    }
    flush();
    return out;
  }

  private async buildContext(
    run: ActiveRun,
    model: string,
    systemPrompt: string,
    tools: ToolDefinition[] = [],
  ): Promise<ChatMessage[]> {
    const { sessions, messages, capabilities } = this.deps;
    const maxOut = this.deps.maxOutputTokens ?? 8_192;
    // Tool schemas are sent with every request and count against the window too.
    const toolTokens = tools.length ? estimateTokens(JSON.stringify(tools)) : 0;
    const contextWindow =
      capabilities.get(model).contextWindow -
      (this.deps.provider.promptOverheadTokens ?? 0) -
      toolTokens;

    const plan = () => {
      const session = sessions.get(run.sessionId)!;
      const stored = messages.contextHistory(run.sessionId, session.summaryThroughMessageId ?? 0);
      const history = this.withImages(
        stored,
        repairToolPairs(stored.map((m) => ({ id: m.id, message: this.toChatMessage(m) }))),
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
          run.sessionId,
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

  /**
   * A request with images that the provider rejects as invalid most likely failed because the
   * model cannot read images: remember that, and say so instead of a generic error.
   */
  private imageRefusal(err: unknown, model: string, request: ChatRequest): unknown {
    if (!(err instanceof ProviderError) || !['bad_request', 'unsupported'].includes(err.kind))
      return err;
    if (!request.messages.some((m) => m.role === 'user' && m.images?.length)) return err;
    this.deps.capabilities.setImageInput(model, 'unsupported');
    return new ProviderError(
      err.kind,
      `the model "${model}" did not accept the images; choose a model that supports images in Settings, or send the message without them`,
      { status: err.status, cause: err },
    );
  }

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
    } catch (caught) {
      const err = this.imageRefusal(caught, model, request);
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
    const images = (exec.images ?? []).map((img) =>
      this.deps.attachments.create(img.data, img.info, img.name, run.sessionId),
    );
    if (images.length)
      this.deps.attachments.bind(
        images.map((a) => a.id),
        run.sessionId,
        message.id,
      );
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
      ...(images.length ? { attachments: images.map(toAttachmentDto) } : {}),
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
    const { limits } = this.deps;
    const registry = run.registry;
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
        caps.toolCalling === 'unsupported'
          ? []
          : registry
              .definitions(!!project)
              // A model known not to read images is not offered the tools that show it one, and
              // screenshots need a browser.
              .filter(
                (t) =>
                  !['view_image', 'screenshot'].includes(t.name) ||
                  (caps.imageInput !== 'unsupported' &&
                    (t.name !== 'screenshot' || !!this.deps.capture)),
              );
      // Memory: pinned, session notes, and the most relevant others for this request.
      const memoryRefs =
        this.deps.memory?.retrieve(
          { projectId: project?.id ?? null, sessionId: run.sessionId },
          this.deps.messages.lastUserMessage(run.sessionId)?.content ?? '',
        ) ?? [];
      if (memoryRefs.length) {
        this.deps.memoryRepo?.recordUsage(run.id, memoryRefs);
        this.emit(run, { type: 'memories_used', memories: memoryRefs });
      }
      const systemPrompt = buildSystemPrompt({
        project,
        detection: project ? await this.detect(project) : null,
        toolsEnabled: tools.length > 0,
        resume: this.resumeFor(run, session.plan),
        memory: memoryPromptSection(memoryRefs),
        guidance: project ? await readGuidance(project.rootPath).catch(() => null) : null,
        processes: project ? (this.deps.processes?.list(project.id) ?? []) : [],
        connectedApps: [
          ...new Set(
            tools.filter((t) => t.name.startsWith('mcp__')).map((t) => t.name.split('__')[1]!),
          ),
        ],
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
        run.iteration = iterations;
        const context = await this.buildContext(run, model, systemPrompt, tools);
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
            sessionId: run.sessionId,
            ...(tools.length ? { tools, toolChoice: 'auto' as const } : {}),
          },
          caps,
        );
        this.deps.runs.recordProgress(run.id, iterations, toolCallsUsed);

        if (turn.toolCalls.length === 0) {
          await this.finish(run, 'completed');
          return;
        }
        if (turn.toolCalls.every((c) => FINAL_TOOLS.has(c.name))) {
          // The answer is complete; record the annotation calls and stop without another model turn.
          for (const call of turn.toolCalls) {
            const { exec } = await this.runToolCall(run, project, call);
            this.recordToolResult(run, call, exec);
          }
          await this.finish(run, 'completed');
          return;
        }

        let blocked: RunBlocked | null = null;
        let rejected = false;
        // Calls made earlier in this same model turn: their results were not visible to the model
        // when it wrote the later calls (used to stop "confirmed" memories based on unseen results).
        const earlierThisTurn: string[] = [];
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
          run.toolCalls = toolCallsUsed;
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
              : await this.runToolCall(run, project, call, [...earlierThisTurn]);
          earlierThisTurn.push(call.name);
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
        this.saveCheckpoint(run);
        this.aborted(run);
        if (blocked) throw blocked;
      }
    } catch (raw) {
      if (raw instanceof RunBlocked) {
        await this.finish(run, 'blocked', {
          kind: raw.kind,
          message: raw.message,
          retryable: true,
        });
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
      if (err.kind === 'cancelled') await this.finish(run, 'cancelled');
      else {
        await this.finish(run, 'failed', {
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
      callId,
      ...(this.deps.devops ? { devops: this.deps.devops } : {}),
      ...(this.deps.processes ? { processes: this.deps.processes } : {}),
      ...(this.deps.codeMap ? { codeMap: this.deps.codeMap } : {}),
      ...(this.deps.capture ? { capture: this.deps.capture } : {}),
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
      emitDeploymentPlan: (plan) => this.emit(run, { type: 'deployment_plan', plan }),
      setNextSteps: (steps) => {
        run.modelSuggestions = steps;
      },
      sessionReports: () =>
        this.deps.runs
          .listBySession(run.sessionId)
          .reverse()
          .map((r) => (r.id === run.id || !r.report ? buildRunReport(r.id, this.deps) : r.report)),
      ...(this.deps.memory && this.deps.memoryRepo
        ? { memory: this.memoryContext(run, project) }
        : {}),
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
    earlierThisTurn: string[] = [],
  ): Promise<{
    exec: ToolExecution;
    approvalId: string | null;
    outcome: 'none' | 'rejected' | 'expired';
  }> {
    const { limits, approvals } = this.deps;
    const registry = run.registry;
    const ctx = {
      ...this.toolContext(run, project, call.id),
      earlierCallsThisTurn: earlierThisTurn,
    };
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
      ...(proposal.confirmationRequired
        ? { confirmationRequired: proposal.confirmationRequired }
        : {}),
      ...(proposal.approvalTtlMs ? { ttlMs: proposal.approvalTtlMs } : {}),
    });
    const resolved = () => this.deps.approvalRepo.get(approval.id)!;
    let decision: ApprovalOutcome;
    const permission = run.permission;
    const granted =
      permission && covers(permission, spec.name, proposal)
        ? approvals.approveByPermission(approval.id, permission.approvalId)
        : null;
    if (permission && granted) {
      // Within the task permission the user approved: no prompt, but the request and its
      // automatic approval are both shown and recorded like any other.
      permission.used++;
      this.emit(run, { type: 'approval_requested', approval });
      this.emit(run, { type: 'approval_resolved', approval: granted });
      this.emit(run, { type: 'task_permission', permission: taskPermissionDto(permission) });
      decision = { outcome: 'approved', approval: granted };
    } else {
      this.deps.runs.setActiveStatus(run.id, 'awaiting_approval');
      // Start waiting before announcing the request, so a decision can never arrive first.
      const waiting = approvals.wait(approval, run.controller.signal);
      this.emit(run, { type: 'approval_requested', approval });
      this.notice({
        type: 'approval_requested',
        sessionId: run.sessionId,
        runId: run.id,
        approvalId: approval.id,
        title: approval.title,
        risk: approval.risk,
      });
      this.phase(run, 'awaiting_approval', proposal.title);

      decision = await waiting;
      this.deps.runs.setActiveStatus(run.id, 'running');
      this.emit(run, { type: 'approval_resolved', approval: resolved() });
      if (decision.outcome === 'approved' && decision.allowSimilar) {
        this.allowSimilar(run, approval.id, spec.name, proposal);
      }
    }

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
      grantTaskPermission: (grant) => {
        const previous = run.permission;
        if (previous && taskPermissionDto(previous).active) {
          previous.ended = 'replaced';
          this.emit(run, { type: 'task_permission', permission: taskPermissionDto(previous) });
        }
        const p: TaskPermission = {
          approvalId: approval.id,
          runId: run.id,
          ...grant,
          used: 0,
          expiresAt: Date.now() + grant.minutes * 60_000,
          ended: null,
        };
        run.permission = p;
        this.emit(run, { type: 'task_permission', permission: taskPermissionDto(p) });
        return { expiresAt: new Date(p.expiresAt).toISOString() };
      },
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
    // Edits, commands and commits can change source files: the code map re-checks on next use.
    if (project) this.deps.codeMap?.invalidate(project.id);
    approvals.complete(
      approval.id,
      exec.status === 'completed' ? 'executed' : 'failed',
      exec.summary,
    );
    // Persist progress right after every side effect, so a crash mid-turn cannot lose it.
    this.saveCheckpoint(run);
    this.emit(run, { type: 'approval_resolved', approval: resolved() });
    return { exec, approvalId: approval.id, outcome: 'none' };
  }

  private async finish(
    run: ActiveRun,
    status: 'completed' | 'cancelled' | 'failed' | 'blocked',
    err?: { kind: RunErrorKind; message: string; retryable: boolean; status?: number | null },
  ): Promise<void> {
    const record = this.deps.runs.finish(
      run.id,
      status,
      err ? { kind: err.kind, message: err.message, retryable: err.retryable } : undefined,
    );
    this.deps.sessions.touch(run.sessionId);
    // Only runs that proposed actions get a report; plain answers have nothing to verify.
    if (
      taskRunIds(run.id, this.deps.runs).some(
        (id) => this.deps.approvalRepo.listByRun(id).length > 0,
      )
    ) {
      this.deps.runs.setReport(run.id, buildRunReport(run.id, this.deps));
    }
    if (status === 'completed') {
      try {
        this.deps.runs.setSuggestions(run.id, await this.suggestionsFor(run));
      } catch {
        // Suggestions are a convenience; never let them break the end of a run.
      }
    }
    if (err) {
      this.deps.audit.record({
        sessionId: run.sessionId,
        actor: 'system',
        action: status === 'blocked' ? 'run_blocked' : 'run_failed',
        details: { runId: run.id, kind: err.kind, status: err.status ?? null },
      });
    }
    const final = toRunDto(this.deps.runs.get(record.id) ?? record);
    this.emit(run, { type: 'run_finished', run: final });
    this.notice({
      type: 'run_finished',
      sessionId: run.sessionId,
      runId: run.id,
      status: final.status,
      durationMs: final.finishedAt
        ? Date.parse(final.finishedAt) - Date.parse(final.startedAt)
        : null,
    });
  }

  /** Follow-up chips from records (report, git, plan, memories) plus the model's proposals. */
  private async suggestionsFor(run: ActiveRun): Promise<NextStep[]> {
    const record = this.deps.runs.get(run.id);
    const session = this.deps.sessions.get(run.sessionId);
    const project = session?.projectId ? this.deps.projects.get(session.projectId) : null;
    const report = record?.report ?? null;
    let testCommand: string | null = null;
    let uncommitted: string[] | null = null;
    let failureLocation: string | null = null;
    if (project && report?.status === 'unverified') {
      testCommand = await detectTestCommand(project.rootPath).catch(() => null);
    }
    if (project && report && report.commits.length === 0 && report.files.some((f) => !f.reverted)) {
      uncommitted = await assertRepoRoot(project.rootPath)
        .then(() => repoStatus(project.rootPath))
        .then((st) => st.entries.map((e) => e.path))
        .catch(() => null);
    }
    if (report?.status === 'failed') {
      const marker = '--- project locations referenced in the output ---\n';
      const out = this.deps.messages
        .listBySession(run.sessionId)
        .filter((m) => m.runId === run.id && m.role === 'tool' && m.content.includes(marker))
        .at(-1)?.content;
      failureLocation = out ? (out.split(marker)[1]?.split('\n')[0]?.trim() ?? null) : null;
    }
    return buildSuggestions(
      {
        report,
        plan: session?.plan ?? null,
        pendingMemories: this.deps.memoryRepo?.countPendingFromRun(run.id) ?? 0,
        testCommand,
        uncommitted,
        failureLocation,
        modelSteps: run.modelSuggestions,
      },
      this.deps.redactor,
    );
  }

  /** Memory operations for tools, scoped to this session's project and session. */
  private memoryContext(
    run: ActiveRun,
    project: ProjectRecord | null,
  ): NonNullable<ToolContext['memory']> {
    const memory = this.deps.memory!;
    const repo = this.deps.memoryRepo!;
    const vis = { projectId: project?.id ?? null, sessionId: run.sessionId };
    return {
      propose: (input) => {
        const result = memory.propose(input, { ...vis, runId: run.id, source: 'agent' });
        this.emit(run, { type: 'memory_saved', memory: result.memory });
        return result;
      },
      search: (query) =>
        memory.activeFor(vis.projectId) ? repo.searchVisible(vis, query, 15) : [],
      resolveId: (prefix) => {
        const matches = repo.visible(vis, 'all').filter((m) => m.id.startsWith(prefix));
        if (matches.length !== 1) {
          throw new MemoryError(
            matches.length
              ? `Memory id "${prefix}" is ambiguous.`
              : `No memory "${prefix}" is visible here.`,
          );
        }
        return matches[0]!.id;
      },
    };
  }

  private saveCheckpoint(run: ActiveRun): void {
    this.deps.runs.setCheckpoint(
      run.id,
      buildCheckpoint(run.id, this.deps, {
        iteration: run.iteration,
        toolCalls: run.toolCalls,
        plan: this.deps.sessions.get(run.sessionId)?.plan ?? null,
      }),
    );
  }

  /** Resumption context when the previous request in this session did not complete. */
  private resumeFor(run: ActiveRun, plan: PlanStep[] | null): string | null {
    const current = this.deps.runs.get(run.id);
    if (!current) return null;
    const prev = this.deps.runs.previousRun(run.sessionId, current.startedAt);
    if (!prev || prev.status === 'completed' || prev.status === 'running') return null;
    if (this.deps.approvalRepo.listByRun(prev.id).length === 0) return null;
    return resumeContext(
      prev.status,
      prev.errorMessage,
      prev.report ?? buildRunReport(prev.id, this.deps),
      plan,
    );
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

/** The project's test command, from manifests (npm/pnpm/yarn script, composer script, artisan). */
async function detectTestCommand(root: string): Promise<string | null> {
  const d = await detectProject(root);
  if (d.scripts['package.json']?.test) {
    const pm = d.packageManagers.find((p) => ['pnpm', 'yarn', 'bun'].includes(p)) ?? 'npm';
    return `${pm} test`;
  }
  if (d.stack.includes('Laravel')) return 'php artisan test';
  if (d.scripts['composer.json']?.test) return 'composer test';
  if (d.stack.includes('Python')) return 'pytest';
  if (d.stack.includes('Go')) return 'go test ./...';
  if (d.stack.includes('Rust')) return 'cargo test';
  return null;
}
