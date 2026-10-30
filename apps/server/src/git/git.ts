import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { childEnv } from '../commands/runner.js';
import { isGitInternal, isSecretPath, WorkspaceError } from '../workspace/paths.js';

/**
 * Settings applied to every git invocation. A repository's own config is untrusted: options such
 * as core.fsmonitor, filter and diff drivers, and pagers can make even read-only commands execute
 * programs chosen by whoever wrote the repo. These overrides, the per-repository ones from
 * neutralizeRepoPrograms, and --no-ext-diff/--no-textconv on diff-producing commands keep git from
 * running repository-defined programs.
 */
const BASE_CONFIG = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.pager=cat',
  '-c',
  'color.ui=false',
  '-c',
  'log.showSignature=false',
  '-c',
  'diff.noprefix=false',
];

/** Everything except push: no credentials and no ssh at all. */
const SAFE_CONFIG = [...BASE_CONFIG, '-c', 'core.sshCommand=false', '-c', 'credential.helper='];

/**
 * For commands that talk to a remote with the user's own credentials (push). The user-level and
 * system credential helpers and SSH setup are trusted and stay active; the repository's own
 * helpers, ssh command and pack programs are still blanked, and only https, ssh and local
 * transports are allowed (no ext::, which runs commands).
 */
const REMOTE_CONFIG = [
  ...BASE_CONFIG,
  '-c',
  'protocol.allow=never',
  '-c',
  'protocol.https.allow=always',
  '-c',
  'protocol.ssh.allow=always',
  '-c',
  'protocol.file.allow=always',
  '-c',
  'push.followTags=false',
  '-c',
  'push.recurseSubmodules=no',
];

/**
 * Environment the user's credential helpers and SSH need (agent socket, WSL interop for a Windows
 * credential manager, desktop keyring, gh's own token variables). Passed only to push and gh;
 * Friday never reads any of them.
 */
const CREDENTIAL_ENV = [
  'SSH_AUTH_SOCK',
  'SSH_ASKPASS',
  'GIT_ASKPASS',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'DBUS_SESSION_BUS_ADDRESS',
  'XDG_RUNTIME_DIR',
  'XDG_CONFIG_HOME',
  'WSL_INTEROP',
  'WSL_DISTRO_NAME',
  'WSLENV',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'GH_HOST',
  'GH_CONFIG_DIR',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
];

export function credentialEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(source))
    if (v !== undefined && (CREDENTIAL_ENV.includes(k) || k.startsWith('GCM_'))) env[k] = v;
  return env;
}

async function configValues(cwd: string, scope: string, key: string): Promise<string[]> {
  const out = await new Promise<string>((resolve) =>
    execFile(
      'git',
      ['config', scope, '--includes', '--null', '--get-all', key],
      { cwd, env: { ...childEnv(), LC_ALL: 'C' }, timeout: 10_000 },
      (err, stdout) => resolve(err ? '' : stdout),
    ),
  );
  return out.split('\0').filter(Boolean);
}

/**
 * Credential helpers the repository itself configures are programs chosen by whoever wrote the
 * repo: reset each such key, then restore the user's and the system's own values for it.
 */
async function trustedCredentialHelpers(cwd: string): Promise<string[]> {
  const keys = new Set<string>();
  for (const scope of ['--local', '--worktree']) {
    const out = await new Promise<string>((resolve) =>
      execFile(
        'git',
        ['config', scope, '--includes', '--null', '--name-only', '--list'],
        { cwd, env: { ...childEnv(), LC_ALL: 'C' }, timeout: 10_000 },
        (err, stdout) => resolve(err ? '' : stdout),
      ),
    );
    for (const key of out.split('\0'))
      if (/^credential\.(.+\.)?helper$/i.test(key) || /^remote\..+\.mirror$/i.test(key))
        keys.add(key);
  }
  // remote.<name>.receivepack can't be overridden this way (git uses the first value); push
  // passes --receive-pack itself.
  const args: string[] = [];
  for (const key of keys) {
    if (/^remote\./i.test(key)) {
      args.push('-c', `${key}=false`);
      continue;
    }
    args.push('-c', `${key}=`);
    for (const scope of ['--system', '--global'])
      for (const v of await configValues(cwd, scope, key)) args.push('-c', `${key}=${v}`);
  }
  return args;
}

/** The user's own ssh (their GIT_SSH_COMMAND or global core.sshCommand), never prompting. */
async function sshCommand(cwd: string): Promise<string> {
  const base =
    process.env.GIT_SSH_COMMAND?.trim() ||
    (await configValues(cwd, '--global', 'core.sshCommand')).at(-1)?.trim() ||
    'ssh';
  return `${base} -o BatchMode=yes`;
}

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

const MAX_BUFFER = 4 * 1024 * 1024;

/**
 * Repository-local settings that name a program git would run: content filters run even for
 * `git status` and `git diff`, the others during commits or other operations.
 */
const PROGRAM_KEYS =
  /^(filter\..+\.(clean|smudge|process)|diff\..+\.(command|textconv)|merge\..+\.driver|gpg(\..+)?\.program|core\.(gitproxy|askpass|editor|sshcommand|fsmonitor)|sequence\.editor|uploadpack\.packobjectshook)$/i;

/**
 * Overrides that blank out every program-running setting found in the repository's own config
 * (.git/config, its includes, and worktree config). User-level and system config are trusted and
 * left alone, so e.g. a globally installed git-lfs filter still works.
 */
async function neutralizeRepoPrograms(cwd: string): Promise<string[]> {
  const keys = new Set<string>();
  for (const scope of ['--local', '--worktree']) {
    const out = await new Promise<string>((resolve) =>
      execFile(
        'git',
        ['config', scope, '--includes', '--null', '--name-only', '--list'],
        { cwd, env: { ...childEnv(), LC_ALL: 'C' }, timeout: 10_000 },
        (err, stdout) => resolve(err ? '' : stdout),
      ),
    );
    for (const key of out.split('\0')) if (PROGRAM_KEYS.test(key)) keys.add(key);
  }
  return [...keys].flatMap((k) => ['-c', `${k}=`]);
}

export async function runGit(
  cwd: string,
  args: string[],
  opts: {
    timeoutMs?: number;
    signal?: AbortSignal;
    allowHooks?: boolean;
    /** Use the user's credential helpers and ssh (push only). */
    credentials?: boolean;
    /** Written to git's standard input. */
    input?: string;
  } = {},
): Promise<GitResult> {
  const config = [
    ...(opts.credentials ? REMOTE_CONFIG : SAFE_CONFIG),
    ...(opts.allowHooks ? [] : ['-c', 'core.hooksPath=/dev/null']),
    ...(await neutralizeRepoPrograms(cwd)),
    ...(opts.credentials ? await trustedCredentialHelpers(cwd) : []),
  ];
  const remoteEnv = opts.credentials
    ? { ...credentialEnv(), GIT_SSH_COMMAND: await sshCommand(cwd) }
    : {};
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      [...config, ...args],
      {
        cwd,
        env: {
          ...childEnv(),
          ...remoteEnv,
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
    // Nothing git runs may wait for input that never comes. A process that exits without reading
    // its input is fine (EPIPE).
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(opts.input ?? '');
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

/**
 * Refs and revisions from the model: no option injection, no shell metacharacters, and no ":",
 * which would address file contents directly ("HEAD:.env", ":.env" for the staged copy) and bypass
 * the credential-file filter.
 */
export const REF_PATTERN = /^(?!-)[A-Za-z0-9._/@{}~^-]{1,200}$/;

/** Decode a path as git prints it: plain, or C-quoted with octal escapes for special bytes. */
function unquoteGitPath(raw: string): string {
  if (!raw.startsWith('"')) return raw;
  const body = raw.slice(1, raw.endsWith('"') ? -1 : undefined);
  const bytes: number[] = [];
  const simple: Record<string, number> = { n: 10, t: 9, r: 13, b: 8, f: 12, a: 7, v: 11 };
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c !== '\\') {
      bytes.push(...Buffer.from(c));
      continue;
    }
    const next = body[++i] ?? '';
    if (/[0-7]/.test(next)) {
      bytes.push(Number.parseInt(body.slice(i, i + 3), 8));
      i += 2;
    } else {
      bytes.push(simple[next] ?? next.charCodeAt(0));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

const stripSide = (p: string) => p.replace(/^[ab]\//, '');

/** Every path a diff section names: header, ---/+++ lines, and rename/copy lines. */
function sectionPaths(part: string): string[] {
  const out: string[] = [];
  const header = /^diff --git ("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|.+)$/m.exec(part);
  if (header)
    out.push(stripSide(unquoteGitPath(header[1]!)), stripSide(unquoteGitPath(header[2]!)));
  for (const m of part.matchAll(/^(?:---|\+\+\+) (.+)$/gm)) {
    if (m[1] !== '/dev/null') out.push(stripSide(unquoteGitPath(m[1]!)));
  }
  for (const m of part.matchAll(/^(?:rename|copy) (?:from|to) (.+)$/gm))
    out.push(unquoteGitPath(m[1]!));
  return out;
}

/**
 * Remove the per-file sections of a diff/patch that belong to credential files, keeping a
 * placeholder so the model knows the file changed. Paths are decoded first: git quotes names
 * with special characters, which must not slip past the check.
 */
export function hideSecretDiffs(patch: string): string {
  const parts = patch.split(/(?=^diff --git )/m);
  return parts
    .map((part) => {
      if (!part.startsWith('diff --git ')) return part;
      const paths = sectionPaths(part);
      if (paths.some((p) => isSecretPath(p) || isGitInternal(p))) {
        const shown = [...new Set(paths)].join(' -> ');
        return `diff --git ${shown}\n[changes to a credential file are hidden]\n`;
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

const COMMIT_HOOKS = ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit'];

/** Active hook scripts git would run (non-sample files in the hooks directory); commit hooks by default. */
export async function activeHooks(root: string, which: string[] = COMMIT_HOOKS): Promise<string[]> {
  const configured = (await runGit(root, ['config', '--get', 'core.hooksPath'])).stdout.trim();
  const dir = configured ? path.resolve(root, configured) : path.join(root, '.git', 'hooks');
  try {
    const names = await fs.readdir(dir);
    return names.filter((n) => !n.endsWith('.sample') && which.includes(n));
  } catch {
    return [];
  }
}
