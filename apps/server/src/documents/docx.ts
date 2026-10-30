import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Footer,
  HeadingLevel,
  LevelFormat,
  Packer,
  PageBreak,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type IRunOptions,
  type ParagraphChild,
} from 'docx';
import type { DocumentMeta } from './html.js';
import type { Block, Inline } from './markdown.js';

/** The same clean style as the PDFs, in Word terms (sizes are half-points, colours hex). */
const ACCENT = '0369A1';
const HEADING = '0C4A6E';
const MONO = 'Consolas';
const BODY_FONT = 'Calibri';

const HEADINGS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
] as const;

function runs(c: Inline[], style: IRunOptions = {}): ParagraphChild[] {
  return c.flatMap((x): ParagraphChild[] => {
    switch (x.t) {
      case 'text':
        return [new TextRun({ ...style, text: x.v })];
      case 'code':
        return [
          new TextRun({
            ...style,
            text: x.v,
            font: MONO,
            size: 19,
            shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'F3F4F6' },
          }),
        ];
      case 'strong':
        return runs(x.c, { ...style, bold: true });
      case 'em':
        return runs(x.c, { ...style, italics: true });
      case 'link':
        return [
          new ExternalHyperlink({
            link: x.href,
            children: runs(x.c, { ...style, color: ACCENT, underline: {} }) as TextRun[],
          }),
        ];
    }
  });
}

const thin = { style: BorderStyle.SINGLE, size: 4, color: 'D1D5DB' };

function table(b: Extract<Block, { t: 'table' }>): Table {
  const align = (k: number) =>
    b.align[k] === 'center'
      ? AlignmentType.CENTER
      : b.align[k] === 'right'
        ? AlignmentType.RIGHT
        : AlignmentType.LEFT;
  const cell = (c: Inline[], k: number, header: boolean, shade: string | null) =>
    new TableCell({
      children: [
        new Paragraph({
          alignment: align(k),
          children: runs(c, header ? { bold: true, color: HEADING } : {}),
        }),
      ],
      ...(shade ? { shading: { type: ShadingType.CLEAR, color: 'auto', fill: shade } } : {}),
      margins: { top: 60, bottom: 60, left: 100, right: 100 },
    });
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: thin,
      bottom: thin,
      left: thin,
      right: thin,
      insideHorizontal: thin,
      insideVertical: thin,
    },
    rows: [
      new TableRow({
        tableHeader: true,
        children: b.head.map((h, k) => cell(h, k, true, 'E0F2FE')),
      }),
      ...b.rows.map(
        (r, i) =>
          new TableRow({ children: r.map((c, k) => cell(c, k, false, i % 2 ? 'F9FAFB' : null)) }),
      ),
    ],
  });
}

function blocksToDocx(blocks: Block[]): Array<Paragraph | Table> {
  const out: Array<Paragraph | Table> = [];
  // Each numbered list restarts at 1 (its own numbering instance).
  let listInstance = 0;
  for (const b of blocks) {
    switch (b.t) {
      case 'heading':
        out.push(new Paragraph({ heading: HEADINGS[b.level - 1], children: runs(b.c) }));
        break;
      case 'para':
        out.push(new Paragraph({ children: runs(b.c), spacing: { after: 120 } }));
        break;
      case 'quote':
        out.push(
          new Paragraph({
            children: runs(b.c, { italics: true, color: '374151' }),
            indent: { left: 360 },
            border: { left: { style: BorderStyle.SINGLE, size: 18, color: '93C5FD', space: 8 } },
            spacing: { after: 160 },
          }),
        );
        break;
      case 'code':
        b.v.split('\n').forEach((line, i, all) =>
          out.push(
            new Paragraph({
              children: [new TextRun({ text: line || ' ', font: MONO, size: 18 })],
              shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'F8FAFC' },
              border: { left: { style: BorderStyle.SINGLE, size: 18, color: ACCENT, space: 8 } },
              indent: { left: 120 },
              spacing: { before: 0, after: i === all.length - 1 ? 160 : 0, line: 260 },
              keepLines: true,
            }),
          ),
        );
        break;
      case 'hr':
        out.push(
          new Paragraph({
            border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'E5E7EB', space: 1 } },
            spacing: { after: 160 },
          }),
        );
        break;
      case 'pagebreak':
        out.push(new Paragraph({ children: [new PageBreak()] }));
        break;
      case 'table':
        out.push(table(b), new Paragraph({ spacing: { after: 80 } }));
        break;
      case 'list':
        listInstance++;
        for (const it of b.items) {
          const box = it.checked === null ? [] : [new TextRun(it.checked ? '☑ ' : '☐ ')];
          out.push(
            new Paragraph({
              children: [...box, ...runs(it.c)],
              ...(it.ordered
                ? { numbering: { reference: 'numbered', level: it.level, instance: listInstance } }
                : { bullet: { level: it.level } }),
              spacing: { after: 40 },
            }),
          );
        }
        break;
    }
  }
  return out;
}

export async function renderDocx(meta: DocumentMeta, blocks: Block[]): Promise<Buffer> {
  const doc = new Document({
    title: meta.title,
    creator: meta.author ?? 'Friday',
    description: meta.subtitle ?? '',
    styles: {
      default: {
        document: {
          run: { font: BODY_FONT, size: 21, color: '1F2937' },
          paragraph: { spacing: { line: 300 } },
        },
        title: { run: { font: BODY_FONT, size: 52, bold: true, color: HEADING } },
        heading1: {
          run: { font: BODY_FONT, size: 34, bold: true, color: HEADING },
          paragraph: { spacing: { before: 320, after: 120 } },
        },
        heading2: {
          run: { font: BODY_FONT, size: 28, bold: true, color: HEADING },
          paragraph: { spacing: { before: 260, after: 100 } },
        },
        heading3: {
          run: { font: BODY_FONT, size: 24, bold: true, color: HEADING },
          paragraph: { spacing: { before: 220, after: 80 } },
        },
        heading4: { run: { font: BODY_FONT, size: 21, bold: true, color: HEADING } },
        heading5: { run: { font: BODY_FONT, size: 21, bold: true, color: HEADING } },
        heading6: { run: { font: BODY_FONT, size: 21, italics: true, color: HEADING } },
      },
    },
    numbering: {
      config: [
        {
          reference: 'numbered',
          levels: [0, 1, 2, 3].map((level) => ({
            level,
            format: [
              LevelFormat.DECIMAL,
              LevelFormat.LOWER_LETTER,
              LevelFormat.LOWER_ROMAN,
              LevelFormat.DECIMAL,
            ][level]!,
            text: `%${level + 1}.`,
            alignment: AlignmentType.START,
            style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
          })),
        },
      ],
    },
    sections: [
      {
        properties: { page: { margin: { top: 1250, bottom: 1250, left: 1130, right: 1130 } } },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [
                  new TextRun({ text: `${meta.title}   ·   `, size: 16, color: '6B7280' }),
                  new TextRun({ children: [PageNumber.CURRENT], size: 16, color: '6B7280' }),
                ],
              }),
            ],
          }),
        },
        children: [
          new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(meta.title)] }),
          ...(meta.subtitle
            ? [
                new Paragraph({
                  children: [new TextRun({ text: meta.subtitle, size: 26, color: '374151' })],
                }),
              ]
            : []),
          new Paragraph({
            children: [
              new TextRun({
                text: [meta.author, meta.date].filter(Boolean).join(' · '),
                size: 18,
                color: '6B7280',
              }),
            ],
            border: { bottom: { style: BorderStyle.SINGLE, size: 18, color: ACCENT, space: 6 } },
            spacing: { after: 320 },
          }),
          ...blocksToDocx(blocks),
        ],
      },
    ],
  });
  return Packer.toBuffer(doc);
}
