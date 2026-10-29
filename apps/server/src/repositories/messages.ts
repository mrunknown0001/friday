import type { MessageDto, MessageRole, MessageStatus } from '@friday/shared';
import type { Db } from '../db/database.js';

interface MessageRow {
  id: number;
  session_id: string;
  run_id: string | null;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  model: string | null;
  created_at: string;
}

function toDto(r: MessageRow): MessageDto {
  return {
    id: r.id,
    sessionId: r.session_id,
    runId: r.run_id,
    role: r.role,
    content: r.content,
    status: r.status,
    model: r.model,
    createdAt: r.created_at,
  };
}

export interface NewMessage {
  sessionId: string;
  runId?: string | null;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  model?: string | null;
}

export class MessageRepo {
  constructor(private readonly db: Db) {}

  insert(m: NewMessage): MessageDto {
    const info = this.db
      .prepare(
        `INSERT INTO messages (session_id, run_id, role, content, status, model, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        m.sessionId,
        m.runId ?? null,
        m.role,
        m.content,
        m.status,
        m.model ?? null,
        new Date().toISOString(),
      );
    return this.get(Number(info.lastInsertRowid))!;
  }

  get(id: number): MessageDto | null {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as
      MessageRow | undefined;
    return row ? toDto(row) : null;
  }

  update(id: number, content: string, status: MessageStatus): void {
    this.db
      .prepare('UPDATE messages SET content = ?, status = ? WHERE id = ?')
      .run(content, status, id);
  }

  /** Completed user/assistant messages after `afterId`, up to and including `throughId`. */
  contextHistory(sessionId: string, afterId: number, throughId: number): MessageDto[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM messages WHERE session_id = ? AND id > ? AND id <= ?
             AND status = 'complete' AND role IN ('user', 'assistant') ORDER BY id`,
        )
        .all(sessionId, afterId, throughId) as MessageRow[]
    ).map(toDto);
  }

  setRunId(id: number, runId: string): void {
    this.db.prepare('UPDATE messages SET run_id = ? WHERE id = ?').run(runId, id);
  }

  listBySession(sessionId: string): MessageDto[] {
    return (
      this.db
        .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY id')
        .all(sessionId) as MessageRow[]
    ).map(toDto);
  }

  lastUserMessage(sessionId: string): MessageDto | null {
    const row = this.db
      .prepare(
        `SELECT * FROM messages WHERE session_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1`,
      )
      .get(sessionId) as MessageRow | undefined;
    return row ? toDto(row) : null;
  }

  countBySession(sessionId: string): number {
    return (
      this.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?').get(sessionId) as {
        n: number;
      }
    ).n;
  }
}
