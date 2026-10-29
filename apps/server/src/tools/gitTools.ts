import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FileChangePreview } from '@friday/shared';
import { z } from 'zod';
import {
  activeHooks,
  assertRepoRoot,
  git,
  hideSecretDiffs,
  REF_PATTERN,
  repoStatus,
  runGit,
  type RepoStatus,
} from '../git/git.js';
import { looksBinary } from '../workspace/files.js';
import { assertRootAvailable, isSecretPath, isWithin, WorkspaceError } from '../workspace/paths.js';
import { makeDiff } from './fileTools.js';
import { defineTool, type Proposal, type ToolContext } from './types.js';

const ref = z.string().regex(REF_PATTERN, 'not a valid git revision');
const relPath = z.string().min(1).max(1024);
const DIFF_FLAGS = ['--no-ext-diff', '--no-textconv', '--no-color'];

async function repoRoot(ctx: ToolContext): Promise<string> {
  if (!ctx.project)
    throw new WorkspaceError('unsupported', 'This conversation is not attached to a project.');
  await assertRootAvailable(ctx.project.rootPath);
  await assertRepoRoot(ctx.project.rootPath);
  return ctx.project.rootPath;
}

/** Pathspecs from the model must stay inside the project. */
function pathspec(root: string, p: string): string {
  if (p.includes('\0') || p.startsWith(':') || p.startsWith('-')) {
    throw new WorkspaceError('invalid_path', `Invalid path "${p}".`);
  }
  const abs = path.resolve(root, p);
  if (!isWithin(root, abs))
    throw new WorkspaceError('outside_root', `Path "${p}" is outside the project root.`);
  return path.relative(root, abs) || '.';
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
  schema: z.object({}),
  describeCall: () => '',
  async execute(_args, ctx) {
    const root = await repoRoot(ctx);
    const s = await repoStatus(root);
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
    const root = await repoRoot(ctx);
    const out = await git(root, [
      'diff',
      ...DIFF_FLAGS,
      ...(args.staged ? ['--cached'] : []),
      ...(args.stat_only ? ['--stat'] : []),
      '--end-of-options',
      ...(args.ref ? [args.ref] : []),
      '--',
      ...(args.path ? [pathspec(root, args.path)] : []),
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
  schema: z.object({
    max_count: z.number().int().min(1).max(100).default(20),
    ref: ref.optional(),
    path: relPath.optional(),
  }),
  describeCall: (a) =>
    [a.ref ?? '', a.path ?? '', `-n ${a.max_count ?? 20}`].filter(Boolean).join(' '),
  async execute(args, ctx) {
    const root = await repoRoot(ctx);
    const r = await runGit(root, [
      'log',
      '--no-color',
      '--date=short',
      '--pretty=format:%h  %ad  %an  %s',
      `--max-count=${args.max_count}`,
      '--end-of-options',
      ...(args.ref ? [args.ref] : []),
      '--',
      ...(args.path ? [pathspec(root, args.path)] : []),
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
  schema: z.object({ ref, stat_only: z.boolean().default(false) }),
  describeCall: (a) => a.ref,
  async execute(args, ctx) {
    const root = await repoRoot(ctx);
    const out = await git(root, [
      'show',
      ...DIFF_FLAGS,
      '--format=fuller',
      '--stat',
      ...(args.stat_only ? [] : ['--patch']),
      '--end-of-options',
      args.ref,
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
  schema: z.object({}),
  describeCall: () => '',
  async execute(_args, ctx) {
    const root = await repoRoot(ctx);
    const out = await git(root, ['branch', '--all', '--no-color', '-vv']);
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
  root: string,
  files: RepoStatus['entries'],
): Promise<FileChangePreview[]> {
  const previews: FileChangePreview[] = [];
  for (const e of files.slice(0, 50)) {
    if (e.untracked) {
      // Never follow symlinks while previewing: the link target may be outside the project.
      const abs = path.join(root, e.path);
      const stat = await fs.lstat(abs).catch(() => null);
      if (!stat?.isFile() || stat.size > 1024 * 1024) {
        previews.push({ path: e.path, change: 'create', diff: '', added: 0, removed: 0 });
        continue;
      }
      const buf = await fs.readFile(abs).catch(() => Buffer.from(''));
      previews.push(
        looksBinary(buf)
          ? { path: e.path, change: 'create', diff: '', added: 0, removed: 0 }
          : makeDiff(e.path, '', buf.toString('utf8'), 'create'),
      );
      continue;
    }
    const patch = await git(root, ['diff', ...DIFF_FLAGS, 'HEAD', '--', e.path]).catch(() => '');
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
  schema: z.object({
    message: z.string().trim().min(3).max(5_000),
    paths: z.array(relPath).min(1).max(200),
    reason,
  }),
  describeCall: (a) => (a.message ?? '').split('\n')[0]!.slice(0, 80),
  async prepare(args, ctx): Promise<Proposal> {
    const root = await repoRoot(ctx);
    const specs = args.paths.map((p) => pathspec(root, p));
    const status = await repoStatus(root);
    const inScope = (await repoStatus(root, specs)).entries;
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
    const files = await commitPreview(root, inScope);
    const hooks = await activeHooks(root);
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
        await git(root, ['add', '--', ...specs], { signal: execCtx.signal });
        const r = await runGit(root, ['commit', '--only', '-m', args.message, '--', ...specs], {
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
        const sha = (await git(root, ['rev-parse', '--short', 'HEAD'])).trim();
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
  schema: z.object({
    name: z.string().min(1).max(200),
    checkout: z.boolean().default(true),
    reason,
  }),
  describeCall: (a) => a.name,
  async prepare(args, ctx): Promise<Proposal> {
    const root = await repoRoot(ctx);
    if (
      args.name.startsWith('-') ||
      (await runGit(root, ['check-ref-format', '--branch', args.name])).code !== 0
    ) {
      throw new WorkspaceError('invalid_path', `"${args.name}" is not a valid branch name.`);
    }
    if (
      (await runGit(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${args.name}`])).code ===
      0
    ) {
      throw new WorkspaceError('unsupported', `Branch "${args.name}" already exists.`);
    }
    const status = await repoStatus(root);
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
        await git(root, args.checkout ? ['switch', '-c', args.name] : ['branch', args.name], {
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
