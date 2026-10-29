// Type-only contract between the Friday server and web client.
// Keep this file free of runtime code so it can be imported with `import type`.

export type ProviderErrorKind =
  | 'not_configured'
  | 'auth'
  | 'permission'
  | 'rate_limit'
  | 'quota'
  | 'timeout'
  | 'network'
  | 'bad_request'
  | 'model_not_found'
  | 'unsupported'
  | 'server'
  | 'malformed'
  | 'cancelled'
  | 'unknown';

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    retryable?: boolean;
  };
}

export interface ModelInfo {
  id: string;
  name?: string;
  description?: string;
  tier?: string;
}

export type CapabilityState = 'unknown' | 'supported' | 'unsupported';

export interface ModelCapabilities {
  model: string;
  streaming: CapabilityState;
  toolCalling: CapabilityState;
  /** Context window in tokens. `contextWindowSource` says whether it was assumed or configured. */
  contextWindow: number;
  contextWindowSource: 'assumed' | 'configured';
  probedAt: string | null;
  notes: string | null;
}

export interface SettingsDto {
  model: string | null;
  modelSource: 'settings' | 'env' | 'none';
  apiKeyConfigured: boolean;
  baseUrl: string;
  timeoutMs: number;
  maxRetries: number;
}

export interface ConnectionTestResult {
  ok: boolean;
  model: string | null;
  latencyMs: number;
  modelListed: boolean | null;
  reply?: string;
  error?: { kind: ProviderErrorKind; message: string };
}

export interface ProviderCallDto {
  id: number;
  createdAt: string;
  model: string;
  operation: string;
  status: 'ok' | 'error' | 'cancelled';
  errorKind: ProviderErrorKind | null;
  durationMs: number;
  attempts: number;
  inputTokens: number | null;
  outputTokens: number | null;
}

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';
export type MessageStatus = 'complete' | 'partial' | 'cancelled' | 'error';

export interface MessageDto {
  id: number;
  sessionId: string;
  runId: string | null;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  model: string | null;
  createdAt: string;
}

export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export interface RunDto {
  id: string;
  sessionId: string;
  status: RunStatus;
  model: string | null;
  errorKind: ProviderErrorKind | null;
  errorMessage: string | null;
  retryable: boolean;
  startedAt: string;
  finishedAt: string | null;
}

export interface SessionSummaryDto {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastRunStatus: RunStatus | null;
}

export interface SessionDetailDto extends SessionSummaryDto {
  messages: MessageDto[];
  latestRun: RunDto | null;
  hasSummary: boolean;
}

export type RunPhase = 'preparing' | 'compacting' | 'waiting_for_model' | 'streaming';

/** Server-Sent Event payloads for a run. `seq` is also sent as the SSE `id`. */
export type RunEvent =
  | { seq: number; type: 'run_started'; runId: string; sessionId: string; model: string }
  | { seq: number; type: 'phase'; phase: RunPhase; detail?: string }
  | { seq: number; type: 'text_delta'; delta: string }
  | { seq: number; type: 'message_saved'; message: MessageDto }
  | {
      seq: number;
      type: 'run_finished';
      run: RunDto;
    };
