import { randomBytes } from 'node:crypto';
import type { McpServerDto, McpToolDto } from '@friday/shared';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  auth,
  UnauthorizedError,
  type OAuthClientProvider,
} from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import type {
  McpServerRecord,
  McpServerRepo,
  OAuthState,
  StoredTool,
} from '../repositories/mcp.js';
import type { Redactor } from '../security/redact.js';
import type { ToolSpec } from '../tools/types.js';
import { WorkspaceError } from '../workspace/paths.js';
import { mcpToolSpecs } from './tools.js';

/**
 * Connections to the user's remote MCP servers (their other apps). Friday is an MCP client: it
 * signs in with OAuth (or a static token), lists the server's tools and calls them when a run uses
 * one. Nothing here decides whether a call may happen; that is the approval policy's job.
 *
 * OAuth runs through the user's browser: the authorization URL is opened, the provider redirects
 * back to Friday's loopback callback with a single-use state, and the SDK exchanges the code (with
 * PKCE). Client registrations and tokens are stored in the local database only, never shown in the
 * UI or to the model, and access tokens are added to the redactor.
 */

export const MCP_LIMITS = {
  /** Tools kept per server. */
  maxTools: 200,
  /** Characters of a tool description passed on. */
  maxDescription: 2_000,
  connectTimeoutMs: 20_000,
  /** How long a sign-in started in Settings may take. */
  signInTtlMs: 10 * 60_000,
} as const;

export const CALLBACK_PATH = '/oauth/mcp/callback';

interface Connection {
  client: Client;
  transport: StreamableHTTPClientTransport;
}

type Status = Pick<McpServerDto, 'status' | 'error'>;

export interface McpCallResult {
  content: Array<Record<string, unknown>>;
  structuredContent?: unknown;
  isError?: boolean;
}

export class McpManager {
  private readonly connections = new Map<string, Connection>();
  private readonly statuses = new Map<string, Status>();
  /** OAuth state parameter → server, for sign-ins started from Settings. */
  private readonly pending = new Map<string, { serverId: string; expiresAt: number }>();
  private readonly listeners = new Set<(serverId: string) => void>();
  private redirectBase: string;

  constructor(
    private readonly repo: McpServerRepo,
    private readonly opts: {
      redactor: Redactor;
      /** Origin of this server as the browser reaches it, e.g. http://127.0.0.1:4317. */
      redirectBase: string;
      version: string;
      fetch?: FetchLike;
      audit?: (action: string, details: unknown) => void;
    },
  ) {
    this.redirectBase = opts.redirectBase;
    // Known tokens are redacted from anything shown to the model or stored.
    for (const s of repo.list()) {
      opts.redactor.addSecret(s.accessToken);
      opts.redactor.addSecret(s.oauth.tokens?.access_token as string | undefined);
      opts.redactor.addSecret(s.oauth.tokens?.refresh_token as string | undefined);
    }
  }

  /** The port is known only once the server listens (it can change between launches). */
  setRedirectBase(origin: string): void {
    this.redirectBase = origin;
  }

  get redirectUrl(): string {
    return `${this.redirectBase}${CALLBACK_PATH}`;
  }

  onChange(listener: (serverId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(serverId: string, status?: Status): void {
    if (status) this.statuses.set(serverId, status);
    for (const l of this.listeners) {
      try {
        l(serverId);
      } catch {
        this.listeners.delete(l);
      }
    }
  }

  toDto(s: McpServerRecord): McpServerDto {
    const policies = this.repo.policies(s.id);
    const signedIn = !!s.oauth.tokens;
    const status: Status = this.statuses.get(s.id) ?? {
      status: s.accessToken || signedIn ? 'disconnected' : 'needs_auth',
      error: null,
    };
    return {
      id: s.id,
      name: s.name,
      url: s.url,
      enabled: s.enabled,
      ...status,
      signedIn,
      hasToken: !!s.accessToken,
      tools: s.tools.map((t): McpToolDto => ({
        name: t.name,
        title: t.title ?? t.annotations?.title ?? null,
        description: t.description ?? '',
        readOnly: t.annotations?.readOnlyHint ?? null,
        destructive: t.annotations?.destructiveHint ?? null,
        policy: policies.get(t.name) ?? 'ask',
      })),
      toolsRefreshedAt: s.toolsRefreshedAt,
      createdAt: s.createdAt,
    };
  }

  list(): McpServerDto[] {
    return this.repo.list().map((s) => this.toDto(s));
  }

  get(id: string): McpServerDto | null {
    const s = this.repo.get(id);
    return s ? this.toDto(s) : null;
  }

  /** Whether the server can be used without the user signing in first. */
  usable(s: McpServerRecord): boolean {
    return s.enabled && (!!s.accessToken || !!s.oauth.tokens);
  }

  // ---------------------------------------------------------------- OAuth

  private provider(serverId: string, onRedirect: (url: URL) => void): OAuthClientProvider {
    const redirectUrl = this.redirectUrl;
    const read = (): OAuthState => this.repo.get(serverId)?.oauth ?? {};
    const write = (patch: Partial<OAuthState>) =>
      this.repo.setOAuth(serverId, { ...read(), ...patch });
    return {
      get redirectUrl() {
        return redirectUrl;
      },
      get clientMetadata() {
        return {
          client_name: 'Friday',
          redirect_uris: [redirectUrl],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        };
      },
      state: () => {
        const state = randomBytes(24).toString('base64url');
        this.pending.set(state, { serverId, expiresAt: Date.now() + MCP_LIMITS.signInTtlMs });
        return state;
      },
      // A registration made for another redirect URL (another port) is not reused.
      clientInformation: () => {
        const o = read();
        return o.redirectUrl === redirectUrl
          ? (o.clientInformation as ReturnType<OAuthClientProvider['clientInformation']>)
          : undefined;
      },
      saveClientInformation: (info) =>
        write({ clientInformation: info as Record<string, unknown>, redirectUrl }),
      tokens: () => read().tokens as ReturnType<OAuthClientProvider['tokens']>,
      saveTokens: (tokens) => {
        this.opts.redactor.addSecret(tokens.access_token);
        this.opts.redactor.addSecret(tokens.refresh_token);
        write({ tokens: tokens as unknown as Record<string, unknown> });
      },
      redirectToAuthorization: (url) => onRedirect(url),
      saveCodeVerifier: (codeVerifier) => write({ codeVerifier }),
      codeVerifier: () => {
        const v = read().codeVerifier;
        if (!v) throw new Error('No sign-in in progress for this server.');
        return v;
      },
      saveDiscoveryState: (discovery) =>
        write({ discovery: discovery as unknown as Record<string, unknown> }),
      discoveryState: () =>
        read().discovery as unknown as ReturnType<
          NonNullable<OAuthClientProvider['discoveryState']>
        >,
      invalidateCredentials: (scope) => {
        const o = read();
        if (scope === 'all') this.repo.setOAuth(serverId, {});
        else if (scope === 'tokens') write({ tokens: undefined } as Partial<OAuthState>);
        else if (scope === 'client')
          write({ clientInformation: undefined, redirectUrl: undefined } as Partial<OAuthState>);
        else if (scope === 'verifier') write({ codeVerifier: undefined } as Partial<OAuthState>);
        else if (scope === 'discovery')
          this.repo.setOAuth(serverId, { ...o, discovery: undefined });
      },
    };
  }

  /**
   * Finish a sign-in: the browser came back to the callback with a code and our state. Returns
   * the server's name for the confirmation page.
   */
  async finishSignIn(state: string, code: string): Promise<string> {
    const p = this.pending.get(state);
    this.pending.delete(state);
    if (!p || p.expiresAt < Date.now())
      throw new WorkspaceError('not_found', 'This sign-in link expired. Start again in Settings.');
    const server = this.repo.get(p.serverId);
    if (!server) throw new WorkspaceError('not_found', 'The server was removed.');
    await auth(
      this.provider(server.id, () => {
        throw new UnauthorizedError('The server asked to sign in again.');
      }),
      {
        serverUrl: server.url,
        authorizationCode: code,
        ...(this.opts.fetch ? { fetchFn: this.opts.fetch } : {}),
      },
    );
    this.opts.audit?.('mcp_signed_in', { server: server.name });
    await this.connect(server.id);
    return server.name;
  }

  /** Forget the OAuth tokens (and registration) for a server. */
  async signOut(id: string): Promise<void> {
    await this.disconnect(id);
    this.repo.setOAuth(id, {});
    this.statuses.delete(id);
    this.changed(id);
  }

  // ---------------------------------------------------------------- connections

  /**
   * Connect (and list tools). If the server needs a sign-in, returns the URL to open in the
   * browser; the connection completes in finishSignIn.
   */
  async connect(id: string): Promise<{ authorizeUrl: string | null }> {
    await this.disconnect(id);
    const server = this.repo.get(id);
    if (!server) throw new WorkspaceError('not_found', 'MCP server not found.');
    let authorizeUrl: string | null = null;
    const transport = new StreamableHTTPClientTransport(new URL(server.url), {
      ...(server.accessToken
        ? { requestInit: { headers: { Authorization: `Bearer ${server.accessToken}` } } }
        : {
            authProvider: this.provider(id, (url) => {
              authorizeUrl = url.toString();
            }),
          }),
      ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}),
    });
    const client = new Client({ name: 'Friday', version: this.opts.version }, { capabilities: {} });
    try {
      await client.connect(transport, { timeout: MCP_LIMITS.connectTimeoutMs });
      this.connections.set(id, { client, transport });
      await this.refreshTools(id);
      this.changed(id, { status: 'connected', error: null });
      return { authorizeUrl: null };
    } catch (err) {
      await transport.close().catch(() => undefined);
      if (authorizeUrl || err instanceof UnauthorizedError) {
        this.changed(id, { status: 'needs_auth', error: null });
        return { authorizeUrl };
      }
      this.changed(id, { status: 'error', error: this.describe(err) });
      return { authorizeUrl: null };
    }
  }

  private async disconnect(id: string): Promise<void> {
    const c = this.connections.get(id);
    this.connections.delete(id);
    if (c) await c.client.close().catch(() => undefined);
  }

  private describe(err: unknown): string {
    const message = err instanceof Error ? err.message : String(err);
    return this.opts.redactor.redact(message).slice(0, 500);
  }

  /** Re-list the server's tools (all pages) and store them. */
  async refreshTools(id: string): Promise<void> {
    const c = this.connections.get(id);
    if (!c) throw new WorkspaceError('unsupported', 'Not connected.');
    const tools: StoredTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await c.client.listTools(cursor ? { cursor } : undefined, {
        timeout: MCP_LIMITS.connectTimeoutMs,
      });
      for (const t of page.tools) {
        if (tools.length >= MCP_LIMITS.maxTools) break;
        tools.push({
          name: t.name,
          title: t.title,
          description: (t.description ?? '').slice(0, MCP_LIMITS.maxDescription),
          inputSchema: t.inputSchema as Record<string, unknown>,
          annotations: t.annotations,
        });
      }
      cursor = page.nextCursor;
    } while (cursor && tools.length < MCP_LIMITS.maxTools);
    this.repo.setTools(id, tools);
    this.changed(id);
  }

  async callTool(
    id: string,
    tool: string,
    args: Record<string, unknown>,
    opts: { signal: AbortSignal; timeoutMs: number },
  ): Promise<McpCallResult> {
    let c = this.connections.get(id);
    if (!c) {
      await this.connect(id);
      c = this.connections.get(id);
    }
    const server = this.repo.get(id);
    if (!c) {
      const st = this.statuses.get(id);
      throw new WorkspaceError(
        'unsupported',
        st?.status === 'needs_auth'
          ? `"${server?.name}" needs the user to sign in again (Settings › Connected apps).`
          : `Could not connect to "${server?.name}": ${st?.error ?? 'unknown error'}.`,
      );
    }
    try {
      // Never retried: a tool call may have side effects in the user's app.
      return (await c.client.callTool({ name: tool, arguments: args }, undefined, {
        signal: opts.signal,
        timeout: opts.timeoutMs,
      })) as McpCallResult;
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        await this.disconnect(id);
        this.changed(id, { status: 'needs_auth', error: null });
        throw new WorkspaceError(
          'unsupported',
          `"${server?.name}" needs the user to sign in again (Settings › Connected apps).`,
        );
      }
      if (opts.signal.aborted) throw err;
      // The session may be gone (server restarted): reconnect on the next call.
      await this.disconnect(id);
      this.changed(id, { status: 'error', error: this.describe(err) });
      throw new WorkspaceError(
        'unsupported',
        `${server?.name} › ${tool} failed: ${this.describe(err)}`,
      );
    }
  }

  /** Tool specs for this run: every usable server's tools that are not turned off. */
  toolSpecs(): Array<ToolSpec<never>> {
    const taken = new Set<string>();
    return this.repo
      .list()
      .filter((s) => this.usable(s))
      .flatMap((s) => mcpToolSpecs(s, this.repo.policies(s.id), this, taken)) as unknown as Array<
      ToolSpec<never>
    >;
  }

  async remove(id: string): Promise<void> {
    await this.disconnect(id);
    this.statuses.delete(id);
    for (const [state, p] of this.pending) if (p.serverId === id) this.pending.delete(state);
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.connections.keys()].map((id) => this.disconnect(id)));
  }
}
