/**
 * Prepare a pasted, dropped or picked image for upload. Models look at images of at most about
 * 1568 px per side (~1.15 megapixels) and scale anything larger down anyway, so downsizing here
 * saves upload time, storage and context without losing what the model can see.
 */

export const MAX_SIDE = 1568;
export const MAX_PIXELS = 1_150_000;
export const MAX_BYTES = 5 * 1024 * 1024;
export const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

export function targetSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(
    1,
    MAX_SIDE / Math.max(width, height),
    Math.sqrt(MAX_PIXELS / (width * height)),
  );
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function encode(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/** The image to upload: the original when it is already small enough, otherwise a smaller copy. */
export async function prepareImage(file: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) throw new Error('This file is not an image Friday can read.');
  try {
    const size = targetSize(bitmap.width, bitmap.height);
    const fits = size.width === bitmap.width && size.height === bitmap.height;
    if (fits && ACCEPTED.includes(file.type) && file.size <= MAX_BYTES) return file;
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not resize the image.');
    ctx.drawImage(bitmap, 0, 0, size.width, size.height);
    // Screenshots stay sharp as PNG; photos (or PNGs that are still large) become JPEG.
    const pngBlob = file.type === 'image/png' ? await encode(canvas, 'image/png') : null;
    if (pngBlob && pngBlob.size <= 2 * 1024 * 1024) return pngBlob;
    const jpeg = await encode(canvas, 'image/jpeg', 0.88);
    if (!jpeg) throw new Error('Could not resize the image.');
    return jpeg;
  } finally {
    bitmap.close();
  }
}

/** Images among pasted or dropped items (files only; text and HTML are left alone). */
export function imageFiles(list: DataTransferItemList | FileList | null | undefined): File[] {
  if (!list) return [];
  const files: File[] = [];
  for (const entry of Array.from(list as ArrayLike<DataTransferItem | File>)) {
    const file = entry instanceof File ? entry : entry.kind === 'file' ? entry.getAsFile() : null;
    if (file && file.type.startsWith('image/')) files.push(file);
  }
  return files;
}
