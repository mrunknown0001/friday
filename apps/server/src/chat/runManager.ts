import { randomUUID } from 'node:crypto';
import type { MessageDto, RunDto, RunEvent, RunPhase } from '@friday/shared';
import { HttpError } from '../http/errors.js';
import { ProviderError } from '../providers/errors.js';
import type { ChatMessage, FinishReason, LLMProvider } from '../providers/types.js';
import type { CapabilityRepo } from '../repositories/capabilities.js';
import type { MessageRepo } from '../repositories/messages.js';
import { toRunDto, type RunRepo } from '../repositories/runs.js';
import { DEFAULT_SESSION_TITLE, type SessionRepo } from '../repositories/sessions.js';
import type { AuditRepo } from '../repositories/telemetry.js';
import type { Redactor } from '../security/redact.js';
import { ContextOverflowError, fitHistory, summarizeHistory, type HistoryItem } from './context.js';
import { SYSTEM_PROMPT } from './systemPrompt.js';

export interface RunManagerDeps {
  provider: LLMProvider;
  sessions: SessionRepo;
  messages: MessageRepo;
  runs: RunRepo;
  capabilities: CapabilityRepo;
  audit: AuditRepo;
  redactor: Redactor;
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

const MAX_BUFFERED_EVENTS = 20_000;
export const MAX_USER_MESSAGE_CHARS = 200_000;

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
    return { run, userMessage: this.deps.messages.get(userMessage.id)! };
  }

  /** Re-run the latest user message after a failed, cancelled, or interrupted run. */
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

  private launch(sessionId: string, userMessage: MessageDto, model: string): RunDto {
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
    active.finished = this.execute(active, userMessage, model).finally(() => {
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

  private async buildContext(
    run: ActiveRun,
    userMessage: MessageDto,
    model: string,
  ): Promise<ChatMessage[]> {
    const { sessions, messages, capabilities } = this.deps;
    const maxOut = this.deps.maxOutputTokens ?? 8_192;
    const contextWindow = capabilities.get(model).contextWindow;

    const plan = () => {
      const session = sessions.get(run.sessionId)!;
      const history: HistoryItem[] = messages
        .contextHistory(run.sessionId, session.summaryThroughMessageId ?? 0, userMessage.id)
        .map((m) => ({
          id: m.id,
          message: { role: m.role as 'user' | 'assistant', content: m.content },
        }));
      return {
        session,
        fit: fitHistory({
          systemPrompt: SYSTEM_PROMPT,
          summary: session.summary,
          history,
          contextWindow,
          reserveOutputTokens: Math.min(maxOut, Math.floor(contextWindow / 4)),
        }),
      };
    };

    const initial = plan();
    const session = initial.session;
    let fit = initial.fit;
    if (fit.dropped.length > 0) {
      this.phase(run, 'compacting', `Summarizing ${fit.dropped.length} older messages`);
      try {
        const summary = await summarizeHistory(
          this.deps.provider,
          model,
          session.summary,
          fit.dropped,
          run.controller.signal,
        );
        sessions.setSummary(
          run.sessionId,
          this.deps.redactor.redact(summary),
          fit.dropped.at(-1)!.id,
        );
        ({ fit } = plan());
      } catch {
        if (run.controller.signal.aborted) throw new ProviderError('cancelled');
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

  private async execute(run: ActiveRun, userMessage: MessageDto, model: string): Promise<void> {
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

    const finalize = (status: 'complete' | 'cancelled' | 'error', content: string) => {
      if (assistantId === null) {
        if (!content) return;
        assistantId = messages.insert({
          sessionId: run.sessionId,
          runId: run.id,
          role: 'assistant',
          content,
          status,
          model,
        }).id;
      } else {
        messages.update(assistantId, content, status);
      }
      this.emit(run, { type: 'message_saved', message: messages.get(assistantId)! });
    };

    try {
      this.phase(run, 'preparing');
      const context = await this.buildContext(run, userMessage, model);
      if (run.controller.signal.aborted) throw new ProviderError('cancelled');

      this.phase(run, 'waiting_for_model');
      const caps = this.deps.capabilities.get(model);
      const request = {
        model,
        messages: context,
        maxOutputTokens: this.deps.maxOutputTokens ?? 8_192,
        signal: run.controller.signal,
        operation: 'chat',
      };

      let finishReason: FinishReason = 'unknown';
      if (caps.streaming === 'unsupported') {
        const result = await provider.complete(request);
        text = result.text;
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
          } else if (ev.type === 'finish') {
            finishReason = ev.finishReason;
          }
          // Phase 1 offers no tools, so tool_call events are ignored.
        }
      }

      let content = text;
      if (finishReason === 'length')
        content += '\n\n_[Response truncated: the output token limit was reached.]_';
      if (finishReason === 'content_filter')
        content += '\n\n_[Response stopped by the provider content filter.]_';
      if (!content.trim()) content = '_[The model returned an empty response.]_';
      finalize('complete', content);
      this.finish(run, 'completed');
    } catch (raw) {
      const err =
        raw instanceof ProviderError
          ? raw
          : raw instanceof ContextOverflowError
            ? new ProviderError('bad_request', raw.message)
            : new ProviderError(
                'unknown',
                this.deps.redactor.redact(raw instanceof Error ? raw.message : String(raw)),
              );
      if (err.kind === 'cancelled') {
        finalize('cancelled', text);
        this.finish(run, 'cancelled');
      } else {
        finalize('error', text);
        this.finish(run, 'failed', err);
      }
    }
  }

  private finish(
    run: ActiveRun,
    status: 'completed' | 'cancelled' | 'failed',
    err?: ProviderError,
  ) {
    const record = this.deps.runs.finish(
      run.id,
      status,
      err
        ? {
            kind: err.kind,
            message: err.message,
            retryable: err.retryable || err.kind === 'unknown',
          }
        : undefined,
    );
    this.deps.sessions.touch(run.sessionId);
    if (err) {
      this.deps.audit.record({
        sessionId: run.sessionId,
        actor: 'system',
        action: 'run_failed',
        details: { runId: run.id, kind: err.kind, status: err.status },
      });
    }
    this.emit(run, { type: 'run_finished', run: toRunDto(record) });
  }
}
