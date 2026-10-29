import fs from 'node:fs/promises';
import path from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { toRel } from './paths.js';

/** Directories skipped by default: dependencies, build output, caches, VCS internals. */
export const DEFAULT_EXCLUDED_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'bower_components',
  'vendor',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.output',
  '.vercel',
  'coverage',
  'target',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  '.cache',
  '.turbo',
  '.parcel-cache',
  '.gradle',
  '.terraform',
  '.idea',
]);

const MAX_GITIGNORE_BYTES = 256 * 1024;

export interface WalkEntry {
  rel: string;
  name: string;
  type: 'file' | 'dir' | 'symlink';
  size: number | null;
  /** Files only: modification time in ms (null if it could not be read). */
  mtimeMs?: number | null;
  depth: number;
}

interface Layer {
  base: string; // absolute directory the .gitignore lives in
  ig: Ignore;
}

async function loadGitignore(dir: string): Promise<Layer | null> {
  try {
    const file = path.join(dir, '.gitignore');
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > MAX_GITIGNORE_BYTES) return null;
    return { base: dir, ig: ignore().add(await fs.readFile(file, 'utf8')) };
  } catch {
    return null;
  }
}

function isIgnored(layers: Layer[], abs: string, isDir: boolean): boolean {
  for (const layer of layers) {
    const rel = path.relative(layer.base, abs).split(path.sep).join('/');
    if (!rel || rel.startsWith('..')) continue;
    if (layer.ig.ignores(isDir ? `${rel}/` : rel)) return true;
  }
  return false;
}

export interface WalkOptions {
  maxDepth: number;
  maxEntries: number;
  /** Include directories in the output (files are always included). */
  includeDirs?: boolean;
  signal?: AbortSignal;
}

export interface WalkResult {
  entries: WalkEntry[];
  truncated: boolean;
}

/**
 * Depth-first listing under `startAbs` (inside canonical `root`), directories first, honouring
 * nested .gitignore files and the default exclusions. Symlinks are reported but never followed.
 */
export async function walk(root: string, startAbs: string, opts: WalkOptions): Promise<WalkResult> {
  const entries: WalkEntry[] = [];
  let truncated = false;

  // .gitignore files from the root down to the start directory also apply.
  const layers: Layer[] = [];
  const chain: string[] = [];
  for (let dir = startAbs; ; dir = path.dirname(dir)) {
    chain.unshift(dir);
    if (dir === root || path.dirname(dir) === dir) break;
  }
  for (const dir of chain.slice(0, -1)) {
    const layer = await loadGitignore(dir);
    if (layer) layers.push(layer);
  }

  const visit = async (dir: string, depth: number, inherited: Layer[]): Promise<void> => {
    if (truncated || opts.signal?.aborted) return;
    const own = await loadGitignore(dir);
    const active = own ? [...inherited, own] : inherited;
    let dirents;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory: skip silently
    }
    dirents.sort(
      (a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name),
    );
    for (const d of dirents) {
      if (entries.length >= opts.maxEntries) {
        truncated = true;
        return;
      }
      const abs = path.join(dir, d.name);
      const isDir = d.isDirectory();
      if (isDir && DEFAULT_EXCLUDED_DIRS.has(d.name)) continue;
      if (isIgnored(active, abs, isDir)) continue;
      const rel = toRel(root, abs);
      if (d.isSymbolicLink()) {
        entries.push({ rel, name: d.name, type: 'symlink', size: null, depth });
      } else if (isDir) {
        if (opts.includeDirs !== false)
          entries.push({ rel, name: d.name, type: 'dir', size: null, depth });
        if (depth < opts.maxDepth) await visit(abs, depth + 1, active);
      } else if (d.isFile()) {
        const stat = await fs.stat(abs).catch(() => null);
        entries.push({
          rel,
          name: d.name,
          type: 'file',
          size: stat?.size ?? null,
          mtimeMs: stat ? Math.floor(stat.mtimeMs) : null,
          depth,
        });
      }
      if (truncated) return;
    }
  };

  await visit(startAbs, 1, layers);
  return { entries, truncated };
}

export function formatSize(bytes: number | null): string {
  if (bytes === null) return '?';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
