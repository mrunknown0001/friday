import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { HttpError } from './errors.js';

/** Header the web client sends on every mutating request. Browsers cannot attach it cross-origin
 * without a CORS preflight, which this server never approves. */
export const CLIENT_HEADER = 'x-friday-client';
/** Per-launch secret the desktop shell adds to every request; the renderer never sees it. */
export const TOKEN_HEADER = 'x-friday-token';

/** Must match mcp/manager.ts CALLBACK_PATH (kept here so the guard has no app imports). */
export const OAUTH_CALLBACK_PATH = '/oauth/mcp/callback';

const digest = (s: string) => createHash('sha256').update(s).digest();

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function hostnameOf(hostHeader: string): string {
  // Host may be "name:port" or "[v6]:port".
  if (hostHeader.startsWith('[')) return hostHeader.slice(0, hostHeader.indexOf(']') + 1);
  return hostHeader.split(':')[0]!.toLowerCase();
}

/**
 * The API controls a local agent, so it must only be reachable by the Friday UI on this machine:
 * - Host header must be a loopback name (blocks DNS-rebinding attacks from web pages).
 * - Origin, when present, must be the app itself or the configured dev server.
 * - Cross-site fetch metadata is rejected.
 * - Mutating requests must carry the custom client header (blocks CSRF via simple requests).
 * - In the desktop app, every request must carry the launch token, so other local programs and
 *   users cannot drive the agent even though they can reach the loopback port.
 */
export function registerLocalOnlyGuards(
  app: FastifyInstance,
  opts: { port: number; devOrigins: string[]; launchToken?: string | null },
) {
  const expectedToken = opts.launchToken ? digest(opts.launchToken) : null;
  const originsFor = (port: number) =>
    new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...opts.devOrigins]);
  let allowedOrigins = originsFor(opts.port);
  // With port 0 the OS picks the port, so the app's own origin is known only once listening.
  app.addHook('onListen', async () => {
    const address = app.server.address();
    if (address && typeof address === 'object') allowedOrigins = originsFor(address.port);
  });

  app.addHook('onRequest', async (req, reply) => {
    // The browser returning from a connected app's sign-in page: a cross-site navigation without
    // the launch token. Only the loopback host check applies; the route needs a single-use state.
    const oauthReturn = req.method === 'GET' && req.url.split('?')[0] === OAUTH_CALLBACK_PATH;
    if (expectedToken && !oauthReturn) {
      const token = req.headers[TOKEN_HEADER];
      // Compare fixed-length digests so the check takes the same time for any input.
      if (typeof token !== 'string' || !timingSafeEqual(digest(token), expectedToken)) {
        throw new HttpError(
          401,
          'invalid_launch_token',
          'This server only accepts the Friday app.',
        );
      }
    }
    const host = req.headers.host;
    if (!host || !LOCAL_HOSTNAMES.has(hostnameOf(host))) {
      throw new HttpError(403, 'forbidden_host', 'Requests must target a loopback host.');
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigins.has(origin)) {
      throw new HttpError(403, 'forbidden_origin', 'Cross-origin requests are not allowed.');
    }
    if (req.headers['sec-fetch-site'] === 'cross-site' && !oauthReturn) {
      throw new HttpError(403, 'forbidden_origin', 'Cross-site requests are not allowed.');
    }
    if (
      req.url.startsWith('/api/') &&
      !SAFE_METHODS.has(req.method) &&
      req.headers[CLIENT_HEADER] !== '1'
    ) {
      throw new HttpError(
        403,
        'missing_client_header',
        `Mutating requests require the ${CLIENT_HEADER} header.`,
      );
    }

    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
        "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'; " +
        // The live preview frames dev servers on this machine, and nothing else.
        'frame-src http://localhost:* http://127.0.0.1:* http://[::1]:* https://localhost:* https://127.0.0.1:*',
    );
  });
}
