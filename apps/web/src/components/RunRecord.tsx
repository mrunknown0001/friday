import type { ApprovalDto } from '@friday/shared';
import { CircleAlert, CircleCheck, CircleSlash, ClipboardList } from 'lucide-react';

/** A command result like "exit code 1 (0.2s)" or "timed out ..." that did not succeed. */
export function isFailedCommand(summary: string | null | undefined): boolean {
  if (!summary) return false;
  const code = /^exit code (\d+)/.exec(summary);
  if (code) return code[1] !== '0';
  return /timed out|killed|cancelled/.test(summary);
}

type Outcome = 'ok' | 'bad' | 'neutral';

function outcome(a: ApprovalDto): { kind: Outcome; text: string } {
  switch (a.status) {
    case 'executed':
      return isFailedCommand(a.resultSummary)
        ? { kind: 'bad', text: a.resultSummary ?? 'failed' }
        : { kind: 'ok', text: a.resultSummary ?? 'done' };
    case 'failed':
      return { kind: 'bad', text: a.resultSummary ?? 'failed' };
    case 'stale':
      return { kind: 'bad', text: 'not run: changed after review' };
    case 'rejected':
      return { kind: 'neutral', text: `rejected${a.decisionNote ? `: ${a.decisionNote}` : ''}` };
    default:
      return { kind: 'neutral', text: a.status };
  }
}

const ICON = {
  ok: <CircleCheck className="h-3.5 w-3.5 shrink-0 text-emerald-400" aria-label="succeeded" />,
  bad: <CircleAlert className="h-3.5 w-3.5 shrink-0 text-red-400" aria-label="failed" />,
  neutral: <CircleSlash className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-label="not run" />,
};

/**
 * Facts about a run's protected actions taken from Friday's own records, independent of what
 * the model wrote in its answer.
 */
export function RunRecord({ approvals }: { approvals: ApprovalDto[] }) {
  const settled = approvals.filter((a) => a.status !== 'pending' && a.status !== 'approved');
  if (settled.length === 0) return null;
  const failures = settled.filter((a) => outcome(a).kind === 'bad').length;
  return (
    <section
      aria-label="Run record"
      className="ml-10 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-xs"
    >
      <h3 className="mb-1 flex items-center gap-1.5 font-medium text-zinc-300">
        <ClipboardList className="h-3.5 w-3.5 text-zinc-400" aria-hidden />
        Run record
        <span className="font-normal text-zinc-500">
          · from Friday’s logs, not the model
          {failures > 0 && <span className="text-red-400"> · {failures} did not succeed</span>}
        </span>
      </h3>
      <ul className="space-y-0.5">
        {settled.map((a) => {
          const o = outcome(a);
          return (
            <li key={a.id} className="flex items-center gap-2">
              {ICON[o.kind]}
              <span className="font-mono text-zinc-300">{a.title}</span>
              <span className={o.kind === 'bad' ? 'text-red-300' : 'text-zinc-500'}>{o.text}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
