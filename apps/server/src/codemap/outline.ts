import type { SymbolRow } from './index.js';

/**
 * Render symbols as an outline that fits a character budget. The most detailed level that fits is
 * used: signatures per file (with members when asked), then names per file, then one line per
 * folder. Big repositories therefore get an overview first and detail when narrowed to a folder.
 */

const TOP_LEVEL = (s: SymbolRow) => s.container === null || s.kind !== 'method';

function byFile(symbols: SymbolRow[]): Map<string, SymbolRow[]> {
  const files = new Map<string, SymbolRow[]>();
  for (const s of symbols) {
    const list = files.get(s.path) ?? [];
    list.push(s);
    files.set(s.path, list);
  }
  return files;
}

function detailed(files: Map<string, SymbolRow[]>, members: boolean): string {
  const out: string[] = [];
  for (const [file, list] of files) {
    out.push(file);
    const memberCount = new Map<string, number>();
    for (const s of list)
      if (!TOP_LEVEL(s)) memberCount.set(s.container!, (memberCount.get(s.container!) ?? 0) + 1);
    for (const s of list) {
      if (TOP_LEVEL(s)) {
        const n = memberCount.get(s.name);
        out.push(`  ${s.line}: ${s.signature}${!members && n ? `  [+${n} members]` : ''}`);
      } else if (members) {
        out.push(`    ${s.line}: ${s.signature}`);
      }
    }
  }
  return out.join('\n');
}

function names(files: Map<string, SymbolRow[]>): string {
  const out: string[] = [];
  for (const [file, list] of files) {
    const memberCount = new Map<string, number>();
    for (const s of list)
      if (!TOP_LEVEL(s)) memberCount.set(s.container!, (memberCount.get(s.container!) ?? 0) + 1);
    const top = list.filter(TOP_LEVEL).sort((a, b) => Number(b.exported) - Number(a.exported));
    const shown = top.slice(0, 12).map((s) => {
      const n = memberCount.get(s.name);
      return n ? `${s.name} (${n})` : s.name;
    });
    out.push(`${file}: ${shown.join(', ')}${top.length > 12 ? `, … +${top.length - 12}` : ''}`);
  }
  return out.join('\n');
}

function folders(files: Map<string, SymbolRow[]>, limit: number): string {
  const dirs = new Map<string, { files: number; symbols: number; names: string[] }>();
  for (const [file, list] of files) {
    const dir = file.includes('/') ? `${file.slice(0, file.lastIndexOf('/'))}/` : './';
    const d = dirs.get(dir) ?? { files: 0, symbols: 0, names: [] };
    d.files++;
    d.symbols += list.length;
    for (const s of list)
      if (s.exported && TOP_LEVEL(s) && d.names.length < 6) d.names.push(s.name);
    dirs.set(dir, d);
  }
  const lines = [...dirs].map(
    ([dir, d]) =>
      `${dir} (${d.files} file${d.files === 1 ? '' : 's'}, ${d.symbols} definitions)${d.names.length ? `: ${d.names.join(', ')}, …` : ''}`,
  );
  const out: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > limit) {
      out.push(`… ${lines.length - out.length} more folders: pass a narrower path`);
      break;
    }
    out.push(line);
    used += line.length + 1;
  }
  return out.join('\n');
}

export interface Outline {
  text: string;
  level: 'signatures' | 'names' | 'folders';
}

export function renderOutline(
  symbols: SymbolRow[],
  opts: { members: boolean; budget: number },
): Outline {
  const files = byFile(symbols);
  const full = detailed(files, opts.members);
  if (full.length <= opts.budget) return { text: full, level: 'signatures' };
  const short = names(files);
  if (short.length <= opts.budget) return { text: short, level: 'names' };
  return { text: folders(files, opts.budget), level: 'folders' };
}
