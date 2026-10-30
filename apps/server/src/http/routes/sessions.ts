import type { AppNotice, RunEvent, SessionDetailDto } from '@friday/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { IMAGE_LIMITS } from '../../attachments/image.js';
import { MAX_USER_MESSAGE_CHARS } from '../../chat/runManager.js';
import { toMessageDto } from '../../repositories/messages.js';
import { toRunDto } from '../../repositories/runs.js';
import type { SessionRecord } from '../../repositories/sessions.js';
import type { Services } from '../../services.js';
import { HttpError } from '../errors.js';
import { parseInput } from '../validation.js';

const idParams = z.object({ id: z.uuid() });
const title = z.string().trim().min(1).max(200);

const SSE_HEARTBEAT_MS = 15_000;

export function registerSessionRoutes(app: FastifyInstance, s: Services) {
  const requireSession = (id: string): SessionRecord => {
    const session = s.sessions.get(id);
    if (!session) throw new HttpError(404, 'session_not_found', 'Session not found.');
    return session;
  };

  const summary = (r: SessionRecord) => ({
    id: r.id,
    projectId: r.projectId,
    title: r.title,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    lastRunStatus: r.lastRunStatus,
  });

  app.get('/api/sessions', async (req) => {
    // ?project=<id> lists that project's sessions; ?project=none lists sessions without a project.
    const { project } = parseInput(
      z.object({ project: z.union([z.uuid(), z.literal('none')]).optional() }),
      req.query,
    );
    const filter = project === undefined ? undefined : project === 'none' ? null : project;
    return { sessions: s.sessions.list(filter).map(summary) };
  });

  app.post('/api/sessions', async (req, reply) => {
    const body = parseInput(
      z.object({ title: title.optional(), projectId: z.uuid().nullable().optional() }),
      req.body,
    );
    if (body.projectId && !s.projects.get(body.projectId)) {
      throw new HttpError(404, 'project_not_found', 'Project not found.');
    }
    // The project binding is fixed at creation so a conversation can never span projects.
    const session = s.sessions.create(body.title, body.projectId ?? null);
    if (body.projectId) s.projects.touch(body.projectId);
    reply.code(201);
    return summary(session);
  });

  app.get('/api/sessions/:id', async (req): Promise<SessionDetailDto> => {
    const { id } = parseInput(idParams, req.params);
    const session = requireSession(id);
    const latest = s.runs.latestForSession(id);
    return {
      ...summary(session),
      messages: s.messages.listBySession(id).map(toMessageDto),
      latestRun: latest ? toRunDto(latest) : null,
      hasSummary: session.summary !== null,
      plan: session.plan,
      approvals: s.approvalRepo.listBySession(id),
      runs: s.runs.listBySession(id).map(toRunDto),
      deploymentPlans: s.deploymentPlans.listBySession(id),
      memoryUsage: s.memoryRepo.usageBySession(id),
    };
  });

  app.patch('/api/sessions/:id', async (req) => {
    const { id } = parseInput(idParams, req.params);
    const body = parseInput(z.object({ title }), req.body);
    requireSession(id);
    s.sessions.rename(id, body.title);
    return summary(s.sessions.get(id)!);
  });

  app.delete('/api/sessions/:id', async (req, reply) => {
    const { id } = parseInput(idParams, req.params);
    requireSession(id);
    const active = s.runManager.activeRunId(id);
    if (active) {
      s.runManager.cancel(active);
      await s.runManager.waitFor(active);
    }
    s.sessions.delete(id);
    s.audit.record({ actor: 'user', action: 'session_deleted', details: { sessionId: id } });
    reply.code(204);
  });

  app.post(
    '/api/sessions/:id/messages',
    { bodyLimit: MAX_USER_MESSAGE_CHARS * 4 + 1024 },
    async (req, reply) => {
      const { id } = parseInput(idParams, req.params);
      const body = parseInput(
        z.object({
          content: z.string(),
          attachmentIds: z.array(z.uuid()).max(IMAGE_LIMITS.perMessage).optional(),
        }),
        req.body,
      );
      const result = s.runManager.startMessage(id, body.content, body.attachmentIds);
      reply.code(202);
      return result;
    },
  );

  app.post('/api/sessions/:id/retry', async (req, reply) => {
    const { id } = parseInput(idParams, req.params);
    const result = s.runManager.retry(id);
    reply.code(202);
    return result;
  });

  app.post('/api/runs/:id/cancel', async (req) => {
    const { id } = parseInput(idParams, req.params);
    if (!s.runs.get(id)) throw new HttpError(404, 'run_not_found', 'Run not found.');
    return { cancelled: s.runManager.cancel(id) };
  });

  app.post('/api/runs/:id/task-permission/revoke', async (req) => {
    const { id } = parseInput(idParams, req.params);
    if (!s.runs.get(id)) throw new HttpError(404, 'run_not_found', 'Run not found.');
    return { revoked: s.runManager.revokeTaskPermission(id) };
  });

  /** App-wide notices for every conversation (approvals waiting, finished runs, processes). */
  const noticeStreams = new Set<() => void>();
  // These streams stay open for the app's lifetime; end them so shutdown is not held up.
  app.addHook('preClose', async () => {
    for (const end of [...noticeStreams]) end();
  });
  app.get('/api/events', async (req, reply) => {
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    });
    raw.write(': connected\n\n');
    const send = (n: AppNotice) => raw.write(`event: notice\ndata: ${JSON.stringify(n)}\n\n`);
    const unsubscribers = [
      s.runManager.onNotice(send),
      s.processes.onChange((process) => send({ type: 'process_updated', process })),
      s.mcp.onChange((serverId) => send({ type: 'mcp_updated', serverId })),
    ];
    const heartbeat = setInterval(() => raw.write(': ping\n\n'), SSE_HEARTBEAT_MS);
    const end = () => {
      if (!noticeStreams.delete(end)) return;
      clearInterval(heartbeat);
      for (const u of unsubscribers) u();
      raw.end();
    };
    noticeStreams.add(end);
    req.raw.on('close', end);
  });

  app.get('/api/runs/:id/events', async (req, reply) => {
    const { id } = parseInput(idParams, req.params);
    const { after } = parseInput(
      z.object({ after: z.coerce.number().int().min(0).optional() }),
      req.query,
    );
    const lastEventId = Number(req.headers['last-event-id']);
    const afterSeq = Number.isInteger(lastEventId) && lastEventId > 0 ? lastEventId : (after ?? 0);

    const record = s.runs.get(id);
    if (!record) throw new HttpError(404, 'run_not_found', 'Run not found.');

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    });

    let closed = false;
    let heartbeat: NodeJS.Timeout | undefined;
    const subscription: { unsubscribe?: () => void } = {};
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      subscription.unsubscribe?.();
      raw.end();
    };
    const send = (e: RunEvent) => {
      if (closed) return;
      raw.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      if (e.type === 'run_finished') close();
    };
    req.raw.on('close', close);

    const sub = s.runManager.subscribe(id, afterSeq, send);
    if (!sub) {
      // Not in memory (finished earlier or before a restart): report the persisted final state.
      send({ seq: 0, type: 'run_finished', run: toRunDto(s.runs.get(id)!) });
      return;
    }
    subscription.unsubscribe = sub.unsubscribe;
    for (const e of sub.replay) send(e);
    if (sub.done) close();
    else heartbeat = setInterval(() => !closed && raw.write(': ping\n\n'), SSE_HEARTBEAT_MS);
  });

  app.get('/api/audit', async () => ({ events: s.audit.list(100) }));
}
