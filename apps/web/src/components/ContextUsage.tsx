import type { ContextUsageDto, TokenOptimization, UsageSummaryDto } from '@friday/shared';
import { useState } from 'react';
import { cn } from '../lib/cn';
import { compact } from './UsageSettings';

/**
 * Categorical slots 1-4 of the reference dark palette, in fixed order; validated on the zinc-900
 * dialog (lightness band, chroma, CVD ΔE ≥ 8.4 between neighbours, ≥ 3:1 contrast).
 */
const PARTS = [
  { key: 'system', label: 'System prompt', color: '#3987e5' },
  { key: 'tools', label: 'Tool definitions', color: '#d95926' },
  { key: 'history', label: 'Messages', color: '#199e70' },
  { key: 'toolResults', label: 'Tool results', color: '#c98500' },
] as const;

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);
const sent = (c: ContextUsageDto) => c.system + c.tools + c.history + c.toolResults;
const saved = (c: ContextUsageDto) => Math.max(0, c.baseline - sent(c));

function Breakdown({ context }: { context: ContextUsageDto }) {
  const [hover, setHover] = useState<number | null>(null);
  const total = sent(context);
  const shown = PARTS.map((p) => ({ ...p, value: context[p.key] })).filter((p) => p.value > 0);
  const h = hover === null ? null : shown[hover];
  // Where the hovered segment starts and ends, as a share of the bar.
  const start = hover === null ? 0 : shown.slice(0, hover).reduce((n, p) => n + p.value, 0) / total;
  const end = h ? start + h.value / total : 0;
  return (
    <figure className="mt-2" aria-label="Where chat requests' input went">
      <div className="relative">
        <div className="flex h-3 gap-[2px]" onMouseLeave={() => setHover(null)}>
          {shown.map((p, i) => (
            <div
              key={p.key}
              data-testid="context-part"
              className={cn(
                'h-full first:rounded-l last:rounded-r',
                hover === i && 'brightness-125',
              )}
              style={{ flexGrow: p.value, flexBasis: 0, minWidth: 3, background: p.color }}
              onMouseEnter={() => setHover(i)}
            />
          ))}
        </div>
        {h && (
          <div
            role="tooltip"
            className="pointer-events-none absolute -top-1 z-10 whitespace-nowrap rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-[11px] text-zinc-300 shadow-lg"
            style={{
              // Above the bar, growing away from the nearer edge so it stays inside the dialog.
              ...(start + end < 1 ? { left: `${start * 100}%` } : { right: `${(1 - end) * 100}%` }),
              transform: 'translateY(-100%)',
            }}
          >
            <span className="font-medium text-zinc-100">{h.label}</span>: ~
            {h.value.toLocaleString()} tokens ({pct(h.value, total)}%)
          </div>
        )}
      </div>
      <ul className="mt-2 grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs sm:grid-cols-4">
        {PARTS.map((p) => (
          <li key={p.key} className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{ background: p.color }}
            />
            <span className="text-zinc-300">{p.label}</span>
            <span className="ml-auto font-mono tabular-nums text-zinc-400">
              {pct(context[p.key], total)}%
            </span>
          </li>
        ))}
      </ul>
    </figure>
  );
}

/**
 * Where chat requests' input tokens went (Friday's estimates), what token optimization saved,
 * how much the provider served from its prompt cache, and the switch for the optimization.
 */
export function ContextUsage({
  usage,
  onOptimization,
  busy,
}: {
  usage: UsageSummaryDto;
  onOptimization: (o: TokenOptimization) => void;
  busy: boolean;
}) {
  const c = usage.context;
  return (
    <div className="mt-4">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-xs font-medium text-zinc-400">Where input went</h4>
        <div
          role="group"
          aria-label="Token optimization"
          title="Standard: send the core tools plus the groups a conversation loads, shorten older tool results, and keep each request under ~100K tokens. Off: every tool and the full history, up to the model's window."
          className="flex items-center gap-1 text-xs text-zinc-400"
        >
          Token optimization
          <div className="flex rounded-md border border-zinc-800 p-0.5">
            {(['standard', 'off'] as const).map((o) => (
              <button
                key={o}
                type="button"
                aria-pressed={usage.optimization === o}
                disabled={busy}
                onClick={() => usage.optimization !== o && onOptimization(o)}
                className={cn(
                  'rounded px-2 py-0.5',
                  usage.optimization === o
                    ? 'bg-zinc-800 text-zinc-100'
                    : 'text-zinc-400 hover:text-zinc-200',
                )}
              >
                {o === 'standard' ? 'Standard' : 'Off'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {c.requests === 0 ? (
        <p className="text-xs text-zinc-500">
          Nothing recorded yet: Friday notes where each chat request&apos;s input goes from now on.
        </p>
      ) : (
        <>
          <p className="text-xs text-zinc-300">
            {c.requests.toLocaleString()} chat request{c.requests === 1 ? '' : 's'}, ~
            {compact(sent(c))} tokens sent
            {saved(c) > 0 &&
              ` · optimization saved ~${compact(saved(c))} (${pct(saved(c), c.baseline)}%)`}
            {c.cachedInputTokens > 0 &&
              ` · ${pct(c.cachedInputTokens, c.inputTokens)}% of input read from the provider's cache`}
          </p>
          <Breakdown context={c} />
          {usage.recentRuns.length > 0 && (
            <div className="mt-3 overflow-x-auto rounded-md border border-zinc-800">
              <table className="w-full text-left text-xs" aria-label="Recent runs">
                <thead className="bg-zinc-900 text-zinc-400">
                  <tr>
                    <th className="px-2 py-1 font-medium">Recent run</th>
                    <th className="px-2 py-1 text-right font-medium">Requests</th>
                    <th className="px-2 py-1 text-right font-medium" title="Friday's estimate">
                      Sent
                    </th>
                    {PARTS.map((p) => (
                      <th key={p.key} className="px-2 py-1 text-right font-medium">
                        {p.label
                          .replace('Tool definitions', 'Tools')
                          .replace('System prompt', 'Prompt')}
                      </th>
                    ))}
                    <th className="px-2 py-1 text-right font-medium">Saved</th>
                    <th className="px-2 py-1 text-right font-medium">Cached</th>
                  </tr>
                </thead>
                <tbody className="font-mono tabular-nums text-zinc-300">
                  {usage.recentRuns.map((r) => (
                    <tr key={r.runId} className="border-t border-zinc-800/70">
                      <td
                        className="max-w-40 truncate px-2 py-1 font-sans"
                        title={r.title ?? 'Deleted conversation'}
                      >
                        <span className="mr-1.5 text-zinc-500">
                          {new Date(r.startedAt).toLocaleTimeString(undefined, {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </span>
                        {r.title ?? 'Deleted conversation'}
                      </td>
                      <td className="px-2 py-1 text-right">{r.requests}</td>
                      <td className="px-2 py-1 text-right">~{compact(sent(r))}</td>
                      {PARTS.map((p) => (
                        <td key={p.key} className="px-2 py-1 text-right">
                          {pct(r[p.key], sent(r))}%
                        </td>
                      ))}
                      <td className="px-2 py-1 text-right">{pct(saved(r), r.baseline)}%</td>
                      <td className="px-2 py-1 text-right">
                        {pct(r.cachedInputTokens, r.inputTokens)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-1 text-[11px] text-zinc-500">
            Shares and savings are Friday&apos;s estimates (about 3.5 characters per token); cache
            hits are what the provider reported (Anthropic, OpenAI, OpenRouter and Gemini report
            them; NoTokenLimit reports no usage on streamed replies).
          </p>
        </>
      )}
    </div>
  );
}
