import { Download, ExternalLink, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Button } from './ui/button';

/** Whether this Friday can open files in the system's apps (desktop) — asked once per page. */
let openFilesSupported: Promise<boolean> | null = null;
function canOpenFiles(): Promise<boolean> {
  openFilesSupported ??= api
    .previewStatus()
    .then((s) => s.openFiles)
    .catch(() => false);
  return openFilesSupported;
}

/** Open a generated document in its app (desktop) or download it (browser). */
export function DocumentActions({ projectId, path }: { projectId: string; path: string }) {
  const [openable, setOpenable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = path.split('/').at(-1) ?? path;

  useEffect(() => {
    let cancelled = false;
    void canOpenFiles().then((ok) => !cancelled && setOpenable(ok));
    return () => {
      cancelled = true;
    };
  }, []);

  const open = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.openProjectFile(projectId, path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {openable && (
        <Button size="sm" onClick={() => void open()} disabled={busy} aria-label={`Open ${name}`}>
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          )}
          Open
        </Button>
      )}
      <a
        href={api.projectDownloadUrl(projectId, path)}
        download={name}
        aria-label={`Download ${name}`}
        className="inline-flex h-7 items-center gap-1.5 rounded-md bg-zinc-800 px-2.5 text-xs font-medium text-zinc-100 hover:bg-zinc-700"
      >
        <Download className="h-3.5 w-3.5" aria-hidden /> Download
      </a>
      {error && (
        <span role="alert" className="text-xs text-red-400">
          {error}
        </span>
      )}
    </div>
  );
}
