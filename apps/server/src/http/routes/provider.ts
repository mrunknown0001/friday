import type { ConnectionTestResult, SettingsDto } from '@friday/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { probeCapabilities } from '../../providers/capabilities.js';
import { classifyError } from '../../providers/errors.js';
import type { Services } from '../../services.js';
import { HttpError } from '../errors.js';
import { parseInput } from '../validation.js';

const modelId = z.string().trim().min(1).max(200);

export function registerProviderRoutes(app: FastifyInstance, s: Services) {
  const requireModel = (model?: string): string => {
    const resolved = model ?? s.modelSettings.resolve().model;
    if (!resolved)
      throw new HttpError(400, 'model_not_selected', 'Select a model in Settings first.');
    return resolved;
  };

  app.get('/api/settings', async (): Promise<SettingsDto> => {
    const { model, source } = s.modelSettings.resolve();
    return {
      model,
      modelSource: source,
      apiKeyConfigured: s.provider.isConfigured(),
      envFile: s.config.envFile,
      baseUrl: s.config.provider.baseUrl,
      timeoutMs: s.config.provider.timeoutMs,
      maxRetries: s.config.provider.maxRetries,
    };
  });

  app.put('/api/settings/model', async (req) => {
    const { model } = parseInput(z.object({ model: modelId }), req.body);
    // Reject IDs that are not in the provider's model list. NoTokenLimit's /models endpoint returns
    // its public catalog (it does not check the key or plan), so plan access is verified separately
    // by the connection test, which makes a real completion request.
    const models = await s.catalog.list(true);
    if (!models.some((m) => m.id === model)) {
      throw new HttpError(
        400,
        'model_not_available',
        `Model "${model}" is not in the NoTokenLimit model list.`,
      );
    }
    const previous = s.modelSettings.resolve().model;
    s.modelSettings.set(model);
    s.audit.record({
      actor: 'user',
      action: 'model_changed',
      details: { from: previous, to: model },
    });
    return { model };
  });

  app.delete('/api/settings/model', async () => {
    s.modelSettings.clear();
    s.audit.record({ actor: 'user', action: 'model_reset_to_env' });
    return s.modelSettings.resolve();
  });

  app.get('/api/provider/models', async (req) => {
    const { refresh } = parseInput(z.object({ refresh: z.enum(['0', '1']).optional() }), req.query);
    return { models: await s.catalog.list(refresh === '1') };
  });

  app.post('/api/provider/test', async (req): Promise<ConnectionTestResult> => {
    const body = parseInput(z.object({ model: modelId.optional() }), req.body);
    const model = body.model ?? s.modelSettings.resolve().model;
    const started = Date.now();
    let modelListed: boolean | null = null;
    try {
      const models = await s.catalog.list(true);
      modelListed = model ? models.some((m) => m.id === model) : null;
      if (!model) {
        // The model list endpoint does not authenticate, so this alone proves nothing about the key.
        return {
          ok: false,
          model: null,
          latencyMs: Date.now() - started,
          modelListed,
          error: {
            kind: 'bad_request',
            message: `Reached NoTokenLimit (${models.length} models listed), but no model is selected. Select a model, then test again to verify the key.`,
          },
        };
      }
      const result = await s.provider.complete({
        model,
        operation: 'connection_test',
        messages: [{ role: 'user', content: 'Reply with exactly: pong' }],
        maxOutputTokens: 16,
      });
      return {
        ok: true,
        model,
        latencyMs: Date.now() - started,
        modelListed,
        reply: result.text.slice(0, 200),
      };
    } catch (raw) {
      const err = classifyError(raw, s.redactor);
      return {
        ok: false,
        model,
        latencyMs: Date.now() - started,
        modelListed,
        error: { kind: err.kind, message: err.message },
      };
    }
  });

  app.get('/api/provider/capabilities', async (req) => {
    const { model } = parseInput(z.object({ model: modelId.optional() }), req.query);
    return s.capabilities.get(requireModel(model));
  });

  app.post('/api/provider/capabilities/probe', async (req) => {
    const body = parseInput(z.object({ model: modelId.optional() }), req.body);
    const model = requireModel(body.model);
    const result = await probeCapabilities(s.provider, model);
    s.capabilities.saveProbe(model, result);
    return s.capabilities.get(model);
  });

  app.put('/api/provider/capabilities/context-window', async (req) => {
    const body = parseInput(
      z.object({
        model: modelId.optional(),
        tokens: z.number().int().min(2_000).max(10_000_000).nullable(),
      }),
      req.body,
    );
    const model = requireModel(body.model);
    s.capabilities.setContextWindow(model, body.tokens);
    return s.capabilities.get(model);
  });

  app.get('/api/provider/calls', async () => ({ calls: s.providerCalls.recent(50) }));
}
