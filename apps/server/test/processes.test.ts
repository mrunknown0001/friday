import fs from 'node:fs';
import type { RunEvent } from '@friday/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { buildSystemPrompt } from '../src/chat/systemPrompt.js';
import {
  findLocalUrls,
  PROCESS_LIMITS,
  ProcessManager,
  reapOrphans,
} from '../src/processes/manager.js';
import { cleanupSandboxes, dockerRunArgs, imagePresent } from '../src/sandbox/docker.js';
import { Redactor } from '../src/security/redact.js';
import { executeToolCall, ToolRegistry } from '../src/tools/registry.js';
import type { ToolContext } from '../src/tools/types.js';
import { detectToolEnvironment } from '../src/workspace/environment.js';
import { call, cleanupProjects, makeProject, ScriptedProvider, testServices } from './helpers.js';

const SECRET = 'sk-live-0123456789abcdefghij';
const managers: ProcessManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.shutdown()));
  cleanupProjects();
});

function manager(instance = `test-${process.pid}`): ProcessManager {
  const redactor = new Redactor([SECRET]);
  const m = new ProcessManager({ instance, redact: (t) => redactor.redact(t) });
  managers.push(m);
  return m;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(check: () => boolean, ms = 5_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const spec = (
  root: string,
  over: { argv?: string[]; shellCommand?: string; projectId?: string },
) => ({
  projectId: over.projectId ?? 'p1',
  sessionId: 's1',
  name: 'dev server',
  command: over.argv ? over.argv.join(' ') : over.shellCommand!,
  root,
  cwdRel: '.',
  cwdAbs: root,
  argv: over.argv ?? null,
  shellCommand: over.shellCommand ?? null,
  sandbox: null,
});

/** A small "dev server": prints its URL, then a tick every 50 ms. */
const SERVER = [
  'node',
  '-e',
  "console.log('  Local:   http://0.0.0.0:4321/'); let i = 0; setInterval(() => console.log('tick ' + i++), 50)",
];

describe('process manager', () => {
  it('finds local URLs and normalizes all-interfaces addresses', () => {
    expect(
      findLocalUrls(
        'ready on http://0.0.0.0:3000, also http://127.0.0.1:8080/app. remote https://example.com:443',
      ),
    ).toEqual(['http://localhost:3000', 'http://127.0.0.1:8080/app']);
    expect(findLocalUrls('see http://[::]:5173/')).toEqual(['http://localhost:5173/']);
  });

  it('runs in the background, detects readiness and URLs, and follows output by cursor', async () => {
    const root = makeProject({ 'a.txt': 'x' });
    const pm = manager();
    const changes: string[] = [];
    pm.onChange((p) => changes.push(`${p.status}:${p.urls.length}`));
    const p = pm.start(spec(root, { argv: SERVER }));
    expect(p).toMatchObject({ status: 'running', name: 'dev server', cwd: '.' });
    expect(await pm.waitFor(p.id, { timeoutMs: 5_000 })).toBe('ready');
    expect(pm.get(p.id)!.urls).toEqual(['http://localhost:4321/']);

    const first = pm.read(p.id)!;
    await until(() => pm.read(p.id, { since: first.cursor })!.output.includes('tick'));
    const next = pm.read(p.id, { since: first.cursor })!;
    expect(next.output).not.toContain('Local:');
    expect(next.cursor).toBeGreaterThan(first.cursor);

    const stopped = await pm.stop(p.id, 'user');
    expect(stopped).toMatchObject({ status: 'stopped', stoppedBy: 'user' });
    expect(stopped!.endedAt).not.toBeNull();
    // Start, new URL, stopping, stopped: no notice per line of output.
    expect(changes).toEqual(['running:0', 'running:1', 'stopping:1', 'stopped:1']);
  });

  it('stops the whole process group, including what the command started', async () => {
    const root = makeProject({});
    const pm = manager();
    const p = pm.start(
      spec(root, { shellCommand: 'sleep 300 & echo "child:$!"; echo ready; wait' }),
    );
    expect(await pm.waitFor(p.id, { readyText: 'ready', timeoutMs: 5_000 })).toBe('ready');
    const child = Number(/child:(\d+)/.exec(pm.read(p.id)!.output)![1]);
    expect(alive(child)).toBe(true);
    await pm.stop(p.id, 'friday');
    await until(() => !alive(child));
  });

  it('reports processes that exit by themselves or cannot start', async () => {
    const root = makeProject({});
    const pm = manager();
    const crash = pm.start(
      spec(root, { argv: ['node', '-e', "console.error('boom'); process.exit(3)"] }),
    );
    expect(await pm.waitFor(crash.id, { timeoutMs: 5_000 })).toBe('exited');
    expect(pm.get(crash.id)).toMatchObject({ status: 'exited', exitCode: 3, stoppedBy: null });
    expect(pm.read(crash.id)!.output).toContain('boom');

    const missing = pm.start(spec(root, { argv: ['friday-no-such-command-xyz'] }));
    expect(await pm.waitFor(missing.id, { timeoutMs: 5_000 })).toBe('exited');
    expect(pm.get(missing.id)!.error).toMatch(/Command not found/);
    expect(pm.dismiss(crash.id)).toBe(true);
    expect(pm.get(crash.id)).toBeNull();
  });

  it('withholds secrets: no server environment, redacted output', async () => {
    const root = makeProject({});
    const pm = manager();
    process.env.NTL_API_KEY_PROCESS_TEST = 'should-not-leak';
    const p = pm.start(
      spec(root, {
        shellCommand: `echo "key=${SECRET}"; env | grep -c NTL_API_KEY_PROCESS_TEST; echo "marker=$FRIDAY_BACKGROUND"; echo done`,
      }),
    );
    delete process.env.NTL_API_KEY_PROCESS_TEST;
    await pm.waitFor(p.id, { readyText: 'done', timeoutMs: 5_000 });
    const out = pm.read(p.id)!.output;
    expect(out).not.toContain(SECRET);
    expect(out).toContain('[REDACTED');
    expect(out).toMatch(/^0$/m);
    expect(out).toContain(`marker=test-${process.pid}:${p.id}`);
  });

  it('keeps only recent output and says when older output was dropped', async () => {
    const root = makeProject({});
    const pm = manager();
    const p = pm.start(
      spec(root, {
        argv: [
          'node',
          '-e',
          `process.stdout.write('a'.repeat(${PROCESS_LIMITS.bufferChars + 5000}) + '\\nend\\n')`,
        ],
      }),
    );
    await pm.waitFor(p.id, { readyText: 'end', timeoutMs: 5_000 });
    const all = pm.read(p.id, { since: 0 })!;
    expect(all.dropped).toBe(true);
    expect(all.output.length).toBeLessThanOrEqual(PROCESS_LIMITS.bufferChars);
    expect(all.output).toContain('end');
  });

  it('limits running processes per project', async () => {
    const root = makeProject({});
    const pm = manager();
    for (let i = 0; i < PROCESS_LIMITS.perProject; i++)
      pm.start(spec(root, { argv: ['sleep', '300'] }));
    expect(() => pm.start(spec(root, { argv: ['sleep', '300'] }))).toThrow(/limit/);
    expect(pm.start(spec(root, { argv: ['sleep', '300'], projectId: 'p2' }))).toMatchObject({
      status: 'running',
    });
    await pm.shutdown();
    expect(pm.list().every((p) => p.status === 'stopped' && p.stoppedBy === 'shutdown')).toBe(true);
  });

  it.skipIf(!fs.existsSync('/proc/self/environ'))(
    'reaps processes a crashed instance left behind, and only those',
    async () => {
      const root = makeProject({});
      const crashed = manager(`reap-${process.pid}`);
      const other = manager(`other-${process.pid}`);
      const orphan = crashed.start(spec(root, { shellCommand: 'sleep 300 & wait' }));
      const unrelated = other.start(spec(root, { argv: ['sleep', '300'] }));
      await new Promise((r) => setTimeout(r, 200));
      // Both the shell and the sleep it started carry the marker.
      expect(await reapOrphans(`reap-${process.pid}`)).toBe(2);
      expect(await crashed.waitFor(orphan.id, { timeoutMs: 5_000 })).toBe('exited');
      expect(other.get(unrelated.id)!.status).toBe('running');
    },
  );

  it('publishes sandbox ports on loopback only', () => {
    const args = dockerRunArgs({
      root: '/home/u/shop',
      cwdRel: '.',
      settings: { enabled: true, image: 'node:22-bookworm-slim', network: 'bridge' },
      argv: ['npm', 'run', 'dev'],
      shellCommand: null,
      masks: { files: [], dirs: [], truncated: false },
      gitDir: false,
      instance: 'test',
      name: 'friday-sbx-x',
      uid: 1000,
      gid: 1000,
      ports: [5173],
    });
    expect(args.join(' ')).toContain('--publish 127.0.0.1:5173:5173');
  });
});

// ---------- tools ----------

const env = await detectToolEnvironment(`test-${process.pid}`);
const registry = new ToolRegistry();

function ctx(root: string, pm: ProcessManager, projectId = 'p1'): ToolContext {
  return {
    project: {
      id: projectId,
      name: 'proj',
      rootPath: root,
      createdAt: '',
      lastOpenedAt: null,
      sandbox: null,
    },
    sessionId: 's1',
    runId: 'r1',
    signal: new AbortController().signal,
    redactor: new Redactor([SECRET]),
    env,
    maxOutputChars: 20_000,
    setPlan: () => undefined,
    processes: pm,
  };
}

describe('process tools', () => {
  it('starts only with approval, then lists, reads and stops without one', async () => {
    const root = makeProject({ 'package.json': '{}' });
    const s = testServices({
      provider: new ScriptedProvider([
        {
          toolCalls: [
            call(
              'start_process',
              { name: 'dev server', argv: SERVER, reason: 'preview the page' },
              'c1',
            ),
          ],
        },
        { chunks: ['started'] },
      ]),
      toolEnv: env,
    });
    managers.push(s.processes);
    const project = s.projects.create('shop', root);
    const session = s.sessions.create(undefined, project.id);
    const { run } = s.runManager.startMessage(session.id, 'start the dev server');
    let approval: Extract<RunEvent, { type: 'approval_requested' }>['approval'] | null = null;
    s.runManager.subscribe(run.id, 0, (e) => {
      if (e.type !== 'approval_requested') return;
      approval = e.approval;
      // Nothing runs before the decision.
      expect(s.processes.list()).toEqual([]);
      setTimeout(
        () =>
          s.approvals.decide(e.approval.id, {
            decision: 'approve',
            actionHash: e.approval.actionHash,
            sessionId: session.id,
          }),
        5,
      );
    });
    await s.runManager.waitFor(run.id);
    expect(approval).toMatchObject({
      toolName: 'start_process',
      category: 'shell',
      details: { kind: 'command', background: { name: 'dev server' }, sandbox: null },
    });
    expect(approval!.summary).toMatch(/keeps running in the background until you stop it/);
    const tool = s.messages.listBySession(session.id).find((m) => m.role === 'tool')!;
    expect(tool.content).toMatch(/proc_[a-f0-9]{8} "dev server": running and ready/);
    expect(tool.content).toContain('urls: http://localhost:4321/');

    const [p] = s.processes.list(project.id);
    expect(p).toMatchObject({ status: 'running', sessionId: session.id });
    const c = ctx(root, s.processes, project.id);
    const list = await executeToolCall(registry, call('list_processes', {}), c, {
      timeoutMs: 5_000,
    });
    expect(list).toMatchObject({ status: 'completed', summary: '1 running, 0 finished' });
    expect(list.content).toContain(p!.id);

    await until(() => s.processes.read(p!.id)!.output.includes('tick'));
    const read = await executeToolCall(
      registry,
      call('read_process_output', { id: p!.id, tail_lines: 5 }),
      c,
      { timeoutMs: 5_000 },
    );
    expect(read.content).toMatch(/tick \d+/);
    expect(read.content).toMatch(/cursor: \d+/);

    // Other projects cannot see or stop it.
    const foreign = ctx(root, s.processes, 'p-other');
    expect(
      await executeToolCall(
        registry,
        call('stop_process', { id: p!.id, reason: 'stop it' }),
        foreign,
        {
          timeoutMs: 5_000,
        },
      ),
    ).toMatchObject({ status: 'error' });

    const stop = await executeToolCall(
      registry,
      call('stop_process', { id: p!.id, reason: 'done previewing' }),
      c,
      { timeoutMs: 15_000 },
    );
    expect(stop).toMatchObject({ status: 'completed' });
    expect(stop.summary).toMatch(/stopped by friday/);
    expect(s.processes.get(p!.id)!.status).toBe('stopped');
  });

  it('refuses to start a second copy of a running command', async () => {
    const root = makeProject({});
    const s = testServices({ toolEnv: env });
    managers.push(s.processes);
    const project = s.projects.create('shop', root);
    const session = s.sessions.create(undefined, project.id);
    s.processes.start({
      ...spec(root, { argv: ['sleep', '300'] }),
      projectId: project.id,
      command: 'sleep 300',
    });
    // Exercise prepare directly: duplicates are refused with the id of the running copy.
    const dup = s.registry.get('start_process')!;
    await expect(
      dup.prepare!(
        { name: 'again', argv: ['sleep', '300'], cwd: '.', wait_seconds: 5, reason: 'run it' },
        ctx(root, s.processes, project.id),
      ),
    ).rejects.toThrow(/already running as proc_/);
    expect(s.approvalRepo.listBySession(session.id)).toEqual([]);
  });
});

const HEADERS = { host: '127.0.0.1:8787', 'x-friday-client': '1' };

describe('process routes', () => {
  it('lists, streams output, stops and dismisses; never starts', async () => {
    const root = makeProject({});
    const s = testServices({ toolEnv: env });
    managers.push(s.processes);
    const app = await buildApp(s, { logger: false });
    const req = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
      app.inject({ method, url, headers: HEADERS, ...(payload ? { payload } : {}) });
    const project = s.projects.create('shop', root);
    const p = s.processes.start({
      ...spec(root, { argv: SERVER }),
      projectId: project.id,
    });
    await s.processes.waitFor(p.id, { timeoutMs: 5_000 });

    const list = await req('GET', `/api/projects/${project.id}/processes`);
    expect(list.json().processes).toHaveLength(1);
    const out = await req('GET', `/api/processes/${p.id}/output?tail=20`);
    expect(out.json()).toMatchObject({ process: { id: p.id, status: 'running' } });
    expect(out.json().output).toContain('http://0.0.0.0:4321/');
    expect((await req('DELETE', `/api/processes/${p.id}`)).statusCode).toBe(409);
    const stop = await req('POST', `/api/processes/${p.id}/stop`);
    expect(stop.json()).toMatchObject({ status: 'stopped', stoppedBy: 'user' });
    expect((await req('DELETE', `/api/processes/${p.id}`)).statusCode).toBe(204);
    expect((await req('GET', '/api/processes/nope/output')).statusCode).toBe(400);
    expect((await req('POST', '/api/processes', { argv: ['ls'] })).statusCode).toBe(404);

    // Closing the server stops what is still running.
    const q = s.processes.start({
      ...spec(root, { argv: ['sleep', '300'] }),
      projectId: project.id,
    });
    await app.close();
    expect(s.processes.get(q.id)).toMatchObject({ status: 'stopped', stoppedBy: 'shutdown' });
  });
});

// Real containers, only where Docker and a small local image are available (never pulled).
const IMAGE = 'node:22-alpine';
const dockerOk = !!env.docker && (await imagePresent(IMAGE));

describe.skipIf(!dockerOk)('background processes in the sandbox', () => {
  afterEach(async () => {
    await cleanupSandboxes(`test-${process.pid}`);
  });

  async function sandboxed(network: 'none' | 'bridge') {
    const root = makeProject({
      '.env': 'SECRET=topsecretvalue',
      'server.js': `require('http').createServer((q, r) => r.end('hello from the sandbox')).listen(Number(process.argv[2]), '0.0.0.0', () => console.log('listening on http://0.0.0.0:' + process.argv[2]));`,
    });
    const s = testServices({ toolEnv: env });
    managers.push(s.processes);
    const project = s.projects.create('shop', root);
    s.projects.setSandbox(project.id, { enabled: true, image: IMAGE, network });
    const c = { ...ctx(root, s.processes, project.id), project: s.projects.get(project.id)! };
    return { s, root, c };
  }

  it('publishes a dev server on 127.0.0.1 and stops the container', async () => {
    const { s, c } = await sandboxed('bridge');
    const port = 40_000 + (process.pid % 20_000);
    const proposal = await s.registry.get('start_process')!.prepare!(
      {
        name: 'web',
        argv: ['node', 'server.js', String(port)],
        cwd: '.',
        wait_seconds: 30,
        ports: [port],
        reason: 'preview',
      },
      c,
    );
    expect(proposal.details).toMatchObject({
      kind: 'command',
      background: { name: 'web' },
      sandbox: { image: IMAGE, network: 'bridge', ports: [port], hiddenCredentials: 1 },
    });
    expect(proposal.summary).toContain(`publishing port ${port} on 127.0.0.1`);
    const result = await proposal.apply(c);
    expect(result.content).toContain('running and ready');
    expect(result.content).toContain(`urls: http://localhost:${port}`);
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(await res.text()).toBe('hello from the sandbox');

    const [p] = s.processes.list();
    await s.processes.stop(p!.id, 'user');
    expect(s.processes.get(p!.id)!.status).toBe('stopped');
    expect(await cleanupSandboxes(`test-${process.pid}`)).toBe(0);
  }, 90_000);

  it('refuses published ports when the sandbox has no network', async () => {
    const { s, c } = await sandboxed('none');
    await expect(
      s.registry.get('start_process')!.prepare!(
        {
          name: 'web',
          argv: ['node', 'server.js', '4000'],
          cwd: '.',
          wait_seconds: 5,
          ports: [4000],
          reason: 'preview',
        },
        c,
      ),
    ).rejects.toThrow(/no network, so no ports can be published/);
  });
});

describe('process status in the system prompt', () => {
  const project = {
    id: 'p1',
    name: 'shop',
    rootPath: '/home/u/shop',
    createdAt: '',
    lastOpenedAt: null,
    sandbox: null,
  };
  const base = {
    id: 'proc_1a2b3c4d',
    projectId: 'p1',
    sessionId: 's1',
    name: 'dev server',
    command: 'npm run dev',
    cwd: '.',
    sandbox: null,
    exitCode: null,
    signal: null,
    error: null,
    urls: [],
    startedAt: '',
    endedAt: null,
  };

  it('states the current status, so stale conversation history is not trusted', () => {
    const prompt = buildSystemPrompt({
      project,
      detection: null,
      toolsEnabled: true,
      processes: [
        { ...base, status: 'running', stoppedBy: null, urls: ['http://localhost:5173/'] },
        { ...base, id: 'proc_00000002', status: 'stopped', stoppedBy: 'user', signal: 'SIGTERM' },
      ],
    });
    expect(prompt).toContain('This is current and overrides earlier messages');
    expect(prompt).toContain(
      '- proc_1a2b3c4d "dev server": `npm run dev` (cwd .): running at http://localhost:5173/',
    );
    expect(prompt).toContain('proc_00000002 "dev server": `npm run dev` (cwd .): stopped by user');
  });

  it('says none are running (e.g. after Friday restarted)', () => {
    const prompt = buildSystemPrompt({
      project,
      detection: null,
      toolsEnabled: true,
      processes: [],
    });
    expect(prompt).toContain(
      '## Background processes in this project\nNone are running right now, whatever earlier messages say',
    );
    expect(
      buildSystemPrompt({ project: null, detection: null, toolsEnabled: true, processes: [] }),
    ).not.toContain('Background processes in this project');
  });
});
