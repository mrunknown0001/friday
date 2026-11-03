import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ApprovalDto, ProjectDto, TreeEntryDto } from '@friday/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { revertFileChange } from '../src/approvals/revert.js';
import { covers, similarScope } from '../src/approvals/taskPermission.js';
import { detectToolEnvironment } from '../src/workspace/environment.js';
import {
  resolveExternalFolder,
  resolveRead,
  resolveWrite,
  WorkspaceError,
  workspaceOf,
} from '../src/workspace/paths.js';
import { call, cleanupProjects, makeProject, ScriptedProvider, testServices } from './helpers.js';

afterEach(cleanupProjects);
const env = await detectToolEnvironment();
const H = { host: '127.0.0.1:4317', 'x-friday-client': '1' };

const failure = async (p: Promise<unknown>) => {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(WorkspaceError);
  return err as WorkspaceError;
};

describe('external folder paths', () => {
  it('resolves absolute paths in an external folder with the project rules', async () => {
    const root = makeProject({ 'a.ts': 'project' });
    const lib = makeProject({ 'src/util.ts': 'lib', '.env': 'KEY=1', 'docs/readme.md': 'x' });
    const outside = makeProject({ 'secret.txt': 'no' });
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(lib, 'link-out.txt'));
    const ws = { root, external: [lib] };

    await expect(resolveRead(ws, 'a.ts')).resolves.toMatchObject({ rel: 'a.ts', external: false });
    await expect(resolveRead(ws, path.join(lib, 'src/util.ts'))).resolves.toEqual({
      abs: path.join(lib, 'src/util.ts'),
      rel: path.join(lib, 'src/util.ts'),
      root: lib,
      external: true,
    });
    await expect(resolveRead(ws, lib)).resolves.toMatchObject({ rel: lib, root: lib });

    expect((await failure(resolveRead(ws, path.join(lib, '.env')))).code).toBe('secret_file');
    expect((await failure(resolveRead(ws, path.join(lib, 'link-out.txt')))).message).toMatch(
      `outside the external folder ${lib}`,
    );
    const escape = await failure(resolveRead(ws, `${lib}/../${path.basename(outside)}/secret.txt`));
    expect(escape.code).toBe('outside_root');
    expect(escape.message).toMatch(/outside the project root and its external folders/);
    expect((await failure(resolveRead(ws, path.join(lib, 'missing.ts')))).message).toBe(
      `Path "${path.join(lib, 'missing.ts')}" does not exist.`,
    );
    // Without the folder in the list, the same path is just outside the project.
    expect(
      (await failure(resolveRead({ root, external: [] }, path.join(lib, 'src/util.ts')))).message,
    ).toMatch(/outside the project root\.$/);
  });

  it('resolves writes there, never to credential files or the folder itself', async () => {
    const root = makeProject({ 'a.ts': 'x' });
    const lib = makeProject({ 'src/util.ts': 'lib' });
    const ws = { root, external: [lib] };
    await expect(resolveWrite(ws, path.join(lib, 'src/new.ts'))).resolves.toMatchObject({
      rel: path.join(lib, 'src/new.ts'),
      root: lib,
      exists: false,
    });
    expect((await failure(resolveWrite(ws, path.join(lib, '.npmrc')))).code).toBe('secret_file');
    expect((await failure(resolveWrite(ws, path.join(lib, '.git/config')))).code).toBe(
      'forbidden_path',
    );
    expect((await failure(resolveWrite(ws, lib))).code).toBe('outside_root');
  });

  it('accepts only specific folders that do not overlap the project or each other', async () => {
    const root = makeProject({ 'sub/a.ts': 'x' });
    const lib = makeProject({ 'src/util.ts': 'lib' });
    await expect(resolveExternalFolder(lib, root, [])).resolves.toBe(lib);
    for (const [input, others, pattern] of [
      [os.homedir(), [], /too broad/],
      ['/etc', [], /too broad/],
      ['relative/path', [], /absolute folder path/],
      [path.join(lib, 'nope'), [], /does not exist/],
      [path.join(root, 'sub'), [], /overlaps the project folder/],
      [path.dirname(root), [], /overlaps the project folder|too broad/],
      [path.join(lib, 'src'), [lib], /overlaps the external folder/],
      [lib, [lib], /already an external folder/],
    ] as const) {
      expect((await failure(resolveExternalFolder(input, root, others))).message).toMatch(pattern);
    }
  });

  it('is never covered by a task permission', () => {
    const change = (p: string) => ({
      risk: 'medium' as const,
      details: {
        kind: 'file_change' as const,
        changes: [{ path: p, change: 'modify' as const, diff: '', added: 1, removed: 1 }],
      },
    });
    expect(similarScope('edit_file', change('src/a.ts'))).not.toBeNull();
    expect(similarScope('edit_file', change('/srv/lib/a.ts'))).toBeNull();
    const permission = {
      approvalId: 'a',
      runId: 'r',
      files: ['/srv/lib/', '/srv/lib/a.ts'],
      commands: [],
      sites: [],
      used: 0,
      maxActions: 10,
      expiresAt: Date.now() + 60_000,
      revoked: false,
      plan: [],
      reason: 'x',
      createdAt: Date.now(),
    } as unknown as Parameters<typeof covers>[0];
    expect(covers(permission, 'edit_file', change('/srv/lib/a.ts'))).toBe(false);
  });
});

type Steps = ConstructorParameters<typeof ScriptedProvider>[0];

/** A project with one external folder, and a scripted model that gets the folder's path. */
function setup(steps: (lib: string) => Steps) {
  const lib = makeProject({
    'src/math.ts': 'export function add(a, b) {\n  return a + b;\n}\n',
    'README.md': '# lib\n',
    '.env': 'TOKEN=abc',
  });
  const s = testServices({ provider: new ScriptedProvider(steps(lib)), toolEnv: env });
  const root = makeProject({ 'src/app.ts': 'import { add } from "lib";\n' });
  const created = s.projects.create('app', root);
  s.projects.setExternalFolders(created.id, [lib]);
  const session = s.sessions.create(undefined, created.id);
  return { s, root, lib, project: s.projects.get(created.id)!, session };
}

const toolMessages = (s: ReturnType<typeof setup>['s'], sessionId: string) =>
  s.messages
    .listBySession(sessionId)
    .filter((m) => m.role === 'tool')
    .map((m) => m.content);

describe('agent tools in external folders', () => {
  it('reads, lists and searches them by absolute path', async () => {
    const { s, session, lib } = setup((lib) => [
      {
        toolCalls: [
          call('read_file', { path: path.join(lib, 'src/math.ts') }, 'r'),
          call('list_directory', { path: lib }, 'l'),
          call('search_code', { query: 'function add', path: lib }, 's'),
          call('find_files', { pattern: '*.ts', path: lib }, 'f'),
          call('read_file', { path: path.join(lib, '.env') }, 'e'),
        ],
      },
      { chunks: ['done'] },
    ]);
    const { run } = s.runManager.startMessage(session.id, 'look at the lib');
    await s.runManager.waitFor(run.id);

    const [read, list, search, find, secret] = toolMessages(s, session.id);
    expect(read).toContain(`${path.join(lib, 'src/math.ts')} (lines 1-3 of 3)`);
    expect(read).toContain('export function add');
    expect(list).toContain('math.ts');
    expect(search).toContain(`${path.join(lib, 'src/math.ts')}\n  1: export function add`);
    expect(find).toContain(path.join(lib, 'src/math.ts'));
    expect(secret).toMatch(/credentials file/);
  });

  it('asks for every change there, even after "allow similar", and can undo them', async () => {
    const edit = (lib: string, from: string, to: string, id: string) =>
      call(
        'edit_file',
        {
          path: path.join(lib, 'src/math.ts'),
          edits: [{ old_text: from, new_text: to }],
          reason: 'Demo change outside the project',
        },
        id,
      );
    const { s, session, project, lib } = setup((lib) => [
      { toolCalls: [edit(lib, 'return a + b;', 'return a + b + 0;', 'e1')] },
      { toolCalls: [edit(lib, 'return a + b + 0;', 'return b + a;', 'e2')] },
      { chunks: ['edited'] },
    ]);
    const file = path.join(lib, 'src/math.ts');

    const { run } = s.runManager.startMessage(session.id, 'change the lib');
    const approvals: ApprovalDto[] = [];
    const next = (n: number) =>
      new Promise<ApprovalDto>((resolve) => {
        const check = () => approvals.length >= n && resolve(approvals[n - 1]!);
        const sub = s.runManager.subscribe(run.id, 0, (e) => {
          if (e.type === 'approval_requested') approvals.push(e.approval);
          check();
        });
        for (const e of sub?.replay ?? [])
          if (e.type === 'approval_requested' && !approvals.some((a) => a.id === e.approval.id))
            approvals.push(e.approval);
        check();
      });

    const first = await next(1);
    expect(first.title).toBe(`Edit ${file}`);
    s.approvals.decide(first.id, {
      decision: 'approve',
      actionHash: first.actionHash,
      sessionId: session.id,
      allowSimilar: true,
    });
    // The second edit to the same file is asked again, not approved by the task permission.
    const second = await next(2);
    expect(second.status).toBe('pending');
    s.approvals.decide(second.id, {
      decision: 'approve',
      actionHash: second.actionHash,
      sessionId: session.id,
    });
    await s.runManager.waitFor(run.id);
    expect(fs.readFileSync(file, 'utf8')).toContain('return b + a;');

    const changes = s.fileChanges.listBySession(session.id);
    expect(changes.map((c) => [c.path, c.change])).toEqual([
      [file, 'modify'],
      [file, 'modify'],
    ]);
    const newest = changes.reduce((a, b) => (b.id > a.id ? b : a));
    // Once the folder is removed from the project, Friday no longer touches it.
    const removed = await revertFileChange(newest, workspaceOf({ ...project, externalFolders: [] }))
      .then(() => null)
      .catch((e: unknown) => e);
    expect(String(removed)).toMatch(/outside the project root/);
    await revertFileChange(newest, workspaceOf(project));
    expect(fs.readFileSync(file, 'utf8')).toContain('return a + b + 0;');
  });

  it('refuses moves between the project and an external folder', async () => {
    const { s, session } = setup((lib) => [
      {
        toolCalls: [
          call('move_file', { from: 'src/app.ts', to: path.join(lib, 'app.ts'), reason: 'move' }),
        ],
      },
      { chunks: ['ok'] },
    ]);
    const { run } = s.runManager.startMessage(session.id, 'move it');
    await s.runManager.waitFor(run.id);
    expect(toolMessages(s, session.id)[0]).toMatch(/moves files within one folder/);
    expect(s.approvalRepo.listBySession(session.id)).toEqual([]);
  });

  it('copies the folders to a task worktree and names them in the system prompt', async () => {
    const { s, project, lib } = setup(() => []);
    const { buildSystemPrompt } = await import('../src/chat/systemPrompt.js');
    const prompt = buildSystemPrompt({ project, toolsEnabled: true } as Parameters<
      typeof buildSystemPrompt
    >[0]);
    expect(prompt).toContain(`External folders: ${lib}.`);
    const wt = s.projects.createWorktree(
      'wt',
      makeProject({}),
      {
        parentId: project.id,
        branch: 'b',
        base: 'x',
        baseBranch: null,
        linked: [],
        status: 'active',
        outcome: null,
        createdAt: '',
      },
      null,
      project.externalFolders,
    );
    expect(wt.externalFolders).toEqual([lib]);
  });
});

describe('external folder routes', () => {
  it('saves validated folders, audits the change and browses them in the file tree', async () => {
    const { s, project, root } = setup(() => []);
    const lib = makeProject({ 'src/math.ts': 'x', '.env': 'TOKEN=abc' });
    const app = await buildApp(s);
    const put = (folders: string[]) =>
      app.inject({
        method: 'PUT',
        url: `/api/projects/${project.id}/external-folders`,
        headers: H,
        payload: { folders },
      });

    const ok = await put([lib]);
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as ProjectDto).externalFolders).toEqual([lib]);
    expect((await put([path.join(root, 'src')])).statusCode).toBe(403);
    expect((await put([lib, path.join(lib, 'src')])).json()).toMatchObject({
      error: { message: expect.stringMatching(/overlaps the external folder/) },
    });
    expect(s.projects.get(project.id)!.externalFolders).toEqual([lib]);
    // The setup's folder was replaced: one change, recorded once.
    const audited = s.audit.list().filter((a) => a.action === 'project_external_folders_changed');
    expect(audited).toHaveLength(1);

    const tree = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/tree?path=${encodeURIComponent(lib)}`,
      headers: H,
    });
    const entries = (tree.json() as { entries: TreeEntryDto[] }).entries;
    expect(entries.map((e) => e.path)).toContain(path.join(lib, 'src'));
    const file = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/file?path=${encodeURIComponent(path.join(lib, 'src/math.ts'))}`,
      headers: H,
    });
    expect(file.json()).toMatchObject({ path: path.join(lib, 'src/math.ts'), content: 'x' });
    const secret = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/file?path=${encodeURIComponent(path.join(lib, '.env'))}`,
      headers: H,
    });
    expect(secret.statusCode).toBe(403);

    expect((await put([])).json()).toMatchObject({ externalFolders: [] });
    const gone = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/file?path=${encodeURIComponent(path.join(lib, 'src/math.ts'))}`,
      headers: H,
    });
    expect(gone.statusCode).toBe(403);
  });
});
