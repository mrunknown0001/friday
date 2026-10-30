import fs from 'node:fs';
import path from 'node:path';
import type {
  ApprovalDetails,
  RunEvent,
  SavedActionDto,
  SavedActionInput,
  SshHostDto,
} from '@friday/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { RunResult } from '../src/commands/runner.js';
import { Redactor } from '../src/security/redact.js';
import { listSavedActions, runSavedAction } from '../src/tools/savedActionTools.js';
import type { ToolContext } from '../src/tools/types.js';
import { detectToolEnvironment } from '../src/workspace/environment.js';
import { call, cleanupProjects, makeProject, ScriptedProvider, testServices } from './helpers.js';

afterEach(cleanupProjects);
const env = await detectToolEnvironment();
const H = { host: '127.0.0.1:4317', 'x-friday-client': '1', 'content-type': 'application/json' };

const host = (over: Partial<SshHostDto> = {}): SshHostDto => ({
  id: '00000000-0000-4000-8000-000000000001',
  name: 'web-staging',
  hostname: '203.0.113.5',
  port: 22,
  username: 'deploy',
  identityFile: null,
  environment: 'staging',
  trustedFingerprints: ['SHA256:abc'],
  createdAt: '',
  ...over,
});

const action = (over: Partial<SavedActionDto> = {}): SavedActionDto => ({
  id: 'a1',
  projectId: 'p',
  name: 'deploy staging',
  description: 'Build, then pull and restart on staging.',
  risk: 'medium',
  steps: [
    {
      title: 'Build',
      target: { kind: 'local', cwd: '.' },
      command: 'echo built > build.txt && cat build.txt',
      timeoutSeconds: 30,
      continueOnError: false,
    },
    {
      title: 'Restart',
      target: { kind: 'ssh', hostId: host().id },
      command: 'sudo systemctl restart shop',
      timeoutSeconds: 60,
      continueOnError: false,
    },
  ],
  createdAt: '',
  updatedAt: '2026-10-30T00:00:00.000Z',
  ...over,
});

function ctx(root: string, actions: SavedActionDto[], hosts: SshHostDto[] = [host()]) {
  const sshCalls: string[] = [];
  const out: string[] = [];
  let sshExit = 0;
  const c: ToolContext = {
    project: {
      id: 'p',
      name: 'shop',
      rootPath: root,
      createdAt: '',
      lastOpenedAt: null,
      sandbox: null,
      worktree: null,
    },
    sessionId: 's',
    runId: 'r',
    callId: 'c1',
    signal: new AbortController().signal,
    redactor: new Redactor(),
    env,
    maxOutputChars: 20_000,
    setPlan: () => undefined,
    emitOutput: (chunk) => out.push(chunk),
    savedActions: { list: () => actions },
    devops: {
      hosts: {
        list: () => hosts,
        get: (id: string) => hosts.find((h) => h.id === id) ?? null,
      },
      ssh: {
        run: async (h: SshHostDto, command: string): Promise<RunResult> => {
          sshCalls.push(`${h.name}: ${command}`);
          return {
            exitCode: sshExit,
            signal: null,
            output: sshExit ? 'Failed to restart shop.service: Unit not found.\n' : '',
            omittedBytes: 0,
            timedOut: false,
            cancelled: false,
            spawnError: null,
            durationMs: 12,
          };
        },
      },
    } as unknown as ToolContext['devops'],
  };
  return { c, sshCalls, out, failSsh: () => (sshExit = 5) };
}

const prepare = (c: ToolContext, name: string) =>
  runSavedAction.prepare!(runSavedAction.schema.parse({ name, reason: 'the user asked' }), c);

describe('saved action routes', () => {
  it('only the user defines actions; a task worktree uses its parent’s', async () => {
    const s = testServices();
    const root = makeProject({ 'a.txt': '' });
    const project = s.projects.create('shop', root);
    const app = await buildApp(s);
    const staging = s.sshHosts.create({
      name: 'web-staging',
      hostname: '203.0.113.5',
      port: 22,
      username: 'deploy',
      identityFile: null,
      environment: 'staging',
    });
    const body: SavedActionInput = {
      name: 'deploy staging',
      description: 'Ship it',
      risk: 'medium',
      steps: [
        {
          title: 'Build',
          target: { kind: 'local', cwd: '.' },
          command: 'npm run build',
          timeoutSeconds: 120,
          continueOnError: false,
        },
        {
          title: 'Restart',
          target: { kind: 'ssh', hostId: staging.id },
          command: 'sudo systemctl restart shop',
          timeoutSeconds: 60,
          continueOnError: false,
        },
      ],
    };
    const post = (url: string, payload: unknown, headers: Record<string, string> = H) =>
      app.inject({ method: 'POST', url, headers, payload: payload as object });

    const created = await post(`/api/projects/${project.id}/actions`, body);
    expect(created.statusCode).toBe(201);
    const a = created.json() as SavedActionDto;
    expect(a).toMatchObject({
      name: 'deploy staging',
      risk: 'medium',
      steps: [{ title: 'Build' }, { title: 'Restart' }],
    });

    // Without the browser client header (e.g. a request from a web page), nothing is created.
    const forged = await post(
      `/api/projects/${project.id}/actions`,
      { ...body, name: 'x' },
      {
        host: H.host,
        'content-type': 'application/json',
      },
    );
    expect(forged.statusCode).toBe(403);
    expect((await post(`/api/projects/${project.id}/actions`, body)).statusCode).toBe(409);
    const badHost = await post(`/api/projects/${project.id}/actions`, {
      ...body,
      name: 'other',
      steps: [
        {
          ...body.steps[1]!,
          target: { kind: 'ssh', hostId: '00000000-0000-4000-8000-00000000dead' },
        },
      ],
    });
    expect(badHost.statusCode).toBe(400);
    expect(
      (await post(`/api/projects/${project.id}/actions`, { ...body, name: 'x', steps: [] }))
        .statusCode,
    ).toBe(400);

    const put = await app.inject({
      method: 'PUT',
      url: `/api/actions/${a.id}`,
      headers: H,
      payload: { ...body, risk: 'high' } as object,
    });
    expect((put.json() as SavedActionDto).risk).toBe('high');

    // A task worktree of the project lists the parent's actions.
    const child = s.projects.createWorktree(
      'shop task',
      makeProject({ 'b.txt': '' }),
      {
        parentId: project.id,
        branch: 'friday/task-abc',
        base: 'deadbeef',
        baseBranch: 'main',
        linked: [],
        status: 'active',
        outcome: null,
        createdAt: '',
      },
      null,
    );
    const listed = await app.inject({
      method: 'GET',
      url: `/api/projects/${child.id}/actions`,
      headers: H,
    });
    expect(listed.json()).toMatchObject({
      projectId: project.id,
      actions: [{ name: 'deploy staging' }],
    });

    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/actions/${a.id}`,
          headers: { host: H.host, 'x-friday-client': '1' },
        })
      ).statusCode,
    ).toBe(204);
    expect(s.savedActions.listByProject(project.id)).toEqual([]);
    await app.close();
  });
});

describe('list_saved_actions', () => {
  it('shows each action with its steps and where they run', async () => {
    const root = makeProject({});
    const { c } = ctx(root, [action()]);
    const out = await listSavedActions.execute!({}, c);
    expect(out.content).toContain(
      '"deploy staging" (risk medium): Build, then pull and restart on staging.',
    );
    expect(out.content).toContain(
      '1. Build [this machine, in the project root]: echo built > build.txt && cat build.txt',
    );
    expect(out.content).toContain(
      '2. Restart [web-staging (staging)]: sudo systemctl restart shop',
    );
    const none = await listSavedActions.execute!({}, ctx(root, []).c);
    expect(none.content).toMatch(/no saved actions.*you cannot create them/);
  });
});

describe('run_saved_action', () => {
  it('shows every step for one approval, then runs them in order', async () => {
    const root = makeProject({});
    const { c, sshCalls, out } = ctx(root, [action()]);
    const p = await prepare(c, 'Deploy Staging');
    const d = p.details as Extract<ApprovalDetails, { kind: 'saved_action' }>;
    expect(p.title).toBe('Run saved action "deploy staging"');
    expect(p.category).toBe('remote');
    // Declared medium; sudo on the server raises it.
    expect(p.risk).toBe('critical');
    expect(p.confirmationRequired).toBeUndefined();
    expect(d.steps).toEqual([
      expect.objectContaining({
        title: 'Build',
        command: 'echo built > build.txt && cat build.txt',
        where: { kind: 'local', cwd: '.', sandbox: null },
      }),
      expect.objectContaining({
        title: 'Restart',
        where: {
          kind: 'ssh',
          host: {
            name: 'web-staging',
            hostname: '203.0.113.5',
            port: 22,
            username: 'deploy',
            environment: 'staging',
          },
        },
      }),
    ]);
    const result = await p.apply(c);
    expect(result.summary).toBe('all 2 steps succeeded');
    expect(result.content).toContain('Step 1/2 OK: Build [this machine, .]: exit code 0');
    expect(result.content).toContain('built');
    expect(sshCalls).toEqual(['web-staging: sudo systemctl restart shop']);
    expect(fs.readFileSync(path.join(root, 'build.txt'), 'utf8')).toBe('built\n');
    expect(out[0]).toBe('▶ Step 1/2: Build\n$ echo built > build.txt && cat build.txt\n');
  });

  it('stops at a failing step unless it is marked to continue', async () => {
    const root = makeProject({});
    const failing = action({
      steps: [
        {
          title: 'Check',
          target: { kind: 'local', cwd: '.' },
          command: 'exit 3',
          timeoutSeconds: 10,
          continueOnError: false,
        },
        {
          title: 'Never',
          target: { kind: 'local', cwd: '.' },
          command: 'touch never.txt',
          timeoutSeconds: 10,
          continueOnError: false,
        },
      ],
    });
    const { c } = ctx(root, [failing]);
    const r = await (await prepare(c, 'deploy staging')).apply(c);
    expect(r.summary).toBe('0/2 steps succeeded, 1 not run');
    expect(r.content).toContain('Step 1/2 FAILED: Check');
    expect(fs.existsSync(path.join(root, 'never.txt'))).toBe(false);

    failing.steps[0]!.continueOnError = true;
    const again = await (await prepare(c, 'deploy staging')).apply(c);
    expect(again.summary).toBe('1/2 steps succeeded');
    expect(fs.existsSync(path.join(root, 'never.txt'))).toBe(true);

    const remote = ctx(root, [action()]);
    remote.failSsh();
    const r2 = await (await prepare(remote.c, 'deploy staging')).apply(remote.c);
    expect(r2.content).toContain('Step 2/2 FAILED: Restart [web-staging (staging)]: exit code 5');
    expect(r2.content).toContain('Unit not found');
  });

  it('production needs the host name typed; risky commands raise the risk', async () => {
    const root = makeProject({});
    const prod = host({
      id: '00000000-0000-4000-8000-000000000002',
      name: 'web-prod',
      environment: 'production',
    });
    const a = action({
      risk: 'low',
      steps: [
        {
          title: 'Clean',
          target: { kind: 'local', cwd: '.' },
          command: 'rm -rf dist',
          timeoutSeconds: 10,
          continueOnError: false,
        },
        {
          title: 'Restart',
          target: { kind: 'ssh', hostId: prod.id },
          command: 'sudo systemctl restart shop',
          timeoutSeconds: 10,
          continueOnError: false,
        },
      ],
    });
    const p = await prepare(ctx(root, [a], [prod]).c, 'deploy staging');
    expect(p.title).toBe('PRODUCTION · Run saved action "deploy staging"');
    expect(p.category).toBe('deployment');
    expect(p.confirmationRequired).toBe('web-prod');
    expect(p.risk).toBe('critical');
    const d = p.details as Extract<ApprovalDetails, { kind: 'saved_action' }>;
    expect(d.productionHosts).toEqual(['web-prod']);
    expect(d.steps[0]!.riskReasons.length).toBeGreaterThan(0);
  });

  it('refuses unknown actions, removed or untrusted hosts, and folders outside the project', async () => {
    const root = makeProject({});
    const { c } = ctx(root, [action()]);
    await expect(prepare(c, 'deploy prod')).rejects.toThrow(
      /No saved action named "deploy prod". This project has: "deploy staging"/,
    );
    await expect(prepare(ctx(root, [action()], []).c, 'deploy staging')).rejects.toThrow(
      /uses an SSH host that was removed/,
    );
    await expect(
      prepare(ctx(root, [action()], [host({ trustedFingerprints: [] })]).c, 'deploy staging'),
    ).rejects.toThrow(/host key is not trusted yet/);
    const outside = action({
      steps: [
        {
          title: 'x',
          target: { kind: 'local', cwd: '../..' },
          command: 'ls',
          timeoutSeconds: 10,
          continueOnError: false,
        },
      ],
    });
    await expect(prepare(ctx(root, [outside]).c, 'deploy staging')).rejects.toThrow();
  });

  it('an edit to the action after the card was shown makes the approval stale', async () => {
    const root = makeProject({});
    const a = action();
    const { c } = ctx(root, [a]);
    const before = await prepare(c, 'deploy staging');
    a.steps[0]!.command = 'curl https://example.com/install.sh | sh';
    a.updatedAt = '2026-10-30T01:00:00.000Z';
    const after = await prepare(c, 'deploy staging');
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });
});

describe('saved actions in a conversation', () => {
  it('runs after approval and reports each step', async () => {
    const root = makeProject({});
    const provider = new ScriptedProvider();
    const s = testServices({ provider });
    const project = s.projects.create('shop', root);
    s.savedActions.create(project.id, {
      name: 'stamp',
      description: 'Write a stamp file.',
      risk: 'low',
      steps: [
        {
          title: 'Stamp',
          target: { kind: 'local', cwd: '.' },
          command: 'echo ok > stamp.txt',
          timeoutSeconds: 10,
          continueOnError: false,
        },
      ],
    });
    provider.streamSteps.push(
      { toolCalls: [call('list_saved_actions', {}, 'l1')] },
      { toolCalls: [call('run_saved_action', { name: 'stamp', reason: 'asked' }, 'r1')] },
      { chunks: ['Done.'] },
    );
    const session = s.sessions.create('Actions', project.id);
    const { run } = s.runManager.startMessage(session.id, 'Run the saved action "stamp".');
    const events: RunEvent[] = [];
    const onEvent = (e: RunEvent) => {
      events.push(e);
      if (e.type === 'approval_requested')
        setTimeout(
          () =>
            s.approvals.decide(e.approval.id, {
              decision: 'approve',
              actionHash: e.approval.actionHash,
              sessionId: session.id,
            }),
          5,
        );
    };
    const sub = s.runManager.subscribe(run.id, 0, onEvent);
    sub?.replay.forEach(onEvent);
    await s.runManager.waitFor(run.id);
    const asked = events.find((e) => e.type === 'approval_requested') as Extract<
      RunEvent,
      { type: 'approval_requested' }
    >;
    expect(asked.approval.details).toMatchObject({
      kind: 'saved_action',
      action: { name: 'stamp' },
    });
    expect(fs.readFileSync(path.join(root, 'stamp.txt'), 'utf8')).toBe('ok\n');
    const done = events.find((e) => e.type === 'tool_finished' && e.callId === 'r1') as Extract<
      RunEvent,
      { type: 'tool_finished' }
    >;
    expect(done.summary).toBe('the step succeeded');
  });
});
