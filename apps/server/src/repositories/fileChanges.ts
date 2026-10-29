import type { FileChangeDto } from '@friday/shared';
import type { Db } from '../db/database.js';

interface FileChangeRow {
  id: number;
  approval_id: string | null;
  session_id: string | null;
  project_id: string;
  path: string;
  from_path: string | null;
  change: FileChangeDto['change'];
  before_content: Buffer | null;
  before_hash: string | null;
  after_hash: string | null;
  created_at: string;
  reverted_at: string | null;
}

export interface FileChangeRecord extends FileChangeDto {
  projectId: string;
  /** Content before the change; null when the file did not exist. */
  beforeContent: Buffer | null;
  beforeHash: string | null;
  /** Hash of the file after the change; null when the change removed it. */
  afterHash: string | null;
}

const toRecord = (r: FileChangeRow): FileChangeRecord => ({
  id: r.id,
  approvalId: r.approval_id,
  sessionId: r.session_id,
  projectId: r.project_id,
  path: r.path,
  fromPath: r.from_path,
  change: r.change,
  beforeContent: r.before_content,
  beforeHash: r.before_hash,
  afterHash: r.after_hash,
  createdAt: r.created_at,
  revertedAt: r.reverted_at,
});

export function toFileChangeDto(r: FileChangeRecord): FileChangeDto {
  const { projectId: _p, beforeContent: _b, beforeHash: _bh, afterHash: _ah, ...dto } = r;
  return dto;
}

export class FileChangeRepo {
  constructor(private readonly db: Db) {}

  insert(c: Omit<FileChangeRecord, 'id' | 'createdAt' | 'revertedAt'>): FileChangeRecord {
    const info = this.db
      .prepare(
        `INSERT INTO file_changes (approval_id, session_id, project_id, path, from_path, change,
           before_content, before_hash, after_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        c.approvalId,
        c.sessionId,
        c.projectId,
        c.path,
        c.fromPath,
        c.change,
        c.beforeContent,
        c.beforeHash,
        c.afterHash,
        new Date().toISOString(),
      );
    return this.get(Number(info.lastInsertRowid))!;
  }

  get(id: number): FileChangeRecord | null {
    const row = this.db.prepare('SELECT * FROM file_changes WHERE id = ?').get(id) as
      FileChangeRow | undefined;
    return row ? toRecord(row) : null;
  }

  listBySession(sessionId: string): FileChangeRecord[] {
    return (
      this.db
        .prepare('SELECT * FROM file_changes WHERE session_id = ? ORDER BY id')
        .all(sessionId) as FileChangeRow[]
    ).map(toRecord);
  }

  /** Changes applied by approvals that belong to `runId`. */
  listByRun(runId: string): FileChangeRecord[] {
    return (
      this.db
        .prepare(
          `SELECT fc.* FROM file_changes fc JOIN approvals a ON a.id = fc.approval_id
           WHERE a.run_id = ? ORDER BY fc.id`,
        )
        .all(runId) as FileChangeRow[]
    ).map(toRecord);
  }

  /** Later, unreverted changes to the same path would be clobbered by reverting this one. */
  laterChangesToPath(change: FileChangeRecord): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM file_changes
           WHERE project_id = ? AND id > ? AND reverted_at IS NULL AND (path = ? OR from_path = ?)`,
        )
        .get(change.projectId, change.id, change.path, change.path) as { n: number }
    ).n;
  }

  markReverted(id: number): boolean {
    return (
      this.db
        .prepare('UPDATE file_changes SET reverted_at = ? WHERE id = ? AND reverted_at IS NULL')
        .run(new Date().toISOString(), id).changes > 0
    );
  }
}
