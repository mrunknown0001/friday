import type { ProjectDto } from '@friday/shared';
import { Check, ChevronDown, Search } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { cn } from '../lib/cn';

interface Option {
  id: string | null;
  name: string;
  detail: string | null;
  missing: boolean;
}

const NO_PROJECT: Option = {
  id: null,
  name: 'No project (chat only)',
  detail: null,
  missing: false,
};

/**
 * The sidebar's project chooser: a button that opens a list you can type into, matching projects
 * by name or folder path. Worktree projects are reached through their parent, so they're not listed.
 */
export function ProjectPicker({
  id,
  projects,
  projectId,
  onSelect,
}: {
  /** For the visible "Project" label. */
  id: string;
  projects: ProjectDto[];
  projectId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const listId = useId();

  const all = useMemo<Option[]>(
    () => [
      NO_PROJECT,
      ...projects
        .filter((p) => !p.worktree)
        .map((p) => ({ id: p.id, name: p.name, detail: p.rootPath, missing: !p.available })),
    ],
    [projects],
  );
  const current = all.find((o) => o.id === projectId) ?? NO_PROJECT;
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? all.filter(
        (o) =>
          o.id !== null &&
          (o.name.toLowerCase().includes(needle) || !!o.detail?.toLowerCase().includes(needle)),
      )
    : all;

  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  // Keep the highlighted option in view while moving through a long list.
  useEffect(() => {
    if (!open) return;
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [open, active]);

  const show = () => {
    setQuery('');
    setActive(Math.max(0, all.indexOf(current)));
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  const pick = (o: Option) => {
    if (o.id !== projectId) onSelect(o.id);
    close();
  };

  return (
    <div ref={root} className="relative">
      <button
        ref={button}
        id={id}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? close() : show())}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            show();
          }
        }}
        className="flex w-full items-center gap-2 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-left text-sm outline-none focus-visible:border-sky-500"
      >
        <span className="min-w-0 flex-1 truncate">
          {current.name}
          {current.missing && <span className="text-amber-400"> (missing)</span>}
        </span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden />
      </button>
      {open && (
        <div className="absolute inset-x-0 top-full z-30 mt-1 overflow-hidden rounded-md border border-zinc-700 bg-zinc-900 shadow-lg shadow-black/40">
          <div className="flex items-center gap-2 border-b border-zinc-800 px-2">
            <Search className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden />
            <input
              ref={input}
              role="combobox"
              aria-label="Search projects"
              aria-expanded
              aria-controls={listId}
              aria-activedescendant={shown[active] ? `${listId}-${active}` : undefined}
              aria-autocomplete="list"
              placeholder="Search projects…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setActive((i) => Math.min(shown.length - 1, i + 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setActive((i) => Math.max(0, i - 1));
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  const o = shown[active];
                  if (o) pick(o);
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  close();
                } else if (e.key === 'Tab') {
                  setOpen(false);
                }
              }}
              className="min-w-0 flex-1 bg-transparent py-1.5 text-sm outline-none placeholder:text-zinc-500"
            />
          </div>
          <ul
            ref={list}
            id={listId}
            role="listbox"
            aria-label="Projects"
            className="max-h-72 overflow-y-auto py-1"
          >
            {shown.length === 0 && (
              <li className="px-3 py-2 text-xs text-zinc-500">
                No project matches “{query.trim()}”.
              </li>
            )}
            {shown.map((o, i) => (
              <li
                key={o.id ?? 'none'}
                id={`${listId}-${i}`}
                data-index={i}
                role="option"
                aria-selected={o.id === projectId}
                onPointerMove={() => setActive(i)}
                onClick={() => pick(o)}
                className={cn(
                  'flex cursor-pointer items-start gap-2 px-2 py-1.5 text-sm',
                  i === active ? 'bg-zinc-800 text-zinc-50' : 'text-zinc-300',
                )}
              >
                <Check
                  className={cn(
                    'mt-0.5 h-3.5 w-3.5 shrink-0 text-sky-400',
                    o.id !== projectId && 'invisible',
                  )}
                  aria-hidden
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">
                    {o.name}
                    {o.missing && <span className="text-amber-400"> (missing)</span>}
                  </span>
                  {o.detail && (
                    <span
                      className="block truncate font-mono text-[11px] text-zinc-500"
                      title={o.detail}
                    >
                      {o.detail}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
