import type { TestLocation, TestRunDto } from '@friday/shared';
import { ChevronRight, FlaskConical, Shuffle, Timer } from 'lucide-react';
import { useContext, useState } from 'react';
import { cn } from '../lib/cn';
import { ReviewActionsContext } from './ReviewCard';
import { FileViewer } from './SidePanel';
import { Badge } from './ui/badge';

const SCOPE: Record<TestRunDto['scope'], string> = {
  changed: 'tests related to the changes',
  files: 'chosen tests',
  all: 'all tests',
};

export const duration = (ms: number) =>
  ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;

const ranges = (r: Array<[number, number]>) =>
  r
    .slice(0, 6)
    .map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`))
    .join(', ') + (r.length > 6 ? ', …' : '');

/** `file:line` that opens the file at that line (when the project is available). */
function Location({ at, label }: { at: TestLocation; label?: string }) {
  const actions = useContext(ReviewActionsContext);
  const [open, setOpen] = useState(false);
  const text = label ?? `${at.file}${at.line ? `:${at.line}` : ''}`;
  if (!actions?.projectId) return <span className="font-mono text-zinc-300">{text}</span>;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="font-mono text-sky-300 hover:underline"
        title="Open the file at this line"
      >
        {text}
      </button>
      {open && (
        <FileViewer
          projectId={actions.projectId}
          path={at.file}
          line={at.line}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function Failure({
  f,
  initiallyOpen,
}: {
  f: TestRunDto['failures'][number];
  initiallyOpen: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <li className="border-t border-zinc-800/70 px-3 py-2">
      <div className="flex items-start gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={`${open ? 'Hide' : 'Show'} the error of ${f.name}`}
          className="mt-0.5 text-zinc-500 hover:text-zinc-300"
        >
          <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-90')} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="break-words text-sm text-zinc-100">
              {f.file && <span className="text-zinc-400">{f.file} › </span>}
              {f.name}
            </span>
            {f.failedBefore > 0 && (
              <Badge tone="warning">
                failed {f.failedBefore} time{f.failedBefore === 1 ? '' : 's'} before
              </Badge>
            )}
          </div>
          {f.at && (
            <div className="mt-0.5 text-xs">
              <span className="text-zinc-500">at </span>
              <Location at={f.at} />
            </div>
          )}
          {open && (
            <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap break-words rounded-md border border-zinc-800 bg-zinc-950 p-2 font-mono text-[0.75rem] text-red-200">
              {f.message}
            </pre>
          )}
        </div>
      </div>
    </li>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="border-t border-zinc-800/70 px-3 py-2">
      <h3 className="mb-1 text-xs font-medium text-zinc-400">{title}</h3>
      {children}
    </section>
  );
}

/** A run_tests result: what failed and where, flaky and slow tests, and changed-line coverage. */
export function TestRunCard({ run }: { run: TestRunDto }) {
  const c = run.counts;
  const tone = run.status === 'passed' ? 'success' : 'danger';
  const statusLabel =
    run.status === 'passed' ? 'passed' : run.status === 'failed' ? 'failed' : 'could not run';
  return (
    <section
      aria-label={`Test run: ${statusLabel}`}
      className="ml-10 rounded-lg border border-zinc-800 bg-zinc-900/40 text-sm"
    >
      <header className="flex flex-wrap items-center gap-2 px-3 py-2">
        <FlaskConical className="h-4 w-4 text-zinc-400" aria-hidden />
        <h2 className="font-medium text-zinc-200">Tests</h2>
        <span className="min-w-0 truncate text-xs text-zinc-400">
          {run.framework} · {run.suite === '.' ? 'project root' : run.suite} · {SCOPE[run.scope]}
        </span>
        <span className="ml-auto flex flex-wrap items-center gap-1">
          <Badge tone={tone}>{statusLabel}</Badge>
          {c.failed > 0 && <Badge tone="danger">{c.failed} failed</Badge>}
          <Badge tone="neutral">{c.passed} passed</Badge>
          {c.flaky > 0 && <Badge tone="warning">{c.flaky} flaky</Badge>}
          {c.skipped > 0 && <Badge tone="neutral">{c.skipped} skipped</Badge>}
          <span className="text-xs text-zinc-500">{duration(run.durationMs)}</span>
        </span>
      </header>
      {run.error && (
        <pre
          role="alert"
          className="mx-3 mb-2 overflow-x-auto whitespace-pre-wrap break-words rounded-md border border-red-900/60 bg-red-950/30 p-2 font-mono text-[0.75rem] text-red-200"
        >
          {run.error}
        </pre>
      )}
      {!run.error && c.passed + c.failed + c.flaky + c.skipped === 0 && (
        <p className="px-3 pb-2 text-xs text-zinc-400">No tests ran.</p>
      )}
      {run.failures.length > 0 && (
        <ul aria-label="Failures">
          {run.failures.map((f, i) => (
            <Failure key={`${f.file}:${f.name}:${i}`} f={f} initiallyOpen={i === 0} />
          ))}
        </ul>
      )}
      {run.flaky.length > 0 && (
        <Section title="Flaky: not caused by a code difference">
          <ul className="space-y-1 text-xs">
            {run.flaky.map((f) => (
              <li key={`${f.file}:${f.name}`} className="flex flex-wrap items-center gap-2">
                <Shuffle className="h-3 w-3 text-amber-300" aria-hidden />
                <span className="text-zinc-200">
                  {f.file && <span className="text-zinc-400">{f.file} › </span>}
                  {f.name}
                </span>
                <span className="text-zinc-500">{f.detail}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {run.coverage && (
        <Section title="Coverage of the changed lines">
          {!run.coverage.available || !run.coverage.files.length ? (
            <p className="text-xs text-zinc-400">{run.coverage.note ?? 'Not available.'}</p>
          ) : (
            <ul className="space-y-1.5 text-xs">
              {run.coverage.files.map((f) => {
                const pct = f.lines ? Math.round((f.covered / f.lines) * 100) : 100;
                const first = f.uncovered[0]?.[0] ?? null;
                return (
                  <li key={f.file}>
                    <div className="flex flex-wrap items-center gap-2">
                      <Location at={{ file: f.file, line: first }} label={f.file} />
                      {f.notLoaded ? (
                        <span className="text-amber-300">not loaded by these tests</span>
                      ) : (
                        <>
                          <span
                            className="h-1.5 w-20 overflow-hidden rounded-full bg-zinc-800"
                            aria-hidden
                          >
                            <span
                              className={cn(
                                'block h-full',
                                pct === 100
                                  ? 'bg-emerald-500'
                                  : pct >= 50
                                    ? 'bg-amber-400'
                                    : 'bg-red-500',
                              )}
                              style={{ width: `${pct}%` }}
                            />
                          </span>
                          <span className="text-zinc-300">
                            {f.covered}/{f.lines} changed lines ran
                          </span>
                        </>
                      )}
                    </div>
                    {f.uncovered.length > 0 && !f.notLoaded && (
                      <p className="text-zinc-500">never ran: {ranges(f.uncovered)}</p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Section>
      )}
      {run.slowest.length > 0 && (
        <Section title="Slowest">
          <ul className="space-y-0.5 text-xs">
            {run.slowest.map((t) => {
              const slower =
                t.usualMs !== null && t.durationMs > 2 * t.usualMs && t.durationMs > 200;
              return (
                <li key={`${t.file}:${t.name}`} className="flex items-baseline gap-2">
                  <span
                    className={cn(
                      'w-16 shrink-0 text-right font-mono',
                      slower ? 'text-amber-300' : 'text-zinc-400',
                    )}
                  >
                    {duration(t.durationMs)}
                  </span>
                  <span className="min-w-0 truncate text-zinc-300">
                    {t.file && <span className="text-zinc-500">{t.file} › </span>}
                    {t.name}
                  </span>
                  {t.usualMs !== null && (
                    <span className={cn('shrink-0', slower ? 'text-amber-300' : 'text-zinc-500')}>
                      <Timer className="mr-0.5 inline h-3 w-3" aria-hidden />
                      usually {duration(t.usualMs)}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </Section>
      )}
      <p
        className="truncate border-t border-zinc-800/70 px-3 py-1.5 font-mono text-[11px] text-zinc-500"
        title={run.command}
      >
        $ {run.command}
      </p>
    </section>
  );
}
