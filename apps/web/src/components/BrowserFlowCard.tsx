import type { BrowserFlowDto, BrowserFlowStepDto } from '@friday/shared';
import { Check, Circle, MousePointerClick, X } from 'lucide-react';
import { useState } from 'react';
import { cn } from '../lib/cn';
import { attachmentUrl } from './Attachments';
import { duration } from './TestRunCard';
import { Badge } from './ui/badge';
import { Dialog } from './ui/dialog';

const STATUS_LABEL: Record<BrowserFlowDto['status'], string> = {
  passed: 'passed',
  failed: 'failed',
  cancelled: 'cancelled',
};

function StepIcon({ status }: { status: BrowserFlowStepDto['status'] }) {
  if (status === 'passed')
    return <Check className="h-3.5 w-3.5 text-emerald-400" role="img" aria-label="passed" />;
  if (status === 'failed')
    return <X className="h-3.5 w-3.5 text-red-400" role="img" aria-label="failed" />;
  return <Circle className="h-3 w-3 text-zinc-600" role="img" aria-label="skipped" />;
}

function Step({
  step,
  previousUrl,
  onOpen,
}: {
  step: BrowserFlowStepDto;
  previousUrl: string | null;
  onOpen: (s: BrowserFlowStepDto) => void;
}) {
  const failed = step.status === 'failed';
  return (
    <li
      className={cn(
        'flex gap-3 border-t border-zinc-800/70 px-3 py-2',
        step.status === 'skipped' && 'text-zinc-500',
      )}
    >
      <span className="mt-0.5 shrink-0">
        <StepIcon status={step.status} />
      </span>
      <div className="min-w-0 flex-1 space-y-1 text-xs">
        <p className="flex flex-wrap items-baseline gap-x-2">
          <span className={cn('break-words', step.status !== 'skipped' && 'text-zinc-200')}>
            {step.index > 0 && <span className="text-zinc-500">{step.index}. </span>}
            {step.label}
          </span>
          {step.status !== 'skipped' && (
            <span className="text-zinc-500">{duration(step.durationMs)}</span>
          )}
        </p>
        {step.url && step.url !== previousUrl && (
          <p className="font-mono break-all text-zinc-500">
            {step.url}
            {step.title && <span className="font-sans"> · {step.title}</span>}
          </p>
        )}
        {step.error && (
          <pre
            role={failed ? 'alert' : undefined}
            className="overflow-x-auto whitespace-pre-wrap break-words rounded-md border border-red-900/60 bg-red-950/30 p-2 font-mono text-[0.75rem] text-red-200"
          >
            {step.error}
          </pre>
        )}
        {step.notes.length > 0 && (
          <ul className="space-y-0.5 text-zinc-400">
            {step.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        )}
        {step.problems.length > 0 && (
          <ul aria-label={`Problems in step ${step.index}`} className="space-y-0.5 text-amber-200">
            {step.problems.map((p, i) => (
              <li key={i} className="font-mono break-all text-[0.75rem]">
                {p}
              </li>
            ))}
          </ul>
        )}
      </div>
      {step.attachmentId && (
        <button
          type="button"
          onClick={() => onOpen(step)}
          aria-label={`View the screenshot after step ${step.index}`}
          className="block shrink-0 self-start overflow-hidden rounded-md border border-zinc-700 bg-zinc-950 hover:border-sky-500"
        >
          <img
            src={attachmentUrl(step.attachmentId)}
            alt={`After step ${step.index}: ${step.label}`}
            loading="lazy"
            className={cn('w-auto object-cover object-left-top', failed ? 'h-28' : 'h-14')}
          />
        </button>
      )}
    </li>
  );
}

/** A run_browser_flow result: each step, what happened on the page, and its screenshot. */
export function BrowserFlowCard({ flow }: { flow: BrowserFlowDto }) {
  const [open, setOpen] = useState<BrowserFlowStepDto | null>(null);
  const total = flow.steps.length - 1;
  const done = flow.steps.filter((s) => s.index > 0 && s.status === 'passed').length;
  const problems = flow.steps.reduce((n, s) => n + s.problems.length, 0);
  const tone =
    flow.status === 'passed' ? 'success' : flow.status === 'failed' ? 'danger' : 'neutral';
  return (
    <section
      aria-label={`Browser flow: ${flow.title}, ${STATUS_LABEL[flow.status]}`}
      className="ml-10 rounded-lg border border-zinc-800 bg-zinc-900/40 text-sm"
    >
      <header className="flex flex-wrap items-center gap-2 px-3 py-2">
        <MousePointerClick className="h-4 w-4 text-zinc-400" aria-hidden />
        <h2 className="font-medium text-zinc-200">{flow.title}</h2>
        <span className="min-w-0 truncate font-mono text-xs text-zinc-500">{flow.startUrl}</span>
        <span className="ml-auto flex flex-wrap items-center gap-1">
          <Badge tone={tone}>{STATUS_LABEL[flow.status]}</Badge>
          <Badge tone="neutral">
            {done} of {total} step{total === 1 ? '' : 's'} passed
          </Badge>
          {problems > 0 && (
            <Badge tone="warning">
              {problems} page problem{problems === 1 ? '' : 's'}
            </Badge>
          )}
          <span className="text-xs text-zinc-500">{duration(flow.durationMs)}</span>
        </span>
      </header>
      <ol aria-label="Steps">
        {flow.steps.map((s, i) => (
          <Step
            key={s.index}
            step={s}
            previousUrl={flow.steps.slice(0, i).findLast((p) => p.url)?.url ?? null}
            onOpen={setOpen}
          />
        ))}
      </ol>
      {open?.attachmentId && (
        <Dialog
          open
          onClose={() => setOpen(null)}
          title={open.index > 0 ? `After step ${open.index}: ${open.label}` : open.label}
        >
          <img
            src={attachmentUrl(open.attachmentId)}
            alt={`After step ${open.index}: ${open.label}`}
            className="mx-auto max-h-[70vh] w-auto rounded border border-zinc-800 object-contain"
          />
          {open.url && <p className="mt-2 font-mono text-xs break-all text-zinc-500">{open.url}</p>}
        </Dialog>
      )}
    </section>
  );
}
