import { ListChecks } from 'lucide-react';
import { useState } from 'react';
import { cn } from '../lib/cn';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';

type Target = 'uncommitted' | 'branch' | 'pull_request';

/** The message that starts a review; the model then uses review_changes and report_findings. */
export function reviewRequest(
  target: Target,
  opts: { base?: string; number?: number; focus?: string },
): string {
  const what =
    target === 'uncommitted'
      ? 'my uncommitted changes'
      : target === 'branch'
        ? `this branch against ${opts.base?.trim() || 'its base branch'}`
        : `pull request #${opts.number}`;
  return `Review ${what}.${opts.focus?.trim() ? ` Focus on: ${opts.focus.trim()}.` : ''} Report the findings; don't change any files.`;
}

/** Choose what to review: uncommitted changes, this branch, or a pull request. */
export function ReviewStartDialog({
  onClose,
  onStart,
}: {
  onClose: () => void;
  onStart: (message: string) => void;
}) {
  const [target, setTarget] = useState<Target>('uncommitted');
  const [base, setBase] = useState('');
  const [number, setNumber] = useState('');
  const [focus, setFocus] = useState('');
  const pr = Number(number);
  const ready = target !== 'pull_request' || (Number.isInteger(pr) && pr > 0);
  const input =
    'rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm outline-none focus:border-sky-500';
  const option = (value: Target, label: string, extra?: React.ReactNode) => (
    <label
      className={cn(
        'flex cursor-pointer flex-wrap items-center gap-2 rounded-md border px-3 py-2',
        target === value ? 'border-sky-600 bg-sky-950/30' : 'border-zinc-800',
      )}
    >
      <input
        type="radio"
        name="review-target"
        checked={target === value}
        onChange={() => setTarget(value)}
        className="accent-sky-500"
      />
      <span className="text-sm text-zinc-100">{label}</span>
      {target === value && extra}
    </label>
  );
  return (
    <Dialog open onClose={onClose} title="Review code">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) onStart(reviewRequest(target, { base, number: pr, focus }));
        }}
      >
        <fieldset className="space-y-2">
          <legend className="mb-1 text-xs font-medium text-zinc-400">What to review</legend>
          {option('uncommitted', 'Uncommitted changes')}
          {option(
            'branch',
            'This branch',
            <input
              aria-label="Compare with branch"
              placeholder="against (default: main)"
              value={base}
              onChange={(e) => setBase(e.target.value)}
              className={cn(input, 'w-48')}
            />,
          )}
          {option(
            'pull_request',
            'A pull request',
            <input
              aria-label="Pull request number"
              placeholder="number"
              inputMode="numeric"
              value={number}
              onChange={(e) => setNumber(e.target.value.replace(/\D/g, ''))}
              className={cn(input, 'w-24')}
            />,
          )}
        </fieldset>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-zinc-400">Focus (optional)</span>
          <input
            value={focus}
            onChange={(e) => setFocus(e.target.value)}
            placeholder="e.g. security, error handling"
            className={cn(input, 'w-full')}
          />
        </label>
        <p className="text-xs text-zinc-500">
          Friday reads the changes and reports findings with severity, file and line. Nothing is
          changed until you ask for a fix and approve the edit.
        </p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!ready}>
            <ListChecks className="h-4 w-4" aria-hidden /> Start review
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
