import type { CodeMapStatusDto, ProjectDto, SandboxStatusDto } from '@friday/shared';
import { Box, Download, Loader2, Network, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
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

/** Per-project settings: where commands run (this machine or a container) and the code map. */
export function ProjectSettingsDialog({
  project,
  onClose,
  onSaved,
}: {
  project: ProjectDto;
  onClose: () => void;
  onSaved: (p: ProjectDto) => void;
}) {
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

        <CodeMapSection projectId={project.id} />

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
