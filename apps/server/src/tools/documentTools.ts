import fs from 'node:fs/promises';
import path from 'node:path';
import type { ApprovalDetails } from '@friday/shared';
import { z } from 'zod';
import { CaptureError } from '../browser/capture.js';
import { renderDocx } from '../documents/docx.js';
import { documentHtml, pdfFooter, type DocumentMeta } from '../documents/html.js';
import { outlineOf, parseMarkdown } from '../documents/markdown.js';
import {
  renderPptx,
  renderXlsx,
  sheetNames,
  type SheetSpec,
  type SlideSpec,
} from '../documents/office.js';
import { resolveForWrite, WorkspaceError } from '../workspace/paths.js';
import { atomicWrite, root, sha256 } from './fileTools.js';
import { defineTool, type Proposal, type ToolContext } from './types.js';

/**
 * Documents about the code and the work (reports, plans, roadmaps, overviews) as PDF, Word,
 * Excel or PowerPoint files in the project. Each is a normal approved file change: the card shows
 * the outline, the file is rendered and written only after approval, and it can be undone.
 */

type Format = Extract<ApprovalDetails, { kind: 'document' }>['format'];

const reason = z
  .string()
  .min(3)
  .max(500)
  .describe('Why this document is needed. Shown to the user.');
const title = z.string().trim().min(1).max(200);
const docPath = (ext: string) =>
  z
    .string()
    .min(1)
    .max(1024)
    .describe(
      `Path relative to the project root, ending in ${ext}, e.g. docs/roadmap${ext.split('|')[0]}.`,
    );

const kb = (n: number) => (n < 1024 ? `${n} bytes` : `${Math.round(n / 1024)} KB`);
const today = () =>
  new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

interface Plan {
  rel: string;
  root: string;
  abs: string;
  before: Buffer | null;
  mode: number | undefined;
}

async function planTarget(
  ctx: ToolContext,
  p: string,
  formats: Format[],
): Promise<Plan & { format: Format }> {
  const format = path.extname(p).slice(1).toLowerCase() as Format;
  if (!formats.includes(format))
    throw new WorkspaceError(
      'invalid_path',
      `The path must end in ${formats.map((f) => `.${f}`).join(' or ')}.`,
    );
  const r = await root(ctx);
  const target = await resolveForWrite(r, p);
  const before = target.exists ? await fs.readFile(target.abs) : null;
  return {
    format,
    rel: target.rel,
    root: r,
    abs: target.abs,
    before,
    mode: target.exists ? (await fs.stat(target.abs)).mode : undefined,
  };
}

function proposal(
  plan: Plan & { format: Format },
  docTitle: string,
  outline: string[],
  label: string,
  render: (ctx: ToolContext) => Promise<Buffer>,
): Proposal {
  const verb = plan.before ? 'Replace' : 'Create';
  return {
    title: `${verb} ${plan.rel}`,
    summary: `${verb}s the ${label} ${plan.rel} ("${docTitle}"). It is generated when you approve; you can open it afterwards and undo it like any file change.`,
    category: plan.before ? 'file_modify' : 'file_create',
    risk: plan.before ? 'medium' : 'low',
    details: {
      kind: 'document',
      path: plan.rel,
      format: plan.format,
      change: plan.before ? 'modify' : 'create',
      title: docTitle,
      outline,
    },
    // Office files embed timestamps, so the file itself is rendered only when applying; the
    // approval stays valid as long as the target file is unchanged.
    fingerprint: `${plan.rel}:${plan.before ? sha256(plan.before) : 'absent'}`,
    timeoutMs: 120_000,
    async apply(ctx) {
      const data = await render(ctx);
      await atomicWrite(plan.root, plan.abs, data, plan.mode);
      ctx.recordFileChange?.({
        path: plan.rel,
        fromPath: null,
        change: plan.before ? 'modify' : 'create',
        beforeContent: plan.before,
        beforeHash: plan.before ? sha256(plan.before) : null,
        afterHash: sha256(data),
      });
      const pages =
        plan.format === 'pdf'
          ? data.toString('latin1').match(/\/Type\s*\/Page[^s]/g)?.length
          : null;
      return {
        content: `${plan.before ? 'Replaced' : 'Created'} ${plan.rel} (${label}, ${kb(data.length)}${pages ? `, ${pages} page${pages > 1 ? 's' : ''}` : ''}). The user can open it from the approval card or the file tree.`,
        summary: `${plan.before ? 'replaced' : 'created'} ${plan.rel} (${kb(data.length)})`,
      };
    },
  };
}

export const createDocument = defineTool({
  name: 'create_document',
  description:
    "Write a PDF or Word (.docx) document into the project from Markdown: reports, plans and roadmaps, architecture or code overviews, change summaries, test reports, how-tos. Supports headings, paragraphs, bullet/numbered/task lists (nested by two spaces), tables, code blocks, quotes, rules and page breaks (a line with <!-- pagebreak -->), and bold, italic, inline code and https links inside text. title/subtitle/author form the title block, so do not repeat the title as a heading. Base it on what you actually read in the project. Needs the user's approval (they see the outline); the file can be undone. PDF needs a browser (built into the desktop app; otherwise an installed Chrome); if PDF is unavailable, use .docx.",
  category: 'file_create',
  risk: 'low',
  requiresProject: true,
  schema: z.object({
    path: docPath('.pdf|.docx'),
    title,
    subtitle: z.string().trim().max(300).optional(),
    author: z.string().trim().max(120).optional(),
    content: z.string().min(1).max(300_000).describe('The body, in Markdown.'),
    reason,
  }),
  describeCall: (a) => a.path,
  async prepare(args, ctx): Promise<Proposal> {
    const plan = await planTarget(ctx, args.path, ['pdf', 'docx']);
    if (plan.format === 'pdf' && !ctx.capture)
      throw new WorkspaceError(
        'unsupported',
        'PDF needs a browser, and none is available (install Chrome/Chromium/Edge, or use the desktop app). Write a .docx instead.',
      );
    const blocks = parseMarkdown(args.content);
    const meta: DocumentMeta = {
      title: args.title,
      subtitle: args.subtitle,
      author: args.author,
      date: today(),
    };
    return proposal(
      plan,
      args.title,
      outlineOf(blocks),
      plan.format === 'pdf' ? 'PDF document' : 'Word document',
      async (execCtx) => {
        if (plan.format === 'docx') return renderDocx(meta, blocks);
        try {
          return await execCtx.capture!.engine.printPdf(documentHtml(meta, blocks), {
            footerHtml: pdfFooter(meta.title),
            signal: execCtx.signal,
          });
        } catch (err) {
          if (err instanceof CaptureError) throw new WorkspaceError('unsupported', err.message);
          throw err;
        }
      },
    );
  },
});

const cellValue = z.union([z.string().max(32_000), z.number(), z.boolean(), z.null()]);

export const createSpreadsheet = defineTool({
  name: 'create_spreadsheet',
  description:
    "Write an Excel (.xlsx) workbook into the project: task lists, estimates, inventories (dependencies, endpoints, files), test results, comparisons. One or more sheets, each with typed columns (text, number, integer, currency, percent as a fraction like 0.25, date as YYYY-MM-DD) and rows of values in column order. A styled, frozen header row is added. Values are never written as formulas. Needs the user's approval (they see each sheet's size and columns); the file can be undone.",
  category: 'file_create',
  risk: 'low',
  requiresProject: true,
  schema: z.object({
    path: docPath('.xlsx'),
    title,
    sheets: z
      .array(
        z.object({
          name: z.string().trim().min(1).max(60),
          columns: z
            .array(
              z.object({
                header: z.string().trim().min(1).max(200),
                type: z
                  .enum(['text', 'number', 'integer', 'currency', 'percent', 'date'])
                  .optional(),
                width: z.number().min(4).max(120).optional(),
              }),
            )
            .min(1)
            .max(100),
          rows: z.array(z.array(cellValue).max(100)).max(20_000),
        }),
      )
      .min(1)
      .max(20),
    reason,
  }),
  describeCall: (a) => a.path,
  async prepare(args, ctx): Promise<Proposal> {
    const plan = await planTarget(ctx, args.path, ['xlsx']);
    const sheets = args.sheets as SheetSpec[];
    const names = sheetNames(sheets.map((s) => s.name));
    const outline = sheets.map(
      (s, i) =>
        `${names[i]}: ${s.rows.length} row${s.rows.length === 1 ? '' : 's'} × ${s.columns.length} column${s.columns.length === 1 ? '' : 's'} (${s.columns
          .slice(0, 8)
          .map((c) => c.header)
          .join(', ')}${s.columns.length > 8 ? ', …' : ''})`,
    );
    return proposal(plan, args.title, outline, 'Excel workbook', () => renderXlsx(sheets));
  },
});

export const createPresentation = defineTool({
  name: 'create_presentation',
  description:
    'Write a PowerPoint (.pptx) presentation into the project: project or sprint updates, roadmaps, architecture walkthroughs, release notes. A title slide is generated from title/subtitle/author; then each slide has a title and short bullet points (two leading spaces per nesting level), and/or a small table, plus optional speaker notes. Use layout "section" for divider slides. Keep slides scannable: at most about 6 bullets. Needs the user\'s approval (they see the slide titles); the file can be undone.',
  category: 'file_create',
  risk: 'low',
  requiresProject: true,
  schema: z.object({
    path: docPath('.pptx'),
    title,
    subtitle: z.string().trim().max(300).optional(),
    author: z.string().trim().max(120).optional(),
    slides: z
      .array(
        z.object({
          title: z.string().trim().min(1).max(200),
          layout: z.enum(['content', 'section']).optional(),
          bullets: z.array(z.string().max(500)).max(14).optional(),
          table: z
            .object({
              columns: z.array(z.string().max(200)).min(1).max(8),
              rows: z.array(z.array(z.string().max(500)).max(8)).max(14),
            })
            .optional(),
          notes: z.string().max(5_000).optional(),
        }),
      )
      .min(1)
      .max(80),
    reason,
  }),
  describeCall: (a) => a.path,
  async prepare(args, ctx): Promise<Proposal> {
    const plan = await planTarget(ctx, args.path, ['pptx']);
    const slides = args.slides as SlideSpec[];
    const meta: DocumentMeta = {
      title: args.title,
      subtitle: args.subtitle,
      author: args.author,
      date: today(),
    };
    const outline = [
      `1. ${args.title} (title slide)`,
      ...slides.map(
        (s, i) =>
          `${i + 2}. ${s.title}${s.layout === 'section' ? ' (section)' : ''}${s.bullets?.length ? ` · ${s.bullets.length} bullet${s.bullets.length > 1 ? 's' : ''}` : ''}${s.table ? ` · table ${s.table.rows.length}×${s.table.columns.length}` : ''}${s.notes ? ' · notes' : ''}`,
      ),
    ];
    return proposal(plan, args.title, outline, 'PowerPoint presentation', () =>
      renderPptx(meta, slides),
    );
  },
});
