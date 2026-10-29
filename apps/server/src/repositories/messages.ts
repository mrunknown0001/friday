import type { MessageDto, MessageRole, MessageStatus, ToolCallStatus } from '@friday/shared';
import type { Db } from '../db/database.js';
import type { ToolCall } from '../providers/types.js';
import { AttachmentRepo, toAttachmentDto } from './attachments.js';

interface MessageRow {
  id: number;
  session_id: string;
  run_id: string | null;
  role: MessageRole;
  content: string;
  tool_calls: string | null;
  tool_call_id: string | null;
  status: MessageStatus;
  model: string | null;
  created_at: string;
  // Joined from tool_calls for tool result messages.
  tc_name: string | null;
  tc_arguments: string | null;
  tc_status: ToolCallStatus | null;
  tc_summary: string | null;
  tc_duration_ms: number | null;
  tc_truncated: number | null;
  tc_approval_id: string | null;
}

const SELECT = `
  SELECT m.*, tc.name AS tc_name, tc.arguments AS tc_arguments, tc.status AS tc_status,
         tc.summary AS tc_summary, tc.duration_ms AS tc_duration_ms, tc.truncated AS tc_truncated,
         tc.approval_id AS tc_approval_id
  FROM messages m
  LEFT JOIN tool_calls tc ON tc.result_message_id = m.id`;

function parseToolCalls(json: string | null): ToolCall[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as ToolCall[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export interface StoredMessage extends MessageDto {
  /** Full tool calls (untruncated arguments) for rebuilding model context. */
  rawToolCalls: ToolCall[];
}

function toStored(r: MessageRow): StoredMessage {
  const rawToolCalls = parseToolCalls(r.tool_calls);
  const dto: StoredMessage = {
    id: r.id,
    sessionId: r.session_id,
    runId: r.run_id,
    role: r.role,
    content: r.content,
    status: r.status,
    model: r.model,
    createdAt: r.created_at,
    rawToolCalls,
  };
  if (rawToolCalls.length > 0) {
    dto.toolCalls = rawToolCalls.map((c) => ({
      id: c.id,
      name: c.name,
      arguments: c.argumentsJson,
    }));
  }
  if (r.tool_call_id) dto.toolCallId = r.tool_call_id;
  if (r.tc_name && r.tool_call_id) {
    dto.tool = {
      callId: r.tool_call_id,
      name: r.tc_name,
      arguments: r.tc_arguments ?? '',
      status: r.tc_status ?? 'completed',
      summary: r.tc_summary ?? '',
      durationMs: r.tc_duration_ms ?? 0,
      truncated: r.tc_truncated === 1,
      approvalId: r.tc_approval_id,
    };
  }
  return dto;
}

export function toMessageDto(m: StoredMessage): MessageDto {
  const { rawToolCalls: _raw, ...dto } = m;
  return dto;
}

export interface NewMessage {
  sessionId: string;
  runId?: string | null;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  model?: string | null;
  toolCalls?: ToolCall[];
  toolCallId?: string | null;
}

export class MessageRepo {
  private readonly attachments: AttachmentRepo;

  constructor(private readonly db: Db) {
    this.attachments = new AttachmentRepo(db);
  }

  /** Add attachment metadata (not the bytes) to the messages that have some. */
  private withAttachments(list: StoredMessage[]): StoredMessage[] {
    const byMessage = this.attachments.byMessages(list.map((m) => m.id));
    for (const m of list) {
      const found = byMessage.get(m.id);
      if (found) m.attachments = found.map(toAttachmentDto);
    }
    return list;
  }

  insert(m: NewMessage): StoredMessage {
    const info = this.db
      .prepare(
        `INSERT INTO messages (session_id, run_id, role, content, tool_calls, tool_call_id, status, model, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        m.sessionId,
        m.runId ?? null,
        m.role,
        m.content,
        m.toolCalls && m.toolCalls.length > 0 ? JSON.stringify(m.toolCalls) : null,
        m.toolCallId ?? null,
        m.status,
        m.model ?? null,
        new Date().toISOString(),
      );
    return this.get(Number(info.lastInsertRowid))!;
  }

  get(id: number): StoredMessage | null {
    const row = this.db.prepare(`${SELECT} WHERE m.id = ?`).get(id) as MessageRow | undefined;
    return row ? this.withAttachments([toStored(row)])[0]! : null;
  }

  update(id: number, content: string, status: MessageStatus, toolCalls?: ToolCall[]): void {
    if (toolCalls === undefined) {
      this.db
        .prepare('UPDATE messages SET content = ?, status = ? WHERE id = ?')
        .run(content, status, id);
    } else {
      this.db
        .prepare('UPDATE messages SET content = ?, status = ?, tool_calls = ? WHERE id = ?')
        .run(content, status, toolCalls.length > 0 ? JSON.stringify(toolCalls) : null, id);
    }
  }

  /**
   * Completed messages after `afterId`, up to and including `throughId` (or everything after it when
   * null). Tool results and assistant tool-call messages are included so the model sees its own work.
   */
  contextHistory(
    sessionId: string,
    afterId: number,
    throughId: number | null = null,
  ): StoredMessage[] {
    const rows = (
      this.db
        .prepare(
          `${SELECT} WHERE m.session_id = ? AND m.id > ? AND (? IS NULL OR m.id <= ?)
             AND m.status = 'complete' AND m.role IN ('user', 'assistant', 'tool') ORDER BY m.id`,
        )
        .all(sessionId, afterId, throughId, throughId) as MessageRow[]
    ).map(toStored);
    return this.withAttachments(rows);
  }

  listBySession(sessionId: string): StoredMessage[] {
    return this.withAttachments(
      (
        this.db
          .prepare(`${SELECT} WHERE m.session_id = ? ORDER BY m.id`)
          .all(sessionId) as MessageRow[]
      ).map(toStored),
    );
  }

  lastUserMessage(sessionId: string): StoredMessage | null {
    const row = this.db
      .prepare(`${SELECT} WHERE m.session_id = ? AND m.role = 'user' ORDER BY m.id DESC LIMIT 1`)
      .get(sessionId) as MessageRow | undefined;
    return row ? this.withAttachments([toStored(row)])[0]! : null;
  }

  countBySession(sessionId: string): number {
    return (
      this.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?').get(sessionId) as {
        n: number;
      }
    ).n;
  }
}
