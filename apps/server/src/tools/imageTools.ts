import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { IMAGE_LIMITS, imageInfo, imageProblem } from '../attachments/image.js';
import { resolveInside, WorkspaceError } from '../workspace/paths.js';
import { defineTool } from './types.js';

export const viewImage = defineTool({
  name: 'view_image',
  description:
    'Look at an image file in the project (PNG, JPEG, WebP or GIF), e.g. a screenshot, design mockup, diagram or icon. The image is shown to you right after this result. SVG files are text: use read_file. Credential files cannot be opened.',
  category: 'read_only',
  risk: 'none',
  requiresProject: true,
  schema: z.object({
    path: z.string().min(1).max(1024).describe('Image file relative to the project root.'),
  }),
  describeCall: (a) => a.path,
  async execute(args, ctx) {
    const target = await resolveInside(ctx.project!.rootPath, args.path);
    const stat = await fs.stat(target.abs);
    if (!stat.isFile()) throw new WorkspaceError('not_a_file', `"${target.rel}" is not a file.`);
    if (stat.size > IMAGE_LIMITS.maxBytes)
      throw new WorkspaceError(
        'too_large',
        `"${target.rel}" is ${(stat.size / 1024 / 1024).toFixed(1)} MB; images can be at most ${IMAGE_LIMITS.maxBytes / 1024 / 1024} MB.`,
      );
    const data = await fs.readFile(target.abs);
    const info = imageInfo(data);
    const problem = imageProblem(data, info);
    if (problem) throw new WorkspaceError('unsupported', `"${target.rel}": ${problem}`);
    return {
      content: `${target.rel}: ${info!.mime}, ${info!.width}×${info!.height} px, ${data.length} bytes. The image follows.`,
      summary: `${info!.width}×${info!.height} ${info!.mime.slice(6)}`,
      images: [{ data, info: info!, name: path.posix.basename(target.rel) }],
    };
  },
});
