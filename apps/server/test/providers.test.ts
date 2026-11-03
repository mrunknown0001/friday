import type { ModelListDto, SettingsDto } from '@friday/shared';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { AnthropicProvider } from '../src/providers/anthropic.js';
import { assumedContextWindow } from '../src/providers/capabilities.js';
import { ProviderError } from '../src/providers/errors.js';
import {
  createProviders,
  isGeminiChatModel,
  isOpenAIChatModel,
  ProviderRouter,
} from '../src/providers/router.js';
import type { ProviderCallRecord, StreamEvent } from '../src/providers/types.js';
import { Redactor } from '../src/security/redact.js';
import {
  jsonResponse,
  mockFetch,
  sseResponse,
  testConfig,
  testServices,
  textChunks,
  type MockHandler,
} from './helpers.js';

const H = { host: '127.0.0.1:4317', 'x-friday-client': '1', 'content-type': 'application/json' };
const ANTHROPIC_KEY = 'sk-ant-api03-test-0123456789abcdefghij';
const OPENAI_KEY = 'sk-proj-test-0123456789abcdefghijklmn';
const OPENROUTER_KEY = 'sk-or-v1-test-0123456789abcdefghijklmn';

/** Anthropic's server-sent events, as the Messages API streams them. */
function anthropicStream(events: Array<Record<string, unknown>>, chunked = false): Response {
  const text = events
    .map((e) => `event: ${String(e['type'])}\ndata: ${JSON.stringify(e)}\n\n`)
    .join('');
  const encoder = new TextEncoder();
  // Split mid-event to check the parser joins chunks.
  const parts = chunked ? text.match(/[\s\S]{1,37}/g)! : [text];
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const p of parts) c.enqueue(encoder.encode(p));
        c.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

const TOOL_TURN = [
  {
    type: 'message_start',
    message: {
      usage: {
        input_tokens: 20,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 400,
        output_tokens: 1,
      },
    },
  },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Reading ' } },
  { type: 'ping' },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'it.' } },
  { type: 'content_block_stop', index: 0 },
  {
    type: 'content_block_start',
    index: 1,
    content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {} },
  },
  {
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'input_json_delta', partial_json: '{"pa' },
  },
  {
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'input_json_delta', partial_json: 'th":"a.ts"}' },
  },
  { type: 'content_block_stop', index: 1 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 31 } },
  { type: 'message_stop' },
];

function anthropic(handlers: MockHandler[], records: ProviderCallRecord[] = []) {
  const mock = mockFetch(handlers);
  const provider = new AnthropicProvider({
    apiKey: ANTHROPIC_KEY,
    timeoutMs: 5_000,
    maxRetries: 2,
    redactor: new Redactor([ANTHROPIC_KEY]),
    recorder: (r) => records.push(r),
    fetch: mock.fetch,
    retryBaseDelayMs: 1,
    retryMaxDelayMs: 5,
  });
  return { provider, calls: mock.calls, records };
}

async function collect(gen: AsyncGenerator<StreamEvent>) {
  const out: StreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe('Anthropic provider', () => {
  it('streams text and tool calls, and sends a well-formed Messages API request', async () => {
    const { provider, calls, records } = anthropic([() => anthropicStream(TOOL_TURN, true)]);
    const events = await collect(
      provider.streamChat({
        model: 'anthropic:claude-sonnet-4-6',
        operation: 'chat',
        sessionId: 's1',
        messages: [
          { role: 'system', content: 'You are Friday.' },
          { role: 'user', content: 'What is in a.ts?' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'toolu_0', name: 'list_directory', argumentsJson: '{"path":"."}' }],
          },
          { role: 'tool', toolCallId: 'toolu_0', content: 'a.ts' },
          {
            role: 'user',
            content: '',
            images: [{ mime: 'image/png', base64: 'iVBOR', width: 16, height: 16 }],
          },
        ],
        tools: [
          { name: 'list_directory', description: 'List', parameters: { type: 'object' } },
          { name: 'read_file', description: 'Read', parameters: { type: 'object' } },
        ],
        toolChoice: 'auto',
      }),
    );
    expect(events).toEqual([
      { type: 'text', delta: 'Reading ' },
      { type: 'text', delta: 'it.' },
      {
        type: 'tool_call',
        call: { id: 'toolu_1', name: 'read_file', argumentsJson: '{"path":"a.ts"}' },
      },
      {
        type: 'finish',
        finishReason: 'tool_calls',
        usage: {
          inputTokens: 520,
          outputTokens: 31,
          cachedInputTokens: 400,
          cacheWriteTokens: 100,
        },
      },
    ]);

    const call = calls[0]!;
    expect(call.url).toBe('https://api.anthropic.com/v1/messages');
    expect(call.headers.get('x-api-key')).toBe(ANTHROPIC_KEY);
    expect(call.headers.get('anthropic-version')).toBe('2023-06-01');
    expect(call.body).toEqual({
      model: 'claude-sonnet-4-6',
      max_tokens: 8192,
      stream: true,
      system: [{ type: 'text', text: 'You are Friday.', cache_control: { type: 'ephemeral' } }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'What is in a.ts?' }] },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_0', name: 'list_directory', input: { path: '.' } },
          ],
        },
        // The tool result and the image that follows are one user turn (turns must alternate).
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_0', content: 'a.ts' },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'iVBOR' },
            },
          ],
        },
      ],
      tools: [
        { name: 'list_directory', description: 'List', input_schema: { type: 'object' } },
        {
          name: 'read_file',
          description: 'Read',
          input_schema: { type: 'object' },
          cache_control: { type: 'ephemeral' },
        },
      ],
      tool_choice: { type: 'auto' },
    });
    expect(records).toEqual([
      expect.objectContaining({
        model: 'anthropic:claude-sonnet-4-6',
        operation: 'chat',
        sessionId: 's1',
        status: 'ok',
        usage: {
          inputTokens: 520,
          outputTokens: 31,
          cachedInputTokens: 400,
          cacheWriteTokens: 100,
        },
        tokensEstimated: false,
      }),
    ]);
  });

  it('marks the end of the settled history as a cache breakpoint of its own', async () => {
    const { provider, calls } = anthropic([() => anthropicStream(TOOL_TURN, true)]);
    await collect(
      provider.streamChat({
        model: 'anthropic:claude-sonnet-4-6',
        stablePrefix: 3,
        messages: [
          { role: 'system', content: 'You are Friday.' },
          { role: 'user', content: 'Fix a.ts' },
          {
            role: 'assistant',
            content: 'Reading it.',
            toolCalls: [{ id: 'toolu_0', name: 'read_file', argumentsJson: '{"path":"a.ts"}' }],
          },
          { role: 'tool', toolCallId: 'toolu_0', content: 'const a = 1;' },
        ],
      }),
    );
    const body = calls[0]!.body as { messages: Array<{ content: Array<Record<string, unknown>> }> };
    expect(body.messages[1]!.content).toEqual([
      { type: 'text', text: 'Reading it.' },
      {
        type: 'tool_use',
        id: 'toolu_0',
        name: 'read_file',
        input: { path: 'a.ts' },
        cache_control: { type: 'ephemeral' },
      },
    ]);
    // The latest message keeps its breakpoint too.
    expect(body.messages[2]!.content[0]).toMatchObject({ cache_control: { type: 'ephemeral' } });
  });

  it('completes without streaming, and lists models across pages', async () => {
    const { provider, calls } = anthropic([
      () =>
        jsonResponse(200, {
          content: [
            { type: 'text', text: 'pong' },
            { type: 'tool_use', id: 'toolu_9', name: 'update_plan', input: { steps: [] } },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 9, output_tokens: 3 },
        }),
      () =>
        jsonResponse(200, {
          data: [{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' }],
          has_more: true,
          last_id: 'claude-opus-5-5',
        }),
      () =>
        jsonResponse(200, {
          data: [{ id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5' }],
          has_more: false,
          last_id: 'claude-haiku-5-5',
        }),
    ]);
    const result = await provider.complete({
      model: 'anthropic:claude-opus-5-5',
      messages: [{ role: 'user', content: 'ping' }],
      maxOutputTokens: 16,
      toolChoice: 'required',
      tools: [{ name: 'update_plan', description: 'Plan', parameters: { type: 'object' } }],
    });
    expect(result).toEqual({
      text: 'pong',
      toolCalls: [{ id: 'toolu_9', name: 'update_plan', argumentsJson: '{"steps":[]}' }],
      finishReason: 'tool_calls',
      usage: { inputTokens: 9, outputTokens: 3, cachedInputTokens: 0, cacheWriteTokens: 0 },
    });
    expect(calls[0]!.body).toMatchObject({ max_tokens: 16, tool_choice: { type: 'any' } });
    expect(await provider.listModels()).toEqual([
      { id: 'anthropic:claude-opus-5-5', provider: 'anthropic', name: 'Claude Opus 5.5' },
      { id: 'anthropic:claude-haiku-5-5', provider: 'anthropic', name: 'Claude Haiku 5.5' },
    ]);
    expect(calls[2]!.url).toBe(
      'https://api.anthropic.com/v1/models?limit=1000&after_id=claude-opus-5-5',
    );
  });

  it('retries overload, names Anthropic in errors, and never shows the key', async () => {
    const overloaded = () =>
      jsonResponse(529, {
        type: 'error',
        error: { type: 'overloaded_error', message: 'Overloaded' },
      });
    const ok = () => anthropicStream(TOOL_TURN);
    const retried = anthropic([overloaded, ok]);
    const events = await collect(
      retried.provider.streamChat({
        model: 'anthropic:claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    expect(events.at(-1)).toMatchObject({ type: 'finish' });
    expect(retried.records[0]!.attempts).toBe(2);

    // An error event inside the stream, before any output, is retried too.
    const streamError = () =>
      anthropicStream([
        { type: 'message_start', message: { usage: { input_tokens: 1 } } },
        { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
      ]);
    const midStream = anthropic([streamError, ok]);
    await collect(
      midStream.provider.streamChat({
        model: 'anthropic:claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    expect(midStream.calls).toHaveLength(2);

    const cases: Array<[Response, string, string]> = [
      [
        jsonResponse(401, {
          type: 'error',
          error: { type: 'authentication_error', message: `invalid x-api-key ${ANTHROPIC_KEY}` },
        }),
        'auth',
        'Anthropic rejected the API key. Check ANTHROPIC_API_KEY.',
      ],
      [
        jsonResponse(400, {
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: 'Your credit balance is too low to access the Anthropic API.',
          },
        }),
        'quota',
        'Your Anthropic quota or credit is exhausted.',
      ],
      [
        jsonResponse(404, {
          type: 'error',
          error: { type: 'not_found_error', message: 'model: claude-nope' },
        }),
        'model_not_found',
        'The selected model is not available to your account.',
      ],
    ];
    for (const [response, kind, message] of cases) {
      const { provider } = anthropic([() => response]);
      const err = await provider
        .complete({ model: 'anthropic:claude-x', messages: [{ role: 'user', content: 'hi' }] })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).kind).toBe(kind);
      expect((err as ProviderError).message.startsWith(message)).toBe(true);
      expect((err as ProviderError).message).not.toContain(ANTHROPIC_KEY);
    }

    const offline = anthropic([
      () => {
        throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND') });
      },
    ]);
    const err = (await offline.provider
      .complete({ model: 'anthropic:claude-x', messages: [{ role: 'user', content: 'hi' }] })
      .catch((e: unknown) => e)) as ProviderError;
    expect(err.kind).toBe('network');
    expect(err.message).toBe('Could not reach Anthropic (network error). (getaddrinfo ENOTFOUND)');
  });
});

describe('provider router', () => {
  function router(handlers: Record<string, MockHandler>, keys: Partial<Record<string, string>>) {
    const config = testConfig({ apiKey: keys['notokenlimit'] ?? null });
    config.providers.anthropic.apiKey = keys['anthropic'] ?? null;
    config.providers.openai.apiKey = keys['openai'] ?? null;
    config.providers.openrouter.apiKey = keys['openrouter'] ?? null;
    const mock = mockFetch([
      (call, signal) => {
        const host = new URL(call.url).host;
        const handler = handlers[host];
        if (!handler) throw new Error(`unexpected request to ${host}`);
        return handler(call, signal);
      },
    ]);
    const records: ProviderCallRecord[] = [];
    const r = createProviders(config, {
      redactor: new Redactor([ANTHROPIC_KEY, OPENAI_KEY, OPENROUTER_KEY]),
      recorder: (x) => records.push(x),
      fetch: mock.fetch,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 5,
    });
    return { r, calls: mock.calls, records };
  }

  it('sends each model to its provider with the id that provider knows', async () => {
    const stream: MockHandler = (_c, signal) => sseResponse(textChunks(['ok']), {}, signal);
    const { r, calls, records } = router(
      {
        'ntl.test': stream,
        'api.openai.com': stream,
        'openrouter.ai': stream,
        'api.anthropic.com': () => anthropicStream(TOOL_TURN),
      },
      {
        notokenlimit: 'ntl-key',
        anthropic: ANTHROPIC_KEY,
        openai: OPENAI_KEY,
        openrouter: OPENROUTER_KEY,
      },
    );
    const ask = (model: string) =>
      collect(
        r.streamChat({ model, messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 50 }),
      );
    await ask('claude-opus-5.5');
    await ask('openai:gpt-5');
    await ask('openrouter:anthropic/claude-sonnet-4.6');
    await ask('anthropic:claude-sonnet-4-6');
    expect(
      calls.map((c) => [
        new URL(c.url).host + new URL(c.url).pathname,
        (c.body as { model: string }).model,
      ]),
    ).toEqual([
      ['ntl.test/api/v1/chat/completions', 'claude-opus-5.5'],
      ['api.openai.com/v1/chat/completions', 'gpt-5'],
      ['openrouter.ai/api/v1/chat/completions', 'anthropic/claude-sonnet-4.6'],
      ['api.anthropic.com/v1/messages', 'claude-sonnet-4-6'],
    ]);
    // OpenAI's current models take max_completion_tokens; the others take max_tokens.
    expect(calls[1]!.body).toMatchObject({ max_completion_tokens: 50 });
    expect(calls[1]!.body).not.toHaveProperty('max_tokens');
    expect(calls[2]!.body).toMatchObject({ max_tokens: 50 });
    expect(calls[1]!.headers.get('authorization')).toBe(`Bearer ${OPENAI_KEY}`);
    expect(calls[2]!.headers.get('authorization')).toBe(`Bearer ${OPENROUTER_KEY}`);
    expect(records.map((x) => x.model)).toEqual([
      'claude-opus-5.5',
      'openai:gpt-5',
      'openrouter:anthropic/claude-sonnet-4.6',
      'anthropic:claude-sonnet-4-6',
    ]);
    // NoTokenLimit's hidden prompt is budgeted for its models only.
    expect(r.overheadTokens('claude-opus-5.5')).toBe(1_500);
    expect(r.overheadTokens('anthropic:claude-opus-5-5')).toBe(0);
  });

  it('serves Gemini through its OpenAI-compatible API', async () => {
    const GEMINI_KEY = 'AIzaSyFridayTest0123456789abcdefghijklm';
    const config = testConfig({ apiKey: null });
    config.providers.gemini.apiKey = GEMINI_KEY;
    const mock = mockFetch([
      () =>
        jsonResponse(200, {
          object: 'list',
          data: [
            { id: 'models/gemini-2.5-pro', object: 'model', owned_by: 'google' },
            { id: 'models/text-embedding-004', object: 'model' },
            { id: 'models/imagen-4.0-generate-001', object: 'model' },
            { id: 'models/gemini-2.5-flash-preview-tts', object: 'model' },
            { id: 'models/gemma-3-27b-it', object: 'model' },
          ],
        }),
      (_c, signal) => sseResponse(textChunks(['hi']), {}, signal),
      // The chat endpoint answers errors with a list, as Google's API really does.
      () =>
        new Response(
          JSON.stringify([
            {
              error: {
                code: 400,
                message: 'Please pass a valid API key',
                status: 'INVALID_ARGUMENT',
              },
            },
          ]),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
    ]);
    const r = createProviders(config, {
      redactor: new Redactor([GEMINI_KEY]),
      recorder: () => {},
      fetch: mock.fetch,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 5,
    });
    expect((await r.listAll()).models).toEqual([
      { id: 'gemini:gemini-2.5-pro', provider: 'gemini' },
      { id: 'gemini:gemma-3-27b-it', provider: 'gemini' },
    ]);
    const events = await collect(
      r.streamChat({
        model: 'gemini:gemini-2.5-pro',
        messages: [{ role: 'user', content: 'hi' }],
        maxOutputTokens: 64,
      }),
    );
    expect(events[0]).toEqual({ type: 'text', delta: 'hi' });
    const chat = mock.calls[1]!;
    expect(chat.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    );
    expect(chat.body).toMatchObject({ model: 'gemini-2.5-pro', max_tokens: 64 });
    expect(chat.headers.get('authorization')).toBe(`Bearer ${GEMINI_KEY}`);

    const err = (await r
      .complete({ model: 'gemini:gemini-2.5-pro', messages: [{ role: 'user', content: 'hi' }] })
      .catch((e: unknown) => e)) as ProviderError;
    expect(err.kind).toBe('auth');
    expect(err.message).toBe(
      'Gemini rejected the API key. Check GEMINI_API_KEY. (Please pass a valid API key)',
    );
    expect(r.statuses().find((x) => x.id === 'gemini')).toEqual({
      id: 'gemini',
      label: 'Gemini',
      configured: true,
      envVar: 'GEMINI_API_KEY',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    });
    expect(isGeminiChatModel('gemini-2.5-flash-image')).toBe(false);
    expect(assumedContextWindow('gemini:gemini-2.5-pro')).toBe(900_000);
  });

  it('calls a provider at the address set in .env', async () => {
    const config = testConfig({ apiKey: null });
    config.providers.anthropic = { apiKey: ANTHROPIC_KEY, baseUrl: 'https://proxy.test/anthropic' };
    config.providers.openai = { apiKey: OPENAI_KEY, baseUrl: 'http://127.0.0.1:11434/v1' };
    const mock = mockFetch([
      (call, signal) =>
        call.url.startsWith('https://proxy.test/')
          ? anthropicStream(TOOL_TURN)
          : call.url.endsWith('/models')
            ? jsonResponse(200, { data: [{ id: 'llama3', object: 'model' }] })
            : sseResponse(textChunks(['ok']), {}, signal),
    ]);
    const r = createProviders(config, {
      redactor: new Redactor([ANTHROPIC_KEY, OPENAI_KEY]),
      recorder: () => {},
      fetch: mock.fetch,
    });
    const msg = [{ role: 'user' as const, content: 'hi' }];
    await collect(r.streamChat({ model: 'anthropic:claude-sonnet-4-6', messages: msg }));
    await collect(r.streamChat({ model: 'openai:llama3', messages: msg }));
    expect(mock.calls.map((c) => c.url)).toEqual([
      'https://proxy.test/anthropic/v1/messages',
      'http://127.0.0.1:11434/v1/chat/completions',
    ]);
    expect(r.statuses().find((x) => x.id === 'anthropic')!.baseUrl).toBe(
      'https://proxy.test/anthropic',
    );
    // Only OpenAI's own list is narrowed to its chat models.
    const openai = (await r.listAll()).models.filter((m) => m.provider === 'openai');
    expect(openai).toEqual([{ id: 'openai:llama3', provider: 'openai' }]);
  });

  it('lists every configured provider, reports one that fails, and skips the others', async () => {
    const { r, calls } = router(
      {
        'api.openai.com': () =>
          jsonResponse(200, {
            data: [
              { id: 'gpt-5', object: 'model' },
              { id: 'text-embedding-3-large', object: 'model' },
              { id: 'o4-mini', object: 'model' },
              { id: 'gpt-image-1', object: 'model' },
            ],
          }),
        'openrouter.ai': () =>
          jsonResponse(401, {
            error: {
              message: `bad key ${OPENROUTER_KEY}, shown as sk-or-v1-***************mn`,
              code: 401,
            },
          }),
      },
      { openai: OPENAI_KEY, openrouter: OPENROUTER_KEY },
    );
    const list = await r.listAll();
    expect(list.models).toEqual([
      { id: 'openai:gpt-5', provider: 'openai' },
      { id: 'openai:o4-mini', provider: 'openai' },
    ]);
    expect(list.errors).toEqual([
      {
        provider: 'openrouter',
        message:
          'OpenRouter rejected the API key. Check OPENROUTER_API_KEY. (bad key [REDACTED], shown as [REDACTED])',
      },
    ]);
    // Providers without a key are never called.
    expect(calls.map((c) => new URL(c.url).host).sort()).toEqual([
      'api.openai.com',
      'openrouter.ai',
    ]);
    expect(r.isConfigured()).toBe(true);
    expect(r.statuses().map((s) => [s.id, s.configured, s.envVar])).toEqual([
      ['notokenlimit', false, 'NTL_API_KEY'],
      ['anthropic', false, 'ANTHROPIC_API_KEY'],
      ['openai', true, 'OPENAI_API_KEY'],
      ['openrouter', true, 'OPENROUTER_API_KEY'],
      ['gemini', false, 'GEMINI_API_KEY'],
      ['7api', false, 'SEVENAPI_API_KEY'],
    ]);
    // A model whose provider has no key says which key is missing.
    await expect(
      r.complete({ model: 'anthropic:claude-x', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(
      'Anthropic is not configured. Set ANTHROPIC_API_KEY (see Settings for the file) and restart Friday.',
    );
    const none = router({}, {}).r;
    expect(none.isConfigured()).toBe(false);
    await expect(none.listAll()).rejects.toThrow(
      /^No model provider is configured\. Set NTL_API_KEY, ANTHROPIC_API_KEY/,
    );
  });

  it('serves the providers in Settings without ever sending a key', async () => {
    const config = testConfig({ apiKey: null });
    config.providers.anthropic.apiKey = ANTHROPIC_KEY;
    const s = testServices({
      config,
      fetch: mockFetch([
        () =>
          jsonResponse(200, { data: [{ id: 'claude-sonnet-4-6', display_name: 'Sonnet 4.6' }] }),
      ]).fetch,
    });
    expect(s.provider).toBeInstanceOf(ProviderRouter);
    const app = await buildApp(s);
    const settings = await app.inject({ method: 'GET', url: '/api/settings', headers: H });
    const dto = settings.json<SettingsDto>();
    expect(dto.apiKeyConfigured).toBe(true);
    expect(dto.providers.find((p) => p.id === 'anthropic')).toEqual({
      id: 'anthropic',
      label: 'Anthropic',
      configured: true,
      envVar: 'ANTHROPIC_API_KEY',
      baseUrl: 'https://api.anthropic.com',
    });
    expect(settings.body).not.toContain(ANTHROPIC_KEY);
    const models = await app.inject({ method: 'GET', url: '/api/provider/models', headers: H });
    expect(models.json<ModelListDto>()).toEqual({
      models: [{ id: 'anthropic:claude-sonnet-4-6', provider: 'anthropic', name: 'Sonnet 4.6' }],
      errors: [],
    });
    const chosen = await app.inject({
      method: 'PUT',
      url: '/api/settings/model',
      headers: H,
      payload: { model: 'anthropic:claude-sonnet-4-6' },
    });
    expect(chosen.statusCode).toBe(200);
    const unknown = await app.inject({
      method: 'PUT',
      url: '/api/settings/model',
      headers: H,
      payload: { model: 'openai:gpt-5' },
    });
    expect(unknown.json().error.message).toBe(
      'Model "openai:gpt-5" is not in the model list of any configured provider.',
    );
    // Keys from every provider are redacted wherever they could appear.
    expect(s.redactor.redact(`key ${ANTHROPIC_KEY}`)).not.toContain(ANTHROPIC_KEY);
  });

  it('keeps chat models from OpenAI and judges context windows by the model name', () => {
    expect(['gpt-5', 'gpt-4.1-mini', 'o3', 'chatgpt-4o-latest'].every(isOpenAIChatModel)).toBe(
      true,
    );
    expect(
      [
        'text-embedding-3-small',
        'whisper-1',
        'tts-1',
        'gpt-4o-realtime-preview',
        'dall-e-3',
        'omni-moderation-latest',
      ].some(isOpenAIChatModel),
    ).toBe(false);
    expect(assumedContextWindow('anthropic:claude-sonnet-4-6')).toBe(180_000);
    expect(assumedContextWindow('openrouter:anthropic/claude-sonnet-4.6')).toBe(180_000);
    expect(assumedContextWindow('openrouter:google/gemini-2.5-pro')).toBe(900_000);
    expect(assumedContextWindow('openai:o3')).toBe(120_000);
    expect(assumedContextWindow('claude-opus-5.5')).toBe(180_000);
  });
});
