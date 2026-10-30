import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  session,
  shell,
  utilityProcess,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type UtilityProcess,
} from 'electron';
import { captureSession, isLocalUrl, printSession, serveCaptures } from './capture.js';

/**
 * Friday desktop shell. The agent runs in the same local server as the web version, started here
 * as an Electron utility process on a random loopback port. Security model:
 * - The renderer is sandboxed with context isolation and no Node.js; it only talks HTTP to the
 *   server, like the browser version, plus four user-driven IPC calls (see preload.cts).
 * - Every request to the server carries a per-launch token added at the network layer, so the
 *   page's JavaScript never sees it and other local programs or users cannot drive the agent.
 * - Navigation, new windows, webviews and permission prompts are locked down to the app itself.
 */

const TOKEN_HEADER = 'x-friday-token';
const ENV_TEMPLATE = `# Friday configuration. Keep this file private: it is created readable by you only.
# Get an API key from https://notokenlimit.com, paste it after the = sign, then use
# Friday > Restart Server.
NTL_API_KEY=
# Optional: default model ID. You can also choose a model in Settings.
NTL_MODEL=
`;

interface Paths {
  serverEntry: string;
  webDist: string;
  dataDir: string;
  envFile: string;
  logFile: string;
}

/** FRIDAY_DATA_DIR and FRIDAY_ENV_FILE, when set, override the defaults (absolute paths only). */
function override(name: 'FRIDAY_DATA_DIR' | 'FRIDAY_ENV_FILE'): string | null {
  const value = process.env[name]?.trim();
  return value && path.isAbsolute(value) ? value : null;
}

function resolvePaths(): Paths {
  const userData = app.getPath('userData');
  const logFile = path.join(userData, 'logs', 'server.log');
  if (app.isPackaged) {
    return {
      serverEntry: path.join(process.resourcesPath, 'server', 'index.mjs'),
      webDist: path.join(process.resourcesPath, 'web'),
      dataDir: override('FRIDAY_DATA_DIR') ?? path.join(userData, 'data'),
      envFile: override('FRIDAY_ENV_FILE') ?? path.join(userData, 'friday.env'),
      logFile,
    };
  }
  // Running from the repository: share the web version's .env and data folder.
  const appDir = app.getAppPath();
  const repoRoot = path.resolve(appDir, '../..');
  return {
    serverEntry: path.join(appDir, 'build', 'server', 'index.mjs'),
    webDist: path.join(repoRoot, 'apps', 'web', 'dist'),
    dataDir: override('FRIDAY_DATA_DIR') ?? path.join(repoRoot, '.data'),
    envFile: override('FRIDAY_ENV_FILE') ?? path.join(repoRoot, '.env'),
    logFile,
  };
}

const paths = resolvePaths();
const token = randomBytes(32).toString('base64url');
let port = 0;
let origin = '';
let server: UtilityProcess | null = null;
let stopping = false;
let quitting = false;
let mainWindow: BrowserWindow | null = null;

function openLog(): fs.WriteStream {
  fs.mkdirSync(path.dirname(paths.logFile), { recursive: true, mode: 0o700 });
  try {
    // Keep one previous log; the server logs only request lines and events, never prompts or keys.
    if (fs.statSync(paths.logFile).size > 5 * 1024 * 1024) {
      fs.renameSync(paths.logFile, `${paths.logFile}.1`);
    }
  } catch {
    // No log yet.
  }
  return fs.createWriteStream(paths.logFile, { flags: 'a', mode: 0o600 });
}

/** Last lines of the server log, for startup and crash dialogs. */
function logTail(lines = 8): string {
  try {
    return fs.readFileSync(paths.logFile, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

/**
 * The server binds a free port itself and reports it over the utility-process channel. Picking a
 * port here and passing it down would leave a gap in which another local program could take it,
 * receive the launch token and serve its own page in the app window.
 */
function waitForListening(child: UtilityProcess, timeoutMs = 20_000): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('The Friday server did not start within 20 seconds.'));
    }, timeoutMs);
    const onMessage = (message: unknown) => {
      const m = message as { type?: unknown; port?: unknown };
      if (m?.type !== 'listening' || typeof m.port !== 'number') return;
      cleanup();
      resolve(m.port);
    };
    const onExit = () => {
      cleanup();
      reject(new Error('The Friday server exited during startup.'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
    };
    child.on('message', onMessage);
    child.once('exit', onExit);
  });
}

async function startServer(): Promise<void> {
  const log = openLog();
  log.write(`\n--- ${new Date().toISOString()} starting Friday server\n`);
  const child = utilityProcess.fork(paths.serverEntry, [], {
    serviceName: 'Friday server',
    stdio: 'pipe',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      FRIDAY_PORT: '0',
      FRIDAY_LAUNCH_TOKEN: token,
      FRIDAY_DATA_DIR: paths.dataDir,
      FRIDAY_ENV_FILE: paths.envFile,
      FRIDAY_WEB_DIST: paths.webDist,
      // Screenshots are taken by this process with the app's own Chromium (see capture.ts).
      FRIDAY_DESKTOP_CAPTURE: '1',
    },
  });
  serveCaptures(child);
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  server = child;
  let started = false;
  child.once('exit', (code) => {
    if (server === child) server = null;
    log.end();
    // Startup failures are reported by the caller; this is for crashes afterwards.
    if (started && !stopping && !quitting) void onServerCrash(code);
  });

  port = await waitForListening(child);
  origin = `http://127.0.0.1:${port}`;
  // Add the launch token to every request the app makes to its own server, and nowhere else:
  // not to requests a page embedded in the app (the live preview of a dev server) makes to it.
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: [`${origin}/*`] },
    (details, callback) => {
      const frameUrl = details.frame?.url;
      if (frameUrl && frameUrl.startsWith('http') && !frameUrl.startsWith(`${origin}/`))
        return callback({ requestHeaders: details.requestHeaders });
      callback({ requestHeaders: { ...details.requestHeaders, [TOKEN_HEADER]: token } });
    },
  );
  started = true;
}

async function stopServer(): Promise<void> {
  const child = server;
  if (!child) return;
  stopping = true;
  await new Promise<void>((resolve) => {
    // The server finishes in-flight work on SIGTERM; don't wait forever.
    const timer = setTimeout(() => {
      child.kill();
      resolve();
    }, 8_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill();
  });
  server = null;
  stopping = false;
}

async function restartServer(): Promise<void> {
  await stopServer();
  try {
    await startServer();
    await mainWindow?.loadURL(`${origin}/`);
  } catch (err) {
    await showStartupError(err);
  }
}

async function onServerCrash(code: number): Promise<void> {
  const { response } = await dialog.showMessageBox({
    type: 'error',
    title: 'Friday',
    message: `The Friday server stopped unexpectedly (exit code ${code}).`,
    detail: `${logTail()}\n\nFull log: ${paths.logFile}`,
    buttons: ['Restart server', 'Quit'],
    defaultId: 0,
  });
  if (response === 0) await restartServer();
  else app.quit();
}

async function showStartupError(err: unknown): Promise<void> {
  const { response } = await dialog.showMessageBox({
    type: 'error',
    title: 'Friday',
    message: err instanceof Error ? err.message : String(err),
    detail: `${logTail()}\n\nFull log: ${paths.logFile}`,
    buttons: ['Try again', 'Quit'],
    defaultId: 0,
  });
  if (response === 0) await restartServer();
  else app.quit();
}

function ensureEnvFile(): void {
  if (fs.existsSync(paths.envFile)) return;
  fs.mkdirSync(path.dirname(paths.envFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.envFile, ENV_TEMPLATE, { flag: 'wx', mode: 0o600 });
}

/** IPC is only honoured from the app's own top-level page. */
function fromApp(event: IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  return (
    !!frame &&
    frame === event.sender.mainFrame &&
    event.sender === mainWindow?.webContents &&
    new URL(frame.url).origin === origin
  );
}

function registerIpc(): void {
  ipcMain.handle('friday:pick-folder', async (event) => {
    if (!fromApp(event) || !mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a project folder',
      properties: ['openDirectory'],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle('friday:restart-server', async (event) => {
    if (fromApp(event)) await restartServer();
  });
  ipcMain.handle('friday:focus-window', (event) => {
    if (!fromApp(event) || !mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  ipcMain.handle('friday:show-config-file', (event) => {
    if (!fromApp(event)) return;
    ensureEnvFile();
    shell.showItemInFolder(paths.envFile);
  });
}

function isExternalWebUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.origin !== origin;
  } catch {
    return false;
  }
}

function lockDownContents(): void {
  app.on('web-contents-created', (_event, contents) => {
    // The hidden screenshot window has its own, stricter session rules (capture.ts).
    if (contents.session === captureSession() || contents.session === printSession()) {
      contents.setWindowOpenHandler(() => ({ action: 'deny' }));
      contents.on('will-attach-webview', (event) => event.preventDefault());
      return;
    }
    // Frames inside the app (the live preview) stay on this machine.
    contents.on('will-frame-navigate', (details) => {
      if (!details.isMainFrame && !isLocalUrl(details.url)) details.preventDefault();
    });
    // Links to other sites open in the system browser; the app window never leaves the app.
    contents.setWindowOpenHandler(({ url }) => {
      if (isExternalWebUrl(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
      if (new URL(url).origin === origin) return;
      event.preventDefault();
      if (isExternalWebUrl(url)) void shell.openExternal(url);
    });
    contents.on('will-redirect', (event, url) => {
      if (new URL(url).origin !== origin) event.preventDefault();
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });

  // Only clipboard writes ("Copy code") and notifications are allowed, and only for the app itself.
  const allowed = (permission: string, requestingUrl: string | undefined) =>
    (permission === 'clipboard-sanitized-write' || permission === 'notifications') &&
    !!requestingUrl &&
    new URL(requestingUrl).origin === origin;
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) =>
    callback(allowed(permission, contents.getURL())),
  );
  session.defaultSession.setPermissionCheckHandler((_contents, permission, requestingOrigin) =>
    allowed(permission, requestingOrigin),
  );
}

function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'Friday',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Show Config File',
          click: () => {
            ensureEnvFile();
            shell.showItemInFolder(paths.envFile);
          },
        },
        { label: 'Open Data Folder', click: () => void shell.openPath(paths.dataDir) },
        { label: 'Open Server Log', click: () => shell.showItemInFolder(paths.logFile) },
        { label: 'Restart Server', click: () => void restartServer() },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' } as const]),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Friday',
    backgroundColor: '#09090b',
    webPreferences: {
      preload: path.join(import.meta.dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => (mainWindow = null));
  await mainWindow.loadURL(`${origin}/`);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.focus();
  });

  app.on('before-quit', (event) => {
    if (quitting || !server) return;
    // Let the server stop running tasks and close the database before exiting.
    event.preventDefault();
    quitting = true;
    void stopServer().finally(() => app.quit());
  });
  app.on('window-all-closed', () => app.quit());

  void app.whenReady().then(async () => {
    if (app.isPackaged) ensureEnvFile();
    lockDownContents();
    registerIpc();
    buildMenu();
    try {
      await startServer();
    } catch (err) {
      await showStartupError(err);
      if (!server) return;
    }
    await createWindow();
  });
}
