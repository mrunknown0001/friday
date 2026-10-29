import fs from 'node:fs/promises';
import path from 'node:path';
import { WorkspaceError } from './paths.js';

export const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_LINE_CHARS = 2_000;

export interface LoadedFile {
  size: number;
  mtime: string;
  binary: boolean;
  tooLarge: boolean;
  text: string | null;
}

/** Binary if it contains NUL bytes or is not valid UTF-8. */
export function looksBinary(buf: Buffer): boolean {
  if (buf.subarray(0, 8_192).includes(0)) return true;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return false;
  } catch {
    return true;
  }
}

export async function loadFile(abs: string, maxBytes = MAX_TEXT_FILE_BYTES): Promise<LoadedFile> {
  const stat = await fs.stat(abs);
  if (!stat.isFile()) throw new WorkspaceError('not_a_file', 'Path is not a regular file.');
  const base = { size: stat.size, mtime: stat.mtime.toISOString() };
  if (stat.size > maxBytes) return { ...base, binary: false, tooLarge: true, text: null };
  const buf = await fs.readFile(abs);
  if (looksBinary(buf)) return { ...base, binary: true, tooLarge: false, text: null };
  return { ...base, binary: false, tooLarge: false, text: buf.toString('utf8') };
}

export function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return lines;
}

export interface LineSlice {
  output: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
}

/** Number lines `start..end` (1-based, inclusive), bounded by line and character budgets. */
export function sliceLines(
  lines: string[],
  start: number,
  end: number,
  maxChars: number,
): LineSlice {
  const totalLines = lines.length;
  const from = Math.max(1, Math.min(start, Math.max(totalLines, 1)));
  const to = Math.min(totalLines, Math.max(end, from));
  const width = String(to).length;
  const out: string[] = [];
  let chars = 0;
  let last = from - 1;
  let truncated = to < totalLines || from > 1;
  for (let n = from; n <= to; n++) {
    let line = lines[n - 1] ?? '';
    if (line.length > MAX_LINE_CHARS) line = `${line.slice(0, MAX_LINE_CHARS)} …[line truncated]`;
    const formatted = `${String(n).padStart(width)} | ${line}`;
    if (chars + formatted.length + 1 > maxChars && out.length > 0) {
      truncated = true;
      break;
    }
    out.push(formatted);
    chars += formatted.length + 1;
    last = n;
  }
  return { output: out.join('\n'), startLine: from, endLine: last, totalLines, truncated };
}

const LANGUAGES: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'jsx',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.json': 'json',
  '.php': 'php',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.rb': 'ruby',
  '.java': 'java',
  '.kt': 'kotlin',
  '.cs': 'csharp',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'bash',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.toml': 'ini',
  '.ini': 'ini',
  '.md': 'markdown',
  '.html': 'xml',
  '.vue': 'xml',
  '.xml': 'xml',
  '.css': 'css',
  '.scss': 'scss',
  '.sql': 'sql',
  '.dockerfile': 'dockerfile',
  '.conf': 'nginx',
};

export function languageFor(filePath: string): string | null {
  const base = path.basename(filePath).toLowerCase();
  if (base === 'dockerfile' || base.startsWith('dockerfile.')) return 'dockerfile';
  if (base === 'makefile') return 'makefile';
  if (base.endsWith('.blade.php')) return 'php';
  return LANGUAGES[path.extname(base)] ?? null;
}
