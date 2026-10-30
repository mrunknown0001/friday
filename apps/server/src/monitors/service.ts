import type { MonitorDto } from '@friday/shared';
import type { MonitorRepo } from '../repositories/monitors.js';
import { runCheck, type CheckDeps } from './checks.js';

export interface MonitorChange {
  monitor: MonitorDto;
  transition: 'down' | 'up' | null;
}

const CONCURRENCY = 4;

/**
 * Runs due health monitors on a timer (and on request), records each result and tells listeners,
 * which turn status changes into notifications. Checks never overlap for the same monitor.
 */
export class MonitorService {
  private timer: NodeJS.Timeout | null = null;
  private readonly running = new Map<string, Promise<MonitorChange | null>>();
  private readonly listeners = new Set<(c: MonitorChange) => void>();
  private readonly controller = new AbortController();

  constructor(
    private readonly repo: MonitorRepo,
    private readonly deps: CheckDeps,
    private readonly redact: (text: string) => string = (t) => t,
  ) {}

  start(tickMs = 15_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), tickMs);
    this.timer.unref();
    // First round shortly after start-up, not in the middle of it.
    setTimeout(() => void this.tick(), 3_000).unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.controller.abort();
  }

  onChange(listener: (c: MonitorChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Check every due monitor, a few at a time. */
  async tick(now = new Date()): Promise<MonitorChange[]> {
    const due = this.repo.due(now).filter((m) => !this.running.has(m.id));
    const out: MonitorChange[] = [];
    for (let i = 0; i < due.length; i += CONCURRENCY) {
      const batch = await Promise.all(due.slice(i, i + CONCURRENCY).map((m) => this.check(m.id)));
      for (const c of batch) if (c) out.push(c);
    }
    return out;
  }

  /** Check one monitor now (joins a check already in progress). */
  check(id: string): Promise<MonitorChange | null> {
    const existing = this.running.get(id);
    if (existing) return existing;
    const p = this.doCheck(id).finally(() => this.running.delete(id));
    this.running.set(id, p);
    return p;
  }

  private async doCheck(id: string): Promise<MonitorChange | null> {
    const m = this.repo.get(id);
    if (!m) return null;
    const started = Date.now();
    let ok: boolean;
    let message: string;
    try {
      ({ ok, message } = await runCheck(m, this.deps, this.controller.signal));
    } catch (err) {
      ok = false;
      message = err instanceof Error ? err.message : String(err);
    }
    if (this.controller.signal.aborted) return null;
    let change: MonitorChange | null;
    try {
      change = this.repo.record(id, {
        ok,
        durationMs: Date.now() - started,
        message: this.redact(message).slice(0, 500),
      });
    } catch {
      return null; // the database is closing
    }
    if (!change) return null; // deleted while it was being checked
    for (const l of this.listeners) {
      try {
        l(change);
      } catch {
        this.listeners.delete(l);
      }
    }
    return change;
  }
}
