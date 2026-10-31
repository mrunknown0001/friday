import path from 'node:path';
import type { SpokenReplyDto, VoiceModelId, VoiceSettings, VoiceStatusDto } from '@friday/shared';
import { z } from 'zod';
import type { LLMProvider } from '../providers/types.js';
import type { MessageRepo } from '../repositories/messages.js';
import type { RunRepo } from '../repositories/runs.js';
import type { SettingsRepo } from '../repositories/settings.js';
import type { SpokenReplyRepo } from '../repositories/spokenReplies.js';
import type { Redactor } from '../security/redact.js';
import {
  DEFAULT_VOICE,
  SPEECH_RATE,
  TRANSCRIBE_RATE,
  VOICES,
  VoiceError,
  type VoiceEngine,
} from './engine.js';
import type { VoiceModelStore } from './models.js';
import { cleanSpoken, speechChunks, writeSpokenReply } from './spoken.js';
import { decodeWav, encodeWav } from './wav.js';

export const SPEAK_CHAR_LIMIT = 600;
export const MAX_RECORDING_SECONDS = 120;

export const voiceSettingsSchema = z.strictObject({
  voice: z.enum(VOICES.map((v) => v.id) as [string, ...string[]]),
  speed: z.number().min(0.7).max(1.4),
  language: z.enum(['english', 'auto']),
});
const DEFAULTS: VoiceSettings = { voice: DEFAULT_VOICE, speed: 1, language: 'english' };
const SETTINGS_KEY = 'voice';

export const voiceModelsDir = (dataDir: string) => path.join(dataDir, 'voice-models');

export interface VoiceDeps {
  store: VoiceModelStore;
  engine: VoiceEngine;
  settings: SettingsRepo;
  spoken: SpokenReplyRepo;
  messages: MessageRepo;
  runs: RunRepo;
  provider: LLMProvider;
  redactor: Redactor;
  resolveModel: () => string | null;
}

/**
 * Voice replies and voice input. Speech and transcription run on this machine; the only call that
 * leaves it is the spoken-version request to the model provider, made when a reply is played.
 */
export class VoiceService {
  /** One spoken-version call per run even if the reply is played twice at once. */
  private readonly writing = new Map<string, Promise<SpokenReplyDto>>();

  constructor(private readonly d: VoiceDeps) {}

  get store() {
    return this.d.store;
  }

  status(): VoiceStatusDto {
    return {
      installed: this.d.engine.installed(),
      models: (['speech', 'transcription'] as VoiceModelId[]).map((id) => this.d.store.status(id)),
      voices: VOICES,
      settings: this.getSettings(),
    };
  }

  getSettings(): VoiceSettings {
    return this.d.settings.get(SETTINGS_KEY, voiceSettingsSchema) ?? DEFAULTS;
  }

  setSettings(s: VoiceSettings): VoiceSettings {
    this.d.settings.set(SETTINGS_KEY, s);
    return s;
  }

  /** The spoken version of a finished run's reply, written once and then kept. */
  async spokenReply(sessionId: string, runId: string): Promise<SpokenReplyDto> {
    const run = this.d.runs.get(runId);
    if (!run || run.sessionId !== sessionId)
      throw new VoiceError('Run not found.', 404, 'run_not_found');
    const saved = this.d.spoken.get(runId);
    if (saved) return toDto(saved.runId, saved.text, saved.model);
    if (run.status === 'running' || run.status === 'awaiting_approval')
      throw new VoiceError('The reply is still being written.', 409, 'reply_in_progress');
    const reply = this.d.messages
      .listBySession(sessionId)
      .filter((m) => m.runId === runId && m.role === 'assistant' && m.content.trim())
      .map((m) => m.content.trim())
      .join('\n\n');
    if (!reply) throw new VoiceError('This run has no reply to speak.', 404, 'no_reply');
    const model = run.model ?? this.d.resolveModel();
    if (!model) throw new VoiceError('Choose a model in Settings first.', 409, 'no_model');
    const pending = this.writing.get(runId);
    if (pending) return pending;
    const job = writeSpokenReply(this.d.provider, model, this.d.redactor.redact(reply), {
      sessionId,
    })
      .then((text) => {
        const safe = this.d.redactor.redact(text);
        this.d.spoken.save({ runId, sessionId, text: safe, model });
        return toDto(runId, safe, model);
      })
      .finally(() => this.writing.delete(runId));
    this.writing.set(runId, job);
    return job;
  }

  /** Speech for one chunk of text, as WAV. */
  async speak(text: string, signal?: AbortSignal): Promise<Buffer> {
    const clean = cleanSpoken(this.d.redactor.redact(text)).slice(0, SPEAK_CHAR_LIMIT);
    if (!clean) throw new VoiceError('Nothing to say.');
    const s = this.getSettings();
    const audio = await this.d.engine.speak(clean, {
      voice: s.voice,
      speed: s.speed,
      ...(signal ? { signal } : {}),
    });
    return encodeWav(audio, SPEECH_RATE);
  }

  /** The text of a recording (16 kHz mono WAV). The audio is never written anywhere. */
  async transcribe(wav: Buffer): Promise<string> {
    const audio = decodeWav(wav, TRANSCRIBE_RATE);
    if (typeof audio === 'string') throw new VoiceError(audio);
    if (audio.length > MAX_RECORDING_SECONDS * TRANSCRIBE_RATE)
      throw new VoiceError(`Recordings can be at most ${MAX_RECORDING_SECONDS / 60} minutes.`);
    if (audio.length < TRANSCRIBE_RATE / 4) return '';
    const text = (await this.d.engine.transcribe(audio, this.getSettings().language)).trim();
    // Whisper writes these for silence or noise.
    return /^\s*[([]?\s*(blank_audio|silence|music|inaudible|no speech)\s*[)\]]?\s*$/i.test(text)
      ? ''
      : text;
  }

  async close(): Promise<void> {
    this.d.store.cancelAll();
    await this.d.engine.close();
  }
}

const toDto = (runId: string, text: string, model: string): SpokenReplyDto => ({
  runId,
  text,
  chunks: speechChunks(text),
  model,
});
