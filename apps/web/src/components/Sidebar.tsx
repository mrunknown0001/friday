import type { ProjectDto, SessionSummaryDto } from '@friday/shared';
import {
  Activity,
  Brain,
  FolderPlus,
  FolderX,
  GitBranch,
  GitBranchPlus,
  MessageSquarePlus,
  Pencil,
  Settings,
  SlidersHorizontal,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import { cn } from '../lib/cn';
import { ConversationSearch, SearchResults, useConversationSearch } from './ConversationSearch';
import { ProjectPicker } from './ProjectPicker';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { RUN_STATUS_TONE } from './status';
import { useConfirm } from './ui/confirm';

interface Props {
  projects: ProjectDto[];
  projectId: string | null;
  onSelectProject: (id: string | null) => void;
  onAddProject: () => void;
  onRemoveProject: (id: string) => void;
  onProjectSettings: () => void;
  sessions: SessionSummaryDto[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  /** Start a conversation in a new task worktree (offered for available git projects). */
  onNewWorktree?: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onOpenSettings: () => void;
  onOpenMemory: () => void;
  onOpenMonitors: () => void;
  /** Monitors currently down (shown as a badge). */
  monitorsDown: number;
  settingsWarning: boolean;
}

export function Sidebar({
  projects,
  projectId,
  onSelectProject,
  onAddProject,
  onRemoveProject,
  onProjectSettings,
  sessions,
  activeId,
  onSelect,
  onNew,
  onNewWorktree,
  onRename,
  onDelete,
  onOpenSettings,
  onOpenMemory,
  onOpenMonitors,
  monitorsDown,
  settingsWarning,
}: Props) {
  const [confirm, confirmDialog] = useConfirm();
  const [editing, setEditing] = useState<string | null>(null);
  const current = projects.find((p) => p.id === projectId) ?? null;
  const [draft, setDraft] = useState('');
  // A search belongs to the project it was typed in; switching projects starts afresh.
  const [typed, setTyped] = useState({ projectId, text: '' });
  const query = typed.projectId === projectId ? typed.text : '';
  const setQuery = (text: string) => setTyped({ projectId, text });
  const search = useConversationSearch(query, projectId);
  const worktreeOf = (s: SessionSummaryDto) =>
    projects.find((p) => p.id === s.projectId)?.worktree ?? null;

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
        <div className="flex">
          {onNewWorktree && (
            <Button
              variant="ghost"
              size="icon"
              onClick={onNewWorktree}
              aria-label="New task in a worktree"
              title="New task in a worktree: its own folder and branch, so your checkout stays untouched until you accept"
            >
              <GitBranchPlus className="h-4 w-4" />
            </Button>
          )}
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
      </div>

      <div className="border-b border-zinc-800 px-4 pb-3">
        <div className="mb-1 flex items-center justify-between">
          <label
            htmlFor="project-select"
            className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500"
          >
            Project
          </label>
          <div className="flex">
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={onAddProject}
              aria-label="Add project"
              title="Add project"
            >
              <FolderPlus className="h-3.5 w-3.5" />
            </Button>
            {current && (
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                aria-label={`Project settings for ${current.name}`}
                title="Project settings: sandbox, external folders, code map, saved actions"
                onClick={onProjectSettings}
              >
                <SlidersHorizontal className="h-3.5 w-3.5" />
              </Button>
            )}
            {current && (
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                aria-label={`Remove project ${current.name}`}
                title="Remove project (files are not touched)"
                onClick={async () => {
                  const ok = await confirm({
                    title: `Remove “${current.name}” from Friday?`,
                    message:
                      'Files on disk are not touched. Its conversations are kept without project access.',
                    confirmLabel: 'Remove project',
                    danger: true,
                  });
                  if (ok) onRemoveProject(current.id);
                }}
              >
                <FolderX className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </div>
        <ProjectPicker
          id="project-select"
          projects={projects}
          projectId={projectId}
          onSelect={onSelectProject}
        />
        {current && (
          <p className="mt-1 truncate font-mono text-[11px] text-zinc-500" title={current.rootPath}>
            {current.rootPath}
          </p>
        )}
      </div>

      <div className="px-4 pb-1 pt-2">
        <h2 className="pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
          Conversations
        </h2>
        <ConversationSearch query={query} onChange={setQuery} busy={search.busy} />
      </div>
      <nav aria-label="Conversations" className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {search.query ? (
          <SearchResults
            query={search.query}
            results={search.results}
            error={search.error}
            activeId={activeId}
            onSelect={onSelect}
          />
        ) : (
          sessions.length === 0 && (
            <p className="px-2 py-3 text-sm text-zinc-500">No conversations yet.</p>
          )
        )}
        <ul className="space-y-0.5" hidden={!!search.query}>
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
                    {worktreeOf(s) && (
                      <GitBranch
                        className={cn(
                          'h-3.5 w-3.5 shrink-0',
                          worktreeOf(s)!.status === 'active' ? 'text-sky-400' : 'text-zinc-500',
                        )}
                        aria-label={`Task worktree, ${worktreeOf(s)!.status}`}
                      />
                    )}
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
                    onClick={async () => {
                      const ok = await confirm({
                        title: `Delete “${s.title}”?`,
                        message: 'This permanently removes its messages.',
                        confirmLabel: 'Delete',
                        danger: true,
                      });
                      if (ok) onDelete(s.id);
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
        <Button variant="ghost" className="w-full justify-start" onClick={onOpenMemory}>
          <Brain className="h-4 w-4" />
          Memory
        </Button>
        <Button variant="ghost" className="w-full justify-start" onClick={onOpenMonitors}>
          <Activity className="h-4 w-4" />
          Monitors
          {monitorsDown > 0 && (
            <Badge tone="danger" className="ml-auto">
              {monitorsDown} down
            </Badge>
          )}
        </Button>
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
      {confirmDialog}
    </aside>
  );
}
