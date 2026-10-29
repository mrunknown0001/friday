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

/** A computed, not-yet-applied change to one text file. */
interface FilePlan {
  rel: string;
  abs: string;
  before: { buf: Buffer; text: string } | null;
  after: string;
  preview: FileChangePreview;
  mode: number | undefined;
  fingerprint: string;
}

async function planWrite(root: string, p: string, content: string): Promise<FilePlan> {
  const target = await resolveForWrite(root, p);
  const before = target.exists ? await readText(target.abs, target.rel) : null;
  if (before?.text === content) {
    throw new WorkspaceError('unsupported', `"${target.rel}" already has exactly this content.`);
  }
  return {
    rel: target.rel,
    abs: target.abs,
    before,
    after: content,
    preview: makeDiff(target.rel, before?.text ?? '', content, before ? 'modify' : 'create'),
    mode: target.exists ? (await fs.stat(target.abs)).mode : undefined,
    fingerprint: `${target.rel}:${before ? sha256(before.buf) : 'absent'}`,
  };
}

const editSchema = z.object({
  old_text: z.string().min(1).max(100_000),
  new_text: z.string().max(100_000),
  replace_all: z.boolean().default(false),
});
type Edit = z.infer<typeof editSchema>;

async function planEdit(root: string, p: string, edits: Edit[]): Promise<FilePlan> {
  const target = await resolveForWrite(root, p);
  if (!target.exists) {
    throw new WorkspaceError(
      'not_found',
      `"${target.rel}" does not exist; use write_file to create it.`,
    );
  }
  const before = await readText(target.abs, target.rel);
  let after = before.text;
  edits.forEach((e, i) => {
    const count = after.split(e.old_text).length - 1;
    if (count === 0) {
      throw new WorkspaceError(
        'unsupported',
        `Edit ${i + 1} to ${target.rel}: old_text was not found. Re-read the file and copy the text exactly.`,
      );
    }
    if (count > 1 && !e.replace_all) {
      throw new WorkspaceError(
        'unsupported',
        `Edit ${i + 1} to ${target.rel}: old_text matches ${count} places. Include more surrounding lines or set replace_all.`,
      );
    }
    after = e.replace_all
      ? after.split(e.old_text).join(e.new_text)
      : after.replace(e.old_text, () => e.new_text);
  });
  if (after === before.text)
    throw new WorkspaceError('unsupported', `The edits do not change ${target.rel}.`);
  return {
    rel: target.rel,
    abs: target.abs,
    before,
    after,
    preview: makeDiff(target.rel, before.text, after, 'modify'),
    mode: (await fs.stat(target.abs)).mode,
    fingerprint: `${target.rel}:${sha256(before.buf)}`,
  };
}

async function applyPlan(plan: FilePlan, ctx: ToolContext): Promise<void> {
  await atomicWrite(plan.abs, plan.after, plan.mode);
  ctx.recordFileChange?.({
    path: plan.rel,
    fromPath: null,
    change: plan.before ? 'modify' : 'create',
    beforeContent: plan.before?.buf ?? null,
    beforeHash: plan.before ? sha256(plan.before.buf) : null,
    afterHash: sha256(plan.after),
  });
}

/** Restore the pre-change state of a plan that was applied as part of a failed batch. */
async function undoPlan(plan: FilePlan): Promise<void> {
  if (plan.before) await atomicWrite(plan.abs, plan.before.text, plan.mode);
  else await fs.rm(plan.abs, { force: true });
}

const counts = (p: FileChangePreview) => `+${p.added} −${p.removed}`;

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
    const plan = await planWrite(await root(ctx), args.path, args.content);
    const verb = plan.before ? 'updated' : 'created';
    return {
      title: `${plan.before ? 'Overwrite' : 'Create'} ${plan.rel}`,
      summary: `${plan.before ? 'Replaces the contents of' : 'Creates'} ${plan.rel} (${counts(plan.preview)}).`,
      category: plan.before ? 'file_modify' : 'file_create',
      risk: sizeRisk(plan.preview),
      details: { kind: 'file_change', changes: [plan.preview] },
      fingerprint: plan.fingerprint,
      async apply(execCtx) {
        await applyPlan(plan, execCtx);
        return {
          content: `${verb[0]!.toUpperCase()}${verb.slice(1)} ${plan.rel} (${counts(plan.preview)}).`,
          summary: `${verb} ${plan.rel}`,
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
  schema: z.object({ path: relPath, edits: z.array(editSchema).min(1).max(20), reason }),
  describeCall: (a) =>
    `${a.path} (${a.edits?.length ?? 0} edit${a.edits?.length === 1 ? '' : 's'})`,
  async prepare(args, ctx): Promise<Proposal> {
    const plan = await planEdit(await root(ctx), args.path, args.edits);
    return {
      title: `Edit ${plan.rel}`,
      summary: `Applies ${args.edits.length} edit${args.edits.length === 1 ? '' : 's'} to ${plan.rel} (${counts(plan.preview)}).`,
      category: 'file_modify',
      risk: sizeRisk(plan.preview),
      details: { kind: 'file_change', changes: [plan.preview] },
      fingerprint: plan.fingerprint,
      async apply(execCtx) {
        await applyPlan(plan, execCtx);
        return {
          content: `Edited ${plan.rel} (${counts(plan.preview)}).`,
          summary: `edited ${plan.rel} (${counts(plan.preview)})`,
        };
      },
    };
  },
});

export const editFiles = defineTool({
  name: 'edit_files',
  description:
    'Change several files in one reviewed step (e.g. a function and its callers, or code plus its test). Each entry either applies exact-string `edits` to an existing file or writes full `content` (new file or rewrite). The user approves the whole set at once; it is applied all-or-nothing.',
  category: 'file_modify',
  risk: 'medium',
  requiresProject: true,
  schema: z.object({
    changes: z
      .array(
        z
          .object({
            path: relPath,
            edits: z.array(editSchema).min(1).max(20).optional(),
            content: z.string().max(MAX_WRITE_CHARS).optional(),
          })
          .refine((c) => (c.edits === undefined) !== (c.content === undefined), {
            message: 'Each change needs exactly one of edits or content.',
          }),
      )
      .min(1)
      .max(20),
    reason,
  }),
  describeCall: (a) => `${a.changes?.length ?? 0} files`,
  async prepare(args, ctx): Promise<Proposal> {
    const r = await root(ctx);
    const plans: FilePlan[] = [];
    for (const c of args.changes) {
      plans.push(
        c.edits ? await planEdit(r, c.path, c.edits) : await planWrite(r, c.path, c.content!),
      );
    }
    const dup = plans.find((p, i) => plans.findIndex((q) => q.abs === p.abs) !== i);
    if (dup)
      throw new WorkspaceError(
        'unsupported',
        `"${dup.rel}" appears more than once; combine its edits.`,
      );
    const added = plans.reduce((n, p) => n + p.preview.added, 0);
    const removed = plans.reduce((n, p) => n + p.preview.removed, 0);
    const creates = plans.some((p) => !p.before);
    return {
      title: `Change ${plans.length} files`,
      summary: `Applies changes to ${plans.map((p) => p.rel).join(', ')} (+${added} −${removed}) as one all-or-nothing step.`,
      category: creates ? 'file_create' : 'file_modify',
      risk: added + removed > 400 || plans.length > 10 ? 'high' : 'medium',
      details: { kind: 'file_change', changes: plans.map((p) => p.preview) },
      fingerprint: plans.map((p) => p.fingerprint).join('|'),
      async apply(execCtx) {
        const done: FilePlan[] = [];
        const recorded: Parameters<NonNullable<ToolContext['recordFileChange']>>[0][] = [];
        // Collect change records and only persist them once every file is written.
        const batchCtx: ToolContext = { ...execCtx, recordFileChange: (c) => recorded.push(c) };
        try {
          for (const plan of plans) {
            await applyPlan(plan, batchCtx);
            done.push(plan);
          }
        } catch (err) {
          for (const plan of done.reverse()) await undoPlan(plan).catch(() => undefined);
          throw new WorkspaceError(
            'unsupported',
            `Applying the change set failed (${err instanceof Error ? err.message : String(err)}); the ${done.length} file(s) already written were restored.`,
          );
        }
        for (const c of recorded) execCtx.recordFileChange?.(c);
        return {
          content: `Changed ${plans.length} files: ${plans.map((p) => `${p.rel} (${counts(p.preview)})`).join(', ')}.`,
          summary: `changed ${plans.length} files (+${added} −${removed})`,
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
