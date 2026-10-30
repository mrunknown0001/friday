import { randomUUID } from 'node:crypto';
import OpenAI from 'openai';
import type {
  ChatCompletionChunk,
  ChatCompletionCreateParamsBase,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';
import { z } from 'zod';
import type { Redactor } from '../security/redact.js';
import { classifyError, ProviderError } from './errors.js';
import { withRetry } from './retry.js';
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

export interface NoTokenLimitOptions {
  apiKey: string | null;
  baseUrl: string;
  timeoutMs: number;
  maxRetries: number;
  redactor: Redactor;
  recorder?: ProviderCallRecorder;
  /** Injected in tests to serve canned HTTP responses through the real SDK. */
  fetch?: typeof fetch;
  retryBaseDelayMs?: number;
}

const modelListSchema = z.object({
  data: z.array(
    z.looseObject({
      id: z.string().min(1),
      name: z.string().optional(),
      description: z.string().optional(),
      tier: z.string().optional(),
    }),
  ),
});

const completionSchema = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullish(),
        message: z.object({
          content: z.string().nullish(),
          tool_calls: z
            .array(
              z.object({
                id: z.string().nullish(),
                function: z.object({ name: z.string(), arguments: z.string().nullish() }),
              }),
            )
            .nullish(),
        }),
      }),
    )
    .min(1),
  usage: z
    .object({ prompt_tokens: z.number().nullish(), completion_tokens: z.number().nullish() })
    .nullish(),
});

/** Marker used as the abort reason when our own idle timer fires. */
class IdleTimeout extends Error {}

export class NoTokenLimitProvider implements LLMProvider {
  readonly id = 'notokenlimit';
  /** Measured 2026-10-29: a ~60-token request was billed as ~1,180 prompt tokens. */
  readonly promptOverheadTokens = 1_500;
  private readonly client: OpenAI | null;

  constructor(private readonly opts: NoTokenLimitOptions) {
    this.client = opts.apiKey
      ? new OpenAI({
          apiKey: opts.apiKey,
          baseURL: opts.baseUrl,
          timeout: opts.timeoutMs,
          // Retries are handled by withRetry so only transient errors are retried.
          maxRetries: 0,
          ...(opts.fetch ? { fetch: opts.fetch } : {}),
        })
      : null;
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  private requireClient(): OpenAI {
    if (!this.client) throw new ProviderError('not_configured');
    return this.client;
  }

  private classify = (err: unknown) => classifyError(err, this.opts.redactor);

  private retryOpts(signal?: AbortSignal) {
    return {
      maxRetries: this.opts.maxRetries,
      signal,
      ...(this.opts.retryBaseDelayMs !== undefined
        ? { baseDelayMs: this.opts.retryBaseDelayMs }
        : {}),
    };
  }

  private record(
    req: Pick<ChatRequest, 'model' | 'operation' | 'sessionId'> &
      Partial<Pick<ChatRequest, 'messages' | 'tools'>>,
    started: number,
    outcome: {
      error?: ProviderError;
      attempts: number;
      usage: Usage | null;
      /** The reply's text and tool calls, to estimate tokens the provider did not report. */
      output?: string;
    },
  ) {
    // NoTokenLimit reports no usage on streamed replies; estimate what a finished call used.
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
    });
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const client = this.requireClient();
    const started = Date.now();
    try {
      const { value, attempts } = await withRetry(
        () => client.get('/models', signal ? { signal } : {}),
        this.classify,
        this.retryOpts(signal),
      );
      const parsed = modelListSchema.safeParse(value);
      if (!parsed.success) throw new ProviderError('malformed', 'unexpected model list format');
      this.record({ model: '-', operation: 'list_models' }, started, { attempts, usage: null });
      return parsed.data.data.map((m) => ({
        id: m.id,
        ...(m.name ? { name: m.name } : {}),
        ...(m.description ? { description: m.description } : {}),
        ...(m.tier ? { tier: m.tier } : {}),
      }));
    } catch (raw) {
      const err = this.classify(raw);
      this.record({ model: '-', operation: 'list_models' }, started, {
        error: err,
        attempts: err.attempts,
        usage: null,
      });
      throw err;
    }
  }

  async *streamChat(req: ChatRequest): AsyncGenerator<StreamEvent, void, undefined> {
    const client = this.requireClient();
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

    let attempts = 1;
    let usage: Usage | null = null;
    let finished = false;
    let output = '';
    try {
      const body = {
        ...toRequestBody(req),
        stream: true as const,
        stream_options: { include_usage: true },
      };
      const result = await withRetry(
        () => client.chat.completions.create(body, { signal: ctrl.signal }),
        this.classify,
        this.retryOpts(ctrl.signal),
      );
      attempts = result.attempts;

      armIdleTimer();
      const tools = new ToolCallAccumulator();
      let finishReason: FinishReason = 'unknown';
      for await (const chunk of result.value as AsyncIterable<ChatCompletionChunk>) {
        armIdleTimer();
        if (!chunk || typeof chunk !== 'object')
          throw new ProviderError('malformed', 'invalid stream chunk');
        if (chunk.usage) usage = toUsage(chunk.usage);
        const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
        if (!choice) continue;
        const delta = choice.delta ?? {};
        // Reasoning fields (e.g. `reasoning_content`) are deliberately ignored: hidden reasoning
        // is not shown to users or stored.
        if (typeof delta.content === 'string' && delta.content.length > 0) {
          output += delta.content;
          yield { type: 'text', delta: delta.content };
        }
        if (Array.isArray(delta.tool_calls)) tools.add(delta.tool_calls);
        if (choice.finish_reason) finishReason = mapFinishReason(choice.finish_reason);
      }
      clearTimeout(idleTimer);
      // The SDK ends iteration silently on abort; never report an aborted stream as finished.
      if (ctrl.signal.aborted) throw new ProviderError('cancelled');

      const calls = tools.finalize();
      for (const call of calls) yield { type: 'tool_call', call };
      if (calls.length > 0) finishReason = 'tool_calls';
      finished = true;
      for (const call of calls) output += call.name + call.argumentsJson;
      this.record(req, started, { attempts, usage, output });
      yield { type: 'finish', finishReason, usage };
    } catch (raw) {
      const err =
        ctrl.signal.reason instanceof IdleTimeout
          ? new ProviderError('timeout', `no data received for ${this.opts.timeoutMs} ms`)
          : req.signal?.aborted
            ? new ProviderError('cancelled')
            : this.classify(raw);
      this.record(req, started, { error: err, attempts: Math.max(attempts, err.attempts), usage });
      throw err;
    } finally {
      clearTimeout(idleTimer);
      req.signal?.removeEventListener('abort', onOuterAbort);
      // If the consumer stopped early, close the HTTP stream.
      if (!finished && !ctrl.signal.aborted) ctrl.abort();
    }
  }

  async complete(req: ChatRequest): Promise<CompletionResult> {
    const client = this.requireClient();
    const started = Date.now();
    try {
      const { value, attempts } = await withRetry(
        () =>
          client.chat.completions.create(
            { ...toRequestBody(req), stream: false },
            req.signal ? { signal: req.signal } : {},
          ),
        this.classify,
        this.retryOpts(req.signal),
      );
      const parsed = completionSchema.safeParse(value);
      if (!parsed.success) throw new ProviderError('malformed', 'unexpected completion format');
      const choice = parsed.data.choices[0]!;
      const toolCalls = (choice.message.tool_calls ?? []).map((tc) =>
        normalizeToolCall(tc.id, tc.function.name, tc.function.arguments),
      );
      const usage = parsed.data.usage ? toUsage(parsed.data.usage) : null;
      const output =
        (choice.message.content ?? '') + toolCalls.map((c) => c.name + c.argumentsJson).join('');
      this.record(req, started, { attempts, usage, output });
      return {
        text: choice.message.content ?? '',
        toolCalls,
        finishReason:
          toolCalls.length > 0 ? 'tool_calls' : mapFinishReason(choice.finish_reason ?? null),
        usage,
      };
    } catch (raw) {
      const err = this.classify(raw);
      this.record(req, started, { error: err, attempts: err.attempts, usage: null });
      throw err;
    }
  }
}

function toRequestBody(req: ChatRequest): ChatCompletionCreateParamsBase {
  const body: ChatCompletionCreateParamsBase = {
    model: req.model,
    messages: req.messages.map(toWireMessage),
  };
  if (req.maxOutputTokens !== undefined) body.max_tokens = req.maxOutputTokens;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    if (req.toolChoice) {
      body.tool_choice =
        typeof req.toolChoice === 'string'
          ? req.toolChoice
          : { type: 'function', function: { name: req.toolChoice.name } };
    }
  }
  return body;
}

function toWireMessage(m: ChatMessage): ChatCompletionMessageParam {
  switch (m.role) {
    case 'system':
      return { role: m.role, content: m.content };
    case 'user':
      return m.images?.length
        ? {
            role: 'user',
            content: [
              // Some backends reject empty text blocks (an image sent without words).
              ...(m.content ? [{ type: 'text' as const, text: m.content }] : []),
              ...m.images.map((img) => ({
                type: 'image_url' as const,
                image_url: { url: `data:${img.mime};base64,${img.base64}` },
              })),
            ],
          }
        : { role: 'user', content: m.content };
    case 'tool':
      return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    case 'assistant':
      return m.toolCalls && m.toolCalls.length > 0
        ? {
            role: 'assistant',
            content: m.content,
            tool_calls: m.toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: { name: tc.name, arguments: tc.argumentsJson },
            })),
          }
        : { role: 'assistant', content: m.content ?? '' };
  }
}

function toUsage(u: { prompt_tokens?: number | null; completion_tokens?: number | null }): Usage {
  return {
    inputTokens: typeof u.prompt_tokens === 'number' ? u.prompt_tokens : null,
    outputTokens: typeof u.completion_tokens === 'number' ? u.completion_tokens : null,
  };
}

function mapFinishReason(reason: string | null): FinishReason {
  switch (reason) {
    case 'stop':
    case 'end_turn':
      return 'stop';
    case 'length':
    case 'max_tokens':
      return 'length';
    case 'tool_calls':
    case 'function_call':
    case 'tool_use':
      return 'tool_calls';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'unknown';
  }
}

function normalizeToolCall(
  id: string | null | undefined,
  name: string,
  args: string | null | undefined,
): ToolCall {
  if (!name) throw new ProviderError('malformed', 'tool call without a function name');
  return {
    id: id || `call_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
    name,
    argumentsJson: args && args.trim() ? args : '{}',
  };
}

type ToolCallDelta = NonNullable<
  ChatCompletionChunk['choices'][number]['delta']['tool_calls']
>[number];

/** Reassembles tool calls whose name/arguments arrive split across stream chunks. */
export class ToolCallAccumulator {
  private readonly calls = new Map<number, { id: string | null; name: string; args: string }>();

  add(deltas: ToolCallDelta[]): void {
    for (const d of deltas) {
      const index = this.resolveIndex(d);
      const entry = this.calls.get(index) ?? { id: null, name: '', args: '' };
      if (d.id && !entry.id) entry.id = d.id;
      const name = d.function?.name;
      if (name) entry.name = !entry.name || entry.name === name ? name : entry.name + name;
      if (typeof d.function?.arguments === 'string') entry.args += d.function.arguments;
      this.calls.set(index, entry);
    }
  }

  private resolveIndex(d: ToolCallDelta): number {
    if (typeof d.index === 'number') return d.index;
    // Some OpenAI-compatible backends omit `index`; a new id starts a new call.
    const known = [...this.calls.entries()].find(([, c]) => d.id && c.id === d.id);
    if (known) return known[0];
    if (d.id || this.calls.size === 0) return this.calls.size;
    return this.calls.size - 1;
  }

  finalize(): ToolCall[] {
    return [...this.calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, c]) => normalizeToolCall(c.id, c.name, c.args));
  }
}
