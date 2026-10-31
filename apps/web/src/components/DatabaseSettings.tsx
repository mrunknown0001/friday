import type {
  DbConnectionDto,
  DbConnectionInput,
  DbConnectionTestResult,
  DbEngine,
  HostEnvironment,
  ProjectDto,
} from '@friday/shared';
import { Database, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useState,
  type FormEvent,
  type ReactElement,
} from 'react';
import { api } from '../lib/api';
import { Badge, type Tone } from './ui/badge';
import { Button } from './ui/button';

const ENV_TONE: Record<HostEnvironment, Tone> = {
  development: 'neutral',
  staging: 'warning',
  production: 'danger',
};
const ENGINE: Record<DbEngine, string> = { postgres: 'Postgres', mysql: 'MySQL', sqlite: 'SQLite' };
const input =
  'w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm outline-none focus:border-sky-500';
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A labelled field; the label points at the control by id (wrapping breaks select names). */
function Field({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactElement<{ id?: string }>;
}) {
  const id = useId();
  return (
    <div className={className}>
      <label htmlFor={id} className="block">
        {label}
      </label>
      {cloneElement(children, { id })}
    </div>
  );
}

/** Where a connection points, without any secret. */
export function connectionTarget(c: DbConnectionDto): string {
  if (c.engine === 'sqlite') return c.path ?? '';
  if (c.secretKind === 'url') return `URL from ${c.secretVar ?? '?'}`;
  return `${c.username ?? ''}@${c.host ?? ''}:${c.port ?? ''}/${c.database ?? ''}`;
}

interface FormState {
  name: string;
  engine: DbEngine;
  projectId: string;
  environment: HostEnvironment;
  mode: 'password' | 'url';
  host: string;
  port: string;
  database: string;
  username: string;
  secretVar: string;
  ssl: DbConnectionDto['ssl'];
  path: string;
}

const EMPTY: FormState = {
  name: '',
  engine: 'postgres',
  projectId: '',
  environment: 'development',
  mode: 'password',
  host: 'localhost',
  port: '',
  database: '',
  username: '',
  secretVar: 'DB_PASSWORD',
  ssl: 'disable',
  path: '',
};

const fromDto = (c: DbConnectionDto): FormState => ({
  name: c.name,
  engine: c.engine,
  projectId: c.projectId ?? '',
  environment: c.environment,
  mode: c.secretKind,
  host: c.host ?? '',
  port: c.port ? String(c.port) : '',
  database: c.database ?? '',
  username: c.username ?? '',
  secretVar: c.secretVar ?? '',
  ssl: c.ssl,
  path: c.path ?? '',
});

function toInput(f: FormState): DbConnectionInput {
  const text = (v: string) => v.trim() || null;
  return {
    name: f.name.trim(),
    engine: f.engine,
    projectId: f.projectId || null,
    environment: f.environment,
    host: f.engine === 'sqlite' || f.mode === 'url' ? null : text(f.host),
    port: f.engine === 'sqlite' || f.mode === 'url' ? null : Number(f.port) || null,
    database: f.engine === 'sqlite' || f.mode === 'url' ? null : text(f.database),
    username: f.engine === 'sqlite' || f.mode === 'url' ? null : text(f.username),
    secretVar: f.engine === 'sqlite' ? null : text(f.secretVar),
    secretKind: f.mode,
    ssl: f.engine === 'sqlite' ? 'disable' : f.ssl,
    path: f.engine === 'sqlite' ? text(f.path) : null,
  };
}

function ConnectionForm({
  projects,
  editing,
  onDone,
}: {
  projects: ProjectDto[];
  editing: DbConnectionDto | null;
  onDone: () => void;
}) {
  const [form, setForm] = useState<FormState>(editing ? fromDto(editing) : EMPTY);
  const [error, setError] = useState<string | null>(null);
  const set =
    <K extends keyof FormState>(k: K) =>
    (e: { target: { value: string } }) =>
      setForm({ ...form, [k]: e.target.value as FormState[K] });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      if (editing) await api.updateDatabase(editing.id, toInput(form));
      else await api.addDatabase(toInput(form));
      setForm(EMPTY);
      onDone();
    } catch (err) {
      setError(message(err));
    }
  };
  const sqlite = form.engine === 'sqlite';
  const url = !sqlite && form.mode === 'url';
  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="mt-2 grid grid-cols-2 gap-2 text-xs"
      aria-label={editing ? `Edit connection ${editing.name}` : 'Add database connection'}
    >
      <Field label="Name">
        <input
          className={input}
          value={form.name}
          onChange={set('name')}
          placeholder="shop-dev"
          required
        />
      </Field>
      <Field label="Database">
        <select className={input} value={form.engine} onChange={set('engine')}>
          <option value="postgres">Postgres</option>
          <option value="mysql">MySQL / MariaDB</option>
          <option value="sqlite">SQLite</option>
        </select>
      </Field>
      <Field label="Used in">
        <select className={input} value={form.projectId} onChange={set('projectId')}>
          <option value="">Any conversation</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              Project {p.name} only
            </option>
          ))}
        </select>
      </Field>
      <Field label="Environment">
        <select className={input} value={form.environment} onChange={set('environment')}>
          <option value="development">development</option>
          <option value="staging">staging</option>
          <option value="production">production</option>
        </select>
      </Field>
      {sqlite ? (
        <Field label="Database file (absolute, or relative to the project)" className="col-span-2">
          <input
            className={`${input} font-mono`}
            value={form.path}
            onChange={set('path')}
            placeholder="database/database.sqlite"
            required
          />
        </Field>
      ) : (
        <>
          <Field label="Connect with" className="col-span-2">
            <select className={input} value={form.mode} onChange={set('mode')}>
              <option value="password">Host, user and a password variable</option>
              <option value="url">A connection URL variable (e.g. DATABASE_URL)</option>
            </select>
          </Field>
          {!url && (
            <>
              <Field label="Host">
                <input className={input} value={form.host} onChange={set('host')} required />
              </Field>
              <Field label="Port">
                <input
                  className={input}
                  value={form.port}
                  onChange={set('port')}
                  inputMode="numeric"
                  placeholder={form.engine === 'postgres' ? '5432' : '3306'}
                />
              </Field>
              <Field label="Database name">
                <input className={input} value={form.database} onChange={set('database')} />
              </Field>
              <Field label="User">
                <input
                  className={input}
                  value={form.username}
                  onChange={set('username')}
                  required
                />
              </Field>
            </>
          )}
          <Field label={url ? 'URL variable name' : 'Password variable name (empty: no password)'}>
            <input
              className={`${input} font-mono`}
              value={form.secretVar}
              onChange={set('secretVar')}
              placeholder={url ? 'DATABASE_URL' : 'DB_PASSWORD'}
              required={url}
            />
          </Field>
          <Field label="TLS">
            <select className={input} value={form.ssl} onChange={set('ssl')}>
              <option value="disable">off</option>
              <option value="require">on, without checking the certificate</option>
              <option value="verify">on, certificate checked</option>
            </select>
          </Field>
        </>
      )}
      <div className="col-span-2 flex items-center gap-2">
        <Button type="submit" size="sm" variant="primary">
          {editing ? (
            'Save'
          ) : (
            <>
              <Plus className="h-3.5 w-3.5" /> Add connection
            </>
          )}
        </Button>
        {editing && (
          <Button type="button" size="sm" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        )}
      </div>
      <p className="col-span-2 text-zinc-500">
        Friday stores only the variable&apos;s name, never a password. Put the value in the
        project&apos;s <code>.env</code> or Friday&apos;s config file; Friday reads it when
        connecting and never shows it to the model. Every query is read-only and needs your
        approval. A database user that can only read is safest.
      </p>
      {error && (
        <p role="alert" className="col-span-2 text-red-400">
          {error}
        </p>
      )}
    </form>
  );
}

function ConnectionRow({
  c,
  projectName,
  onEdit,
  onChanged,
}: {
  c: DbConnectionDto;
  projectName: string | null;
  onEdit: () => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DbConnectionTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="rounded-md border border-zinc-800 p-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <Database className="h-3.5 w-3.5 text-zinc-500" aria-hidden />
        <span className="font-mono text-sm text-zinc-100">{c.name}</span>
        <Badge tone="neutral">{ENGINE[c.engine]}</Badge>
        <Badge tone={ENV_TONE[c.environment]}>{c.environment}</Badge>
        <span className="min-w-0 truncate font-mono text-zinc-400">{connectionTarget(c)}</span>
        <div className="ml-auto flex gap-1">
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void act(async () => setResult(await api.testDatabase(c.id)))}
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Test'}
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label={`Edit connection ${c.name}`}
            onClick={onEdit}
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label={`Remove connection ${c.name}`}
            disabled={busy}
            onClick={() => {
              if (window.confirm(`Remove the database connection "${c.name}"?`))
                void act(async () => {
                  await api.removeDatabase(c.id);
                  onChanged();
                });
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      <p className="mt-1 text-zinc-500">
        {projectName ? `Project ${projectName} only` : 'Any conversation'}
        {c.engine !== 'sqlite' &&
          (c.secretVar
            ? ` · ${c.secretKind === 'url' ? 'URL' : 'password'} from ${c.secretVar}`
            : ' · no password')}
        {c.engine !== 'sqlite' &&
          c.ssl !== 'disable' &&
          ` · TLS${c.ssl === 'verify' ? ' (verified)' : ''}`}
      </p>
      {result && (
        <div role="status" className="mt-1">
          <p className={result.ok ? 'text-emerald-300' : 'text-red-300'}>{result.message}</p>
          {result.warnings.map((w) => (
            <p key={w} className="text-amber-200">
              {w}
            </p>
          ))}
        </div>
      )}
      {error && (
        <p role="alert" className="mt-1 text-red-400">
          {error}
        </p>
      )}
    </li>
  );
}

/** Settings → Databases: the connections Friday may read from, managed only here. */
export function DatabaseSettings() {
  const [connections, setConnections] = useState<DbConnectionDto[] | null>(null);
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [editing, setEditing] = useState<DbConnectionDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const headingId = useId();

  const load = useCallback(async () => {
    try {
      const [c, p] = await Promise.all([api.databases(), api.projects()]);
      setConnections(c.connections);
      setProjects(p.projects);
    } catch (e) {
      setError(message(e));
    }
  }, []);
  useEffect(() => {
    // load() only sets state after its requests resolve.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  return (
    <section className="border-b border-zinc-800 py-4 last:border-0" aria-labelledby={headingId}>
      <h3 id={headingId} className="mb-2 text-sm font-semibold text-zinc-200">
        Databases
      </h3>
      {connections === null ? (
        <Loader2 className="h-4 w-4 animate-spin text-zinc-500" aria-label="Loading connections" />
      ) : (
        <ul className="space-y-2">
          {connections.map((c) => (
            <ConnectionRow
              key={c.id}
              c={c}
              projectName={projects.find((p) => p.id === c.projectId)?.name ?? null}
              onEdit={() => setEditing(c)}
              onChanged={() => void load()}
            />
          ))}
          {connections.length === 0 && (
            <li className="text-xs text-zinc-500">No connections yet.</li>
          )}
        </ul>
      )}
      <ConnectionForm
        key={editing?.id ?? 'new'}
        projects={projects}
        editing={editing}
        onDone={() => {
          setEditing(null);
          void load();
        }}
      />
      {error && (
        <p role="alert" className="mt-1 text-xs text-red-400">
          {error}
        </p>
      )}
    </section>
  );
}
