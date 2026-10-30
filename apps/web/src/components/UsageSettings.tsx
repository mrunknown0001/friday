import type { ModelPrice, UsageSummaryDto, UsageTotals } from '@friday/shared';
import { Loader2, RefreshCw, Table2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { cn } from '../lib/cn';
import { Button } from './ui/button';

const RANGES = [7, 30, 90] as const;
/** Sky 600: passes the chart lightness band and 3:1 contrast on the zinc-900 dialog. */
const BAR = '#0284c7';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function compact(n: number): string {
  if (n < 1_000) return String(Math.round(n));
  for (const [div, unit] of [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ] as const)
    if (n >= div) {
      const v = n / div;
      return `${v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, '')}${unit}`;
    }
  return String(n);
}

export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function money(n: number | null): string {
  if (n === null) return '–';
  if (n > 0 && n < 0.01) return '<$0.01';
  return `$${n.toFixed(2)}`;
}

const tokens = (t: UsageTotals) => t.inputTokens + t.outputTokens;

const noUsage: UsageTotals = {
  calls: 0,
  errors: 0,
  estimatedCalls: 0,
  callsWithoutTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  durationMs: 0,
  cost: null,
};

/** "~" in front of token counts that include Friday's own estimates. */
const approx = (t: UsageTotals) => (t.estimatedCalls ? '~' : '');

/** Calls recorded before Friday estimated tokens have no count at all: not the same as zero. */
const uncounted = (t: UsageTotals) => t.calls > 0 && t.callsWithoutTokens === t.calls;

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

function UsageRow({
  label,
  muted,
  totals,
  priced,
}: {
  label: string;
  muted?: boolean;
  totals: UsageTotals;
  priced: boolean;
}) {
  return (
    <li className="flex items-center gap-2 px-2 py-1">
      <span
        className={cn('min-w-0 flex-1 truncate', muted ? 'italic text-zinc-500' : 'text-zinc-300')}
        title={label}
      >
        {label}
      </span>
      <span className="whitespace-nowrap font-mono tabular-nums text-zinc-400">
        {uncounted(totals) ? 'no count' : `${approx(totals)}${compact(tokens(totals))} tokens`}
      </span>
      <span className="w-16 whitespace-nowrap text-right font-mono tabular-nums text-zinc-400">
        {plural(totals.calls, 'call')}
      </span>
      {priced && (
        <span className="w-14 whitespace-nowrap text-right font-mono tabular-nums text-zinc-300">
          {uncounted(totals) ? '–' : money(totals.cost)}
        </span>
      )}
    </li>
  );
}

/** A clean upper bound for the axis: 1, 2 or 5 × a power of ten. */
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return ([1, 2, 5, 10].find((m) => m * p >= v) ?? 10) * p;
}

const dayLabel = (day: string) =>
  new Date(`${day}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border border-zinc-800 px-3 py-2">
      <div className="text-[11px] text-zinc-400">{label}</div>
      <div className="text-lg font-semibold text-zinc-100">{value}</div>
      {hint && <div className="text-[11px] text-zinc-500">{hint}</div>}
    </div>
  );
}

function DayChart({ days }: { days: UsageSummaryDto['byDay'] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = niceMax(Math.max(...days.map(tokens)));
  const ticks = [max, max / 2, 0];
  const h = hover === null ? null : days[hover]!;
  const mid = Math.floor((days.length - 1) / 2);

  return (
    <figure className="mt-3" aria-label="Tokens per day">
      <figcaption className="mb-1 text-xs text-zinc-400">Tokens per day</figcaption>
      <div className="flex gap-2">
        <div className="flex h-32 flex-col justify-between text-right font-mono text-[10px] tabular-nums text-zinc-500">
          {ticks.map((t) => (
            <span key={t}>{compact(t)}</span>
          ))}
        </div>
        <div className="relative min-w-0 flex-1">
          <div className="pointer-events-none absolute inset-0 flex flex-col justify-between">
            {ticks.map((t) => (
              <div key={t} className="border-t border-zinc-800" />
            ))}
          </div>
          <div
            className="relative flex h-32 items-end gap-[2px]"
            onMouseLeave={() => setHover(null)}
          >
            {days.map((d, i) => (
              <div
                key={d.day}
                data-testid="usage-day"
                className="flex h-full min-w-0 flex-1 items-end justify-center"
                onMouseEnter={() => setHover(i)}
              >
                <div
                  className={cn('w-full max-w-6 rounded-t', hover === i && 'brightness-125')}
                  style={{
                    height: `${(tokens(d) / max) * 100}%`,
                    minHeight: tokens(d) ? 2 : 0,
                    background: BAR,
                  }}
                />
              </div>
            ))}
          </div>
          {h && (
            <div
              role="tooltip"
              className="pointer-events-none absolute -top-2 z-10 w-48 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-[11px] text-zinc-300 shadow-lg"
              style={{
                // Grow away from the nearer edge so the tooltip stays inside the chart.
                ...(hover! < days.length / 2
                  ? { left: `${(hover! / days.length) * 100}%` }
                  : { right: `${(1 - (hover! + 1) / days.length) * 100}%` }),
                transform: 'translateY(-100%)',
              }}
            >
              <div className="font-medium text-zinc-100">{dayLabel(h.day)}</div>
              <div className="mt-0.5 grid grid-cols-2 gap-x-2 tabular-nums">
                <span className="text-zinc-400">Tokens in</span>
                <span className="text-right">
                  {approx(h)}
                  {h.inputTokens.toLocaleString()}
                </span>
                <span className="text-zinc-400">Tokens out</span>
                <span className="text-right">
                  {approx(h)}
                  {h.outputTokens.toLocaleString()}
                </span>
                <span className="text-zinc-400">Calls</span>
                <span className="text-right">
                  {h.calls}
                  {h.errors ? ` (${h.errors} failed)` : ''}
                </span>
                <span className="text-zinc-400">Model time</span>
                <span className="text-right">{duration(h.durationMs)}</span>
                {h.cost !== null && (
                  <>
                    <span className="text-zinc-400">Est. cost</span>
                    <span className="text-right">{money(h.cost)}</span>
                  </>
                )}
              </div>
            </div>
          )}
          <div className="mt-1 flex justify-between text-[10px] text-zinc-500">
            <span>{dayLabel(days[0]!.day)}</span>
            {days.length > 2 && <span>{dayLabel(days[mid]!.day)}</span>}
            <span>{dayLabel(days.at(-1)!.day)}</span>
          </div>
        </div>
      </div>
    </figure>
  );
}

function DayTable({ days }: { days: UsageSummaryDto['byDay'] }) {
  return (
    <div
      className="mt-3 max-h-56 overflow-y-auto rounded-md border border-zinc-800"
      tabIndex={0}
      role="region"
      aria-label="Usage per day"
    >
      <table className="w-full text-left text-xs">
        <thead className="sticky top-0 bg-zinc-900 text-zinc-400">
          <tr>
            <th className="px-2 py-1 font-medium">Day</th>
            <th className="px-2 py-1 text-right font-medium">Calls</th>
            <th className="px-2 py-1 text-right font-medium">Tokens in</th>
            <th className="px-2 py-1 text-right font-medium">Tokens out</th>
            <th className="px-2 py-1 text-right font-medium">Model time</th>
            <th className="px-2 py-1 text-right font-medium">Est. cost</th>
          </tr>
        </thead>
        <tbody className="font-mono tabular-nums text-zinc-300">
          {[...days].reverse().map((d) => (
            <tr key={d.day} className="border-t border-zinc-800/70">
              <td className="px-2 py-1">{d.day}</td>
              <td className="px-2 py-1 text-right">{d.calls}</td>
              <td className="px-2 py-1 text-right">
                {approx(d)}
                {d.inputTokens.toLocaleString()}
              </td>
              <td className="px-2 py-1 text-right">
                {approx(d)}
                {d.outputTokens.toLocaleString()}
              </td>
              <td className="px-2 py-1 text-right">{duration(d.durationMs)}</td>
              <td className="px-2 py-1 text-right">{money(d.cost)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type PriceDraft = Record<string, { input: string; output: string }>;

const toDraft = (prices: Record<string, ModelPrice>): PriceDraft =>
  Object.fromEntries(
    Object.entries(prices).map(([m, p]) => [
      m,
      { input: String(p.input), output: String(p.output) },
    ]),
  );

const priceInput =
  'w-16 rounded border border-zinc-700 bg-zinc-950 px-1 py-0.5 text-right font-mono text-xs outline-none focus:border-sky-500';

/** Tokens, calls and model time per day, model and conversation, with an optional cost estimate. */
export function UsageSettings() {
  const [days, setDays] = useState<(typeof RANGES)[number]>(30);
  const [usage, setUsage] = useState<UsageSummaryDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showTable, setShowTable] = useState(false);
  const [draft, setDraft] = useState<PriceDraft>({});
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (range: number) => {
    setLoading(true);
    try {
      const u = await api.usage(range, -new Date().getTimezoneOffset());
      setUsage(u);
      setDraft(toDraft(u.prices));
      setError(null);
    } catch (e) {
      setError(message(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // The loader only sets state after its fetch resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(days);
  }, [days, load]);

  const models = useMemo(() => {
    if (!usage) return [];
    const seen = new Set(usage.byModel.map((m) => m.model));
    const priceOnly = Object.keys(usage.prices)
      .filter((m) => !seen.has(m))
      .map((model) => ({ model, ...noUsage }));
    return [...usage.byModel.filter((m) => m.model !== '-'), ...priceOnly];
  }, [usage]);

  const parsedDraft = useMemo(() => {
    const out: Record<string, ModelPrice> = {};
    for (const [model, p] of Object.entries(draft)) {
      if (!p.input.trim() && !p.output.trim()) continue;
      const input = Number(p.input || 0);
      const output = Number(p.output || 0);
      if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0)
        return null;
      out[model] = { input, output };
    }
    return out;
  }, [draft]);
  const dirty =
    !!usage && parsedDraft !== null && JSON.stringify(parsedDraft) !== JSON.stringify(usage.prices);

  const savePrices = async () => {
    if (!parsedDraft) return;
    setSaving(true);
    try {
      await api.saveUsagePrices(parsedDraft);
      await load(days);
    } catch (e) {
      setError(message(e));
    } finally {
      setSaving(false);
    }
  };

  const setPrice = (model: string, side: 'input' | 'output', value: string) =>
    setDraft((d) => ({
      ...d,
      [model]: { input: '', output: '', ...d[model], [side]: value.replace(/[^0-9.]/g, '') },
    }));

  const priced = !!usage && Object.keys(usage.prices).length > 0;
  const empty = !!usage && usage.totals.calls === 0;

  return (
    <section className="border-b border-zinc-800 py-4 last:border-0">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-zinc-200">Usage</h3>
        <div className="flex items-center gap-1">
          <div
            role="group"
            aria-label="Range"
            className="flex rounded-md border border-zinc-800 p-0.5"
          >
            {RANGES.map((r) => (
              <button
                key={r}
                type="button"
                aria-pressed={days === r}
                onClick={() => setDays(r)}
                className={cn(
                  'whitespace-nowrap rounded px-2 py-0.5 text-xs',
                  days === r ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200',
                )}
              >
                {r} days
              </button>
            ))}
          </div>
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={showTable}
            aria-label="Show usage as a table"
            title="Show as a table"
            onClick={() => setShowTable((v) => !v)}
            disabled={!usage || empty}
          >
            <Table2 className="h-3.5 w-3.5" aria-hidden />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-label="Refresh usage"
            onClick={() => void load(days)}
          >
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" aria-hidden />
            )}
          </Button>
        </div>
      </div>

      {error && (
        <p role="alert" className="mb-2 text-xs text-red-400">
          {error}
        </p>
      )}

      {usage && (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat
              label="Model calls"
              value={usage.totals.calls.toLocaleString()}
              {...(usage.totals.errors ? { hint: `${usage.totals.errors} failed` } : {})}
            />
            <Stat
              label="Tokens"
              value={`${approx(usage.totals)}${compact(tokens(usage.totals))}`}
              hint={`${compact(usage.totals.inputTokens)} in · ${compact(usage.totals.outputTokens)} out`}
            />
            <Stat label="Model time" value={duration(usage.totals.durationMs)} />
            <Stat
              label="Estimated cost"
              value={money(usage.totals.cost)}
              hint={priced ? 'from your prices' : 'add prices below'}
            />
          </div>

          {empty ? (
            <p className="mt-3 text-sm text-zinc-500">
              No model calls in the last {usage.days} days.
            </p>
          ) : showTable ? (
            <DayTable days={usage.byDay} />
          ) : (
            <DayChart days={usage.byDay} />
          )}

          {usage.bySession.length > 0 && (
            <div className="mt-4">
              <h4 className="mb-1 text-xs font-medium text-zinc-400">
                Conversations using the most tokens
              </h4>
              <ul className="divide-y divide-zinc-800/70 rounded-md border border-zinc-800 text-xs">
                {usage.bySession.slice(0, 8).map((s) => (
                  <UsageRow
                    key={s.sessionId}
                    label={s.deleted ? 'Deleted conversation' : (s.title ?? '')}
                    muted={s.deleted}
                    totals={s}
                    priced={priced}
                  />
                ))}
                {usage.outsideSessions.calls > 0 && (
                  <UsageRow
                    label="Probes and connection tests"
                    muted
                    totals={usage.outsideSessions}
                    priced={priced}
                  />
                )}
              </ul>
            </div>
          )}

          {models.length > 0 && (
            <div className="mt-4">
              <h4 className="mb-1 text-xs font-medium text-zinc-400">By model</h4>
              <div className="overflow-x-auto rounded-md border border-zinc-800">
                <table className="w-full text-left text-xs">
                  <thead className="bg-zinc-900 text-zinc-400">
                    <tr>
                      <th className="px-2 py-1 font-medium">Model</th>
                      <th className="px-2 py-1 text-right font-medium">Calls</th>
                      <th className="px-2 py-1 text-right font-medium">Tokens in/out</th>
                      <th className="px-2 py-1 text-right font-medium">Time</th>
                      <th
                        className="px-2 py-1 text-right font-medium"
                        title="US dollars per million tokens, input / output"
                      >
                        $ per 1M in/out
                      </th>
                      <th className="px-2 py-1 text-right font-medium">Est. cost</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono tabular-nums text-zinc-300">
                    {models.map((m) => (
                      <tr key={m.model} className="border-t border-zinc-800/70">
                        <td className="max-w-44 truncate px-2 py-1" title={m.model}>
                          {m.model}
                        </td>
                        <td className="px-2 py-1 text-right">{m.calls}</td>
                        <td className="px-2 py-1 text-right">
                          {uncounted(m)
                            ? '–'
                            : `${approx(m)}${compact(m.inputTokens)}/${compact(m.outputTokens)}`}
                        </td>
                        <td className="px-2 py-1 text-right">{duration(m.durationMs)}</td>
                        <td className="px-2 py-1 text-right whitespace-nowrap">
                          <input
                            aria-label={`${m.model} input price per million tokens`}
                            inputMode="decimal"
                            placeholder="in"
                            value={draft[m.model]?.input ?? ''}
                            onChange={(e) => setPrice(m.model, 'input', e.target.value)}
                            className={priceInput}
                          />{' '}
                          <input
                            aria-label={`${m.model} output price per million tokens`}
                            inputMode="decimal"
                            placeholder="out"
                            value={draft[m.model]?.output ?? ''}
                            onChange={(e) => setPrice(m.model, 'output', e.target.value)}
                            className={priceInput}
                          />
                        </td>
                        <td className="px-2 py-1 text-right">
                          {uncounted(m) ? '–' : money(m.cost)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-2 flex items-center gap-2">
                <Button size="sm" onClick={() => void savePrices()} disabled={!dirty || saving}>
                  {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />} Save
                  prices
                </Button>
                {parsedDraft === null && (
                  <span className="text-xs text-red-400">Prices must be numbers.</span>
                )}
              </div>
            </div>
          )}

          <p className="mt-2 text-[11px] text-zinc-500">
            Counted from Friday&apos;s own record of each model call; no prompt or reply content.
            {usage.totals.estimatedCalls > 0 &&
              ` Token counts marked ~ include Friday's estimates (${usage.totals.estimatedCalls} of ${usage.totals.calls} calls): NoTokenLimit doesn't report usage on streamed replies, so Friday counts what it sent and received.`}
            {usage.totals.callsWithoutTokens > 0 &&
              ` ${plural(usage.totals.callsWithoutTokens, 'call')} (failed, or from before Friday estimated tokens) ${usage.totals.callsWithoutTokens === 1 ? 'has' : 'have'} no token counts.`}{' '}
            NoTokenLimit doesn&apos;t publish per-token prices, so the cost is only an estimate from
            the prices you enter.
          </p>
        </>
      )}
    </section>
  );
}
