import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from '../http/errors.js';
import type { FileChangeRecord } from '../repositories/fileChanges.js';
import {
  assertRootAvailable,
  resolveForWrite,
  WorkspaceError,
  type WritePath,
} from '../workspace/paths.js';

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function currentHash(abs: string): Promise<string | null> {
  try {
    return sha256(await fs.readFile(abs));
  } catch {
    return null;
  }
}

const changedSince = (rel: string) =>
  new HttpError(
    409,
    'changed_since',
    `"${rel}" was modified after Friday changed it. Not reverting, to avoid losing those edits.`,
  );

interface RevertPlan {
  target: WritePath;
  back: WritePath | null;
}

function asHttp(err: unknown): never {
  if (err instanceof HttpError) throw err;
  if (err instanceof WorkspaceError) throw new HttpError(409, err.code, err.message);
  throw err;
}

/**
 * Check that a change can be undone without losing anything: the file must still be exactly as
 * Friday left it. Performs no writes.
 */
export async function checkRevertable(change: FileChangeRecord, root: string): Promise<RevertPlan> {
  try {
    await assertRootAvailable(root);
    const target = await resolveForWrite(root, change.path);
    const now = target.exists ? await currentHash(target.abs) : null;
    switch (change.change) {
      case 'create':
        if (now !== change.afterHash) throw changedSince(change.path);
        return { target, back: null };
      case 'modify':
        if (now !== change.afterHash || !change.beforeContent) throw changedSince(change.path);
        return { target, back: null };
      case 'delete':
        if (target.exists || !change.beforeContent) {
          throw new HttpError(
            409,
            'changed_since',
            `"${change.path}" exists again; not overwriting it.`,
          );
        }
        return { target, back: null };
      case 'move': {
        if (now !== change.afterHash || !change.fromPath) throw changedSince(change.path);
        const back = await resolveForWrite(root, change.fromPath);
        if (back.exists) {
          throw new HttpError(
            409,
            'changed_since',
            `"${change.fromPath}" exists again; not overwriting it.`,
          );
        }
        return { target, back };
      }
    }
  } catch (err) {
    return asHttp(err);
  }
}

async function applyRevert(change: FileChangeRecord, plan: RevertPlan): Promise<void> {
  const { target, back } = plan;
  switch (change.change) {
    case 'create':
      await fs.rm(target.abs);
      return;
    case 'modify':
      await fs.writeFile(target.abs, change.beforeContent!);
      return;
    case 'delete':
      await fs.mkdir(path.dirname(target.abs), { recursive: true });
      await fs.writeFile(target.abs, change.beforeContent!, { flag: 'wx' });
      return;
    case 'move':
      await fs.mkdir(path.dirname(back!.abs), { recursive: true });
      await fs.rename(target.abs, back!.abs);
      return;
  }
}

/** Undo one applied change, only if the file is still exactly as Friday left it. */
export async function revertFileChange(change: FileChangeRecord, root: string): Promise<void> {
  const plan = await checkRevertable(change, root);
  try {
    await applyRevert(change, plan);
  } catch (err) {
    asHttp(err);
  }
}

/**
 * Undo several changes (newest first). Only the newest change per path is checked against the
 * disk, because older ones become current as newer ones are undone; if any check fails nothing
 * is touched.
 */
export async function revertChanges(
  changes: FileChangeRecord[],
  root: string,
  onReverted: (c: FileChangeRecord) => void,
): Promise<void> {
  const ordered = [...changes].sort((a, b) => b.id - a.id);
  const newestPerPath = new Map<string, FileChangeRecord>();
  for (const c of ordered) if (!newestPerPath.has(c.path)) newestPerPath.set(c.path, c);
  for (const c of newestPerPath.values()) await checkRevertable(c, root);
  for (const c of ordered) {
    await revertFileChange(c, root);
    onReverted(c);
  }
}
