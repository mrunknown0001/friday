import { execFileSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import type { ApprovalDetails } from '@friday/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  imagePresent,
  parseConfig,
  resolveComposeFiles,
  splitContainers,
  verdict,
  withDependencies,
  type ComposeContainer,
  type ComposeProject,
} from '../src/compose/compose.js';
import { dockerVersion } from '../src/sandbox/docker.js';
import { Redactor } from '../src/security/redact.js';
import { composeControl, composeStatus, dedupeProgress } from '../src/tools/composeTools.js';
import type { ToolContext } from '../src/tools/types.js';
import { detectToolEnvironment } from '../src/workspace/environment.js';
import { cleanupProjects, makeProject } from './helpers.js';

afterEach(cleanupProjects);
const env = await detectToolEnvironment();

type Details = Extract<ApprovalDetails, { kind: 'compose' }>;

function ctx(root: string, out: string[] = []): ToolContext {
  return {
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
  };
}

const control = (c: ToolContext, args: Record<string, unknown>) =>
  composeControl.prepare!(composeControl.schema.parse({ reason: 'the user asked', ...args }), c);
const status = (c: ToolContext, args: Record<string, unknown> = {}) =>
  composeStatus.execute!(composeStatus.schema.parse(args), c);

const container = (over: Partial<ComposeContainer> = {}): ComposeContainer => ({
  id: 'x',
  name: 'shop-web-1',
  service: 'web',
  oneoff: false,
  state: 'running',
  exitCode: 0,
  restartCount: 0,
  startedAt: '',
  health: null,
  published: [],
  anonymousVolumes: 0,
  ...over,
});

describe('compose files and configuration', () => {
  it('uses the default file with its override, or a named compose file inside the project', async () => {
    const root = makeProject({
      'compose.yaml': 'services: {}',
      'compose.override.yaml': 'services: {}',
      'docker/compose.dev.yml': 'services: {}',
      'docker/notes.yml': 'a: 1',
    });
    expect((await resolveComposeFiles(root)).rel).toEqual([
      'compose.yaml',
      'compose.override.yaml',
    ]);
    expect((await resolveComposeFiles(root, 'docker/compose.dev.yml')).abs).toEqual([
      path.join(root, 'docker/compose.dev.yml'),
    ]);
    await expect(resolveComposeFiles(root, 'docker/notes.yml')).rejects.toThrow(
      /not a compose file/,
    );
    await expect(resolveComposeFiles(root, '../compose.yaml')).rejects.toThrow(/outside/);
    await expect(resolveComposeFiles(makeProject({ 'a.txt': '' }))).rejects.toThrow(
      /No compose file/,
    );
  });

  it('keeps operational facts only: no environment values, labels or commands', () => {
    const p = parseConfig(
      {
        name: 'shop',
        services: {
          web: {
            image: 'nginx:alpine',
            environment: { API_TOKEN: 'tok-very-secret' },
            labels: { secret: 'label-secret' },
            command: ['--password', 'cmd-secret'],
            ports: [{ host_ip: '127.0.0.1', target: 80, published: '8080', protocol: 'tcp' }],
            depends_on: { db: { condition: 'service_healthy' } },
            healthcheck: { test: ['CMD', 'true'] },
          },
          db: { image: 'postgres:17-alpine', healthcheck: { disable: true } },
          app: { build: { context: '/x' } },
        },
        volumes: { data: { name: 'shop_data' }, shared: { name: 'shared', external: true } },
      },
      { rel: ['compose.yaml'], abs: ['/p/compose.yaml'], dir: '/p' },
    );
    expect(JSON.stringify(p)).not.toMatch(/secret/);
    expect(p.services.map((s) => s.name)).toEqual(['app', 'db', 'web']);
    expect(p.services[0]).toMatchObject({ image: 'shop-app', declaredImage: null, build: true });
    expect(p.services[1]!.healthcheck).toBe(false);
    expect(p.services[2]).toMatchObject({
      ports: ['127.0.0.1:8080→80/tcp'],
      dependsOn: ['db'],
      healthcheck: true,
    });
    expect(p.volumes).toEqual(['shop_data']);
    expect(() =>
      parseConfig({ name: '../x', services: {} }, { rel: [], abs: [], dir: '' }),
    ).toThrow();
  });

  it('starts dependencies with up, transitively', () => {
    const svc = (name: string, dependsOn: string[] = []) => ({
      name,
      image: name,
      declaredImage: name,
      build: false,
      ports: [],
      dependsOn,
      healthcheck: false,
    });
    const p = {
      services: [
        svc('web', ['api']),
        svc('api', ['db', 'cache']),
        svc('db'),
        svc('cache'),
        svc('worker'),
      ],
    } as unknown as ComposeProject;
    expect(withDependencies(p, ['web'])).toEqual(['api', 'cache', 'db', 'web']);
    expect(withDependencies(p, ['worker'])).toEqual(['worker']);
  });

  it('tells this project’s containers apart from another compose file’s with the same name', () => {
    const inspect = (name: string, files: string, extra: object = {}) => ({
      Id: name,
      Name: `/${name}`,
      Config: {
        Labels: {
          'com.docker.compose.service': name.split('-')[1],
          'com.docker.compose.project.config_files': files,
        },
      },
      State: { Status: 'running', ExitCode: 0 },
      ...extra,
    });
    const c = splitContainers(
      [
        inspect('shop-web-1', '/p/compose.yaml,/p/compose.override.yaml', {
          State: {
            Status: 'running',
            Health: {
              Status: 'unhealthy',
              FailingStreak: 4,
              Log: [{ Output: 'connection refused\n' }],
            },
          },
          NetworkSettings: {
            Ports: {
              '80/tcp': [
                { HostIp: '0.0.0.0', HostPort: '8080' },
                { HostIp: '::', HostPort: '8080' },
              ],
              '53/udp': [{ HostIp: '0.0.0.0', HostPort: '53' }],
              '9000/tcp': null,
            },
          },
          Mounts: [
            { Type: 'volume', Name: 'a'.repeat(64) },
            { Type: 'volume', Name: 'shop_data' },
            { Type: 'bind', Source: '/p' },
          ],
        }),
        inspect('shop-db-1', '/other/checkout/compose.yaml'),
      ],
      ['/p/compose.yaml'],
    );
    expect(c.foreign).toEqual([{ name: 'shop-db-1', files: '/other/checkout/compose.yaml' }]);
    expect(c.ours).toHaveLength(1);
    expect(c.ours[0]).toMatchObject({
      service: 'web',
      health: { status: 'unhealthy', failingStreak: 4, lastOutput: 'connection refused' },
      published: [
        { host: '127.0.0.1', port: 8080, target: '80/tcp' },
        { host: '::1', port: 8080, target: '80/tcp' },
      ],
      anonymousVolumes: 1,
    });
  });

  it('summarizes a service’s state', () => {
    expect(verdict([])).toEqual({ verdict: 'missing', text: 'no container' });
    expect(verdict([container()]).verdict).toBe('ok');
    expect(
      verdict([container({ health: { status: 'starting', failingStreak: 0, lastOutput: '' } })])
        .verdict,
    ).toBe('starting');
    expect(
      verdict([
        container({ health: { status: 'unhealthy', failingStreak: 3, lastOutput: 'refused' } }),
      ]).text,
    ).toBe('running, UNHEALTHY (3 failed checks; last: refused)');
    expect(verdict([container({ state: 'exited', exitCode: 0 })]).verdict).toBe('completed');
    expect(verdict([container({ state: 'exited', exitCode: 137 })])).toEqual({
      verdict: 'failed',
      text: 'exited (137)',
    });
    expect(verdict([container(), container({ state: 'restarting', restartCount: 5 })])).toEqual({
      verdict: 'failed',
      text: '2 containers: running; restarting (5 restarts)',
    });
  });

  it('drops repeated progress lines', () => {
    expect(dedupeProgress(' Container a Started \n Container a Started \nerror: x\nerror: x')).toBe(
      ' Container a Started \nerror: x\nerror: x',
    );
  });
});

describe('compose_control arguments', () => {
  it('refuses options that do not apply before touching Docker', async () => {
    const c = ctx(makeProject({ 'compose.yaml': 'services: {}' }));
    await expect(control(c, { action: 'restart', pull: 'always' })).rejects.toThrow(
      /only apply to action "up"/,
    );
    await expect(control(c, { action: 'up', removeVolumes: true })).rejects.toThrow(
      /only applies to action "down"/,
    );
    await expect(
      control(c, { action: 'down', removeVolumes: true, services: ['db'] }),
    ).rejects.toThrow(/whole project/);
    expect(() =>
      composeControl.schema.parse({ action: 'up', services: ['-f'], reason: 'x y z' }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------------- with Docker

const IMAGES = ['nginx:alpine', 'redis:7-alpine'];
const dockerOk =
  !!(await dockerVersion()) &&
  (await Promise.all(IMAGES.map((i) => imagePresent(i)))).every(Boolean);

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

describe.skipIf(!dockerOk)('Docker Compose with Docker', () => {
  it('brings services up and down, checks health and ports, and deletes volumes only when confirmed', async () => {
    const name = `friday-test-${Math.random().toString(36).slice(2, 8)}`;
    const port = await freePort();
    const file = [
      `name: ${name}`,
      'services:',
      '  web:',
      '    image: nginx:alpine',
      `    ports: ["127.0.0.1:${port}:80"]`,
      '    depends_on: [cache]',
      '    environment:',
      '      SECRET_TOKEN: ${TOKEN}',
      '    healthcheck:',
      '      test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://localhost/"]',
      '      interval: 1s',
      '      retries: 30',
      '  cache:',
      '    image: redis:7-alpine',
      '    volumes: ["data:/data"]',
      '  ghost:',
      '    image: friday-test/does-not-exist:1',
      'volumes:',
      '  data: {}',
    ].join('\n');
    const root = makeProject({ 'compose.yaml': file, '.env': 'TOKEN=env-file-secret-value\n' });
    const out: string[] = [];
    const c = ctx(root, out);
    try {
      const before = await status(c);
      expect(before.content).toContain(`Compose project "${name}" (compose.yaml)`);
      expect(before.content).toMatch(
        /web \(nginx:alpine, has a health check, publishes 127\.0\.0\.1:\d+→80\/tcp\): no container/,
      );
      expect(before.content).toMatch(/cache \(redis:7-alpine, no health check\): no container/);
      expect(before.content).not.toContain('env-file-secret-value');

      // up web starts its dependency; nothing is pulled or built.
      const up = await control(c, { action: 'up', services: ['web'], waitSeconds: 60 });
      const d = up.details as Details;
      expect(up.risk).toBe('medium');
      expect(up.confirmationRequired).toBeUndefined();
      expect(d.argv).toEqual([
        'docker',
        'compose',
        '--ansi',
        'never',
        '--progress',
        'plain',
        '-f',
        path.join(root, 'compose.yaml'),
        '--project-directory',
        root,
        '-p',
        name,
        'up',
        '--detach',
        '--pull',
        'never',
        '--no-build',
        '--',
        'web',
      ]);
      expect(d.services.map((s) => [s.name, s.dependency, s.state])).toEqual([
        ['cache', true, 'no container'],
        ['web', false, 'no container'],
      ]);
      expect(JSON.stringify(up)).not.toContain('env-file-secret-value');
      const result = await up.apply(c);
      expect(result.content).toMatch(/docker compose up succeeded \(exit code 0\)/);
      expect(result.content).toMatch(
        /web: running, healthy; ports 127\.0\.0\.1:\d+→80\/tcp \(accepting connections\)/,
      );
      expect(result.content).toMatch(/cache: running/);
      expect(result.summary).toBe('2 services up');
      expect(out.join('')).toMatch(/Container .*-web-1 Started/);

      const now = await status(c);
      expect(now.summary).toBe('2/3 up, 1 not running');
      const logs = await status(c, { view: 'logs', services: ['cache'], tail: 20 });
      expect(logs.content).toMatch(/Ready to accept connections/);

      // A missing image is reported before asking, not pulled.
      await expect(control(c, { action: 'up', services: ['ghost'] })).rejects.toThrow(
        /Not on this machine: ghost \(friday-test\/does-not-exist:1\).*pull: "missing"/,
      );

      // The same project name from another checkout is refused.
      const other = makeProject({ 'compose.yaml': file });
      await expect(control(ctx(other), { action: 'stop' })).rejects.toThrow(
        /also has containers created from another compose file/,
      );
      expect((await status(ctx(other))).content).toMatch(/came from another compose file/);

      const restart = await control(c, { action: 'restart', services: ['cache'] });
      expect(restart.risk).toBe('medium');
      const stop = await control(c, { action: 'stop', services: ['web'] });
      expect((await stop.apply(c)).summary).toBe('stopped');
      expect((await status(c, { services: ['web'] })).content).toMatch(
        /web \(nginx:alpine, has a health check, publishes .*\): exited/,
      );

      // down -v: critical, typed project name, lists the volume.
      const down = await control(c, { action: 'down', removeVolumes: true });
      const dd = down.details as Details;
      expect(down.risk).toBe('critical');
      expect(down.confirmationRequired).toBe(name);
      expect(dd.volumes).toEqual([{ name: `${name}_data`, exists: true }]);
      expect(dd.argv.slice(-2)).toEqual(['down', '--volumes']);
      const gone = await down.apply(c);
      expect(gone.content).toMatch(/No containers left for all services/);
      expect(
        execFileSync('docker', ['volume', 'ls', '-q', '--filter', `name=${name}_data`])
          .toString()
          .trim(),
      ).toBe('');
    } finally {
      execFileSync('docker', ['compose', '-p', name, 'down', '--volumes', '--timeout', '1'], {
        cwd: root,
        stdio: 'ignore',
      });
    }
  }, 180_000);
});
