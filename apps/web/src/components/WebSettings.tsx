import type { WebSettings as Settings, WebStatusDto } from '@friday/shared';
import { Loader2 } from 'lucide-react';
import { useCallback, useEffect, useId, useState } from 'react';
import { api } from '../lib/api';
import { Badge } from './ui/badge';

const input =
  'w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm outline-none focus:border-sky-500';
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Settings → Web: the switch for web access, the search key's status, and research limits. */
export function WebSettings() {
  const [status, setStatus] = useState<WebStatusDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ids = {
    heading: useId(),
    enabled: useId(),
    searches: useId(),
    pages: useId(),
    minutes: useId(),
  };

  const load = useCallback(async () => {
    try {
      setStatus(await api.web());
    } catch (e) {
      setError(message(e));
    }
  }, []);
  useEffect(() => {
    // load() only sets state after its request resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const save = (patch: Partial<Settings>) => {
    if (!status) return;
    const next = { ...status.settings, ...patch };
    setStatus({ ...status, settings: next });
    setError(null);
    void api.setWebSettings(next).catch((e: unknown) => {
      setError(message(e));
      void load();
    });
  };
  const limit = (key: 'maxSearches' | 'maxPages' | 'maxMinutes') => (value: string) => {
    const n = Math.round(Number(value));
    if (!status || !Number.isFinite(n)) return;
    save({ [key]: Math.min(status.hardLimits[key], Math.max(1, n)) });
  };

  return (
    <section className="border-b border-zinc-800 py-4 last:border-0" aria-labelledby={ids.heading}>
      <h3 id={ids.heading} className="mb-2 text-sm font-semibold text-zinc-200">
        Web
      </h3>
      <p className="mb-2 text-xs text-zinc-500">
        Friday can search the web (Tavily), read public pages and do deep research. Only search
        queries and page addresses leave this machine: never file contents or secrets, and queries
        that look like code, paths, private hosts or secrets are refused. Every query and page shows
        in the tool activity. Pages on this machine or your local network are never fetched.
      </p>
      {!status ? (
        <Loader2 className="h-4 w-4 animate-spin text-zinc-500" aria-label="Loading web settings" />
      ) : (
        <>
          <label htmlFor={ids.enabled} className="flex items-center gap-2 text-sm text-zinc-200">
            <input
              id={ids.enabled}
              type="checkbox"
              className="accent-sky-500"
              checked={status.settings.enabled}
              onChange={(e) => save({ enabled: e.target.checked })}
            />
            Let Friday search the web and read pages
          </label>
          <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-zinc-400">
            Search:
            {status.searchConfigured ? (
              <Badge tone="success">Tavily key set</Badge>
            ) : (
              <>
                <Badge tone="warning">no key</Badge>
                <span>
                  Create a key at{' '}
                  <a
                    href="https://tavily.com"
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-sky-300 hover:underline"
                  >
                    tavily.com
                  </a>
                  , add <code className="font-mono">TAVILY_API_KEY=…</code> to{' '}
                  <code className="font-mono">{status.envFile}</code> and restart Friday. Reading
                  pages works without it.
                </span>
              </>
            )}
          </p>
          <fieldset className="mt-3" disabled={!status.settings.enabled}>
            <legend className="mb-1 text-xs text-zinc-400">Limits for each deep research</legend>
            <div className="grid grid-cols-3 gap-2 text-xs">
              {(
                [
                  ['maxSearches', ids.searches, 'Searches'],
                  ['maxPages', ids.pages, 'Pages read'],
                  ['maxMinutes', ids.minutes, 'Minutes'],
                ] as const
              ).map(([key, id, label]) => (
                <div key={key}>
                  <label htmlFor={id}>
                    {label} <span className="text-zinc-500">(max {status.hardLimits[key]})</span>
                  </label>
                  <input
                    id={id}
                    type="number"
                    min={1}
                    max={status.hardLimits[key]}
                    className={input}
                    value={status.settings[key]}
                    onChange={(e) => limit(key)(e.target.value)}
                  />
                </div>
              ))}
            </div>
          </fieldset>
        </>
      )}
      {error && (
        <p role="alert" className="mt-1 text-xs text-red-400">
          {error}
        </p>
      )}
    </section>
  );
}
