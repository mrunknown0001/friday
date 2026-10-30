import fs from 'node:fs/promises';
import path from 'node:path';
import type { CodeMap, SymbolRow } from '../codemap/index.js';
import { languageOf, type Language } from '../codemap/extract.js';
import { looksBinary } from '../workspace/files.js';
import { isSecretPath, resolveInside, WorkspaceError } from '../workspace/paths.js';
import { search } from '../workspace/search.js';
import { occurrences, type Occurrence } from './lexer.js';
import {
  parseGoImports,
  parseJsStatements,
  parsePhpNames,
  parsePyImports,
  parseTsconfigPaths,
  resolveJs,
  resolvePy,
  type JsStatement,
  type PathAliases,
  type PyImport,
} from './modules.js';

/**
 * Where a symbol is used, split into the occurrences Friday can tie to the definition (through
 * imports, the same file or package, or `this`) and text matches that may be something else with
 * the same name: in comments, strings, other files that don't import it, or member calls on
 * values whose type Friday can't check. Pattern-based, not a compiler: it errs on the side of
 * listing a match as uncertain.
 */

export interface Ref {
  path: string;
  line: number;
  offset: number;
  text: string;
}

export interface UncertainRef extends Ref {
  reason: string;
}

export interface References {
  def: SymbolRow;
  language: Language;
  /** The definition's own occurrence is included. */
  confident: Ref[];
  uncertain: UncertainRef[];
  /** Contents of every file with an occurrence, as read. */
  texts: Map<string, string>;
  /** JS/TS: those plus files read for their re-exports. */
  jsTexts: Map<string, string>;
  /** JS/TS: the project file a specifier in a file points at. */
  resolve: (file: string, spec: string) => string | null;
  /** Paths of the project's indexed source files. */
  files: Set<string>;
}

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_MATCH_LINES = 5_000;

/** Method names common enough that `.name(` elsewhere says nothing about which class it is. */
const COMMON_MEMBERS = new Set(
  'get set has add delete remove push pop shift map filter reduce find forEach some every then catch finally toString valueOf toJSON length size keys values entries join split slice splice includes indexOf apply call bind start stop run update create save load close open read write send emit on off once init render handle process execute clear reset append insert copy format parse sort next name id type value data items count list key equals hashCode compareTo dispose destroy connect disconnect validate check build test fetch post put patch request response log error warn info debug'.split(
    ' ',
  ),
);

const SELF: Record<Language, string[]> = {
  typescript: ['this'],
  python: ['self', 'cls'],
  php: ['this', 'self', 'static'],
  go: [],
  rust: ['self', 'Self'],
  ruby: ['self'],
  java: ['this'],
  kotlin: ['this'],
  csharp: ['this'],
};

const LANGUAGE_NAME: Record<Language, string> = {
  typescript: 'TypeScript/JavaScript',
  python: 'Python',
  php: 'PHP',
  go: 'Go',
  rust: 'Rust',
  ruby: 'Ruby',
  java: 'Java',
  kotlin: 'Kotlin',
  csharp: 'C#',
};

async function readText(root: string, rel: string): Promise<string | null> {
  if (isSecretPath(rel)) return null;
  const abs = path.join(root, rel);
  const stat = await fs.lstat(abs).catch(() => null);
  if (!stat?.isFile() || stat.size > MAX_FILE_BYTES) return null;
  const buf = await fs.readFile(abs);
  return looksBinary(buf) ? null : buf.toString('utf8');
}

const lineOf = (o: Occurrence) => o.lineText.trim().slice(0, 200);

/** The one definition a name (and optional file) refers to. */
export function locateDefinition(
  map: CodeMap,
  projectId: string,
  symbol: string,
  file: string | null,
): SymbolRow {
  const query = symbol.replace(/::|\\|->|#/g, '.');
  const dot = query.lastIndexOf('.');
  const name = query.slice(dot + 1);
  const container = dot > 0 ? query.slice(0, dot) : null;
  const all = map.find(projectId, query, undefined, 500).filter((d) => d.name === name);
  const defs = all.filter(
    (d) => (container === null || d.container === container) && (!file || d.path === file),
  );
  if (!defs.length)
    throw new WorkspaceError(
      'not_found',
      `No definition of "${symbol}"${file ? ` in ${file}` : ''} in the code map.${
        all.length
          ? ` Definitions named "${name}": ${all
              .slice(0, 8)
              .map((d) => `${d.path}:${d.line} (${d.container ? `${d.container}.` : ''}${d.name})`)
              .join(', ')}.`
          : ' Check the spelling with find_symbol.'
      }`,
    );
  if (defs.length > 1) {
    // A TypeScript overload or a declaration merged with its implementation: the same symbol.
    const first = defs[0]!;
    if (!defs.every((d) => d.path === first.path && d.container === first.container))
      throw new WorkspaceError(
        'unsupported',
        `"${symbol}" is defined in several places: ${defs
          .slice(0, 10)
          .map((d) => `${d.path}:${d.line} (${d.container ? `${d.container}.` : ''}${d.name})`)
          .join(
            ', ',
          )}. Pass \`path\` (the definition's file)${container ? '' : ' or Class.member'} to pick one.`,
      );
  }
  return defs[0]!;
}

interface JsContext {
  statements: (file: string) => JsStatement[];
  resolve: (file: string, spec: string) => string | null;
}

/** Project files that export the symbol, with the name(s) they export it as. */
function jsProviders(def: SymbolRow, defText: string, ctx: JsContext, jsFiles: string[]) {
  const providers = new Map<string, Set<string>>();
  const names = new Set<string>();
  if (def.exported) names.add(/^\s*export\s+default\b/.test(def.signature) ? 'default' : def.name);
  for (const st of ctx.statements(def.path))
    if (st.kind === 'export-list')
      for (const s of st.specifiers) if (s.imported === def.name) names.add(s.local);
  if (/\bmodule\.exports\b|\bexports\.\w/.test(defText)) names.add(def.name);
  if (!names.size) return providers;
  providers.set(def.path, names);
  for (let changed = true; changed;) {
    changed = false;
    for (const f of jsFiles) {
      for (const st of ctx.statements(f)) {
        if ((st.kind !== 'export-from' && st.kind !== 'export-all') || !st.spec) continue;
        const target = ctx.resolve(f, st.spec);
        const from = target ? providers.get(target) : undefined;
        if (!from || target === f) continue;
        const add = new Set<string>();
        if (st.kind === 'export-all' && !st.namespace)
          for (const n of from) if (n !== 'default') add.add(n);
        for (const s of st.specifiers) if (from.has(s.imported)) add.add(s.local);
        const mine = providers.get(f) ?? new Set<string>();
        for (const n of add)
          if (!mine.has(n)) {
            mine.add(n);
            changed = true;
          }
        if (mine.size) providers.set(f, mine);
      }
    }
  }
  return providers;
}

export async function findReferences(opts: {
  root: string;
  map: CodeMap;
  projectId: string;
  symbol: string;
  path?: string | undefined;
  ripgrep: string | null;
  signal?: AbortSignal | undefined;
}): Promise<References> {
  const { root, map, projectId } = opts;
  await map.refresh({ id: projectId, rootPath: root }, { signal: opts.signal });
  const file = opts.path ? (await resolveInside(root, opts.path)).rel : null;
  const def = locateDefinition(map, projectId, opts.symbol, file);
  const language = languageOf(def.path)!;
  const name = def.name;
  const files = new Set(map.filesUnder(projectId, '').map((f) => f.path));

  const found = await search(root, opts.ripgrep, {
    query: name,
    regex: false,
    caseSensitive: true,
    targetAbs: root,
    maxResults: MAX_MATCH_LINES,
    signal: opts.signal,
  });
  if (found.truncated)
    throw new WorkspaceError(
      'unsupported',
      `"${name}" appears on more than ${MAX_MATCH_LINES} lines; too many to check safely. Rename it in smaller steps with edit_files.`,
    );
  const candidates = [...new Set([def.path, ...found.matches.map((m) => m.path)])].sort();
  const texts = new Map<string, string>();
  for (const f of candidates) {
    const t = await readText(root, f);
    if (t !== null) texts.set(f, t);
  }
  const defText = texts.get(def.path);
  if (defText === undefined) throw new WorkspaceError('not_found', `Could not read ${def.path}.`);

  // JavaScript/TypeScript: imports of every file, for re-exports through index files.
  const statementCache = new Map<string, JsStatement[]>();
  const jsTexts = new Map<string, string>(texts);
  const aliasCache = new Map<string, PathAliases | null>();
  const aliasesFor = async (dir: string): Promise<PathAliases | null> => {
    if (aliasCache.has(dir)) return aliasCache.get(dir)!;
    let found: PathAliases | null = null;
    for (const cfg of ['tsconfig.json', 'jsconfig.json']) {
      const text = await readText(root, path.posix.join(dir, cfg));
      if (text) {
        found = parseTsconfigPaths(text, dir);
        if (found) break;
      }
    }
    if (!found && dir !== '.' && dir !== '') found = await aliasesFor(path.posix.dirname(dir));
    aliasCache.set(dir, found);
    return found;
  };
  const jsFiles = [...files].filter((f) => languageOf(f) === 'typescript');
  const fileAliases = new Map<string, PathAliases | null>();
  if (language === 'typescript') {
    for (const f of jsFiles) {
      fileAliases.set(f, await aliasesFor(path.posix.dirname(f)));
      if (!jsTexts.has(f)) {
        const t = await readText(root, f);
        // Only files that re-export matter beyond the ones mentioning the name.
        if (t && /\bexport\s*(\*|\{)/.test(t)) jsTexts.set(f, t);
      }
    }
  }
  const js: JsContext = {
    statements: (f) => {
      let s = statementCache.get(f);
      if (!s) {
        s = jsTexts.has(f) ? parseJsStatements(jsTexts.get(f)!) : [];
        statementCache.set(f, s);
      }
      return s;
    },
    resolve: (f, spec) => resolveJs(f, spec, files, fileAliases.get(f) ?? null),
  };
  const providers =
    language === 'typescript' && !def.container
      ? jsProviders(
          def,
          defText,
          js,
          [...jsTexts.keys()].filter((f) => languageOf(f) === 'typescript'),
        )
      : new Map<string, Set<string>>();

  // Python: modules that provide the name (the definition's module, and ones that import it).
  const pyImports = new Map<string, PyImport[]>();
  const pyProviders = new Map<string, Set<string>>();
  if (language === 'python' && !def.container) {
    pyProviders.set(def.path, new Set([name]));
    for (const [f, t] of texts) if (f.endsWith('.py')) pyImports.set(f, parsePyImports(t));
    // __init__.py files re-export without mentioning callers; read those too.
    for (const f of files)
      if (f.endsWith('__init__.py') && !pyImports.has(f)) {
        const t = await readText(root, f);
        if (t) pyImports.set(f, parsePyImports(t));
      }
    for (let changed = true; changed;) {
      changed = false;
      for (const [f, imports] of pyImports)
        for (const im of imports) {
          if (!im.names) continue;
          const target = resolvePy(f, im.module, files);
          const from = target ? pyProviders.get(target) : undefined;
          if (!from || target === f) continue;
          for (const n of im.names)
            if (from.has(n.imported)) {
              const mine = pyProviders.get(f) ?? new Set<string>();
              if (!mine.has(n.local)) {
                mine.add(n.local);
                pyProviders.set(f, mine);
                changed = true;
              }
            }
        }
    }
  }

  // Go: the definition's package and import path.
  let goImportPath: string | null = null;
  let goPackage: string | null = null;
  const goReceivers = new Set<string>();
  if (language === 'go') {
    goPackage = /^package\s+(\w+)/m.exec(defText)?.[1] ?? null;
    for (let dir = path.posix.dirname(def.path); ; dir = path.posix.dirname(dir)) {
      const mod = await readText(root, path.posix.join(dir === '.' ? '' : dir, 'go.mod'));
      const module = mod ? /^module\s+(\S+)/m.exec(mod)?.[1] : null;
      if (module) {
        const sub = path.posix.relative(dir, path.posix.dirname(def.path));
        goImportPath = sub ? `${module}/${sub}` : module;
        break;
      }
      if (dir === '.' || dir === '') break;
    }
    if (def.container)
      for (const m of defText.matchAll(
        new RegExp(`^func\\s*\\(\\s*(\\w+)\\s+\\*?${def.container}\\b`, 'gm'),
      ))
        goReceivers.add(m[1]!);
  }

  const php = language === 'php' ? parsePhpNames(defText) : null;
  const uniqueMember =
    def.container !== null &&
    !COMMON_MEMBERS.has(name) &&
    map.find(projectId, name, undefined, 500).filter((d) => d.name === name).length === 1;

  const confident: Ref[] = [];
  const uncertain: UncertainRef[] = [];
  const defDir = path.posix.dirname(def.path);

  for (const [f, text] of texts) {
    const lang = languageOf(f);
    const occs = occurrences(text, name, lang);
    if (!occs.length) continue;
    const sameFamily = lang === language;
    const jsStatements = lang === 'typescript' ? js.statements(f) : [];
    const pyIm = lang === 'python' ? (pyImports.get(f) ?? parsePyImports(text)) : [];
    const goIm = lang === 'go' ? parseGoImports(text) : null;
    const phpNames = lang === 'php' ? parsePhpNames(text) : null;
    const mentionsContainer =
      def.container !== null &&
      occurrences(text, def.container, lang).some((o) => o.region === 'code');
    let defLineSeen = false;

    for (const o of occs) {
      const ref: Ref = { path: f, line: o.line, offset: o.offset, text: lineOf(o) };
      const sure = () => confident.push(ref);
      const unsure = (reason: string) => uncertain.push({ ...ref, reason });

      if (f === def.path && o.line === def.line && !defLineSeen) {
        defLineSeen = true;
        sure();
        continue;
      }
      if (!lang) {
        unsure('in a file that is not source code');
        continue;
      }
      if (o.region !== 'code') {
        unsure(o.region === 'comment' ? 'in a comment' : 'in a string');
        continue;
      }
      if (!sameFamily) {
        unsure(`in ${LANGUAGE_NAME[lang]} code, not ${LANGUAGE_NAME[language]}`);
        continue;
      }

      // Members: tied to the class only through `this`/the class name, or a name unique enough.
      if (def.container !== null) {
        if (o.accessor && o.accessor !== '\\') {
          const r = o.receiver;
          if (
            (r && SELF[language].includes(r) && f === def.path) ||
            (r && goReceivers.has(r) && path.posix.dirname(f) === defDir) ||
            r === def.container
          )
            sure();
          else if (uniqueMember && (f === def.path || mentionsContainer)) sure();
          else
            unsure(
              uniqueMember
                ? `called on something in a file that never mentions ${def.container}`
                : `called on something Friday can't check is a ${def.container}${COMMON_MEMBERS.has(name) ? ' (a common method name)' : ''}`,
            );
        } else
          unsure(
            f === def.path
              ? 'a separate use of the name in the same file (a local, or another member)'
              : 'the same name defined or used outside the class (maybe an override)',
          );
        continue;
      }

      switch (language) {
        case 'typescript': {
          const st = jsStatements.find((s) => o.offset >= s.start && o.offset < s.end);
          if (st) {
            const target = st.spec ? js.resolve(f, st.spec) : null;
            const from = target ? providers.get(target) : undefined;
            if (st.kind === 'export-list') {
              if (f === def.path || importsName(f)) sure();
              else unsure(`exports a "${name}" that is not imported from ${def.path}`);
            } else if (st.specifiers.some((s) => s.imported === name) && from?.has(name)) sure();
            else if (st.specifiers.some((s) => s.imported === name))
              unsure(`imported from ${st.spec ?? 'another module'}, not from ${def.path}`);
            else unsure('a different import with the same local name');
            break;
          }
          if (o.accessor) {
            const ns = o.receiver ? namespaceOf(f, o.receiver) : null;
            if (ns) sure();
            else if (f === def.path && o.receiver === 'exports') sure();
            else unsure('a property of something else with the same name');
            break;
          }
          if (f === def.path || importsName(f)) sure();
          else
            unsure(
              providers.size
                ? `this file doesn't import it from ${def.path}`
                : `${name} is not exported, and this is another file`,
            );
          break;
        }
        case 'python': {
          const st = pyIm.find((s) => o.offset >= s.start && o.offset < s.end);
          if (st) {
            const target = resolvePy(f, st.module, files);
            const from = target ? pyProviders.get(target) : undefined;
            if (st.names?.some((n) => n.imported === name) && from?.has(name)) sure();
            else unsure(`imported from ${st.module}, not from ${def.path}`);
            break;
          }
          if (o.accessor) {
            const viaModule = pyIm.some(
              (im) =>
                !im.names &&
                im.local === o.receiver &&
                pyProviders.has(resolvePy(f, im.module, files) ?? ''),
            );
            if (viaModule) sure();
            else unsure('an attribute of something else with the same name');
            break;
          }
          if (f === def.path) sure();
          else if (
            pyIm.some(
              (im) =>
                im.names?.some((n) => n.local === name && n.imported === name) &&
                pyProviders.get(resolvePy(f, im.module, files) ?? '')?.has(name),
            )
          )
            sure();
          else unsure(`this file doesn't import it from ${def.path}`);
          break;
        }
        case 'go': {
          const samePackage =
            path.posix.dirname(f) === defDir && /^package\s+(\w+)/m.exec(text)?.[1] === goPackage;
          if (o.accessor) {
            if (o.receiver && goIm?.get(o.receiver) === goImportPath && goImportPath) sure();
            else unsure('a field or method of something else with the same name');
          } else if (samePackage) sure();
          else unsure(`another package (${path.posix.dirname(f)}), not ${defDir}`);
          break;
        }
        case 'php': {
          const defNs = php!.namespace;
          if (o.accessor === '\\') {
            let k = o.offset - 1;
            while (k >= 0 && /[\w\\]/.test(text[k]!)) k--;
            const qualifier = text.slice(k + 1, o.offset - 1).replace(/^\\/, '');
            if (qualifier === defNs) sure();
            else unsure(`the qualified name ${qualifier}\\${name}, not ${defNs}\\${name}`);
            break;
          }
          if (o.accessor) {
            unsure('a member of something else with the same name');
            break;
          }
          const imported = phpNames!.uses.get(name);
          if (f === def.path) sure();
          else if (imported !== undefined) {
            if (imported === (defNs ? `${defNs}\\${name}` : name)) sure();
            else unsure(`refers to ${imported} (from a use statement)`);
          } else if (phpNames!.namespace === defNs) sure();
          else unsure(`in namespace ${phpNames!.namespace || '(global)'}, which doesn't import it`);
          break;
        }
        default:
          if (f === def.path && !o.accessor) sure();
          else
            unsure(
              `Friday doesn't follow ${LANGUAGE_NAME[language]} imports, so it can't tell this is the same symbol`,
            );
      }
    }

    function importsName(file: string): boolean {
      return js.statements(file).some((s) => {
        if (s.kind !== 'import' && s.kind !== 'require') return false;
        const target = s.spec ? js.resolve(file, s.spec) : null;
        const from = target ? providers.get(target) : undefined;
        return (
          !!from &&
          s.specifiers.some(
            (sp) => sp.local === name && from.has(sp.imported) && sp.imported === name,
          )
        );
      });
    }

    function namespaceOf(file: string, receiver: string): boolean {
      return js.statements(file).some((s) => {
        if (s.namespace !== receiver || !s.spec) return false;
        const target = js.resolve(file, s.spec);
        return !!target && !!providers.get(target)?.has(name);
      });
    }
  }

  const order = (a: Ref, b: Ref) => a.path.localeCompare(b.path) || a.offset - b.offset;
  return {
    def,
    language,
    confident: confident.sort(order),
    uncertain: uncertain.sort(order),
    texts,
    jsTexts,
    resolve: js.resolve,
    files,
  };
}
