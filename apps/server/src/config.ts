import path from 'node:path';
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
  FRIDAY_PORT: intFromEnv(4317, 1, 65_535),
  FRIDAY_DATA_DIR: optionalString,
  FRIDAY_WEB_PORT: intFromEnv(5173, 1, 65_535),
  FRIDAY_DEV_ORIGINS: optionalString,
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
  };
  dataDir: string;
}

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv, repoRoot: string): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    // Only report variable names and validation messages, never values.
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigError(`Invalid configuration: ${issues}`);
  }
  const e = parsed.data;
  const devOrigins = (
    e.FRIDAY_DEV_ORIGINS ??
    `http://localhost:${e.FRIDAY_WEB_PORT},http://127.0.0.1:${e.FRIDAY_WEB_PORT}`
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
    server: { host: '127.0.0.1', port: e.FRIDAY_PORT, devOrigins },
    dataDir: path.resolve(repoRoot, e.FRIDAY_DATA_DIR ?? '.data'),
  };
}
