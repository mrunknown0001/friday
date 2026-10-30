/**
 * The Markdown subset documents are written in: headings, paragraphs, bullet and numbered lists
 * (nested, task boxes), tables, code blocks, quotes, rules and page breaks, with bold, italic,
 * inline code and links inside text. Parsed once into blocks that the PDF (HTML) and Word
 * renderers share. Raw HTML is not interpreted: it stays visible text.
 */

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'strong'; c: Inline[] }
  | { t: 'em'; c: Inline[] }
  | { t: 'code'; v: string }
  | { t: 'link'; c: Inline[]; href: string };

export interface ListItem {
  c: Inline[];
  /** 0 = top level. */
  level: number;
  ordered: boolean;
  /** Task list box: true (checked), false (open), null (none). */
  checked: boolean | null;
}

export type Align = 'left' | 'center' | 'right' | null;

export type Block =
  | { t: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; c: Inline[] }
  | { t: 'para'; c: Inline[] }
  | { t: 'list'; items: ListItem[] }
  | { t: 'code'; lang: string; v: string }
  | { t: 'quote'; c: Inline[] }
  | { t: 'table'; head: Inline[][]; rows: Inline[][][]; align: Align[] }
  | { t: 'hr' }
  | { t: 'pagebreak' };

const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const FENCE = /^\s*(```|~~~)\s*([\w+-]*)\s*$/;

/** Only links that are safe to put in a document. */
export function safeHref(href: string): string | null {
  return /^(https?:\/\/|mailto:)/i.test(href.trim()) ? href.trim() : null;
}

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = '';
  const flush = () => {
    if (text) out.push({ t: 'text', v: text });
    text = '';
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === '\\' && i + 1 < src.length && /[\\`*_[\]()#+\-.!|~]/.test(src[i + 1]!)) {
      text += src[i + 1];
      i += 2;
      continue;
    }
    if (ch === '`') {
      const end = src.indexOf('`', i + 1);
      if (end > i) {
        flush();
        out.push({ t: 'code', v: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    const double = src.slice(i, i + 2);
    if (double === '**' || double === '__') {
      const end = src.indexOf(double, i + 2);
      if (end > i + 2) {
        flush();
        out.push({ t: 'strong', c: parseInline(src.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if ((ch === '*' || ch === '_') && src[i + 1] !== ' ') {
      const end = src.indexOf(ch, i + 1);
      // `_` inside words (snake_case) is not emphasis.
      const wordy = ch === '_' && /\w/.test(src[i - 1] ?? '');
      if (end > i + 1 && !wordy && src[end - 1] !== ' ') {
        flush();
        out.push({ t: 'em', c: parseInline(src.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }
    if (ch === '[') {
      const m = /^\[([^\]]*)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/.exec(src.slice(i));
      if (m) {
        flush();
        const href = safeHref(m[2]!);
        if (href) out.push({ t: 'link', c: parseInline(m[1]!), href });
        else out.push(...parseInline(m[1]!));
        i += m[0].length;
        continue;
      }
    }
    text += ch;
    i++;
  }
  flush();
  return out;
}

function cells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  const endPara = () => {
    if (para.length) blocks.push({ t: 'para', c: parseInline(para.join(' ')) });
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = FENCE.exec(line);
    if (fence) {
      endPara();
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i]!.trim().startsWith(fence[1]!); i++)
        body.push(lines[i]!);
      blocks.push({ t: 'code', lang: fence[2] ?? '', v: body.join('\n') });
      continue;
    }
    if (!line.trim()) {
      endPara();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      endPara();
      blocks.push({
        t: 'heading',
        level: heading[1]!.length as 1 | 2 | 3 | 4 | 5 | 6,
        c: parseInline(heading[2]!),
      });
      continue;
    }
    if (/^\s*(<!--\s*pagebreak\s*-->|\\pagebreak)\s*$/i.test(line)) {
      endPara();
      blocks.push({ t: 'pagebreak' });
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      endPara();
      blocks.push({ t: 'hr' });
      continue;
    }
    if (/^\s*>/.test(line)) {
      endPara();
      const quote: string[] = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]!); i++)
        quote.push(lines[i]!.replace(/^\s*>\s?/, ''));
      i--;
      blocks.push({ t: 'quote', c: parseInline(quote.join(' ')) });
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!)) {
      endPara();
      const head = cells(line);
      const align = cells(lines[i + 1]!).map((c): Align =>
        c.startsWith(':') && c.endsWith(':')
          ? 'center'
          : c.endsWith(':')
            ? 'right'
            : c.startsWith(':')
              ? 'left'
              : null,
      );
      const rows: Inline[][][] = [];
      for (i += 2; i < lines.length && lines[i]!.includes('|') && lines[i]!.trim(); i++) {
        const r = cells(lines[i]!);
        rows.push(head.map((_, k) => parseInline(r[k] ?? '')));
      }
      i--;
      blocks.push({ t: 'table', head: head.map(parseInline), rows, align });
      continue;
    }
    const item = LIST.exec(line);
    if (item) {
      endPara();
      const items: ListItem[] = [];
      for (; i < lines.length; i++) {
        const l = lines[i]!;
        // Blank lines between items keep the list going ("loose" lists), if a same-kind item follows.
        if (!l.trim()) {
          let j = i + 1;
          while (j < lines.length && !lines[j]!.trim()) j++;
          const next = j < lines.length ? LIST.exec(lines[j]!) : null;
          const nextLevel = next ? Math.floor(next[1]!.replace(/\t/g, '  ').length / 2) : 0;
          if (next && (nextLevel > 0 || /\d/.test(next[2]!) === items[0]!.ordered)) {
            i = j - 1;
            continue;
          }
          break;
        }
        const m = LIST.exec(l);
        const topLevelSwitch =
          m &&
          items.length &&
          Math.floor(m[1]!.replace(/\t/g, '  ').length / 2) === 0 &&
          /\d/.test(m[2]!) !== items[0]!.ordered;
        if (topLevelSwitch) break;
        if (m) {
          let text = m[3]!;
          let checked: boolean | null = null;
          const box = /^\[([ xX])\]\s+(.*)$/.exec(text);
          if (box) {
            checked = box[1] !== ' ';
            text = box[2]!;
          }
          items.push({
            c: parseInline(text),
            level: Math.min(Math.floor(m[1]!.replace(/\t/g, '  ').length / 2), 3),
            ordered: /\d/.test(m[2]!),
            checked,
          });
        } else if (l.trim() && /^\s+\S/.test(l) && items.length) {
          // Continuation of the previous item.
          const last = items.at(-1)!;
          last.c.push({ t: 'text', v: ' ' }, ...parseInline(l.trim()));
        } else break;
      }
      i--;
      blocks.push({ t: 'list', items });
      continue;
    }
    para.push(line.trim());
  }
  endPara();
  return blocks;
}

export function inlineText(c: Inline[]): string {
  return c.map((x) => (x.t === 'text' || x.t === 'code' ? x.v : inlineText(x.c))).join('');
}

/** A short outline for the approval card: headings, plus counts of what else is inside. */
export function outlineOf(blocks: Block[]): string[] {
  const out: string[] = [];
  let tables = 0;
  let code = 0;
  let words = 0;
  const top = Math.min(7, ...blocks.flatMap((b) => (b.t === 'heading' ? [b.level] : [])));
  for (const b of blocks) {
    if (b.t === 'heading' && b.level <= top + 2 && out.length < 40)
      out.push(`${'  '.repeat(b.level - top)}${inlineText(b.c)}`);
    if (b.t === 'table') tables++;
    if (b.t === 'code') code++;
    if (b.t === 'para' || b.t === 'quote') words += inlineText(b.c).split(/\s+/).length;
    if (b.t === 'list') for (const it of b.items) words += inlineText(it.c).split(/\s+/).length;
  }
  out.push(
    `~${words} words${tables ? `, ${tables} table${tables > 1 ? 's' : ''}` : ''}${code ? `, ${code} code block${code > 1 ? 's' : ''}` : ''}`,
  );
  return out;
}
