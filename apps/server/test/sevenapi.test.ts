import type { ModelCapabilities } from '@friday/shared';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { listedDetails } from '../src/providers/openaiCompatible.js';
import { createProviders } from '../src/providers/router.js';
import type { ProviderCallRecord, StreamEvent } from '../src/providers/types.js';
import { Redactor } from '../src/security/redact.js';
import {
  jsonResponse,
  mockFetch,
  sseResponse,
  testConfig,
  testServices,
  textChunks,
} from './helpers.js';

const KEY = 'sk-7api-test-0123456789abcdefghijklmn';
const H = { host: '127.0.0.1:4317', 'x-friday-client': '1', 'content-type': 'application/json' };

/** Entries shaped like 7API's public /v1/models (trimmed to the fields Friday reads). */
const LIST = {
  object: 'list',
  data: [
    {
      id: 'gpt-6-astra',
      object: 'model',
      name: 'GPT-6 Astra',
      context_window: 1_050_000,
      context_length: 1_050_000,
      input_modalities: ['text', 'image'],
      supports_vision: true,
    },
    {
      id: 'claude-sonnet-5-5',
      object: 'model',
      name: 'Claude Sonnet 5.5',
      context_window: 1_000_000,
      input_modalities: ['text'],
      supports_vision: false,
    },
    {
      id: 'glm-5.3-uncensored',
      object: 'model',
      context_length: 1_000_000,
      supports_vision: false,
    },
    // Nothing usable reported: no details.
    { id: 'mystery', object: 'model', context_window: 'big', input_modalities: 'text' },
  ],
};

const collect = async (it: AsyncIterable<StreamEvent>) => {
  const out: StreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
};

function sevenApi(handler: Parameters<typeof mockFetch>[0][number]) {
  const config = testConfig({ apiKey: null });
  config.providers.sevenapi.apiKey = KEY;
  const mock = mockFetch([handler]);
  const records: ProviderCallRecord[] = [];
  const r = createProviders(config, {
    redactor: new Redactor([KEY]),
    recorder: (x) => records.push(x),
    fetch: mock.fetch,
    retryBaseDelayMs: 1,
    retryMaxDelayMs: 5,
  });
  return { r, config, calls: mock.calls, records, fetch: mock.fetch };
}

describe('7API provider', () => {
  it('lists every model with its context window and image support', async () => {
    const { r, calls } = sevenApi(() => jsonResponse(200, LIST));
    const list = await r.listAll();
    expect(new URL(calls[0]!.url).href).toBe('https://7api.st/v1/models');
    expect(list.errors).toEqual([]);
    expect(list.models).toEqual([
      {
        id: '7api:gpt-6-astra',
        provider: '7api',
        name: 'GPT-6 Astra',
        contextWindow: 1_050_000,
        imageInput: true,
      },
      {
        id: '7api:claude-sonnet-5-5',
        provider: '7api',
        name: 'Claude Sonnet 5.5',
        contextWindow: 1_000_000,
        imageInput: false,
      },
      {
        id: '7api:glm-5.3-uncensored',
        provider: '7api',
        contextWindow: 1_000_000,
        imageInput: false,
      },
      { id: '7api:mystery', provider: '7api' },
    ]);
    expect(r.statuses().find((s) => s.id === '7api')).toEqual({
      id: '7api',
      label: '7API',
      configured: true,
      envVar: 'SEVENAPI_API_KEY',
      baseUrl: 'https://7api.st/v1',
    });
  });

  it('ignores implausible details', () => {
    expect(listedDetails({ context_window: 500 })).toEqual({});
    expect(listedDetails({ context_window: 50_000_000 })).toEqual({});
    expect(listedDetails({ context_window: 1.5e5 + 0.5 })).toEqual({});
    expect(listedDetails({ context_window: 'x', context_length: 200_000 })).toEqual({
      contextWindow: 200_000,
    });
    expect(listedDetails({ supports_vision: true })).toEqual({ imageInput: true });
  });

  it('sends chat to 7API with its own id and key, OpenAI-style, Claude included', async () => {
    const { r, calls, records } = sevenApi((_c, signal) =>
      sseResponse(textChunks(['po', 'ng']), {}, signal),
    );
    const events = await collect(
      r.streamChat({
        model: '7api:claude-sonnet-5-5',
        messages: [{ role: 'user', content: 'Reply with exactly: pong' }],
        maxOutputTokens: 16,
      }),
    );
    expect(
      events
        .filter((e) => e.type === 'text')
        .map((e) => (e as { delta: string }).delta)
        .join(''),
    ).toBe('pong');
    const call = calls[0]!;
    expect(new URL(call.url).href).toBe('https://7api.st/v1/chat/completions');
    expect(call.headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(call.body).toMatchObject({ model: 'claude-sonnet-5-5', max_tokens: 16, stream: true });
    expect(records.map((x) => x.model)).toEqual(['7api:claude-sonnet-5-5']);
    expect(r.providerOf('7api:glm-5.3')).toBe('7api');
  });

  it('names 7API and its key in errors, without the key', async () => {
    const { r } = sevenApi(() =>
      jsonResponse(401, { error: { message: `Invalid API key ${KEY}`, type: 'auth_error' } }),
    );
    const err = await r
      .complete({ model: '7api:glm-5.3', messages: [{ role: 'user', content: 'hi' }] })
      .catch((e: unknown) => e);
    expect(String(err)).toMatch(/7API rejected the API key\. Check SEVENAPI_API_KEY\./);
    expect(String(err)).not.toContain(KEY);
  });

  it('uses the listed window and image support until the user or a probe says otherwise', async () => {
    const config = testConfig({ apiKey: null });
    config.providers.sevenapi.apiKey = KEY;
    const s = testServices({ config, fetch: mockFetch([() => jsonResponse(200, LIST)]).fetch });
    const app = await buildApp(s);
    const caps = async (model: string) =>
      (
        await app.inject({
          method: 'GET',
          url: `/api/provider/capabilities?model=${encodeURIComponent(model)}`,
          headers: H,
        })
      ).json() as ModelCapabilities;

    // Before the list was loaded: Friday's guess.
    expect(await caps('7api:claude-sonnet-5-5')).toMatchObject({
      contextWindow: 180_000,
      contextWindowSource: 'assumed',
      imageInput: 'unknown',
    });
    const listed = await app.inject({ method: 'GET', url: '/api/provider/models', headers: H });
    expect(listed.statusCode).toBe(200);
    expect(await caps('7api:claude-sonnet-5-5')).toMatchObject({
      contextWindow: 1_000_000,
      contextWindowSource: 'listed',
      imageInput: 'unsupported',
    });
    expect(await caps('7api:gpt-6-astra')).toMatchObject({ imageInput: 'supported' });
    expect(await caps('7api:mystery')).toMatchObject({ contextWindowSource: 'assumed' });

    // The user's window and what a real request showed take precedence.
    await app.inject({
      method: 'PUT',
      url: '/api/provider/capabilities/context-window',
      headers: H,
      payload: { model: '7api:claude-sonnet-5-5', tokens: 200_000 },
    });
    s.capabilities.setImageInput('7api:gpt-6-astra', 'unsupported');
    expect(await caps('7api:claude-sonnet-5-5')).toMatchObject({
      contextWindow: 200_000,
      contextWindowSource: 'configured',
    });
    expect(await caps('7api:gpt-6-astra')).toMatchObject({
      imageInput: 'unsupported',
      contextWindowSource: 'listed',
    });
  });
});
