import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { WorktreeInfo } from '@friday/shared';
import { assertRepoRoot, git, repoStatus, runGit } from '../git/git.js';
import type { ProjectRecord, ProjectRepo } from '../repositories/projects.js';
import { isSecretPath, isWithin, WorkspaceError } from '../workspace/paths.js';

/**
 * Git worktrees for single tasks. A task's worktree is a separate folder on its own branch, made
 * from the parent project's last commit, so the user's checkout is untouched until they accept
 * (merge, squash, or keep the branch) or discard it. Friday never discards the user's own
 * uncommitted changes: merging into a checkout with uncommitted changes is refused.
 */

/** Dependency folders worth linking from the parent checkout, when git ignores them there. */
const DEPENDENCY_DIRS = new Set(['node_modules', 'vendor', '.venv', 'venv']);
const LINK_DEPTH = 3;
const SKIP = new Set(['.git', '.data', 'dist', 'build', '.next', 'target']);

export type AcceptMode = 'merge' | 'squash' | 'branch';

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30) || 'project';

/** Ignored dependency folders in the parent checkout, as project-relative paths. */
async function dependencyFolders(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (rel: string, depth: number) => {
    let entries;
    try {
      entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP.has(e.name)) continue;
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (DEPENDENCY_DIRS.has(e.name)) found.push(child);
      else if (depth < LINK_DEPTH && !e.name.startsWith('.')) await walk(child, depth + 1);
    }
  };
  await walk('', 1);
  if (!found.length) return [];
  // Only folders git ignores: a tracked "vendor" directory is part of the code, not an install.
  const r = await runGit(root, ['check-ignore', '--stdin'], { input: found.join('\n') + '\n' });
  const ignored = new Set(r.stdout.split('\n').filter(Boolean));
  return found.filter((f) => ignored.has(f));
}

/**
 * Keep the linked folders out of git in the worktree: a symlink is not a directory, so a
 * "node_modules/" ignore rule does not cover it. The rules go in the repository's local exclude
 * file (shared by its worktrees), where they change nothing for the main checkout: the same
 * folders are already ignored there.
 */
async function excludeLinks(worktreeRoot: string, linked: string[]): Promise<void> {
  const common = (await git(worktreeRoot, ['rev-parse', '--git-common-dir'])).trim();
  const file = path.resolve(worktreeRoot, common, 'info', 'exclude');
  const current = await fs.readFile(file, 'utf8').catch(() => '');
  const have = new Set(current.split('\n').map((l) => l.trim()));
  const add = linked.map((l) => `/${l}`).filter((l) => !have.has(l));
  if (!add.length) return;
  await fs.mkdir(path.dirname(file), { recursive: true });
  const header = have.has('# Friday worktrees: linked dependency folders')
    ? ''
    : '# Friday worktrees: linked dependency folders\n';
  await fs.appendFile(
    file,
    `${current && !current.endsWith('\n') ? '\n' : ''}${header}${add.join('\n')}\n`,
  );
}

export class WorktreeManager {
  constructor(
    private readonly projects: ProjectRepo,
    private readonly dataDir: string,
  ) {}

  private folder(): string {
    return path.join(this.dataDir, 'worktrees');
  }

  /** Make a worktree for a new task from the parent project's current commit. */
  async create(parent: ProjectRecord): Promise<ProjectRecord> {
    if (parent.worktree)
      throw new WorkspaceError('unsupported', 'Start worktrees from the main project.');
    await assertRepoRoot(parent.rootPath);
    const status = await repoStatus(parent.rootPath);
    if (!status.head)
      throw new WorkspaceError('unsupported', 'The repository has no commits yet to start from.');

    const id = randomBytes(3).toString('hex');
    const branch = `friday/task-${id}`;
    await fs.mkdir(this.folder(), { recursive: true, mode: 0o700 });
    const target = path.join(this.folder(), `${slug(parent.name)}-${id}`);
    const r = await runGit(
      parent.rootPath,
      ['worktree', 'add', '-b', branch, target, status.head],
      {
        timeoutMs: 120_000,
      },
    );
    if (r.code !== 0)
      throw new WorkspaceError(
        'unsupported',
        `git worktree add failed: ${(r.stderr || r.stdout).trim().split('\n')[0]}`,
      );
    const root = await fs.realpath(target);

    const linked: string[] = [];
    for (const rel of await dependencyFolders(parent.rootPath)) {
      const at = path.join(root, rel);
      // Only where the folder's parent exists in the worktree and nothing is there yet.
      if (!(await fs.stat(path.dirname(at)).catch(() => null))?.isDirectory()) continue;
      if (await fs.lstat(at).catch(() => null)) continue;
      await fs.symlink(path.join(parent.rootPath, rel), at, 'dir');
      linked.push(rel);
    }
    if (linked.length) await excludeLinks(root, linked);

    const info: WorktreeInfo = {
      parentId: parent.id,
      branch,
      base: status.head,
      baseBranch: status.branch,
      linked,
      status: 'active',
      outcome: null,
      createdAt: new Date().toISOString(),
    };
    return this.projects.createWorktree(`${parent.name} · ${branch}`, root, info, parent.sandbox);
  }

  private active(project: ProjectRecord): { info: WorktreeInfo; parent: ProjectRecord } {
    const info = project.worktree;
    if (!info) throw new WorkspaceError('unsupported', 'This project is not a worktree.');
    if (info.status !== 'active')
      throw new WorkspaceError('unsupported', `This worktree was already ${info.status}.`);
    const parent = this.projects.get(info.parentId);
    if (!parent)
      throw new WorkspaceError('not_found', 'The project this worktree came from is gone.');
    return { info, parent };
  }

  /** Commits and uncommitted changes in the worktree, and the state of the parent checkout. */
  async status(project: ProjectRecord) {
    const { info, parent } = this.active(project);
    const log = await git(project.rootPath, [
      'log',
      '-n',
      '100',
      '--format=%H%x00%s',
      `${info.base}..${info.branch}`,
    ]);
    const commits = log
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [sha, subject] = l.split('\0');
        return { sha: sha!, subject: subject ?? '' };
      });
    const wt = await repoStatus(project.rootPath);
    const uncommitted = wt.entries.map((e) => ({
      path: e.path,
      status: e.untracked ? 'new' : e.xy.includes('D') ? 'deleted' : 'modified',
    }));
    const target = await repoStatus(parent.rootPath);
    return {
      commits,
      uncommitted,
      onBranch: wt.branch === info.branch,
      target: {
        branch: target.branch,
        head: target.head,
        dirty: target.entries.filter((e) => !e.untracked).map((e) => e.path),
      },
    };
  }

  /** Commit what the task left uncommitted in the worktree, on its own branch. */
  private async commitPending(project: ProjectRecord, info: WorktreeInfo, message: string) {
    const wt = await repoStatus(project.rootPath);
    if (wt.branch !== info.branch)
      throw new WorkspaceError(
        'unsupported',
        `The worktree is on ${wt.branch ?? 'a detached HEAD'}, not ${info.branch}. Switch it back first.`,
      );
    if (!wt.entries.length) return;
    const secret = wt.entries.filter(
      (e) => isSecretPath(e.path) || (e.origPath && isSecretPath(e.origPath)),
    );
    if (secret.length)
      throw new WorkspaceError(
        'secret_file',
        `The worktree has credential files that would be committed (${secret.map((e) => e.path).join(', ')}). Delete them or add them to .gitignore first.`,
      );
    await git(project.rootPath, ['add', '-A']);
    const r = await runGit(project.rootPath, ['commit', '-q', '-m', message]);
    if (r.code !== 0)
      throw new WorkspaceError(
        'unsupported',
        `Committing the worktree's changes failed: ${(r.stderr || r.stdout).trim().split('\n')[0]}`,
      );
  }

  /**
   * Accept the task. Uncommitted changes in the worktree are committed first. "merge" and
   * "squash" land it on the branch the parent checkout is on (refused if that checkout has
   * uncommitted changes, so nothing of the user's is ever touched; a conflict is aborted and the
   * worktree kept). "branch" keeps the branch and removes only the folder.
   */
  async accept(project: ProjectRecord, mode: AcceptMode, message: string): Promise<WorktreeInfo> {
    const { info, parent } = this.active(project);
    await this.commitPending(project, info, message);

    let outcome: WorktreeInfo['outcome'];
    if (mode === 'branch') {
      const head = (await git(project.rootPath, ['rev-parse', info.branch])).trim();
      outcome = { mode, branch: info.branch, commit: head, at: new Date().toISOString() };
    } else {
      const target = await repoStatus(parent.rootPath);
      if (!target.branch)
        throw new WorkspaceError(
          'unsupported',
          'Your checkout is on a detached HEAD; switch to the branch to merge into first.',
        );
      const dirty = target.entries.filter((e) => !e.untracked);
      if (dirty.length)
        throw new WorkspaceError(
          'unsupported',
          `Your checkout has uncommitted changes (${dirty
            .slice(0, 5)
            .map((e) => e.path)
            .join(
              ', ',
            )}${dirty.length > 5 ? ', …' : ''}). Commit or stash them first; Friday never touches them.`,
        );
      const ahead = Number(
        (
          await git(parent.rootPath, ['rev-list', '--count', `${target.head}..${info.branch}`])
        ).trim(),
      );
      if (!ahead)
        throw new WorkspaceError(
          'unsupported',
          `${info.branch} has nothing that ${target.branch} doesn't.`,
        );
      const merge =
        mode === 'merge'
          ? ['merge', '--no-ff', '-m', `Merge ${info.branch}: ${message}`, info.branch]
          : ['merge', '--squash', info.branch];
      const r = await runGit(parent.rootPath, merge, { timeoutMs: 120_000 });
      if (r.code !== 0) {
        // The checkout was clean, so undoing the attempt restores it exactly.
        await runGit(
          parent.rootPath,
          mode === 'merge' ? ['merge', '--abort'] : ['reset', '--merge'],
        );
        const conflicts = /CONFLICT \([^)]*\): .*? in (.+)$/gm;
        const files = [...`${r.stdout}\n${r.stderr}`.matchAll(conflicts)].map((m) => m[1]);
        throw new WorkspaceError(
          'unsupported',
          files.length
            ? `The changes conflict with ${target.branch} in ${files.join(', ')}. Nothing was changed; the worktree is kept, so ask Friday to bring it up to date with ${target.branch} there.`
            : `The merge failed and was undone: ${(r.stderr || r.stdout).trim().split('\n')[0]}`,
        );
      }
      if (mode === 'squash') {
        const c = await runGit(parent.rootPath, ['commit', '-q', '-m', message]);
        if (c.code !== 0) {
          await runGit(parent.rootPath, ['reset', '--merge']);
          throw new WorkspaceError(
            'unsupported',
            `Committing the squashed changes failed and was undone: ${(c.stderr || c.stdout).trim().split('\n')[0]}`,
          );
        }
      }
      const head = (await git(parent.rootPath, ['rev-parse', 'HEAD'])).trim();
      outcome = { mode, branch: target.branch, commit: head, at: new Date().toISOString() };
    }

    await this.remove(project, parent, info, mode === 'branch' ? null : mode);
    const done: WorktreeInfo = { ...info, status: 'accepted', outcome };
    this.projects.setWorktree(project.id, done);
    return done;
  }

  /** Discard the task: remove the worktree folder and its branch. The user's checkout is untouched. */
  async discard(project: ProjectRecord): Promise<WorktreeInfo> {
    const { info, parent } = this.active(project);
    await this.remove(project, parent, info, 'discard');
    const done: WorktreeInfo = {
      ...info,
      status: 'discarded',
      outcome: { mode: 'discard', branch: null, commit: null, at: new Date().toISOString() },
    };
    this.projects.setWorktree(project.id, done);
    return done;
  }

  /**
   * Remove the worktree folder (only one Friday made, inside its data folder and registered with
   * git), and delete the branch unless it is kept.
   */
  private async remove(
    project: ProjectRecord,
    parent: ProjectRecord,
    info: WorktreeInfo,
    deleteBranch: 'merge' | 'squash' | 'discard' | null,
  ): Promise<void> {
    const root = project.rootPath;
    const folder = await fs.realpath(this.folder()).catch(() => this.folder());
    if (!isWithin(folder, root) || root === folder)
      throw new WorkspaceError('unsupported', 'Refusing to remove a folder Friday did not create.');
    const listed = await git(parent.rootPath, ['worktree', 'list', '--porcelain']);
    const registered = listed
      .split('\n')
      .filter((l) => l.startsWith('worktree '))
      .map((l) => l.slice('worktree '.length));
    if (registered.some((p) => p === root)) {
      // Links first, so removal never follows them into the parent's dependency folders.
      for (const rel of info.linked) {
        const at = path.join(root, rel);
        if ((await fs.lstat(at).catch(() => null))?.isSymbolicLink()) await fs.unlink(at);
      }
      const r = await runGit(parent.rootPath, ['worktree', 'remove', '--force', root], {
        timeoutMs: 60_000,
      });
      if (r.code !== 0)
        throw new WorkspaceError(
          'unsupported',
          `git worktree remove failed: ${(r.stderr || r.stdout).trim().split('\n')[0]}`,
        );
    }
    await runGit(parent.rootPath, ['worktree', 'prune']);
    if (deleteBranch)
      await runGit(parent.rootPath, [
        'branch',
        deleteBranch === 'merge' ? '-d' : '-D',
        info.branch,
      ]);
  }
}
