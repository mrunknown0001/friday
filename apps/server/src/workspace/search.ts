import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { looksBinary, splitLines } from './files.js';
import { isGitInternal, isSecretPath, isWithin, WorkspaceError } from './paths.js';
import { DEFAULT_EXCLUDED_DIRS, walk } from './walk.js';

export interface SearchOptions {
  query: string;
  regex: boolean;
  caseSensitive: boolean;
  /** Canonical absolute path to search (a directory or a file inside `root`). */
  targetAbs: string;
  glob?: string | undefined;
  maxResults: number;
  signal?: AbortSignal | undefined;
}

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

export interface SearchResult {
  matches: SearchMatch[];
  truncated: boolean;
  engine: 'ripgrep' | 'builtin';
}

const MAX_MATCH_TEXT = 300;
const RG_TIMEOUT_MS = 20_000;

const clip = (s: string) => {
  const t = s.replace(/\r?\n$/, '');
  return t.length > MAX_MATCH_TEXT ? `${t.slice(0, MAX_MATCH_TEXT)}…` : t;
};

export async function search(
  root: string,
  rgPath: string | null,
  opts: SearchOptions,
): Promise<SearchResult> {
  if (!opts.query) throw new WorkspaceError('invalid_path', 'Search query is empty.');
  if (rgPath) return ripgrep(root, rgPath, opts);
  if (opts.regex) {
    throw new WorkspaceError(
      'unsupported',
      'Regex search requires ripgrep (rg), which is not installed. Retry with regex=false for a literal search.',
    );
  }
  return builtinSearch(root, opts);
}

/**
 * ripgrep with an argument vector (no shell). Matches in credential files and .git are dropped
 * without a trace: even reporting "a credential file matched" would let a model guess a secret one
 * character at a time. The check runs on every result because a caller-supplied glob can override
 * the exclusion globs.
 */
function ripgrep(root: string, rgPath: string, opts: SearchOptions): Promise<SearchResult> {
  const args = [
    '--json',
    '--no-config',
    '--no-require-git',
    '--hidden',
    '--max-filesize',
    '1M',
    '--max-count',
    '20',
    '--max-columns',
    '1000',
  ];
  for (const dir of DEFAULT_EXCLUDED_DIRS) args.push('--glob', `!${dir}/`);
  args.push('--glob', '!*.pem', '--glob', '!*.key');
  if (opts.glob) args.push('--glob', opts.glob);
  if (!opts.regex) args.push('--fixed-strings');
  args.push(opts.caseSensitive ? '--case-sensitive' : '--ignore-case');
  // `-e` keeps a query beginning with "-" from being parsed as a flag; `--` does the same for the path.
  args.push('-e', opts.query, '--');
  const relTarget = path.relative(root, opts.targetAbs);
  if (relTarget) args.push(relTarget);

  return new Promise((resolve, reject) => {
    const child = spawn(rgPath, args, {
      cwd: root,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const matches: SearchMatch[] = [];
    let truncated = false;
    let buffer = '';
    let stderr = '';
    let settled = false;

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve({ matches, truncated, engine: 'ripgrep' });
    };
    const stop = () => {
      if (child.exitCode === null) child.kill('SIGTERM');
    };
    const onAbort = () => {
      stop();
      finish(new WorkspaceError('unsupported', 'Search cancelled.'));
    };
    const timer = setTimeout(() => {
      truncated = true;
      stop();
    }, RG_TIMEOUT_MS);
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const handleLine = (line: string) => {
      if (!line || matches.length >= opts.maxResults) return;
      let msg: {
        type?: string;
        data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } };
      };
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.type !== 'match' || !msg.data?.path?.text || typeof msg.data.lines?.text !== 'string')
        return;
      const rel = path.normalize(msg.data.path.text).split(path.sep).join('/');
      if (!isWithin(root, path.resolve(root, rel))) return;
      if (isSecretPath(rel) || isGitInternal(rel)) return;
      matches.push({ path: rel, line: msg.data.line_number ?? 0, text: clip(msg.data.lines.text) });
      if (matches.length >= opts.maxResults) {
        truncated = true;
        stop();
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        handleLine(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c: string) => {
      if (stderr.length < 2_000) stderr += c;
    });
    child.on('error', (err) =>
      finish(new WorkspaceError('unsupported', `ripgrep failed to start: ${err.message}`)),
    );
    child.on('close', (code) => {
      handleLine(buffer);
      // 0 = matches, 1 = no matches, 2 = error (possibly with partial results). Killed = we stopped it.
      if (code === 2 && matches.length === 0 && !truncated) {
        const detail = stderr.split('\n').find(Boolean) ?? 'unknown error';
        finish(new WorkspaceError('unsupported', `Search failed: ${detail.slice(0, 200)}`));
      } else {
        finish();
      }
    });
  });
}

const MAX_BUILTIN_FILES = 5_000;
const MAX_BUILTIN_FILE_BYTES = 1024 * 1024;

/** Literal search used when ripgrep is unavailable. Deliberately has no regex mode (ReDoS risk). */
async function builtinSearch(root: string, opts: SearchOptions): Promise<SearchResult> {
  const stat = await fs.stat(opts.targetAbs);
  const files = stat.isFile()
    ? [path.relative(root, opts.targetAbs).split(path.sep).join('/')]
    : (
        await walk(root, opts.targetAbs, {
          maxDepth: 64,
          maxEntries: MAX_BUILTIN_FILES,
          includeDirs: false,
          ...(opts.signal ? { signal: opts.signal } : {}),
        })
      ).entries
        .filter((e) => e.type === 'file' && (e.size ?? 0) <= MAX_BUILTIN_FILE_BYTES)
        .map((e) => e.rel);

  const globRe = opts.glob ? globToRegExp(opts.glob) : null;
  const needle = opts.caseSensitive ? opts.query : opts.query.toLowerCase();
  const matches: SearchMatch[] = [];
  const truncated = files.length >= MAX_BUILTIN_FILES;
  const done = (t: boolean): SearchResult => ({ matches, truncated: t, engine: 'builtin' });

  for (const rel of files) {
    if (opts.signal?.aborted) throw new WorkspaceError('unsupported', 'Search cancelled.');
    if (globRe && !globRe.test(rel) && !globRe.test(path.posix.basename(rel))) continue;
    // Credential files and git internals are never opened.
    if (isSecretPath(rel) || isGitInternal(rel)) continue;
    let buf: Buffer;
    try {
      buf = await fs.readFile(path.join(root, rel));
    } catch {
      continue;
    }
    if (looksBinary(buf)) continue;
    const lines = splitLines(buf.toString('utf8'));
    let perFile = 0;
    for (let i = 0; i < lines.length; i++) {
      const hay = opts.caseSensitive ? lines[i]! : lines[i]!.toLowerCase();
      if (!hay.includes(needle)) continue;
      matches.push({ path: rel, line: i + 1, text: clip(lines[i]!) });
      if (++perFile >= 20) break;
      if (matches.length >= opts.maxResults) return done(true);
    }
  }
  return done(truncated);
}

/** Minimal glob → RegExp: `**` any path, `*` any segment chars, `?` one char. Linear-time pattern. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`, 'i');
}

export function formatMatches(result: SearchResult): string {
  const byFile = new Map<string, SearchMatch[]>();
  for (const m of result.matches) byFile.set(m.path, [...(byFile.get(m.path) ?? []), m]);
  const parts: string[] = [];
  for (const [file, ms] of byFile) {
    parts.push(`${file}\n${ms.map((m) => `  ${m.line}: ${m.text}`).join('\n')}`);
  }
  return parts.join('\n\n');
}
