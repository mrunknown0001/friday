import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { LoadTargetDto, LoadTestDto } from '@friday/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { buildScript, type LoadPlan } from '../src/loadtest/script.js';
import { parseSummary } from '../src/loadtest/summary.js';
import type { NewLoadTest } from '../src/repositories/loadTests.js';
import { Redactor } from '../src/security/redact.js';
import { runLoadTest } from '../src/tools/loadTestTools.js';
import type { ToolContext } from '../src/tools/types.js';
import { detectToolEnvironment } from '../src/workspace/environment.js';
import { testServices } from './helpers.js';

const env = await detectToolEnvironment();
const H = { host: '127.0.0.1:4317', 'x-friday-client': '1', 'content-type': 'application/json' };

const plan = (over: Partial<LoadPlan> = {}): LoadPlan => ({
  origin: 'http://localhost:5199',
  requests: [
    { name: 'home', method: 'GET', path: '/', headers: {}, body: null, expectStatus: null },
    {
      name: 'login',
      method: 'POST',
      path: '/api/login',
      headers: {},
      body: '{"email":"demo@flowshop.test"}',
      expectStatus: 200,
    },
  ],
  vus: 3,
  durationSeconds: 20,
  stages: null,
  thinkTimeMs: 500,
  thresholds: { p95Ms: 300, p99Ms: null, errorRate: 0.01, perRequestP95Ms: { home: 50 } },
  ...over,
});

describe('the generated k6 script', () => {
  it('calls only the origin, with the approved load, and never follows redirects', () => {
    const s = buildScript(plan());
    expect(s).toContain('const ORIGIN = "http://localhost:5199";');
    expect(s).toContain('"maxRedirects": 0');
    expect(s).toContain('"executor": "constant-vus",\n      "vus": 3,\n      "duration": "20s"');
    expect(s).toContain('"http_req_duration": [\n      "p(95)<300"');
    expect(s).toContain('"http_req_failed": [\n      "rate<0.01"');
    expect(s).toContain('"http_req_duration{name:home}": [\n      "p(95)<50"');
    expect(s).toContain('"http_reqs{name:login}": [\n      "count>=0"');
    // JSON bodies get a content type.
    expect(s).toContain('"Content-Type": "application/json"');
    const ramp = buildScript(
      plan({
        stages: [
          { durationSeconds: 10, targetVus: 5 },
          { durationSeconds: 5, targetVus: 0 },
        ],
      }),
    );
    expect(ramp).toContain('"executor": "ramping-vus"');
    expect(ramp).toContain('{\n          "duration": "10s",\n          "target": 5\n        }');
  });

  it('keeps every value from the plan a literal, never code', () => {
    const evil = "/x'); import fs from 'k6'; ('";
    const s = buildScript(
      plan({
        requests: [
          {
            name: 'x',
            method: 'GET',
            path: evil,
            headers: { 'X-A': '`${__ENV.HOME}`' },
            body: null,
            expectStatus: null,
          },
        ],
      }),
    );
    expect(s).toContain(JSON.stringify(evil));
    expect(s.match(/^import /gm)).toEqual(['import ', 'import ']);
  });
});

// The shape k6 2.3 hands to handleSummary (trimmed from a real run).
const SUMMARY = {
  metrics: {
    http_reqs: { type: 'counter', contains: 'default', values: { count: 126, rate: 39.94 } },
    http_req_failed: {
      type: 'rate',
      contains: 'default',
      values: { rate: 0.3333, passes: 42, fails: 84 },
      thresholds: { 'rate<0.01': { ok: false } },
    },
    http_req_duration: {
      type: 'trend',
      contains: 'time',
      values: {
        avg: 41.33,
        min: 0.19,
        med: 1.49,
        max: 122.7,
        'p(90)': 121.6,
        'p(95)': 121.9,
        'p(99)': 122.21,
      },
      thresholds: { 'p(95)<300': { ok: true } },
    },
    'http_req_duration{name:home}': {
      type: 'trend',
      contains: 'time',
      values: { avg: 1.77, 'p(95)': 4.99 },
      thresholds: { 'p(95)<50': { ok: true } },
    },
    'http_req_failed{name:home}': {
      type: 'rate',
      values: { rate: 0 },
      thresholds: { 'rate>=0': { ok: true } },
    },
    'http_reqs{name:home}': {
      type: 'counter',
      values: { count: 63 },
      thresholds: { 'count>=0': { ok: true } },
    },
    'http_req_duration{name:login}': {
      type: 'trend',
      contains: 'time',
      values: { avg: 80.9, 'p(95)': 121.0 },
      thresholds: { 'max>=0': { ok: true } },
    },
    vus_max: { type: 'gauge', values: { value: 3, min: 3, max: 3 } },
  },
  root_group: {
    checks: [
      { name: 'home: status 2xx or 3xx', passes: 63, fails: 0 },
      { name: 'login: status 200', passes: 21, fails: 42 },
      { name: 'status:home:200', passes: 63, fails: 0 },
      { name: 'status:login:200', passes: 21, fails: 0 },
      { name: 'status:login:401', passes: 42, fails: 0 },
      { name: 'body:login:401:{"error":"Wrong email or password"}', passes: 1, fails: 0 },
      { name: 'body:login:401:{"error":"Wrong email or password"}', passes: 1, fails: 0 },
    ],
  },
  state: { testRunDurationMs: 3154.6 },
};

describe('reading the k6 summary', () => {
  it('reports throughput, latency, errors and the thresholds the user asked for', () => {
    const r = parseSummary(SUMMARY, plan());
    expect(r).toMatchObject({
      requests: 126,
      rate: 39.94,
      failedRate: 0.3333,
      vusMax: 3,
      durationMs: 3155,
      latency: { avg: 41.3, med: 1.5, p90: 121.6, p95: 121.9, p99: 122.2, max: 122.7 },
      thresholdsFailed: true,
    });
    expect(r.thresholds).toEqual([
      { metric: 'http_req_failed', condition: 'rate<0.01', ok: false, actual: '33.33%' },
      { metric: 'http_req_duration', condition: 'p(95)<300', ok: true, actual: '121.9 ms' },
      { metric: 'http_req_duration{name:home}', condition: 'p(95)<50', ok: true, actual: '5 ms' },
    ]);
    expect(r.perRequest).toEqual([
      {
        name: 'home',
        count: 63,
        failedRate: 0,
        p95: 5,
        avg: 1.8,
        statuses: [{ status: 200, count: 63 }],
        errorSamples: [],
      },
      {
        name: 'login',
        count: 0,
        failedRate: 0,
        p95: 121,
        avg: 80.9,
        statuses: [
          { status: 401, count: 42 },
          { status: 200, count: 21 },
        ],
        errorSamples: [{ status: 401, body: '{"error":"Wrong email or password"}' }],
      },
    ]);
    // The status counters are not shown as checks.
    expect(r.checks.map((c) => c.name)).toEqual(['home: status 2xx or 3xx', 'login: status 200']);
  });
});

/** A stand-in k6: answers `version`, then writes SUMMARY where --env FRIDAY_SUMMARY says. */
function fakeK6(dir: string, exit = 99): string {
  const file = path.join(dir, 'k6');
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node
const fs = require('node:fs');
const a = process.argv.slice(2);
if (a[0] === 'version') { console.log('k6 v2.3.0 (fake)'); process.exit(0); }
fs.writeFileSync(${JSON.stringify(path.join(dir, 'calls.json'))}, JSON.stringify({ argv: a, script: fs.readFileSync(a.at(-1), 'utf8') }));
const out = a[a.indexOf('--env') + 1].split('=').slice(1).join('=');
fs.writeFileSync(out, ${JSON.stringify(JSON.stringify(SUMMARY))});
process.exit(${exit});
`,
  );
  fs.chmodSync(file, 0o755);
  return file;
}

function ctx(targets: LoadTargetDto[] = []) {
  const recorded: NewLoadTest[] = [];
  const c: ToolContext = {
    project: null,
    sessionId: 's',
    runId: 'r',
    callId: `call_${Math.random().toString(36).slice(2, 8)}`,
    signal: new AbortController().signal,
    redactor: new Redactor(),
    env,
    maxOutputChars: 40_000,
    setPlan: () => undefined,
    capture: { engine: null as never, fridayPort: () => 4317 },
    loadTargets: {
      byName: (n) => targets.find((t) => t.name.toLowerCase() === n.toLowerCase()) ?? null,
      byOrigin: (o) => targets.find((t) => t.origin === o) ?? null,
    },
    loadTests: {
      record: (r) => {
        recorded.push(r);
        return r as LoadTestDto;
      },
    },
  };
  return { c, recorded };
}

const staging: LoadTargetDto = {
  id: 't1',
  name: 'staging',
  origin: 'https://staging.example.test',
  environment: 'staging',
  maxVus: 20,
  maxDurationSeconds: 120,
  createdAt: '',
};
const prod: LoadTargetDto = {
  ...staging,
  id: 't2',
  name: 'prod',
  origin: 'https://shop.example.test',
  environment: 'production',
};

describe('run_load_test', () => {
  let dir: string;
  const saved = process.env.FRIDAY_K6;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'friday-k6-'));
    process.env.FRIDAY_K6 = fakeK6(dir);
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.FRIDAY_K6;
    else process.env.FRIDAY_K6 = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const prepare = (c: ToolContext, args: Record<string, unknown>) =>
    runLoadTest.prepare!(
      runLoadTest.schema.parse({ reason: 'how fast is it', requests: [{ path: '/' }], ...args }),
      c,
    );

  it('shows the script and load on the card, runs k6 on it, and records the result', async () => {
    const { c, recorded } = ctx();
    const p = await prepare(c, {
      target: 'localhost:5199',
      requests: [
        { path: '/', name: 'home' },
        { method: 'POST', path: '/api/login', body: '{"a":1}', expect_status: 200 },
      ],
      vus: 3,
      duration_seconds: 20,
      think_time_ms: 500,
      thresholds: { p95_ms: 300, error_rate: 0.01, per_request_p95_ms: { home: 50 } },
    });
    expect(p).toMatchObject({
      category: 'load_test',
      risk: 'medium',
      title: 'Load test: http://localhost:5199',
    });
    const d = p.details;
    if (d.kind !== 'load_test') throw new Error('kind');
    expect(d).toMatchObject({
      target: { name: null, origin: 'http://localhost:5199', environment: 'local' },
      vus: 3,
      durationSeconds: 20,
      thresholds: ['p(95) < 300 ms', 'failed requests < 1.00%', 'home: p(95) < 50 ms'],
      k6: expect.stringMatching(/^k6 v2\.3\.0/),
      limits: { maxVus: 100, maxDurationSeconds: 600 },
    });
    expect(d.requests.map((r) => [r.name, r.method, r.url])).toEqual([
      ['home', 'GET', 'http://localhost:5199/'],
      ['POST /api/login', 'POST', 'http://localhost:5199/api/login'],
    ]);
    expect(d.riskReasons).toEqual([
      'POST /api/login changes data on every iteration of every virtual user.',
    ]);

    const out = await p.apply(c);
    const call = JSON.parse(fs.readFileSync(path.join(dir, 'calls.json'), 'utf8'));
    expect(call.argv.slice(0, 6)).toEqual([
      'run',
      '--no-usage-report',
      '--address=',
      '--quiet',
      '--no-color',
      '--env',
    ]);
    expect(call.script).toBe(d.script);
    expect(recorded[0]).toMatchObject({ status: 'failed', requests: 126, failedRate: 0.3333 });
    expect(out.content).toContain('- FAILED: http_req_failed rate<0.01 (measured 33.33%)');
    expect(out.content).toContain('- login: status 200: 42 of 63 failed');
    expect(out.summary).toBe('failed: 126 requests, 39.94/s, p95 121.9 ms, 33.33% failed');
    // The script and summary were written outside any project and are gone.
    expect(fs.existsSync(path.dirname(call.argv.at(-1)))).toBe(false);
  });

  it('only targets this machine or listed hosts, within their limits', async () => {
    const { c } = ctx([staging, prod]);
    await expect(prepare(c, { target: 'https://example.com' })).rejects.toThrow(
      /https:\/\/example\.com is not a load-test target.*Settings → Load-test targets/,
    );
    await expect(prepare(c, { target: 'http://127.0.0.1:4317' })).rejects.toThrow(
      /Friday's own server/,
    );
    await expect(
      prepare(c, { target: 'localhost:5199', requests: [{ path: '//evil.test/' }] }),
    ).rejects.toThrow(/must start with one "\/"/);
    await expect(prepare(c, { target: 'localhost:5199', vus: 150 })).rejects.toThrow(
      /150 virtual users is more than http:\/\/localhost:5199 allows \(100/,
    );
    await expect(prepare(c, { target: 'staging', duration_seconds: 300 })).rejects.toThrow(
      /300s is longer than https:\/\/staging\.example\.test allows \(120s, set by Settings → Load-test targets \(staging\)\)/,
    );
    const byUrl = await prepare(c, { target: 'https://staging.example.test/any/page', vus: 10 });
    expect(byUrl).toMatchObject({ risk: 'high' });
    expect(byUrl.details.kind === 'load_test' && byUrl.details.riskReasons[0]).toBe(
      'Traffic goes over the network to https://staging.example.test (staging).',
    );
    const named = await prepare(c, {
      target: 'localhost:5199',
      requests: [
        { path: '/api/cart', name: 'cart (auth)' },
        { path: '/api/cart', name: 'cart (auth)' },
      ],
    });
    expect(named.details.kind === 'load_test' && named.details.requests.map((r) => r.name)).toEqual(
      ['cart auth', 'cart auth 2'],
    );
    const live = await prepare(c, { target: 'PROD', vus: 2, duration_seconds: 10 });
    expect(live).toMatchObject({ risk: 'critical', confirmationRequired: 'prod' });
  });

  it('says how to get k6 when it is missing, and installs nothing', async () => {
    process.env.FRIDAY_K6 = path.join(dir, 'missing-k6');
    const { c } = ctx();
    await expect(prepare(c, { target: 'localhost:5199' })).rejects.toThrow(
      /k6 is not installed\. Friday does not install it/,
    );
  });
});

describe('load-test target routes', () => {
  it('lets the user list hosts with limits, never this machine or credentials', async () => {
    const s = testServices();
    const app = await buildApp(s);
    const post = (payload: unknown) =>
      app.inject({
        method: 'POST',
        url: '/api/load-targets',
        headers: H,
        payload: JSON.stringify(payload),
      });
    const code = async (payload: unknown) => JSON.parse((await post(payload)).body).error?.code;
    const base = {
      name: 'staging',
      origin: 'https://staging.example.test/path',
      environment: 'staging',
    };
    expect(await code({ ...base, origin: 'http://localhost:3000' })).toBe('invalid_origin');
    expect(await code({ ...base, origin: 'https://u:p@staging.example.test' })).toBe(
      'invalid_origin',
    );
    expect(await code({ ...base, origin: 'ftp://x.test' })).toBe('invalid_origin');
    expect(await code({ ...base, maxVus: 5000 })).toBe('invalid_request');
    expect(await code({ ...base, password: 'x' })).toBe('invalid_request');
    const created = await post(base);
    expect(created.statusCode).toBe(201);
    const t = JSON.parse(created.body) as LoadTargetDto;
    expect(t).toMatchObject({
      origin: 'https://staging.example.test',
      maxVus: 20,
      maxDurationSeconds: 300,
    });
    expect(await code({ ...base, name: 'other' })).toBe('target_exists');
    const list = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/load-targets', headers: H })).body,
    );
    expect(list.targets).toHaveLength(1);
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/load-targets/${t.id}`,
      headers: { host: H.host, 'x-friday-client': '1' },
    });
    expect(del.statusCode).toBe(204);
    expect(s.audit.list().map((e) => e.action)).toEqual(
      expect.arrayContaining(['load_target_added', 'load_target_removed']),
    );
  });
});

// The real k6, when configured (FRIDAY_TEST_K6=/path/to/k6).
const REAL_K6 = process.env.FRIDAY_TEST_K6;

describe.skipIf(!REAL_K6)('with a real k6', () => {
  it('loads a local server and reads its results', async () => {
    const server = http.createServer((req, res) => {
      if (req.url === '/fail') {
        res.writeHead(500);
        return res.end('boom: db\n  down');
      }
      if (req.url === '/away') {
        res.writeHead(302, { location: 'https://example.com/' });
        return res.end();
      }
      res.end('ok');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const saved = process.env.FRIDAY_K6;
    process.env.FRIDAY_K6 = REAL_K6;
    try {
      const { c, recorded } = ctx();
      const p = await runLoadTest.prepare!(
        runLoadTest.schema.parse({
          reason: 'baseline',
          target: `http://127.0.0.1:${port}`,
          requests: [
            { path: '/', name: 'home' },
            { path: '/away', name: 'away' },
            { path: '/fail', name: 'broken' },
          ],
          vus: 2,
          duration_seconds: 2,
          think_time_ms: 50,
          thresholds: { p95_ms: 1000 },
        }),
        c,
      );
      await p.apply(c);
      const r = recorded[0]!;
      expect(r.status).toBe('passed');
      expect(r.requests).toBeGreaterThan(10);
      // The redirect to another site was reported, not followed.
      const away = r.perRequest.find((q) => q.name === 'away')!;
      expect(away).toMatchObject({ failedRate: 0 });
      expect(away.statuses.map((x) => x.status)).toEqual([302]);
      expect(r.perRequest.find((q) => q.name === 'broken')!.errorSamples).toEqual([
        { status: 500, body: 'boom: db down' },
      ]);
      expect(r.checks.map((c) => c.name)).toEqual([
        'home: status 2xx or 3xx',
        'away: status 2xx or 3xx',
        'broken: status 2xx or 3xx',
      ]);
      expect(r.thresholds.every((t) => t.ok)).toBe(true);
    } finally {
      process.env.FRIDAY_K6 = saved;
      server.close();
    }
  }, 60_000);
});
