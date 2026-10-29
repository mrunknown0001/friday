import fs from 'node:fs/promises';
import { z } from 'zod';
import { detectProject } from '../workspace/detect.js';
import { languageFor, loadFile, sliceLines, splitLines } from '../workspace/files.js';
import { assertRootAvailable, resolveInside, WorkspaceError } from '../workspace/paths.js';
import { formatMatches, globToRegExp, search } from '../workspace/search.js';
import { formatSize, walk } from '../workspace/walk.js';
import { defineTool, type ToolContext } from './types.js';

async function projectRoot(ctx: ToolContext): Promise<string> {
  if (!ctx.project)
    throw new WorkspaceError('unsupported', 'This conversation is not attached to a project.');
  await assertRootAvailable(ctx.project.rootPath);
  return ctx.project.rootPath;
}

const relPath = z
  .string()
  .max(1024)
  .describe('Path relative to the project root (forward slashes). Use "." for the root.');

export const inspectProject = defineTool({
  name: 'inspect_project',
  description:
    'Summarize the project: detected languages/frameworks, package managers, manifests, scripts (build/test commands), workspaces, and top-level entries. Call this first when starting work on a project.',
  category: 'read_only',
  risk: 'none',
  requiresProject: true,
  schema: z.object({}),
  describeCall: () => 'project overview',
  async execute(_args, ctx) {
    const root = await projectRoot(ctx);
    const d = await detectProject(root);
    const lines = [
      `Project: ${ctx.project!.name}`,
      `Stack: ${d.stack.join(', ') || 'unknown'}`,
      `Package managers: ${d.packageManagers.join(', ') || 'none detected'}`,
      `Manifests: ${d.manifests.join(', ') || 'none'}`,
      `Git repository: ${d.isGitRepo ? 'yes' : 'no'}`,
    ];
    if (d.workspaces.length) lines.push(`Workspaces: ${d.workspaces.join(', ')}`);
    for (const [file, s] of Object.entries(d.scripts)) {
      lines.push(`Scripts in ${file}:`, ...Object.entries(s).map(([k, v]) => `  ${k}: ${v}`));
    }
    lines.push(`Top level: ${d.topLevel.join('  ')}`);
    if (d.notes.length) lines.push(`Notes: ${d.notes.join('; ')}`);
    return {
      content: lines.join('\n'),
      summary: d.stack.length ? d.stack.slice(0, 6).join(', ') : 'No known stack detected',
    };
  },
});

export const listDirectory = defineTool({
  name: 'list_directory',
  description:
    'List files and folders as an indented tree with sizes. Respects .gitignore and skips dependency/build folders (node_modules, vendor, dist, .git, ...).',
  category: 'read_only',
  risk: 'none',
  requiresProject: true,
  schema: z.object({
    path: relPath.default('.'),
    depth: z.number().int().min(1).max(6).default(2).describe('How many levels to descend (1-6).'),
    max_entries: z.number().int().min(10).max(1000).default(300),
  }),
  describeCall: (a) => `${a.path ?? '.'} (depth ${a.depth ?? 2})`,
  async execute(args, ctx) {
    const root = await projectRoot(ctx);
    const target = await resolveInside(root, args.path);
    const stat = await fs.stat(target.abs);
    if (!stat.isDirectory())
      throw new WorkspaceError('not_a_directory', `"${target.rel}" is a file; use read_file.`);
    const { entries, truncated } = await walk(root, target.abs, {
      maxDepth: args.depth,
      maxEntries: args.max_entries,
      signal: ctx.signal,
    });
    const body = entries
      .map((e) => {
        const indent = '  '.repeat(e.depth - 1);
        if (e.type === 'dir') return `${indent}${e.name}/`;
        if (e.type === 'symlink') return `${indent}${e.name} -> (symlink, not followed)`;
        return `${indent}${e.name} (${formatSize(e.size)})`;
      })
      .join('\n');
    const files = entries.filter((e) => e.type === 'file').length;
    const note = truncated
      ? `\n[truncated at ${args.max_entries} entries; list a subfolder or lower depth]`
      : '';
    return {
      content: `${target.rel}/\n${body || '(empty or fully ignored)'}${note}`,
      summary: `${files} files, ${entries.length - files} folders${truncated ? ' (truncated)' : ''}`,
      truncated,
    };
  },
});

const DEFAULT_READ_LINES = 400;
const MAX_READ_LINES = 1_000;

export const readFile = defineTool({
  name: 'read_file',
  description:
    'Read a text file with line numbers. Reads lines 1-400 by default; use start_line/end_line for other ranges (max 1000 lines per call). Binary, oversized, and credential files are refused.',
  category: 'read_only',
  risk: 'none',
  requiresProject: true,
  schema: z.object({
    path: relPath,
    start_line: z.number().int().min(1).optional(),
    end_line: z.number().int().min(1).optional(),
  }),
  describeCall: (a) =>
    a.start_line || a.end_line ? `${a.path}:${a.start_line ?? 1}-${a.end_line ?? ''}` : a.path,
  async execute(args, ctx) {
    const root = await projectRoot(ctx);
    const target = await resolveInside(root, args.path);
    const file = await loadFile(target.abs);
    if (file.tooLarge) {
      throw new WorkspaceError(
        'too_large',
        `"${target.rel}" is ${formatSize(file.size)}; too large to read. Use search_code to find relevant lines.`,
      );
    }
    if (file.binary || file.text === null) {
      return {
        content: `"${target.rel}" is a binary file (${formatSize(file.size)}); contents not shown.`,
        summary: 'binary file',
      };
    }
    const lines = splitLines(file.text);
    const start = args.start_line ?? 1;
    const requestedEnd = args.end_line ?? start + DEFAULT_READ_LINES - 1;
    const end = Math.min(requestedEnd, start + MAX_READ_LINES - 1);
    if (lines.length > 0 && start > lines.length) {
      throw new WorkspaceError('invalid_path', `"${target.rel}" has only ${lines.length} lines.`);
    }
    const slice = sliceLines(lines, start, end, ctx.maxOutputChars - 200);
    const header = `${target.rel} (lines ${slice.startLine}-${slice.endLine} of ${slice.totalLines})`;
    const more =
      slice.endLine < slice.totalLines
        ? `\n[more: continue with start_line=${slice.endLine + 1}]`
        : '';
    return {
      content: `${header}\n${slice.output}${more}`,
      summary: `${target.rel}:${slice.startLine}-${slice.endLine} of ${slice.totalLines} lines`,
      truncated: slice.truncated,
    };
  },
});

export const fileInfo = defineTool({
  name: 'file_info',
  description:
    'Get metadata for a file or folder: type, size, modification time, line count and language for text files.',
  category: 'read_only',
  risk: 'none',
  requiresProject: true,
  schema: z.object({ path: relPath }),
  describeCall: (a) => a.path,
  async execute(args, ctx) {
    const root = await projectRoot(ctx);
    const target = await resolveInside(root, args.path);
    const stat = await fs.stat(target.abs);
    if (stat.isDirectory()) {
      return {
        content: `${target.rel}: directory, modified ${stat.mtime.toISOString()}`,
        summary: 'directory',
      };
    }
    const file = await loadFile(target.abs);
    const kind = file.tooLarge ? 'large file (not inspected)' : file.binary ? 'binary' : 'text';
    const lineCount = file.text !== null ? splitLines(file.text).length : null;
    const info = [
      `${target.rel}: ${kind}`,
      `size: ${formatSize(file.size)} (${file.size} bytes)`,
      `modified: ${file.mtime}`,
      lineCount !== null ? `lines: ${lineCount}` : null,
      languageFor(target.rel) ? `language: ${languageFor(target.rel)}` : null,
    ].filter(Boolean);
    return {
      content: info.join('\n'),
      summary: `${kind}, ${formatSize(file.size)}${lineCount !== null ? `, ${lineCount} lines` : ''}`,
    };
  },
});

export const searchCode = defineTool({
  name: 'search_code',
  description:
    'Search file contents across the project (ripgrep when available). Literal by default; set regex=true for a regular expression. Respects .gitignore. Returns matching lines grouped by file with line numbers.',
  category: 'read_only',
  risk: 'none',
  requiresProject: true,
  schema: z.object({
    query: z.string().min(1).max(500),
    regex: z.boolean().default(false),
    case_sensitive: z.boolean().default(false),
    path: relPath.default('.').describe('Folder or file to search within.'),
    glob: z
      .string()
      .max(200)
      .regex(/^[^!\0]/, 'glob must not start with "!"')
      .optional()
      .describe('Only search files matching this glob, e.g. "*.php" or "src/**/*.ts".'),
    max_results: z.number().int().min(1).max(200).default(50),
  }),
  describeCall: (a) =>
    `"${a.query}"${a.path && a.path !== '.' ? ` in ${a.path}` : ''}${a.glob ? ` (${a.glob})` : ''}`,
  async execute(args, ctx) {
    const root = await projectRoot(ctx);
    const target = await resolveInside(root, args.path);
    const result = await search(root, ctx.env.ripgrep, {
      query: args.query,
      regex: args.regex,
      caseSensitive: args.case_sensitive,
      targetAbs: target.abs,
      glob: args.glob,
      maxResults: args.max_results,
      signal: ctx.signal,
    });
    const files = new Set(result.matches.map((m) => m.path)).size;
    const hiddenNote = result.hiddenSecretFiles.length
      ? `\n\n[Also matched in credential files whose contents are hidden by policy: ${result.hiddenSecretFiles.join(', ')}. The matches exist; tell the user rather than concluding there are none.]`
      : '';
    if (result.matches.length === 0) {
      return {
        content: `No readable matches for "${args.query}" in ${target.rel}.${hiddenNote}`,
        summary: result.hiddenSecretFiles.length
          ? `matches only in credential files (hidden)`
          : 'no matches',
      };
    }
    const note = result.truncated
      ? `\n\n[results truncated at ${result.matches.length}; narrow with path or glob]`
      : '';
    return {
      content: `${result.matches.length} matches in ${files} files:\n\n${formatMatches(result)}${note}${hiddenNote}`,
      summary: `${result.matches.length} matches in ${files} files${result.truncated ? ' (truncated)' : ''}`,
      truncated: result.truncated,
    };
  },
});

export const findFiles = defineTool({
  name: 'find_files',
  description:
    'Find files by name or path. A pattern with * or ? is a glob matched against the path relative to the root (e.g. "**/*.test.ts", "routes/*.php"); otherwise it is a case-insensitive substring of the path.',
  category: 'read_only',
  risk: 'none',
  requiresProject: true,
  schema: z.object({
    pattern: z.string().min(1).max(200),
    path: relPath.default('.'),
    max_results: z.number().int().min(1).max(500).default(100),
  }),
  describeCall: (a) => a.pattern,
  async execute(args, ctx) {
    const root = await projectRoot(ctx);
    const target = await resolveInside(root, args.path);
    const { entries, truncated: walkTruncated } = await walk(root, target.abs, {
      maxDepth: 64,
      maxEntries: 20_000,
      includeDirs: false,
      signal: ctx.signal,
    });
    const isGlob = /[*?]/.test(args.pattern);
    const re = isGlob ? globToRegExp(args.pattern) : null;
    const needle = args.pattern.toLowerCase();
    const hits = entries.filter((e) => {
      if (e.type !== 'file') return false;
      if (re) return re.test(e.rel) || (!args.pattern.includes('/') && re.test(e.name));
      return e.rel.toLowerCase().includes(needle);
    });
    const shown = hits.slice(0, args.max_results);
    const truncated = hits.length > shown.length || walkTruncated;
    if (shown.length === 0)
      return { content: `No files matching "${args.pattern}".`, summary: 'no files' };
    return {
      content: `${shown.map((e) => `${e.rel} (${formatSize(e.size)})`).join('\n')}${truncated ? `\n[truncated: ${hits.length} matches shown ${shown.length}]` : ''}`,
      summary: `${hits.length} files${truncated ? ' (truncated)' : ''}`,
      truncated,
    };
  },
});
