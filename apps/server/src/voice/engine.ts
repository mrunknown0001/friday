import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import type { VoiceOption } from '@friday/shared';
import { VOICE_MODELS, type VoiceModelStore } from './models.js';

/** Kokoro's English voices (kokoro-js ships their style vectors; nothing is downloaded for them). */
const VOICE_IDS = [
  'af_heart',
  'af_alloy',
  'af_aoede',
  'af_bella',
  'af_jessica',
  'af_kore',
  'af_nicole',
  'af_nova',
  'af_river',
  'af_sarah',
  'af_sky',
  'am_adam',
  'am_echo',
  'am_eric',
  'am_fenrir',
  'am_liam',
  'am_michael',
  'am_onyx',
  'am_puck',
  'bf_alice',
  'bf_emma',
  'bf_isabella',
  'bf_lily',
  'bm_daniel',
  'bm_fable',
  'bm_george',
  'bm_lewis',
] as const;

export const VOICES: VoiceOption[] = VOICE_IDS.map((id) => ({
  id,
  name: id[3]!.toUpperCase() + id.slice(4),
  accent: id[0] === 'a' ? 'American' : 'British',
  gender: id[1] === 'f' ? 'female' : 'male',
}));
export const DEFAULT_VOICE = 'af_heart';

/** Kokoro's output rate; the microphone is sent at Whisper's 16 kHz. */
export const SPEECH_RATE = 24_000;
export const TRANSCRIBE_RATE = 16_000;

const IDLE_MS = 5 * 60_000;
const SPEAK_TIMEOUT_MS = 60_000;
const TRANSCRIBE_TIMEOUT_MS = 90_000;

/** A voice request that can't be served; the route answers with its status and message. */
export class VoiceError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = 'voice_error',
  ) {
    super(message);
  }
}

/**
 * Runs in the worker: loads each model on first use with remote loading off, so transformers.js
 * only reads the files Friday downloaded and checked.
 */
const WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
let tts = null, asr = null;
const tf = require(workerData.transformers);
tf.env.allowRemoteModels = false;
tf.env.allowLocalModels = true;
tf.env.localModelPath = workerData.modelDir;
tf.env.useBrowserCache = false;
tf.env.useFSCache = false;
const { KokoroTTS } = require(workerData.kokoro);
parentPort.on('message', async (job) => {
  try {
    if (job.kind === 'speak') {
      tts = tts || await KokoroTTS.from_pretrained(workerData.speechRepo, { dtype: 'q8', device: 'cpu' });
      const out = await tts.generate(job.text, { voice: job.voice, speed: job.speed });
      const audio = Float32Array.from(out.audio);
      parentPort.postMessage({ id: job.id, ok: true, audio }, [audio.buffer]);
    } else {
      asr = asr || await tf.pipeline('automatic-speech-recognition', workerData.transcriptionRepo, {
        dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
        device: 'cpu',
      });
      const out = await asr(job.audio, {
        task: 'transcribe',
        language: job.language === 'auto' ? null : job.language,
        chunk_length_s: 30,
        stride_length_s: 5,
      });
      parentPort.postMessage({ id: job.id, ok: true, text: String(out.text || '') });
    }
  } catch (e) {
    parentPort.postMessage({ id: job.id, ok: false, error: e && e.message ? e.message : String(e) });
  }
});
`;

type Job =
  | { kind: 'speak'; text: string; voice: string; speed: number }
  | { kind: 'transcribe'; audio: Float32Array; language: 'english' | 'auto' };

interface Reply {
  id: number;
  ok: boolean;
  error?: string;
  audio?: Float32Array;
  text?: string;
}

export interface VoiceEngine {
  /** The speech packages are part of this build. */
  installed(): boolean;
  /** A job whose signal is aborted before its turn is skipped. */
  speak(
    text: string,
    o: { voice: string; speed: number; signal?: AbortSignal },
  ): Promise<Float32Array>;
  transcribe(audio: Float32Array, language: 'english' | 'auto'): Promise<string>;
  close(): Promise<void>;
}

function resolvePackages(): { kokoro: string; transformers: string } | null {
  try {
    const require = createRequire(import.meta.url);
    return {
      kokoro: require.resolve('kokoro-js'),
      transformers: require.resolve('@huggingface/transformers'),
    };
  } catch {
    return null;
  }
}

/**
 * Kokoro and Whisper in one worker thread, one job at a time. The worker starts on the first job
 * and is stopped after five idle minutes, which frees the models' memory (about 1 GB with both).
 */
export class LocalVoiceEngine implements VoiceEngine {
  private readonly packages = resolvePackages();
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly waiting = new Map<number, (r: Reply) => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private idle: NodeJS.Timeout | null = null;

  constructor(private readonly store: VoiceModelStore) {}

  installed(): boolean {
    return this.packages !== null;
  }

  async speak(
    text: string,
    o: { voice: string; speed: number; signal?: AbortSignal },
  ): Promise<Float32Array> {
    if (!this.store.isReady('speech'))
      throw new VoiceError(
        'Download the speech model in Settings → Voice first.',
        409,
        'model_missing',
      );
    return this.run(
      { kind: 'speak', text, voice: o.voice, speed: o.speed },
      SPEAK_TIMEOUT_MS,
      o.signal,
    ).then((r) => r.audio!);
  }

  async transcribe(audio: Float32Array, language: 'english' | 'auto'): Promise<string> {
    if (!this.store.isReady('transcription'))
      throw new VoiceError(
        'Download the transcription model in Settings → Voice first.',
        409,
        'model_missing',
      );
    return this.run({ kind: 'transcribe', audio, language }, TRANSCRIBE_TIMEOUT_MS).then(
      (r) => r.text!,
    );
  }

  async close(): Promise<void> {
    if (this.idle) clearTimeout(this.idle);
    const w = this.worker;
    this.worker = null;
    if (w) await w.terminate();
  }

  private run(job: Job, timeoutMs: number, signal?: AbortSignal): Promise<Reply> {
    const result = this.queue.then(() => {
      if (signal?.aborted) throw new VoiceError('Cancelled.', 499, 'cancelled');
      return this.send(job, timeoutMs);
    });
    this.queue = result.catch(() => undefined);
    return result;
  }

  private send(job: Job, timeoutMs: number): Promise<Reply> {
    if (this.idle) clearTimeout(this.idle);
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        // A stuck model can't be interrupted; the next job starts a fresh worker.
        void this.close();
        reject(new VoiceError('Speech took too long and was stopped.', 503, 'voice_timeout'));
      }, timeoutMs);
      this.waiting.set(id, (r) => {
        clearTimeout(timer);
        if (r.ok) resolve(r);
        else reject(new VoiceError(r.error ?? 'Speech failed.', 500, 'voice_failed'));
      });
      worker.postMessage(
        { ...job, id },
        job.kind === 'transcribe' ? [job.audio.buffer as ArrayBuffer] : [],
      );
    }).finally(() => {
      if (this.waiting.size === 0) this.idle = setTimeout(() => void this.close(), IDLE_MS);
      this.idle?.unref();
    });
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    if (!this.packages)
      throw new VoiceError(
        'Voice is not part of this build of Friday.',
        501,
        'voice_not_installed',
      );
    const worker = new Worker(WORKER, {
      eval: true,
      stderr: true,
      workerData: {
        ...this.packages,
        modelDir: this.store.dir + '/',
        speechRepo: VOICE_MODELS.speech.repo,
        transcriptionRepo: VOICE_MODELS.transcription.repo,
      },
    });
    // onnxruntime prints warnings about unused initializers; they are not useful in the log.
    worker.stderr.resume();
    worker.on('message', (r: Reply) => {
      const done = this.waiting.get(r.id);
      this.waiting.delete(r.id);
      done?.(r);
    });
    const fail = (message: string) => {
      if (this.worker === worker) this.worker = null;
      for (const [id, done] of this.waiting) {
        this.waiting.delete(id);
        done({ id, ok: false, error: message });
      }
    };
    worker.on('error', (e) => fail(e.message));
    worker.on('exit', () => fail('The speech worker stopped.'));
    this.worker = worker;
    return worker;
  }
}
