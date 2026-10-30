import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

/** The bearer token the fake app issues; tests check it never leaks. */
export const FAKE_TOKEN_PREFIX = 'notes-access-';

/**
 * A small remote MCP server ("a notes app") with its own OAuth authorization server, as a real
 * app would have: protected-resource and authorization-server metadata, dynamic client
 * registration, an authorize endpoint that approves at once, and a PKCE-checked token endpoint.
 */
export async function startFakeApp(opts: { requireAuth?: boolean; staticToken?: string } = {}) {
  const requireAuth = opts.requireAuth ?? true;
  const codes = new Map<string, { challenge: string; redirectUri: string }>();
  const issued = new Set<string>(opts.staticToken ? [opts.staticToken] : []);
  const notes: string[] = [];
  const calls: Array<{ tool: string; args: unknown }> = [];
  let base = '';

  const mcpServer = () => {
    const server = new McpServer({ name: 'notes', version: '1.0.0' });
    server.registerTool(
      'search_notes',
      {
        title: 'Search notes',
        description: 'Find notes containing a word.',
        inputSchema: { query: z.string() },
        annotations: { readOnlyHint: true },
      },
      async ({ query }) => {
        calls.push({ tool: 'search_notes', args: { query } });
        const found = notes.filter((n) => n.includes(query));
        return { content: [{ type: 'text', text: found.length ? found.join('\n') : 'no notes' }] };
      },
    );
    server.registerTool(
      'create_note',
      {
        description: 'Create a note.',
        inputSchema: { text: z.string() },
      },
      async ({ text }) => {
        calls.push({ tool: 'create_note', args: { text } });
        notes.push(text);
        return { content: [{ type: 'text', text: `created note #${notes.length}` }] };
      },
    );
    server.registerTool(
      'delete_all',
      {
        description: 'Delete every note.',
        annotations: { destructiveHint: true },
      },
      async () => {
        calls.push({ tool: 'delete_all', args: {} });
        notes.length = 0;
        return { content: [{ type: 'text', text: 'deleted' }] };
      },
    );
    server.registerTool(
      'whoami',
      { description: 'Show the session (echoes the access token: a badly written tool).' },
      async () => ({
        content: [{ type: 'text', text: `token=${[...issued].at(-1)}` }],
      }),
    );
    server.registerTool('broken', { description: 'Always fails.' }, async () => ({
      isError: true,
      content: [{ type: 'text', text: 'database is down' }],
    }));
    return server;
  };

  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const readBody = (req: http.IncomingMessage) =>
    new Promise<string>((resolve) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => resolve(b));
    });

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url!, base);
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource'))
      return json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base] });
    if (url.pathname === '/.well-known/oauth-authorization-server')
      return json(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
    if (url.pathname === '/register' && req.method === 'POST') {
      const meta = JSON.parse(await readBody(req)) as Record<string, unknown>;
      return json(res, 201, { ...meta, client_id: `client-${randomBytes(4).toString('hex')}` });
    }
    if (url.pathname === '/authorize') {
      // A real app would show its login and consent page here; this one approves at once.
      const code = randomBytes(8).toString('hex');
      codes.set(code, {
        challenge: url.searchParams.get('code_challenge')!,
        redirectUri: url.searchParams.get('redirect_uri')!,
      });
      const back = new URL(url.searchParams.get('redirect_uri')!);
      back.searchParams.set('code', code);
      back.searchParams.set('state', url.searchParams.get('state')!);
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      const form = new URLSearchParams(await readBody(req));
      if (form.get('grant_type') === 'authorization_code') {
        const entry = codes.get(form.get('code') ?? '');
        codes.delete(form.get('code') ?? '');
        const verifier = form.get('code_verifier') ?? '';
        const challenge = createHash('sha256').update(verifier).digest('base64url');
        if (
          !entry ||
          entry.challenge !== challenge ||
          entry.redirectUri !== form.get('redirect_uri')
        )
          return json(res, 400, { error: 'invalid_grant' });
      }
      const token = `${FAKE_TOKEN_PREFIX}${randomBytes(12).toString('hex')}`;
      issued.add(token);
      return json(res, 200, {
        access_token: token,
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: `notes-refresh-${randomBytes(12).toString('hex')}`,
      });
    }
    if (url.pathname === '/mcp') {
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
      if (requireAuth && (!bearer || !issued.has(bearer))) {
        res.writeHead(401, {
          'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
        });
        return res.end();
      }
      const body = req.method === 'POST' ? JSON.parse((await readBody(req)) || 'null') : undefined;
      // Stateless: a fresh server and transport per request.
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      const server = mcpServer();
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      return transport.handleRequest(req, res, body);
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`;
  return {
    url: `${base}/mcp`,
    base,
    notes,
    calls,
    issued,
    close: () => new Promise<void>((r) => httpServer.close(() => r())),
  };
}
