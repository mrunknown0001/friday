import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { classifyError, ProviderError } from '../src/providers/errors.js';
import { NoTokenLimitProvider, ToolCallAccumulator } from '../src/providers/notokenlimit.js';
import { withRetry } from '../src/providers/retry.js';
import type { ProviderCallRecord, StreamEvent } from '../src/providers/types.js';
import { Redactor } from '../src/security/redact.js';
import {
  jsonResponse,
  mockFetch,
  sseResponse,
  TEST_KEY,
  textChunks,
  type MockHandler,
} from './helpers.js';

function makeProvider(
  handlers: MockHandler[],
  opts: { timeoutMs?: number; maxRetries?: number; apiKey?: string | null } = {},
) {
  const mock = mockFetch(handlers);
  const records: ProviderCallRecord[] = [];
  const provider = new NoTokenLimitProvider({
    apiKey: opts.apiKey === undefined ? TEST_KEY : opts.apiKey,
    baseUrl: 'https://ntl.test/api/v1',
    timeoutMs: opts.timeoutMs ?? 5_000,
    maxRetries: opts.maxRetries ?? 2,
    redactor: new Redactor([TEST_KEY]),
    recorder: (r) => records.push(r),
    fetch: mock.fetch,
    retryBaseDelayMs: 1,
    retryMaxDelayMs: 5,
  });
  return { provider, calls: mock.calls, records };
}

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

const req = { model: 'm1', messages: [{ role: 'user' as const, content: 'hi' }] };

describe('NoTokenLimitProvider', () => {
  it('is not configured without an API key and fails clearly', async () => {
    const { provider, calls } = makeProvider([], { apiKey: null });
    expect(provider.isConfigured()).toBe(false);
    await expect(collect(provider.streamChat(req))).rejects.toMatchObject({
      kind: 'not_configured',
    });
    expect(calls).toHaveLength(0);
  });

  it('streams text, reports usage, and sends the expected request', async () => {
    const { provider, calls, records } = makeProvider([
      (_c, signal) => sseResponse(textChunks(['Hel', 'lo']), {}, signal),
    ]);
    const events = await collect(provider.streamChat({ ...req, maxOutputTokens: 100 }));
    expect(events).toEqual([
      { type: 'text', delta: 'Hel' },
      { type: 'text', delta: 'lo' },
      { type: 'finish', finishReason: 'stop', usage: { inputTokens: 11, outputTokens: 7 } },
    ]);
    expect(calls[0]!.url).toBe('https://ntl.test/api/v1/chat/completions');
    expect(calls[0]!.headers.get('authorization')).toBe(`Bearer ${TEST_KEY}`);
    expect(calls[0]!.body).toMatchObject({
      model: 'm1',
      stream: true,
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(records).toEqual([
      expect.objectContaining({
        model: 'm1',
        status: 'ok',
        attempts: 1,
        usage: { inputTokens: 11, outputTokens: 7 },
        tokensEstimated: false,
      }),
    ]);
  });

  it('records an estimate when a streamed reply reports no usage', async () => {
    // NoTokenLimit sends no usage chunk on streamed replies, even when asked to.
    const { provider, records } = makeProvider([
      (_c, signal) => sseResponse(textChunks(['Hello']).slice(0, -1), {}, signal),
      (_c, signal) => sseResponse(textChunks(['x']).slice(0, -1), {}, signal),
    ]);
    const events = await collect(provider.streamChat({ ...req, sessionId: 's1' }));
    // The run still sees that the provider reported nothing.
    expect(events.at(-1)).toEqual({ type: 'finish', finishReason: 'stop', usage: null });
    expect(records[0]).toMatchObject({
      sessionId: 's1',
      usage: { inputTokens: 7, outputTokens: 2 },
      tokensEstimated: true,
    });

    // A failed or cancelled call is not estimated.
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      collect(provider.streamChat({ ...req, signal: ctrl.signal })),
    ).rejects.toMatchObject({
      kind: 'cancelled',
    });
    expect(records[1]).toMatchObject({ status: 'cancelled', usage: null, tokensEstimated: false });
  });

  it('reassembles tool calls whose arguments are split across chunks', async () => {
    const chunk = (delta: unknown, finish: string | null = null) => ({
      id: 'c',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
    const { provider, calls } = makeProvider([
      (_c, s) =>
        sseResponse(
          [
            chunk({
              tool_calls: [
                {
                  index: 0,
                  id: 'call_a',
                  type: 'function',
                  function: { name: 'read_file', arguments: '' },
                },
              ],
            }),
            chunk({ tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }),
            chunk({
              tool_calls: [
                {
                  index: 1,
                  id: 'call_b',
                  type: 'function',
                  function: { name: 'list_dir', arguments: '{}' },
                },
              ],
            }),
            chunk({ tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] }),
            chunk({}, 'tool_calls'),
          ],
          {},
          s,
        ),
    ]);
    const events = await collect(
      provider.streamChat({
        ...req,
        tools: [{ name: 'read_file', description: 'Read', parameters: { type: 'object' } }],
        toolChoice: 'auto',
      }),
    );
    expect(events.filter((e) => e.type === 'tool_call')).toEqual([
      {
        type: 'tool_call',
        call: { id: 'call_a', name: 'read_file', argumentsJson: '{"path":"a.ts"}' },
      },
      { type: 'tool_call', call: { id: 'call_b', name: 'list_dir', argumentsJson: '{}' } },
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'finish', finishReason: 'tool_calls' });
    expect(calls[0]!.body).toMatchObject({
      tools: [{ type: 'function', function: { name: 'read_file' } }],
      tool_choice: 'auto',
    });
  });

  it('sends assistant tool calls and tool results in OpenAI wire format', async () => {
    const { provider, calls } = makeProvider([(_c, s) => sseResponse(textChunks(['done']), {}, s)]);
    await collect(
      provider.streamChat({
        model: 'm1',
        messages: [
          { role: 'user', content: 'read it' },
          {
            role: 'assistant',
            content: null,
            toolCalls: [{ id: 'call_1', name: 'read_file', argumentsJson: '{"path":"a"}' }],
          },
          { role: 'tool', toolCallId: 'call_1', content: 'file body' },
        ],
      }),
    );
    expect((calls[0]!.body as { messages: unknown[] }).messages).toEqual([
      { role: 'user', content: 'read it' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"a"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'file body' },
    ]);
  });

  it('does not retry authentication errors and never leaks the key', async () => {
    const { provider, calls, records } = makeProvider([
      () =>
        jsonResponse(401, {
          error: {
            type: 'authentication_error',
            code: 'invalid_key',
            message: `Invalid API key ${TEST_KEY}`,
          },
        }),
    ]);
    const err = await collect(provider.streamChat(req)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe('auth');
    expect((err as ProviderError).message).not.toContain(TEST_KEY);
    expect(calls).toHaveLength(1);
    expect(records[0]).toMatchObject({ status: 'error', errorKind: 'auth', attempts: 1 });
  });

  it('retries rate limits with bounded attempts, then succeeds', async () => {
    const { provider, calls, records } = makeProvider([
      () =>
        jsonResponse(429, { error: { message: 'Too many requests' } }, { 'retry-after-ms': '1' }),
      () => jsonResponse(503, { error: { message: 'overloaded' } }),
      (_c, s) => sseResponse(textChunks(['ok']), {}, s),
    ]);
    const events = await collect(provider.streamChat(req));
    expect(events[0]).toEqual({ type: 'text', delta: 'ok' });
    expect(calls).toHaveLength(3);
    expect(records[0]).toMatchObject({ status: 'ok', attempts: 3 });
  });

  it('gives up after maxRetries transient failures', async () => {
    const { provider, calls } = makeProvider(
      [() => jsonResponse(500, { error: { message: 'boom' } })],
      { maxRetries: 2 },
    );
    await expect(collect(provider.streamChat(req))).rejects.toMatchObject({
      kind: 'server',
      attempts: 3,
    });
    expect(calls).toHaveLength(3);
  });

  it('treats quota exhaustion as non-retryable', async () => {
    const { provider, calls } = makeProvider([
      () =>
        jsonResponse(429, {
          error: { code: 'quota_exceeded', message: 'Daily quota exhausted for your plan' },
        }),
    ]);
    await expect(collect(provider.streamChat(req))).rejects.toMatchObject({
      kind: 'quota',
      retryable: false,
    });
    expect(calls).toHaveLength(1);
  });

  it('maps 402 to quota and unknown models to model_not_found', async () => {
    const a = makeProvider([() => jsonResponse(402, { error: { message: 'Payment required' } })]);
    await expect(a.provider.complete(req)).rejects.toMatchObject({ kind: 'quota' });
    const b = makeProvider([
      () => jsonResponse(404, { error: { message: 'model not found: m1' } }),
    ]);
    await expect(b.provider.complete(req)).rejects.toMatchObject({ kind: 'model_not_found' });
  });

  it('times out a stalled stream instead of hanging', async () => {
    const { provider } = makeProvider(
      [(_c, s) => sseResponse(textChunks(['partial']).slice(0, 1), { hang: true }, s)],
      {
        timeoutMs: 1_000,
        maxRetries: 0,
      },
    );
    const seen: StreamEvent[] = [];
    const err = await (async () => {
      for await (const e of provider.streamChat(req)) seen.push(e);
    })().catch((e: unknown) => e);
    expect(seen).toEqual([{ type: 'text', delta: 'partial' }]);
    expect(err).toMatchObject({ kind: 'timeout' });
  });

  it('reports cancellation when the caller aborts mid-stream', async () => {
    const { provider, records } = makeProvider([
      (_c, s) => sseResponse(textChunks(['a', 'b', 'c', 'd']), { delayMs: 30 }, s),
    ]);
    const ctrl = new AbortController();
    const seen: string[] = [];
    const err = await (async () => {
      for await (const e of provider.streamChat({ ...req, signal: ctrl.signal })) {
        if (e.type === 'text') {
          seen.push(e.delta);
          ctrl.abort();
        }
      }
    })().catch((e: unknown) => e);
    expect(seen).toEqual(['a']);
    expect(err).toMatchObject({ kind: 'cancelled' });
    expect(records[0]).toMatchObject({ status: 'cancelled' });
  });

  it('classifies malformed stream data', async () => {
    const { provider } = makeProvider(
      [(_c, s) => sseResponse([], { rawTail: 'data: {not json\n\n' }, s)],
      { maxRetries: 0 },
    );
    await expect(collect(provider.streamChat(req))).rejects.toMatchObject({ kind: 'malformed' });
  });

  it('classifies errors embedded in the SSE stream', async () => {
    const { provider } = makeProvider(
      [(_c, s) => sseResponse([{ error: { message: 'Insufficient credits' } }], {}, s)],
      {
        maxRetries: 0,
      },
    );
    await expect(collect(provider.streamChat(req))).rejects.toMatchObject({ kind: 'quota' });
  });

  it('retries a stream that fails upstream before any output, then succeeds', async () => {
    const upstream = (s: AbortSignal | null) =>
      sseResponse(
        [
          { id: 'c1', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
          { error: { type: 'api_error', message: 'Upstream provider failed' } },
        ],
        {},
        s,
      );
    const { provider, calls, records } = makeProvider([
      (_c, s) => upstream(s),
      (_c, s) => sseResponse(textChunks(['ok']), {}, s),
    ]);
    const events = await collect(provider.streamChat(req));
    expect(events.filter((e) => e.type === 'text')).toEqual([{ type: 'text', delta: 'ok' }]);
    expect(calls).toHaveLength(2);
    expect(records[0]).toMatchObject({ status: 'ok', attempts: 2 });
  });

  it('reports a lasting upstream outage clearly, after retrying', async () => {
    const { provider, calls, records } = makeProvider(
      [
        (_c, s) =>
          sseResponse(
            [{ error: { type: 'api_error', message: 'Upstream provider failed' } }],
            {},
            s,
          ),
      ],
      { maxRetries: 2 },
    );
    const err = (await collect(provider.streamChat(req)).catch((e: unknown) => e)) as ProviderError;
    expect(err.kind).toBe('upstream');
    expect(err.retryable).toBe(true);
    expect(err.message).toBe(
      "NoTokenLimit couldn't get an answer from the model's provider. This is on NoTokenLimit's side: try again in a few minutes, or choose another model in Settings. (Upstream provider failed)",
    );
    expect(calls).toHaveLength(3);
    expect(records[0]).toMatchObject({ status: 'error', errorKind: 'upstream', attempts: 3 });
  });

  it('does not retry once text has reached the caller', async () => {
    const { provider, calls } = makeProvider([
      (_c, s) =>
        sseResponse(
          [
            ...textChunks(['Hel']).slice(0, 1),
            { error: { type: 'api_error', message: 'Upstream provider failed' } },
          ],
          {},
          s,
        ),
    ]);
    const seen: string[] = [];
    const err = await (async () => {
      for await (const e of provider.streamChat(req)) if (e.type === 'text') seen.push(e.delta);
    })().catch((e: unknown) => e);
    expect(seen).toEqual(['Hel']);
    expect(err).toMatchObject({ kind: 'upstream' });
    expect(calls).toHaveLength(1);
  });

  it('treats 502 and 504 as upstream outages and retries them', async () => {
    const { provider, calls } = makeProvider([
      () => new Response('error code: 502', { status: 502 }),
      () =>
        jsonResponse(200, {
          choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'pong' } }],
        }),
    ]);
    await expect(provider.complete(req)).resolves.toMatchObject({ text: 'pong' });
    expect(calls).toHaveLength(2);
    const redactor = new Redactor([]);
    const http = (status: number) =>
      classifyError(
        new OpenAI.APIError(status, { message: 'x' }, undefined, new Headers()),
        redactor,
      );
    expect([502, 504].map((s) => http(s).kind)).toEqual(['upstream', 'upstream']);
    expect([500, 503].map((s) => http(s).kind)).toEqual(['server', 'server']);
    expect(http(502).retryAfterMs).toBe(2_000);
  });

  it('validates non-streaming completions', async () => {
    const good = makeProvider([
      () =>
        jsonResponse(200, {
          choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'pong' } }],
          usage: { prompt_tokens: 3, completion_tokens: 1 },
        }),
    ]);
    await expect(good.provider.complete(req)).resolves.toEqual({
      text: 'pong',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 3, outputTokens: 1 },
    });
    const bad = makeProvider([() => jsonResponse(200, { choices: [] })]);
    await expect(bad.provider.complete(req)).rejects.toMatchObject({ kind: 'malformed' });
  });

  it('lists models and rejects unexpected formats', async () => {
    const ok = makeProvider([
      () =>
        jsonResponse(200, {
          object: 'list',
          data: [{ id: 'claude-opus-5', object: 'model', name: 'Opus', tier: 'high' }],
        }),
    ]);
    await expect(ok.provider.listModels()).resolves.toEqual([
      { id: 'claude-opus-5', name: 'Opus', tier: 'high' },
    ]);
    expect(ok.calls[0]!.url).toBe('https://ntl.test/api/v1/models');
    const bad = makeProvider([() => jsonResponse(200, { models: 'nope' })]);
    await expect(bad.provider.listModels()).rejects.toMatchObject({ kind: 'malformed' });
  });

  it('classifies network failures as retryable', async () => {
    const { provider, calls } = makeProvider(
      [
        () => {
          throw new TypeError('fetch failed');
        },
      ],
      { maxRetries: 1 },
    );
    await expect(provider.complete(req)).rejects.toMatchObject({
      kind: 'network',
      retryable: true,
    });
    expect(calls).toHaveLength(2);
  });
});

describe('ToolCallAccumulator', () => {
  it('handles backends that omit the index field', () => {
    const acc = new ToolCallAccumulator();
    acc.add([{ id: 'x', function: { name: 'a', arguments: '{"k":' } } as never]);
    acc.add([{ function: { arguments: '1}' } } as never]);
    acc.add([{ id: 'y', function: { name: 'b', arguments: '{}' } } as never]);
    expect(acc.finalize()).toEqual([
      { id: 'x', name: 'a', argumentsJson: '{"k":1}' },
      { id: 'y', name: 'b', argumentsJson: '{}' },
    ]);
  });

  it('rejects tool calls without a name and fills missing ids', () => {
    const noName = new ToolCallAccumulator();
    noName.add([{ index: 0, function: { arguments: '{}' } } as never]);
    expect(() => noName.finalize()).toThrow(ProviderError);
    const noId = new ToolCallAccumulator();
    noId.add([{ index: 0, function: { name: 'a' } } as never]);
    expect(noId.finalize()[0]).toMatchObject({
      name: 'a',
      argumentsJson: '{}',
      id: expect.stringMatching(/^call_/),
    });
  });
});

describe('withRetry', () => {
  const redactor = new Redactor();
  const classify = (e: unknown) => classifyError(e, redactor);

  it('honours retry-after but caps it and stops when aborted', async () => {
    const delays: number[] = [];
    const ctrl = new AbortController();
    let n = 0;
    const promise = withRetry(
      async () => {
        n++;
        if (n === 2) ctrl.abort();
        throw new ProviderError('rate_limit', null, { retryAfterMs: 999_999 });
      },
      classify,
      {
        maxRetries: 5,
        maxDelayMs: 50,
        signal: ctrl.signal,
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    );
    await expect(promise).rejects.toMatchObject({ kind: 'cancelled' });
    expect(delays).toEqual([50]);
    expect(n).toBe(2);
  });
});
