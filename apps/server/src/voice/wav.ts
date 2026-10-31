/** 16-bit PCM WAV, mono: what Friday sends for speech and accepts from the microphone. */

export function encodeWav(samples: Float32Array, rate: number): Buffer {
  const data = samples.length * 2;
  const buf = Buffer.alloc(44 + data);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + data, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(data, 40);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    buf.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), 44 + i * 2);
  }
  return buf;
}

/**
 * Reads a mono 16-bit PCM WAV at the given rate. Anything else is refused with a reason rather
 * than resampled: the web app records in exactly this format.
 */
export function decodeWav(buf: Buffer, rate: number): Float32Array | string {
  if (
    buf.length < 44 ||
    buf.toString('ascii', 0, 4) !== 'RIFF' ||
    buf.toString('ascii', 8, 12) !== 'WAVE'
  )
    return 'The recording is not a WAV file.';
  let offset = 12;
  let format: { channels: number; rate: number; bits: number; pcm: boolean } | null = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ' && size >= 16 && body + 16 <= buf.length) {
      format = {
        pcm: buf.readUInt16LE(body) === 1,
        channels: buf.readUInt16LE(body + 2),
        rate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      if (!format) return 'The recording has no format header.';
      if (!format.pcm || format.channels !== 1 || format.bits !== 16 || format.rate !== rate)
        return `The recording must be 16-bit mono PCM at ${rate} Hz.`;
      const end = Math.min(buf.length, body + size);
      const n = Math.floor((end - body) / 2);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(body + i * 2) / 0x8000;
      return out;
    }
    offset = body + size + (size % 2);
  }
  return 'The recording has no audio data.';
}
