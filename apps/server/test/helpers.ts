import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { ProviderError } from '../src/providers/errors.js';
import type {
  ChatRequest,
  CompletionResult,
  FinishReason,
  LLMProvider,
  ModelInfo,
  StreamEvent,
  ToolCall,
} from '../src/providers/types.js';
import { createServices, type ServiceOverrides } from '../src/services.js';

export const TEST_KEY = 'ntl-test-key-0123456789abcdef';

export function testConfig(overrides: Partial<AppConfig['provider']> = {}): AppConfig {
  return {
    provider: {
      apiKey: TEST_KEY,
      envModel: 'test-model',
      baseUrl: 'https://ntl.test/api/v1',
      timeoutMs: 5_000,
      maxRetries: 2,
      ...overrides,
    },
    server: {
      host: '127.0.0.1',
      port: 4317,
      devOrigins: ['http://localhost:5173'],
      launchToken: null,
    },
    dataDir: ':memory:',
    envFile: '/friday/.env',
    webDist: '/friday/apps/web/dist',
    agent: {
      maxIterations: 8,
      maxToolCalls: 12,
      maxToolOutputChars: 20_000,
      toolTimeoutMs: 5_000,
      maxConsecutiveToolFailures: 3,
    },
    approvalTtlMs: 60_000,
  };
}

export function testServices(
  overrides: ServiceOverrides & { config?: AppConfig; dbFile?: string } = {},
) {
  const db = openDatabase(overrides.dbFile ?? ':memory:');
  return createServices(overrides.config ?? testConfig(), db, {
    retryBaseDelayMs: 1,
    retryMaxDelayMs: 5,
    ...overrides,
    runManager: { checkpointIntervalMs: 0, retainFinishedMs: 60_000, ...overrides.runManager },
  });
}

// ---------- HTTP mocks that exercise the real OpenAI SDK ----------

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export interface SseOptions {
  delayMs?: number;
  /** Stop sending after the chunks without closing the stream (simulates a stalled connection). */
  hang?: boolean;
  /** Raw lines appended verbatim (e.g. malformed JSON). */
  rawTail?: string;
}

export function sseResponse(
  chunks: unknown[],
  opts: SseOptions = {},
  signal?: AbortSignal | null,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const onAbort = () => {
        try {
          controller.error(new DOMException('aborted', 'AbortError'));
        } catch {
          /* already closed */
        }
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      for (const chunk of chunks) {
        if (signal?.aborted) return;
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        if (signal?.aborted) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      }
      if (opts.rawTail) controller.enqueue(encoder.encode(opts.rawTail));
      if (opts.hang) return;
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

export function textChunks(
  parts: string[],
  finish: string = 'stop',
  usage = { prompt_tokens: 11, completion_tokens: 7 },
) {
  return [
    ...parts.map((p) => ({
      id: 'c1',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { content: p } }],
    })),
    {
      id: 'c1',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: finish }],
    },
    { id: 'c1', object: 'chat.completion.chunk', choices: [], usage },
  ];
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

export type MockHandler = (
  call: RecordedCall,
  signal: AbortSignal | null,
) => Response | Promise<Response>;

/** A fetch replacement that serves handlers in order (the last one repeats). */
export function mockFetch(handlers: MockHandler[]) {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const bodyText = typeof init?.body === 'string' ? init.body : null;
    const call: RecordedCall = {
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: bodyText ? JSON.parse(bodyText) : null,
    };
    calls.push(call);
    const handler = handlers[Math.min(calls.length - 1, handlers.length - 1)]!;
    if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    return handler(call, init?.signal ?? null);
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

// ---------- Scripted provider for orchestration tests ----------

export interface StreamStep {
  chunks?: string[];
  toolCalls?: ToolCall[];
  delayMs?: number;
  finishReason?: FinishReason;
  /** Throw this error after emitting `errorAfter` chunks (default: after all chunks). */
  error?: ProviderError;
  errorAfter?: number;
}

export class ScriptedProvider implements LLMProvider {
  readonly id = 'scripted';
  readonly requests: ChatRequest[] = [];
  readonly completeRequests: ChatRequest[] = [];

  constructor(
    public streamSteps: StreamStep[] = [],
    public completeSteps: Array<CompletionResult | ProviderError> = [],
    public models: ModelInfo[] = [{ id: 'test-model' }],
    private readonly configured = true,
  ) {}

  isConfigured() {
    return this.configured;
  }

  async listModels(): Promise<ModelInfo[]> {
    return this.models;
  }

  async *streamChat(req: ChatRequest): AsyncGenerator<StreamEvent, void, undefined> {
    this.requests.push(req);
    const step = this.streamSteps.shift() ?? { chunks: ['ok'] };
    const chunks = step.chunks ?? [];
    const errorAt = step.error ? (step.errorAfter ?? chunks.length) : -1;
    for (let i = 0; i <= chunks.length; i++) {
      if (i === errorAt) throw step.error!;
      if (i === chunks.length) break;
      if (step.delayMs) await sleepAbortable(step.delayMs, req.signal);
      if (req.signal?.aborted) throw new ProviderError('cancelled');
      yield { type: 'text', delta: chunks[i]! };
    }
    for (const call of step.toolCalls ?? []) yield { type: 'tool_call', call };
    yield {
      type: 'finish',
      finishReason: step.finishReason ?? (step.toolCalls?.length ? 'tool_calls' : 'stop'),
      usage: null,
    };
  }

  async complete(req: ChatRequest): Promise<CompletionResult> {
    this.completeRequests.push(req);
    const step = this.completeSteps.shift() ?? {
      text: 'summary',
      toolCalls: [],
      finishReason: 'stop',
      usage: null,
    };
    if (step instanceof ProviderError) throw step;
    return step;
  }
}

function sleepAbortable(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new ProviderError('cancelled'));
      },
      { once: true },
    );
  });
}

// ---------- Disposable project folders ----------

const tempDirs: string[] = [];

/** Create a temp project from a map of relative paths to contents. Returns its canonical root. */
export function makeProject(files: Record<string, string | Buffer>): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'friday-proj-')));
  tempDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

export function cleanupProjects(): void {
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
}

export const call = (
  name: string,
  args: unknown,
  id = `call_${name}_${Math.random().toString(36).slice(2, 8)}`,
): ToolCall => ({
  id,
  name,
  argumentsJson: JSON.stringify(args),
});
