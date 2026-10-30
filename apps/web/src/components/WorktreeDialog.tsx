import type { ProjectDto, WorktreeStatusDto } from '@friday/shared';
import { AlertTriangle, GitBranch, GitMerge, Loader2, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { cn } from '../lib/cn';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';

type Mode = 'merge' | 'squash' | 'branch';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function Changes({ status }: { status: WorktreeStatusDto }) {
  const { commits, uncommitted } = status;
  if (!commits.length && !uncommitted.length)
    return <p className="text-sm text-zinc-400">The task hasn't changed anything yet.</p>;
  return (
    <div className="space-y-2 text-xs">
      {commits.length > 0 && (
        <div>
          <p className="mb-1 text-zinc-500">
            {commits.length} commit{commits.length === 1 ? '' : 's'} on the task branch
          </p>
          <ul className="max-h-28 overflow-y-auto rounded-md border border-zinc-800 bg-zinc-950 p-2 font-mono">
            {commits.map((c) => (
              <li key={c.sha} className="truncate text-zinc-300">
                <span className="text-zinc-500">{c.sha.slice(0, 8)}</span> {c.subject}
              </li>
            ))}
          </ul>
        </div>
      )}
      {uncommitted.length > 0 && (
        <div>
          <p className="mb-1 text-zinc-500">
            {uncommitted.length} changed file{uncommitted.length === 1 ? '' : 's'} not committed yet
          </p>
          <ul className="max-h-28 overflow-y-auto rounded-md border border-zinc-800 bg-zinc-950 p-2 font-mono">
            {uncommitted.map((f) => (
              <li key={f.path} className="truncate text-zinc-300">
                <span className="inline-block w-16 text-zinc-500">{f.status}</span>
                {f.path}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Accept (merge, squash or keep the branch) or discard a task worktree. */
export function WorktreeDialog({
  project,
  action,
  defaultMessage,
  onClose,
  onDone,
}: {
  project: ProjectDto;
  action: 'accept' | 'discard';
  defaultMessage: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [status, setStatus] = useState<WorktreeStatusDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<Mode>('merge');
  const [text, setText] = useState(defaultMessage);
  const branch = project.worktree!.branch;

  useEffect(() => {
    let cancelled = false;
    api
      .worktreeStatus(project.id)
      .then((s) => !cancelled && setStatus(s))
      .catch((e) => !cancelled && setError(message(e)));
    return () => {
      cancelled = true;
    };
  }, [project.id]);

  const target = status?.target.branch ?? null;
  const dirty = status?.target.dirty ?? [];
  const intoBranch = mode !== 'branch';
  const blocked =
    !status ||
    !status.idle ||
    (action === 'accept' && intoBranch && (dirty.length > 0 || !target)) ||
    (action === 'accept' && !status.commits.length && !status.uncommitted.length);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      if (action === 'accept')
        await api.acceptWorktree(project.id, mode, text.trim() || defaultMessage);
      else await api.discardWorktree(project.id);
      onDone();
      onClose();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const options: Array<{ value: Mode; label: string; hint: string }> = [
    {
      value: 'merge',
      label: `Merge into ${target ?? 'your branch'}`,
      hint: 'A merge commit on your branch; the task’s own commits stay in the history.',
    },
    {
      value: 'squash',
      label: `Squash into one commit on ${target ?? 'your branch'}`,
      hint: 'The whole task lands as a single commit.',
    },
    {
      value: 'branch',
      label: `Keep the branch ${branch}`,
      hint: 'Your branch is not changed. Push it or open a pull request from it later.',
    },
  ];

  return (
    <Dialog
      open
      onClose={onClose}
      title={action === 'accept' ? 'Accept the task' : 'Discard the task'}
    >
      <div className="space-y-4">
        {!status && !error && (
          <p className="flex items-center gap-2 text-sm text-zinc-400">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Reading the worktree…
          </p>
        )}
        {status && (
          <>
            <p className="text-sm text-zinc-300">
              <GitBranch className="mr-1 inline h-4 w-4 text-zinc-400" aria-hidden />
              <span className="font-mono">{branch}</span>, started from{' '}
              <span className="font-mono">
                {project.worktree!.baseBranch ?? 'a detached HEAD'} @{' '}
                {project.worktree!.base.slice(0, 8)}
              </span>
              .
            </p>
            <Changes status={status} />
            {!status.idle && (
              <p className="flex items-start gap-2 text-sm text-amber-300">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> A task is still
                running in this worktree. Wait for it, or stop it first.
              </p>
            )}
          </>
        )}

        {status && action === 'accept' && (
          <>
            <fieldset className="space-y-2">
              <legend className="mb-1 text-xs font-medium text-zinc-400">How</legend>
              {options.map((o) => (
                <label
                  key={o.value}
                  className={cn(
                    'flex cursor-pointer gap-2 rounded-md border px-3 py-2',
                    mode === o.value ? 'border-sky-600 bg-sky-950/30' : 'border-zinc-800',
                  )}
                >
                  <input
                    type="radio"
                    name="accept-mode"
                    checked={mode === o.value}
                    onChange={() => setMode(o.value)}
                    className="mt-1 accent-sky-500"
                  />
                  <span>
                    <span className="block text-sm text-zinc-100">{o.label}</span>
                    <span className="block text-xs text-zinc-400">{o.hint}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            {intoBranch && dirty.length > 0 && (
              <p role="status" className="flex items-start gap-2 text-sm text-amber-300">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                <span>
                  Your checkout has uncommitted changes ({dirty.slice(0, 4).join(', ')}
                  {dirty.length > 4 ? ', …' : ''}). Commit or stash them first: Friday never touches
                  them. Keeping the branch works now.
                </span>
              </p>
            )}
            {intoBranch && !target && (
              <p role="status" className="text-sm text-amber-300">
                Your checkout is on a detached HEAD; switch to the branch to merge into first.
              </p>
            )}
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-zinc-400">
                Commit message{mode === 'merge' ? ' (also used for uncommitted changes)' : ''}
              </span>
              <input
                value={text}
                onChange={(e) => setText(e.target.value)}
                className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm outline-none focus:border-sky-500"
              />
            </label>
            <p className="text-xs text-zinc-500">
              Uncommitted changes in the worktree are committed first. A conflict undoes the attempt
              completely and keeps the worktree. The worktree folder is removed afterwards
              {mode === 'branch' ? '; the branch stays' : ', and its branch deleted'}.
            </p>
          </>
        )}

        {status && action === 'discard' && (
          <p className="text-sm text-zinc-300">
            This removes the worktree folder and the branch{' '}
            <span className="font-mono">{branch}</span>, with everything the task did
            {status.commits.length || status.uncommitted.length ? ' (listed above)' : ''}. Your own
            checkout is not touched.
          </p>
        )}

        {error && (
          <p role="alert" className="text-sm text-red-400">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => void run()}
            disabled={busy || blocked}
            className={action === 'discard' ? 'bg-red-700 hover:bg-red-600' : undefined}
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : action === 'accept' ? (
              <GitMerge className="h-4 w-4" aria-hidden />
            ) : (
              <Trash2 className="h-4 w-4" aria-hidden />
            )}
            {action === 'accept' ? 'Accept' : 'Discard'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
