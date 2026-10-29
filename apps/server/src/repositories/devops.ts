import { randomUUID } from 'node:crypto';
import type { DeploymentPlanDto, HostEnvironment, LogSourceDto, SshHostDto } from '@friday/shared';
import type { Db } from '../db/database.js';

interface HostRow {
  id: string;
  name: string;
  hostname: string;
  port: number;
  username: string;
  identity_file: string | null;
  environment: HostEnvironment;
  trusted_fingerprints: string;
  created_at: string;
}

/** A host key the user accepted: its fingerprint and the known_hosts line it came from. */
export interface TrustedKey {
  fingerprint: string;
  line: string;
}

const toHost = (r: HostRow): SshHostDto => ({
  id: r.id,
  name: r.name,
  hostname: r.hostname,
  port: r.port,
  username: r.username,
  identityFile: r.identity_file,
  environment: r.environment,
  trustedFingerprints: (JSON.parse(r.trusted_fingerprints) as TrustedKey[]).map(
    (k) => k.fingerprint,
  ),
  createdAt: r.created_at,
});

export class SshHostRepo {
  constructor(private readonly db: Db) {}

  create(h: Omit<SshHostDto, 'id' | 'createdAt' | 'trustedFingerprints'>): SshHostDto {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO ssh_hosts (id, name, hostname, port, username, identity_file, environment, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        h.name,
        h.hostname,
        h.port,
        h.username,
        h.identityFile,
        h.environment,
        new Date().toISOString(),
      );
    return this.get(id)!;
  }

  get(id: string): SshHostDto | null {
    const row = this.db.prepare('SELECT * FROM ssh_hosts WHERE id = ?').get(id) as
      HostRow | undefined;
    return row ? toHost(row) : null;
  }

  byName(name: string): SshHostDto | null {
    const row = this.db.prepare('SELECT * FROM ssh_hosts WHERE name = ?').get(name) as
      HostRow | undefined;
    return row ? toHost(row) : null;
  }

  list(): SshHostDto[] {
    return (this.db.prepare('SELECT * FROM ssh_hosts ORDER BY name').all() as HostRow[]).map(
      toHost,
    );
  }

  trustedKeys(id: string): TrustedKey[] {
    const row = this.db
      .prepare('SELECT trusted_fingerprints FROM ssh_hosts WHERE id = ?')
      .get(id) as { trusted_fingerprints: string } | undefined;
    return row ? (JSON.parse(row.trusted_fingerprints) as TrustedKey[]) : [];
  }

  setTrusted(id: string, keys: TrustedKey[]): void {
    this.db
      .prepare('UPDATE ssh_hosts SET trusted_fingerprints = ? WHERE id = ?')
      .run(JSON.stringify(keys), id);
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM ssh_hosts WHERE id = ?').run(id).changes > 0;
  }
}

interface LogRow {
  id: string;
  label: string;
  path: string;
  created_at: string;
}

const toLog = (r: LogRow): LogSourceDto => ({
  id: r.id,
  label: r.label,
  path: r.path,
  createdAt: r.created_at,
});

export class LogSourceRepo {
  constructor(private readonly db: Db) {}

  create(label: string, path: string): LogSourceDto {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO log_sources (id, label, path, created_at) VALUES (?, ?, ?, ?)')
      .run(id, label, path, new Date().toISOString());
    return this.list().find((l) => l.id === id)!;
  }

  list(): LogSourceDto[] {
    return (this.db.prepare('SELECT * FROM log_sources ORDER BY label').all() as LogRow[]).map(
      toLog,
    );
  }

  byLabel(label: string): LogSourceDto | null {
    const row = this.db.prepare('SELECT * FROM log_sources WHERE label = ?').get(label) as
      LogRow | undefined;
    return row ? toLog(row) : null;
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM log_sources WHERE id = ?').run(id).changes > 0;
  }
}

export class DeploymentPlanRepo {
  constructor(private readonly db: Db) {}

  create(p: Omit<DeploymentPlanDto, 'id' | 'createdAt'>): DeploymentPlanDto {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const { sessionId, runId, toolCallId, environment, ...rest } = p;
    this.db
      .prepare(
        `INSERT INTO deployment_plans (id, session_id, run_id, tool_call_id, environment, plan, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, sessionId, runId, toolCallId, environment, JSON.stringify(rest), createdAt);
    return { ...p, id, createdAt };
  }

  listBySession(sessionId: string): DeploymentPlanDto[] {
    const rows = this.db
      .prepare('SELECT * FROM deployment_plans WHERE session_id = ? ORDER BY created_at')
      .all(sessionId) as Array<{
      id: string;
      session_id: string;
      run_id: string;
      tool_call_id: string;
      environment: HostEnvironment;
      plan: string;
      created_at: string;
    }>;
    return rows.map((r) => ({
      ...(JSON.parse(r.plan) as Omit<
        DeploymentPlanDto,
        'id' | 'sessionId' | 'runId' | 'toolCallId' | 'environment' | 'createdAt'
      >),
      id: r.id,
      sessionId: r.session_id,
      runId: r.run_id,
      toolCallId: r.tool_call_id,
      environment: r.environment,
      createdAt: r.created_at,
    }));
  }
}
