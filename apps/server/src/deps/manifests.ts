import fs from 'node:fs/promises';
import path from 'node:path';
import { toRel } from '../workspace/paths.js';

/**
 * Where a project's dependencies are declared: npm folders (package.json + package-lock.json,
 * with workspaces) and Composer folders (composer.json + composer.lock). Only direct dependencies
 * are upgraded; their current versions come from the lockfile, so nothing has to be installed.
 */

export type Ecosystem = 'npm' | 'composer';

export interface DirectDep {
  name: string;
  /** Workspace folder relative to the npm root (null: the root package itself). */
  workspace: string | null;
  dev: boolean;
  /** The manifest section it is listed in. */
  field: 'dependencies' | 'optionalDependencies' | 'devDependencies' | 'require' | 'require-dev';
  /** As written in the manifest: "^4.17.20", "~2.0", "5.7.1". */
  spec: string;
  /** Locked version, or null when the lockfile has none. */
  current: string | null;
}

export interface DepsFolder {
  ecosystem: Ecosystem;
  /** Project-relative folder ("." for the root). */
  rel: string;
  abs: string;
  /** Manifest and lockfiles an upgrade may change (project-relative). */
  files: string[];
  deps: DirectDep[];
  /** Dependencies left out, with why (git URLs, local paths, workspace links). */
  skipped: Array<{ name: string; why: string }>;
}

export interface DepsScan {
  folders: DepsFolder[];
  /** Folders using a package manager Friday doesn't upgrade yet. */
  unsupported: Array<{ rel: string; manager: string }>;
}

const IGNORE = new Set(['node_modules', 'vendor', '.git', 'dist', 'build', '.next', 'coverage']);
const NON_REGISTRY =
  /^(file:|link:|portal:|workspace:|git(\+\w+)?:|github:|gitlab:|bitbucket:|https?:|npm:)/;
const PLATFORM = /^(php|hhvm|ext-.+|lib-.+|composer(-plugin|-runtime)?-api)$/i;

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    const text = await fs.readFile(file, 'utf8');
    if (text.length > 20_000_000) return null;
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const exists = (file: string) =>
  fs
    .stat(file)
    .then(() => true)
    .catch(() => false);

type Json = Record<string, unknown>;
const obj = (v: unknown): Record<string, string> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, string>) : {};

/** Folders matched by npm workspace patterns ("apps/*", "packages/core"). */
async function workspaceDirs(rootAbs: string, patterns: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const raw of patterns) {
    const pattern = raw.replace(/\/+$/, '');
    if (pattern.includes('..') || path.isAbsolute(pattern)) continue;
    if (pattern.endsWith('/*') && !pattern.slice(0, -2).includes('*')) {
      const base = path.join(rootAbs, pattern.slice(0, -2));
      const entries = await fs.readdir(base, { withFileTypes: true }).catch(() => []);
      for (const e of entries)
        if (e.isDirectory() && (await exists(path.join(base, e.name, 'package.json'))))
          out.push(path.join(base, e.name));
    } else if (
      !pattern.includes('*') &&
      (await exists(path.join(rootAbs, pattern, 'package.json')))
    )
      out.push(path.join(rootAbs, pattern));
  }
  return [...new Set(out)].sort();
}

function lockedNpm(lock: Json | null, wsRel: string | null, name: string): string | null {
  const packages = obj(lock?.packages) as unknown as Record<string, { version?: string }>;
  const nested = wsRel ? packages[`${wsRel}/node_modules/${name}`] : undefined;
  const top = packages[`node_modules/${name}`];
  const v1 = (obj(lock?.dependencies) as unknown as Record<string, { version?: string }>)[name];
  return nested?.version ?? top?.version ?? v1?.version ?? null;
}

async function scanNpm(root: string, abs: string): Promise<DepsFolder> {
  const pkg = (await readJson(path.join(abs, 'package.json'))) ?? {};
  const lock = await readJson(path.join(abs, 'package-lock.json'));
  const rawWs = pkg.workspaces;
  const patterns = Array.isArray(rawWs)
    ? (rawWs as string[])
    : Array.isArray((rawWs as Json | undefined)?.packages)
      ? ((rawWs as Json).packages as string[])
      : [];
  const wsDirs = await workspaceDirs(abs, patterns);
  const manifests: Array<{ ws: string | null; json: Json }> = [{ ws: null, json: pkg }];
  for (const d of wsDirs)
    manifests.push({
      ws: path.relative(abs, d).split(path.sep).join('/'),
      json: (await readJson(path.join(d, 'package.json'))) ?? {},
    });
  const local = new Set(manifests.map((m) => String(m.json.name ?? '')).filter(Boolean));
  const deps: DirectDep[] = [];
  const skipped: DepsFolder['skipped'] = [];
  for (const m of manifests) {
    for (const [field, dev] of [
      ['dependencies', false],
      ['optionalDependencies', false],
      ['devDependencies', true],
    ] as const) {
      for (const [name, spec] of Object.entries(obj(m.json[field]))) {
        if (local.has(name)) continue; // another workspace of this repository
        if (typeof spec !== 'string') continue;
        if (NON_REGISTRY.test(spec) || /^[\w.-]+\/[\w.-]+(#.*)?$/.test(spec)) {
          skipped.push({ name, why: `not from the registry (${spec.slice(0, 60)})` });
          continue;
        }
        deps.push({
          name,
          workspace: m.ws,
          dev,
          field,
          spec,
          current: lockedNpm(lock, m.ws, name),
        });
      }
    }
  }
  const rel = toRel(root, abs);
  const prefix = rel === '.' ? '' : `${rel}/`;
  return {
    ecosystem: 'npm',
    rel,
    abs,
    files: [
      `${prefix}package.json`,
      ...manifests.filter((m) => m.ws).map((m) => `${prefix}${m.ws}/package.json`),
      `${prefix}package-lock.json`,
    ],
    deps,
    skipped,
  };
}

async function scanComposer(root: string, abs: string): Promise<DepsFolder> {
  const manifest = (await readJson(path.join(abs, 'composer.json'))) ?? {};
  const lock = await readJson(path.join(abs, 'composer.lock'));
  const locked = new Map<string, string>();
  for (const list of [lock?.packages, lock?.['packages-dev']])
    if (Array.isArray(list))
      for (const p of list as Array<{ name?: string; version?: string }>)
        if (p.name && p.version) locked.set(p.name.toLowerCase(), p.version);
  const deps: DirectDep[] = [];
  const skipped: DepsFolder['skipped'] = [];
  for (const [field, dev] of [
    ['require', false],
    ['require-dev', true],
  ] as const) {
    for (const [name, spec] of Object.entries(obj(manifest[field]))) {
      if (PLATFORM.test(name) || !name.includes('/')) continue;
      if (typeof spec !== 'string') continue;
      if (/^dev-|@dev\b/.test(spec)) {
        skipped.push({ name, why: `a development branch (${spec})` });
        continue;
      }
      deps.push({
        name,
        workspace: null,
        dev,
        field,
        spec,
        current: locked.get(name.toLowerCase())?.replace(/^v/i, '') ?? null,
      });
    }
  }
  const rel = toRel(root, abs);
  const prefix = rel === '.' ? '' : `${rel}/`;
  return {
    ecosystem: 'composer',
    rel,
    abs,
    files: [`${prefix}composer.json`, `${prefix}composer.lock`],
    deps,
    skipped,
  };
}

/** Find dependency folders in the project root and up to two levels below it. */
export async function scanProject(root: string, only?: string): Promise<DepsScan> {
  const folders: DepsFolder[] = [];
  const unsupported: DepsScan['unsupported'] = [];
  const covered = new Set<string>(); // npm workspaces belong to their root's lockfile
  const visit = async (abs: string, depth: number) => {
    const has = async (f: string) => exists(path.join(abs, f));
    if (!covered.has(abs)) {
      if ((await has('package.json')) && (await has('package-lock.json'))) {
        const f = await scanNpm(root, abs);
        folders.push(f);
        for (const file of f.files)
          if (file.endsWith('/package.json')) covered.add(path.dirname(path.join(root, file)));
      } else if (await has('package.json')) {
        const manager = (await has('pnpm-lock.yaml'))
          ? 'pnpm'
          : (await has('yarn.lock'))
            ? 'Yarn'
            : (await has('bun.lockb')) || (await has('bun.lock'))
              ? 'Bun'
              : null;
        if (manager) unsupported.push({ rel: toRel(root, abs), manager });
      }
      if ((await has('composer.json')) && (await has('composer.lock')))
        folders.push(await scanComposer(root, abs));
    }
    if (depth >= 2) return;
    const entries = await fs.readdir(abs, { withFileTypes: true }).catch(() => []);
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name)))
      if (e.isDirectory() && !IGNORE.has(e.name) && !e.name.startsWith('.'))
        await visit(path.join(abs, e.name), depth + 1);
  };
  await visit(only ?? root, only ? 2 : 0);
  // A named folder is scanned on its own (not its subfolders).
  return { folders, unsupported };
}
