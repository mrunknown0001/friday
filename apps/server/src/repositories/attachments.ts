import { createHash, randomUUID } from 'node:crypto';
import type { AttachmentDto } from '@friday/shared';
import type { Db } from '../db/database.js';
import type { ImageInfo } from '../attachments/image.js';

interface AttachmentRow {
  id: string;
  session_id: string | null;
  message_id: number | null;
  name: string | null;
  mime: AttachmentDto['mime'];
  size: number;
  width: number;
  height: number;
  created_at: string;
}

export interface AttachmentRecord extends AttachmentDto {
  sessionId: string | null;
  messageId: number | null;
}

/** An attachment with its bytes, for sending to the model. */
export interface AttachmentData extends AttachmentRecord {
  data: Buffer;
}

const META = 'id, session_id, message_id, name, mime, size, width, height, created_at';

function toRecord(r: AttachmentRow): AttachmentRecord {
  return {
    id: r.id,
    name: r.name,
    mime: r.mime,
    size: r.size,
    width: r.width,
    height: r.height,
    createdAt: r.created_at,
    sessionId: r.session_id,
    messageId: r.message_id,
  };
}

export function toAttachmentDto(r: AttachmentRecord): AttachmentDto {
  return {
    id: r.id,
    name: r.name,
    mime: r.mime,
    size: r.size,
    width: r.width,
    height: r.height,
    createdAt: r.createdAt,
  };
}

export class AttachmentRepo {
  constructor(private readonly db: Db) {}

  /** Store an upload that is not attached to a message yet. */
  create(
    data: Buffer,
    info: ImageInfo,
    name: string | null,
    sessionId: string | null = null,
  ): AttachmentRecord {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO attachments (id, session_id, message_id, name, mime, size, width, height, sha256, data, created_at)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        sessionId,
        name,
        info.mime,
        data.length,
        info.width,
        info.height,
        createHash('sha256').update(data).digest('hex'),
        data,
        createdAt,
      );
    return this.get(id)!;
  }

  get(id: string): AttachmentRecord | null {
    const row = this.db.prepare(`SELECT ${META} FROM attachments WHERE id = ?`).get(id) as
      AttachmentRow | undefined;
    return row ? toRecord(row) : null;
  }

  data(id: string): Buffer | null {
    const row = this.db.prepare('SELECT data FROM attachments WHERE id = ?').get(id) as
      { data: Uint8Array } | undefined;
    return row ? Buffer.from(row.data) : null;
  }

  /** Bind pending uploads to the message that sends them. */
  bind(ids: string[], sessionId: string, messageId: number): void {
    const stmt = this.db.prepare(
      'UPDATE attachments SET session_id = ?, message_id = ? WHERE id = ? AND message_id IS NULL',
    );
    for (const id of ids) stmt.run(sessionId, messageId, id);
  }

  /** Metadata for these messages' attachments, grouped by message id. */
  byMessages(messageIds: number[]): Map<number, AttachmentRecord[]> {
    const out = new Map<number, AttachmentRecord[]>();
    if (!messageIds.length) return out;
    const rows = this.db
      .prepare(
        `SELECT ${META} FROM attachments WHERE message_id IN (${messageIds.map(() => '?').join(',')}) ORDER BY created_at, rowid`,
      )
      .all(...messageIds) as AttachmentRow[];
    for (const r of rows) {
      const list = out.get(r.message_id!) ?? [];
      list.push(toRecord(r));
      out.set(r.message_id!, list);
    }
    return out;
  }

  /** Bytes and metadata for these messages' attachments, grouped by message id. */
  withData(messageIds: number[]): Map<number, AttachmentData[]> {
    const out = new Map<number, AttachmentData[]>();
    for (const [messageId, list] of this.byMessages(messageIds)) {
      out.set(
        messageId,
        list.map((a) => ({ ...a, data: this.data(a.id)! })),
      );
    }
    return out;
  }

  /**
   * Remove a pending upload (the user took it out of the composer). Uploads have no session
   * until sent; images a tool stored for a conversation (browser flow steps) are not uploads.
   */
  deletePending(id: string): boolean {
    return (
      this.db
        .prepare(
          'DELETE FROM attachments WHERE id = ? AND message_id IS NULL AND session_id IS NULL',
        )
        .run(id).changes > 0
    );
  }

  /** Uploads never sent within `maxAgeMs` (closed tab, removed draft). */
  deleteStalePending(maxAgeMs: number, now = Date.now()): number {
    return this.db
      .prepare(
        'DELETE FROM attachments WHERE message_id IS NULL AND session_id IS NULL AND created_at < ?',
      )
      .run(new Date(now - maxAgeMs).toISOString()).changes;
  }
}
