import type {
  MemoryCategory,
  MemoryDto,
  MemoryScope,
  MemorySettingsDto,
  ProjectDto,
} from '@friday/shared';
import { Check, Download, Pencil, Pin, PinOff, Plus, Search, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { cn } from '../lib/cn';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';

const CATEGORIES: MemoryCategory[] = [
  'preference',
  'architecture',
  'stack',
  'command',
  'environment',
  'deployment',
  'known_issue',
  'decision',
  'procedure',
  'lesson',
  'objective',
  'progress',
  'discovery',
  'rejected_approach',
  'blocker',
];

type Filter = 'all' | 'user' | 'project' | 'operational' | 'session';
const input =
  'rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm outline-none focus:border-sky-500';
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function MemoryRow({
  m,
  onChanged,
  onError,
}: {
  m: MemoryDto;
  onChanged: () => void;
  onError: (e: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.content);
  const run = (p: Promise<unknown>) => p.then(onChanged, (e: unknown) => onError(message(e)));
  return (
    <li
      className={cn(
        'rounded-md border p-2 text-sm',
        m.pinned ? 'border-violet-800/70' : 'border-zinc-800',
      )}
    >
      <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[11px]">
        <Badge>{m.scope}</Badge>
        <Badge>{m.category.replace(/_/g, ' ')}</Badge>
        <Badge tone={m.confidence === 'confirmed' ? 'success' : 'warning'}>{m.confidence}</Badge>
        {m.status !== 'active' && (
          <Badge tone={m.status === 'pending' ? 'info' : 'neutral'}>{m.status}</Badge>
        )}
        <span className="text-zinc-500">
          by {m.source} · used {m.useCount}×{' '}
          {m.lastUsedAt ? `· last ${new Date(m.lastUsedAt).toLocaleDateString()}` : ''}
        </span>
        <div className="ml-auto flex gap-0.5">
          {m.status === 'pending' ? (
            <>
              <Button
                size="sm"
                variant="primary"
                onClick={() => void run(api.updateMemory(m.id, { status: 'active' }))}
              >
                <Check className="h-3.5 w-3.5" /> Approve
              </Button>
              <Button
                size="sm"
                onClick={() => void run(api.updateMemory(m.id, { status: 'rejected' }))}
              >
                <X className="h-3.5 w-3.5" /> Reject
              </Button>
            </>
          ) : (
            <>
              <Button
                size="icon"
                variant="ghost"
                className="h-6 w-6"
                aria-label={m.pinned ? 'Unpin memory' : 'Pin memory'}
                title={m.pinned ? 'Unpin' : 'Pin: always include'}
                onClick={() => void run(api.updateMemory(m.id, { pinned: !m.pinned }))}
              >
                {m.pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="h-6 w-6"
                aria-label="Edit memory"
                onClick={() => setEditing((e) => !e)}
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
            </>
          )}
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6"
            aria-label="Delete memory"
            onClick={() => {
              if (window.confirm('Delete this memory permanently?'))
                void run(api.deleteMemory(m.id));
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      {editing ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(api.updateMemory(m.id, { content: draft })).then(() => setEditing(false));
          }}
          className="flex gap-2"
        >
          <textarea
            aria-label="Memory text"
            className={`${input} min-h-16 flex-1`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <Button type="submit" size="sm" variant="primary">
            Save
          </Button>
        </form>
      ) : (
        <p
          className={cn('text-zinc-200', m.status === 'superseded' && 'text-zinc-500 line-through')}
        >
          {m.content}
        </p>
      )}
    </li>
  );
}

export function MemoryDialog({
  project,
  onClose,
}: {
  project: ProjectDto | null;
  onClose: () => void;
}) {
  const [settings, setSettings] = useState<MemorySettingsDto | null>(null);
  const [memories, setMemories] = useState<MemoryDto[]>([]);
  const [pending, setPending] = useState<MemoryDto[]>([]);
  const [filter, setFilter] = useState<Filter>(project ? 'project' : 'all');
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState({
    scope: (project ? 'project' : 'user') as 'user' | 'project' | 'operational',
    category: 'decision' as MemoryCategory,
    content: '',
  });

  const load = useCallback(async () => {
    try {
      const scope: MemoryScope | undefined = filter === 'all' ? undefined : filter;
      const projectFilter =
        filter === 'project' || filter === 'operational'
          ? project
            ? { projectId: project.id }
            : {}
          : {};
      const [s, list, p] = await Promise.all([
        api.memorySettings(),
        api.memories({
          ...(scope ? { scope } : {}),
          ...projectFilter,
          ...(query.trim() ? { q: query.trim() } : {}),
        }),
        api.memories({ status: 'pending' }),
      ]);
      setSettings(s);
      setMemories(list.memories.filter((m) => m.status !== 'pending' && m.status !== 'rejected'));
      setPending(p.memories);
      setError(null);
    } catch (e) {
      setError(message(e));
    }
  }, [filter, project, query]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 200);
    return () => clearTimeout(t);
  }, [load]);

  const saveSettings = async (next: MemorySettingsDto) => {
    try {
      setSettings(await api.setMemorySettings(next));
    } catch (e) {
      setError(message(e));
    }
  };
  const projectDisabled = !!project && !!settings?.disabledProjectIds.includes(project.id);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.createMemory({
        ...form,
        projectId: form.scope === 'user' ? null : (project?.id ?? null),
      });
      setForm({ ...form, content: '' });
      await load();
    } catch (err) {
      setError(message(err));
    }
  };

  return (
    <Dialog open onClose={onClose} title="Memory">
      <div className="space-y-4">
        <section className="flex flex-wrap items-center gap-4 text-sm" aria-label="Memory settings">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={settings?.enabled ?? true}
              onChange={(e) =>
                settings && void saveSettings({ ...settings, enabled: e.target.checked })
              }
            />
            Use memory
          </label>
          {project && (
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                disabled={!settings?.enabled}
                checked={!projectDisabled}
                onChange={(e) =>
                  settings &&
                  void saveSettings({
                    ...settings,
                    disabledProjectIds: e.target.checked
                      ? settings.disabledProjectIds.filter((id) => id !== project.id)
                      : [...settings.disabledProjectIds, project.id],
                  })
                }
              />
              Use memory in {project.name}
            </label>
          )}
          {project && (
            <Button
              size="sm"
              className="ml-auto"
              onClick={() =>
                void api.exportMemory(project.id).then(
                  (r) =>
                    setNotice(
                      `Exported ${r.count} memories to ${r.path} (Friday reads it as repository guidance).`,
                    ),
                  (e: unknown) => setError(message(e)),
                )
              }
            >
              <Download className="h-3.5 w-3.5" /> Export to .friday/memory.md
            </Button>
          )}
        </section>
        <p className="text-xs text-zinc-500">
          Friday saves durable facts (commands, decisions, procedures, your preferences) and shows
          the relevant ones to the model in later conversations. Project memories are never visible
          in other projects. Secrets and code are refused. Under each answer, "Used N saved
          memories" shows exactly what was included.
        </p>

        {pending.length > 0 && (
          <section aria-label="Proposed preferences">
            <h3 className="mb-1 text-sm font-semibold text-zinc-200">Waiting for your approval</h3>
            <ul className="space-y-2">
              {pending.map((m) => (
                <MemoryRow key={m.id} m={m} onChanged={() => void load()} onError={setError} />
              ))}
            </ul>
          </section>
        )}

        <section aria-label="Saved memories">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <div className="flex rounded-md border border-zinc-800 text-xs" role="tablist">
              {(['all', 'user', 'project', 'operational', 'session'] as Filter[]).map((f) => (
                <button
                  key={f}
                  type="button"
                  role="tab"
                  aria-selected={filter === f}
                  onClick={() => setFilter(f)}
                  className={cn(
                    'px-2 py-1 capitalize',
                    filter === f
                      ? 'bg-zinc-800 text-zinc-100'
                      : 'text-zinc-400 hover:text-zinc-200',
                  )}
                >
                  {f === 'project' && project ? project.name : f}
                </button>
              ))}
            </div>
            <label className="relative ml-auto">
              <Search
                className="pointer-events-none absolute left-2 top-1.5 h-3.5 w-3.5 text-zinc-500"
                aria-hidden
              />
              <input
                aria-label="Search memories"
                className={`${input} pl-7`}
                placeholder="Search…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
          </div>
          <ul className="max-h-80 space-y-2 overflow-y-auto">
            {memories.map((m) => (
              <MemoryRow key={m.id} m={m} onChanged={() => void load()} onError={setError} />
            ))}
            {memories.length === 0 && (
              <li className="text-xs text-zinc-500">No memories here yet.</li>
            )}
          </ul>
        </section>

        <form
          onSubmit={(e) => void add(e)}
          aria-label="Add memory"
          className="space-y-2 border-t border-zinc-800 pt-3"
        >
          <div className="flex gap-2 text-xs">
            <select
              aria-label="Scope"
              className={input}
              value={form.scope}
              onChange={(e) => setForm({ ...form, scope: e.target.value as typeof form.scope })}
            >
              <option value="user">user (all projects)</option>
              {project && <option value="project">project: {project.name}</option>}
              <option value="operational">operational</option>
            </select>
            <select
              aria-label="Category"
              className={input}
              value={form.category}
              onChange={(e) => setForm({ ...form, category: e.target.value as MemoryCategory })}
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c.replace(/_/g, ' ')}
                </option>
              ))}
            </select>
          </div>
          <div className="flex gap-2">
            <input
              aria-label="New memory"
              className={`${input} flex-1`}
              placeholder="e.g. Deploys run from the release branch."
              value={form.content}
              onChange={(e) => setForm({ ...form, content: e.target.value })}
              required
            />
            <Button type="submit" size="sm" variant="primary">
              <Plus className="h-3.5 w-3.5" /> Add
            </Button>
          </div>
        </form>
        {notice && (
          <p role="status" className="text-xs text-emerald-300">
            {notice}
          </p>
        )}
        {error && (
          <p role="alert" className="text-xs text-red-400">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
