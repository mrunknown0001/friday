import type { Language } from '../codemap/extract.js';

/**
 * A small lexer for refactoring: it tells code apart from comments and strings, so a rename can
 * change code and list mentions in comments and strings separately. It is language-aware only as
 * far as comment and string syntax goes; it doesn't parse.
 */

export type Region = 'code' | 'comment' | 'string';

interface Syntax {
  line: string[];
  block: Array<[string, string]>;
  /** String delimiters, longest first (Python's triple quotes before single ones). */
  quotes: string[];
  /** JS template literals: `...${code}...`. */
  template: boolean;
  /** Characters a backslash escapes inside strings. */
  escapes: boolean;
}

const C_LIKE: Syntax = {
  line: ['//'],
  block: [['/*', '*/']],
  quotes: ['"', "'"],
  template: false,
  escapes: true,
};

const SYNTAX: Record<Language, Syntax> = {
  typescript: { ...C_LIKE, quotes: ['"', "'"], template: true },
  python: {
    line: ['#'],
    block: [],
    quotes: ['"""', "'''", '"', "'"],
    template: false,
    escapes: true,
  },
  php: { ...C_LIKE, line: ['//', '#'] },
  go: { ...C_LIKE, quotes: ['"', '`', "'"] },
  rust: { ...C_LIKE, quotes: ['"'] },
  ruby: {
    line: ['#'],
    block: [['=begin', '=end']],
    quotes: ['"', "'"],
    template: false,
    escapes: true,
  },
  java: { ...C_LIKE, quotes: ['"""', '"', "'"] },
  kotlin: { ...C_LIKE, quotes: ['"""', '"', "'"] },
  csharp: { ...C_LIKE, quotes: ['"', "'"] },
};

/** Region of every character of `text`. */
export function regions(text: string, language: Language | null): Uint8Array {
  const out = new Uint8Array(text.length); // 0 code, 1 comment, 2 string
  // Not a language Friday knows: all of it counts as text to search.
  if (!language) return out;
  const syn = SYNTAX[language];
  let i = 0;
  // Brace depth inside each open template literal's ${...}.
  const templates: number[] = [];
  const startsWith = (s: string) => text.startsWith(s, i);
  const fill = (from: number, to: number, kind: number) => out.fill(kind, from, to);
  while (i < text.length) {
    const ch = text[i]!;
    if (templates.length) {
      if (ch === '{') templates[templates.length - 1]!++;
      else if (ch === '}') {
        if (templates.at(-1) === 0) {
          templates.pop();
          i = scanTemplate(i + 1);
          continue;
        }
        templates[templates.length - 1]!--;
      }
    }
    const line = syn.line.find(startsWith);
    if (line) {
      const end = text.indexOf('\n', i);
      const stop = end < 0 ? text.length : end;
      fill(i, stop, 1);
      i = stop;
      continue;
    }
    const block = syn.block.find(([open]) => startsWith(open));
    if (block) {
      const end = text.indexOf(block[1], i + block[0].length);
      const stop = end < 0 ? text.length : end + block[1].length;
      fill(i, stop, 1);
      i = stop;
      continue;
    }
    if (syn.template && ch === '`') {
      i = scanTemplate(i + 1, i);
      continue;
    }
    const quote = syn.quotes.find(startsWith);
    if (quote) {
      const start = i;
      i += quote.length;
      while (i < text.length && !startsWith(quote)) {
        if (syn.escapes && text[i] === '\\') i++;
        // Single-line strings end at the line end (unterminated); triple-quoted ones don't.
        else if (quote.length === 1 && quote !== '`' && text[i] === '\n') break;
        i++;
      }
      i = Math.min(text.length, i + (startsWith(quote) ? quote.length : 0));
      fill(start, i, 2);
      continue;
    }
    i++;
  }
  return out;

  /** Scan template text from `from` up to the closing backtick or a `${`. */
  function scanTemplate(from: number, start = from): number {
    let j = from;
    while (j < text.length) {
      if (text[j] === '\\') j += 2;
      else if (text[j] === '`') {
        fill(start, j + 1, 2);
        return j + 1;
      } else if (text[j] === '$' && text[j + 1] === '{') {
        fill(start, j + 2, 2);
        templates.push(0);
        return j + 2;
      } else j++;
    }
    fill(start, text.length, 2);
    return text.length;
  }
}

export interface Occurrence {
  /** Character offset of the name. */
  offset: number;
  line: number;
  region: Region;
  /** What comes right before the name: ".", "?.", "->", "::", "\\" (PHP namespaces) or null. */
  accessor: string | null;
  /** The identifier before the accessor (`this` in `this.total`), if any. */
  receiver: string | null;
  lineText: string;
}

const WORD = /[\w$]/;
const REGION_NAME: Region[] = ['code', 'comment', 'string'];

/** Whole-word occurrences of `name`, each with its region and how it is accessed. */
export function occurrences(text: string, name: string, language: Language | null): Occurrence[] {
  const reg = regions(text, language);
  const out: Occurrence[] = [];
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
  let from = 0;
  for (;;) {
    const at = text.indexOf(name, from);
    if (at < 0) break;
    from = at + name.length;
    if (WORD.test(text[at - 1] ?? '') || WORD.test(text[at + name.length] ?? '')) continue;
    // PHP variables: $name is a different thing from name.
    if (language === 'php' && text[at - 1] === '$') continue;
    let j = at - 1;
    while (j >= 0 && (text[j] === ' ' || text[j] === '\t')) j--;
    let accessor: string | null = null;
    for (const a of ['?.', '->', '::', '.', '\\']) {
      if (text.slice(j - a.length + 1, j + 1) === a) {
        // A spread (`...name`) is not a member access.
        if (a === '.' && text.slice(j - 2, j + 1) === '...') break;
        accessor = a;
        j -= a.length;
        break;
      }
    }
    let receiver: string | null = null;
    if (accessor) {
      while (j >= 0 && (text[j] === ' ' || text[j] === '\t')) j--;
      let k = j;
      while (k >= 0 && WORD.test(text[k]!)) k--;
      if (k < j) receiver = text.slice(k + 1, j + 1).replace(/^\$/, '');
      if (k >= 0 && text[k] === '$') receiver = text.slice(k + 1, j + 1);
    }
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= at) lo = mid;
      else hi = mid - 1;
    }
    const end = text.indexOf('\n', lineStarts[lo]!);
    out.push({
      offset: at,
      line: lo + 1,
      region: REGION_NAME[reg[at]!]!,
      accessor,
      receiver,
      lineText: text.slice(lineStarts[lo]!, end < 0 ? text.length : end),
    });
  }
  return out;
}

/** Replace the name at these offsets (all for the same old name). */
export function replaceAt(
  text: string,
  offsets: number[],
  oldName: string,
  newName: string,
): string {
  let out = '';
  let last = 0;
  for (const at of [...offsets].sort((a, b) => a - b)) {
    out += text.slice(last, at) + newName;
    last = at + oldName.length;
  }
  return out + text.slice(last);
}
