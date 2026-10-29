// Live NoTokenLimit check. Consumes a small amount of quota, so it only runs via
// `npm run test:integration` with NTL_API_KEY and NTL_MODEL set in .env. Never run in CI.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { probeCapabilities } from '../../src/providers/capabilities.js';
import { NoTokenLimitProvider } from '../../src/providers/notokenlimit.js';
import { Redactor } from '../../src/security/redact.js';

const repoRoot = path.resolve(import.meta.dirname, '../../../..');
const envFile = path.join(repoRoot, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
const config = loadConfig(process.env, repoRoot);
const enabled =
  process.env.NTL_INTEGRATION === '1' && !!config.provider.apiKey && !!config.provider.envModel;

describe.skipIf(!enabled)('NoTokenLimit live integration', () => {
  const provider = new NoTokenLimitProvider({
    apiKey: config.provider.apiKey,
    baseUrl: config.provider.baseUrl,
    timeoutMs: config.provider.timeoutMs,
    maxRetries: config.provider.maxRetries,
    redactor: new Redactor([config.provider.apiKey]),
  });
  const model = config.provider.envModel!;

  it('lists models including the configured one', async () => {
    const models = await provider.listModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models.map((m) => m.id)).toContain(model);
  }, 60_000);

  it('streams a short completion', async () => {
    let text = '';
    for await (const ev of provider.streamChat({
      model,
      messages: [{ role: 'user', content: 'Reply with exactly: pong' }],
      maxOutputTokens: 16,
    })) {
      if (ev.type === 'text') text += ev.delta;
    }
    expect(text.toLowerCase()).toContain('pong');
  }, 120_000);

  it('reports actual streaming and tool-calling capability', async () => {
    const result = await probeCapabilities(provider, model);
    console.info(`[integration] ${model}:`, result);
    expect(['supported', 'unsupported', 'unknown']).toContain(result.toolCalling);
  }, 120_000);
});
