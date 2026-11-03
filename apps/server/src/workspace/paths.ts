import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Errors whose messages are safe to show to the model and the user. */
export class WorkspaceError extends Error {
  constructor(
    readonly code:
      | 'outside_root'
      | 'not_found'
      | 'not_a_file'
      | 'not_a_directory'
      | 'secret_file'
      | 'forbidden_path'
      | 'invalid_path'
      | 'root_unavailable'
      | 'too_large'
      | 'unsupported',
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

export function isWithin(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** Display form of a path relative to the project root, always with forward slashes. */
export function toRel(root: string, abs: string): string {
  const rel = path.relative(root, abs);
  return rel === '' ? '.' : rel.split(path.sep).join('/');
}

const SECRET_BASENAMES = new Set([
  '.npmrc',
  '.pypirc',
  '.netrc',
  '_netrc',
  '.git-credentials',
  '.htpasswd',
  'credentials',
  'credentials.json',
  'auth.json',
  'secrets.json',
  'secrets.yml',
  'secrets.yaml',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
]);
const SECRET_EXTENSIONS = new Set([
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.jks',
  '.keystore',
  '.tfstate',
  '.kdbx',
]);
const SECRET_DIRS = new Set(['.ssh', '.aws', '.gnupg', '.azure', '.kube']);
const ENV_TEMPLATE = /\.(example|sample|template|dist|defaults)$/i;

/**
 * Files that commonly hold credentials. Reading them would send secrets to the model provider, so
 * they are blocked even inside an authorized project. Templates like `.env.example` stay readable.
 */
export function isSecretPath(relPath: string): boolean {
  // Compared case-insensitively: on Windows drives (/mnt/c under WSL) ".KUBE" is ".kube".
  const segments = relPath
    .split(/[\\/]/)
    .filter(Boolean)
    .map((s) => s.toLowerCase());
  if (segments.some((s) => SECRET_DIRS.has(s))) return true;
  const base = segments.at(-1) ?? '';
  const lower = base.toLowerCase();
  if (/^\.env(\..+)?$/i.test(base) && !ENV_TEMPLATE.test(base)) return true;
  if (SECRET_BASENAMES.has(lower)) return true;
  return SECRET_EXTENSIONS.has(path.extname(lower));
}

/**
 * Git internals (config can hold remotes with embedded tokens, hooks are executable). Compared
 * case-insensitively for case-insensitive filesystems, where ".GIT/config" is ".git/config".
 */
export function isGitInternal(relPath: string): boolean {
  return relPath.split(/[\\/]/).some((s) => s.toLowerCase() === '.git');
}

export interface ResolvedPath {
  abs: string;
  rel: string;
}

/** The project root plus the external folders the user authorized for it, all canonical. */
export interface Workspace {
  root: string;
  external: readonly string[];
}

export const workspaceOf = (p: {
  rootPath: string;
  externalFolders: readonly string[];
}): Workspace => ({ root: p.rootPath, external: p.externalFolders });

/** A folder paths are confined to, and how paths in it are shown. */
interface Scope {
  root: string;
  /** External folders show absolute paths; the project shows paths relative to its root. */
  external: boolean;
  /** What a path that escapes is outside of, for error messages. */
  outsideOf: string;
}

const projectScope = (root: string): Scope => ({
  root,
  external: false,
  outsideOf: 'the project root',
});

const show = (scope: Scope, abs: string) => (scope.external ? abs : toRel(scope.root, abs));

/**
 * The folder a path is confined to: an absolute path inside one of the external folders resolves
 * against that folder; everything else (relative paths, paths in the project) against the root.
 */
function scopeFor(ws: Workspace, input: unknown): Scope {
  const trimmed = typeof input === 'string' ? input.trim() : '';
  if (path.isAbsolute(trimmed) && !trimmed.includes('\0')) {
    const lexical = path.normalize(trimmed);
    const folder = isWithin(ws.root, lexical)
      ? undefined
      : ws.external.find((f) => isWithin(f, lexical));
    if (folder) return { root: folder, external: true, outsideOf: `the external folder ${folder}` };
  }
  return {
    root: ws.root,
    external: false,
    outsideOf: ws.external.length
      ? 'the project root and its external folders'
      : 'the project root',
  };
}

/** A path resolved in a workspace, with the folder it was confined to. */
export interface ScopedPath extends ResolvedPath {
  root: string;
  external: boolean;
}

/** How a path relative to `scoped.root` (from walk or search) is shown: absolute when external. */
export function shownPath(scoped: { root: string; external: boolean }, rel: string): string {
  if (!scoped.external) return rel;
  return rel === '.' ? scoped.root : path.join(scoped.root, ...rel.split('/'));
}

/**
 * Resolve a model-supplied path inside `root` (which must already be canonical).
 * Rejects traversal, absolute paths outside the root, symlinks that escape the root,
 * secret files, and git internals. The target must exist.
 */
export async function resolveInside(root: string, input: string): Promise<ResolvedPath> {
  return resolveInScope(projectScope(root), input);
}

/**
 * `resolveInside` for a project with external folders: relative paths resolve in the project,
 * absolute paths in the project or in an external folder (with the same rules inside it). `rel`
 * is the form shown to the model and the user: relative in the project, absolute outside it.
 */
export async function resolveRead(ws: Workspace, input: string): Promise<ScopedPath> {
  const scope = scopeFor(ws, input);
  return { ...(await resolveInScope(scope, input)), root: scope.root, external: scope.external };
}

async function resolveInScope(scope: Scope, input: string): Promise<ResolvedPath> {
  if (typeof input !== 'string' || input.includes('\0') || input.length > 4096) {
    throw new WorkspaceError('invalid_path', 'Invalid path.');
  }
  const { root } = scope;
  const trimmed = input.trim() || '.';
  const lexical = path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(root, trimmed);
  if (!isWithin(root, lexical)) {
    throw new WorkspaceError('outside_root', `Path "${input}" is outside ${scope.outsideOf}.`);
  }

  let real: string;
  try {
    real = await fs.realpath(lexical);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new WorkspaceError('not_found', `Path "${show(scope, lexical)}" does not exist.`);
    }
    throw new WorkspaceError('invalid_path', `Cannot access "${show(scope, lexical)}".`);
  }
  if (!isWithin(root, real)) {
    throw new WorkspaceError(
      'outside_root',
      `Path "${show(scope, lexical)}" resolves (via a symlink) to a location outside ${scope.outsideOf}.`,
    );
  }

  for (const candidate of [lexical, real]) {
    const rel = toRel(root, candidate);
    if (isSecretPath(rel)) {
      throw new WorkspaceError(
        'secret_file',
        `"${show(scope, candidate)}" looks like a credentials file, so it is never read (its contents could be sent to the model provider).`,
      );
    }
    if (isGitInternal(rel)) {
      throw new WorkspaceError('forbidden_path', 'Reading .git internals is not allowed.');
    }
  }
  return { abs: real, rel: show(scope, real) };
}

const FORBIDDEN_ROOTS = new Set([
  '/',
  '/bin',
  '/boot',
  '/dev',
  '/etc',
  '/home',
  '/lib',
  '/lib32',
  '/lib64',
  '/media',
  '/mnt',
  '/opt',
  '/proc',
  '/root',
  '/run',
  '/sbin',
  '/srv',
  '/sys',
  '/tmp',
  '/usr',
  '/var',
  '/Users',
  '/Volumes',
  '/System',
  '/Library',
  '/private',
]);
const FORBIDDEN_PREFIXES = ['/proc/', '/sys/', '/dev/', '/boot/', '/etc/'];

/**
 * Validate a folder the user wants to authorize as a project and return its canonical path.
 * Broad locations (filesystem roots, the home directory, system directories, whole drives) are
 * refused so a single authorization cannot expose the whole machine.
 */
export async function resolveProjectRoot(input: string): Promise<string> {
  if (typeof input !== 'string' || input.includes('\0') || !path.isAbsolute(input.trim())) {
    throw new WorkspaceError('invalid_path', 'Enter an absolute folder path.');
  }
  const home = await fs.realpath(os.homedir()).catch(() => os.homedir());
  const assertAllowed = (p: string) => {
    const isDriveMount = /^\/mnt\/[a-z]$/i.test(p) || /^[A-Za-z]:\\?$/.test(p);
    if (
      FORBIDDEN_ROOTS.has(p) ||
      p === home ||
      isDriveMount ||
      FORBIDDEN_PREFIXES.some((prefix) => p.startsWith(prefix)) ||
      isWithin(p, home)
    ) {
      throw new WorkspaceError(
        'forbidden_path',
        'That folder is too broad to authorize. Choose a specific project folder.',
      );
    }
    if (isSecretPath(p)) throw new WorkspaceError('secret_file', 'That folder holds credentials.');
  };

  // Check the path as typed and again after resolving symlinks.
  assertAllowed(path.normalize(input.trim()).replace(/(.)\/+$/, '$1'));
  let real: string;
  try {
    real = await fs.realpath(input.trim());
  } catch {
    throw new WorkspaceError('not_found', 'That folder does not exist.');
  }
  const stat = await fs.stat(real);
  if (!stat.isDirectory())
    throw new WorkspaceError('not_a_directory', 'That path is not a folder.');
  assertAllowed(real);
  return real;
}

/** Confirm an authorized root still exists and has not been swapped for a symlink. */
export async function assertRootAvailable(root: string): Promise<void> {
  try {
    const real = await fs.realpath(root);
    const stat = await fs.stat(real);
    if (real !== root || !stat.isDirectory()) throw new Error('changed');
  } catch {
    throw new WorkspaceError(
      'root_unavailable',
      'The project folder is missing or has changed. Re-add the project to continue.',
    );
  }
}

export interface WritePath extends ResolvedPath {
  exists: boolean;
}

/**
 * Resolve a path the agent wants to create, modify, delete, or move, which may not exist yet.
 * The nearest existing ancestor must resolve inside the root (no writing through a symlinked
 * directory that points elsewhere). Existing targets are resolved to their real path, so a
 * symlink is never replaced. Credential files and .git internals are never written.
 */
export async function resolveForWrite(root: string, input: string): Promise<WritePath> {
  return resolveWriteInScope(projectScope(root), input);
}

/** `resolveForWrite` for a project with external folders (see `resolveRead`). */
export async function resolveWrite(
  ws: Workspace,
  input: string,
): Promise<WritePath & { root: string; external: boolean }> {
  const scope = scopeFor(ws, input);
  return {
    ...(await resolveWriteInScope(scope, input)),
    root: scope.root,
    external: scope.external,
  };
}

async function resolveWriteInScope(scope: Scope, input: string): Promise<WritePath> {
  if (typeof input !== 'string' || input.includes('\0') || input.length > 4096 || !input.trim()) {
    throw new WorkspaceError('invalid_path', 'Invalid path.');
  }
  const { root } = scope;
  const trimmed = input.trim();
  const lexical = path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(root, trimmed);
  if (!isWithin(root, lexical) || lexical === root) {
    throw new WorkspaceError('outside_root', `Path "${input}" is outside ${scope.outsideOf}.`);
  }
  const check = (abs: string) => {
    const rel = toRel(root, abs);
    if (isSecretPath(rel)) {
      throw new WorkspaceError(
        'secret_file',
        `"${show(scope, abs)}" looks like a credentials file; Friday does not write credential files. Ask the user to edit it.`,
      );
    }
    if (isGitInternal(rel))
      throw new WorkspaceError('forbidden_path', 'Writing .git internals is not allowed.');
  };
  check(lexical);

  let probe = lexical;
  for (;;) {
    try {
      await fs.lstat(probe);
      break;
    } catch {
      probe = path.dirname(probe);
    }
  }
  const realProbe = await fs.realpath(probe);
  if (!isWithin(root, realProbe)) {
    throw new WorkspaceError(
      'outside_root',
      `Path "${show(scope, lexical)}" resolves (via a symlink) to a location outside ${scope.outsideOf}.`,
    );
  }

  if (probe === lexical) {
    const stat = await fs.stat(realProbe);
    if (!stat.isFile())
      throw new WorkspaceError('not_a_file', `"${show(scope, lexical)}" is not a regular file.`);
    check(realProbe);
    return { abs: realProbe, rel: show(scope, realProbe), exists: true };
  }
  if (!(await fs.stat(realProbe)).isDirectory()) {
    throw new WorkspaceError('not_a_directory', `"${show(scope, probe)}" is a file, not a folder.`);
  }
  const abs = path.join(realProbe, path.relative(probe, lexical));
  check(abs);
  return { abs, rel: show(scope, abs), exists: false };
}

export const MAX_EXTERNAL_FOLDERS = 10;

/**
 * Validate a folder the user wants to add to a project's external folders and return its
 * canonical path: the same breadth rules as a project root, and no overlap with the project or
 * with another external folder (each path then belongs to exactly one folder).
 */
export async function resolveExternalFolder(
  input: string,
  projectRoot: string,
  others: readonly string[],
): Promise<string> {
  const real = await resolveProjectRoot(input);
  if (isWithin(projectRoot, real) || isWithin(real, projectRoot)) {
    throw new WorkspaceError(
      'forbidden_path',
      `${real} overlaps the project folder; external folders must be outside it.`,
    );
  }
  if (others.includes(real))
    throw new WorkspaceError('invalid_path', `${real} is already an external folder.`);
  const overlap = others.find((o) => isWithin(o, real) || isWithin(real, o));
  if (overlap)
    throw new WorkspaceError('forbidden_path', `${real} overlaps the external folder ${overlap}.`);
  return real;
}
