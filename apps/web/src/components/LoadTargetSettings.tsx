import type { HostEnvironment, LoadTargetDto } from '@friday/shared';
import { Gauge, Loader2, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { Badge, type Tone } from './ui/badge';
import { Button } from './ui/button';

const ENV_TONE: Record<HostEnvironment, Tone> = {
  development: 'neutral',
  staging: 'warning',
  production: 'danger',
};
const input =
  'w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm outline-none focus:border-sky-500';
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Settings → Load-test targets: the hosts besides this machine that load tests may hit. */
export function LoadTargetSettings() {
  const [targets, setTargets] = useState<LoadTargetDto[] | null>(null);
  const [form, setForm] = useState({
    name: '',
    origin: '',
    environment: 'staging' as HostEnvironment,
    maxVus: '20',
    maxMinutes: '5',
  });
  const [error, setError] = useState<string | null>(null);
  const ids = {
    heading: useId(),
    name: useId(),
    origin: useId(),
    env: useId(),
    vus: useId(),
    minutes: useId(),
  };

  const load = useCallback(async () => {
    try {
      setTargets((await api.loadTargets()).targets);
    } catch (e) {
      setError(message(e));
    }
  }, []);
  useEffect(() => {
    // load() only sets state after its request resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm({ ...form, [k]: e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api.addLoadTarget({
        name: form.name.trim(),
        origin: form.origin.trim(),
        environment: form.environment,
        maxVus: Number(form.maxVus) || 20,
        maxDurationSeconds: Math.round((Number(form.maxMinutes) || 5) * 60),
      });
      setForm({ ...form, name: '', origin: '' });
      await load();
    } catch (err) {
      setError(message(err));
    }
  };

  return (
    <section className="border-b border-zinc-800 py-4 last:border-0" aria-labelledby={ids.heading}>
      <h3 id={ids.heading} className="mb-2 text-sm font-semibold text-zinc-200">
        Load-test targets
      </h3>
      <p className="mb-2 text-xs text-zinc-500">
        Load tests may always hit this machine (up to 100 virtual users for 10 minutes). Any other
        site must be listed here, with the most load it may get. Production targets need their name
        typed for each test.
      </p>
      {targets === null ? (
        <Loader2 className="h-4 w-4 animate-spin text-zinc-500" aria-label="Loading targets" />
      ) : (
        <ul className="mb-2 space-y-1 text-xs">
          {targets.map((t) => (
            <li
              key={t.id}
              className="flex flex-wrap items-center gap-2 rounded-md border border-zinc-800 p-2"
            >
              <Gauge className="h-3.5 w-3.5 text-zinc-500" aria-hidden />
              <span className="font-mono text-sm text-zinc-100">{t.name}</span>
              <Badge tone={ENV_TONE[t.environment]}>{t.environment}</Badge>
              <span className="min-w-0 truncate font-mono text-zinc-400">{t.origin}</span>
              <span className="text-zinc-500">
                up to {t.maxVus} users, {Math.round(t.maxDurationSeconds / 60)} min
              </span>
              <Button
                size="icon"
                variant="ghost"
                className="ml-auto h-6 w-6"
                aria-label={`Remove load-test target ${t.name}`}
                onClick={() => {
                  if (window.confirm(`Remove the load-test target "${t.name}"?`))
                    void api
                      .removeLoadTarget(t.id)
                      .then(load, (e: unknown) => setError(message(e)));
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
          {targets.length === 0 && <li className="text-zinc-500">No other targets.</li>}
        </ul>
      )}
      <form
        onSubmit={(e) => void submit(e)}
        className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-5"
        aria-label="Add load-test target"
      >
        <div>
          <label htmlFor={ids.name}>Name</label>
          <input
            id={ids.name}
            className={input}
            value={form.name}
            onChange={set('name')}
            placeholder="staging"
            required
          />
        </div>
        <div className="col-span-2">
          <label htmlFor={ids.origin}>Site</label>
          <input
            id={ids.origin}
            className={`${input} font-mono`}
            value={form.origin}
            onChange={set('origin')}
            placeholder="https://staging.example.com"
            required
          />
        </div>
        <div>
          <label htmlFor={ids.env}>Environment</label>
          <select
            id={ids.env}
            className={input}
            value={form.environment}
            onChange={set('environment')}
          >
            <option value="development">development</option>
            <option value="staging">staging</option>
            <option value="production">production</option>
          </select>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label htmlFor={ids.vus}>Max users</label>
            <input
              id={ids.vus}
              className={input}
              value={form.maxVus}
              onChange={set('maxVus')}
              inputMode="numeric"
            />
          </div>
          <div>
            <label htmlFor={ids.minutes}>Max min</label>
            <input
              id={ids.minutes}
              className={input}
              value={form.maxMinutes}
              onChange={set('maxMinutes')}
              inputMode="numeric"
            />
          </div>
        </div>
        <div className="col-span-2 sm:col-span-5">
          <Button type="submit" size="sm" variant="primary">
            <Plus className="h-3.5 w-3.5" /> Add target
          </Button>
        </div>
      </form>
      {error && (
        <p role="alert" className="mt-1 text-xs text-red-400">
          {error}
        </p>
      )}
    </section>
  );
}
