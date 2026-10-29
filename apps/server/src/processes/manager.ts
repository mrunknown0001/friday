import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import type { ProcessDto, ProcessOutputDto } from '@friday/shared';
import { childEnv } from '../commands/runner.js';
import { dockerRunArgs, hostPaths, stopContainer, type SandboxRun } from '../sandbox/docker.js';
import { WorkspaceError } from '../workspace/paths.js';

/**
 * Background processes: dev servers, watchers and other commands that do not exit by themselves.
 * Each one was approved by the user (start_process). They run until stopped (by the user, by
 * Friday, or when Friday quits) and keep only their most recent output. Nothing here is
 * persisted: after a restart they are gone, and processes a crash left behind are found by a
 * marker in their environment and stopped on the next start (reapOrphans).
 */

export const PROCESS_LIMITS = {
  /** Running at once, per project and overall. */
  perProject: 3,
  total: 8,
  /** Finished processes kept for their output, per project. */
  keepFinished: 10,
  /** Characters of output kept per process (the most recent). */
  bufferChars: 256 * 1024,
} as const;

export const PROCESS_ID = /^proc_[a-f0-9]{8}$/;
/** Environment marker identifying this instance's background processes and their children. */
const MARKER = 'FRIDAY_BACKGROUND';
const KILL_GRACE_MS = 5_000;
const MAX_URLS = 5;

// eslint-disable-next-line no-control-regex -- terminal escape sequences are control characters
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const LOCAL_URL =
  /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d{1,5})?(?:\/[^\s'"<>`)\]]*)?/g;

/** Local URLs in output, normalized to localhost (0.0.0.0 and [::] mean "all interfaces"). */
export function findLocalUrls(text: string): string[] {
  return [...text.matchAll(LOCAL_URL)].map((m) =>
    m[0].replace(/[.,;:]+$/, '').replace(/\/\/(?:0\.0\.0\.0|\[::\])/, '//localhost'),
  );
}

export interface StartSpec {
  projectId: string;
  sessionId: string;
  name: string;
  /** Display form of the command. */
  command: string;
  root: string;
  cwdRel: string;
  cwdAbs: string;
  argv: string[] | null;
  shellCommand: string | null;
  /** Set to run in the project's sandbox container. */
  sandbox: SandboxRun | null;
}

interface Managed {
  dto: ProcessDto;
  root: string;
  child: ChildProcess;
  container: string | null;
  buffer: string;
  /** Absolute position (in characters) of buffer[0] in everything the process wrote. */
  start: number;
  total: number;
  waiters: Set<() => void>;
  exited: Promise<void>;
  killTimer?: NodeJS.Timeout;
}

export type WaitResult = 'ready' | 'exited' | 'timeout' | 'cancelled';

export class ProcessManager {
  private readonly procs = new Map<string, Managed>();
  private readonly listeners = new Set<(p: ProcessDto) => void>();

  constructor(
    private readonly opts: {
      /** Label shared with the sandbox containers (one per data folder). */
      instance: string;
      redact: (text: string) => string;
      audit?: (action: string, sessionId: string, details: unknown) => void;
    },
  ) {}

  /** Called on start, status changes and newly seen URLs (not on every line of output). */
  onChange(listener: (p: ProcessDto) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(m: Managed): void {
    const dto = { ...m.dto, urls: [...m.dto.urls] };
    for (const l of this.listeners) {
      try {
        l(dto);
      } catch {
        this.listeners.delete(l);
      }
    }
    for (const w of [...m.waiters]) w();
  }

  /** Running first, then most recent. */
  list(projectId?: string): ProcessDto[] {
    return [...this.procs.values()]
      .filter((m) => projectId === undefined || m.dto.projectId === projectId)
      .map((m) => ({ ...m.dto, urls: [...m.dto.urls] }))
      .sort(
        (a, b) =>
          Number(b.status === 'running') - Number(a.status === 'running') ||
          b.startedAt.localeCompare(a.startedAt),
      );
  }

  get(id: string): ProcessDto | null {
    const m = this.procs.get(id);
    return m ? { ...m.dto, urls: [...m.dto.urls] } : null;
  }

  private active(projectId?: string): Managed[] {
    return [...this.procs.values()].filter(
      (m) =>
        (m.dto.status === 'running' || m.dto.status === 'stopping') &&
        (projectId === undefined || m.dto.projectId === projectId),
    );
  }

  /** The running process with exactly this command and folder, if any (to avoid duplicates). */
  findRunning(projectId: string, command: string, cwd: string): ProcessDto | null {
    const m = this.active(projectId).find((p) => p.dto.command === command && p.dto.cwd === cwd);
    return m ? this.get(m.dto.id) : null;
  }

  /** Throws when another process may not be started now. */
  assertCanStart(projectId: string): void {
    const here = this.active(projectId);
    if (here.length >= PROCESS_LIMITS.perProject) {
      throw new WorkspaceError(
        'unsupported',
        `This project already has ${here.length} background processes running (${here.map((m) => `${m.dto.id} "${m.dto.name}"`).join(', ')}), the limit. Stop one first with stop_process.`,
      );
    }
    if (this.active().length >= PROCESS_LIMITS.total) {
      throw new WorkspaceError(
        'unsupported',
        `Friday already runs ${PROCESS_LIMITS.total} background processes, the limit. Ask the user to stop some in the Processes panel.`,
      );
    }
  }

  start(spec: StartSpec): ProcessDto {
    this.assertCanStart(spec.projectId);
    const id = `proc_${randomBytes(4).toString('hex')}`;
    const [file, args, cwd] = spec.sandbox
      ? ['docker', dockerRunArgs(spec.sandbox), spec.root]
      : spec.shellCommand !== null
        ? ['/bin/sh', ['-c', spec.shellCommand], spec.cwdAbs]
        : [spec.argv![0]!, spec.argv!.slice(1), spec.cwdAbs];

    const child = spawn(file, args, {
      cwd,
      // The marker is inherited by everything the process starts, so leftovers can be found.
      env: { ...childEnv(), [MARKER]: `${this.opts.instance}:${id}` },
      shell: false,
      // Own process group, so stopping it also stops what it started (e.g. npm → node).
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let resolveExited!: () => void;
    const m: Managed = {
      dto: {
        id,
        projectId: spec.projectId,
        sessionId: spec.sessionId,
        name: spec.name,
        command: spec.command,
        cwd: spec.cwdRel,
        sandbox: spec.sandbox
          ? {
              image: spec.sandbox.settings.image,
              network: spec.sandbox.settings.network,
              ports: spec.sandbox.ports ?? [],
            }
          : null,
        status: 'running',
        exitCode: null,
        signal: null,
        error: null,
        stoppedBy: null,
        urls: [],
        startedAt: new Date().toISOString(),
        endedAt: null,
      },
      root: spec.root,
      child,
      container: spec.sandbox?.name ?? null,
      buffer: '',
      start: 0,
      total: 0,
      waiters: new Set(),
      exited: new Promise((r) => (resolveExited = r)),
    };
    this.procs.set(id, m);

    child.stdout!.on('data', (b: Buffer) => this.append(m, b.toString('utf8')));
    child.stderr!.on('data', (b: Buffer) => this.append(m, b.toString('utf8')));
    const finish = (code: number | null, sig: string | null, error: string | null) => {
      if (m.dto.endedAt) return;
      if (m.killTimer) clearTimeout(m.killTimer);
      m.dto.status = m.dto.stoppedBy ? 'stopped' : 'exited';
      m.dto.exitCode = code;
      m.dto.signal = sig;
      m.dto.error = error;
      m.dto.endedAt = new Date().toISOString();
      this.opts.audit?.('process_ended', m.dto.sessionId, {
        id,
        exitCode: code,
        signal: sig,
        stoppedBy: m.dto.stoppedBy,
      });
      this.changed(m);
      resolveExited();
      this.prune(spec.projectId);
    };
    child.on('error', (err: NodeJS.ErrnoException) =>
      finish(null, null, err.code === 'ENOENT' ? `Command not found: ${file}` : err.message),
    );
    child.on('close', (code, sig) => finish(code, sig, null));

    this.opts.audit?.('process_started', spec.sessionId, {
      id,
      name: spec.name,
      command: spec.command,
      cwd: spec.cwdRel,
      sandbox: m.dto.sandbox,
    });
    this.changed(m);
    return this.get(id)!;
  }

  private append(m: Managed, raw: string): void {
    const text = raw.replace(ANSI, '');
    m.buffer += text;
    m.total += text.length;
    if (m.buffer.length > PROCESS_LIMITS.bufferChars) {
      const drop = m.buffer.length - PROCESS_LIMITS.bufferChars;
      m.buffer = m.buffer.slice(drop);
      m.start += drop;
    }
    // Look a little behind the new text too, in case a URL was split across chunks.
    let fresh = false;
    for (const url of findLocalUrls(m.buffer.slice(-(text.length + 200)))) {
      if (m.dto.urls.length >= MAX_URLS || m.dto.urls.includes(url)) continue;
      // In a container, only ports published to this machine are reachable.
      const port = Number(new URL(url).port || 80);
      if (m.dto.sandbox && !m.dto.sandbox.ports.includes(port)) continue;
      m.dto.urls.push(url);
      fresh = true;
    }
    if (fresh) this.changed(m);
    else for (const w of [...m.waiters]) w();
  }

  /**
   * Output, redacted, with container paths shown as project paths. With `since` (a cursor from an
   * earlier read), only what came after it; otherwise the last `tailLines` lines.
   */
  read(id: string, opts: { since?: number; tailLines?: number } = {}): ProcessOutputDto | null {
    const m = this.procs.get(id);
    if (!m) return null;
    let text: string;
    let dropped = m.start > 0;
    if (opts.since !== undefined) {
      const from = Math.max(opts.since, m.start);
      dropped = opts.since < m.start;
      text = m.buffer.slice(Math.min(from - m.start, m.buffer.length));
    } else {
      const lines = m.buffer.split('\n');
      const n = opts.tailLines ?? 100;
      if (lines.length > n + 1) dropped = true;
      text = lines.slice(-(n + 1)).join('\n');
    }
    if (m.dto.sandbox) text = hostPaths(text, m.root);
    return { process: this.get(id)!, output: this.opts.redact(text), cursor: m.total, dropped };
  }

  /**
   * Wait until the process looks ready: `readyText` appears in its output, or (without one) it
   * prints a local URL. Also returns when it exits, on timeout, or when `signal` aborts.
   */
  waitFor(
    id: string,
    opts: { readyText?: string; timeoutMs: number; signal?: AbortSignal; fromCursor?: number },
  ): Promise<WaitResult> {
    const m = this.procs.get(id);
    if (!m) return Promise.resolve('exited');
    const from = opts.fromCursor ?? 0;
    const check = (): WaitResult | null => {
      const seen = m.buffer.slice(Math.max(0, from - m.start));
      if (opts.readyText ? seen.includes(opts.readyText) : m.dto.urls.length > 0) return 'ready';
      if (m.dto.status !== 'running') return 'exited';
      return null;
    };
    return new Promise((resolve) => {
      const done = (r: WaitResult) => {
        clearTimeout(timer);
        m.waiters.delete(waiter);
        opts.signal?.removeEventListener('abort', onAbort);
        resolve(r);
      };
      const waiter = () => {
        const r = check();
        if (r) done(r);
      };
      const onAbort = () => done('cancelled');
      const timer = setTimeout(() => done('timeout'), opts.timeoutMs);
      m.waiters.add(waiter);
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      if (opts.signal?.aborted) onAbort();
      else waiter();
    });
  }

  /** Stop a running process and wait (briefly) for it to end. */
  async stop(id: string, by: NonNullable<ProcessDto['stoppedBy']>): Promise<ProcessDto | null> {
    const m = this.procs.get(id);
    if (!m) return null;
    if (m.dto.status === 'running') {
      m.dto.status = 'stopping';
      m.dto.stoppedBy = by;
      this.opts.audit?.('process_stop_requested', m.dto.sessionId, { id, by });
      this.changed(m);
      const kill = (sig: NodeJS.Signals) => {
        try {
          if (m.child.pid !== undefined) process.kill(-m.child.pid, sig);
        } catch {
          /* already gone */
        }
      };
      if (m.container) {
        // Stopping the container ends the docker client too; the client is killed as a fallback.
        await stopContainer(m.container, KILL_GRACE_MS / 1000);
        m.killTimer = setTimeout(() => kill('SIGKILL'), 2_000);
      } else {
        kill('SIGTERM');
        m.killTimer = setTimeout(() => kill('SIGKILL'), KILL_GRACE_MS);
      }
      m.killTimer.unref();
    }
    await Promise.race([m.exited, new Promise((r) => setTimeout(r, KILL_GRACE_MS + 5_000))]);
    return this.get(id);
  }

  /** Forget a finished process (and its output). */
  dismiss(id: string): boolean {
    const m = this.procs.get(id);
    if (!m || m.dto.status === 'running' || m.dto.status === 'stopping') return false;
    return this.procs.delete(id);
  }

  private prune(projectId: string): void {
    const finished = [...this.procs.values()]
      .filter((m) => m.dto.projectId === projectId && m.dto.endedAt)
      .sort((a, b) => b.dto.endedAt!.localeCompare(a.dto.endedAt!));
    for (const m of finished.slice(PROCESS_LIMITS.keepFinished)) this.procs.delete(m.dto.id);
  }

  /** Stop everything (Friday is quitting). */
  async shutdown(): Promise<void> {
    await Promise.allSettled(this.active().map((m) => this.stop(m.dto.id, 'shutdown')));
  }
}

/**
 * Stop background processes an earlier run of this instance left behind (it crashed or was
 * killed). They are recognized by the marker in their environment, so nothing else is touched.
 * Linux only (reads /proc); elsewhere this does nothing.
 */
export async function reapOrphans(instance: string): Promise<number> {
  let pids: string[];
  try {
    pids = (await fs.readdir('/proc')).filter((d) => /^\d+$/.test(d));
  } catch {
    return 0;
  }
  const needle = `\0${MARKER}=${instance}:`;
  const found: number[] = [];
  for (const pid of pids) {
    if (Number(pid) === process.pid) continue;
    try {
      const environ = `\0${await fs.readFile(`/proc/${pid}/environ`, 'utf8')}`;
      if (environ.includes(needle)) found.push(Number(pid));
    } catch {
      /* not ours to read, or gone */
    }
  }
  for (const pid of found) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
  return found.length;
}
