import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { ConfigError, loadConfig, resolveEnvFile } from './config.js';
import { openDatabase } from './db/database.js';
import { acquireDataDirLock } from './db/lock.js';
import { reapOrphans } from './processes/manager.js';
import { cleanupSandboxes, instanceLabel } from './sandbox/docker.js';
import { createServices } from './services.js';
import { detectToolEnvironment } from './workspace/environment.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// Works from both src/ (tsx) and dist/ (compiled): two levels up from apps/server/<dir>.
const repoRoot = path.resolve(here, '../../..');

async function main() {
  const envFile = resolveEnvFile(process.env, repoRoot);
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

  const config = loadConfig(process.env, repoRoot);
  // One server per data directory: two would each mark the other's runs as interrupted.
  const releaseLock = acquireDataDirLock(config.dataDir);
  process.on('exit', releaseLock);
  const db = openDatabase(path.join(config.dataDir, 'friday.db'));
  const toolEnv = await detectToolEnvironment(instanceLabel(config.dataDir));
  // Containers left by a crash of this instance (labelled with its id; nobody else's).
  const leftoverSandboxes = toolEnv.docker ? await cleanupSandboxes(toolEnv.sandboxInstance) : 0;
  // Background processes (dev servers) a crash of this instance left running.
  const leftoverProcesses = await reapOrphans(toolEnv.sandboxInstance);
  const services = createServices(config, db, { toolEnv });

  const interrupted = services.runs.markInterrupted();
  // Approvals cannot survive a restart: the run that would execute them is gone.
  const orphanedApprovals = services.approvalRepo.cancelOrphans();
  if (orphanedApprovals > 0) {
    services.audit.record({
      actor: 'system',
      action: 'approvals_cancelled_on_startup',
      details: { count: orphanedApprovals },
    });
  }
  if (interrupted > 0) {
    services.audit.record({
      actor: 'system',
      action: 'runs_interrupted_on_startup',
      details: { count: interrupted },
    });
  }

  const app = await buildApp(services, {
    logger: true,
    webDist: config.webDist,
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
  const address = app.server.address();
  const port = address && typeof address === 'object' ? address.port : config.server.port;
  // Running under the desktop app (an Electron utility process): report the bound port, so the
  // shell never has to guess a free port that another program could take first.
  const parentPort = (process as { parentPort?: { postMessage(message: unknown): void } })
    .parentPort;
  parentPort?.postMessage({ type: 'listening', port });
  app.log.info(
    {
      apiKeyConfigured: services.provider.isConfigured(),
      model: services.modelSettings.resolve().model,
      port,
      dataDir: config.dataDir,
      envFile: config.envFile,
      desktop: config.server.launchToken !== null,
      interruptedRuns: interrupted,
      ripgrep: toolEnv.ripgrepVersion ?? 'not found (literal search fallback)',
      docker: toolEnv.docker ?? 'not reachable (command sandbox unavailable)',
      leftoverSandboxes,
      leftoverProcesses,
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
