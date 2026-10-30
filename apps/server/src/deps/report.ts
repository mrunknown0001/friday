import type { Advisory } from './audit.js';
import type { DirectDep } from './manifests.js';
import type { PackageInfo, Release } from './registry.js';
import { classifyChange, compareVersions, inRange, sameLine, type Change } from './versions.js';

/** Releases younger than this are not recommended (the "two weeks old" rule). */
export const MIN_AGE_DAYS = 14;
const DAY = 86_400_000;

export const ageDays = (time: string | null, now: number) =>
  time ? Math.floor((now - Date.parse(time)) / DAY) : null;

export interface Target {
  version: string;
  change: Change;
  time: string | null;
  ageDays: number | null;
}

export interface DepStatus {
  dep: DirectDep;
  info: PackageInfo;
  /** Newest release old enough on the same compatibility line (no breaking change by semver). */
  safe: Target | null;
  /** Newest release old enough on any line (may be a major upgrade). */
  newest: Target | null;
  /** The registry's latest release, when it is newer than `newest` (too recent for now). */
  waiting: Target | null;
  advisories: Advisory[];
}

const target = (from: string, r: Release, now: number): Target => ({
  version: r.version,
  change: classifyChange(from, r.version),
  time: r.time,
  ageDays: ageDays(r.time, now),
});

/** Pick upgrade targets for one dependency under the release-age rule. */
export function assess(
  dep: DirectDep,
  info: PackageInfo,
  advisories: Advisory[],
  now = Date.now(),
): DepStatus {
  const current = dep.current;
  const mine = advisories.filter((a) => a.package.toLowerCase() === dep.name.toLowerCase());
  const empty = { dep, info, safe: null, newest: null, waiting: null, advisories: mine };
  if (!current || !info.releases.length) return empty;
  const ceiling = info.latest ?? info.releases[0]!.version;
  const newer = info.releases.filter(
    (r) => compareVersions(r.version, current) > 0 && compareVersions(r.version, ceiling) <= 0,
  );
  const old = newer.filter((r) => (ageDays(r.time, now) ?? -1) >= MIN_AGE_DAYS);
  const safe = old.find((r) => sameLine(current, r.version));
  const newest = old[0];
  const top = newer[0];
  return {
    ...empty,
    safe: safe ? target(current, safe, now) : null,
    newest: newest ? target(current, newest, now) : null,
    waiting:
      top && (!newest || compareVersions(top.version, newest.version) > 0)
        ? target(current, top, now)
        : null,
  };
}

const sevRank: Record<string, number> = { critical: 4, high: 3, moderate: 2, low: 1, unknown: 0 };

/** Whether a version still falls in an advisory's affected range. */
export const stillAffected = (a: Advisory, version: string) => inRange(version, a.range);

function when(t: Target): string {
  if (t.ageDays === null) return 'release date unknown';
  if (t.ageDays < 1) return 'released today';
  if (t.ageDays < 60) return `${t.ageDays} days old`;
  if (t.ageDays < 730) return `${Math.round(t.ageDays / 30)} months old`;
  return `${Math.round(t.ageDays / 365)} years old`;
}

/** One line per dependency for the report (only those with something to say). */
export function describe(s: DepStatus): string | null {
  const d = s.dep;
  const where = `${d.workspace ? `${d.workspace}: ` : ''}${d.dev ? 'dev' : 'prod'}`;
  const head = `${d.name} (${where}) ${d.current ?? 'not locked'} [${d.spec}]`;
  if (s.info.error) return `${head}: ${s.info.error}`;
  if (!d.current) return `${head}: not in the lockfile (run the install first)`;
  const parts: string[] = [];
  if (s.safe) parts.push(`→ ${s.safe.version} (${s.safe.change}, ${when(s.safe)})`);
  if (s.newest && s.newest.version !== s.safe?.version)
    parts.push(`major → ${s.newest.version} (${when(s.newest)})`);
  if (s.waiting)
    parts.push(
      `latest ${s.waiting.version} is ${s.waiting.ageDays === null ? 'of unknown age' : `${s.waiting.ageDays} days old`} (under ${MIN_AGE_DAYS} days: not recommended yet)`,
    );
  for (const a of [...s.advisories].sort((x, y) => sevRank[y.severity]! - sevRank[x.severity]!)) {
    const fixedBy = [s.safe, s.newest]
      .filter((t): t is Target => !!t)
      .find((t) => !stillAffected(a, t.version));
    parts.push(
      `${a.severity.toUpperCase()} advisory: ${a.title}${a.url ? ` (${a.url})` : ''}; affected ${a.range}${
        fixedBy ? `; fixed by ${fixedBy.version}` : '; no recommended version fixes it yet'
      }`,
    );
  }
  return parts.length ? `${head} ${parts.join('; ')}` : null;
}
