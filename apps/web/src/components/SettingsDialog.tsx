import type {
  ConnectionTestResult,
  ModelCapabilities,
  ModelInfo,
  ProviderCallDto,
  SettingsDto,
} from '@friday/shared';
import { CheckCircle2, KeyRound, Loader2, RefreshCw, XCircle } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError } from '../lib/api';
import { desktop } from '../lib/desktop';
import {
  disableNotifications,
  enableNotifications,
  notificationState,
  notify,
  type NotificationState,
} from '../lib/notifications';
import { Badge, type Tone } from './ui/badge';
import { Button } from './ui/button';
import { DatabaseSettings } from './DatabaseSettings';
import { DevopsSettings } from './DevopsSettings';
import { LoadTargetSettings } from './LoadTargetSettings';
import { VoiceSettings } from './VoiceSettings';
import { McpSettings } from './McpSettings';
import { UsageSettings } from './UsageSettings';
import { Dialog } from './ui/dialog';

function NotificationSettings() {
  const [state, setState] = useState<NotificationState>(notificationState);
  return (
    <Section title="Notifications">
      <p className="text-sm text-zinc-300">
        A system notification when Friday needs your approval, or finishes a task that took a while,
        while you are in another window or conversation. It shows the action’s title only.
      </p>
      {state === 'unsupported' && (
        <p className="mt-2 text-xs text-zinc-400">Notifications are not available here.</p>
      )}
      {state === 'blocked' && (
        <p className="mt-2 text-xs text-amber-300">
          Notifications are blocked for this page. Allow them in your browser’s site settings, then
          reload.
        </p>
      )}
      {(state === 'on' || state === 'off') && (
        <div className="mt-2 flex items-center gap-2">
          <Badge tone={state === 'on' ? 'success' : 'neutral'}>{state}</Badge>
          {state === 'on' ? (
            <>
              <Button
                size="sm"
                onClick={() => {
                  disableNotifications();
                  setState(notificationState());
                }}
              >
                Turn off
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  notify({
                    title: 'Friday',
                    body: 'Notifications are working.',
                    tag: 'friday-test',
                  })
                }
              >
                Send a test
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={() => void enableNotifications().then(setState)}>
              Turn on
            </Button>
          )}
        </div>
      )}
    </Section>
  );
}

const CAP_TONE: Record<string, Tone> = {
  supported: 'success',
  unsupported: 'danger',
  unknown: 'neutral',
};

function Section({
  title,
  children,
  aside,
}: {
  title: string;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <section className="border-b border-zinc-800 py-4 first:pt-0 last:border-0">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-zinc-200">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function ErrorText({ error }: { error: string | null }) {
  return error ? (
    <p role="alert" className="mt-2 text-xs text-red-400">
      {error}
    </p>
  ) : null;
}

const message = (e: unknown) =>
  e instanceof ApiError || e instanceof Error ? e.message : String(e);

export function SettingsDialog({
  onClose,
  settings,
  onSettingsChanged,
}: {
  onClose: () => void;
  settings: SettingsDto | null;
  onSettingsChanged: () => void;
}) {
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(settings?.apiKeyConfigured ?? false);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState(settings?.model ?? '');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [test, setTest] = useState<ConnectionTestResult | null>(null);
  const [testing, setTesting] = useState(false);

  const [caps, setCaps] = useState<ModelCapabilities | null>(null);
  const [capsError, setCapsError] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  const [windowDraft, setWindowDraft] = useState('');

  const [calls, setCalls] = useState<ProviderCallDto[]>([]);

  const loadModels = useCallback(async (refresh: boolean) => {
    try {
      setModels((await api.models(refresh)).models);
      setModelsError(null);
    } catch (e) {
      setModelsError(message(e));
    } finally {
      setLoadingModels(false);
    }
  }, []);

  const loadCaps = useCallback(async () => {
    try {
      const c = await api.capabilities();
      setCapsError(null);
      setCaps(c);
      setWindowDraft(c.contextWindowSource === 'configured' ? String(c.contextWindow) : '');
    } catch (e) {
      setCaps(null);
      if (!(e instanceof ApiError && e.code === 'model_not_selected')) setCapsError(message(e));
    }
  }, []);

  const loadCalls = useCallback(async () => {
    try {
      setCalls((await api.providerCalls()).calls);
    } catch {
      setCalls([]);
    }
  }, []);

  const keyConfigured = settings?.apiKeyConfigured ?? false;
  useEffect(() => {
    // These loaders only set state after their fetches resolve; the rule cannot see through the await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadCalls();
    void loadCaps();
    if (keyConfigured) void loadModels(false);
    // Reload when the effective model or key status changes.
  }, [settings?.model, keyConfigured, loadModels, loadCaps, loadCalls]);

  const refreshModels = () => {
    setLoadingModels(true);
    void loadModels(true);
  };

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (models ?? []).filter(
      (m) => !q || m.id.toLowerCase().includes(q) || m.name?.toLowerCase().includes(q),
    );
  }, [models, filter]);

  const saveModel = async () => {
    if (!selected) return;
    setSaving(true);
    setSaveError(null);
    try {
      await api.setModel(selected);
      onSettingsChanged();
    } catch (e) {
      setSaveError(message(e));
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      setTest(await api.testConnection());
    } catch (e) {
      setTest({
        ok: false,
        model: settings?.model ?? null,
        latencyMs: 0,
        modelListed: null,
        error: { kind: 'unknown', message: message(e) },
      });
    } finally {
      setTesting(false);
      void loadCalls();
    }
  };

  const probe = async () => {
    setProbing(true);
    setCapsError(null);
    try {
      setCaps(await api.probeCapabilities());
    } catch (e) {
      setCapsError(message(e));
    } finally {
      setProbing(false);
      void loadCalls();
    }
  };

  const saveWindow = async () => {
    setCapsError(null);
    const value = windowDraft.trim();
    try {
      setCaps(await api.setContextWindow(value ? Number(value) : null));
    } catch (e) {
      setCapsError(message(e));
    }
  };

  return (
    <Dialog open onClose={onClose} title="Settings">
      <Section title="NoTokenLimit API key">
        {settings?.apiKeyConfigured ? (
          <p className="flex items-center gap-2 text-sm text-emerald-300">
            <KeyRound className="h-4 w-4" aria-hidden /> Configured via{' '}
            <code className="font-mono">NTL_API_KEY</code>. The key never leaves the local server.
          </p>
        ) : (
          <div className="text-sm text-zinc-300">
            <p className="flex items-center gap-2 text-amber-300">
              <KeyRound className="h-4 w-4" aria-hidden /> Not configured.
            </p>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-zinc-400">
              <li>
                Open <code className="font-mono break-all">{settings?.envFile ?? '.env'}</code>
                {desktop ? '' : ' (copy .env.example if it does not exist)'}.
              </li>
              <li>
                Set <code className="font-mono">NTL_API_KEY</code> (and optionally{' '}
                <code className="font-mono">NTL_MODEL</code>).
              </li>
              <li>{desktop ? 'Restart the server below.' : 'Restart the server.'}</li>
            </ol>
            {desktop && (
              <div className="mt-2 flex gap-2">
                <Button onClick={() => void desktop!.showConfigFile()}>Show config file</Button>
                <Button onClick={() => void desktop!.restartServer()}>Restart server</Button>
              </div>
            )}
            <p className="mt-2 text-xs text-zinc-500">
              Keys are read from the server environment only and are never stored in the database or
              sent to this page. Don't paste keys into the chat.
            </p>
          </div>
        )}
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs text-zinc-400">
          <dt>Base URL</dt>
          <dd className="font-mono text-zinc-300">{settings?.baseUrl}</dd>
          <dt>Timeout</dt>
          <dd className="text-zinc-300">{settings ? `${settings.timeoutMs / 1000}s` : ''}</dd>
          <dt>Retries</dt>
          <dd className="text-zinc-300">{settings?.maxRetries} (transient errors only)</dd>
        </dl>
      </Section>

      <Section
        title="Model"
        aside={
          settings?.apiKeyConfigured && (
            <Button size="sm" variant="ghost" onClick={refreshModels} disabled={loadingModels}>
              <RefreshCw className={`h-3.5 w-3.5 ${loadingModels ? 'animate-spin' : ''}`} /> Refresh
              list
            </Button>
          )
        }
      >
        <p className="mb-2 text-xs text-zinc-400">
          Current: <span className="font-mono text-zinc-200">{settings?.model ?? 'none'}</span>
          {settings?.modelSource === 'env' && ' (from NTL_MODEL)'}
          {settings?.modelSource === 'settings' && ' (saved in settings)'}
        </p>
        {!settings?.apiKeyConfigured ? (
          <p className="text-sm text-zinc-500">
            Configure an API key to load the NoTokenLimit model list.
          </p>
        ) : (
          <>
            <input
              aria-label="Filter models"
              placeholder="Filter models…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="mb-2 w-full rounded-md border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-sm outline-none focus:border-sky-500"
            />
            <select
              aria-label="Model"
              size={8}
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              className="w-full rounded-md border border-zinc-700 bg-zinc-950 p-1 font-mono text-sm outline-none focus:border-sky-500"
            >
              {filtered.map((m) => (
                <option key={m.id} value={m.id} className="rounded px-1.5 py-0.5">
                  {m.id}
                  {m.name && m.name !== m.id ? ` — ${m.name}` : ''}
                </option>
              ))}
            </select>
            {models && (
              <p className="mt-1 text-xs text-zinc-500">
                {models.length} models in the NoTokenLimit catalog. Some require a specific plan;
                after selecting one, use Test connection to confirm your account can use it.
              </p>
            )}
            <ErrorText error={modelsError ?? saveError} />
            <div className="mt-2 flex gap-2">
              <Button
                variant="primary"
                size="sm"
                onClick={() => void saveModel()}
                disabled={!selected || selected === settings.model || saving}
              >
                {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Use selected model
              </Button>
              {settings.modelSource === 'settings' && (
                <Button
                  size="sm"
                  onClick={async () => {
                    await api.resetModel().catch(() => undefined);
                    onSettingsChanged();
                  }}
                >
                  Reset to NTL_MODEL
                </Button>
              )}
            </div>
          </>
        )}
      </Section>

      <Section title="Connection test">
        <p className="mb-2 text-xs text-zinc-400">
          Sends one tiny completion to the current model (uses a few tokens). This is the only check
          that verifies both your API key and your plan's access to the model.
        </p>
        <Button
          size="sm"
          onClick={() => void runTest()}
          disabled={testing || !settings?.apiKeyConfigured}
        >
          {testing && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Test connection
        </Button>
        {test && (
          <div
            className={`mt-3 rounded-md border p-3 text-sm ${test.ok ? 'border-emerald-900 bg-emerald-950/30' : 'border-red-900 bg-red-950/30'}`}
            role="status"
          >
            <div className="flex items-center gap-2 font-medium">
              {test.ok ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-400" />
              ) : (
                <XCircle className="h-4 w-4 text-red-400" />
              )}
              {test.ok ? 'Connected' : 'Failed'}
              <span className="text-xs font-normal text-zinc-400">{test.latencyMs} ms</span>
            </div>
            {test.reply && (
              <p className="mt-1 text-zinc-300">
                Reply: <span className="font-mono">{test.reply}</span>
              </p>
            )}
            {test.modelListed === false && (
              <p className="mt-1 text-amber-300">
                Warning: the current model is not in the NoTokenLimit model list.
              </p>
            )}
            {test.error && (
              <p className="mt-1 text-red-300">
                <span className="font-mono text-xs">{test.error.kind}</span> — {test.error.message}
              </p>
            )}
          </div>
        )}
      </Section>

      <Section title="Model capabilities">
        {caps ? (
          <>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-zinc-400">Streaming</span>
              <Badge tone={CAP_TONE[caps.streaming]}>{caps.streaming}</Badge>
              <span className="ml-3 text-zinc-400">Tool calling</span>
              <Badge tone={CAP_TONE[caps.toolCalling]}>{caps.toolCalling}</Badge>
              <span className="ml-3 text-zinc-400">Images</span>
              <Badge tone={CAP_TONE[caps.imageInput]}>{caps.imageInput}</Badge>
              <span className="ml-3 text-zinc-400">Context</span>
              <span className="font-mono text-zinc-200">{caps.contextWindow.toLocaleString()}</span>
              <span className="text-xs text-zinc-500">({caps.contextWindowSource})</span>
            </div>
            <p className="mt-1 text-xs text-zinc-500">
              {caps.probedAt
                ? `Probed ${new Date(caps.probedAt).toLocaleString()}`
                : 'Not probed yet: capabilities are unverified.'}
              {caps.notes && ` · ${caps.notes}`}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => void probe()} disabled={probing}>
                {probing && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Probe capabilities
              </Button>
              <label className="ml-2 text-xs text-zinc-400" htmlFor="ctx-window">
                Context window override
              </label>
              <input
                id="ctx-window"
                inputMode="numeric"
                placeholder="tokens"
                value={windowDraft}
                onChange={(e) => setWindowDraft(e.target.value.replace(/[^0-9]/g, ''))}
                className="w-28 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 font-mono text-xs outline-none focus:border-sky-500"
              />
              <Button size="sm" variant="ghost" onClick={() => void saveWindow()}>
                Save
              </Button>
            </div>
          </>
        ) : (
          <p className="text-sm text-zinc-500">Select a model to view its capabilities.</p>
        )}
        <ErrorText error={capsError} />
      </Section>

      <NotificationSettings />
      <McpSettings />
      <DevopsSettings />
      <DatabaseSettings />
      <LoadTargetSettings />
      <VoiceSettings />
      <UsageSettings />
      <Section
        title="Recent provider calls"
        aside={
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void loadCalls()}
            aria-label="Refresh provider calls"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          </Button>
        }
      >
        {calls.length === 0 ? (
          <p className="text-sm text-zinc-500">No calls recorded yet.</p>
        ) : (
          <div
            className="max-h-56 overflow-y-auto rounded-md border border-zinc-800"
            tabIndex={0}
            role="region"
            aria-label="Recent provider calls"
          >
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-zinc-900 text-zinc-400">
                <tr>
                  <th className="px-2 py-1 font-medium">Time</th>
                  <th className="px-2 py-1 font-medium">Operation</th>
                  <th className="px-2 py-1 font-medium">Model</th>
                  <th className="px-2 py-1 font-medium">Status</th>
                  <th className="px-2 py-1 text-right font-medium">ms</th>
                  <th className="px-2 py-1 text-right font-medium">Tokens in/out</th>
                </tr>
              </thead>
              <tbody className="font-mono text-zinc-300">
                {calls.map((c) => (
                  <tr key={c.id} className="border-t border-zinc-800/70">
                    <td className="px-2 py-1">{new Date(c.createdAt).toLocaleTimeString()}</td>
                    <td className="px-2 py-1">{c.operation}</td>
                    <td className="max-w-40 truncate px-2 py-1">{c.model}</td>
                    <td className="px-2 py-1">
                      <Badge
                        tone={
                          c.status === 'ok'
                            ? 'success'
                            : c.status === 'cancelled'
                              ? 'warning'
                              : 'danger'
                        }
                      >
                        {c.errorKind ?? c.status}
                      </Badge>
                      {c.attempts > 1 && <span className="ml-1 text-zinc-500">×{c.attempts}</span>}
                    </td>
                    <td className="px-2 py-1 text-right">{c.durationMs}</td>
                    <td className="px-2 py-1 text-right">
                      {c.tokensEstimated && '~'}
                      {c.inputTokens ?? '–'}/{c.outputTokens ?? '–'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-1 text-[11px] text-zinc-500">
          Only metadata is recorded; prompts and responses are not logged.
        </p>
      </Section>
    </Dialog>
  );
}
