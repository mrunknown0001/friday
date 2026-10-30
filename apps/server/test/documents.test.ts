import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type { ApprovalDto, RunEvent } from '@friday/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { findChrome, ChromeEngine, type CaptureEngine } from '../src/browser/capture.js';
import { renderDocx } from '../src/documents/docx.js';
import { documentHtml, pdfFooter } from '../src/documents/html.js';
import { outlineOf, parseMarkdown } from '../src/documents/markdown.js';
import { renderPptx, renderXlsx, sheetNames } from '../src/documents/office.js';
import { call, cleanupProjects, makeProject, ScriptedProvider, testServices } from './helpers.js';

afterEach(cleanupProjects);

/** The files inside a zip (Office documents are zips of XML parts). */
function unzip(buf: Buffer): Map<string, string> {
  const files = new Map<string, string>();
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let p = buf.readUInt32LE(end + 16);
  const count = buf.readUInt16LE(end + 10);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30);
    const comment = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    files.set(name, (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8'));
    p += 46 + nameLen + extra + comment;
  }
  return files;
}

const MD = `## Summary
**Bold**, *italic*, \`code\` and a [link](https://example.com/a_(b)); [bad](javascript:alert(1)).

| Name | Due |
|:-----|----:|
| Code map | 2026-10-30 |

1. one
2. two
- [x] done
- [ ] open
  - nested

> A quote.

\`\`\`ts
const x = '<script>alert(1)</script>';
\`\`\`

<!-- pagebreak -->

# Appendix
Raw <b>HTML</b> stays text.`;

const META = { title: 'Roadmap', subtitle: 'Q4', author: 'Adam', date: '30 October 2026' };

describe('markdown for documents', () => {
  it('parses the supported blocks and inlines, safely', () => {
    const blocks = parseMarkdown(MD);
    expect(blocks.map((b) => b.t)).toEqual([
      'heading',
      'para',
      'table',
      'list',
      'list',
      'quote',
      'code',
      'pagebreak',
      'heading',
      'para',
    ]);
    const para = blocks[1] as Extract<(typeof blocks)[number], { t: 'para' }>;
    expect(para.c.map((x) => x.t)).toEqual([
      'strong',
      'text',
      'em',
      'text',
      'code',
      'text',
      'link',
      'text',
      'text',
      'text',
    ]);
    expect(para.c.find((x) => x.t === 'link')).toMatchObject({ href: 'https://example.com/a_(b)' });
    // The javascript: link is reduced to its text.
    expect(JSON.stringify(para.c)).not.toContain('javascript');
    const table = blocks[2] as Extract<(typeof blocks)[number], { t: 'table' }>;
    expect(table.align).toEqual(['left', 'right']);
    const tasks = blocks[4] as Extract<(typeof blocks)[number], { t: 'list' }>;
    expect(tasks.items.map((i) => [i.ordered, i.checked, i.level])).toEqual([
      [false, true, 0],
      [false, false, 0],
      [false, null, 1],
    ]);
    expect(outlineOf(blocks)).toEqual([
      '  Summary',
      'Appendix',
      expect.stringMatching(/words, 1 table, 1 code block/),
    ]);
  });

  it('keeps lists with blank lines between items together, and outlines from the top heading', () => {
    const blocks = parseMarkdown(
      '### Critical\n\n1. **A** first.\n\n1. **B** second.\n\n#### Detail\n\nAfter.',
    );
    expect(blocks.map((b) => b.t)).toEqual(['heading', 'list', 'heading', 'para']);
    expect((blocks[1] as Extract<(typeof blocks)[number], { t: 'list' }>).items).toHaveLength(2);
    expect(outlineOf(blocks).slice(0, 2)).toEqual(['Critical', '  Detail']);
  });

  it('renders print HTML with everything escaped and no scripts', () => {
    const html = documentHtml(META, parseMarkdown(MD));
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Raw &lt;b&gt;HTML&lt;/b&gt;');
    expect(html).toContain("default-src 'none'");
    expect(html).toContain(
      '<ol><li>one</li><li>two</li></ol>\n<ul><li><span class="box">☑</span> done',
    );
    expect(pdfFooter('A <b>')).toContain('A &lt;b&gt;');
  });
});

describe('document files', () => {
  it('Word: title block, headings, tables, separate numbered lists, safe links', async () => {
    const parts = unzip(await renderDocx(META, parseMarkdown(`${MD}\n\n1. again`)));
    const doc = parts.get('word/document.xml')!;
    expect(doc).toContain('Roadmap');
    expect(doc).toContain('<w:tbl>');
    expect(doc).toContain('&lt;script&gt;');
    expect(parts.get('word/_rels/document.xml.rels')).toContain('https://example.com/a_(b)');
    expect(parts.get('word/_rels/document.xml.rels')).not.toContain('javascript');
    // Two numbered lists, so two numbering instances (the second restarts at 1).
    expect(new Set(doc.match(/<w:numId w:val="\d+"\/>/g)).size).toBeGreaterThanOrEqual(2);
  });

  it('Excel: typed columns, frozen header, cleaned sheet names, never formulas', async () => {
    const parts = unzip(
      await renderXlsx([
        {
          name: 'Tasks',
          columns: [
            { header: 'Task' },
            { header: 'Cost', type: 'currency' },
            { header: 'Due', type: 'date' },
          ],
          rows: [
            ['=HYPERLINK("http://evil")', 12.5, '2026-10-30'],
            ['Docs', null, 'soon'],
          ],
        },
        { name: 'Risks/Issues?', columns: [{ header: 'Risk' }], rows: [] },
      ]),
    );
    const sheet = parts.get('xl/worksheets/sheet1.xml')!;
    expect(sheet).not.toContain('<f>');
    expect(sheet).toContain('state="frozen"');
    // Stored as a shared string (text), not a formula.
    expect(parts.get('xl/sharedStrings.xml')).toContain('<t>=HYPERLINK("http://evil")</t>');
    expect(sheet).toMatch(/<c r="A2" s="0" t="s">/);
    expect(parts.get('xl/workbook.xml')).toContain('name="Risks Issues"');
    expect(sheetNames(['a', 'A', 'x'.repeat(40)])).toEqual(['a', 'A 2', 'x'.repeat(31)]);
  });

  it('PowerPoint: a title slide, content, table, section and notes', async () => {
    const parts = unzip(
      await renderPptx(META, [
        { title: 'Status', bullets: ['Shipped', '  nested'], notes: 'Say thanks.' },
        { title: 'Dates', table: { columns: ['What', 'When'], rows: [['Docs', 'Nov']] } },
        { title: 'Questions', layout: 'section' },
      ]),
    );
    const slides = [...parts.keys()].filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k));
    expect(slides).toHaveLength(4);
    expect(parts.get('ppt/slides/slide1.xml')).toContain('Roadmap');
    expect(parts.get('ppt/slides/slide3.xml')).toContain('<a:tbl>');
    expect([...parts.keys()].some((k) => k.includes('notesSlide'))).toBe(true);
  });
});

// ---------- tools ----------

class FakePrinter implements CaptureEngine {
  readonly name = 'fake';
  html = '';
  async capture(): Promise<never> {
    throw new Error('not used');
  }
  async printPdf(html: string) {
    this.html = html;
    return Buffer.from('%PDF-1.7\n/Type /Page\n/Type /Pages\n%%EOF');
  }
}

async function runTool(
  files: Record<string, string>,
  name: string,
  args: Record<string, unknown>,
  opts: { decision?: 'approve' | 'reject'; engine?: CaptureEngine } = {},
) {
  const root = makeProject(files);
  const provider = new ScriptedProvider([
    { toolCalls: [call(name, { reason: 'the user asked for it', ...args }, 'd1')] },
    { chunks: ['done'] },
  ]);
  const s = testServices({ provider, ...(opts.engine ? { captureEngine: opts.engine } : {}) });
  const project = s.projects.create('shop', root);
  const session = s.sessions.create(undefined, project.id);
  const { run } = s.runManager.startMessage(session.id, 'make it');
  let card: ApprovalDto | null = null;
  s.runManager.subscribe(run.id, 0, (e: RunEvent) => {
    if (e.type !== 'approval_requested') return;
    card = e.approval;
    // Nothing is written before the decision.
    expect(fs.existsSync(path.join(root, String(args.path)))).toBe(
      files[String(args.path)] !== undefined,
    );
    setTimeout(
      () =>
        s.approvals.decide(e.approval.id, {
          decision: opts.decision ?? 'approve',
          actionHash: e.approval.actionHash,
          sessionId: session.id,
        }),
      5,
    );
  });
  await s.runManager.waitFor(run.id);
  const tool = s.messages.listBySession(session.id).find((m) => m.role === 'tool')!;
  return { s, root, project, card: card as ApprovalDto | null, tool };
}

describe('document tools', () => {
  it('create_document writes a Word file after approval, showing its outline; undo removes it', async () => {
    const { s, root, project, card, tool } = await runTool({}, 'create_document', {
      path: 'docs/roadmap.docx',
      title: 'Roadmap',
      content: MD,
    });
    expect(card).toMatchObject({
      category: 'file_create',
      risk: 'low',
      details: {
        kind: 'document',
        path: 'docs/roadmap.docx',
        format: 'docx',
        change: 'create',
        title: 'Roadmap',
        outline: ['  Summary', 'Appendix', expect.any(String)],
      },
    });
    expect(tool.content).toMatch(/Created docs\/roadmap\.docx \(Word document, \d+ KB\)/);
    const file = fs.readFileSync(path.join(root, 'docs/roadmap.docx'));
    expect(unzip(file).get('word/document.xml')).toContain('Appendix');

    const [change] = s.fileChanges.listBySession(card!.sessionId);
    const app = await buildApp(s, { logger: false });
    const undo = await app.inject({
      method: 'POST',
      url: `/api/file-changes/${change!.id}/revert`,
      headers: { host: '127.0.0.1:8787', 'x-friday-client': '1' },
    });
    expect(undo.statusCode).toBe(200);
    expect(fs.existsSync(path.join(root, 'docs/roadmap.docx'))).toBe(false);
    void project;
  });

  it('PDF goes through the browser, and is refused clearly without one', async () => {
    const printer = new FakePrinter();
    const ok = await runTool(
      {},
      'create_document',
      { path: 'report.pdf', title: 'Report', content: '# Hi' },
      { engine: printer },
    );
    expect(ok.tool.content).toMatch(/Created report\.pdf \(PDF document, \d+ bytes, 1 page\)/);
    expect(printer.html).toContain('<h1>Hi</h1>');

    const none = await runTool({}, 'create_document', {
      path: 'report.pdf',
      title: 'Report',
      content: '# Hi',
    });
    expect(none.card).toBeNull();
    expect(none.tool.content).toMatch(/PDF needs a browser.*Write a \.docx instead/);
  });

  it('refuses wrong extensions and paths outside the project; replacing asks at medium risk', async () => {
    const wrong = await runTool({}, 'create_spreadsheet', {
      path: 'data.csv',
      title: 'Data',
      sheets: [{ name: 'A', columns: [{ header: 'x' }], rows: [] }],
    });
    expect(wrong.tool.content).toMatch(/must end in \.xlsx/);
    const outside = await runTool({}, 'create_presentation', {
      path: '../deck.pptx',
      title: 'Deck',
      slides: [{ title: 'One' }],
    });
    expect(outside.card).toBeNull();
    expect(outside.tool.content).toMatch(/outside|project/i);

    const replace = await runTool(
      { 'deck.pptx': 'old' },
      'create_presentation',
      { path: 'deck.pptx', title: 'Deck', slides: [{ title: 'One', bullets: ['a'] }] },
      { decision: 'reject' },
    );
    expect(replace.card).toMatchObject({
      category: 'file_modify',
      risk: 'medium',
      details: { change: 'modify', outline: ['1. Deck (title slide)', '2. One · 1 bullet'] },
    });
    expect(fs.readFileSync(path.join(replace.root, 'deck.pptx'), 'utf8')).toBe('old');
  });

  it('serves documents for download, never other files; opening needs the desktop app', async () => {
    const root = makeProject({ 'docs/plan.docx': 'PK fake', 'src/app.ts': 'x', '.env': 'K=1' });
    const s = testServices();
    const app = await buildApp(s, { logger: false });
    const project = s.projects.create('p', root);
    const headers = { host: '127.0.0.1:8787', 'x-friday-client': '1' };
    const dl = (p: string) =>
      app.inject({
        method: 'GET',
        url: `/api/projects/${project.id}/download?path=${encodeURIComponent(p)}`,
        headers,
      });
    const doc = await dl('docs/plan.docx');
    expect(doc.statusCode).toBe(200);
    expect(doc.headers['content-disposition']).toMatch(/^attachment; filename="plan\.docx"/);
    expect((await dl('src/app.ts')).statusCode).toBe(400);
    expect((await dl('.env')).statusCode).toBe(403);
    const open = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/open`,
      headers: { ...headers, 'content-type': 'application/json' },
      payload: { path: 'docs/plan.docx' },
    });
    expect(open.statusCode).toBe(409);
  });
});

const chrome = await findChrome();

describe.skipIf(!chrome)('PDF with a real browser', () => {
  it('prints the document, with page numbers and without network or scripts', async () => {
    const pdf = await new ChromeEngine(chrome!).printPdf(documentHtml(META, parseMarkdown(MD)), {
      footerHtml: pdfFooter(META.title),
    });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g)).toHaveLength(2);
  }, 60_000);
});
