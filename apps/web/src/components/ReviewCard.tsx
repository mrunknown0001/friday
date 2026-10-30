import type { FindingSeverity, ReviewDto, ReviewFinding } from '@friday/shared';
import {
  AlertTriangle,
  ChevronRight,
  ExternalLink,
  EyeOff,
  ListChecks,
  RotateCcw,
  Wrench,
} from 'lucide-react';
import { createContext, useContext, useState } from 'react';
import { api } from '../lib/api';
import { cn } from '../lib/cn';
import { FileViewer } from './SidePanel';
import { Badge, type Tone } from './ui/badge';
import { Button } from './ui/button';

/** What a review card needs from the conversation: the project, and a way to ask for a fix. */
export interface ReviewActions {
  projectId: string | null;
  canSend: boolean;
  send: (text: string) => Promise<boolean>;
}

export const ReviewActionsContext = createContext<ReviewActions | null>(null);

const SEVERITY: Record<FindingSeverity, { tone: Tone; label: string }> = {
  critical: { tone: 'danger', label: 'critical' },
  high: { tone: 'danger', label: 'high' },
  medium: { tone: 'warning', label: 'medium' },
  low: { tone: 'info', label: 'low' },
  nit: { tone: 'neutral', label: 'nit' },
};

const LOCATION_NOTE: Partial<Record<ReviewFinding['location'], string>> = {
  outside_change: 'not in the changed lines',
  not_found: 'file or line not found: check before acting',
};

/** The message that asks Friday to fix one finding, as a normal approved edit. */
export function fixRequest(f: ReviewFinding): string {
  const where = `${f.file}${f.line ? `:${f.line}` : ''}`;
  const fence = (s: string) => {
    const ticks = Math.max(3, ...[...s.matchAll(/`+/g)].map((m) => m[0].length + 1));
    return `${'`'.repeat(ticks)}\n${s}\n${'`'.repeat(ticks)}`;
  };
  if (f.suggestion)
    return `Fix review finding #${f.n} ("${f.title}") in ${where}: replace\n${fence(f.suggestion.oldText)}\nwith\n${fence(f.suggestion.newText)}\nRead the file first and propose it as an edit for my approval; don't change anything else.`;
  return `Fix review finding #${f.n} ("${f.title}") in ${where}. ${f.fix ?? f.reason}\nRead the code first and propose the smallest edit for my approval; don't change anything else.`;
}

function Finding({
  review,
  f,
  onChanged,
}: {
  review: ReviewDto;
  f: ReviewFinding;
  onChanged: (r: ReviewDto) => void;
}) {
  const actions = useContext(ReviewActionsContext);
  const [open, setOpen] = useState(f.severity !== 'nit');
  const [viewing, setViewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dismissed = f.status === 'dismissed';
  const note = LOCATION_NOTE[f.location];

  const setStatus = async (status: ReviewFinding['status']) => {
    setError(null);
    try {
      onChanged(await api.setFindingStatus(review.id, f.n, status));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const fix = async () => {
    if (!actions) return;
    setBusy(true);
    try {
      if (await actions.send(fixRequest(f))) await setStatus('fix_requested');
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className={cn('border-t border-zinc-800/70 px-3 py-2', dismissed && 'opacity-60')}>
      <div className="flex items-start gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={`${open ? 'Hide' : 'Show'} finding ${f.n}`}
          className="mt-0.5 text-zinc-500 hover:text-zinc-300"
        >
          <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-90')} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-zinc-500">#{f.n}</span>
            <Badge tone={SEVERITY[f.severity].tone}>{SEVERITY[f.severity].label}</Badge>
            <span className={cn('text-sm text-zinc-100', dismissed && 'line-through')}>
              {f.title}
            </span>
            {f.status === 'fix_requested' && <Badge tone="info">fix requested</Badge>}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs">
            {actions?.projectId ? (
              <button
                type="button"
                onClick={() => setViewing(true)}
                className="font-mono text-sky-300 hover:underline"
                title="Open the file at this line"
              >
                {f.file}
                {f.line ? `:${f.line}` : ''}
              </button>
            ) : (
              <span className="font-mono text-zinc-300">
                {f.file}
                {f.line ? `:${f.line}` : ''}
              </span>
            )}
            {note && (
              <span className="flex items-center gap-1 text-amber-300">
                <AlertTriangle className="h-3 w-3" aria-hidden /> {note}
              </span>
            )}
          </div>
          {open && (
            <div className="mt-1.5 space-y-2 text-xs">
              <p className="whitespace-pre-wrap text-zinc-300">{f.reason}</p>
              {f.suggestion && (
                <div
                  aria-label={`Suggested change for finding ${f.n}`}
                  className="overflow-x-auto rounded-md border border-zinc-800 bg-zinc-950 font-mono text-[0.75rem]"
                >
                  {f.suggestion.oldText.split('\n').map((l, i) => (
                    <div key={`o${i}`} className="whitespace-pre bg-red-950/40 px-2 text-red-200">
                      − {l}
                    </div>
                  ))}
                  {f.suggestion.newText.split('\n').map((l, i) => (
                    <div
                      key={`n${i}`}
                      className="whitespace-pre bg-emerald-950/40 px-2 text-emerald-200"
                    >
                      + {l}
                    </div>
                  ))}
                </div>
              )}
              {f.suggestion?.applies === false && (
                <p className="text-amber-300">
                  The text to replace is not in the file exactly once; Friday will re-read it.
                </p>
              )}
              {!f.suggestion && f.fix && <p className="text-zinc-400">Fix: {f.fix}</p>}
              <div className="flex flex-wrap gap-2">
                {!dismissed && (f.suggestion || f.fix) && (
                  <Button size="sm" onClick={() => void fix()} disabled={busy || !actions?.canSend}>
                    <Wrench className="h-3.5 w-3.5" aria-hidden />
                    {f.status === 'fix_requested' ? 'Ask again' : 'Fix this'}
                  </Button>
                )}
                {dismissed ? (
                  <Button size="sm" variant="ghost" onClick={() => void setStatus('open')}>
                    <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Restore
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => void setStatus('dismissed')}>
                    <EyeOff className="h-3.5 w-3.5" aria-hidden /> Dismiss
                  </Button>
                )}
              </div>
              {error && (
                <p role="alert" className="text-red-400">
                  {error}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
      {viewing && actions?.projectId && (
        <FileViewer
          projectId={actions.projectId}
          path={f.file}
          line={f.line}
          onClose={() => setViewing(false)}
        />
      )}
    </li>
  );
}

/** A code review's findings, most severe first, each fixed (as an approved edit) or dismissed. */
export function ReviewCard({ review: initial }: { review: ReviewDto }) {
  const [review, setReview] = useState(initial);
  // A newer copy from the server (e.g. after reload) replaces the local one.
  const [seen, setSeen] = useState(initial);
  if (initial !== seen) {
    setSeen(initial);
    setReview(initial);
  }
  const open = review.findings.filter((f) => f.status !== 'dismissed');
  const counts = (['critical', 'high', 'medium', 'low', 'nit'] as const)
    .map((s) => [s, open.filter((f) => f.severity === s).length] as const)
    .filter(([, n]) => n);
  return (
    <section
      aria-label={`Code review: ${review.target.label}`}
      className="ml-10 rounded-lg border border-zinc-800 bg-zinc-900/40 text-sm"
    >
      <header className="flex flex-wrap items-center gap-2 px-3 py-2">
        <ListChecks className="h-4 w-4 text-zinc-400" aria-hidden />
        <h2 className="font-medium text-zinc-200">Code review</h2>
        <span className="min-w-0 truncate text-xs text-zinc-400" title={review.target.label}>
          {review.target.label}
        </span>
        {review.target.url && (
          <a
            href={review.target.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-sky-300 hover:underline"
          >
            <ExternalLink className="mr-0.5 inline h-3 w-3" aria-hidden />
            on GitHub
          </a>
        )}
        <span className="ml-auto flex gap-1">
          {counts.length ? (
            counts.map(([s, n]) => (
              <Badge key={s} tone={SEVERITY[s].tone}>
                {n} {s}
              </Badge>
            ))
          ) : (
            <Badge tone="success">no open findings</Badge>
          )}
        </span>
      </header>
      <p className="px-3 pb-2 text-xs text-zinc-300">{review.summary}</p>
      {review.findings.length > 0 && (
        <ul aria-label="Findings">
          {review.findings.map((f) => (
            <Finding key={f.n} review={review} f={f} onChanged={setReview} />
          ))}
        </ul>
      )}
      <p className="border-t border-zinc-800/70 px-3 py-1.5 text-[11px] text-zinc-500">
        Written by the model; locations checked by Friday. Each fix is proposed as an edit you
        approve.
      </p>
    </section>
  );
}
