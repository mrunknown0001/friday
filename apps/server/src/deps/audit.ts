import { execFile } from 'node:child_process';
import { childEnv } from '../commands/runner.js';
import type { Ecosystem } from './manifests.js';

/**
 * Known vulnerabilities from the package managers' own audits, read from the lockfile only:
 * `npm audit --package-lock-only` and `composer audit --locked`. Composer runs with plugins and
 * scripts off, so no project code runs.
 */

export type Severity = 'low' | 'moderate' | 'high' | 'critical' | 'unknown';

export interface Advisory {
  package: string;
  title: string;
  severity: Severity;
  url: string | null;
  /** Affected versions, as the advisory states them. */
  range: string;
  /** Set for npm when this package is only affected through another one. */
  via: string | null;
  /** npm's suggested fix: upgrade this package to this version (null: no fix known). */
  fix: { name: string; version: string; major: boolean } | null;
}

export interface AuditResult {
  advisories: Advisory[];
  error: string | null;
}

const SEVERITIES: Severity[] = ['low', 'moderate', 'high', 'critical'];
const severity = (s: unknown): Severity => {
  const v = String(s ?? '').toLowerCase();
  if (v === 'medium') return 'moderate';
  return (SEVERITIES as string[]).includes(v) ? (v as Severity) : 'unknown';
};

function run(file: string, args: string[], cwd: string, signal?: AbortSignal) {
  return new Promise<{ code: number; out: string; missing: boolean }>((resolve) => {
    execFile(
      file,
      args,
      {
        cwd,
        env: childEnv(),
        timeout: 90_000,
        maxBuffer: 32 * 1024 * 1024,
        ...(signal ? { signal } : {}),
      },
      (err, stdout, stderr) =>
        resolve({
          code: err ? (typeof err.code === 'number' ? err.code : -1) : 0,
          out: stdout || stderr,
          missing: (err as NodeJS.ErrnoException | null)?.code === 'ENOENT',
        }),
    );
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

export function parseNpmAudit(data: Json): Advisory[] {
  const out: Advisory[] = [];
  for (const [name, v] of Object.entries<Json>(data?.vulnerabilities ?? {})) {
    const fix =
      v?.fixAvailable && typeof v.fixAvailable === 'object'
        ? {
            name: String(v.fixAvailable.name),
            version: String(v.fixAvailable.version),
            major: !!v.fixAvailable.isSemVerMajor,
          }
        : null;
    const direct = (v?.via ?? []).filter((x: Json) => x && typeof x === 'object');
    if (direct.length)
      for (const a of direct)
        out.push({
          package: name,
          title: String(a.title ?? 'advisory'),
          severity: severity(a.severity ?? v.severity),
          url: a.url ? String(a.url) : null,
          range: String(a.range ?? v.range ?? '*'),
          via: null,
          fix,
        });
    else
      out.push({
        package: name,
        title: `affected through ${(v?.via ?? []).join(', ')}`,
        severity: severity(v?.severity),
        url: null,
        range: String(v?.range ?? '*'),
        via: (v?.via ?? []).join(', ') || null,
        fix,
      });
  }
  return out;
}

export function parseComposerAudit(data: Json): Advisory[] {
  const out: Advisory[] = [];
  const groups = data?.advisories ?? {};
  for (const [name, list] of Object.entries<Json>(Array.isArray(groups) ? {} : groups)) {
    const items = Array.isArray(list) ? list : Object.values(list ?? {});
    for (const a of items)
      out.push({
        package: name,
        title: String(a?.title ?? 'advisory'),
        severity: severity(a?.severity),
        url: a?.link ? String(a.link) : null,
        range: String(a?.affectedVersions ?? '*'),
        via: null,
        fix: null,
      });
  }
  return out;
}

export async function audit(
  ecosystem: Ecosystem,
  cwd: string,
  signal?: AbortSignal,
): Promise<AuditResult> {
  const r =
    ecosystem === 'npm'
      ? await run('npm', ['audit', '--json', '--package-lock-only'], cwd, signal)
      : await run(
          'composer',
          [
            'audit',
            '--locked',
            '--format=json',
            '--no-plugins',
            '--no-scripts',
            '--no-interaction',
          ],
          cwd,
          signal,
        );
  if (r.missing)
    return {
      advisories: [],
      error: `${ecosystem === 'npm' ? 'npm' : 'Composer'} is not installed`,
    };
  // Both exit non-zero when they find something; the JSON is what counts.
  let data: Json;
  try {
    data = JSON.parse(r.out);
  } catch {
    return {
      advisories: [],
      error: `the audit failed: ${r.out.trim().split('\n')[0]?.slice(0, 200) || `exit ${r.code}`}`,
    };
  }
  if (data?.error)
    return {
      advisories: [],
      error: `the audit failed: ${String(data.error.summary ?? data.error.code ?? 'unknown error').slice(0, 200)}`,
    };
  return {
    advisories: ecosystem === 'npm' ? parseNpmAudit(data) : parseComposerAudit(data),
    error: null,
  };
}
