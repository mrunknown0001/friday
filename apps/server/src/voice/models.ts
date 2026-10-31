import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { VoiceModelDto, VoiceModelId } from '@friday/shared';

/**
 * The voice models, pinned to a Hugging Face revision with each file's size and SHA-256. Nothing is
 * downloaded until the user asks in Settings, and a file that doesn't match is discarded.
 */
export interface ModelFile {
  path: string;
  size: number;
  sha256: string;
}

export interface VoiceModelSpec {
  id: VoiceModelId;
  label: string;
  repo: string;
  revision: string;
  license: string;
  files: ModelFile[];
}

export const VOICE_MODELS: Record<VoiceModelId, VoiceModelSpec> = {
  speech: {
    id: 'speech',
    label: 'Kokoro 82M (8-bit)',
    repo: 'onnx-community/Kokoro-82M-v1.0-ONNX',
    revision: '1939ad2a8e416c0acfeecc08a694d14ef25f2231',
    license: 'Apache-2.0',
    files: [
      {
        path: 'config.json',
        size: 44,
        sha256: 'df34b4f930b23447cd4dc410fabfb42eb3f24e803e6c3f97d618fb359380a36f',
      },
      {
        path: 'tokenizer.json',
        size: 3497,
        sha256: '77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34',
      },
      {
        path: 'tokenizer_config.json',
        size: 113,
        sha256: 'be1cb066d6ef6b074b3f15e6a6dd21ac88ff3cdaedf325f0aaed686c70f75d20',
      },
      {
        path: 'onnx/model_quantized.onnx',
        size: 92361116,
        sha256: 'fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478',
      },
    ],
  },
  transcription: {
    id: 'transcription',
    label: 'Whisper base (8-bit)',
    repo: 'onnx-community/whisper-base',
    revision: '1846881b6b3a3024392c1eea3ad983695bc23925',
    license: 'MIT',
    files: [
      {
        path: 'config.json',
        size: 2243,
        sha256: 'f4d0608f7d918166da7edb3e188de5ef1bfe70d9802e785d271fd88111e9cf4b',
      },
      {
        path: 'generation_config.json',
        size: 3832,
        sha256: '61070cf8de25b1e9256e8e102ded49d8d24a8369ed36ef84fdf21549e68125a0',
      },
      {
        path: 'preprocessor_config.json',
        size: 339,
        sha256: 'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d',
      },
      {
        path: 'tokenizer.json',
        size: 2480466,
        sha256: '27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566',
      },
      {
        path: 'tokenizer_config.json',
        size: 282682,
        sha256: '2e036e4dbacfdeb7242c7d4ec4149f4a16e86026048f94d1637e3a8ee9c6a573',
      },
      {
        path: 'onnx/encoder_model_quantized.onnx',
        size: 23201314,
        sha256: '5862993336bf33acd23736071aae2b32261d3b1b2f37780194460d4ef974dd46',
      },
      {
        path: 'onnx/decoder_model_merged_quantized.onnx',
        size: 53693315,
        sha256: 'fa3ef9902734ce5ae6f9ef2bdb2ba9a6c4b5785b09f4f420ce036573dc9d090b',
      },
    ],
  },
};

const HF = 'https://huggingface.co';
/** Hugging Face serves large files from its CDNs; a redirect anywhere else is refused. */
const ALLOWED_HOSTS = /(^|\.)(huggingface\.co|hf\.co)$/;

export const modelSize = (m: VoiceModelSpec) => m.files.reduce((s, f) => s + f.size, 0);
export const fileUrl = (m: VoiceModelSpec, f: ModelFile) =>
  `${HF}/${m.repo}/resolve/${m.revision}/${f.path}`;

interface Progress {
  received: number;
  error: string | null;
  abort: AbortController | null;
}

/**
 * The downloaded models, in `<dir>/<repo>/<file>` (the layout transformers.js reads with remote
 * loading turned off). One download per model at a time; progress is polled through status().
 */
export class VoiceModelStore {
  private readonly progress = new Map<VoiceModelId, Progress>();

  constructor(
    readonly dir: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly models: Record<VoiceModelId, VoiceModelSpec> = VOICE_MODELS,
  ) {}

  private filePath(m: VoiceModelSpec, f: ModelFile) {
    return path.join(this.dir, ...m.repo.split('/'), ...f.path.split('/'));
  }

  /** Every file present with its expected size (hashes were checked when it was downloaded). */
  isReady(id: VoiceModelId): boolean {
    const m = this.models[id];
    return m.files.every((f) => {
      try {
        return fs.statSync(this.filePath(m, f)).size === f.size;
      } catch {
        return false;
      }
    });
  }

  status(id: VoiceModelId): VoiceModelDto {
    const m = this.models[id];
    const p = this.progress.get(id);
    const ready = !p?.abort && this.isReady(id);
    return {
      id,
      label: m.label,
      repo: m.repo,
      revision: m.revision,
      url: `${HF}/${m.repo}/tree/${m.revision}`,
      license: m.license,
      sizeBytes: modelSize(m),
      state: p?.abort ? 'downloading' : ready ? 'ready' : p?.error ? 'error' : 'missing',
      receivedBytes: ready ? modelSize(m) : (p?.received ?? 0),
      error: ready ? null : (p?.error ?? null),
    };
  }

  /** Starts the download if it isn't running; resolves when it ends (the route doesn't wait). */
  download(id: VoiceModelId): Promise<void> {
    const current = this.progress.get(id);
    if (current?.abort) return Promise.resolve();
    const p: Progress = { received: 0, error: null, abort: new AbortController() };
    this.progress.set(id, p);
    return this.fetchAll(this.models[id], p)
      .catch((e: unknown) => {
        p.error = p.abort?.signal.aborted
          ? 'Download cancelled.'
          : e instanceof Error
            ? e.message
            : String(e);
      })
      .finally(() => {
        p.abort = null;
      });
  }

  /** Cancels a running download and removes the model's files. */
  remove(id: VoiceModelId): void {
    const p = this.progress.get(id);
    p?.abort?.abort();
    this.progress.delete(id);
    fs.rmSync(path.join(this.dir, ...this.models[id].repo.split('/')), {
      recursive: true,
      force: true,
    });
  }

  cancelAll(): void {
    for (const p of this.progress.values()) p.abort?.abort();
  }

  private async fetchAll(m: VoiceModelSpec, p: Progress): Promise<void> {
    for (const f of m.files) {
      const target = this.filePath(m, f);
      if (fs.existsSync(target) && (await sha256File(target)) === f.sha256) {
        p.received += f.size;
        continue;
      }
      await this.fetchFile(m, f, target, p);
    }
  }

  private async fetchFile(m: VoiceModelSpec, f: ModelFile, target: string, p: Progress) {
    const signal = p.abort!.signal;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const part = `${target}.part`;
    const base = p.received;
    // Redirects are followed by hand so each hop can be checked.
    let url = fileUrl(m, f);
    let res: Response | null = null;
    for (let hop = 0; hop < 5; hop++) {
      const u = new URL(url);
      if (u.protocol !== 'https:' || !ALLOWED_HOSTS.test(u.hostname))
        throw new Error(`Refused to download ${f.path} from ${u.host}.`);
      res = await this.fetchImpl(url, { redirect: 'manual', signal });
      const next = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (!next) break;
      await res.body?.cancel();
      url = new URL(next, url).toString();
      res = null;
    }
    if (!res) throw new Error(`Too many redirects for ${f.path}.`);
    if (!res.ok || !res.body)
      throw new Error(`Hugging Face answered ${res.status} for ${m.repo}/${f.path}.`);
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(part);
    let size = 0;
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        size += chunk.length;
        if (size > f.size) throw new Error(`${f.path} is larger than expected; discarded.`);
        hash.update(chunk);
        if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()));
        p.received = base + size;
      }
      await new Promise<void>((resolve, reject) =>
        out.end((err?: Error | null) => (err ? reject(err) : resolve())),
      );
      if (size !== f.size || hash.digest('hex') !== f.sha256)
        throw new Error(`${f.path} did not match its published checksum; discarded.`);
      fs.renameSync(part, target);
    } catch (e) {
      out.destroy();
      fs.rmSync(part, { force: true });
      throw e;
    }
  }
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (c) => hash.update(c))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}
