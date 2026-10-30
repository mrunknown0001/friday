import type {
  MonitorDetailDto,
  MonitorDto,
  MonitorInput,
  MonitorKind,
  MonitorTarget,
  ProjectDto,
  SshHostDto,
} from '@friday/shared';
import {
  Activity,
  ChevronDown,
  ChevronRight,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react';
import { cloneElement, useEffect, useId, useState, type FormEvent, type ReactElement } from 'react';
import { api } from '../lib/api';
import { cn } from '../lib/cn';
import { Badge, type Tone } from './ui/badge';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';

const input =
  'w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm outline-none focus:border-sky-500';
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

const STATUS_TONE: Record<MonitorDto['status'], Tone> = {
  up: 'success',
  down: 'danger',
  pending: 'neutral',
  paused: 'neutral',
};

const KIND_LABEL: Record<MonitorKind, string> = {
  http: 'URL',
  ssh: 'SSH host',
  process: 'Background process',
  compose: 'Compose service',
};

export function duration(fromIso: string, now = Date.now()): string {
  const min = Math.max(0, Math.round((now - Date.parse(fromIso)) / 60_000));
  if (min < 1) return 'less than a minute';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ${min % 60} min`;
  return `${Math.floor(h / 24)} days`;
}

export function targetText(t: MonitorTarget, hosts: SshHostDto[]): string {
  switch (t.kind) {
    case 'http':
      return `${t.url}${t.expectedStatus ? ` → ${t.expectedStatus}` : ''}${t.contains ? ` containing “${t.contains}”` : ''}`;
    case 'ssh': {
      const host = hosts.find((h) => h.id === t.hostId)?.name ?? 'removed host';
      return [
        host,
        t.service ? `${t.service} active` : null,
        t.diskPath ? `${t.diskPath} ≤ ${t.diskMaxPercent}%` : null,
      ]
        .filter(Boolean)
        .join(' · ');
    }
    case 'process':
      return `“${t.processName}” running`;
    case 'compose':
      return `${t.service}${t.file ? ` (${t.file})` : ''} running and healthy`;
  }
}

/** The message an Investigate click sends in a new conversation. */
export function investigatePrompt(m: MonitorDto): string {
  return `The health monitor "${m.name}" is down${m.statusSince ? ` since ${new Date(m.statusSince).toLocaleString()}` : ''}. Last result: ${m.lastMessage ?? 'unknown'}. Use monitor_status to see its history, then find out why with read-only checks first. Don't change anything without asking me.`;
}

/** Notification text for a monitor that went down or recovered. */
export function monitorNotification(m: MonitorDto, transition: 'down' | 'up') {
  return transition === 'down'
    ? { title: `“${m.name}” is down`, body: m.lastMessage ?? 'The check failed.' }
    : {
        title: `“${m.name}” recovered`,
        body: m.lastMessage ?? 'The check passes again.',
      };
}

function History({ recent }: { recent: MonitorDto['recent'] }) {
  if (!recent.length) return null;
  return (
    <div aria-label="Recent checks" className="flex h-4 items-end gap-px">
      {recent.map((c, i) => (
        <span
          key={i}
          title={`${new Date(c.at).toLocaleString()}: ${c.message}`}
          className={cn('h-full w-1.5 rounded-sm', c.ok ? 'bg-emerald-500/70' : 'bg-red-500/80')}
        />
      ))}
    </div>
  );
}

function Events({ id }: { id: string }) {
  const [detail, setDetail] = useState<MonitorDetailDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.monitor(id).then(
      (d) => live && setDetail(d),
      (e: unknown) => live && setError(message(e)),
    );
    return () => {
      live = false;
    };
  }, [id]);
  if (error) return <p className="text-xs text-red-300">{error}</p>;
  if (!detail) return <p className="text-xs text-zinc-500">Loading…</p>;
  return (
    <div className="mt-2 space-y-2 text-xs">
      <div>
        <h4 className="mb-1 font-medium text-zinc-400">Status changes</h4>
        {detail.events.length ? (
          <ul className="space-y-0.5">
            {detail.events.slice(0, 10).map((e, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-zinc-500">{new Date(e.at).toLocaleString()}</span>
                <span className={e.status === 'down' ? 'text-red-300' : 'text-emerald-300'}>
                  {e.status === 'down' ? 'Down' : 'Up'}
                </span>
                <span className="text-zinc-300">{e.message}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-zinc-500">None yet.</p>
        )}
      </div>
      <div>
        <h4 className="mb-1 font-medium text-zinc-400">Latest checks</h4>
        <ul className="space-y-0.5">
          {detail.checks.slice(0, 8).map((c, i) => (
            <li key={i} className="flex gap-2">
              <span className="text-zinc-500">{new Date(c.at).toLocaleTimeString()}</span>
              <span className={c.ok ? 'text-emerald-300' : 'text-red-300'}>
                {c.ok ? 'OK' : 'Failed'}
              </span>
              <span className="text-zinc-300">{c.message}</span>
              {c.durationMs !== null && <span className="text-zinc-500">{c.durationMs} ms</span>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function MonitorRow({
  m,
  projects,
  hosts,
  onEdit,
  onChanged,
  onError,
  onInvestigate,
}: {
  m: MonitorDto;
  projects: ProjectDto[];
  hosts: SshHostDto[];
  onEdit: () => void;
  onChanged: () => void;
  onError: (e: string) => void;
  onInvestigate: (m: MonitorDto) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = (p: Promise<unknown>) => {
    setBusy(true);
    p.then(onChanged, (e: unknown) => onError(message(e))).finally(() => setBusy(false));
  };
  const project = projects.find((p) => p.id === m.projectId);
  const toggle = () => run(api.updateMonitor(m.id, toInput({ ...m, enabled: !m.enabled })));
  return (
    <li
      aria-label={`Monitor ${m.name}`}
      className={cn(
        'rounded-md border p-2',
        m.status === 'down' ? 'border-red-900/70 bg-red-950/20' : 'border-zinc-800',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? 'Hide history' : 'Show history'}
          onClick={() => setOpen(!open)}
          className="text-zinc-500 hover:text-zinc-200"
        >
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
        <Badge tone={STATUS_TONE[m.status]}>{m.status}</Badge>
        <span className="font-medium text-zinc-100">{m.name}</span>
        <span className="text-xs text-zinc-500">
          {KIND_LABEL[m.target.kind]}
          {project ? ` · ${project.name}` : ''} · every {m.intervalMinutes} min
        </span>
        <div className="ml-auto flex items-center gap-1">
          {m.status === 'down' && (
            <Button size="sm" variant="secondary" onClick={() => onInvestigate(m)}>
              <Search className="h-3.5 w-3.5" />
              Investigate
            </Button>
          )}
          <Button
            size="icon"
            variant="ghost"
            aria-label="Check now"
            title="Check now"
            disabled={busy || !m.enabled}
            onClick={() => run(api.checkMonitor(m.id))}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', busy && 'animate-spin')} />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label={m.enabled ? 'Pause' : 'Resume'}
            title={m.enabled ? 'Pause' : 'Resume'}
            disabled={busy}
            onClick={toggle}
          >
            {m.enabled ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          </Button>
          <Button size="icon" variant="ghost" aria-label="Edit" title="Edit" onClick={onEdit}>
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Delete"
            title="Delete"
            disabled={busy}
            onClick={() => {
              if (window.confirm(`Delete the monitor “${m.name}” and its history?`))
                run(api.deleteMonitor(m.id));
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      <p className="mt-1 break-all pl-6 font-mono text-xs text-zinc-400">
        {targetText(m.target, hosts)}
      </p>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 pl-6 text-xs">
        <History recent={m.recent} />
        {m.statusSince && (m.status === 'up' || m.status === 'down') && (
          <span className={m.status === 'down' ? 'text-red-300' : 'text-zinc-400'}>
            {m.status === 'down' ? 'Down' : 'Up'} for {duration(m.statusSince)}
          </span>
        )}
        {m.lastMessage && (
          <span className={cn(m.recent.at(-1)?.ok === false ? 'text-red-300' : 'text-zinc-400')}>
            {m.lastMessage}
          </span>
        )}
        {m.status === 'up' && m.consecutiveFailures > 0 && (
          <span className="text-amber-300">
            {m.consecutiveFailures} of {m.failuresBeforeAlert} failures before alerting
          </span>
        )}
      </div>
      {open && (
        <div className="pl-6">
          <Events id={m.id} />
        </div>
      )}
    </li>
  );
}

const toInput = (m: MonitorInput): MonitorInput => ({
  name: m.name,
  projectId: m.projectId,
  target: m.target,
  intervalMinutes: m.intervalMinutes,
  failuresBeforeAlert: m.failuresBeforeAlert,
  enabled: m.enabled,
});

const DEFAULT_TARGET: Record<MonitorKind, MonitorTarget> = {
  http: { kind: 'http', url: '', expectedStatus: null, contains: null, timeoutSeconds: 10 },
  ssh: { kind: 'ssh', hostId: '', service: null, diskPath: null, diskMaxPercent: null },
  process: { kind: 'process', processName: '' },
  compose: { kind: 'compose', service: '', file: null },
};

const orNull = (v: string) => (v.trim() ? v.trim() : null);

export function MonitorForm({
  initial,
  projects,
  hosts,
  defaultProjectId,
  onSaved,
  onCancel,
}: {
  initial: MonitorDto | null;
  projects: ProjectDto[];
  hosts: SshHostDto[];
  defaultProjectId: string | null;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<MonitorInput>(
    initial
      ? toInput(initial)
      : {
          name: '',
          projectId: defaultProjectId,
          target: DEFAULT_TARGET.http,
          intervalMinutes: 5,
          failuresBeforeAlert: 2,
          enabled: true,
        },
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const uid = useId();
  const t = draft.target;
  const setTarget = (next: Partial<MonitorTarget>) =>
    setDraft({ ...draft, target: { ...t, ...next } as MonitorTarget });
  const needsProject = t.kind === 'process' || t.kind === 'compose';
  const trusted = hosts.filter((h) => h.trustedFingerprints.length);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      if (initial) await api.updateMonitor(initial.id, draft);
      else await api.createMonitor(draft);
      onSaved();
    } catch (err) {
      setError(message(err));
    } finally {
      setSaving(false);
    }
  };

  // Label and control are linked by id (a <select> inside its <label> gets its options in its name).
  const field = (label: string, control: ReactElement<{ id?: string }>, hint?: string) => {
    const id = `${uid}-${label.replace(/\W+/g, '-')}`;
    return (
      <div className="text-xs text-zinc-400">
        <label htmlFor={id}>{label}</label>
        <div className="mt-0.5">{cloneElement(control, { id })}</div>
        {hint && <span className="mt-0.5 block text-[11px] text-zinc-500">{hint}</span>}
      </div>
    );
  };

  return (
    <form
      onSubmit={save}
      aria-label="Monitor"
      className="space-y-3 rounded-md border border-zinc-800 p-3"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {field(
          'Name',
          <input
            className={input}
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="shop staging"
            required
          />,
        )}
        {field(
          'Checks',
          <select
            className={input}
            value={t.kind}
            disabled={!!initial}
            onChange={(e) =>
              setDraft({ ...draft, target: DEFAULT_TARGET[e.target.value as MonitorKind] })
            }
          >
            {(Object.keys(KIND_LABEL) as MonitorKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>,
        )}
      </div>

      {t.kind === 'http' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            {field(
              'URL',
              <input
                className={input}
                type="url"
                value={t.url}
                onChange={(e) => setTarget({ url: e.target.value })}
                placeholder="https://staging.example.com/health"
                required
              />,
              'Checked with a plain GET: no cookies or credentials. Redirects are followed on the same host only.',
            )}
          </div>
          {field(
            'Expected status',
            <input
              className={input}
              inputMode="numeric"
              value={t.expectedStatus ?? ''}
              onChange={(e) =>
                setTarget({ expectedStatus: e.target.value ? Number(e.target.value) : null })
              }
              placeholder="any 2xx or 3xx"
            />,
          )}
          {field(
            'Response contains (optional)',
            <input
              className={input}
              value={t.contains ?? ''}
              onChange={(e) => setTarget({ contains: e.target.value || null })}
              placeholder='"status":"ok"'
            />,
          )}
          {field(
            'Timeout (seconds)',
            <input
              className={input}
              type="number"
              min={1}
              max={60}
              value={t.timeoutSeconds}
              onChange={(e) => setTarget({ timeoutSeconds: Number(e.target.value) })}
            />,
          )}
        </div>
      )}

      {t.kind === 'ssh' && (
        <div className="grid gap-3 sm:grid-cols-2">
          {field(
            'SSH host',
            <select
              className={input}
              value={t.hostId}
              onChange={(e) => setTarget({ hostId: e.target.value })}
              required
            >
              <option value="">Choose a host…</option>
              {trusted.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name} ({h.environment})
                </option>
              ))}
            </select>,
            trusted.length < hosts.length
              ? 'Hosts whose key is not trusted yet are not listed (Settings › SSH hosts).'
              : undefined,
          )}
          {field(
            'systemd service must be active (optional)',
            <input
              className={input}
              value={t.service ?? ''}
              onChange={(e) => setTarget({ service: orNull(e.target.value) })}
              placeholder="nginx"
            />,
          )}
          {field(
            'Disk path (optional)',
            <input
              className={input}
              value={t.diskPath ?? ''}
              onChange={(e) => setTarget({ diskPath: orNull(e.target.value) })}
              placeholder="/"
            />,
          )}
          {field(
            'Max disk usage (%)',
            <input
              className={input}
              type="number"
              min={1}
              max={100}
              value={t.diskMaxPercent ?? ''}
              onChange={(e) =>
                setTarget({ diskMaxPercent: e.target.value ? Number(e.target.value) : null })
              }
              placeholder="90"
            />,
          )}
          <p className="text-[11px] text-zinc-500 sm:col-span-2">
            Runs fixed read-only commands over SSH: whether the host answers, systemctl is-active,
            and df.
          </p>
        </div>
      )}

      {t.kind === 'process' &&
        field(
          'Background process name',
          <input
            className={input}
            value={t.processName}
            onChange={(e) => setTarget({ processName: e.target.value })}
            placeholder="dev server"
            required
          />,
          'As shown in the project’s Processes panel. Background processes stop when Friday stops.',
        )}

      {t.kind === 'compose' && (
        <div className="grid gap-3 sm:grid-cols-2">
          {field(
            'Service',
            <input
              className={input}
              value={t.service}
              onChange={(e) => setTarget({ service: e.target.value })}
              placeholder="web"
              required
            />,
          )}
          {field(
            'Compose file (optional)',
            <input
              className={input}
              value={t.file ?? ''}
              onChange={(e) => setTarget({ file: orNull(e.target.value) })}
              placeholder="compose.yaml in the project root"
            />,
          )}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        {field(
          needsProject ? 'Project' : 'Project (optional)',
          <select
            className={input}
            value={draft.projectId ?? ''}
            onChange={(e) => setDraft({ ...draft, projectId: e.target.value || null })}
            required={needsProject}
          >
            <option value="">{needsProject ? 'Choose a project…' : 'None'}</option>
            {projects
              .filter((p) => !p.worktree)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </select>,
          needsProject ? undefined : 'Investigate opens a conversation in this project.',
        )}
        {field(
          'Every (minutes)',
          <input
            className={input}
            type="number"
            min={1}
            max={1440}
            value={draft.intervalMinutes}
            onChange={(e) => setDraft({ ...draft, intervalMinutes: Number(e.target.value) })}
          />,
        )}
        {field(
          'Alert after failures in a row',
          <input
            className={input}
            type="number"
            min={1}
            max={10}
            value={draft.failuresBeforeAlert}
            onChange={(e) => setDraft({ ...draft, failuresBeforeAlert: Number(e.target.value) })}
          />,
        )}
      </div>

      {error && (
        <p role="alert" className="text-xs text-red-300">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving}>
          {initial ? 'Save' : 'Add monitor'}
        </Button>
      </div>
    </form>
  );
}

export function MonitorsDialog({
  monitors,
  projects,
  defaultProjectId,
  onClose,
  onChanged,
  onInvestigate,
}: {
  monitors: MonitorDto[];
  projects: ProjectDto[];
  defaultProjectId: string | null;
  onClose: () => void;
  onChanged: () => void;
  onInvestigate: (m: MonitorDto) => void;
}) {
  const [hosts, setHosts] = useState<SshHostDto[]>([]);
  const [editing, setEditing] = useState<MonitorDto | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.sshHosts().then(
      (r) => live && setHosts(r.hosts),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);
  const down = monitors.filter((m) => m.status === 'down').length;

  return (
    <Dialog open onClose={onClose} title="Health monitors">
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <p className="text-xs text-zinc-400">
            Read-only checks that run every few minutes while Friday is running. You get a
            notification when one goes down or recovers.
            {down > 0 && <span className="ml-1 text-red-300">{down} down.</span>}
          </p>
          {editing === null && (
            <Button size="sm" className="ml-auto shrink-0" onClick={() => setEditing('new')}>
              <Plus className="h-3.5 w-3.5" />
              Add monitor
            </Button>
          )}
        </div>
        {error && (
          <p role="alert" className="text-xs text-red-300">
            {error}
          </p>
        )}
        {editing !== null && (
          <MonitorForm
            key={editing === 'new' ? 'new' : editing.id}
            initial={editing === 'new' ? null : editing}
            projects={projects}
            hosts={hosts}
            defaultProjectId={defaultProjectId}
            onCancel={() => setEditing(null)}
            onSaved={() => {
              setEditing(null);
              onChanged();
            }}
          />
        )}
        {monitors.length ? (
          <ul aria-label="Monitors" className="space-y-2">
            {monitors.map((m) => (
              <MonitorRow
                key={m.id}
                m={m}
                projects={projects}
                hosts={hosts}
                onEdit={() => setEditing(m)}
                onChanged={() => {
                  setError(null);
                  onChanged();
                }}
                onError={setError}
                onInvestigate={onInvestigate}
              />
            ))}
          </ul>
        ) : (
          editing === null && (
            <div className="flex flex-col items-center gap-2 py-8 text-center text-sm text-zinc-500">
              <Activity className="h-6 w-6" />
              No monitors yet. Add one to watch a URL, an SSH host, a background process or a
              compose service.
            </div>
          )
        )}
      </div>
    </Dialog>
  );
}
