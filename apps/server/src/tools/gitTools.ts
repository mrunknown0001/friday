import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FileChangePreview } from '@friday/shared';
import { z } from 'zod';
import {
  activeHooks,
  assertRepoRoot,
  COMMIT_HOOKS,
  hideSecretDiffs,
  parseStatus,
  REF_PATTERN,
  repoStatus,
  runGit,
  SAFE_CONFIG,
  type GitResult,
  type RepoStatus,
} from '../git/git.js';
import { remoteFor } from '../workspace/projectAccess.js';
import type { RemoteWorkspace } from '../workspace/remote.js';
import { looksBinary } from '../workspace/files.js';
import { assertRootAvailable, isSecretPath, WorkspaceError } from '../workspace/paths.js';
import { makeDiff } from './fileTools.js';
import { defineTool, type Proposal, type ToolContext } from './types.js';

const ref = z.string().regex(REF_PATTERN, 'not a valid git revision');
const relPath = z.string().min(1).max(1024);
const DIFF_FLAGS = ['--no-ext-diff', '--no-textconv', '--no-color'];

type GitOpts = { signal?: AbortSignal; timeoutMs?: number; allowHooks?: boolean };

/**
 * The project's repository, on this machine or in the project folder on its SSH host. Either way
 * git runs with Friday's safe settings and only when the project root is the repository root.
 */
interface Repo {
  root: string;
  /** Path rules of the machine the repository is on. */
  paths: typeof path.posix;
  run(args: string[], opts?: GitOpts): Promise<GitResult>;
  status(pathspecs?: string[]): Promise<RepoStatus>;
  hooks(): Promise<string[]>;
  /** An untracked file's bytes for the commit preview: null if not a regular file or too big. */
  untracked(rel: string): Promise<Buffer | null>;
}

const MAX_PREVIEW_BYTES = 1024 * 1024;

async function repoFor(ctx: ToolContext): Promise<Repo> {
  if (!ctx.project)
    throw new WorkspaceError('unsupported', 'This conversation is not attached to a project.');
  const remote = remoteFor(ctx.project, ctx.devops);
  if (remote) return remoteRepo(remote);
  const root = ctx.project.rootPath;
  await assertRootAvailable(root);
  await assertRepoRoot(root);
  return {
    root,
    paths: path,
    run: (args, opts) => runGit(root, args, opts),
    status: (specs) => repoStatus(root, specs),
    hooks: () => activeHooks(root),
    async untracked(rel) {
      // Never follow symlinks while previewing: the link target may be outside the project.
      const abs = path.join(root, rel);
      const stat = await fs.lstat(abs).catch(() => null);
      if (!stat?.isFile() || stat.size > MAX_PREVIEW_BYTES) return null;
      return fs.readFile(abs).catch(() => null);
    },
  };
}

async function remoteRepo(remote: RemoteWorkspace): Promise<Repo> {
  const run = async (args: string[], opts: GitOpts = {}): Promise<GitResult> => {
    const r = await remote.git(
      [...SAFE_CONFIG, ...(opts.allowHooks ? [] : ['-c', 'core.hooksPath=/dev/null']), ...args],
      { ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}), signal: opts.signal },
    );
    return { code: r.code ?? 1, stdout: r.stdout, stderr: r.stderr };
  };
  const top = await run(['rev-parse', '--show-toplevel']);
  if (top.code !== 0)
    throw new WorkspaceError('unsupported', 'This project is not a git repository.');
  if (top.stdout.trim() !== remote.root) {
    throw new WorkspaceError(
      'unsupported',
      `The project folder is inside a larger git repository (top level: ${top.stdout.trim()}). Git tools only work when the project root is the repository root.`,
    );
  }
  return {
    root: remote.root,
    paths: path.posix,
    run,
    async status(specs = []) {
      const r = await run([
        'status',
        '--porcelain=v2',
        '--branch',
        '-z',
        '--untracked-files=all',
        '--',
        ...specs,
      ]);
      if (r.code !== 0) throw gitFailure('status', r);
      return parseStatus(r.stdout);
    },
    hooks: () => remote.gitHooks(COMMIT_HOOKS),
    async untracked(rel) {
      const f = await remote.readFile(rel, MAX_PREVIEW_BYTES).catch(() => null);
      return f?.buf ?? null;
    },
  };
}

const gitFailure = (what: string, r: GitResult) =>
  new WorkspaceError(
    'unsupported',
    `git ${what} failed: ${(r.stderr.trim() || r.stdout.trim()).split('\n')[0] ?? `exit ${r.code}`}`,
  );

/** git that throws on failure, returning stdout. */
async function git(repo: Repo, args: string[], opts?: GitOpts): Promise<string> {
  const r = await repo.run(args, opts);
  if (r.code !== 0) throw gitFailure(args[0] ?? '', r);
  return r.stdout;
}

/** Pathspecs from the model must stay inside the project. */
function pathspec(repo: Repo, p: string): string {
  if (p.includes('\0') || p.startsWith(':') || p.startsWith('-')) {
    throw new WorkspaceError('invalid_path', `Invalid path "${p}".`);
  }
  const abs = repo.paths.resolve(repo.root, p);
  const rel = repo.paths.relative(repo.root, abs);
  if (rel.startsWith('..') || repo.paths.isAbsolute(rel))
    throw new WorkspaceError('outside_root', `Path "${p}" is outside the project root.`);
  return rel || '.';
}

function describeStatus(s: RepoStatus): string {
  const lines = [
    `Branch: ${s.branch ?? `(detached at ${s.head?.slice(0, 8) ?? 'no commits'})`}` +
      (s.upstream ? ` → ${s.upstream} (ahead ${s.ahead}, behind ${s.behind})` : ' (no upstream)'),
    `HEAD: ${s.head?.slice(0, 12) ?? '(no commits yet)'}`,
  ];
  const staged = s.entries.filter((e) => !e.untracked && e.xy[0] !== '.');
  const unstaged = s.entries.filter((e) => !e.untracked && e.xy[1] !== '.');
  const untracked = s.entries.filter((e) => e.untracked);
  const fmt = (e: (typeof s.entries)[number], code: string) =>
    `  ${code} ${e.origPath ? `${e.origPath} -> ` : ''}${e.path}`;
  if (!staged.length && !unstaged.length && !untracked.length) lines.push('Working tree clean.');
  if (staged.length) lines.push('Staged:', ...staged.map((e) => fmt(e, e.xy[0]!)));
  if (unstaged.length) lines.push('Not staged:', ...unstaged.map((e) => fmt(e, e.xy[1]!)));
  if (untracked.length)
    lines.push('Untracked:', ...untracked.slice(0, 200).map((e) => fmt(e, '?')));
  return lines.join('\n');
}

export const gitStatus = defineTool({
  name: 'git_status',
  description:
    'Show the current branch, upstream ahead/behind counts, and staged, unstaged and untracked files.',
  category: 'read_only',
  risk: 'none',
  requiresProject: true,
  remote: true,
  schema: z.object({}),
  describeCall: () => '',
  async execute(_args, ctx) {
    const repo = await repoFor(ctx);
    const s = await repo.status();
    const changed = s.entries.length;
    return {
      content: describeStatus(s),
      summary: `${s.branch ?? 'detached'}: ${changed ? `${changed} changed file${changed === 1 ? '' : 's'}` : 'clean'}`,
    };
  },
});

export const gitDiff = defineTool({
  name: 'git_diff',
  description:
    'Show a unified diff. Default: unstaged changes in the working tree. staged=true: what is staged. ref: compare the working tree with a revision (e.g. "HEAD", "main"). Use stat_only for an overview first. Credential files are hidden.',
  category: 'read_only',
  risk: 'none',
  requiresProject: true,
  remote: true,
  schema: z.object({
    staged: z.boolean().default(false),
    ref: ref.optional(),
    path: relPath.optional(),
    stat_only: z.boolean().default(false),
  }),
  describeCall: (a) =>
    [a.staged ? '--staged' : '', a.ref ?? '', a.path ?? '', a.stat_only ? '--stat' : '']
      .filter(Boolean)
      .join(' '),
  async execute(args, ctx) {
    const repo = await repoFor(ctx);
    const out = await git(repo, [
      'diff',
      ...DIFF_FLAGS,
      ...(args.staged ? ['--cached'] : []),
      ...(args.stat_only ? ['--stat'] : []),
      '--end-of-options',
      ...(args.ref ? [args.ref] : []),
      '--',
      ...(args.path ? [pathspec(repo, args.path)] : []),
    ]);
    const shown = args.stat_only ? out : hideSecretDiffs(out);
    const files = (shown.match(/^diff --git /gm) ?? []).length;
    return {
      content: shown.trim() || 'No differences.',
      summary: shown.trim()
        ? args.stat_only
          ? shown.trim().split('\n').at(-1)!.trim()
          : `${files} file${files === 1 ? '' : 's'} changed`
        : 'no differences',
    };
  },
});

export const gitLog = defineTool({
  name: 'git_log',
  description:
    'List recent commits (hash, author, date, subject), optionally for a path or starting from a revision.',
  category: 'read_only',
  risk: 'none',
  requiresProject: true,
  remote: true,
  schema: z.object({
    max_count: z.number().int().min(1).max(100).default(20),
    ref: ref.optional(),
    path: relPath.optional(),
  }),
  describeCall: (a) =>
    [a.ref ?? '', a.path ?? '', `-n ${a.max_count ?? 20}`].filter(Boolean).join(' '),
  async execute(args, ctx) {
    const repo = await repoFor(ctx);
    const r = await repo.run([
      'log',
      '--no-color',
      '--date=short',
      '--pretty=format:%h  %ad  %an  %s',
      `--max-count=${args.max_count}`,
      '--end-of-options',
      ...(args.ref ? [args.ref] : []),
      '--',
      ...(args.path ? [pathspec(repo, args.path)] : []),
    ]);
    if (r.code !== 0) {
      if (/does not have any commits/.test(r.stderr))
        return { content: 'No commits yet.', summary: 'no commits' };
      throw new WorkspaceError('unsupported', `git log failed: ${r.stderr.trim().split('\n')[0]}`);
    }
    const n = r.stdout.trim() ? r.stdout.trim().split('\n').length : 0;
    return {
      content: r.stdout.trim() || 'No commits.',
      summary: `${n} commit${n === 1 ? '' : 's'}`,
    };
  },
});

export const gitShow = defineTool({
  name: 'git_show',
  description:
    'Show one commit: metadata, changed-file stats, and (unless stat_only) its patch. Credential files are hidden.',
  category: 'read_only',
  risk: 'none',
  requiresProject: true,
  remote: true,
  schema: z.object({ ref, stat_only: z.boolean().default(false) }),
  describeCall: (a) => a.ref,
  async execute(args, ctx) {
    const repo = await repoFor(ctx);
    // Only commits: a blob id (e.g. of a committed .env) would print the file as-is.
    const commit = (
      await git(repo, ['rev-parse', '--verify', '--end-of-options', `${args.ref}^{commit}`])
    ).trim();
    const out = await git(repo, [
      'show',
      ...DIFF_FLAGS,
      '--format=fuller',
      '--stat',
      ...(args.stat_only ? [] : ['--patch']),
      '--end-of-options',
      commit,
    ]);
    const subject = /^\s{4}(.+)$/m.exec(out)?.[1] ?? args.ref;
    return { content: hideSecretDiffs(out), summary: subject.slice(0, 80) };
  },
});

export const gitBranches = defineTool({
  name: 'git_branches',
  description: 'List local and remote-tracking branches with their latest commit and upstream.',
  category: 'read_only',
  risk: 'none',
  requiresProject: true,
  remote: true,
  schema: z.object({}),
  describeCall: () => '',
  async execute(_args, ctx) {
    const repo = await repoFor(ctx);
    const out = await git(repo, ['branch', '--all', '--no-color', '-vv']);
    const n = out.trim() ? out.trim().split('\n').length : 0;
    return {
      content: out.trim() || 'No branches yet.',
      summary: `${n} branch${n === 1 ? '' : 'es'}`,
    };
  },
});

// ------------------------------------------------------------------ mutations (approval required)

const reason = z.string().min(3).max(500).describe('Why this is needed. Shown to the user.');

async function commitPreview(
  repo: Repo,
  files: RepoStatus['entries'],
): Promise<FileChangePreview[]> {
  const previews: FileChangePreview[] = [];
  for (const e of files.slice(0, 50)) {
    if (e.untracked) {
      const buf = await repo.untracked(e.path);
      if (!buf) {
        previews.push({ path: e.path, change: 'create', diff: '', added: 0, removed: 0 });
        continue;
      }
      previews.push(
        looksBinary(buf)
          ? { path: e.path, change: 'create', diff: '', added: 0, removed: 0 }
          : makeDiff(e.path, '', buf.toString('utf8'), 'create'),
      );
      continue;
    }
    const patch = await git(repo, ['diff', ...DIFF_FLAGS, 'HEAD', '--', e.path]).catch(() => '');
    let added = 0;
    let removed = 0;
    for (const line of patch.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) added++;
      else if (line.startsWith('-') && !line.startsWith('---')) removed++;
    }
    const change = e.xy.includes('D')
      ? 'delete'
      : e.xy.includes('R')
        ? 'move'
        : e.xy.includes('A')
          ? 'create'
          : 'modify';
    previews.push({
      path: e.path,
      change,
      ...(e.origPath ? { fromPath: e.origPath } : {}),
      diff: patch.slice(0, 100_000),
      added,
      removed,
    });
  }
  return previews;
}

export const gitCommit = defineTool({
  name: 'git_commit',
  description:
    "Commit specific paths (files or folders, relative to the project root) with a message. Only these paths are committed, using their current working-tree content; other staged changes are left alone. Requires the user's approval; they see the exact files and diffs. Repository hooks (e.g. pre-commit) will run. Never use this to commit credential files.",
  category: 'git',
  risk: 'medium',
  requiresProject: true,
  remote: true,
  schema: z.object({
    message: z.string().trim().min(3).max(5_000),
    paths: z.array(relPath).min(1).max(200),
    reason,
  }),
  describeCall: (a) => (a.message ?? '').split('\n')[0]!.slice(0, 80),
  async prepare(args, ctx): Promise<Proposal> {
    const repo = await repoFor(ctx);
    const specs = args.paths.map((p) => pathspec(repo, p));
    const status = await repo.status();
    const inScope = (await repo.status(specs)).entries;
    if (inScope.length === 0)
      throw new WorkspaceError('unsupported', 'None of these paths have changes to commit.');
    const secret = inScope.filter(
      (e) => isSecretPath(e.path) || (e.origPath && isSecretPath(e.origPath)),
    );
    if (secret.length) {
      throw new WorkspaceError(
        'secret_file',
        `Refusing to commit credential files: ${secret.map((e) => e.path).join(', ')}. Add them to .gitignore instead.`,
      );
    }
    const files = await commitPreview(repo, inScope);
    const hooks = await repo.hooks();
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ head: status.head, branch: status.branch, files }))
      .digest('hex');
    return {
      title: `Commit ${inScope.length} file${inScope.length === 1 ? '' : 's'} to ${status.branch ?? 'detached HEAD'}`,
      summary: `Stages and commits only the listed paths on ${status.branch ?? 'a detached HEAD'}. Nothing is pushed.${hooks.length ? ` Repository hooks will run: ${hooks.join(', ')}.` : ''}`,
      category: 'git',
      risk: status.branch === null || hooks.length ? 'high' : 'medium',
      details: {
        kind: 'git',
        operation: 'commit',
        branch: status.branch,
        head: status.head,
        message: args.message,
        newBranch: null,
        files,
        hooks,
      },
      fingerprint,
      timeoutMs: 120_000,
      async apply(execCtx) {
        await git(repo, ['add', '--', ...specs], { signal: execCtx.signal });
        const r = await repo.run(['commit', '--only', '-m', args.message, '--', ...specs], {
          allowHooks: true,
          timeoutMs: 110_000,
          signal: execCtx.signal,
        });
        if (r.code !== 0) {
          const out = `${r.stdout}\n${r.stderr}`.trim();
          throw new WorkspaceError(
            'unsupported',
            `git commit failed (exit ${r.code}):\n${out.slice(0, 4_000)}`,
          );
        }
        const sha = (await git(repo, ['rev-parse', '--short', 'HEAD'])).trim();
        return {
          content: `Committed ${sha} on ${status.branch ?? 'detached HEAD'}: ${args.message.split('\n')[0]}\n${r.stdout.trim()}`,
          summary: `committed ${sha}`,
        };
      },
    };
  },
});

export const gitCreateBranch = defineTool({
  name: 'git_create_branch',
  description:
    'Create a new branch at the current commit and (by default) switch to it. Uncommitted changes are kept. Requires approval.',
  category: 'git',
  risk: 'low',
  requiresProject: true,
  remote: true,
  schema: z.object({
    name: z.string().min(1).max(200),
    checkout: z.boolean().default(true),
    reason,
  }),
  describeCall: (a) => a.name,
  async prepare(args, ctx): Promise<Proposal> {
    const repo = await repoFor(ctx);
    if (
      args.name.startsWith('-') ||
      (await repo.run(['check-ref-format', '--branch', args.name])).code !== 0
    ) {
      throw new WorkspaceError('invalid_path', `"${args.name}" is not a valid branch name.`);
    }
    if (
      (await repo.run(['rev-parse', '--verify', '--quiet', `refs/heads/${args.name}`])).code === 0
    ) {
      throw new WorkspaceError('unsupported', `Branch "${args.name}" already exists.`);
    }
    const status = await repo.status();
    if (!status.head) throw new WorkspaceError('unsupported', 'The repository has no commits yet.');
    return {
      title: `${args.checkout ? 'Create and switch to' : 'Create'} branch ${args.name}`,
      summary: `Creates branch ${args.name} at ${status.head.slice(0, 8)}${status.branch ? ` (from ${status.branch})` : ''}${args.checkout ? ' and switches to it; uncommitted changes stay in the working tree' : ''}. Nothing is pushed.`,
      category: 'git',
      risk: 'low',
      details: {
        kind: 'git',
        operation: 'create_branch',
        branch: status.branch,
        head: status.head,
        message: null,
        newBranch: args.name,
        files: [],
        hooks: [],
      },
      fingerprint: `${status.head}|${status.branch}`,
      async apply(execCtx) {
        await git(repo, args.checkout ? ['switch', '-c', args.name] : ['branch', args.name], {
          signal: execCtx.signal,
        });
        return {
          content: `Created branch ${args.name}${args.checkout ? ' and switched to it' : ''}.`,
          summary: `branch ${args.name}`,
        };
      },
    };
  },
});
