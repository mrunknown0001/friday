import type { McpServerDto, McpToolPolicy } from '@friday/shared';
import { ChevronRight, Loader2, Plug, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { cn } from '../lib/cn';
import { Badge, type Tone } from './ui/badge';
import { Button } from './ui/button';

/** Fired by App when the server reports a change (e.g. a browser sign-in finished). */
export const MCP_UPDATED_EVENT = 'friday:mcp-updated';

const input =
  'w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm outline-none focus:border-sky-500';
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

const STATUS: Record<McpServerDto['status'], { label: string; tone: Tone }> = {
  connected: { label: 'connected', tone: 'success' },
  needs_auth: { label: 'sign-in needed', tone: 'warning' },
  error: { label: 'error', tone: 'danger' },
  disconnected: { label: 'not connected yet', tone: 'neutral' },
};

const POLICY_LABEL: Record<McpToolPolicy, string> = {
  ask: 'Ask every time',
  allow: 'Allow without asking',
  off: 'Off',
};

/** Open the app's sign-in page (the desktop app hands it to the system browser). */
function openSignIn(url: string) {
  window.open(url, '_blank', 'noopener,noreferrer');
}

function ServerRow({ server, onChanged }: { server: McpServerDto; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const status = STATUS[server.status];

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
    }
  };
  const connect = () =>
    act('connect', async () => {
      const r = await api.connectMcpServer(server.id);
      if (r.authorizeUrl) openSignIn(r.authorizeUrl);
    });

  return (
    <li className="rounded-md border border-zinc-800 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Plug className="h-4 w-4 text-sky-400" aria-hidden />
        <span className="font-medium text-zinc-100">{server.name}</span>
        <span className="min-w-0 truncate font-mono text-xs text-zinc-400" title={server.url}>
          {server.url}
        </span>
        <Badge tone={status.tone}>{status.label}</Badge>
        {!server.enabled && <Badge>disabled</Badge>}
      </div>
      {server.error && <p className="mt-1 text-xs text-red-400">{server.error}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => void connect()} disabled={busy !== null}>
          {busy === 'connect' && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
          {server.status === 'needs_auth' ? 'Sign in' : 'Reconnect'}
        </Button>
        {server.signedIn && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void act('signout', () => api.signOutMcpServer(server.id))}
            disabled={busy !== null}
          >
            Sign out
          </Button>
        )}
        <label className="flex items-center gap-1.5 text-xs text-zinc-300">
          <input
            type="checkbox"
            className="accent-sky-500"
            checked={server.enabled}
            onChange={(e) =>
              void act('enable', () => api.setMcpServerEnabled(server.id, e.target.checked))
            }
          />
          Friday may use this app
        </label>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          onClick={() => {
            if (window.confirm(`Remove “${server.name}”? Friday forgets its sign-in and settings.`))
              void act('remove', () => api.removeMcpServer(server.id));
          }}
          disabled={busy !== null}
          aria-label={`Remove ${server.name}`}
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-red-400">
          {error}
        </p>
      )}
      {server.tools.length > 0 && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="flex items-center gap-1 text-xs text-zinc-300 hover:text-zinc-100"
          >
            <ChevronRight className={cn('h-3 w-3 transition-transform', open && 'rotate-90')} />
            {server.tools.length} tools · {server.tools.filter((t) => t.policy === 'allow').length}{' '}
            allowed without asking · {server.tools.filter((t) => t.policy === 'off').length} off
          </button>
          {open && (
            <ul className="mt-2 space-y-2">
              {server.tools.map((t) => (
                <li key={t.name} className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 text-xs">
                  <div className="min-w-0">
                    <span className="font-mono text-zinc-200">{t.name}</span>
                    {t.title && <span className="ml-2 text-zinc-400">{t.title}</span>}
                    {t.readOnly && (
                      <Badge tone="success" className="ml-2">
                        read-only
                      </Badge>
                    )}
                    {t.destructive && (
                      <Badge tone="danger" className="ml-2">
                        destructive
                      </Badge>
                    )}
                    {t.description && (
                      <p className="line-clamp-2 text-zinc-400" title={t.description}>
                        {t.description}
                      </p>
                    )}
                  </div>
                  <select
                    aria-label={`How Friday may use ${t.name}`}
                    value={t.policy}
                    onChange={(e) =>
                      void act('policy', () =>
                        api.setMcpToolPolicy(server.id, t.name, e.target.value as McpToolPolicy),
                      )
                    }
                    className="h-7 rounded-md border border-zinc-700 bg-zinc-950 px-1.5 text-xs"
                  >
                    {(Object.keys(POLICY_LABEL) as McpToolPolicy[]).map((p) => (
                      <option key={p} value={p}>
                        {POLICY_LABEL[p]}
                      </option>
                    ))}
                  </select>
                </li>
              ))}
            </ul>
          )}
          {server.tools.some((t) => t.policy === 'allow' && !t.readOnly) && (
            <p className="mt-2 text-xs text-amber-300">
              Some tools that may change data run without asking. The app’s own hints are not
              guarantees.
            </p>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * Connected apps (MCP servers): add an app by URL, sign in through the browser, and choose how
 * each of its tools may be used.
 */
export function McpSettings() {
  const [servers, setServers] = useState<McpServerDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', url: '', accessToken: '' });
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    () =>
      api
        .mcpServers()
        .then((r) => setServers(r.servers))
        .catch((e: unknown) => setError(message(e))),
    [],
  );
  useEffect(() => {
    void load();
    const onUpdate = () => void load();
    window.addEventListener(MCP_UPDATED_EVENT, onUpdate);
    return () => window.removeEventListener(MCP_UPDATED_EVENT, onUpdate);
  }, [load]);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.addMcpServer({
        name: form.name.trim(),
        url: form.url.trim(),
        ...(form.accessToken.trim() ? { accessToken: form.accessToken.trim() } : {}),
      });
      if (r.authorizeUrl) openSignIn(r.authorizeUrl);
      setForm({ name: '', url: '', accessToken: '' });
      setAdding(false);
      await load();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="border-b border-zinc-800 py-4 last:border-0">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-zinc-200">Connected apps (MCP)</h3>
        {!adding && (
          <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>
            <Plus className="h-3.5 w-3.5" aria-hidden /> Add app
          </Button>
        )}
      </div>
      <p className="mb-3 text-xs text-zinc-400">
        Let Friday use your other apps through their MCP server, like Claude does. You sign in to
        each app in your browser; Friday keeps the sign-in on this machine. Every tool asks before
        it runs unless you allow it below, and what apps return is treated as data, not
        instructions.
      </p>
      {adding && (
        <form
          onSubmit={(e) => void add(e)}
          className="mb-3 space-y-2 rounded-md border border-zinc-800 p-3"
        >
          <div className="grid gap-2 sm:grid-cols-[10rem_1fr]">
            <label className="text-xs text-zinc-300">
              App name
              <input
                className={`${input} mt-1 font-mono`}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value.toLowerCase() })}
                placeholder="notes"
                required
                maxLength={24}
                pattern="[a-z0-9][a-z0-9_\-]*"
              />
            </label>
            <label className="text-xs text-zinc-300">
              MCP server URL
              <input
                className={`${input} mt-1 font-mono`}
                type="url"
                value={form.url}
                onChange={(e) => setForm({ ...form, url: e.target.value })}
                placeholder="https://app.example.com/mcp"
                required
              />
            </label>
          </div>
          <label className="block text-xs text-zinc-300">
            Access token (optional: only if the app gave you one; most apps use sign-in)
            <input
              className={`${input} mt-1 font-mono`}
              type="password"
              autoComplete="off"
              value={form.accessToken}
              onChange={(e) => setForm({ ...form, accessToken: e.target.value })}
            />
          </label>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)} disabled={busy}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" type="submit" disabled={busy}>
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />} Add and sign in
            </Button>
          </div>
        </form>
      )}
      {error && (
        <p role="alert" className="mb-2 text-xs text-red-400">
          {error}
        </p>
      )}
      {servers === null ? (
        <p className="text-xs text-zinc-400">Loading…</p>
      ) : servers.length === 0 ? (
        <p className="text-xs text-zinc-400">No apps connected.</p>
      ) : (
        <ul className="space-y-2">
          {servers.map((s) => (
            <ServerRow key={s.id} server={s} onChanged={() => void load()} />
          ))}
        </ul>
      )}
    </section>
  );
}
