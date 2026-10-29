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
  const segments = relPath.split(/[\\/]/).filter(Boolean);
  if (segments.some((s) => SECRET_DIRS.has(s))) return true;
  const base = segments.at(-1) ?? '';
  const lower = base.toLowerCase();
  if (/^\.env(\..+)?$/i.test(base) && !ENV_TEMPLATE.test(base)) return true;
  if (SECRET_BASENAMES.has(lower)) return true;
  return SECRET_EXTENSIONS.has(path.extname(lower));
}

/** Git internals (including remotes with embedded tokens) are off-limits until the Git tools exist. */
function isGitInternal(relPath: string): boolean {
  return relPath.split(/[\\/]/).includes('.git');
}

export interface ResolvedPath {
  abs: string;
  rel: string;
}

/**
 * Resolve a model-supplied path inside `root` (which must already be canonical).
 * Rejects traversal, absolute paths outside the root, symlinks that escape the root,
 * secret files, and git internals. The target must exist.
 */
export async function resolveInside(root: string, input: string): Promise<ResolvedPath> {
  if (typeof input !== 'string' || input.includes('\0') || input.length > 4096) {
    throw new WorkspaceError('invalid_path', 'Invalid path.');
  }
  const trimmed = input.trim() || '.';
  const lexical = path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(root, trimmed);
  if (!isWithin(root, lexical)) {
    throw new WorkspaceError('outside_root', `Path "${input}" is outside the project root.`);
  }

  let real: string;
  try {
    real = await fs.realpath(lexical);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new WorkspaceError('not_found', `Path "${toRel(root, lexical)}" does not exist.`);
    }
    throw new WorkspaceError('invalid_path', `Cannot access "${toRel(root, lexical)}".`);
  }
  if (!isWithin(root, real)) {
    throw new WorkspaceError(
      'outside_root',
      `Path "${toRel(root, lexical)}" resolves (via a symlink) to a location outside the project root.`,
    );
  }

  const rel = toRel(root, real);
  for (const candidate of [toRel(root, lexical), rel]) {
    if (isSecretPath(candidate)) {
      throw new WorkspaceError(
        'secret_file',
        `"${candidate}" looks like a credentials file, so it is never read (its contents could be sent to the model provider).`,
      );
    }
    if (isGitInternal(candidate)) {
      throw new WorkspaceError('forbidden_path', 'Reading .git internals is not allowed.');
    }
  }
  return { abs: real, rel };
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
  if (typeof input !== 'string' || input.includes('\0') || input.length > 4096 || !input.trim()) {
    throw new WorkspaceError('invalid_path', 'Invalid path.');
  }
  const trimmed = input.trim();
  const lexical = path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(root, trimmed);
  if (!isWithin(root, lexical) || lexical === root) {
    throw new WorkspaceError('outside_root', `Path "${input}" is outside the project root.`);
  }
  const check = (rel: string) => {
    if (isSecretPath(rel)) {
      throw new WorkspaceError(
        'secret_file',
        `"${rel}" looks like a credentials file; Friday does not write credential files. Ask the user to edit it.`,
      );
    }
    if (isGitInternal(rel))
      throw new WorkspaceError('forbidden_path', 'Writing .git internals is not allowed.');
  };
  check(toRel(root, lexical));

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
      `Path "${toRel(root, lexical)}" resolves (via a symlink) to a location outside the project root.`,
    );
  }

  if (probe === lexical) {
    const stat = await fs.stat(realProbe);
    if (!stat.isFile())
      throw new WorkspaceError('not_a_file', `"${toRel(root, lexical)}" is not a regular file.`);
    const rel = toRel(root, realProbe);
    check(rel);
    return { abs: realProbe, rel, exists: true };
  }
  if (!(await fs.stat(realProbe)).isDirectory()) {
    throw new WorkspaceError('not_a_directory', `"${toRel(root, probe)}" is a file, not a folder.`);
  }
  const abs = path.join(realProbe, path.relative(probe, lexical));
  const rel = toRel(root, abs);
  check(rel);
  return { abs, rel, exists: false };
}
