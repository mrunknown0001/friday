import fs from 'node:fs/promises';
import type { RefactorMatch } from '@friday/shared';
import { languageOf } from '../codemap/extract.js';
import { isSecretPath, resolveForWrite, WorkspaceError } from '../workspace/paths.js';
import { occurrences, regions } from './lexer.js';
import { parseJsStatements, relativeSpec, type JsSpecifier, type JsStatement } from './modules.js';
import type { References } from './references.js';

/**
 * Moving a top-level TypeScript/JavaScript definition to another file: the definition (with its
 * doc comment) moves, the imports it uses come along (re-pointed from the new file), names from
 * the old file it uses are imported from there (and exported if they weren't), the old file
 * imports it back if it still uses it, and every file that imports it from the old file is
 * updated. Text only; the result is shown as a diff for approval.
 */

export interface MovePlan {
  target: string;
  files: Array<{ path: string; before: string | null; after: string }>;
  importsUpdated: number;
  notChanged: RefactorMatch[];
  notes: string[];
}

const MOVABLE = new Set(['function', 'class', 'interface', 'type', 'enum', 'const']);

type Edit = [start: number, end: number, text: string];

function applyEdits(text: string, edits: Edit[]): string {
  let out = text;
  for (const [s, e, t] of [...edits].sort((a, b) => b[0] - a[0]))
    out = out.slice(0, s) + t + out.slice(e);
  return out;
}

const lineStart = (text: string, at: number) => text.lastIndexOf('\n', at - 1) + 1;
const lineEnd = (text: string, at: number) => {
  const e = text.indexOf('\n', at);
  return e < 0 ? text.length : e + 1;
};

/** Offsets of the definition, from its doc comment/decorators to its end (newline included). */
export function definitionRange(
  text: string,
  line: number,
): { start: number; declStart: number; end: number } {
  const reg = regions(text, 'typescript');
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  const declStart = starts[line - 1]!;

  // Comments and decorators directly above belong to it.
  let start = declStart;
  for (let l = line - 2; l >= 0; l--) {
    const s = starts[l]!;
    const e = starts[l + 1]! - 1;
    const content = text.slice(s, e).trim();
    if (!content) break;
    const firstCode = s + text.slice(s, e).search(/\S/);
    if (reg[firstCode] === 1 || content.startsWith('@')) start = s;
    else break;
  }

  const head = text.slice(declStart, lineEnd(text, declStart));
  const blockKind =
    /^\s*(export\s+)?(default\s+)?(declare\s+)?(abstract\s+)?(async\s+)?(function|class|interface|enum|namespace|module)\b/.test(
      head,
    );
  let depth = 0;
  let sawEquals = false;
  let i = declStart;
  const end = (at: number) => {
    // A semicolon right after a closing brace, and the rest of the line, come along.
    let j = at;
    while (j < text.length && (text[j] === ' ' || text[j] === '\t')) j++;
    if (text[j] === ';') j++;
    return { start, declStart, end: lineEnd(text, j) };
  };
  for (; i < text.length; i++) {
    if (reg[i] !== 0) continue;
    const ch = text[i]!;
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0 && ch === '}' && blockKind && !sawEquals) return end(i + 1);
    } else if (
      depth === 0 &&
      ch === '=' &&
      text[i + 1] !== '>' &&
      text[i - 1] !== '=' &&
      text[i + 1] !== '='
    )
      sawEquals = true;
    else if (depth === 0 && ch === ';') return end(i + 1);
    else if (depth === 0 && ch === '\n' && (sawEquals || !blockKind)) {
      // Without semicolons, a statement ends at a line that doesn't continue on the next one.
      const before = text.slice(declStart, i).replace(/\s+$/, '');
      const next = text.slice(i + 1).match(/^\s*(\S)/)?.[1] ?? '';
      if (
        before.length > head.trim().length - 1 &&
        !/[=+\-*/%&|^!?:,([{.<>]$|=>$/.test(before) &&
        !/^[.?:+\-*/%&|^,)\]}]/.test(next)
      )
        return { start, declStart, end: i + 1 };
    }
  }
  return { start, declStart, end: text.length };
}

const IDENT = /[A-Za-z_$][\w$]*/g;

/** Names a block of code refers to (not members, not object keys). */
export function usedNames(code: string): Set<string> {
  const reg = regions(code, 'typescript');
  const out = new Set<string>();
  for (const m of code.matchAll(IDENT)) {
    if (reg[m.index] !== 0) continue;
    const before = code.slice(0, m.index).replace(/\s+$/, '');
    if (before.endsWith('.') && !before.endsWith('...')) continue;
    const after = code.slice(m.index + m[0].length).match(/^\s*(\S)/)?.[1];
    if (after === ':' && /[{,]$/.test(before)) continue;
    out.add(m[0]);
  }
  return out;
}

/** Top-level declarations of a file: name to the offset of its line and whether it is exported. */
export function topLevelDeclarations(text: string): Map<string, { at: number; exported: boolean }> {
  const reg = regions(text, 'typescript');
  const out = new Map<string, { at: number; exported: boolean }>();
  const re =
    /^(export\s+)?(declare\s+)?(default\s+)?(abstract\s+)?(async\s+)?(function\s*\*?|class|interface|type|enum|const\s+enum|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
  for (const m of text.matchAll(re)) {
    if (reg[m.index] !== 0 || m[3]) continue;
    if (!out.has(m[7]!)) out.set(m[7]!, { at: m.index, exported: !!m[1] });
  }
  return out;
}

const fmtSpecifier = (s: JsSpecifier) =>
  `${s.type ? 'type ' : ''}${s.imported === s.local ? s.imported : `${s.imported} as ${s.local}`}`;

interface Style {
  quote: string;
  semi: string;
}

function styleOf(text: string, statements: JsStatement[]): Style {
  const st = statements.find((s) => s.kind === 'import');
  const sample = st ? text.slice(st.start, st.end) : '';
  return {
    quote: sample.includes('"') && !sample.includes("'") ? '"' : "'",
    semi: st ? (sample.trimEnd().endsWith(';') ? ';' : '') : /;\s*$/m.test(text) ? ';' : '',
  };
}

function importLine(
  kind: 'import' | 'export',
  specifiers: JsSpecifier[],
  spec: string,
  style: Style,
  defaultLocal: string | null = null,
  namespace: string | null = null,
  typeOnly = false,
): string {
  const parts: string[] = [];
  if (defaultLocal) parts.push(defaultLocal);
  if (namespace) parts.push(`* as ${namespace}`);
  if (specifiers.length)
    parts.push(
      `{ ${specifiers.map((s) => fmtSpecifier(typeOnly ? { ...s, type: false } : s)).join(', ')} }`,
    );
  return `${kind}${typeOnly ? ' type' : ''} ${parts.join(', ')} from ${style.quote}${spec}${style.quote}${style.semi}`;
}

/** The statement text with its braces rewritten (single line, or one specifier per line as before). */
function rewriteBraces(stmt: string, list: (items: string[]) => string[]): string | null {
  const open = stmt.indexOf('{');
  const close = stmt.lastIndexOf('}');
  if (open < 0 || close < open) return null;
  const inner = stmt.slice(open + 1, close);
  const items = inner
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const next = list(items);
  if (!next.length) return '';
  if (inner.includes('\n')) {
    const indent = /\n([ \t]*)\S/.exec(inner)?.[1] ?? '  ';
    const trailing = /,\s*$/.test(inner) ? ',' : '';
    return `${stmt.slice(0, open + 1)}\n${next.map((s) => `${indent}${s}`).join(',\n')}${trailing}\n${stmt.slice(close)}`;
  }
  const pad = /^\{\s/.test(stmt.slice(open)) ? ' ' : '';
  return `${stmt.slice(0, open + 1)}${pad}${next.join(', ')}${pad}${stmt.slice(close)}`;
}

/** Remove a whole statement, with its line when nothing else is on it. */
function removeStatement(text: string, st: { start: number; end: number }): Edit {
  const ls = lineStart(text, st.start);
  const le = lineEnd(text, st.end - 1);
  if (!text.slice(ls, st.start).trim() && !text.slice(st.end, le).trim()) return [ls, le, ''];
  return [st.start, st.end, ''];
}

/** Where new imports go: after the last import statement, or after a leading comment block. */
function importInsertAt(text: string, statements: JsStatement[]): number {
  const imports = statements.filter((s) => s.kind !== 'export-list');
  if (imports.length) return lineEnd(text, imports.at(-1)!.end - 1);
  const reg = regions(text, 'typescript');
  let i = 0;
  if (text.startsWith('#!')) i = lineEnd(text, 0);
  for (;;) {
    while (i < text.length && /\s/.test(text[i]!)) i++;
    if (reg[i] === 1) {
      while (i < text.length && reg[i] === 1) i++;
      continue;
    }
    const directive = /^(['"])use [\w ]+\1;?/.exec(text.slice(i));
    if (directive) {
      i += directive[0].length;
      continue;
    }
    break;
  }
  return i === 0 ? 0 : lineEnd(text, i - 1);
}

export async function planMove(root: string, refs: References, to: string): Promise<MovePlan> {
  const def = refs.def;
  const name = def.name;
  if (refs.language !== 'typescript')
    throw new WorkspaceError('unsupported', 'move_symbol supports TypeScript and JavaScript only.');
  if (def.container || !MOVABLE.has(def.kind))
    throw new WorkspaceError(
      'unsupported',
      `Only top-level functions, classes, types, interfaces, enums and constants can be moved; ${name} is a ${def.kind}${def.container ? ` of ${def.container}` : ''}.`,
    );
  if (/^\s*export\s+default\b/.test(def.signature))
    throw new WorkspaceError('unsupported', `${name} is a default export; move it by hand.`);
  const target = await resolveForWrite(root, to);
  if (languageOf(target.rel) !== 'typescript' || isSecretPath(target.rel))
    throw new WorkspaceError('unsupported', `"${target.rel}" is not a TypeScript/JavaScript file.`);
  if (target.rel === def.path)
    throw new WorkspaceError('unsupported', `${name} is already in ${target.rel}.`);

  const A = def.path;
  const B = target.rel;
  const aText = refs.texts.get(A)!;
  const aStatements = parseJsStatements(aText);
  if (
    aStatements.some(
      (s) => s.kind === 'export-list' && s.specifiers.some((sp) => sp.imported === name),
    )
  )
    throw new WorkspaceError(
      'unsupported',
      `${A} exports ${name} through an export list (export { ${name} }); move it by hand.`,
    );
  const range = definitionRange(aText, def.line);
  let block = aText.slice(range.start, range.end);
  if (!block.endsWith('\n')) block += '\n';
  const typeOnly = def.kind === 'interface' || def.kind === 'type';
  const notes: string[] = [];

  // What the moved code uses: imports of A, and A's own top-level names.
  const used = usedNames(block);
  used.delete(name);
  const aDecls = topLevelDeclarations(aText);
  const neededImports: Array<{
    st: JsStatement;
    specifiers: JsSpecifier[];
    defaultLocal: string | null;
    namespace: string | null;
  }> = [];
  for (const st of aStatements) {
    if ((st.kind !== 'import' && st.kind !== 'require') || !st.spec) continue;
    const specifiers = st.specifiers.filter((s) => s.imported !== 'default' && used.has(s.local));
    const def_ = st.specifiers.find((s) => s.imported === 'default' && used.has(s.local));
    const namespace = st.namespace && used.has(st.namespace) ? st.namespace : null;
    if (specifiers.length || def_ || namespace)
      neededImports.push({ st, specifiers, defaultLocal: def_?.local ?? null, namespace });
  }
  const fromA = [...aDecls.keys()].filter((n) => {
    const at = aDecls.get(n)!.at;
    return n !== name && used.has(n) && (at < range.start || at >= range.end);
  });

  // A without the definition (and a blank line it leaves behind).
  const aEdits: Edit[] = [];
  // With a blank line on both sides, one of them goes too.
  const blankAfter = aText[range.end] === '\n';
  const blankBefore = range.start === 0 || aText.slice(range.start - 2, range.start) === '\n\n';
  const removeEnd = blankAfter && blankBefore ? range.end + 1 : range.end;
  aEdits.push([range.start, removeEnd, '']);
  const aAfterRemoval = applyEdits(aText, aEdits);

  // Names from A the moved code needs must be exported from A.
  for (const n of fromA) {
    const d = aDecls.get(n)!;
    if (!d.exported) {
      aEdits.push([d.at, d.at, 'export ']);
      notes.push(`${n} is now exported from ${A}, because ${name} uses it.`);
    }
  }

  // Imports A no longer needs (only the ones the moved code used).
  const remainingStatements = parseJsStatements(aAfterRemoval);
  const stillUsed = (n: string) =>
    occurrences(aAfterRemoval, n, 'typescript').some(
      (o) =>
        o.region === 'code' &&
        !remainingStatements.some((s) => o.offset >= s.start && o.offset < s.end),
    );
  for (const ni of neededImports) {
    const st = ni.st;
    const drop = new Set(
      [...ni.specifiers.map((s) => s.local), ni.defaultLocal, ni.namespace].filter(
        (n): n is string => !!n && !stillUsed(n),
      ),
    );
    if (!drop.size) continue;
    const stmt = aText.slice(st.start, st.end);
    const remaining = st.specifiers.filter((s) => !drop.has(s.local));
    if (!remaining.length && !(st.namespace && !drop.has(st.namespace)))
      aEdits.push(removeStatement(aText, st));
    else if (st.specifiers.some((s) => drop.has(s.local) && s.imported !== 'default')) {
      const rewritten = rewriteBraces(stmt, (items) =>
        items.filter((it) => {
          const local = /(?:as\s+)?([\w$]+)\s*$/.exec(it)?.[1];
          return !local || !drop.has(local);
        }),
      );
      if (rewritten !== null) aEdits.push([st.start, st.end, rewritten]);
    }
  }

  const aStyle = styleOf(aText, aStatements);
  const aUsesMoved = occurrences(aAfterRemoval, name, 'typescript').some(
    (o) => o.region === 'code',
  );
  if (aUsesMoved) {
    const at = importInsertAt(aText, aStatements);
    aEdits.push([
      at,
      at,
      `${importLine('import', [{ imported: name, local: name, type: typeOnly }], relativeSpec(A, B, aStatements.find((s) => s.spec?.startsWith('.'))?.spec ?? null), aStyle)}\n`,
    ]);
  }

  // B: imports for what the code uses, then the definition.
  let bBefore: string | null = null;
  if (target.exists) {
    const stat = await fs.lstat(target.abs);
    if (!stat.isFile()) throw new WorkspaceError('not_a_file', `"${B}" is not a file.`);
    bBefore = await fs.readFile(target.abs, 'utf8');
  }
  const bText = bBefore ?? '';
  const bStatements = parseJsStatements(bText);
  if (topLevelDeclarations(bText).has(name))
    throw new WorkspaceError('unsupported', `${B} already defines ${name}.`);
  const bStyle = bBefore ? styleOf(bText, bStatements) : aStyle;
  const bEdits: Edit[] = [];
  const bLocals = new Set(
    bStatements.flatMap((s) => [
      ...s.specifiers.map((sp) => sp.local),
      ...(s.namespace ? [s.namespace] : []),
    ]),
  );
  const newLines: string[] = [];
  const example =
    (
      bStatements.find((s) => s.spec?.startsWith('.')) ??
      aStatements.find((s) => s.spec?.startsWith('.'))
    )?.spec ?? null;
  const respec = (spec: string) => {
    const file = refs.resolve(A, spec);
    if (!file) return spec;
    if (file === B) return null;
    return relativeSpec(B, file, spec);
  };
  for (const ni of neededImports) {
    const spec = respec(ni.st.spec!);
    if (spec === null) continue; // the import was of B itself
    const specifiers = ni.specifiers.filter((s) => !bLocals.has(s.local));
    const defaultLocal = ni.defaultLocal && !bLocals.has(ni.defaultLocal) ? ni.defaultLocal : null;
    const namespace = ni.namespace && !bLocals.has(ni.namespace) ? ni.namespace : null;
    if (!specifiers.length && !defaultLocal && !namespace) continue;
    const target = refs.resolve(A, ni.st.spec!);
    const same = bStatements.find(
      (s) =>
        s.kind === 'import' &&
        !!s.spec &&
        !s.namespace &&
        !s.typeOnly &&
        (target ? refs.resolve(B, s.spec) === target : s.spec === spec) &&
        bText.slice(s.start, s.end).includes('{'),
    );
    if (same && specifiers.length && !defaultLocal && !namespace) {
      const rewritten = rewriteBraces(bText.slice(same.start, same.end), (items) => [
        ...items,
        ...specifiers.map(fmtSpecifier),
      ]);
      if (rewritten) {
        bEdits.push([same.start, same.end, rewritten]);
        continue;
      }
    }
    if (ni.st.kind === 'require') {
      newLines.push(
        namespace
          ? `const ${namespace} = require(${bStyle.quote}${spec}${bStyle.quote})${bStyle.semi}`
          : `const { ${specifiers.map((s) => (s.imported === s.local ? s.local : `${s.imported}: ${s.local}`)).join(', ')} } = require(${bStyle.quote}${spec}${bStyle.quote})${bStyle.semi}`,
      );
    } else
      newLines.push(
        importLine('import', specifiers, spec, bStyle, defaultLocal, namespace, ni.st.typeOnly),
      );
  }
  if (fromA.length) {
    const missing = fromA.filter((n) => !bLocals.has(n));
    if (missing.length)
      newLines.push(
        importLine(
          'import',
          missing.map((n) => ({ imported: n, local: n, type: false })),
          relativeSpec(B, A, example),
          bStyle,
        ),
      );
  }
  // B importing the symbol from A: it now has the definition itself.
  for (const st of bStatements) {
    if (st.kind !== 'import' || !st.spec || refs.resolve(B, st.spec) !== A) continue;
    if (!st.specifiers.some((s) => s.imported === name)) continue;
    const other = st.specifiers.filter((s) => s.imported !== name);
    if (!other.length && !st.namespace) bEdits.push(removeStatement(bText, st));
    else {
      const rewritten = rewriteBraces(bText.slice(st.start, st.end), (items) =>
        items.filter((it) => !new RegExp(`^(type\\s+)?${name}(\\s|$)`).test(it)),
      );
      if (rewritten !== null) bEdits.push([st.start, st.end, rewritten]);
    }
  }
  if (newLines.length) {
    const at = importInsertAt(bText, bStatements);
    bEdits.push([at, at, `${newLines.join('\n')}\n${at === 0 && bText.trim() ? '\n' : ''}`]);
  }
  // It must be exported from B when anything imports it.
  let moved = block;
  const declOffset = range.declStart - range.start;
  if (!/^\s*export\b/.test(moved.slice(declOffset)))
    moved = `${moved.slice(0, declOffset)}export ${moved.slice(declOffset).replace(/^\s*/, '')}`;
  const bBody = applyEdits(bText, bEdits);
  const bAfter = bBody.trim() ? `${bBody.replace(/\s*$/, '')}\n\n${moved}` : moved;

  // Everyone else importing it from A.
  const files: MovePlan['files'] = [];
  const notChanged: RefactorMatch[] = [];
  let importsUpdated = 0;
  for (const [f, text] of refs.jsTexts) {
    if (f === A || f === B || languageOf(f) !== 'typescript') continue;
    const statements = parseJsStatements(text);
    const style = styleOf(text, statements);
    const edits: Edit[] = [];
    const additions: string[] = [];
    for (const st of statements) {
      if (!st.spec || refs.resolve(f, st.spec) !== A) continue;
      const lineNo = text.slice(0, st.start).split('\n').length;
      const mine = st.specifiers.filter((s) => s.imported === name);
      if (st.kind === 'export-all') {
        if (
          !statements.some(
            (s) => s.kind === 'export-all' && s.spec && refs.resolve(f, s.spec) === B,
          )
        ) {
          additions.push(
            importLine(
              'export',
              [{ imported: name, local: name, type: typeOnly }],
              relativeSpec(f, B, st.spec),
              style,
            ),
          );
          importsUpdated++;
        }
        continue;
      }
      if (
        st.namespace &&
        occurrences(text, name, 'typescript').some((o) => o.receiver === st.namespace)
      ) {
        notChanged.push({
          path: f,
          line: lineNo,
          text: text.slice(st.start, st.end).trim().slice(0, 200),
          reason: `uses ${name} through a namespace import of ${A}`,
        });
        continue;
      }
      if (!mine.length) continue;
      if (st.kind === 'require') {
        notChanged.push({
          path: f,
          line: lineNo,
          text: text.slice(st.start, st.end).trim().slice(0, 200),
          reason: `require() of ${A}; update it by hand`,
        });
        continue;
      }
      const rest = st.specifiers.filter((s) => s.imported !== name);
      const kind = st.kind === 'export-from' ? 'export' : 'import';
      const newSpec = relativeSpec(f, B, st.spec);
      if (!rest.length && !st.namespace) {
        // Same statement, new path: keeps its formatting.
        const stmt = text.slice(st.start, st.end);
        const quoted = new RegExp(`(['"])${st.spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1`);
        edits.push([
          st.start,
          st.end,
          stmt.replace(quoted, (_m, q: string) => `${q}${newSpec}${q}`),
        ]);
      } else {
        const rewritten = rewriteBraces(text.slice(st.start, st.end), (items) =>
          items.filter((it) => !new RegExp(`^(type\\s+)?${name}(\\s|$)`).test(it)),
        );
        if (rewritten === null) continue;
        edits.push([st.start, st.end, rewritten]);
        additions.push(
          importLine(
            kind,
            mine.map((s) => ({ ...s, type: s.type || (st.typeOnly && kind === 'import') })),
            newSpec,
            style,
          ),
        );
      }
      importsUpdated++;
    }
    if (!edits.length && !additions.length) continue;
    if (additions.length) {
      const at = importInsertAt(text, statements);
      edits.push([at, at, `${additions.join('\n')}\n`]);
    }
    files.push({ path: f, before: text, after: applyEdits(text, edits) });
  }

  const aAfter = applyEdits(aText, aEdits).replace(/\n{3,}$/, '\n');
  files.unshift(
    { path: A, before: aText, after: aAfter },
    { path: B, before: bBefore, after: bAfter },
  );

  const aImportsB = aUsesMoved;
  const bImportsA = fromA.length > 0;
  if (aImportsB && bImportsA)
    notes.push(
      `${A} and ${B} now import each other (a circular import); check this works for your bundler/runtime.`,
    );
  return { target: B, files, importsUpdated, notChanged, notes };
}
