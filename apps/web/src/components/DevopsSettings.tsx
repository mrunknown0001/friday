import type { HostEnvironment, LogSourceDto, SshHostDto } from '@friday/shared';
import { Loader2, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api } from '../lib/api';
import { Badge, type Tone } from './ui/badge';
import { Button } from './ui/button';

const ENV_TONE: Record<HostEnvironment, Tone> = {
  development: 'neutral',
  staging: 'warning',
  production: 'danger',
};
const input =
  'w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm outline-none focus:border-sky-500';
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-b border-zinc-800 py-4 last:border-0">
      <h3 className="mb-2 text-sm font-semibold text-zinc-200">{title}</h3>
      {children}
    </section>
  );
}

function HostRow({ host, onChanged }: { host: SshHostDto; onChanged: () => void }) {
  const [scanned, setScanned] = useState<string[] | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setStatus(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="rounded-md border border-zinc-800 p-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm text-zinc-100">{host.name}</span>
        <span className="font-mono text-zinc-400">
          {host.username}@{host.hostname}:{host.port}
        </span>
        <Badge tone={ENV_TONE[host.environment]}>{host.environment}</Badge>
        {host.trustedFingerprints.length ? (
          <Badge tone="success">
            <ShieldCheck className="h-3 w-3" /> key trusted
          </Badge>
        ) : (
          <Badge tone="warning">host key not trusted</Badge>
        )}
        <div className="ml-auto flex gap-1">
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void act(async () =>
                setScanned((await api.scanSshHost(host.id)).keys.map((k) => k.fingerprint)),
              )
            }
          >
            Scan host key
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || !host.trustedFingerprints.length}
            onClick={() =>
              void act(async () => {
                const r = await api.testSshHost(host.id);
                setStatus(r.ok ? r.message : `${r.message}${r.detail ? ` ${r.detail}` : ''}`);
              })
            }
          >
            Test
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label={`Remove host ${host.name}`}
            disabled={busy}
            onClick={() => {
              if (window.confirm(`Remove SSH host "${host.name}"?`))
                void act(async () => {
                  await api.removeSshHost(host.id);
                  onChanged();
                });
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      <p className="mt-1 text-zinc-500">Key: {host.identityFile ?? 'ssh-agent'}</p>
      {host.trustedFingerprints.map((f) => (
        <p key={f} className="font-mono text-[11px] text-emerald-400/80">
          trusted: {f}
        </p>
      ))}
      {scanned && (
        <div className="mt-2 rounded border border-amber-900/60 bg-amber-950/20 p-2">
          <p className="mb-1 text-amber-200">
            Compare these with the server's own fingerprints (on the server:{' '}
            <code>ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code>) before trusting. A
            mismatch can mean someone is intercepting the connection.
          </p>
          {scanned.map((f) => (
            <div key={f} className="flex items-center gap-2">
              <code className="font-mono text-zinc-200">{f}</code>
              <Button
                size="sm"
                disabled={busy || host.trustedFingerprints.includes(f)}
                onClick={() =>
                  void act(async () => {
                    await api.trustSshHost(host.id, f);
                    setScanned(null);
                    onChanged();
                  })
                }
              >
                {host.trustedFingerprints.includes(f) ? 'Trusted' : 'I verified it: trust'}
              </Button>
            </div>
          ))}
        </div>
      )}
      {status && (
        <p role="status" className="mt-1 text-zinc-300">
          {status}
        </p>
      )}
    </li>
  );
}

function AddHostForm({ onAdded }: { onAdded: () => void }) {
  const [form, setForm] = useState({
    name: '',
    hostname: '',
    port: '22',
    username: '',
    identityFile: '',
    environment: 'staging' as HostEnvironment,
  });
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm({ ...form, [k]: e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api.addSshHost({
        name: form.name.trim(),
        hostname: form.hostname.trim(),
        port: Number(form.port) || 22,
        username: form.username.trim(),
        identityFile: form.identityFile.trim() || null,
        environment: form.environment,
      });
      setForm({ ...form, name: '', hostname: '', identityFile: '' });
      onAdded();
    } catch (err) {
      setError(message(err));
    }
  };
  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="mt-2 grid grid-cols-2 gap-2 text-xs"
      aria-label="Add SSH host"
    >
      <label>
        Name
        <input
          className={input}
          value={form.name}
          onChange={set('name')}
          placeholder="web-prod"
          required
        />
      </label>
      <label>
        Hostname / IP
        <input
          className={input}
          value={form.hostname}
          onChange={set('hostname')}
          placeholder="203.0.113.10"
          required
        />
      </label>
      <label>
        User
        <input
          className={input}
          value={form.username}
          onChange={set('username')}
          placeholder="deploy"
          required
        />
      </label>
      <label>
        Port
        <input className={input} value={form.port} onChange={set('port')} inputMode="numeric" />
      </label>
      <label className="col-span-2">
        Private key file path (optional; leave empty to use ssh-agent)
        <input
          className={`${input} font-mono`}
          value={form.identityFile}
          onChange={set('identityFile')}
          placeholder="/home/you/.ssh/id_ed25519"
        />
      </label>
      <label>
        Environment
        <select className={input} value={form.environment} onChange={set('environment')}>
          <option value="development">development</option>
          <option value="staging">staging</option>
          <option value="production">production</option>
        </select>
      </label>
      <div className="flex items-end">
        <Button type="submit" size="sm" variant="primary">
          <Plus className="h-3.5 w-3.5" /> Add host
        </Button>
      </div>
      <p className="col-span-2 text-zinc-500">
        Friday stores only the key's path, never the key or a password. Connections use key
        authentication only, ignore ~/.ssh/config, and require a host key you have explicitly
        trusted.
      </p>
      {error && (
        <p role="alert" className="col-span-2 text-red-400">
          {error}
        </p>
      )}
    </form>
  );
}

export function DevopsSettings() {
  const [hosts, setHosts] = useState<SshHostDto[] | null>(null);
  const [sources, setSources] = useState<LogSourceDto[]>([]);
  const [label, setLabel] = useState('');
  const [path, setPath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [h, l] = await Promise.all([api.sshHosts(), api.logSources()]);
      setHosts(h.hosts);
      setSources(l.sources);
    } catch (e) {
      setError(message(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    // load() only sets state after its requests resolve.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const addSource = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api.addLogSource(label.trim(), path.trim());
      setLabel('');
      setPath('');
      await load();
    } catch (err) {
      setError(message(err));
    }
  };

  return (
    <>
      <Block title="SSH hosts">
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin text-zinc-500" />
        ) : (
          <ul className="space-y-2">
            {(hosts ?? []).map((h) => (
              <HostRow key={h.id} host={h} onChanged={() => void load()} />
            ))}
            {hosts?.length === 0 && <li className="text-xs text-zinc-500">No hosts yet.</li>}
          </ul>
        )}
        <AddHostForm onAdded={() => void load()} />
      </Block>
      <Block title="Log sources">
        <p className="mb-2 text-xs text-zinc-500">
          Log files outside your projects that Friday may read (read-only, last 4 MB, secrets
          redacted). Logs inside a project don't need adding.
        </p>
        <ul className="mb-2 space-y-1 text-xs">
          {sources.map((s) => (
            <li key={s.id} className="flex items-center gap-2">
              <span className="font-mono text-zinc-100">{s.label}</span>
              <span className="truncate font-mono text-zinc-500">{s.path}</span>
              <Button
                size="icon"
                variant="ghost"
                className="ml-auto h-6 w-6"
                aria-label={`Remove log source ${s.label}`}
                onClick={() =>
                  void api.removeLogSource(s.id).then(load, (e: unknown) => setError(message(e)))
                }
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
        </ul>
        <form
          onSubmit={(e) => void addSource(e)}
          className="flex gap-2 text-xs"
          aria-label="Add log source"
        >
          <input
            className={`${input} w-32`}
            aria-label="Label"
            placeholder="nginx-error"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            required
          />
          <input
            className={`${input} font-mono`}
            aria-label="Log file path"
            placeholder="/var/log/nginx/error.log"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            required
          />
          <Button type="submit" size="sm">
            Authorize
          </Button>
        </form>
        {error && (
          <p role="alert" className="mt-1 text-xs text-red-400">
            {error}
          </p>
        )}
      </Block>
    </>
  );
}
