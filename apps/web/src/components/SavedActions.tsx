import type { SavedActionDto, SavedActionInput, SavedActionStep, SshHostDto } from '@friday/shared';
import {
  ArrowDown,
  ArrowUp,
  Loader2,
  Pencil,
  Play,
  Plus,
  ScrollText,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Badge, type Tone } from './ui/badge';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';

const input =
  'w-full rounded-md border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-sm outline-none focus:border-sky-500';

const RISK_TONE: Record<SavedActionDto['risk'], Tone> = {
  low: 'neutral',
  medium: 'info',
  high: 'warning',
  critical: 'danger',
};

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

const newStep = (): SavedActionStep => ({
  title: '',
  target: { kind: 'local', cwd: '.' },
  command: '',
  timeoutSeconds: 300,
  continueOnError: false,
});

/** The message that asks Friday to run a saved action (it still needs the user's approval). */
export const runRequest = (name: string) => `Run the saved action "${name}".`;

function hostLabel(hosts: SshHostDto[], id: string) {
  const h = hosts.find((x) => x.id === id);
  return h ? `${h.name} (${h.environment})` : 'a removed SSH host';
}

function StepEditor({
  step,
  n,
  count,
  hosts,
  onChange,
  onMove,
  onRemove,
}: {
  step: SavedActionStep;
  n: number;
  count: number;
  hosts: SshHostDto[];
  onChange: (s: SavedActionStep) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}) {
  const where = step.target.kind === 'local' ? 'local' : step.target.hostId;
  return (
    <li
      aria-label={`Step ${n}`}
      className="space-y-2 rounded-md border border-zinc-800 bg-zinc-950/50 p-2"
    >
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs text-zinc-500">{n}.</span>
        <input
          aria-label={`Step ${n} title`}
          placeholder="What it does, e.g. Build"
          value={step.title}
          onChange={(e) => onChange({ ...step, title: e.target.value })}
          className={input}
        />
        <button
          type="button"
          aria-label={`Move step ${n} up`}
          disabled={n === 1}
          onClick={() => onMove(-1)}
          className="text-zinc-400 hover:text-zinc-100 disabled:opacity-30"
        >
          <ArrowUp className="h-4 w-4" />
        </button>
        <button
          type="button"
          aria-label={`Move step ${n} down`}
          disabled={n === count}
          onClick={() => onMove(1)}
          className="text-zinc-400 hover:text-zinc-100 disabled:opacity-30"
        >
          <ArrowDown className="h-4 w-4" />
        </button>
        <button
          type="button"
          aria-label={`Remove step ${n}`}
          disabled={count === 1}
          onClick={onRemove}
          className="text-zinc-400 hover:text-red-300 disabled:opacity-30"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="grid gap-2 sm:grid-cols-[1fr_1fr]">
        <label className="text-xs text-zinc-400">
          Runs on
          <select
            aria-label={`Step ${n} runs on`}
            value={where}
            onChange={(e) =>
              onChange({
                ...step,
                target:
                  e.target.value === 'local'
                    ? { kind: 'local', cwd: '.' }
                    : { kind: 'ssh', hostId: e.target.value },
              })
            }
            className={`${input} mt-1`}
          >
            <option value="local">This project, on this machine</option>
            {hosts.map((h) => (
              <option key={h.id} value={h.id}>
                SSH: {h.name} ({h.environment})
              </option>
            ))}
            {step.target.kind === 'ssh' && !hosts.some((h) => h.id === where) && (
              <option value={where}>A removed SSH host</option>
            )}
          </select>
        </label>
        {step.target.kind === 'local' ? (
          <label className="text-xs text-zinc-400">
            Folder (relative to the project)
            <input
              aria-label={`Step ${n} folder`}
              value={step.target.cwd}
              onChange={(e) =>
                onChange({ ...step, target: { kind: 'local', cwd: e.target.value } })
              }
              className={`${input} mt-1 font-mono`}
            />
          </label>
        ) : (
          <p className="self-end text-xs text-zinc-500">
            Runs through the remote shell as the host’s user.
          </p>
        )}
      </div>
      <textarea
        aria-label={`Step ${n} command`}
        placeholder="The exact command, e.g. npm run build"
        value={step.command}
        rows={Math.min(6, Math.max(1, step.command.split('\n').length))}
        onChange={(e) => onChange({ ...step, command: e.target.value })}
        className={`${input} font-mono text-[0.8rem]`}
      />
      <div className="flex flex-wrap items-center gap-4 text-xs text-zinc-400">
        <label className="flex items-center gap-1.5">
          Timeout
          <input
            aria-label={`Step ${n} timeout`}
            type="number"
            min={5}
            max={1800}
            value={step.timeoutSeconds}
            onChange={(e) => onChange({ ...step, timeoutSeconds: Number(e.target.value) || 5 })}
            className="w-20 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm outline-none focus:border-sky-500"
          />
          s
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            aria-label={`Step ${n}: continue if it fails`}
            checked={step.continueOnError}
            onChange={(e) => onChange({ ...step, continueOnError: e.target.checked })}
            className="accent-sky-500"
          />
          Continue if this step fails
        </label>
      </div>
    </li>
  );
}

function ActionEditor({
  initial,
  hosts,
  busy,
  onSave,
  onCancel,
}: {
  initial: SavedActionInput;
  hosts: SshHostDto[];
  busy: boolean;
  onSave: (a: SavedActionInput) => void;
  onCancel: () => void;
}) {
  const [a, setA] = useState(initial);
  const setStep = (i: number, s: SavedActionStep) =>
    setA({ ...a, steps: a.steps.map((x, j) => (j === i ? s : x)) });
  const move = (i: number, delta: -1 | 1) => {
    const steps = [...a.steps];
    [steps[i], steps[i + delta]] = [steps[i + delta]!, steps[i]!];
    setA({ ...a, steps });
  };
  const incomplete = !a.name.trim() || a.steps.some((s) => !s.title.trim() || !s.command.trim());
  return (
    <div className="space-y-3 rounded-md border border-zinc-800 p-3">
      <div className="grid gap-2 sm:grid-cols-[2fr_1fr]">
        <label className="text-xs text-zinc-400">
          Name
          <input
            aria-label="Action name"
            placeholder="e.g. deploy staging"
            value={a.name}
            onChange={(e) => setA({ ...a, name: e.target.value })}
            className={`${input} mt-1`}
          />
        </label>
        <label className="text-xs text-zinc-400">
          Risk
          <select
            aria-label="Action risk"
            value={a.risk}
            onChange={(e) => setA({ ...a, risk: e.target.value as SavedActionDto['risk'] })}
            className={`${input} mt-1`}
          >
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="critical">Critical</option>
          </select>
        </label>
      </div>
      <label className="block text-xs text-zinc-400">
        Description
        <input
          aria-label="Action description"
          placeholder="What it is for (shown to Friday and on the approval card)"
          value={a.description}
          onChange={(e) => setA({ ...a, description: e.target.value })}
          className={`${input} mt-1`}
        />
      </label>
      <ol className="space-y-2">
        {a.steps.map((s, i) => (
          <StepEditor
            key={i}
            step={s}
            n={i + 1}
            count={a.steps.length}
            hosts={hosts}
            onChange={(next) => setStep(i, next)}
            onMove={(d) => move(i, d)}
            onRemove={() => setA({ ...a, steps: a.steps.filter((_, j) => j !== i) })}
          />
        ))}
      </ol>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          size="sm"
          onClick={() => setA({ ...a, steps: [...a.steps, newStep()] })}
          disabled={a.steps.length >= 30}
        >
          <Plus className="h-3.5 w-3.5" aria-hidden /> Add step
        </Button>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={() => onSave(a)}
            disabled={busy || incomplete}
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />} Save action
          </Button>
        </div>
      </div>
    </div>
  );
}

function useActions(projectId: string) {
  const [actions, setActions] = useState<SavedActionDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .savedActions(projectId)
      .then((r) => !cancelled && setActions(r.actions))
      .catch((e: unknown) => !cancelled && setError(message(e)));
    return () => {
      cancelled = true;
    };
  }, [projectId]);
  const reload = useCallback(async () => {
    setActions((await api.savedActions(projectId)).actions);
  }, [projectId]);
  return { actions, error, setError, reload };
}

/** Project settings: define, change and delete the project's saved actions. */
export function SavedActionsSection({ projectId }: { projectId: string }) {
  const { actions, error, setError, reload } = useActions(projectId);
  const [hosts, setHosts] = useState<SshHostDto[]>([]);
  const [editing, setEditing] = useState<{ id: string | null; value: SavedActionInput } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .sshHosts()
      .then((r) => setHosts(r.hosts))
      .catch(() => setHosts([]));
  }, []);

  const save = async (value: SavedActionInput) => {
    setBusy(true);
    setError(null);
    try {
      if (editing?.id) await api.updateSavedAction(editing.id, value);
      else await api.createSavedAction(projectId, value);
      setEditing(null);
      await reload();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (a: SavedActionDto) => {
    if (!window.confirm(`Delete the saved action "${a.name}"?`)) return;
    setError(null);
    try {
      await api.deleteSavedAction(a.id);
      await reload();
    } catch (e) {
      setError(message(e));
    }
  };

  return (
    <section aria-labelledby="actions-heading" className="space-y-2 border-t border-zinc-800 pt-4">
      <h3 id="actions-heading" className="flex items-center gap-2 text-sm font-semibold">
        <ScrollText className="h-4 w-4 text-sky-400" aria-hidden /> Saved actions
      </h3>
      <p className="text-sm text-zinc-300">
        Procedures you define once, such as “deploy staging”. Ask Friday to run one by name: it
        shows every step for one approval, and runs exactly these commands. Friday can’t change
        them.
      </p>
      {actions === null && !error && <p className="text-xs text-zinc-400">Loading…</p>}
      {actions && actions.length > 0 && (
        <ul aria-label="Saved actions" className="space-y-1.5">
          {actions.map((a) => (
            <li
              key={a.id}
              className="flex items-start gap-2 rounded-md border border-zinc-800 px-2.5 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-zinc-100">{a.name}</span>
                  <Badge tone={RISK_TONE[a.risk]}>{a.risk}</Badge>
                  <span className="text-xs text-zinc-500">
                    {a.steps.length} step{a.steps.length === 1 ? '' : 's'}
                  </span>
                </div>
                {a.description && <p className="text-xs text-zinc-400">{a.description}</p>}
                <p className="truncate text-xs text-zinc-500">
                  {a.steps
                    .map((s) =>
                      s.target.kind === 'local'
                        ? s.title
                        : `${s.title} @ ${hostLabel(hosts, s.target.hostId)}`,
                    )
                    .join(' → ')}
                </p>
              </div>
              <button
                type="button"
                aria-label={`Edit ${a.name}`}
                onClick={() =>
                  setEditing({
                    id: a.id,
                    value: {
                      name: a.name,
                      description: a.description,
                      risk: a.risk,
                      steps: a.steps,
                    },
                  })
                }
                className="text-zinc-400 hover:text-zinc-100"
              >
                <Pencil className="h-4 w-4" />
              </button>
              <button
                type="button"
                aria-label={`Delete ${a.name}`}
                onClick={() => void remove(a)}
                className="text-zinc-400 hover:text-red-300"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {editing ? (
        <ActionEditor
          key={editing.id ?? 'new'}
          initial={editing.value}
          hosts={hosts}
          busy={busy}
          onSave={(v) => void save(v)}
          onCancel={() => setEditing(null)}
        />
      ) : (
        <Button
          size="sm"
          onClick={() =>
            setEditing({
              id: null,
              value: { name: '', description: '', risk: 'medium', steps: [newStep()] },
            })
          }
        >
          <Plus className="h-3.5 w-3.5" aria-hidden /> Add action
        </Button>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-400">
          {error}
        </p>
      )}
    </section>
  );
}

/** From a conversation: pick a saved action and ask Friday to run it. */
export function RunActionDialog({
  projectId,
  canSend,
  onRun,
  onClose,
}: {
  projectId: string;
  canSend: boolean;
  onRun: (text: string) => void;
  onClose: () => void;
}) {
  const { actions, error } = useActions(projectId);
  return (
    <Dialog open onClose={onClose} title="Run a saved action">
      <div className="space-y-3">
        {actions === null && !error && (
          <p className="flex items-center gap-2 text-sm text-zinc-400">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading…
          </p>
        )}
        {actions?.length === 0 && (
          <p className="text-sm text-zinc-300">
            This project has no saved actions yet. Define them in Project settings › Saved actions.
          </p>
        )}
        {actions && actions.length > 0 && (
          <ul className="space-y-1.5">
            {actions.map((a) => (
              <li
                key={a.id}
                className="flex items-center gap-2 rounded-md border border-zinc-800 px-2.5 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-zinc-100">{a.name}</span>
                    <Badge tone={RISK_TONE[a.risk]}>{a.risk}</Badge>
                  </div>
                  {a.description && <p className="text-xs text-zinc-400">{a.description}</p>}
                </div>
                <Button
                  size="sm"
                  disabled={!canSend}
                  onClick={() => {
                    onRun(runRequest(a.name));
                    onClose();
                  }}
                >
                  <Play className="h-3.5 w-3.5" aria-hidden /> Run
                </Button>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-zinc-500">
          Friday asks for your approval, showing every step, before anything runs.
        </p>
        {error && (
          <p role="alert" className="text-sm text-red-400">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
