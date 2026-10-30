import zlib from 'node:zlib';
import type { RunEvent } from '@friday/shared';
import { describe, expect, it } from 'vitest';
import type { CaptureEngine, CaptureOptions } from '../src/browser/capture.js';
import { percent } from '../src/tools/screenshotTool.js';
import { diffImages } from '../src/visual/diff.js';
import { decodePng, encodePng, PngError, type Bitmap } from '../src/visual/png.js';
import { call, ScriptedProvider, testServices } from './helpers.js';

function bitmap(width: number, height: number, fill = [255, 255, 255, 255]): Bitmap {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(fill, i * 4);
  return { width, height, data };
}

function paint(b: Bitmap, x0: number, y0: number, w: number, h: number, rgba: number[]): Bitmap {
  const out = { ...b, data: new Uint8Array(b.data) };
  for (let y = y0; y < y0 + h; y++)
    for (let x = x0; x < x0 + w; x++) out.data.set(rgba, (y * b.width + x) * 4);
  return out;
}

/** An RGB PNG whose rows use the given filter, to exercise every filter in the decoder. */
function rgbPng(
  width: number,
  height: number,
  pixel: (x: number, y: number) => number[],
  filter: number,
) {
  const stride = width * 3;
  const rows: Buffer[] = [];
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const cur = Buffer.alloc(stride);
    for (let x = 0; x < width; x++) cur.set(pixel(x, y), x * 3);
    const line = Buffer.alloc(stride + 1);
    line[0] = filter;
    for (let i = 0; i < stride; i++) {
      const a = i >= 3 ? cur[i - 3]! : 0;
      const b = prev[i]!;
      const c = i >= 3 ? prev[i - 3]! : 0;
      const p = a + b - c;
      const pred = [
        0,
        a,
        b,
        (a + b) >> 1,
        Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c)
          ? a
          : Math.abs(p - b) <= Math.abs(p - c)
            ? b
            : c,
      ][filter]!;
      line[i + 1] = (cur[i]! - pred) & 0xff;
    }
    rows.push(line);
    prev = cur;
  }
  const chunk = (type: string, body: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), body])) >>> 0);
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('PNG', () => {
  it('decodes every row filter, and round-trips RGBA', () => {
    const pixel = (x: number, y: number) => [(x * 37 + y) & 255, (y * 53) & 255, (x * y) & 255];
    for (let filter = 0; filter <= 4; filter++) {
      const img = decodePng(rgbPng(9, 7, pixel, filter));
      expect(img.width).toBe(9);
      for (const [x, y] of [
        [0, 0],
        [8, 6],
        [4, 3],
      ] as const)
        expect(
          [...img.data.slice((y * 9 + x) * 4, (y * 9 + x) * 4 + 4)],
          `filter ${filter}`,
        ).toEqual([...pixel(x, y), 255]);
    }
    const b = paint(bitmap(20, 10, [10, 20, 30, 128]), 3, 2, 5, 4, [200, 100, 50, 255]);
    const back = decodePng(encodePng(b));
    expect(back).toEqual({ width: 20, height: 10, data: b.data });
  });

  it('refuses what it cannot read', () => {
    expect(() => decodePng(Buffer.from('not a png'))).toThrow(PngError);
    const palette = rgbPng(2, 2, () => [0, 0, 0], 0);
    palette[8 + 8 + 9] = 3; // color type: palette
    expect(() => decodePng(palette)).toThrow(/only 8-bit/);
    // Image data that inflates to more than the header allows (a decompression bomb) is refused.
    const bomb = rgbPng(2, 2, () => [0, 0, 0], 0);
    const big = zlib.deflateSync(Buffer.alloc(10_000_000));
    const at = bomb.indexOf('IDAT') - 4;
    const len = bomb.readUInt32BE(at);
    const head = Buffer.alloc(8);
    head.writeUInt32BE(big.length, 0);
    head.write('IDAT', 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), big])) >>> 0);
    const crafted = Buffer.concat([
      bomb.subarray(0, at),
      head,
      big,
      crc,
      bomb.subarray(at + 12 + len),
    ]);
    expect(() => decodePng(crafted)).toThrow(/corrupt or larger/);
  });
});

describe('visual diff', () => {
  it('finds nothing in identical or near-identical images', () => {
    const a = bitmap(64, 48, [240, 240, 240, 255]);
    expect(diffImages(a, a)).toMatchObject({ changedPixels: 0, changedRatio: 0, regions: [] });
    // Compression noise of a level or two is not a change.
    expect(diffImages(a, bitmap(64, 48, [241, 239, 240, 255])).changedPixels).toBe(0);
  });

  it('outlines changed areas, largest first, and highlights them', () => {
    const a = bitmap(100, 80);
    const b = paint(paint(a, 10, 10, 30, 20, [0, 120, 255, 255]), 80, 60, 4, 4, [0, 0, 0, 255]);
    const d = diffImages(a, b);
    expect(d.changedPixels).toBe(30 * 20 + 16);
    expect(d.changedRatio).toBeCloseTo((600 + 16) / 8000);
    expect(d.regions).toEqual([
      { x: 8, y: 8, width: 32, height: 24 },
      { x: 80, y: 56, width: 8, height: 8 },
    ]);
    const px = (x: number, y: number) => [
      ...d.image.data.slice((y * 100 + x) * 4, (y * 100 + x) * 4 + 4),
    ];
    // Changed: the new colour (0, 120, 255) under a red tint, so it stays recognizable.
    expect(px(20, 20)).toEqual([138, 48, 150, 255]);
    expect(px(60, 40)).toEqual([255, 255, 255, 255]); // unchanged white stays (faded) white
  });

  it('counts the part only one image has when the page size changed', () => {
    const d = diffImages(bitmap(10, 10), bitmap(10, 15));
    expect(d.changedPixels).toBe(50);
    expect(d.image.height).toBe(15);
    expect(d.regions[0]).toEqual({ x: 0, y: 8, width: 10, height: 7 });
  });

  it('formats the changed share', () => {
    expect([percent(0), percent(0.0004), percent(0.032), percent(0.25)]).toEqual([
      '0%',
      '<0.1%',
      '3.2%',
      '25%',
    ]);
  });
});

/** Serves a white page first, then the same page with a blue button added. */
class ChangingPage implements CaptureEngine {
  readonly name = 'fake';
  shots = 0;
  async capture(url: string, opts: CaptureOptions) {
    const base = bitmap(opts.width, opts.height);
    const img = this.shots++ === 0 ? base : paint(base, 40, 30, 60, 20, [0, 100, 255, 255]);
    return {
      image: encodePng(img),
      mime: 'image/png' as const,
      width: opts.width,
      height: opts.height,
      title: 'Cart',
      finalUrl: url,
      status: 200,
      problems: [],
    };
  }
  async printPdf(): Promise<Buffer> {
    throw new Error('not used');
  }
}

describe('before/after screenshots', () => {
  it('compares with the earlier capture of the page and adds both to the run report', async () => {
    const provider = new ScriptedProvider();
    const s = testServices({ provider, captureEngine: new ChangingPage() });
    const shot = (args: Record<string, unknown>, id: string) =>
      call('screenshot', { url: 'localhost:5173/cart', width: 320, height: 240, ...args }, id);
    provider.streamSteps.push(
      { toolCalls: [shot({}, 'before')] },
      // A different size is a different page: nothing to compare with.
      { toolCalls: [shot({ width: 400, compare: true }, 'other')] },
      { toolCalls: [shot({ compare: true }, 'after')] },
      { chunks: ['The button is there now.'] },
    );
    const session = s.sessions.create();
    const events: RunEvent[] = [];
    const { run } = s.runManager.startMessage(session.id, 'add a checkout button and check it');
    s.runManager.subscribe(run.id, 0, (e) => events.push(e));
    await s.runManager.waitFor(run.id);

    const tools = s.messages.listBySession(session.id).filter((m) => m.role === 'tool');
    expect(tools[1]!.content).toContain('No earlier screenshot of this page at this size');
    const after = tools[2]!;
    expect(after.content).toContain(
      '1.6% of the pixels changed, in 1 area: x 40–104, y 24–56 (64×32).',
    );
    expect(after.content).toContain('then the difference (changes in red');
    expect(after.attachments?.map((a) => a.name)).toEqual(['screenshot.png', 'difference.png']);
    const finished = events.filter((e) => e.type === 'tool_finished');
    expect(finished.at(-1)).toMatchObject({ summary: '320×240, 1.6% changed' });

    // The model sees both images.
    const lastRequest = provider.requests.at(-1)!.messages;
    const withImages = lastRequest.flatMap((m) =>
      m.role === 'user' && m.images?.length ? [m.images] : [],
    );
    expect(withImages.at(-1)).toHaveLength(2);

    // A run that only compared screenshots still gets a report, with the comparison.
    const report = s.runs.get(run.id)!.report!;
    expect(report.status).toBe('no_changes');
    expect(report.visuals).toEqual([
      expect.objectContaining({
        url: 'http://localhost:5173/cart',
        width: 320,
        changedRatio: expect.closeTo(0.0156, 3),
        regions: 1,
        before: expect.objectContaining({ id: tools[0]!.attachments![0]!.id }),
        after: expect.objectContaining({ id: after.attachments![0]!.id }),
        diff: expect.objectContaining({ id: after.attachments![1]!.id }),
      }),
    ]);
  });
});
