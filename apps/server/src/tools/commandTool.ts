import fs from 'node:fs/promises';
import type { ApprovalDetails, SandboxSettings } from '@friday/shared';
import { z } from 'zod';
import { extractLocations } from '../commands/locations.js';
import { assessCommand } from '../commands/risk.js';
import { childEnv, runProcess, type RunResult } from '../commands/runner.js';
import {
  findCredentials,
  hostPaths,
  imagePresent,
  runInSandbox,
  sandboxName,
  WORKSPACE,
  type SandboxRun,
} from '../sandbox/docker.js';
import { assertRootAvailable, resolveInside, WorkspaceError } from '../workspace/paths.js';
import { defineTool, type Proposal, type ToolContext } from './types.js';

const MAX_TIMEOUT_SECONDS = 600;

/** Shell-style display of an argv, quoting only where needed. */
export function displayArgv(argv: string[]): string {
  return argv
    .map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`))
    .join(' ');
}

/** Keep the start and the end (where test summaries and errors usually are). */
export function clipOutput(output: string, max: number): { text: string; clipped: boolean } {
  if (output.length <= max) return { text: output, clipped: false };
  const half = Math.floor(max / 2);
  return {
    text: `${output.slice(0, half)}\n[... ${output.length - max} characters omitted ...]\n${output.slice(-half)}`,
    clipped: true,
  };
}

export interface CommandArgs {
  argv?: string[] | undefined;
  shell_command?: string | undefined;
  cwd: string;
}

/**
 * What run_command and start_process share: the working folder (inside the project), the risk
 * assessment, and where the command will run (this machine, or the project's sandbox, which the
 * model cannot choose). Side-effect free.
 */
export async function prepareCommand(args: CommandArgs, ctx: ToolContext) {
  if (!ctx.project)
    throw new WorkspaceError('unsupported', 'This conversation is not attached to a project.');
  const root = ctx.project.rootPath;
  await assertRootAvailable(root);
  const cwd = await resolveInside(root, args.cwd);
  if (!(await fs.stat(cwd.abs)).isDirectory())
    throw new WorkspaceError('not_a_directory', `"${cwd.rel}" is not a folder.`);
  const argv = args.argv ?? null;
  const shellCommand = args.shell_command ?? null;
  const shown = argv ? displayArgv(argv) : shellCommand!;
  const assessment = assessCommand(argv, shellCommand);

  const sandbox = ctx.project.sandbox?.enabled ? ctx.project.sandbox : null;
  let gitDir = false;
  let hidden = 0;
  if (sandbox) {
    if (!ctx.env.docker)
      throw new WorkspaceError(
        'unsupported',
        'This project runs commands in a container, but Docker is not reachable. Ask the user to start Docker or turn the sandbox off in Project settings.',
      );
    if (!(await imagePresent(sandbox.image)))
      throw new WorkspaceError(
        'unsupported',
        `This project runs commands in the container image "${sandbox.image}", which is not available locally. Ask the user to pull it in Project settings › Command sandbox; Friday never downloads images by itself.`,
      );
    gitDir = await fs
      .lstat(`${root}/.git`)
      .then((s) => s.isDirectory())
      .catch(() => false);
    const masks = await findCredentials(root);
    hidden = masks.files.length + masks.dirs.length;
    if (assessment.network && sandbox.network === 'none')
      assessment.reasons.push('The sandbox has no network, so this command will probably fail.');
  }
  const env = sandbox
    ? ['CI', 'FORCE_COLOR', 'HOME', 'LANG', 'NO_COLOR', 'TERM']
    : Object.keys(childEnv()).sort();
  const details: Extract<ApprovalDetails, { kind: 'command' }> = {
    kind: 'command',
    argv,
    shellCommand,
    shell: shellCommand !== null,
    cwd: cwd.rel,
    host: 'local',
    timeoutSeconds: 0,
    env,
    network: assessment.network,
    riskReasons: assessment.reasons,
    sandbox: sandbox
      ? {
          image: sandbox.image,
          network: sandbox.network,
          hiddenCredentials: hidden,
          gitReadOnly: gitDir,
        }
      : null,
  };
  return { root, cwd, argv, shellCommand, shown, assessment, sandbox, gitDir, details };
}

/** The container settings for one sandboxed command (credentials scanned again right now). */
export async function sandboxRun(
  root: string,
  cwdRel: string,
  sandbox: SandboxSettings,
  command: { argv: string[] | null; shellCommand: string | null },
  gitDir: boolean,
  instance: string,
  ports?: number[],
  outputDir?: string,
  env?: Record<string, string>,
): Promise<SandboxRun> {
  return {
    root,
    cwdRel,
    settings: sandbox,
    ...command,
    // Scanned again now: credential files created since review are hidden too.
    masks: await findCredentials(root),
    gitDir,
    instance,
    name: sandboxName(),
    uid: process.getuid?.() ?? 1000,
    gid: process.getgid?.() ?? 1000,
    ...(ports?.length ? { ports } : {}),
    ...(outputDir ? { outputDir } : {}),
    ...(env && Object.keys(env).length ? { env } : {}),
  };
}

/**
 * Run a command prepared by prepareCommand, after approval: in the project's sandbox when it has
 * one, otherwise on this machine. Output is streamed to the UI.
 */
export async function runPrepared(
  prep: Pick<
    Awaited<ReturnType<typeof prepareCommand>>,
    'root' | 'cwd' | 'argv' | 'shellCommand' | 'sandbox' | 'gitDir'
  >,
  timeoutSeconds: number,
  execCtx: ToolContext,
): Promise<RunResult> {
  const { root, cwd, argv, shellCommand, sandbox, gitDir } = prep;
  const run = {
    timeoutMs: timeoutSeconds * 1000,
    signal: execCtx.signal,
    ...(execCtx.emitOutput ? { onOutput: execCtx.emitOutput } : {}),
  };
  const result = sandbox
    ? await runInSandbox(
        await sandboxRun(
          root,
          cwd.rel,
          sandbox,
          { argv, shellCommand },
          gitDir,
          execCtx.env.sandboxInstance,
        ),
        run,
      )
    : await runProcess({ argv, shellCommand, cwd: cwd.abs, ...run });
  if (result.spawnError) throw new WorkspaceError('unsupported', result.spawnError);
  return result;
}

export const runCommand = defineTool({
  name: 'run_command',
  description:
    "Run a command in the project (tests, builds, linters, diagnostics). Prefer `argv` (no shell). Use `shell_command` only when you need pipes, redirection or chaining. Every command requires the user's approval; they see the exact command, working directory and risk. Non-interactive: stdin is closed, CI=1 is set, and secrets are not passed in the environment. If the user enabled the project's command sandbox, it runs in a Docker container that sees only the project folder (credential files hidden, .git read-only, usually no network); the result says so. You cannot choose where it runs.",
  category: 'shell',
  risk: 'medium',
  requiresProject: true,
  schema: z
    .object({
      argv: z
        .array(z.string().max(4_000))
        .min(1)
        .max(100)
        .optional()
        .describe('Program and arguments, e.g. ["npm", "test"]. No shell interpretation.'),
      shell_command: z
        .string()
        .min(1)
        .max(8_000)
        .optional()
        .describe('A script for /bin/sh -c. Only when shell features are required.'),
      cwd: z
        .string()
        .max(1024)
        .default('.')
        .describe('Working directory relative to the project root.'),
      timeout_seconds: z.number().int().min(1).max(MAX_TIMEOUT_SECONDS).default(120),
      reason: z.string().min(3).max(500).describe('Why this command is needed. Shown to the user.'),
    })
    .refine((a) => (a.argv === undefined) !== (a.shell_command === undefined), {
      message: 'Provide exactly one of argv or shell_command.',
    }),
  describeCall: (a) => (a.argv ? displayArgv(a.argv) : (a.shell_command ?? '')).slice(0, 120),
  async prepare(args, ctx): Promise<Proposal> {
    const { root, cwd, argv, shellCommand, shown, assessment, sandbox, gitDir, details } =
      await prepareCommand(args, ctx);
    const where = sandbox
      ? `in a ${sandbox.network === 'none' ? 'network-less ' : ''}container (${sandbox.image}) with only the project folder mounted`
      : 'on this machine, as your user';

    return {
      title: `Run: ${shown.length > 80 ? `${shown.slice(0, 80)}…` : shown}`,
      summary: `Runs ${argv ? 'a program directly (no shell)' : 'a shell script with /bin/sh'} in ${cwd.rel === '.' ? 'the project root' : cwd.rel} ${where}, for up to ${args.timeout_seconds}s.`,
      category: 'shell',
      risk: assessment.risk,
      details: { ...details, timeoutSeconds: args.timeout_seconds },
      // Changing the sandbox setting after review makes the approval stale.
      fingerprint: `cwd:${cwd.abs}|sandbox:${sandbox ? JSON.stringify(sandbox) : 'off'}`,
      timeoutMs: (args.timeout_seconds + 5) * 1000,
      async apply(execCtx) {
        const result = await runPrepared(
          { root, cwd, argv, shellCommand, sandbox, gitDir },
          args.timeout_seconds,
          execCtx,
        );
        const status = result.timedOut
          ? `timed out after ${args.timeout_seconds}s (process killed)`
          : result.cancelled
            ? 'cancelled (process killed)'
            : result.signal
              ? `killed by ${result.signal}`
              : `exit code ${result.exitCode}`;
        // Container paths (/workspace/...) are shown as the project paths they map to.
        const output = sandbox ? hostPaths(result.output, root) : result.output;
        const { text, clipped } = clipOutput(output, execCtx.maxOutputChars - 400);
        const failed =
          result.timedOut || result.cancelled || result.signal !== null || result.exitCode !== 0;
        const locations = failed ? extractLocations(output, root, cwd.abs) : [];
        const content = [
          `$ ${shown}`,
          `cwd: ${cwd.rel}`,
          ...(sandbox
            ? [
                `sandbox: ${sandbox.image}, network ${sandbox.network}, project at ${WORKSPACE} (paths below are shown as project paths)`,
              ]
            : []),
          `${status} in ${(result.durationMs / 1000).toFixed(1)}s`,
          '--- output ---',
          text || '(no output)',
          ...(locations.length
            ? [
                '--- project locations referenced in the output ---',
                locations.join('\n'),
                'Read these before changing code.',
              ]
            : []),
        ].join('\n');
        return {
          content,
          summary: `${status} (${(result.durationMs / 1000).toFixed(1)}s)`,
          truncated: clipped || result.omittedBytes > 0,
        };
      },
    };
  },
});
