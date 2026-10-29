import { z } from 'zod';
import type { AppConfig } from './config.js';
import type { Db } from './db/database.js';
import { RunManager } from './chat/runManager.js';
import { NoTokenLimitProvider } from './providers/notokenlimit.js';
import type { LLMProvider, ModelInfo } from './providers/types.js';
import { CapabilityRepo } from './repositories/capabilities.js';
import { MessageRepo } from './repositories/messages.js';
import { RunRepo } from './repositories/runs.js';
import { SessionRepo } from './repositories/sessions.js';
import { SettingsRepo } from './repositories/settings.js';
import { AuditRepo, ProviderCallRepo } from './repositories/telemetry.js';
import { Redactor } from './security/redact.js';

export const MODEL_SETTING = 'provider.model';
const modelSettingSchema = z.string().min(1).max(200);

export class ModelSettings {
  constructor(
    private readonly settings: SettingsRepo,
    private readonly envModel: string | null,
  ) {}

  resolve(): { model: string | null; source: 'settings' | 'env' | 'none' } {
    const stored = this.settings.get(MODEL_SETTING, modelSettingSchema);
    if (stored) return { model: stored, source: 'settings' };
    if (this.envModel) return { model: this.envModel, source: 'env' };
    return { model: null, source: 'none' };
  }

  set(model: string): void {
    this.settings.set(MODEL_SETTING, modelSettingSchema.parse(model));
  }

  clear(): void {
    this.settings.delete(MODEL_SETTING);
  }
}

/** Caches the account's model list briefly so model validation doesn't hit the API every time. */
export class ModelCatalog {
  private cache: { at: number; models: ModelInfo[] } | null = null;

  constructor(
    private readonly provider: LLMProvider,
    private readonly ttlMs = 5 * 60_000,
  ) {}

  async list(refresh = false): Promise<ModelInfo[]> {
    if (!refresh && this.cache && Date.now() - this.cache.at < this.ttlMs) return this.cache.models;
    const models = await this.provider.listModels();
    this.cache = { at: Date.now(), models };
    return models;
  }
}

export interface Services {
  config: AppConfig;
  db: Db;
  redactor: Redactor;
  provider: LLMProvider;
  settings: SettingsRepo;
  sessions: SessionRepo;
  messages: MessageRepo;
  runs: RunRepo;
  capabilities: CapabilityRepo;
  providerCalls: ProviderCallRepo;
  audit: AuditRepo;
  modelSettings: ModelSettings;
  catalog: ModelCatalog;
  runManager: RunManager;
}

export interface ServiceOverrides {
  provider?: LLMProvider;
  fetch?: typeof fetch;
  retryBaseDelayMs?: number;
  runManager?: {
    checkpointIntervalMs?: number;
    retainFinishedMs?: number;
    maxOutputTokens?: number;
  };
}

export function createServices(
  config: AppConfig,
  db: Db,
  overrides: ServiceOverrides = {},
): Services {
  const redactor = new Redactor([config.provider.apiKey]);
  const providerCalls = new ProviderCallRepo(db);
  const provider =
    overrides.provider ??
    new NoTokenLimitProvider({
      apiKey: config.provider.apiKey,
      baseUrl: config.provider.baseUrl,
      timeoutMs: config.provider.timeoutMs,
      maxRetries: config.provider.maxRetries,
      redactor,
      recorder: (r) => providerCalls.insert(r),
      ...(overrides.fetch ? { fetch: overrides.fetch } : {}),
      ...(overrides.retryBaseDelayMs !== undefined
        ? { retryBaseDelayMs: overrides.retryBaseDelayMs }
        : {}),
    });

  const settings = new SettingsRepo(db);
  const sessions = new SessionRepo(db);
  const messages = new MessageRepo(db);
  const runs = new RunRepo(db);
  const capabilities = new CapabilityRepo(db);
  const audit = new AuditRepo(db);
  const modelSettings = new ModelSettings(settings, config.provider.envModel);

  const runManager = new RunManager({
    provider,
    sessions,
    messages,
    runs,
    capabilities,
    audit,
    redactor,
    resolveModel: () => modelSettings.resolve().model,
    ...overrides.runManager,
  });

  return {
    config,
    db,
    redactor,
    provider,
    settings,
    sessions,
    messages,
    runs,
    capabilities,
    providerCalls,
    audit,
    modelSettings,
    catalog: new ModelCatalog(provider),
    runManager,
  };
}
