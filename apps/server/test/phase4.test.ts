import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ApprovalDto, RunEvent } from '@friday/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { ProviderError } from '../src/providers/errors.js';
import { buildApp } from '../src/app.js';
import { extractLocations, isVerificationCommand } from '../src/commands/locations.js';
import { hideSecretDiffs, parseStatus } from '../src/git/git.js';
import { Redactor } from '../src/security/redact.js';
import { executeToolCall, ToolRegistry } from '../src/tools/registry.js';
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
const registry = new ToolRegistry();

function g(cwd: string, ...args: string[]) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
  });
}

function makeRepo(files: Record<string, string>): string {
  const root = makeProject(files);
  g(root, 'init', '-q', '-b', 'main');
  g(root, 'config', 'user.email', 'friday@test');
  g(root, 'config', 'user.name', 'Friday Test');
  g(root, 'add', '-A');
  g(root, 'commit', '-q', '-m', 'initial');
  return root;
}

function ctx(root: string): ToolContext {
  return {
    project: { id: 'p', name: 'p', rootPath: root, createdAt: '', lastOpenedAt: null },
    sessionId: 's',
    runId: 'r',
    signal: new AbortController().signal,
    redactor: new Redactor(),
    env,
    maxOutputChars: 20_000,
    setPlan: () => undefined,
  };
}
const run = (root: string, name: string, args: unknown) =>
  executeToolCall(registry, call(name, args), ctx(root), { timeoutMs: 10_000 });

// ------------------------------------------------------------------ git inspection

describe('git inspection tools', () => {
  it('parses porcelain v2 status including renames and untracked files', () => {
    const s = parseStatus(
      '# branch.oid abc\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -1\0' +
        '1 .M N... 100644 100644 100644 h1 h2 src/a.ts\0' +
        '2 R. N... 100644 100644 100644 h1 h2 R100 new name.ts\0old.ts\0' +
        '? notes.md\0',
    );
    expect(s).toMatchObject({
      branch: 'main',
      head: 'abc',
      upstream: 'origin/main',
      ahead: 2,
      behind: 1,
    });
    expect(s.entries).toEqual([
      { xy: '.M', path: 'src/a.ts', untracked: false },
      { xy: 'R.', path: 'new name.ts', origPath: 'old.ts', untracked: false },
      { xy: '??', path: 'notes.md', untracked: true },
    ]);
  });

  it('reports status, diff, log, show and branches', async () => {
    const root = makeRepo({ 'src/a.ts': 'export const a = 1;\n', 'README.md': '# r\n' });
    fs.writeFileSync(path.join(root, 'src/a.ts'), 'export const a = 2;\n');
    fs.writeFileSync(path.join(root, 'todo.md'), '- x\n');

    const status = await run(root, 'git_status', {});
    expect(status.content).toContain('Branch: main (no upstream)');
    expect(status.content).toMatch(/Not staged:\n {2}M src\/a.ts/);
    expect(status.content).toMatch(/Untracked:\n {2}\? todo.md/);

    const diff = await run(root, 'git_diff', {});
    expect(diff.content).toContain('-export const a = 1;');
    expect(diff.content).toContain('+export const a = 2;');
    expect((await run(root, 'git_diff', { stat_only: true })).content).toContain('1 file changed');

    const log = await run(root, 'git_log', {});
    expect(log.content).toMatch(/^[0-9a-f]{7,}\s+\d{4}-\d\d-\d\d\s+Friday Test\s+initial$/);
    expect((await run(root, 'git_show', { ref: 'HEAD', stat_only: true })).content).toContain(
      'initial',
    );
    expect((await run(root, 'git_branches', {})).content).toContain('* main');
  });

  it('hides credential files in diffs', async () => {
    const root = makeRepo({ '.env': 'SECRET=old\n', 'a.txt': 'a\n' });
    fs.writeFileSync(path.join(root, '.env'), 'SECRET=topsecretvalue\n');
    fs.writeFileSync(path.join(root, 'a.txt'), 'b\n');
    const diff = await run(root, 'git_diff', {});
    expect(diff.content).toContain('[changes to a credential file are hidden]');
    expect(diff.content).not.toContain('topsecretvalue');
    expect(diff.content).toContain('+b');
    expect(hideSecretDiffs('diff --git a/x b/x\n+ok\n')).toBe('diff --git a/x b/x\n+ok\n');
    // git quotes paths with non-ASCII or special characters; those must be decoded and hidden too.
    const quoted = hideSecretDiffs(
      'diff --git "a/caf\\303\\251/.env" "b/caf\\303\\251/.env"\n--- "a/caf\\303\\251/.env"\n+++ "b/caf\\303\\251/.env"\n+API_KEY=leaked\n',
    );
    expect(quoted).toContain('[changes to a credential file are hidden]');
    expect(quoted).not.toContain('leaked');
  });

  it('never shows credential files through revision:path or blob ids', async () => {
    const root = makeRepo({ '.env': 'API_KEY=topsecretvalue\n', 'a.txt': 'a\n' });
    for (const ref of ['HEAD:.env', ':.env', 'HEAD~0:.env']) {
      const r = await run(root, 'git_show', { ref });
      expect(r.status, ref).toBe('error');
      expect(r.content).not.toContain('topsecretvalue');
    }
    const blob = g(root, 'rev-parse', 'HEAD:.env').trim();
    const byId = await run(root, 'git_show', { ref: blob });
    expect(byId.status).toBe('error');
    expect(byId.content).not.toContain('topsecretvalue');
  });

  it('never runs programs configured by a malicious repository', async () => {
    const root = makeRepo({
      'a.txt': 'one\n',
      '.gitattributes': 'a.txt diff=evil\n* filter=pwn\n',
    });
    const sentinel = path.join(root, 'PWNED');
    // Content filters run on plain `git status`/`git diff` unless neutralised.
    g(root, 'config', 'filter.pwn.clean', `sh -c 'touch ${sentinel}; cat'`);
    g(root, 'config', 'filter.pwn.process', `sh -c 'touch ${sentinel}'`);
    g(root, 'config', 'core.fsmonitor', `touch ${sentinel}; echo`);
    g(root, 'config', 'diff.evil.textconv', `sh -c 'touch ${sentinel}; cat "$0"'`);
    g(root, 'config', 'diff.external', `sh -c 'touch ${sentinel}'`);
    g(root, 'config', 'core.pager', `sh -c 'touch ${sentinel}; cat'`);
    fs.writeFileSync(path.join(root, 'a.txt'), 'two\n');
    for (const [tool, args] of [
      ['git_status', {}],
      ['git_diff', {}],
      ['git_show', { ref: 'HEAD' }],
      ['git_log', {}],
    ] as const) {
      const r = await run(root, tool, args);
      expect(r.status, tool).toBe('completed');
    }
    expect(fs.existsSync(sentinel)).toBe(false);
  });

  it('rejects option injection through refs and paths outside the project', async () => {
    const root = makeRepo({ 'a.txt': 'a\n' });
    const inj = await run(root, 'git_diff', { ref: '--output=/tmp/friday-pwn' });
    expect(inj.status).toBe('error');
    expect(inj.content).toMatch(/not a valid git revision/);
    expect((await run(root, 'git_log', { path: '../..' })).content).toMatch(
      /outside the project root/,
    );
    expect((await run(root, 'git_diff', { path: ':(top)' })).content).toMatch(/Invalid path/);
  });

  it('refuses projects that are a subfolder of a larger repository', async () => {
    const outer = makeRepo({ 'sub/a.txt': 'a\n', 'secret-outside.txt': 'x\n' });
    const r = await run(path.join(outer, 'sub'), 'git_status', {});
    expect(r.content).toMatch(/inside a larger git repository/);
    expect(r.content).not.toContain('secret-outside');
  });
});

describe('error interpretation helpers', () => {
  it('extracts project file locations from tool output', () => {
    const root = makeProject({
      'src/cart.js': 'x',
      'test/cart.test.js': 'y',
      'node_modules/lib/i.js': 'z',
    });
    const out = [
      `    at cartTotal (${root}/src/cart.js:5:12)`,
      'test/cart.test.js:6:10 - AssertionError',
      '  at node_modules/lib/i.js:1:1',
      'error in /etc/passwd:1',
      'see src/missing.ts:3',
      `again ${root}/src/cart.js:5:12`,
    ].join('\n');
    expect(extractLocations(out, root, root)).toEqual([
      'src/cart.js:5:12',
      'test/cart.test.js:6:10',
    ]);
  });

  it('recognizes verification commands', () => {
    for (const c of [
      'npm test',
      'npm run build',
      'pnpm lint',
      'npx vitest run',
      'node --test',
      'php artisan test',
      'vendor/bin/phpunit',
      'pytest -q',
      'go test ./...',
      'cargo check',
      'tsc --noEmit',
    ]) {
      expect(isVerificationCommand(c), c).toBe(true);
    }
    for (const c of ['ls -la', 'npm install', 'git status', 'cat package.json', 'node server.js']) {
      expect(isVerificationCommand(c), c).toBe(false);
    }
  });
});

// ------------------------------------------------------------------ agent loop: approvals for git and multi-file

function setup(steps: ConstructorParameters<typeof ScriptedProvider>[0], root: string) {
  const provider = new ScriptedProvider(steps);
  const s = testServices({ provider, config: testConfig(), toolEnv: env });
  const project = s.projects.create('demo', root);
  const session = s.sessions.create(undefined, project.id);
  return { s, session, provider };
}

/** Start a run and approve every request as it arrives (optionally intervening before approval). */
async function runApproving(
  s: ReturnType<typeof setup>['s'],
  sessionId: string,
  text: string,
  before?: (a: ApprovalDto) => void,
) {
  const { run } = s.runManager.startMessage(sessionId, text);
  const events: RunEvent[] = [];
  const onEvent = (e: RunEvent) => {
    events.push(e);
    if (e.type === 'approval_requested') {
      setTimeout(() => {
        before?.(e.approval);
        try {
          s.approvals.decide(e.approval.id, {
            decision: 'approve',
            actionHash: e.approval.actionHash,
            sessionId,
          });
        } catch {
          /* already decided */
        }
      }, 5);
    }
  };
  const sub = s.runManager.subscribe(run.id, 0, onEvent);
  sub?.replay.forEach(onEvent);
  await s.runManager.waitFor(run.id);
  return { run: s.runs.get(run.id)!, events };
}

describe('git mutations through approvals', () => {
  it('commits exactly the requested paths and leaves other staged work alone', async () => {
    const root = makeRepo({ 'src/a.ts': 'a1\n', 'src/b.ts': 'b1\n' });
    fs.writeFileSync(path.join(root, 'src/a.ts'), 'a2\n');
    fs.writeFileSync(path.join(root, 'src/b.ts'), 'b2\n');
    g(root, 'add', 'src/b.ts'); // user's own staged change, not part of the commit
    fs.writeFileSync(path.join(root, 'new.ts'), 'n\n');
    const { s, session } = setup(
      [
        {
          toolCalls: [
            call(
              'git_commit',
              { message: 'Fix a', paths: ['src/a.ts', 'new.ts'], reason: 'user asked' },
              'c',
            ),
          ],
        },
        { chunks: ['done'] },
      ],
      root,
    );
    const { run } = await runApproving(s, session.id, 'commit the fix');
    const approval = s.approvalRepo.listByRun(run.id)[0]!;
    expect(approval).toMatchObject({ toolName: 'git_commit', category: 'git', status: 'executed' });
    expect(approval.details).toMatchObject({
      kind: 'git',
      operation: 'commit',
      branch: 'main',
      message: 'Fix a',
    });
    expect(
      approval.details.kind === 'git' && approval.details.files.map((f) => [f.path, f.change]),
    ).toEqual([
      ['src/a.ts', 'modify'],
      ['new.ts', 'create'],
    ]);
    expect(g(root, 'show', '--name-only', '--format=%s', 'HEAD').trim().split('\n')).toEqual([
      'Fix a',
      '',
      'new.ts',
      'src/a.ts',
    ]);
    // The user's staged change to b.ts is still staged and uncommitted.
    expect(g(root, 'diff', '--cached', '--name-only').trim()).toBe('src/b.ts');
    expect(run.report?.commits[0]).toMatch(/^[0-9a-f]{7,} Fix a$/);
  });

  it('refuses to commit credential files and goes stale if files change after review', async () => {
    const root = makeRepo({ 'a.txt': '1\n' });
    fs.writeFileSync(path.join(root, '.env'), 'X=1\n');
    fs.writeFileSync(path.join(root, 'a.txt'), '2\n');
    const { s, session } = setup(
      [
        {
          toolCalls: [
            call('git_commit', { message: 'all', paths: ['.'], reason: 'commit everything' }, 'x'),
          ],
        },
        {
          toolCalls: [
            call('git_commit', { message: 'a only', paths: ['a.txt'], reason: 'commit a' }, 'y'),
          ],
        },
        { chunks: ['ok'] },
      ],
      root,
    );
    const { run } = await runApproving(s, session.id, 'commit', () =>
      fs.writeFileSync(path.join(root, 'a.txt'), '3\n'),
    );
    const tools = s.messages.listBySession(session.id).filter((m) => m.role === 'tool');
    expect(tools[0]!.content).toMatch(/Refusing to commit credential files: \.env/);
    expect(tools[1]!.content).toMatch(/Not executed: the target changed after it was reviewed/);
    expect(s.approvalRepo.listByRun(run.id).map((a) => a.status)).toEqual(['stale']);
    expect(g(root, 'log', '--format=%s').trim()).toBe('initial');
  });

  it('creates a branch with approval', async () => {
    const root = makeRepo({ 'a.txt': '1\n' });
    const { s, session } = setup(
      [
        {
          toolCalls: [
            call('git_create_branch', { name: 'fix/cart', reason: 'isolate the fix' }, 'b'),
          ],
        },
        { chunks: ['ok'] },
      ],
      root,
    );
    await runApproving(s, session.id, 'make a branch');
    expect(g(root, 'branch', '--show-current').trim()).toBe('fix/cart');
  });
});

describe('multi-file edits', () => {
  it('shows every file in one approval and applies them together', async () => {
    const root = makeProject({
      'src/price.js': 'export const tax = 0.1;\n',
      'src/cart.js': 'import { tax } from "./price.js";\n',
    });
    const { s, session } = setup(
      [
        {
          toolCalls: [
            call(
              'edit_files',
              {
                changes: [
                  { path: 'src/price.js', edits: [{ old_text: 'tax', new_text: 'vat' }] },
                  { path: 'src/cart.js', edits: [{ old_text: '{ tax }', new_text: '{ vat }' }] },
                  { path: 'src/README.md', content: '# src\n' },
                ],
                reason: 'Rename tax to vat',
              },
              'm',
            ),
          ],
        },
        { chunks: ['done'] },
      ],
      root,
    );
    const { run } = await runApproving(s, session.id, 'rename');
    const a = s.approvalRepo.listByRun(run.id)[0]!;
    expect(
      a.details.kind === 'file_change' && a.details.changes.map((c) => [c.path, c.change]),
    ).toEqual([
      ['src/price.js', 'modify'],
      ['src/cart.js', 'modify'],
      ['src/README.md', 'create'],
    ]);
    expect(fs.readFileSync(path.join(root, 'src/price.js'), 'utf8')).toBe(
      'export const vat = 0.1;\n',
    );
    expect(fs.readFileSync(path.join(root, 'src/cart.js'), 'utf8')).toBe(
      'import { vat } from "./price.js";\n',
    );
    expect(s.fileChanges.listByRun(run.id)).toHaveLength(3);
  });

  it('is all-or-nothing when a write fails part way', async () => {
    const root = makeProject({ 'a/x.txt': 'x1\n', 'ro/y.txt': 'y1\n' });
    const { s, session } = setup(
      [
        {
          toolCalls: [
            call(
              'edit_files',
              {
                changes: [
                  { path: 'a/x.txt', edits: [{ old_text: 'x1', new_text: 'x2' }] },
                  { path: 'ro/y.txt', edits: [{ old_text: 'y1', new_text: 'y2' }] },
                ],
                reason: 'update both',
              },
              'm',
            ),
          ],
        },
        { chunks: ['ok'] },
      ],
      root,
    );
    // Make the second folder read-only after the proposal is shown (approval re-check still reads fine).
    await runApproving(s, session.id, 'go', () => fs.chmodSync(path.join(root, 'ro'), 0o555));
    fs.chmodSync(path.join(root, 'ro'), 0o755);
    expect(fs.readFileSync(path.join(root, 'a/x.txt'), 'utf8')).toBe('x1\n');
    expect(fs.readFileSync(path.join(root, 'ro/y.txt'), 'utf8')).toBe('y1\n');
    const tool = s.messages.listBySession(session.id).find((m) => m.role === 'tool')!;
    expect(tool.content).toMatch(/already written were restored/);
    expect(s.fileChanges.listBySession(session.id)).toEqual([]);
  });
});

// ------------------------------------------------------------------ verification reports, checkpoints, resume, rollback

const fixEdit = call(
  'edit_file',
  { path: 'src/cart.js', edits: [{ old_text: 'i = 1', new_text: 'i = 0' }], reason: 'fix loop' },
  'e',
);
const nodeExit = (code: number, id: string) =>
  call(
    'run_command',
    {
      argv: ['node', '-e', `console.log('test output'); process.exit(${code})`],
      reason: 'run tests',
    },
    id,
  );
// Classified as a verification command because of the "npm test" form below.
const npmTest = (id: string) =>
  call('run_command', { argv: ['npm', 'test', '--silent'], reason: 'run tests' }, id);

describe('verification reports', () => {
  const files = () => ({
    'src/cart.js': 'for (let i = 1; i < n; i++) {}\n',
    'package.json': JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }),
  });

  it('is "verified" only when a verification command passes after the last change', async () => {
    const root = makeProject(files());
    const { s, session } = setup(
      [
        { toolCalls: [nodeExit(1, 'early')] },
        { toolCalls: [fixEdit] },
        { toolCalls: [npmTest('t')] },
        { chunks: ['All good.'] },
      ],
      root,
    );
    const { run } = await runApproving(s, session.id, 'fix and test');
    expect(run.report).toMatchObject({
      status: 'verified',
      files: [{ path: 'src/cart.js', change: 'modify', reverted: false, modifiedSince: false }],
    });
    expect(
      run.report!.commands.map((c) => [c.exitCode, c.verification, c.afterLastChange]),
    ).toEqual([
      [1, false, false],
      [0, true, true],
    ]);
    expect(run.checkpoint).toMatchObject({
      filesChanged: ['src/cart.js'],
      lastCommand: { title: 'npm test --silent' },
    });
  });

  it('is "failed" when the last check fails, and "unverified" with no check after the change', async () => {
    const root = makeProject({
      ...files(),
      'package.json': JSON.stringify({ scripts: { test: 'node -e "process.exit(2)"' } }),
    });
    const { s, session } = setup(
      [{ toolCalls: [fixEdit] }, { toolCalls: [npmTest('t')] }, { chunks: ['Tests pass!'] }],
      root,
    );
    const { run } = await runApproving(s, session.id, 'fix and test');
    expect(run.report?.status).toBe('failed');
    expect(run.report?.note).toMatch(
      /`npm test --silent` did not pass after the last change \(exit code 2/,
    );

    const root2 = makeProject(files());
    const second = setup([{ toolCalls: [fixEdit] }, { chunks: ['Fixed.'] }], root2);
    const { run: run2 } = await runApproving(second.s, second.session.id, 'fix');
    expect(run2.report).toMatchObject({ status: 'unverified' });
  });

  it('flags files edited elsewhere after Friday changed them', async () => {
    const root = makeProject(files());
    const { s, session } = setup([{ toolCalls: [fixEdit] }, { chunks: ['Fixed.'] }], root);
    const { run } = await runApproving(s, session.id, 'fix');
    fs.appendFileSync(path.join(root, 'src/cart.js'), '// user\n');
    const app = await buildApp(s);
    // Single-file undo refuses, and the refreshed report shows the drift.
    const [change] = s.fileChanges.listByRun(run.id);
    const undo = await app.inject({
      method: 'POST',
      url: `/api/file-changes/${change!.id}/revert`,
      headers: { host: '127.0.0.1:4317', 'x-friday-client': '1' },
    });
    expect(undo.statusCode).toBe(409);
    const { buildRunReport } = await import('../src/reports/runReport.js');
    expect(buildRunReport(run.id, s).files[0]!.modifiedSince).toBe(true);
    await app.close();
  });

  it('gives the next attempt a resumption context from records', async () => {
    const root = makeProject(files());
    // First run: an edit and a test command, then the provider fails (run ends "failed").
    const first = setup(
      [
        { toolCalls: [fixEdit] },
        { toolCalls: [npmTest('t')] },
        { error: new ProviderError('server') },
        { chunks: ['resumed'] },
      ],
      root,
    );
    const { run } = await runApproving(first.s, first.session.id, 'fix it');
    expect(run.status).toBe('failed');
    const retry = first.s.runManager.retry(first.session.id);
    await first.s.runManager.waitFor(retry.run.id);
    const system = first.provider.requests.at(-1)!.messages[0]!;
    const text = system.role === 'system' ? system.content : '';
    expect(text).toContain('## Resuming earlier work');
    expect(text).toContain('Files changed and still in place: src/cart.js');
    expect(text).toContain('Ran `npm test --silent`: exit code 0');
    expect(text).toContain('do not redo finished steps');
  });
});

describe('run rollback', () => {
  it('undoes every change from a run, newest first', async () => {
    const root = makeProject({ 'a.txt': 'a1\n', 'b.txt': 'b1\n' });
    const { s, session } = setup(
      [
        {
          toolCalls: [
            call(
              'edit_file',
              { path: 'a.txt', edits: [{ old_text: 'a1', new_text: 'a2' }], reason: 'step one' },
              '1',
            ),
          ],
        },
        {
          toolCalls: [
            call(
              'edit_file',
              { path: 'a.txt', edits: [{ old_text: 'a2', new_text: 'a3' }], reason: 'step two' },
              '2',
            ),
          ],
        },
        {
          toolCalls: [
            call('write_file', { path: 'c.txt', content: 'new\n', reason: 'add c' }, '3'),
          ],
        },
        { toolCalls: [call('delete_file', { path: 'b.txt', reason: 'remove b' }, '4')] },
        { chunks: ['done'] },
      ],
      root,
    );
    const { run } = await runApproving(s, session.id, 'many changes');
    expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('a3\n');
    const app = await buildApp(s);
    const headers = { host: '127.0.0.1:4317', 'x-friday-client': '1' };
    const res = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/rollback`, headers });
    expect(res.statusCode).toBe(200);
    expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('a1\n');
    expect(fs.readFileSync(path.join(root, 'b.txt'), 'utf8')).toBe('b1\n');
    expect(fs.existsSync(path.join(root, 'c.txt'))).toBe(false);
    expect(res.json().run.report.status).toBe('no_changes');
    const again = await app.inject({
      method: 'POST',
      url: `/api/runs/${run.id}/rollback`,
      headers,
    });
    expect(again.json().error.code).toBe('nothing_to_roll_back');
    await app.close();
  });

  it('touches nothing if any file was edited since', async () => {
    const root = makeProject({ 'a.txt': 'a1\n', 'b.txt': 'b1\n' });
    const { s, session } = setup(
      [
        {
          toolCalls: [
            call(
              'edit_files',
              {
                changes: [
                  { path: 'a.txt', content: 'a2\n' },
                  { path: 'b.txt', content: 'b2\n' },
                ],
                reason: 'both',
              },
              '1',
            ),
          ],
        },
        { chunks: ['done'] },
      ],
      root,
    );
    const { run } = await runApproving(s, session.id, 'change both');
    fs.writeFileSync(path.join(root, 'b.txt'), 'b2 plus user edit\n');
    const app = await buildApp(s);
    const res = await app.inject({
      method: 'POST',
      url: `/api/runs/${run.id}/rollback`,
      headers: { host: '127.0.0.1:4317', 'x-friday-client': '1' },
    });
    expect(res.statusCode).toBe(409);
    expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('a2\n');
    expect(fs.readFileSync(path.join(root, 'b.txt'), 'utf8')).toBe('b2 plus user edit\n');
    await app.close();
  });
});

describe('regressions from the live crash test', () => {
  const files = () => ({
    'src/cart.js': 'for (let i = 1; i < n; i++) {}\n',
    'package.json': JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }),
  });

  it('checkpoints an applied change immediately, even mid-turn', async () => {
    const root = makeProject(files());
    const { s, session } = setup([{ toolCalls: [fixEdit, npmTest('t')] }], root);
    const { run } = s.runManager.startMessage(session.id, 'fix and test');
    let checkpointAtSecondApproval: unknown = null;
    await new Promise<void>((resolve) => {
      const onEvent = (e: RunEvent) => {
        if (e.type !== 'approval_requested') return;
        if (e.approval.toolName === 'edit_file') {
          s.approvals.decide(e.approval.id, {
            decision: 'approve',
            actionHash: e.approval.actionHash,
            sessionId: session.id,
          });
        } else {
          // The "crash" point: the edit is applied, the command is still awaiting approval.
          checkpointAtSecondApproval = s.runs.get(run.id)?.checkpoint;
          s.runManager.cancel(run.id);
          resolve();
        }
      };
      const sub = s.runManager.subscribe(run.id, 0, onEvent);
      sub?.replay.forEach(onEvent);
    });
    await s.runManager.waitFor(run.id);
    expect(checkpointAtSecondApproval).toMatchObject({ filesChanged: ['src/cart.js'] });
  });

  it('reports on the whole task when a resumed run verifies an earlier attempt’s change', async () => {
    const root = makeProject(files());
    const { s, session } = setup(
      [
        { toolCalls: [fixEdit] },
        { error: new ProviderError('server') },
        { toolCalls: [npmTest('t')] },
        { chunks: ['verified'] },
      ],
      root,
    );
    const { run: first } = await runApproving(s, session.id, 'fix it');
    expect(first.status).toBe('failed');
    const { run } = s.runManager.retry(session.id);
    const sub = s.runManager.subscribe(run.id, 0, (e) => {
      if (e.type === 'approval_requested')
        s.approvals.decide(e.approval.id, {
          decision: 'approve',
          actionHash: e.approval.actionHash,
          sessionId: session.id,
        });
    });
    sub?.replay.forEach(
      (e) =>
        e.type === 'approval_requested' &&
        s.approvals.decide(e.approval.id, {
          decision: 'approve',
          actionHash: e.approval.actionHash,
          sessionId: session.id,
        }),
    );
    await s.runManager.waitFor(run.id);
    const resumed = s.runs.get(run.id)!;
    expect(resumed.report).toMatchObject({
      status: 'verified',
      files: [{ path: 'src/cart.js', reverted: false }],
    });

    // Rolling back the resumed run undoes the earlier attempt's change too.
    const app = await buildApp(s);
    const res = await app.inject({
      method: 'POST',
      url: `/api/runs/${run.id}/rollback`,
      headers: { host: '127.0.0.1:4317', 'x-friday-client': '1' },
    });
    expect(res.statusCode).toBe(200);
    expect(fs.readFileSync(path.join(root, 'src/cart.js'), 'utf8')).toContain('i = 1');
    await app.close();
  });
});
