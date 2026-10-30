import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ApprovalDetails, RunEvent, TestRunDto } from '@friday/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { Redactor } from '../src/security/redact.js';
import { changedLineCoverage, buildArgv, firstLines, runTests } from '../src/tools/testTools.js';
import {
  parseGoCover,
  parseGoJson,
  parseJestJson,
  parseJunit,
  parseLcov,
} from '../src/testing/results.js';
import { detectSuites, relatedTests, listTestFiles, type Suite } from '../src/testing/suites.js';
import { TestRunRepo } from '../src/repositories/testRuns.js';
import type { ToolContext } from '../src/tools/types.js';
import { detectToolEnvironment } from '../src/workspace/environment.js';
import { call, cleanupProjects, makeProject, ScriptedProvider, testServices } from './helpers.js';

afterEach(cleanupProjects);
const env = await detectToolEnvironment();
const FRIDAY_MODULES = path.resolve(import.meta.dirname, '../../../node_modules');

const g = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();

function commitAll(root: string) {
  g(root, 'init', '-q', '-b', 'main');
  g(root, 'config', 'user.email', 'f@test');
  g(root, 'config', 'user.name', 'F');
  g(root, 'add', '-A');
  g(root, 'commit', '-q', '-m', 'init');
}

const CART = [
  'export function total(items) {',
  '  let t = 0;',
  '  for (const i of items) t += i.price * i.qty;',
  '  return t;',
  '}',
  'export function discount(t, pct) {',
  '  if (pct > 50) return t;',
  '  return t - (t * pct) / 100;',
  '}',
  '',
].join('\n');

const CART_TEST = [
  "import { test, describe } from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { total } from './cart.js';",
  "describe('cart', () => {",
  "  test('adds', () => assert.equal(total([{ price: 2, qty: 3 }]), 6));",
  "  test('empty', () => assert.equal(total([]), 0));",
  '});',
  '',
].join('\n');

function nodeProject(extra: Record<string, string> = {}) {
  const root = makeProject({
    'package.json': JSON.stringify({ type: 'module', scripts: { test: 'node --test' } }),
    'cart.js': CART,
    'cart.test.js': CART_TEST,
    'other.test.js': "import { test } from 'node:test';\ntest('other', () => {});\n",
    ...extra,
  });
  commitAll(root);
  return root;
}

function ctx(root: string, repo?: TestRunRepo, tree?: { projectId: string; sessionId: string }) {
  const recorded: TestRunDto[] = [];
  const c: ToolContext = {
    project: {
      id: tree?.projectId ?? 'p',
      name: 'shop',
      rootPath: root,
      createdAt: '',
      lastOpenedAt: null,
      sandbox: null,
      worktree: null,
    },
    sessionId: 's',
    runId: 'r',
    callId: `call_${Math.random().toString(36).slice(2, 8)}`,
    signal: new AbortController().signal,
    redactor: new Redactor(),
    env,
    maxOutputChars: 40_000,
    setPlan: () => undefined,
    tests: {
      history: (suite, keys) => repo?.history(tree!.projectId, suite, keys) ?? [],
      record: (dto, results, t) => {
        const saved = repo
          ? repo.create(
              {
                projectId: tree!.projectId,
                sessionId: tree!.sessionId,
                runId: 'r',
                toolCallId: 'c',
              },
              dto,
              results,
              t,
            )
          : {
              ...dto,
              id: 'tr',
              sessionId: 's',
              runId: 'r',
              toolCallId: 'c',
              projectId: 'p',
              createdAt: '',
            };
        recorded.push(saved);
        return saved;
      },
    },
  };
  return { c, recorded };
}

/** Prepare (what the approval card shows) and apply (what runs after approval). */
async function approveAndRun(c: ToolContext, args: Record<string, unknown>) {
  const parsed = runTests.schema.parse({ reason: 'check the change', ...args });
  const proposal = await runTests.prepare!(parsed, c);
  const out = await proposal.apply(c);
  return { proposal, out };
}

describe('result parsers', () => {
  it('reads Vitest/Jest JSON, including files that failed to load', () => {
    const r = parseJestJson(
      JSON.stringify({
        testResults: [
          {
            name: '/p/src/cart.test.ts',
            status: 'failed',
            message: '',
            assertionResults: [
              {
                ancestorTitles: ['cart'],
                title: 'adds',
                fullName: 'cart adds',
                status: 'failed',
                duration: 6.7,
                failureMessages: [
                  '\u001b[31mAssertionError: expected 6 to be 7\u001b[39m\n    at /p/src/cart.test.ts:4:60',
                ],
                location: { line: 4, column: 3 },
              },
              { ancestorTitles: ['cart'], title: 'later', status: 'skipped', failureMessages: [] },
              {
                ancestorTitles: [],
                title: 'top',
                status: 'passed',
                duration: 1,
                failureMessages: [],
              },
            ],
          },
          {
            name: '/p/src/broken.test.ts',
            status: 'failed',
            message: 'Failed to load url ./nope',
            assertionResults: [],
          },
        ],
      }),
    );
    expect(r.cases).toEqual([
      expect.objectContaining({
        file: '/p/src/cart.test.ts',
        name: 'cart › adds',
        filterName: 'cart adds',
        status: 'failed',
        line: 4,
        error: 'AssertionError: expected 6 to be 7\n    at /p/src/cart.test.ts:4:60',
      }),
      expect.objectContaining({ name: 'cart › later', status: 'skipped' }),
      expect.objectContaining({ name: 'top', status: 'passed', durationMs: 1 }),
    ]);
    expect(r.fileErrors).toEqual([
      { file: '/p/src/broken.test.ts', error: 'Failed to load url ./nope' },
    ]);
  });

  it('reads JUnit from node:test and pytest', () => {
    const node = parseJunit(`<?xml version="1.0" encoding="utf-8"?>
<testsuites>
  <testsuite name="cart" tests="2" failures="1">
    <testcase name="adds" time="0.002093" classname="test" failure="x">
      <failure type="testCodeFailure" message="Expected values to be strictly equal:6 !== 7">
Error [ERR_TEST_FAILURE]: Expected values to be strictly equal:

6 !== 7

    at TestContext.&lt;anonymous> (file:///p/cart.test.js:5:37)
      </failure>
    </testcase>
    <testcase name="empty" time="0.000153" classname="test"/>
  </testsuite>
  <testcase name="top" time="0.1" classname="test"/>
  <!-- tests 3 -->
</testsuites>`);
    expect(node.cases).toEqual([
      expect.objectContaining({
        file: null,
        name: 'cart › adds',
        filterName: 'adds',
        status: 'failed',
        durationMs: 2,
        message: 'Expected values to be strictly equal:\n\n6 !== 7',
      }),
      expect.objectContaining({ name: 'cart › empty', status: 'passed' }),
      expect.objectContaining({ name: 'top', status: 'passed', durationMs: 100 }),
    ]);
    expect(node.cases[0]!.error).toContain('file:///p/cart.test.js:5:37');

    const py =
      parseJunit(`<?xml version="1.0" encoding="utf-8"?><testsuites><testsuite name="pytest" errors="1" failures="1" skipped="1" tests="4">
<testcase classname="tests.test_cart.TestCart" name="test_total[2-3]" file="tests/test_cart.py" line="11" time="0.010"><failure message="AssertionError: assert 6 == 7">tests/test_cart.py:12: AssertionError</failure></testcase>
<testcase classname="tests.test_cart" name="test_empty" file="tests/test_cart.py" line="20" time="0.001"/>
<testcase classname="tests.test_cart" name="test_later" file="tests/test_cart.py" line="24" time="0"><skipped type="pytest.skip" message="later"/></testcase>
<testcase classname="" name="tests.test_broken" time="0"><error message="collection failure">ImportError: no module named nope</error></testcase>
</testsuite></testsuites>`);
    expect(py.cases[0]).toMatchObject({
      file: 'tests/test_cart.py',
      name: 'TestCart › test_total[2-3]',
      status: 'failed',
      line: 11,
      nodeId: 'tests/test_cart.py::TestCart::test_total[2-3]',
      message: 'AssertionError: assert 6 == 7',
    });
    expect(py.cases[1]).toMatchObject({
      name: 'test_empty',
      nodeId: 'tests/test_cart.py::test_empty',
    });
    expect(py.cases[2]!.status).toBe('skipped');
    expect(py.cases[3]).toMatchObject({ status: 'failed', message: 'collection failure' });
  });

  it('reads go test -json: subtests instead of their parents, and build failures', () => {
    const ev = (o: object) => JSON.stringify(o);
    const r = parseGoJson(
      [
        ev({ Action: 'run', Package: 'ex.com/shop/cart', Test: 'TestTotal' }),
        ev({ Action: 'run', Package: 'ex.com/shop/cart', Test: 'TestTotal/empty' }),
        ev({
          Action: 'output',
          Package: 'ex.com/shop/cart',
          Test: 'TestTotal/empty',
          Output: '=== RUN   TestTotal/empty\n',
        }),
        ev({
          Action: 'output',
          Package: 'ex.com/shop/cart',
          Test: 'TestTotal/empty',
          Output: '    cart_test.go:12: got 1, want 0\n',
        }),
        ev({ Action: 'fail', Package: 'ex.com/shop/cart', Test: 'TestTotal/empty', Elapsed: 0.01 }),
        ev({ Action: 'fail', Package: 'ex.com/shop/cart', Test: 'TestTotal', Elapsed: 0.02 }),
        ev({ Action: 'pass', Package: 'ex.com/shop/cart', Test: 'TestDiscount', Elapsed: 1.5 }),
        ev({ Action: 'fail', Package: 'ex.com/shop/cart', Elapsed: 2 }),
        ev({
          Action: 'output',
          Package: 'ex.com/shop/api',
          Output: 'api.go:3:2: undefined: nope\n',
        }),
        ev({ Action: 'fail', Package: 'ex.com/shop/api', Elapsed: 0 }),
      ].join('\n'),
    );
    expect(r.cases).toEqual([
      expect.objectContaining({
        name: 'TestTotal › empty',
        filterName: 'TestTotal',
        file: 'cart_test.go',
        line: 12,
        status: 'failed',
        error: 'cart_test.go:12: got 1, want 0',
        pkg: 'ex.com/shop/cart',
      }),
      expect.objectContaining({ name: 'TestDiscount', status: 'passed', durationMs: 1500 }),
    ]);
    expect(r.fileErrors).toEqual([
      { file: null, error: 'ex.com/shop/api: api.go:3:2: undefined: nope' },
    ]);
  });

  it('reads LCOV and Go cover profiles', () => {
    const lcov = parseLcov(
      'TN:\nSF:cart.js\nDA:1,1\nDA:7,0\nDA:8,0\nend_of_record\nSF:/p/b.js\nDA:2,3\nend_of_record\n',
    );
    expect([...lcov.get('cart.js')!]).toEqual([
      [1, 1],
      [7, 0],
      [8, 0],
    ]);
    expect(lcov.get('/p/b.js')!.get(2)).toBe(3);
    const cover = parseGoCover(
      'mode: set\nex.com/shop/cart/cart.go:3.20,5.2 2 1\nex.com/shop/cart/cart.go:7.10,8.3 1 0\n',
    );
    expect([...cover.get('ex.com/shop/cart/cart.go')!]).toEqual([
      [3, 1],
      [4, 1],
      [5, 1],
      [7, 0],
      [8, 0],
    ]);
  });

  it('keeps the error message without its stack', () => {
    expect(
      firstLines('AssertionError: nope\n\n- 1\n+ 2\n    at a (x.js:1:1)\n    at b (y.js:2:2)'),
    ).toBe('AssertionError: nope\n- 1\n+ 2');
  });
});

describe('suites and related tests', () => {
  it('finds each suite and its runner, and says what is missing', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ workspaces: ['web'] }),
      'web/package.json': JSON.stringify({ scripts: { test: 'vitest run' } }),
      'web/src/a.test.ts': '',
      'node_modules/.bin/vitest': '#!/bin/sh\n',
      'api/package.json': JSON.stringify({ devDependencies: { jest: '^30' } }),
      'tools/package.json': JSON.stringify({ scripts: { test: 'node --test test/' } }),
      'py/pyproject.toml': '[tool.pytest.ini_options]\naddopts = "-q"\n',
      'py/requirements-dev.txt': 'pytest\npytest-cov\n',
      'py/tests/conftest.py': '',
      'svc/go.mod': 'module example.com/svc\n\ngo 1.22\n',
      'docs/package.json': JSON.stringify({ scripts: { build: 'x' } }),
    });
    const suites = await detectSuites(root);
    expect(
      suites.map((s) => [
        s.dir,
        s.framework,
        s.runner.join(' '),
        s.missing !== null,
        s.coverage.available,
      ]),
    ).toEqual([
      ['api', 'jest', 'jest', true, true],
      ['py', 'pytest', 'pytest', false, true],
      ['svc', 'go', 'go test', false, true],
      ['tools', 'node', 'node', false, true],
      ['web', 'vitest', '../node_modules/.bin/vitest', false, false],
    ]);
    expect(suites.find((s) => s.dir === 'web')!.coverage.note).toMatch(/@vitest\/coverage-v8/);
    expect(suites.find((s) => s.dir === 'svc')!.goModule).toBe('example.com/svc');
  });

  it('relates tests to changed files by name and by import', async () => {
    const root = makeProject({
      'src/cart.js': '',
      'src/util/index.js': '',
      'test/cart.test.js': '',
      'test/checkout.test.js': "import { total } from '../src/cart.js';",
      'test/fmt.test.js': "const u = require('../src/util');",
      'test/unrelated.test.js': "import x from 'cart';",
    });
    const suite: Suite = {
      dir: '.',
      framework: 'node',
      runner: ['node'],
      missing: null,
      coverage: { available: true, note: null },
    };
    const tests = await listTestFiles(root, suite);
    expect(await relatedTests(root, suite, ['src/cart.js'], tests)).toEqual([
      'test/cart.test.js',
      'test/checkout.test.js',
    ]);
    expect(
      await relatedTests(root, suite, ['src/util/index.js', 'test/unrelated.test.js'], tests),
    ).toEqual(['test/fmt.test.js', 'test/unrelated.test.js']);

    const py = makeProject({
      'shop/cart.py': '',
      'tests/test_checkout.py': 'from shop.cart import total\n',
      'tests/test_other.py': 'import shop.orders\n',
      'tests/test_pkg.py': 'from shop import cart, orders\n',
    });
    const pySuite: Suite = { ...suite, framework: 'pytest', runner: ['pytest'] };
    expect(
      await relatedTests(py, pySuite, ['shop/cart.py'], await listTestFiles(py, pySuite)),
    ).toEqual(['tests/test_checkout.py', 'tests/test_pkg.py']);
  });

  it('builds each runner’s command with its machine-readable report', () => {
    const base = { missing: null, coverage: { available: true, note: null } };
    const sel = {
      scope: 'changed' as const,
      targets: ['src/cart.ts'],
      nameFilter: null,
      coverage: true,
    };
    expect(
      buildArgv(
        { ...base, dir: 'web', framework: 'vitest', runner: ['../node_modules/.bin/vitest'] },
        sel,
        '/o',
        'results',
      ),
    ).toEqual([
      '../node_modules/.bin/vitest',
      'related',
      '--run',
      '--passWithNoTests',
      'src/cart.ts',
      '--reporter=default',
      '--reporter=json',
      '--outputFile.json=/o/results.json',
      '--coverage.enabled=true',
      '--coverage.reporter=lcov',
      '--coverage.reportsDirectory=/o/coverage',
    ]);
    expect(
      buildArgv(
        { ...base, dir: '.', framework: 'jest', runner: ['node_modules/.bin/jest'] },
        { ...sel, coverage: false, nameFilter: 'adds' },
        '/o',
        'results',
      ),
    ).toEqual([
      'node_modules/.bin/jest',
      '--ci',
      '--json',
      '--outputFile=/o/results.json',
      '--testLocationInResults',
      '--testNamePattern=adds',
      '--passWithNoTests',
      '--findRelatedTests',
      'src/cart.ts',
    ]);
    expect(
      buildArgv(
        { ...base, dir: '.', framework: 'pytest', runner: ['.venv/bin/pytest'] },
        { scope: 'all', targets: [], nameFilter: null, coverage: true },
        '/o',
        'results',
      ),
    ).toEqual([
      '.venv/bin/pytest',
      '-o',
      'junit_family=xunit1',
      '--junitxml=/o/results.xml',
      '--cov=.',
      '--cov-report=lcov:/o/lcov.info',
    ]);
    expect(
      buildArgv(
        { ...base, dir: '.', framework: 'go', runner: ['go', 'test'] },
        { scope: 'all', targets: [], nameFilter: '^(TestA)$', coverage: false },
        '/o',
        'retry',
      ),
    ).toEqual(['go', 'test', '-json', '-run=^(TestA)$', './...']);
  });

  it('measures coverage of the changed lines only', () => {
    const suite: Suite = {
      dir: '.',
      framework: 'node',
      runner: ['node'],
      missing: null,
      coverage: { available: true, note: null },
    };
    const hits = parseLcov('SF:cart.js\nDA:1,1\nDA:2,1\nDA:6,1\nDA:7,0\nDA:8,0\nend_of_record\n');
    const files = changedLineCoverage(
      hits,
      (n) => n,
      ['cart.js', 'cart.test.js', 'new.js', 'README.md'],
      {
        'cart.js': [
          [2, 2],
          [7, 9],
        ],
        'cart.test.js': [[1, 3]],
        'new.js': [[1, 4]],
        'README.md': [[1, 1]],
      },
      suite,
    );
    expect(files).toEqual([
      { file: 'cart.js', lines: 3, covered: 1, uncovered: [[7, 8]], notLoaded: false },
      { file: 'new.js', lines: 4, covered: 0, uncovered: [[1, 4]], notLoaded: true },
    ]);
  });
});

describe('run_tests with node --test', () => {
  it('runs the tests related to the change, then reports the first error at its location', async () => {
    const root = nodeProject();
    fs.writeFileSync(
      path.join(root, 'cart.js'),
      CART.replace('i.price * i.qty', 'i.price + i.qty'),
    );
    const { c, recorded } = ctx(root);
    const { proposal, out } = await approveAndRun(c, {});
    const d = proposal.details as Extract<ApprovalDetails, { kind: 'command' }>;
    expect(d.argv).toEqual([
      'node',
      '--test',
      '--test-reporter=spec',
      '--test-reporter-destination=stdout',
      '--test-reporter=junit',
      `--test-reporter-destination=${path.join(os.tmpdir(), `friday-tests-${c.callId}`)}/results.xml`,
      'cart.test.js',
    ]);
    expect(d.tests).toEqual({
      framework: 'node',
      suite: '.',
      scope: 'changed',
      changedFiles: ['cart.js'],
      testFiles: ['cart.test.js'],
      nameFilter: null,
      coverage: false,
      retryFailures: true,
    });
    expect(out.summary).toMatch(/^exit code 1: 1 failed, 1 passed \(/);
    expect(out.content).toContain('Failed tests re-run once');
    expect(out.content).toContain('1. cart.test.js › cart › adds');
    expect(out.content).toContain('   at cart.test.js:5');
    expect(out.content).toContain('5 !== 6');
    const run = recorded[0]!;
    expect(run).toMatchObject({
      status: 'failed',
      exitCode: 1,
      counts: { passed: 1, failed: 1, skipped: 0, flaky: 0 },
      failures: [
        { name: 'cart › adds', file: 'cart.test.js', at: { file: 'cart.test.js', line: 5 } },
      ],
    });
    // The report folder is gone; nothing was written to the project.
    expect(fs.existsSync(path.join(os.tmpdir(), `friday-tests-${c.callId}`))).toBe(false);
    expect(g(root, 'status', '--porcelain')).toBe('M cart.js');
  });

  it('reports coverage of the changed lines', async () => {
    const root = nodeProject();
    fs.writeFileSync(
      path.join(root, 'cart.js'),
      CART.replace(
        '  if (pct > 50) return t;',
        '  if (pct > 50) return t;\n  if (pct < 0) return 0;',
      ),
    );
    const { c, recorded } = ctx(root);
    const { out } = await approveAndRun(c, { coverage: true, retry_failures: false });
    expect(recorded[0]!.status).toBe('passed');
    expect(recorded[0]!.coverage).toEqual({
      available: true,
      note: null,
      files: [{ file: 'cart.js', lines: 1, covered: 0, uncovered: [[8, 8]], notLoaded: false }],
    });
    expect(out.content).toContain('- cart.js: 0/1 changed lines ran; never ran: 8');
  });

  it('tells flaky tests from broken ones, by re-running and from history on the same code', async () => {
    const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'friday-flaky-')), 'count');
    const flakyTest = [
      "import { test } from 'node:test';",
      "import fs from 'node:fs';",
      `const f = ${JSON.stringify(marker)};`,
      "const n = fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8')) : 0;",
      'fs.writeFileSync(f, String(n + 1));',
      "test('sometimes', () => { if (n % 2 === 0) throw new Error('unlucky ' + n); });",
      '',
    ].join('\n');
    const root = nodeProject({ 'cart.flaky.test.js': flakyTest });
    const s = testServices();
    const project = s.projects.create('shop', root);
    const repo = new TestRunRepo(s.db);
    const where = { projectId: project.id, sessionId: s.sessions.create('t', project.id).id };

    // Fails, then passes when re-run: flaky, and the run counts as passed.
    const first = ctx(root, repo, where);
    await approveAndRun(first.c, { scope: 'files', files: ['cart.flaky.test.js'] });
    expect(first.recorded[0]).toMatchObject({
      status: 'passed',
      exitCode: 1,
      counts: { failed: 0, flaky: 1 },
      flaky: [{ name: 'sometimes', evidence: 'passed_on_retry' }],
    });

    // Without re-running: it fails now (n = 2), after passing on the same code before.
    const second = ctx(root, repo, where);
    const { out } = await approveAndRun(second.c, {
      scope: 'files',
      files: ['cart.flaky.test.js'],
      retry_failures: false,
    });
    expect(second.recorded[0]!.flaky).toEqual([
      expect.objectContaining({ name: 'sometimes', evidence: 'mixed_on_same_code' }),
    ]);
    expect(second.recorded[0]!.failures[0]).toMatchObject({ name: 'sometimes', failedBefore: 1 });
    expect(out.content).toContain('also failed in 1 earlier run');
    fs.rmSync(path.dirname(marker), { recursive: true, force: true });
  });

  it('refuses what it cannot run, with the reason', async () => {
    const root = nodeProject();
    const { c } = ctx(root);
    const prep = (args: Record<string, unknown>) =>
      runTests.prepare!(runTests.schema.parse({ reason: 'check', ...args }), c);
    await expect(prep({})).rejects.toThrow(/No uncommitted changes/);
    fs.writeFileSync(path.join(root, 'README.md'), '# x\n');
    fs.writeFileSync(path.join(root, 'lonely.js'), 'export const x = 1;\n');
    await expect(prep({})).rejects.toThrow(
      /No tests relate to the changed files \(README\.md, lonely\.js\)/,
    );
    await expect(prep({ scope: 'files' })).rejects.toThrow(/needs `files`/);
    // A name filter can't smuggle in a runner option.
    expect(() => runTests.schema.parse({ reason: 'check', name_filter: '--config=x.js' })).toThrow(
      /must not start with/,
    );
    await expect(prep({ scope: 'files', files: ['../x.test.js'] })).rejects.toThrow();
    await expect(prep({ suite: 'nope' })).rejects.toThrow(/No test suite in "nope"/);
    // A folder inside a suite means that suite.
    fs.mkdirSync(path.join(root, 'test'));
    await expect(prep({ suite: 'test/', scope: 'all' })).resolves.toBeTruthy();
    await expect(prep({ scope: 'all', coverage: true })).resolves.toBeTruthy();

    const none = makeProject({ 'a.txt': '' });
    await expect(
      runTests.prepare!(runTests.schema.parse({ reason: 'check' }), ctx(none).c),
    ).rejects.toThrow(/No test suite found/);
  });
});

describe('run_tests with vitest', () => {
  it('lets vitest pick the related tests and reads its JSON report', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ type: 'module', devDependencies: { vitest: '*' } }),
      'src/cart.ts':
        'export const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0);\nexport function boom(): number {\n  return 1;\n}\n',
      'src/cart.test.ts':
        "import { expect, it } from 'vitest';\nimport { boom, total } from './cart';\nit('adds', () => expect(total([1, 2])).toBe(3));\nit('booms', () => expect(boom()).toBe(1));\n",
      'src/other.test.ts': "import { it } from 'vitest';\nit('other', () => {});\n",
    });
    fs.symlinkSync(FRIDAY_MODULES, path.join(root, 'node_modules'));
    fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules\n');
    commitAll(root);
    fs.writeFileSync(
      path.join(root, 'src/cart.ts'),
      "export const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0);\nexport function boom(): number {\n  throw new Error('boom inside source');\n}\n",
    );
    const { c, recorded } = ctx(root);
    const { proposal, out } = await approveAndRun(c, { retry_failures: false });
    const d = proposal.details as Extract<ApprovalDetails, { kind: 'command' }>;
    expect(d.argv!.slice(0, 5)).toEqual([
      'node_modules/.bin/vitest',
      'related',
      '--run',
      '--passWithNoTests',
      'src/cart.ts',
    ]);
    expect(recorded[0]).toMatchObject({
      framework: 'vitest',
      status: 'failed',
      counts: { passed: 1, failed: 1 },
      failures: [
        {
          name: 'booms',
          file: 'src/cart.test.ts',
          message: 'Error: boom inside source',
          at: { file: 'src/cart.ts', line: 3 },
        },
      ],
    });
    expect(out.content).not.toContain('other');
  }, 30_000);
});

describe('test runs in a conversation', () => {
  it('shows the run live after approval, keeps it with the conversation and counts as verification', async () => {
    const root = nodeProject();
    const provider = new ScriptedProvider();
    const s = testServices({ provider });
    const project = s.projects.create('shop', root);
    provider.streamSteps.push(
      {
        toolCalls: [
          call(
            'edit_file',
            {
              path: 'cart.js',
              edits: [
                { old_text: '  return t;\n}\nexport', new_text: '  return t + 0;\n}\nexport' },
              ],
              reason: 'tidy',
            },
            'e1',
          ),
        ],
      },
      { toolCalls: [call('run_tests', { reason: 'check the change' }, 't1')] },
      { chunks: ['Tests pass.'] },
    );
    const session = s.sessions.create('Tests', project.id);
    const { run } = s.runManager.startMessage(session.id, 'tidy and test');
    const events: RunEvent[] = [];
    const onEvent = (e: RunEvent) => {
      events.push(e);
      if (e.type === 'approval_requested')
        setTimeout(() => {
          s.approvals.decide(e.approval.id, {
            decision: 'approve',
            actionHash: e.approval.actionHash,
            sessionId: session.id,
          });
        }, 5);
    };
    const sub = s.runManager.subscribe(run.id, 0, onEvent);
    sub?.replay.forEach(onEvent);
    await s.runManager.waitFor(run.id);

    const live = events.find((e) => e.type === 'test_run') as Extract<
      RunEvent,
      { type: 'test_run' }
    >;
    expect(live.testRun).toMatchObject({
      toolCallId: 't1',
      projectId: project.id,
      status: 'passed',
      counts: { passed: 2, failed: 0 },
    });
    const finished = s.runs.get(run.id)!;
    expect(finished.report?.status).toBe('verified');

    const app = await buildApp(s);
    const detail = (
      await app.inject({
        method: 'GET',
        url: `/api/sessions/${session.id}`,
        headers: { host: '127.0.0.1:4317' },
      })
    ).json();
    expect(detail.testRuns).toHaveLength(1);
    await app.close();
  });
});
