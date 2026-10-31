import http from 'node:http';
import type { ApprovalDto, BrowserFlowDto, RunEvent } from '@friday/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { imageInfo } from '../src/attachments/image.js';
import {
  ChromeEngine,
  findChrome,
  type CaptureEngine,
  type PageSession,
} from '../src/browser/capture.js';
import { describeStep, runFlow, type FlowStep } from '../src/browser/flow.js';
import { buildRunReport, type ReportDeps } from '../src/reports/runReport.js';
import { runBrowserFlow } from '../src/tools/browserTools.js';
import { call, cleanupProjects, ScriptedProvider, testServices } from './helpers.js';

afterEach(cleanupProjects);

const SHOP = `<!doctype html><html><head><title>Shop</title></head><body>
<h1>Shop</h1>
<nav><a href="/cart">Cart</a> <a href="https://example.com/">Partner site</a></nav>
<form id="f">
  <label for="email">Email address</label> <input id="email" type="email" required>
  <label>Password <input type="password" name="pw"></label>
  <label><input type="checkbox" id="remember"> Remember me</label>
  <select aria-label="Plan"><option>Free</option><option value="pro">Pro plan</option></select>
  <button type="submit">Sign in</button>
</form>
<p id="msg"></p>
<ul><li>Milk <button onclick="this.parentElement.remove()">Delete</button></li>
<li>Eggs <button onclick="if (confirm('Delete eggs?')) this.parentElement.remove()">Delete</button></li></ul>
<button onclick="setTimeout(() => { document.getElementById('late').hidden = false }, 600)">Load more</button>
<div id="late" hidden><button onclick="console.error('boom'); throw new Error('kaboom')">Late button</button></div>
<script>
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await fetch('/api/login', { method: 'POST', body: JSON.stringify({ email: document.getElementById('email').value, plan: document.querySelector('select').value, remember: document.getElementById('remember').checked }) });
  const body = await r.json();
  document.getElementById('msg').textContent = body.ok ? 'Welcome, ' + body.email + ' (' + body.plan + (body.remember ? ', remembered' : '') + ')' : 'Login failed';
});
</script>
</body></html>`;

function shopServer(): Promise<{ origin: string; close: () => void; logins: string[] }> {
  const logins: string[] = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/api/login') {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        logins.push(body);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, ...(JSON.parse(body) as object) }));
      });
      return;
    }
    if (req.url === '/broken') {
      res.writeHead(500, { 'content-type': 'text/html' });
      return res.end('<title>Error</title><h1>Internal error</h1>');
    }
    res.setHeader('content-type', 'text/html');
    if (req.url === '/cart') return res.end('<title>Cart</title><h1>Your cart</h1><p>Empty</p>');
    if (req.url === '/' || req.url?.startsWith('/?')) return res.end(SHOP);
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        origin: `http://localhost:${(server.address() as { port: number }).port}`,
        close: () => server.close(),
        logins,
      }),
    ),
  );
}

describe('browser flow steps', () => {
  it('describes each step the way the approval card shows it', () => {
    const steps: FlowStep[] = [
      { action: 'goto', url: '/cart' },
      { action: 'click', target: { role: 'button', name: 'Delete', nth: 2 }, accept_dialog: true },
      { action: 'fill', target: { label: 'Email' }, value: 'a@b.co' },
      { action: 'fill', target: { placeholder: 'Search' }, value: '' },
      { action: 'select', target: { role: 'combobox', name: 'Plan' }, option: 'Pro' },
      { action: 'check', target: { label: 'Remember me', exact: true } },
      { action: 'press', key: 'Enter', target: { test_id: 'search' } },
      { action: 'wait', ms: 300 },
      { action: 'expect', text: 'Welcome' },
      { action: 'expect', target: { css: '#total' }, value: '9.00' },
      { action: 'expect', url: '/orders/', absent: true },
    ];
    expect(steps.map(describeStep)).toEqual([
      'Go to /cart',
      'Click button "Delete" (match 2), accepting the dialog it opens',
      'Type "a@b.co" into field labelled "Email"',
      'Clear field with placeholder "Search"',
      'Choose "Pro" in combobox "Plan"',
      'Check field labelled "Remember me" (exact)',
      'Press Enter in test id "search"',
      'Wait 300 ms',
      'Expect the page to show "Welcome"',
      'Expect element #total to have the value "9.00"',
      'Expect the address not to contain "/orders/"',
    ]);
  });

  it('checks that each step has what its action needs', () => {
    const parse = (steps: unknown[]) =>
      runBrowserFlow.schema.safeParse({
        title: 'Sign in',
        url: 'http://localhost:5173',
        reason: 'check the login',
        steps,
      });
    expect(parse([{ action: 'click', target: { role: 'button', name: 'Go' } }]).success).toBe(true);
    const errors = (steps: unknown[]) => {
      const r = parse(steps);
      return r.success ? [] : r.error.issues.map((i) => i.message);
    };
    expect(errors([{ action: 'fill', target: { label: 'Email' } }])).toContain('fill needs value.');
    expect(errors([{ action: 'click', target: { text: 'Go' }, key: 'Enter' }])).toContain(
      'click does not take key.',
    );
    expect(errors([{ action: 'expect', text: 'Hi', url: '/home' }])).toContain(
      'expect needs exactly one of text, target or url.',
    );
    expect(errors([{ action: 'click', target: { text: 'Go', css: 'a' } }])).toContain(
      'A target needs exactly one of role, label, text, placeholder, test_id or css.',
    );
    expect(errors([{ action: 'click', target: { name: 'Go' } }])).toContain('name goes with role.');
    expect(errors([{ action: 'press', key: 'Control+A' }]).length).toBeGreaterThan(0);
    // A role with a label or text is read as the role's name.
    expect(
      parse([{ action: 'fill', target: { role: 'textbox', label: 'Email' }, value: 'a' }]).success,
    ).toBe(true);
    expect(
      errors([{ action: 'click', target: { role: 'button', name: 'Go', text: 'Go' } }]),
    ).toContain('Give the role one name (name, label or text).');
  });
});

/** An engine that can drive pages, but none of these tests gets that far. */
class UnusedEngine implements CaptureEngine {
  readonly name = 'unused';
  capture(): never {
    throw new Error('not used');
  }
  printPdf(): never {
    throw new Error('not used');
  }
  openPage(): never {
    throw new Error('not used');
  }
}

async function prepareError(engine: CaptureEngine, args: Record<string, unknown>) {
  const provider = new ScriptedProvider();
  const s = testServices({ provider, captureEngine: engine });
  provider.streamSteps.push(
    {
      toolCalls: [
        call(
          'run_browser_flow',
          { title: 'Sign in', reason: 'check it', steps: [{ action: 'wait', ms: 100 }], ...args },
          'f1',
        ),
      ],
    },
    { chunks: ['ok'] },
  );
  const session = s.sessions.create();
  const { run } = s.runManager.startMessage(session.id, 'test the login');
  await s.runManager.waitFor(run.id);
  expect(s.approvalRepo.listByRun(run.id)).toEqual([]);
  return s.messages.listBySession(session.id).find((m) => m.role === 'tool')!.content;
}

describe('browser flows in the run report', () => {
  const report = (flowSummaries: string[]) => {
    const at = (min: number) => new Date(Date.UTC(2026, 9, 31, 8, min)).toISOString();
    const approvals = flowSummaries.map((summary, i) => ({
      toolName: 'run_browser_flow',
      status: 'executed',
      title: `Browser flow: Sign in ${i + 1}`,
      resultSummary: summary,
      details: { kind: 'browser_flow' },
      createdAt: at(10 + i),
    }));
    const change = {
      id: 1,
      path: 'public/app.js',
      fromPath: null,
      change: 'modify',
      projectId: 'p',
      revertedAt: null,
      afterHash: 'x',
      createdAt: at(5),
    };
    return buildRunReport('r', {
      approvalRepo: { listByRun: () => approvals },
      fileChanges: { listByRun: () => [change] },
      projects: { get: () => null },
      runs: { get: () => null },
    } as unknown as ReportDeps);
  };

  it('counts a browser flow after the last change as the check', () => {
    expect(
      report(['failed at step 3: button "Log in" was not found.', 'passed, 4 steps']),
    ).toMatchObject({
      status: 'verified',
      note: '`Browser flow: Sign in 2` passed after the last change (1 earlier check(s) failed).',
    });
    expect(report(['failed at step 3: button "Log in" was not found.'])).toMatchObject({
      status: 'failed',
      commands: [{ exitCode: 1, verification: true, afterLastChange: true }],
    });
    expect(report([])).toMatchObject({ status: 'unverified' });
  });
});

describe('run_browser_flow before approval', () => {
  it('refuses pages that are not running or not on this machine, without asking', async () => {
    const engine = new UnusedEngine();
    const closed = http.createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const port = (closed.address() as { port: number }).port;
    closed.close();
    expect(await prepareError(engine, { url: `http://localhost:${port}/` })).toMatch(
      /Nothing is listening at http:\/\/localhost:\d+\. Start the app first/,
    );
    expect(await prepareError(engine, { url: 'https://example.com/' })).toMatch(
      /Only pages on this machine/,
    );
    const shop = await shopServer();
    try {
      expect(
        await prepareError(engine, {
          url: shop.origin,
          steps: [{ action: 'goto', url: 'https://example.com/login' }],
        }),
      ).toMatch(/Step 1: Only pages on this machine/);
      expect(
        await prepareError(engine, {
          url: shop.origin,
          steps: [{ action: 'goto', url: '//example.com/' }],
        }),
      ).toMatch(/Step 1: Only pages on this machine/);
    } finally {
      shop.close();
    }
  });

  it('says when the browser can only take screenshots', async () => {
    const engine: CaptureEngine = {
      name: 'screenshots only',
      capture: () => Promise.reject(new Error('not used')),
      printPdf: () => Promise.reject(new Error('not used')),
    };
    expect(await prepareError(engine, { url: 'http://localhost:5173' })).toMatch(
      /cannot drive pages/,
    );
  });
});

// A real headless browser, only where one is configured (FRIDAY_CHROME or an installed Chrome).
const chrome = await findChrome();

describe.skipIf(!chrome)('browser flows with a real browser', () => {
  let shop: Awaited<ReturnType<typeof shopServer>>;
  beforeAll(async () => {
    shop = await shopServer();
  });
  afterAll(() => shop.close());

  const flow = async (steps: FlowStep[], start = `${shop.origin}/`) => {
    const engine = new ChromeEngine(chrome!);
    const page = await engine.openPage({ width: 1000, height: 700 });
    try {
      return await runFlow(page, start, steps);
    } finally {
      await page.close();
    }
  };

  it('fills a form, chooses options, submits it and checks the result', async () => {
    const r = await flow([
      { action: 'fill', target: { label: 'Email address' }, value: 'test@example.com' },
      { action: 'fill', target: { label: 'Password' }, value: 'seed-password' },
      { action: 'check', target: { label: 'Remember me' } },
      { action: 'select', target: { role: 'combobox', name: 'Plan' }, option: 'Pro plan' },
      { action: 'click', target: { role: 'button', name: 'Sign in' } },
      { action: 'expect', text: 'Welcome, test@example.com (pro, remembered)' },
      { action: 'click', target: { role: 'link', name: 'Cart' } },
      { action: 'expect', url: '/cart' },
      { action: 'expect', target: { role: 'heading', name: 'Your cart' } },
    ]);
    expect(r.steps.map((s) => s.status)).toEqual(Array(10).fill('passed'));
    expect(r.status).toBe('passed');
    expect(JSON.parse(shop.logins.at(-1)!)).toEqual({
      email: 'test@example.com',
      plan: 'pro',
      remember: true,
    });
    expect(r.steps.at(-1)).toMatchObject({ url: `${shop.origin}/cart`, title: 'Cart' });
    for (const s of r.steps) expect(imageInfo(s.image!)?.mime).toBe('image/jpeg');
    expect(r.steps[0]!.problems).toEqual([]); // the browser's own favicon request is not one
  }, 60_000);

  it('waits for late elements, answers dialogs as told and reports page errors', async () => {
    const r = await flow([
      { action: 'click', target: { role: 'button', name: 'Delete', nth: 2 } },
      { action: 'expect', text: 'Eggs' },
      { action: 'click', target: { role: 'button', name: 'Delete', nth: 2 }, accept_dialog: true },
      { action: 'expect', text: 'Eggs', absent: true },
      { action: 'click', target: { text: 'Load more' } },
      { action: 'click', target: { role: 'button', name: 'Late button' } },
    ]);
    expect(r.status).toBe('passed');
    expect(r.steps[1]!.notes).toEqual([
      'confirm dialog "Delete eggs?" dismissed (the step did not say to accept it)',
    ]);
    expect(r.steps[3]!.notes).toEqual(['confirm dialog "Delete eggs?" accepted']);
    expect(r.steps[6]!.durationMs).toBeGreaterThan(400);
    expect(r.steps[6]!.problems).toEqual(['console.error: boom', 'uncaught: Error: kaboom']);
  }, 60_000);

  it('clicks again when the page never received the click', async () => {
    const engine = new ChromeEngine(chrome!);
    const real = await engine.openPage({ width: 1000, height: 700 });
    // The browser drops input a new page is not ready for; here the first click is dropped.
    let swallow = 3;
    const page: PageSession = {
      ...real,
      send: (method, params) =>
        method === 'Input.dispatchMouseEvent' && swallow-- > 0
          ? Promise.resolve({})
          : real.send(method, params),
    };
    try {
      const r = await runFlow(page, `${shop.origin}/`, [
        { action: 'click', target: { role: 'button', name: 'Delete', nth: 1 } },
        { action: 'expect', text: 'Milk', absent: true },
      ]);
      expect(r.status).toBe('passed');
      expect(r.steps[1]!.notes).toEqual([
        'the page did not receive the first click; clicked again',
      ]);
    } finally {
      await real.close();
    }
  }, 60_000);

  it('stops at an ambiguous or missing element and lists what is on the page', async () => {
    const r = await flow([
      { action: 'click', target: { role: 'button', name: 'Delete' } },
      { action: 'expect', text: 'never reached' },
    ]);
    expect(r.status).toBe('failed');
    expect(r.steps.map((s) => s.status)).toEqual(['passed', 'failed', 'skipped']);
    expect(r.steps[1]!.error).toBe(
      'button "Delete" matches 2 elements; add nth (1 = first) or name it more precisely.\nMatches:\n  1. button "Delete" in "Milk Delete"\n  2. button "Delete" in "Eggs Delete"',
    );
    expect(r.steps[1]!.durationMs).toBeLessThan(2_000);
    expect(r.outline?.controls).toContainEqual({
      role: 'button',
      name: 'Delete',
      target: { role: 'button', name: 'Delete', nth: 2 },
      state: ['in "Eggs Delete"'],
    });

    const missing = await flow([
      { action: 'click', target: { role: 'button', name: 'Sign up' }, timeout_ms: 300 },
    ]);
    expect(missing.steps[1]!.error).toBe(
      'button "Sign up" was not found.\nSimilar elements on the page:\n  button "Sign in"',
    );
    const text = await flow([{ action: 'expect', text: 'welcome', timeout_ms: 300 }]);
    expect(text.steps[1]!.error).toBe('Expectation failed: the page does not show "welcome".');
  }, 60_000);

  it('never leaves this machine and fails on error pages', async () => {
    const away = await flow([{ action: 'click', target: { role: 'link', name: 'Partner site' } }]);
    expect(away.steps[1]!.error).toBe(
      'This led to https://example.com/, which is not on this machine; only local pages are opened, so the flow cannot go on there.',
    );
    const broken = await flow([], `${shop.origin}/broken`);
    expect(broken.steps[0]).toMatchObject({
      status: 'failed',
      error: 'The page answered HTTP 500.',
      problems: [`HTTP 500: ${shop.origin}/broken`],
    });
  }, 60_000);

  it('runs after approval, keeps every screenshot for the user and shows the model one', async () => {
    const provider = new ScriptedProvider();
    const s = testServices({ provider, captureEngine: new ChromeEngine(chrome!) });
    const login = (id: string, name: string) =>
      call(
        'run_browser_flow',
        {
          title: 'Sign in',
          url: shop.origin,
          reason: 'check the login form',
          steps: [
            {
              action: 'fill',
              target: { role: 'textbox', label: 'Email address' },
              value: 'test@example.com',
            },
            { action: 'fill', target: { label: 'Password' }, value: 'seed-password' },
            { action: 'click', target: { role: 'button', name } },
            { action: 'expect', text: 'Welcome' },
          ],
        },
        id,
      );
    provider.streamSteps.push(
      { toolCalls: [call('inspect_page', { url: shop.origin }, 'i1')] },
      { toolCalls: [login('f1', 'Sign in')] },
      { toolCalls: [login('f2', 'Log in')] },
      { chunks: ['The login works; "Log in" does not exist.'] },
    );
    const session = s.sessions.create();
    const { run } = s.runManager.startMessage(session.id, 'test the login');
    const asked: ApprovalDto[] = [];
    const flows: BrowserFlowDto[] = [];
    s.runManager.subscribe(run.id, 0, (e: RunEvent) => {
      if (e.type === 'browser_flow') flows.push(e.flow);
      if (e.type === 'approval_requested' && e.approval.status === 'pending')
        setTimeout(() => {
          const a = s.approvalRepo.get(e.approval.id)!;
          if (a.status !== 'pending') return;
          asked.push(a);
          s.approvals.decide(a.id, {
            decision: 'approve',
            actionHash: a.actionHash,
            sessionId: session.id,
            allowSimilar: true,
          });
        }, 5);
    });
    await s.runManager.waitFor(run.id);

    const tools = s.messages.listBySession(session.id).filter((m) => m.role === 'tool');
    // inspect_page ran without asking and gave ready-made targets.
    expect(tools[0]!.content).toContain(
      '- textbox "Email address" [required; empty] → {"role":"textbox","name":"Email address"}',
    );
    expect(tools[0]!.content).toContain('- button "Sign in" → {"role":"button","name":"Sign in"}');

    // One approval: the second flow on the same site ran under "allow similar".
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ category: 'browser', risk: 'medium' });
    expect(asked[0]!.details).toMatchObject({
      kind: 'browser_flow',
      origin: shop.origin,
      steps: [
        {
          action: 'fill',
          description: 'Type "test@example.com" into textbox "Email address"',
        },
        { action: 'fill', description: 'Type "seed-password" into field labelled "Password"' },
        { action: 'click', description: 'Click button "Sign in"' },
        { action: 'expect', description: 'Expect the page to show "Welcome"' },
      ],
    });
    expect(JSON.stringify(asked[0]!.details)).toContain('Types a password at step 2');
    const approvals = s.approvalRepo.listByRun(run.id);
    expect(approvals.map((a) => [a.status, !!a.grantedBy])).toEqual([
      ['executed', false],
      ['executed', true],
    ]);

    // Both flows are recorded with a screenshot per step that ran.
    expect(flows.map((f) => f.status)).toEqual(['passed', 'failed']);
    expect(s.browserFlows.listBySession(session.id)).toEqual(flows);
    expect(flows[0]!.steps.every((st) => st.attachmentId)).toBe(true);
    expect(flows[1]!.steps.map((st) => [st.status, !!st.attachmentId])).toEqual([
      ['passed', true],
      ['passed', true],
      ['passed', true],
      ['failed', true],
      ['skipped', false],
    ]);
    expect(tools[2]!.content).toContain('failed at step 3 of 4');
    expect(tools[2]!.content).toContain('Elements on the page when it failed (to fix the step):');
    expect(tools[2]!.content).toContain('- button "Sign in" → {"role":"button","name":"Sign in"}');

    // The model was shown one screenshot per flow (the last, or the failing step's)...
    expect(tools[1]!.attachments!.map((a) => a.id)).toEqual([flows[0]!.steps[4]!.attachmentId]);
    expect(tools[2]!.attachments!.map((a) => a.id)).toEqual([flows[1]!.steps[3]!.attachmentId]);
    // ...and the rest stay in the conversation, not swept away as abandoned uploads.
    s.attachments.deleteStalePending(0, Date.now() + 1_000);
    for (const st of flows[0]!.steps) expect(s.attachments.get(st.attachmentId!)).not.toBeNull();
  }, 120_000);
});
