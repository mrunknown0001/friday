import type { LoadTestDto } from '@friday/shared';
import { Check, Gauge, X } from 'lucide-react';
import { duration } from './TestRunCard';
import { Badge } from './ui/badge';

const STATUS: Record<
  LoadTestDto['status'],
  { label: string; tone: 'success' | 'danger' | 'warning' }
> = {
  passed: { label: 'passed', tone: 'success' },
  failed: { label: 'thresholds failed', tone: 'danger' },
  error: { label: 'could not run', tone: 'warning' },
};

const pct = (r: number) => `${(r * 100).toFixed(r && r < 0.001 ? 3 : 2)}%`;
const ms = (n: number | null) => (n === null ? '–' : `${n.toLocaleString()} ms`);

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[0.7rem] text-zinc-500">{label}</dt>
      <dd className="font-mono text-sm text-zinc-100">{value}</dd>
    </div>
  );
}

/** A run_load_test result: throughput, latency, errors, thresholds and each request. */
export function LoadTestCard({ test }: { test: LoadTestDto }) {
  const s = STATUS[test.status];
  const where =
    test.target.environment === 'local'
      ? 'this machine'
      : `${test.target.name ?? ''} (${test.target.environment})`;
  return (
    <section
      aria-label={`Load test: ${s.label}`}
      className="ml-10 rounded-lg border border-zinc-800 bg-zinc-900/40 text-sm"
    >
      <header className="flex flex-wrap items-center gap-2 px-3 py-2">
        <Gauge className="h-4 w-4 text-zinc-400" aria-hidden />
        <h2 className="font-medium text-zinc-200">Load test</h2>
        <span className="min-w-0 truncate text-xs text-zinc-400">
          <span className="font-mono">{test.target.origin}</span> · {where}
        </span>
        <span className="ml-auto flex items-center gap-1">
          <Badge tone={s.tone}>{s.label}</Badge>
          <span className="text-xs text-zinc-500">{duration(test.durationMs)}</span>
        </span>
      </header>
      {test.error && (
        <p
          role="alert"
          className="mx-3 mb-2 whitespace-pre-wrap break-words rounded-md border border-amber-900/60 bg-amber-950/30 p-2 text-xs text-amber-100"
        >
          {test.error}
        </p>
      )}
      {test.requests > 0 && (
        <>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-zinc-800/70 px-3 py-2 sm:grid-cols-4">
            <Stat label="Requests" value={`${test.requests.toLocaleString()} (${test.rate}/s)`} />
            <Stat label="Failed" value={pct(test.failedRate)} />
            <Stat label="p95 latency" value={ms(test.latency?.p95 ?? null)} />
            <Stat label="p99 latency" value={ms(test.latency?.p99 ?? null)} />
            <Stat label="Median" value={ms(test.latency?.med ?? null)} />
            <Stat label="Max" value={ms(test.latency?.max ?? null)} />
            <Stat label="Virtual users" value={String(test.vusMax)} />
          </dl>
          {test.thresholds.length > 0 && (
            <section aria-label="Thresholds" className="border-t border-zinc-800/70 px-3 py-2">
              <h3 className="mb-1 text-xs font-medium text-zinc-400">Thresholds</h3>
              <ul className="space-y-0.5 text-xs">
                {test.thresholds.map((t) => (
                  <li key={`${t.metric} ${t.condition}`} className="flex items-center gap-2">
                    {t.ok ? (
                      <Check
                        className="h-3.5 w-3.5 text-emerald-400"
                        role="img"
                        aria-label="passed"
                      />
                    ) : (
                      <X className="h-3.5 w-3.5 text-red-400" role="img" aria-label="failed" />
                    )}
                    <span className="font-mono text-zinc-200">
                      {t.metric} {t.condition}
                    </span>
                    {t.actual && <span className="text-zinc-500">measured {t.actual}</span>}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {test.perRequest.length > 0 && (
            <section aria-label="Per request" className="border-t border-zinc-800/70 px-3 py-2">
              <h3 className="mb-1 text-xs font-medium text-zinc-400">Per request</h3>
              <table className="w-full text-left text-xs">
                <thead className="text-zinc-500">
                  <tr>
                    <th className="font-normal">Request</th>
                    <th className="font-normal">Count</th>
                    <th className="font-normal">Failed</th>
                    <th className="font-normal">Avg</th>
                    <th className="font-normal">p95</th>
                    <th className="font-normal">Status</th>
                  </tr>
                </thead>
                <tbody className="font-mono text-zinc-200">
                  {test.perRequest.map((r) => (
                    <tr key={r.name}>
                      <td className="max-w-48 truncate font-sans">{r.name}</td>
                      <td>{r.count.toLocaleString()}</td>
                      <td className={r.failedRate > 0 ? 'text-red-300' : ''}>
                        {pct(r.failedRate)}
                      </td>
                      <td>{ms(r.avg)}</td>
                      <td>{ms(r.p95)}</td>
                      <td className="text-zinc-400">
                        {r.statuses
                          .map((x) => `${x.status || 'none'} × ${x.count.toLocaleString()}`)
                          .join(', ')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {test.perRequest.some((r) => r.errorSamples.length > 0) && (
                <ul aria-label="First unexpected answers" className="mt-2 space-y-0.5 text-xs">
                  {test.perRequest.flatMap((r) =>
                    r.errorSamples.map((e) => (
                      <li key={`${r.name}:${e.status}`} className="break-words">
                        <span className="text-zinc-400">
                          {r.name} · first {e.status || 'failed'} answer:
                        </span>{' '}
                        <span className="font-mono text-amber-200">{e.body || '(empty)'}</span>
                      </li>
                    )),
                  )}
                </ul>
              )}
            </section>
          )}
        </>
      )}
    </section>
  );
}
