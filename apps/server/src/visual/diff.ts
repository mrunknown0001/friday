import type { Bitmap } from './png.js';

/**
 * Compare two screenshots of the same page. Pixels count as changed when their perceived colour
 * differs by more than a small threshold (YIQ distance, as in pixelmatch), so anti-aliasing and
 * compression noise don't register. When the page height changed, the part only one image has
 * counts as changed.
 */

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VisualDiff {
  /** Share of the compared area's pixels that changed, 0–1. */
  changedRatio: number;
  changedPixels: number;
  /** Bounding boxes of the changed areas, largest first. */
  regions: Region[];
  /** The "after" image faded, with changed pixels tinted red and each region outlined. */
  image: Bitmap;
}

/** YIQ distance threshold: 0.05 of the maximum (pixelmatch defaults to 0.1, which misses pale background colours such as #e0f2fe on white). */
const MAX_DELTA = 35_215 * 0.05 * 0.05;
const BLOCK = 8;
const MAX_REGIONS = 12;
/** How much red covers a changed pixel. */
const TINT = 0.6;

function delta(a: Uint8Array, i: number, b: Uint8Array, j: number): number {
  // Blend with white by alpha, so transparent pixels compare like they look.
  const blend = (c: number, alpha: number) => 255 + ((c - 255) * alpha) / 255;
  const r1 = blend(a[i]!, a[i + 3]!);
  const g1 = blend(a[i + 1]!, a[i + 3]!);
  const b1 = blend(a[i + 2]!, a[i + 3]!);
  const r2 = blend(b[j]!, b[j + 3]!);
  const g2 = blend(b[j + 1]!, b[j + 3]!);
  const b2 = blend(b[j + 2]!, b[j + 3]!);
  const y = (r1 - r2) * 0.29889531 + (g1 - g2) * 0.58662247 + (b1 - b2) * 0.11448223;
  const iq = (r1 - r2) * 0.59597799 - (g1 - g2) * 0.2741761 - (b1 - b2) * 0.32180189;
  const q = (r1 - r2) * 0.21147017 - (g1 - g2) * 0.52261711 + (b1 - b2) * 0.31114694;
  return 0.5053 * y * y + 0.299 * iq * iq + 0.1957 * q * q;
}

export function diffImages(before: Bitmap, after: Bitmap): VisualDiff {
  const width = Math.max(before.width, after.width);
  const height = Math.max(before.height, after.height);
  const changed = new Uint8Array(width * height);
  let count = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inBefore = x < before.width && y < before.height;
      const inAfter = x < after.width && y < after.height;
      const differs =
        inBefore && inAfter
          ? delta(before.data, (y * before.width + x) * 4, after.data, (y * after.width + x) * 4) >
            MAX_DELTA
          : true;
      if (differs) {
        changed[y * width + x] = 1;
        count++;
      }
    }
  }

  const regions = findRegions(changed, width, height);
  return {
    changedRatio: count / (width * height),
    changedPixels: count,
    regions,
    image: highlight(after, changed, width, height, regions),
  };
}

/** Changed 8×8 blocks, grouped into connected areas (blocks touching, diagonals included). */
function findRegions(changed: Uint8Array, width: number, height: number): Region[] {
  const bw = Math.ceil(width / BLOCK);
  const bh = Math.ceil(height / BLOCK);
  const blocks = new Uint8Array(bw * bh);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (changed[y * width + x]) blocks[Math.floor(y / BLOCK) * bw + Math.floor(x / BLOCK)] = 1;

  const seen = new Uint8Array(bw * bh);
  const regions: Region[] = [];
  for (let start = 0; start < blocks.length; start++) {
    if (!blocks[start] || seen[start]) continue;
    let [x0, y0, x1, y1] = [bw, bh, 0, 0];
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const b = stack.pop()!;
      const bx = b % bw;
      const by = Math.floor(b / bw);
      x0 = Math.min(x0, bx);
      y0 = Math.min(y0, by);
      x1 = Math.max(x1, bx);
      y1 = Math.max(y1, by);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = bx + dx;
          const ny = by + dy;
          if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue;
          const n = ny * bw + nx;
          if (blocks[n] && !seen[n]) {
            seen[n] = 1;
            stack.push(n);
          }
        }
    }
    const x = x0 * BLOCK;
    const y = y0 * BLOCK;
    regions.push({
      x,
      y,
      width: Math.min((x1 + 1) * BLOCK, width) - x,
      height: Math.min((y1 + 1) * BLOCK, height) - y,
    });
  }
  return regions.sort((a, b) => b.width * b.height - a.width * a.height).slice(0, MAX_REGIONS);
}

function highlight(
  after: Bitmap,
  changed: Uint8Array,
  width: number,
  height: number,
  regions: Region[],
): Bitmap {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const i = (y * after.width + x) * 4;
      const inside = x < after.width && y < after.height;
      if (changed[y * width + x]) {
        // Changed: the new pixel under a strong red tint, so what changed stays readable.
        const tint = (c: number, k: number) =>
          Math.round(c * TINT + (inside ? after.data[i + k]! : 255) * (1 - TINT));
        data.set([tint(230, 0), tint(0, 1), tint(80, 2), 255], o);
        continue;
      }
      // Unchanged: the after image in faded grey, so the red stands out but the layout shows.
      const grey = inside
        ? 0.299 * after.data[i]! + 0.587 * after.data[i + 1]! + 0.114 * after.data[i + 2]!
        : 255;
      const v = Math.round(255 - (255 - grey) * 0.35);
      data.set([v, v, v, 255], o);
    }
  }
  // Outline each region (2px, a little outside it) so small changes are easy to find.
  for (const r of regions) {
    const x0 = Math.max(0, r.x - 3);
    const y0 = Math.max(0, r.y - 3);
    const x1 = Math.min(width - 1, r.x + r.width + 2);
    const y1 = Math.min(height - 1, r.y + r.height + 2);
    const dot = (x: number, y: number) => data.set([230, 0, 80, 255], (y * width + x) * 4);
    for (let x = x0; x <= x1; x++)
      for (const y of [y0, y0 + 1, y1 - 1, y1]) if (y >= 0 && y < height) dot(x, y);
    for (let y = y0; y <= y1; y++)
      for (const x of [x0, x0 + 1, x1 - 1, x1]) if (x >= 0 && x < width) dot(x, y);
  }
  return { width, height, data };
}
