import fs from 'node:fs/promises';
import { z } from 'zod';
import { extractLocations } from '../commands/locations.js';
import { assessCommand } from '../commands/risk.js';
import { childEnv, runProcess } from '../commands/runner.js';
import { assertRootAvailable, resolveInside, WorkspaceError } from '../workspace/paths.js';
import { defineTool, type Proposal } from './types.js';

const MAX_TIMEOUT_SECONDS = 600;

/** Shell-style display of an argv, quoting only where needed. */
export function displayArgv(argv: string[]): string {
  return argv
    .map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`))
    .join(' ');
}

/** Keep the start and the end (where test summaries and errors usually are). */
function clipOutput(output: string, max: number): { text: string; clipped: boolean } {
  if (output.length <= max) return { text: output, clipped: false };
  const half = Math.floor(max / 2);
  return {
    text: `${output.slice(0, half)}\n[... ${output.length - max} characters omitted ...]\n${output.slice(-half)}`,
    clipped: true,
  };
}

export const runCommand = defineTool({
  name: 'run_command',
  description:
    "Run a command in the project (tests, builds, linters, diagnostics). Prefer `argv` (no shell). Use `shell_command` only when you need pipes, redirection or chaining. Every command requires the user's approval; they see the exact command, working directory and risk. Non-interactive: stdin is closed, CI=1 is set, and secrets are not passed in the environment.",
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
    const env = Object.keys(childEnv()).sort();

    return {
      title: `Run: ${shown.length > 80 ? `${shown.slice(0, 80)}…` : shown}`,
      summary: `Runs ${argv ? 'a program directly (no shell)' : 'a shell script with /bin/sh'} in ${cwd.rel === '.' ? 'the project root' : cwd.rel} on this machine, as your user, for up to ${args.timeout_seconds}s.`,
      category: 'shell',
      risk: assessment.risk,
      details: {
        kind: 'command',
        argv,
        shellCommand,
        shell: shellCommand !== null,
        cwd: cwd.rel,
        host: 'local',
        timeoutSeconds: args.timeout_seconds,
        env,
        network: assessment.network,
        riskReasons: assessment.reasons,
      },
      fingerprint: `cwd:${cwd.abs}`,
      timeoutMs: (args.timeout_seconds + 5) * 1000,
      async apply(execCtx) {
        const result = await runProcess({
          argv,
          shellCommand,
          cwd: cwd.abs,
          timeoutMs: args.timeout_seconds * 1000,
          signal: execCtx.signal,
          ...(execCtx.emitOutput ? { onOutput: execCtx.emitOutput } : {}),
        });
        if (result.spawnError) {
          throw new WorkspaceError('unsupported', result.spawnError);
        }
        const status = result.timedOut
          ? `timed out after ${args.timeout_seconds}s (process killed)`
          : result.cancelled
            ? 'cancelled (process killed)'
            : result.signal
              ? `killed by ${result.signal}`
              : `exit code ${result.exitCode}`;
        const { text, clipped } = clipOutput(result.output, execCtx.maxOutputChars - 400);
        const failed =
          result.timedOut || result.cancelled || result.signal !== null || result.exitCode !== 0;
        const locations = failed ? extractLocations(result.output, root, cwd.abs) : [];
        const content = [
          `$ ${shown}`,
          `cwd: ${cwd.rel}`,
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
