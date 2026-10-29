import fs from 'node:fs/promises';
import { z } from 'zod';
import type { CodeMap, IndexStats } from '../codemap/index.js';
import { renderOutline } from '../codemap/outline.js';
import { resolveInside, WorkspaceError } from '../workspace/paths.js';
import { search } from '../workspace/search.js';
import { defineTool, type ToolContext } from './types.js';

const KINDS = [
  'class',
  'interface',
  'type',
  'enum',
  'struct',
  'trait',
  'module',
  'function',
  'method',
  'const',
] as const;

const LANGUAGES = 'TypeScript/JavaScript, Python, PHP, Go, Rust, Ruby, Java, Kotlin and C#';

function codeMap(ctx: ToolContext): CodeMap {
  if (!ctx.codeMap) throw new WorkspaceError('unsupported', 'The code map is not available here.');
  return ctx.codeMap;
}

function indexNote(stats: IndexStats): string {
  return `index: ${stats.files} source files, ${stats.symbols} definitions${stats.changed || stats.removed ? ` (${stats.changed} re-read, ${stats.removed} removed, ${stats.durationMs} ms)` : ''}${stats.truncated ? '; the project has more files than the index limit, so some are missing' : ''}`;
}

export const codeMapTool = defineTool({
  name: 'code_map',
  description: `Outline of the project's code: the classes, functions, methods, types and constants defined in each file, with line numbers. Start here in an unfamiliar or large project instead of reading files blindly, then narrow with \`path\` (a folder or one file). Big scopes are summarised (names per file, or per folder); a single file always shows every definition. Covers ${LANGUAGES}; found by patterns, not a compiler, so unusual syntax can be missed.`,
  category: 'read_only',
  risk: 'none',
  requiresProject: true,
  schema: z.object({
    path: z
      .string()
      .max(1024)
      .default('.')
      .describe('Folder or file relative to the project root ("." for everything).'),
    members: z
      .boolean()
      .default(false)
      .describe('Also list class/struct members (methods). Always on for a single file.'),
  }),
  describeCall: (a) => a.path,
  async execute(args, ctx) {
    const project = ctx.project!;
    const map = codeMap(ctx);
    const stats = await map.refresh(project, { signal: ctx.signal });
    let target = '';
    let isFile = false;
    if (args.path !== '.' && args.path !== '') {
      const resolved = await resolveInside(project.rootPath, args.path);
      isFile = (await fs.stat(resolved.abs)).isFile();
      target = isFile ? resolved.rel : `${resolved.rel.replace(/\/$/, '')}/`;
      if (resolved.rel === '.') target = '';
    }
    const symbols = map.symbolsUnder(project.id, target, isFile);
    const scope = target || 'the project';
    if (!symbols.length) {
      const files = isFile ? [] : map.filesUnder(project.id, target);
      return {
        content: `No definitions found in ${scope}${files.length ? ` (${files.length} source files without recognisable definitions)` : isFile ? ' (not a supported source file, or it defines nothing)' : ' (no supported source files)'}. Supported: ${LANGUAGES}. Use list_directory or search_code instead.\n${indexNote(stats)}`,
        summary: 'no definitions',
      };
    }
    const outline = renderOutline(symbols, {
      members: args.members || isFile,
      budget: ctx.maxOutputChars - 1_000,
    });
    const files = new Set(symbols.map((s) => s.path)).size;
    const hint =
      outline.level === 'signatures'
        ? ''
        : `\n(${outline.level === 'names' ? 'Names only' : 'Summary per folder'} to fit; call code_map with a narrower path for signatures and line numbers.)`;
    return {
      content: `Code map of ${scope}: ${files} files, ${symbols.length} definitions. Lines are "line: definition".\n${outline.text}${hint}\n${indexNote(stats)}`,
      summary: `${files} files, ${symbols.length} definitions`,
    };
  },
});

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const findSymbol = defineTool({
  name: 'find_symbol',
  description: `Find where a class, function, method, type or constant is defined (file:line and signature), by name: exact matches first, then names starting with or containing it. Use "Class.method" for a member. With references=true it also lists the lines that mention the name elsewhere (text matches of the whole word, so a different symbol with the same name can appear). Faster and more precise than search_code for "where is X defined / used". Covers ${LANGUAGES}.`,
  category: 'read_only',
  risk: 'none',
  requiresProject: true,
  schema: z.object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[\w$#.:\\-]+$/, 'A symbol name, e.g. RunManager or RunManager.startMessage.'),
    kind: z.enum(KINDS).optional(),
    references: z.boolean().default(false),
  }),
  describeCall: (a) => `${a.name}${a.references ? ' +refs' : ''}`,
  async execute(args, ctx) {
    const project = ctx.project!;
    const map = codeMap(ctx);
    const stats = await map.refresh(project, { signal: ctx.signal });
    const query = args.name.replace(/::|\\/g, '.');
    const defs = map.find(project.id, query, args.kind);
    const lines: string[] = [];
    if (!defs.length) {
      lines.push(
        `No definition named like "${args.name}"${args.kind ? ` (kind ${args.kind})` : ''}. It may be defined in an unsupported language, generated, or written in an unusual way: try search_code.`,
      );
    } else {
      lines.push(`Definitions (${defs.length}${defs.length === 30 ? '+' : ''}):`);
      for (const d of defs)
        lines.push(
          `${d.path}:${d.line}  ${d.kind} ${d.container ? `${d.container}.` : ''}${d.name}${d.exported ? '' : ' (not exported)'}\n    ${d.signature}`,
        );
    }

    if (args.references) {
      const bare = query.slice(query.lastIndexOf('.') + 1);
      const result = await search(project.rootPath, ctx.env.ripgrep, {
        query: bare,
        regex: false,
        caseSensitive: true,
        targetAbs: project.rootPath,
        maxResults: 500,
        signal: ctx.signal,
      });
      const word = new RegExp(`(^|[^\\w$])${escapeRe(bare)}([^\\w$]|$)`);
      const definedAt = new Set(defs.map((d) => `${d.path}:${d.line}`));
      const refs = result.matches.filter(
        (m) => word.test(m.text) && !definedAt.has(`${m.path}:${m.line}`),
      );
      const shown = refs.slice(0, 60);
      lines.push(
        '',
        refs.length
          ? `References to "${bare}" (${refs.length}${result.truncated ? '+' : ''} lines, whole-word text matches):`
          : `No other lines mention "${bare}".`,
        ...shown.map((m) => `${m.path}:${m.line}: ${m.text.trim()}`),
        ...(refs.length > shown.length ? [`… ${refs.length - shown.length} more`] : []),
      );
    }
    lines.push(indexNote(stats));
    return {
      content: lines.join('\n'),
      summary: defs.length
        ? `${defs.length} definition${defs.length === 1 ? '' : 's'}`
        : 'not found',
    };
  },
});
