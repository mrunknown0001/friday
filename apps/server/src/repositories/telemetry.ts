import type {
  ContextUsageDto,
  ModelPrice,
  ProviderCallDto,
  UsageSummaryDto,
  UsageTotals,
} from '@friday/shared';
import type { Db } from '../db/database.js';
import type { ProviderCallRecord } from '../providers/types.js';

export class ProviderCallRepo {
  constructor(private readonly db: Db) {}

  insert(r: ProviderCallRecord): void {
    this.db
      .prepare(
        `INSERT INTO provider_calls
          (created_at, model, operation, status, error_kind, duration_ms, attempts, input_tokens, output_tokens, session_id, tokens_estimated,
           run_id, cached_tokens, cache_write_tokens, ctx_system, ctx_tools, ctx_history, ctx_tool_results, ctx_baseline)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        r.sessionId,
        r.tokensEstimated ? 1 : 0,
        r.runId ?? null,
        r.usage?.cachedInputTokens ?? null,
        r.usage?.cacheWriteTokens ?? null,
        r.breakdown?.system ?? null,
        r.breakdown?.tools ?? null,
        r.breakdown?.history ?? null,
        r.breakdown?.toolResults ?? null,
        r.breakdown?.baseline ?? null,
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
      tokensEstimated: r['tokens_estimated'] === 1,
    }));
  }
}

const DAY_MS = 86_400_000;

interface UsageRow {
  day: string;
  model: string;
  session_id: string | null;
  title: string | null;
  calls: number;
  errors: number;
  estimated: number;
  without_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  duration_ms: number;
}

interface ContextRow {
  requests: number;
  system: number | null;
  tools: number | null;
  history: number | null;
  tool_results: number | null;
  baseline: number | null;
  input_tokens: number;
  cached_tokens: number;
}

const emptyTotals = (): UsageTotals => ({
  calls: 0,
  errors: 0,
  estimatedCalls: 0,
  callsWithoutTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  durationMs: 0,
  cost: null,
});

function add(into: UsageTotals, r: UsageRow, price: ModelPrice | undefined): void {
  into.calls += r.calls;
  into.errors += r.errors;
  into.estimatedCalls += r.estimated;
  into.callsWithoutTokens += r.without_tokens;
  into.inputTokens += r.input_tokens;
  into.outputTokens += r.output_tokens;
  into.cachedInputTokens += r.cached_tokens;
  into.durationMs += r.duration_ms;
  if (price)
    into.cost =
      (into.cost ?? 0) + (r.input_tokens * price.input + r.output_tokens * price.output) / 1e6;
}

/** Usage totals from Friday's own provider call records: metadata only, never prompt content. */
export class UsageRepo {
  constructor(private readonly db: Db) {}

  /**
   * The last `days` local days, today included. `tzOffsetMinutes` is the viewer's offset east of
   * UTC (480 for UTC+8), so days are bucketed the way the viewer reads a calendar.
   */
  summary(opts: {
    days: number;
    tzOffsetMinutes: number;
    prices: Record<string, ModelPrice>;
    now?: Date;
  }): Omit<UsageSummaryDto, 'optimization'> {
    const shift = opts.tzOffsetMinutes * 60_000;
    const localToday = new Date((opts.now ?? new Date()).getTime() + shift)
      .toISOString()
      .slice(0, 10);
    const startDay = Date.parse(`${localToday}T00:00:00Z`) - (opts.days - 1) * DAY_MS;
    const since = new Date(startDay - shift).toISOString();
    const modifier = `${opts.tzOffsetMinutes >= 0 ? '+' : ''}${opts.tzOffsetMinutes} minutes`;

    const rows = this.db
      .prepare(
        `SELECT date(c.created_at, ?) AS day, c.model, c.session_id, s.title,
                COUNT(*) AS calls,
                SUM(c.status = 'error') AS errors,
                SUM(c.tokens_estimated) AS estimated,
                SUM(c.input_tokens IS NULL AND c.output_tokens IS NULL) AS without_tokens,
                COALESCE(SUM(c.input_tokens), 0) AS input_tokens,
                COALESCE(SUM(c.output_tokens), 0) AS output_tokens,
                COALESCE(SUM(c.cached_tokens), 0) AS cached_tokens,
                SUM(c.duration_ms) AS duration_ms
           FROM provider_calls c LEFT JOIN sessions s ON s.id = c.session_id
          WHERE c.created_at >= ? AND c.operation != 'list_models'
          GROUP BY day, c.model, c.session_id`,
      )
      .all(modifier, since) as unknown as UsageRow[];

    const totals = emptyTotals();
    const outsideSessions = emptyTotals();
    const byDay = new Map<string, UsageTotals & { day: string }>();
    for (let i = 0; i < opts.days; i++) {
      const day = new Date(startDay + i * DAY_MS).toISOString().slice(0, 10);
      byDay.set(day, { day, ...emptyTotals() });
    }
    const byModel = new Map<string, UsageTotals & { model: string }>();
    const bySession = new Map<
      string,
      UsageTotals & { sessionId: string; title: string | null; deleted: boolean }
    >();

    for (const r of rows) {
      const price = opts.prices[r.model];
      add(totals, r, price);
      const day = byDay.get(r.day);
      if (day) add(day, r, price);
      let model = byModel.get(r.model);
      if (!model) byModel.set(r.model, (model = { model: r.model, ...emptyTotals() }));
      add(model, r, price);
      if (r.session_id === null) {
        add(outsideSessions, r, price);
        continue;
      }
      let session = bySession.get(r.session_id);
      if (!session)
        bySession.set(
          r.session_id,
          (session = {
            sessionId: r.session_id,
            title: r.title,
            deleted: r.title === null,
            ...emptyTotals(),
          }),
        );
      add(session, r, price);
    }

    // Where chat requests' input went (Friday's estimates, recorded since token optimization).
    const ctx = `COUNT(*) AS requests,
                 SUM(c.ctx_system) AS system, SUM(c.ctx_tools) AS tools,
                 SUM(c.ctx_history) AS history, SUM(c.ctx_tool_results) AS tool_results,
                 SUM(c.ctx_baseline) AS baseline,
                 COALESCE(SUM(c.input_tokens), 0) AS input_tokens,
                 COALESCE(SUM(c.cached_tokens), 0) AS cached_tokens`;
    const toContext = (r: ContextRow): ContextUsageDto => ({
      requests: r.requests,
      system: r.system ?? 0,
      tools: r.tools ?? 0,
      history: r.history ?? 0,
      toolResults: r.tool_results ?? 0,
      baseline: r.baseline ?? 0,
      inputTokens: r.input_tokens,
      cachedInputTokens: r.cached_tokens,
    });
    const context = toContext(
      this.db
        .prepare(
          `SELECT ${ctx} FROM provider_calls c
            WHERE c.created_at >= ? AND c.ctx_baseline IS NOT NULL`,
        )
        .get(since) as unknown as ContextRow,
    );
    const recentRuns = (
      this.db
        .prepare(
          `SELECT c.run_id, c.session_id, s.title, MIN(c.created_at) AS started_at, ${ctx}
             FROM provider_calls c LEFT JOIN sessions s ON s.id = c.session_id
            WHERE c.created_at >= ? AND c.ctx_baseline IS NOT NULL AND c.run_id IS NOT NULL
            GROUP BY c.run_id ORDER BY started_at DESC LIMIT 10`,
        )
        .all(since) as unknown as Array<
        ContextRow & {
          run_id: string;
          session_id: string | null;
          title: string | null;
          started_at: string;
        }
      >
    ).map((r) => ({
      runId: r.run_id,
      sessionId: r.session_id,
      title: r.title,
      startedAt: r.started_at,
      ...toContext(r),
    }));

    const tokens = (t: UsageTotals) => t.inputTokens + t.outputTokens;
    return {
      context,
      recentRuns,
      days: opts.days,
      since,
      totals,
      byDay: [...byDay.values()],
      byModel: [...byModel.values()].sort((a, b) => tokens(b) - tokens(a) || b.calls - a.calls),
      bySession: [...bySession.values()]
        .sort((a, b) => tokens(b) - tokens(a) || b.calls - a.calls)
        .slice(0, 20),
      outsideSessions,
      prices: opts.prices,
    };
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
