import type { McpServerDto } from '@friday/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CALLBACK_PATH } from '../../mcp/manager.js';
import type { Services } from '../../services.js';
import { WorkspaceError } from '../../workspace/paths.js';
import { HttpError } from '../errors.js';
import { parseInput } from '../validation.js';

const idParams = z.object({ id: z.uuid() });

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Remote servers must use HTTPS; plain HTTP only on this machine (local development). */
const serverUrl = z
  .string()
  .trim()
  .max(2_000)
  .refine(
    (raw) => {
      try {
        const u = new URL(raw);
        if (u.username || u.password) return false;
        return u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(u.hostname));
      } catch {
        return false;
      }
    },
    {
      message: 'Use an https:// URL (http:// only for localhost), without a user name or password.',
    },
  );

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font:16px system-ui,sans-serif;background:#09090b;color:#e4e4e7;display:grid;place-items:center;height:100vh;margin:0}
main{max-width:30rem;padding:2rem;border:1px solid #27272a;border-radius:12px;background:#18181b}h1{font-size:1.2rem}</style>
</head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></main></body></html>`;
}

/**
 * Connected apps (MCP servers). Adding, signing in, and choosing how each tool may be used are
 * user actions in Settings; the model can only call tools the user left enabled.
 */
export function registerMcpRoutes(app: FastifyInstance, s: Services) {
  const requireServer = (id: string) => {
    const server = s.mcpServers.get(id);
    if (!server) throw new HttpError(404, 'mcp_server_not_found', 'Connected app not found.');
    return server;
  };
  const dto = (id: string): McpServerDto => s.mcp.get(id)!;

  app.addHook('onClose', async () => {
    await s.mcp.shutdown();
  });

  app.get('/api/mcp/servers', async () => ({ servers: s.mcp.list() }));

  app.post('/api/mcp/servers', async (req, reply) => {
    const body = parseInput(
      z.object({
        name: z
          .string()
          .trim()
          .regex(
            /^[a-z0-9][a-z0-9_-]{0,23}$/,
            'Use 1-24 lowercase letters, digits, "-" or "_" (it prefixes the tool names Friday sees).',
          ),
        url: serverUrl,
        accessToken: z.string().trim().min(8).max(4_000).optional(),
      }),
      req.body,
    );
    if (s.mcpServers.byName(body.name))
      throw new HttpError(409, 'mcp_name_taken', `A connected app named "${body.name}" exists.`);
    const server = s.mcpServers.create({
      name: body.name,
      url: body.url,
      accessToken: body.accessToken ?? null,
    });
    s.redactor.addSecret(body.accessToken);
    s.audit.record({
      actor: 'user',
      action: 'mcp_server_added',
      details: { name: server.name, url: server.url, auth: body.accessToken ? 'token' : 'oauth' },
    });
    const { authorizeUrl } = await s.mcp.connect(server.id);
    reply.code(201);
    return { server: dto(server.id), authorizeUrl };
  });

  /** Connect (again). Returns a sign-in URL to open in the browser when the app needs one. */
  app.post('/api/mcp/servers/:id/connect', async (req) => {
    const { id } = parseInput(idParams, req.params);
    requireServer(id);
    const { authorizeUrl } = await s.mcp.connect(id);
    return { server: dto(id), authorizeUrl };
  });

  app.post('/api/mcp/servers/:id/sign-out', async (req) => {
    const { id } = parseInput(idParams, req.params);
    const server = requireServer(id);
    await s.mcp.signOut(id);
    s.audit.record({ actor: 'user', action: 'mcp_signed_out', details: { name: server.name } });
    return dto(id);
  });

  app.patch('/api/mcp/servers/:id', async (req) => {
    const { id } = parseInput(idParams, req.params);
    const body = parseInput(z.object({ enabled: z.boolean() }), req.body);
    const server = requireServer(id);
    s.mcpServers.setEnabled(id, body.enabled);
    s.audit.record({
      actor: 'user',
      action: body.enabled ? 'mcp_server_enabled' : 'mcp_server_disabled',
      details: { name: server.name },
    });
    return dto(id);
  });

  app.put('/api/mcp/servers/:id/tools/:tool', async (req) => {
    const { id, tool } = parseInput(
      z.object({ id: z.uuid(), tool: z.string().min(1).max(200) }),
      req.params,
    );
    const { policy } = parseInput(z.object({ policy: z.enum(['ask', 'allow', 'off']) }), req.body);
    const server = requireServer(id);
    if (!server.tools.some((t) => t.name === tool))
      throw new HttpError(404, 'mcp_tool_not_found', `"${server.name}" has no tool "${tool}".`);
    s.mcpServers.setPolicy(id, tool, policy);
    s.audit.record({
      actor: 'user',
      action: 'mcp_tool_policy_changed',
      details: { server: server.name, tool, policy },
    });
    return dto(id);
  });

  app.delete('/api/mcp/servers/:id', async (req, reply) => {
    const { id } = parseInput(idParams, req.params);
    const server = requireServer(id);
    await s.mcp.remove(id);
    s.mcpServers.remove(id);
    s.audit.record({ actor: 'user', action: 'mcp_server_removed', details: { name: server.name } });
    reply.code(204);
  });

  /**
   * Where the app's sign-in page sends the browser back. Reached by a top-level navigation from
   * another site (and, in the desktop app, from the system browser without the launch token), so
   * the local-only guard lets this one path through; it does nothing without a pending sign-in's
   * single-use state, and shows only a fixed page.
   */
  app.get(CALLBACK_PATH, async (req, reply) => {
    const q = parseInput(
      z.object({
        code: z.string().max(4_000).optional(),
        state: z.string().max(200).optional(),
        error: z.string().max(200).optional(),
      }),
      req.query,
    );
    reply.type('text/html; charset=utf-8');
    if (q.error || !q.code || !q.state) {
      return page(
        'Sign-in was not completed',
        q.error === 'access_denied'
          ? 'Access was denied. You can close this tab and try again from Friday’s Settings.'
          : 'The app did not return a sign-in code. Close this tab and try again from Friday’s Settings.',
      );
    }
    try {
      const name = await s.mcp.finishSignIn(q.state, q.code);
      return page('Connected', `Friday is now signed in to “${name}”. You can close this tab.`);
    } catch (err) {
      reply.code(400);
      return page(
        'Sign-in failed',
        err instanceof WorkspaceError
          ? err.message
          : 'The app did not accept the sign-in. Close this tab and try again from Friday’s Settings.',
      );
    }
  });
}
