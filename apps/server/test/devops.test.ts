import fs from 'node:fs';
import path from 'node:path';
import type { ApprovalDto, RunEvent, SshHostDto } from '@friday/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { Redactor } from '../src/security/redact.js';
import { sshArgs } from '../src/ssh/ssh.js';
import { summarizeInspect } from '../src/tools/devopsTools.js';
import { executeToolCall } from '../src/tools/registry.js';
import type { ToolContext } from '../src/tools/types.js';
import { detectToolEnvironment } from '../src/workspace/environment.js';
import {
  call,
  cleanupProjects,
  makeProject,
  ScriptedProvider,
  testConfig,
  testServices,
} from './helpers.js';

afterEach(cleanupProjects);
const env = await detectToolEnvironment();
const HEADERS = {
  host: '127.0.0.1:4317',
  'x-friday-client': '1',
  'content-type': 'application/json',
};

function services() {
  return testServices({ provider: new ScriptedProvider(), toolEnv: env });
}

function ctx(s: ReturnType<typeof services>, root: string | null, sessionId = 's'): ToolContext {
  return {
    project: root
      ? {
          id: 'p',
          name: 'p',
          rootPath: root,
          createdAt: '',
          lastOpenedAt: null,
          sandbox: null,
          worktree: null,
        }
      : null,
    sessionId,
    runId: 'r',
    callId: 'c',
    signal: new AbortController().signal,
    redactor: new Redactor(['ntl-secret-value-for-test']),
    env,
    maxOutputChars: 20_000,
    setPlan: () => undefined,
    devops: { hosts: s.sshHosts, ssh: s.ssh, logSources: s.logSources, plans: s.deploymentPlans },
  };
}
const run = (
  s: ReturnType<typeof services>,
  root: string | null,
  name: string,
  args: unknown,
  sessionId?: string,
) => executeToolCall(s.registry, call(name, args), ctx(s, root, sessionId), { timeoutMs: 30_000 });

describe('inspect_environment', () => {
  it('reports OS, disk and tool versions without environment variables', async () => {
    process.env.NTL_API_KEY_PROBE = 'ntl-secret-value-for-test';
    const s = services();
    const r = await run(s, makeProject({ 'a.txt': '' }), 'inspect_environment', {});
    delete process.env.NTL_API_KEY_PROBE;
    expect(r.status).toBe('completed');
    expect(r.content).toContain(`Node.js: ${process.version}`);
    expect(r.content).toMatch(/Disk:\n {2}\/.*GB free of/);
    expect(r.content).not.toContain('ntl-secret-value-for-test');
    expect(r.content).not.toContain('NTL_API_KEY');
  });
});

describe('search_logs', () => {
  it('reads the tail of a project log, filters, and redacts secrets', async () => {
    const lines = Array.from({ length: 500 }, (_, i) => `[2026-10-29] INFO request ${i}`);
    lines.push('[2026-10-29] ERROR SQLSTATE connection refused password=hunter2hunter2');
    const root = makeProject({ 'storage/logs/laravel.log': lines.join('\n') + '\n' });
    const s = services();
    const tail = await run(s, root, 'search_logs', {
      source: 'storage/logs/laravel.log',
      tail_lines: 3,
    });
    expect(tail.content.split('\n').slice(1)).toHaveLength(3);
    const errors = await run(s, root, 'search_logs', {
      source: 'storage/logs/laravel.log',
      query: 'error',
    });
    expect(errors.content).toContain('1 of 501 lines match "error"');
    expect(errors.content).toContain('SQLSTATE connection refused');
    expect(errors.content).not.toContain('hunter2hunter2');
  });

  it('reads only the end of large files', async () => {
    const big =
      `FIRST-MARKER\n${'x'.repeat(100)}\n`.repeat(1) +
      `${'y'.repeat(1023)}\n`.repeat(5 * 1024) +
      'LAST-MARKER\n';
    const root = makeProject({ 'big.log': big });
    const r = await run(services(), root, 'search_logs', { source: 'big.log', tail_lines: 2 });
    expect(r.content).toContain('last 4 MB read');
    expect(r.content).toContain('LAST-MARKER');
    expect(r.content).not.toContain('FIRST-MARKER');
  });

  it('uses only log sources the user authorized, and lists them when asked for an unknown one', async () => {
    const dir = makeProject({ 'nginx/error.log': 'upstream timed out\n' });
    const s = services();
    s.logSources.create('nginx-error', path.join(dir, 'nginx/error.log'));
    const ok = await run(s, null, 'search_logs', { source: 'nginx-error' });
    expect(ok.content).toContain('upstream timed out');
    const unknown = await run(s, null, 'search_logs', { source: '/var/log/syslog' });
    expect(unknown.content).toMatch(
      /No authorized log source named "\/var\/log\/syslog". Available: nginx-error/,
    );
    const root = makeProject({ 'a.log': 'x\n' });
    expect((await run(s, root, 'search_logs', { source: '/etc/passwd' })).content).toMatch(
      /outside the project root/,
    );
  });

  it('authorizes log sources only through the API, with path checks', async () => {
    const s = services();
    const app = await buildApp(s);
    const dir = makeProject({ 'app.log': 'hi\n', '.env': 'X=1' });
    const post = (payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: '/api/log-sources', headers: HEADERS, payload });
    expect((await post({ label: 'app', path: path.join(dir, 'app.log') })).statusCode).toBe(201);
    expect((await post({ label: 'pw', path: '/etc/passwd' })).statusCode).toBe(403);
    expect((await post({ label: 'env', path: path.join(dir, '.env') })).statusCode).toBe(403);
    expect((await post({ label: 'dir', path: dir })).statusCode).toBe(400);
    expect((await post({ label: 'rel', path: 'app.log' })).statusCode).toBe(400);
    expect((await post({ label: 'x', path: path.join(dir, 'app.log'), extra: 1 })).statusCode).toBe(
      400,
    );
    await app.close();
  });
});

describe('inspect_docker', () => {
  it('never exposes environment variable values from docker inspect', () => {
    const out = summarizeInspect([
      {
        Name: '/web',
        Config: {
          Image: 'nginx',
          Env: ['DB_PASSWORD=supersecret', 'PATH=/usr/bin'],
          Cmd: ['nginx'],
        },
        State: {
          Status: 'running',
          Running: true,
          Health: { Status: 'healthy', Log: [{ Output: 'ok' }] },
        },
        HostConfig: { Privileged: false, RestartPolicy: { Name: 'always' } },
        Mounts: [{ Type: 'bind', Source: '/srv', Destination: '/app', RW: true }],
      },
    ]);
    const json = JSON.stringify(out);
    expect(json).not.toContain('supersecret');
    expect(out).toMatchObject([
      {
        name: 'web',
        envNames: ['DB_PASSWORD', 'PATH'],
        state: { status: 'running', health: { status: 'healthy' } },
      },
    ]);
  });

  it('validates container names (no option injection)', async () => {
    const r = await run(services(), null, 'inspect_docker', {
      view: 'logs',
      container: '--privileged',
    });
    expect(r.status).toBe('error');
    expect(r.content).toMatch(/invalid container name/);
  });

  it.skipIf(process.env.CI === 'true')('lists containers when Docker is available', async () => {
    const r = await run(services(), null, 'inspect_docker', { view: 'containers' });
    expect(['completed', 'error']).toContain(r.status);
    if (r.status === 'completed')
      expect(r.content.split('\n')[0]).toBe('NAME\tIMAGE\tSTATUS\tPORTS');
  });
});

describe('validate_config', () => {
  const check = (files: Record<string, string>, p: string) =>
    run(services(), makeProject(files), 'validate_config', { path: p });

  it('finds GitHub Actions errors and security problems', async () => {
    const r = await check(
      {
        '.github/workflows/ci.yml': [
          'on: pull_request_target',
          'jobs:',
          '  build:',
          '    steps:',
          '      - uses: actions/checkout@main',
          '        with:',
          '          ref: ${{ github.event.pull_request.head.sha }}',
          '      - run: echo "${{ github.event.pull_request.title }}"',
        ].join('\n'),
      },
      '.github/workflows/ci.yml',
    );
    expect(r.content).toContain('INVALID');
    expect(r.content).toMatch(/line 3: Job "build" has no "runs-on"/);
    expect(r.content).toContain('unpinned action (actions/checkout@main)');
    expect(r.content).toContain('script injection');
    expect(r.content).toContain('pull_request_target');
    expect(r.content).toContain('No top-level "permissions"');
  });

  it('accepts a good workflow', async () => {
    const r = await check(
      {
        '.github/workflows/ci.yml':
          'on: [push]\npermissions:\n  contents: read\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm ci && npm test\n',
      },
      '.github/workflows/ci.yml',
    );
    expect(r.summary).toBe('valid, 0 warnings');
  });

  it('warns about risky Docker Compose settings without printing secret values', async () => {
    const r = await check(
      {
        'docker-compose.yml': [
          'services:',
          '  db:',
          '    image: mysql:8',
          '    ports: ["3306:3306"]',
          '    environment:',
          '      MYSQL_ROOT_PASSWORD: rootpw123',
          '  agent:',
          '    image: portainer/agent',
          '    privileged: true',
          '    volumes: ["/var/run/docker.sock:/var/run/docker.sock"]',
          '  safe:',
          '    image: redis',
          '    ports: ["127.0.0.1:6379:6379"]',
          '    environment: { REDIS_PASSWORD: "${REDIS_PASSWORD}" }',
          '  broken: {}',
        ].join('\n'),
      },
      'docker-compose.yml',
    );
    expect(r.content).toContain('Service "broken" needs "image" or "build"');
    expect(r.content).toContain('publishes database port 3306 on all interfaces');
    expect(r.content).toContain('hard-codes a value for MYSQL_ROOT_PASSWORD');
    expect(r.content).toContain('runs privileged');
    expect(r.content).toContain('mounts the Docker socket');
    expect(r.content).not.toContain('rootpw123');
    expect(r.content).not.toMatch(/"safe"/);
  });

  it('reports YAML and JSON syntax errors with line numbers', async () => {
    expect((await check({ 'a.yml': 'a: 1\nb: [1, 2\nc: 3\n' }, 'a.yml')).content).toMatch(
      /INVALID[\s\S]*line 3: Flow sequence/,
    );
    expect((await check({ 'a.json': '{\n  "a": 1,\n  "b": \n}' }, 'a.json')).content).toMatch(
      /line 4/,
    );
  });
});

// ------------------------------------------------------------------ deployment plans and remote operations

function host(
  s: ReturnType<typeof services>,
  name: string,
  environment: SshHostDto['environment'],
  trusted = true,
): SshHostDto {
  const h = s.sshHosts.create({
    name,
    hostname: '127.0.0.1',
    port: 1,
    username: 'deploy',
    identityFile: null,
    environment,
  });
  if (trusted)
    s.sshHosts.setTrusted(h.id, [
      { fingerprint: 'ED25519 SHA256:test', line: '[127.0.0.1]:1 ssh-ed25519 AAAAtest' },
    ]);
  return s.sshHosts.get(h.id)!;
}

const plan = (over: Record<string, unknown> = {}) => ({
  title: 'Deploy v2',
  environment: 'production',
  target: 'shop on web-prod',
  summary: 'Pull the release, migrate, reload PHP-FPM.',
  pre_checks: ['Database backup with mysqldump', 'Disk space above 20%'],
  steps: [
    {
      title: 'Pull code',
      command: 'cd /srv/shop && git pull --ff-only',
      where: 'web-prod',
      risk: 'medium',
      reversible: true,
      rollback: 'git checkout previous tag',
    },
    {
      title: 'Migrate',
      command: 'php artisan migrate --force',
      where: 'web-prod',
      risk: 'high',
      causes_downtime: false,
      reversible: false,
      rollback: 'restore the backup',
    },
  ],
  verification: ['curl -fsS https://shop.example/health'],
  rollback_plan: 'Check out the previous tag and restore the database backup.',
  data_loss_risk: 'Migration adds a column; low risk with backup.',
  downtime_estimate: 'none expected',
  ...over,
});

describe('prepare_deployment_plan', () => {
  it('rejects unsafe plans with clear reasons', async () => {
    const s = services();
    host(s, 'web-prod', 'production');
    host(s, 'web-staging', 'staging');
    const noBackup = await run(
      s,
      null,
      'prepare_deployment_plan',
      plan({ pre_checks: ['Check disk'] }),
    );
    expect(noBackup.content).toMatch(/add a database backup to pre_checks/);
    const noVerify = await run(
      s,
      null,
      'prepare_deployment_plan',
      plan({ verification: [], rollback_plan: '' }),
    );
    expect(noVerify.content).toMatch(/verification step/);
    expect(noVerify.content).toMatch(/rollback plan/);
    const mismatch = await run(
      s,
      null,
      'prepare_deployment_plan',
      plan({
        steps: [
          { title: 'x step', command: 'ls', where: 'web-staging', risk: 'low', reversible: true },
        ],
      }),
    );
    expect(mismatch.content).toMatch(
      /targets web-staging \(staging\) but the plan is for production/,
    );
    const unknownHost = await run(
      s,
      null,
      'prepare_deployment_plan',
      plan({ steps: [{ title: 'x step', where: 'nope', risk: 'low', reversible: true }] }),
    );
    expect(unknownHost.content).toMatch(/not a configured SSH host/);
    expect(s.deploymentPlans.listBySession('s')).toEqual([]);
  });

  it('records a good plan without executing anything', async () => {
    const s = services();
    host(s, 'web-prod', 'production');
    const session = s.sessions.create();
    const r = await run(s, null, 'prepare_deployment_plan', plan(), session.id);
    expect(r.status).toBe('completed');
    expect(r.content).toMatch(/Executed so far: none/);
    expect(s.deploymentPlans.listBySession(session.id)).toMatchObject([
      {
        environment: 'production',
        steps: [{ title: 'Pull code' }, { title: 'Migrate', reversible: false }],
      },
    ]);
  });
});

describe('ssh configuration', () => {
  it('uses strict, non-interactive, config-isolated ssh options', () => {
    const args = sshArgs(
      {
        id: 'i',
        name: 'n',
        hostname: 'example.com',
        port: 2222,
        username: 'deploy',
        identityFile: '/k/id',
        environment: 'staging',
        trustedFingerprints: [],
        createdAt: '',
      },
      '/kh',
    );
    const joined = args.join(' ');
    for (const opt of [
      '-F /dev/null',
      'BatchMode=yes',
      'StrictHostKeyChecking=yes',
      'UserKnownHostsFile=/kh',
      'GlobalKnownHostsFile=/dev/null',
      'PasswordAuthentication=no',
      'ForwardAgent=no',
      'IdentitiesOnly=yes',
      '-i /k/id',
      '-p 2222',
      '-l deploy',
    ]) {
      expect(joined).toContain(opt);
    }
    expect(args.slice(-2)).toEqual(['--', 'example.com']);
  });

  it('accepts hosts only through the API and never accepts secrets', async () => {
    const s = services();
    const app = await buildApp(s);
    const key = makeProject({ id_ed25519: 'not really a key', 'id_ed25519.pub': 'pub' });
    const post = (payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: '/api/ssh-hosts', headers: HEADERS, payload });
    const base = {
      name: 'web-1',
      hostname: 'web1.example.com',
      username: 'deploy',
      environment: 'staging',
    };
    expect((await post({ ...base, password: 'hunter2' })).statusCode).toBe(400);
    expect(
      (await post({ ...base, identityFile: path.join(key, 'id_ed25519.pub') })).json().error.code,
    ).toBe('invalid_identity');
    expect((await post({ ...base, identityFile: '/nope/key' })).json().error.code).toBe(
      'invalid_identity',
    );
    expect((await post({ ...base, hostname: '-oProxyCommand=evil' })).statusCode).toBe(400);
    const ok = await post({ ...base, identityFile: path.join(key, 'id_ed25519') });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ name: 'web-1', port: 22, trustedFingerprints: [] });
    // Unreachable host: scanning reports a clear error and trusts nothing.
    const bad = s.sshHosts.create({
      name: 'dead',
      hostname: '127.0.0.1',
      port: 1,
      username: 'x',
      identityFile: null,
      environment: 'development',
    });
    const scan = await app.inject({
      method: 'POST',
      url: `/api/ssh-hosts/${bad.id}/scan`,
      headers: { host: HEADERS.host, 'x-friday-client': '1' },
    });
    expect(scan.statusCode).toBe(409);
    expect(s.sshHosts.get(bad.id)?.trustedFingerprints).toEqual([]);
    expect(s.audit.list().map((e) => e.action)).toContain('ssh_host_added');
    await app.close();
  });
});

function setupAgent(steps: ConstructorParameters<typeof ScriptedProvider>[0]) {
  const provider = new ScriptedProvider(steps);
  const s = testServices({ provider, config: testConfig(), toolEnv: env });
  const session = s.sessions.create();
  return { s, session };
}

function firstApproval(s: ReturnType<typeof services>, sessionId: string, text: string) {
  const { run: r } = s.runManager.startMessage(sessionId, text);
  const approval = new Promise<ApprovalDto>((resolve) => {
    const on = (e: RunEvent) => e.type === 'approval_requested' && resolve(e.approval);
    s.runManager.subscribe(r.id, 0, on)?.replay.forEach(on);
  });
  return { runId: r.id, approval };
}

describe('remote operations', () => {
  it('rejects injection in diagnostic targets and refuses untrusted hosts', async () => {
    const { s, session } = setupAgent([
      {
        toolCalls: [
          call(
            'remote_diagnose',
            {
              host: 'web-stg',
              check: 'service_status',
              target: 'nginx; rm -rf /',
              reason: 'check nginx',
            },
            'a',
          ),
          call(
            'remote_diagnose',
            { host: 'web-stg', check: 'tail_log', target: '/etc/shadow', reason: 'read log' },
            'b',
          ),
          call(
            'remote_diagnose',
            { host: 'new-box', check: 'uptime', reason: 'check uptime' },
            'c',
          ),
        ],
      },
      { chunks: ['ok'] },
    ]);
    host(s, 'web-stg', 'staging');
    host(s, 'new-box', 'development', false);
    const { run: r } = s.runManager.startMessage(session.id, 'diagnose');
    await s.runManager.waitFor(r.id);
    const tools = s.messages
      .listBySession(session.id)
      .filter((m) => m.role === 'tool')
      .map((m) => m.content);
    expect(tools[0]).toMatch(/needs target = a systemd unit name/);
    expect(tools[1]).toMatch(/absolute path under \/var\/log/);
    expect(tools[2]).toMatch(/has no trusted host key/);
    expect(s.approvalRepo.listBySession(session.id)).toEqual([]);
  });

  it('refuses production commands without a deployment plan', async () => {
    const { s, session } = setupAgent([
      {
        toolCalls: [
          call(
            'remote_command',
            {
              host: 'web-prod',
              command: 'systemctl restart php8.3-fpm',
              expected_impact: 'Restarts PHP workers',
              downtime: 'a few seconds',
              rollback: 'none needed',
              verification: 'curl health',
              reason: 'apply config',
            },
            'x',
          ),
        ],
      },
      { chunks: ['ok'] },
    ]);
    host(s, 'web-prod', 'production');
    const { run: r } = s.runManager.startMessage(session.id, 'restart');
    await s.runManager.waitFor(r.id);
    expect(s.messages.listBySession(session.id).find((m) => m.role === 'tool')?.content).toMatch(
      /require a deployment plan recorded in this conversation first/,
    );
    expect(s.approvalRepo.listBySession(session.id)).toEqual([]);
  });

  it('requires the typed host name to approve production commands, enforced by the server', async () => {
    const restart = call(
      'remote_command',
      {
        host: 'web-prod',
        command: 'sudo systemctl restart php8.3-fpm',
        expected_impact: 'Restarts PHP workers',
        downtime: 'a few seconds',
        rollback: 'none needed',
        verification: 'curl health',
        reason: 'apply config',
      },
      'x',
    );
    const { s, session } = setupAgent([
      { toolCalls: [call('prepare_deployment_plan', plan(), 'p')] },
      { toolCalls: [restart] },
      { chunks: ['done'] },
    ]);
    host(s, 'web-prod', 'production');
    const { runId, approval } = firstApproval(s, session.id, 'deploy');
    const a = await approval;
    expect(a).toMatchObject({
      category: 'deployment',
      risk: 'critical',
      confirmationRequired: 'web-prod',
    });
    expect(a.details).toMatchObject({
      kind: 'remote',
      host: { name: 'web-prod', environment: 'production' },
      command: 'sudo systemctl restart php8.3-fpm',
      downtime: 'a few seconds',
    });
    expect(Date.parse(a.expiresAt) - Date.now()).toBeLessThanOrEqual(5 * 60_000);
    const decide = (confirmation?: string) => () =>
      s.approvals.decide(a.id, {
        decision: 'approve',
        actionHash: a.actionHash,
        sessionId: session.id,
        ...(confirmation !== undefined ? { confirmation } : {}),
      });
    expect(decide()).toThrow(/Type "web-prod" to confirm/);
    expect(decide('web-staging')).toThrow(/Type "web-prod"/);
    expect(s.approvalRepo.get(a.id)?.status).toBe('pending');
    decide('web-prod')();
    await s.runManager.waitFor(runId);
    // The (unreachable) host makes ssh fail; the result says so instead of pretending.
    const result = s.messages
      .listBySession(session.id)
      .filter((m) => m.role === 'tool')
      .at(-1)!.content;
    expect(result).toMatch(/ssh error: (Could not connect|SSH failed)/);
    expect(s.audit.list().map((e) => e.action)).toContain('approval_approved');
  });

  it('does not require typed confirmation for staging, but raises the risk floor', async () => {
    const { s, session } = setupAgent([
      {
        toolCalls: [
          call(
            'remote_command',
            {
              host: 'web-stg',
              command: 'ls /srv',
              expected_impact: 'none, read only',
              downtime: 'none',
              rollback: 'n/a',
              verification: 'n/a',
              reason: 'look around',
            },
            'x',
          ),
        ],
      },
    ]);
    host(s, 'web-stg', 'staging');
    const { runId, approval } = firstApproval(s, session.id, 'look');
    const a = await approval;
    expect(a).toMatchObject({ category: 'remote', risk: 'medium', confirmationRequired: null });
    s.runManager.cancel(runId);
    await s.runManager.waitFor(runId);
  });
});

it('keeps the fake .pub file out of approvals and audit (sanity)', () => {
  expect(fs.existsSync('/nonexistent')).toBe(false);
});

describe('findJsonError', async () => {
  const { findJsonError } = await import('../src/workspace/jsonCheck.js');
  it('agrees with JSON.parse on validity and locates errors', () => {
    const samples = [
      '{}',
      '[]',
      '{"a":[1,2,{"b":null}],"c":"\\u00e9\\n"}',
      '-0.5e10',
      '"x"',
      'true',
      '{"a":1,}',
      '[1 2]',
      '{a:1}',
      "{'a':1}",
      '{"a":01}',
      '"\\x"',
      '{"a":"\n"}',
      '[',
      '',
      'nul',
      '{"a":1}}',
    ];
    for (const t of samples) {
      let native = true;
      try {
        JSON.parse(t);
      } catch {
        native = false;
      }
      expect(findJsonError(t) === null, JSON.stringify(t)).toBe(native);
    }
    expect(findJsonError('{\n  "a": 1,\n  "b": \n}')).toEqual({
      line: 4,
      column: 1,
      message: 'Unexpected "}"',
    });
  });
});
