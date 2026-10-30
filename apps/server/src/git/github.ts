import { spawn } from 'node:child_process';
import os from 'node:os';
import { childEnv } from '../commands/runner.js';
import { WorkspaceError } from '../workspace/paths.js';
import { credentialEnv, git, runGit, type GitResult } from './git.js';

/** A remote URL as shown to the user: any user name and password in it are removed. */
export function displayRemoteUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = '';
      u.password = '';
    }
    return u.toString();
  } catch {
    // scp-like "git@github.com:owner/repo.git" or a local path: nothing secret in it.
    return url;
  }
}

export interface GitHubRepo {
  host: string;
  owner: string;
  name: string;
}

const NAME = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * Host, owner and repository name from a remote URL shaped like GitHub's (https, ssh or scp-like
 * with an OWNER/REPO path); null otherwise. Whether the host really is GitHub (or a GitHub
 * Enterprise server) is up to gh: it must be signed in to it.
 */
export function githubRepo(url: string): GitHubRepo | null {
  let host: string;
  let pathPart: string;
  const scp = /^[A-Za-z0-9._-]+@([A-Za-z0-9.-]+):(.+)$/.exec(url);
  if (scp) {
    host = scp[1]!;
    pathPart = scp[2]!;
  } else {
    try {
      const u = new URL(url);
      if (!['https:', 'ssh:'].includes(u.protocol)) return null;
      host = u.hostname;
      pathPart = u.pathname.replace(/^\//, '');
    } catch {
      return null;
    }
  }
  const [owner, rawName, ...rest] = pathPart.replace(/\/$/, '').split('/');
  const name = rawName?.replace(/\.git$/, '');
  if (rest.length || !owner || !name || !NAME.test(owner) || !NAME.test(name)) return null;
  return { host: host.toLowerCase(), owner, name };
}

/** The --repo argument gh expects: OWNER/REPO on github.com, HOST/OWNER/REPO elsewhere. */
export const repoArg = (r: GitHubRepo) =>
  r.host === 'github.com' ? `${r.owner}/${r.name}` : `${r.host}/${r.owner}/${r.name}`;

const ghBinary = () => process.env.FRIDAY_GH?.trim() || 'gh';

/**
 * Run the GitHub CLI with the user's own sign-in (Friday never reads its token). It runs in a
 * neutral folder with an explicit --repo, so it never reads the project's git configuration, and
 * never prompts.
 */
export function runGh(
  args: string[],
  opts: { input?: string; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(ghBinary(), args, {
      cwd: os.tmpdir(),
      env: {
        ...childEnv(),
        ...credentialEnv(),
        GH_PROMPT_DISABLED: '1',
        GH_NO_UPDATE_NOTIFIER: '1',
        GH_SPINNER_DISABLED: '1',
        GH_PAGER: 'cat',
        NO_COLOR: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs ?? 60_000);
    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < 1_000_000) stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < 1_000_000) stderr += d.toString('utf8');
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        err.code === 'ENOENT'
          ? new WorkspaceError(
              'unsupported',
              'The GitHub CLI (gh) is not installed. Install it and run `gh auth login` in a terminal.',
            )
          : new WorkspaceError('unsupported', `gh failed: ${err.message.split('\n')[0]}`),
      );
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.stdin.on('error', () => undefined); // gh may exit without reading its input
    child.stdin.end(opts.input ?? '');
  });
}

/** gh must be installed and signed in to the repository's host. */
export async function ghReady(
  repo: GitHubRepo,
  signal: AbortSignal,
  needs = 'Pull requests need GitHub',
): Promise<void> {
  const auth = await runGh(['auth', 'status', '--hostname', repo.host], {
    signal,
    timeoutMs: 20_000,
  });
  if (auth.code !== 0)
    throw new WorkspaceError(
      'unsupported',
      repo.host === 'github.com'
        ? 'The GitHub CLI (gh) is not signed in. Run `gh auth login` in a terminal, then try again.'
        : `${repo.host} is not a GitHub host the GitHub CLI (gh) is signed in to. ${needs}; for GitHub Enterprise run \`gh auth login --hostname ${repo.host}\`.`,
    );
}

/** The project's GitHub repository: from the current branch's remote, else origin, else the only remote. */
export async function projectGitHubRepo(
  root: string,
): Promise<{ repo: GitHubRepo; remote: string }> {
  const remotes = (await git(root, ['remote'])).split('\n').filter(Boolean);
  const branch = (await runGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim();
  const configured = branch
    ? (await runGit(root, ['config', '--get', `branch.${branch}.remote`])).stdout.trim()
    : '';
  const remote =
    (configured && remotes.includes(configured) ? configured : null) ??
    (remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0]! : null);
  if (!remote)
    throw new WorkspaceError(
      'unsupported',
      remotes.length
        ? `Can't tell which remote is the GitHub repository (remotes: ${remotes.join(', ')}).`
        : 'This repository has no remote, so it has no GitHub Actions runs.',
    );
  const url = (await git(root, ['remote', 'get-url', remote])).trim();
  const repo = githubRepo(url);
  if (!repo)
    throw new WorkspaceError(
      'unsupported',
      `The remote ${remote} (${displayRemoteUrl(url)}) is not a GitHub repository URL.`,
    );
  return { repo, remote };
}

/**
 * A GET on GitHub's REST API through gh (read-only by construction: gh api's default method with
 * no fields is GET). Returns the body text; null on 404/410 (not found, or logs expired).
 */
export async function ghApiGet(
  repo: GitHubRepo,
  path: string,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string | null> {
  const r = await runGh(['api', '--hostname', repo.host, '--method', 'GET', path], {
    ...opts,
    timeoutMs: opts.timeoutMs ?? 60_000,
  });
  if (r.code === 0) return r.stdout;
  if (/HTTP 40[4]|HTTP 410|Not Found|Gone/i.test(r.stderr)) return null;
  throw new WorkspaceError(
    'unsupported',
    `GitHub API request failed: ${r.stderr.trim().split('\n')[0]?.slice(0, 300) || `exit ${r.code}`}`,
  );
}

/** Parse a GitHub API response, failing with a readable error instead of a crash. */
export function parseGitHubJson<T>(body: string): T {
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new WorkspaceError('unsupported', 'GitHub returned a response Friday could not read.');
  }
}
