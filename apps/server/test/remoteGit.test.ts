import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunReport } from '@friday/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { assessCommand } from '../src/commands/risk.js';
import { runGit } from '../src/git/git.js';
import { displayRemoteUrl, githubRepo } from '../src/git/github.js';
import { Redactor } from '../src/security/redact.js';
import { createPullRequest, gitPush, reportSection } from '../src/tools/remoteGitTools.js';
import type { ToolContext } from '../src/tools/types.js';
import { detectToolEnvironment } from '../src/workspace/environment.js';
import { cleanupProjects, makeProject } from './helpers.js';

afterEach(cleanupProjects);
const env = await detectToolEnvironment();

function g(cwd: string, ...args: string[]) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
  });
}

/** A working repo on `branch` with one extra commit, cloned from a bare "remote". */
function setup(branch = 'feature') {
  const bare = makeProject({});
  g(bare, 'init', '-q', '--bare', '-b', 'main');
  const root = makeProject({ 'README.md': '# demo\n' });
  g(root, 'init', '-q', '-b', 'main');
  g(root, 'config', 'user.email', 'friday@test');
  g(root, 'config', 'user.name', 'Friday Test');
  g(root, 'add', '-A');
  g(root, 'commit', '-q', '-m', 'initial');
  g(root, 'remote', 'add', 'origin', bare);
  g(root, 'push', '-q', 'origin', 'main');
  g(root, 'fetch', '-q', 'origin');
  g(root, 'remote', 'set-head', 'origin', 'main');
  if (branch !== 'main') g(root, 'switch', '-q', '-c', branch);
  fs.writeFileSync(path.join(root, 'a.txt'), 'a\n');
  g(root, 'add', 'a.txt');
  g(root, 'commit', '-q', '-m', 'Add a');
  return { root, bare };
}

function ctx(root: string, extra: Partial<ToolContext> = {}): ToolContext {
  return {
    project: {
      id: 'p',
      name: 'p',
      rootPath: root,
      createdAt: '',
      lastOpenedAt: null,
      sandbox: null,
      worktree: null,
    },
    sessionId: 's',
    runId: 'r',
    signal: new AbortController().signal,
    redactor: new Redactor(),
    env,
    maxOutputChars: 20_000,
    setPlan: () => undefined,
    ...extra,
  };
}

const prepare = (tool: typeof gitPush | typeof createPullRequest, args: unknown, c: ToolContext) =>
  tool.prepare!(tool.schema.parse(args) as never, c);

describe('git_push', () => {
  it('pushes the current branch as a new remote branch and sets the upstream', async () => {
    const { root, bare } = setup();
    const p = await prepare(gitPush, { reason: 'share the work' }, ctx(root));
    expect(p.title).toBe('Push feature to origin');
    expect(p.details).toMatchObject({
      kind: 'git_remote',
      operation: 'push',
      remote: 'origin',
      remoteUrl: bare,
      branch: 'feature',
      remoteHead: null,
      needsPush: true,
      commitCount: 1,
      commits: [{ subject: 'Add a' }],
      pullRequest: null,
    });
    const out = await p.apply(ctx(root));
    expect(out.summary).toBe('pushed feature');
    expect(g(bare, 'log', '--format=%s', '-1', 'feature').trim()).toBe('Add a');
    expect(g(root, 'rev-parse', '--abbrev-ref', 'feature@{upstream}').trim()).toBe(
      'origin/feature',
    );

    // Everything is on the remote now.
    await expect(prepare(gitPush, { reason: 'again' }, ctx(root))).rejects.toThrow(
      /Nothing to push/,
    );

    // A later commit is a fast-forward update.
    fs.writeFileSync(path.join(root, 'b.txt'), 'b\n');
    g(root, 'add', 'b.txt');
    g(root, 'commit', '-q', '-m', 'Add b');
    const next = await prepare(gitPush, { reason: 'update' }, ctx(root));
    expect(next.details).toMatchObject({ commitCount: 1, commits: [{ subject: 'Add b' }] });
    expect((next.details as { remoteHead: string | null }).remoteHead).not.toBeNull();
  });

  it('never pushes main, master or the remote default branch, or a detached HEAD', async () => {
    const onMain = setup('main');
    await expect(prepare(gitPush, { reason: 'xyz' }, ctx(onMain.root))).rejects.toThrow(
      /never pushes to the default branch/,
    );

    const { root } = setup('develop');
    g(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop');
    await expect(prepare(gitPush, { reason: 'xyz' }, ctx(root))).rejects.toThrow(
      /never pushes to the default branch \(develop\)/,
    );

    g(root, 'switch', '-q', '-c', 'master');
    g(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    await expect(prepare(gitPush, { reason: 'xyz' }, ctx(root))).rejects.toThrow(
      /never pushes to master/,
    );

    g(root, 'switch', '-q', '--detach');
    await expect(prepare(gitPush, { reason: 'xyz' }, ctx(root))).rejects.toThrow(
      /HEAD is detached/,
    );
  });

  it('never force-pushes over commits it does not have', async () => {
    const { root, bare } = setup();
    await (await prepare(gitPush, { reason: 'xyz' }, ctx(root))).apply(ctx(root));

    // Someone else pushes to the same branch.
    const other = makeProject({});
    g(other, 'clone', '-q', '-b', 'feature', bare, '.');
    g(other, 'config', 'user.email', 'o@test');
    g(other, 'config', 'user.name', 'Other');
    fs.writeFileSync(path.join(other, 'theirs.txt'), 't\n');
    g(other, 'add', '-A');
    g(other, 'commit', '-q', '-m', 'Theirs');
    g(other, 'push', '-q', 'origin', 'feature');

    fs.writeFileSync(path.join(root, 'mine.txt'), 'm\n');
    g(root, 'add', '-A');
    g(root, 'commit', '-q', '-m', 'Mine');

    // Not fetched yet: the push is attempted and the remote rejects it.
    const stale = await prepare(gitPush, { reason: 'xyz' }, ctx(root));
    await expect(stale.apply(ctx(root))).rejects.toThrow(/never force-pushes/);
    expect(g(bare, 'log', '--format=%s', '-1', 'feature').trim()).toBe('Theirs');

    // Once fetched, Friday sees the divergence before asking.
    g(root, 'fetch', '-q', 'origin');
    await expect(prepare(gitPush, { reason: 'xyz' }, ctx(root))).rejects.toThrow(
      /has commits this branch does not/,
    );
  });

  it('refuses to push commits that contain credential files', async () => {
    const { root } = setup();
    fs.writeFileSync(path.join(root, '.env'), 'SECRET=1\n');
    g(root, 'add', '-f', '.env');
    g(root, 'commit', '-q', '-m', 'oops');
    g(root, 'rm', '-q', '--cached', '.env');
    g(root, 'commit', '-q', '-m', 'remove it again');
    await expect(prepare(gitPush, { reason: 'xyz' }, ctx(root))).rejects.toThrow(
      /include credential files \(\.env\)/,
    );
  });

  it("does not run the repository's own pack programs or ext:: transports", async () => {
    const { root, bare } = setup();
    const marker = path.join(os.tmpdir(), `friday-marker-${process.pid}-${Date.now()}`);
    g(root, 'config', 'remote.origin.receivepack', `touch ${marker}; git-receive-pack`);
    await (await prepare(gitPush, { reason: 'xyz' }, ctx(root))).apply(ctx(root));
    expect(fs.existsSync(marker)).toBe(false);
    expect(g(bare, 'log', '--format=%s', '-1', 'feature').trim()).toBe('Add a');

    g(root, 'config', '--unset', 'remote.origin.receivepack');
    g(root, 'remote', 'set-url', '--push', 'origin', `ext::sh -c touch% ${marker}`);
    fs.writeFileSync(path.join(root, 'c.txt'), 'c\n');
    g(root, 'add', '-A');
    g(root, 'commit', '-q', '-m', 'Add c');
    const p = await prepare(gitPush, { reason: 'xyz' }, ctx(root));
    await expect(p.apply(ctx(root))).rejects.toThrow(/git push failed/);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("uses the user's credential helpers, never the repository's own", async () => {
    const { root } = setup();
    const home = makeProject({});
    const marker = path.join(home, 'repo-helper-ran');
    // The user's (global) helper answers; the repository's own helper must never run.
    fs.writeFileSync(
      path.join(home, '.gitconfig'),
      '[credential]\n\thelper = "!f() { echo username=me; echo password=from-user-helper; }; f"\n',
    );
    g(root, 'config', 'credential.helper', `!f() { touch ${marker}; echo password=from-repo; }; f`);
    const saved = process.env.HOME;
    process.env.HOME = home;
    try {
      const r = await runGit(root, ['credential', 'fill'], {
        credentials: true,
        input: 'protocol=https\nhost=example.com\n\n',
      });
      expect(r.stdout).toContain('password=from-user-helper');
      expect(fs.existsSync(marker)).toBe(false);

      // Without credentials (every other git call), no helper runs at all.
      const plain = await runGit(root, ['credential', 'fill'], {
        input: 'protocol=https\nhost=example.com\nusername=x\n\n',
      });
      expect(plain.stdout).not.toContain('from-');
    } finally {
      process.env.HOME = saved;
    }
  });

  it('never shows credentials embedded in a remote URL', async () => {
    const { root } = setup();
    g(root, 'remote', 'set-url', '--push', 'origin', 'https://me:s3cret@example.com/o/r.git');
    const p = await prepare(gitPush, { reason: 'xyz' }, ctx(root));
    expect(p.details).toMatchObject({ remoteUrl: 'https://example.com/o/r.git' });
    expect(JSON.stringify(p)).not.toContain('s3cret');
  });
});

// ------------------------------------------------------------------ pull requests

const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'friday-gh-'));
const ghLog = path.join(fakeDir, 'calls.log');
const ghBody = path.join(fakeDir, 'body.md');
const ghMode = path.join(fakeDir, 'mode');

beforeAll(() => {
  const script = `#!/bin/sh
echo "$@" >> ${ghLog}
mode=$(cat ${ghMode} 2>/dev/null)
case "$1 $2" in
  "auth status") [ "$mode" = "signed-out" ] && exit 1; exit 0 ;;
  "repo view") echo '{"defaultBranchRef":{"name":"main"}}' ;;
  "pr list") if [ "$mode" = "open" ]; then echo '[{"url":"https://github.com/o/r/pull/3"}]'; else echo '[]'; fi ;;
  "pr create") cat > ${ghBody}; echo "https://github.com/o/r/pull/7" ;;
  *) echo "unexpected: $*" >&2; exit 2 ;;
esac
`;
  fs.writeFileSync(path.join(fakeDir, 'gh'), script, { mode: 0o755 });
  process.env.FRIDAY_GH = path.join(fakeDir, 'gh');
});
afterAll(() => {
  delete process.env.FRIDAY_GH;
  fs.rmSync(fakeDir, { recursive: true, force: true });
});
afterEach(() => {
  for (const f of [ghLog, ghBody, ghMode]) fs.rmSync(f, { force: true });
});

/** Fetch from a GitHub URL, push to the local bare repo. */
function githubSetup() {
  const s = setup();
  g(s.root, 'remote', 'set-url', 'origin', 'https://github.com/o/r.git');
  g(s.root, 'remote', 'set-url', '--push', 'origin', s.bare);
  return s;
}

const report: RunReport = {
  status: 'verified',
  note: '`npm test` passed after the last change.',
  files: [
    { path: 'a.txt', change: 'create', fromPath: null, reverted: false, modifiedSince: false },
  ],
  commands: [
    {
      title: 'npm test',
      result: 'exit code 0',
      exitCode: 0,
      verification: true,
      afterLastChange: true,
    },
  ],
  commits: [],
};

describe('create_pull_request', () => {
  const args = { title: 'Add a', body: 'Adds **a**.', reason: 'user asked' };

  it('pushes the branch, then opens the pull request with the exact text shown', async () => {
    const { root, bare } = githubSetup();
    const c = ctx(root, { sessionReports: () => [report] });
    const p = await prepare(createPullRequest, args, c);
    expect(p.details).toMatchObject({
      kind: 'git_remote',
      operation: 'pull_request',
      needsPush: true,
      pullRequest: { repo: 'o/r', base: 'main', title: 'Add a', draft: false },
    });
    const body = (p.details as { pullRequest: { body: string } }).pullRequest.body;
    expect(body).toMatch(/^Adds \*\*a\*\*\.\n\n## Verification\n\n✅ Verified: `npm test` passed/);
    expect(body).toContain('- `npm test`: passed');

    const out = await p.apply(c);
    expect(out.content).toContain('Opened pull request: https://github.com/o/r/pull/7');
    expect(g(bare, 'log', '--format=%s', '-1', 'feature').trim()).toBe('Add a');
    expect(fs.readFileSync(ghBody, 'utf8')).toBe(body);
    expect(fs.readFileSync(ghLog, 'utf8')).toContain(
      'pr create --repo o/r --head feature --base main --title Add a --body-file -',
    );
  });

  it('skips the push when the remote is up to date, and leaves out an empty report', async () => {
    const { root } = githubSetup();
    await (await prepare(gitPush, { reason: 'xyz' }, ctx(root))).apply(ctx(root));
    const noChanges: RunReport = { ...report, status: 'no_changes', files: [] };
    const p = await prepare(
      createPullRequest,
      { ...args, draft: true, base: 'release' },
      ctx(root, { sessionReports: () => [noChanges] }),
    );
    expect(p.details).toMatchObject({
      needsPush: false,
      pullRequest: { base: 'release', draft: true, body: 'Adds **a**.' },
    });
    await p.apply(ctx(root));
    expect(fs.readFileSync(ghLog, 'utf8')).toContain(
      '--base release --title Add a --body-file - --draft',
    );
  });

  it('takes the report from the run that made the branch commits', async () => {
    const { root } = githubSetup();
    const sha = g(root, 'rev-parse', '--short', 'HEAD').trim();
    const current: RunReport = { ...report, status: 'no_changes', files: [], commands: [] };
    const unrelated: RunReport = {
      ...report,
      note: 'from another branch',
      commits: ['1234567 other'],
    };
    const maker: RunReport = {
      ...report,
      note: 'from the run that committed',
      commits: [`${sha} Add a`],
    };
    const body = async (reports: RunReport[]) =>
      (
        (await prepare(createPullRequest, args, ctx(root, { sessionReports: () => reports })))
          .details as { pullRequest: { body: string } }
      ).pullRequest.body;
    expect(await body([current, unrelated, maker])).toContain('from the run that committed');
    expect(await body([current, unrelated])).toBe('Adds **a**.');
  });

  it('explains what is missing instead of guessing', async () => {
    const { root } = githubSetup();
    fs.writeFileSync(ghMode, 'open');
    await expect(prepare(createPullRequest, args, ctx(root))).rejects.toThrow(
      /already open: https:\/\/github.com\/o\/r\/pull\/3/,
    );
    fs.writeFileSync(ghMode, 'signed-out');
    await expect(prepare(createPullRequest, args, ctx(root))).rejects.toThrow(/gh auth login/);

    const plain = setup();
    await expect(prepare(createPullRequest, args, ctx(plain.root))).rejects.toThrow(
      /not a GitHub repository URL/,
    );
  });
});

describe('remote helpers', () => {
  it('reads GitHub repositories from remote URLs', () => {
    expect(githubRepo('https://github.com/o/r.git')).toEqual({
      host: 'github.com',
      owner: 'o',
      name: 'r',
    });
    expect(githubRepo('git@github.com:o/r.git')).toMatchObject({ owner: 'o', name: 'r' });
    expect(githubRepo('ssh://git@github.com/o/r')).toMatchObject({ owner: 'o', name: 'r' });
    expect(githubRepo('https://ghe.corp.example/team/app')).toMatchObject({
      host: 'ghe.corp.example',
    });
    expect(githubRepo('/srv/git/r.git')).toBeNull();
    expect(githubRepo('ext::sh -c x')).toBeNull();
    expect(githubRepo('https://github.com/o/r/extra')).toBeNull();
    expect(displayRemoteUrl('https://x-access-token:abc@github.com/o/r.git')).toBe(
      'https://github.com/o/r.git',
    );
  });

  it('writes the verification section only from records', () => {
    expect(reportSection({ ...report, status: 'no_changes' })).toBeNull();
    expect(
      reportSection({ ...report, status: 'unverified', note: 'No checks ran.', commands: [] }),
    ).toBe(
      '## Verification\n\n⚠️ Not verified: No checks ran.\n\nFiles changed: 1\n\n_Generated by Friday from its records of this task, not by the model._',
    );
  });

  it('rates force pushes through run_command as critical', () => {
    for (const argv of [
      ['git', 'push', '--force'],
      ['git', 'push', '-f', 'origin', 'main'],
      ['git', 'push', 'origin', '+main'],
      ['git', 'push', '--force-with-lease'],
      ['git', 'push', '--delete', 'origin', 'x'],
    ])
      expect(assessCommand(argv, null).risk, argv.join(' ')).toBe('critical');
    expect(assessCommand(['git', 'push'], null).risk).toBe('high');
  });
});
