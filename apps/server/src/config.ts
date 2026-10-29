import path from 'node:path';
import type { AgentLimitsDto } from '@friday/shared';
import { z } from 'zod';

const DEFAULT_BASE_URL = 'https://notokenlimit.com/api/v1';

const intFromEnv = (def: number, min: number, max: number) =>
  z
    .string()
    .trim()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number().int().min(min).max(max));

const optionalString = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v ? v : null));

const envSchema = z.object({
  NTL_API_KEY: optionalString,
  NTL_MODEL: optionalString,
  NTL_BASE_URL: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? v : DEFAULT_BASE_URL))
    .pipe(
      z.url().refine((u) => {
        const parsed = new URL(u);
        // Plain HTTP is only acceptable for a provider running on this machine.
        return (
          parsed.protocol === 'https:' ||
          (parsed.protocol === 'http:' &&
            ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))
        );
      }, 'NTL_BASE_URL must use https (http is allowed only for localhost)'),
    ),
  NTL_TIMEOUT_MS: intFromEnv(120_000, 1_000, 600_000),
  NTL_MAX_RETRIES: intFromEnv(2, 0, 5),
  // 0 = any free port (the desktop app reads the bound port from the server).
  FRIDAY_PORT: intFromEnv(4317, 0, 65_535),
  FRIDAY_DATA_DIR: optionalString,
  /** File the server loads NTL_* settings from (the desktop app points this at its config dir). */
  FRIDAY_ENV_FILE: optionalString,
  /** Built web UI to serve. Defaults to apps/web/dist in the repository. */
  FRIDAY_WEB_DIST: optionalString,
  /** Per-launch secret set by the desktop shell; when present every request must carry it. */
  FRIDAY_LAUNCH_TOKEN: optionalString.pipe(
    z
      .string()
      .regex(/^[A-Za-z0-9_-]{32,}$/, 'must be at least 32 URL-safe characters')
      .nullable(),
  ),
  FRIDAY_WEB_PORT: intFromEnv(5173, 1, 65_535),
  FRIDAY_DEV_ORIGINS: optionalString,
  FRIDAY_AGENT_MAX_ITERATIONS: intFromEnv(20, 1, 100),
  FRIDAY_AGENT_MAX_TOOL_CALLS: intFromEnv(40, 1, 300),
  FRIDAY_TOOL_TIMEOUT_MS: intFromEnv(30_000, 1_000, 300_000),
  FRIDAY_TOOL_OUTPUT_CHARS: intFromEnv(20_000, 2_000, 200_000),
  FRIDAY_APPROVAL_TTL_MS: intFromEnv(15 * 60_000, 10_000, 24 * 60 * 60_000),
});

export interface AppConfig {
  provider: {
    apiKey: string | null;
    envModel: string | null;
    baseUrl: string;
    timeoutMs: number;
    maxRetries: number;
  };
  server: {
    host: '127.0.0.1';
    port: number;
    /** Extra browser origins allowed to call the API (the Vite dev server). */
    devOrigins: string[];
    /** Required x-friday-token value (desktop app only). */
    launchToken: string | null;
  };
  dataDir: string;
  /** Where NTL_API_KEY and friends are read from, shown in Settings. */
  envFile: string;
  webDist: string;
  agent: AgentLimitsDto;
  /** How long a pending approval stays valid. */
  approvalTtlMs: number;
}

export class ConfigError extends Error {}

/** Resolved before the rest of the config, because this file is what fills in the environment. */
export function resolveEnvFile(env: NodeJS.ProcessEnv, repoRoot: string): string {
  return path.resolve(repoRoot, env.FRIDAY_ENV_FILE?.trim() || '.env');
}

export function loadConfig(env: NodeJS.ProcessEnv, repoRoot: string): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    // Only report variable names and validation messages, never values.
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigError(`Invalid configuration: ${issues}`);
  }
  const e = parsed.data;
  // The desktop app (launch token set) serves its own UI, so no dev-server origin by default.
  const devOrigins = (
    e.FRIDAY_DEV_ORIGINS ??
    (e.FRIDAY_LAUNCH_TOKEN
      ? ''
      : `http://localhost:${e.FRIDAY_WEB_PORT},http://127.0.0.1:${e.FRIDAY_WEB_PORT}`)
  )
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  return {
    provider: {
      apiKey: e.NTL_API_KEY,
      envModel: e.NTL_MODEL,
      baseUrl: e.NTL_BASE_URL.replace(/\/+$/, ''),
      timeoutMs: e.NTL_TIMEOUT_MS,
      maxRetries: e.NTL_MAX_RETRIES,
    },
    server: {
      host: '127.0.0.1',
      port: e.FRIDAY_PORT,
      devOrigins,
      launchToken: e.FRIDAY_LAUNCH_TOKEN,
    },
    dataDir: path.resolve(repoRoot, e.FRIDAY_DATA_DIR ?? '.data'),
    envFile: resolveEnvFile(env, repoRoot),
    webDist: path.resolve(repoRoot, e.FRIDAY_WEB_DIST ?? 'apps/web/dist'),
    agent: {
      maxIterations: e.FRIDAY_AGENT_MAX_ITERATIONS,
      maxToolCalls: e.FRIDAY_AGENT_MAX_TOOL_CALLS,
      maxToolOutputChars: e.FRIDAY_TOOL_OUTPUT_CHARS,
      toolTimeoutMs: e.FRIDAY_TOOL_TIMEOUT_MS,
      maxConsecutiveToolFailures: 4,
    },
    approvalTtlMs: e.FRIDAY_APPROVAL_TTL_MS,
  };
}
