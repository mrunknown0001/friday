/**
 * Just enough version handling for npm and Composer releases: parse, compare, classify a change,
 * and test a version against the comparator ranges advisories use (">=1.2.0 <1.4.3",
 * ">=1.0,<1.2.3|>=2.0,<2.0.5", "2.0.0 - 5.7.1"). Not a full semver range engine.
 */

export interface Version {
  raw: string;
  nums: [number, number, number, number];
  /** Pre-release label ("beta.2", "RC1"); empty for a stable release. */
  pre: string;
}

const STABLE_SUFFIX = /^[-.]?(p|pl|patch)\d*$/i;

export function parseVersion(raw: string): Version | null {
  const m = /^[vV]?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?(.*)$/.exec(raw.trim());
  if (!m) return null;
  let rest = m[5] ?? '';
  const plus = rest.indexOf('+');
  if (plus >= 0) rest = rest.slice(0, plus); // build metadata does not order
  if (rest && !/^[-.]?[0-9A-Za-z][0-9A-Za-z.-]*$/.test(rest)) return null;
  const pre = rest && !STABLE_SUFFIX.test(rest) ? rest.replace(/^[-.]/, '') : '';
  return {
    raw,
    nums: [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0), Number(m[4] ?? 0)],
    pre,
  };
}

export const isStable = (raw: string) => {
  const v = parseVersion(raw);
  return !!v && !v.pre;
};

function comparePre(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return 1; // a release sorts after its pre-releases
  if (!b) return -1;
  const pa = a.split(/[.-]/);
  const pb = b.split(/[.-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x) ? Number(x) : null;
    const ny = /^\d+$/.test(y) ? Number(y) : null;
    if (nx !== null && ny !== null) {
      if (nx !== ny) return nx - ny;
    } else if (nx !== null) return -1;
    else if (ny !== null) return 1;
    else {
      const c = x.toLowerCase().localeCompare(y.toLowerCase());
      if (c) return c;
    }
  }
  return 0;
}

export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return a.localeCompare(b);
  for (let i = 0; i < 4; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i]! - y.nums[i]!;
  return comparePre(x.pre, y.pre);
}

export type Change = 'major' | 'minor' | 'patch' | 'downgrade' | 'same';

/** How big a move from `from` to `to` is; for 0.x versions a minor bump counts as major. */
export function classifyChange(from: string, to: string): Change {
  const c = compareVersions(to, from);
  if (c === 0) return 'same';
  if (c < 0) return 'downgrade';
  const a = parseVersion(from);
  const b = parseVersion(to);
  if (!a || !b) return 'major';
  if (a.nums[0] !== b.nums[0]) return 'major';
  if (a.nums[0] === 0 && a.nums[1] !== b.nums[1]) return 'major';
  if (a.nums[1] !== b.nums[1]) return 'minor';
  return 'patch';
}

/** The same compatibility line (no breaking change by semver): same major, or same 0.minor. */
export const sameLine = (a: string, b: string) => {
  const c = classifyChange(a, b);
  return c === 'minor' || c === 'patch' || c === 'same';
};

function comparator(version: string, c: string): boolean {
  const m = /^(>=|<=|>|<|==?|!=)?\s*(.+)$/.exec(c.trim());
  if (!m) return false;
  const op = m[1] ?? '=';
  const target = m[2]!.trim();
  if (target === '*' || target === '') return true;
  // 1.x / 1.2.* style wildcards.
  const wild = /^[vV]?(\d+)(?:\.(\d+|[xX*]))?(?:\.([xX*]))?$/.exec(target);
  if (op === '=' && wild && (wild[2] === undefined || /[xX*]/.test(wild[2]) || wild[3])) {
    const major = Number(wild[1]);
    const minor = wild[2] && !/[xX*]/.test(wild[2]) ? Number(wild[2]) : null;
    const lo = `${major}.${minor ?? 0}.0`;
    const hi = minor === null ? `${major + 1}.0.0` : `${major}.${minor + 1}.0`;
    return compareVersions(version, lo) >= 0 && compareVersions(version, `${hi}-0`) < 0;
  }
  const c2 = compareVersions(version, target);
  switch (op) {
    case '>=':
      return c2 >= 0;
    case '<=':
      return c2 <= 0;
    case '>':
      return c2 > 0;
    case '<':
      return c2 < 0;
    case '!=':
      return c2 !== 0;
    default:
      return c2 === 0;
  }
}

/** Whether `version` is inside an advisory range (comparators; "," or space = and; "|" or "||" = or). */
export function inRange(version: string, range: string): boolean {
  return range.split(/\s*\|\|?\s*/).some((alt) => {
    const hyphen = /^\s*(\S+)\s+-\s+(\S+)\s*$/.exec(alt);
    if (hyphen)
      return compareVersions(version, hyphen[1]!) >= 0 && compareVersions(version, hyphen[2]!) <= 0;
    const parts = alt
      .replace(/(>=|<=|>|<|!=|==?)\s+/g, '$1')
      .split(/[\s,]+/)
      .filter(Boolean);
    return parts.length > 0 && parts.every((p) => comparator(version, p));
  });
}
