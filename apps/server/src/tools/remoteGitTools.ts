import { createHash } from 'node:crypto';
import type { RunReport } from '@friday/shared';
import { z } from 'zod';
import { activeHooks, assertRepoRoot, git, repoStatus, runGit } from '../git/git.js';
import { displayRemoteUrl, githubRepo, repoArg, runGh, type GitHubRepo } from '../git/github.js';
import { assertRootAvailable, isSecretPath, WorkspaceError } from '../workspace/paths.js';
import { defineTool, type Proposal, type ToolContext, type ToolOutput } from './types.js';

/**
 * Pushing a branch and opening a pull request with the user's own git and gh sign-in. Friday never
 * pushes the default branch (or main/master), never force-pushes, and every push and pull request
 * is approved on a card that shows the destination, the commits and the exact text.
 */

const reason = z.string().min(3).max(500).describe('Why this is needed. Shown to the user.');
const remoteName = z.string().regex(/^(?!-)[A-Za-z0-9._/-]{1,100}$/, 'not a valid remote name');
const ALWAYS_PROTECTED = ['main', 'master'];

interface PushPlan {
  root: string;
  remote: string;
  remoteUrl: string;
  rawUrl: string;
  /** Where the remote is fetched from: the repository a pull request is opened on. */
  fetchUrl: string;
  branch: string;
  head: string;
  remoteHead: string | null;
  defaultBranch: string | null;
  commits: Array<{ sha: string; subject: string }>;
  commitCount: number;
  hooks: string[];
}

async function repoRoot(ctx: ToolContext): Promise<string> {
  if (!ctx.project)
    throw new WorkspaceError('unsupported', 'This conversation is not attached to a project.');
  await assertRootAvailable(ctx.project.rootPath);
  await assertRepoRoot(ctx.project.rootPath);
  return ctx.project.rootPath;
}

async function maybe(root: string, args: string[]): Promise<string | null> {
  const r = await runGit(root, args);
  return r.code === 0 ? r.stdout.trim() || null : null;
}

/** What a push of the current branch would do, from local refs only (no network). */
async function pushPlan(root: string, requested: string | undefined): Promise<PushPlan> {
  const status = await repoStatus(root);
  if (!status.head) throw new WorkspaceError('unsupported', 'The repository has no commits yet.');
  const branch = status.branch;
  if (!branch)
    throw new WorkspaceError(
      'unsupported',
      'HEAD is detached. Create a branch with git_create_branch first.',
    );

  const remotes = (await git(root, ['remote'])).split('\n').filter(Boolean);
  const configured = await maybe(root, ['config', '--get', `branch.${branch}.remote`]);
  const remote =
    requested ??
    (configured && remotes.includes(configured) ? configured : null) ??
    (remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0]! : null);
  if (!remote || !remotes.includes(remote))
    throw new WorkspaceError(
      'unsupported',
      remotes.length
        ? `No remote${requested ? ` named "${requested}"` : ' chosen'}. Remotes: ${remotes.join(', ')}.`
        : 'This repository has no remote to push to.',
    );

  const rawUrl = (await git(root, ['remote', 'get-url', '--push', remote])).trim();
  const fetchUrl = (await git(root, ['remote', 'get-url', remote])).trim();
  const defaultBranch =
    (await maybe(root, ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`]))
      ?.slice(remote.length + 1)
      .trim() ?? null;
  assertNotProtected(branch, defaultBranch);

  const remoteHead = await maybe(root, [
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/remotes/${remote}/${branch}^{commit}`,
  ]);
  if (
    remoteHead &&
    (await runGit(root, ['merge-base', '--is-ancestor', remoteHead, 'HEAD'])).code !== 0
  )
    throw new WorkspaceError(
      'unsupported',
      `${remote}/${branch} has commits this branch does not (or its history was rewritten). Friday never force-pushes: pull or rebase first, then try again.`,
    );

  const range = remoteHead ? [`${remoteHead}..HEAD`] : ['HEAD', '--not', `--remotes=${remote}`];
  const commitCount = Number((await git(root, ['rev-list', '--count', ...range])).trim()) || 0;
  const log = await git(root, ['log', '-n', '50', '--format=%H%x00%s', ...range]);
  const commits = log
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [sha, subject] = l.split('\0');
      return { sha: sha!, subject: subject ?? '' };
    });

  // Credential files must not leave the machine, even in commits made outside Friday.
  if (commitCount) {
    const touched = await git(root, ['log', '--format=', '--name-only', '-z', ...range]);
    const secret = [...new Set(touched.split(/[\0\n]/).filter(Boolean))].filter(isSecretPath);
    if (secret.length)
      throw new WorkspaceError(
        'secret_file',
        `Refusing to push: these commits include credential files (${secret.slice(0, 10).join(', ')}). Remove them from the history first.`,
      );
  }

  return {
    root,
    remote,
    remoteUrl: displayRemoteUrl(rawUrl),
    rawUrl,
    fetchUrl,
    branch,
    head: status.head,
    remoteHead,
    defaultBranch,
    commits,
    commitCount,
    hooks: await activeHooks(root, ['pre-push']),
  };
}

function assertNotProtected(branch: string, defaultBranch: string | null): void {
  if (branch === defaultBranch || ALWAYS_PROTECTED.includes(branch))
    throw new WorkspaceError(
      'unsupported',
      `Friday never pushes to ${branch === defaultBranch ? 'the default branch' : branch} (${branch}). Create a feature branch with git_create_branch, commit there, and push that.`,
    );
}

const needsPush = (p: PushPlan) => p.commitCount > 0 || p.remoteHead !== p.head;

// Hashed: the push URL may carry credentials, and fingerprints are stored with the approval.
const planFingerprint = (p: PushPlan) =>
  createHash('sha256')
    .update(JSON.stringify([p.branch, p.head, p.remote, p.rawUrl, p.remoteHead, p.hooks]))
    .digest('hex');

async function push(p: PushPlan, ctx: ToolContext): Promise<string> {
  // An explicit refspec without "+", and no --force of any kind: a non-fast-forward is rejected.
  const r = await runGit(
    p.root,
    [
      'push',
      '--porcelain',
      '--no-follow-tags',
      '--recurse-submodules=no',
      '--set-upstream',
      // The repository's own remote.<name>.receivepack is a program chosen by whoever wrote it.
      '--receive-pack=git-receive-pack',
      p.remote,
      `refs/heads/${p.branch}:refs/heads/${p.branch}`,
    ],
    { credentials: true, allowHooks: true, timeoutMs: 110_000, signal: ctx.signal },
  );
  const out = ctx.redactor.redact(`${r.stdout}\n${r.stderr}`.trim()).slice(0, 4_000);
  if (r.code !== 0) {
    const hint = /rejected|non-fast-forward|fetch first/i.test(out)
      ? '\nThe remote branch has commits this branch does not. Friday never force-pushes: pull or rebase first.'
      : /could not read Username|Authentication failed|Permission denied|terminal prompts disabled/i.test(
            out,
          )
        ? '\nGit could not sign in. Make sure `git push` works in your own terminal (credential helper or ssh key), then try again.'
        : '';
    throw new WorkspaceError('unsupported', `git push failed (exit ${r.code}):\n${out}${hint}`);
  }
  return out;
}

function pushDetails(p: PushPlan) {
  return {
    kind: 'git_remote' as const,
    remote: p.remote,
    remoteUrl: p.remoteUrl,
    branch: p.branch,
    head: p.head,
    remoteHead: p.remoteHead,
    needsPush: needsPush(p),
    commits: p.commits,
    commitCount: p.commitCount,
    hooks: p.hooks,
  };
}

export const gitPush = defineTool({
  name: 'git_push',
  description:
    "Push the current branch to the remote branch of the same name (usually origin) and set it as the upstream. Uses the user's own git sign-in. Never pushes the default branch or main/master and never force-pushes: if the remote branch has other commits, the push fails. Requires the user's approval; they see the destination and the commits.",
  category: 'git',
  risk: 'medium',
  requiresProject: true,
  schema: z.object({
    remote: remoteName
      .optional()
      .describe('Remote name; defaults to the branch upstream or origin.'),
    reason,
  }),
  describeCall: (a) => a.remote ?? '',
  async prepare(args, ctx): Promise<Proposal> {
    const p = await pushPlan(await repoRoot(ctx), args.remote);
    if (!needsPush(p))
      throw new WorkspaceError(
        'unsupported',
        `Nothing to push: ${p.remote}/${p.branch} already has every commit on ${p.branch}.`,
      );
    return {
      title: `Push ${p.branch} to ${p.remote}`,
      summary: `Pushes ${p.commitCount} commit${p.commitCount === 1 ? '' : 's'} on ${p.branch} to ${p.remoteUrl}${p.remoteHead ? '' : ' as a new branch'}, with your own git sign-in. No force push.${p.hooks.length ? ` Repository hooks will run: ${p.hooks.join(', ')}.` : ''}`,
      category: 'git',
      risk: p.hooks.length ? 'high' : 'medium',
      details: { ...pushDetails(p), operation: 'push', pullRequest: null },
      fingerprint: planFingerprint(p),
      timeoutMs: 120_000,
      async apply(execCtx): Promise<ToolOutput> {
        const out = await push(p, execCtx);
        return {
          content: `Pushed ${p.branch} to ${p.remote} (${p.remoteUrl}).\n${out}`,
          summary: `pushed ${p.branch}`,
        };
      },
    };
  },
});

/** The verification section of a pull request description, from Friday's records of this task. */
export function reportSection(report: RunReport): string | null {
  if (report.status === 'no_changes') return null;
  const status = {
    verified: '✅ Verified',
    failed: '❌ Checks failed',
    unverified: '⚠️ Not verified',
  }[report.status];
  const active = report.files.filter((f) => !f.reverted);
  const lines = [
    '## Verification',
    '',
    `${status}: ${report.note}`,
    '',
    `Files changed: ${active.length}`,
  ];
  const checks = report.commands.filter((c) => c.verification);
  if (checks.length) {
    lines.push('', 'Checks run:');
    for (const c of checks.slice(-10))
      lines.push(`- \`${c.title.replace(/`/g, "'")}\`: ${c.exitCode === 0 ? 'passed' : c.result}`);
  }
  lines.push('', '_Generated by Friday from its records of this task, not by the model._');
  return lines.join('\n');
}

/**
 * The report for a pull request: from the newest run in this conversation that made one of the
 * branch's commits (often the run before the one asked to open the pull request), else this
 * run's own if it changed files.
 */
async function prReport(p: PushPlan, base: string, ctx: ToolContext): Promise<string | null> {
  const reports = ctx.sessionReports?.() ?? [];
  if (!reports.length) return null;
  const baseRef = `refs/remotes/${p.remote}/${base}`;
  const range = (await maybe(p.root, ['rev-parse', '--verify', '--quiet', baseRef]))
    ? [`${baseRef}..HEAD`]
    : ['HEAD', '--not', `--remotes=${p.remote}`];
  const shas = (await git(p.root, ['rev-list', '--max-count=500', ...range]))
    .split('\n')
    .filter(Boolean);
  const inBranch = (commit: string) => {
    const sha = commit.split(' ')[0] ?? '';
    return sha.length >= 7 && shas.some((s) => s.startsWith(sha));
  };
  const chosen =
    reports.find((r) => r.status !== 'no_changes' && r.commits.some(inBranch)) ??
    (reports[0]!.status !== 'no_changes' ? reports[0]! : null);
  return chosen ? reportSection(chosen) : null;
}

async function ghReady(repo: GitHubRepo, signal: AbortSignal): Promise<void> {
  const auth = await runGh(['auth', 'status', '--hostname', repo.host], {
    signal,
    timeoutMs: 20_000,
  });
  if (auth.code !== 0)
    throw new WorkspaceError(
      'unsupported',
      repo.host === 'github.com'
        ? 'The GitHub CLI (gh) is not signed in. Run `gh auth login` in a terminal, then try again.'
        : `${repo.host} is not a GitHub host the GitHub CLI (gh) is signed in to. Pull requests need GitHub; for GitHub Enterprise run \`gh auth login --hostname ${repo.host}\`.`,
    );
}

export const createPullRequest = defineTool({
  name: 'create_pull_request',
  description:
    "Open a GitHub pull request for the current branch, pushing it first if the remote does not have every commit yet (same rules as git_push: never the default branch, never force). Uses the user's own gh sign-in. Write a clear title and a description of what changed and why; Friday appends a verification section from its own records of this task. Requires the user's approval; they see the exact title and description.",
  category: 'git',
  risk: 'medium',
  requiresProject: true,
  schema: z.object({
    title: z.string().trim().min(3).max(256),
    body: z.string().max(20_000).describe('Markdown description.'),
    base: z
      .string()
      .regex(/^(?!-)[A-Za-z0-9._/-]{1,200}$/, 'not a valid branch name')
      .optional()
      .describe("Branch to merge into; defaults to the repository's default branch."),
    draft: z.boolean().default(false),
    remote: remoteName.optional(),
    reason,
  }),
  describeCall: (a) => a.title ?? '',
  async prepare(args, ctx): Promise<Proposal> {
    const p = await pushPlan(await repoRoot(ctx), args.remote);
    const repo = githubRepo(p.fetchUrl);
    if (!repo)
      throw new WorkspaceError(
        'unsupported',
        `The remote ${p.remote} (${displayRemoteUrl(p.fetchUrl)}) is not a GitHub repository URL; pull requests need GitHub.`,
      );
    await ghReady(repo, ctx.signal);

    const view = await runGh(['repo', 'view', repoArg(repo), '--json', 'defaultBranchRef'], {
      signal: ctx.signal,
      timeoutMs: 30_000,
    });
    if (view.code !== 0)
      throw new WorkspaceError(
        'unsupported',
        `gh could not open ${repoArg(repo)}: ${ctx.redactor.redact(view.stderr.trim()).slice(0, 500)}`,
      );
    const defaultBranch =
      (JSON.parse(view.stdout) as { defaultBranchRef?: { name?: string } }).defaultBranchRef
        ?.name ?? p.defaultBranch;
    assertNotProtected(p.branch, defaultBranch);
    const base = args.base ?? defaultBranch;
    if (!base)
      throw new WorkspaceError('unsupported', 'Could not tell the base branch; pass `base`.');
    if (base === p.branch)
      throw new WorkspaceError('unsupported', 'The base branch is the branch itself.');

    const existing = await runGh(
      [
        'pr',
        'list',
        '--repo',
        repoArg(repo),
        '--head',
        p.branch,
        '--state',
        'open',
        '--json',
        'url',
      ],
      { signal: ctx.signal, timeoutMs: 30_000 },
    );
    const open =
      existing.code === 0 ? (JSON.parse(existing.stdout || '[]') as Array<{ url: string }>) : [];
    if (open.length)
      throw new WorkspaceError(
        'unsupported',
        `A pull request for ${p.branch} is already open: ${open[0]!.url}. Pushing new commits to the branch (git_push) updates it.`,
      );

    const report = await prReport(p, base, ctx);
    const body = [args.body.trim(), report].filter(Boolean).join('\n\n');
    const pr = { repo: repoArg(repo), base, title: args.title, body, draft: args.draft };
    const willPush = needsPush(p);
    return {
      title: `Open pull request: ${args.title}`,
      summary: `${willPush ? `Pushes ${p.branch} to ${p.remote}, then opens` : 'Opens'} a${args.draft ? ' draft' : ''} pull request on ${pr.repo} from ${p.branch} into ${base}, with your own gh sign-in. Everyone with access to the repository can see it.`,
      category: 'git',
      risk: p.hooks.length && willPush ? 'high' : 'medium',
      details: {
        ...pushDetails(p),
        hooks: willPush ? p.hooks : [],
        operation: 'pull_request',
        pullRequest: pr,
      },
      fingerprint: createHash('sha256')
        .update(JSON.stringify([planFingerprint(p), pr]))
        .digest('hex'),
      timeoutMs: 180_000,
      async apply(execCtx): Promise<ToolOutput> {
        const pushed = willPush ? await push(p, execCtx) : null;
        const r = await runGh(
          [
            'pr',
            'create',
            '--repo',
            pr.repo,
            '--head',
            p.branch,
            '--base',
            base,
            '--title',
            pr.title,
            '--body-file',
            '-',
            ...(pr.draft ? ['--draft'] : []),
          ],
          { input: body, signal: execCtx.signal, timeoutMs: 60_000 },
        );
        if (r.code !== 0)
          throw new WorkspaceError(
            'unsupported',
            `${pushed !== null ? `Pushed ${p.branch}, but ` : ''}gh pr create failed (exit ${r.code}): ${execCtx.redactor.redact(`${r.stderr}\n${r.stdout}`.trim()).slice(0, 2_000)}`,
          );
        const url = /https?:\/\/\S+/.exec(r.stdout)?.[0] ?? r.stdout.trim();
        return {
          content: `${pushed !== null ? `Pushed ${p.branch} to ${p.remote}.\n` : ''}Opened pull request: ${url}`,
          summary: `opened ${url.replace(/^https?:\/\/[^/]+\//, '')}`,
        };
      },
    };
  },
});
