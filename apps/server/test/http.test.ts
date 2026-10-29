import type { RunEvent } from '@friday/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import fs from 'node:fs';
import path from 'node:path';
import {
  call,
  cleanupProjects,
  makeProject,
  ScriptedProvider,
  jsonResponse,
  mockFetch,
  sseResponse,
  TEST_KEY,
  testConfig,
  testServices,
  textChunks,
  type MockHandler,
} from './helpers.js';

const LOCAL = { host: '127.0.0.1:4317' };
const MUTATE = { ...LOCAL, 'x-friday-client': '1', 'content-type': 'application/json' };
const MUTATE_NO_BODY = { ...LOCAL, 'x-friday-client': '1' };

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

const modelList = () =>
  jsonResponse(200, { object: 'list', data: [{ id: 'test-model' }, { id: 'other-model' }] });

async function setup(handlers: MockHandler[], config = testConfig()) {
  const mock = mockFetch(handlers);
  const services = testServices({ config, fetch: mock.fetch });
  app = await buildApp(services);
  return { app, services, calls: mock.calls };
}

function parseSse(body: string): RunEvent[] {
  return body
    .split('\n\n')
    .map((block) => block.split('\n').find((l) => l.startsWith('data: ')))
    .filter((l): l is string => !!l)
    .map((l) => JSON.parse(l.slice(6)) as RunEvent);
}

describe('local-only HTTP guards', () => {
  it('rejects non-loopback Host headers (DNS rebinding)', async () => {
    const { app } = await setup([]);
    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: 'evil.example:4317' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('forbidden_host');
  });

  it('requires the launch token on every request when one is configured (desktop)', async () => {
    const token = 'T'.repeat(43);
    const config = testConfig();
    config.server.launchToken = token;
    const { app } = await setup([], config);
    for (const headers of [LOCAL, { ...LOCAL, 'x-friday-token': 'T'.repeat(42) }]) {
      const res = await app.inject({ method: 'GET', url: '/api/settings', headers });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('invalid_launch_token');
    }
    const ok = await app.inject({
      method: 'GET',
      url: '/api/settings',
      headers: { ...LOCAL, 'x-friday-token': token },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).not.toContain(token);
  });

  it('accepts its own origin when the OS picked the port (desktop binds port 0)', async () => {
    const config = testConfig();
    config.server.port = 0;
    const { app } = await setup([], config);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: 'POST',
      headers: { ...MUTATE, origin: `http://127.0.0.1:${port}` },
      body: '{}',
    });
    expect(res.status).toBe(201);
    const foreign = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: 'POST',
      headers: { ...MUTATE, origin: 'http://127.0.0.1:4317' },
      body: '{}',
    });
    expect(foreign.status).toBe(403);
  });

  it('rejects foreign origins and cross-site fetches', async () => {
    const { app } = await setup([]);
    const a = await app.inject({
      method: 'GET',
      url: '/api/sessions',
      headers: { ...LOCAL, origin: 'https://evil.example' },
    });
    expect(a.statusCode).toBe(403);
    const b = await app.inject({
      method: 'GET',
      url: '/api/sessions',
      headers: { ...LOCAL, 'sec-fetch-site': 'cross-site' },
    });
    expect(b.statusCode).toBe(403);
    const ok = await app.inject({
      method: 'GET',
      url: '/api/sessions',
      headers: { ...LOCAL, origin: 'http://localhost:5173' },
    });
    expect(ok.statusCode).toBe(200);
  });

  it('requires the client header on mutating requests (CSRF)', async () => {
    const { app } = await setup([]);
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { ...LOCAL, 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('missing_client_header');
    const ok = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: MUTATE,
      payload: {},
    });
    expect(ok.statusCode).toBe(201);
  });

  it('never exposes the API key through settings', async () => {
    const { app } = await setup([]);
    const res = await app.inject({ method: 'GET', url: '/api/settings', headers: LOCAL });
    expect(res.json()).toMatchObject({
      apiKeyConfigured: true,
      model: 'test-model',
      modelSource: 'env',
    });
    expect(res.body).not.toContain(TEST_KEY);
  });
});

describe('provider routes', () => {
  it('only accepts models from the account model list', async () => {
    const { app, services } = await setup([modelList]);
    const bad = await app.inject({
      method: 'PUT',
      url: '/api/settings/model',
      headers: MUTATE,
      payload: { model: 'made-up' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('model_not_available');
    const good = await app.inject({
      method: 'PUT',
      url: '/api/settings/model',
      headers: MUTATE,
      payload: { model: 'other-model' },
    });
    expect(good.statusCode).toBe(200);
    expect(services.modelSettings.resolve()).toEqual({ model: 'other-model', source: 'settings' });
    expect(services.audit.list().map((e) => e.action)).toContain('model_changed');
  });

  it('connection test reports success with a real completion round-trip', async () => {
    const { app, calls } = await setup([
      modelList,
      () =>
        jsonResponse(200, {
          choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'pong' } }],
        }),
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/api/provider/test',
      headers: MUTATE,
      payload: {},
    });
    expect(res.json()).toMatchObject({
      ok: true,
      model: 'test-model',
      modelListed: true,
      reply: 'pong',
    });
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      '/api/v1/models',
      '/api/v1/chat/completions',
    ]);
  });

  it('connection test reports provider errors without leaking secrets', async () => {
    const { app } = await setup([
      () => jsonResponse(401, { error: { message: `bad key ${TEST_KEY}` } }),
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/api/provider/test',
      headers: MUTATE,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, error: { kind: 'auth' } });
    expect(res.body).not.toContain(TEST_KEY);
  });

  it('maps provider outages on model listing to a clear error', async () => {
    const { app } = await setup(
      [() => jsonResponse(503, { error: { message: 'down' } })],
      testConfig({ maxRetries: 0 }),
    );
    const res = await app.inject({ method: 'GET', url: '/api/provider/models', headers: LOCAL });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatchObject({ code: 'provider_server', retryable: true });
  });

  it('probes and stores model capabilities', async () => {
    const { app } = await setup([
      (_c, s) => sseResponse(textChunks(['OK']), {}, s),
      () =>
        jsonResponse(200, {
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 't1',
                    type: 'function',
                    function: { name: 'report_status', arguments: '{"status":"ok"}' },
                  },
                ],
              },
            },
          ],
        }),
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/api/provider/capabilities/probe',
      headers: MUTATE,
      payload: {},
    });
    expect(res.json()).toMatchObject({
      model: 'test-model',
      streaming: 'supported',
      toolCalling: 'supported',
    });
    const again = await app.inject({
      method: 'GET',
      url: '/api/provider/capabilities',
      headers: LOCAL,
    });
    expect(again.json().probedAt).not.toBeNull();
  });
});

describe('chat over HTTP', () => {
  it('sends a message, streams the run over SSE, and persists the conversation', async () => {
    const { app, services } = await setup([
      (_c, s) => sseResponse(textChunks(['Use ', '`docker volume ls`.']), {}, s),
    ]);
    const created = (
      await app.inject({ method: 'POST', url: '/api/sessions', headers: MUTATE, payload: {} })
    ).json();
    const sent = await app.inject({
      method: 'POST',
      url: `/api/sessions/${created.id}/messages`,
      headers: MUTATE,
      payload: { content: 'How do I list volumes?' },
    });
    expect(sent.statusCode).toBe(202);
    const { run } = sent.json();
    await services.runManager.waitFor(run.id);

    const sse = await app.inject({
      method: 'GET',
      url: `/api/runs/${run.id}/events`,
      headers: LOCAL,
    });
    expect(sse.headers['content-type']).toContain('text/event-stream');
    const events = parseSse(sse.body);
    expect(
      events
        .filter((e) => e.type === 'text_delta')
        .map((e) => (e as { delta: string }).delta)
        .join(''),
    ).toBe('Use `docker volume ls`.');
    expect(events.at(-1)).toMatchObject({ type: 'run_finished', run: { status: 'completed' } });

    // Resuming from Last-Event-ID only replays newer events.
    const resumed = parseSse(
      (
        await app.inject({
          method: 'GET',
          url: `/api/runs/${run.id}/events`,
          headers: { ...LOCAL, 'last-event-id': String(events.length - 1) },
        })
      ).body,
    );
    expect(resumed.map((e) => e.type)).toEqual(['run_finished']);

    const detail = (
      await app.inject({ method: 'GET', url: `/api/sessions/${created.id}`, headers: LOCAL })
    ).json();
    expect(detail.title).toBe('How do I list volumes?');
    expect(detail.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);
    expect(detail.latestRun.status).toBe('completed');

    const calls = services.providerCalls.recent();
    expect(calls[0]).toMatchObject({
      operation: 'chat',
      status: 'ok',
      inputTokens: 11,
      outputTokens: 7,
    });
  });

  it('reports persisted final state for runs no longer in memory', async () => {
    const { app, services } = await setup([]);
    const session = services.sessions.create();
    const msg = services.messages.insert({
      sessionId: session.id,
      role: 'user',
      content: 'x',
      status: 'complete',
    });
    const runId = '11111111-1111-4111-8111-111111111111';
    services.runs.create({
      id: runId,
      sessionId: session.id,
      userMessageId: msg.id,
      model: 'test-model',
    });
    services.runs.markInterrupted();
    const events = parseSse(
      (await app.inject({ method: 'GET', url: `/api/runs/${runId}/events`, headers: LOCAL })).body,
    );
    expect(events).toEqual([
      expect.objectContaining({
        type: 'run_finished',
        run: expect.objectContaining({ status: 'interrupted' }),
      }),
    ]);
  });

  it('validates input and ids', async () => {
    const { app } = await setup([]);
    const badId = await app.inject({
      method: 'GET',
      url: '/api/sessions/not-a-uuid',
      headers: LOCAL,
    });
    expect(badId.statusCode).toBe(400);
    const missing = await app.inject({
      method: 'GET',
      url: '/api/sessions/22222222-2222-4222-8222-222222222222',
      headers: LOCAL,
    });
    expect(missing.statusCode).toBe(404);
    const created = (
      await app.inject({ method: 'POST', url: '/api/sessions', headers: MUTATE, payload: {} })
    ).json();
    const empty = await app.inject({
      method: 'POST',
      url: `/api/sessions/${created.id}/messages`,
      headers: MUTATE,
      payload: { content: '   ' },
    });
    expect(empty.statusCode).toBe(400);
  });

  it('deleting a session cancels its active run first', async () => {
    const { app, services } = await setup([
      (_c, s) => sseResponse(textChunks(['a', 'b', 'c', 'd']), { delayMs: 50 }, s),
    ]);
    const created = (
      await app.inject({ method: 'POST', url: '/api/sessions', headers: MUTATE, payload: {} })
    ).json();
    const { run } = (
      await app.inject({
        method: 'POST',
        url: `/api/sessions/${created.id}/messages`,
        headers: MUTATE,
        payload: { content: 'hi' },
      })
    ).json();
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/sessions/${created.id}`,
      headers: MUTATE_NO_BODY,
    });
    expect(del.statusCode).toBe(204);
    expect(services.runManager.activeRunId(created.id)).toBeNull();
    expect(services.runs.get(run.id)).toBeNull();
  });
});

describe('project routes', () => {
  afterEach(cleanupProjects);

  it('authorizes a folder, dedupes it, and binds new sessions to it', async () => {
    const { app, services } = await setup([]);
    const root = makeProject({
      'package.json': '{"devDependencies":{"vite":"8"}}',
      'src/a.ts': 'x',
    });
    const added = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: MUTATE,
      payload: { path: root },
    });
    expect(added.statusCode).toBe(201);
    const project = added.json();
    expect(project).toMatchObject({
      name: root.split('/').at(-1),
      rootPath: root,
      available: true,
    });
    const again = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: MUTATE,
      payload: { path: `${root}/` },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().id).toBe(project.id);
    expect(services.audit.list().map((e) => e.action)).toContain('project_authorized');

    const session = (
      await app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers: MUTATE,
        payload: { projectId: project.id },
      })
    ).json();
    expect(session.projectId).toBe(project.id);
    await app.inject({ method: 'POST', url: '/api/sessions', headers: MUTATE, payload: {} });
    const scoped = (
      await app.inject({
        method: 'GET',
        url: `/api/sessions?project=${project.id}`,
        headers: LOCAL,
      })
    ).json();
    expect(scoped.sessions.map((x: { id: string }) => x.id)).toEqual([session.id]);
    const none = (
      await app.inject({ method: 'GET', url: '/api/sessions?project=none', headers: LOCAL })
    ).json();
    expect(none.sessions).toHaveLength(1);

    const overview = (
      await app.inject({
        method: 'GET',
        url: `/api/projects/${project.id}/overview`,
        headers: LOCAL,
      })
    ).json();
    expect(overview.stack).toEqual(expect.arrayContaining(['Node.js', 'Vite']));
  });

  it('refuses broad, missing, or relative folders', async () => {
    const { app } = await setup([]);
    for (const [path, code] of [
      ['/', 'forbidden_path'],
      ['/etc', 'forbidden_path'],
      ['relative/dir', 'invalid_path'],
      ['/definitely/not/here', 'not_found'],
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/projects',
        headers: MUTATE,
        payload: { path },
      });
      expect(res.json().error.code, path).toBe(code);
    }
  });

  it('serves the file browser with the same confinement as the agent', async () => {
    const { app, services } = await setup([]);
    const root = makeProject({
      'src/a.ts': 'const a = 1;',
      '.env': 'SECRET=1',
      'node_modules/x/i.js': '',
    });
    const project = services.projects.create('p', root);
    const tree = (
      await app.inject({ method: 'GET', url: `/api/projects/${project.id}/tree`, headers: LOCAL })
    ).json();
    expect(tree.entries.map((e: { path: string }) => e.path).sort()).toEqual(['.env', 'src']);
    const file = (
      await app.inject({
        method: 'GET',
        url: `/api/projects/${project.id}/file?path=src/a.ts`,
        headers: LOCAL,
      })
    ).json();
    expect(file).toMatchObject({
      path: 'src/a.ts',
      content: 'const a = 1;',
      language: 'typescript',
      binary: false,
    });
    const secret = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/file?path=.env`,
      headers: LOCAL,
    });
    expect(secret.statusCode).toBe(403);
    expect(secret.body).not.toContain('SECRET=1');
    const escape = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/file?path=../../etc/passwd`,
      headers: LOCAL,
    });
    expect(escape.statusCode).toBe(403);
  });

  it('removing a project keeps its sessions but detaches them', async () => {
    const { app, services } = await setup([]);
    const project = services.projects.create('p', makeProject({ 'a.txt': '' }));
    const session = services.sessions.create(undefined, project.id);
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${project.id}`,
      headers: MUTATE_NO_BODY,
    });
    expect(res.statusCode).toBe(204);
    expect(services.sessions.get(session.id)?.projectId).toBeNull();
  });
});

describe('approval and undo routes', () => {
  afterEach(cleanupProjects);

  async function approvalSetup() {
    const provider = new ScriptedProvider([
      {
        toolCalls: [
          call(
            'write_file',
            { path: 'notes/todo.md', content: '- ship it\n', reason: 'Track work' },
            'w1',
          ),
        ],
      },
      { chunks: ['Created.'] },
    ]);
    const services = testServices({ provider });
    app = await buildApp(services);
    const root = makeProject({ 'README.md': '# demo\n' });
    const project = services.projects.create('demo', root);
    const session = services.sessions.create(undefined, project.id);
    return { app, services, root, session };
  }

  async function pendingApproval(services: ReturnType<typeof testServices>, sessionId: string) {
    for (let i = 0; i < 100; i++) {
      const pending = services.approvalRepo
        .listBySession(sessionId)
        .find((a) => a.status === 'pending');
      if (pending) return pending;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('no approval requested');
  }

  it('applies a change only via an approved decision, then undoes it', async () => {
    const { app, services, root, session } = await approvalSetup();
    const sent = await app.inject({
      method: 'POST',
      url: `/api/sessions/${session.id}/messages`,
      headers: MUTATE,
      payload: { content: 'add a todo' },
    });
    const { run } = sent.json();
    const a = await pendingApproval(services, session.id);

    // Session detail exposes the pending approval for the UI (survives a page reload).
    const detail = (
      await app.inject({ method: 'GET', url: `/api/sessions/${session.id}`, headers: LOCAL })
    ).json();
    expect(detail.approvals).toMatchObject([
      { id: a.id, status: 'pending', category: 'file_create' },
    ]);
    expect(detail.latestRun.status).toBe('awaiting_approval');

    // CSRF header and a well-formed hash are required.
    const noHeader = await app.inject({
      method: 'POST',
      url: `/api/approvals/${a.id}/decision`,
      headers: { ...LOCAL, 'content-type': 'application/json' },
      payload: { decision: 'approve', actionHash: a.actionHash, sessionId: session.id },
    });
    expect(noHeader.statusCode).toBe(403);
    const badHash = await app.inject({
      method: 'POST',
      url: `/api/approvals/${a.id}/decision`,
      headers: MUTATE,
      payload: { decision: 'approve', actionHash: 'x', sessionId: session.id },
    });
    expect(badHash.statusCode).toBe(400);
    expect(fs.existsSync(path.join(root, 'notes/todo.md'))).toBe(false);

    const ok = await app.inject({
      method: 'POST',
      url: `/api/approvals/${a.id}/decision`,
      headers: MUTATE,
      payload: { decision: 'approve', actionHash: a.actionHash, sessionId: session.id },
    });
    expect(ok.json().status).toBe('approved');
    const replay = await app.inject({
      method: 'POST',
      url: `/api/approvals/${a.id}/decision`,
      headers: MUTATE,
      payload: { decision: 'approve', actionHash: a.actionHash, sessionId: session.id },
    });
    expect(replay.statusCode).toBe(409);
    await services.runManager.waitFor(run.id);
    expect(fs.readFileSync(path.join(root, 'notes/todo.md'), 'utf8')).toBe('- ship it\n');

    const changes = (
      await app.inject({
        method: 'GET',
        url: `/api/sessions/${session.id}/changes`,
        headers: LOCAL,
      })
    ).json().changes;
    expect(changes).toMatchObject([{ path: 'notes/todo.md', change: 'create', revertedAt: null }]);
    expect(JSON.stringify(changes)).not.toContain('before'); // backups are not exposed

    const undo = await app.inject({
      method: 'POST',
      url: `/api/file-changes/${changes[0].id}/revert`,
      headers: MUTATE_NO_BODY,
    });
    expect(undo.statusCode).toBe(200);
    expect(undo.json().revertedAt).not.toBeNull();
    expect(fs.existsSync(path.join(root, 'notes/todo.md'))).toBe(false);
    const again = await app.inject({
      method: 'POST',
      url: `/api/file-changes/${changes[0].id}/revert`,
      headers: MUTATE_NO_BODY,
    });
    expect(again.statusCode).toBe(409);
    expect(services.audit.list().map((e) => e.action)).toContain('file_change_reverted');
  });

  it('refuses to undo a change the user edited afterwards', async () => {
    const { app, services, root, session } = await approvalSetup();
    const { run } = (
      await app.inject({
        method: 'POST',
        url: `/api/sessions/${session.id}/messages`,
        headers: MUTATE,
        payload: { content: 'add a todo' },
      })
    ).json();
    const a = await pendingApproval(services, session.id);
    services.approvals.decide(a.id, {
      decision: 'approve',
      actionHash: a.actionHash,
      sessionId: session.id,
    });
    await services.runManager.waitFor(run.id);
    fs.writeFileSync(path.join(root, 'notes/todo.md'), '- ship it\n- my own line\n');
    const [change] = services.fileChanges.listBySession(session.id);
    const res = await app.inject({
      method: 'POST',
      url: `/api/file-changes/${change!.id}/revert`,
      headers: MUTATE_NO_BODY,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('changed_since');
    expect(fs.readFileSync(path.join(root, 'notes/todo.md'), 'utf8')).toContain('my own line');
  });
});
