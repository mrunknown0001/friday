import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupSandboxes,
  dockerRunArgs,
  dockerVersion,
  findCredentials,
  hostPaths,
  IMAGE_PATTERN,
  imagePresent,
  runInSandbox,
  sandboxName,
  suggestImage,
  type SandboxRun,
} from '../src/sandbox/docker.js';
import { detectToolEnvironment } from '../src/workspace/environment.js';
import { call, cleanupProjects, makeProject, ScriptedProvider, testServices } from './helpers.js';

afterEach(cleanupProjects);

const base = (over: Partial<SandboxRun> = {}): SandboxRun => ({
  root: '/home/u/shop',
  cwdRel: '.',
  settings: { enabled: true, image: 'node:22-bookworm-slim', network: 'none' },
  argv: ['npm', 'test'],
  shellCommand: null,
  masks: { files: [], dirs: [], truncated: false },
  gitDir: false,
  instance: 'test',
  name: 'friday-sbx-test',
  uid: 1000,
  gid: 1000,
  ...over,
});

describe('sandbox arguments', () => {
  it('isolates the container: no network, no capabilities, read-only root, fixed env', () => {
    const args = dockerRunArgs(base());
    const joined = args.join(' ');
    for (const part of [
      '--rm',
      '--network none',
      '--cap-drop ALL',
      '--security-opt no-new-privileges',
      '--read-only',
      '--user 1000:1000',
      'type=bind,src=/home/u/shop,dst=/workspace',
      '--workdir /workspace',
      '--label dev.friday.sandbox=test',
    ]) {
      expect(joined).toContain(part);
    }
    // Image and command come last, after "--", exactly as given.
    expect(args.slice(-4)).toEqual(['--', 'node:22-bookworm-slim', 'npm', 'test']);
    expect(joined).not.toMatch(/docker\.sock|--privileged|NTL_|--env-file/);
    expect(args.filter((a) => a.startsWith('HOME=') || a.startsWith('PATH='))).toEqual([
      'HOME=/tmp',
    ]);
  });

  it('hides credentials, protects .git, and runs shell scripts only via /bin/sh -c', () => {
    const args = dockerRunArgs(
      base({
        cwdRel: 'packages/api',
        gitDir: true,
        masks: { files: ['.env', 'config/.env.local'], dirs: ['.aws'], truncated: false },
        argv: null,
        shellCommand: 'npm test | tee out.txt',
      }),
    );
    const joined = args.join(' ');
    expect(joined).toContain('type=bind,src=/home/u/shop/.git,dst=/workspace/.git,readonly');
    expect(joined).toContain('type=bind,src=/dev/null,dst=/workspace/.env,readonly');
    expect(joined).toContain('type=bind,src=/dev/null,dst=/workspace/config/.env.local,readonly');
    expect(joined).toContain('type=tmpfs,dst=/workspace/.aws');
    expect(joined).toContain('--workdir /workspace/packages/api');
    expect(args.slice(-3)).toEqual(['/bin/sh', '-c', 'npm test | tee out.txt']);
  });

  it('refuses paths that would break the mount syntax and validates image names', () => {
    expect(() => dockerRunArgs(base({ root: '/home/u/a,b' }))).toThrow(/cannot mount/);
    expect(IMAGE_PATTERN.test('node:22-bookworm-slim')).toBe(true);
    expect(IMAGE_PATTERN.test('ghcr.io/org/app:1.2.3')).toBe(true);
    for (const bad of ['--privileged', 'Node:22', 'node:22 --rm', 'a;b']) {
      expect(IMAGE_PATTERN.test(bad), bad).toBe(false);
    }
    expect(suggestImage(['Node.js', 'React'])).toBe('node:22-bookworm-slim');
    expect(suggestImage(['PHP', 'Laravel'])).toBe('php:8.4-cli');
    expect(hostPaths('at /workspace/src/a.js:3:1', '/home/u/shop')).toBe(
      'at /home/u/shop/src/a.js:3:1',
    );
  });

  it('finds credential files git ignores, and credential folders, without following symlinks', async () => {
    const root = makeProject({
      '.env': 'KEY=1',
      '.env.example': 'KEY=',
      'api/.env.production': 'KEY=2',
      'deploy/id_rsa': 'x',
      '.aws/credentials': 'x',
      'node_modules/pkg/.env': 'ignored: not scanned',
      'src/app.js': 'ok',
    });
    fs.writeFileSync(path.join(root, '.gitignore'), '.env\n');
    fs.symlinkSync('/etc/hostname', path.join(root, 'link.env'));
    const masks = await findCredentials(root);
    expect(masks.files.sort()).toEqual(['.env', 'api/.env.production', 'deploy/id_rsa']);
    expect(masks.dirs).toEqual(['.aws']);
  });
});

// Real containers, only where Docker and a small local image are available. Uses its own label,
// so cleanup can never touch other containers on the machine.
const IMAGE = 'node:22-alpine';
const dockerOk = !!(await dockerVersion()) && (await imagePresent(IMAGE));

describe.skipIf(!dockerOk)('sandbox with Docker', () => {
  const instance = `test-${process.pid}`;
  afterEach(async () => {
    await cleanupSandboxes(instance);
  });

  async function run(root: string, script: string, network: 'none' | 'bridge' = 'none') {
    return runInSandbox(
      {
        root,
        cwdRel: '.',
        settings: { enabled: true, image: IMAGE, network },
        argv: null,
        shellCommand: script,
        masks: await findCredentials(root),
        gitDir: fs.existsSync(path.join(root, '.git')),
        instance,
        name: sandboxName(),
        uid: process.getuid!(),
        gid: process.getgid!(),
      },
      { timeoutMs: 60_000, signal: new AbortController().signal },
    );
  }

  it('sees and writes the project, but not credentials, .git, the host env or the network', async () => {
    const root = makeProject({
      '.env': 'SECRET=topsecretvalue',
      'src/a.js': 'console.log(1)',
      '.git/config': '[core]\n',
      '.git/hooks/.keep': '',
    });
    process.env.FRIDAY_SANDBOX_TEST_SECRET = 'should-not-leak';
    const r = await run(
      root,
      [
        'cat src/a.js',
        'echo "env:[$(cat .env)]"',
        'echo built > out.txt',
        'touch .git/hooks/pre-commit 2>/dev/null && echo HOOK-WRITTEN || echo hook-refused',
        'env | grep -c FRIDAY_SANDBOX_TEST_SECRET || true',
        'id -u',
        'wget -q -T 3 -O- http://example.com >/dev/null 2>&1 && echo NET-OK || echo net-blocked',
        'touch /etc/x 2>/dev/null && echo ROOTFS-WRITABLE || echo rootfs-readonly',
      ].join('; '),
    );
    delete process.env.FRIDAY_SANDBOX_TEST_SECRET;
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain('console.log(1)');
    expect(r.output).toContain('env:[]');
    expect(r.output).not.toContain('topsecretvalue');
    expect(r.output).toContain('hook-refused');
    expect(r.output).toContain('net-blocked');
    expect(r.output).toContain('rootfs-readonly');
    expect(r.output).toContain(`\n${process.getuid!()}\n`);
    expect(r.output).toMatch(/^0$/m); // the host variable is not in the container
    // Files the command writes land in the project, owned by the user.
    expect(fs.readFileSync(path.join(root, 'out.txt'), 'utf8')).toBe('built\n');
    expect(fs.statSync(path.join(root, 'out.txt')).uid).toBe(process.getuid!());
    expect(fs.existsSync(path.join(root, '.git/hooks/pre-commit'))).toBe(false);
    expect(fs.readFileSync(path.join(root, '.env'), 'utf8')).toBe('SECRET=topsecretvalue');
  }, 90_000);

  it('removes the container when a command times out', async () => {
    const root = makeProject({ 'a.txt': 'x' });
    const name = sandboxName();
    const r = await runInSandbox(
      {
        root,
        cwdRel: '.',
        settings: { enabled: true, image: IMAGE, network: 'none' },
        argv: ['sleep', '60'],
        shellCommand: null,
        masks: { files: [], dirs: [], truncated: false },
        gitDir: false,
        instance,
        name,
        uid: process.getuid!(),
        gid: process.getgid!(),
      },
      { timeoutMs: 2_000, signal: new AbortController().signal },
    );
    expect(r.timedOut).toBe(true);
    expect(await cleanupSandboxes(instance)).toBe(0);
  }, 60_000);
});

describe('run_command in a sandboxed project', () => {
  async function setup(
    script: ConstructorParameters<typeof ScriptedProvider>[0],
    sandbox: { image: string; docker: boolean },
  ) {
    const root = makeProject({ '.env': 'SECRET=topsecretvalue', 'src/a.js': 'x' });
    const env = { ...(await detectToolEnvironment(`test-${process.pid}`)) };
    if (!sandbox.docker) env.docker = null;
    const s = testServices({ provider: new ScriptedProvider(script), toolEnv: env });
    const project = s.projects.create('shop', root);
    s.projects.setSandbox(project.id, { enabled: true, image: sandbox.image, network: 'none' });
    const session = s.sessions.create(undefined, project.id);
    return { s, root, session };
  }

  it('refuses clearly, without running on the host, when Docker or the image is missing', async () => {
    for (const [sandbox, message] of [
      [{ image: IMAGE, docker: false }, /Docker is not reachable/],
      [{ image: 'friday-test/does-not-exist:1', docker: true }, /not available locally/],
    ] as const) {
      const { s, root, session } = await setup(
        [
          {
            toolCalls: [
              call('run_command', { argv: ['touch', 'ran'], reason: 'create a marker' }, 'c'),
            ],
          },
          { chunks: ['ok'] },
        ],
        sandbox,
      );
      const { run } = s.runManager.startMessage(session.id, 'go');
      await s.runManager.waitFor(run.id);
      const tool = s.messages.listBySession(session.id).find((m) => m.role === 'tool')!;
      expect(tool.content).toMatch(message);
      expect(s.approvalRepo.listByRun(run.id)).toEqual([]);
      expect(fs.existsSync(path.join(root, 'ran'))).toBe(false);
    }
  });

  it.skipIf(!dockerOk)(
    'runs the approved command in the container and says so on the card',
    async () => {
      const { s, session } = await setup(
        [
          {
            toolCalls: [
              call(
                'run_command',
                { shell_command: 'echo "env:[$(cat .env)]"; pwd', reason: 'check' },
                'c',
              ),
            ],
          },
          { chunks: ['ok'] },
        ],
        { image: IMAGE, docker: true },
      );
      const { run } = s.runManager.startMessage(session.id, 'go');
      s.runManager.subscribe(run.id, 0, (e) => {
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
      });
      await s.runManager.waitFor(run.id);
      const approval = s.approvalRepo.listByRun(run.id)[0]!;
      expect(approval.details).toMatchObject({
        kind: 'command',
        sandbox: { image: IMAGE, network: 'none', hiddenCredentials: 1, gitReadOnly: false },
      });
      expect(approval.summary).toMatch(/network-less container/);
      expect(approval.status).toBe('executed');
      const tool = s.messages.listBySession(session.id).find((m) => m.role === 'tool')!;
      expect(tool.content).toContain(`sandbox: ${IMAGE}, network none`);
      expect(tool.content).toContain('env:[]');
      expect(tool.content).not.toContain('topsecretvalue');
      await cleanupSandboxes(`test-${process.pid}`);
    },
    90_000,
  );
});
