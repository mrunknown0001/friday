import fs from 'node:fs/promises';
import path from 'node:path';
import type { TestFramework } from '@friday/shared';
import { walk } from '../workspace/walk.js';

/**
 * Finding a project's test suites: each folder with a package.json (Vitest, Jest, `node --test`,
 * and Playwright beside them when it has a playwright.config), a pytest configuration, or a
 * go.mod. Detection only reads files; Friday never installs a test runner, coverage plugin or
 * browser.
 */

export interface Suite {
  /** Folder relative to the project root ('.' for the root). */
  dir: string;
  framework: TestFramework;
  /** Program and leading arguments, run from the suite folder. */
  runner: string[];
  /** Null when the runner is installed; otherwise why it can't run. */
  missing: string | null;
  coverage: { available: boolean; note: string | null };
  /** Go module path (for mapping cover profiles and packages to files). */
  goModule?: string;
  playwright?: PlaywrightInfo;
}

export interface PlaywrightInfo {
  /** The config file, relative to the suite folder. */
  config: string;
  /** Where the specs are, relative to the suite folder ('.' when the config does not say). */
  testDir: string;
  /** The command the config starts first (webServer), when it names one. */
  webServer: string | null;
  /** Installed @playwright/test version. */
  version: string | null;
}

const PLAYWRIGHT_CONFIGS = ['ts', 'js', 'mjs', 'cjs', 'mts', 'cts'].map(
  (e) => `playwright.config.${e}`,
);

/** The parts of a Playwright config Friday shows: read as text, never executed. */
export function readPlaywrightConfig(text: string): { testDir: string; webServer: string | null } {
  const testDir = /\btestDir\s*:\s*['"`]([^'"`]+)['"`]/.exec(text)?.[1];
  const web = /\bwebServer\s*:\s*[[{][\s\S]*?\bcommand\s*:\s*['"`]([^'"`]+)['"`]/.exec(text)?.[1];
  return {
    testDir: testDir
      ? path.posix.normalize(testDir.replace(/^\.\//, '')).replace(/\/$/, '') || '.'
      : '.',
    webServer: web ?? null,
  };
}

async function playwrightSuite(root: string, dir: string, pkg: PackageJson): Promise<Suite | null> {
  const abs = path.join(root, dir);
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  let config: string | null = null;
  for (const name of PLAYWRIGHT_CONFIGS)
    if (await exists(path.join(abs, name))) {
      config = name;
      break;
    }
  if (!config || !('@playwright/test' in deps || 'playwright' in deps)) return null;
  const info = readPlaywrightConfig((await readSmall(path.join(abs, config))) ?? '');
  const bin = await findModule(root, abs, '.bin/playwright');
  const manifest = await findModule(root, abs, '@playwright/test/package.json');
  let version: string | null = null;
  if (manifest)
    try {
      version =
        (JSON.parse((await readSmall(manifest)) ?? '{}') as { version?: string }).version ?? null;
    } catch {
      version = null;
    }
  return {
    dir,
    framework: 'playwright',
    runner: [bin ? path.relative(abs, bin).split(path.sep).join('/') : 'playwright', 'test'],
    missing:
      bin && manifest
        ? null
        : '@playwright/test is not installed (node_modules/.bin/playwright is missing)',
    coverage: { available: false, note: 'Playwright runs measure no code coverage here.' },
    playwright: { config, ...info, version },
  };
}

const MAX_MANIFEST_BYTES = 512 * 1024;

async function readSmall(file: string): Promise<string | null> {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) return null;
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

const exists = (p: string) =>
  fs
    .stat(p)
    .then(() => true)
    .catch(() => false);

/** `node_modules/<name>` (a package or .bin entry) from the suite folder up to the project root. */
async function findModule(root: string, dirAbs: string, name: string): Promise<string | null> {
  for (let dir = dirAbs; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name);
    if (await exists(candidate)) return candidate;
    if (dir === root || !dir.startsWith(root)) return null;
  }
}

interface PackageJson {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

async function nodeSuite(root: string, dir: string, pkg: PackageJson): Promise<Suite | null> {
  const abs = path.join(root, dir);
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const script = pkg.scripts?.test ?? '';
  const framework: TestFramework | null = /\bvitest\b/.test(script)
    ? 'vitest'
    : /\bjest\b/.test(script)
      ? 'jest'
      : /\bnode\b.*\s--test\b/.test(script)
        ? 'node'
        : 'vitest' in deps
          ? 'vitest'
          : 'jest' in deps
            ? 'jest'
            : null;
  if (!framework) return null;
  if (framework === 'node')
    return {
      dir,
      framework,
      runner: ['node'],
      missing: null,
      coverage: { available: true, note: null },
    };
  const bin = await findModule(root, abs, `.bin/${framework}`);
  const runner = [bin ? path.relative(abs, bin).split(path.sep).join('/') : framework];
  if (framework === 'jest')
    return {
      dir,
      framework,
      runner,
      missing: bin ? null : 'jest is not installed (node_modules/.bin/jest is missing)',
      coverage: { available: true, note: null },
    };
  const provider =
    (await findModule(root, abs, '@vitest/coverage-v8')) ??
    (await findModule(root, abs, '@vitest/coverage-istanbul'));
  return {
    dir,
    framework,
    runner,
    missing: bin ? null : 'vitest is not installed (node_modules/.bin/vitest is missing)',
    coverage: provider
      ? { available: true, note: null }
      : {
          available: false,
          note: 'Coverage needs @vitest/coverage-v8 (or -istanbul), which is not installed. Friday does not install packages; the user can add it.',
        },
  };
}

async function pythonSuite(root: string, dir: string): Promise<Suite | null> {
  const abs = path.join(root, dir);
  const read = (f: string) => readSmall(path.join(abs, f));
  const [pyproject, ini, cfg, tox, conftest] = await Promise.all([
    read('pyproject.toml'),
    read('pytest.ini'),
    read('setup.cfg'),
    read('tox.ini'),
    exists(path.join(abs, 'conftest.py')),
  ]);
  const requirements = (
    await Promise.all(
      [
        'requirements.txt',
        'requirements-dev.txt',
        'requirements_dev.txt',
        'dev-requirements.txt',
        'Pipfile',
      ].map(read),
    )
  ).join('\n');
  const all = [pyproject, cfg, tox, requirements].join('\n');
  const usesPytest =
    ini !== null ||
    conftest ||
    /\[tool\.pytest/.test(pyproject ?? '') ||
    /\[tool:pytest\]/.test(cfg ?? '') ||
    /\[pytest\]/.test(tox ?? '') ||
    /(^|["'\s])pytest\b/m.test(all);
  if (!usesPytest) return null;
  let runner = ['pytest'];
  for (const venv of ['.venv', 'venv'])
    if (await exists(path.join(abs, venv, 'bin', 'pytest'))) {
      runner = [`${venv}/bin/pytest`];
      break;
    }
  const cov = /pytest-cov\b/.test(all);
  return {
    dir,
    framework: 'pytest',
    runner,
    missing: null,
    coverage: cov
      ? { available: true, note: null }
      : {
          available: false,
          note: 'Coverage needs pytest-cov, which the project does not list. Friday does not install packages.',
        },
  };
}

async function goSuite(root: string, dir: string, gomod: string): Promise<Suite | null> {
  const module = /^module\s+(\S+)/m.exec(gomod)?.[1];
  if (!module) return null;
  return {
    dir,
    framework: 'go',
    runner: ['go', 'test'],
    missing: null,
    coverage: { available: true, note: null },
    goModule: module,
  };
}

/** Every test suite in the project, shallowest first. */
export async function detectSuites(root: string, signal?: AbortSignal): Promise<Suite[]> {
  const { entries } = await walk(root, root, {
    maxDepth: 4,
    maxEntries: 20_000,
    ...(signal ? { signal } : {}),
  });
  const dirs = new Map<string, Set<string>>();
  const note = (rel: string) => {
    const dir = path.posix.dirname(rel);
    const set = dirs.get(dir) ?? new Set<string>();
    set.add(path.posix.basename(rel));
    dirs.set(dir, set);
  };
  for (const e of entries)
    if (
      e.type === 'file' &&
      /(^|\/)(package\.json|go\.mod|pyproject\.toml|pytest\.ini|setup\.cfg|tox\.ini|conftest\.py)$/.test(
        e.rel,
      )
    )
      note(e.rel);
  const suites: Suite[] = [];
  for (const [dir, files] of [...dirs].sort((a, b) => depth(a[0]) - depth(b[0]))) {
    const abs = path.join(root, dir);
    if (files.has('package.json')) {
      const text = await readSmall(path.join(abs, 'package.json'));
      try {
        const pkg = text ? (JSON.parse(text) as PackageJson) : null;
        const s = pkg ? await nodeSuite(root, dir, pkg) : null;
        if (s) suites.push(s);
        const e2e = pkg ? await playwrightSuite(root, dir, pkg) : null;
        if (e2e) suites.push(e2e);
      } catch {
        // Not valid JSON: not a suite.
      }
    }
    if (files.has('go.mod')) {
      const s = await goSuite(root, dir, (await readSmall(path.join(abs, 'go.mod'))) ?? '');
      if (s) suites.push(s);
    }
    // A conftest.py below a pytest suite belongs to that suite.
    if (
      [...files].some((f) => f !== 'package.json' && f !== 'go.mod') &&
      !suites.some((s) => s.framework === 'pytest' && isUnder(dir, s.dir))
    ) {
      const s = await pythonSuite(root, dir);
      if (s) suites.push(s);
    }
  }
  return suites;
}

const depth = (dir: string) => (dir === '.' ? 0 : dir.split('/').length);

/** Whether project-relative `file` is inside suite folder `dir`. */
export function isUnder(file: string, dir: string): boolean {
  return dir === '.' || file === dir || file.startsWith(`${dir}/`);
}

/** Where a suite's tests are: its folder, or a Playwright suite's testDir. */
export function testRoot(suite: Suite): string {
  const t = suite.playwright?.testDir ?? '.';
  return t === '.' ? suite.dir : path.posix.normalize(path.posix.join(suite.dir, t));
}

/**
 * The suite a file belongs to: the deepest one containing it. A Playwright suite claims only
 * files under its testDir, and only over a unit-test suite of the same folder when it is a spec.
 */
export function suiteFor(suites: Suite[], file: string): Suite | null {
  const fits = suites.filter((s) =>
    s.framework === 'playwright' ? isUnder(file, testRoot(s)) : isUnder(file, s.dir),
  );
  return (
    fits.sort(
      (a, b) =>
        depth(b.dir) - depth(a.dir) ||
        (a.framework === 'playwright' ? -1 : 0) - (b.framework === 'playwright' ? -1 : 0),
    )[0] ?? null
  );
}

const JS_TEST = /(^|[./_-])(test|spec)\.[cm]?[jt]sx?$|(^|\/)(__tests__|tests?)\/.+\.[cm]?[jt]sx?$/;
const PY_TEST = /(^|\/)(test_[^/]+|[^/]+_test)\.py$/;

export function isTestFile(framework: TestFramework, rel: string): boolean {
  if (framework === 'pytest') return PY_TEST.test(rel);
  if (framework === 'go') return rel.endsWith('_test.go');
  return JS_TEST.test(rel);
}

/** Source files whose coverage is worth reporting (not tests, not config). */
export function isCodeFile(framework: TestFramework, rel: string): boolean {
  if (isTestFile(framework, rel)) return false;
  if (framework === 'pytest') return rel.endsWith('.py');
  if (framework === 'go') return rel.endsWith('.go');
  return /\.[cm]?[jt]sx?$/.test(rel) && !/(^|\/)[^/]*\.config\.[cm]?[jt]s$/.test(rel);
}

const stem = (rel: string) =>
  path.posix
    .basename(rel)
    .replace(/\.[^.]+$/, '')
    .replace(/^test_|_test$|[.](test|spec)$/, '');

const JS_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
const PY_IMPORT = /^\s*(?:from\s+([\w.]+)\s+import\s+([\w\s,()*]+)|import\s+([\w.,\s]+))/gm;

/** Dotted module names a Python file can be imported as (each suffix of its path). */
function pythonModules(rel: string): string[] {
  const parts = rel
    .replace(/\.py$/, '')
    .replace(/\/__init__$/, '')
    .split('/');
  return parts.map((_, i) => parts.slice(i).join('.'));
}

/**
 * Test files related to the changed files (node:test and pytest; Vitest and Jest find their own
 * through the module graph): changed test files, tests that import a changed file directly, and
 * tests named after one. Paths are project-relative.
 */
export async function relatedTests(
  root: string,
  suite: Suite,
  changed: string[],
  testFiles: string[],
): Promise<string[]> {
  const related = new Set(changed.filter((f) => isTestFile(suite.framework, f)));
  const sources = changed.filter((f) => !isTestFile(suite.framework, f));
  if (!sources.length) return [...related];
  const stems = new Set(sources.map(stem));
  const noExt = new Set(sources.map((f) => f.replace(/\.[cm]?[jt]sx?$/, '')));
  const modules = new Set(
    sources
      .filter((f) => f.endsWith('.py'))
      .flatMap((f) => pythonModules(path.posix.relative(suite.dir === '.' ? '' : suite.dir, f))),
  );
  for (const t of testFiles) {
    if (related.has(t)) continue;
    if (stems.has(stem(t))) {
      related.add(t);
      continue;
    }
    const text = await readSmall(path.join(root, t));
    if (!text) continue;
    if (suite.framework === 'pytest') {
      for (const m of text.matchAll(PY_IMPORT)) {
        const names = m[1]
          ? [
              m[1],
              ...m[2]!
                .split(/[\s,()]+/)
                .filter(Boolean)
                .map((n) => `${m[1]}.${n}`),
            ]
          : m[3]!.split(',').map((n) => n.trim().split(/\s+/)[0]!);
        if (names.some((n) => modules.has(n))) {
          related.add(t);
          break;
        }
      }
      continue;
    }
    for (const m of text.matchAll(JS_IMPORT)) {
      const target = path.posix
        .normalize(path.posix.join(path.posix.dirname(t), m[1]!))
        .replace(/\.[cm]?[jt]sx?$/, '');
      if (noExt.has(target) || noExt.has(`${target}/index`)) {
        related.add(t);
        break;
      }
    }
  }
  return [...related].sort();
}

/** Every test file of a suite (project-relative), honouring .gitignore. */
export async function listTestFiles(root: string, suite: Suite): Promise<string[]> {
  const { entries } = await walk(root, path.join(root, testRoot(suite)), {
    maxDepth: 12,
    maxEntries: 20_000,
  });
  return entries
    .filter((e) => e.type === 'file' && isTestFile(suite.framework, e.rel))
    .map((e) => e.rel);
}
