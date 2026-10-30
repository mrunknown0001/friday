import { ghApiGet, githubRepo, parseGitHubJson, type GitHubRepo } from '../git/github.js';
import { compareVersions, isStable, parseVersion } from './versions.js';

/**
 * Release notes between two versions, from the package's GitHub repository: its releases, or
 * else its CHANGELOG.md. Read through gh (GET only). The text is third-party content.
 */

export interface Notes {
  repo: string | null;
  /** Releases or changelog sections in (from, to], oldest first. */
  entries: Array<{ version: string; title: string; date: string | null; body: string }>;
  /** Lines that announce breaking changes, removals or new requirements. */
  breaking: string[];
  source: 'releases' | 'changelog' | 'both' | null;
  error: string | null;
}

const BREAKING =
  /\bbreaking\b|\bremoved?\b|\bno longer\b|\bdrop(?:ped|s)? (?:support|node|php)|\brequires? (?:node|php)\b|\bminimum (?:node|php)\b|\bdeprecat|\brenamed\b|\bmigrat/i;

export function repoFromUrl(url: string | null): GitHubRepo | null {
  if (!url) return null;
  const clean = url
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^github:/, 'https://github.com/')
    .replace(/#.*$/, '');
  const shorthand = /^([\w.-]+)\/([\w.-]+)$/.exec(clean);
  return githubRepo(shorthand ? `https://github.com/${shorthand[1]}/${shorthand[2]}` : clean);
}

/** The version a release tag names ("v1.2.3", "pkg@1.2.3", "@scope/pkg@1.2.3"). */
export function tagVersion(tag: string, pkg: string): string | null {
  const at = tag.lastIndexOf('@');
  if (at > 0) {
    const prefix = tag.slice(0, at);
    const short = pkg.split('/').pop()!;
    if (prefix !== pkg && prefix !== short) return null; // another package of a monorepo
  }
  const v = tag.slice(at + 1).replace(/^(release-|version-|v)/i, '');
  return parseVersion(v) ? v : null;
}

export function breakingLines(text: string, max = 12): string[] {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    // Markdown links and commit hashes add noise: "[`3fabe4d`](…) [#704](…) remove x" → "#704 remove x".
    const line = raw
      .replace(/^\s*(?:[>*-]\s*)+/, '')
      .replace(/^#{1,6}\s+/, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\(?`?\b[0-9a-f]{7,40}\b`?\)?/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    // A fix for deprecation warnings is not a breaking change.
    if (line.length < 8 || !BREAKING.test(line) || /^fix(e[sd])?\b/i.test(line)) continue;
    const clipped = line.length > 220 ? `${line.slice(0, 217)}…` : line;
    if (!out.includes(clipped)) out.push(clipped);
    if (out.length >= max) break;
  }
  return out;
}

const inWindow = (v: string, from: string, to: string) =>
  compareVersions(v, from) > 0 && compareVersions(v, to) <= 0;

/** Split a CHANGELOG into sections per version heading. */
export function changelogSections(
  text: string,
): Array<{ version: string; title: string; body: string }> {
  const out: Array<{ version: string; title: string; body: string }> = [];
  let cur: { version: string; title: string; lines: string[] } | null = null;
  for (const line of text.split('\n')) {
    const h = /^#{1,3}\s+\[?v?(\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?)\]?/.exec(line);
    if (h) {
      if (cur) out.push({ version: cur.version, title: cur.title, body: cur.lines.join('\n') });
      cur = { version: h[1]!, title: line.replace(/^#+\s*/, '').trim(), lines: [] };
    } else cur?.lines.push(line);
  }
  if (cur) out.push({ version: cur.version, title: cur.title, body: cur.lines.join('\n') });
  return out;
}

export async function releaseNotes(
  pkg: string,
  repositoryUrl: string | null,
  from: string,
  to: string,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<Notes> {
  const repo = repoFromUrl(repositoryUrl);
  const empty: Notes = {
    repo: repo ? `${repo.owner}/${repo.name}` : null,
    entries: [],
    breaking: [],
    source: null,
    error: null,
  };
  if (!repo)
    return {
      ...empty,
      error: repositoryUrl
        ? 'its source repository is not on GitHub'
        : 'the registry lists no source repository',
    };
  const get = (p: string) => ghApiGet(repo, p, { ...opts, timeoutMs: opts.timeoutMs ?? 20_000 });
  try {
    type GhRelease = {
      tag_name?: string;
      name?: string;
      body?: string;
      published_at?: string;
      draft?: boolean;
    };
    // Newest first; read more pages until the window's start is covered (at most 300 releases).
    const releases: GhRelease[] = [];
    for (let page = 1; page <= 3; page++) {
      const body = await get(`repos/${repo.owner}/${repo.name}/releases?per_page=100&page=${page}`);
      const batch = body ? parseGitHubJson<GhRelease[]>(body) : [];
      releases.push(...batch);
      const reached = batch.some((r) => {
        const v = r.tag_name ? tagVersion(r.tag_name, pkg) : null;
        return v !== null && compareVersions(v, from) <= 0;
      });
      if (batch.length < 100 || reached) break;
    }
    const entries = releases
      .filter((r) => !r.draft && r.tag_name)
      .map((r) => ({ r, version: tagVersion(r.tag_name!, pkg) }))
      .filter((x): x is { r: (typeof releases)[number]; version: string } => !!x.version)
      .filter((x) => inWindow(x.version, from, to) && (isStable(x.version) || !isStable(to)))
      .sort((a, b) => compareVersions(a.version, b.version))
      .map(({ r, version }) => ({
        version,
        title: r.name || r.tag_name!,
        date: r.published_at ?? null,
        body: (r.body ?? '').trim(),
      }));
    // Repositories often start publishing GitHub releases late: when the X.0.0 release of a major
    // version in the window (where breaking changes are announced) has none, the CHANGELOG fills the gap.
    const major = (v: string) => parseVersion(v)!.nums[0];
    const crossed: number[] = [];
    for (let m = major(from) + 1; m <= major(to); m++) crossed.push(m);
    const gap =
      !entries.length ||
      crossed.some((m) => !entries.some((e) => compareVersions(e.version, `${m}.0.0`) === 0));
    let fromLog: typeof entries = [];
    if (gap)
      for (const file of ['CHANGELOG.md', 'changelog.md', 'CHANGES.md', 'HISTORY.md']) {
        const raw = await get(`repos/${repo.owner}/${repo.name}/contents/${file}`);
        if (!raw) continue;
        const content = parseGitHubJson<{ content?: string; encoding?: string }>(raw);
        if (!content.content || content.encoding !== 'base64') continue;
        const text = Buffer.from(content.content, 'base64').toString('utf8');
        const have = new Set(entries.map((e) => e.version));
        fromLog = changelogSections(text)
          .filter(
            (x) =>
              inWindow(x.version, from, to) &&
              (isStable(x.version) || !isStable(to)) &&
              !have.has(x.version),
          )
          .map((x) => ({ ...x, date: null, body: x.body.trim() }));
        if (fromLog.length) break;
      }
    const all = [...entries, ...fromLog].sort((a, b) => compareVersions(a.version, b.version));
    if (all.length)
      return {
        ...empty,
        entries: all,
        // Breaking changes are listed newest major first: they matter most for the target.
        breaking: breakingLines(
          [...all]
            .reverse()
            .map((e) => e.body)
            .join('\n'),
        ),
        source:
          entries.length && fromLog.length ? 'both' : entries.length ? 'releases' : 'changelog',
      };
    return { ...empty, error: 'no release notes found for these versions' };
  } catch (err) {
    return { ...empty, error: err instanceof Error ? err.message : String(err) };
  }
}
