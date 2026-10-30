import type { AttachmentDto } from '@friday/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { imageInfo, imageProblem } from '../../attachments/image.js';
import { CaptureError } from '../../browser/capture.js';
import { localPageUrl, PageUrlError } from '../../browser/urls.js';
import { toAttachmentDto } from '../../repositories/attachments.js';
import type { Services } from '../../services.js';
import { HttpError } from '../errors.js';
import { parseInput } from '../validation.js';

/** The live preview pane: which screenshot engine exists, and "screenshot into the message". */
export function registerPreviewRoutes(app: FastifyInstance, s: Services) {
  app.get('/api/preview/status', async () => ({ screenshots: s.capture?.engine.name ?? null }));

  /** Capture a local page as a pending attachment for the composer (a user action). */
  app.post('/api/preview/screenshot', async (req, reply) => {
    const body = parseInput(
      z.object({
        url: z.string().min(1).max(2_000),
        width: z.number().int().min(320).max(2_560).default(1_280),
        height: z.number().int().min(240).max(2_000).default(800),
        fullPage: z.boolean().default(false),
      }),
      req.body,
    );
    if (!s.capture)
      throw new HttpError(
        409,
        'no_browser',
        'No browser for screenshots: install Chrome, Chromium or Edge, or use the desktop app.',
      );
    let url: string;
    try {
      url = localPageUrl(body.url, s.capture.fridayPort());
    } catch (err) {
      if (err instanceof PageUrlError) throw new HttpError(400, 'invalid_url', err.message);
      throw err;
    }
    try {
      const shot = await s.capture.engine.capture(url, {
        width: body.width,
        height: body.height,
        fullPage: body.fullPage,
        waitMs: 500,
      });
      const info = imageInfo(shot.image);
      const problem = imageProblem(shot.image, info);
      if (problem) throw new HttpError(400, 'invalid_image', problem);
      const attachment = s.attachments.create(shot.image, info!, 'screenshot.png');
      reply.code(201);
      return {
        attachment: toAttachmentDto(attachment) satisfies AttachmentDto,
        title: shot.title,
        finalUrl: shot.finalUrl,
        problems: shot.problems,
      };
    } catch (err) {
      if (err instanceof CaptureError) throw new HttpError(502, 'capture_failed', err.message);
      throw err;
    }
  });
}
