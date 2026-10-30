import PptxGenJSModule from 'pptxgenjs';
import writeXlsxFile, { type Cell, type Row, type Sheet } from 'write-excel-file/node';
import type { DocumentMeta } from './html.js';

// ---------------------------------------------------------------- spreadsheets

export type ColumnType = 'text' | 'number' | 'integer' | 'currency' | 'percent' | 'date';

export interface SheetSpec {
  name: string;
  columns: Array<{ header: string; type?: ColumnType | undefined; width?: number | undefined }>;
  rows: Array<Array<string | number | boolean | null>>;
}

const FORMATS: Partial<Record<ColumnType, string>> = {
  integer: '#,##0',
  currency: '#,##0.00',
  percent: '0.0%',
  date: 'yyyy-mm-dd',
};

/** Excel sheet names: at most 31 characters, none of \ / ? * [ ] :, unique. */
export function sheetNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((raw, i) => {
    let name =
      raw
        .replace(/[\\/?*[\]:]/g, ' ')
        .trim()
        .slice(0, 31) || `Sheet${i + 1}`;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${name.slice(0, 28)} ${n}`;
    used.add(name.toLowerCase());
    return name;
  });
}

function cell(value: string | number | boolean | null, type: ColumnType | undefined): Cell {
  if (value === null || value === '') return null;
  // Strings are always written as text: a value starting with "=" never becomes a formula.
  if (type === 'date' && typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return { value: d, type: Date, format: FORMATS.date };
  }
  if (typeof value === 'number') {
    const format = type ? FORMATS[type] : undefined;
    return { value, type: Number, ...(format ? { format } : {}) };
  }
  if (typeof value === 'boolean') return { value, type: Boolean };
  return { value: value.slice(0, 32_000), type: String, wrap: value.length > 60 };
}

export async function renderXlsx(sheets: SheetSpec[]): Promise<Buffer> {
  const names = sheetNames(sheets.map((s) => s.name));
  const out: Array<Sheet<Buffer>> = sheets.map((s, i) => {
    const header: Row = s.columns.map((c) => ({
      value: c.header,
      type: String,
      fontWeight: 'bold',
      textColor: '#0C4A6E',
      backgroundColor: '#E0F2FE',
      bottomBorderStyle: 'thin',
      bottomBorderColor: '#0369A1',
    }));
    const data: Row[] = s.rows.map((r) => s.columns.map((c, k) => cell(r[k] ?? null, c.type)));
    return {
      sheet: names[i]!,
      data: [header, ...data],
      stickyRowsCount: 1,
      columns: s.columns.map((c, k) => ({
        width:
          c.width ??
          Math.min(
            60,
            Math.max(
              10,
              c.header.length + 2,
              ...s.rows.slice(0, 500).map((r) => String(r[k] ?? '').length + 2),
            ),
          ),
      })),
    };
  });
  return writeXlsxFile(out, { fontFamily: 'Calibri', fontSize: 11 }).toBuffer();
}

// ---------------------------------------------------------------- presentations

export interface SlideSpec {
  title: string;
  layout?: 'content' | 'section' | undefined;
  /** Bullet points; two leading spaces per nesting level. */
  bullets?: string[] | undefined;
  table?: { columns: string[]; rows: string[][] } | undefined;
  notes?: string | undefined;
}

// At runtime the default import is the class; its types describe a CommonJS module wrapping it.
const PptxGenJS = PptxGenJSModule as unknown as typeof PptxGenJSModule.default;

const C = { accent: '0369A1', dark: '0C4A6E', text: '1F2937', muted: '6B7280', light: 'E0F2FE' };
const FONT = 'Calibri';

export async function renderPptx(meta: DocumentMeta, slides: SlideSpec[]): Promise<Buffer> {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE'; // 13.33 × 7.5 in
  pptx.title = meta.title;
  pptx.author = meta.author ?? 'Friday';
  pptx.company = '';
  pptx.defineSlideMaster({
    title: 'FRIDAY_CONTENT',
    background: { color: 'FFFFFF' },
    objects: [
      { rect: { x: 0, y: 0, w: 13.33, h: 0.12, fill: { color: C.accent } } },
      {
        text: {
          text: meta.title,
          options: { x: 0.5, y: 7.0, w: 9, h: 0.3, fontFace: FONT, fontSize: 10, color: C.muted },
        },
      },
    ],
    slideNumber: { x: 12.3, y: 7.0, w: 0.6, h: 0.3, fontFace: FONT, fontSize: 10, color: C.muted },
  });

  // Title slide.
  const first = pptx.addSlide();
  first.background = { color: C.dark };
  first.addShape(pptx.ShapeType.rect, {
    x: 0.8,
    y: 4.15,
    w: 1.6,
    h: 0.08,
    fill: { color: '38BDF8' },
  });
  first.addText(meta.title, {
    x: 0.8,
    y: 2.0,
    w: 11.7,
    h: 2.0,
    fontFace: FONT,
    fontSize: 40,
    bold: true,
    color: 'FFFFFF',
    valign: 'bottom',
    fit: 'shrink',
  });
  first.addText(
    [meta.subtitle, [meta.author, meta.date].filter(Boolean).join(' · ')]
      .filter(Boolean)
      .join('\n'),
    {
      x: 0.8,
      y: 4.4,
      w: 11.7,
      h: 1.4,
      fontFace: FONT,
      fontSize: 18,
      color: 'CBD5E1',
      valign: 'top',
    },
  );

  for (const s of slides) {
    const slide = pptx.addSlide({ masterName: 'FRIDAY_CONTENT' });
    if (s.notes) slide.addNotes(s.notes);
    if (s.layout === 'section') {
      slide.addText(s.title, {
        x: 0.8,
        y: 2.6,
        w: 11.7,
        h: 1.6,
        fontFace: FONT,
        fontSize: 36,
        bold: true,
        color: C.dark,
        valign: 'middle',
        fit: 'shrink',
      });
      continue;
    }
    slide.addText(s.title, {
      x: 0.5,
      y: 0.35,
      w: 12.3,
      h: 0.9,
      fontFace: FONT,
      fontSize: 28,
      bold: true,
      color: C.dark,
      valign: 'middle',
      fit: 'shrink',
    });
    const hasTable = !!s.table?.rows.length;
    const top = 1.45;
    if (s.bullets?.length) {
      slide.addText(
        s.bullets.map((b) => {
          const level = Math.min(Math.floor((b.length - b.trimStart().length) / 2), 3);
          return {
            text: b.trim().replace(/^[-*•]\s+/, ''),
            options: { bullet: { indent: 18 }, indentLevel: level, breakLine: true },
          };
        }),
        {
          x: 0.6,
          y: top,
          w: hasTable ? 5.6 : 12.1,
          h: 5.3,
          fontFace: FONT,
          fontSize: 20,
          color: C.text,
          valign: 'top',
          paraSpaceAfter: 6,
          fit: 'shrink',
        },
      );
    }
    if (hasTable) {
      const t = s.table!;
      const header = t.columns.map((c) => ({
        text: c,
        options: { bold: true, color: C.dark, fill: { color: C.light } },
      }));
      const rows = t.rows.map((r) => t.columns.map((_, k) => ({ text: r[k] ?? '' })));
      slide.addTable([header, ...rows], {
        x: s.bullets?.length ? 6.5 : 0.6,
        y: top,
        w: s.bullets?.length ? 6.2 : 12.1,
        fontFace: FONT,
        fontSize: 14,
        color: C.text,
        border: { type: 'solid', pt: 0.75, color: 'D1D5DB' },
        autoPage: false,
      });
    }
  }
  return (await pptx.write({ outputType: 'nodebuffer' })) as Buffer;
}
