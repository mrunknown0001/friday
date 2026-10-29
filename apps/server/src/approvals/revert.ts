import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from '../http/errors.js';
import type { FileChangeRecord } from '../repositories/fileChanges.js';
import { assertRootAvailable, resolveForWrite, WorkspaceError } from '../workspace/paths.js';

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

/**
 * Undo one applied change, but only if the file is still exactly as Friday left it. Anything
 * else (later edits by the user or another change) is refused rather than overwritten.
 */
export async function revertFileChange(change: FileChangeRecord, root: string): Promise<void> {
  try {
    await assertRootAvailable(root);
    const target = await resolveForWrite(root, change.path).catch((err: unknown) => {
      // A path that no longer resolves cleanly is never touched.
      throw err instanceof WorkspaceError ? new HttpError(409, err.code, err.message) : err;
    });
    const now = target.exists ? await currentHash(target.abs) : null;

    switch (change.change) {
      case 'create':
        if (now !== change.afterHash) throw changedSince(change.path);
        await fs.rm(target.abs);
        return;
      case 'modify':
        if (now !== change.afterHash || !change.beforeContent) throw changedSince(change.path);
        await fs.writeFile(target.abs, change.beforeContent);
        return;
      case 'delete':
        if (target.exists || !change.beforeContent) {
          throw new HttpError(
            409,
            'changed_since',
            `"${change.path}" exists again; not overwriting it.`,
          );
        }
        await fs.mkdir(path.dirname(target.abs), { recursive: true });
        await fs.writeFile(target.abs, change.beforeContent, { flag: 'wx' });
        return;
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
        await fs.mkdir(path.dirname(back.abs), { recursive: true });
        await fs.rename(target.abs, back.abs);
        return;
      }
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (err instanceof WorkspaceError) throw new HttpError(409, err.code, err.message);
    throw err;
  }
}
