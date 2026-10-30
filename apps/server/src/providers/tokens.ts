import { imageTokens } from '../attachments/image.js';
import type { ChatMessage, ChatRequest } from './types.js';

/** Rough, provider-agnostic token estimate. Deliberately pessimistic (~3.5 chars/token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

export function estimateMessageTokens(m: ChatMessage): number {
  const overhead = 6;
  switch (m.role) {
    case 'assistant':
      return (
        overhead +
        estimateTokens(m.content ?? '') +
        (m.toolCalls ?? []).reduce((n, tc) => n + estimateTokens(tc.name + tc.argumentsJson), 0)
      );
    case 'user':
      return (
        overhead +
        estimateTokens(m.content) +
        (m.images ?? []).reduce((n, img) => n + imageTokens(img.width, img.height), 0)
      );
    default:
      return overhead + estimateTokens(m.content);
  }
}

/** What Friday sent: the messages plus the tool definitions. */
export function estimateRequestTokens(req: Pick<ChatRequest, 'messages' | 'tools'>): number {
  return (
    req.messages.reduce((n, m) => n + estimateMessageTokens(m), 0) +
    (req.tools?.length ? estimateTokens(JSON.stringify(req.tools)) : 0)
  );
}
