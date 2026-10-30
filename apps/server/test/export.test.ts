import type { ApprovalDto, MessageDto, RunDto } from '@friday/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { CaptureEngine } from '../src/browser/capture.js';
import { exportFileName } from '../src/http/routes/export.js';
import { conversationMarkdown, fenced, nestHeadings } from '../src/reports/export.js';
import { TEST_KEY, testServices } from './helpers.js';

const LOCAL = { host: '127.0.0.1:4317' };

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

const msg = (over: Partial<MessageDto>): MessageDto => ({
  id: 1,
  sessionId: 's',
  runId: 'r1',
  role: 'user',
  content: '',
  status: 'complete',
  model: null,
  createdAt: '2026-10-30T01:00:00.000Z',
  ...over,
});

const DIFF = '--- a/cart.js\n+++ b/cart.js\n@@ -1 +1 @@\n-for (let i = 1;\n+for (let i = 0;\n';

const approval: ApprovalDto = {
  id: 'ap1',
  sessionId: 's',
  runId: 'r1',
  projectId: 'p',
  toolCallId: 'c2',
  toolName: 'edit_file',
  category: 'file_modify',
  risk: 'medium',
  title: 'Edit cart.js',
  summary: 'Applies 1 edit.',
  reason: 'Fix the off-by-one',
  details: {
    kind: 'file_change',
    changes: [{ path: 'cart.js', change: 'modify', diff: DIFF, added: 1, removed: 1 }],
  },
  actionHash: 'f'.repeat(64),
  status: 'executed',
  decisionNote: null,
  resultSummary: 'edited cart.js (+1 −1)',
  createdAt: '2026-10-30T01:00:05.000Z',
  expiresAt: '2026-10-30T01:15:05.000Z',
  decidedAt: '2026-10-30T01:00:09.000Z',
  confirmationRequired: null,
  grantedBy: null,
};

const run = (over: Partial<RunDto>): RunDto =>
  ({
    id: 'r1',
    sessionId: 's',
    status: 'completed',
    model: 'claude-sonnet-4.6',
    errorKind: null,
    errorMessage: null,
    retryable: false,
    startedAt: '2026-10-30T01:00:00.000Z',
    finishedAt: '2026-10-30T01:01:00.000Z',
    checkpoint: null,
    report: null,
    ...over,
  }) as RunDto;

const input = {
  title: 'Fix the cart',
  createdAt: '2026-10-30T01:00:00.000Z',
  project: { name: 'shop', rootPath: '/work/shop' },
  messages: [
    msg({
      id: 1,
      content: 'The cart total is wrong.',
      attachments: [
        { id: 'a', name: 'cart.png', mime: 'image/png', size: 10, width: 800, height: 600 },
      ] as MessageDto['attachments'],
    }),
    msg({
      id: 2,
      role: 'assistant',
      model: 'claude-sonnet-4.6',
      createdAt: '2026-10-30T01:00:03.000Z',
      toolCalls: [
        { id: 'c1', name: 'read_file', arguments: '{"path":"cart.js"}' },
        { id: 'c2', name: 'edit_file', arguments: '{"path":"cart.js"}' },
      ],
    }),
    msg({
      id: 3,
      role: 'tool',
      toolCallId: 'c1',
      content: '1 for (let i = 1;',
      tool: {
        callId: 'c1',
        name: 'read_file',
        arguments: '{}',
        status: 'completed',
        summary: 'read 1 line of cart.js',
        durationMs: 3,
        truncated: false,
        approvalId: null,
      },
    }),
    msg({
      id: 4,
      role: 'tool',
      toolCallId: 'c2',
      content: 'Edited cart.js.',
      tool: {
        callId: 'c2',
        name: 'edit_file',
        arguments: '{}',
        status: 'completed',
        summary: 'edited',
        durationMs: 9,
        truncated: false,
        approvalId: 'ap1',
      },
    }),
    msg({
      id: 5,
      role: 'assistant',
      model: 'claude-sonnet-4.6',
      createdAt: '2026-10-30T01:00:30.000Z',
      content: '# Fixed\n\nThe loop now starts at 0:\n\n```js\n# not a heading\n```',
    }),
    msg({ id: 6, runId: 'r2', content: 'Now deploy it', createdAt: '2026-10-30T02:00:00.000Z' }),
  ],
  approvals: [approval],
  runs: [
    run({
      report: {
        status: 'verified',
        note: '`npm test` passed after the last change.',
        files: [
          {
            path: 'cart.js',
            change: 'modify',
            fromPath: null,
            reverted: false,
            modifiedSince: false,
          },
        ],
        commands: [
          {
            title: 'npm test',
            result: 'exit code 0',
            exitCode: 0,
            verification: true,
            afterLastChange: true,
          },
        ],
        commits: [],
      },
    }),
    run({ id: 'r2', status: 'cancelled' }),
  ],
  detail: 'summary' as const,
  tzOffsetMinutes: 480,
  now: new Date('2026-10-30T03:00:00.000Z'),
};

describe('conversation export', () => {
  it('writes a summary: messages, one line per tool call, decisions and run reports', () => {
    const md = conversationMarkdown(input);
    expect(md).toMatch(
      /^# Fix the cart\n\nExported from Friday on 2026-10-30 11:00 \(UTC\+08:00\)\./,
    );
    expect(md).toContain('Project: shop (`/work/shop`). Model: claude-sonnet-4.6.');
    expect(md).toContain(
      '## You · 2026-10-30 09:00\n\nThe cart total is wrong.\n\n_Images: cart.png (800×600)_',
    );
    expect(md).toContain('- `read_file`: read 1 line of cart.js');
    expect(md).toContain('- **Edit cart.js**: approved and done, edited cart.js (+1 −1)');
    // Friday's turns in one run share one heading, before its tool calls (a turn that only
    // called tools must not read as part of the user's message).
    expect(md.match(/## Friday/g)).toHaveLength(1);
    expect(md.indexOf('## Friday')).toBeLessThan(md.indexOf('- `read_file`'));
    // Reply headings sit below the export's; code is left alone.
    expect(md).toContain('### Fixed');
    expect(md).toContain('```js\n# not a heading\n```');
    expect(md).toContain('**Run report: ✅ Verified.** `npm test` passed after the last change.');
    expect(md).toContain('- `cart.js` (modify)');
    expect(md).toContain('_This run ended cancelled._');
    // The report follows its own run, before the next one starts.
    expect(md.indexOf('Run report')).toBeLessThan(md.indexOf('Now deploy it'));
    expect(md).not.toContain('Edited cart.js.');
    expect(md).not.toContain('--- a/cart.js');
  });

  it('adds tool results, reasons and diffs in a full export', () => {
    const md = conversationMarkdown({ ...input, detail: 'full' });
    expect(md).toContain('Reason given: Fix the off-by-one');
    expect(md).toContain(`\`\`\`diff\n${DIFF.trimEnd()}\n\`\`\``);
    expect(md).toContain('```\n1 for (let i = 1;\n```');
    expect(md).toContain('Arguments: `{"path":"cart.js"}`');
    expect(md.match(/## Friday/g)).toHaveLength(1);
  });

  it('keeps fences and headings from breaking the document', () => {
    expect(fenced('a\n```\nb')).toBe('~~~\na\n```\nb\n~~~');
    expect(fenced('```\n~~~')).toBe('```\n`​``\n~~~\n```');
    expect(nestHeadings('# A\n##### B\n~~~\n# c\n~~~')).toBe('### A\n###### B\n~~~\n# c\n~~~');
    expect(exportFileName('Fix: the cart / total?', '2026-10-30', 'md')).toBe(
      'Fix-the-cart-total-2026-10-30.md',
    );
    expect(exportFileName('…', '2026-10-30', 'pdf')).toBe('conversation-2026-10-30.pdf');
  });
});

class FakePrinter implements CaptureEngine {
  readonly name = 'fake';
  html = '';
  async capture(): Promise<never> {
    throw new Error('not used');
  }
  async printPdf(html: string) {
    this.html = html;
    return Buffer.from('%PDF-1.7\n%%EOF');
  }
}

async function setup(engine?: CaptureEngine) {
  const s = testServices(engine ? { captureEngine: engine } : {});
  app = await buildApp(s);
  const session = s.sessions.create('Deploy notes');
  s.messages.insert({
    sessionId: session.id,
    role: 'user',
    content: `Use key ${TEST_KEY} and password=hunter2hunter2 please`,
    status: 'complete',
  });
  s.messages.insert({
    sessionId: session.id,
    role: 'assistant',
    content: 'Done.',
    status: 'complete',
    model: 'm',
  });
  return { s, session, app };
}

describe('export route', () => {
  it('downloads Markdown with secrets redacted, and records the export', async () => {
    const { s, session, app } = await setup();
    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${session.id}/export?format=md&tz=480`,
      headers: LOCAL,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/markdown; charset=utf-8');
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="Deploy-notes-\d{4}-\d{2}-\d{2}\.md"/,
    );
    expect(res.body).toContain('# Deploy notes');
    expect(res.body).toContain('Done.');
    expect(res.body).not.toContain(TEST_KEY);
    expect(res.body).not.toContain('hunter2hunter2');
    expect(s.audit.list(5)[0]).toMatchObject({ action: 'session_exported', sessionId: session.id });
  });

  it('prints a PDF through the browser engine, or says why it cannot', async () => {
    const without = await setup();
    const no = await without.app.inject({
      method: 'GET',
      url: `/api/sessions/${without.session.id}/export?format=pdf`,
      headers: LOCAL,
    });
    expect(no.statusCode).toBe(409);
    expect(no.json().error.code).toBe('pdf_unavailable');
    await without.app.close();
    app = null;

    const printer = new FakePrinter();
    const { session, app: withPdf } = await setup(printer);
    const res = await withPdf.inject({
      method: 'GET',
      url: `/api/sessions/${session.id}/export?format=pdf&detail=full`,
      headers: LOCAL,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect(printer.html).toContain('<h1>Deploy notes</h1>');
    expect(printer.html).toContain('Conversation with Friday');
    // The title appears once (the document header), not again from the Markdown.
    expect(printer.html.match(/Deploy notes<\/h1>/g)).toHaveLength(1);
    expect(printer.html).not.toContain(TEST_KEY);
  });

  it('rejects unknown conversations and bad options', async () => {
    const { session, app } = await setup();
    const get = (url: string) => app.inject({ method: 'GET', url, headers: LOCAL });
    expect((await get(`/api/sessions/${crypto.randomUUID()}/export`)).statusCode).toBe(404);
    for (const q of ['format=docx', 'detail=all', 'tz=9999'])
      expect((await get(`/api/sessions/${session.id}/export?${q}`)).statusCode).toBe(400);
  });
});
