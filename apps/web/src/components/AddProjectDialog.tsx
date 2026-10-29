import type { ProjectDto } from '@friday/shared';
import { FolderOpen, Loader2, ShieldCheck } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { desktop } from '../lib/desktop';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';

export function AddProjectDialog({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: (p: ProjectDto) => void;
}) {
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onAdded(await api.addProject(path.trim(), name.trim() || undefined));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title="Add project">
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <div>
          <label htmlFor="project-path" className="mb-1 block text-sm font-medium text-zinc-200">
            Folder path
          </label>
          <div className="flex gap-2">
            <input
              id="project-path"
              autoFocus
              required
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/home/you/code/my-app"
              spellCheck={false}
              aria-describedby="project-path-help"
              className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 font-mono text-sm outline-none focus:border-sky-500"
            />
            {desktop && (
              <Button
                onClick={() =>
                  void desktop!.pickFolder().then((picked) => picked && setPath(picked))
                }
              >
                <FolderOpen className="h-3.5 w-3.5" aria-hidden /> Browse…
              </Button>
            )}
          </div>
          <p id="project-path-help" className="mt-1 text-xs text-zinc-500">
            Absolute path to a specific project folder on this machine.
          </p>
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
          <div className="space-y-1">
            <p>
              Adding a folder authorizes Friday to <strong className="text-zinc-200">read</strong>{' '}
              files inside it when you chat in this project. Reads are confined to the folder,
              including through symlinks.
            </p>
            <p>
              Credential files (.env, private keys, …) and .git internals are never read. File
              contents Friday reads are sent to your NoTokenLimit model. Every file change and
              command needs your approval first.
            </p>
            <p>Broad locations such as your home folder or system directories are refused.</p>
          </div>
        </div>
        {error && (
          <p role="alert" className="text-sm text-red-400">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!path.trim() || busy}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Authorize folder
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
