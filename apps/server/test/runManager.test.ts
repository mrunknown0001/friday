import type { RunEvent } from '@friday/shared';
import { describe, expect, it } from 'vitest';
import { estimateMessageTokens } from '../src/chat/context.js';
import { SYSTEM_PROMPT } from '../src/chat/systemPrompt.js';
import { HttpError } from '../src/http/errors.js';
import { ProviderError } from '../src/providers/errors.js';
import { ScriptedProvider, testConfig, testServices } from './helpers.js';

function setup(provider: ScriptedProvider, opts: { envModel?: string | null } = {}) {
  const s = testServices({
    provider,
    config: testConfig({ envModel: opts.envModel === undefined ? 'test-model' : opts.envModel }),
  });
  const session = s.sessions.create();
  return { s, session };
}

function record(s: ReturnType<typeof setup>['s'], runId: string) {
  const events: RunEvent[] = [];
  const sub = s.runManager.subscribe(runId, 0, (e) => events.push(e));
  events.push(...(sub?.replay ?? []));
  return events;
}

describe('RunManager', () => {
  it('streams a reply, persists it, and titles the session', async () => {
    const provider = new ScriptedProvider([{ chunks: ['Hello', ' world'] }]);
    const { s, session } = setup(provider);
    const { run, userMessage } = s.runManager.startMessage(
      session.id,
      '  Explain Docker volumes\nplease ',
    );
    const events = record(s, run.id);
    await s.runManager.waitFor(run.id);

    expect(userMessage.content).toBe('Explain Docker volumes\nplease');
    expect(events.map((e) => e.type)).toEqual([
      'run_started',
      'phase',
      'phase',
      'phase',
      'text_delta',
      'text_delta',
      'message_saved',
      'run_finished',
    ]);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const messages = s.messages.listBySession(session.id);
    expect(messages.map((m) => [m.role, m.content, m.status])).toEqual([
      ['user', 'Explain Docker volumes\nplease', 'complete'],
      ['assistant', 'Hello world', 'complete'],
    ]);
    expect(s.runs.get(run.id)?.status).toBe('completed');
    expect(s.sessions.get(session.id)?.title).toBe('Explain Docker volumes');
    // The model saw the system prompt and the user message.
    expect(provider.requests[0]!.messages.map((m) => m.role)).toEqual(['system', 'user']);
  });

  it('cancels mid-stream and keeps the partial output marked as cancelled', async () => {
    const provider = new ScriptedProvider([{ chunks: ['a', 'b', 'c', 'd', 'e'], delayMs: 25 }]);
    const { s, session } = setup(provider);
    const { run } = s.runManager.startMessage(session.id, 'go');
    const events = record(s, run.id);
    await new Promise((r) => setTimeout(r, 60));
    expect(s.runManager.cancel(run.id)).toBe(true);
    await s.runManager.waitFor(run.id);

    expect(s.runs.get(run.id)?.status).toBe('cancelled');
    const assistant = s.messages.listBySession(session.id).find((m) => m.role === 'assistant');
    expect(assistant?.status).toBe('cancelled');
    expect(assistant!.content.length).toBeGreaterThan(0);
    expect(assistant!.content.length).toBeLessThan(5);
    expect(events.at(-1)).toMatchObject({ type: 'run_finished', run: { status: 'cancelled' } });
    expect(s.runManager.cancel(run.id)).toBe(false);
  });

  it('records provider failures with kind and retryability, then retries successfully', async () => {
    const provider = new ScriptedProvider([
      { chunks: ['par'], error: new ProviderError('rate_limit'), errorAfter: 1 },
      { chunks: ['full answer'] },
    ]);
    const { s, session } = setup(provider);
    const first = s.runManager.startMessage(session.id, 'question');
    await s.runManager.waitFor(first.run.id);
    expect(s.runs.get(first.run.id)).toMatchObject({
      status: 'failed',
      errorKind: 'rate_limit',
      retryable: true,
    });
    expect(s.messages.listBySession(session.id).at(-1)).toMatchObject({
      content: 'par',
      status: 'error',
    });

    const { run } = s.runManager.retry(session.id);
    await s.runManager.waitFor(run.id);
    expect(s.runs.get(run.id)?.status).toBe('completed');
    // Retry reuses the original user message rather than inserting a duplicate.
    expect(s.messages.listBySession(session.id).filter((m) => m.role === 'user')).toHaveLength(1);
    // The failed partial answer is not sent back to the model.
    expect(provider.requests[1]!.messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(() => s.runManager.retry(session.id)).toThrow(/completed successfully/);
  });

  it('surfaces quota errors as non-retryable', async () => {
    const provider = new ScriptedProvider([
      { error: new ProviderError('quota', 'plan exhausted') },
    ]);
    const { s, session } = setup(provider);
    const { run } = s.runManager.startMessage(session.id, 'q');
    await s.runManager.waitFor(run.id);
    expect(s.runs.get(run.id)).toMatchObject({
      status: 'failed',
      errorKind: 'quota',
      retryable: false,
    });
    expect(s.runs.get(run.id)?.errorMessage).toContain('quota');
  });

  it('allows only one active run per session', async () => {
    const provider = new ScriptedProvider([{ chunks: ['a', 'b'], delayMs: 30 }]);
    const { s, session } = setup(provider);
    const { run } = s.runManager.startMessage(session.id, 'one');
    expect(() => s.runManager.startMessage(session.id, 'two')).toThrow(HttpError);
    s.runManager.cancel(run.id);
    await s.runManager.waitFor(run.id);
  });

  it('refuses to start without a key or model and stores nothing', () => {
    const unconfigured = setup(new ScriptedProvider([], [], [], false));
    expect(() => unconfigured.s.runManager.startMessage(unconfigured.session.id, 'hi')).toThrow(
      /NTL_API_KEY/,
    );
    const noModel = setup(new ScriptedProvider(), { envModel: null });
    expect(() => noModel.s.runManager.startMessage(noModel.session.id, 'hi')).toThrow(
      /Select a model/,
    );
    expect(noModel.s.messages.countBySession(noModel.session.id)).toBe(0);
  });

  it('summarizes older history when it no longer fits the context window', async () => {
    const provider = new ScriptedProvider(
      [{ chunks: ['a1'] }, { chunks: ['a2'] }, { chunks: ['a3'] }],
      [
        {
          text: 'User is building a Laravel app.',
          toolCalls: [],
          finishReason: 'stop',
          usage: null,
        },
      ],
    );
    const { s, session } = setup(provider);
    // Conversation-only model, so the system prompt is exactly SYSTEM_PROMPT and no tool schemas count.
    s.capabilities.saveProbe('test-model', {
      streaming: 'supported',
      toolCalling: 'unsupported',
      notes: null,
    });
    // Pick a window whose history budget (~1000 tokens) fits two ~435-token user messages but not three.
    const sys = estimateMessageTokens({ role: 'system', content: SYSTEM_PROMPT });
    s.capabilities.setContextWindow('test-model', Math.ceil((1000 + sys) / 0.55));
    for (const text of ['first '.repeat(250), 'second '.repeat(215)]) {
      const { run } = s.runManager.startMessage(session.id, text);
      await s.runManager.waitFor(run.id);
    }
    const { run } = s.runManager.startMessage(session.id, 'third '.repeat(250));
    const events = record(s, run.id);
    await s.runManager.waitFor(run.id);

    expect(provider.completeRequests.some((r) => r.operation === 'summarize')).toBe(true);
    expect(events.some((e) => e.type === 'phase' && e.phase === 'compacting')).toBe(true);
    const updated = s.sessions.get(session.id)!;
    expect(updated.summary).toBe('User is building a Laravel app.');
    const sent = provider.requests.at(-1)!.messages;
    expect(sent[0]!.role === 'system' && sent[0]!.content).toContain('Laravel');
    expect(s.runs.get(run.id)?.status).toBe('completed');
  });

  it('notes truncated output instead of presenting it as complete', async () => {
    const provider = new ScriptedProvider([{ chunks: ['cut'], finishReason: 'length' }]);
    const { s, session } = setup(provider);
    const { run } = s.runManager.startMessage(session.id, 'long please');
    await s.runManager.waitFor(run.id);
    expect(s.messages.listBySession(session.id).at(-1)?.content).toMatch(/truncated/);
  });

  it('shutdown cancels active runs and persists their state', async () => {
    const provider = new ScriptedProvider([{ chunks: ['a', 'b', 'c'], delayMs: 50 }]);
    const { s, session } = setup(provider);
    const { run } = s.runManager.startMessage(session.id, 'x');
    await s.runManager.shutdown();
    expect(s.runs.get(run.id)?.status).toBe('cancelled');
  });
});
