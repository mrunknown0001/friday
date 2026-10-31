import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { childEnv } from '../commands/runner.js';

/** The installed k6: FRIDAY_K6, else `k6` on PATH. Friday never installs it. */

async function onPath(name: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const executable = (p: string) =>
    fs
      .access(p, fs.constants.X_OK)
      .then(() => p)
      .catch(() => null);
  if (path.isAbsolute(name)) return executable(name);
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const found = await executable(path.join(dir, name));
    if (found) return found;
  }
  return null;
}

export interface K6 {
  path: string;
  version: string;
}

let cached: { key: string; k6: K6 | null } | null = null;

export async function findK6(env: NodeJS.ProcessEnv = process.env): Promise<K6 | null> {
  const key = `${env.FRIDAY_K6 ?? ''}|${env.PATH ?? ''}`;
  if (cached?.key === key) return cached.k6;
  const bin = await onPath(env.FRIDAY_K6 || 'k6', env);
  let k6: K6 | null = null;
  if (bin) {
    const version = await new Promise<string | null>((resolve) =>
      execFile(bin, ['version'], { env: childEnv(), timeout: 10_000 }, (err, out) =>
        resolve(err ? null : (out.split('\n')[0]?.trim() ?? null)),
      ),
    );
    if (version && /^k6 v/.test(version))
      k6 = { path: bin, version: version.split(' ').slice(0, 2).join(' ') };
  }
  cached = { key, k6 };
  return k6;
}

export const K6_INSTALL =
  'k6 is not installed. Friday does not install it; the user can install it (https://grafana.com/docs/k6/latest/set-up/install-k6/) or set FRIDAY_K6 to its path, then restart Friday.';

/**
 * The k6 command for a generated script: no usage report to Grafana, no REST API server, plain
 * output. The summary file is where the script's handleSummary writes.
 */
export function k6Argv(k6: string, script: string, summary: string): string[] {
  return [
    k6,
    'run',
    '--no-usage-report',
    '--address=',
    '--quiet',
    '--no-color',
    '--env',
    `FRIDAY_SUMMARY=${summary}`,
    script,
  ];
}
