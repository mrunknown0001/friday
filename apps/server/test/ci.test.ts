import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanLog, firstFailure, relativizeRunnerPaths } from '../src/ci/logs.js';
import { Redactor } from '../src/security/redact.js';
import { executeToolCall, ToolRegistry } from '../src/tools/registry.js';
import type { ToolContext } from '../src/tools/types.js';
import { detectToolEnvironment } from '../src/workspace/environment.js';
import { call, cleanupProjects, makeProject } from './helpers.js';

afterEach(cleanupProjects);

const T = (s: string) => `2026-10-30T07:10:24.9782122Z ${s}`;
const log = (lines: string[]) => `\uFEFF${lines.map(T).join('\n')}\n`;

const VITEST_LOG = log([
  "Current runner version: '2.338.0'",
  '##[group]Run actions/checkout@v4',
  'Syncing repository',
  '##[endgroup]',
  '##[group]Run npm test',
  '\u001b[36;1mnpm test\u001b[0m',
  '\u001b[36;1mecho "Error: this is only the script being echoed"\u001b[0m',
  'shell: /usr/bin/bash -e {0}',
  '##[endgroup]',
  '> shop@1.0.0 test',
  '> vitest run',
  ' \u001b[31m❯\u001b[39m test/cart.test.ts (2 tests | 1 failed) 12ms',
  '\u001b[31m   ×\u001b[39m cartTotal sums every item 5ms',
  '',
  ' FAIL  test/cart.test.ts > cartTotal sums every item',
  'AssertionError: expected 3 to be 5 // Object.is equality',
  ' ❯ /home/runner/work/shop/shop/src/cart.ts:3:5',
  ' ❯ test/cart.test.ts:6:22',
  ' ❯ packages/api/src/server.ts:10:1',
  ' ❯ test/widget.test.ts:9:3',
  '##[error]Process completed with exit code 1.',
  '##[group]Run actions/upload-artifact@v4',
  'Error: this later step must not be picked',
  '##[endgroup]',
]);

describe('CI log reading', () => {
  it('finds the first real error in the failing step, not the script echo or exit code', () => {
    const f = firstFailure(VITEST_LOG)!;
    expect(f.step).toBe('npm test');
    expect(f.specific).toBe(true);
    // Starts a few lines before the first error, and stops at the exit code line.
    expect(f.excerpt[0]).toBe('> shop@1.0.0 test');
    expect(f.excerpt).toContain('   × cartTotal sums every item 5ms');
    expect(f.excerpt).toContain('AssertionError: expected 3 to be 5 // Object.is equality');
    expect(f.excerpt.join('\n')).not.toMatch(/only the script|later step|Process completed/);
    expect(f.errors).toEqual([]);
  });

  it('recognizes compiler and linter errors, and falls back to the end of the step', () => {
    const tsc = firstFailure(
      log([
        '##[group]Run npx tsc --noEmit',
        'npx tsc --noEmit',
        '##[endgroup]',
        "src/cart.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.",
        '##[error]Process completed with exit code 2.',
      ]),
    )!;
    expect(tsc.excerpt).toEqual([
      "src/cart.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.",
    ]);

    const eslint = firstFailure(
      log([
        '##[group]Run npm run lint',
        '##[endgroup]',
        '/home/runner/work/shop/shop/src/a.ts',
        "  4:7  error  'x' is assigned a value but never used  no-unused-vars",
        '##[error]src/a.ts#L4 x is unused',
        '##[error]Process completed with exit code 1.',
      ]),
    )!;
    expect(eslint.specific).toBe(true);
    expect(eslint.excerpt[0]).toBe('/home/runner/work/shop/shop/src/a.ts');
    expect(eslint.errors).toEqual(['src/a.ts#L4 x is unused']);

    const vague = firstFailure(
      log([
        '##[group]Run ./deploy.sh',
        '##[endgroup]',
        'step one',
        'step two',
        '##[error]Process completed with exit code 3.',
      ]),
    )!;
    expect(vague).toMatchObject({ specific: false, excerpt: ['step one', 'step two'] });

    expect(firstFailure(log(['##[group]Run npm test', 'all good']))).toBeNull();
  });

  it('cleans timestamps and colours, and maps runner paths to the project', () => {
    expect(cleanLog(T('\u001b[31mred\u001b[39m'))).toEqual(['red']);
    expect(relativizeRunnerPaths('at /home/runner/work/shop/shop/src/a.ts:1')).toBe(
      'at src/a.ts:1',
    );
    expect(relativizeRunnerPaths('D:\\a\\shop\\shop\\src\\a.ts')).toBe('src\\a.ts');
    expect(relativizeRunnerPaths('/__w/shop/shop/x.py:2')).toBe('x.py:2');
  });
});

// ------------------------------------------------------------------ tools, with a stand-in gh

const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'friday-ci-gh-'));
const responses = path.join(fake, 'responses');
const callLog = path.join(fake, 'calls.log');

beforeAll(() => {
  fs.mkdirSync(responses);
  fs.writeFileSync(
    path.join(fake, 'gh'),
    `#!/bin/sh
echo "$@" >> ${callLog}
[ "$1 $2" = "auth status" ] && exit 0
[ "$1" = "api" ] || exit 2
f="${responses}/$(printf '%s' "$6" | tr '/?&=' '____')"
[ -f "$f" ] && { cat "$f"; exit 0; }
echo "gh: Not Found (HTTP 404)" >&2
exit 1
`,
    { mode: 0o755 },
  );
  process.env.FRIDAY_GH = path.join(fake, 'gh');
});
afterAll(() => {
  delete process.env.FRIDAY_GH;
  fs.rmSync(fake, { recursive: true, force: true });
});
afterEach(() => {
  for (const f of fs.readdirSync(responses)) fs.rmSync(path.join(responses, f));
  fs.rmSync(callLog, { force: true });
});

const respond = (apiPath: string, body: unknown) =>
  fs.writeFileSync(
    path.join(responses, apiPath.replace(/[/?&=]/g, '_')),
    typeof body === 'string' ? body : JSON.stringify(body),
  );

const env = await detectToolEnvironment();
const registry = new ToolRegistry();

function repo(): { root: string; head: string } {
  const root = makeProject({
    'src/cart.ts': 'a\nb\nc\nd\n',
    'test/cart.test.ts': 'x\n'.repeat(8),
    'packages/web/test/widget.test.ts': 'w\n'.repeat(12),
  });
  const g = (...a: string[]) =>
    execFileSync('git', a, {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
    });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'f@test');
  g('config', 'user.name', 'F');
  g('add', '-A');
  g('commit', '-q', '-m', 'init');
  g('remote', 'add', 'origin', 'https://github.com/o/shop.git');
  return { root, head: g('rev-parse', 'HEAD').trim() };
}

function ctx(root: string): ToolContext {
  return {
    project: {
      id: 'p',
      name: 'shop',
      rootPath: root,
      createdAt: '',
      lastOpenedAt: null,
      sandbox: null,
    },
    sessionId: 's',
    runId: 'r',
    signal: new AbortController().signal,
    redactor: new Redactor(),
    env,
    maxOutputChars: 20_000,
    setPlan: () => undefined,
  };
}
const run = (root: string, name: string, args: unknown) =>
  executeToolCall(registry, call(name, args), ctx(root), { timeoutMs: 20_000 });

const RUN = (head: string, over: Record<string, unknown> = {}) => ({
  id: 77,
  name: 'CI',
  display_title: 'Fix the cart',
  head_branch: 'main',
  head_sha: head,
  status: 'completed',
  conclusion: 'failure',
  event: 'push',
  created_at: '2026-10-30T07:07:13Z',
  html_url: 'https://github.com/o/shop/actions/runs/77',
  ...over,
});

describe('ci_runs and ci_failure', () => {
  it('lists runs for the current branch and marks the one that tested HEAD', async () => {
    const { root, head } = repo();
    respond('repos/o/shop/actions/runs?per_page=10&branch=main', {
      workflow_runs: [RUN(head), RUN('a'.repeat(40), { id: 76, conclusion: 'success' })],
    });
    const r = await run(root, 'ci_runs', {});
    expect(r.status).toBe('completed');
    expect(r.content).toContain('GitHub Actions runs for o/shop on main');
    expect(r.content).toContain(
      `#77 failure · CI · "Fix the cart" · main @ ${head.slice(0, 7)} (your HEAD) · push`,
    );
    expect(r.content).toContain('#76 success');
    expect(r.summary).toBe('2 runs, 1 failed');
    // Only GET requests, ever.
    expect(fs.readFileSync(callLog, 'utf8')).toMatch(
      /^auth status --hostname github.com\napi --hostname github.com --method GET /,
    );
  });

  it('explains the latest failure and points at the project files', async () => {
    const { root, head } = repo();
    respond('repos/o/shop/actions/runs?per_page=1&status=failure&branch=main', {
      workflow_runs: [RUN(head)],
    });
    respond('repos/o/shop/actions/runs/77/jobs?filter=latest&per_page=100', {
      jobs: [
        {
          id: 9,
          name: 'test (node 22)',
          conclusion: 'failure',
          steps: [{ number: 4, name: 'Run tests', conclusion: 'failure' }],
        },
        { id: 10, name: 'lint', conclusion: 'success', steps: [] },
      ],
    });
    respond('repos/o/shop/actions/jobs/9/logs', VITEST_LOG);
    respond('repos/o/shop/check-runs/9/annotations', [
      {
        path: '.github',
        start_line: 1,
        annotation_level: 'failure',
        title: '',
        message: 'Process completed with exit code 1.',
      },
      {
        path: 'src/cart.ts',
        start_line: 3,
        annotation_level: 'failure',
        title: 'cart',
        message: 'expected 3 to be 5',
      },
    ]);
    const r = await run(root, 'ci_failure', {});
    expect(r.status).toBe('completed');
    expect(r.content).toContain('The run tested exactly your current commit.');
    expect(r.content).toContain(
      'Failed jobs (1 of 2):\n- test (node 22): step 4 "Run tests" (failure)',
    );
    expect(r.content).toContain('First error (`npm test`):');
    expect(r.content).toContain('AssertionError: expected 3 to be 5');
    expect(r.content).toContain(' ❯ src/cart.ts:3:5'); // runner path made relative
    expect(r.content).toContain('Annotations:\n- src/cart.ts:3 failure: cart: expected 3 to be 5');
    expect(r.content).not.toContain('Process completed');
    expect(r.content).toContain(
      'Project files in the error: src/cart.ts:3:5, test/cart.test.ts:6:22',
    );
    expect(r.content).toContain(
      'Paths relative to a package folder, matched to project files:\n- test/widget.test.ts:9 → packages/web/test/widget.test.ts:9',
    );
    expect(r.content).toContain(
      'Also mentioned, not found in the project: packages/api/src/server.ts:10',
    );
    expect(r.summary).toBe('run 77 failed: src/cart.ts, test/cart.test.ts');
  });

  it('says what it can when there is nothing to read', async () => {
    const { root, head } = repo();
    respond('repos/o/shop/actions/runs?per_page=1&status=failure&branch=main', {
      workflow_runs: [],
    });
    expect((await run(root, 'ci_failure', {})).content).toBe(
      'No failed GitHub Actions runs on main. Use ci_runs to see recent runs.',
    );

    respond('repos/o/shop/actions/runs/5', RUN('b'.repeat(40), { id: 5 }));
    respond('repos/o/shop/actions/runs/5/jobs?filter=latest&per_page=100', { jobs: [] });
    const noJobs = await run(root, 'ci_failure', { run_id: 5 });
    expect(noJobs.content).toContain('not in your local history');
    expect(noJobs.content).toContain('The run has no jobs');

    respond('repos/o/shop/actions/runs/6', RUN(head, { id: 6 }));
    respond('repos/o/shop/actions/runs/6/jobs?filter=latest&per_page=100', {
      jobs: [{ id: 11, name: 'build', conclusion: 'failure' }],
    });
    const expired = await run(root, 'ci_failure', { run_id: 6 });
    expect(expired.content).toContain('its log is no longer available');

    const missing = await run(root, 'ci_failure', { run_id: 404 });
    expect(missing.status).toBe('error');
    expect(missing.content).toContain('Run #404 was not found');
  });

  it('needs a GitHub remote', async () => {
    const { root } = repo();
    execFileSync('git', ['remote', 'set-url', 'origin', '/srv/git/shop.git'], { cwd: root });
    const r = await run(root, 'ci_runs', {});
    expect(r.status).toBe('error');
    expect(r.content).toContain('is not a GitHub repository URL');
  });
});
