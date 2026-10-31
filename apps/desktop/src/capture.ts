import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { BrowserWindow, session, shell, type Session, type UtilityProcess } from 'electron';

/**
 * Screenshots of local pages for the Friday server (its `screenshot` tool), taken with the app's
 * own Chromium. Pages load in a hidden offscreen window with a separate in-memory session: it
 * never carries the launch token, keeps no cookies after quitting, gets no permissions, cannot
 * download or open windows, and may only load documents (pages, frames, redirects) from this
 * machine.
 */

const PARTITION = 'friday-capture';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0']);

export function isLocalUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return (u.protocol === 'http:' || u.protocol === 'https:') && LOCAL_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

let configured: Session | null = null;

export function captureSession(): Session {
  if (configured) return configured;
  const s = session.fromPartition(PARTITION);
  s.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    const document = details.resourceType === 'mainFrame' || details.resourceType === 'subFrame';
    callback({ cancel: document && !isLocalUrl(details.url) });
  });
  s.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  s.setPermissionCheckHandler(() => false);
  s.on('will-download', (_event, item) => item.cancel());
  configured = s;
  return s;
}

let printing: Session | null = null;

/** Printing documents to PDF: no network at all (the HTML is self-contained), no scripts. */
export function printSession(): Session {
  if (printing) return printing;
  const s = session.fromPartition('friday-print');
  s.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) =>
    callback({ cancel: !details.url.startsWith('data:') }),
  );
  s.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  s.setPermissionCheckHandler(() => false);
  s.on('will-download', (_event, item) => item.cancel());
  printing = s;
  return s;
}

interface PrintRequest {
  type: 'print';
  id: string;
  html: string;
  footerHtml: string;
}

async function printPdf(req: PrintRequest): Promise<Buffer> {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      session: printSession(),
      javascript: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  try {
    await win.loadURL(
      `data:text/html;charset=utf-8;base64,${Buffer.from(req.html).toString('base64')}`,
    );
    return await win.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: req.footerHtml,
    });
  } finally {
    win.destroy();
  }
}

interface CaptureRequest {
  type: 'capture';
  id: string;
  url: string;
  options: { width: number; height: number; fullPage: boolean; waitMs: number; maxHeight: number };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_PROBLEMS = 25;
const LOAD_TIMEOUT_MS = 20_000;
const MAX_PNG_BYTES = 4 * 1024 * 1024;

async function capture(req: CaptureRequest) {
  const { url, options } = req;
  if (!isLocalUrl(url)) throw new Error('Only pages on this machine can be captured.');
  const win = new BrowserWindow({
    show: false,
    width: options.width,
    height: options.height,
    useContentSize: true,
    webPreferences: {
      session: captureSession(),
      offscreen: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  const problems: string[] = [];
  const note = (p: string) => {
    if (problems.length < MAX_PROBLEMS) problems.push(p.slice(0, 500));
  };
  let status: number | null = null;
  const wc = win.webContents;
  wc.on('console-message', (details) => {
    if (details.level === 'error' || details.level === 'warning')
      note(`console.${details.level === 'error' ? 'error' : 'warn'}: ${details.message}`);
  });
  wc.on('did-navigate', (_e, _url, code) => {
    if (status === null) status = code;
  });
  wc.on('did-fail-load', (_e, code, description, failedUrl, isMainFrame) => {
    if (!isMainFrame && code !== -3)
      note(
        code === -20
          ? `blocked: navigation to ${failedUrl} (only pages on this machine are opened)`
          : `failed: ${failedUrl} (${description})`,
      );
  });
  try {
    try {
      await Promise.race([
        win.loadURL(url),
        sleep(LOAD_TIMEOUT_MS).then(() =>
          note(`the page did not finish loading within ${LOAD_TIMEOUT_MS / 1000}s`),
        ),
      ]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/ERR_CONNECTION_REFUSED/.test(message))
        throw new Error(
          `Nothing is listening at ${url} (connection refused). Is the dev server running?`,
          { cause: err },
        );
      if (/ERR_BLOCKED_BY_CLIENT/.test(message))
        throw new Error(
          `${url} redirects to a page that is not on this machine; only local pages are opened.`,
          { cause: err },
        );
      throw new Error(`Could not open ${url}: ${message.replace(/^.*?(ERR_\w+).*$/s, '$1')}`, {
        cause: err,
      });
    }
    if (options.waitMs) await sleep(options.waitMs);
    let height = options.height;
    if (options.fullPage) {
      const full = Number(
        await wc.executeJavaScript(
          'Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)',
        ),
      );
      height = Math.min(
        Math.max(Math.ceil(full) || options.height, options.height),
        options.maxHeight,
      );
      if (full > options.maxHeight)
        note(`page is ${Math.ceil(full)}px tall; captured the top ${options.maxHeight}px`);
      win.setContentSize(options.width, height);
      await sleep(300);
    }
    const image = await wc.capturePage();
    const size = image.getSize();
    let data = image.toPNG();
    let mime: 'image/png' | 'image/jpeg' = 'image/png';
    if (data.length > MAX_PNG_BYTES) {
      data = image.toJPEG(82);
      mime = 'image/jpeg';
    }
    return {
      image: data.toString('base64'),
      mime,
      width: size.width,
      height: size.height,
      title: wc.getTitle(),
      finalUrl: wc.getURL(),
      status,
      problems,
    };
  } finally {
    win.destroy();
  }
}

// ---------------------------------------------------------------- browser flows

/**
 * Pages the server drives step by step (browser flows), in the same capture session: hidden
 * offscreen windows, documents from this machine only, no other windows, no downloads. Only these
 * DevTools methods are relayed.
 */
const PAGE_METHODS = new Set([
  'Page.enable',
  'Page.navigate',
  'Page.getFrameTree',
  'Page.handleJavaScriptDialog',
  'Page.captureScreenshot',
  'Runtime.enable',
  'Runtime.evaluate',
  'Runtime.callFunctionOn',
  'Runtime.releaseObject',
  'Network.enable',
  'Input.dispatchMouseEvent',
  'Input.dispatchKeyEvent',
  'Input.insertText',
]);
const MAX_PAGES = 4;
const pages = new Map<string, BrowserWindow>();

async function openPage(width: number, height: number, child: UtilityProcess): Promise<string> {
  if (pages.size >= MAX_PAGES) throw new Error('Too many browser flows are running.');
  const win = new BrowserWindow({
    show: false,
    width,
    height,
    useContentSize: true,
    webPreferences: {
      session: captureSession(),
      offscreen: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  const id = randomUUID();
  const wc = win.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  // DevTools commands wait for a renderer, which a window gets once it loads something.
  try {
    await win.loadURL('about:blank');
    wc.debugger.attach('1.3');
  } catch (err) {
    win.destroy();
    throw err;
  }
  wc.debugger.on('message', (_event, method, params) =>
    child.postMessage({ type: 'page_event', page: id, method, params }),
  );
  win.on('closed', () => pages.delete(id));
  pages.set(id, win);
  return id;
}

async function pageSend(
  id: string,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const win = pages.get(id);
  if (!win || win.isDestroyed()) throw new Error('The page is closed.');
  if (!PAGE_METHODS.has(method)) throw new Error(`${method} is not allowed.`);
  if (method === 'Page.captureScreenshot') {
    // An offscreen window paints through its own frames, not the DevTools screencast.
    const image = await win.webContents.capturePage();
    const data =
      params.format === 'jpeg'
        ? image.toJPEG(typeof params.quality === 'number' ? params.quality : 80)
        : image.toPNG();
    return { data: data.toString('base64') };
  }
  return win.webContents.debugger.sendCommand(method, params);
}

function closePage(id: string): void {
  const win = pages.get(id);
  pages.delete(id);
  if (win && !win.isDestroyed()) win.destroy();
}

interface PageRequest {
  type: 'page_open' | 'page_send' | 'page_close';
  id: string;
  page?: string;
  width?: number;
  height?: number;
  method?: string;
  params?: Record<string, unknown>;
}

function servePage(req: PageRequest, child: UtilityProcess): void {
  const reply = (r: { ok: boolean; result?: unknown; error?: string }) =>
    child.postMessage({ type: 'page_result', id: req.id, ...r });
  const fail = (err: unknown) =>
    reply({ ok: false, error: err instanceof Error ? err.message : String(err) });
  try {
    if (req.type === 'page_open') {
      const width = Math.min(Math.max(Number(req.width) || 1280, 320), 2560);
      const height = Math.min(Math.max(Number(req.height) || 800, 240), 2000);
      openPage(width, height, child).then((page) => reply({ ok: true, result: { page } }), fail);
    } else if (req.type === 'page_close') {
      closePage(String(req.page));
      reply({ ok: true });
    } else {
      pageSend(String(req.page), String(req.method), req.params ?? {}).then(
        (result) => reply({ ok: true, result }),
        fail,
      );
    }
  } catch (err) {
    fail(err);
  }
}

/** Close every driven page (the server stopped). */
export function closeAllPages(): void {
  for (const id of [...pages.keys()]) closePage(id);
}

/** Answer capture requests from the server (utility process). */
export function serveCaptures(child: UtilityProcess): void {
  child.on('message', (message: unknown) => {
    const open = message as { type?: string; id?: string; path?: string };
    if (
      open?.type === 'open_path' &&
      typeof open.id === 'string' &&
      typeof open.path === 'string'
    ) {
      const id = open.id;
      // The server checked the file is inside a project; only documents are ever opened.
      const allowed = path.isAbsolute(open.path) && /\.(pdf|docx|xlsx|pptx)$/i.test(open.path);
      (allowed ? shell.openPath(open.path) : Promise.resolve('Only documents can be opened.')).then(
        (error) =>
          child.postMessage({ type: 'open_result', id, ok: !error, ...(error ? { error } : {}) }),
      );
      return;
    }
    const page = message as PageRequest;
    if (
      (page?.type === 'page_open' || page?.type === 'page_send' || page?.type === 'page_close') &&
      typeof page.id === 'string'
    ) {
      servePage(page, child);
      return;
    }
    const print = message as PrintRequest;
    if (print?.type === 'print' && typeof print.id === 'string' && typeof print.html === 'string') {
      printPdf(print).then(
        (pdf) =>
          child.postMessage({
            type: 'print_result',
            id: print.id,
            ok: true,
            pdf: pdf.toString('base64'),
          }),
        (err: unknown) =>
          child.postMessage({
            type: 'print_result',
            id: print.id,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
      );
      return;
    }
    const req = message as CaptureRequest;
    if (req?.type !== 'capture' || typeof req.id !== 'string' || typeof req.url !== 'string')
      return;
    capture(req).then(
      (result) => child.postMessage({ type: 'capture_result', id: req.id, ok: true, ...result }),
      (err: unknown) =>
        child.postMessage({
          type: 'capture_result',
          id: req.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }),
    );
  });
}
