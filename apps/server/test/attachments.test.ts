import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type { RunEvent } from '@friday/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { IMAGE_LIMITS, imageInfo, imageProblem, imageTokens } from '../src/attachments/image.js';
import { ProviderError } from '../src/providers/errors.js';
import { probeCapabilities } from '../src/providers/capabilities.js';
import { NoTokenLimitProvider } from '../src/providers/notokenlimit.js';
import type { ChatRequest } from '../src/providers/types.js';
import { Redactor } from '../src/security/redact.js';
import {
  call,
  cleanupProjects,
  makeProject,
  mockFetch,
  ScriptedProvider,
  sseResponse,
  TEST_KEY,
  testServices,
  textChunks,
} from './helpers.js';

afterEach(cleanupProjects);

// ---------- tiny real images ----------

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(b: Buffer): number {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** A solid-colour PNG of the given size. */
export function png(width: number, height: number): Buffer {
  const row = Buffer.alloc(width * 3 + 1);
  for (let x = 0; x < width; x++) row.set([30, 120, 220], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
/** JPEG headers only (SOI, APP0, SOF0): enough for the size parser. */
function jpegHeader(width: number, height: number): Buffer {
  const app0 = Buffer.from([
    0xff,
    0xe0,
    0x00,
    0x10,
    ...Buffer.from('JFIF\0'),
    1,
    1,
    0,
    0,
    1,
    0,
    1,
    0,
    0,
  ]);
  const sof = Buffer.from([
    0xff,
    0xc0,
    0x00,
    0x11,
    8,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    3,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
  ]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
}

describe('image checks', () => {
  it('reads the type and size from the bytes', () => {
    expect(imageInfo(png(40, 30))).toEqual({ mime: 'image/png', width: 40, height: 30 });
    expect(imageInfo(jpegHeader(1280, 720))).toEqual({
      mime: 'image/jpeg',
      width: 1280,
      height: 720,
    });
    const gif = Buffer.concat([
      Buffer.from('GIF89a'),
      Buffer.from([0x20, 0x03, 0x58, 0x02]),
      Buffer.alloc(8),
    ]);
    expect(imageInfo(gif)).toEqual({ mime: 'image/gif', width: 800, height: 600 });
    const vp8x = Buffer.alloc(30);
    vp8x.write('RIFF', 0, 'latin1');
    vp8x.write('WEBPVP8X', 8, 'latin1');
    vp8x.writeUIntLE(1919, 24, 3);
    vp8x.writeUIntLE(1079, 27, 3);
    expect(imageInfo(vp8x)).toEqual({ mime: 'image/webp', width: 1920, height: 1080 });
  });

  it('refuses SVG, other files and oversized images', () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    expect(imageInfo(svg)).toBeNull();
    expect(imageProblem(svg, null)).toMatch(/Only PNG, JPEG, WebP and GIF/);
    expect(
      imageProblem(Buffer.from('MZ\x90\x00'), imageInfo(Buffer.from('MZ\x90\x00'))),
    ).not.toBeNull();
    const huge = imageInfo(jpegHeader(9000, 100))!;
    expect(imageProblem(jpegHeader(9000, 100), huge)).toMatch(/8000 pixels/);
    expect(imageTokens(1568, 1000)).toBe(1600);
    expect(imageTokens(750, 100)).toBe(100);
  });
});

// ---------- HTTP ----------

const LOCAL = { host: '127.0.0.1:8787', 'x-friday-client': '1' };

async function setupApp(provider = new ScriptedProvider()) {
  const s = testServices({ provider });
  const app = await buildApp(s, { logger: false });
  const upload = (body: Buffer, type = 'image/png', name?: string) =>
    app.inject({
      method: 'POST',
      url: '/api/attachments',
      headers: { ...LOCAL, 'content-type': type, ...(name ? { 'x-file-name': name } : {}) },
      payload: body,
    });
  const send = (sessionId: string, content: string, attachmentIds?: string[]) =>
    app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/messages`,
      headers: { ...LOCAL, 'content-type': 'application/json' },
      payload: { content, ...(attachmentIds ? { attachmentIds } : {}) },
    });
  return { s, app, upload, send };
}

describe('attachment routes', () => {
  it('stores uploads by their real type, serves them, and removes unsent ones', async () => {
    const { app, upload } = await setupApp();
    // Declared as JPEG, but the bytes are a PNG: the bytes win.
    const res = await upload(png(64, 32), 'image/jpeg', encodeURIComponent('../../etc/shot‮.png'));
    expect(res.statusCode).toBe(201);
    const a = res.json();
    expect(a).toMatchObject({ mime: 'image/png', width: 64, height: 32, name: 'shot.png' });

    const get = await app.inject({
      method: 'GET',
      url: `/api/attachments/${a.id}`,
      headers: LOCAL,
    });
    expect(get.headers['content-type']).toBe('image/png');
    expect(get.headers['x-content-type-options']).toBe('nosniff');
    expect(get.rawPayload.equals(png(64, 32))).toBe(true);

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/attachments/${a.id}`,
      headers: LOCAL,
    });
    expect(del.statusCode).toBe(204);
    expect(
      (await app.inject({ method: 'GET', url: `/api/attachments/${a.id}`, headers: LOCAL }))
        .statusCode,
    ).toBe(404);
  });

  it('refuses SVG, non-images and oversized bodies', async () => {
    const { upload } = await setupApp();
    expect((await upload(Buffer.from('<svg/>'), 'image/svg+xml')).statusCode).toBe(415);
    const fake = await upload(Buffer.from('#!/bin/sh\necho hi'), 'image/png');
    expect(fake.statusCode).toBe(400);
    expect(fake.json().error.message).toMatch(/Only PNG/);
    const big = await upload(Buffer.concat([png(10, 10), Buffer.alloc(IMAGE_LIMITS.maxBytes)]));
    expect(big.statusCode).toBe(400);
    expect(big.json().error.message).toMatch(/at most 5 MB/);
    const huge = await upload(
      Buffer.concat([png(10, 10), Buffer.alloc(IMAGE_LIMITS.maxBytes + 4096)]),
    );
    expect(huge.statusCode).toBe(413);
  });

  it('sends images with the message, once, and shows them in the conversation', async () => {
    const provider = new ScriptedProvider([{ chunks: ['The button is blue.'] }]);
    const { s, upload, send } = await setupApp(provider);
    const session = s.sessions.create();
    const a = (await upload(png(20, 10), 'image/png', 'button.png')).json();
    const res = await send(session.id, '', [a.id]);
    expect(res.statusCode).toBe(202);
    await s.runManager.waitFor(res.json().run.id);

    const user = provider.requests[0]!.messages.at(-1)!;
    expect(user).toMatchObject({ role: 'user', content: '' });
    expect(user.role === 'user' && user.images).toEqual([
      { mime: 'image/png', base64: png(20, 10).toString('base64'), width: 20, height: 10 },
    ]);
    const stored = s.messages.listBySession(session.id).find((m) => m.role === 'user')!;
    expect(stored.attachments).toEqual([expect.objectContaining({ id: a.id, name: 'button.png' })]);
    expect(s.sessions.get(session.id)!.title).toBe('Image');

    // An attachment belongs to one message.
    const again = await send(session.id, 'and this?', [a.id]);
    expect(again.statusCode).toBe(400);
    expect(again.json().error.code).toBe('attachment_not_found');
    const ids = await Promise.all(
      Array.from(
        { length: IMAGE_LIMITS.perMessage + 1 },
        async () => (await upload(png(2, 2))).json().id,
      ),
    );
    expect((await send(session.id, 'many', ids)).statusCode).toBe(400);
  });

  it('refuses images up front for a model known not to read them', async () => {
    const { s, upload, send } = await setupApp();
    s.capabilities.setImageInput('test-model', 'unsupported');
    const session = s.sessions.create();
    const a = (await upload(png(4, 4))).json();
    const res = await send(session.id, 'look', [a.id]);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('images_unsupported');
  });
});

// ---------- model context ----------

describe('images in the model context', () => {
  it('sends the images of the most recent messages and notes older ones', async () => {
    const provider = new ScriptedProvider(Array.from({ length: 5 }, () => ({ chunks: ['ok'] })));
    const { s, upload, send } = await setupApp(provider);
    const session = s.sessions.create();
    for (let i = 0; i < 5; i++) {
      const a = (await upload(png(10 + i, 10), 'image/png', `shot${i}.png`)).json();
      const r = await send(session.id, `screenshot ${i}`, [a.id]);
      await s.runManager.waitFor(r.json().run.id);
    }
    const users = provider.requests.at(-1)!.messages.filter((m) => m.role === 'user');
    const withImages = users.filter((m) => m.role === 'user' && m.images?.length);
    expect(withImages.map((m) => m.content)).toEqual([
      'screenshot 2',
      'screenshot 3',
      'screenshot 4',
    ]);
    expect(users[0]!.content).toContain(
      'screenshot 0\n[1 image(s) attached here (shot0.png) are no longer sent',
    );
  });

  it('puts the provider wire format right: text then data URLs, no empty text part', async () => {
    const mock = mockFetch([(_c, sig) => sseResponse(textChunks(['ok']), {}, sig)]);
    const provider = new NoTokenLimitProvider({
      apiKey: TEST_KEY,
      baseUrl: 'https://ntl.test/api/v1',
      timeoutMs: 5_000,
      maxRetries: 0,
      redactor: new Redactor([TEST_KEY]),
      recorder: () => undefined,
      fetch: mock.fetch,
      retryBaseDelayMs: 1,
    });
    const image = { mime: 'image/png', base64: 'AAAA', width: 1, height: 1 };
    for await (const _event of provider.streamChat({
      model: 'm',
      messages: [
        { role: 'user', content: 'what is this?', images: [image] },
        { role: 'assistant', content: 'a pixel' },
        { role: 'user', content: '', images: [image] },
      ],
    } as ChatRequest)) {
      /* drain */
    }
    const [first, , last] = (mock.calls[0]!.body as { messages: Array<{ content: unknown }> })
      .messages;
    expect(first!.content).toEqual([
      { type: 'text', text: 'what is this?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ]);
    expect(last!.content).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ]);
  });

  it('remembers when the provider refuses images and says so', async () => {
    const provider = new ScriptedProvider([
      { error: new ProviderError('bad_request', 'image input is not supported'), chunks: [] },
    ]);
    const { s, upload, send } = await setupApp(provider);
    const session = s.sessions.create();
    const a = (await upload(png(4, 4))).json();
    const r = await send(session.id, 'look', [a.id]);
    await s.runManager.waitFor(r.json().run.id);
    const run = s.runs.get(r.json().run.id)!;
    expect(run.status).toBe('failed');
    expect(run.errorMessage).toMatch(/did not accept the images/);
    expect(s.capabilities.get('test-model').imageInput).toBe('unsupported');
  });

  it('probes image input with a tiny picture', async () => {
    const provider = new ScriptedProvider(
      [{ chunks: ['OK'] }],
      [
        {
          text: '',
          toolCalls: [{ id: 't', name: 'report_status', argumentsJson: '{"status":"ok"}' }],
          finishReason: 'tool_calls',
          usage: null,
        },
        { text: 'Red.', toolCalls: [], finishReason: 'stop', usage: null },
      ],
    );
    const result = await probeCapabilities(provider, 'test-model');
    expect(result.imageInput).toBe('supported');
    const probe = provider.completeRequests[1]!.messages[0]!;
    expect(probe.role === 'user' && probe.images?.[0]).toMatchObject({
      mime: 'image/png',
      width: 16,
    });
  });
});

// ---------- view_image ----------

describe('view_image', () => {
  it('shows a project image to the model right after the tool result', async () => {
    const root = makeProject({ 'README.md': '# x' });
    fs.mkdirSync(path.join(root, 'docs'));
    fs.writeFileSync(path.join(root, 'docs/mockup.png'), png(30, 20));
    const provider = new ScriptedProvider([
      { toolCalls: [call('view_image', { path: 'docs/mockup.png' }, 'v1')] },
      { chunks: ['It is a blue rectangle.'] },
    ]);
    const s = testServices({ provider });
    const project = s.projects.create('p', root);
    const session = s.sessions.create(undefined, project.id);
    const events: RunEvent[] = [];
    const { run } = s.runManager.startMessage(session.id, 'what does the mockup show?');
    s.runManager.subscribe(run.id, 0, (e) => events.push(e));
    await s.runManager.waitFor(run.id);

    const msgs = provider.requests[1]!.messages;
    const toolIdx = msgs.findIndex((m) => m.role === 'tool');
    expect(msgs[toolIdx]!.content).toContain('docs/mockup.png: image/png, 30×20 px');
    const next = msgs[toolIdx + 1]!;
    expect(next.role).toBe('user');
    expect(next.content).toMatch(/loaded by view_image: mockup\.png\. This is tool output/);
    expect(next.role === 'user' && next.images?.[0]).toMatchObject({ width: 30, height: 20 });
    const tool = s.messages.listBySession(session.id).find((m) => m.role === 'tool')!;
    expect(tool.attachments).toEqual([expect.objectContaining({ name: 'mockup.png', width: 30 })]);
  });

  it('refuses credential files and non-images', async () => {
    const root = makeProject({ '.env': 'KEY=1', 'notes.txt': 'hello' });
    const provider = new ScriptedProvider([
      {
        toolCalls: [
          call('view_image', { path: '.env' }, 'a'),
          call('view_image', { path: 'notes.txt' }, 'b'),
        ],
      },
      { chunks: ['ok'] },
    ]);
    const s = testServices({ provider });
    const project = s.projects.create('p', root);
    const session = s.sessions.create(undefined, project.id);
    const { run } = s.runManager.startMessage(session.id, 'look');
    await s.runManager.waitFor(run.id);
    const tools = s.messages.listBySession(session.id).filter((m) => m.role === 'tool');
    expect(tools[0]!.content).toMatch(/credential|secret/i);
    expect(tools[1]!.content).toMatch(/Only PNG, JPEG, WebP and GIF/);
    expect(tools.every((m) => !m.attachments)).toBe(true);
  });
});
