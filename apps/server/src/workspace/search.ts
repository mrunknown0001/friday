import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
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
  engine: 'ripgrep' | 'builtin' | 'grep';
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

/** Limits of the built-in regex engine. */
export const REGEX_LIMITS = {
  patternChars: 1_000,
  /** One file: a pattern still running after this backtracks catastrophically. */
  fileMs: 2_000,
  /** The whole search; what was found so far is returned, marked truncated. */
  totalMs: 20_000,
  /** Longer lines (minified code) are matched on their start only. */
  lineChars: 10_000,
};

/**
 * Matches lines against a JavaScript regex in a worker thread. JavaScript regexes can take
 * exponential time ("(a+)+$"), and a running regex can't be interrupted, so the worker is stopped
 * when one file takes too long. It is plain code with no imports, so it runs the same from source,
 * compiled and in the desktop bundle.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const re = new RegExp(workerData.pattern, workerData.flags);
parentPort.on('message', ({ lines, max }) => {
  const hits = [];
  for (let i = 0; i < lines.length && hits.length < max; i++) {
    const line = lines[i].length > workerData.lineChars ? lines[i].slice(0, workerData.lineChars) : lines[i];
    if (re.test(line)) hits.push(i);
  }
  parentPort.postMessage(hits);
});
`;

class RegexMatcher {
  private readonly worker: Worker;

  constructor(pattern: string, flags: string) {
    this.worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { pattern, flags, lineChars: REGEX_LIMITS.lineChars },
      resourceLimits: { maxOldGenerationSizeMb: 128 },
    });
    // Errors surface through the pending match; this keeps an unexpected one from crashing.
    this.worker.on('error', () => undefined);
  }

  /** Indexes of the matching lines, or 'timeout' when the file took longer than `ms`. */
  match(lines: string[], max: number, ms: number): Promise<number[] | 'timeout'> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve('timeout');
      }, ms);
      const onMessage = (hits: number[]) => {
        cleanup();
        resolve(hits);
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.worker.off('message', onMessage);
        this.worker.off('error', onError);
      };
      this.worker.on('message', onMessage);
      this.worker.on('error', onError);
      this.worker.postMessage({ lines, max });
    });
  }

  stop(): void {
    void this.worker.terminate();
  }
}

/** The pattern as a JavaScript regex, or why it isn't one. */
function compileRegex(query: string, caseSensitive: boolean): string {
  if (query.length > REGEX_LIMITS.patternChars)
    throw new WorkspaceError(
      'invalid_path',
      `The regex is too long (over ${REGEX_LIMITS.patternChars} characters).`,
    );
  const flags = caseSensitive ? '' : 'i';
  try {
    new RegExp(query, flags);
  } catch (err) {
    throw new WorkspaceError(
      'invalid_path',
      `Invalid regex: ${(err as Error).message.replace(/^Invalid regular expression: /, '')}`,
    );
  }
  return flags;
}

/**
 * Search used when ripgrep is unavailable: literal text, or a regex matched in a worker that is
 * stopped when a pattern runs away (see RegexMatcher).
 */
async function builtinSearch(root: string, opts: SearchOptions): Promise<SearchResult> {
  const flags = opts.regex ? compileRegex(opts.query, opts.caseSensitive) : '';
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
  const literal = (lines: string[]) => {
    const hits: number[] = [];
    for (let i = 0; i < lines.length && hits.length < 20; i++) {
      const hay = opts.caseSensitive ? lines[i]! : lines[i]!.toLowerCase();
      if (hay.includes(needle)) hits.push(i);
    }
    return hits;
  };
  const matcher = opts.regex ? new RegexMatcher(opts.query, flags) : null;
  const deadline = Date.now() + REGEX_LIMITS.totalMs;

  try {
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
      let hits: number[];
      if (matcher) {
        if (Date.now() > deadline) return done(true);
        const found = await matcher.match(lines, 20, REGEX_LIMITS.fileMs);
        if (found === 'timeout')
          throw new WorkspaceError(
            'unsupported',
            `The regex took over ${REGEX_LIMITS.fileMs / 1000} s on ${rel}, so the search was stopped. It probably backtracks catastrophically (nested quantifiers such as (a+)+ or (.*)*); simplify it.`,
          );
        hits = found;
      } else {
        hits = literal(lines);
      }
      for (const i of hits) {
        matches.push({ path: rel, line: i + 1, text: clip(lines[i]!) });
        if (matches.length >= opts.maxResults) return done(true);
      }
    }
    return done(truncated);
  } finally {
    matcher?.stop();
  }
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
