import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { buildSystemPrompt } from '../src/chat/systemPrompt.js';
import { cleanupProjects, makeProject, testConfig, testServices } from './helpers.js';

const LOCAL = { host: '127.0.0.1:4317' };
const MUTATE = { ...LOCAL, 'x-friday-client': '1', 'content-type': 'application/json' };

let app: FastifyInstance | null = null;
const dataDirs: string[] = [];
afterEach(async () => {
  await app?.close();
  app = null;
  cleanupProjects();
  for (const d of dataDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const g = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();

function setup() {
  const root = makeProject({
    '.gitignore': 'node_modules/\n',
    'src/cart.js': 'export const total = (items) => items.length;\n',
    'vendor/lib.js': 'tracked vendor code\n',
    'node_modules/left-pad/index.js': 'module.exports = 1;\n',
  });
  g(root, 'init', '-q', '-b', 'main');
  g(root, 'config', 'user.email', 'friday@test');
  g(root, 'config', 'user.name', 'Friday Test');
  g(root, 'add', '-A');
  g(root, 'commit', '-q', '-m', 'initial');
  const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'friday-data-')));
  dataDirs.push(dataDir);
  const s = testServices({ config: { ...testConfig(), dataDir } });
  const parent = s.projects.create('shop', root);
  return { s, root, parent, dataDir };
}

describe('task worktrees', () => {
  it('makes a worktree on its own branch, with dependencies linked and kept out of git', async () => {
    const { s, root, parent, dataDir } = setup();
    const wt = await s.worktrees.create(parent);
    const info = wt.worktree!;
    expect(info).toMatchObject({
      parentId: parent.id,
      base: g(root, 'rev-parse', 'HEAD'),
      baseBranch: 'main',
      linked: ['node_modules'],
      status: 'active',
    });
    expect(info.branch).toMatch(/^friday\/task-[0-9a-f]{6}$/);
    expect(wt.rootPath.startsWith(path.join(dataDir, 'worktrees', 'shop-'))).toBe(true);
    expect(g(wt.rootPath, 'branch', '--show-current')).toBe(info.branch);
    expect(fs.readFileSync(path.join(wt.rootPath, 'src/cart.js'), 'utf8')).toContain('total');
    // node_modules is linked (ignored in the parent); the tracked vendor folder is a real copy.
    expect(fs.readlinkSync(path.join(wt.rootPath, 'node_modules'))).toBe(
      path.join(root, 'node_modules'),
    );
    expect(fs.lstatSync(path.join(wt.rootPath, 'vendor')).isSymbolicLink()).toBe(false);
    expect(g(wt.rootPath, 'status', '--porcelain')).toBe('');
    expect(g(root, 'status', '--porcelain')).toBe('');
    expect(wt.sandbox).toEqual(parent.sandbox);
  });

  it('merges the task into your branch, then removes the worktree and its branch', async () => {
    const { s, root, parent } = setup();
    const wt = await s.worktrees.create(parent);
    fs.writeFileSync(
      path.join(wt.rootPath, 'src/cart.js'),
      'export const total = (i) => i.reduce((a, x) => a + x, 0);\n',
    );
    fs.writeFileSync(path.join(wt.rootPath, 'src/new.js'), 'export {};\n');
    // An untracked file of the user's in their checkout does not block the merge.
    fs.writeFileSync(path.join(root, 'notes.txt'), 'mine\n');

    const done = await s.worktrees.accept(wt, 'merge', 'Fix the cart total');
    expect(done).toMatchObject({ status: 'accepted', outcome: { mode: 'merge', branch: 'main' } });
    expect(g(root, 'log', '-1', '--format=%s')).toBe(
      `Merge ${wt.worktree!.branch}: Fix the cart total`,
    );
    expect(g(root, 'log', '-1', '--format=%s', 'HEAD^2')).toBe('Fix the cart total');
    expect(fs.readFileSync(path.join(root, 'src/cart.js'), 'utf8')).toContain('reduce');
    expect(fs.existsSync(path.join(root, 'src/new.js'))).toBe(true);
    expect(fs.readFileSync(path.join(root, 'notes.txt'), 'utf8')).toBe('mine\n');
    expect(fs.existsSync(wt.rootPath)).toBe(false);
    expect(g(root, 'branch', '--list', wt.worktree!.branch)).toBe('');
    // Removing the link never touched the real dependency folder.
    expect(fs.existsSync(path.join(root, 'node_modules/left-pad/index.js'))).toBe(true);
    expect(s.projects.get(wt.id)!.worktree!.status).toBe('accepted');
    await expect(s.worktrees.discard(s.projects.get(wt.id)!)).rejects.toThrow(/already accepted/);
  });

  it('never touches your uncommitted changes: merging into a dirty checkout is refused', async () => {
    const { s, root, parent } = setup();
    const wt = await s.worktrees.create(parent);
    fs.writeFileSync(path.join(wt.rootPath, 'src/cart.js'), 'task change\n');
    fs.writeFileSync(path.join(root, 'src/cart.js'), 'my unfinished work\n');
    await expect(s.worktrees.accept(wt, 'merge', 'x')).rejects.toThrow(
      /uncommitted changes \(src\/cart.js\)/,
    );
    await expect(s.worktrees.accept(wt, 'squash', 'x')).rejects.toThrow(/Commit or stash/);
    expect(fs.readFileSync(path.join(root, 'src/cart.js'), 'utf8')).toBe('my unfinished work\n');
    expect(fs.existsSync(wt.rootPath)).toBe(true);
    expect(s.projects.get(wt.id)!.worktree!.status).toBe('active');
  });

  it('undoes a conflicting merge completely and keeps the worktree', async () => {
    const { s, root, parent } = setup();
    const wt = await s.worktrees.create(parent);
    fs.writeFileSync(path.join(wt.rootPath, 'src/cart.js'), 'theirs\n');
    fs.writeFileSync(path.join(root, 'src/cart.js'), 'mine\n');
    g(root, 'commit', '-q', '-am', 'my change');
    const head = g(root, 'rev-parse', 'HEAD');
    for (const mode of ['merge', 'squash'] as const) {
      await expect(s.worktrees.accept(s.projects.get(wt.id)!, mode, 'x')).rejects.toThrow(
        /conflict with main in src\/cart.js\. Nothing was changed/,
      );
      expect(g(root, 'rev-parse', 'HEAD')).toBe(head);
      expect(g(root, 'status', '--porcelain')).toBe('');
    }
    expect(fs.existsSync(wt.rootPath)).toBe(true);
  });

  it('squashes into one commit, or keeps the branch', async () => {
    const { s, root, parent } = setup();
    const a = await s.worktrees.create(parent);
    fs.writeFileSync(path.join(a.rootPath, 'a.txt'), 'a\n');
    g(a.rootPath, 'add', '-A');
    g(a.rootPath, 'commit', '-q', '-m', 'step one');
    fs.writeFileSync(path.join(a.rootPath, 'b.txt'), 'b\n');
    await s.worktrees.accept(a, 'squash', 'Add a and b');
    expect(g(root, 'log', '--format=%s', '-2')).toBe('Add a and b\ninitial');
    expect(g(root, 'branch', '--list', a.worktree!.branch)).toBe('');

    const b = await s.worktrees.create(parent);
    fs.writeFileSync(path.join(b.rootPath, 'c.txt'), 'c\n');
    const kept = await s.worktrees.accept(b, 'branch', 'Add c');
    expect(kept.outcome).toMatchObject({ mode: 'branch', branch: b.worktree!.branch });
    expect(g(root, 'log', '-1', '--format=%s', b.worktree!.branch)).toBe('Add c');
    expect(fs.existsSync(b.rootPath)).toBe(false);
    expect(fs.existsSync(path.join(root, 'c.txt'))).toBe(false);
  });

  it('discards only the worktree and its branch', async () => {
    const { s, root, parent } = setup();
    const wt = await s.worktrees.create(parent);
    fs.writeFileSync(path.join(wt.rootPath, 'src/cart.js'), 'task change\n');
    fs.writeFileSync(path.join(root, 'src/cart.js'), 'my unfinished work\n');
    await s.worktrees.discard(wt);
    expect(fs.existsSync(wt.rootPath)).toBe(false);
    expect(g(root, 'branch', '--list', wt.worktree!.branch)).toBe('');
    expect(fs.readFileSync(path.join(root, 'src/cart.js'), 'utf8')).toBe('my unfinished work\n');
    expect(s.projects.get(wt.id)!.worktree).toMatchObject({
      status: 'discarded',
      outcome: { mode: 'discard' },
    });
  });

  it('refuses to commit credential files on accept', async () => {
    const { s, parent } = setup();
    const wt = await s.worktrees.create(parent);
    fs.writeFileSync(path.join(wt.rootPath, '.env'), 'SECRET=1\n');
    await expect(s.worktrees.accept(wt, 'branch', 'x')).rejects.toThrow(/credential files .*\.env/);
  });

  it('tells the model where it is working', async () => {
    const { s, parent } = setup();
    const wt = await s.worktrees.create(parent);
    const prompt = buildSystemPrompt({ project: wt, detection: null, toolsEnabled: true });
    expect(prompt).toContain(
      `## Task worktree\nYou are working in a separate git worktree made for this task, on branch ${wt.worktree!.branch} (started from main at`,
    );
    expect(prompt).toContain("linked from the user's checkout: node_modules");
  });
});

describe('worktree routes', () => {
  it('starts a conversation in a worktree, reports its state, and accepts it', async () => {
    const { s, root, parent } = setup();
    app = await buildApp(s);
    const created = await app.inject({
      method: 'POST',
      url: `/api/projects/${parent.id}/worktrees`,
      headers: MUTATE,
      payload: { title: 'Fix the cart' },
    });
    expect(created.statusCode).toBe(201);
    const { project, sessionId } = created.json();
    expect(project.worktree.parentId).toBe(parent.id);
    expect(project.available).toBe(true);
    expect(s.sessions.get(sessionId)!.projectId).toBe(project.id);

    // The parent's conversation list includes it; "no project" does not.
    const list = (q: string) =>
      app!
        .inject({ method: 'GET', url: `/api/sessions?project=${q}`, headers: LOCAL })
        .then((r) => r.json().sessions);
    expect((await list(parent.id)).map((x: { id: string }) => x.id)).toContain(sessionId);
    expect((await list('none')).map((x: { id: string }) => x.id)).not.toContain(sessionId);

    // A parent with a worktree in progress can't be removed.
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${parent.id}`,
      headers: { ...LOCAL, 'x-friday-client': '1' },
    });
    expect(del.statusCode).toBe(409);

    fs.writeFileSync(path.join(project.rootPath, 'src/cart.js'), 'changed\n');
    const status = (
      await app.inject({
        method: 'GET',
        url: `/api/projects/${project.id}/worktree`,
        headers: LOCAL,
      })
    ).json();
    expect(status).toMatchObject({
      commits: [],
      uncommitted: [{ path: 'src/cart.js', status: 'modified' }],
      target: { branch: 'main', dirty: [] },
      idle: true,
    });

    const accepted = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/worktree/accept`,
      headers: MUTATE,
      payload: { mode: 'merge', message: 'Fix the cart' },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().project).toMatchObject({
      available: false,
      worktree: { status: 'accepted' },
    });
    expect(fs.readFileSync(path.join(root, 'src/cart.js'), 'utf8')).toBe('changed\n');
    expect(s.audit.list(5).map((e) => e.action)).toEqual(
      expect.arrayContaining(['worktree_created', 'worktree_accepted']),
    );

    const again = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/worktree/discard`,
      headers: { ...LOCAL, 'x-friday-client': '1' },
    });
    expect(again.statusCode).toBe(400);
  });
});
