import type { CodeMapStatusDto, ProjectDto, SandboxStatusDto } from '@friday/shared';
import {
  Box,
  Download,
  FolderOpen,
  Loader2,
  Network,
  Plus,
  RefreshCw,
  Server,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { SavedActionsSection } from './SavedActions';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';

const input =
  'w-full rounded-md border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-sm outline-none focus:border-sky-500';

/** The project's code map: what is indexed, and a rebuild for when it looks wrong. */
function CodeMapSection({ projectId }: { projectId: string }) {
  const [status, setStatus] = useState<CodeMapStatusDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .projectCodeMap(projectId)
      .then((s) => !cancelled && setStatus(s))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const rebuild = async () => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await api.rebuildCodeMap(projectId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="codemap-heading" className="space-y-2 border-t border-zinc-800 pt-4">
      <h3 id="codemap-heading" className="flex items-center gap-2 text-sm font-semibold">
        <Network className="h-4 w-4 text-sky-400" aria-hidden /> Code map
      </h3>
      <p className="text-sm text-zinc-300">
        An index of the classes, functions and methods defined in the project, so Friday can find
        code without reading files blindly. It is built the first time Friday needs it and only
        re-reads files that changed. It is kept on this machine.
      </p>
      <div className="flex flex-wrap items-center gap-2 text-xs" role="status">
        {status === null && !error ? (
          <span className="text-zinc-400">Loading…</span>
        ) : status && status.files > 0 ? (
          <span className="text-zinc-300">
            {status.files.toLocaleString()} source files, {status.symbols.toLocaleString()}{' '}
            definitions
            {status.lastRefresh &&
              ` · checked ${new Date(status.lastRefresh.at).toLocaleTimeString()}`}
            {status.lastRefresh?.truncated && ' · project larger than the index limit'}
          </span>
        ) : status ? (
          <span className="text-zinc-400">Not built yet.</span>
        ) : null}
        <Button size="sm" variant="ghost" onClick={() => void rebuild()} disabled={busy}>
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          )}{' '}
          Rebuild
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-red-400">
          {error}
        </p>
      )}
    </section>
  );
}

/**
 * Folders outside the project Friday may read (by absolute path). Saved as soon as one is added or
 * removed; changes there are always asked one by one.
 */
function ExternalFoldersSection({
  project,
  onSaved,
}: {
  project: ProjectDto;
  onSaved: (p: ProjectDto) => void;
}) {
  const [folders, setFolders] = useState(project.externalFolders);
  const [adding, setAdding] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (next: string[]) => {
    setBusy(true);
    setError(null);
    try {
      const p = await api.setExternalFolders(project.id, next);
      setFolders(p.externalFolders);
      onSaved(p);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const add = async () => {
    if (await save([...folders, adding.trim()])) setAdding('');
  };

  return (
    <section aria-labelledby="external-heading" className="space-y-2 border-t border-zinc-800 pt-4">
      <h3 id="external-heading" className="flex items-center gap-2 text-sm font-semibold">
        <FolderOpen className="h-4 w-4 text-sky-400" aria-hidden /> External folders
      </h3>
      <p className="text-sm text-zinc-300">
        Folders outside the project Friday may read, such as a shared library or another repository.
        Credential files and <code className="font-mono">.git</code> stay off limits there too, and
        every change Friday proposes in them needs your approval, one at a time. Commands, git and
        tests still run only in the project.
      </p>
      {folders.length > 0 && (
        <ul className="space-y-1" aria-label="External folders">
          {folders.map((f) => (
            <li
              key={f}
              className="flex items-center gap-2 rounded-md border border-zinc-800 px-2.5 py-1.5"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-200" title={f}>
                {f}
              </span>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Remove ${f}`}
                disabled={busy}
                onClick={() => void save(folders.filter((x) => x !== f))}
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (adding.trim()) void add();
        }}
      >
        <input
          aria-label="Folder to add"
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
          placeholder="/absolute/path/to/folder"
          spellCheck={false}
          className={`${input} font-mono`}
        />
        <Button size="sm" type="submit" disabled={busy || !adding.trim()}>
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <Plus className="h-3.5 w-3.5" aria-hidden />
          )}
          Add
        </Button>
      </form>
      {error && (
        <p role="alert" className="text-xs text-red-400">
          {error}
        </p>
      )}
    </section>
  );
}

/** Per-project settings: where commands run (this machine or a container) and the code map. */
interface SettingsProps {
  project: ProjectDto;
  onClose: () => void;
  onSaved: (p: ProjectDto) => void;
}

export function ProjectSettingsDialog(props: SettingsProps) {
  return props.project.remote ? (
    <RemoteProjectSettings {...props} />
  ) : (
    <LocalProjectSettings {...props} />
  );
}

/** A project on an SSH host: where it is, and what works there. */
function RemoteProjectSettings({ project, onClose }: SettingsProps) {
  const r = project.remote!;
  return (
    <Dialog open onClose={onClose} title={`Project settings: ${project.name}`}>
      <div className="space-y-4 text-sm">
        <section aria-labelledby="remote-heading" className="space-y-2">
          <h3 id="remote-heading" className="flex items-center gap-2 font-semibold">
            <Server className="h-4 w-4 text-sky-400" aria-hidden /> On an SSH host
          </h3>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-zinc-400">Host</dt>
            <dd className="flex items-center gap-2 text-zinc-100">
              {r.name}
              <Badge tone={r.environment === 'production' ? 'danger' : 'neutral'}>
                {r.environment}
              </Badge>
            </dd>
            <dt className="text-zinc-400">Login</dt>
            <dd className="font-mono text-zinc-100">
              {r.username}@{r.hostname}
              {r.port !== 22 ? `:${r.port}` : ''}
            </dd>
            <dt className="text-zinc-400">Folder</dt>
            <dd className="font-mono text-zinc-100 [overflow-wrap:anywhere]">{project.rootPath}</dd>
          </dl>
          <p className="text-zinc-300">
            Friday reads and searches this folder on the server over SSH, and every file change,
            command and commit runs there after your approval
            {r.environment === 'production' ? ', with the host name typed to confirm' : ''}. The
            connection and host key are managed in Settings → SSH hosts.
          </p>
          <p className="text-xs text-zinc-400">
            Not available for projects on an SSH host: the command sandbox, external folders, the
            code map, saved actions, task worktrees, test runs and code review.
          </p>
        </section>
        <div className="flex justify-end">
          <Button onClick={onClose}>Close</Button>
        </div>
      </div>
    </Dialog>
  );
}

function LocalProjectSettings({ project, onClose, onSaved }: SettingsProps) {
  const [status, setStatus] = useState<SandboxStatusDto | null>(null);
  const [enabled, setEnabled] = useState(project.sandbox?.enabled ?? false);
  const [image, setImage] = useState(project.sandbox?.image ?? '');
  const [network, setNetwork] = useState<'none' | 'bridge'>(project.sandbox?.network ?? 'none');
  const [busy, setBusy] = useState<'check' | 'pull' | 'save' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const loaded = useCallback((s: SandboxStatusDto) => {
    setStatus(s);
    setImage((current) => current || s.suggestedImage);
  }, []);
  const check = async () => {
    setBusy('check');
    setError(null);
    try {
      loaded(await api.projectSandbox(project.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  useEffect(() => {
    let cancelled = false;
    api
      .projectSandbox(project.id)
      .then((s) => !cancelled && loaded(s))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [project.id, loaded]);

  const configured = project.sandbox?.image ?? status?.suggestedImage;
  // The presence check is for the saved (or suggested) image; an edited name is unknown until saved.
  const present = image.trim() === configured ? status?.imagePresent : null;

  const pull = async () => {
    setBusy('pull');
    setError(null);
    try {
      setStatus(await api.pullSandboxImage(project.id, image.trim()));
      if (image.trim() !== configured) await save(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const save = async (close = true) => {
    setBusy('save');
    setError(null);
    try {
      const p = await api.setProjectSandbox(project.id, {
        enabled,
        image: image.trim(),
        network,
      });
      onSaved(p);
      setSaved(true);
      if (close) onClose();
      else await check();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open onClose={onClose} title={`Project settings: ${project.name}`}>
      <div className="space-y-4">
        <section aria-labelledby="sandbox-heading" className="space-y-3">
          <h3 id="sandbox-heading" className="flex items-center gap-2 text-sm font-semibold">
            <Box className="h-4 w-4 text-sky-400" aria-hidden /> Command sandbox
          </h3>
          <p className="text-sm text-zinc-300">
            Run this project’s commands (tests, builds, scripts) in a throwaway Docker container
            instead of on this machine. The container sees only the project folder. Credential files
            are hidden, <code className="font-mono">.git</code> is read-only, and nothing from your
            environment (keys, tokens, PATH) is passed in. Every command still needs your approval.
          </p>
          <p className="text-xs text-zinc-400">
            The project folder is writable inside the container, so tests and builds work. Commands
            can still change project files, so review them as usual.
          </p>

          <div className="flex items-center gap-2 text-xs">
            {status === null ? (
              <span className="text-zinc-400">Checking Docker…</span>
            ) : status.docker ? (
              <Badge tone="success">Docker {status.docker}</Badge>
            ) : (
              <span className="text-amber-300">
                Docker is not reachable. Start Docker, then check again.
              </span>
            )}
            <Button size="sm" variant="ghost" onClick={() => void check()} disabled={busy !== null}>
              <RefreshCw
                className={`h-3.5 w-3.5 ${busy === 'check' ? 'animate-spin' : ''}`}
                aria-hidden
              />{' '}
              Check again
            </Button>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="accent-sky-500"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              disabled={!status?.docker}
            />
            Run this project’s commands in a container
          </label>

          <div>
            <label htmlFor="sandbox-image" className="mb-1 block text-xs font-medium text-zinc-300">
              Image
            </label>
            <div className="flex gap-2">
              <input
                id="sandbox-image"
                value={image}
                onChange={(e) => setImage(e.target.value)}
                spellCheck={false}
                aria-describedby="sandbox-image-help"
                className={`${input} font-mono`}
              />
              <Button
                size="sm"
                onClick={() => void pull()}
                disabled={busy !== null || !status?.docker || !image.trim()}
              >
                {busy === 'pull' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                ) : (
                  <Download className="h-3.5 w-3.5" aria-hidden />
                )}
                Pull
              </Button>
            </div>
            <p id="sandbox-image-help" className="mt-1 text-xs text-zinc-400">
              {present === true && 'Available locally. '}
              {present === false && (
                <span className="text-amber-300">Not downloaded yet: click Pull. </span>
              )}
              {status && image.trim() !== status.suggestedImage && (
                <>
                  Suggested for this project:{' '}
                  <button
                    type="button"
                    className="font-mono text-sky-300 underline"
                    onClick={() => setImage(status.suggestedImage)}
                  >
                    {status.suggestedImage}
                  </button>
                  .{' '}
                </>
              )}
              Friday never downloads images by itself.
            </p>
          </div>

          <div>
            <label
              htmlFor="sandbox-network"
              className="mb-1 block text-xs font-medium text-zinc-300"
            >
              Network
            </label>
            <select
              id="sandbox-network"
              value={network}
              onChange={(e) => setNetwork(e.target.value as 'none' | 'bridge')}
              className={input}
            >
              <option value="none">No network (recommended)</option>
              <option value="bridge">Allow outbound network (e.g. to install packages)</option>
            </select>
          </div>
        </section>

        <ExternalFoldersSection project={project} onSaved={onSaved} />

        <CodeMapSection projectId={project.id} />

        <SavedActionsSection projectId={project.id} />

        {error && (
          <p role="alert" className="text-sm text-red-400">
            {error}
          </p>
        )}
        {saved && !error && (
          <p role="status" className="text-xs text-emerald-300">
            Saved.
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => void save()}
            disabled={busy !== null || !image.trim()}
          >
            {busy === 'save' && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />} Save
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
