import { randomUUID } from 'node:crypto';
import type { SandboxSettings, WorktreeInfo } from '@friday/shared';
import type { Db } from '../db/database.js';

export interface ProjectRecord {
  id: string;
  name: string;
  /** Canonical (realpath) absolute root. Every tool call is confined to this directory. */
  rootPath: string;
  createdAt: string;
  lastOpenedAt: string | null;
  sandbox: SandboxSettings | null;
  worktree: WorktreeInfo | null;
  /** Canonical folders outside the root the user authorized: readable, writes need approval. */
  externalFolders: string[];
}

interface ProjectRow {
  id: string;
  name: string;
  root_path: string;
  created_at: string;
  last_opened_at: string | null;
  sandbox: string | null;
  worktree: string | null;
  external_folders: string;
}

const toRecord = (r: ProjectRow): ProjectRecord => ({
  id: r.id,
  name: r.name,
  rootPath: r.root_path,
  createdAt: r.created_at,
  lastOpenedAt: r.last_opened_at,
  sandbox: r.sandbox ? (JSON.parse(r.sandbox) as SandboxSettings) : null,
  worktree: r.worktree ? (JSON.parse(r.worktree) as WorktreeInfo) : null,
  externalFolders: JSON.parse(r.external_folders) as string[],
});

export class ProjectRepo {
  constructor(private readonly db: Db) {}

  create(name: string, rootPath: string): ProjectRecord {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO projects (id, name, root_path, created_at) VALUES (?, ?, ?, ?)')
      .run(id, name, rootPath, new Date().toISOString());
    return this.get(id)!;
  }

  /**
   * A worktree project: a child of `worktree.parentId`, with the parent's sandbox settings and
   * external folders.
   */
  createWorktree(
    name: string,
    rootPath: string,
    worktree: WorktreeInfo,
    sandbox: SandboxSettings | null,
    externalFolders: string[] = [],
  ): ProjectRecord {
    const id = randomUUID();
    this.db
      .prepare(
        'INSERT INTO projects (id, name, root_path, created_at, parent_id, worktree, sandbox, external_folders) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        name,
        rootPath,
        new Date().toISOString(),
        worktree.parentId,
        JSON.stringify(worktree),
        sandbox ? JSON.stringify(sandbox) : null,
        JSON.stringify(externalFolders),
      );
    return this.get(id)!;
  }

  setWorktree(id: string, worktree: WorktreeInfo): void {
    this.db
      .prepare('UPDATE projects SET worktree = ? WHERE id = ?')
      .run(JSON.stringify(worktree), id);
  }

  /** Worktree projects made from this project, newest first. */
  worktrees(parentId: string): ProjectRecord[] {
    return (
      this.db
        .prepare('SELECT * FROM projects WHERE parent_id = ? ORDER BY created_at DESC')
        .all(parentId) as unknown as ProjectRow[]
    ).map(toRecord);
  }

  get(id: string): ProjectRecord | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as
      ProjectRow | undefined;
    return row ? toRecord(row) : null;
  }

  getByRoot(rootPath: string): ProjectRecord | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE root_path = ?').get(rootPath) as
      ProjectRow | undefined;
    return row ? toRecord(row) : null;
  }

  list(): ProjectRecord[] {
    return (
      this.db
        .prepare('SELECT * FROM projects ORDER BY COALESCE(last_opened_at, created_at) DESC')
        .all() as ProjectRow[]
    ).map(toRecord);
  }

  rename(id: string, name: string): boolean {
    return this.db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(name, id).changes > 0;
  }

  setSandbox(id: string, sandbox: SandboxSettings | null): boolean {
    return (
      this.db
        .prepare('UPDATE projects SET sandbox = ? WHERE id = ?')
        .run(sandbox ? JSON.stringify(sandbox) : null, id).changes > 0
    );
  }

  setExternalFolders(id: string, folders: string[]): boolean {
    return (
      this.db
        .prepare('UPDATE projects SET external_folders = ? WHERE id = ?')
        .run(JSON.stringify(folders), id).changes > 0
    );
  }

  touch(id: string): void {
    this.db
      .prepare('UPDATE projects SET last_opened_at = ? WHERE id = ?')
      .run(new Date().toISOString(), id);
  }

  /** Removes the authorization only; files on disk are never touched. Sessions keep their history. */
  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM projects WHERE id = ?').run(id).changes > 0;
  }
}
