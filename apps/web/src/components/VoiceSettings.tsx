import type { VoiceModelDto, VoiceSettings as Settings } from '@friday/shared';
import { Download, Loader2, Trash2, Volume2, X } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { api } from '../lib/api';
import { player, refreshVoiceStatus, usePlayer, useVoiceStatus } from '../lib/voice';
import { Badge } from './ui/badge';
import { Button } from './ui/button';

const input =
  'w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm outline-none focus:border-sky-500';
const mb = (bytes: number) => `${Math.round(bytes / 1e6)} MB`;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

const PURPOSE: Record<VoiceModelDto['id'], string> = {
  speech: 'Speaks replies',
  transcription: 'Transcribes the microphone',
};

function ModelRow({ m, onError }: { m: VoiceModelDto; onError: (e: unknown) => void }) {
  const act = (fn: () => Promise<unknown>) => () =>
    void fn()
      .catch(onError)
      .finally(() => void refreshVoiceStatus());
  const pct = m.sizeBytes ? Math.floor((m.receivedBytes / m.sizeBytes) * 100) : 0;
  return (
    <li
      className="space-y-1 rounded-md border border-zinc-800 p-2"
      aria-label={`${m.label}: ${m.state}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-zinc-100">{m.label}</span>
        <span className="text-zinc-500">
          {PURPOSE[m.id]} · {mb(m.sizeBytes)} · {m.license}
        </span>
        {m.state === 'ready' && <Badge tone="success">ready</Badge>}
        <span className="ml-auto flex gap-1">
          {(m.state === 'missing' || m.state === 'error') && (
            <Button size="sm" variant="secondary" onClick={act(() => api.downloadVoiceModel(m.id))}>
              <Download className="h-3.5 w-3.5" /> {m.state === 'error' ? 'Retry' : 'Download'}{' '}
              {mb(m.sizeBytes)}
            </Button>
          )}
          {m.state === 'downloading' && (
            <Button size="sm" variant="ghost" onClick={act(() => api.removeVoiceModel(m.id))}>
              <X className="h-3.5 w-3.5" /> Cancel
            </Button>
          )}
          {m.state === 'ready' && (
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6"
              aria-label={`Remove ${m.label}`}
              onClick={act(() => api.removeVoiceModel(m.id))}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </span>
      </div>
      <div className="text-zinc-500">
        From{' '}
        <a href={m.url} target="_blank" rel="noreferrer" className="font-mono hover:text-zinc-300">
          {m.repo}
        </a>{' '}
        at revision <span className="font-mono">{m.revision.slice(0, 10)}</span>, checked against
        its published SHA-256.
      </div>
      {m.state === 'downloading' && (
        <div className="flex items-center gap-2">
          <div
            className="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-800"
            role="progressbar"
            aria-label={`Downloading ${m.label}`}
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className="h-full bg-sky-500" style={{ width: `${pct}%` }} />
          </div>
          <span className="text-zinc-400">
            {mb(m.receivedBytes)} / {mb(m.sizeBytes)}
          </span>
        </div>
      )}
      {m.state === 'error' && m.error && <p className="text-red-400">{m.error}</p>}
    </li>
  );
}

/** Settings → Voice: the local speech models, the voice, and what the microphone listens for. */
export function VoiceSettings() {
  const status = useVoiceStatus();
  const p = usePlayer();
  const [error, setError] = useState<string | null>(null);
  const ids = { heading: useId(), voice: useId(), speed: useId(), language: useId() };
  const downloading = status?.models.some((m) => m.state === 'downloading');

  useEffect(() => {
    if (!downloading) return;
    const t = setInterval(() => void refreshVoiceStatus(), 1000);
    return () => clearInterval(t);
  }, [downloading]);

  const save = (patch: Partial<Settings>) => {
    if (!status) return;
    setError(null);
    void api.setVoiceSettings({ ...status.settings, ...patch }).then(
      () => refreshVoiceStatus(),
      (e: unknown) => setError(message(e)),
    );
  };
  const speechReady = status?.models.some((m) => m.id === 'speech' && m.state === 'ready');
  const voices = status?.voices ?? [];

  return (
    <section className="border-b border-zinc-800 py-4 last:border-0" aria-labelledby={ids.heading}>
      <h3 id={ids.heading} className="mb-2 text-sm font-semibold text-zinc-200">
        Voice
      </h3>
      <p className="mb-2 text-xs text-zinc-500">
        Friday speaks replies with Kokoro and transcribes the microphone with Whisper, both on this
        machine: audio never leaves it and is never stored. Code, logs and output are described, not
        read out. Writing that spoken version takes one extra model call per reply played.
      </p>
      {!status ? (
        <Loader2 className="h-4 w-4 animate-spin text-zinc-500" aria-label="Loading voice" />
      ) : !status.installed ? (
        <p className="text-xs text-amber-300">Voice is not part of this build of Friday.</p>
      ) : (
        <>
          <ul className="mb-3 space-y-1 text-xs">
            {status.models.map((m) => (
              <ModelRow key={m.id} m={m} onError={(e) => setError(message(e))} />
            ))}
          </ul>
          <div className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-3">
            <div>
              <label htmlFor={ids.voice}>Speaking voice</label>
              <select
                id={ids.voice}
                className={input}
                value={status.settings.voice}
                onChange={(e) => save({ voice: e.target.value })}
              >
                {(['American', 'British'] as const).map((accent) => (
                  <optgroup key={accent} label={accent}>
                    {voices
                      .filter((v) => v.accent === accent)
                      .map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.name} ({v.gender})
                        </option>
                      ))}
                  </optgroup>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor={ids.speed}>Speed {status.settings.speed.toFixed(2)}×</label>
              <input
                id={ids.speed}
                type="range"
                min={0.7}
                max={1.4}
                step={0.05}
                className="w-full accent-sky-500"
                value={status.settings.speed}
                onChange={(e) => save({ speed: Number(e.target.value) })}
              />
            </div>
            <div>
              <label htmlFor={ids.language}>Microphone language</label>
              <select
                id={ids.language}
                className={input}
                value={status.settings.language}
                onChange={(e) => save({ language: e.target.value as Settings['language'] })}
              >
                <option value="english">English</option>
                <option value="auto">Detect for each recording</option>
              </select>
            </div>
          </div>
          {speechReady && (
            <Button
              size="sm"
              variant="secondary"
              className="mt-2"
              onClick={() =>
                p.key === 'voice-test'
                  ? player.stop()
                  : void player.say('voice-test', 'Hi, I’m Friday. This is how replies will sound.')
              }
            >
              <Volume2 className="h-3.5 w-3.5" />{' '}
              {p.key === 'voice-test' ? 'Stop' : 'Try the voice'}
            </Button>
          )}
        </>
      )}
      {(error || (p.errorFor === 'voice-test' && p.error)) && (
        <p role="alert" className="mt-1 text-xs text-red-400">
          {error ?? p.error}
        </p>
      )}
    </section>
  );
}
