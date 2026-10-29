import { spawn } from 'node:child_process';

/**
 * Only these variables reach child processes. Anything else, including NTL_API_KEY and other
 * secrets in the server environment, is withheld.
 */
const ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LANGUAGE',
  'TZ',
  'TMPDIR',
];
const FIXED_ENV: Record<string, string> = {
  CI: '1',
  TERM: 'dumb',
  NO_COLOR: '1',
  FORCE_COLOR: '0',
  GIT_TERMINAL_PROMPT: '0',
};

export function childEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (v !== undefined && (ENV_ALLOWLIST.includes(k) || k.startsWith('LC_'))) env[k] = v;
  }
  return { ...env, ...FIXED_ENV };
}

export interface RunOptions {
  argv: string[] | null;
  shellCommand: string | null;
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal;
  onOutput?: (chunk: string) => void;
  /** Extra variables for this process only (e.g. SSH_AUTH_SOCK for ssh). */
  extraEnv?: Record<string, string>;
  /** Bytes kept from the start of the output; the last `tailBytes` are always kept too. */
  headBytes?: number;
  tailBytes?: number;
}

export interface RunResult {
  exitCode: number | null;
  signal: string | null;
  output: string;
  /** Bytes dropped from the middle of the output. */
  omittedBytes: number;
  timedOut: boolean;
  cancelled: boolean;
  spawnError: string | null;
  durationMs: number;
}

const KILL_GRACE_MS = 3_000;

/**
 * Run a process without a shell (argv) or through /bin/sh only when explicitly requested.
 * stdin is closed (no interactive prompts). The process gets its own group so timeouts and
 * cancellation also stop its children. This is not a sandbox: it runs as the current user.
 */
export function runProcess(opts: RunOptions): Promise<RunResult> {
  const started = Date.now();
  const headLimit = opts.headBytes ?? 256 * 1024;
  const tailLimit = opts.tailBytes ?? 64 * 1024;
  const [file, args] =
    opts.shellCommand !== null
      ? ['/bin/sh', ['-c', opts.shellCommand]]
      : [opts.argv![0]!, opts.argv!.slice(1)];

  return new Promise((resolve) => {
    let head = '';
    let tail = '';
    let omitted = 0;
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: { ...childEnv(), ...opts.extraEnv },
      shell: false,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stop = () => {
      if (child.pid === undefined || child.exitCode !== null) return;
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
      killTimer = setTimeout(() => {
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }, KILL_GRACE_MS);
      killTimer.unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, opts.timeoutMs);
    const onAbort = () => {
      cancelled = true;
      stop();
    };
    opts.signal.addEventListener('abort', onAbort, { once: true });
    if (opts.signal.aborted) onAbort();

    const collect = (buf: Buffer) => {
      const text = buf.toString('utf8');
      opts.onOutput?.(text);
      if (head.length < headLimit) {
        const room = headLimit - head.length;
        head += text.slice(0, room);
        if (text.length <= room) return;
        tail += text.slice(room);
      } else {
        tail += text;
      }
      if (tail.length > tailLimit) {
        omitted += tail.length - tailLimit;
        tail = tail.slice(-tailLimit);
      }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    const finish = (exitCode: number | null, sig: string | null, spawnError: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal.removeEventListener('abort', onAbort);
      resolve({
        exitCode,
        signal: sig,
        output: omitted > 0 ? `${head}\n[... ${omitted} bytes omitted ...]\n${tail}` : head + tail,
        omittedBytes: omitted,
        timedOut,
        cancelled,
        spawnError,
        durationMs: Date.now() - started,
      });
    };
    child.on('error', (err: NodeJS.ErrnoException) =>
      finish(null, null, err.code === 'ENOENT' ? `Command not found: ${file}` : err.message),
    );
    child.on('close', (code, sig) => {
      if (killTimer) clearTimeout(killTimer);
      finish(code, sig, null);
    });
  });
}
