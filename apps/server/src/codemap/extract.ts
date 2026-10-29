/**
 * Symbol extraction for the code map: definitions (classes, functions, methods, types, ...) found
 * with per-language line patterns. No parser and no dependencies, so it is fast and covers many
 * languages, but it is approximate: unusual formatting can hide a definition, and members are
 * attributed to a container by indentation (which matches how almost all real code is written).
 */

export type SymbolKind =
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'struct'
  | 'trait'
  | 'module'
  | 'function'
  | 'method'
  | 'const';

export interface CodeSymbol {
  name: string;
  kind: SymbolKind;
  /** 1-based line of the definition. */
  line: number;
  /** Enclosing class/struct/impl/module name for members. */
  container: string | null;
  /** The definition line, trimmed (shown to the model). */
  signature: string;
  /** Visible outside its file/module (export, pub, public, capitalised Go name, ...). */
  exported: boolean;
}

export type Language =
  'typescript' | 'python' | 'php' | 'go' | 'rust' | 'ruby' | 'java' | 'kotlin' | 'csharp';

const EXTENSIONS: Record<string, Language> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'typescript',
  jsx: 'typescript',
  mjs: 'typescript',
  cjs: 'typescript',
  vue: 'typescript',
  svelte: 'typescript',
  py: 'python',
  php: 'php',
  go: 'go',
  rs: 'rust',
  rb: 'ruby',
  rake: 'ruby',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  cs: 'csharp',
};

export function languageOf(path: string): Language | null {
  if (/\.d\.[cm]?ts$|\.min\.[cm]?js$/.test(path)) return null;
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return EXTENSIONS[ext] ?? null;
}

/** Container kinds whose members are recorded (interfaces and enums list no members). */
type ContainerRole = 'members' | 'opaque' | 'local';

interface Rule {
  re: RegExp;
  kind: SymbolKind;
  /** Capture group holding the name. */
  name: number;
  /** Only inside a member container (method), or only outside any container. */
  where?: 'member' | 'top';
  /** The definition opens a block: members inside are attributed to it (or ignored if local). */
  opens?: ContainerRole;
  /** Group holding the container name for receivers (Go methods). */
  receiver?: number;
  /** Only at column 0 (module level): skips helpers inside callbacks such as test blocks. */
  column0?: boolean;
  exported: (m: RegExpExecArray, name: string, line: string) => boolean;
}

const ID = '[A-Za-z_$][\\w$]*';
const KEYWORDS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'return',
  'function',
  'new',
  'throw',
  'else',
  'do',
  'try',
  'await',
  'typeof',
  'super',
  'this',
  'constructor',
  'using',
  'lock',
  'foreach',
  'when',
  'synchronized',
  'sizeof',
  'yield',
  'delete',
  'import',
  'require',
  'void',
]);

const notPrivate = (_m: RegExpExecArray, name: string, line: string) =>
  !/\b(private|protected)\b/.test(line) && !name.startsWith('#');

const RULES: Record<Language, Rule[]> = {
  typescript: [
    {
      re: new RegExp(
        `^\\s*(export\\s+)?(default\\s+)?(declare\\s+)?(abstract\\s+)?class\\s+(${ID})`,
      ),
      kind: 'class',
      name: 5,
      opens: 'members',
      exported: (m) => !!m[1],
    },
    {
      re: new RegExp(`^\\s*(export\\s+)?(declare\\s+)?interface\\s+(${ID})`),
      kind: 'interface',
      name: 3,
      opens: 'opaque',
      exported: (m) => !!m[1],
    },
    {
      re: new RegExp(`^\\s*(export\\s+)?(declare\\s+)?type\\s+(${ID})\\s*(<[^=]*>)?\\s*=`),
      kind: 'type',
      name: 3,
      exported: (m) => !!m[1],
    },
    {
      re: new RegExp(`^\\s*(export\\s+)?(declare\\s+)?(const\\s+)?enum\\s+(${ID})`),
      kind: 'enum',
      name: 4,
      opens: 'opaque',
      exported: (m) => !!m[1],
    },
    {
      re: new RegExp(
        `^\\s*(export\\s+)?(default\\s+)?(declare\\s+)?(async\\s+)?function\\s*\\*?\\s*(${ID})`,
      ),
      kind: 'function',
      name: 5,
      where: 'top',
      column0: true,
      opens: 'local',
      exported: (m) => !!m[1],
    },
    {
      // const handler = async (req) => ..., const Button = function () ..., const f = x => ...
      re: new RegExp(
        `^\\s*(export\\s+)?(const|let|var)\\s+(${ID})\\s*(:[^=]+)?=\\s*(async\\s+)?(function\\b|\\([^)]*\\)?\\s*(:[^=]*)?=>|\\([^)]*$|${ID}\\s*=>)`,
      ),
      kind: 'function',
      name: 3,
      where: 'top',
      column0: true,
      opens: 'local',
      exported: (m) => !!m[1],
    },
    {
      re: new RegExp(`^(export\\s+)(const|let|var)\\s+(${ID})`),
      kind: 'const',
      name: 3,
      where: 'top',
      exported: () => true,
    },
    {
      // Class members: methods, accessors, and arrow-function properties.
      re: new RegExp(
        `^\\s+((?:public|private|protected|static|readonly|async|override|abstract|declare|get|set)\\s+)*\\*?\\s*(#?${ID})\\s*(<[^>(]*>)?\\s*(\\(|=\\s*(async\\s+)?\\([^)]*\\)?\\s*(:[^=]*)?=>)`,
      ),
      kind: 'method',
      name: 2,
      where: 'member',
      opens: 'local',
      exported: notPrivate,
    },
  ],
  python: [
    {
      re: /^(\s*)class\s+([A-Za-z_]\w*)/,
      kind: 'class',
      name: 2,
      opens: 'members',
      exported: (_m, n) => !n.startsWith('_'),
    },
    {
      re: /^(\s*)(async\s+)?def\s+([A-Za-z_]\w*)\s*\(/,
      kind: 'method',
      name: 3,
      where: 'member',
      opens: 'local',
      exported: (_m, n) => !n.startsWith('_') || /^__\w+__$/.test(n),
    },
    {
      re: /^(\s*)(async\s+)?def\s+([A-Za-z_]\w*)\s*\(/,
      kind: 'function',
      name: 3,
      where: 'top',
      opens: 'local',
      exported: (_m, n) => !n.startsWith('_'),
    },
    {
      re: /^([A-Z][A-Z0-9_]+)\s*(:[^=]+)?=/,
      kind: 'const',
      name: 1,
      where: 'top',
      exported: () => true,
    },
  ],
  php: [
    {
      re: /^\s*((?:final|abstract|readonly)\s+)*(class|interface|trait|enum)\s+([A-Za-z_]\w*)/,
      kind: 'class',
      name: 3,
      opens: 'members',
      exported: () => true,
    },
    {
      re: /^\s*((?:public|private|protected|static|final|abstract)\s+)*function\s+&?\s*([A-Za-z_]\w*)\s*\(/,
      kind: 'method',
      name: 2,
      where: 'member',
      opens: 'local',
      exported: notPrivate,
    },
    {
      re: /^\s*function\s+&?\s*([A-Za-z_]\w*)\s*\(/,
      kind: 'function',
      name: 1,
      where: 'top',
      opens: 'local',
      exported: () => true,
    },
  ],
  go: [
    {
      re: /^func\s+\(\s*\w*\s*\*?\s*(\w+)(?:\[[^\]]*\])?\s*\)\s*(\w+)\s*[[(]/,
      kind: 'method',
      name: 2,
      receiver: 1,
      exported: (_m, n) => /^[A-Z]/.test(n),
    },
    {
      re: /^func\s+(\w+)\s*[[(]/,
      kind: 'function',
      name: 1,
      exported: (_m, n) => /^[A-Z]/.test(n),
    },
    {
      re: /^type\s+(\w+)(?:\[[^\]]*\])?\s+struct\b/,
      kind: 'struct',
      name: 1,
      exported: (_m, n) => /^[A-Z]/.test(n),
    },
    {
      re: /^type\s+(\w+)(?:\[[^\]]*\])?\s+interface\b/,
      kind: 'interface',
      name: 1,
      exported: (_m, n) => /^[A-Z]/.test(n),
    },
    {
      re: /^type\s+(\w+)\b/,
      kind: 'type',
      name: 1,
      exported: (_m, n) => /^[A-Z]/.test(n),
    },
    {
      re: /^(?:const|var)\s+([A-Z]\w*)\b/,
      kind: 'const',
      name: 1,
      exported: () => true,
    },
  ],
  rust: [
    {
      re: /^\s*(pub(\([^)]*\))?\s+)?(struct|union)\s+(\w+)/,
      kind: 'struct',
      name: 4,
      exported: (m) => !!m[1],
    },
    {
      re: /^\s*(pub(\([^)]*\))?\s+)?enum\s+(\w+)/,
      kind: 'enum',
      name: 3,
      opens: 'opaque',
      exported: (m) => !!m[1],
    },
    {
      re: /^\s*(pub(\([^)]*\))?\s+)?(unsafe\s+)?trait\s+(\w+)/,
      kind: 'trait',
      name: 4,
      opens: 'members',
      exported: (m) => !!m[1],
    },
    {
      re: /^\s*(pub(\([^)]*\))?\s+)?type\s+(\w+)/,
      kind: 'type',
      name: 3,
      exported: (m) => !!m[1],
    },
    {
      re: /^\s*(pub(\([^)]*\))?\s+)?mod\s+(\w+)/,
      kind: 'module',
      name: 3,
      exported: (m) => !!m[1],
    },
    {
      re: /^\s*(pub(\([^)]*\))?\s+)?(?:const|static)\s+(?:mut\s+)?([A-Z_][A-Z0-9_]*)\s*:/,
      kind: 'const',
      name: 3,
      where: 'top',
      exported: (m) => !!m[1],
    },
    {
      re: /^\s*(pub(\([^)]*\))?\s+)?((?:async|unsafe|const|extern\s+"[^"]*")\s+)*fn\s+(\w+)/,
      kind: 'method',
      name: 4,
      where: 'member',
      opens: 'local',
      exported: (m) => !!m[1],
    },
    {
      re: /^\s*(pub(\([^)]*\))?\s+)?((?:async|unsafe|const|extern\s+"[^"]*")\s+)*fn\s+(\w+)/,
      kind: 'function',
      name: 4,
      where: 'top',
      opens: 'local',
      exported: (m) => !!m[1],
    },
  ],
  ruby: [
    {
      re: /^\s*(class|module)\s+([A-Z][\w:]*)/,
      kind: 'class',
      name: 2,
      opens: 'members',
      exported: () => true,
    },
    {
      re: /^\s*def\s+(self\.)?([A-Za-z_]\w*[?!=]?)/,
      kind: 'method',
      name: 2,
      where: 'member',
      opens: 'local',
      exported: () => true,
    },
    {
      re: /^\s*def\s+(self\.)?([A-Za-z_]\w*[?!=]?)/,
      kind: 'function',
      name: 2,
      where: 'top',
      opens: 'local',
      exported: () => true,
    },
  ],
  java: [
    {
      re: /^\s*((?:public|private|protected|static|final|abstract|sealed|non-sealed|strictfp)\s+)*(class|interface|enum|record|@interface)\s+(\w+)/,
      kind: 'class',
      name: 3,
      opens: 'members',
      exported: (_m, _n, line) => !/\bprivate\b/.test(line),
    },
    {
      re: /^\s+((?:public|private|protected|static|final|abstract|synchronized|native|default)\s+)*(<[^>]+>\s+)?[\w<>[\],.? ]+?\s+(\w+)\s*\([^;]*$/,
      kind: 'method',
      name: 3,
      where: 'member',
      opens: 'local',
      exported: notPrivate,
    },
  ],
  kotlin: [
    {
      re: /^\s*((?:public|private|protected|internal|open|abstract|sealed|data|enum|annotation|inner|value|final)\s+)*(class|interface|object)\s+(\w+)/,
      kind: 'class',
      name: 3,
      opens: 'members',
      exported: (_m, _n, line) => !/\bprivate\b/.test(line),
    },
    {
      re: /^\s*((?:public|private|protected|internal|open|override|abstract|suspend|inline|operator|infix|tailrec|final)\s+)*fun\s+(<[^>]*>\s*)?([\w.]+\.)?(\w+)\s*\(/,
      kind: 'method',
      name: 4,
      where: 'member',
      opens: 'local',
      exported: notPrivate,
    },
    {
      re: /^\s*((?:public|private|internal|inline|suspend|operator|infix|tailrec)\s+)*fun\s+(<[^>]*>\s*)?([\w.]+\.)?(\w+)\s*\(/,
      kind: 'function',
      name: 4,
      where: 'top',
      opens: 'local',
      exported: notPrivate,
    },
  ],
  csharp: [
    {
      re: /^\s*((?:public|private|protected|internal|static|sealed|abstract|partial|readonly|ref|file)\s+)*(class|interface|enum|struct|record)\s+(\w+)/,
      kind: 'class',
      name: 3,
      opens: 'members',
      exported: (_m, _n, line) => /\bpublic\b/.test(line),
    },
    {
      re: /^\s+((?:public|private|protected|internal|static|virtual|override|abstract|async|sealed|extern|unsafe|new|partial)\s+)+[\w<>[\],.? ]+?\s+(\w+)\s*(<[^>]*>)?\s*\([^;]*$/,
      kind: 'method',
      name: 2,
      where: 'member',
      opens: 'local',
      exported: (_m, _n, line) => /\bpublic\b/.test(line),
    },
  ],
};

const MAX_LINE = 400;
const MAX_SYMBOLS = 500;

interface Open {
  name: string;
  indent: number;
  role: ContainerRole;
}

function indentOf(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === ' ') n++;
    else if (ch === '\t') n += 4;
    else break;
  }
  return n;
}

/** Definitions in one source file. */
export function extractSymbols(path: string, text: string): CodeSymbol[] {
  const language = languageOf(path);
  if (!language) return [];
  const rules = RULES[language];
  const symbols: CodeSymbol[] = [];
  const stack: Open[] = [];
  const lines = text.split('\n');
  let inBlockComment = false;
  const cLike = language !== 'python' && language !== 'ruby';

  for (let i = 0; i < lines.length && symbols.length < MAX_SYMBOLS; i++) {
    const raw = lines[i]!.replace(/\r$/, '');
    if (raw.length > MAX_LINE) continue; // minified or generated
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (cLike) {
      if (inBlockComment) {
        if (trimmed.includes('*/')) inBlockComment = false;
        continue;
      }
      if (trimmed.startsWith('/*')) {
        if (!trimmed.includes('*/')) inBlockComment = true;
        continue;
      }
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
    } else if (trimmed.startsWith('#')) {
      continue;
    }

    const indent = indentOf(raw);
    // The rest of a multi-line signature or call (`): Promise<T> {`, `]);`): never a definition,
    // and not the end of a block.
    if (/^[)\]]/.test(trimmed)) continue;
    // A brace on its own line (Allman style, PHP and C#) opens the block just defined.
    if (trimmed.startsWith('{')) continue;
    // Leaving a block: the closing brace (or Ruby's `end`) sits at the container's indentation;
    // Python just dedents.
    // `}> {` or `}): Promise<T> {` at the definition's own indentation ends a multi-line
    // signature (a type literal), not the block.
    if (/^}.*\{$/.test(trimmed) && stack.length && indent === stack.at(-1)!.indent) continue;
    const closes = trimmed.startsWith('}') || /^end\b/.test(trimmed);
    while (stack.length && indent <= stack.at(-1)!.indent) {
      stack.pop();
      if (closes) break;
    }
    if (closes) continue;

    const top = stack.at(-1);
    // Inside a function (or an interface/enum body) nothing is recorded: local helpers and fields.
    if (top && top.role !== 'members') continue;
    for (const rule of rules) {
      if (rule.where === 'member' && !top) continue;
      if (rule.where === 'top' && top) continue;
      if (rule.column0 && indent > 0) continue;
      const m = rule.re.exec(raw);
      if (!m) continue;
      const name = m[rule.name];
      if (!name || KEYWORDS.has(name)) continue;
      const container = rule.receiver ? (m[rule.receiver] ?? null) : (top?.name ?? null);
      symbols.push({
        name,
        kind: rule.kind,
        line: i + 1,
        container,
        signature: trimmed.replace(/\s*[{:]\s*$/, '').slice(0, 160),
        exported: rule.exported(m, name, raw),
      });
      // A one-line body (`foo() { ... }`, `def f(): pass`) opens nothing.
      const oneLine = /\{.*\}\s*;?$/.test(trimmed) || /;\s*$/.test(trimmed);
      if (rule.opens && !oneLine) stack.push({ name, indent, role: rule.opens });
      break;
    }
    // Rust impl blocks and other containers that are not symbols themselves.
    if (language === 'rust' && !top) {
      const impl = /^\s*impl(?:<[^>]*>)?\s+(?:[\w:]+(?:<[^>]*>)?\s+for\s+)?([\w:]+)/.exec(raw);
      if (impl && !/\{.*\}\s*$/.test(trimmed))
        stack.push({ name: impl[1]!.split('::').at(-1)!, indent, role: 'members' });
    }
  }
  return symbols;
}
