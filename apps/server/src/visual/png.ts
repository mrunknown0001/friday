import zlib from 'node:zlib';

/**
 * Just enough PNG to compare screenshots: decode 8-bit grayscale, RGB and RGBA images (what
 * browsers produce), with or without alpha, non-interlaced; encode RGBA. Built on Node's zlib,
 * so no image library is needed.
 */

export interface Bitmap {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, row by row. */
  data: Uint8Array;
}

export class PngError extends Error {}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Channels per color type: grayscale, RGB, (palette: unsupported), gray+alpha, RGBA. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };
const MAX_PIXELS = 2_560 * 8_000;

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodePng(buf: Buffer): Bitmap {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new PngError('not a PNG');
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  for (let at = 8; at + 8 <= buf.length;) {
    const length = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    const body = buf.subarray(at + 8, at + 8 + length);
    if (body.length !== length) throw new PngError('truncated PNG');
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8]!;
      const colorType = body[9]!;
      const interlace = body[12]!;
      channels = CHANNELS[colorType] ?? 0;
      if (depth !== 8 || !channels || interlace !== 0)
        throw new PngError('only 8-bit, non-interlaced grayscale, RGB or RGBA PNGs are supported');
      if (!width || !height || width * height > MAX_PIXELS) throw new PngError('image too large');
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    at += 12 + length;
  }
  if (!channels || !idat.length) throw new PngError('PNG has no image data');

  const stride = width * channels;
  let raw: Buffer;
  try {
    // Never inflate more than the header says the image holds (a crafted PNG can expand hugely).
    raw = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: (stride + 1) * height + 1024 });
  } catch {
    throw new PngError('PNG image data is corrupt or larger than its size');
  }
  if (raw.length < (stride + 1) * height) throw new PngError('PNG image data is incomplete');
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    if (filter > 4) throw new PngError(`unknown PNG filter ${filter}`);
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = y * stride;
    const prev = out - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? pixels[out + x - channels]! : 0;
      const b = y > 0 ? pixels[prev + x]! : 0;
      const c = y > 0 && x >= channels ? pixels[prev + x - channels]! : 0;
      const v = line[x]!;
      pixels[out + x] =
        filter === 0
          ? v
          : filter === 1
            ? v + a
            : filter === 2
              ? v + b
              : filter === 3
                ? v + ((a + b) >> 1)
                : v + paeth(a, b, c);
    }
  }

  const data = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < width * height; i++, j += channels) {
    const o = i * 4;
    if (channels >= 3) {
      data[o] = pixels[j]!;
      data[o + 1] = pixels[j + 1]!;
      data[o + 2] = pixels[j + 2]!;
    } else {
      data[o] = data[o + 1] = data[o + 2] = pixels[j]!;
    }
    data[o + 3] = channels === 4 ? pixels[j + 3]! : channels === 2 ? pixels[j + 1]! : 255;
  }
  return { width, height, data };
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0);
  return Buffer.concat([head, body, crc]);
}

/** RGBA PNG, "Sub" filter on every row (compresses screenshots well enough, and is simple). */
export function encodePng(img: Bitmap): Buffer {
  const stride = img.width * 4;
  const raw = Buffer.alloc((stride + 1) * img.height);
  for (let y = 0; y < img.height; y++) {
    const o = y * (stride + 1);
    raw[o] = 1;
    for (let x = 0; x < stride; x++) {
      const v = img.data[y * stride + x]!;
      const left = x >= 4 ? img.data[y * stride + x - 4]! : 0;
      raw[o + 1 + x] = (v - left) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
