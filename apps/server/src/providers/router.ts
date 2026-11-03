import type { ModelListDto, ProviderId, ProviderStatusDto } from '@friday/shared';
import type { AppConfig } from '../config.js';
import type { Redactor } from '../security/redact.js';
import { ANTHROPIC, ANTHROPIC_PREFIX, AnthropicProvider } from './anthropic.js';
import { NO_PROVIDER, NOTOKENLIMIT, ProviderError, type ProviderSource } from './errors.js';
import { NoTokenLimitProvider } from './notokenlimit.js';
import { OpenAICompatibleProvider } from './openaiCompatible.js';
import type {
  ChatRequest,
  CompletionResult,
  LLMProvider,
  ModelInfo,
  ProviderCallRecorder,
  StreamEvent,
} from './types.js';

export const OPENAI: ProviderSource = { label: 'OpenAI', envVar: 'OPENAI_API_KEY', gateway: false };
export const OPENROUTER: ProviderSource = {
  label: 'OpenRouter',
  envVar: 'OPENROUTER_API_KEY',
  gateway: true,
};

/** OpenAI's list also has embedding, speech, image and moderation models; Friday needs chat. */
export function isOpenAIChatModel(id: string): boolean {
  return (
    /^(gpt-|chatgpt-|o\d)/.test(id) &&
    !/(embedding|tts|whisper|transcribe|audio|realtime|image|dall-e|moderation|search)/.test(id)
  );
}

interface Entry {
  id: ProviderId;
  /** Prefix of its model ids; '' for NoTokenLimit, whose ids are kept as they were. */
  prefix: string;
  source: ProviderSource;
  baseUrl: string;
  provider: LLMProvider;
}

/**
 * All model providers behind one LLMProvider: a model id says which provider serves it
 * ("anthropic:claude-sonnet-4-6"; NoTokenLimit ids have no prefix). Each provider is used only
 * when its key is set.
 */
export class ProviderRouter implements LLMProvider {
  readonly id = 'router';

  constructor(private readonly entries: Entry[]) {}

  private entryFor(model: string): Entry {
    return (
      this.entries.find((e) => e.prefix && model.startsWith(e.prefix)) ??
      this.entries.find((e) => !e.prefix)!
    );
  }

  /** The provider that serves a model id. */
  providerOf(model: string): ProviderId {
    return this.entryFor(model).id;
  }

  isConfigured(): boolean {
    return this.entries.some((e) => e.provider.isConfigured());
  }

  statuses(): ProviderStatusDto[] {
    return this.entries.map((e) => ({
      id: e.id,
      label: e.source.label,
      configured: e.provider.isConfigured(),
      envVar: e.source.envVar,
      baseUrl: e.baseUrl,
    }));
  }

  overheadTokens(model: string): number {
    return this.entryFor(model).provider.overheadTokens?.(model) ?? 0;
  }

  /** Every configured provider's models; a provider that fails is reported, not fatal. */
  async listAll(signal?: AbortSignal): Promise<ModelListDto> {
    const configured = this.entries.filter((e) => e.provider.isConfigured());
    if (!configured.length)
      throw new ProviderError('not_configured', null, { source: NO_PROVIDER });
    const results = await Promise.allSettled(configured.map((e) => e.provider.listModels(signal)));
    const models: ModelInfo[] = [];
    const errors: ModelListDto['errors'] = [];
    results.forEach((r, i) => {
      const e = configured[i]!;
      if (r.status === 'fulfilled') models.push(...r.value.map((m) => ({ ...m, provider: e.id })));
      else
        errors.push({
          provider: e.id,
          message: r.reason instanceof Error ? r.reason.message : String(r.reason),
        });
    });
    if (!models.length && results[0]?.status === 'rejected') throw results[0].reason;
    return { models, errors };
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    return (await this.listAll(signal)).models;
  }

  private serving(model: string): LLMProvider {
    const e = this.entryFor(model);
    if (!e.provider.isConfigured())
      throw new ProviderError('not_configured', null, { source: e.source });
    return e.provider;
  }

  async *streamChat(request: ChatRequest): AsyncGenerator<StreamEvent, void, undefined> {
    yield* this.serving(request.model).streamChat(request);
  }

  async complete(request: ChatRequest): Promise<CompletionResult> {
    return this.serving(request.model).complete(request);
  }
}

export interface ProviderDeps {
  redactor: Redactor;
  recorder: ProviderCallRecorder;
  /** Tests: canned HTTP for every provider, and short retry waits. */
  fetch?: typeof fetch;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
}

export function createProviders(config: AppConfig, d: ProviderDeps): ProviderRouter {
  const common = {
    timeoutMs: config.provider.timeoutMs,
    maxRetries: config.provider.maxRetries,
    redactor: d.redactor,
    recorder: d.recorder,
    ...(d.fetch ? { fetch: d.fetch } : {}),
    ...(d.retryBaseDelayMs !== undefined ? { retryBaseDelayMs: d.retryBaseDelayMs } : {}),
    ...(d.retryMaxDelayMs !== undefined ? { retryMaxDelayMs: d.retryMaxDelayMs } : {}),
  };
  const p = config.providers;
  return new ProviderRouter([
    {
      id: 'notokenlimit',
      prefix: '',
      source: NOTOKENLIMIT,
      baseUrl: config.provider.baseUrl,
      provider: new NoTokenLimitProvider({
        ...common,
        apiKey: config.provider.apiKey,
        baseUrl: config.provider.baseUrl,
      }),
    },
    {
      id: 'anthropic',
      prefix: ANTHROPIC_PREFIX,
      source: ANTHROPIC,
      baseUrl: 'https://api.anthropic.com',
      provider: new AnthropicProvider({ ...common, apiKey: p.anthropic.apiKey }),
    },
    {
      id: 'openai',
      prefix: 'openai:',
      source: OPENAI,
      baseUrl: 'https://api.openai.com/v1',
      provider: new OpenAICompatibleProvider({
        ...common,
        id: 'openai',
        source: OPENAI,
        prefix: 'openai:',
        apiKey: p.openai.apiKey,
        baseUrl: 'https://api.openai.com/v1',
        maxTokensField: 'max_completion_tokens',
        modelFilter: isOpenAIChatModel,
      }),
    },
    {
      id: 'openrouter',
      prefix: 'openrouter:',
      source: OPENROUTER,
      baseUrl: 'https://openrouter.ai/api/v1',
      provider: new OpenAICompatibleProvider({
        ...common,
        id: 'openrouter',
        source: OPENROUTER,
        prefix: 'openrouter:',
        apiKey: p.openrouter.apiKey,
        baseUrl: 'https://openrouter.ai/api/v1',
      }),
    },
  ]);
}
