import type { UsageSummaryDto } from '@friday/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { openDatabase, openSqlite } from '../src/db/database.js';
import { migrate, MIGRATIONS } from '../src/db/migrations.js';
import { UsageRepo } from '../src/repositories/telemetry.js';
import { mockFetch, sseResponse, testServices, textChunks, type MockHandler } from './helpers.js';

const LOCAL = { host: '127.0.0.1:4317' };
const MUTATE = { ...LOCAL, 'x-friday-client': '1', 'content-type': 'application/json' };

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

async function setup(handlers: MockHandler[] = []) {
  const mock = mockFetch(handlers);
  const services = testServices({ fetch: mock.fetch });
  app = await buildApp(services);
  return { app, services };
}

function insertCall(
  db: ReturnType<typeof openDatabase>,
  c: {
    at: string;
    model?: string;
    operation?: string;
    status?: string;
    session?: string | null;
    input?: number | null;
    output?: number | null;
    ms?: number;
    estimated?: boolean;
  },
) {
  db.prepare(
    `INSERT INTO provider_calls
      (created_at, model, operation, status, error_kind, duration_ms, attempts, input_tokens, output_tokens, session_id, tokens_estimated)
     VALUES (?, ?, ?, ?, NULL, ?, 1, ?, ?, ?, ?)`,
  ).run(
    c.at,
    c.model ?? 'model-a',
    c.operation ?? 'chat',
    c.status ?? 'ok',
    c.ms ?? 1_000,
    c.input === undefined ? 100 : c.input,
    c.output === undefined ? 10 : c.output,
    c.session === undefined ? null : c.session,
    c.estimated ? 1 : 0,
  );
}

describe('usage summary', () => {
  const now = new Date('2026-10-30T10:00:00Z');

  it('buckets by local day, model and conversation, with estimated cost', () => {
    const db = openDatabase(':memory:');
    db.prepare(
      "INSERT INTO sessions (id, title, created_at, updated_at) VALUES ('s1', 'Fix login', ?, ?)",
    ).run(now.toISOString(), now.toISOString());
    // 2026-10-29T17:30Z is already 30 October in UTC+8.
    insertCall(db, {
      at: '2026-10-29T17:30:00Z',
      session: 's1',
      input: 1_000_000,
      output: 0,
      estimated: true,
    });
    insertCall(db, { at: '2026-10-29T09:00:00Z', session: 's1', output: 1_000_000, input: 0 });
    insertCall(db, { at: '2026-10-28T09:00:00Z', model: 'model-b', session: 'gone' });
    insertCall(db, { at: '2026-10-28T09:00:00Z', operation: 'probe_tools', status: 'error' });
    insertCall(db, { at: '2026-10-28T09:00:00Z', model: '-', operation: 'list_models' });
    insertCall(db, { at: '2026-10-20T09:00:00Z' }); // before the range
    insertCall(db, { at: '2026-10-29T09:30:00Z', input: null, output: null });

    const s = new UsageRepo(db).summary({
      days: 7,
      tzOffsetMinutes: 480,
      prices: { 'model-a': { input: 3, output: 15 } },
      now,
    });

    expect(s.since).toBe('2026-10-23T16:00:00.000Z');
    expect(s.byDay.map((d) => d.day)).toEqual([
      '2026-10-24',
      '2026-10-25',
      '2026-10-26',
      '2026-10-27',
      '2026-10-28',
      '2026-10-29',
      '2026-10-30',
    ]);
    expect(s.byDay.at(-1)).toMatchObject({ calls: 1, inputTokens: 1_000_000, cost: 3 });
    expect(s.byDay.at(-2)).toMatchObject({ calls: 2, outputTokens: 1_000_000, cost: 15 });
    expect(s.byDay[0]).toMatchObject({ calls: 0, cost: null });

    // Model listings are not model usage; the old call is out of range.
    expect(s.totals).toMatchObject({
      calls: 5,
      errors: 1,
      durationMs: 5_000,
      estimatedCalls: 1,
      callsWithoutTokens: 1,
    });
    expect(s.totals.cost).toBeCloseTo(18 + (200 * 3 + 20 * 15) / 1e6);
    expect(s.byModel.map((m) => [m.model, m.calls, m.cost])).toEqual([
      ['model-a', 4, expect.closeTo(18 + 0.0009)],
      ['model-b', 1, null],
    ]);
    expect(s.bySession).toEqual([
      expect.objectContaining({ sessionId: 's1', title: 'Fix login', deleted: false, calls: 2 }),
      expect.objectContaining({ sessionId: 'gone', title: null, deleted: true, calls: 1 }),
    ]);
    expect(s.outsideSessions).toMatchObject({ calls: 2, errors: 1 });
  });

  it('handles negative offsets', () => {
    const db = openDatabase(':memory:');
    insertCall(db, { at: '2026-10-30T03:00:00Z' }); // still 29 October in UTC-5
    const s = new UsageRepo(db).summary({ days: 2, tzOffsetMinutes: -300, prices: {}, now });
    expect(s.byDay.map((d) => [d.day, d.calls])).toEqual([
      ['2026-10-29', 1],
      ['2026-10-30', 0],
    ]);
  });
});

describe('provider call sessions migration', () => {
  it('links earlier conversation calls to the run that was going on', () => {
    // Version 13 added the column; 14 fills it for calls recorded before.
    const db = openSqlite(':memory:');
    migrate(
      db,
      MIGRATIONS.filter((m) => m.version < 14),
    );
    db.prepare(
      "INSERT INTO sessions (id, title, created_at, updated_at) VALUES ('s1', 'Old chat', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')",
    ).run();
    db.prepare(
      `INSERT INTO runs (id, session_id, user_message_id, status, started_at, finished_at)
       VALUES ('r1', 's1', 1, 'completed', '2026-10-01T10:00:00.000Z', '2026-10-01T10:05:00.000Z')`,
    ).run();
    const add = (at: string, operation: string) =>
      db
        .prepare(
          `INSERT INTO provider_calls (created_at, model, operation, status, duration_ms, attempts)
           VALUES (?, 'm', ?, 'ok', 1, 1)`,
        )
        .run(at, operation);
    add('2026-10-01T10:02:00.000Z', 'chat');
    add('2026-10-01T10:04:00.000Z', 'summarize');
    add('2026-10-01T09:00:00.000Z', 'chat'); // no run: a conversation deleted since
    add('2026-10-01T10:03:00.000Z', 'probe_tools');

    migrate(db);
    const rows = db
      .prepare('SELECT operation, session_id FROM provider_calls ORDER BY id')
      .all() as Array<Record<string, unknown>>;
    expect(rows.map((r) => [r['operation'], r['session_id']])).toEqual([
      ['chat', 's1'],
      ['summarize', 's1'],
      ['chat', 'deleted'],
      ['probe_tools', null],
    ]);
  });
});

describe('usage routes', () => {
  it('records the conversation of each model call and reports it', async () => {
    const { app, services } = await setup([
      (_c, s) =>
        sseResponse(textChunks(['Hi'], 'stop', { prompt_tokens: 40, completion_tokens: 2 }), {}, s),
    ]);
    const session = (
      await app.inject({ method: 'POST', url: '/api/sessions', headers: MUTATE, payload: {} })
    ).json();
    const sent = await app.inject({
      method: 'POST',
      url: `/api/sessions/${session.id}/messages`,
      headers: MUTATE,
      payload: { content: 'Hello' },
    });
    await services.runManager.waitFor(sent.json().run.id);

    const res = await app.inject({
      method: 'GET',
      url: '/api/usage?days=7&tz=480',
      headers: LOCAL,
    });
    expect(res.statusCode).toBe(200);
    const usage = res.json<UsageSummaryDto>();
    expect(usage.byDay).toHaveLength(7);
    expect(usage.bySession).toEqual([
      expect.objectContaining({
        sessionId: session.id,
        calls: 1,
        inputTokens: 40,
        outputTokens: 2,
      }),
    ]);
    expect(usage.totals.cost).toBeNull();
  });

  it('saves prices, validates them, and clears them', async () => {
    const { app } = await setup();
    const put = (prices: unknown) =>
      app.inject({ method: 'PUT', url: '/api/usage/prices', headers: MUTATE, payload: { prices } });

    const saved = await put({ 'test-model': { input: 3, output: 15 } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().prices).toEqual({ 'test-model': { input: 3, output: 15 } });
    expect(
      (await app.inject({ method: 'GET', url: '/api/usage', headers: LOCAL })).json().prices,
    ).toEqual({ 'test-model': { input: 3, output: 15 } });

    expect((await put({ 'test-model': { input: -1, output: 1 } })).statusCode).toBe(400);
    expect((await put({ 'test-model': { input: '3', output: 1 } })).statusCode).toBe(400);
    expect((await put({})).json().prices).toEqual({});
  });

  it('rejects bad ranges and requires the client header to change prices', async () => {
    const { app } = await setup();
    for (const q of ['days=0', 'days=366', 'tz=900', 'days=abc'])
      expect(
        (await app.inject({ method: 'GET', url: `/api/usage?${q}`, headers: LOCAL })).statusCode,
      ).toBe(400);
    const res = await app.inject({
      method: 'PUT',
      url: '/api/usage/prices',
      headers: { ...LOCAL, 'content-type': 'application/json' },
      payload: { prices: {} },
    });
    expect(res.statusCode).toBe(403);
  });
});
