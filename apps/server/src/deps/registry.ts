import { execFile } from 'node:child_process';
import { childEnv } from '../commands/runner.js';
import { compareVersions, isStable } from './versions.js';
import type { Ecosystem } from './manifests.js';

/**
 * Release history from the package registries: `npm view` (so the project's .npmrc registry
 * settings apply) and Packagist's metadata API. Read-only: only package names are sent.
 */

export interface Release {
  version: string;
  /** ISO publish time; null when the registry does not say. */
  time: string | null;
}

export interface PackageInfo {
  name: string;
  /** Stable releases, newest first. */
  releases: Release[];
  latest: string | null;
  /** Source repository URL, when published. */
  repository: string | null;
  error: string | null;
}

export type Fetch = typeof fetch;

const CACHE_MS = 10 * 60_000;
const cache = new Map<string, { at: number; info: PackageInfo }>();

function npmView(
  name: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(
      'npm',
      ['view', '--json', '--', name, 'time', 'dist-tags', 'repository'],
      {
        cwd,
        env: childEnv(),
        timeout: 30_000,
        maxBuffer: 32 * 1024 * 1024,
        ...(signal ? { signal } : {}),
      },
      (err, stdout, stderr) => resolve({ ok: !err, out: err ? `${stderr}${stdout}` : stdout }),
    );
  });
}

export function parseNpmView(name: string, out: string): PackageInfo {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(out) as Record<string, unknown>;
  } catch {
    return {
      name,
      releases: [],
      latest: null,
      repository: null,
      error: 'unreadable registry data',
    };
  }
  const time = (data.time ?? {}) as Record<string, string>;
  const tags = (data['dist-tags'] ?? {}) as Record<string, string>;
  const repo = data.repository as { url?: string } | string | undefined;
  const releases = Object.entries(time)
    .filter(([v]) => v !== 'created' && v !== 'modified' && isStable(v))
    .map(([version, t]) => ({ version, time: t }))
    .sort((a, b) => compareVersions(b.version, a.version));
  return {
    name,
    releases,
    latest: tags.latest ?? releases[0]?.version ?? null,
    repository: typeof repo === 'string' ? repo : (repo?.url ?? null),
    error: null,
  };
}

/** Packagist "p2" metadata is minified: each entry lists only the fields that changed. */
export function expandPackagist(
  list: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  let prev: Record<string, unknown> = {};
  for (const entry of list) {
    const full: Record<string, unknown> = { ...prev, ...entry };
    for (const [k, v] of Object.entries(full)) if (v === '__unset') delete full[k];
    out.push(full);
    prev = full;
  }
  return out;
}

export function parsePackagist(name: string, body: unknown): PackageInfo {
  const list = (body as { packages?: Record<string, Array<Record<string, unknown>>> })?.packages?.[
    name.toLowerCase()
  ];
  if (!Array.isArray(list))
    return { name, releases: [], latest: null, repository: null, error: 'not on Packagist' };
  const all = expandPackagist(list);
  const releases = all
    .map((p) => ({
      version: String(p.version ?? '').replace(/^v/i, ''),
      time: typeof p.time === 'string' ? p.time : null,
    }))
    .filter((r) => r.version && isStable(r.version))
    .sort((a, b) => compareVersions(b.version, a.version));
  const source = (all[0]?.source as { url?: string } | undefined)?.url ?? null;
  return { name, releases, latest: releases[0]?.version ?? null, repository: source, error: null };
}

export async function packageInfo(
  ecosystem: Ecosystem,
  name: string,
  opts: { cwd: string; fetch?: Fetch; signal?: AbortSignal; npm?: typeof npmView },
): Promise<PackageInfo> {
  const key = `${ecosystem}:${opts.cwd}:${name}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.info;
  let info: PackageInfo;
  if (ecosystem === 'npm') {
    const r = await (opts.npm ?? npmView)(name, opts.cwd, opts.signal);
    info = r.ok
      ? parseNpmView(name, r.out)
      : {
          name,
          releases: [],
          latest: null,
          repository: null,
          error: /E404|404 Not Found/.test(r.out)
            ? 'not found in the registry'
            : `registry lookup failed: ${r.out.trim().split('\n')[0]?.slice(0, 160) ?? 'unknown error'}`,
        };
  } else {
    try {
      const res = await (opts.fetch ?? fetch)(
        `https://repo.packagist.org/p2/${encodeURIComponent(name.toLowerCase()).replace('%2F', '/')}.json`,
        {
          headers: { 'user-agent': 'Friday (dependency report)' },
          signal: AbortSignal.any([
            AbortSignal.timeout(20_000),
            ...(opts.signal ? [opts.signal] : []),
          ]),
        },
      );
      info =
        res.status === 404
          ? { name, releases: [], latest: null, repository: null, error: 'not on Packagist' }
          : res.ok
            ? parsePackagist(name, await res.json())
            : {
                name,
                releases: [],
                latest: null,
                repository: null,
                error: `Packagist answered HTTP ${res.status}`,
              };
    } catch (err) {
      info = {
        name,
        releases: [],
        latest: null,
        repository: null,
        error: `Packagist lookup failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  if (!info.error) cache.set(key, { at: Date.now(), info });
  return info;
}

/** Run `fn` over `items`, a few at a time, keeping the order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (t: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

export function clearRegistryCache(): void {
  cache.clear();
}
