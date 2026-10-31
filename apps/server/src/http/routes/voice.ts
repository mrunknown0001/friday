import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Services } from '../../services.js';
import { VoiceError } from '../../voice/engine.js';
import { VOICE_MODELS } from '../../voice/models.js';
import {
  MAX_RECORDING_SECONDS,
  SPEAK_CHAR_LIMIT,
  voiceSettingsSchema,
} from '../../voice/service.js';
import { HttpError } from '../errors.js';
import { parseInput } from '../validation.js';

const modelParams = z.object({ id: z.enum(['speech', 'transcription']) });
/** 16-bit mono at 16 kHz, plus the header. */
const RECORDING_BYTES = MAX_RECORDING_SECONDS * 16_000 * 2 + 1024;

async function voice<T>(s: Services, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof VoiceError)
      throw new HttpError(e.status, e.code, s.redactor.redact(e.message));
    throw e;
  }
}

/**
 * Voice: model downloads (only when the user clicks Download), settings, speech for a piece of
 * text, transcription of a recording, and the spoken version of a reply.
 */
export function registerVoiceRoutes(app: FastifyInstance, s: Services) {
  app.addContentTypeParser(
    ['audio/wav', 'audio/x-wav', 'audio/wave'],
    { parseAs: 'buffer', bodyLimit: RECORDING_BYTES },
    (_req, body, done) => done(null, body),
  );

  app.get('/api/voice', async () => s.voice.status());

  app.post('/api/voice/models/:id/download', async (req, reply) => {
    const { id } = parseInput(modelParams, req.params);
    if (!s.voice.status().installed)
      throw new HttpError(501, 'voice_not_installed', 'Voice is not part of this build of Friday.');
    const m = VOICE_MODELS[id];
    if (s.voice.store.status(id).state !== 'downloading') {
      s.audit.record({
        actor: 'user',
        action: 'voice_model_download',
        details: { model: id, repo: m.repo, revision: m.revision },
      });
      void s.voice.store.download(id);
    }
    reply.code(202);
    return s.voice.store.status(id);
  });

  app.delete('/api/voice/models/:id', async (req, reply) => {
    const { id } = parseInput(modelParams, req.params);
    s.voice.store.remove(id);
    s.audit.record({ actor: 'user', action: 'voice_model_removed', details: { model: id } });
    reply.code(204);
  });

  app.put('/api/voice/settings', async (req) =>
    s.voice.setSettings(parseInput(voiceSettingsSchema, req.body)),
  );

  app.post('/api/voice/speak', async (req, reply) => {
    const { text } = parseInput(
      z.strictObject({ text: z.string().trim().min(1).max(SPEAK_CHAR_LIMIT) }),
      req.body,
    );
    // A stopped reply drops its remaining chunks: skip any not yet synthesized.
    const gone = new AbortController();
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) gone.abort();
    });
    const wav = await voice(s, () => s.voice.speak(text, gone.signal));
    return reply.header('Content-Type', 'audio/wav').header('Cache-Control', 'no-store').send(wav);
  });

  app.post('/api/voice/transcribe', { bodyLimit: RECORDING_BYTES }, async (req) => {
    if (!Buffer.isBuffer(req.body))
      throw new HttpError(415, 'unsupported_media_type', 'Send the recording as audio/wav.');
    const body = req.body;
    return { text: await voice(s, () => s.voice.transcribe(body)) };
  });

  app.post('/api/sessions/:sessionId/runs/:runId/spoken', async (req) => {
    const { sessionId, runId } = parseInput(
      z.object({ sessionId: z.string().min(1).max(100), runId: z.string().min(1).max(100) }),
      req.params,
    );
    return voice(s, () => s.voice.spokenReply(sessionId, runId));
  });
}
