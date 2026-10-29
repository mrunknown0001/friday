import type { AttachmentDto } from '@friday/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { IMAGE_LIMITS, imageInfo, imageProblem } from '../../attachments/image.js';
import { toAttachmentDto } from '../../repositories/attachments.js';
import type { Services } from '../../services.js';
import { HttpError } from '../errors.js';
import { parseInput } from '../validation.js';

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const idParams = z.object({ id: z.uuid() });
/** Uploads that were never sent (draft discarded, tab closed) are removed after this. */
const PENDING_TTL_MS = 24 * 60 * 60_000;

/** A display name from the client: no path, no control characters, bounded. */
function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  let name: string;
  try {
    name = decodeURIComponent(raw);
  } catch {
    return null;
  }
  name = name
    .split(/[\\/]/)
    .at(-1)!
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .trim()
    .slice(0, 120);
  return name || null;
}

/**
 * Image attachments: uploaded first (raw image body), then sent with a message by id. The type
 * is decided from the bytes, never from the request's Content-Type or the file name.
 */
export function registerAttachmentRoutes(app: FastifyInstance, s: Services) {
  app.addContentTypeParser(
    IMAGE_TYPES,
    { parseAs: 'buffer', bodyLimit: IMAGE_LIMITS.maxBytes + 1024 },
    (_req, body, done) => done(null, body),
  );

  app.post('/api/attachments', { bodyLimit: IMAGE_LIMITS.maxBytes + 1024 }, async (req, reply) => {
    if (!Buffer.isBuffer(req.body))
      throw new HttpError(
        415,
        'unsupported_media_type',
        'Send the image itself as the request body.',
      );
    const info = imageInfo(req.body);
    const problem = imageProblem(req.body, info);
    if (problem) throw new HttpError(400, 'invalid_image', problem);
    s.attachments.deleteStalePending(PENDING_TTL_MS);
    const a = s.attachments.create(req.body, info!, cleanName(req.headers['x-file-name']));
    reply.code(201);
    return toAttachmentDto(a) satisfies AttachmentDto;
  });

  app.get('/api/attachments/:id', async (req, reply) => {
    const { id } = parseInput(idParams, req.params);
    const a = s.attachments.get(id);
    const data = a && s.attachments.data(id);
    if (!a || !data) throw new HttpError(404, 'attachment_not_found', 'Image not found.');
    reply
      .header('Content-Type', a.mime)
      .header('Content-Disposition', 'inline')
      // The bytes behind an id never change.
      .header('Cache-Control', 'private, max-age=31536000, immutable');
    return reply.send(data);
  });

  /** Remove an upload that has not been sent (taken out of the composer). */
  app.delete('/api/attachments/:id', async (req, reply) => {
    const { id } = parseInput(idParams, req.params);
    if (!s.attachments.deletePending(id))
      throw new HttpError(404, 'attachment_not_found', 'No unsent image with this id.');
    reply.code(204);
  });
}
