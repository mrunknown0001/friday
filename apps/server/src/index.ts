import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { openDatabase } from './db/database.js';
import { createServices } from './services.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// Works from both src/ (tsx) and dist/ (compiled): two levels up from apps/server/<dir>.
const repoRoot = path.resolve(here, '../../..');

async function main() {
  const envFile = path.join(repoRoot, '.env');
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

  const config = loadConfig(process.env, repoRoot);
  const db = openDatabase(path.join(config.dataDir, 'friday.db'));
  const services = createServices(config, db);

  const interrupted = services.runs.markInterrupted();
  if (interrupted > 0) {
    services.audit.record({
      actor: 'system',
      action: 'runs_interrupted_on_startup',
      details: { count: interrupted },
    });
  }

  const app = await buildApp(services, {
    logger: true,
    webDist: path.join(repoRoot, 'apps/web/dist'),
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    await services.runManager.shutdown();
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // Loopback only: the API controls a local agent and must never be exposed on the network.
  await app.listen({ host: config.server.host, port: config.server.port });
  app.log.info(
    {
      apiKeyConfigured: services.provider.isConfigured(),
      model: services.modelSettings.resolve().model,
      dataDir: config.dataDir,
      interruptedRuns: interrupted,
    },
    'Friday server ready',
  );
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    console.error(err.message);
  } else {
    console.error('Fatal startup error:', err instanceof Error ? err.message : err);
  }
  process.exit(1);
});
