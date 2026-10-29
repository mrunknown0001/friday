import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { childEnv } from '../commands/runner.js';
import { isSecretPath, WorkspaceError } from '../workspace/paths.js';

/**
 * Settings applied to every git invocation. A repository's own config is untrusted: options such
 * as core.fsmonitor, diff/textconv drivers, and pagers can make even read-only commands execute
 * programs chosen by whoever wrote the repo. These overrides (plus --no-ext-diff/--no-textconv on
 * diff-producing commands) keep inspection from running repository-defined programs.
 */
const SAFE_CONFIG = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.pager=cat',
  '-c',
  'core.sshCommand=false',
  '-c',
  'credential.helper=',
  '-c',
  'color.ui=false',
  '-c',
  'log.showSignature=false',
  '-c',
  'diff.noprefix=false',
];

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

const MAX_BUFFER = 4 * 1024 * 1024;

export function runGit(
  cwd: string,
  args: string[],
  opts: { timeoutMs?: number; signal?: AbortSignal; allowHooks?: boolean } = {},
): Promise<GitResult> {
  const config = opts.allowHooks ? SAFE_CONFIG : [...SAFE_CONFIG, '-c', 'core.hooksPath=/dev/null'];
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...config, ...args],
      {
        cwd,
        env: {
          ...childEnv(),
          GIT_OPTIONAL_LOCKS: '0', // status must not write the index lock
          GIT_TERMINAL_PROMPT: '0',
          GIT_PAGER: 'cat',
          LC_ALL: 'C',
        },
        timeout: opts.timeoutMs ?? 20_000,
        maxBuffer: MAX_BUFFER,
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
      (err, stdout, stderr) => {
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          return reject(new WorkspaceError('unsupported', 'git is not installed.'));
        }
        if (err && typeof (err as { code?: unknown }).code !== 'number') {
          return reject(
            new WorkspaceError('unsupported', `git failed: ${err.message.split('\n')[0]}`),
          );
        }
        resolve({ code: err ? Number((err as { code?: number }).code) : 0, stdout, stderr });
      },
    );
  });
}

/** Run git and throw a readable error on a non-zero exit. */
export async function git(
  cwd: string,
  args: string[],
  opts: Parameters<typeof runGit>[2] = {},
): Promise<string> {
  const r = await runGit(cwd, args, opts);
  if (r.code !== 0) {
    const msg = (r.stderr || r.stdout).trim().split('\n').slice(0, 3).join(' ');
    throw new WorkspaceError('unsupported', `git ${args[0]} failed: ${msg || `exit ${r.code}`}`);
  }
  return r.stdout;
}

/**
 * Git tools only operate when the project root is the repository's top level, so git can never
 * report on (or commit) files outside the authorized folder.
 */
export async function assertRepoRoot(root: string): Promise<void> {
  const r = await runGit(root, ['rev-parse', '--show-toplevel']);
  if (r.code !== 0)
    throw new WorkspaceError('unsupported', 'This project is not a git repository.');
  const top = await fs.realpath(r.stdout.trim()).catch(() => r.stdout.trim());
  if (top !== root) {
    throw new WorkspaceError(
      'unsupported',
      `The project folder is inside a larger git repository (top level: ${path.basename(top)}). Git tools only work when the project root is the repository root.`,
    );
  }
}

/** Refs and revisions from the model: no option injection, no shell metacharacters. */
export const REF_PATTERN = /^(?!-)[A-Za-z0-9._/@{}~^:-]{1,200}$/;

/**
 * Remove the per-file sections of a diff/patch that belong to credential files, keeping a
 * placeholder so the model knows the file changed.
 */
export function hideSecretDiffs(patch: string): string {
  const parts = patch.split(/(?=^diff --git )/m);
  return parts
    .map((part) => {
      const m = /^diff --git a\/(.+?) b\/(.+?)$/m.exec(part);
      if (m && (isSecretPath(m[1]!) || isSecretPath(m[2]!))) {
        return `diff --git a/${m[1]} b/${m[2]}\n[changes to a credential file are hidden]\n`;
      }
      return part;
    })
    .join('');
}

export interface StatusEntry {
  path: string;
  origPath?: string;
  /** Two-letter XY status: index (staged) then worktree. '?' for untracked. */
  xy: string;
  untracked: boolean;
}

export interface RepoStatus {
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  entries: StatusEntry[];
}

/** Parse `git status --porcelain=v2 --branch -z`. */
export function parseStatus(out: string): RepoStatus {
  const status: RepoStatus = {
    branch: null,
    head: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    entries: [],
  };
  const fields = out.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]!;
    if (!f) continue;
    if (f.startsWith('# branch.oid ')) {
      const oid = f.slice(13);
      status.head = oid === '(initial)' ? null : oid;
    } else if (f.startsWith('# branch.head ')) {
      const head = f.slice(14);
      status.branch = head === '(detached)' ? null : head;
    } else if (f.startsWith('# branch.upstream ')) {
      status.upstream = f.slice(18);
    } else if (f.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(f);
      if (m) {
        status.ahead = Number(m[1]);
        status.behind = Number(m[2]);
      }
    } else if (f.startsWith('1 ') || f.startsWith('u ')) {
      const parts = f.split(' ');
      status.entries.push({
        xy: parts[1]!,
        path: parts.slice(f.startsWith('1 ') ? 8 : 10).join(' '),
        untracked: false,
      });
    } else if (f.startsWith('2 ')) {
      const parts = f.split(' ');
      status.entries.push({
        xy: parts[1]!,
        path: parts.slice(9).join(' '),
        origPath: fields[++i],
        untracked: false,
      });
    } else if (f.startsWith('? ')) {
      status.entries.push({ xy: '??', path: f.slice(2), untracked: true });
    }
  }
  return status;
}

export async function repoStatus(root: string, pathspecs: string[] = []): Promise<RepoStatus> {
  const out = await git(root, [
    'status',
    '--porcelain=v2',
    '--branch',
    '-z',
    '--untracked-files=all',
    '--',
    ...pathspecs,
  ]);
  return parseStatus(out);
}

/** Active hook scripts git would run on commit (non-sample files in the hooks directory). */
export async function activeHooks(root: string): Promise<string[]> {
  const configured = (await runGit(root, ['config', '--get', 'core.hooksPath'])).stdout.trim();
  const dir = configured ? path.resolve(root, configured) : path.join(root, '.git', 'hooks');
  try {
    const names = await fs.readdir(dir);
    return names.filter(
      (n) =>
        !n.endsWith('.sample') &&
        ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit'].includes(n),
    );
  } catch {
    return [];
  }
}
