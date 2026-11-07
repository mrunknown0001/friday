import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import type { ApprovalDto, ProjectDto, SshHostDto } from '@friday/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { runProcess } from '../src/commands/runner.js';
import { execSsh } from '../src/ssh/ssh.js';
import { call, cleanupProjects, makeProject, ScriptedProvider, testServices } from './helpers.js';

afterEach(cleanupProjects);
const H = { host: '127.0.0.1:4317', 'x-friday-client': '1', 'content-type': 'application/json' };

type Steps = ConstructorParameters<typeof ScriptedProvider>[0];

/**
 * A project in a folder on an "SSH host" whose ssh is replaced by the local sh: routes, tools,
 * approvals and undo all run for real, the scripts included; only the network hop is skipped.
 */
function setup(
  steps: (root: string) => Steps = () => [],
  environment: SshHostDto['environment'] = 'staging',
) {
  const root = makeProject({
    'README.md': '# shop\n',
    'src/app.ts': 'export const total = (a: number, b: number) => a + b;\n',
    '.env': 'DB_PASSWORD=hunter2\n',
  });
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], { cwd: root });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(`${root}/.gitignore`, '.env\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');

  const provider = new ScriptedProvider(steps(root));
  const s = testServices({ provider });
  const host = s.sshHosts.create({
    name: 'web-1',
    hostname: '203.0.113.10',
    port: 22,
    username: 'deploy',
    identityFile: null,
    environment,
  });
  s.sshHosts.setTrusted(host.id, [{ fingerprint: 'ED25519 SHA256:test', line: 'x' }]);
  const commands: string[] = [];
  s.ssh.exec = async (_h, command, opts) => {
    commands.push(command);
    return execSsh(['sh', '-c', command], root, opts);
  };
  s.ssh.run = async (_h, command, opts) => {
    commands.push(command);
    return runProcess({ argv: ['sh', '-c', command], shellCommand: null, cwd: root, ...opts });
  };
  const project = s.projects.create('shop', root, host.id);
  const session = s.sessions.create(undefined, project.id);
  return { s, root, host, project, session, provider, commands };
}

const toolMessages = (s: ReturnType<typeof setup>['s'], sessionId: string) =>
  s.messages
    .listBySession(sessionId)
    .filter((m) => m.role === 'tool')
    .map((m) => m.content);

/** Approvals of a run as they are requested. */
function approvalsOf(s: ReturnType<typeof setup>['s'], runId: string) {
  const seen: ApprovalDto[] = [];
  const waiters: Array<() => void> = [];
  s.runManager.subscribe(runId, 0, (e) => {
    if (e.type === 'approval_requested') seen.push(e.approval);
    waiters.splice(0).forEach((w) => w());
  });
  return (n: number) =>
    new Promise<ApprovalDto>((resolve) => {
      const check = () => (seen.length >= n ? resolve(seen[n - 1]!) : waiters.push(check));
      check();
    });
}

describe('projects on SSH hosts', () => {
  it('reads, lists, searches and inspects git on the server, and offers only tools that work there', async () => {
    const { s, session, provider } = setup(() => [
      {
        toolCalls: [
          call('read_file', { path: 'src/app.ts' }, 'r'),
          call('list_directory', { path: '.' }, 'l'),
          call('search_code', { query: 'total' }, 's'),
          call('find_files', { pattern: '*.ts' }, 'f'),
          call('read_file', { path: '.env' }, 'e'),
          call('git_status', {}, 'g'),
          call('code_map', {}, 'c'),
          call('inspect_project', {}, 'i'),
        ],
      },
      { chunks: ['done'] },
    ]);
    const { run } = s.runManager.startMessage(session.id, 'look around');
    await s.runManager.waitFor(run.id);

    const [read, list, search, find, secret, status, codeMap, inspect] = toolMessages(
      s,
      session.id,
    );
    expect(read).toContain('src/app.ts (lines 1-1 of 1)');
    expect(list).toContain('src/');
    expect(list).toContain('README.md');
    expect(search).toContain('src/app.ts\n  1: export const total');
    expect(find).toContain('src/app.ts');
    expect(secret).toMatch(/credentials file/);
    expect(status).toContain('Branch: main');
    expect(codeMap).toMatch(/works only on this computer; this project is on an SSH host/);
    expect(inspect).toContain('on web-1');

    const offered = provider.requests[0]!.tools!.map((t) => t.name);
    expect(offered).toEqual(expect.arrayContaining(['read_file', 'edit_file', 'git_status']));
    for (const local of [
      'code_map',
      'run_tests',
      'start_process',
      'view_image',
      'request_task_permissions',
    ])
      expect(offered).not.toContain(local);
    expect(JSON.stringify(provider.requests[0]!.messages)).toContain(
      'Server: web-1 (deploy@203.0.113.10, staging)',
    );
  });

  it('edits, runs commands and commits on the server with approval, and undoes edits', async () => {
    const { s, root, session } = setup(() => [
      {
        toolCalls: [
          call(
            'edit_file',
            {
              path: 'src/app.ts',
              edits: [{ old_text: 'a + b', new_text: 'a + b + 0' }],
              reason: 'demo',
            },
            'e',
          ),
        ],
      },
      {
        toolCalls: [call('run_command', { argv: ['cat', 'src/app.ts'], reason: 'check it' }, 'c')],
      },
      {
        toolCalls: [
          call('git_commit', { message: 'Add zero', paths: ['src/app.ts'], reason: 'save' }, 'g'),
        ],
      },
      { chunks: ['done'] },
    ]);
    const { run } = s.runManager.startMessage(session.id, 'change it');
    const next = approvalsOf(s, run.id);
    const approve = (a: ApprovalDto) =>
      s.approvals.decide(a.id, {
        decision: 'approve',
        actionHash: a.actionHash,
        sessionId: session.id,
      });

    const edit = await next(1);
    expect(edit.details).toMatchObject({
      kind: 'file_change',
      remote: { name: 'web-1', environment: 'staging' },
    });
    expect(edit.confirmationRequired ?? null).toBeNull();
    approve(edit);
    const command = await next(2);
    expect(command.details).toMatchObject({
      kind: 'command',
      host: 'remote',
      cwd: '.',
      remote: { name: 'web-1' },
    });
    expect(command.title).toBe('Run on web-1: cat src/app.ts');
    approve(command);
    const commit = await next(3);
    expect(commit.details).toMatchObject({ kind: 'git', operation: 'commit', branch: 'main' });
    approve(commit);
    await s.runManager.waitFor(run.id);

    const [edited, ran, committed] = toolMessages(s, session.id);
    expect(edited).toMatch(/Edited src\/app.ts/);
    expect(ran).toContain('host: web-1 (deploy@203.0.113.10), cwd: .');
    expect(ran).toContain('exit code 0');
    expect(ran).toContain('a + b + 0');
    expect(committed).toMatch(/Committed \w+ on main: Add zero/);
    expect(execFileSync('git', ['log', '--format=%s', '-1'], { cwd: root }).toString().trim()).toBe(
      'Add zero',
    );

    // Undo the edit through the same route the UI uses.
    const app = await buildApp(s);
    const change = s.fileChanges.listBySession(session.id)[0]!;
    const res = await app.inject({
      method: 'POST',
      url: `/api/file-changes/${change.id}/revert`,
      headers: H,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(fs.readFileSync(`${root}/src/app.ts`, 'utf8')).toBe(
      'export const total = (a: number, b: number) => a + b;\n',
    );
  });

  it('needs the host name typed to approve anything on a production server', async () => {
    const { s, session, root } = setup(
      () => [
        {
          toolCalls: [
            call('write_file', { path: 'NOTES.md', content: 'hi\n', reason: 'note' }, 'w'),
          ],
        },
        { chunks: ['done'] },
      ],
      'production',
    );
    const { run } = s.runManager.startMessage(session.id, 'write a note');
    const write = await approvalsOf(s, run.id)(1);
    expect(write.confirmationRequired).toBe('web-1');
    expect(() =>
      s.approvals.decide(write.id, {
        decision: 'approve',
        actionHash: write.actionHash,
        sessionId: session.id,
        allowSimilar: true,
      }),
    ).toThrow(/Type "web-1"/);
    s.approvals.decide(write.id, {
      decision: 'approve',
      actionHash: write.actionHash,
      sessionId: session.id,
      confirmation: 'web-1',
    });
    await s.runManager.waitFor(run.id);
    expect(fs.readFileSync(`${root}/NOTES.md`, 'utf8')).toBe('hi\n');
  });

  it('serves the file panel from the server and refuses local-only settings', async () => {
    const { s, host, project } = setup();
    const app = await buildApp(s);
    const get = (url: string) => app.inject({ method: 'GET', url, headers: H });

    const listed = (await get('/api/projects')).json() as { projects: ProjectDto[] };
    expect(listed.projects[0]).toMatchObject({
      id: project.id,
      available: true,
      remote: { hostId: host.id, name: 'web-1', username: 'deploy', environment: 'staging' },
    });
    expect(listed.projects[0]).not.toHaveProperty('sshHostId');

    const tree = (await get(`/api/projects/${project.id}/tree`)).json() as {
      entries: Array<{ path: string }>;
    };
    // .env is in the repository's .gitignore.
    expect(tree.entries.map((e) => e.path)).toEqual(['src', '.gitignore', 'README.md']);
    const file = (await get(`/api/projects/${project.id}/file?path=src/app.ts`)).json() as {
      content: string;
    };
    expect(file.content).toContain('export const total');
    expect((await get(`/api/projects/${project.id}/file?path=.env`)).statusCode).toBe(403);
    const found = (await get(`/api/projects/${project.id}/search?q=total`)).json() as {
      matches: Array<{ path: string }>;
    };
    expect(found.matches.map((m) => m.path)).toEqual(['src/app.ts']);

    for (const url of ['sandbox', 'overview']) {
      const r = await get(`/api/projects/${project.id}/${url}`);
      expect(r.statusCode).toBe(409);
      expect(r.json()).toMatchObject({ error: { code: 'remote_project' } });
    }
    const worktree = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/worktrees`,
      headers: H,
      payload: {},
    });
    expect(worktree.statusCode).toBe(409);

    // The host can't be removed while a project uses it; untrusting it makes the project unavailable.
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/ssh-hosts/${host.id}`,
      headers: { host: H.host, 'x-friday-client': '1' },
    });
    expect(del.statusCode).toBe(409);
    expect(del.json()).toMatchObject({ error: { code: 'host_in_use' } });
    await app.inject({
      method: 'POST',
      url: `/api/ssh-hosts/${host.id}/untrust`,
      headers: H,
      payload: {},
    });
    const after = (await get('/api/projects')).json() as { projects: ProjectDto[] };
    expect(after.projects[0]!.available).toBe(false);
    expect((await get(`/api/projects/${project.id}/tree`)).statusCode).toBe(409);
  });

  it('adds a folder on a host after the breadth rules, and lists folders to choose from', async () => {
    const { s, host, root } = setup();
    const app = await buildApp(s);
    const folders = await app.inject({
      method: 'GET',
      url: `/api/ssh-hosts/${host.id}/folders?path=${encodeURIComponent(root)}`,
      headers: H,
    });
    expect(folders.json()).toMatchObject({ path: root, folders: ['src'] });
    // Test folders live in /tmp, which is never a project folder on a server.
    const add = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: H,
      payload: { path: `${root}/src`, hostId: host.id },
    });
    expect(add.statusCode).toBe(403);
    expect(add.json().error.message).toMatch(/too broad/);
    // The same path on two hosts is two projects.
    const other = s.sshHosts.create({
      name: 'web-2',
      hostname: '203.0.113.11',
      port: 22,
      username: 'deploy',
      identityFile: null,
      environment: 'staging',
    });
    const a = s.projects.create('a', '/var/www/shop', host.id);
    const b = s.projects.create('b', '/var/www/shop', other.id);
    expect(a.rootPath).toBe('/var/www/shop');
    expect(s.projects.getByRoot('/var/www/shop', other.id)?.id).toBe(b.id);
    expect(s.projects.getByRoot('/var/www/shop')).toBeNull();
  });
});
