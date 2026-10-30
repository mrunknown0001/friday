import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import type { RunEvent } from '@friday/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import {
  ChromeEngine,
  findChrome,
  type CaptureEngine,
  type CaptureOptions,
} from '../src/browser/capture.js';
import { isLocalUrl, localPageUrl } from '../src/browser/urls.js';
import { call, cleanupProjects, makeProject, ScriptedProvider, testServices } from './helpers.js';

afterEach(cleanupProjects);

/** A small valid PNG (solid colour). */
function png(width: number, height: number): Buffer {
  const CRC = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = CRC[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(width * 3 + 1, 200);
  row[0] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

class FakeEngine implements CaptureEngine {
  readonly name = 'fake';
  async printPdf() {
    return Buffer.from('%PDF-1.7 fake');
  }
  readonly calls: Array<{ url: string; opts: CaptureOptions }> = [];
  async capture(url: string, opts: CaptureOptions) {
    this.calls.push({ url, opts });
    return {
      image: png(opts.width, opts.height),
      mime: 'image/png' as const,
      width: opts.width,
      height: opts.height,
      title: 'Shop',
      finalUrl: url,
      status: 200,
      problems: ['console.error: cart failed to load'],
    };
  }
}

describe('local page URLs', () => {
  it('allows only this machine, never Friday itself', () => {
    expect(localPageUrl('localhost:5173/cart', 4317)).toBe('http://localhost:5173/cart');
    expect(localPageUrl('http://0.0.0.0:3000', 4317)).toBe('http://localhost:3000/');
    expect(localPageUrl('https://127.0.0.1:8443/', 4317)).toBe('https://127.0.0.1:8443/');
    for (const bad of [
      'https://example.com',
      'file:///etc/passwd',
      'http://192.168.1.10:3000',
      'http://localhost.evil.com',
      'http://user:pw@localhost:3000',
    ])
      expect(() => localPageUrl(bad, 4317), bad).toThrow();
    expect(() => localPageUrl('http://127.0.0.1:4317/api/sessions', 4317)).toThrow(/Friday's own/);
    expect(isLocalUrl('http://[::1]:3000/')).toBe(true);
    expect(isLocalUrl('javascript:alert(1)')).toBe(false);
  });
});

describe('screenshot tool', () => {
  function setup(engine: CaptureEngine | null) {
    const provider = new ScriptedProvider();
    const s = testServices({ provider, ...(engine ? { captureEngine: engine } : {}) });
    return { s, provider };
  }

  it('captures a local page, shows the image at once and reports page problems', async () => {
    const engine = new FakeEngine();
    const { s, provider } = setup(engine);
    provider.streamSteps.push(
      {
        toolCalls: [
          call(
            'screenshot',
            { url: 'localhost:5173', path: '/cart', width: 800, height: 600 },
            's1',
          ),
        ],
      },
      { chunks: ['The cart page renders.'] },
    );
    const session = s.sessions.create();
    const events: RunEvent[] = [];
    const { run } = s.runManager.startMessage(session.id, 'how does the cart look?');
    s.runManager.subscribe(run.id, 0, (e) => events.push(e));
    await s.runManager.waitFor(run.id);

    expect(engine.calls[0]).toMatchObject({
      url: 'http://localhost:5173/cart',
      opts: { width: 800, height: 600, fullPage: false },
    });
    const finished = events.find((e) => e.type === 'tool_finished' && e.name === 'screenshot');
    expect(finished).toMatchObject({
      attachments: [{ width: 800, height: 600, mime: 'image/png' }],
    });
    const tool = s.messages.listBySession(session.id).find((m) => m.role === 'tool')!;
    expect(tool.content).toContain('Screenshot of http://localhost:5173/cart ("Shop"), HTTP 200');
    expect(tool.content).toContain('- console.error: cart failed to load');
    expect(tool.attachments).toHaveLength(1);
    // The model sees the image right after the tool result.
    const next = provider.requests[1]!.messages;
    const img = next.find((m) => m.role === 'user' && m.images?.length);
    expect(img?.content).toMatch(/loaded by view_image|screenshot/);
  });

  it('refuses other machines and is not offered without a browser', async () => {
    const engine = new FakeEngine();
    const { s, provider } = setup(engine);
    provider.streamSteps.push(
      { toolCalls: [call('screenshot', { url: 'https://example.com' }, 'x')] },
      { chunks: ['ok'] },
    );
    const session = s.sessions.create();
    const r = s.runManager.startMessage(session.id, 'shoot');
    await s.runManager.waitFor(r.run.id);
    const tool = s.messages.listBySession(session.id).find((m) => m.role === 'tool')!;
    expect(tool.content).toMatch(/Only pages on this machine/);
    expect(engine.calls).toEqual([]);

    const none = setup(null);
    none.provider.streamSteps.push({ chunks: ['hi'] });
    const s2 = none.s.sessions.create();
    const r2 = none.s.runManager.startMessage(s2.id, 'hello');
    await none.s.runManager.waitFor(r2.run.id);
    expect(none.provider.requests[0]!.tools!.map((t) => t.name)).not.toContain('screenshot');
  });
});

const HEADERS = { host: '127.0.0.1:8787', 'x-friday-client': '1' };

describe('preview and image routes', () => {
  it('serves project images with a sandboxing CSP, never credentials or non-images', async () => {
    const root = makeProject({
      'logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      'notes.txt': 'hello',
      '.env': 'KEY=1',
    });
    fs.writeFileSync(path.join(root, 'shot.png'), png(4, 3));
    const s = testServices();
    const app = await buildApp(s, { logger: false });
    const project = s.projects.create('p', root);
    const raw = (p: string) =>
      app.inject({
        method: 'GET',
        url: `/api/projects/${project.id}/raw?path=${encodeURIComponent(p)}`,
        headers: HEADERS,
      });
    const pngRes = await raw('shot.png');
    expect(pngRes.headers['content-type']).toBe('image/png');
    expect(pngRes.headers['content-security-policy']).toMatch(/^sandbox; default-src 'none'/);
    const svg = await raw('logo.svg');
    expect(svg.headers['content-type']).toBe('image/svg+xml');
    expect(svg.headers['content-security-policy']).toContain('sandbox');
    expect((await raw('notes.txt')).statusCode).toBe(400);
    expect((await raw('.env')).statusCode).toBe(403);

    // The app's own CSP lets frames show local pages only.
    const page = await app.inject({ method: 'GET', url: '/api/health', headers: HEADERS });
    const csp = String(page.headers['content-security-policy']);
    expect(csp).toContain('frame-src http://localhost:* http://127.0.0.1:*');
    const frameSrc = /frame-src ([^;]+)/.exec(csp)![1]!.trim().split(/\s+/);
    for (const source of frameSrc)
      expect(source).toMatch(/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]):\*$/);
  });

  it('adds a screenshot to the composer as a pending attachment', async () => {
    const engine = new FakeEngine();
    const s = testServices({ captureEngine: engine });
    const app = await buildApp(s, { logger: false });
    expect(
      (await app.inject({ method: 'GET', url: '/api/preview/status', headers: HEADERS })).json(),
    ).toEqual({ screenshots: 'fake', openFiles: false });
    const res = await app.inject({
      method: 'POST',
      url: '/api/preview/screenshot',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      payload: { url: 'http://localhost:5173/', width: 390 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      attachment: { width: 390, mime: 'image/png' },
      problems: ['console.error: cart failed to load'],
    });
    expect(s.attachments.get(res.json().attachment.id)?.messageId).toBeNull();
    const external = await app.inject({
      method: 'POST',
      url: '/api/preview/screenshot',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      payload: { url: 'https://example.com' },
    });
    expect(external.statusCode).toBe(400);

    const none = await buildApp(testServices(), { logger: false });
    expect(
      (await none.inject({ method: 'GET', url: '/api/preview/status', headers: HEADERS })).json(),
    ).toEqual({ screenshots: null, openFiles: false });
  });
});

// A real headless browser, only where one is configured (FRIDAY_CHROME or an installed Chrome).
const chrome = await findChrome();

describe.skipIf(!chrome)('screenshots with a real browser', () => {
  it('captures a local page, reports its problems, and keeps it on this machine', async () => {
    const server = http.createServer((req, res) => {
      if (req.url === '/away') {
        res.writeHead(302, { location: 'https://example.com/' });
        return res.end();
      }
      res.setHeader('content-type', 'text/html');
      res.end(`<title>Shop</title><h1>Checkout</h1><iframe src="https://example.com"></iframe>
        <div style="height:2000px"></div><script>console.error('cart failed to load')</script>`);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const engine = new ChromeEngine(chrome!);
    try {
      const shot = await engine.capture(`http://localhost:${port}/`, {
        width: 800,
        height: 600,
        fullPage: true,
        waitMs: 100,
      });
      expect(shot).toMatchObject({ mime: 'image/png', width: 800, title: 'Shop', status: 200 });
      expect(shot.height).toBeGreaterThan(2000);
      expect(shot.image.subarray(1, 4).toString()).toBe('PNG');
      expect(shot.problems).toContain('console.error: cart failed to load');
      expect(
        shot.problems.some((p) => p.startsWith('blocked: navigation to https://example.com')),
      ).toBe(true);
      await expect(
        engine.capture(`http://localhost:${port}/away`, {
          width: 800,
          height: 600,
          fullPage: false,
          waitMs: 0,
        }),
      ).rejects.toThrow(/redirects to a page that is not on this machine/);
    } finally {
      server.close();
    }
  }, 60_000);
});
