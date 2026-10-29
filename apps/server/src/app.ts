import fs from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { ProviderError } from './providers/errors.js';
import { HttpError } from './http/errors.js';
import { registerApprovalRoutes } from './http/routes/approvals.js';
import { registerDevopsRoutes } from './http/routes/devops.js';
import { registerProjectRoutes } from './http/routes/projects.js';
import { registerProviderRoutes } from './http/routes/provider.js';
import { registerSessionRoutes } from './http/routes/sessions.js';
import { registerLocalOnlyGuards } from './http/security.js';
import type { Services } from './services.js';

export interface AppOptions {
  logger?: boolean;
  /** Built web UI to serve (apps/web/dist). Omitted in dev, where Vite serves the UI. */
  webDist?: string | null;
}

function providerStatus(err: ProviderError): number {
  switch (err.kind) {
    case 'not_configured':
    case 'bad_request':
    case 'model_not_found':
    case 'unsupported':
      return 400;
    case 'cancelled':
      return 409;
    case 'rate_limit':
    case 'quota':
      return 429;
    case 'timeout':
      return 504;
    default:
      return 502;
  }
}

export async function buildApp(
  services: Services,
  opts: AppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger
      ? {
          level: 'info',
          // Never log headers (Authorization/Cookie) or bodies (user prompts).
          serializers: { req: (req) => ({ method: req.method, url: req.url }) },
        }
      : false,
    bodyLimit: 1024 * 1024,
  });

  registerLocalOnlyGuards(app, {
    port: services.config.server.port,
    devOrigins: services.config.server.devOrigins,
  });

  app.setErrorHandler((error, req, reply) => {
    if (error instanceof HttpError) {
      return reply
        .code(error.statusCode)
        .send({ error: { code: error.code, message: error.message, retryable: error.retryable } });
    }
    if (error instanceof ProviderError) {
      return reply.code(providerStatus(error)).send({
        error: {
          code: `provider_${error.kind}`,
          message: error.message,
          retryable: error.retryable,
        },
      });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return reply.code(status).send({
        error: {
          code: 'bad_request',
          message: services.redactor.redact(String((error as Error).message)),
        },
      });
    }
    req.log.error(
      { err: services.redactor.redact(String((error as Error)?.stack ?? error)) },
      'unhandled error',
    );
    return reply
      .code(500)
      .send({ error: { code: 'internal_error', message: 'Internal server error.' } });
  });

  app.get('/api/health', async () => ({ ok: true }));
  registerProviderRoutes(app, services);
  registerSessionRoutes(app, services);
  registerProjectRoutes(app, services);
  registerApprovalRoutes(app, services);
  registerDevopsRoutes(app, services);

  const webDist = opts.webDist;
  if (webDist && fs.existsSync(path.join(webDist, 'index.html'))) {
    await app.register(fastifyStatic, { root: webDist, index: ['index.html'] });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: { code: 'not_found', message: 'Not found.' } });
    });
  } else {
    app.setNotFoundHandler((_req, reply) =>
      reply.code(404).send({ error: { code: 'not_found', message: 'Not found.' } }),
    );
  }

  return app;
}
