import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';
import { Redactor } from '../src/security/redact.js';

describe('loadConfig', () => {
  it('configures the desktop launch token, file locations, and no dev origins with a token', () => {
    const token = 'a'.repeat(43);
    const c = loadConfig(
      {
        FRIDAY_LAUNCH_TOKEN: token,
        FRIDAY_ENV_FILE: '/home/u/.config/Friday/friday.env',
        FRIDAY_WEB_DIST: '/opt/Friday/resources/web',
      },
      '/repo',
    );
    expect(c.server.launchToken).toBe(token);
    expect(c.server.devOrigins).toEqual([]);
    expect(c.envFile).toBe('/home/u/.config/Friday/friday.env');
    expect(c.webDist).toBe('/opt/Friday/resources/web');
    expect(loadConfig({}, '/repo')).toMatchObject({
      envFile: '/repo/.env',
      webDist: '/repo/apps/web/dist',
      server: { launchToken: null },
    });
    expect(() => loadConfig({ FRIDAY_LAUNCH_TOKEN: 'short' }, '/repo')).toThrow(
      /FRIDAY_LAUNCH_TOKEN/,
    );
  });

  it('applies defaults and reports a missing key as unconfigured', () => {
    const c = loadConfig({}, '/repo');
    expect(c.provider).toEqual({
      apiKey: null,
      envModel: null,
      baseUrl: 'https://notokenlimit.com/api/v1',
      timeoutMs: 120_000,
      maxRetries: 2,
    });
    expect(c.server).toMatchObject({ host: '127.0.0.1', port: 4317 });
    expect(c.dataDir).toBe('/repo/.data');
  });

  it('reads provider settings from the environment', () => {
    const c = loadConfig(
      {
        NTL_API_KEY: ' k-123 ',
        NTL_MODEL: 'claude-opus-5',
        NTL_TIMEOUT_MS: '3000',
        NTL_MAX_RETRIES: '0',
        NTL_BASE_URL: 'https://x.test/v1/',
      },
      '/repo',
    );
    expect(c.provider).toMatchObject({
      apiKey: 'k-123',
      envModel: 'claude-opus-5',
      timeoutMs: 3000,
      maxRetries: 0,
      baseUrl: 'https://x.test/v1',
    });
  });

  it('rejects insecure base URLs and out-of-range numbers without echoing values', () => {
    expect(() => loadConfig({ NTL_BASE_URL: 'http://evil.example/v1' }, '/r')).toThrow(ConfigError);
    expect(() => loadConfig({ NTL_MAX_RETRIES: '50' }, '/r')).toThrow(/NTL_MAX_RETRIES/);
    expect(() => loadConfig({ NTL_TIMEOUT_MS: 'abc' }, '/r')).toThrow(ConfigError);
    expect(loadConfig({ NTL_BASE_URL: 'http://localhost:8080/v1' }, '/r').provider.baseUrl).toBe(
      'http://localhost:8080/v1',
    );
  });
});

describe('Redactor', () => {
  it('catches env-var style names and URL credentials without mangling ordinary text', () => {
    const r = new Redactor([]);
    expect(r.redact('DB_PASSWORD=hunter2hunter')).toBe('DB_PASSWORD=[REDACTED]');
    expect(r.redact('AWS_SECRET_ACCESS_KEY=abcd1234xyz')).toBe('AWS_SECRET_ACCESS_KEY=[REDACTED]');
    expect(r.redact('MYSQL_PWD=root')).toBe('MYSQL_PWD=[REDACTED]');
    expect(r.redact('https://deploy:s3cret@git.example.com/r.git')).toBe(
      'https://deploy:[REDACTED]@git.example.com/r.git',
    );
    for (const ok of ['PWD=/home/u/app', 'max_tokens: 4096', 'The token is valid', 'node --test'])
      expect(r.redact(ok)).toBe(ok);
  });

  it('removes known secrets and common credential patterns', () => {
    const r = new Redactor(['super-secret-value-123', 'short']);
    const out = r.redact(
      'key super-secret-value-123 auth Bearer abcdefghijklmnop token=hunter2hunter2 sk-abcdefghijklmnopqrstuv short',
    );
    expect(out).not.toContain('super-secret-value-123');
    expect(out).not.toContain('abcdefghijklmnop');
    expect(out).not.toContain('hunter2hunter2');
    expect(out).not.toContain('sk-abcdefghijklmnopqrstuv');
    expect(out).toContain('token=[REDACTED]');
    // Short literals are not treated as secrets to avoid mangling ordinary text.
    expect(out).toContain('short');
  });

  it('redacts private key blocks', () => {
    const r = new Redactor();
    expect(
      r.redact('-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----'),
    ).toBe('[REDACTED]');
  });
});
