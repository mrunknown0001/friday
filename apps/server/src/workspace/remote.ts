import path from 'node:path';
import type { RemoteTargetDto, SshHostDto } from '@friday/shared';
import ignore, { type Ignore } from 'ignore';
import type { RunResult } from '../commands/runner.js';
import { PROGRAM_KEYS } from '../git/git.js';
import { explainSshFailure, shellQuote, type ExecOptions, type ExecResult } from '../ssh/ssh.js';
import { isGitInternal, isSecretPath, WorkspaceError } from './paths.js';
import { globToRegExp, type SearchResult } from './search.js';
import { DEFAULT_EXCLUDED_DIRS, type WalkEntry } from './walk.js';

/**
 * Projects on SSH hosts. Every operation is one POSIX `sh` script run over ssh with the project
 * root as its first argument. The script resolves real paths on the server and refuses anything
 * outside the root; Friday checks the paths it gets back again (symlink escapes, credential files,
 * .git) before using any result. Servers are expected to be Linux with GNU coreutils, find and grep.
 */

const P = path.posix;

/** How Friday reaches one SSH host: ssh with raw output, and ssh with streamed output. */
export interface RemoteTransport {
  host: SshHostDto;
  exec(command: string, opts: ExecOptions): Promise<ExecResult>;
  run(
    command: string,
    opts: { timeoutMs: number; signal: AbortSignal; onOutput?: (chunk: string) => void },
  ): Promise<RunResult>;
}

export function remoteTarget(host: SshHostDto): RemoteTargetDto {
  return {
    hostId: host.id,
    name: host.name,
    hostname: host.hostname,
    port: host.port,
    username: host.username,
    environment: host.environment,
  };
}

export const describeHost = (h: Pick<SshHostDto, 'name' | 'username' | 'hostname'>) =>
  `${h.name} (${h.username}@${h.hostname})`;

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_LIST_BYTES = 8 * 1024 * 1024;
const MAX_SEARCH_BYTES = 4 * 1024 * 1024;
const MAX_GITIGNORE_BYTES = 256 * 1024;
const IGNORES_MARKER = Buffer.from('\0@@FRIDAY-IGNORES@@\0');

// Exit codes the scripts use; anything else is reported with the script's stderr.
const EXIT = {
  notFound: 3,
  outside: 4,
  isDir: 5,
  notFile: 6,
  notDir: 7,
  exists: 8,
  writeFailed: 9,
  rootMissing: 10,
  ssh: 255,
} as const;

const PRUNE = [...DEFAULT_EXCLUDED_DIRS]
  .filter((d) => d !== '.git')
  .map((d) => `-name ${d}`)
  .join(' -o ');
const FIND_PRUNE = `\\( -name .git -o -type d \\( ${PRUNE} \\) \\) -prune -o`;
const RG_EXCLUDES = [...DEFAULT_EXCLUDED_DIRS].map((d) => `--glob '!${d}/'`).join(' ');
const GREP_EXCLUDES = [...DEFAULT_EXCLUDED_DIRS].map((d) => `--exclude-dir=${d}`).join(' ');

/** Every project script starts here: $root is the project root, and `inside` tests a real path. */
const PRELUDE = `set -u
root=$1; shift
[ -d "$root" ] || exit ${EXIT.rootMissing}
inside() { case $1 in "$root"|"$root"/*) return 0;; esac; return 1; }
# The real folder a new file goes in, created if needed, still inside the project: sets $rd.
parent() {
  case $1 in "$root"/*) ;; *) exit ${EXIT.outside};; esac
  d=$(dirname -- "$1"); a=$d
  while [ ! -e "$a" ] && [ ! -L "$a" ]; do a=$(dirname -- "$a"); done
  ra=$(realpath -e -- "$a" 2>/dev/null) || exit ${EXIT.notFound}
  inside "$ra" || exit ${EXIT.outside}
  [ -d "$ra" ] || exit ${EXIT.notDir}
  mkdir -p -- "$d" || exit ${EXIT.writeFailed}
  rd=$(realpath -e -- "$d") || exit ${EXIT.writeFailed}
  inside "$rd" || exit ${EXIT.outside}
  case $rd/ in "$root"/.git/*) exit ${EXIT.outside};; esac
}
`;

const SCRIPTS = {
  stat: `p=$(realpath -e -- "$1" 2>/dev/null) || exit ${EXIT.notFound}
inside "$p" || exit ${EXIT.outside}
if [ -d "$p" ]; then t=d; elif [ -f "$p" ]; then t=f; else t=o; fi
printf '%s\\0%s\\0%s\\0%s\\0' "$p" "$t" "$(stat -c %s -- "$p")" "$(stat -c %Y -- "$p")"`,

  read: `p=$(realpath -e -- "$1" 2>/dev/null) || exit ${EXIT.notFound}
inside "$p" || exit ${EXIT.outside}
[ -d "$p" ] && exit ${EXIT.isDir}
[ -f "$p" ] || exit ${EXIT.notFile}
s=$(stat -c %s -- "$p") || exit ${EXIT.notFound}
printf '%s\\0%s\\0%s\\0' "$p" "$s" "$(stat -c %Y -- "$p")"
[ "$s" -le "$2" ] || exit 0
exec cat -- "$p"`,

  list: `p=$(realpath -e -- "$1" 2>/dev/null) || exit ${EXIT.notFound}
inside "$p" || exit ${EXIT.outside}
[ -d "$p" ] || exit ${EXIT.notDir}
printf '%s\\0' "$p"
cd -- "$p" || exit ${EXIT.notFound}
find . -mindepth 1 -maxdepth "$2" ${FIND_PRUNE} -printf '%y\\0%s\\0%T@\\0%P\\0' 2>/dev/null | head -c "$3"
printf '\\0@@FRIDAY-IGNORES@@\\0'
find . -maxdepth "$2" ${FIND_PRUNE} -name .gitignore -type f -size -${MAX_GITIGNORE_BYTES / 1024}k -print0 2>/dev/null | head -c 200000 |
  xargs -0 -r -n 1 sh -c 'printf "%s\\0" "$1"; base64 -w0 -- "$1"; printf "\\0"' sh
d=$p
while [ "$d" != "$root" ] && [ "$d" != / ]; do
  d=$(dirname -- "$d")
  if [ -f "$d/.gitignore" ]; then printf '%s\\0' "$d/.gitignore"; base64 -w0 -- "$d/.gitignore"; printf '\\0'; fi
done
exit 0`,

  search: `t=$(realpath -e -- "$1" 2>/dev/null) || exit ${EXIT.notFound}
inside "$t" || exit ${EXIT.outside}
cd -- "$root" || exit ${EXIT.rootMissing}
r=\${t#"$root"}; r=\${r#/}; [ -n "$r" ] || r=.
q=$2; mode=$3; cs=$4; rg_glob=$5; grep_include=$6; max=$7
if command -v rg >/dev/null 2>&1; then
  set -- --no-config --no-require-git --hidden --null --line-number --no-heading --with-filename --color never --max-count 20 --max-filesize 1M --max-columns 1000 ${RG_EXCLUDES} --glob '!*.pem' --glob '!*.key'
  [ -n "$rg_glob" ] && set -- "$@" --glob "$rg_glob"
  [ "$mode" = F ] && set -- "$@" --fixed-strings
  if [ "$cs" = i ]; then set -- "$@" --ignore-case; else set -- "$@" --case-sensitive; fi
  printf 'rg\\0'
  timeout 20 rg "$@" -e "$q" -- "$r" 2>/dev/null | head -c "$max"
else
  set -- -rIHn --null --color=never -m 20 ${GREP_EXCLUDES} --exclude='*.pem' --exclude='*.key'
  [ -n "$grep_include" ] && set -- "$@" --include="$grep_include"
  if [ "$mode" = F ]; then set -- "$@" -F; else set -- "$@" -E; fi
  [ "$cs" = i ] && set -- "$@" -i
  printf 'grep\\0'
  timeout 20 grep "$@" -e "$q" -- "$r" 2>/dev/null | head -c "$max"
fi
exit 0`,

  probeWrite: `t=$1
case $t in "$root"/*) ;; *) exit ${EXIT.outside};; esac
a=$t
while [ ! -e "$a" ] && [ ! -L "$a" ]; do a=$(dirname -- "$a"); done
ra=$(realpath -e -- "$a" 2>/dev/null) || exit ${EXIT.notFound}
inside "$ra" || exit ${EXIT.outside}
if [ "$a" = "$t" ]; then
  [ -f "$ra" ] || exit ${EXIT.notFile}
  printf 'E\\0%s\\0' "$ra"
else
  [ -d "$ra" ] || exit ${EXIT.notDir}
  printf 'N\\0%s\\0%s\\0' "$ra" "$a"
fi`,

  // Contents arrive on stdin. Written to a temp file and renamed into place, keeping the file's
  // mode; when its owner can't be kept (e.g. a file owned by www-data), it is written in place.
  write: `parent "$1"
f=$rd/$(basename -- "$1")
[ -d "$f" ] && exit ${EXIT.isDir}
[ -L "$f" ] && exit ${EXIT.notFile}
tmp=$(mktemp "$rd/.friday-XXXXXXXX.tmp") || exit ${EXIT.writeFailed}
if ! cat > "$tmp"; then rm -f -- "$tmp"; exit ${EXIT.writeFailed}; fi
if [ -e "$f" ]; then
  chmod --reference="$f" -- "$tmp" 2>/dev/null
  if [ "$(stat -c %u:%g -- "$f")" != "$(stat -c %u:%g -- "$tmp")" ] && ! chown --reference="$f" -- "$tmp" 2>/dev/null; then
    cat -- "$tmp" > "$f"; s=$?; rm -f -- "$tmp"
    [ $s -eq 0 ] || exit ${EXIT.writeFailed}
    exit 0
  fi
else
  chmod 644 -- "$tmp"
fi
mv -f -- "$tmp" "$f" || { rm -f -- "$tmp"; exit ${EXIT.writeFailed}; }`,

  remove: `[ -L "$1" ] && exit ${EXIT.notFile}
p=$(realpath -e -- "$1" 2>/dev/null) || exit ${EXIT.notFound}
inside "$p" || exit ${EXIT.outside}
[ -f "$p" ] || exit ${EXIT.notFile}
rm -f -- "$p" || exit ${EXIT.writeFailed}`,

  // Never replaces an existing destination: a hard link fails if it exists, and mv -n skips.
  move: `[ -L "$1" ] && exit ${EXIT.notFile}
f=$(realpath -e -- "$1" 2>/dev/null) || exit ${EXIT.notFound}
inside "$f" || exit ${EXIT.outside}
[ -f "$f" ] || exit ${EXIT.notFile}
parent "$2"
dest=$rd/$(basename -- "$2")
if [ -e "$dest" ] || [ -L "$dest" ]; then exit ${EXIT.exists}; fi
if ln -- "$f" "$dest" 2>/dev/null; then rm -f -- "$f"; exit 0; fi
[ -e "$dest" ] && exit ${EXIT.exists}
mv -n -- "$f" "$dest" || exit ${EXIT.writeFailed}
[ -e "$f" ] && exit ${EXIT.exists}
exit 0`,

  // Like git/git.ts: settings in the repository's own config that name a program git would run
  // are blanked (through GIT_CONFIG_*), so even read-only commands never run them.
  git: `cd -- "$root" || exit ${EXIT.rootMissing}
set -f
keys=$(for s in --local --worktree; do git config "$s" --includes --name-only --list 2>/dev/null; done | grep -Ei '${PROGRAM_KEYS.source}')
n=0
old_ifs=$IFS
IFS='
'
for k in $keys; do
  eval "GIT_CONFIG_KEY_$n=\\$k; GIT_CONFIG_VALUE_$n=; export GIT_CONFIG_KEY_$n GIT_CONFIG_VALUE_$n"
  n=$((n + 1))
done
IFS=$old_ifs
export GIT_CONFIG_COUNT=$n GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat LC_ALL=C
exec git "$@"`,

  // Hook scripts present for the given names (core.hooksPath or the repository's hooks folder).
  hooks: `cd -- "$root" || exit ${EXIT.rootMissing}
d=$(git config --get core.hooksPath 2>/dev/null)
[ -n "$d" ] || d=$(git rev-parse --git-path hooks 2>/dev/null) || exit 0
case $d in /*) ;; *) d=$root/$d;; esac
for n in "$@"; do [ -f "$d/$n" ] && printf '%s\\0' "$n"; done
exit 0`,
};

/**
 * run_command on the server. The login's shell when it is POSIX-like (bash, zsh, …), else /bin/sh,
 * started as a login shell; it changes into the folder after the profile ran.
 */
const COMMAND_SCRIPT = `dir=$1; seconds=$2; mode=$3; shift 3
cd -- "$dir" || exit 1
export CI=1 TERM=dumb NO_COLOR=1 FORCE_COLOR=0 GIT_TERMINAL_PROMPT=0
case \${SHELL##*/} in bash|zsh|sh|dash|ksh) login=$SHELL;; *) login=/bin/sh;; esac
if [ "$mode" = argv ]; then
  exec timeout -k 5 "$seconds" "$login" -lc 'cd -- "$0" || exit 1; exec "$@"' "$dir" "$@"
fi
exec timeout -k 5 "$seconds" "$login" -lc 'cd -- "$0" || exit 1; eval "$1"' "$dir" "$1"`;

/** Scripts that run without a project: choosing and checking a folder on the host. */
const HOST_SCRIPTS = {
  // The folder (default: the login's home), its subfolders, and $HOME.
  browse: `p=\${1:-$HOME}
p=$(realpath -e -- "$p" 2>/dev/null) || exit ${EXIT.notFound}
[ -d "$p" ] || exit ${EXIT.notDir}
printf '%s\\0%s\\0' "$p" "$HOME"
cd -- "$p" || exit ${EXIT.notFound}
find . -mindepth 1 -maxdepth 1 -type d ! -name '.*' -printf '%P\\0' 2>/dev/null | head -c 200000
exit 0`,
};

/** `sh -c <script> friday <args...>`, every word quoted for the remote user's shell. */
export function shCommand(script: string, args: string[]): string {
  return ['sh', '-c', script, 'friday', ...args].map(shellQuote).join(' ');
}

const within = (root: string, p: string) => p === root || p.startsWith(`${root}/`);

/** Split `buf` on NUL into `count` fields; the rest of the buffer follows. */
function fields(buf: Buffer, count: number): { values: string[]; rest: Buffer } {
  const values: string[] = [];
  let at = 0;
  for (let i = 0; i < count; i++) {
    const end = buf.indexOf(0, at);
    if (end === -1) throw new WorkspaceError('unsupported', 'Unexpected reply from the server.');
    values.push(buf.subarray(at, end).toString('utf8'));
    at = end + 1;
  }
  return { values, rest: buf.subarray(at) };
}

export interface RemoteStat {
  abs: string;
  rel: string;
  type: 'file' | 'dir' | 'other';
  size: number;
  mtime: string;
}

export interface RemoteFile {
  abs: string;
  rel: string;
  size: number;
  mtime: string;
  /** Null when the file is larger than the limit asked for. */
  buf: Buffer | null;
}

export interface GitRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export class RemoteWorkspace {
  constructor(
    readonly root: string,
    readonly transport: RemoteTransport,
  ) {}

  get host(): SshHostDto {
    return this.transport.host;
  }

  private where(): string {
    return `on ${this.host.name}`;
  }

  /** Run a project script; non-zero exits become WorkspaceErrors naming `shown`. */
  private async script(
    name: keyof typeof SCRIPTS,
    args: string[],
    shown: string,
    opts: Partial<ExecOptions> = {},
  ): Promise<ExecResult> {
    const r = await this.transport.exec(shCommand(PRELUDE + SCRIPTS[name], [this.root, ...args]), {
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxBytes: 4 * 1024 * 1024,
      ...opts,
    });
    if (r.cancelled) throw new WorkspaceError('unsupported', 'Cancelled.');
    if (r.timedOut)
      throw new WorkspaceError('unsupported', `${this.host.name} did not answer in time.`);
    if (r.code === 0 || (r.truncated && r.code === null)) return r;
    throw this.failure(r, shown);
  }

  private failure(r: ExecResult, shown: string): WorkspaceError {
    const msg = r.stderr.trim().split('\n').at(-1)?.slice(0, 300) ?? '';
    switch (r.code) {
      case EXIT.ssh:
        return new WorkspaceError(
          'root_unavailable',
          `Could not reach ${this.host.name}: ${explainSshFailure(r.stderr)}`,
        );
      case EXIT.rootMissing:
        return new WorkspaceError(
          'root_unavailable',
          `The project folder ${this.root} no longer exists ${this.where()}.`,
        );
      case EXIT.notFound:
        return new WorkspaceError('not_found', `Path "${shown}" does not exist.`);
      case EXIT.outside:
        return new WorkspaceError(
          'outside_root',
          `Path "${shown}" resolves (via a symlink) to a location outside the project.`,
        );
      case EXIT.isDir:
        return new WorkspaceError('not_a_file', `"${shown}" is a folder.`);
      case EXIT.notFile:
        return new WorkspaceError('not_a_file', `"${shown}" is not a regular file.`);
      case EXIT.notDir:
        return new WorkspaceError('not_a_directory', `"${shown}" is not a folder.`);
      case EXIT.exists:
        return new WorkspaceError('unsupported', `"${shown}" already exists; nothing was changed.`);
      case EXIT.writeFailed:
        return new WorkspaceError(
          'unsupported',
          `Could not write "${shown}" ${this.where()}${msg ? `: ${msg}` : ''}.`,
        );
      default:
        return new WorkspaceError(
          'unsupported',
          `The server reported an error for "${shown}"${msg ? `: ${msg}` : ''} (exit ${r.code ?? 'none'}). Friday needs a Linux server with GNU coreutils.`,
        );
    }
  }

  relOf(abs: string): string {
    return P.relative(this.root, abs) || '.';
  }

  /** Lexical checks before anything is sent: inside the root, no credentials, no .git. */
  lexical(input: string, purpose: 'read' | 'write'): { abs: string; rel: string } {
    if (typeof input !== 'string' || /[\0\n]/.test(input) || input.length > 4096) {
      throw new WorkspaceError('invalid_path', 'Invalid path.');
    }
    const trimmed = input.trim() || '.';
    const abs = trimmed.startsWith('/') ? P.normalize(trimmed) : P.resolve(this.root, trimmed);
    if (!within(this.root, abs) || (purpose === 'write' && abs === this.root)) {
      throw new WorkspaceError('outside_root', `Path "${input}" is outside the project.`);
    }
    const rel = this.relOf(abs);
    this.checkName(rel, purpose);
    return { abs, rel };
  }

  private checkName(rel: string, purpose: 'read' | 'write'): void {
    if (isSecretPath(rel)) {
      throw new WorkspaceError(
        'secret_file',
        purpose === 'read'
          ? `"${rel}" looks like a credentials file, so it is never read (its contents could be sent to the model provider).`
          : `"${rel}" looks like a credentials file; Friday does not write credential files. Ask the user to edit it.`,
      );
    }
    if (isGitInternal(rel)) {
      throw new WorkspaceError(
        'forbidden_path',
        `${purpose === 'read' ? 'Reading' : 'Writing'} .git internals is not allowed.`,
      );
    }
  }

  /** A real path the server returned: inside the root and not a credential file or .git. */
  private checkReal(real: string, shown: string, purpose: 'read' | 'write'): string {
    if (!within(this.root, real)) {
      throw new WorkspaceError(
        'outside_root',
        `Path "${shown}" resolves (via a symlink) to a location outside the project.`,
      );
    }
    const rel = this.relOf(real);
    this.checkName(rel, purpose);
    return rel;
  }

  async stat(input: string): Promise<RemoteStat> {
    const { abs, rel: shown } = this.lexical(input, 'read');
    const r = await this.script('stat', [abs], shown);
    const [real, type, size, mtime] = fields(r.stdout, 4).values as [
      string,
      string,
      string,
      string,
    ];
    const rel = this.checkReal(real, shown, 'read');
    return {
      abs: real,
      rel,
      type: type === 'd' ? 'dir' : type === 'f' ? 'file' : 'other',
      size: Number(size),
      mtime: new Date(Number(mtime) * 1000).toISOString(),
    };
  }

  /** A file's bytes, or null bytes when it is larger than `limit`. */
  async readFile(input: string, limit: number, signal?: AbortSignal): Promise<RemoteFile> {
    const { abs, rel: shown } = this.lexical(input, 'read');
    const r = await this.script('read', [abs, String(limit)], shown, {
      maxBytes: limit + 8192,
      signal,
    });
    const { values, rest } = fields(r.stdout, 3);
    const [real, size, mtime] = values as [string, string, string];
    const rel = this.checkReal(real, shown, 'read');
    const n = Number(size);
    return {
      abs: real,
      rel,
      size: n,
      mtime: new Date(Number(mtime) * 1000).toISOString(),
      buf: n > limit ? null : rest,
    };
  }

  /**
   * The tree under `input` like walk(): excluded folders skipped, .gitignore applied, symlinks
   * listed but not followed, folders before files, depth-first.
   */
  async list(
    input: string,
    opts: { maxDepth: number; maxEntries: number; signal?: AbortSignal | undefined },
  ): Promise<{ abs: string; rel: string; entries: WalkEntry[]; truncated: boolean }> {
    const { abs, rel: shown } = this.lexical(input, 'read');
    const r = await this.script(
      'list',
      [abs, String(opts.maxDepth), String(MAX_LIST_BYTES)],
      shown,
      { maxBytes: MAX_LIST_BYTES + 1024 * 1024, timeoutMs: 60_000, signal: opts.signal },
    );
    const { values, rest } = fields(r.stdout, 1);
    const start = values[0]!;
    const startRel = this.checkReal(start, shown, 'read');
    const mark = rest.indexOf(IGNORES_MARKER);
    const listing = mark === -1 ? rest : rest.subarray(0, mark);
    let truncated = mark === -1 || listing.length >= MAX_LIST_BYTES;

    // Records: type, size, mtime, path relative to the start folder.
    const parts = listing.toString('utf8').split('\0');
    const children = new Map<
      string,
      Array<{ name: string; type: WalkEntry['type']; size: number | null; mtimeMs: number | null }>
    >();
    for (let i = 0; i + 3 < parts.length; i += 4) {
      const [y, size, mtime, p] = parts.slice(i, i + 4) as [string, string, string, string];
      const type = y === 'd' ? 'dir' : y === 'f' ? 'file' : y === 'l' ? 'symlink' : null;
      if (!type || !p) continue;
      const dir = P.dirname(p) === '.' ? '' : P.dirname(p);
      const list = children.get(dir) ?? [];
      list.push({
        name: P.basename(p),
        type,
        size: type === 'file' ? Number(size) : null,
        mtimeMs: type === 'file' ? Math.floor(Number(mtime) * 1000) : null,
      });
      children.set(dir, list);
    }

    // .gitignore files: path (relative to the start, or absolute for ancestors) and base64 content.
    const layers: Array<{ base: string; ig: Ignore }> = [];
    if (mark !== -1) {
      const ig = rest
        .subarray(mark + IGNORES_MARKER.length)
        .toString('utf8')
        .split('\0');
      for (let i = 0; i + 1 < ig.length; i += 2) {
        const file = ig[i]!.startsWith('/') ? ig[i]! : P.join(start, ig[i]!);
        if (!within(this.root, file)) continue;
        const content = Buffer.from(ig[i + 1]!, 'base64');
        if (content.length > MAX_GITIGNORE_BYTES) continue;
        layers.push({
          base: this.relOf(P.dirname(file)),
          ig: ignore().add(content.toString('utf8')),
        });
      }
    }
    const ignored = (rel: string, isDir: boolean) =>
      layers.some(({ base, ig }) => {
        const r =
          base === '.' ? rel : rel.startsWith(`${base}/`) ? rel.slice(base.length + 1) : null;
        return !!r && ig.ignores(isDir ? `${r}/` : r);
      });

    const entries: WalkEntry[] = [];
    const visit = (dir: string, depth: number) => {
      const kids = (children.get(dir) ?? []).sort(
        (a, b) =>
          Number(b.type === 'dir') - Number(a.type === 'dir') || a.name.localeCompare(b.name),
      );
      for (const k of kids) {
        if (entries.length >= opts.maxEntries) {
          truncated = true;
          return;
        }
        const fromStart = dir ? `${dir}/${k.name}` : k.name;
        const rel = startRel === '.' ? fromStart : `${startRel}/${fromStart}`;
        if (ignored(rel, k.type === 'dir')) continue;
        entries.push({
          rel,
          name: k.name,
          type: k.type,
          size: k.size,
          ...(k.type === 'file' ? { mtimeMs: k.mtimeMs } : {}),
          depth,
        });
        if (k.type === 'dir' && depth < opts.maxDepth) visit(fromStart, depth + 1);
      }
    };
    visit('', 1);
    return { abs: start, rel: startRel, entries, truncated };
  }

  /** Lines matching `query` with the server's ripgrep, or grep (-F / -E) when it has none. */
  async search(opts: {
    query: string;
    regex: boolean;
    caseSensitive: boolean;
    path: string;
    glob?: string | undefined;
    maxResults: number;
    signal?: AbortSignal | undefined;
  }): Promise<{ rel: string; result: SearchResult }> {
    if (!opts.query) throw new WorkspaceError('invalid_path', 'Search query is empty.');
    const { abs, rel: shown } = this.lexical(opts.path, 'read');
    const glob = opts.glob ?? '';
    const r = await this.script(
      'search',
      [
        abs,
        opts.query,
        opts.regex ? 'R' : 'F',
        opts.caseSensitive ? 's' : 'i',
        glob,
        // grep matches --include against file names only; path globs are applied below.
        glob.includes('/') ? '' : glob,
        String(MAX_SEARCH_BYTES),
      ],
      shown,
      { maxBytes: MAX_SEARCH_BYTES + 1024, timeoutMs: 40_000, signal: opts.signal },
    );
    const { values, rest } = fields(r.stdout, 1);
    const engine = values[0] === 'rg' ? 'ripgrep' : 'grep';
    const pathGlob = engine === 'grep' && glob.includes('/') ? globToRegExp(glob) : null;
    const matches: SearchResult['matches'] = [];
    let truncated = rest.length >= MAX_SEARCH_BYTES;
    const text = rest.toString('utf8');
    let at = 0;
    while (at < text.length) {
      const nul = text.indexOf('\0', at);
      const nl = nul === -1 ? -1 : text.indexOf('\n', nul);
      if (nul === -1 || nl === -1) break;
      const file = text.slice(at, nul).replace(/^\.\//, '');
      const line = text.slice(nul + 1, nl);
      at = nl + 1;
      const colon = line.indexOf(':');
      const rel = P.normalize(file);
      if (rel.startsWith('..') || rel.startsWith('/') || isSecretPath(rel) || isGitInternal(rel))
        continue;
      if (pathGlob && !pathGlob.test(rel)) continue;
      if (matches.length >= opts.maxResults) {
        truncated = true;
        break;
      }
      const body = line.slice(colon + 1).replace(/\r$/, '');
      matches.push({
        path: rel,
        line: Number(line.slice(0, colon)) || 0,
        text: body.length > 300 ? `${body.slice(0, 300)}…` : body,
      });
    }
    return { rel: shown, result: { matches, truncated, engine } };
  }

  /** Where a write to `input` lands (like resolveWrite): its real path and whether it exists. */
  async resolveWrite(input: string): Promise<{ abs: string; rel: string; exists: boolean }> {
    if (!input?.trim()) throw new WorkspaceError('invalid_path', 'Invalid path.');
    const { abs, rel: shown } = this.lexical(input, 'write');
    const r = await this.script('probeWrite', [abs], shown);
    const kind = fields(r.stdout, 1).values[0];
    if (kind === 'E') {
      const real = fields(r.stdout, 2).values[1]!;
      return { abs: real, rel: this.checkReal(real, shown, 'write'), exists: true };
    }
    const [, realAncestor, ancestor] = fields(r.stdout, 3).values as [string, string, string];
    const target = P.join(realAncestor, P.relative(ancestor, abs));
    return { abs: target, rel: this.checkReal(target, shown, 'write'), exists: false };
  }

  async write(abs: string, content: string | Buffer): Promise<void> {
    const rel = this.checkReal(abs, this.relOf(abs), 'write');
    await this.script('write', [abs], rel, { input: content, timeoutMs: 60_000 });
  }

  async remove(abs: string): Promise<void> {
    const rel = this.checkReal(abs, this.relOf(abs), 'write');
    await this.script('remove', [abs], rel);
  }

  async move(fromAbs: string, toAbs: string): Promise<void> {
    this.checkReal(fromAbs, this.relOf(fromAbs), 'write');
    const toRel = this.checkReal(toAbs, this.relOf(toAbs), 'write');
    await this.script('move', [fromAbs, toAbs], toRel);
  }

  /** git in the project folder on the server. */
  async git(
    args: string[],
    opts: { timeoutMs?: number; signal?: AbortSignal | undefined } = {},
  ): Promise<GitRunResult> {
    const r = await this.transport.exec(shCommand(PRELUDE + SCRIPTS.git, [this.root, ...args]), {
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBytes: 4 * 1024 * 1024,
      signal: opts.signal,
    });
    if (r.cancelled) throw new WorkspaceError('unsupported', 'Cancelled.');
    if (r.timedOut) throw new WorkspaceError('unsupported', `git on ${this.host.name} timed out.`);
    if (r.code === EXIT.ssh || r.code === EXIT.rootMissing) throw this.failure(r, '.');
    return { code: r.code, stdout: r.stdout.toString('utf8'), stderr: r.stderr };
  }

  /** Which of these hook scripts the repository on the server has. */
  async gitHooks(names: string[]): Promise<string[]> {
    const r = await this.script('hooks', names, '.');
    return r.stdout
      .toString('utf8')
      .split('\0')
      .filter((n) => names.includes(n));
  }

  /**
   * The ssh command that runs `argv` or `shellCommand` in `cwdAbs` on the server: in a login shell
   * (so PATH from the login's profile applies, as when they log in), in the project folder, and
   * stopped by the server's `timeout` too, so a command Friday gave up on doesn't keep running.
   */
  commandLine(
    cwdAbs: string,
    command: { argv: string[] | null; shellCommand: string | null },
    timeoutSeconds: number,
  ): string {
    const args = command.argv
      ? [cwdAbs, String(timeoutSeconds), 'argv', ...command.argv]
      : [cwdAbs, String(timeoutSeconds), 'shell', command.shellCommand ?? ''];
    return shCommand(COMMAND_SCRIPT, args);
  }
}

// ── Choosing a project folder on a host ─────────────────────────────────────────────────────────

const FORBIDDEN_REMOTE_PREFIXES = [
  '/proc',
  '/sys',
  '/dev',
  '/boot',
  '/etc',
  '/run',
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib32',
  '/lib64',
  '/libx32',
  '/snap',
  '/lost+found',
  '/var/log',
  '/var/lib',
  '/var/cache',
  '/var/spool',
  '/var/run',
  '/var/tmp',
  '/tmp',
];

/**
 * The breadth rules for a project folder on a server: a specific folder at least two levels deep
 * (/var/www/app, /srv/app, /home/deploy/app), never system folders, the login's home or one of
 * its parents, or a credentials folder.
 */
export function checkRemoteRoot(p: string, home: string): void {
  const tooBroad = () =>
    new WorkspaceError(
      'forbidden_path',
      `"${p}" is too broad to authorize. Choose the specific project folder (for example /var/www/my-app).`,
    );
  if (!p.startsWith('/') || /[\0\n]/.test(p) || p.length > 4096)
    throw new WorkspaceError('invalid_path', 'Give the absolute path of the folder on the server.');
  const norm = P.normalize(p).replace(/\/+$/, '') || '/';
  if (norm.split('/').filter(Boolean).length < 2) throw tooBroad();
  if (FORBIDDEN_REMOTE_PREFIXES.some((f) => within(f, norm))) throw tooBroad();
  const h = P.normalize(home || '/').replace(/\/+$/, '') || '/';
  if (within(norm, h)) throw tooBroad();
  if (isSecretPath(norm))
    throw new WorkspaceError(
      'secret_file',
      `"${p}" is a credentials folder and can't be a project.`,
    );
}

async function hostScript(
  transport: RemoteTransport,
  name: keyof typeof HOST_SCRIPTS,
  args: string[],
  shown: string,
): Promise<Buffer> {
  const r = await transport.exec(shCommand(HOST_SCRIPTS[name], args), {
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxBytes: 1024 * 1024,
  });
  if (r.timedOut)
    throw new WorkspaceError('unsupported', `${transport.host.name} did not answer in time.`);
  if (r.code === 0 || r.truncated) return r.stdout;
  if (r.code === EXIT.ssh)
    throw new WorkspaceError(
      'root_unavailable',
      `Could not reach ${transport.host.name}: ${explainSshFailure(r.stderr)}`,
    );
  if (r.code === EXIT.notFound)
    throw new WorkspaceError('not_found', `"${shown}" does not exist on ${transport.host.name}.`);
  if (r.code === EXIT.notDir)
    throw new WorkspaceError('not_a_directory', `"${shown}" is not a folder.`);
  throw new WorkspaceError(
    'unsupported',
    `${transport.host.name} reported an error (exit ${r.code ?? 'none'}): ${r.stderr.trim().slice(0, 200)}`,
  );
}

/** Subfolders of `dir` on the host (default: the login's home), for the folder picker. */
export async function browseRemote(
  transport: RemoteTransport,
  dir: string | null,
): Promise<{ path: string; home: string; folders: string[] }> {
  if (dir !== null && (!dir.startsWith('/') || /[\0\n]/.test(dir)))
    throw new WorkspaceError('invalid_path', 'Give an absolute path.');
  const out = await hostScript(transport, 'browse', dir ? [dir] : [], dir ?? '~');
  const { values, rest } = fields(out, 2);
  const folders = rest
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .filter((f) => !isSecretPath(f))
    .sort((a, b) => a.localeCompare(b));
  return { path: values[0]!, home: values[1]!, folders };
}

/** The canonical project folder for `input` on the host, after the breadth rules. */
export async function resolveRemoteRoot(
  transport: RemoteTransport,
  input: string,
): Promise<string> {
  const typed = input.trim();
  if (!typed.startsWith('/'))
    throw new WorkspaceError('invalid_path', 'Give the absolute path of the folder on the server.');
  const { path: real, home } = await browseRemote(transport, typed);
  checkRemoteRoot(typed, home);
  checkRemoteRoot(real, home);
  return real;
}
