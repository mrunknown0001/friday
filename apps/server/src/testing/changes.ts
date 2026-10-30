import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { repoStatus, runGit } from '../git/git.js';
import type { ChangedLines } from '../tools/reviewTools.js';
import { parseDiff } from '../tools/reviewTools.js';
import { looksBinary } from '../workspace/files.js';
import { isSecretPath } from '../workspace/paths.js';

/**
 * What changed in the working tree (uncommitted, compared with HEAD), for choosing related tests
 * and measuring coverage of the changed lines. Read-only git commands only.
 */

export interface WorkingChanges {
  /** Project-relative files that exist now (deleted files are left out). */
  files: string[];
  /** New-side line ranges per file; untracked files count as changed throughout. */
  lines: ChangedLines;
}

const MAX_UNTRACKED_BYTES = 1024 * 1024;

async function isRepoRoot(root: string): Promise<boolean> {
  const r = await runGit(root, ['rev-parse', '--show-toplevel']).catch(() => null);
  if (!r || r.code !== 0) return false;
  const top = await fs.realpath(r.stdout.trim()).catch(() => r.stdout.trim());
  return top === root;
}

/** Null when the project is not a git repository (or is inside a larger one). */
export async function workingChanges(root: string): Promise<WorkingChanges | null> {
  if (!(await isRepoRoot(root))) return null;
  const status = await repoStatus(root);
  const lines: ChangedLines = {};
  if (status.head) {
    const r = await runGit(root, [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-color',
      '-U0',
      'HEAD',
    ]);
    if (r.code === 0) Object.assign(lines, parseDiff(r.stdout).files);
  }
  const files: string[] = [];
  for (const e of status.entries) {
    if (isSecretPath(e.path)) continue;
    const abs = path.join(root, e.path);
    const stat = await fs.lstat(abs).catch(() => null);
    if (!stat?.isFile()) continue;
    files.push(e.path);
    if (lines[e.path]) continue;
    // Untracked (or not in the diff, e.g. no HEAD yet): every line is new.
    if (stat.size > MAX_UNTRACKED_BYTES) continue;
    const buf = await fs.readFile(abs);
    if (looksBinary(buf)) continue;
    const count = buf.toString('utf8').split('\n').length;
    lines[e.path] = [[1, count]];
  }
  return { files: files.sort(), lines };
}

/**
 * Identifies the exact code a test run saw: HEAD plus the uncommitted diff plus untracked files.
 * Two runs with the same value tested the same code, so a test that passed in one and failed in
 * the other is flaky. Null when it can't be computed reliably.
 */
export async function treeFingerprint(root: string): Promise<string | null> {
  if (!(await isRepoRoot(root))) return null;
  const head = await runGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  const hash = createHash('sha256').update(head.code === 0 ? head.stdout.trim() : 'no-head');
  if (head.code === 0) {
    const diff = await runGit(
      root,
      ['diff', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD'],
      {
        timeoutMs: 30_000,
      },
    ).catch(() => null);
    if (!diff || diff.code !== 0) return null;
    hash.update(diff.stdout);
  }
  const status = await repoStatus(root);
  const untracked = status.entries.filter((e) => e.untracked);
  if (untracked.length > 500) return null;
  for (const e of untracked) {
    hash.update(`\0${e.path}\0`);
    const buf = await fs.readFile(path.join(root, e.path)).catch(() => null);
    if (buf && buf.length <= MAX_UNTRACKED_BYTES) hash.update(buf);
    else hash.update(String(buf?.length ?? -1));
  }
  return hash.digest('hex').slice(0, 32);
}
