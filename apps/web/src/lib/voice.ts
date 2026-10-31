import type { PermissionCategory, VoiceStatusDto } from '@friday/shared';
import { useSyncExternalStore } from 'react';
import { api } from './api';

/**
 * Voice in the web app: playing spoken replies (one at a time, chunk by chunk, the next chunk
 * fetched while the current one plays), recording the microphone for dictation, and the shared
 * voice status. Audio is synthesized and transcribed by the local Friday server.
 */

// ------------------------------------------------------------------ status

let status: VoiceStatusDto | null = null;
const statusListeners = new Set<() => void>();
const emitStatus = () => statusListeners.forEach((l) => l());

let loading: Promise<VoiceStatusDto | null> | null = null;

/** Fetches the status again; callers at the same moment share one request. */
export function refreshVoiceStatus(): Promise<VoiceStatusDto | null> {
  loading ??= api
    .voice()
    .then(
      (s) => (status = s),
      // Unreachable server: keep what we had.
      () => status,
    )
    .finally(() => {
      loading = null;
      emitStatus();
    });
  return loading;
}

export function useVoiceStatus(): VoiceStatusDto | null {
  return useSyncExternalStore(
    (l) => {
      statusListeners.add(l);
      if (!status) void refreshVoiceStatus();
      return () => statusListeners.delete(l);
    },
    () => status,
  );
}

export const modelReady = (s: VoiceStatusDto | null, id: 'speech' | 'transcription') =>
  !!s?.installed && s.models.some((m) => m.id === id && m.state === 'ready');

// ------------------------------------------------------------------ the "Speak replies" toggle

const TOGGLE_KEY = 'friday.voiceReplies';
let repliesOn = (() => {
  try {
    return localStorage.getItem(TOGGLE_KEY) === '1';
  } catch {
    return false;
  }
})();
const toggleListeners = new Set<() => void>();

export function setSpeakReplies(on: boolean): void {
  repliesOn = on;
  try {
    localStorage.setItem(TOGGLE_KEY, on ? '1' : '0');
  } catch {
    // Not remembered in this browser; the toggle still works.
  }
  if (on) unlockAudio();
  else player.stop();
  toggleListeners.forEach((l) => l());
}

export function useSpeakReplies(): boolean {
  return useSyncExternalStore(
    (l) => {
      toggleListeners.add(l);
      return () => toggleListeners.delete(l);
    },
    () => repliesOn,
  );
}

/** What the voice says when a card needs a click (never the command or values on it). */
const APPROVAL_PHRASE: Partial<Record<PermissionCategory, string>> = {
  file_create: 'to create a file',
  file_modify: 'to change a file',
  file_delete: 'to delete or move a file',
  shell: 'to run a command',
  git: 'for a Git action',
  remote: 'to run a command on a remote server',
  deployment: 'for a production change',
  task_permission: 'for a task permission',
  process_control: 'to start or stop a process',
  browser: 'to run a browser flow',
  database: 'to run a database query',
  load_test: 'to run a load test',
  mcp: 'to use a connected app',
};

export const approvalAnnouncement = (category: PermissionCategory) =>
  `Friday needs your approval ${APPROVAL_PHRASE[category] ?? 'for an action'}. The card is in the conversation.`;

// ------------------------------------------------------------------ playback

export interface PlayerState {
  /** What is playing or being prepared: a run id, or another key such as "approval:<id>". */
  key: string | null;
  loading: boolean;
  error: string | null;
  /** The key the error belongs to. */
  errorFor: string | null;
}

let ctx: AudioContext | null = null;

/** Creates or resumes the audio output; call from a click so later replies may play on their own. */
export function unlockAudio(): void {
  if (typeof AudioContext === 'undefined') return;
  ctx ??= new AudioContext();
  if (ctx.state === 'suspended') void ctx.resume();
}

class Player {
  state: PlayerState = { key: null, loading: false, error: null, errorFor: null };
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private source: AudioBufferSourceNode | null = null;
  private abort: AbortController | null = null;

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private set(patch: Partial<PlayerState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  stop(): void {
    this.generation++;
    this.abort?.abort();
    this.abort = null;
    try {
      this.source?.stop();
    } catch {
      // Already stopped.
    }
    this.source = null;
    if (this.state.key || this.state.loading) this.set({ key: null, loading: false });
  }

  /** Speaks a finished run's reply (its spoken version is written by the server on first play). */
  playRun(sessionId: string, runId: string): Promise<void> {
    return this.play(runId, async () => (await api.spokenReply(sessionId, runId)).chunks);
  }

  /** Speaks a short fixed text, such as an approval announcement. */
  say(key: string, text: string): Promise<void> {
    return this.play(key, () => Promise.resolve([text]));
  }

  private async play(key: string, chunks: () => Promise<string[]>): Promise<void> {
    this.stop();
    const gen = this.generation;
    unlockAudio();
    this.set({ key, loading: true, error: null, errorFor: null });
    try {
      const parts = await chunks();
      if (gen !== this.generation) return;
      // The chunks are synthesized one after another without waiting for playback: synthesis is
      // faster than speech, so it stays ahead and there are no pauses between chunks.
      const abort = new AbortController();
      this.abort = abort;
      const audio: Promise<AudioBuffer>[] = [];
      let previous: Promise<unknown> = Promise.resolve();
      for (const text of parts) {
        const next = previous.then(() => this.fetchAudio(text, abort.signal));
        audio.push(next);
        previous = next.catch(() => undefined);
      }
      for (let i = 0; i < audio.length && gen === this.generation; i++) {
        const buffer = await audio[i]!;
        if (gen !== this.generation) return;
        if (i === 0) this.set({ loading: false });
        await this.playBuffer(buffer, gen);
      }
      if (gen === this.generation) this.set({ key: null, loading: false });
    } catch (e) {
      if (gen === this.generation)
        this.set({
          key: null,
          loading: false,
          error: e instanceof Error ? e.message : String(e),
          errorFor: key,
        });
    }
  }

  private async fetchAudio(text: string, signal: AbortSignal): Promise<AudioBuffer> {
    const wav = await api.speak(text, signal);
    return ctx!.decodeAudioData(await wav.arrayBuffer());
  }

  private playBuffer(buffer: AudioBuffer, gen: number): Promise<void> {
    return new Promise((resolve) => {
      if (gen !== this.generation || !ctx) return resolve();
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      src.onended = () => resolve();
      this.source = src;
      src.start();
    });
  }
}

export const player = new Player();

export function usePlayer(): PlayerState {
  return useSyncExternalStore(player.subscribe, () => player.state);
}

// ------------------------------------------------------------------ dictation

/** Whisper's input rate; the server refuses anything else. */
const RATE = 16_000;
export const MAX_RECORDING_SECONDS = 120;

export interface Recording {
  /** Microphone level 0–1, for the indicator. */
  level: () => number;
  /** Stops the microphone and returns the recording as 16 kHz mono WAV. */
  stop: () => Promise<Blob>;
  /** Stops the microphone and drops the audio. */
  cancel: () => void;
}

/** Starts the microphone. Nothing is recorded before this or after stop/cancel. */
export async function startRecording(): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  const release = () => stream.getTracks().forEach((t) => t.stop());
  try {
    const audio = new AudioContext();
    const analyser = audio.createAnalyser();
    analyser.fftSize = 512;
    audio.createMediaStreamSource(stream).connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    const recorder = new MediaRecorder(stream);
    const parts: Blob[] = [];
    recorder.ondataavailable = (e) => e.data.size && parts.push(e.data);
    recorder.start();
    const finish = () => {
      release();
      void audio.close();
    };
    return {
      level: () => {
        analyser.getByteTimeDomainData(samples);
        let peak = 0;
        for (const v of samples) peak = Math.max(peak, Math.abs(v - 128));
        return Math.min(1, peak / 64);
      },
      stop: () =>
        new Promise<Blob>((resolve, reject) => {
          recorder.onstop = () => {
            finish();
            new Blob(parts, { type: recorder.mimeType })
              .arrayBuffer()
              .then(toWav16k)
              .then(resolve, reject);
          };
          recorder.stop();
        }),
      cancel: () => {
        recorder.onstop = finish;
        if (recorder.state !== 'inactive') recorder.stop();
        else finish();
      },
    };
  } catch (e) {
    release();
    throw e;
  }
}

/** Dictation's entry point (an object, so tests can replace it). */
export const recorder = { start: startRecording };

/** Decodes the browser's recording and resamples it to 16 kHz mono 16-bit WAV. */
async function toWav16k(encoded: ArrayBuffer): Promise<Blob> {
  const decoder = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await decoder.decodeAudioData(encoded);
  } finally {
    void decoder.close();
  }
  const seconds = Math.min(decoded.duration, MAX_RECORDING_SECONDS);
  const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(seconds * RATE)), RATE);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  return wavBlob((await offline.startRendering()).getChannelData(0), RATE);
}

export function wavBlob(samples: Float32Array, rate: number): Blob {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const text = (at: number, s: string) =>
    [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  text(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  samples.forEach((s, i) => {
    const c = Math.max(-1, Math.min(1, s));
    v.setInt16(44 + i * 2, c < 0 ? c * 0x8000 : c * 0x7fff, true);
  });
  return new Blob([buf], { type: 'audio/wav' });
}
