import { randomUUID } from 'node:crypto';
import type {
  MonitorCheckDto,
  MonitorDetailDto,
  MonitorDto,
  MonitorEventDto,
  MonitorInput,
  MonitorTarget,
} from '@friday/shared';
import { transaction, type Db } from '../db/database.js';

interface Row {
  id: string;
  name: string;
  project_id: string | null;
  target: string;
  interval_minutes: number;
  failures_before_alert: number;
  enabled: number;
  status: 'pending' | 'up' | 'down';
  status_since: string | null;
  last_checked_at: string | null;
  last_message: string | null;
  consecutive_failures: number;
  created_at: string;
  updated_at: string;
}

interface CheckRow {
  checked_at: string;
  ok: number;
  duration_ms: number | null;
  message: string;
}

/** Checks and status changes kept per monitor. */
export const KEEP_CHECKS = 300;
export const KEEP_EVENTS = 100;
const RECENT = 30;

const check = (r: CheckRow): MonitorCheckDto => ({
  at: r.checked_at,
  ok: !!r.ok,
  durationMs: r.duration_ms,
  message: r.message,
});

export interface CheckOutcome {
  ok: boolean;
  durationMs: number | null;
  message: string;
}

/** Health monitors, defined by the user; their state and history are written by MonitorService. */
export class MonitorRepo {
  constructor(private readonly db: Db) {}

  private toDto(r: Row): MonitorDto {
    const recent = (
      this.db
        .prepare(
          'SELECT checked_at, ok, duration_ms, message FROM monitor_checks WHERE monitor_id = ? ORDER BY id DESC LIMIT ?',
        )
        .all(r.id, RECENT) as unknown as CheckRow[]
    )
      .map(check)
      .reverse();
    return {
      id: r.id,
      name: r.name,
      projectId: r.project_id,
      target: JSON.parse(r.target) as MonitorTarget,
      intervalMinutes: r.interval_minutes,
      failuresBeforeAlert: r.failures_before_alert,
      enabled: !!r.enabled,
      status: r.enabled ? r.status : 'paused',
      statusSince: r.status_since,
      lastCheckedAt: r.last_checked_at,
      lastMessage: r.last_message,
      consecutiveFailures: r.consecutive_failures,
      recent,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  create(m: MonitorInput): MonitorDto {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO monitors (id, name, project_id, target, interval_minutes, failures_before_alert, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        m.name,
        m.projectId,
        JSON.stringify(m.target),
        m.intervalMinutes,
        m.failuresBeforeAlert,
        m.enabled ? 1 : 0,
        now,
        now,
      );
    return this.get(id)!;
  }

  /** Changing what is checked starts the monitor over (pending, no failures counted). */
  update(id: string, m: MonitorInput): MonitorDto | null {
    const before = this.get(id);
    if (!before) return null;
    const retarget =
      JSON.stringify(before.target) !== JSON.stringify(m.target) ||
      before.projectId !== m.projectId;
    this.db
      .prepare(
        `UPDATE monitors SET name = ?, project_id = ?, target = ?, interval_minutes = ?, failures_before_alert = ?,
           enabled = ?, updated_at = ?${retarget ? ", status = 'pending', status_since = NULL, consecutive_failures = 0" : ''}
         WHERE id = ?`,
      )
      .run(
        m.name,
        m.projectId,
        JSON.stringify(m.target),
        m.intervalMinutes,
        m.failuresBeforeAlert,
        m.enabled ? 1 : 0,
        new Date().toISOString(),
        id,
      );
    return this.get(id);
  }

  get(id: string): MonitorDto | null {
    const row = this.db.prepare('SELECT * FROM monitors WHERE id = ?').get(id) as unknown as
      Row | undefined;
    return row ? this.toDto(row) : null;
  }

  byName(name: string): MonitorDto | null {
    const row = this.db.prepare('SELECT * FROM monitors WHERE name = ?').get(name) as unknown as
      Row | undefined;
    return row ? this.toDto(row) : null;
  }

  list(): MonitorDto[] {
    return (this.db.prepare('SELECT * FROM monitors ORDER BY name').all() as unknown as Row[]).map(
      (r) => this.toDto(r),
    );
  }

  /** Enabled monitors whose next check is due at `now`. */
  due(now: Date): MonitorDto[] {
    return this.list().filter(
      (m) =>
        m.enabled &&
        (!m.lastCheckedAt ||
          Date.parse(m.lastCheckedAt) + m.intervalMinutes * 60_000 <= now.getTime()),
    );
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM monitors WHERE id = ?').run(id).changes > 0;
  }

  detail(id: string, limit = 100): MonitorDetailDto | null {
    const monitor = this.get(id);
    if (!monitor) return null;
    const checks = (
      this.db
        .prepare(
          'SELECT checked_at, ok, duration_ms, message FROM monitor_checks WHERE monitor_id = ? ORDER BY id DESC LIMIT ?',
        )
        .all(id, limit) as unknown as CheckRow[]
    ).map(check);
    const events = this.db
      .prepare(
        'SELECT at, status, message FROM monitor_events WHERE monitor_id = ? ORDER BY id DESC LIMIT ?',
      )
      .all(id, KEEP_EVENTS) as unknown as MonitorEventDto[];
    return { monitor, checks, events: events.map((e) => ({ ...e })) };
  }

  /**
   * Record one check and move the status: up after a passing check, down after
   * `failuresBeforeAlert` failures in a row. Returns the transition, if any.
   */
  record(
    id: string,
    outcome: CheckOutcome,
    at = new Date(),
  ): { monitor: MonitorDto; transition: 'down' | 'up' | null } | null {
    const m = this.get(id);
    if (!m) return null;
    const iso = at.toISOString();
    const failures = outcome.ok ? 0 : m.consecutiveFailures + 1;
    const prev = this.db.prepare('SELECT status FROM monitors WHERE id = ?').get(id) as {
      status: Row['status'];
    };
    const next: Row['status'] = outcome.ok
      ? 'up'
      : failures >= m.failuresBeforeAlert
        ? 'down'
        : prev.status;
    const changed = next !== prev.status;
    transaction(this.db, () => {
      this.db
        .prepare(
          'INSERT INTO monitor_checks (monitor_id, checked_at, ok, duration_ms, message) VALUES (?, ?, ?, ?, ?)',
        )
        .run(id, iso, outcome.ok ? 1 : 0, outcome.durationMs, outcome.message);
      this.db
        .prepare(
          `DELETE FROM monitor_checks WHERE monitor_id = ? AND id <= (
           SELECT id FROM monitor_checks WHERE monitor_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)`,
        )
        .run(id, id, KEEP_CHECKS);
      this.db
        .prepare(
          `UPDATE monitors SET status = ?, status_since = ?, last_checked_at = ?, last_message = ?,
           consecutive_failures = ? WHERE id = ?`,
        )
        .run(next, changed ? iso : m.statusSince, iso, outcome.message, failures, id);
      if (changed && next !== 'pending') {
        this.db
          .prepare(
            'INSERT INTO monitor_events (monitor_id, at, status, message) VALUES (?, ?, ?, ?)',
          )
          .run(id, iso, next, outcome.message);
        this.db
          .prepare(
            `DELETE FROM monitor_events WHERE monitor_id = ? AND id <= (
             SELECT id FROM monitor_events WHERE monitor_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)`,
          )
          .run(id, id, KEEP_EVENTS);
      }
    });
    // Only a real outage and its recovery are worth a notification (not the first passing check).
    const transition =
      changed && next === 'down' ? 'down' : changed && prev.status === 'down' ? 'up' : null;
    return { monitor: this.get(id)!, transition };
  }
}
