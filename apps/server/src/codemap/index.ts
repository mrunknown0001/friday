import fs from 'node:fs/promises';
import path from 'node:path';
import type { CodeMapStatusDto } from '@friday/shared';
import { transaction, type Db } from '../db/database.js';
import { isSecretPath } from '../workspace/paths.js';
import { walk } from '../workspace/walk.js';
import { extractSymbols, languageOf, type CodeSymbol, type SymbolKind } from './extract.js';

/**
 * The code map: symbol definitions of a project, stored in SQLite and refreshed on demand. A
 * refresh walks the project like the file tree does (.gitignore and dependency folders excluded,
 * credential files skipped) and re-reads only files whose size or modification time changed, so
 * repeated use on a large repository stays cheap.
 */

export const CODEMAP_LIMITS = {
  /** Source files indexed per project. */
  maxFiles: 30_000,
  /** Larger files are usually generated or bundled. */
  maxFileBytes: 512 * 1024,
  /** A refresh younger than this is reused instead of walking the project again. */
  freshMs: 15_000,
} as const;

export interface IndexStats {
  files: number;
  symbols: number;
  /** Files (re)read in this refresh. */
  changed: number;
  removed: number;
  durationMs: number;
  /** The project has more source files than the limit; the rest are not indexed. */
  truncated: boolean;
}

export interface SymbolRow extends CodeSymbol {
  path: string;
}

interface Row {
  path: string;
  name: string;
  kind: SymbolKind;
  line: number;
  container: string | null;
  signature: string;
  exported: number;
}

const toSymbol = (r: Row): SymbolRow => ({ ...r, exported: r.exported === 1 });

const BATCH = 200;

export class CodeMap {
  private readonly last = new Map<string, { at: number; stats: IndexStats }>();
  private readonly running = new Map<string, Promise<IndexStats>>();

  constructor(private readonly db: Db) {}

  /** Bring the index up to date (or reuse a refresh from the last few seconds). */
  async refresh(
    project: { id: string; rootPath: string },
    opts: { force?: boolean; signal?: AbortSignal } = {},
  ): Promise<IndexStats> {
    const recent = this.last.get(project.id);
    if (!opts.force && recent && Date.now() - recent.at < CODEMAP_LIMITS.freshMs)
      return { ...recent.stats, changed: 0, removed: 0, durationMs: 0 };
    const pending = this.running.get(project.id);
    if (pending) return pending;
    const job = this.index(project, opts.signal).finally(() => this.running.delete(project.id));
    this.running.set(project.id, job);
    const stats = await job;
    this.last.set(project.id, { at: Date.now(), stats });
    return stats;
  }

  private async index(
    project: { id: string; rootPath: string },
    signal?: AbortSignal,
  ): Promise<IndexStats> {
    const started = Date.now();
    const root = project.rootPath;
    const walked = await walk(root, root, {
      maxDepth: 40,
      maxEntries: CODEMAP_LIMITS.maxFiles,
      includeDirs: false,
      ...(signal ? { signal } : {}),
    });
    const sources = walked.entries.filter(
      (e) =>
        e.type === 'file' &&
        e.size !== null &&
        e.size <= CODEMAP_LIMITS.maxFileBytes &&
        languageOf(e.rel) !== null &&
        !isSecretPath(e.rel),
    );
    const stored = new Map(
      (
        this.db
          .prepare('SELECT path, size, mtime_ms FROM code_files WHERE project_id = ?')
          .all(project.id) as Array<{ path: string; size: number; mtime_ms: number }>
      ).map((r) => [r.path, r]),
    );

    const updates: Array<{ path: string; size: number; mtime: number; symbols: CodeSymbol[] }> = [];
    const seen = new Set<string>();
    for (const e of sources) {
      if (signal?.aborted) throw new Error('aborted');
      seen.add(e.rel);
      const size = e.size!;
      const mtime = e.mtimeMs ?? 0;
      const before = stored.get(e.rel);
      if (before && before.size === size && before.mtime_ms === mtime) continue;
      const buf = await fs.readFile(path.join(root, e.rel)).catch(() => null);
      if (!buf) continue;
      // Binary content behind a source extension: index nothing, but remember the file.
      const text = buf.subarray(0, 8192).includes(0) ? '' : buf.toString('utf8');
      updates.push({ path: e.rel, size, mtime, symbols: extractSymbols(e.rel, text) });
    }
    const removed = [...stored.keys()].filter((p) => !seen.has(p));

    const delSymbols = this.db.prepare(
      'DELETE FROM code_symbols WHERE project_id = ? AND path = ?',
    );
    const delFile = this.db.prepare('DELETE FROM code_files WHERE project_id = ? AND path = ?');
    const putFile = this.db.prepare(
      `INSERT INTO code_files (project_id, path, size, mtime_ms, symbol_count) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(project_id, path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms,
         symbol_count = excluded.symbol_count`,
    );
    const putSymbol = this.db.prepare(
      `INSERT INTO code_symbols (project_id, path, name, kind, line, container, signature, exported)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (let i = 0; i < Math.max(updates.length, removed.length); i += BATCH) {
      transaction(this.db, () => {
        for (const p of removed.slice(i, i + BATCH)) {
          delSymbols.run(project.id, p);
          delFile.run(project.id, p);
        }
        for (const u of updates.slice(i, i + BATCH)) {
          delSymbols.run(project.id, u.path);
          for (const s of u.symbols)
            putSymbol.run(
              project.id,
              u.path,
              s.name,
              s.kind,
              s.line,
              s.container,
              s.signature,
              s.exported ? 1 : 0,
            );
          putFile.run(project.id, u.path, u.size, u.mtime, u.symbols.length);
        }
      });
    }
    const { files, symbols } = this.status(project.id);
    return {
      files,
      symbols,
      changed: updates.length,
      removed: removed.length,
      durationMs: Date.now() - started,
      truncated: walked.truncated,
    };
  }

  /** When the index was last brought up to date in this server run, and what that found. */
  lastRefresh(projectId: string): CodeMapStatusDto['lastRefresh'] {
    const r = this.last.get(projectId);
    return r
      ? {
          at: new Date(r.at).toISOString(),
          durationMs: r.stats.durationMs,
          truncated: r.stats.truncated,
        }
      : null;
  }

  /** Files may have changed (an approved edit or command ran): refresh on next use. */
  invalidate(projectId: string): void {
    this.last.delete(projectId);
  }

  status(projectId: string): { files: number; symbols: number } {
    const r = this.db
      .prepare(
        'SELECT COUNT(*) AS files, COALESCE(SUM(symbol_count), 0) AS symbols FROM code_files WHERE project_id = ?',
      )
      .get(projectId) as { files: number; symbols: number };
    return { files: r.files, symbols: r.symbols };
  }

  /** Forget a project's index (it is rebuilt on next use). */
  clear(projectId: string): void {
    transaction(this.db, () => {
      this.db.prepare('DELETE FROM code_symbols WHERE project_id = ?').run(projectId);
      this.db.prepare('DELETE FROM code_files WHERE project_id = ?').run(projectId);
    });
    this.last.delete(projectId);
  }

  /** Symbols of one file, or of every file under a folder ('' for the whole project). */
  symbolsUnder(projectId: string, target: string, isFile: boolean): SymbolRow[] {
    const rows = (
      isFile
        ? this.db
            .prepare(
              'SELECT * FROM code_symbols WHERE project_id = ? AND path = ? ORDER BY path, line',
            )
            .all(projectId, target)
        : this.db
            .prepare(
              'SELECT * FROM code_symbols WHERE project_id = ? AND substr(path, 1, ?) = ? ORDER BY path, line',
            )
            .all(projectId, target.length, target)
    ) as Row[];
    return rows.map(toSymbol);
  }

  /** Indexed files under a folder (files without symbols included), with their symbol counts. */
  filesUnder(projectId: string, prefix: string): Array<{ path: string; symbols: number }> {
    return (
      this.db
        .prepare(
          'SELECT path, symbol_count AS symbols FROM code_files WHERE project_id = ? AND substr(path, 1, ?) = ? ORDER BY path',
        )
        .all(projectId, prefix.length, prefix) as Array<{ path: string; symbols: number }>
    ).slice(0, CODEMAP_LIMITS.maxFiles);
  }

  /**
   * Definitions matching a name: exact matches first, then prefix, then substring (all case
   * insensitive). "Class.method" also matches a member by its container.
   */
  find(projectId: string, query: string, kind?: SymbolKind, limit = 30): SymbolRow[] {
    const dot = query.lastIndexOf('.');
    const container = dot > 0 ? query.slice(0, dot) : null;
    const name = dot > 0 ? query.slice(dot + 1) : query;
    if (!name) return [];
    const like = `%${name.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = (
      this.db
        .prepare(
          `SELECT * FROM code_symbols WHERE project_id = ? AND name LIKE ? ESCAPE '\\'
             AND (? IS NULL OR kind = ?) AND (? IS NULL OR container = ? COLLATE NOCASE)
           LIMIT 2000`,
        )
        .all(projectId, like, kind ?? null, kind ?? null, container, container) as Row[]
    ).map(toSymbol);
    const lower = name.toLowerCase();
    const rank = (s: SymbolRow) =>
      (s.name === name
        ? 0
        : s.name.toLowerCase() === lower
          ? 1
          : s.name.toLowerCase().startsWith(lower)
            ? 2
            : 3) *
        2 +
      (s.exported ? 0 : 1);
    return rows
      .sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path) || a.line - b.line)
      .slice(0, limit);
  }
}
