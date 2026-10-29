// Live end-to-end check of the whole coding cycle against NoTokenLimit, over real HTTP and SSE, on
// a disposable sample project in the system temp folder:
//   inspect -> plan -> approval with diff -> apply -> approval to run tests -> execute ->
//   actual output -> verified report.
// Approvals are decided by this test the way the UI does (echoing the action hash), and only for the
// expected actions. Uses quota, so it only runs via `npm run test:integration` with NTL_API_KEY and
// NTL_MODEL set. Never run in CI.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ApprovalDto, RunDto, RunEvent } from '@friday/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { openDatabase } from '../../src/db/database.js';
import { createServices } from '../../src/services.js';
import { detectToolEnvironment } from '../../src/workspace/environment.js';

const repoRoot = path.resolve(import.meta.dirname, '../../../..');
const envFile = path.join(repoRoot, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
const config = loadConfig({ ...process.env, FRIDAY_PORT: '4391' }, repoRoot);
const enabled =
  process.env.NTL_INTEGRATION === '1' && !!config.provider.apiKey && !!config.provider.envModel;

const BUGGY = `export function cartTotal(items) {
  let total = 0;
  for (let i = 1; i < items.length; i++) {
    total += items[i].price * items[i].qty;
  }
  return total;
}
`;
const TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cartTotal } from '../src/cart.js';

test('sums every line of the cart', () => {
  assert.equal(cartTotal([{ price: 5, qty: 2 }, { price: 1, qty: 3 }]), 13);
});

test('empty cart is zero', () => {
  assert.equal(cartTotal([]), 0);
});
`;

function makeSampleProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'friday-e2e-shop-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'test'));
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'shop', type: 'module', scripts: { test: 'node --test' } }, null, 2),
  );
  fs.writeFileSync(path.join(root, 'src', 'cart.js'), BUGGY);
  fs.writeFileSync(path.join(root, 'test', 'cart.test.js'), TEST);
  return root;
}

/** Minimal SSE reader for the run event stream. */
async function* runEvents(url: string): AsyncGenerator<RunEvent> {
  const res = await fetch(url, { headers: { host: '127.0.0.1:4391' } });
  if (!res.ok || !res.body) throw new Error(`SSE failed: ${res.status}`);
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true });
    let end: number;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = block
        .split('\n')
        .filter((l) => l.startsWith('data: '))
        .map((l) => l.slice(6))
        .join('\n');
      if (data) yield JSON.parse(data) as RunEvent;
    }
  }
}

describe.skipIf(!enabled)('end-to-end coding cycle (live)', () => {
  const root = makeSampleProject();
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('inspects, plans, edits and tests only with approval, and reports a verified result', async () => {
    const db = openDatabase(':memory:');
    const services = createServices(config, db, { toolEnv: await detectToolEnvironment() });
    const app = await buildApp(services);
    await app.listen({ host: '127.0.0.1', port: 4391 });
    const base = 'http://127.0.0.1:4391';
    const headers = { 'content-type': 'application/json', 'x-friday-client': '1' };
    const post = async (url: string, body: unknown) => {
      const res = await fetch(base + url, { method: 'POST', headers, body: JSON.stringify(body) });
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    };

    try {
      // Unapproved work cannot even start: the test command fails before any change.
      expect(() => execFileSync('npm', ['test'], { cwd: root, stdio: 'pipe' })).toThrow();

      const project = await post('/api/projects', { path: root, name: 'shop' });
      expect(project.status).toBe(201);
      const session = await post('/api/sessions', { projectId: project.json.id });
      const sessionId = session.json.id as string;
      const started = await post(`/api/sessions/${sessionId}/messages`, {
        content:
          'The tests in this project fail. Inspect the code, give a short plan, fix the bug with a ' +
          'minimal edit, then run `npm test` and tell me the actual result.',
      });
      expect(started.status).toBe(202);
      const runId = (started.json.run as RunDto).id;

      const toolOrder: string[] = [];
      const approvals: ApprovalDto[] = [];
      let finished: RunDto | null = null;
      let plannedBeforeEdit = false;
      let text = '';

      for await (const e of runEvents(`${base}/api/runs/${runId}/events`)) {
        if (e.type === 'tool_started') toolOrder.push(e.name);
        if (e.type === 'plan_updated' && approvals.length === 0) plannedBeforeEdit = true;
        if (e.type === 'text_delta' && approvals.length === 0) text += e.delta;
        if (e.type === 'approval_requested') {
          const a = e.approval;
          approvals.push(a);
          let approve = false;
          if (a.details.kind === 'file_change') {
            // The diff is shown before anything is written.
            expect(a.details.changes.some((c) => c.diff.includes('i = 0'))).toBe(true);
            expect(fs.readFileSync(path.join(root, 'src', 'cart.js'), 'utf8')).toBe(BUGGY);
            approve = a.details.changes.every((c) => c.path === 'src/cart.js');
          } else if (a.details.kind === 'command') {
            const shown = a.details.argv?.join(' ') ?? a.details.shellCommand ?? '';
            approve = /\b(npm|node)\b.*\btest\b/.test(shown);
          }
          const decision = await post(`/api/approvals/${a.id}/decision`, {
            decision: approve ? 'approve' : 'reject',
            actionHash: a.actionHash,
            sessionId,
            ...(approve ? {} : { note: 'Not part of this test.' }),
          });
          expect(decision.status).toBe(200);
        }
        if (e.type === 'run_finished') finished = e.run;
      }

      // Inspection happened before the first approval request.
      const firstGated = toolOrder.findIndex((n) =>
        ['edit_file', 'edit_files', 'write_file', 'run_command'].includes(n),
      );
      expect(firstGated).toBeGreaterThan(0);
      expect(
        toolOrder.slice(0, firstGated).some((n) => ['read_file', 'search_code'].includes(n)),
      ).toBe(true);
      // A plan was given before the edit: as a published plan or in the answer text.
      expect(plannedBeforeEdit || /plan|fix|loop|index/i.test(text)).toBe(true);

      expect(approvals.map((a) => a.details.kind)).toEqual(
        expect.arrayContaining(['file_change', 'command']),
      );
      expect(finished?.status).toBe('completed');
      const report = finished!.report!;
      expect(report.status).toBe('verified');
      expect(report.files.map((f) => f.path)).toContain('src/cart.js');
      const check = report.commands.find((c) => c.verification && c.afterLastChange);
      expect(check?.exitCode).toBe(0);

      // Independent confirmation, outside Friday: the project's tests now pass.
      execFileSync('npm', ['test'], { cwd: root, stdio: 'pipe' });
      console.info(
        `[e2e] tools: ${toolOrder.join(' -> ')}\n[e2e] approvals: ${approvals
          .map((a) => `${a.details.kind}:${a.status === 'pending' ? 'decided' : a.status}`)
          .join(', ')}\n[e2e] report: ${report.status} - ${report.note}`,
      );
    } finally {
      await services.runManager.shutdown();
      await app.close();
      db.close();
    }
  }, 300_000);
});
