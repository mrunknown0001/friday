import path from 'node:path';
import { regions } from './lexer.js';

/**
 * Import and export statements, read from code (not comments or strings), and where their module
 * specifiers point inside the project. Enough to tell whether a file uses a symbol from a given
 * file: named imports, namespace imports, re-exports ("barrel" files) and require() in
 * JavaScript/TypeScript; from/import in Python; package imports in Go; namespace and use in PHP.
 */

export interface JsSpecifier {
  /** The exported name ('default' for a default import, '*' for a namespace). */
  imported: string;
  /** The name in this file (for export-from: the name it is re-exported as). */
  local: string;
  type: boolean;
}

export interface JsStatement {
  kind: 'import' | 'export-from' | 'export-all' | 'export-list' | 'require';
  spec: string | null;
  specifiers: JsSpecifier[];
  /** Namespace binding: `import * as ns`, `export * as ns`, `const ns = require()`. */
  namespace: string | null;
  typeOnly: boolean;
  start: number;
  end: number;
}

function parseSpecifiers(list: string, exportFrom: boolean): JsSpecifier[] {
  return list
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = /^(type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?$/.exec(s);
      if (!m) return null;
      return { imported: m[2]!, local: m[3] ?? m[2]!, type: !!m[1] && !exportFrom ? true : !!m[1] };
    })
    .filter((s): s is JsSpecifier => s !== null);
}

const JS_STATEMENT =
  /\b(import|export)\s+(type\s+)?((?:[\w$]+\s*,\s*)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})|[\w$]+)\s*from\s*(['"])([^'"\n]+)\4\s*;?|\bexport\s+(type\s+)?\{([^}]*)\}\s*;?|\b(const|let|var)\s+(\{[^}]*\}|[\w$]+)\s*=\s*require\(\s*(['"])([^'"\n]+)\10\s*\)\s*;?/g;

export function parseJsStatements(text: string): JsStatement[] {
  const reg = regions(text, 'typescript');
  const out: JsStatement[] = [];
  for (const m of text.matchAll(JS_STATEMENT)) {
    if (reg[m.index] !== 0) continue;
    // Not a property like `foo.import`.
    if (m.index > 0 && text[m.index - 1] === '.') continue;
    const start = m.index;
    const end = m.index + m[0].length;
    if (m[1]) {
      const clause = m[3]!.trim();
      const typeOnly = !!m[2];
      const spec = m[5]!;
      if (m[1] === 'export') {
        const all = /^\*(?:\s+as\s+([\w$]+))?$/.exec(clause);
        if (all) {
          out.push({
            kind: 'export-all',
            spec,
            specifiers: [],
            namespace: all[1] ?? null,
            typeOnly,
            start,
            end,
          });
          continue;
        }
        const braces = /^\{([\s\S]*)\}$/.exec(clause);
        if (braces)
          out.push({
            kind: 'export-from',
            spec,
            specifiers: parseSpecifiers(braces[1]!, true),
            namespace: null,
            typeOnly,
            start,
            end,
          });
        continue;
      }
      // import Default, { a, b as c } / import * as ns / import Default, * as ns
      const specifiers: JsSpecifier[] = [];
      let namespace: string | null = null;
      const def = /^([\w$]+)\s*(,|$)/.exec(clause);
      if (def) specifiers.push({ imported: 'default', local: def[1]!, type: typeOnly });
      const ns = /\*\s+as\s+([\w$]+)/.exec(clause);
      if (ns) namespace = ns[1]!;
      const braces = /\{([\s\S]*)\}/.exec(clause);
      if (braces)
        specifiers.push(
          ...parseSpecifiers(braces[1]!, false).map((s) => ({ ...s, type: s.type || typeOnly })),
        );
      if (!def && !ns && !braces) continue;
      out.push({ kind: 'import', spec, specifiers, namespace, typeOnly, start, end });
    } else if (m[7] !== undefined) {
      out.push({
        kind: 'export-list',
        spec: null,
        specifiers: parseSpecifiers(m[7], true),
        namespace: null,
        typeOnly: !!m[6],
        start,
        end,
      });
    } else {
      const binding = m[9]!;
      const spec = m[11]!;
      if (binding.startsWith('{')) {
        const specifiers = binding
          .slice(1, -1)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => {
            const [imported, local] = s.split(':').map((x) => x.trim());
            return { imported: imported!, local: local ?? imported!, type: false };
          })
          .filter((s) => /^[\w$]+$/.test(s.imported) && /^[\w$]+$/.test(s.local));
        out.push({
          kind: 'require',
          spec,
          specifiers,
          namespace: null,
          typeOnly: false,
          start,
          end,
        });
      } else
        out.push({
          kind: 'require',
          spec,
          specifiers: [],
          namespace: binding,
          typeOnly: false,
          start,
          end,
        });
    }
  }
  return out;
}

const JS_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.vue',
  '.svelte',
];

export interface PathAliases {
  /** Folder (project-relative) the paths are relative to. */
  base: string;
  paths: Array<{ prefix: string; suffix: string; targets: string[] }>;
}

/** compilerOptions.paths from a tsconfig/jsconfig (comments and trailing commas allowed). */
export function parseTsconfigPaths(text: string, configDir: string): PathAliases | null {
  const reg = regions(text, 'typescript');
  let clean = '';
  for (let i = 0; i < text.length; i++) clean += reg[i] === 1 ? ' ' : text[i];
  clean = clean.replace(/,(\s*[}\]])/g, '$1');
  try {
    const json = JSON.parse(clean) as {
      compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
    };
    const opts = json.compilerOptions;
    if (!opts?.paths) return null;
    const base = path.posix.normalize(path.posix.join(configDir, opts.baseUrl ?? '.'));
    return {
      base,
      paths: Object.entries(opts.paths).map(([pattern, targets]) => {
        const star = pattern.indexOf('*');
        return {
          prefix: star < 0 ? pattern : pattern.slice(0, star),
          suffix: star < 0 ? '' : pattern.slice(star + 1),
          targets: star < 0 ? targets : targets,
        };
      }),
    };
  } catch {
    return null;
  }
}

/**
 * The project file a JS/TS module specifier points at, or null (a package, or not found).
 * `files` holds every project-relative source path.
 */
export function resolveJs(
  fromFile: string,
  spec: string,
  files: Set<string>,
  aliases: PathAliases | null,
): string | null {
  const bases: string[] = [];
  if (spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..')
    bases.push(path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec)));
  else if (aliases)
    for (const p of aliases.paths) {
      if (!spec.startsWith(p.prefix) || !spec.endsWith(p.suffix)) continue;
      const middle = spec.slice(p.prefix.length, spec.length - p.suffix.length);
      for (const t of p.targets)
        bases.push(path.posix.normalize(path.posix.join(aliases.base, t.replace('*', middle))));
    }
  for (const base of bases) {
    const b = base.replace(/^\.\//, '');
    const candidates = [
      b,
      ...JS_EXTENSIONS.map((e) => b + e),
      ...JS_EXTENSIONS.map((e) => `${b}/index${e}`),
    ];
    // ESM TypeScript imports name the compiled file: "./cart.js" means cart.ts.
    const swapped = b.replace(
      /\.(m|c)?js(x?)$/,
      (_m, mc: string | undefined, x: string) => `.${mc ?? ''}ts${x}`,
    );
    if (swapped !== b) candidates.push(swapped);
    const hit = candidates.find((c) => files.has(c));
    if (hit) return hit;
  }
  return null;
}

/** A relative specifier from one file to another, in the style of `example` (extension or not). */
export function relativeSpec(fromFile: string, toFile: string, example: string | null): string {
  let rel = path.posix.relative(path.posix.dirname(fromFile), toFile);
  if (!rel.startsWith('.')) rel = `./${rel}`;
  const ext = path.posix.extname(toFile);
  const exampleExt = example ? path.posix.extname(example) : '';
  if (!exampleExt) return rel.slice(0, rel.length - ext.length).replace(/\/index$/, '');
  // Keep the project's ESM style: "./x.js" for a .ts file.
  if (/^\.(m|c)?js$/.test(exampleExt) && /^\.(m|c)?tsx?$/.test(ext))
    return rel.slice(0, rel.length - ext.length) + ext.replace('ts', 'js');
  return rel;
}

export interface PyImport {
  /** Dotted module, with leading dots for relative imports. */
  module: string;
  /** Names imported with `from module import ...` (null for `import module`). */
  names: Array<{ imported: string; local: string }> | null;
  /** Local name of `import module as alias` / the first segment for `import a.b`. */
  local: string | null;
  start: number;
  end: number;
}

export function parsePyImports(text: string): PyImport[] {
  const reg = regions(text, 'python');
  const out: PyImport[] = [];
  const re =
    /^[ \t]*from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+(\([\s\S]*?\)|[^\n#]+)|^[ \t]*import[ \t]+([^\n#]+)/gm;
  for (const m of text.matchAll(re)) {
    const at = m.index + m[0].search(/\S/);
    if (reg[at] !== 0) continue;
    const start = m.index;
    const end = m.index + m[0].length;
    if (m[1] !== undefined) {
      const names = m[2]!
        .replace(/[()\\]/g, ' ')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => {
          const [imported, local] = s.split(/\s+as\s+/);
          return { imported: imported!.trim(), local: (local ?? imported!).trim() };
        });
      out.push({ module: m[1], names, local: null, start, end });
    } else
      for (const part of m[3]!.split(',')) {
        const [module, alias] = part.trim().split(/\s+as\s+/);
        if (!module) continue;
        out.push({
          module: module.trim(),
          names: null,
          local: (alias ?? module.split('.').pop()!).trim(),
          start,
          end,
        });
      }
  }
  return out;
}

/** The project file a Python module refers to (by path suffix, so src/ layouts work). */
export function resolvePy(fromFile: string, module: string, files: Set<string>): string | null {
  const dots = /^\.*/.exec(module)![0].length;
  const rest = module.slice(dots).split('.').filter(Boolean).join('/');
  const candidates = (base: string) =>
    [base && `${base}.py`, `${base ? `${base}/` : ''}__init__.py`].filter(Boolean) as string[];
  if (dots) {
    let dir = path.posix.dirname(fromFile);
    for (let i = 1; i < dots; i++) dir = path.posix.dirname(dir);
    const base = path.posix.normalize(path.posix.join(dir, rest)).replace(/^\.\/?/, '');
    return candidates(base).find((c) => files.has(c)) ?? null;
  }
  if (!rest) return null;
  for (const c of candidates(rest)) {
    if (files.has(c)) return c;
    for (const f of files) if (f.endsWith(`/${c}`)) return f;
  }
  return null;
}

/** Go imports: local name (alias or last path segment) to import path. */
export function parseGoImports(text: string): Map<string, string> {
  const reg = regions(text, 'go');
  const out = new Map<string, string>();
  const add = (alias: string | undefined, p: string) =>
    out.set(alias && alias !== '_' && alias !== '.' ? alias : p.split('/').pop()!, p);
  for (const m of text.matchAll(/^import\s+(?:([\w.]+)\s+)?"([^"]+)"/gm))
    if (reg[m.index] === 0) add(m[1], m[2]!);
  for (const m of text.matchAll(/^import\s*\(([\s\S]*?)\)/gm)) {
    if (reg[m.index] !== 0) continue;
    for (const l of m[1]!.matchAll(/^\s*(?:([\w.]+)\s+)?"([^"]+)"/gm)) add(l[1], l[2]!);
  }
  return out;
}

/** PHP: the file's namespace and its `use` imports (alias to fully qualified name). */
export function parsePhpNames(text: string): { namespace: string; uses: Map<string, string> } {
  const reg = regions(text, 'php');
  let namespace = '';
  const ns = /^\s*namespace\s+([\w\\]+)\s*[;{]/m.exec(text);
  if (ns && reg[ns.index + ns[0].indexOf('namespace')] === 0) namespace = ns[1]!;
  const uses = new Map<string, string>();
  for (const m of text.matchAll(/^\s*use\s+(?:function\s+|const\s+)?([^;{]+);/gm)) {
    if (reg[m.index + m[0].indexOf('use')] !== 0) continue;
    for (const part of m[1]!.split(',')) {
      const [fq, alias] = part
        .trim()
        .replace(/^\\/, '')
        .split(/\s+as\s+/i);
      if (!fq) continue;
      uses.set((alias ?? fq.split('\\').pop()!).trim(), fq.trim());
    }
  }
  return { namespace, uses };
}
