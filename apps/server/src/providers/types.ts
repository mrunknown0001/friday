import type { ModelInfo, ProviderErrorKind } from '@friday/shared';

export type { ModelInfo, ProviderErrorKind };

/** A tool call proposed by the model. Arguments are raw JSON text and are NOT trusted. */
export interface ToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the tool arguments. */
  parameters: Record<string, unknown>;
}

export type ToolChoice = 'auto' | 'none' | 'required' | { name: string };

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
  maxOutputTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  /** Label recorded in provider telemetry (e.g. "chat", "summarize", "probe"). */
  operation?: string;
}

export interface Usage {
  inputTokens: number | null;
  outputTokens: number | null;
}

export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'unknown';

export type StreamEvent =
  | { type: 'text'; delta: string }
  /** Emitted once per tool call after its arguments have fully streamed. */
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'finish'; finishReason: FinishReason; usage: Usage | null };

export interface CompletionResult {
  text: string;
  toolCalls: ToolCall[];
  finishReason: FinishReason;
  usage: Usage | null;
}

export interface ProviderCallRecord {
  model: string;
  operation: string;
  status: 'ok' | 'error' | 'cancelled';
  errorKind: ProviderErrorKind | null;
  durationMs: number;
  attempts: number;
  usage: Usage | null;
}

export type ProviderCallRecorder = (record: ProviderCallRecord) => void;

/**
 * Provider-neutral interface the agent depends on. Implementations own transport details,
 * retries, and error classification; callers only see `StreamEvent`s and `ProviderError`s.
 */
export interface LLMProvider {
  readonly id: string;
  isConfigured(): boolean;
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
  streamChat(request: ChatRequest): AsyncGenerator<StreamEvent, void, undefined>;
  /** Non-streaming completion, for models where streaming is unsupported and for internal tasks. */
  complete(request: ChatRequest): Promise<CompletionResult>;
}
