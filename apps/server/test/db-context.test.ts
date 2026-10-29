import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ContextOverflowError,
  estimateMessageTokens,
  fitHistory,
  type HistoryItem,
} from '../src/chat/context.js';
import { openDatabase } from '../src/db/database.js';
import { migrate, MIGRATIONS } from '../src/db/migrations.js';
import { MessageRepo } from '../src/repositories/messages.js';
import { RunRepo } from '../src/repositories/runs.js';
import { SessionRepo } from '../src/repositories/sessions.js';

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function tmpDbFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'friday-test-'));
  tmpDirs.push(dir);
  return path.join(dir, 'nested', 'friday.db');
}

describe('migrations', () => {
  it('applies once and records versions', () => {
    const db = new Database(':memory:');
    expect(migrate(db)).toEqual(MIGRATIONS.map((m) => m.version));
    expect(migrate(db)).toEqual([]);
    expect(db.prepare('SELECT version FROM schema_migrations').all()).toEqual(
      MIGRATIONS.map((m) => ({ version: m.version })),
    );
  });

  it('rolls back a failing migration atomically', () => {
    const db = new Database(':memory:');
    migrate(db);
    const bad = [
      ...MIGRATIONS,
      {
        version: 999,
        name: 'bad',
        up: 'CREATE TABLE ok_table (x INT); SELECT * FROM missing_table;',
      },
    ];
    expect(() => migrate(db, bad)).toThrow();
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'ok_table'").get(),
    ).toBeUndefined();
    expect(db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()).toEqual({
      v: MIGRATIONS.at(-1)!.version,
    });
  });

  it('creates a private database file', () => {
    const file = tmpDbFile();
    openDatabase(file).close();
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe('session persistence and recovery', () => {
  it('keeps sessions and messages across reopen and marks in-flight runs interrupted', () => {
    const file = tmpDbFile();
    let db = openDatabase(file);
    const session = new SessionRepo(db).create('My chat');
    const msg = new MessageRepo(db).insert({
      sessionId: session.id,
      role: 'user',
      content: 'hello',
      status: 'complete',
    });
    new MessageRepo(db).insert({
      sessionId: session.id,
      role: 'assistant',
      content: 'half an ans',
      status: 'partial',
    });
    new RunRepo(db).create({
      id: '00000000-0000-4000-8000-000000000001',
      sessionId: session.id,
      userMessageId: msg.id,
      model: 'm',
    });
    db.close(); // simulated crash/restart

    db = openDatabase(file);
    const runs = new RunRepo(db);
    expect(runs.markInterrupted()).toBe(1);
    expect(runs.latestForSession(session.id)).toMatchObject({
      status: 'interrupted',
      retryable: true,
    });
    const sessions = new SessionRepo(db);
    expect(sessions.list().map((s) => s.title)).toEqual(['My chat']);
    expect(sessions.get(session.id)?.lastRunStatus).toBe('interrupted');
    expect(new MessageRepo(db).listBySession(session.id).map((m) => [m.content, m.status])).toEqual(
      [
        ['hello', 'complete'],
        ['half an ans', 'partial'],
      ],
    );
    // Partial output is shown to the user but never fed back to the model as context.
    expect(new MessageRepo(db).contextHistory(session.id, 0, 1e9).map((m) => m.content)).toEqual([
      'hello',
    ]);
    db.close();
  });

  it('deleting a session removes its messages and runs', () => {
    const db = openDatabase(':memory:');
    const sessions = new SessionRepo(db);
    const s = sessions.create();
    const m = new MessageRepo(db).insert({
      sessionId: s.id,
      role: 'user',
      content: 'x',
      status: 'complete',
    });
    new RunRepo(db).create({ id: 'r1', sessionId: s.id, userMessageId: m.id, model: 'm' });
    sessions.delete(s.id);
    expect(db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 0 });
  });
});

describe('fitHistory', () => {
  const item = (id: number, role: 'user' | 'assistant', chars: number): HistoryItem => ({
    id,
    message: { role, content: 'x'.repeat(chars) },
  });

  it('keeps everything when it fits', () => {
    const history = [item(1, 'user', 10), item(2, 'assistant', 10), item(3, 'user', 10)];
    const plan = fitHistory({
      systemPrompt: 'sys',
      summary: null,
      history,
      contextWindow: 10_000,
      reserveOutputTokens: 100,
    });
    expect(plan.dropped).toEqual([]);
    expect(plan.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
  });

  it('drops whole oldest turns first and keeps the latest request', () => {
    const history = [
      item(1, 'user', 1750),
      item(2, 'assistant', 1750),
      item(3, 'user', 1750),
      item(4, 'assistant', 1750),
      item(5, 'user', 1750),
    ];
    // ~506 tokens each; budget = 0.8*3000 - 200 - system ≈ 2190 → fits the last two turns (3 msgs).
    const plan = fitHistory({
      systemPrompt: 'sys',
      summary: null,
      history,
      contextWindow: 3000,
      reserveOutputTokens: 200,
    });
    // A turn (user + its replies) is dropped as a unit, so history always starts with a user message.
    expect(plan.dropped.map((h) => h.id)).toEqual([1, 2]);
    expect(plan.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(plan.messages.at(-1)).toEqual(history[4]!.message);
  });

  it('includes the summary in the single system message', () => {
    const plan = fitHistory({
      systemPrompt: 'sys',
      summary: 'User prefers pnpm.',
      history: [item(1, 'user', 5)],
      contextWindow: 10_000,
      reserveOutputTokens: 100,
    });
    expect(plan.messages.filter((m) => m.role === 'system')).toHaveLength(1);
    expect(plan.messages[0]!.role === 'system' && plan.messages[0]!.content).toContain(
      'User prefers pnpm.',
    );
  });

  it('never separates tool results from the assistant call that produced them', () => {
    const history: HistoryItem[] = [
      item(1, 'user', 2000),
      {
        id: 2,
        message: {
          role: 'assistant',
          content: null,
          toolCalls: [{ id: 'c', name: 't', argumentsJson: '{}' }],
        },
      },
      { id: 3, message: { role: 'tool', toolCallId: 'c', content: 'y'.repeat(2000) } },
      item(4, 'user', 100),
    ];
    // Room for the system prompt and the latest user message, but not the tool group (~580 tokens).
    const window = Math.ceil(
      (estimateMessageTokens({ role: 'system', content: 'sys' }) +
        estimateMessageTokens(history[3]!.message) +
        100) /
        0.8,
    );
    const plan = fitHistory({
      systemPrompt: 'sys',
      summary: null,
      history,
      contextWindow: window,
      reserveOutputTokens: 0,
    });
    expect(plan.dropped.map((h) => h.id)).toEqual([1, 2, 3]);
    expect(plan.messages.some((m) => m.role === 'tool')).toBe(false);
  });

  it('fails clearly when the latest message alone is too large', () => {
    expect(() =>
      fitHistory({
        systemPrompt: 's',
        summary: null,
        history: [item(1, 'user', 100_000)],
        contextWindow: 4000,
        reserveOutputTokens: 500,
      }),
    ).toThrow(ContextOverflowError);
  });
});
