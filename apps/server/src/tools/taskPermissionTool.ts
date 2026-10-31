import fs from 'node:fs/promises';
import { z } from 'zod';
import { TASK_PERMISSION_LIMITS as L } from '../approvals/taskPermission.js';
import { localPageUrl, PageUrlError } from '../browser/urls.js';
import { assessCommand } from '../commands/risk.js';
import {
  assertRootAvailable,
  resolveForWrite,
  resolveInside,
  WorkspaceError,
} from '../workspace/paths.js';
import { displayArgv } from './commandTool.js';
import { defineTool, type Proposal } from './types.js';

export const requestTaskPermissions = defineTool({
  name: 'request_task_permissions',
  description:
    'For a multi-step coding task (e.g. fix, test, fix again), ask the user once for permission to edit specific files, run specific commands and run browser flows on specific local sites until the task is done, instead of asking for each step. List only what the task needs: exact project paths (a path ending in "/" covers a folder), exact commands as argv (no shell), and local sites (e.g. "http://localhost:5173") for run_browser_flow. Matching file edits, commands and flows then run without a separate approval; anything else (deletes, moves, git, remote, shell scripts, other files or commands) still needs approval. The user may reject it; then continue asking per action. Call it before the first approved action (edit or command), together with your plan.',
  category: 'task_permission',
  risk: 'medium',
  requiresProject: true,
  schema: z.object({
    plan: z.array(z.string().min(3).max(200)).min(1).max(12).describe('The steps of the task.'),
    files: z
      .array(z.string().min(1).max(1024))
      .max(L.maxFiles)
      .default([])
      .describe('Project-relative files to create or modify; "dir/" covers a folder.'),
    commands: z
      .array(z.array(z.string().min(1).max(500)).min(1).max(20))
      .max(L.maxCommands)
      .default([])
      .describe('Exact commands to allow, e.g. [["npm", "test"]]. Run in the project root.'),
    sites: z
      .array(z.string().min(1).max(500))
      .max(L.maxSites)
      .default([])
      .describe('Local sites where run_browser_flow may run, e.g. ["http://localhost:5173"].'),
    max_actions: z.number().int().min(1).max(L.maxActions).default(L.defaultActions),
    minutes: z.number().int().min(5).max(L.maxMinutes).default(L.defaultMinutes),
    reason: z.string().min(3).max(500).describe('Why one permission fits this task.'),
  }),
  describeCall: (a) =>
    `${a.files?.length ?? 0} files, ${a.commands?.length ?? 0} commands${a.sites?.length ? `, ${a.sites.length} site${a.sites.length === 1 ? '' : 's'}` : ''}`,
  async prepare(args, ctx): Promise<Proposal> {
    if (!ctx.project)
      throw new WorkspaceError('unsupported', 'This conversation is not attached to a project.');
    const root = ctx.project.rootPath;
    await assertRootAvailable(root);

    // Same path policy as the file tools: inside the project, no credential files, no .git.
    const files: string[] = [];
    for (const raw of args.files) {
      const folder = raw.trim().endsWith('/');
      const rel = raw.trim().replace(/\/+$/, '');
      // Existing folders resolve like reads; anything else (files, new paths) like writes.
      const existing = await resolveInside(root, rel).catch(() => null);
      const isDir = existing ? (await fs.stat(existing.abs)).isDirectory() : false;
      if (isDir && !folder)
        throw new WorkspaceError('invalid_path', `"${rel}" is a folder; write it as "${rel}/".`);
      const target = isDir ? existing! : await resolveForWrite(root, rel);
      if (target.rel === '.' || target.rel === '')
        throw new WorkspaceError(
          'invalid_path',
          'List specific files or folders, not the whole project.',
        );
      const entry = folder ? `${target.rel}/` : target.rel;
      if (!files.includes(entry)) files.push(entry);
    }

    const commands: string[][] = [];
    for (const argv of args.commands) {
      if (argv.some((a) => a.includes('\0')))
        throw new WorkspaceError('invalid_path', 'Commands may not contain NUL characters.');
      const assessment = assessCommand(argv, null);
      if (assessment.risk === 'high' || assessment.risk === 'critical' || assessment.network) {
        throw new WorkspaceError(
          'unsupported',
          `"${displayArgv(argv)}" cannot be part of a task permission (${assessment.reasons.join('; ') || assessment.risk + ' risk'}). Leave it out and ask for it as a separate action.`,
        );
      }
      if (!commands.some((c) => c.join('\0') === argv.join('\0'))) commands.push(argv);
    }

    const sites: string[] = [];
    for (const raw of args.sites) {
      let origin: string;
      try {
        origin = new URL(localPageUrl(raw, ctx.capture?.fridayPort() ?? null)).origin;
      } catch (err) {
        if (err instanceof PageUrlError) throw new WorkspaceError('invalid_path', err.message);
        throw err;
      }
      if (!sites.includes(origin)) sites.push(origin);
    }
    if (!files.length && !commands.length && !sites.length)
      throw new WorkspaceError('invalid_path', 'List the files, commands or sites the task needs.');

    const shown = (xs: string[]) =>
      xs.length > 3 ? `${xs.slice(0, 3).join(', ')}, …` : xs.join(', ');
    return {
      title: `Task permission: ${[
        files.length ? `${files.length} file${files.length === 1 ? '' : 's'}` : '',
        commands.length ? `${commands.length} command${commands.length === 1 ? '' : 's'}` : '',
        sites.length ? `browser flows on ${sites.length} site${sites.length === 1 ? '' : 's'}` : '',
      ]
        .filter(Boolean)
        .join(', ')}`,
      summary: `Lets Friday ${[
        files.length ? `edit ${shown(files)}` : '',
        commands.length ? `run ${shown(commands.map(displayArgv))}` : '',
        sites.length ? `run browser flows on ${shown(sites)}` : '',
      ]
        .filter(Boolean)
        .join(
          ', ',
        )} without asking each time, for this task only: up to ${args.max_actions} actions within ${args.minutes} minutes. Each change is still re-checked, recorded and undoable; anything else still asks you.`,
      category: 'task_permission',
      risk: 'medium',
      details: {
        kind: 'task_permissions',
        plan: args.plan.map((s) => ctx.redactor.redact(s)),
        files,
        commands,
        ...(sites.length ? { sites } : {}),
        maxActions: args.max_actions,
        minutes: args.minutes,
      },
      fingerprint: JSON.stringify({
        files,
        commands,
        sites,
        max: args.max_actions,
        min: args.minutes,
      }),
      async apply(execCtx) {
        const granted = execCtx.grantTaskPermission?.({
          files,
          commands,
          sites,
          maxActions: args.max_actions,
          minutes: args.minutes,
        });
        if (!granted)
          throw new WorkspaceError('unsupported', 'Task permissions are not available.');
        return {
          content: `Task permission granted until ${granted.expiresAt} for up to ${args.max_actions} actions. ${[
            files.length ? `Edits to ${files.join(', ')}` : '',
            commands.length ? `the commands ${commands.map(displayArgv).join(', ')}` : '',
            sites.length ? `browser flows on ${sites.join(', ')}` : '',
          ]
            .filter(Boolean)
            .join(
              ', ',
            )} now run without a separate approval (they are still re-checked and recorded). Anything else still needs approval. Continue with the plan.`,
          summary: `granted: ${args.max_actions} actions, ${args.minutes} min`,
        };
      },
    };
  },
});
