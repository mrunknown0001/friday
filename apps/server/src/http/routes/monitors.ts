import type { FastifyInstance } from 'fastify';
import type { MonitorInput } from '@friday/shared';
import { z } from 'zod';
import { SERVICE_NAME } from '../../compose/compose.js';
import { checkUrl, DISK_PATH, UNIT } from '../../monitors/checks.js';
import type { Services } from '../../services.js';
import { HttpError } from '../errors.js';
import { parseInput } from '../validation.js';

const target = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('http'),
    url: z.string().trim().min(1).max(2_000),
    expectedStatus: z.number().int().min(100).max(599).nullable().default(null),
    contains: z.string().min(1).max(500).nullable().default(null),
    timeoutSeconds: z.number().int().min(1).max(60).default(10),
  }),
  z.object({
    kind: z.literal('ssh'),
    hostId: z.uuid(),
    service: z.string().trim().regex(UNIT, 'invalid systemd unit name').nullable().default(null),
    diskPath: z
      .string()
      .trim()
      .regex(DISK_PATH, 'an absolute path like /')
      .nullable()
      .default(null),
    diskMaxPercent: z.number().int().min(1).max(100).nullable().default(null),
  }),
  z.object({ kind: z.literal('process'), processName: z.string().trim().min(1).max(80) }),
  z.object({
    kind: z.literal('compose'),
    service: z.string().trim().regex(SERVICE_NAME, 'invalid service name'),
    file: z.string().trim().min(1).max(512).nullable().default(null),
  }),
]);

export const monitorInput = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(/^[\w .:/()-]+$/, 'letters, digits, spaces and . _ : / ( ) - only'),
  projectId: z.uuid().nullable().default(null),
  target,
  intervalMinutes: z.number().int().min(1).max(1_440).default(5),
  failuresBeforeAlert: z.number().int().min(1).max(10).default(2),
  enabled: z.boolean().default(true),
});

/**
 * Health monitors are created, changed and deleted only here, by the user through the UI (these
 * routes need the browser client header like every other change). The model can only read them.
 */
export function registerMonitorRoutes(app: FastifyInstance, s: Services) {
  const check = (body: MonitorInput, exceptId: string | null) => {
    const t = body.target;
    if (t.kind === 'http') {
      try {
        checkUrl(t.url);
      } catch (err) {
        throw new HttpError(400, 'invalid_url', (err as Error).message);
      }
    }
    if (t.kind === 'ssh') {
      const host = s.sshHosts.get(t.hostId);
      if (!host) throw new HttpError(400, 'unknown_host', 'That SSH host no longer exists.');
      if (!host.trustedFingerprints.length)
        throw new HttpError(
          400,
          'untrusted_host',
          `Trust ${host.name}'s host key in Settings › SSH hosts first.`,
        );
      if ((t.diskPath === null) !== (t.diskMaxPercent === null))
        throw new HttpError(
          400,
          'invalid_disk',
          'Give both a disk path and a usage limit, or neither.',
        );
    }
    if ((t.kind === 'process' || t.kind === 'compose') && !body.projectId)
      throw new HttpError(400, 'project_required', 'Pick the project this monitor belongs to.');
    if (body.projectId) {
      const p = s.projects.get(body.projectId);
      if (!p) throw new HttpError(404, 'project_not_found', 'Project not found.');
    }
    const same = s.monitors.byName(body.name);
    if (same && same.id !== exceptId)
      throw new HttpError(409, 'monitor_exists', `A monitor named "${body.name}" already exists.`);
  };

  const audit = (action: string, m: { name: string; target: { kind: string } }) =>
    s.audit.record({ actor: 'user', action, details: { name: m.name, kind: m.target.kind } });

  const idParams = z.object({ id: z.uuid() });
  const found = (id: string) => {
    const m = s.monitors.get(id);
    if (!m) throw new HttpError(404, 'monitor_not_found', 'Monitor not found.');
    return m;
  };

  app.get('/api/monitors', async () => ({ monitors: s.monitors.list() }));

  app.get('/api/monitors/:id', async (req) => {
    const { id } = parseInput(idParams, req.params);
    found(id);
    return s.monitors.detail(id);
  });

  app.post('/api/monitors', async (req, reply) => {
    const body = parseInput(monitorInput, req.body);
    check(body, null);
    const monitor = s.monitors.create(body);
    audit('monitor_created', monitor);
    // A first result right away instead of after the first interval.
    if (monitor.enabled) void s.monitorService.check(monitor.id);
    reply.code(201);
    return monitor;
  });

  app.put('/api/monitors/:id', async (req) => {
    const { id } = parseInput(idParams, req.params);
    const before = found(id);
    const body = parseInput(monitorInput, req.body);
    check(body, id);
    const monitor = s.monitors.update(id, body)!;
    audit('monitor_changed', monitor);
    const retargeted = JSON.stringify(before.target) !== JSON.stringify(monitor.target);
    if (monitor.enabled && (retargeted || !before.enabled)) void s.monitorService.check(id);
    return monitor;
  });

  app.delete('/api/monitors/:id', async (req, reply) => {
    const { id } = parseInput(idParams, req.params);
    const m = found(id);
    s.monitors.delete(id);
    audit('monitor_deleted', m);
    reply.code(204);
  });

  app.post('/api/monitors/:id/check', async (req) => {
    const { id } = parseInput(idParams, req.params);
    found(id);
    const change = await s.monitorService.check(id);
    return change?.monitor ?? found(id);
  });
}
