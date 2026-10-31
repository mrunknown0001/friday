import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SpokenReplyDto, VoiceStatusDto } from '@friday/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { LocalVoiceEngine, type VoiceEngine } from '../src/voice/engine.js';
import { VOICE_MODELS, VoiceModelStore, type VoiceModelSpec } from '../src/voice/models.js';
import { cleanSpoken, speechChunks } from '../src/voice/spoken.js';
import { decodeWav, encodeWav } from '../src/voice/wav.js';
import { ScriptedProvider, testServices } from './helpers.js';

const H = { host: '127.0.0.1:4317', 'x-friday-client': '1', 'content-type': 'application/json' };
/** A POST without a body. */
const P = { host: H.host, 'x-friday-client': '1' };
const sha = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'friday-voice-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A tiny model spec served by a fake fetch. */
function fakeModel(
  files: Record<string, string>,
): Record<'speech' | 'transcription', VoiceModelSpec> {
  const spec = (id: 'speech' | 'transcription'): VoiceModelSpec => ({
    id,
    label: id,
    repo: `test/${id}`,
    revision: 'abc123',
    license: 'MIT',
    files: Object.entries(files).map(([p, body]) => ({
      path: p,
      size: Buffer.byteLength(body),
      sha256: sha(body),
    })),
  });
  return { speech: spec('speech'), transcription: spec('transcription') };
}

function fakeFetch(serve: (url: URL) => Response, seen: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    seen.push(url.toString());
    return serve(url);
  }) as typeof fetch;
}

describe('voice model downloads', () => {
  it('downloads each pinned file, follows Hugging Face redirects and checks the hash', async () => {
    const files = { 'config.json': '{"a":1}', 'onnx/model.onnx': 'weights' };
    const seen: string[] = [];
    const store = new VoiceModelStore(
      dir,
      fakeFetch((u) => {
        if (u.hostname === 'huggingface.co')
          return new Response(null, {
            status: 302,
            headers: { location: `https://cdn-lfs.hf.co/x${u.pathname}` },
          });
        const name = u.pathname.split('/resolve/abc123/')[1]!;
        return new Response(files[name as keyof typeof files]);
      }, seen),
      fakeModel(files),
    );
    expect(store.status('speech').state).toBe('missing');
    await store.download('speech');
    expect(store.status('speech')).toMatchObject({ state: 'ready', receivedBytes: 14 });
    expect(seen[0]).toBe('https://huggingface.co/test/speech/resolve/abc123/config.json');
    expect(fs.readFileSync(path.join(dir, 'test', 'speech', 'onnx', 'model.onnx'), 'utf8')).toBe(
      'weights',
    );
    store.remove('speech');
    expect(store.status('speech').state).toBe('missing');
  });

  it('discards a file that does not match and refuses other hosts', async () => {
    const files = { 'config.json': '{"a":1}' };
    const tampered = new VoiceModelStore(
      dir,
      fakeFetch(() => new Response('{"a":2}')),
      fakeModel(files),
    );
    await tampered.download('speech');
    expect(tampered.status('speech')).toMatchObject({
      state: 'error',
      error: 'config.json did not match its published checksum; discarded.',
    });
    expect(fs.existsSync(path.join(dir, 'test', 'speech', 'config.json.part'))).toBe(false);

    const redirected = new VoiceModelStore(
      dir,
      fakeFetch(
        () => new Response(null, { status: 302, headers: { location: 'https://evil.test/x' } }),
      ),
      fakeModel(files),
    );
    await redirected.download('speech');
    expect(redirected.status('speech').error).toBe(
      'Refused to download config.json from evil.test.',
    );
  });

  it('pins every real model file with a size and SHA-256', () => {
    for (const m of Object.values(VOICE_MODELS)) {
      expect(m.revision).toMatch(/^[0-9a-f]{40}$/);
      for (const f of m.files) {
        expect(f.size).toBeGreaterThan(0);
        expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });
});

describe('the spoken version', () => {
  it('removes anything technical the model left in', () => {
    expect(
      cleanSpoken(
        '## Done\n- I fixed `auth.ts` in /home/me/app/src/auth.ts.\n```ts\nconst a = 1;\n```\nKey [REDACTED], see https://x.test/a and commit 3f2a9c1d8e7b6a5f.',
      ),
    ).toBe('Done I fixed auth.ts in auth.ts. Key a hidden value, see a link and commit .');
  });

  it('splits into short chunks, the first one shortest', () => {
    const text =
      'All tests pass. ' +
      'The fix changes the comparison in the cart total so the last item is counted, and the new test covers an empty cart, a single item and a discount. ' +
      'Next, I can open a pull request.';
    const chunks = speechChunks(text, 120);
    expect(chunks[0]).toBe('All tests pass.');
    expect(chunks.every((c) => c.length <= 120)).toBe(true);
    expect(chunks.join(' ')).toBe(text);
    // Each chunk within its limit (100, then 1.3 times more each time, up to 240).
    const long = speechChunks('Word after word goes here. '.repeat(40));
    const limits = [100, 130, 169, 220, 240, 240];
    long.slice(0, 6).forEach((c, i) => expect(c.length).toBeLessThanOrEqual(limits[i]!));
    expect(long[3]!.length).toBeGreaterThan(long[0]!.length * 1.5);
  });

  it('starts with a short piece when the first sentence is long', () => {
    const text =
      'The key line is the condition that was using strict less-than, which was excluding items whose quantity matched the limit exactly. Changing it fixes the count.';
    const chunks = speechChunks(text);
    expect(chunks[0]).toBe('The key line is the condition that was using strict less-than,');
    expect(chunks.join(' ')).toBe(text);
  });
});

describe('wav', () => {
  it('round-trips 16-bit mono and refuses other formats', () => {
    const samples = Float32Array.from([0, 0.5, -0.5, 1, -1]);
    const wav = encodeWav(samples, 16_000);
    const back = decodeWav(wav, 16_000) as Float32Array;
    expect(back.length).toBe(5);
    expect(back[1]).toBeCloseTo(0.5, 3);
    expect(decodeWav(wav, 24_000)).toBe('The recording must be 16-bit mono PCM at 24000 Hz.');
    expect(decodeWav(Buffer.from('nope'), 16_000)).toBe('The recording is not a WAV file.');
  });
});

class FakeEngine implements VoiceEngine {
  spoken: string[] = [];
  heard: number[] = [];
  installed() {
    return true;
  }
  async speak(text: string) {
    this.spoken.push(text);
    return new Float32Array(2400);
  }
  async transcribe(audio: Float32Array) {
    this.heard.push(audio.length);
    return ' Run the tests please. ';
  }
  async close() {}
}

describe('voice routes', () => {
  function setup() {
    const provider = new ScriptedProvider(
      [],
      [
        {
          text: 'I fixed the total. The fix is the comparison on line twelve.',
          toolCalls: [],
          finishReason: 'stop',
          usage: null,
        },
      ],
    );
    const engine = new FakeEngine();
    const files = { 'config.json': '{}' };
    // Both models "downloaded".
    for (const id of ['speech', 'transcription']) {
      fs.mkdirSync(path.join(dir, 'test', id), { recursive: true });
      fs.writeFileSync(path.join(dir, 'test', id, 'config.json'), '{}');
    }
    const s = testServices({ provider, voiceEngine: engine, voiceModelsDir: dir });
    // The store reads the real manifest; point it at the fake one.
    Object.assign(s.voice.store, { models: fakeModel(files) });
    return { s, provider, engine };
  }

  it('reports the models and settings, and validates settings', async () => {
    const { s } = setup();
    const app = await buildApp(s);
    const status = (
      await app.inject({ method: 'GET', url: '/api/voice', headers: H })
    ).json<VoiceStatusDto>();
    expect(status.installed).toBe(true);
    expect(status.models.map((m) => m.state)).toEqual(['ready', 'ready']);
    expect(status.settings).toEqual({ voice: 'af_heart', speed: 1, language: 'english' });
    expect(status.voices.find((v) => v.id === 'bm_george')).toEqual({
      id: 'bm_george',
      name: 'George',
      accent: 'British',
      gender: 'male',
    });
    const bad = await app.inject({
      method: 'PUT',
      url: '/api/voice/settings',
      headers: H,
      payload: { voice: 'xx', speed: 1, language: 'english' },
    });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({
      method: 'PUT',
      url: '/api/voice/settings',
      headers: H,
      payload: { voice: 'bf_emma', speed: 1.2, language: 'auto' },
    });
    expect(ok.json()).toEqual({ voice: 'bf_emma', speed: 1.2, language: 'auto' });
    await app.close();
  });

  it('writes the spoken version of a finished run once, then serves it again', async () => {
    const { s, provider } = setup();
    const session = s.sessions.create();
    const user = s.messages.insert({
      sessionId: session.id,
      role: 'user',
      content: 'fix it',
      status: 'complete',
    });
    const run = s.runs.create({
      id: 'run-1',
      sessionId: session.id,
      userMessageId: user.id,
      model: 'test-model',
    });
    s.messages.insert({
      sessionId: session.id,
      runId: run.id,
      role: 'assistant',
      content: 'Fixed.\n```ts\nif (i <= n) total += x;\n```\nKey sk-abcdefghijklmnopqrstuv',
      status: 'complete',
      model: 'test-model',
    });
    const app = await buildApp(s);
    const url = `/api/sessions/${session.id}/runs/${run.id}/spoken`;
    expect((await app.inject({ method: 'POST', url, headers: P })).statusCode).toBe(409);
    s.runs.finish(run.id, 'completed');
    const first = (await app.inject({ method: 'POST', url, headers: P })).json<SpokenReplyDto>();
    expect(first).toEqual({
      runId: 'run-1',
      text: 'I fixed the total. The fix is the comparison on line twelve.',
      chunks: ['I fixed the total. The fix is the comparison on line twelve.'],
      model: 'test-model',
    });
    // The reply went out redacted, as data.
    const sent = provider.completeRequests[0]!;
    expect(sent.operation).toBe('spoken_reply');
    expect(sent.messages[1]!.content).toContain('if (i <= n) total += x;');
    expect(sent.messages[1]!.content).not.toContain('sk-abcdefghijklmnopqrstuv');
    const again = (await app.inject({ method: 'POST', url, headers: P })).json<SpokenReplyDto>();
    expect(again.text).toBe(first.text);
    expect(provider.completeRequests).toHaveLength(1);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/sessions/other/runs/${run.id}/spoken`,
          headers: P,
        })
      ).statusCode,
    ).toBe(404);
    await app.close();
  });

  it('speaks text as WAV and transcribes a recording without storing it', async () => {
    const { s, engine } = setup();
    const app = await buildApp(s);
    const speech = await app.inject({
      method: 'POST',
      url: '/api/voice/speak',
      headers: H,
      payload: { text: 'Friday needs your approval to run a command.' },
    });
    expect(speech.statusCode).toBe(200);
    expect(speech.headers['content-type']).toBe('audio/wav');
    expect(speech.rawPayload.subarray(0, 4).toString()).toBe('RIFF');
    expect(engine.spoken).toEqual(['Friday needs your approval to run a command.']);

    const wav = encodeWav(new Float32Array(16_000), 16_000);
    const heard = await app.inject({
      method: 'POST',
      url: '/api/voice/transcribe',
      headers: { ...H, 'content-type': 'audio/wav' },
      payload: wav,
    });
    expect(heard.json()).toEqual({ text: 'Run the tests please.' });
    expect(engine.heard).toEqual([16_000]);
    const wrongRate = await app.inject({
      method: 'POST',
      url: '/api/voice/transcribe',
      headers: { ...H, 'content-type': 'audio/wav' },
      payload: encodeWav(new Float32Array(48_000), 48_000),
    });
    expect(wrongRate.json().error.message).toBe(
      'The recording must be 16-bit mono PCM at 16000 Hz.',
    );
    const noClientHeader = await app.inject({
      method: 'POST',
      url: '/api/voice/transcribe',
      headers: { host: H.host, 'content-type': 'audio/wav' },
      payload: wav,
    });
    expect(noClientHeader.statusCode).toBe(403);
    await app.close();
  });

  it('asks for the model download before speaking', async () => {
    const s = testServices({ voiceEngine: undefined, voiceModelsDir: dir });
    const app = await buildApp(s);
    const res = await app.inject({
      method: 'POST',
      url: '/api/voice/speak',
      headers: H,
      payload: { text: 'hello' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe('Download the speech model in Settings → Voice first.');
    await app.close();
    await s.voice.close();
  });
});

// Real Kokoro and Whisper: FRIDAY_TEST_VOICE_MODELS points at a folder with both models downloaded.
const modelsDir = process.env.FRIDAY_TEST_VOICE_MODELS;
describe.skipIf(!modelsDir)('real speech and transcription', () => {
  it('speaks a sentence and hears it back', async () => {
    const engine = new LocalVoiceEngine(new VoiceModelStore(modelsDir!));
    try {
      const audio = await engine.speak('Friday needs your approval to run the tests.', {
        voice: 'af_heart',
        speed: 1,
      });
      expect(audio.length).toBeGreaterThan(24_000);
      // 24 kHz to 16 kHz, nearest sample.
      const resampled = Float32Array.from(
        { length: Math.floor((audio.length * 2) / 3) },
        (_, i) => audio[Math.floor((i * 3) / 2)]!,
      );
      const text = await engine.transcribe(resampled, 'english');
      expect(text.toLowerCase()).toContain('approval to run the tests');
    } finally {
      await engine.close();
    }
  }, 120_000);
});
