import fs from 'node:fs';
import path from 'node:path';
import type { ApprovalDetails } from '@friday/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseComposerAudit, parseNpmAudit, type Advisory } from '../src/deps/audit.js';
import { breakingLines, changelogSections, tagVersion } from '../src/deps/changelog.js';
import { scanProject } from '../src/deps/manifests.js';
import {
  expandPackagist,
  parseNpmView,
  parsePackagist,
  type PackageInfo,
} from '../src/deps/registry.js';
import { assess } from '../src/deps/report.js';
import { classifyChange, compareVersions, inRange, isStable } from '../src/deps/versions.js';
import { Redactor } from '../src/security/redact.js';
import {
  dependencyReport,
  depsBackend,
  nextSpec,
  upgradeDependencies,
} from '../src/tools/dependencyTools.js';
import type { AppliedFileChange, ToolContext } from '../src/tools/types.js';
import { detectToolEnvironment } from '../src/workspace/environment.js';
import { cleanupProjects, makeProject } from './helpers.js';

afterEach(() => {
  cleanupProjects();
  vi.restoreAllMocks();
});
const env = await detectToolEnvironment();
type Details = Extract<ApprovalDetails, { kind: 'dependency_upgrade' }>;

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

describe('versions', () => {
  it('orders releases and pre-releases', () => {
    const sorted = [
      '1.10.0',
      '1.2.0',
      'v1.2.0-beta.2',
      '1.2.0-beta.10',
      '2.0.0-rc.1',
      '1.2.0.1',
    ].sort(compareVersions);
    expect(sorted).toEqual([
      'v1.2.0-beta.2',
      '1.2.0-beta.10',
      '1.2.0',
      '1.2.0.1',
      '1.10.0',
      '2.0.0-rc.1',
    ]);
    expect(isStable('3.1.0')).toBe(true);
    expect(isStable('3.1.0-RC1')).toBe(false);
    expect(isStable('2.4.1-p1')).toBe(true);
    expect(isStable('dev-main')).toBe(false);
  });

  it('classifies changes, with 0.x minor bumps as major', () => {
    expect(classifyChange('1.2.3', '1.2.4')).toBe('patch');
    expect(classifyChange('1.2.3', '1.3.0')).toBe('minor');
    expect(classifyChange('1.2.3', '2.0.0')).toBe('major');
    expect(classifyChange('0.4.1', '0.5.0')).toBe('major');
    expect(classifyChange('2.0.0', '1.9.0')).toBe('downgrade');
  });

  it('matches advisory ranges from npm and Composer', () => {
    expect(inRange('5.7.1', '>=2.0.0-alpha <5.7.2')).toBe(true);
    expect(inRange('5.7.2', '>=2.0.0-alpha <5.7.2')).toBe(false);
    expect(inRange('7.4.0', '>=8.0.0,<8.0.1|<7.15.2')).toBe(true);
    expect(inRange('7.15.5', '>=8.0.0,<8.0.1|<7.15.2')).toBe(false);
    expect(inRange('8.0.0', '>=8.0.0,<8.0.1|<7.15.2')).toBe(true);
    expect(inRange('3.0.0', '2.0.0 - 5.7.1')).toBe(true);
    expect(inRange('1.4.2', '1.x || >=3.0.0')).toBe(true);
    expect(inRange('2.0.0', '1.x || >=3.0.0')).toBe(false);
    expect(inRange('4.17.20', '< 4.17.21')).toBe(true);
  });
});

describe('dependency manifests', () => {
  it('reads npm workspaces with versions from the lockfile', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({
        name: 'mono',
        workspaces: ['apps/*'],
        devDependencies: { typescript: '~6.0.3' },
      }),
      'apps/api/package.json': JSON.stringify({
        name: 'api',
        dependencies: {
          express: '^4.18.0',
          web: '*',
          mine: 'file:../mine',
          fork: 'user/fork#main',
        },
      }),
      'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { express: '^5.0.0' } }),
      'package-lock.json': JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': {},
          'node_modules/typescript': { version: '6.0.3' },
          'node_modules/express': { version: '5.1.0' },
          'apps/api/node_modules/express': { version: '4.21.2' },
        },
      }),
      'tools/pnpm-thing/package.json': '{}',
      'tools/pnpm-thing/pnpm-lock.yaml': '',
      'node_modules/ignored/package.json': '{}',
      'node_modules/ignored/package-lock.json': '{}',
    });
    const scan = await scanProject(root);
    expect(scan.folders).toHaveLength(1);
    const f = scan.folders[0]!;
    expect(f.files).toEqual([
      'package.json',
      'apps/api/package.json',
      'apps/web/package.json',
      'package-lock.json',
    ]);
    expect(f.deps.map((d) => [d.name, d.workspace, d.field, d.current])).toEqual([
      ['typescript', null, 'devDependencies', '6.0.3'],
      ['express', 'apps/api', 'dependencies', '4.21.2'],
      ['express', 'apps/web', 'dependencies', '5.1.0'],
    ]);
    expect(f.skipped.map((s) => s.name)).toEqual(['mine', 'fork']);
    expect(scan.unsupported).toEqual([{ rel: 'tools/pnpm-thing', manager: 'pnpm' }]);
  });

  it('reads Composer projects, leaving out platform requirements', async () => {
    const root = makeProject({
      'composer.json': JSON.stringify({
        require: {
          php: '>=8.1',
          'ext-json': '*',
          'monolog/monolog': '^2.0',
          'acme/wip': 'dev-main',
        },
        'require-dev': { 'phpunit/phpunit': '~9.5' },
      }),
      'composer.lock': JSON.stringify({
        packages: [{ name: 'monolog/monolog', version: '2.11.1' }],
        'packages-dev': [{ name: 'phpunit/phpunit', version: 'v9.6.38' }],
      }),
    });
    const f = (await scanProject(root)).folders[0]!;
    expect(f.ecosystem).toBe('composer');
    expect(f.deps.map((d) => [d.name, d.dev, d.current])).toEqual([
      ['monolog/monolog', false, '2.11.1'],
      ['phpunit/phpunit', true, '9.6.38'],
    ]);
    expect(f.skipped).toEqual([{ name: 'acme/wip', why: 'a development branch (dev-main)' }]);
  });
});

describe('registry, audit and release-note parsing', () => {
  it('reads npm view and Packagist metadata', () => {
    const npm = parseNpmView(
      'ms',
      JSON.stringify({
        time: {
          created: 'x',
          modified: 'y',
          '2.0.0': '2017-01-01',
          '2.1.3': '2020-12-01',
          '3.0.0-canary.1': '2021-01-01',
        },
        'dist-tags': { latest: '2.1.3' },
        repository: { url: 'git+https://github.com/vercel/ms.git' },
      }),
    );
    expect(npm.releases.map((r) => r.version)).toEqual(['2.1.3', '2.0.0']);
    expect(npm.latest).toBe('2.1.3');
    expect(npm.repository).toBe('git+https://github.com/vercel/ms.git');

    const expanded = expandPackagist([
      {
        version: 'v3.1.0',
        time: '2026-01-01',
        source: { url: 'https://github.com/a/b.git' },
        extra: 1,
      },
      { version: 'v3.0.0', time: '2025-06-01', extra: '__unset' },
      { version: '3.0.0-RC1', time: '2025-05-01' },
    ]);
    expect(expanded[1]).toEqual({
      version: 'v3.0.0',
      time: '2025-06-01',
      source: { url: 'https://github.com/a/b.git' },
    });
    const pk = parsePackagist('A/B', { packages: { 'a/b': expanded } });
    expect(pk.releases.map((r) => r.version)).toEqual(['3.1.0', '3.0.0']);
    expect(pk.repository).toBe('https://github.com/a/b.git');
    expect(parsePackagist('x/y', {}).error).toBe('not on Packagist');
  });

  it('reads npm and Composer audits', () => {
    const npm = parseNpmAudit({
      vulnerabilities: {
        semver: {
          severity: 'high',
          via: [{ title: 'ReDoS', url: 'https://x/GHSA-1', severity: 'high', range: '<5.7.2' }],
          fixAvailable: { name: 'semver', version: '5.7.2', isSemVerMajor: false },
        },
        'old-dep': { severity: 'moderate', via: ['semver'], range: '1.0.0', fixAvailable: true },
      },
    });
    expect(npm).toEqual([
      expect.objectContaining({
        package: 'semver',
        title: 'ReDoS',
        range: '<5.7.2',
        fix: { name: 'semver', version: '5.7.2', major: false },
      }),
      expect.objectContaining({ package: 'old-dep', via: 'semver', fix: null }),
    ]);
    const composer = parseComposerAudit({
      advisories: {
        'guzzlehttp/guzzle': [
          {
            title: 'Host bypass',
            affectedVersions: '>=8.0.0,<8.0.1|<7.15.2',
            link: 'https://x',
            severity: 'high',
          },
        ],
      },
    });
    expect(composer[0]).toMatchObject({
      package: 'guzzlehttp/guzzle',
      severity: 'high',
      range: '>=8.0.0,<8.0.1|<7.15.2',
    });
    expect(parseComposerAudit({ advisories: [] })).toEqual([]);
  });

  it('finds versions in tags and changelogs, and breaking-change lines', () => {
    expect(tagVersion('v2.1.0', 'ms')).toBe('2.1.0');
    expect(tagVersion('@vitest/ui@3.0.0', '@vitest/ui')).toBe('3.0.0');
    expect(tagVersion('vitest@3.0.0', '@vitest/ui')).toBeNull();
    expect(tagVersion('nightly', 'x')).toBeNull();
    const sections = changelogSections(
      '# Changelog\n## [3.0.0] - 2026\n- Drop support for Node 18\n## 2.5.0\n- fixes\n',
    );
    expect(sections.map((s) => s.version)).toEqual(['3.0.0', '2.5.0']);
    expect(
      breakingLines(
        '- BREAKING: `parse()` now throws\n- Fixed PHP 8.2 deprecation warnings\n- Removed the legacy API\n- Faster\n',
      ),
    ).toEqual(['BREAKING: `parse()` now throws', 'Removed the legacy API']);
    expect(
      breakingLines(
        '* [`3fabe4d`](https://github.com/x/y/commit/3fabe4dbfbd1) [#704](https://github.com/x/y/pull/704) remove lru-cache',
      ),
    ).toEqual(['#704 remove lru-cache']);
  });
});

describe('upgrade targets', () => {
  const info = (releases: Array<[string, number]>, latest?: string): PackageInfo => ({
    name: 'x',
    releases: releases.map(([version, d]) => ({ version, time: daysAgo(d) })),
    latest: latest ?? releases[0]![0],
    repository: null,
    error: null,
  });
  const dep = {
    name: 'x',
    workspace: null,
    dev: false,
    field: 'dependencies' as const,
    spec: '^1.2.0',
    current: '1.2.0',
  };

  it('recommends releases at least 14 days old, same line and newest', () => {
    const s = assess(
      dep,
      info([
        ['2.1.0', 3],
        ['2.0.0', 40],
        ['1.4.0', 20],
        ['1.3.0', 100],
        ['1.2.0', 400],
      ]),
      [],
    );
    expect(s.safe).toMatchObject({ version: '1.4.0', change: 'minor', ageDays: 20 });
    expect(s.newest).toMatchObject({ version: '2.0.0', change: 'major' });
    expect(s.waiting).toMatchObject({ version: '2.1.0', ageDays: 3 });
    // Nothing old enough yet.
    expect(
      assess(
        dep,
        info([
          ['1.2.1', 2],
          ['1.2.0', 400],
        ]),
        [],
      ),
    ).toMatchObject({ safe: null, newest: null, waiting: { version: '1.2.1' } });
    // Never above the registry's latest tag.
    expect(
      assess(
        dep,
        info(
          [
            ['3.0.0', 50],
            ['1.3.0', 50],
            ['1.2.0', 400],
          ],
          '1.3.0',
        ),
        [],
      ).newest?.version,
    ).toBe('1.3.0');
  });

  it('keeps the manifest style for the new spec', () => {
    expect(nextSpec('npm', '^4.17.20', '4.17.21')).toBe('^4.17.21');
    expect(nextSpec('npm', '~2.0.0', '2.1.3')).toBe('~2.1.3');
    expect(nextSpec('npm', '5.7.1', '5.7.2')).toBe('5.7.2');
    expect(nextSpec('npm', '>=1 <3', '2.5.0')).toBe('^2.5.0');
    expect(nextSpec('composer', '^2.0', '3.12.1')).toBe('^3.12.1');
    expect(nextSpec('composer', '~9.5', '10.5.2')).toBe('~10.5');
    expect(nextSpec('composer', '7.4.0', '7.15.5')).toBe('7.15.5');
  });
});

// ---------------------------------------------------------------- the tools, offline

function project() {
  return makeProject({
    'package.json': JSON.stringify(
      {
        name: 'shop',
        version: '1.0.0',
        dependencies: { ms: '~2.0.0' },
        devDependencies: { semver: '5.7.1' },
      },
      null,
      2,
    ),
    'package-lock.json': JSON.stringify(
      {
        name: 'shop',
        lockfileVersion: 3,
        packages: {
          '': {},
          'node_modules/ms': { version: '2.0.0' },
          'node_modules/semver': { version: '5.7.1' },
        },
      },
      null,
      2,
    ),
  });
}

const REGISTRY: Record<string, PackageInfo> = {
  ms: {
    name: 'ms',
    releases: [
      { version: '2.1.3', time: daysAgo(2000) },
      { version: '2.0.0', time: daysAgo(3000) },
    ],
    latest: '2.1.3',
    repository: 'https://github.com/vercel/ms',
    error: null,
  },
  semver: {
    name: 'semver',
    releases: [
      { version: '7.8.6', time: daysAgo(3) },
      { version: '7.8.5', time: daysAgo(120) },
      { version: '5.7.2', time: daysAgo(1200) },
      { version: '5.7.1', time: daysAgo(2000) },
    ],
    latest: '7.8.6',
    repository: 'https://github.com/npm/node-semver',
    error: null,
  },
};
const ADVISORIES: Advisory[] = [
  {
    package: 'semver',
    title: 'ReDoS',
    severity: 'high',
    url: 'https://x/GHSA-1',
    range: '>=2.0.0-alpha <5.7.2',
    via: null,
    fix: null,
  },
];

function offline() {
  vi.spyOn(depsBackend, 'packageInfo').mockImplementation(async (_e, name) => REGISTRY[name]!);
  vi.spyOn(depsBackend, 'audit').mockResolvedValue({ advisories: ADVISORIES, error: null });
  vi.spyOn(depsBackend, 'releaseNotes').mockImplementation(async (name) => ({
    repo: name === 'semver' ? 'npm/node-semver' : 'vercel/ms',
    entries: [],
    breaking: name === 'semver' ? ['Drop support for very old node versions'] : [],
    source: 'releases',
    error: null,
  }));
}

function ctx(root: string, changes: AppliedFileChange[] = []): ToolContext {
  return {
    project: {
      id: 'p',
      name: 'shop',
      rootPath: root,
      createdAt: '',
      lastOpenedAt: null,
      sandbox: null,
      worktree: null,
    },
    sessionId: 's',
    runId: 'r',
    callId: 'c',
    signal: new AbortController().signal,
    redactor: new Redactor(),
    env,
    maxOutputChars: 20_000,
    setPlan: () => undefined,
    recordFileChange: (c) => changes.push(c),
  };
}

const prepare = (c: ToolContext, args: object) =>
  upgradeDependencies.prepare!(
    upgradeDependencies.schema.parse({ reason: 'the user asked', ...args }),
    c,
  );

describe('dependency tools', () => {
  it('reports targets and advisories', async () => {
    offline();
    const r = await dependencyReport.execute!(dependencyReport.schema.parse({}), ctx(project()));
    expect(r.content).toContain('ms (prod) 2.0.0 [~2.0.0] → 2.1.3 (minor');
    expect(r.content).toMatch(
      /semver \(dev\) 5\.7\.1 \[5\.7\.1\] → 5\.7\.2 \(patch, 3 years old\); major → 7\.8\.5 \(4 months old\); latest 7\.8\.6 is 3 days old .*HIGH advisory: ReDoS .*fixed by 5\.7\.2/,
    );
    expect(r.summary).toBe('2 upgradable, 1 with advisories');
  });

  it('enforces the release-age rule unless the user asked for a newer one', async () => {
    offline();
    const c = ctx(project());
    await expect(prepare(c, { packages: [{ name: 'semver', version: '7.8.6' }] })).rejects.toThrow(
      /only 3 days old; .*Recommended instead: 5\.7\.2 or 7\.8\.5/,
    );
    await expect(prepare(c, { packages: [{ name: 'semver', version: '6.0.0' }] })).rejects.toThrow(
      /has no stable release 6\.0\.0/,
    );
    await expect(
      prepare(c, { packages: [{ name: 'lodash', version: '4.17.21' }] }),
    ).rejects.toThrow(/not a direct dependency/);
    await expect(prepare(c, { packages: [{ name: 'ms', version: '2.0.0' }] })).rejects.toThrow(
      /already at 2\.0\.0/,
    );
    const young = await prepare(c, {
      packages: [{ name: 'semver', version: '7.8.6' }],
      allow_recent: true,
    });
    expect((young.details as Details).packages[0]).toMatchObject({ recent: true, change: 'major' });
    expect(young.risk).toBe('high');
  });

  it('shows the plan on the card and runs the package manager, recording the changes', async () => {
    offline();
    const root = project();
    const c = ctx(root);
    const p = await prepare(c, {
      packages: [
        { name: 'ms', version: '2.1.3' },
        { name: 'semver', version: '5.7.2' },
      ],
    });
    const d = p.details as Details;
    expect(d.commands).toEqual([
      ['npm', 'install', '--no-fund', '--no-audit', '--save-prod', 'ms@~2.1.3'],
      ['npm', 'install', '--no-fund', '--no-audit', '--save-dev', '--save-exact', 'semver@5.7.2'],
    ]);
    expect(d.packages.map((x) => [x.name, x.from, x.to, x.change, x.specAfter])).toEqual([
      ['ms', '2.0.0', '2.1.3', 'minor', '~2.1.3'],
      ['semver', '5.7.1', '5.7.2', 'patch', '5.7.2'],
    ]);
    expect(d.packages[1]!.fixes).toEqual([
      { title: 'ReDoS', severity: 'high', url: 'https://x/GHSA-1' },
    ]);
    expect(d.packages[1]!.remaining).toEqual([]);
    expect(d.files).toEqual(['package.json', 'package-lock.json']);
    expect(p.risk).toBe('high'); // installs download code and may run scripts, like run_command

    // A stand-in npm that writes what `npm install name@spec` would.
    const bin = makeProject({
      npm: `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
const field = args.includes('--save-dev') ? 'devDependencies' : 'dependencies';
for (const a of args.filter((x) => !x.startsWith('-') && x !== 'install')) {
  const [name, spec] = a.split('@');
  pkg[field][name] = spec;
  lock.packages['node_modules/' + name].version = spec.replace(/^[~^]/, '');
  console.log('changed 1 package');
}
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2));
fs.writeFileSync('package-lock.json', JSON.stringify(lock, null, 2));
`,
    });
    fs.chmodSync(path.join(bin, 'npm'), 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath}`;
    const changes: AppliedFileChange[] = [];
    try {
      const out = await p.apply(ctx(root, changes));
      expect(out.summary).toBe('2/2 upgraded');
      expect(out.content).toContain('ms: 2.0.0 → 2.1.3; manifest now ~2.1.3');
      expect(out.content).toContain('semver: 5.7.1 → 5.7.2; manifest now 5.7.2');
      expect(out.content).toMatch(/Next: run the tests/);
    } finally {
      process.env.PATH = oldPath;
    }
    expect(changes.map((x) => [x.path, x.change])).toEqual([
      ['package.json', 'modify'],
      ['package-lock.json', 'modify'],
    ]);
    expect(changes[0]!.beforeContent!.toString()).toContain('"ms": "~2.0.0"');
  });

  it('upgrades Composer packages with composer require', async () => {
    const root = makeProject({
      'composer.json': JSON.stringify({
        require: { 'guzzlehttp/guzzle': '7.4.0' },
        'require-dev': { 'phpunit/phpunit': '~9.5' },
      }),
      'composer.lock': JSON.stringify({
        packages: [{ name: 'guzzlehttp/guzzle', version: '7.4.0' }],
        'packages-dev': [{ name: 'phpunit/phpunit', version: '9.6.38' }],
      }),
    });
    vi.spyOn(depsBackend, 'packageInfo').mockImplementation(async (_e, name) => ({
      name,
      releases: [
        { version: name === 'guzzlehttp/guzzle' ? '7.15.5' : '10.5.2', time: daysAgo(60) },
      ],
      latest: null,
      repository: null,
      error: null,
    }));
    vi.spyOn(depsBackend, 'audit').mockResolvedValue({ advisories: [], error: null });
    vi.spyOn(depsBackend, 'releaseNotes').mockResolvedValue({
      repo: null,
      entries: [],
      breaking: [],
      source: null,
      error: 'the registry lists no source repository',
    });
    const p = await prepare(ctx(root), {
      packages: [
        { name: 'guzzlehttp/guzzle', version: '7.15.5' },
        { name: 'phpunit/phpunit', version: '10.5.2' },
      ],
    });
    const d = p.details as Details;
    expect(d.ecosystem).toBe('composer');
    expect(d.commands).toEqual([
      [
        'composer',
        'require',
        '--update-with-dependencies',
        '--no-interaction',
        '--no-progress',
        'guzzlehttp/guzzle:7.15.5',
      ],
      [
        'composer',
        'require',
        '--dev',
        '--update-with-dependencies',
        '--no-interaction',
        '--no-progress',
        'phpunit/phpunit:~10.5',
      ],
    ]);
    expect(d.packages[1]!.notesError).toBe('the registry lists no source repository');
  });
});
