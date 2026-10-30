import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { MonitorDto, MonitorInput, ProcessDto, SshHostDto } from '@friday/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { RunResult } from '../src/commands/runner.js';
import { parseSsh, runCheck, shownUrl, sshScript, type CheckDeps } from '../src/monitors/checks.js';
import { MonitorService } from '../src/monitors/service.js';
import { KEEP_CHECKS } from '../src/repositories/monitors.js';
import { Redactor } from '../src/security/redact.js';
import { monitorStatus } from '../src/tools/monitorTools.js';
import type { ToolContext } from '../src/tools/types.js';
import { detectToolEnvironment } from '../src/workspace/environment.js';
import { cleanupProjects, makeProject, testServices } from './helpers.js';

afterEach(cleanupProjects);
const env = await detectToolEnvironment();
const H = { host: '127.0.0.1:4317', 'x-friday-client': '1', 'content-type': 'application/json' };

// A local web server standing in for the monitored site.
let base = '';
let server: http.Server;
beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/ok') return void res.end('{"status":"ok"}');
    if (url === '/down') {
      res.statusCode = 503;
      return void res.end('maintenance');
    }
    if (url === '/hop') {
      res.writeHead(302, { location: '/ok' });
      return void res.end();
    }
    if (url === '/away') {
      res.writeHead(302, { location: 'http://example.invalid/elsewhere' });
      return void res.end();
    }
    if (url === '/slow') return void setTimeout(() => res.end('late'), 3_000);
    if (url.startsWith('/agent')) return void res.end(req.headers['user-agent'] ?? '');
    res.statusCode = 404;
    res.end('nope');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

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

const result = (over: Partial<RunResult> = {}): RunResult => ({
  exitCode: 0,
  signal: null,
  output: '',
  omittedBytes: 0,
  timedOut: false,
  cancelled: false,
  spawnError: null,
  durationMs: 40,
  ...over,
});

const proc = (over: Partial<ProcessDto> = {}): ProcessDto => ({
  id: 'proc_00000001',
  projectId: 'p',
  sessionId: 's',
  name: 'dev server',
  command: 'npm run dev',
  cwd: '.',
  sandbox: null,
  status: 'running',
  exitCode: null,
  signal: null,
  error: null,
  stoppedBy: null,
  urls: [],
  startedAt: '2026-10-31T10:00:00.000Z',
  endedAt: null,
  ...over,
});

function deps(over: Partial<CheckDeps> = {}): CheckDeps {
  return {
    fetch,
    sshHost: () => host(),
    sshRun: async () => result(),
    processes: () => [],
    projectRoot: () => null,
    ...over,
  };
}

const monitor = (target: MonitorDto['target'], over: Partial<MonitorDto> = {}): MonitorDto => ({
  id: 'm',
  name: 'shop',
  projectId: 'p',
  target,
  intervalMinutes: 5,
  failuresBeforeAlert: 2,
  enabled: true,
  status: 'pending',
  statusSince: null,
  lastCheckedAt: null,
  lastMessage: null,
  consecutiveFailures: 0,
  recent: [],
  createdAt: '',
  updatedAt: '',
  ...over,
});

const httpTarget = (path: string, over: object = {}): MonitorDto['target'] => ({
  kind: 'http',
  url: `${base}${path}`,
  expectedStatus: null,
  contains: null,
  timeoutSeconds: 5,
  ...over,
});

const check = (target: MonitorDto['target'], d = deps()) =>
  runCheck(monitor(target), d, new AbortController().signal);

describe('HTTP checks', () => {
  it('passes on 2xx/3xx, fails on other statuses, and checks the body text', async () => {
    expect(await check(httpTarget('/ok'))).toEqual({ ok: true, message: 'HTTP 200 OK' });
    expect(await check(httpTarget('/down'))).toEqual({
      ok: false,
      message: 'HTTP 503 Service Unavailable (expected 2xx or 3xx)',
    });
    expect(await check(httpTarget('/ok', { contains: '"status":"ok"' }))).toMatchObject({
      ok: true,
    });
    expect(await check(httpTarget('/ok', { contains: 'healthy' }))).toEqual({
      ok: false,
      message: 'HTTP 200 OK, but the response does not contain the expected text',
    });
    expect(await check(httpTarget('/nope', { expectedStatus: 404 }))).toMatchObject({ ok: true });
    expect((await check(httpTarget('/agent'))).ok).toBe(true);
  });

  it('follows redirects on the same host only', async () => {
    expect(await check(httpTarget('/hop', { contains: 'ok' }))).toMatchObject({ ok: true });
    // Another host's redirect is not followed: the 302 itself is the answer.
    expect(await check(httpTarget('/away'))).toEqual({ ok: true, message: 'HTTP 302 Found' });
    expect(await check(httpTarget('/away', { expectedStatus: 200 }))).toMatchObject({
      ok: false,
      message: 'HTTP 302 Found (expected 200)',
    });
  });

  it('reports timeouts and refused connections', async () => {
    expect(await check(httpTarget('/slow', { timeoutSeconds: 1 }))).toEqual({
      ok: false,
      message: 'no response within 1s',
    });
    const closed = await new Promise<number>((resolve) => {
      const s = http.createServer().listen(0, '127.0.0.1', () => {
        const port = (s.address() as AddressInfo).port;
        s.close(() => resolve(port));
      });
    });
    expect(
      await check({
        ...httpTarget('/'),
        url: `http://127.0.0.1:${closed}/`,
      } as MonitorDto['target']),
    ).toEqual({ ok: false, message: 'connection refused (ECONNREFUSED)' });
  });

  it('hides the query string from the model', () => {
    expect(shownUrl('https://shop.example.com/health?token=abc123')).toBe(
      'https://shop.example.com/health?…',
    );
  });
});

describe('SSH checks', () => {
  const t = (over: object = {}) =>
    ({
      kind: 'ssh',
      hostId: host().id,
      service: null,
      diskPath: null,
      diskMaxPercent: null,
      ...over,
    }) as Extract<MonitorDto['target'], { kind: 'ssh' }>;

  it('runs a fixed script with quoted arguments', () => {
    expect(sshScript(t())).toBe('echo FRIDAY_MONITOR_OK');
    expect(sshScript(t({ service: 'nginx', diskPath: '/var', diskMaxPercent: 90 }))).toBe(
      `echo FRIDAY_MONITOR_OK; echo "SERVICE $(systemctl is-active 'nginx' 2>&1 | head -n 1)"; echo "DISK $(df -P '/var' 2>/dev/null | tail -n 1 | awk '{print $5}')"`,
    );
    expect(() => sshScript(t({ service: 'x;reboot' }))).toThrow(/Invalid systemd unit/);
    expect(() => sshScript(t({ diskPath: '/var $(id)' }))).toThrow(/Invalid disk path/);
  });

  it('reads the answer', () => {
    const target = t({ service: 'nginx', diskPath: '/', diskMaxPercent: 90 });
    expect(
      parseSsh(target, result({ output: 'FRIDAY_MONITOR_OK\nSERVICE active\nDISK 41%\n' }), host()),
    ).toEqual({ ok: true, message: 'web-staging: reachable, nginx is active, / 41% full' });
    expect(
      parseSsh(target, result({ output: 'FRIDAY_MONITOR_OK\nSERVICE failed\nDISK 95%\n' }), host()),
    ).toEqual({
      ok: false,
      message: 'web-staging: nginx is failed; / is 95% full (limit 90%)',
    });
    expect(
      parseSsh(
        t(),
        result({
          exitCode: 255,
          output: 'ssh: connect to host 203.0.113.5 port 22: Connection refused',
        }),
        host(),
      ).ok,
    ).toBe(false);
    expect(parseSsh(t(), result({ timedOut: true }), host())).toEqual({
      ok: false,
      message: 'web-staging: no answer within 20s',
    });
  });

  it('never connects to an untrusted or removed host', async () => {
    let ran = 0;
    const d = deps({
      sshRun: async () => {
        ran++;
        return result();
      },
    });
    expect(
      await check(t(), { ...d, sshHost: () => host({ trustedFingerprints: [] }) }),
    ).toMatchObject({
      ok: false,
      message: expect.stringMatching(/host key not trusted/),
    });
    expect(await check(t(), { ...d, sshHost: () => null })).toEqual({
      ok: false,
      message: 'the SSH host was removed',
    });
    expect(ran).toBe(0);
  });
});

describe('process checks', () => {
  const t = { kind: 'process', processName: 'Dev Server' } as const;
  it('looks for a running background process of the project by name', async () => {
    expect(await check(t, deps({ processes: () => [proc()] }))).toEqual({
      ok: true,
      message: '"dev server" is running (proc_00000001)',
    });
    expect(
      await check(
        t,
        deps({ processes: () => [proc({ status: 'exited', exitCode: 1, endedAt: 'x' })] }),
      ),
    ).toEqual({ ok: false, message: '"dev server" is not running: exited with code 1' });
    expect(await check(t, deps())).toMatchObject({
      ok: false,
      message: expect.stringMatching(/has run since Friday started/),
    });
  });
});

describe('monitor status and history', () => {
  const input = (over: Partial<MonitorInput> = {}): MonitorInput => ({
    name: 'shop',
    projectId: null,
    target: httpTarget('/ok'),
    intervalMinutes: 5,
    failuresBeforeAlert: 2,
    enabled: true,
    ...over,
  });

  it('goes down after N failures in a row and reports the recovery', () => {
    const s = testServices();
    const m = s.monitors.create(input());
    const fail = { ok: false, durationMs: 5, message: 'HTTP 503' };
    const pass = { ok: true, durationMs: 5, message: 'HTTP 200' };
    // The first passing check is not news.
    expect(s.monitors.record(m.id, pass)!.transition).toBeNull();
    expect(s.monitors.record(m.id, fail)!.monitor).toMatchObject({
      status: 'up',
      consecutiveFailures: 1,
    });
    const down = s.monitors.record(m.id, fail)!;
    expect(down.transition).toBe('down');
    expect(down.monitor).toMatchObject({
      status: 'down',
      consecutiveFailures: 2,
      lastMessage: 'HTTP 503',
    });
    expect(s.monitors.record(m.id, fail)!.transition).toBeNull();
    const up = s.monitors.record(m.id, pass)!;
    expect(up.transition).toBe('up');
    expect(up.monitor.recent.map((c) => c.ok)).toEqual([true, false, false, false, true]);
    expect(s.monitors.detail(m.id)!.events.map((e) => e.status)).toEqual(['up', 'down', 'up']);
    // Paused monitors show as paused and are never due.
    const paused = s.monitors.update(m.id, input({ enabled: false }))!;
    expect(paused.status).toBe('paused');
    expect(s.monitors.due(new Date(Date.now() + 86_400_000))).toEqual([]);
  });

  it('starts over when what it checks changes, and keeps a bounded history', () => {
    const s = testServices();
    const m = s.monitors.create(input({ failuresBeforeAlert: 1 }));
    s.monitors.record(m.id, { ok: false, durationMs: 1, message: 'x' });
    expect(
      s.monitors.update(m.id, input({ failuresBeforeAlert: 1, intervalMinutes: 10 }))!.status,
    ).toBe('down');
    const moved = s.monitors.update(m.id, input({ target: httpTarget('/other') }))!;
    expect(moved).toMatchObject({ status: 'pending', consecutiveFailures: 0, statusSince: null });
    for (let i = 0; i < KEEP_CHECKS + 20; i++)
      s.monitors.record(m.id, { ok: true, durationMs: 1, message: `#${i}` });
    const d = s.monitors.detail(m.id, 1_000)!;
    expect(d.checks).toHaveLength(KEEP_CHECKS);
    expect(d.checks[0]!.message).toBe(`#${KEEP_CHECKS + 19}`);
  });

  it('checks due monitors on schedule and tells listeners about outages', async () => {
    const s = testServices();
    const svc = new MonitorService(s.monitors, deps(), (t) =>
      new Redactor(['sekret-token-value']).redact(t),
    );
    const changes: string[] = [];
    svc.onChange((c) => changes.push(`${c.monitor.name}:${c.monitor.status}:${c.transition}`));
    s.monitors.create(input({ name: 'ok', failuresBeforeAlert: 1 }));
    s.monitors.create(
      input({ name: 'broken', target: httpTarget('/down'), failuresBeforeAlert: 1 }),
    );
    s.monitors.create(input({ name: 'off', enabled: false }));
    await svc.tick();
    expect(changes.sort()).toEqual(['broken:down:down', 'ok:up:null']);
    // Not due again until the interval has passed.
    expect(await svc.tick()).toEqual([]);
    expect((await svc.tick(new Date(Date.now() + 5 * 60_000 + 1_000))).length).toBe(2);
    // Two requests for the same monitor share one check.
    const id = s.monitors.byName('ok')!.id;
    const [a, b] = [svc.check(id), svc.check(id)];
    expect(a).toBe(b);
    await a;
    svc.stop();
  });
});

describe('monitor routes', () => {
  const base_ = () => {
    const s = testServices({ monitorFetch: fetch });
    return s;
  };

  it('only the user defines monitors, with validated targets', async () => {
    const s = base_();
    const app = await buildApp(s);
    const root = makeProject({ 'a.txt': '' });
    const project = s.projects.create('shop', root);
    const ssh = s.sshHosts.create({
      name: 'web-staging',
      hostname: '203.0.113.5',
      port: 22,
      username: 'deploy',
      identityFile: null,
      environment: 'staging',
    });
    const post = (payload: object) =>
      app.inject({ method: 'POST', url: '/api/monitors', headers: H, payload });

    const created = await post({ name: 'shop', target: { kind: 'http', url: `${base}/ok` } });
    expect(created.statusCode).toBe(201);
    const m = created.json() as MonitorDto;
    expect(m).toMatchObject({ intervalMinutes: 5, failuresBeforeAlert: 2, status: 'pending' });

    const bad = async (payload: object, code: string) => {
      const r = await post(payload);
      expect(r.statusCode, JSON.stringify(payload)).toBeGreaterThanOrEqual(400);
      expect(r.json().error.code, r.body).toBe(code);
    };
    await bad({ name: 'shop', target: { kind: 'http', url: `${base}/x` } }, 'monitor_exists');
    await bad({ name: 'a', target: { kind: 'http', url: 'ftp://x/' } }, 'invalid_url');
    await bad({ name: 'b', target: { kind: 'http', url: 'https://u:p@x.test/' } }, 'invalid_url');
    await bad({ name: 'c', target: { kind: 'process', processName: 'dev' } }, 'project_required');
    await bad({ name: 'd', target: { kind: 'ssh', hostId: ssh.id } }, 'untrusted_host');
    s.sshHosts.setTrusted(ssh.id, [{ fingerprint: 'SHA256:abc', line: 'x ssh-ed25519 AAAA' }]);
    await bad(
      { name: 'e', target: { kind: 'ssh', hostId: ssh.id, diskPath: '/' } },
      'invalid_disk',
    );
    await bad(
      { name: 'f', target: { kind: 'ssh', hostId: ssh.id, service: 'x; reboot' } },
      'invalid_request',
    );
    expect(
      (
        await post({
          name: 'dev',
          projectId: project.id,
          target: { kind: 'process', processName: 'dev server' },
        })
      ).statusCode,
    ).toBe(201);

    // Check now, edit, pause, delete.
    const checked = await app.inject({
      method: 'POST',
      url: `/api/monitors/${m.id}/check`,
      headers: H,
      payload: {},
    });
    expect((checked.json() as MonitorDto).lastMessage).toBe('HTTP 200 OK');
    const put = await app.inject({
      method: 'PUT',
      url: `/api/monitors/${m.id}`,
      headers: H,
      payload: { name: 'shop', target: { kind: 'http', url: `${base}/ok` }, enabled: false },
    });
    expect((put.json() as MonitorDto).status).toBe('paused');
    const detail = await app.inject({ method: 'GET', url: `/api/monitors/${m.id}`, headers: H });
    expect(detail.json().checks.length).toBeGreaterThanOrEqual(1);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/monitors/${m.id}`,
          headers: { host: H.host, 'x-friday-client': '1' },
        })
      ).statusCode,
    ).toBe(204);
    const list = await app.inject({ method: 'GET', url: '/api/monitors', headers: H });
    expect((list.json().monitors as MonitorDto[]).map((x) => x.name)).toEqual(['dev']);
    expect(s.audit.list().map((e) => e.action)).toEqual(
      expect.arrayContaining(['monitor_created', 'monitor_changed', 'monitor_deleted']),
    );
    // Removing the project removes its monitors.
    s.projects.delete(project.id);
    expect(s.monitors.list()).toEqual([]);
    await app.close();
  });
});

describe('monitor_status tool', () => {
  it('shows status and history read-only, without query strings', async () => {
    const s = testServices();
    const m = s.monitors.create({
      name: 'shop',
      projectId: null,
      target: httpTarget('/health?token=abc123secret'),
      intervalMinutes: 5,
      failuresBeforeAlert: 1,
      enabled: true,
    });
    s.monitors.record(m.id, { ok: false, durationMs: 12, message: 'HTTP 503 Service Unavailable' });
    const ctx = {
      project: null,
      sessionId: 's',
      runId: 'r',
      signal: new AbortController().signal,
      redactor: new Redactor(),
      env,
      maxOutputChars: 20_000,
      setPlan: () => undefined,
      monitors: s.monitors,
    } as ToolContext;
    const all = await monitorStatus.execute!(monitorStatus.schema.parse({}), ctx);
    expect(all.summary).toBe('1 monitor, 1 down');
    expect(all.content).toMatch(
      /"shop": DOWN since .* \(1 failed checks in a row\)\. Checks GET http:\/\/127\.0\.0\.1:\d+\/health\?… \(expects 2xx\/3xx\)/,
    );
    expect(all.content).not.toContain('abc123secret');
    const one = await monitorStatus.execute!(monitorStatus.schema.parse({ name: 'SHOP' }), ctx);
    expect(one.content).toMatch(/FAIL 12 ms HTTP 503 Service Unavailable/);
    expect(one.content).toMatch(/DOWN: HTTP 503/);
    await expect(
      monitorStatus.execute!(monitorStatus.schema.parse({ name: 'nope' }), ctx),
    ).rejects.toThrow(/No monitor named "nope". Monitors: "shop"/);
  });
});
