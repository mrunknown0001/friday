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
  /** Set for a project in a folder on this SSH host; rootPath is then the path on the server. */
  sshHostId: string | null;
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
  ssh_host_id: string | null;
}

/** root_path of a project on an SSH host: unique per host and folder. */
const remoteKey = (hostId: string, rootPath: string) => `ssh://${hostId}${rootPath}`;

const toRecord = (r: ProjectRow): ProjectRecord => ({
  id: r.id,
  name: r.name,
  rootPath: r.ssh_host_id ? r.root_path.slice(remoteKey(r.ssh_host_id, '').length) : r.root_path,
  createdAt: r.created_at,
  lastOpenedAt: r.last_opened_at,
  sandbox: r.sandbox ? (JSON.parse(r.sandbox) as SandboxSettings) : null,
  worktree: r.worktree ? (JSON.parse(r.worktree) as WorktreeInfo) : null,
  externalFolders: JSON.parse(r.external_folders) as string[],
  sshHostId: r.ssh_host_id,
});

export class ProjectRepo {
  constructor(private readonly db: Db) {}

  /** A project on this machine, or with `sshHostId` in a folder on that SSH host. */
  create(name: string, rootPath: string, sshHostId: string | null = null): ProjectRecord {
    const id = randomUUID();
    this.db
      .prepare(
        'INSERT INTO projects (id, name, root_path, created_at, ssh_host_id) VALUES (?, ?, ?, ?, ?)',
      )
      .run(
        id,
        name,
        sshHostId ? remoteKey(sshHostId, rootPath) : rootPath,
        new Date().toISOString(),
        sshHostId,
      );
    return this.get(id)!;
  }

  /** Projects in folders on this SSH host. */
  onHost(sshHostId: string): ProjectRecord[] {
    return (
      this.db
        .prepare('SELECT * FROM projects WHERE ssh_host_id = ?')
        .all(sshHostId) as unknown as ProjectRow[]
    ).map(toRecord);
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

  getByRoot(rootPath: string, sshHostId: string | null = null): ProjectRecord | null {
    const row = this.db
      .prepare('SELECT * FROM projects WHERE root_path = ?')
      .get(sshHostId ? remoteKey(sshHostId, rootPath) : rootPath) as ProjectRow | undefined;
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
