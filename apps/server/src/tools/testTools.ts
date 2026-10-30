import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  ChangedLineCoverage,
  FlakyTest,
  TestCommandInfo,
  TestFailure,
  TestLocation,
  TestRunDto,
  TestTiming,
} from '@friday/shared';
import { z } from 'zod';
import { extractLocations } from '../commands/locations.js';
import { runProcess, type RunResult } from '../commands/runner.js';
import { hostPaths, OUTPUT_DIR, runInSandbox } from '../sandbox/docker.js';
import { treeFingerprint, workingChanges, type WorkingChanges } from '../testing/changes.js';
import {
  parseGoCover,
  parseGoJson,
  parseJestJson,
  parseJunit,
  parseLcov,
  type LineHits,
  type ParsedResults,
  type TestCase,
} from '../testing/results.js';
import {
  detectSuites,
  isCodeFile,
  isTestFile,
  isUnder,
  listTestFiles,
  relatedTests,
  suiteFor,
  type Suite,
} from '../testing/suites.js';
import {
  assertRootAvailable,
  isSecretPath,
  isWithin,
  resolveInside,
  WorkspaceError,
} from '../workspace/paths.js';
import { clipOutput, displayArgv, prepareCommand, sandboxRun } from './commandTool.js';
import {
  defineTool,
  type NewTestRun,
  type Proposal,
  type TestHistoryRow,
  type ToolContext,
} from './types.js';

/**
 * Test insights. `detect_tests` finds the project's test suites and which tests relate to the
 * uncommitted changes; `run_tests` (approved like any command) runs them with a machine-readable
 * reporter Friday adds, re-runs failures once to tell flaky tests from real ones, optionally
 * measures coverage of the changed lines, and keeps each test's outcome so slow and flaky tests
 * show up across runs. Friday builds the command itself: the model chooses only the suite, scope,
 * test files and a name filter.
 */

const MAX_REPORT_BYTES = 32 * 1024 * 1024;
const MAX_RETRY = 20;
const MAX_FAILURES_SHOWN = 30;
/** A test at least this slow is listed among the slowest. */
const SLOW_MS = 100;

type Scope = TestCommandInfo['scope'];

async function projectRoot(ctx: ToolContext): Promise<string> {
  if (!ctx.project)
    throw new WorkspaceError('unsupported', 'This conversation is not attached to a project.');
  await assertRootAvailable(ctx.project.rootPath);
  return ctx.project.rootPath;
}

const describeSuite = (s: Suite) => `${s.dir === '.' ? '(project root)' : s.dir} (${s.framework})`;

/** Changed files that belong to this suite (and not to a deeper one). */
function changedIn(suites: Suite[], suite: Suite, changes: WorkingChanges | null): string[] {
  return (changes?.files ?? []).filter((f) => suiteFor(suites, f) === suite);
}

/** A suite-relative argument that can't be mistaken for an option. */
function arg(suite: Suite, rel: string): string {
  const r = suite.dir === '.' ? rel : path.posix.relative(suite.dir, rel);
  return r.startsWith('-') ? `./${r}` : r;
}

/** Go packages (as ./dir) holding these files. */
function goPackages(suite: Suite, files: string[]): string[] {
  const dirs = new Set(
    files.filter((f) => f.endsWith('.go')).map((f) => path.posix.dirname(arg(suite, f))),
  );
  return [...dirs].map((d) => (d === '.' ? '.' : `./${d.replace(/^\.\//, '')}`)).sort();
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface Selection {
  scope: Scope;
  /** Suite-relative files, packages or pytest node ids. */
  targets: string[];
  nameFilter: string | null;
  coverage: boolean;
}

/** Where the runner writes its report (as the command sees it) and the file names used. */
const REPORT = {
  vitest: 'json',
  jest: 'json',
  node: 'xml',
  pytest: 'xml',
  go: null,
} as const;

/** The exact argv for a selection. Reports go to `out`, a folder outside the project. */
export function buildArgv(suite: Suite, sel: Selection, out: string, report: string): string[] {
  const { runner } = suite;
  const name = sel.nameFilter;
  switch (suite.framework) {
    case 'vitest':
      return [
        ...runner,
        sel.scope === 'changed' ? 'related' : 'run',
        ...(sel.scope === 'changed' ? ['--run', '--passWithNoTests'] : []),
        ...sel.targets,
        ...(name ? [`--testNamePattern=${name}`] : []),
        '--reporter=default',
        '--reporter=json',
        `--outputFile.json=${out}/${report}.json`,
        ...(sel.coverage
          ? [
              '--coverage.enabled=true',
              '--coverage.reporter=lcov',
              `--coverage.reportsDirectory=${out}/coverage`,
            ]
          : []),
      ];
    case 'jest':
      return [
        ...runner,
        '--ci',
        '--json',
        `--outputFile=${out}/${report}.json`,
        '--testLocationInResults',
        ...(name ? [`--testNamePattern=${name}`] : []),
        ...(sel.coverage
          ? ['--coverage', '--coverageReporters=lcov', `--coverageDirectory=${out}/coverage`]
          : []),
        ...(sel.scope === 'changed'
          ? ['--passWithNoTests', '--findRelatedTests', ...sel.targets]
          : sel.scope === 'files'
            ? ['--runTestsByPath', ...sel.targets]
            : []),
      ];
    case 'node':
      return [
        ...runner,
        '--test',
        '--test-reporter=spec',
        '--test-reporter-destination=stdout',
        '--test-reporter=junit',
        `--test-reporter-destination=${out}/${report}.xml`,
        ...(sel.coverage
          ? [
              '--experimental-test-coverage',
              '--test-reporter=lcov',
              `--test-reporter-destination=${out}/lcov.info`,
            ]
          : []),
        ...(name ? [`--test-name-pattern=${name}`] : []),
        ...sel.targets,
      ];
    case 'pytest':
      return [
        ...runner,
        '-o',
        'junit_family=xunit1',
        `--junitxml=${out}/${report}.xml`,
        ...(sel.coverage ? ['--cov=.', `--cov-report=lcov:${out}/lcov.info`] : []),
        ...(name ? ['-k', name] : []),
        ...sel.targets,
      ];
    case 'go':
      return [
        ...runner,
        '-json',
        ...(sel.coverage ? [`-coverprofile=${out}/cover.out`] : []),
        ...(name ? [`-run=${name}`] : []),
        ...(sel.targets.length ? sel.targets : ['./...']),
      ];
  }
}

const coverageFile = (suite: Suite) =>
  suite.framework === 'go'
    ? 'cover.out'
    : suite.framework === 'vitest' || suite.framework === 'jest'
      ? 'coverage/lcov.info'
      : 'lcov.info';

/** What a run_tests call will test, chosen from the arguments and the working tree. */
async function plan(
  root: string,
  args: {
    suite?: string | undefined;
    scope: Scope;
    files?: string[] | undefined;
    name_filter?: string | undefined;
    coverage: boolean;
  },
) {
  const suites = await detectSuites(root);
  if (!suites.length)
    throw new WorkspaceError(
      'unsupported',
      'No test suite found (Vitest, Jest, node --test, pytest or Go). Read the project\'s own test script (e.g. package.json "test") and run it with run_command instead.',
    );
  const changes = await workingChanges(root);
  let suite: Suite | undefined;
  if (args.suite !== undefined) {
    const want = path.posix.normalize(args.suite.replace(/\\/g, '/')).replace(/\/$/, '') || '.';
    // A folder inside a suite (e.g. its test/ folder) means that suite.
    suite =
      suites.find((s) => s.dir === want) ??
      (!want.startsWith('..') &&
      fs.statSync(path.join(root, want), { throwIfNoEntry: false })?.isDirectory()
        ? suiteFor(suites, want)
        : null) ??
      undefined;
    if (!suite)
      throw new WorkspaceError(
        'not_found',
        `No test suite in "${args.suite}". Suites: ${suites.map(describeSuite).join(', ')}.`,
      );
  } else if (suites.length === 1) suite = suites[0];
  else if (args.scope === 'changed') {
    const touched = suites.filter((s) => changedIn(suites, s, changes).length);
    if (touched.length === 1) suite = touched[0];
    else if (touched.length > 1)
      throw new WorkspaceError(
        'unsupported',
        `The changes span several suites: ${touched.map(describeSuite).join(', ')}. Call run_tests once per suite.`,
      );
  } else if (args.files?.length)
    suite = suiteFor(suites, args.files[0]!.replace(/^\.\//, '')) ?? undefined;
  if (!suite)
    throw new WorkspaceError(
      'unsupported',
      `Pass \`suite\`: this project has several (${suites.map(describeSuite).join(', ')}).`,
    );
  if (suite.missing)
    throw new WorkspaceError(
      'unsupported',
      `${suite.missing}. Friday does not install packages; ask the user to install the project's dependencies.`,
    );
  if (args.coverage && !suite.coverage.available)
    throw new WorkspaceError(
      'unsupported',
      `${suite.coverage.note ?? 'Coverage is not available for this suite.'} Run without coverage.`,
    );

  let changed: string[] = [];
  let testFiles: string[] = [];
  let targets: string[] = [];
  if (args.scope === 'changed') {
    if (!changes)
      throw new WorkspaceError(
        'unsupported',
        'This project is not a git repository, so Friday cannot tell what changed. Use scope "files" or "all".',
      );
    changed = changedIn(suites, suite, changes);
    if (!changed.length)
      throw new WorkspaceError(
        'unsupported',
        `No uncommitted changes in ${describeSuite(suite)}. Use scope "all" or "files".`,
      );
    if (suite.framework === 'vitest' || suite.framework === 'jest') {
      targets = changed.map((f) => arg(suite, f));
    } else if (suite.framework === 'go') {
      targets = goPackages(suite, changed);
      if (!targets.length)
        throw new WorkspaceError('unsupported', 'None of the changed files is a Go file.');
    } else {
      testFiles = await relatedTests(root, suite, changed, await listTestFiles(root, suite));
      if (!testFiles.length)
        throw new WorkspaceError(
          'unsupported',
          `No tests relate to the changed files (${changed.slice(0, 5).join(', ')}): no test file is changed, imports one of them, or is named after one. Use scope "all", or name test files with scope "files".`,
        );
      targets = testFiles.map((f) => arg(suite, f));
    }
  } else if (args.scope === 'files') {
    if (!args.files?.length)
      throw new WorkspaceError('unsupported', 'Scope "files" needs `files`.');
    for (const f of args.files) {
      const r = await resolveInside(root, f);
      if (!fs.statSync(r.abs, { throwIfNoEntry: false })?.isFile())
        throw new WorkspaceError('not_found', `"${r.rel}" is not a file.`);
      if (!isUnder(r.rel, suite.dir))
        throw new WorkspaceError(
          'unsupported',
          `"${r.rel}" is not in the suite ${describeSuite(suite)}.`,
        );
      testFiles.push(r.rel);
    }
    targets =
      suite.framework === 'go' ? goPackages(suite, testFiles) : testFiles.map((f) => arg(suite, f));
  }
  return {
    suite,
    changes,
    changed,
    testFiles,
    selection: {
      scope: args.scope,
      targets,
      nameFilter: args.name_filter ?? null,
      coverage: args.coverage,
    } satisfies Selection,
  };
}

/** Cases with project-relative files, and a stable key per test. */
interface Outcome extends TestCase {
  rel: string | null;
  key: string;
}

function makeResolver(root: string, suite: Suite, cwdAbs: string) {
  const cache = new Map<string, string | null>();
  return (file: string | null, pkg?: string): string | null => {
    if (!file) return null;
    let abs: string;
    if (pkg !== undefined && suite.goModule) {
      const mod = suite.goModule;
      const sub = pkg === mod ? '' : pkg.startsWith(`${mod}/`) ? pkg.slice(mod.length + 1) : null;
      if (sub === null) return null;
      abs = path.join(root, suite.dir, sub, path.basename(file));
    } else abs = path.isAbsolute(file) ? path.normalize(file) : path.resolve(cwdAbs, file);
    if (cache.has(abs)) return cache.get(abs)!;
    let rel: string | null = null;
    if (isWithin(root, abs)) {
      const r = path.relative(root, abs).split(path.sep).join('/');
      if (r && !isSecretPath(r) && fs.statSync(abs, { throwIfNoEntry: false })?.isFile()) rel = r;
    }
    cache.set(abs, rel);
    return rel;
  };
}

/**
 * The key identifies a test across runs, so it only uses what the runner reports. node:test's
 * JUnit output names no file: the file shown is then the test file in the failure's stack, or
 * the only file run.
 */
function outcomes(
  parsed: ParsedResults,
  resolve: ReturnType<typeof makeResolver>,
  guess: { root: string; cwdAbs: string; suite: Suite; onlyFile: string | null },
): Outcome[] {
  return parsed.cases.map((c) => {
    const reported = resolve(c.file, c.pkg);
    const fromStack = () =>
      extractLocations(c.error ?? '', guess.root, guess.cwdAbs, 10)
        .map((l) => l.split(':')[0]!)
        .find((f) => isTestFile(guess.suite.framework, f)) ?? null;
    const rel = reported ?? (c.error ? fromStack() : null) ?? guess.onlyFile;
    return { ...c, rel, key: `${reported ?? c.pkg ?? ''}::${c.name}` };
  });
}

/** The first lines of an error, without stack frames. */
export function firstLines(error: string, max = 600): string {
  const lines = error
    .split('\n')
    .filter((l) => l.trim() && !/^\s+at\s/.test(l) && !/^\s*❯\s/.test(l))
    .slice(0, 8);
  const text = lines.join('\n').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function locate(
  error: string,
  root: string,
  cwdAbs: string,
  fallback: { rel: string | null; line: number | null },
): TestLocation | null {
  const found = extractLocations(error, root, cwdAbs, 1)[0];
  if (found) {
    const [file, line] = found.split(':');
    return { file: file!, line: Number(line) || null };
  }
  return fallback.rel ? { file: fallback.rel, line: fallback.line } : null;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)]! : null;
};

function mergeRanges(lines: number[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const n of [...lines].sort((a, b) => a - b)) {
    const last = out.at(-1);
    if (last && n === last[1] + 1) last[1] = n;
    else out.push([n, n]);
  }
  return out;
}

/** Coverage of the changed lines of this suite's code files. */
export function changedLineCoverage(
  hits: LineHits,
  resolveFile: (name: string) => string | null,
  changed: string[],
  ranges: Record<string, Array<[number, number]>>,
  suite: Suite,
): ChangedLineCoverage[] {
  const byRel = new Map<string, Map<number, number>>();
  for (const [name, lines] of hits) {
    const rel = resolveFile(name);
    if (rel) byRel.set(rel, lines);
  }
  const out: ChangedLineCoverage[] = [];
  for (const file of changed) {
    if (!isCodeFile(suite.framework, file) || !ranges[file]?.length) continue;
    const lines = ranges[file]!.flatMap(([a, b]) =>
      Array.from({ length: Math.min(b - a + 1, 5_000) }, (_, i) => a + i),
    );
    const cov = byRel.get(file);
    if (!cov) {
      out.push({
        file,
        lines: lines.length,
        covered: 0,
        uncovered: mergeRanges(lines),
        notLoaded: true,
      });
      continue;
    }
    const executable = lines.filter((n) => cov.has(n));
    const missed = executable.filter((n) => !cov.get(n));
    out.push({
      file,
      lines: executable.length,
      covered: executable.length - missed.length,
      uncovered: mergeRanges(missed),
      notLoaded: false,
    });
  }
  return out.slice(0, 30);
}

async function readReport(file: string, sandboxRoot: string | null): Promise<string | null> {
  const stat = await fsp.lstat(file).catch(() => null);
  if (!stat?.isFile() || stat.size > MAX_REPORT_BYTES) return null;
  const text = await fsp.readFile(file, 'utf8');
  return sandboxRoot ? hostPaths(text, sandboxRoot) : text;
}

function parseReport(suite: Suite, text: string | null, output: string): ParsedResults | null {
  try {
    if (suite.framework === 'go') return parseGoJson(output);
    if (text === null) return null;
    return REPORT[suite.framework] === 'json' ? parseJestJson(text) : parseJunit(text);
  } catch {
    return null;
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const fmtRanges = (r: Array<[number, number]>) =>
  r
    .slice(0, 8)
    .map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`))
    .join(', ') + (r.length > 8 ? ', …' : '');

function countsLine(dto: Pick<TestRunDto, 'counts'>): string {
  const c = dto.counts;
  const parts = [`${c.failed} failed`, `${c.passed} passed`];
  if (c.flaky) parts.push(`${c.flaky} flaky`);
  if (c.skipped) parts.push(`${c.skipped} skipped`);
  return parts.join(', ');
}

/** The text the model reads. */
function report(dto: NewTestRun, extra: { retry: string | null; output: string }): string {
  const lines = [
    `$ ${dto.command}`,
    `${dto.framework} in ${dto.suite === '.' ? 'the project root' : dto.suite}, ${dto.scope === 'changed' ? 'tests related to the uncommitted changes' : dto.scope === 'files' ? 'chosen tests' : 'all tests'}`,
    `${dto.exitCode === null ? 'did not finish' : `exit code ${dto.exitCode}`} in ${(dto.durationMs / 1000).toFixed(1)}s: ${countsLine(dto)}`,
  ];
  if (extra.retry) lines.push(`Failed tests re-run once: $ ${extra.retry}`);
  if (dto.error) lines.push('', 'Error:', dto.error);
  if (dto.failures.length) {
    lines.push('', 'Failures (first error of each):');
    dto.failures.forEach((f, i) => {
      lines.push(
        `${i + 1}. ${f.file ? `${f.file} › ` : ''}${f.name}${f.failedBefore ? ` (also failed in ${plural(f.failedBefore, 'earlier run')})` : ''}`,
      );
      if (f.at) lines.push(`   at ${f.at.file}${f.at.line ? `:${f.at.line}` : ''}`);
      lines.push(...f.message.split('\n').map((l) => `   ${l}`));
    });
  }
  if (dto.flaky.length) {
    lines.push('', 'Flaky (not caused by a code difference):');
    for (const f of dto.flaky)
      lines.push(`- ${f.file ? `${f.file} › ` : ''}${f.name}: ${f.detail}`);
  }
  if (dto.slowest.length) {
    lines.push('', 'Slowest:');
    for (const t of dto.slowest)
      lines.push(
        `- ${t.durationMs} ms ${t.file ? `${t.file} › ` : ''}${t.name}${t.usualMs !== null ? ` (usually ${t.usualMs} ms)` : ''}`,
      );
  }
  if (dto.coverage) {
    lines.push('', 'Coverage of the changed lines:');
    if (!dto.coverage.available) lines.push(dto.coverage.note ?? 'not available');
    else if (!dto.coverage.files.length) lines.push(dto.coverage.note ?? 'no changed code lines');
    for (const f of dto.coverage.files)
      lines.push(
        f.notLoaded
          ? `- ${f.file}: not loaded by these tests (changed lines ${fmtRanges(f.uncovered)})`
          : `- ${f.file}: ${f.covered}/${f.lines} changed lines ran${f.uncovered.length ? `; never ran: ${fmtRanges(f.uncovered)}` : ''}`,
      );
  }
  if (dto.failures.length || dto.error)
    lines.push(
      '',
      'Read the code at these locations before changing anything; start with the first failure.',
    );
  if (extra.output) lines.push('', '--- output (end) ---', extra.output);
  return lines.join('\n');
}

export const detectTests = defineTool({
  name: 'detect_tests',
  description:
    "Find the project's test suites (Vitest, Jest, node --test, pytest, Go): each suite's folder, framework, whether its runner and coverage are installed, and which uncommitted changes fall in it (with the related test files where Friday picks them). Read-only. Use it before run_tests when the project has several suites or you don't know its test setup.",
  category: 'read_only',
  risk: 'low',
  requiresProject: true,
  schema: z.object({}),
  describeCall: () => 'test suites',
  async execute(_args, ctx) {
    const root = await projectRoot(ctx);
    const suites = await detectSuites(root, ctx.signal);
    if (!suites.length)
      return {
        content:
          'No test suite found (Vitest, Jest, node --test, pytest or Go). If the project has another test command (see package.json "test", a Makefile, composer.json), run it with run_command.',
        summary: 'no test suites',
      };
    const changes = await workingChanges(root);
    const lines = [`Test suites (${suites.length}):`];
    for (const s of suites) {
      const changed = changedIn(suites, s, changes);
      const tests = s.framework === 'go' ? [] : await listTestFiles(root, s);
      lines.push(
        `- suite "${s.dir}"${s.dir === '.' ? ' (the project root)' : ''}: ${s.framework}, runs \`${displayArgv(s.runner)}\`${s.missing ? `; NOT RUNNABLE: ${s.missing}` : ''}`,
        `  coverage: ${s.coverage.available ? 'available' : `not available (${s.coverage.note})`}`,
      );
      if (s.framework !== 'go') lines.push(`  ${plural(tests.length, 'test file')}`);
      if (changed.length) {
        lines.push(
          `  uncommitted changes here: ${changed.slice(0, 15).join(', ')}${changed.length > 15 ? ', …' : ''}`,
        );
        if (s.framework === 'node' || s.framework === 'pytest') {
          const related = await relatedTests(root, s, changed, tests);
          lines.push(
            related.length
              ? `  related tests: ${related.slice(0, 15).join(', ')}${related.length > 15 ? ', …' : ''}`
              : '  related tests: none found (no test file is changed, imports a changed file, or is named after one)',
          );
        } else if (s.framework === 'go')
          lines.push(`  packages: ${goPackages(s, changed).join(' ') || '(no Go files changed)'}`);
        else lines.push(`  related tests: ${s.framework} finds them from the imports when run`);
      }
    }
    if (!changes) lines.push('', 'Not a git repository: scope "changed" is not available.');
    else {
      const outside = changes.files.filter((f) => !suiteFor(suites, f));
      if (!changes.files.length) lines.push('', 'No uncommitted changes.');
      else if (outside.length)
        lines.push('', `Changes outside any suite: ${outside.slice(0, 10).join(', ')}`);
    }
    lines.push(
      '',
      'Run the tests related to the changes first (run_tests, scope "changed"), then the whole suite when they pass.',
    );
    return { content: lines.join('\n'), summary: plural(suites.length, 'suite') };
  },
});

export const runTests = defineTool({
  name: 'run_tests',
  description:
    'Run a test suite and get a structured summary: failures with the first error and file:line, flaky tests, the slowest tests, and optionally coverage of the changed lines. Friday builds the exact command for the framework (Vitest, Jest, node --test, pytest, Go) with a reporter it reads; the user approves it like run_command. scope "changed" (default) runs only the tests related to the uncommitted changes; "files" runs the given test files; "all" runs the whole suite. Failed tests are re-run once, so a test that then passes is reported as flaky rather than broken. Prefer this to run_command for running tests; use run_command for test commands it does not support.',
  category: 'shell',
  risk: 'medium',
  requiresProject: true,
  schema: z.object({
    suite: z
      .string()
      .max(500)
      .optional()
      .describe(
        'The suite folder from detect_tests (relative to the project root). Optional when it is clear.',
      ),
    scope: z.enum(['changed', 'files', 'all']).default('changed'),
    files: z
      .array(z.string().min(1).max(500))
      .max(50)
      .optional()
      .describe('Test files (relative to the project root), for scope "files".'),
    name_filter: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[^-]/, 'must not start with "-"')
      .optional()
      .describe(
        'Only tests whose name matches (Vitest/Jest --testNamePattern, pytest -k, go -run, node --test-name-pattern).',
      ),
    coverage: z
      .boolean()
      .default(false)
      .describe('Measure which changed lines the tests ran (needs the coverage tool installed).'),
    retry_failures: z.boolean().default(true),
    timeout_seconds: z.number().int().min(10).max(600).default(300),
    reason: z.string().min(3).max(500).describe('Why these tests are run. Shown to the user.'),
  }),
  describeCall: (a) =>
    `${a.scope}${a.suite ? ` in ${a.suite}` : ''}${a.coverage ? ', coverage' : ''}`.slice(0, 120),
  async prepare(args, ctx): Promise<Proposal> {
    const root = await projectRoot(ctx);
    const p = await plan(root, args);
    const { suite, selection } = p;
    // Fixed per call, so re-checking the proposal after approval yields the same command.
    const id = (ctx.callId ?? ctx.runId).replace(/[^\w-]/g, '').slice(-24) || 'run';
    const hostOut = path.join(os.tmpdir(), `friday-tests-${id}`);
    const sandboxed = Boolean(ctx.project!.sandbox?.enabled);
    const out = sandboxed ? OUTPUT_DIR : hostOut;
    const argv = buildArgv(suite, selection, out, 'results');
    const prep = await prepareCommand({ argv, cwd: suite.dir }, ctx);
    const tests: TestCommandInfo = {
      framework: suite.framework,
      suite: suite.dir,
      scope: args.scope,
      changedFiles: p.changed,
      testFiles: p.testFiles,
      nameFilter: selection.nameFilter,
      coverage: args.coverage,
      retryFailures: args.retry_failures,
    };
    const shown = displayArgv(argv);
    const what =
      args.scope === 'changed'
        ? `the tests related to ${plural(p.changed.length, 'changed file')}`
        : args.scope === 'files'
          ? plural(p.testFiles.length, 'test file')
          : 'the whole suite';
    return {
      title: `Run tests: ${suite.framework} in ${suite.dir === '.' ? 'the project root' : suite.dir}`,
      summary: `Runs ${what} ${prep.sandbox ? 'in the project container' : 'on this machine'}, for up to ${args.timeout_seconds}s${args.retry_failures ? ', then re-runs failed tests once' : ''}.`,
      category: 'shell',
      risk: prep.assessment.risk,
      details: { ...prep.details, timeoutSeconds: args.timeout_seconds, tests },
      fingerprint: `cwd:${prep.cwd.abs}|sandbox:${prep.sandbox ? JSON.stringify(prep.sandbox) : 'off'}|argv:${JSON.stringify(argv)}`,
      timeoutMs: (args.timeout_seconds * (args.retry_failures ? 2 : 1) + 15) * 1000,
      async apply(execCtx) {
        const started = Date.now();
        const tree = await treeFingerprint(root).catch(() => null);
        const exec = async (cmd: string[]): Promise<RunResult> => {
          const run = {
            timeoutMs: args.timeout_seconds * 1000,
            signal: execCtx.signal,
            ...(execCtx.emitOutput ? { onOutput: execCtx.emitOutput } : {}),
          };
          const result = prep.sandbox
            ? await runInSandbox(
                await sandboxRun(
                  root,
                  prep.cwd.rel,
                  prep.sandbox,
                  { argv: cmd, shellCommand: null },
                  prep.gitDir,
                  execCtx.env.sandboxInstance,
                  undefined,
                  hostOut,
                ),
                run,
              )
            : await runProcess({ argv: cmd, shellCommand: null, cwd: prep.cwd.abs, ...run });
          if (result.spawnError) throw new WorkspaceError('unsupported', result.spawnError);
          return result;
        };
        await fsp.rm(hostOut, { recursive: true, force: true });
        await fsp.mkdir(hostOut, { mode: 0o700 });
        try {
          return await runAndSummarise();
        } finally {
          await fsp.rm(hostOut, { recursive: true, force: true }).catch(() => undefined);
        }

        async function runAndSummarise() {
          const sandboxRoot = prep.sandbox ? root : null;
          const cwdAbs = prep.cwd.abs;
          const resolve = makeResolver(root, suite, cwdAbs);
          const guess = {
            root,
            cwdAbs,
            suite,
            onlyFile: p.testFiles.length === 1 ? p.testFiles[0]! : null,
          };
          const ext = REPORT[suite.framework];
          const first = await exec(argv);
          const firstOutput = prep.sandbox ? hostPaths(first.output, root) : first.output;
          const parsed = parseReport(
            suite,
            ext ? await readReport(path.join(hostOut, `results.${ext}`), sandboxRoot) : null,
            firstOutput,
          );
          const cases = parsed ? outcomes(parsed, resolve, guess) : [];
          const failed = cases.filter((c) => c.status === 'failed');

          // Re-run failed tests once: one that passes now failed for a reason other than the code.
          let retryShown: string | null = null;
          const flakyKeys = new Set<string>();
          const retryable =
            args.retry_failures &&
            failed.length > 0 &&
            failed.length <= MAX_RETRY &&
            !first.timedOut &&
            !first.cancelled &&
            failed.every((c) => (suite.framework === 'pytest' ? c.nodeId : c.rel));
          if (retryable) {
            const files = [...new Set(failed.map((c) => c.rel!))];
            const names = [...new Set(failed.map((c) => c.filterName))];
            const sel: Selection =
              suite.framework === 'pytest'
                ? {
                    scope: 'files',
                    targets: failed.map((c) =>
                      c.nodeId!.startsWith('-') ? `./${c.nodeId}` : c.nodeId!,
                    ),
                    nameFilter: null,
                    coverage: false,
                  }
                : suite.framework === 'go'
                  ? {
                      scope: 'files',
                      targets: goPackages(suite, files),
                      nameFilter: `^(${names.map(escapeRegex).join('|')})$`,
                      coverage: false,
                    }
                  : {
                      scope: 'files',
                      targets: files.map((f) => arg(suite, f)),
                      nameFilter: names.map(escapeRegex).join('|'),
                      coverage: false,
                    };
            const retryArgv = buildArgv(suite, sel, prep.sandbox ? OUTPUT_DIR : hostOut, 'retry');
            retryShown = displayArgv(retryArgv);
            execCtx.emitOutput?.(`\n$ ${retryShown}\n`);
            const second = await exec(retryArgv);
            const again = parseReport(
              suite,
              ext ? await readReport(path.join(hostOut, `retry.${ext}`), sandboxRoot) : null,
              prep.sandbox ? hostPaths(second.output, root) : second.output,
            );
            const passedNow = new Set(
              (again ? outcomes(again, resolve, guess) : [])
                .filter((c) => c.status === 'passed')
                .map((c) => c.key),
            );
            for (const c of failed) if (passedNow.has(c.key)) flakyKeys.add(c.key);
          }

          const history =
            execCtx.tests?.history(
              suite.dir,
              cases.map((c) => c.key),
            ) ?? [];
          const byKey = new Map<string, TestHistoryRow[]>();
          for (const h of history) byKey.set(h.key, [...(byKey.get(h.key) ?? []), h]);

          const real = failed.filter((c) => !flakyKeys.has(c.key));
          const redact = (s: string) => ctx.redactor.redact(s);
          const failures: TestFailure[] = [
            ...(parsed?.fileErrors ?? []).map((e) => {
              const rel = resolve(e.file);
              return {
                name: rel ? 'failed to load' : 'suite error',
                file: rel,
                message: redact(firstLines(e.error, 1_000)),
                at: locate(e.error, root, cwdAbs, { rel, line: null }),
                failedBefore: 0,
              };
            }),
            ...real.map((c) => ({
              name: c.name,
              file: c.rel,
              message: redact(firstLines(c.message || c.error || 'failed')),
              at: locate(c.error ?? '', root, cwdAbs, { rel: c.rel, line: c.line }),
              // A flaky outcome failed too, before passing on the re-run.
              failedBefore: (byKey.get(c.key) ?? []).filter(
                (h) => h.status === 'failed' || h.status === 'flaky',
              ).length,
            })),
          ].slice(0, MAX_FAILURES_SHOWN);

          const flaky: FlakyTest[] = failed
            .filter((c) => flakyKeys.has(c.key))
            .map((c) => ({
              name: c.name,
              file: c.rel,
              evidence: 'passed_on_retry' as const,
              detail: 'failed, then passed when re-run with no change',
            }));
          if (tree)
            for (const c of cases) {
              if (flakyKeys.has(c.key) || c.status === 'skipped' || flaky.length >= 10) continue;
              const same = (byKey.get(c.key) ?? []).filter((h) => h.tree === tree);
              const seen = new Set([c.status, ...same.map((h) => h.status)]);
              if ((seen.has('passed') || seen.has('flaky')) && seen.has('failed'))
                flaky.push({
                  name: c.name,
                  file: c.rel,
                  evidence: 'mixed_on_same_code',
                  detail: `passed and failed on the same code (${plural(same.length + 1, 'run')})`,
                });
            }

          // Tests worth a look for speed: slow ones, and ones much slower than they usually are.
          const slowest: TestTiming[] = cases
            .filter((c) => c.durationMs !== null && c.status !== 'skipped')
            .map((c) => {
              const earlier = (byKey.get(c.key) ?? [])
                .filter((h) => h.status === 'passed' && h.durationMs !== null)
                .map((h) => h.durationMs!);
              return {
                name: c.name,
                file: c.rel,
                durationMs: Math.round(c.durationMs!),
                usualMs: earlier.length >= 2 ? Math.round(median(earlier)!) : null,
              };
            })
            .filter(
              (t) =>
                t.durationMs >= SLOW_MS ||
                (t.usualMs !== null && t.durationMs >= 50 && t.durationMs > 2 * t.usualMs),
            )
            .sort((a, b) => b.durationMs - a.durationMs)
            .slice(0, 5);

          let coverage: TestRunDto['coverage'] = null;
          if (args.coverage) {
            const text = await readReport(path.join(hostOut, coverageFile(suite)), sandboxRoot);
            if (text === null)
              coverage = {
                available: false,
                note: 'The test run wrote no coverage report.',
                files: [],
              };
            else {
              const hits = suite.framework === 'go' ? parseGoCover(text) : parseLcov(text);
              const resolveCov = (name: string) =>
                suite.framework === 'go'
                  ? resolve(path.posix.basename(name), path.posix.dirname(name))
                  : resolve(name);
              const changedHere = p.changes
                ? p.changes.files.filter((f) => isUnder(f, suite.dir))
                : [];
              const files = changedLineCoverage(
                hits,
                resolveCov,
                changedHere,
                p.changes?.lines ?? {},
                suite,
              );
              coverage = {
                available: true,
                note: files.length ? null : 'No changed code lines in this suite to measure.',
                files,
              };
            }
          }

          const loadErrors = parsed?.fileErrors.length ?? 0;
          const noResults = !parsed || (!cases.length && !loadErrors);
          const exitCode = first.timedOut || first.cancelled ? null : first.exitCode;
          const status: TestRunDto['status'] =
            noResults && exitCode !== 0
              ? 'error'
              : real.length || loadErrors || (exitCode !== 0 && !flakyKeys.size)
                ? 'failed'
                : 'passed';
          const tail = clipOutput(firstOutput, 4_000).text;
          const error = first.timedOut
            ? `Timed out after ${args.timeout_seconds}s (process killed).`
            : first.cancelled
              ? 'Cancelled.'
              : status === 'error'
                ? redact(firstOutput.slice(-1_500).trim() || `exit code ${exitCode}`)
                : status === 'failed' && !failures.length
                  ? `Exit code ${exitCode}, but no failing test was reported (e.g. a coverage threshold or a setup step failed).`
                  : null;

          const dto: NewTestRun = {
            suite: suite.dir,
            framework: suite.framework,
            scope: args.scope,
            command: shown,
            status,
            exitCode,
            durationMs: Date.now() - started,
            counts: {
              passed: cases.filter((c) => c.status === 'passed').length,
              failed: real.length,
              skipped: cases.filter((c) => c.status === 'skipped').length,
              flaky: flakyKeys.size,
            },
            error,
            failures,
            flaky,
            slowest,
            coverage,
          };
          execCtx.tests?.record(
            dto,
            cases.map((c) => ({
              key: c.key,
              status: flakyKeys.has(c.key) ? 'flaky' : c.status,
              durationMs: c.durationMs === null ? null : Math.round(c.durationMs),
            })),
            tree,
          );
          const content = report(dto, {
            retry: retryShown,
            output: status === 'error' || error ? tail : '',
          });
          const total = cases.length;
          const summary =
            exitCode === null
              ? (error ?? 'did not finish')
              : `exit code ${exitCode}: ${total || loadErrors ? countsLine(dto) : 'no tests ran'} (${(dto.durationMs / 1000).toFixed(1)}s)`;
          return { content, summary, truncated: first.omittedBytes > 0 };
        }
      },
    };
  },
});
