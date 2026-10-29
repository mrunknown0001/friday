import type { AttachmentDto } from '@friday/shared';

/**
 * Image checks done on the bytes themselves (never the file name or a client-supplied type): the
 * format from its signature, and the pixel size from its header. Only raster formats models read
 * are accepted; SVG (which can carry scripts) never is.
 */

export type ImageMime = AttachmentDto['mime'];

export const IMAGE_LIMITS = {
  /** Bytes per image. The web app downsizes before uploading, so real uploads are far smaller. */
  maxBytes: 5 * 1024 * 1024,
  /** Pixels per side. */
  maxSide: 8_000,
  /** Images per message. */
  perMessage: 4,
  /** Most recent user messages whose images are still sent to the model (older: a text note). */
  recentMessages: 3,
} as const;

export interface ImageInfo {
  mime: ImageMime;
  width: number;
  height: number;
}

const ascii = (b: Buffer, start: number, end: number) => b.toString('latin1', start, end);

function png(b: Buffer): ImageInfo | null {
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47 || ascii(b, 12, 16) !== 'IHDR') return null;
  return { mime: 'image/png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function gif(b: Buffer): ImageInfo | null {
  if (b.length < 10 || !/^GIF8[79]a$/.test(ascii(b, 0, 6))) return null;
  return { mime: 'image/gif', width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
}

function webp(b: Buffer): ImageInfo | null {
  if (b.length < 30 || ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 12) !== 'WEBP') return null;
  const chunk = ascii(b, 12, 16);
  if (chunk === 'VP8 ')
    return {
      mime: 'image/webp',
      width: b.readUInt16LE(26) & 0x3fff,
      height: b.readUInt16LE(28) & 0x3fff,
    };
  if (chunk === 'VP8L') {
    const bits = b.readUInt32LE(21);
    return { mime: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X')
    return { mime: 'image/webp', width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
  return null;
}

function jpeg(b: Buffer): ImageInfo | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i++;
      continue;
    }
    const length = b.readUInt16BE(i + 2);
    // Start-of-frame markers (baseline, progressive, ...), excluding DHT/JPG/DAC.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
      return { mime: 'image/jpeg', height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    i += 2 + length;
  }
  return null;
}

/** Format and size of an image, or null if it is not a PNG, JPEG, WebP or GIF. */
export function imageInfo(bytes: Buffer): ImageInfo | null {
  return png(bytes) ?? jpeg(bytes) ?? webp(bytes) ?? gif(bytes);
}

/** Why an image is refused, or null if it is acceptable. */
export function imageProblem(bytes: Buffer, info: ImageInfo | null): string | null {
  if (!info) return 'Only PNG, JPEG, WebP and GIF images are supported.';
  if (bytes.length > IMAGE_LIMITS.maxBytes)
    return `Images can be at most ${IMAGE_LIMITS.maxBytes / 1024 / 1024} MB.`;
  if (
    info.width < 1 ||
    info.height < 1 ||
    info.width > IMAGE_LIMITS.maxSide ||
    info.height > IMAGE_LIMITS.maxSide
  )
    return `Images can be at most ${IMAGE_LIMITS.maxSide} pixels per side.`;
  return null;
}

/**
 * Rough input tokens for an image: models scale images down to about 1.15 megapixels and charge
 * about one token per 750 pixels (so at most ~1,600 per image).
 */
export function imageTokens(width: number, height: number): number {
  return Math.min(1_600, Math.ceil((width * height) / 750));
}
