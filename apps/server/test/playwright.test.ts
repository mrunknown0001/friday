import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type { TestRunDto } from '@friday/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { dockerRunArgs } from '../src/sandbox/docker.js';
import { Redactor } from '../src/security/redact.js';
import { parsePlaywrightJson } from '../src/testing/results.js';
import { detectSuites, readPlaywrightConfig, suiteFor } from '../src/testing/suites.js';
import { playwrightProblem, runTests } from '../src/tools/testTools.js';
import type { ToolContext, ToolImage } from '../src/tools/types.js';
import { detectToolEnvironment } from '../src/workspace/environment.js';
import { cleanupProjects, makeProject } from './helpers.js';

afterEach(cleanupProjects);
const env = await detectToolEnvironment();

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

/** A small valid PNG (solid colour). */
function png(width: number, height: number): Buffer {
  const CRC = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = CRC[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(width * 3 + 1, 200);
  row[0] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * A stand-in for `playwright test`: records how it was called, then writes what Playwright
 * writes: a json report where PLAYWRIGHT_JSON_OUTPUT_FILE says, and a failure's screenshot,
 * trace and page snapshot under test-results/.
 */
const FAKE_PLAYWRIGHT = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const cwd = process.cwd();
fs.writeFileSync(path.join(cwd, 'calls.log'), JSON.stringify({ argv: process.argv.slice(2), out: process.env.PLAYWRIGHT_JSON_OUTPUT_FILE, ci: process.env.CI }) + '\\n', { flag: 'a' });
if (fs.existsSync(path.join(cwd, 'launch-fails'))) {
  const msg = "browserType.launch: Executable doesn't exist at /home/u/.cache/ms-playwright/chromium-1243/chrome";
  console.log(msg + '\\n  Please run the following command to download new browsers: npx playwright install');
  fs.writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_FILE, JSON.stringify({ config: { rootDir: path.join(cwd, 'e2e') },
    suites: [{ title: 'cart.spec.ts', file: 'cart.spec.ts', specs: [{ title: 'adds green tea', file: 'cart.spec.ts', line: 3,
      tests: [{ projectName: '', status: 'unexpected', results: [{ status: 'failed', duration: 5, error: { message: msg } }] }] }] }], errors: [] }));
  process.exit(1);
}
const dir = path.join(cwd, 'test-results', 'cart-adds-green-tea');
fs.mkdirSync(dir, { recursive: true });
fs.copyFileSync(path.join(cwd, 'fixture.png'), path.join(dir, 'test-failed-1.png'));
fs.writeFileSync(path.join(dir, 'trace.zip'), 'zip');
fs.writeFileSync(path.join(dir, 'error-context.md'), '# Instructions\\n\\n- Following Playwright test failed.\\n- Explain why, be concise.\\n\\n# Error details\\n\\n\\x60\\x60\\x60\\nError: failed\\n\\x60\\x60\\x60\\n\\n# Page snapshot\\n\\n\\x60\\x60\\x60yaml\\n- listitem: Coffee beans × 1\\n\\x60\\x60\\x60\\n');
const att = (name, contentType, file) => ({ name, contentType, path: path.join(dir, file) });
const rootDir = path.join(cwd, 'e2e');
const report = {
  config: { rootDir },
  suites: [
    { title: 'cart.spec.ts', file: 'cart.spec.ts', specs: [{ title: 'adds green tea', file: 'cart.spec.ts', line: 3,
      tests: [{ projectName: '', status: 'unexpected', results: [{ status: 'failed', duration: 3500, retry: 0,
        error: { message: '\\u001b[31mError: expect(locator).toContainText(expected) failed\\u001b[39m\\n\\nExpected substring: "Green tea"', stack: 'Error: x\\n    at ' + rootDir + '/cart.spec.ts:10:44', location: { file: rootDir + '/cart.spec.ts', line: 10 } },
        attachments: [att('screenshot', 'image/png', 'test-failed-1.png'), att('error-context', 'text/markdown', 'error-context.md'), att('trace', 'application/zip', 'trace.zip')] }] }] }] },
    { title: 'login.spec.ts', file: 'login.spec.ts', specs: [], suites: [{ title: 'sign in', file: 'login.spec.ts', specs: [
      { title: 'works', file: 'login.spec.ts', line: 5, tests: [{ projectName: '', status: 'flaky', results: [
        { status: 'failed', duration: 900, retry: 0, error: { message: 'Timeout' }, attachments: [] },
        { status: 'passed', duration: 400, retry: 1, attachments: [] }] }] },
      { title: 'later', file: 'login.spec.ts', line: 9, tests: [{ projectName: '', status: 'skipped', results: [] }] }] }] },
  ],
  errors: [],
};
fs.writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_FILE, JSON.stringify(report));
console.log('  1 failed\\n  1 flaky\\n  1 skipped');
process.exit(1);
`;

function e2eProject(extra: Record<string, string> = {}) {
  const root = makeProject({
    'package.json': JSON.stringify({
      type: 'module',
      scripts: { test: 'node --test', 'test:e2e': 'playwright test' },
      devDependencies: { '@playwright/test': '1.63.0' },
    }),
    'playwright.config.ts': [
      "import { defineConfig } from '@playwright/test';",
      'export default defineConfig({',
      "  testDir: './e2e',",
      "  webServer: { command: 'npm run dev', url: 'http://localhost:5173' },",
      '});',
    ].join('\n'),
    'src/cart.js': 'export const total = (xs) => xs.length;\n',
    'src/cart.test.js': "import { test } from 'node:test';\ntest('t', () => {});\n",
    'e2e/cart.spec.ts':
      "import { test } from '@playwright/test';\ntest('adds green tea', () => {});\n",
    'e2e/login.spec.ts': "import { test } from '@playwright/test';\ntest('works', () => {});\n",
    'node_modules/.bin/playwright': FAKE_PLAYWRIGHT,
    'node_modules/@playwright/test/package.json': JSON.stringify({ version: '1.63.0' }),
    '.gitignore': 'node_modules\ntest-results\ncalls.log\n',
    ...extra,
  });
  fs.chmodSync(path.join(root, 'node_modules/.bin/playwright'), 0o755);
  fs.writeFileSync(path.join(root, 'fixture.png'), png(64, 48));
  commitAll(root);
  return root;
}

function ctx(root: string) {
  const recorded: TestRunDto[] = [];
  const stored: ToolImage[] = [];
  const c: ToolContext = {
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
    callId: `call_${Math.random().toString(36).slice(2, 8)}`,
    signal: new AbortController().signal,
    redactor: new Redactor(),
    env,
    maxOutputChars: 40_000,
    setPlan: () => undefined,
    captures: {
      latest: () => null,
      image: () => null,
      store: (img) => {
        stored.push(img);
        return `att-${stored.length}`;
      },
      record: () => 'cap',
    },
    tests: {
      history: () => [],
      record: (dto) => {
        const saved = {
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
  return { c, recorded, stored };
}

async function approveAndRun(c: ToolContext, args: Record<string, unknown>) {
  const parsed = runTests.schema.parse({ reason: 'check the flow', ...args });
  const proposal = await runTests.prepare!(parsed, c);
  const out = await proposal.apply(c);
  return { proposal, out };
}

describe('finding Playwright suites', () => {
  it('reads testDir and webServer from the config without running it', () => {
    expect(
      readPlaywrightConfig(
        "export default defineConfig({ testDir: './tests/e2e/', webServer: [{ command: 'pnpm dev', port: 3000 }] })",
      ),
    ).toEqual({ testDir: 'tests/e2e', webServer: 'pnpm dev' });
    expect(readPlaywrightConfig('export default {}')).toEqual({ testDir: '.', webServer: null });
  });

  it('finds Playwright beside the unit tests, and says when it is not installed', async () => {
    const root = e2eProject();
    const suites = await detectSuites(root);
    expect(suites.map((s) => [s.dir, s.framework, s.runner, s.missing])).toEqual([
      ['.', 'node', ['node'], null],
      ['.', 'playwright', ['node_modules/.bin/playwright', 'test'], null],
    ]);
    expect(suites[1]!.playwright).toEqual({
      config: 'playwright.config.ts',
      testDir: 'e2e',
      webServer: 'npm run dev',
      version: '1.63.0',
    });
    // Specs belong to Playwright, other files to the unit-test suite.
    expect(suiteFor(suites, 'e2e/cart.spec.ts')?.framework).toBe('playwright');
    expect(suiteFor(suites, 'src/cart.test.js')?.framework).toBe('node');

    fs.rmSync(path.join(root, 'node_modules'), { recursive: true });
    const [, missing] = await detectSuites(root);
    expect(missing!.missing).toMatch(/@playwright\/test is not installed/);
  });
});

describe('Playwright results', () => {
  it('names tests by describe block and project, and keeps flaky and skipped apart', () => {
    const r = parsePlaywrightJson(
      JSON.stringify({
        config: { rootDir: '/p/e2e' },
        suites: [
          {
            title: 'a.spec.ts',
            file: 'a.spec.ts',
            suites: [
              {
                title: 'cart',
                specs: [
                  {
                    title: 'adds',
                    file: 'a.spec.ts',
                    line: 4,
                    tests: [
                      {
                        projectName: 'chromium',
                        status: 'expected',
                        results: [{ status: 'passed', duration: 12 }],
                      },
                      {
                        projectName: 'firefox',
                        status: 'unexpected',
                        results: [{ status: 'timedOut', duration: 30000, attachments: [] }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
        errors: [{ message: 'Error: No tests found', location: { file: 'b.spec.ts' } }],
      }),
    );
    expect(r.cases.map((c) => [c.file, c.name, c.status, c.error, c.line])).toEqual([
      ['/p/e2e/a.spec.ts', 'cart › adds [chromium]', 'passed', null, 4],
      ['/p/e2e/a.spec.ts', 'cart › adds [firefox]', 'failed', 'Test timed out.', 4],
    ]);
    expect(r.fileErrors).toEqual([{ file: '/p/e2e/b.spec.ts', error: 'Error: No tests found' }]);
  });
});

describe('run_tests with Playwright', () => {
  it('runs the specs with its JSON reporter and retries, and shows the failure with its screenshot', async () => {
    const root = e2eProject();
    const { c, recorded, stored } = ctx(root);
    const { proposal, out } = await approveAndRun(c, { framework: 'playwright', scope: 'all' });
    const d = proposal.details;
    if (d.kind !== 'command') throw new Error('not a command');
    expect(d.argv).toEqual([
      'node_modules/.bin/playwright',
      'test',
      '--reporter=list,json',
      '--retries=1',
    ]);
    expect(d.env).toContain('PLAYWRIGHT_JSON_OUTPUT_FILE');
    expect(d.tests).toMatchObject({ framework: 'playwright', webServer: 'npm run dev' });
    const call = JSON.parse(fs.readFileSync(path.join(root, 'calls.log'), 'utf8').trim());
    expect(call.out).toMatch(/friday-tests-.*\/results\.json$/);
    expect(call.ci).toBe('1');

    const run = recorded[0]!;
    expect(run).toMatchObject({
      framework: 'playwright',
      status: 'failed',
      counts: { passed: 0, failed: 1, flaky: 1, skipped: 1 },
    });
    expect(run.failures).toEqual([
      {
        name: 'adds green tea',
        file: 'e2e/cart.spec.ts',
        message: expect.stringMatching(
          /^Error: expect\(locator\)\.toContainText\(expected\) failed/,
        ),
        at: { file: 'e2e/cart.spec.ts', line: 10 },
        failedBefore: 0,
        artifacts: {
          screenshotId: 'att-1',
          trace: 'test-results/cart-adds-green-tea/trace.zip',
          video: null,
        },
      },
    ]);
    expect(run.flaky).toEqual([
      expect.objectContaining({
        name: 'sign in › works',
        file: 'e2e/login.spec.ts',
        evidence: 'passed_on_retry',
      }),
    ]);
    // The model sees the first failure's screenshot and the page as Playwright saw it.
    expect(out.images?.map((i) => i.attachmentId)).toEqual(['att-1']);
    expect(stored).toHaveLength(1);
    expect(out.content).toContain(
      'saved: screenshot (follows); trace test-results/cart-adds-green-tea/trace.zip (npx playwright show-trace test-results/cart-adds-green-tea/trace.zip)',
    );
    expect(out.content).toContain('- listitem: Coffee beans × 1');
    // Only the snapshot: not the instructions Playwright writes for AI assistants.
    expect(out.content).not.toContain('Explain why');
  });

  it('runs unit tests unless asked for Playwright, and picks specs related to the changes', async () => {
    const root = e2eProject();
    const { c } = ctx(root);
    const unit = runTests.schema.parse({ reason: 'unit', scope: 'all' });
    const p = await runTests.prepare!(unit, c);
    expect(p.details.kind === 'command' && p.details.tests?.framework).toBe('node');

    const e2e = () =>
      runTests.prepare!(runTests.schema.parse({ reason: 'e2e', framework: 'playwright' }), c);
    fs.writeFileSync(path.join(root, 'src/totals.js'), 'export const sum = 1;\n');
    await expect(e2e()).rejects.toThrow(
      /No Playwright spec relates to the changed files \(src\/totals\.js\).*scope "files"/,
    );

    // A spec named after a changed file is related.
    fs.writeFileSync(
      path.join(root, 'src/cart.js'),
      'export const total = (xs) => xs.length + 0;\n',
    );
    const related = await e2e();
    expect(related.details.kind === 'command' && related.details.argv).toEqual([
      'node_modules/.bin/playwright',
      'test',
      '--reporter=list,json',
      '--retries=1',
      'e2e/cart.spec.ts',
    ]);
  });

  it('reports a run that could not start a browser as an error, with what to do', async () => {
    const root = e2eProject({ 'launch-fails': '' });
    const { c, recorded } = ctx(root);
    const { out } = await approveAndRun(c, { framework: 'playwright', scope: 'all' });
    expect(recorded[0]).toMatchObject({
      status: 'error',
      error:
        "Playwright's browsers are not installed. Friday does not install them; the user can run `npx playwright install` in the project root.",
    });
    expect(out.summary).toBe("could not run: Playwright's browsers are not installed");
  });

  it('explains missing browsers and a busy web server port, and never installs anything', () => {
    const suite = {
      dir: 'web',
      framework: 'playwright' as const,
      runner: [],
      missing: null,
      coverage: { available: false, note: null },
      playwright: {
        config: 'playwright.config.ts',
        testDir: 'e2e',
        webServer: 'npm run dev',
        version: '1.63.0',
      },
    };
    const browsers = "browserType.launch: Executable doesn't exist at /tmp/x/chrome";
    expect(playwrightProblem(browsers, suite, false)).toMatch(
      /run `npx playwright install` in web\./,
    );
    expect(playwrightProblem(browsers, suite, true)).toMatch(
      /mcr\.microsoft\.com\/playwright:v1\.63\.0-noble/,
    );
    expect(
      playwrightProblem(
        'Error: http://localhost:5173 is already used, make sure that nothing is running on the port/url or set reuseExistingServer:true',
        suite,
        false,
      ),
    ).toMatch(/stop the background process using it \(stop_process\)/);
    expect(playwrightProblem('1 passed', suite, false)).toBeNull();
  });

  it('passes the report location into the sandbox as a fixed variable', () => {
    const args = dockerRunArgs({
      root: '/p',
      cwdRel: '.',
      settings: {
        enabled: true,
        image: 'mcr.microsoft.com/playwright:v1.63.0-noble',
        network: 'none',
      },
      argv: ['node_modules/.bin/playwright', 'test'],
      shellCommand: null,
      masks: { files: [], dirs: [], truncated: false },
      gitDir: false,
      instance: 'i',
      name: 'n',
      uid: 1000,
      gid: 1000,
      env: { PLAYWRIGHT_JSON_OUTPUT_FILE: '/friday-out/results.json' },
    });
    expect(args.join(' ')).toContain('--env PLAYWRIGHT_JSON_OUTPUT_FILE=/friday-out/results.json');
  });
});
