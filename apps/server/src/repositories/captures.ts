import { randomUUID } from 'node:crypto';
import type { VisualComparison } from '@friday/shared';
import type { Db } from '../db/database.js';
import type { Region } from '../visual/diff.js';
import { toAttachmentDto, type AttachmentRepo } from './attachments.js';

export interface NewCapture {
  sessionId: string;
  runId: string;
  attachmentId: string;
  url: string;
  width: number;
  height: number;
  fullPage: boolean;
  comparison?: {
    beforeId: string;
    diffAttachmentId: string | null;
    changedRatio: number;
    regions: Region[];
  };
}

interface CaptureRow {
  id: string;
  url: string;
  width: number;
  height: number;
  full_page: number;
  attachment_id: string;
  before_attachment_id: string | null;
  diff_attachment_id: string | null;
  changed_ratio: number | null;
  regions: string | null;
  created_at: string;
}

/** Screenshots Friday took in a conversation, and the before/after comparisons among them. */
export class CaptureRepo {
  constructor(
    private readonly db: Db,
    private readonly attachments: AttachmentRepo,
  ) {}

  insert(c: NewCapture): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO page_captures (id, session_id, run_id, attachment_id, url, width, height, full_page,
           before_id, diff_attachment_id, changed_ratio, regions, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        c.sessionId,
        c.runId,
        c.attachmentId,
        c.url,
        c.width,
        c.height,
        c.fullPage ? 1 : 0,
        c.comparison?.beforeId ?? null,
        c.comparison?.diffAttachmentId ?? null,
        c.comparison?.changedRatio ?? null,
        c.comparison ? JSON.stringify(c.comparison.regions) : null,
        new Date().toISOString(),
      );
    return id;
  }

  /** The latest capture of this page at this size in the conversation. */
  latest(q: {
    sessionId: string;
    url: string;
    width: number;
    height: number;
    fullPage: boolean;
  }): { id: string; attachmentId: string; createdAt: string } | null {
    const row = this.db
      .prepare(
        `SELECT id, attachment_id, created_at FROM page_captures
          WHERE session_id = ? AND url = ? AND width = ? AND height = ? AND full_page = ?
          ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(q.sessionId, q.url, q.width, q.height, q.fullPage ? 1 : 0) as
      { id: string; attachment_id: string; created_at: string } | undefined;
    return row ? { id: row.id, attachmentId: row.attachment_id, createdAt: row.created_at } : null;
  }

  /** Before/after comparisons made in these runs, oldest first. */
  comparisons(runIds: string[]): VisualComparison[] {
    if (!runIds.length) return [];
    const rows = this.db
      .prepare(
        `SELECT c.id, c.url, c.width, c.height, c.full_page, c.attachment_id, b.attachment_id AS before_attachment_id,
                c.diff_attachment_id, c.changed_ratio, c.regions, c.created_at
           FROM page_captures c JOIN page_captures b ON b.id = c.before_id
          WHERE c.run_id IN (${runIds.map(() => '?').join(',')})
          ORDER BY c.created_at, c.rowid`,
      )
      .all(...runIds) as unknown as CaptureRow[];
    const out: VisualComparison[] = [];
    for (const r of rows) {
      const before = this.attachments.get(r.before_attachment_id!);
      const after = this.attachments.get(r.attachment_id);
      if (!before || !after) continue;
      const diff = r.diff_attachment_id ? this.attachments.get(r.diff_attachment_id) : null;
      out.push({
        url: r.url,
        width: r.width,
        height: r.height,
        fullPage: r.full_page === 1,
        before: toAttachmentDto(before),
        after: toAttachmentDto(after),
        diff: diff ? toAttachmentDto(diff) : null,
        changedRatio: r.changed_ratio ?? 0,
        regions: r.regions ? (JSON.parse(r.regions) as unknown[]).length : 0,
        createdAt: r.created_at,
      });
    }
    return out;
  }
}
