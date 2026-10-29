import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Services } from '../../services.js';
import { explainSshFailure, HOST_NAME, HOSTNAME, USERNAME } from '../../ssh/ssh.js';
import { isSecretPath, WorkspaceError } from '../../workspace/paths.js';
import { HttpError } from '../errors.js';
import { parseInput } from '../validation.js';

const idParams = z.object({ id: z.uuid() });
const FORBIDDEN_LOG_PREFIXES = ['/proc/', '/sys/', '/dev/', '/boot/', '/etc/', '/root/'];

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof WorkspaceError) throw new HttpError(409, err.code, err.message);
    throw err;
  }
}

/**
 * SSH hosts and log sources are configured only through these endpoints (user actions in the UI).
 * No tool can add a host, trust a key, or authorize a path.
 */
export function registerDevopsRoutes(app: FastifyInstance, s: Services) {
  const requireHost = (id: string) => {
    const host = s.sshHosts.get(id);
    if (!host) throw new HttpError(404, 'host_not_found', 'SSH host not found.');
    return host;
  };

  app.get('/api/ssh-hosts', async () => ({ hosts: s.sshHosts.list() }));

  app.post('/api/ssh-hosts', async (req, reply) => {
    // strictObject: unknown fields (e.g. "password", "privateKey") are rejected outright.
    const body = parseInput(
      z.strictObject({
        name: z.string().regex(HOST_NAME, 'letters, digits, . _ - only'),
        hostname: z.string().regex(HOSTNAME, 'invalid hostname'),
        port: z.number().int().min(1).max(65_535).default(22),
        username: z.string().regex(USERNAME, 'invalid username'),
        identityFile: z.string().max(4096).nullable().default(null),
        environment: z.enum(['development', 'staging', 'production']),
      }),
      req.body,
    );
    if (s.sshHosts.byName(body.name))
      throw new HttpError(409, 'host_exists', `A host named "${body.name}" already exists.`);
    if (body.identityFile) {
      if (!path.isAbsolute(body.identityFile))
        throw new HttpError(400, 'invalid_identity', 'Key file path must be absolute.');
      if (body.identityFile.endsWith('.pub')) {
        throw new HttpError(
          400,
          'invalid_identity',
          'Point to the private key file (not .pub). Friday never reads it; ssh does.',
        );
      }
      const stat = await fs.stat(body.identityFile).catch(() => null);
      if (!stat?.isFile()) throw new HttpError(400, 'invalid_identity', 'Key file not found.');
    }
    const host = s.sshHosts.create(body);
    s.audit.record({
      actor: 'user',
      action: 'ssh_host_added',
      details: { name: host.name, hostname: host.hostname, environment: host.environment },
    });
    reply.code(201);
    return host;
  });

  app.delete('/api/ssh-hosts/:id', async (req, reply) => {
    const { id } = parseInput(idParams, req.params);
    const host = requireHost(id);
    s.sshHosts.delete(id);
    s.audit.record({ actor: 'user', action: 'ssh_host_removed', details: { name: host.name } });
    reply.code(204);
  });

  // Shows the host's current key fingerprints so the user can compare them out-of-band.
  app.post('/api/ssh-hosts/:id/scan', async (req) => {
    const { id } = parseInput(idParams, req.params);
    const keys = await wrap(() => s.ssh.scan(requireHost(id)));
    return { keys: keys.map((k) => ({ fingerprint: k.fingerprint })) };
  });

  app.post('/api/ssh-hosts/:id/trust', async (req) => {
    const { id } = parseInput(idParams, req.params);
    const { fingerprint } = parseInput(
      z.object({ fingerprint: z.string().min(10).max(200) }),
      req.body,
    );
    const host = await wrap(() => s.ssh.trust(requireHost(id), fingerprint));
    s.audit.record({
      actor: 'user',
      action: 'ssh_host_key_trusted',
      details: { name: host.name, fingerprint },
    });
    return host;
  });

  app.post('/api/ssh-hosts/:id/untrust', async (req) => {
    const { id } = parseInput(idParams, req.params);
    const host = requireHost(id);
    s.sshHosts.setTrusted(id, []);
    s.audit.record({
      actor: 'user',
      action: 'ssh_host_key_untrusted',
      details: { name: host.name },
    });
    return s.sshHosts.get(id);
  });

  // User-initiated connectivity check: runs `true`, nothing else.
  app.post('/api/ssh-hosts/:id/test', async (req) => {
    const { id } = parseInput(idParams, req.params);
    const host = requireHost(id);
    const r = await wrap(() =>
      s.ssh.run(host, 'true', { timeoutMs: 20_000, signal: AbortSignal.timeout(25_000) }),
    );
    if (r.exitCode === 0)
      return {
        ok: true,
        message: `Connected to ${host.username}@${host.hostname} in ${r.durationMs} ms.`,
      };
    return {
      ok: false,
      message: r.timedOut ? 'Timed out.' : explainSshFailure(r.output),
      detail: s.redactor.redact(r.output.slice(0, 500)),
    };
  });

  app.get('/api/log-sources', async () => ({ sources: s.logSources.list() }));

  app.post('/api/log-sources', async (req, reply) => {
    const body = parseInput(
      z.strictObject({
        label: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/, 'letters, digits, . _ - only'),
        path: z.string().min(2).max(4096),
      }),
      req.body,
    );
    if (!path.isAbsolute(body.path))
      throw new HttpError(400, 'invalid_path', 'Use an absolute path.');
    const real = await fs.realpath(body.path).catch(() => null);
    if (!real) throw new HttpError(404, 'not_found', 'That file does not exist.');
    const stat = await fs.stat(real);
    if (!stat.isFile()) throw new HttpError(400, 'not_a_file', 'Choose a log file, not a folder.');
    if (FORBIDDEN_LOG_PREFIXES.some((p) => real.startsWith(p)) || isSecretPath(real)) {
      throw new HttpError(
        403,
        'forbidden_path',
        'That location cannot be authorized as a log source.',
      );
    }
    await fs.access(real, fs.constants.R_OK).catch(() => {
      throw new HttpError(403, 'not_readable', 'Friday cannot read that file (permissions).');
    });
    if (s.logSources.byLabel(body.label))
      throw new HttpError(409, 'label_exists', 'That label is already used.');
    if (s.logSources.list().some((l) => l.path === real))
      throw new HttpError(409, 'path_exists', 'That file is already authorized.');
    const source = s.logSources.create(body.label, real);
    s.audit.record({
      actor: 'user',
      action: 'log_source_authorized',
      details: { label: source.label, path: real },
    });
    reply.code(201);
    return source;
  });

  app.delete('/api/log-sources/:id', async (req, reply) => {
    const { id } = parseInput(idParams, req.params);
    if (!s.logSources.delete(id)) throw new HttpError(404, 'not_found', 'Log source not found.');
    s.audit.record({ actor: 'user', action: 'log_source_removed', details: { id } });
    reply.code(204);
  });
}
