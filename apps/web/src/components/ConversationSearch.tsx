import type { SessionSearchResultDto } from '@friday/shared';
import { Loader2, Search, X } from 'lucide-react';
import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import { cn } from '../lib/cn';

const DEBOUNCE_MS = 200;

export interface ConversationSearchState {
  /** The trimmed query the results are for; empty when not searching. */
  query: string;
  results: SessionSearchResultDto[] | null;
  error: string | null;
  busy: boolean;
}

/** Searches the project's conversations (titles and messages) shortly after typing stops. */
export function useConversationSearch(
  query: string,
  projectId: string | null,
): ConversationSearchState {
  const q = query.trim();
  const key = `${projectId ?? 'none'}\n${q}`;
  // The latest answer, tagged with the search it answers; busy until it matches the current one.
  const [answer, setAnswer] = useState<{
    key: string;
    results: SessionSearchResultDto[] | null;
    error: string | null;
  } | null>(null);

  useEffect(() => {
    if (!q) return;
    let stale = false;
    const timer = setTimeout(() => {
      api
        .searchSessions(q, projectId)
        .then((r) => !stale && setAnswer({ key, results: r.results, error: null }))
        .catch(
          (e: unknown) =>
            !stale &&
            setAnswer({ key, results: null, error: e instanceof Error ? e.message : String(e) }),
        );
    }, DEBOUNCE_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [q, projectId, key]);

  if (!q) return { query: '', results: null, error: null, busy: false };
  const current = answer?.key === key;
  return {
    query: q,
    // Until the new results arrive, keep showing the previous ones.
    results: answer?.results ?? null,
    error: current ? answer.error : null,
    busy: !current,
  };
}

export function ConversationSearch({
  query,
  onChange,
  busy,
}: {
  query: string;
  onChange: (query: string) => void;
  busy: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-950 px-2 focus-within:border-zinc-600">
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-zinc-500" aria-hidden />
      ) : (
        <Search className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden />
      )}
      <input
        type="search"
        aria-label="Search conversations"
        placeholder="Search conversations…"
        value={query}
        maxLength={200}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && query) {
            e.preventDefault();
            onChange('');
          }
        }}
        className="min-w-0 flex-1 bg-transparent py-1 text-sm outline-none placeholder:text-zinc-500 [&::-webkit-search-cancel-button]:hidden"
      />
      {query && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => onChange('')}
          className="rounded p-0.5 text-zinc-500 hover:text-zinc-200"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

/** `text` with each case-insensitive occurrence of `needle` marked. */
export function highlight(text: string, needle: string): ReactNode {
  if (!needle) return text;
  const lower = text.toLowerCase();
  const n = needle.toLowerCase();
  const parts: ReactNode[] = [];
  let from = 0;
  for (let at = lower.indexOf(n); at !== -1; at = lower.indexOf(n, from)) {
    parts.push(text.slice(from, at));
    parts.push(
      <mark key={at} className="rounded-sm bg-amber-500/30 text-inherit">
        {text.slice(at, at + n.length)}
      </mark>,
    );
    from = at + n.length;
  }
  parts.push(text.slice(from));
  return parts.map((p, i) => <Fragment key={i}>{p}</Fragment>);
}

export function SearchResults({
  query,
  results,
  error,
  activeId,
  onSelect,
}: {
  query: string;
  results: SessionSearchResultDto[] | null;
  error: string | null;
  activeId: string | null;
  onSelect: (id: string) => void;
}) {
  if (error) {
    return (
      <p role="alert" className="px-2 py-3 text-sm text-red-300">
        {error}
      </p>
    );
  }
  if (!results) return null;
  if (results.length === 0) {
    return (
      <p className="px-2 py-3 text-sm text-zinc-500" role="status">
        No conversation mentions “{query}”.
      </p>
    );
  }
  return (
    <ul aria-label="Search results" className="space-y-0.5">
      {results.map((r) => (
        <li key={r.session.id}>
          <button
            type="button"
            onClick={() => onSelect(r.session.id)}
            aria-current={r.session.id === activeId ? 'page' : undefined}
            className={cn(
              'w-full rounded-md px-2 py-1.5 text-left',
              r.session.id === activeId
                ? 'bg-zinc-800 text-zinc-50'
                : 'text-zinc-300 hover:bg-zinc-800/60',
            )}
          >
            <span className="block truncate text-sm">
              {r.titleMatch ? highlight(r.session.title, query) : r.session.title}
            </span>
            {r.snippet && (
              <span className="mt-0.5 line-clamp-2 text-xs text-zinc-500 [overflow-wrap:anywhere]">
                {highlight(r.snippet, query)}
              </span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}
