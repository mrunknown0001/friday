import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isLocalUrl } from './urls.js';

/**
 * Screenshots of local pages (dev servers). Two engines, no extra packages:
 * - desktop: the Electron shell's own Chromium, asked over the utility-process channel (a hidden,
 *   separate in-memory session that never carries the launch token);
 * - chrome: an installed Chrome, Chromium or Edge, run headless with a throwaway profile and
 *   driven over the DevTools protocol (Node's built-in WebSocket).
 * Both block navigation (and frames) to anything not on this machine and report the page's
 * console errors and failed requests with the image.
 */

export interface CaptureOptions {
  width: number;
  height: number;
  fullPage: boolean;
  /** Extra time after the load event (animations, client-side rendering). */
  waitMs: number;
  signal?: AbortSignal;
}

export interface CaptureResult {
  image: Buffer;
  mime: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
  title: string;
  finalUrl: string;
  /** HTTP status of the page itself, when known. */
  status: number | null;
  /** Console errors, uncaught exceptions and failed requests, in order. */
  problems: string[];
}

export class CaptureError extends Error {}

export interface CaptureEngine {
  readonly name: string;
  capture(url: string, opts: CaptureOptions): Promise<CaptureResult>;
}

export const CAPTURE_LIMITS = {
  /** Full-page captures are cut at this height (taller images are unreadable to models anyway). */
  maxHeight: 4_000,
  loadTimeoutMs: 20_000,
  maxProblems: 25,
  /** Above this a PNG is re-encoded as JPEG. */
  maxPngBytes: 4 * 1024 * 1024,
} as const;

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new CaptureError('Cancelled.'));
      },
      { once: true },
    );
  });

// ---------------------------------------------------------------- installed Chrome (DevTools)

const CHROME_CANDIDATES =
  process.platform === 'darwin'
    ? [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      ]
    : process.platform === 'win32'
      ? [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        ]
      : [
          'google-chrome',
          'google-chrome-stable',
          'chromium',
          'chromium-browser',
          'microsoft-edge',
          'microsoft-edge-stable',
        ];

async function onPath(name: string): Promise<string | null> {
  if (path.isAbsolute(name))
    return fs
      .access(name)
      .then(() => name)
      .catch(() => null);
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const full = path.join(dir, name);
    const ok = await fs
      .access(full, fs.constants.X_OK)
      .then(() => true)
      .catch(() => false);
    if (ok) return full;
  }
  return null;
}

/** An installed Chromium-based browser: FRIDAY_CHROME, else the usual names and places. */
export async function findChrome(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (env.FRIDAY_CHROME) return onPath(env.FRIDAY_CHROME);
  for (const c of CHROME_CANDIDATES) {
    const found = await onPath(c);
    if (found) return found;
  }
  return null;
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message: string };
  sessionId?: string;
}

/** The fields of the DevTools events used here. */
interface CdpEvent {
  requestId?: string;
  request?: { url: string };
  type?: string;
  response?: { status: number; url: string };
  errorText?: string;
  canceled?: boolean;
  args?: Array<{ value?: unknown; description?: string }>;
  exceptionDetails?: { text: string; exception?: { description?: string } };
}

class Cdp {
  private next = 1;
  private readonly pending = new Map<
    number,
    { resolve: (r: Record<string, unknown>) => void; reject: (e: Error) => void }
  >();
  private readonly handlers = new Set<(m: CdpMessage) => void>();

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(String(ev.data)) as CdpMessage;
      if (m.id !== undefined) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) p?.reject(new CaptureError(m.error.message));
        else p?.resolve(m.result ?? {});
      } else {
        for (const h of this.handlers) h(m);
      }
    });
    ws.addEventListener('close', () => {
      for (const p of this.pending.values()) p.reject(new CaptureError('The browser closed.'));
      this.pending.clear();
    });
  }

  static connect(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => resolve(new Cdp(ws)), { once: true });
      ws.addEventListener('error', () => reject(new CaptureError('Could not reach the browser.')), {
        once: true,
      });
    });
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string) {
    const id = this.next++;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise<Record<string, unknown>>((resolve, reject) =>
      this.pending.set(id, { resolve, reject }),
    );
  }

  on(handler: (m: CdpMessage) => void): void {
    this.handlers.add(handler);
  }

  close(): void {
    this.ws.close();
  }
}

/** Flags for a quiet, throwaway headless browser (no background calls home, no extensions). */
const CHROME_FLAGS = [
  '--headless=new',
  '--remote-debugging-port=0',
  '--remote-debugging-address=127.0.0.1',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--hide-scrollbars',
  '--mute-audio',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-default-apps',
  '--disable-sync',
  '--disable-domain-reliability',
  '--metrics-recording-only',
  '--no-pings',
  '--disable-features=Translate,OptimizationHints,MediaRouter,AutofillServerCommunication',
];

export class ChromeEngine implements CaptureEngine {
  readonly name: string;

  constructor(private readonly executable: string) {
    this.name = `chrome (${path.basename(executable)})`;
  }

  async capture(url: string, opts: CaptureOptions): Promise<CaptureResult> {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'friday-chrome-'));
    const child = spawn(
      this.executable,
      [...CHROME_FLAGS, `--user-data-dir=${profile}`, 'about:blank'],
      {
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    let cdp: Cdp | null = null;
    try {
      const wsUrl = await new Promise<string>((resolve, reject) => {
        let err = '';
        const timer = setTimeout(
          () => reject(new CaptureError(`The browser did not start: ${err.slice(-300)}`)),
          15_000,
        );
        child.stderr!.on('data', (b: Buffer) => {
          err += b.toString();
          const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
          if (m) {
            clearTimeout(timer);
            resolve(m[1]!);
          }
        });
        child.once('error', (e) => {
          clearTimeout(timer);
          reject(new CaptureError(`Could not start ${this.executable}: ${e.message}`));
        });
        child.once('exit', () => {
          clearTimeout(timer);
          reject(new CaptureError(`The browser exited during startup: ${err.slice(-300)}`));
        });
      });
      cdp = await Cdp.connect(wsUrl);
      return await this.run(cdp, url, opts);
    } finally {
      cdp?.close();
      child.kill('SIGKILL');
      await fs.rm(profile, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async run(cdp: Cdp, url: string, opts: CaptureOptions): Promise<CaptureResult> {
    const { targetId } = (await cdp.send('Target.createTarget', { url: 'about:blank' })) as {
      targetId: string;
    };
    const { sessionId } = (await cdp.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    })) as {
      sessionId: string;
    };
    const send = (method: string, params: Record<string, unknown> = {}) =>
      cdp.send(method, params, sessionId);
    const problems: string[] = [];
    const note = (p: string) => {
      if (problems.length < CAPTURE_LIMITS.maxProblems) problems.push(p.slice(0, 500));
    };
    let status: number | null = null;
    let loaded!: () => void;
    const loadedP = new Promise<void>((r) => (loaded = r));
    const requests = new Map<string, string>();

    cdp.on((m) => {
      if (m.sessionId !== sessionId || !m.params) return;
      const p = m.params as CdpEvent;
      switch (m.method) {
        case 'Fetch.requestPaused': {
          // Documents (the page, its frames and redirects) may only come from this machine.
          const reqUrl = p.request!.url;
          if (isLocalUrl(reqUrl)) void send('Fetch.continueRequest', { requestId: p.requestId });
          else {
            note(`blocked: navigation to ${reqUrl} (only pages on this machine are opened)`);
            void send('Fetch.failRequest', {
              requestId: p.requestId,
              errorReason: 'BlockedByClient',
            });
          }
          break;
        }
        case 'Page.loadEventFired':
          loaded();
          break;
        case 'Network.requestWillBeSent':
          requests.set(p.requestId!, p.request!.url);
          break;
        case 'Network.responseReceived':
          if (p.type === 'Document' && status === null) status = p.response!.status;
          else if (p.response!.status >= 400)
            note(`HTTP ${p.response!.status}: ${p.response!.url}`);
          break;
        case 'Network.loadingFailed':
          if (p.errorText !== 'net::ERR_BLOCKED_BY_CLIENT' && !p.canceled)
            note(`failed: ${requests.get(p.requestId!) ?? 'request'} (${p.errorText})`);
          break;
        case 'Runtime.consoleAPICalled':
          if (p.type === 'error' || p.type === 'warning' || p.type === 'assert')
            note(
              `console.${p.type}: ${(p.args ?? [])
                .map((a) => (a.value !== undefined ? String(a.value) : (a.description ?? '')))
                .join(' ')}`,
            );
          break;
        case 'Runtime.exceptionThrown': {
          const d = p.exceptionDetails!;
          note(`uncaught: ${d.exception?.description?.split('\n')[0] ?? d.text}`);
          break;
        }
      }
    });

    await send('Fetch.enable', {
      patterns: [{ resourceType: 'Document', requestStage: 'Request' }],
    });
    await Promise.all([send('Page.enable'), send('Runtime.enable'), send('Network.enable')]);
    await send('Emulation.setDeviceMetricsOverride', {
      width: opts.width,
      height: opts.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const nav = (await send('Page.navigate', { url })) as { errorText?: string };
    if (nav.errorText) {
      throw new CaptureError(
        nav.errorText === 'net::ERR_CONNECTION_REFUSED'
          ? `Nothing is listening at ${url} (connection refused). Is the dev server running?`
          : nav.errorText === 'net::ERR_BLOCKED_BY_CLIENT'
            ? `${url} redirects to a page that is not on this machine; only local pages are opened.`
            : `Could not open ${url}: ${nav.errorText}`,
      );
    }
    await Promise.race([
      loadedP,
      sleep(CAPTURE_LIMITS.loadTimeoutMs, opts.signal).then(() =>
        note(`the page did not finish loading within ${CAPTURE_LIMITS.loadTimeoutMs / 1000}s`),
      ),
    ]);
    if (opts.waitMs) await sleep(opts.waitMs, opts.signal);

    let height = opts.height;
    if (opts.fullPage) {
      const metrics = (await send('Page.getLayoutMetrics')) as {
        cssContentSize: { height: number };
      };
      height = Math.min(
        Math.max(Math.ceil(metrics.cssContentSize.height), opts.height),
        CAPTURE_LIMITS.maxHeight,
      );
      if (metrics.cssContentSize.height > CAPTURE_LIMITS.maxHeight)
        note(
          `page is ${Math.ceil(metrics.cssContentSize.height)}px tall; captured the top ${CAPTURE_LIMITS.maxHeight}px`,
        );
      await send('Emulation.setDeviceMetricsOverride', {
        width: opts.width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await sleep(250, opts.signal);
    }
    const info = (await send('Runtime.evaluate', {
      expression: 'JSON.stringify([document.title, location.href])',
      returnByValue: true,
    })) as { result: { value?: string } };
    const [title, finalUrl] = JSON.parse(info.result.value ?? '["",""]') as [string, string];
    let shot = (await send('Page.captureScreenshot', { format: 'png' })) as { data: string };
    let mime: CaptureResult['mime'] = 'image/png';
    if (shot.data.length * 0.75 > CAPTURE_LIMITS.maxPngBytes) {
      shot = (await send('Page.captureScreenshot', { format: 'jpeg', quality: 82 })) as {
        data: string;
      };
      mime = 'image/jpeg';
    }
    return {
      image: Buffer.from(shot.data, 'base64'),
      mime,
      width: opts.width,
      height,
      title,
      finalUrl,
      status,
      problems,
    };
  }
}

// ---------------------------------------------------------------- desktop shell (Electron)

interface ParentPort {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (e: { data: unknown }) => void): void;
}

interface DesktopReply {
  type: 'capture_result';
  id: string;
  ok: boolean;
  error?: string;
  image?: string;
  mime?: CaptureResult['mime'];
  width?: number;
  height?: number;
  title?: string;
  finalUrl?: string;
  status?: number | null;
  problems?: string[];
}

/** Captures done by the desktop app's main process with its own Chromium. */
export class DesktopEngine implements CaptureEngine {
  readonly name = 'desktop (built-in Chromium)';
  private readonly pending = new Map<string, (reply: DesktopReply) => void>();

  constructor(private readonly port: ParentPort) {
    port.on('message', (e) => {
      const reply = e.data as DesktopReply;
      if (reply?.type === 'capture_result') this.pending.get(reply.id)?.(reply);
    });
  }

  capture(url: string, opts: CaptureOptions): Promise<CaptureResult> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        this.pending.delete(id);
        opts.signal?.removeEventListener('abort', onAbort);
      };
      const timer = setTimeout(
        () => {
          done();
          reject(new CaptureError('The screenshot took too long.'));
        },
        CAPTURE_LIMITS.loadTimeoutMs + opts.waitMs + 15_000,
      );
      const onAbort = () => {
        done();
        reject(new CaptureError('Cancelled.'));
      };
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, (r) => {
        done();
        if (!r.ok || !r.image) return reject(new CaptureError(r.error ?? 'The screenshot failed.'));
        resolve({
          image: Buffer.from(r.image, 'base64'),
          mime: r.mime ?? 'image/png',
          width: r.width ?? opts.width,
          height: r.height ?? opts.height,
          title: r.title ?? '',
          finalUrl: r.finalUrl ?? url,
          status: r.status ?? null,
          problems: r.problems ?? [],
        });
      });
      this.port.postMessage({
        type: 'capture',
        id,
        url,
        options: {
          width: opts.width,
          height: opts.height,
          fullPage: opts.fullPage,
          waitMs: opts.waitMs,
          maxHeight: CAPTURE_LIMITS.maxHeight,
        },
      });
    });
  }
}

/** The desktop shell's engine when running inside it, else an installed browser, else none. */
export async function detectCaptureEngine(
  env: NodeJS.ProcessEnv = process.env,
): Promise<CaptureEngine | null> {
  const parentPort = (process as { parentPort?: ParentPort }).parentPort;
  if (parentPort && env.FRIDAY_DESKTOP_CAPTURE === '1') return new DesktopEngine(parentPort);
  const chrome = await findChrome(env);
  return chrome ? new ChromeEngine(chrome) : null;
}
