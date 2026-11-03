import type {
  AppNotice,
  EnhancePromptResult,
  QuestionDto,
  RunEvent,
  SessionDetailDto,
} from '@friday/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db/database.js';
import { QuestionRepo } from '../src/repositories/questions.js';
import { SessionRepo } from '../src/repositories/sessions.js';
import {
  call,
  cleanupProjects,
  makeProject,
  ScriptedProvider,
  testConfig,
  testServices,
} from './helpers.js';

afterEach(cleanupProjects);

const H = { host: '127.0.0.1:4317', 'x-friday-client': '1', 'content-type': 'application/json' };

const ASK = {
  questions: [
    {
      question: 'Which database should the cache use?',
      header: 'Database',
      options: [
        { label: 'Redis', description: 'Already in docker-compose' },
        { label: 'Postgres' },
        { label: 'Redis' },
      ],
    },
    {
      question: 'Which environments?',
      options: [{ label: 'staging' }, { label: 'production' }],
      multi_select: true,
    },
  ],
};

function setup(steps: ConstructorParameters<typeof ScriptedProvider>[0], ttlMs = 60_000) {
  const provider = new ScriptedProvider(steps);
  const s = testServices({ provider, config: { ...testConfig(), approvalTtlMs: ttlMs } });
  return { s, provider };
}

/** Start a run and resolve with its first question. */
function startAndAwaitQuestion(s: ReturnType<typeof setup>['s'], text: string) {
  const session = s.sessions.create();
  const notices: AppNotice[] = [];
  s.runManager.onNotice((n) => notices.push(n));
  const { run } = s.runManager.startMessage(session.id, text);
  const events: RunEvent[] = [];
  const question = new Promise<QuestionDto>((resolve) => {
    const take = (e: RunEvent) => {
      events.push(e);
      if (e.type === 'question' && e.question.status === 'pending') resolve(e.question);
    };
    const sub = s.runManager.subscribe(run.id, 0, take);
    for (const e of sub?.replay ?? []) take(e);
  });
  return { session, run, events, notices, question };
}

describe('ask_user', () => {
  it('pauses the run on a question card and continues with the answer', async () => {
    const { s, provider } = setup([
      { toolCalls: [call('ask_user', ASK, 'q1')] },
      { chunks: ['Using Redis on staging.'] },
    ]);
    const app = await buildApp(s);
    const { session, run, events, notices, question } = startAndAwaitQuestion(s, 'add a cache');
    const q = await question;
    expect(q).toMatchObject({ sessionId: session.id, toolCallId: 'q1', status: 'pending' });
    // Duplicate labels are dropped: they could not be told apart in the answer.
    expect(q.questions[0]).toEqual({
      question: 'Which database should the cache use?',
      header: 'Database',
      options: [
        { label: 'Redis', description: 'Already in docker-compose' },
        { label: 'Postgres', description: null },
      ],
      multiSelect: false,
    });
    expect(q.questions[1]!.multiSelect).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'phase', phase: 'awaiting_answer' }),
    );
    expect(notices).toContainEqual(
      expect.objectContaining({ type: 'question_asked', questionId: q.id, runId: run.id }),
    );

    const answer = (body: object) =>
      app.inject({
        method: 'POST',
        url: `/api/questions/${q.id}/answer`,
        headers: H,
        payload: body,
      });
    // Only offered options, one unless multi-select, every question answered, right conversation.
    const bad = [
      {
        sessionId: session.id,
        answers: [
          { selected: ['MySQL'], text: null },
          { selected: ['staging'], text: null },
        ],
      },
      {
        sessionId: session.id,
        answers: [
          { selected: ['Redis', 'Postgres'], text: null },
          { selected: ['staging'], text: null },
        ],
      },
      { sessionId: session.id, answers: [{ selected: ['Redis'], text: null }] },
      {
        sessionId: session.id,
        answers: [
          { selected: [], text: '  ' },
          { selected: ['staging'], text: null },
        ],
      },
    ];
    for (const body of bad) expect((await answer(body)).statusCode).toBe(400);
    const other = s.sessions.create();
    expect(
      (await answer({ sessionId: other.id, answers: [{ selected: ['Redis'], text: null }] }))
        .statusCode,
    ).toBe(403);

    const ok = await answer({
      sessionId: session.id,
      answers: [
        { selected: ['Redis'], text: 'reuse the existing container' },
        { selected: ['staging', 'production'], text: null },
      ],
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<QuestionDto>().status).toBe('answered');
    await s.runManager.waitFor(run.id);
    expect(s.runs.get(run.id)!.status).toBe('completed');

    const result = s.messages.listBySession(session.id).find((m) => m.role === 'tool')!;
    expect(result.content).toBe(
      'The user answered (their answers, not tool output):\n' +
        '1. Which database should the cache use?\n   Answer: Redis; "reuse the existing container"\n' +
        '2. Which environments?\n   Answer: staging; production\nContinue with these answers.',
    );
    // The model's next turn sees the answer.
    expect(JSON.stringify(provider.requests[1]!.messages)).toContain(
      'reuse the existing container',
    );
    expect(provider.requests[0]!.tools!.map((t) => t.name)).toContain('ask_user');
    expect(provider.requests[0]!.messages[0]!.content).toContain('ask_user tool');

    const detail = (
      await app.inject({ method: 'GET', url: `/api/sessions/${session.id}`, headers: H })
    ).json<SessionDetailDto>();
    expect(detail.questions).toHaveLength(1);
    expect(detail.questions[0]).toMatchObject({
      status: 'answered',
      answers: [
        { selected: ['Redis'], text: 'reuse the existing container' },
        { selected: ['staging', 'production'], text: null },
      ],
    });
    expect((await answer({ sessionId: session.id, skip: true })).statusCode).toBe(409);
    expect(s.audit.list().map((e) => e.action)).toEqual(
      expect.arrayContaining(['question_asked', 'question_answered']),
    );
  });

  it('lets Friday decide when skipped, and asks again later when nobody answers', async () => {
    const { s } = setup([
      { toolCalls: [call('ask_user', ASK, 'q1')] },
      { chunks: ['Assuming Redis.'] },
    ]);
    const app = await buildApp(s);
    const first = startAndAwaitQuestion(s, 'add a cache');
    const q = await first.question;
    const skipped = await app.inject({
      method: 'POST',
      url: `/api/questions/${q.id}/answer`,
      headers: H,
      payload: { sessionId: first.session.id, skip: true },
    });
    expect(skipped.json<QuestionDto>()).toMatchObject({ status: 'skipped', answers: null });
    await s.runManager.waitFor(first.run.id);
    expect(
      s.messages.listBySession(first.session.id).find((m) => m.role === 'tool')!.content,
    ).toMatch(/^The user skipped the questions and left the choice to you/);

    const quick = setup(
      [{ toolCalls: [call('ask_user', ASK, 'q2')] }, { chunks: ['Which DB?'] }],
      30,
    );
    const second = startAndAwaitQuestion(quick.s, 'add a cache');
    await second.question;
    await quick.s.runManager.waitFor(second.run.id);
    expect(quick.s.runs.get(second.run.id)!.status).toBe('completed');
    expect(quick.s.questionRepo.listBySession(second.session.id)[0]!.status).toBe('expired');
    expect(
      quick.s.messages.listBySession(second.session.id).find((m) => m.role === 'tool')!.content,
    ).toMatch(/did not answer in time.*restates the question/);
  });

  it('cancels the question with the run, and on restart', async () => {
    const { s } = setup([{ toolCalls: [call('ask_user', ASK)] }]);
    const app = await buildApp(s);
    const { session, run, question } = startAndAwaitQuestion(s, 'add a cache');
    const q = await question;
    s.runManager.cancel(run.id);
    await s.runManager.waitFor(run.id);
    expect(s.runs.get(run.id)!.status).toBe('cancelled');
    expect(s.questionRepo.get(q.id)!.status).toBe('cancelled');
    const late = await app.inject({
      method: 'POST',
      url: `/api/questions/${q.id}/answer`,
      headers: H,
      payload: { sessionId: session.id, skip: true },
    });
    expect(late.statusCode).toBe(409);

    const db = openDatabase(':memory:');
    const repo = new QuestionRepo(db);
    const sid = new SessionRepo(db).create().id;
    repo.create({
      id: 'x',
      sessionId: sid,
      runId: 'r',
      toolCallId: 'c',
      questions: [],
      expiresAt: new Date().toISOString(),
    });
    expect(repo.cancelPending()).toBe(1);
    expect(repo.get('x')!.status).toBe('cancelled');
  });
});

describe('prompt enhancement', () => {
  const reply = (text: string) => ({
    text,
    toolCalls: [],
    finishReason: 'stop' as const,
    usage: null,
  });

  function enhanceSetup(replies: string[]) {
    const provider = new ScriptedProvider([], replies.map(reply));
    const s = testServices({ provider });
    return { s, provider };
  }

  it('asks what would change the request, then writes the prompt from the answers', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'shop', scripts: { test: 'vitest' } }),
      'src/cart.ts': 'export {}',
      '.env': 'SECRET=1',
    });
    const questions = {
      questions: [
        {
          question: 'Which page is slow?',
          header: 'Page',
          options: [{ label: 'Cart' }, { label: 'Checkout', description: 'The payment step' }],
        },
      ],
    };
    const { s, provider } = enhanceSetup([
      `Here you go:\n\`\`\`json\n${JSON.stringify(questions)}\n\`\`\``,
      JSON.stringify({ prompt: 'Find why the cart page is slow and fix it; keep tests passing.' }),
    ]);
    const project = s.projects.create('shop', root);
    const session = s.sessions.create(undefined, project.id);
    s.messages.insert({
      sessionId: session.id,
      role: 'user',
      content: 'the shop is slow',
      status: 'complete',
    });
    s.messages.insert({
      sessionId: session.id,
      role: 'assistant',
      content: 'Which part?',
      status: 'complete',
    });
    const app = await buildApp(s);
    const enhance = (body: object) =>
      app.inject({ method: 'POST', url: '/api/enhance', headers: H, payload: body });

    const draft = 'make it faster, token ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const first = await enhance({ draft, projectId: null, sessionId: session.id });
    expect(first.statusCode).toBe(200);
    expect(first.json<EnhancePromptResult>()).toEqual({
      kind: 'questions',
      questions: [
        {
          question: 'Which page is slow?',
          header: 'Page',
          options: [
            { label: 'Cart', description: null },
            { label: 'Checkout', description: 'The payment step' },
          ],
          multiSelect: false,
        },
      ],
    });
    const sent = provider.completeRequests[0]!;
    expect(sent.operation).toBe('enhance');
    expect(sent.sessionId).toBe(session.id);
    const user = String(sent.messages[1]!.content);
    // The session's project and recent messages; secrets and credential files stay out.
    expect(user).toContain('Project: shop');
    expect(user).toContain('package.json');
    expect(user).toContain('src/');
    expect(user).not.toContain('.env');
    expect(user).not.toContain(root);
    expect(user).toContain('User: the shop is slow');
    expect(user).toContain('Friday: Which part?');
    expect(user).not.toContain('ghp_');
    expect(user).toContain('make it faster, token [REDACTED');

    const second = await enhance({
      draft,
      projectId: null,
      sessionId: session.id,
      answers: [{ question: 'Which page is slow?', answer: 'Cart' }],
    });
    expect(second.json<EnhancePromptResult>()).toEqual({
      kind: 'prompt',
      prompt: 'Find why the cart page is slow and fix it; keep tests passing.',
    });
    expect(String(provider.completeRequests[1]!.messages[1]!.content)).toMatch(
      /1\. Which page is slow\?\n {3}Answer: Cart[\s\S]*Write the prompt now/,
    );
  });

  it('refuses unusable replies and requests it cannot serve', async () => {
    const { s } = enhanceSetup([
      'I think you should add caching.',
      JSON.stringify({
        questions: [{ question: 'Which?', options: [{ label: 'a' }, { label: 'b' }] }],
      }),
    ]);
    const app = await buildApp(s);
    const enhance = (body: object) =>
      app.inject({ method: 'POST', url: '/api/enhance', headers: H, payload: body });
    const base = { projectId: null, sessionId: null };

    const prose = await enhance({ ...base, draft: 'add caching' });
    expect(prose.statusCode).toBe(502);
    expect(prose.json().error.code).toBe('enhance_failed');
    // Asked to write without questions, it must not ask again.
    const asked = await enhance({ ...base, draft: 'add caching', noQuestions: true });
    expect(asked.statusCode).toBe(502);
    expect((await enhance({ ...base, draft: '   ' })).statusCode).toBe(400);
    expect(
      (await enhance({ ...base, draft: 'x', sessionId: '00000000-0000-4000-8000-000000000000' }))
        .statusCode,
    ).toBe(404);

    const off = testServices({ provider: new ScriptedProvider([], [], undefined, false) });
    const offApp = await buildApp(off);
    const notConfigured = await offApp.inject({
      method: 'POST',
      url: '/api/enhance',
      headers: H,
      payload: { ...base, draft: 'add caching' },
    });
    expect(notConfigured.statusCode).toBe(400);
  });
});
