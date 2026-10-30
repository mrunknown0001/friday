import { randomUUID } from 'node:crypto';
import type { McpToolPolicy } from '@friday/shared';
import type { Db } from '../db/database.js';

/** A tool as the server listed it (inputSchema is sent to the model as the tool's parameters). */
export interface StoredTool {
  name: string;
  title?: string | undefined;
  description?: string | undefined;
  inputSchema: Record<string, unknown>;
  annotations?:
    | {
        title?: string | undefined;
        readOnlyHint?: boolean | undefined;
        destructiveHint?: boolean | undefined;
        openWorldHint?: boolean | undefined;
      }
    | undefined;
}

/** OAuth state for one server, as the SDK's client provider needs it. Secret. */
export interface OAuthState {
  /** Redirect URL the client was registered with (the port can change between launches). */
  redirectUrl?: string;
  clientInformation?: Record<string, unknown>;
  tokens?: Record<string, unknown>;
  codeVerifier?: string;
  discovery?: Record<string, unknown>;
}

export interface McpServerRecord {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  accessToken: string | null;
  oauth: OAuthState;
  tools: StoredTool[];
  toolsRefreshedAt: string | null;
  createdAt: string;
}

interface Row {
  id: string;
  name: string;
  url: string;
  enabled: number;
  access_token: string | null;
  oauth: string | null;
  tools: string | null;
  tools_refreshed_at: string | null;
  created_at: string;
}

function parse<T>(json: string | null, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

const toRecord = (r: Row): McpServerRecord => ({
  id: r.id,
  name: r.name,
  url: r.url,
  enabled: r.enabled === 1,
  accessToken: r.access_token,
  oauth: parse<OAuthState>(r.oauth, {}),
  tools: parse<StoredTool[]>(r.tools, []),
  toolsRefreshedAt: r.tools_refreshed_at,
  createdAt: r.created_at,
});

export class McpServerRepo {
  constructor(private readonly db: Db) {}

  list(): McpServerRecord[] {
    return (this.db.prepare('SELECT * FROM mcp_servers ORDER BY name').all() as Row[]).map(
      toRecord,
    );
  }

  get(id: string): McpServerRecord | null {
    const row = this.db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as
      Row | undefined;
    return row ? toRecord(row) : null;
  }

  byName(name: string): McpServerRecord | null {
    const row = this.db.prepare('SELECT * FROM mcp_servers WHERE name = ?').get(name) as
      Row | undefined;
    return row ? toRecord(row) : null;
  }

  create(input: { name: string; url: string; accessToken: string | null }): McpServerRecord {
    const id = randomUUID();
    this.db
      .prepare(
        'INSERT INTO mcp_servers (id, name, url, enabled, access_token, created_at) VALUES (?, ?, ?, 1, ?, ?)',
      )
      .run(id, input.name, input.url, input.accessToken, new Date().toISOString());
    return this.get(id)!;
  }

  setEnabled(id: string, enabled: boolean): void {
    this.db.prepare('UPDATE mcp_servers SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  }

  setOAuth(id: string, oauth: OAuthState): void {
    this.db.prepare('UPDATE mcp_servers SET oauth = ? WHERE id = ?').run(JSON.stringify(oauth), id);
  }

  setTools(id: string, tools: StoredTool[]): void {
    this.db
      .prepare('UPDATE mcp_servers SET tools = ?, tools_refreshed_at = ? WHERE id = ?')
      .run(JSON.stringify(tools), new Date().toISOString(), id);
  }

  remove(id: string): boolean {
    return this.db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id).changes > 0;
  }

  /** Per-tool policy; tools without an entry ask every time. */
  policies(id: string): Map<string, McpToolPolicy> {
    const rows = this.db
      .prepare('SELECT tool, policy FROM mcp_tool_policies WHERE server_id = ?')
      .all(id) as Array<{ tool: string; policy: McpToolPolicy }>;
    return new Map(rows.map((r) => [r.tool, r.policy]));
  }

  setPolicy(id: string, tool: string, policy: McpToolPolicy): void {
    if (policy === 'ask') {
      this.db
        .prepare('DELETE FROM mcp_tool_policies WHERE server_id = ? AND tool = ?')
        .run(id, tool);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO mcp_tool_policies (server_id, tool, policy) VALUES (?, ?, ?)
         ON CONFLICT(server_id, tool) DO UPDATE SET policy = excluded.policy`,
      )
      .run(id, tool, policy);
  }
}
