import type { ProjectDto, RemoteFolderListDto, SshHostDto } from '@friday/shared';
import { ArrowUp, Folder, FolderOpen, Laptop, Loader2, Server, ShieldCheck } from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api } from '../lib/api';
import { cn } from '../lib/cn';
import { desktop } from '../lib/desktop';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';

type Where = 'local' | 'ssh';

/** Folders on an SSH host: open one to go in, "Use this folder" to pick the one shown. */
function RemoteFolderBrowser({
  hostId,
  start,
  onPick,
}: {
  hostId: string;
  start: string;
  onPick: (path: string) => void;
}) {
  const [listing, setListing] = useState<RemoteFolderListDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = (path?: string) =>
    api
      .sshHostFolders(hostId, path)
      .then((l) => {
        setListing(l);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  const open = (path?: string) => {
    setLoading(true);
    void load(path);
  };
  // Opens at the typed folder when there is one, otherwise at the login's home.
  useEffect(() => {
    void load(start.startsWith('/') ? start : undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId]);

  const up = listing && listing.path !== '/' ? listing.path.replace(/\/[^/]+$/, '') || '/' : null;
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950" aria-label="Folders on the host">
      <div className="flex items-center gap-2 border-b border-zinc-800 px-2 py-1.5">
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          disabled={!up || loading}
          onClick={() => up && open(up)}
          aria-label="Parent folder"
          title="Parent folder"
        >
          <ArrowUp className="h-3.5 w-3.5" />
        </Button>
        <span
          className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-300"
          title={listing?.path}
        >
          {listing?.path ?? '…'}
        </span>
        {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-500" aria-hidden />}
        <Button
          size="sm"
          disabled={!listing || loading}
          onClick={() => listing && onPick(listing.path)}
        >
          Use this folder
        </Button>
      </div>
      {error ? (
        <p role="alert" className="px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      ) : (
        <ul className="max-h-48 overflow-y-auto py-1">
          {listing && listing.folders.length === 0 && (
            <li className="px-3 py-1.5 text-xs text-zinc-500">No subfolders.</li>
          )}
          {listing?.folders.map((f) => (
            <li key={f}>
              <button
                type="button"
                onClick={() => open(`${listing.path === '/' ? '' : listing.path}/${f}`)}
                className="flex w-full items-center gap-2 px-3 py-1 text-left font-mono text-xs text-zinc-200 hover:bg-zinc-800"
              >
                <Folder className="h-3.5 w-3.5 shrink-0 text-sky-400" aria-hidden />
                <span className="truncate">{f}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function AddProjectDialog({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: (p: ProjectDto) => void;
}) {
  const [where, setWhere] = useState<Where>('local');
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hosts, setHosts] = useState<SshHostDto[] | null>(null);
  const [hostId, setHostId] = useState('');
  const [browsing, setBrowsing] = useState(false);

  useEffect(() => {
    if (where !== 'ssh' || hosts) return;
    api
      .sshHosts()
      .then(({ hosts: all }) => {
        const trusted = all.filter((h) => h.trustedFingerprints.length > 0);
        setHosts(trusted);
        setHostId((id) => id || trusted[0]?.id || '');
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [where, hosts]);

  const host = hosts?.find((h) => h.id === hostId) ?? null;
  const remote = where === 'ssh';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onAdded(
        await api.addProject(path.trim(), name.trim() || undefined, remote ? hostId : undefined),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const choice = (value: Where, label: string, icon: ReactNode) => (
    <label
      className={cn(
        'relative flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-md border px-3 py-1.5 text-sm has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-sky-600',
        where === value
          ? 'border-sky-600 bg-sky-950/50 text-sky-100'
          : 'border-zinc-700 text-zinc-300 hover:border-zinc-500',
      )}
    >
      <input
        type="radio"
        name="project-where"
        value={value}
        checked={where === value}
        onChange={() => {
          setWhere(value);
          setPath('');
          setBrowsing(false);
          setError(null);
        }}
        className="sr-only"
      />
      {icon}
      {label}
    </label>
  );

  return (
    <Dialog open onClose={onClose} title="Add project">
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <fieldset>
          <legend className="mb-1 text-sm font-medium text-zinc-200">Where is the project?</legend>
          <div className="flex gap-2">
            {choice('local', 'This computer', <Laptop className="h-4 w-4" aria-hidden />)}
            {choice('ssh', 'SSH host', <Server className="h-4 w-4" aria-hidden />)}
          </div>
        </fieldset>

        {remote && (
          <div>
            <label htmlFor="project-host" className="mb-1 block text-sm font-medium text-zinc-200">
              Host
            </label>
            {hosts === null ? (
              <p className="text-xs text-zinc-500">Loading hosts…</p>
            ) : hosts.length === 0 ? (
              <p className="rounded-md border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
                No trusted SSH host yet. Add one and trust its host key in Settings → SSH hosts.
              </p>
            ) : (
              <div className="flex items-center gap-2">
                <select
                  id="project-host"
                  value={hostId}
                  onChange={(e) => {
                    setHostId(e.target.value);
                    setBrowsing(false);
                  }}
                  className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm outline-none focus:border-sky-500"
                >
                  {hosts.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.name} ({h.username}@{h.hostname})
                    </option>
                  ))}
                </select>
                {host && (
                  <Badge tone={host.environment === 'production' ? 'danger' : 'neutral'}>
                    {host.environment}
                  </Badge>
                )}
              </div>
            )}
          </div>
        )}

        <div>
          <label htmlFor="project-path" className="mb-1 block text-sm font-medium text-zinc-200">
            {remote ? 'Folder on the host' : 'Folder path'}
          </label>
          <div className="flex gap-2">
            <input
              id="project-path"
              autoFocus
              required
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder={remote ? '/var/www/my-app' : '/home/you/code/my-app'}
              spellCheck={false}
              aria-describedby="project-path-help"
              className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 font-mono text-sm outline-none focus:border-sky-500"
            />
            {remote ? (
              <Button
                disabled={!host}
                aria-expanded={browsing}
                onClick={() => setBrowsing((b) => !b)}
              >
                <FolderOpen className="h-3.5 w-3.5" aria-hidden /> Browse…
              </Button>
            ) : (
              desktop && (
                <Button
                  onClick={() =>
                    void desktop!.pickFolder().then((picked) => picked && setPath(picked))
                  }
                >
                  <FolderOpen className="h-3.5 w-3.5" aria-hidden /> Browse…
                </Button>
              )
            )}
          </div>
          <p id="project-path-help" className="mt-1 text-xs text-zinc-500">
            {remote
              ? 'Absolute path of a specific project folder on the server, e.g. /var/www/my-app.'
              : 'Absolute path to a specific project folder on this machine.'}
          </p>
          {remote && browsing && host && (
            <div className="mt-2">
              <RemoteFolderBrowser
                hostId={host.id}
                start={path.trim()}
                onPick={(p) => {
                  setPath(p);
                  setBrowsing(false);
                }}
              />
            </div>
          )}
        </div>
        <div>
          <label htmlFor="project-name" className="mb-1 block text-sm font-medium text-zinc-200">
            Name <span className="font-normal text-zinc-500">(optional)</span>
          </label>
          <input
            id="project-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Defaults to the folder name"
            className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-sm outline-none focus:border-sky-500"
          />
        </div>
        <div className="flex gap-2 rounded-md border border-zinc-800 bg-zinc-950/60 p-3 text-xs text-zinc-400">
          <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-400" aria-hidden />
          {remote ? (
            <div className="space-y-1">
              <p>
                Friday works in this folder <strong className="text-zinc-200">on the server</strong>
                , over SSH{host ? ` as ${host.username}` : ''}: it reads and searches files there
                without asking, and every file change, command and commit needs your approval before
                it runs on the server.
                {host?.environment === 'production' &&
                  ' This is a production host: approving also needs its name typed.'}
              </p>
              <p>
                Credential files (.env, private keys, …) and .git internals are never read. File
                contents Friday reads are sent to the model provider you chose. The server needs
                Linux with standard GNU tools.
              </p>
              <p>System folders, the login&apos;s home folder and /tmp are refused.</p>
            </div>
          ) : (
            <div className="space-y-1">
              <p>
                Adding a folder authorizes Friday to <strong className="text-zinc-200">read</strong>{' '}
                files inside it when you chat in this project. Reads are confined to the folder,
                including through symlinks.
              </p>
              <p>
                Credential files (.env, private keys, …) and .git internals are never read. File
                contents Friday reads are sent to the model provider you chose. Every file change
                and command needs your approval first.
              </p>
              <p>Broad locations such as your home folder or system directories are refused.</p>
            </div>
          )}
        </div>
        {error && (
          <p role="alert" className="text-sm text-red-400">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="submit"
            variant="primary"
            disabled={!path.trim() || busy || (remote && !hostId)}
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Authorize folder
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
