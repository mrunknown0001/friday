import type { ProviderCallDto } from '@friday/shared';
import type { Db } from '../db/database.js';
import type { ProviderCallRecord } from '../providers/types.js';

export class ProviderCallRepo {
  constructor(private readonly db: Db) {}

  insert(r: ProviderCallRecord): void {
    this.db
      .prepare(
        `INSERT INTO provider_calls
          (created_at, model, operation, status, error_kind, duration_ms, attempts, input_tokens, output_tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        new Date().toISOString(),
        r.model,
        r.operation,
        r.status,
        r.errorKind,
        r.durationMs,
        r.attempts,
        r.usage?.inputTokens ?? null,
        r.usage?.outputTokens ?? null,
      );
  }

  recent(limit = 50): ProviderCallDto[] {
    const rows = this.db
      .prepare('SELECT * FROM provider_calls ORDER BY id DESC LIMIT ?')
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r['id'] as number,
      createdAt: r['created_at'] as string,
      model: r['model'] as string,
      operation: r['operation'] as string,
      status: r['status'] as ProviderCallDto['status'],
      errorKind: (r['error_kind'] as ProviderCallDto['errorKind']) ?? null,
      durationMs: r['duration_ms'] as number,
      attempts: r['attempts'] as number,
      inputTokens: (r['input_tokens'] as number | null) ?? null,
      outputTokens: (r['output_tokens'] as number | null) ?? null,
    }));
  }
}

export class AuditRepo {
  constructor(private readonly db: Db) {}

  record(e: {
    sessionId?: string | null;
    actor: 'user' | 'system' | 'agent';
    action: string;
    details?: unknown;
  }): void {
    this.db
      .prepare(
        'INSERT INTO audit_events (created_at, session_id, actor, action, details) VALUES (?, ?, ?, ?, ?)',
      )
      .run(
        new Date().toISOString(),
        e.sessionId ?? null,
        e.actor,
        e.action,
        e.details === undefined ? null : JSON.stringify(e.details),
      );
  }

  list(limit = 100): Array<{
    id: number;
    createdAt: string;
    sessionId: string | null;
    actor: string;
    action: string;
    details: unknown;
  }> {
    const rows = this.db
      .prepare('SELECT * FROM audit_events ORDER BY id DESC LIMIT ?')
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r['id'] as number,
      createdAt: r['created_at'] as string,
      sessionId: (r['session_id'] as string | null) ?? null,
      actor: r['actor'] as string,
      action: r['action'] as string,
      details: r['details'] ? JSON.parse(r['details'] as string) : null,
    }));
  }
}
