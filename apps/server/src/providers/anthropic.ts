import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Redactor } from '../security/redact.js';
import {
  parseRetryAfter,
  ProviderError,
  QUOTA_HINT,
  UPSTREAM_RETRY_MS,
  withoutKeyHints,
  type ProviderSource,
} from './errors.js';
import { abortableSleep, retryDelay, withRetry } from './retry.js';
import { estimateRequestTokens, estimateTokens } from './tokens.js';
import type {
  ChatMessage,
  ChatRequest,
  CompletionResult,
  FinishReason,
  LLMProvider,
  ModelInfo,
  ProviderCallRecorder,
  StreamEvent,
  ToolCall,
  Usage,
} from './types.js';

export const ANTHROPIC: ProviderSource = {
  label: 'Anthropic',
  envVar: 'ANTHROPIC_API_KEY',
  gateway: false,
};
export const ANTHROPIC_PREFIX = 'anthropic:';
const API_VERSION = '2023-06-01';
/** The Messages API requires max_tokens. */
const DEFAULT_MAX_TOKENS = 8_192;

export interface AnthropicOptions {
  apiKey: string | null;
  baseUrl?: string;
  timeoutMs: number;
  maxRetries: number;
  redactor: Redactor;
  recorder?: ProviderCallRecorder;
  fetch?: typeof fetch;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
}

/** An HTTP error answer from the API. */
class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly errorType: string,
    message: string,
    readonly headers: Headers | null,
  ) {
    super(message);
  }
}

/** The parts of a stream event Friday reads. */
interface WireEvent {
  type?: string;
  index?: number;
  message?: { usage?: Record<string, unknown> };
  content_block?: { type?: string; id?: string; name?: string };
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
  usage?: { output_tokens?: number };
  error?: { type?: string; message?: string };
}

/** Marker used as the abort reason when our own idle timer fires. */
class IdleTimeout extends Error {}

type Block =
  | { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | {
      type: 'tool_use';
      id: string;
      name: string;
      input: unknown;
      cache_control?: { type: 'ephemeral' };
    }
  | {
      type: 'tool_result';
      tool_use_id: string;
      content: string;
      cache_control?: { type: 'ephemeral' };
    };

interface WireMessage {
  role: 'user' | 'assistant';
  content: Block[];
}

const modelListSchema = z.object({
  data: z.array(z.looseObject({ id: z.string().min(1), display_name: z.string().optional() })),
  has_more: z.boolean().optional(),
  last_id: z.string().nullish(),
});

const messageSchema = z.object({
  content: z.array(
    z.looseObject({
      type: z.string(),
      text: z.string().optional(),
      id: z.string().optional(),
      name: z.string().optional(),
      input: z.unknown().optional(),
    }),
  ),
  stop_reason: z.string().nullish(),
  usage: z.looseObject({}).nullish(),
});

/** Anthropic's Messages API, called directly (streaming, tools, images, prompt caching). */
export class AnthropicProvider implements LLMProvider {
  readonly id = 'anthropic';
  readonly source = ANTHROPIC;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: AnthropicOptions) {
    this.baseUrl = (opts.baseUrl ?? 'https://api.anthropic.com').replace(/\/+$/, '');
    this.fetchImpl = opts.fetch ?? fetch;
  }

  isConfigured(): boolean {
    return !!this.opts.apiKey;
  }

  private retryTiming() {
    return {
      ...(this.opts.retryBaseDelayMs !== undefined
        ? { baseDelayMs: this.opts.retryBaseDelayMs }
        : {}),
      ...(this.opts.retryMaxDelayMs !== undefined ? { maxDelayMs: this.opts.retryMaxDelayMs } : {}),
    };
  }

  private classify = (err: unknown) => classifyAnthropicError(err, this.opts.redactor);

  /** One HTTP request; errors become ApiFailure (status) or are thrown as they are (network). */
  private async call(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    if (!this.opts.apiKey) throw new ProviderError('not_configured', null, { source: ANTHROPIC });
    // The timeout covers getting the response headers only: a signal given to fetch also ends the
    // body, and a stream has its own idle timer.
    const timeout = new AbortController();
    const timer = setTimeout(
      () => timeout.abort(new DOMException('timed out', 'TimeoutError')),
      this.opts.timeoutMs,
    );
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'x-api-key': this.opts.apiKey,
          'anthropic-version': API_VERSION,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let errorType = '';
      let message: string;
      try {
        const parsed = JSON.parse(text) as { error?: { type?: unknown; message?: unknown } };
        errorType = typeof parsed.error?.type === 'string' ? parsed.error.type : '';
        message = typeof parsed.error?.message === 'string' ? parsed.error.message : '';
      } catch {
        message = text.slice(0, 300);
      }
      throw new ApiFailure(res.status, errorType, message, res.headers);
    }
    return res;
  }

  private record(
    req: Pick<ChatRequest, 'model' | 'operation' | 'sessionId' | 'runId' | 'breakdown'> &
      Partial<Pick<ChatRequest, 'messages' | 'tools'>>,
    started: number,
    outcome: { error?: ProviderError; attempts: number; usage: Usage | null; output?: string },
  ) {
    let usage = outcome.usage;
    let tokensEstimated = false;
    if (!outcome.error && outcome.output !== undefined && req.messages) {
      if (usage?.inputTokens == null || usage.outputTokens == null) {
        usage = {
          inputTokens:
            usage?.inputTokens ??
            estimateRequestTokens({ messages: req.messages, tools: req.tools }),
          outputTokens: usage?.outputTokens ?? estimateTokens(outcome.output),
        };
        tokensEstimated = true;
      }
    }
    this.opts.recorder?.({
      model: req.model,
      operation: req.operation ?? 'chat',
      sessionId: req.sessionId ?? null,
      status: !outcome.error ? 'ok' : outcome.error.kind === 'cancelled' ? 'cancelled' : 'error',
      errorKind: outcome.error?.kind ?? null,
      durationMs: Date.now() - started,
      attempts: outcome.attempts,
      usage,
      tokensEstimated,
      runId: req.runId ?? null,
      breakdown: req.breakdown ?? null,
    });
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const started = Date.now();
    const models: ModelInfo[] = [];
    let attempts = 0;
    try {
      let after: string | null = null;
      // A few pages at most; the list is short.
      for (let page = 0; page < 5; page++) {
        const query: string = `?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ''}`;
        const result = await withRetry(
          async () => (await this.call('GET', `/v1/models${query}`, undefined, signal)).json(),
          this.classify,
          { maxRetries: this.opts.maxRetries, signal, ...this.retryTiming() },
        );
        attempts += result.attempts;
        const parsed = modelListSchema.safeParse(result.value);
        if (!parsed.success)
          throw new ProviderError('malformed', 'unexpected model list format', {
            source: ANTHROPIC,
          });
        for (const m of parsed.data.data) {
          models.push({
            id: `${ANTHROPIC_PREFIX}${m.id}`,
            provider: 'anthropic',
            ...(m.display_name ? { name: m.display_name } : {}),
          });
        }
        if (!parsed.data.has_more || !parsed.data.last_id) break;
        after = parsed.data.last_id;
      }
      this.record({ model: '-', operation: 'list_models' }, started, { attempts, usage: null });
      return models;
    } catch (raw) {
      const err = this.classify(raw);
      this.record({ model: '-', operation: 'list_models' }, started, {
        error: err,
        attempts: Math.max(attempts, err.attempts),
        usage: null,
      });
      throw err;
    }
  }

  async *streamChat(req: ChatRequest): AsyncGenerator<StreamEvent, void, undefined> {
    const started = Date.now();
    const ctrl = new AbortController();
    const onOuterAbort = () => ctrl.abort(req.signal?.reason);
    if (req.signal?.aborted) ctrl.abort(req.signal.reason);
    req.signal?.addEventListener('abort', onOuterAbort, { once: true });
    let idleTimer: NodeJS.Timeout | undefined;
    const armIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => ctrl.abort(new IdleTimeout()), this.opts.timeoutMs);
    };

    let attempts = 0;
    // Set while events stream in (TypeScript cannot see the assignments in the loop).
    let usage = null as Usage | null;
    let output = '';
    let finished = false;
    try {
      const body = { ...toRequestBody(req), stream: true };
      let finishReason: FinishReason = 'unknown';
      let calls: ToolCall[] = [];
      // An error event before anything reached the caller (e.g. overloaded) is retried like a
      // failed connection; after that, retrying would duplicate output.
      for (let round = 1; ; round++) {
        const result = await withRetry(
          () => this.call('POST', '/v1/messages', body, ctrl.signal),
          this.classify,
          { maxRetries: this.opts.maxRetries, signal: ctrl.signal, ...this.retryTiming() },
        ).catch((raw: unknown) => {
          const err = this.classify(raw);
          err.attempts += attempts;
          throw err;
        });
        attempts += result.attempts;
        let delivered = false;
        const blocks = new Map<number, { id: string; name: string; json: string }>();
        try {
          armIdleTimer();
          for await (const ev of readEvents(result.value.body!, ctrl.signal)) {
            armIdleTimer();
            const data = ev.data as WireEvent;
            switch (data.type) {
              case 'message_start': {
                const u = data.message?.usage;
                if (u) usage = { ...inputUsage(u), outputTokens: null };
                break;
              }
              case 'content_block_start': {
                const b = data.content_block;
                if (b?.type === 'tool_use' && data.index !== undefined)
                  blocks.set(data.index, { id: b.id ?? '', name: b.name ?? '', json: '' });
                break;
              }
              case 'content_block_delta': {
                const d = data.delta;
                if (d?.type === 'text_delta' && d.text) {
                  delivered = true;
                  output += d.text;
                  yield { type: 'text', delta: d.text };
                } else if (d?.type === 'input_json_delta' && typeof d.partial_json === 'string') {
                  delivered = true;
                  const b = data.index !== undefined ? blocks.get(data.index) : undefined;
                  if (b) b.json += d.partial_json;
                }
                // Thinking deltas are deliberately ignored: hidden reasoning is not shown or stored.
                break;
              }
              case 'message_delta': {
                if (data.delta?.stop_reason) finishReason = mapStopReason(data.delta.stop_reason);
                const out = data.usage?.output_tokens;
                if (typeof out === 'number')
                  usage = { ...(usage ?? { inputTokens: null }), outputTokens: out };
                break;
              }
              case 'error':
                throw new ApiFailure(0, data.error?.type ?? '', data.error?.message ?? '', null);
              default:
                break;
            }
          }
          calls = [...blocks.entries()]
            .sort(([a], [b]) => a - b)
            .map(([, b]) => toToolCall(b.id, b.name, b.json));
          break;
        } catch (raw) {
          if (ctrl.signal.aborted || delivered) throw raw;
          const err = this.classify(raw);
          if (!err.retryable || round > this.opts.maxRetries) {
            err.attempts = attempts;
            throw err;
          }
          clearTimeout(idleTimer);
          await abortableSleep(retryDelay(round, err, this.retryTiming()), ctrl.signal);
        }
      }
      clearTimeout(idleTimer);
      if (ctrl.signal.aborted) throw new ProviderError('cancelled');
      for (const call of calls) yield { type: 'tool_call', call };
      if (calls.length > 0) finishReason = 'tool_calls';
      finished = true;
      for (const call of calls) output += call.name + call.argumentsJson;
      this.record(req, started, { attempts, usage, output });
      yield { type: 'finish', finishReason, usage };
    } catch (raw) {
      const err =
        ctrl.signal.reason instanceof IdleTimeout
          ? new ProviderError('timeout', `no data received for ${this.opts.timeoutMs} ms`, {
              source: ANTHROPIC,
            })
          : req.signal?.aborted
            ? new ProviderError('cancelled')
            : this.classify(raw);
      this.record(req, started, {
        error: err,
        attempts: Math.max(attempts, err.attempts, 1),
        usage,
      });
      throw err;
    } finally {
      clearTimeout(idleTimer);
      req.signal?.removeEventListener('abort', onOuterAbort);
      if (!finished && !ctrl.signal.aborted) ctrl.abort();
    }
  }

  async complete(req: ChatRequest): Promise<CompletionResult> {
    const started = Date.now();
    try {
      const { value, attempts } = await withRetry(
        async () =>
          (await this.call('POST', '/v1/messages', toRequestBody(req), req.signal)).json(),
        this.classify,
        { maxRetries: this.opts.maxRetries, signal: req.signal, ...this.retryTiming() },
      );
      const parsed = messageSchema.safeParse(value);
      if (!parsed.success)
        throw new ProviderError('malformed', 'unexpected message format', { source: ANTHROPIC });
      const text = parsed.data.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('');
      const toolCalls = parsed.data.content
        .filter((b) => b.type === 'tool_use')
        .map((b) => toToolCall(b.id, b.name ?? '', JSON.stringify(b.input ?? {})));
      const u = parsed.data.usage as Record<string, unknown> | null | undefined;
      const usage: Usage | null = u
        ? {
            ...inputUsage(u),
            outputTokens: typeof u['output_tokens'] === 'number' ? u['output_tokens'] : null,
          }
        : null;
      this.record(req, started, {
        attempts,
        usage,
        output: text + toolCalls.map((c) => c.name + c.argumentsJson).join(''),
      });
      return {
        text,
        toolCalls,
        finishReason:
          toolCalls.length > 0 ? 'tool_calls' : mapStopReason(parsed.data.stop_reason ?? null),
        usage,
      };
    } catch (raw) {
      const err = this.classify(raw);
      this.record(req, started, { error: err, attempts: err.attempts, usage: null });
      throw err;
    }
  }
}

/** Input tokens including the cached part (written to or read from the prompt cache). */
function inputUsage(u: Record<string, unknown>): Omit<Usage, 'outputTokens'> {
  const n = (k: string) => (typeof u[k] === 'number' ? (u[k] as number) : 0);
  if (typeof u['input_tokens'] !== 'number') return { inputTokens: null };
  return {
    inputTokens:
      n('input_tokens') + n('cache_creation_input_tokens') + n('cache_read_input_tokens'),
    cachedInputTokens: n('cache_read_input_tokens'),
    cacheWriteTokens: n('cache_creation_input_tokens'),
  };
}

/** Server-sent events from a fetch body: `event:` and `data:` lines, blocks split by blank lines. */
async function* readEvents(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<{ event: string; data: unknown }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const onAbort = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (signal.aborted) return;
      if (value) buffer += decoder.decode(value, { stream: true });
      let split: number;
      while ((split = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const raw = buffer.slice(0, split);
        buffer = buffer.slice(split + (buffer[split] === '\r' ? 4 : 2));
        let event = 'message';
        const data: string[] = [];
        for (const line of raw.split(/\r?\n/)) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
        }
        if (!data.length) continue;
        yield { event, data: JSON.parse(data.join('\n')) };
      }
      if (done) return;
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

function toRequestBody(req: ChatRequest): Record<string, unknown> {
  const model = req.model.startsWith(ANTHROPIC_PREFIX)
    ? req.model.slice(ANTHROPIC_PREFIX.length)
    : req.model;
  const system = req.messages
    .filter((m): m is Extract<ChatMessage, { role: 'system' }> => m.role === 'system')
    .map((m) => m.content)
    .filter(Boolean)
    .join('\n\n');
  const messages = toWireMessages(req.messages, req.stablePrefix);
  // Prompt caching: the tools, the system prompt and the conversation so far are reused by the
  // next turn of the same run, so mark the end of each as a cache breakpoint.
  const lastBlock = messages.at(-1)?.content.at(-1);
  if (lastBlock && lastBlock.type !== 'image') lastBlock.cache_control = { type: 'ephemeral' };
  const tools = (req.tools ?? []).map((t, i, all) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
    ...(i === all.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}),
  }));
  return {
    model,
    max_tokens: req.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
    messages,
    ...(system
      ? { system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] }
      : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(tools.length
      ? {
          tools,
          ...(req.toolChoice
            ? {
                tool_choice:
                  typeof req.toolChoice === 'object'
                    ? { type: 'tool', name: req.toolChoice.name }
                    : { type: req.toolChoice === 'required' ? 'any' : req.toolChoice },
              }
            : {}),
        }
      : {}),
  };
}

/**
 * Chat messages to Messages API turns: tool results are user turns, consecutive turns of one
 * role are merged (the API requires them to alternate), and empty text is left out.
 */
/**
 * `stablePrefix` messages from the start stay the same for several requests (see
 * ChatRequest.stablePrefix): the block ending them gets a cache breakpoint of its own.
 */
function toWireMessages(messages: ChatMessage[], stablePrefix?: number): WireMessage[] {
  const out: WireMessage[] = [];
  const push = (role: WireMessage['role'], content: Block[]) => {
    if (!content.length) return;
    const last = out.at(-1);
    if (last?.role === role) last.content.push(...content);
    else out.push({ role, content });
  };
  for (const [i, m] of messages.entries()) {
    switch (m.role) {
      case 'system':
        break;
      case 'user':
        push('user', [
          ...(m.images ?? []).map((img): Block => ({
            type: 'image',
            source: { type: 'base64', media_type: img.mime, data: img.base64 },
          })),
          ...(m.content.trim() ? [{ type: 'text' as const, text: m.content }] : []),
        ]);
        break;
      case 'assistant':
        push('assistant', [
          ...(m.content?.trim() ? [{ type: 'text' as const, text: m.content }] : []),
          ...(m.toolCalls ?? []).map((c): Block => ({
            type: 'tool_use',
            id: c.id,
            name: c.name,
            input: parseInput(c),
          })),
        ]);
        break;
      case 'tool':
        push('user', [
          { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content || '(no output)' },
        ]);
        break;
    }
    if (i === (stablePrefix ?? 0) - 1) {
      const block = out.at(-1)?.content.at(-1);
      if (block && block.type !== 'image') block.cache_control = { type: 'ephemeral' };
    }
  }
  return out;
}

/** Tool input must be an object; arguments that aren't (already refused by Friday) send {}. */
function parseInput(c: ToolCall): unknown {
  try {
    const v: unknown = JSON.parse(c.argumentsJson || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function toToolCall(id: string | undefined, name: string, json: string): ToolCall {
  if (!name)
    throw new ProviderError('malformed', 'tool call without a name', { source: ANTHROPIC });
  return {
    id: id || `toolu_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
    name,
    argumentsJson: json.trim() ? json : '{}',
  };
}

function mapStopReason(reason: string | null): FinishReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
    case 'pause_turn':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'refusal':
      return 'content_filter';
    default:
      return 'unknown';
  }
}

/** Anthropic's error types and HTTP statuses to Friday's error kinds. */
export function classifyAnthropicError(err: unknown, redactor: Redactor): ProviderError {
  if (err instanceof ProviderError) return err;
  const E = (
    kind: ConstructorParameters<typeof ProviderError>[0],
    detail?: string | null,
    opts: { status?: number | null; retryAfterMs?: number | null; cause?: unknown } = {},
  ) => new ProviderError(kind, detail, { ...opts, source: ANTHROPIC });

  if (err instanceof ApiFailure) {
    const status = err.status || null;
    const detail = redactor
      .redact(withoutKeyHints(err.message || err.errorType || `HTTP ${status ?? '?'}`))
      .slice(0, 300);
    const retryAfterMs = parseRetryAfter(err.headers ?? undefined);
    const opts = { status, retryAfterMs, cause: err };
    switch (err.errorType || String(status)) {
      case 'authentication_error':
      case '401':
        return E('auth', detail, opts);
      case 'permission_error':
      case '403':
        return E(QUOTA_HINT.test(err.message) ? 'quota' : 'permission', detail, opts);
      case 'not_found_error':
      case '404':
        return E(/model/i.test(err.message) ? 'model_not_found' : 'bad_request', detail, opts);
      case 'rate_limit_error':
      case '429':
        return E('rate_limit', detail, opts);
      case 'overloaded_error':
      case '529':
        return E('upstream', detail, {
          ...opts,
          retryAfterMs: Math.max(retryAfterMs ?? 0, UPSTREAM_RETRY_MS),
        });
      case 'api_error':
      case 'timeout_error':
        return E(err.errorType === 'timeout_error' ? 'timeout' : 'server', detail, opts);
      case 'billing_error':
        return E('quota', detail, opts);
      default:
        if (QUOTA_HINT.test(err.message)) return E('quota', detail, opts);
        if (status !== null && status >= 500) return E('server', detail, opts);
        if (/model/i.test(err.message) && /not (found|exist|available)|invalid/i.test(err.message))
          return E('model_not_found', detail, opts);
        if (/not support|unsupported/i.test(err.message)) return E('unsupported', detail, opts);
        return E(status === 413 || status === 400 ? 'bad_request' : 'unknown', detail, opts);
    }
  }
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError'))
    return E(err.name === 'TimeoutError' ? 'timeout' : 'cancelled');
  if (err instanceof SyntaxError)
    return E('malformed', redactor.redact(err.message), { cause: err });
  if (err instanceof TypeError)
    // fetch reports network failures as TypeError("fetch failed") with the reason as cause.
    return E(
      'network',
      redactor.redact(err.cause instanceof Error ? err.cause.message : err.message),
      { cause: err },
    );
  const message = err instanceof Error ? err.message : String(err);
  return E('unknown', redactor.redact(message).slice(0, 300), { cause: err });
}
