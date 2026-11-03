import type { SearchResultDto } from '@friday/shared';
import { CaseSensitive, Loader2, Regex, Search, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import { cn } from '../lib/cn';

const DEBOUNCE_MS = 300;

function Toggle({
  on,
  onChange,
  label,
  children,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  label: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={label}
      title={label}
      onClick={() => onChange(!on)}
      className={cn(
        'rounded p-1',
        on ? 'bg-sky-900/70 text-sky-200' : 'text-zinc-500 hover:text-zinc-200',
      )}
    >
      {children}
    </button>
  );
}

/**
 * Search the project's files (text or regex, the same search Friday uses). While there is a query
 * it shows the results instead of `children` (the file tree); a result opens at its line.
 */
export function ProjectSearch({
  projectId,
  onOpen,
  children,
}: {
  projectId: string;
  onOpen: (path: string, line: number) => void;
  children: ReactNode;
}) {
  const [query, setQuery] = useState('');
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [glob, setGlob] = useState('');
  const [result, setResult] = useState<{ key: string; data: SearchResultDto } | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);

  const q = query.trim();
  const key = JSON.stringify([projectId, q, regex, caseSensitive, glob.trim()]);
  useEffect(() => {
    if (!q) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      api
        .searchProject(
          projectId,
          { query: q, regex, caseSensitive, ...(glob.trim() ? { glob: glob.trim() } : {}) },
          ctrl.signal,
        )
        .then((data) => setResult({ key, data }))
        .catch((e: unknown) => {
          if (ctrl.signal.aborted) return;
          setError({ key, message: e instanceof Error ? e.message : String(e) });
        });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
    // `key` stands for the inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const shown = q && result?.key === key ? result.data : null;
  const failed = q && error?.key === key ? error.message : null;
  const searching = !!q && !shown && !failed;
  const byFile = new Map<string, SearchResultDto['matches']>();
  for (const m of shown?.matches ?? []) byFile.set(m.path, [...(byFile.get(m.path) ?? []), m]);

  return (
    <>
      <div className="mb-2 space-y-1 px-2">
        <div className="flex items-center gap-1 rounded-md border border-zinc-800 bg-zinc-950 px-1.5 focus-within:border-zinc-600">
          <Search className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden />
          <input
            type="search"
            aria-label="Search in files"
            placeholder={regex ? 'Regex, e.g. ^export (function|const)' : 'Search in files…'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setQuery('');
            }}
            maxLength={500}
            className="min-w-0 flex-1 bg-transparent py-1 text-xs text-zinc-100 outline-none placeholder:text-zinc-500 [&::-webkit-search-cancel-button]:hidden"
          />
          {query && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setQuery('')}
              className="rounded p-0.5 text-zinc-500 hover:text-zinc-200"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
          <Toggle on={caseSensitive} onChange={setCaseSensitive} label="Match case">
            <CaseSensitive className="h-3.5 w-3.5" />
          </Toggle>
          <Toggle on={regex} onChange={setRegex} label="Use regular expression">
            <Regex className="h-3.5 w-3.5" />
          </Toggle>
        </div>
        {q && (
          <input
            aria-label="Files to include"
            placeholder="Files to include, e.g. *.ts or src/**/*.php"
            value={glob}
            onChange={(e) => setGlob(e.target.value)}
            maxLength={200}
            className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-xs text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-zinc-600"
          />
        )}
      </div>
      {!q ? (
        children
      ) : (
        <div
          className="min-h-0 flex-1 overflow-y-auto px-2 text-xs"
          aria-live="polite"
          aria-busy={searching}
        >
          {searching && (
            <p className="flex items-center gap-1.5 px-1 text-zinc-500">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Searching…
            </p>
          )}
          {failed && (
            <p role="alert" className="px-1 text-red-400">
              {failed}
            </p>
          )}
          {shown && (
            <>
              <p className="mb-1 px-1 text-zinc-500">
                {shown.matches.length === 0
                  ? 'No matches.'
                  : `${shown.matches.length}${shown.truncated ? '+' : ''} result${shown.matches.length === 1 ? '' : 's'} in ${byFile.size} file${byFile.size === 1 ? '' : 's'}`}
                {shown.truncated && ' (showing the first ones; narrow the search)'}
              </p>
              <ul aria-label="Search results" className="space-y-1.5">
                {[...byFile.entries()].map(([path, lines]) => (
                  <li key={path}>
                    <p className="truncate px-1 font-medium text-zinc-300" title={path}>
                      {path}
                    </p>
                    <ul>
                      {lines.map((m) => (
                        <li key={m.line}>
                          <button
                            type="button"
                            onClick={() => onOpen(m.path, m.line)}
                            aria-label={`${m.path} line ${m.line}`}
                            className="flex w-full gap-2 rounded px-1 py-0.5 text-left font-mono text-[11px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                          >
                            <span className="w-8 shrink-0 text-right text-zinc-600">{m.line}</span>
                            <span className="truncate">{m.text.trim()}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </>
  );
}
