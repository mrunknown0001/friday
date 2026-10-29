import type { ToolCallStatus } from '@friday/shared';
import { Ban, Check, ChevronRight, CircleSlash, Loader2, X } from 'lucide-react';
import { useState } from 'react';
import { cn } from '../lib/cn';

export interface ToolItem {
  key: string;
  name: string;
  arguments: string;
  status: ToolCallStatus | 'running';
  summary: string;
  durationMs: number | null;
  /** Full result text, available once the result is persisted. */
  output?: string | undefined;
  truncated?: boolean | undefined;
}

/** Compact, human-readable form of a tool call's arguments. */
export function toolLabel(name: string, argsJson: string): string {
  let a: Record<string, unknown>;
  try {
    a = JSON.parse(argsJson || '{}') as Record<string, unknown>;
  } catch {
    return argsJson.slice(0, 80);
  }
  const str = (v: unknown) =>
    typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v);
  switch (name) {
    case 'read_file':
      return a.start_line || a.end_line
        ? `${str(a.path)}:${str(a.start_line ?? 1)}-${str(a.end_line ?? '')}`
        : str(a.path);
    case 'search_code':
      return `"${str(a.query)}"${a.path && a.path !== '.' ? ` in ${str(a.path)}` : ''}${a.glob ? ` (${str(a.glob)})` : ''}`;
    case 'list_directory':
      return str(a.path ?? '.');
    case 'find_files':
      return str(a.pattern);
    case 'file_info':
      return str(a.path);
    case 'update_plan':
      return Array.isArray(a.steps) ? `${a.steps.length} steps` : '';
    case 'inspect_project':
      return '';
    default:
      return Object.values(a).map(str).join(' ').slice(0, 80);
  }
}

const STATUS_ICON = {
  running: <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-400" aria-label="running" />,
  completed: <Check className="h-3.5 w-3.5 text-emerald-400" aria-label="completed" />,
  error: <X className="h-3.5 w-3.5 text-red-400" aria-label="failed" />,
  denied: <Ban className="h-3.5 w-3.5 text-amber-400" aria-label="denied" />,
  skipped: <CircleSlash className="h-3.5 w-3.5 text-zinc-500" aria-label="skipped" />,
} as const;

function ToolRow({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false);
  const expandable = !!item.output;
  const label = toolLabel(item.name, item.arguments);
  return (
    <li>
      <button
        type="button"
        disabled={!expandable}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={expandable ? open : undefined}
        className={cn(
          'flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs',
          expandable && 'hover:bg-zinc-800/70',
        )}
      >
        <ChevronRight
          className={cn(
            'h-3 w-3 shrink-0 text-zinc-500 transition-transform',
            open && 'rotate-90',
            !expandable && 'opacity-0',
          )}
          aria-hidden
        />
        {STATUS_ICON[item.status]}
        <span className="font-mono text-zinc-200">{item.name}</span>
        {label && <span className="min-w-0 truncate font-mono text-zinc-400">{label}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-2 pl-2 text-zinc-500">
          {item.summary && <span className="max-w-72 truncate">{item.summary}</span>}
          {item.durationMs !== null && item.status !== 'running' && (
            <span>{item.durationMs} ms</span>
          )}
        </span>
      </button>
      {open && item.output && (
        <pre className="mx-2 mb-1 mt-0.5 max-h-80 overflow-auto rounded border border-zinc-800 bg-zinc-950 p-2 font-mono text-[0.75rem] leading-snug text-zinc-300">
          {item.output}
          {item.truncated && '\n[output was truncated before being sent to the model]'}
        </pre>
      )}
    </li>
  );
}

/** A group of consecutive tool calls, shown as a compact timeline. */
export function ToolActivity({ items }: { items: ToolItem[] }) {
  if (items.length === 0) return null;
  return (
    <div className="ml-10 rounded-lg border border-zinc-800 bg-zinc-900/40 py-1">
      <ul aria-label="Tool activity">
        {items.map((item) => (
          <ToolRow key={item.key} item={item} />
        ))}
      </ul>
    </div>
  );
}
