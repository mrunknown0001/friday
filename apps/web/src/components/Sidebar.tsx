import type { SessionSummaryDto } from '@friday/shared';
import { MessageSquarePlus, Pencil, Settings, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { cn } from '../lib/cn';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { RUN_STATUS_TONE } from './status';

interface Props {
  sessions: SessionSummaryDto[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onOpenSettings: () => void;
  settingsWarning: boolean;
}

export function Sidebar({
  sessions,
  activeId,
  onSelect,
  onNew,
  onRename,
  onDelete,
  onOpenSettings,
  settingsWarning,
}: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const commitRename = (id: string) => {
    const title = draft.trim();
    if (title) onRename(id, title);
    setEditing(null);
  };

  return (
    <aside className="flex w-72 shrink-0 flex-col border-r border-zinc-800 bg-zinc-900/40">
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="grid h-7 w-7 place-items-center rounded-md bg-sky-600 text-sm font-bold">
            F
          </div>
          <span className="font-semibold tracking-tight">Friday</span>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={onNew}
          aria-label="New conversation"
          title="New conversation"
        >
          <MessageSquarePlus className="h-4 w-4" />
        </Button>
      </div>

      <nav aria-label="Conversations" className="flex-1 overflow-y-auto px-2 pb-2">
        <h2 className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
          Conversations
        </h2>
        {sessions.length === 0 && (
          <p className="px-2 py-3 text-sm text-zinc-500">No conversations yet.</p>
        )}
        <ul className="space-y-0.5">
          {sessions.map((s) => (
            <li key={s.id}>
              {editing === s.id ? (
                <input
                  autoFocus
                  aria-label="Conversation title"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => commitRename(s.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename(s.id);
                    if (e.key === 'Escape') setEditing(null);
                  }}
                  className="w-full rounded-md border border-sky-600 bg-zinc-900 px-2 py-1.5 text-sm outline-none"
                />
              ) : (
                <div
                  className={cn(
                    'group flex items-center gap-1 rounded-md pr-1',
                    s.id === activeId
                      ? 'bg-zinc-800 text-zinc-50'
                      : 'text-zinc-300 hover:bg-zinc-800/60',
                  )}
                >
                  <button
                    type="button"
                    onClick={() => onSelect(s.id)}
                    aria-current={s.id === activeId ? 'page' : undefined}
                    className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm"
                  >
                    <span className="truncate">{s.title}</span>
                    {s.lastRunStatus && s.lastRunStatus !== 'completed' && (
                      <Badge tone={RUN_STATUS_TONE[s.lastRunStatus]}>{s.lastRunStatus}</Badge>
                    )}
                  </button>
                  <button
                    type="button"
                    aria-label={`Rename ${s.title}`}
                    onClick={() => {
                      setDraft(s.title);
                      setEditing(s.id);
                    }}
                    className="rounded p-1 text-zinc-500 opacity-0 hover:text-zinc-200 focus:opacity-100 group-hover:opacity-100"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${s.title}`}
                    onClick={() => {
                      if (
                        window.confirm(
                          `Delete "${s.title}"? This permanently removes its messages.`,
                        )
                      )
                        onDelete(s.id);
                    }}
                    className="rounded p-1 text-zinc-500 opacity-0 hover:text-red-400 focus:opacity-100 group-hover:opacity-100"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </nav>

      <div className="border-t border-zinc-800 p-2">
        <Button variant="ghost" className="w-full justify-start" onClick={onOpenSettings}>
          <Settings className="h-4 w-4" />
          Settings
          {settingsWarning && (
            <Badge tone="warning" className="ml-auto">
              setup needed
            </Badge>
          )}
        </Button>
      </div>
    </aside>
  );
}
