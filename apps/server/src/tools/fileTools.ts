import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FileChangePreview, RiskLevel } from '@friday/shared';
import { createTwoFilesPatch } from 'diff';
import { z } from 'zod';
import { looksBinary, MAX_TEXT_FILE_BYTES } from '../workspace/files.js';
import { assertRootAvailable, resolveForWrite, WorkspaceError } from '../workspace/paths.js';
import { defineTool, type Proposal, type ToolContext } from './types.js';

export const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

const MAX_DIFF_CHARS = 200_000;
const MAX_WRITE_CHARS = 1_000_000;

const reason = z
  .string()
  .min(3)
  .max(500)
  .describe('Why this change is needed. Shown to the user when they approve or reject it.');
const relPath = z.string().min(1).max(1024).describe('Path relative to the project root.');

async function root(ctx: ToolContext): Promise<string> {
  if (!ctx.project)
    throw new WorkspaceError('unsupported', 'This conversation is not attached to a project.');
  await assertRootAvailable(ctx.project.rootPath);
  return ctx.project.rootPath;
}

/** Current text content of an existing file; refuses binary and oversized files. */
async function readText(abs: string, rel: string): Promise<{ buf: Buffer; text: string }> {
  const stat = await fs.stat(abs);
  if (stat.size > MAX_TEXT_FILE_BYTES) {
    throw new WorkspaceError(
      'too_large',
      `"${rel}" is too large to edit safely (${stat.size} bytes).`,
    );
  }
  const buf = await fs.readFile(abs);
  if (looksBinary(buf))
    throw new WorkspaceError('unsupported', `"${rel}" is a binary file and cannot be edited.`);
  return { buf, text: buf.toString('utf8') };
}

export function makeDiff(
  rel: string,
  before: string,
  after: string,
  change: FileChangePreview['change'],
  fromPath?: string,
): FileChangePreview {
  let diff = createTwoFilesPatch(
    change === 'create' ? '/dev/null' : `a/${fromPath ?? rel}`,
    change === 'delete' ? '/dev/null' : `b/${rel}`,
    before,
    after,
    undefined,
    undefined,
    { context: 3 },
  );
  // Drop jsdiff's "Index:"/"====" preamble so the text is a plain unified diff.
  diff = diff.replace(/^Index:.*\n=+\n/, '');
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++;
    else if (line.startsWith('-') && !line.startsWith('---')) removed++;
  }
  if (diff.length > MAX_DIFF_CHARS)
    diff = `${diff.slice(0, MAX_DIFF_CHARS)}\n[diff truncated for display]`;
  return { path: rel, change, ...(fromPath ? { fromPath } : {}), diff, added, removed };
}

/** Write via a temp file and rename, so a crash never leaves a half-written file. */
async function atomicWrite(abs: string, content: string, mode?: number) {
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const tmp = path.join(
    path.dirname(abs),
    `.${path.basename(abs)}.friday-${randomBytes(4).toString('hex')}.tmp`,
  );
  try {
    await fs.writeFile(tmp, content, { mode: mode ?? 0o644 });
    await fs.rename(tmp, abs);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

const sizeRisk = (p: FileChangePreview): RiskLevel =>
  p.added + p.removed > 400 ? 'high' : 'medium';

export const writeFile = defineTool({
  name: 'write_file',
  description:
    "Create a new file or replace an entire file with new content. Prefer edit_file for changes to existing files. Requires the user's approval; they see the full diff first.",
  category: 'file_modify',
  risk: 'medium',
  requiresProject: true,
  schema: z.object({ path: relPath, content: z.string().max(MAX_WRITE_CHARS), reason }),
  describeCall: (a) => a.path,
  async prepare(args, ctx): Promise<Proposal> {
    const r = await root(ctx);
    const target = await resolveForWrite(r, args.path);
    const before = target.exists ? await readText(target.abs, target.rel) : null;
    if (before?.text === args.content)
      throw new WorkspaceError('unsupported', `"${target.rel}" already has exactly this content.`);
    const preview = makeDiff(
      target.rel,
      before?.text ?? '',
      args.content,
      before ? 'modify' : 'create',
    );
    const mode = target.exists ? (await fs.stat(target.abs)).mode : undefined;
    return {
      title: `${before ? 'Overwrite' : 'Create'} ${target.rel}`,
      summary: `${before ? 'Replaces the contents of' : 'Creates'} ${target.rel} (+${preview.added} −${preview.removed}).`,
      category: before ? 'file_modify' : 'file_create',
      risk: sizeRisk(preview),
      details: { kind: 'file_change', changes: [preview] },
      fingerprint: `${target.rel}:${before ? sha256(before.buf) : 'absent'}`,
      async apply(execCtx) {
        await atomicWrite(target.abs, args.content, mode);
        execCtx.recordFileChange?.({
          path: target.rel,
          fromPath: null,
          change: before ? 'modify' : 'create',
          beforeContent: before?.buf ?? null,
          beforeHash: before ? sha256(before.buf) : null,
          afterHash: sha256(args.content),
        });
        return {
          content: `${before ? 'Updated' : 'Created'} ${target.rel} (+${preview.added} −${preview.removed}).`,
          summary: `${before ? 'updated' : 'created'} ${target.rel}`,
        };
      },
    };
  },
});

export const editFile = defineTool({
  name: 'edit_file',
  description:
    "Edit an existing text file by exact string replacement. Each old_text must match the current file exactly (whitespace included) and be unique unless replace_all is true. Read the file first. Requires the user's approval; they see the diff.",
  category: 'file_modify',
  risk: 'medium',
  requiresProject: true,
  schema: z.object({
    path: relPath,
    edits: z
      .array(
        z.object({
          old_text: z.string().min(1).max(100_000),
          new_text: z.string().max(100_000),
          replace_all: z.boolean().default(false),
        }),
      )
      .min(1)
      .max(20),
    reason,
  }),
  describeCall: (a) =>
    `${a.path} (${a.edits?.length ?? 0} edit${a.edits?.length === 1 ? '' : 's'})`,
  async prepare(args, ctx): Promise<Proposal> {
    const r = await root(ctx);
    const target = await resolveForWrite(r, args.path);
    if (!target.exists)
      throw new WorkspaceError(
        'not_found',
        `"${target.rel}" does not exist; use write_file to create it.`,
      );
    const before = await readText(target.abs, target.rel);
    let after = before.text;
    args.edits.forEach((e, i) => {
      const count = after.split(e.old_text).length - 1;
      if (count === 0) {
        throw new WorkspaceError(
          'unsupported',
          `Edit ${i + 1}: old_text was not found in ${target.rel}. Re-read the file and copy the text exactly.`,
        );
      }
      if (count > 1 && !e.replace_all) {
        throw new WorkspaceError(
          'unsupported',
          `Edit ${i + 1}: old_text matches ${count} places in ${target.rel}. Include more surrounding lines or set replace_all.`,
        );
      }
      after = e.replace_all
        ? after.split(e.old_text).join(e.new_text)
        : after.replace(e.old_text, () => e.new_text);
    });
    if (after === before.text)
      throw new WorkspaceError('unsupported', 'The edits do not change the file.');
    const preview = makeDiff(target.rel, before.text, after, 'modify');
    const mode = (await fs.stat(target.abs)).mode;
    return {
      title: `Edit ${target.rel}`,
      summary: `Applies ${args.edits.length} edit${args.edits.length === 1 ? '' : 's'} to ${target.rel} (+${preview.added} −${preview.removed}).`,
      category: 'file_modify',
      risk: sizeRisk(preview),
      details: { kind: 'file_change', changes: [preview] },
      fingerprint: `${target.rel}:${sha256(before.buf)}`,
      async apply(execCtx) {
        await atomicWrite(target.abs, after, mode);
        execCtx.recordFileChange?.({
          path: target.rel,
          fromPath: null,
          change: 'modify',
          beforeContent: before.buf,
          beforeHash: sha256(before.buf),
          afterHash: sha256(after),
        });
        return {
          content: `Edited ${target.rel} (+${preview.added} −${preview.removed}).`,
          summary: `edited ${target.rel} (+${preview.added} −${preview.removed})`,
        };
      },
    };
  },
});

export const deleteFile = defineTool({
  name: 'delete_file',
  description:
    "Delete one file. Requires the user's explicit approval. The previous content is kept so the user can undo.",
  category: 'file_delete',
  risk: 'high',
  requiresProject: true,
  schema: z.object({ path: relPath, reason }),
  describeCall: (a) => a.path,
  async prepare(args, ctx): Promise<Proposal> {
    const r = await root(ctx);
    const target = await resolveForWrite(r, args.path);
    if (!target.exists) throw new WorkspaceError('not_found', `"${target.rel}" does not exist.`);
    const buf = await fs.readFile(target.abs);
    if (buf.length > MAX_TEXT_FILE_BYTES)
      throw new WorkspaceError(
        'too_large',
        `"${target.rel}" is too large to back up, so Friday will not delete it.`,
      );
    const binary = looksBinary(buf);
    const preview = binary
      ? { path: target.rel, change: 'delete' as const, diff: '', added: 0, removed: 0 }
      : makeDiff(target.rel, buf.toString('utf8'), '', 'delete');
    return {
      title: `Delete ${target.rel}`,
      summary: `Deletes ${target.rel}${binary ? ` (binary, ${buf.length} bytes)` : ` (${preview.removed} lines)`}. A backup is kept for undo.`,
      category: 'file_delete',
      risk: 'high',
      details: { kind: 'file_change', changes: [preview] },
      fingerprint: `${target.rel}:${sha256(buf)}`,
      async apply(execCtx) {
        await fs.rm(target.abs);
        execCtx.recordFileChange?.({
          path: target.rel,
          fromPath: null,
          change: 'delete',
          beforeContent: buf,
          beforeHash: sha256(buf),
          afterHash: null,
        });
        return { content: `Deleted ${target.rel}.`, summary: `deleted ${target.rel}` };
      },
    };
  },
});

export const moveFile = defineTool({
  name: 'move_file',
  description:
    "Move or rename one file within the project. The destination must not exist. Requires the user's explicit approval.",
  category: 'file_delete',
  risk: 'medium',
  requiresProject: true,
  schema: z.object({ from: relPath, to: relPath, reason }),
  describeCall: (a) => `${a.from} → ${a.to}`,
  async prepare(args, ctx): Promise<Proposal> {
    const r = await root(ctx);
    const from = await resolveForWrite(r, args.from);
    const to = await resolveForWrite(r, args.to);
    if (!from.exists) throw new WorkspaceError('not_found', `"${from.rel}" does not exist.`);
    if (to.exists)
      throw new WorkspaceError(
        'unsupported',
        `"${to.rel}" already exists; Friday will not overwrite it by moving.`,
      );
    const buf = await fs.readFile(from.abs);
    return {
      title: `Move ${from.rel} → ${to.rel}`,
      summary: `Renames ${from.rel} to ${to.rel}. Content is unchanged.`,
      category: 'file_delete',
      risk: 'medium',
      details: {
        kind: 'file_change',
        changes: [
          { path: to.rel, fromPath: from.rel, change: 'move', diff: '', added: 0, removed: 0 },
        ],
      },
      fingerprint: `${from.rel}:${sha256(buf)}|${to.rel}:absent`,
      async apply(execCtx) {
        await fs.mkdir(path.dirname(to.abs), { recursive: true });
        // Never clobber a file that appeared after the re-check.
        await fs.link(from.abs, to.abs).then(
          () => fs.rm(from.abs),
          async (err: NodeJS.ErrnoException) => {
            if (err.code === 'EEXIST')
              throw new WorkspaceError('unsupported', `"${to.rel}" now exists; not moved.`);
            await fs.rename(from.abs, to.abs);
          },
        );
        execCtx.recordFileChange?.({
          path: to.rel,
          fromPath: from.rel,
          change: 'move',
          beforeContent: null,
          beforeHash: sha256(buf),
          afterHash: sha256(buf),
        });
        return { content: `Moved ${from.rel} to ${to.rel}.`, summary: `moved to ${to.rel}` };
      },
    };
  },
});
