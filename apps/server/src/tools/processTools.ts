import path from 'node:path';
import type { ProcessDto } from '@friday/shared';
import { z } from 'zod';
import { extractLocations } from '../commands/locations.js';
import { PROCESS_ID, type ProcessManager, type WaitResult } from '../processes/manager.js';
import { WorkspaceError } from '../workspace/paths.js';
import { clipOutput, prepareCommand, sandboxRun } from './commandTool.js';
import { defineTool, type Proposal, type ToolContext } from './types.js';

function manager(ctx: ToolContext): ProcessManager {
  if (!ctx.processes)
    throw new WorkspaceError('unsupported', 'Background processes are not available here.');
  return ctx.processes;
}

/** A process of this conversation's project (ids of other projects are treated as unknown). */
function ownProcess(ctx: ToolContext, id: string): ProcessDto {
  const p = manager(ctx).get(id);
  if (!p || p.projectId !== ctx.project?.id)
    throw new WorkspaceError(
      'not_found',
      `No background process "${id}" in this project. Use list_processes to see them.`,
    );
  return p;
}

function describeStatus(p: ProcessDto): string {
  if (p.error) return `failed to start: ${p.error}`;
  if (p.status === 'running') return 'running';
  if (p.status === 'stopping') return 'stopping';
  const how = p.signal ? `killed by ${p.signal}` : `exit code ${p.exitCode}`;
  return p.status === 'stopped'
    ? `stopped by ${p.stoppedBy} (${how})`
    : `exited by itself (${how})`;
}

function processLine(p: ProcessDto): string {
  return [
    `${p.id} "${p.name}": ${describeStatus(p)}`,
    `  $ ${p.command}  (cwd: ${p.cwd}${p.sandbox ? `, container ${p.sandbox.image}` : ''})`,
    ...(p.urls.length ? [`  urls: ${p.urls.join(' ')}`] : []),
    `  started ${p.startedAt}${p.endedAt ? `, ended ${p.endedAt}` : ''}`,
  ].join('\n');
}

const MAX_WAIT_SECONDS = 120;

export const startProcess = defineTool({
  name: 'start_process',
  description:
    'Start a long-running command in the background: a dev server, a file watcher, a test runner in watch mode, a local queue worker. Use run_command instead for anything that finishes by itself (tests, builds, installs). Prefer the project\'s own script (e.g. its package.json "dev" script via npm run dev) and read it first; never guess entry files. Needs the user\'s approval, like run_command. It keeps running after this call returns, until it is stopped (stop_process, the user, or Friday quitting). The call waits up to wait_seconds for `ready_text` to appear in the output (or, without it, for a local URL such as http://localhost:5173) and returns the output so far. Never background commands with "&" or nohup in run_command; use this. If the project runs commands in a container, a server is only reachable from this machine through `ports` (published on 127.0.0.1; the project sandbox must allow network), and it must listen on 0.0.0.0 inside the container.',
  category: 'shell',
  risk: 'medium',
  requiresProject: true,
  schema: z
    .object({
      name: z
        .string()
        .trim()
        .min(1)
        .max(60)
        .describe('Short name shown to the user, e.g. "dev server" or "tsc watch".'),
      argv: z
        .array(z.string().max(4_000))
        .min(1)
        .max(100)
        .optional()
        .describe('Program and arguments, e.g. ["npm", "run", "dev"]. No shell interpretation.'),
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
      ready_text: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe('Text in the output that means "ready", e.g. "Compiled successfully".'),
      wait_seconds: z.number().int().min(1).max(MAX_WAIT_SECONDS).default(20),
      ports: z
        .array(z.number().int().min(1024).max(65535))
        .max(3)
        .optional()
        .describe(
          'Sandboxed projects only: container ports to publish on 127.0.0.1. Ignored when commands run on this machine.',
        ),
      reason: z.string().min(3).max(500).describe('Why this is needed. Shown to the user.'),
    })
    .refine((a) => (a.argv === undefined) !== (a.shell_command === undefined), {
      message: 'Provide exactly one of argv or shell_command.',
    }),
  describeCall: (a) =>
    `${a.name}: ${(a.argv ? a.argv.join(' ') : (a.shell_command ?? '')).slice(0, 100)}`,
  async prepare(args, ctx): Promise<Proposal> {
    const pm = manager(ctx);
    const { root, cwd, argv, shellCommand, shown, assessment, sandbox, gitDir, details } =
      await prepareCommand(args, ctx);
    const projectId = ctx.project!.id;
    const twin = pm.findRunning(projectId, shown, cwd.rel);
    if (twin)
      throw new WorkspaceError(
        'unsupported',
        `This command is already running as ${twin.id} "${twin.name}". Read its output with read_process_output, or stop it first to restart it.`,
      );
    pm.assertCanStart(projectId);
    const ports = sandbox ? [...new Set(args.ports ?? [])].sort((a, b) => a - b) : [];
    if (ports.length && sandbox?.network === 'none')
      throw new WorkspaceError(
        'unsupported',
        "This project's sandbox has no network, so no ports can be published. Start it without ports (e.g. a watcher), or ask the user to allow network in Project settings › Command sandbox.",
      );
    const where = sandbox
      ? `in a ${sandbox.network === 'none' ? 'network-less ' : ''}container (${sandbox.image})${ports.length ? `, publishing port${ports.length > 1 ? 's' : ''} ${ports.join(', ')} on 127.0.0.1` : ''}`
      : 'on this machine, as your user';

    return {
      title: `Start in background: ${shown.length > 70 ? `${shown.slice(0, 70)}…` : shown}`,
      summary: `Starts "${args.name}" ${argv ? '(a program run directly, no shell)' : 'with /bin/sh'} in ${cwd.rel === '.' ? 'the project root' : cwd.rel} ${where}. It keeps running in the background until you stop it or Friday quits.`,
      category: 'shell',
      risk: assessment.risk,
      details: {
        ...details,
        sandbox: details.sandbox ? { ...details.sandbox, ports } : null,
        background: { name: args.name },
      },
      fingerprint: `background|cwd:${cwd.abs}|sandbox:${sandbox ? JSON.stringify(sandbox) : 'off'}|ports:${ports.join(',')}`,
      timeoutMs: (args.wait_seconds + 30) * 1000,
      async apply(execCtx) {
        const pm = manager(execCtx);
        const started = pm.start({
          projectId,
          sessionId: execCtx.sessionId,
          name: args.name,
          command: shown,
          root,
          cwdRel: cwd.rel,
          cwdAbs: cwd.abs,
          argv,
          shellCommand,
          sandbox: sandbox
            ? await sandboxRun(
                root,
                cwd.rel,
                sandbox,
                { argv, shellCommand },
                gitDir,
                execCtx.env.sandboxInstance,
                ports,
              )
            : null,
        });
        const waited: WaitResult = await pm.waitFor(started.id, {
          ...(args.ready_text ? { readyText: args.ready_text } : {}),
          timeoutMs: args.wait_seconds * 1000,
          signal: execCtx.signal,
        });
        // The run was cancelled while waiting: the user no longer wants this started.
        if (waited === 'cancelled') await pm.stop(started.id, 'friday');
        const out = pm.read(started.id, { tailLines: 80 })!;
        const p = out.process;
        if (p.error) throw new WorkspaceError('unsupported', p.error);
        const state =
          waited === 'ready'
            ? 'running and ready'
            : waited === 'timeout'
              ? `still running after ${args.wait_seconds}s (${args.ready_text ? `"${args.ready_text}"` : 'a local URL'} not seen yet; it may still be starting)`
              : describeStatus(p);
        const { text, clipped } = clipOutput(out.output, execCtx.maxOutputChars - 800);
        const locations = p.status === 'running' ? [] : extractLocations(out.output, root, cwd.abs);
        const content = [
          `${p.id} "${p.name}": ${state}`,
          `$ ${shown}`,
          `cwd: ${cwd.rel}${p.sandbox ? `; container ${p.sandbox.image}, network ${p.sandbox.network}${ports.length ? `, ports ${ports.join(', ')} on 127.0.0.1` : ''}` : ''}`,
          ...(p.urls.length ? [`urls: ${p.urls.join(' ')}`] : []),
          `--- output so far${out.dropped ? ' (latest lines)' : ''} ---`,
          text || '(no output yet)',
          ...(locations.length
            ? ['--- project locations referenced in the output ---', locations.join('\n')]
            : []),
          '---',
          p.status === 'running'
            ? `It keeps running in the background. Check on it with read_process_output (id "${p.id}", since ${out.cursor} for only newer output); stop it with stop_process.`
            : 'It is no longer running. Fix the cause before starting it again.',
        ].join('\n');
        return {
          content,
          summary:
            p.status === 'running'
              ? `${p.id} running${p.urls[0] ? ` at ${p.urls[0]}` : ''}`
              : describeStatus(p),
          truncated: clipped,
        };
      },
    };
  },
});

export const listProcesses = defineTool({
  name: 'list_processes',
  description:
    "List this project's background processes started with start_process (running ones and recently finished ones): id, status, command and local URLs.",
  category: 'read_only',
  risk: 'none',
  requiresProject: true,
  schema: z.object({}),
  describeCall: () => '',
  async execute(_args, ctx) {
    const list = manager(ctx).list(ctx.project!.id);
    const running = list.filter((p) => p.status === 'running').length;
    return {
      content: list.length
        ? list.map(processLine).join('\n')
        : 'No background processes in this project.',
      summary: `${running} running, ${list.length - running} finished`,
    };
  },
});

export const readProcessOutput = defineTool({
  name: 'read_process_output',
  description:
    'Read the recent output and status of a background process from start_process (e.g. to check a dev server for compile errors after an edit). Pass `since` (the cursor from an earlier read) to get only newer output. Only the most recent output is kept.',
  category: 'read_only',
  risk: 'none',
  requiresProject: true,
  schema: z.object({
    id: z.string().regex(PROCESS_ID, 'Expected an id like proc_1a2b3c4d.'),
    since: z.number().int().min(0).optional().describe('Cursor from an earlier read.'),
    tail_lines: z.number().int().min(1).max(400).default(80),
  }),
  describeCall: (a) => a.id,
  async execute(args, ctx) {
    ownProcess(ctx, args.id);
    const out = manager(ctx).read(args.id, {
      ...(args.since !== undefined ? { since: args.since } : {}),
      tailLines: args.tail_lines,
    })!;
    const p = out.process;
    const root = ctx.project!.rootPath;
    const { text, clipped } = clipOutput(out.output, ctx.maxOutputChars - 800);
    const locations = extractLocations(out.output, root, path.join(root, p.cwd));
    return {
      content: [
        processLine(p),
        `--- ${args.since !== undefined ? `output since ${args.since}` : `last ${args.tail_lines} lines`}${out.dropped ? ' (older output was discarded)' : ''} ---`,
        text || '(no new output)',
        ...(locations.length
          ? ['--- project locations referenced in the output ---', locations.join('\n')]
          : []),
        `--- cursor: ${out.cursor} (pass as since to read only newer output) ---`,
      ].join('\n'),
      summary: describeStatus(p),
      truncated: clipped,
    };
  },
});

export const stopProcess = defineTool({
  name: 'stop_process',
  description:
    'Stop a background process this project started with start_process (e.g. before restarting it with new settings). Stops the whole process group, or the container. Does not need approval: it only ends something the user already approved.',
  category: 'process_control',
  risk: 'low',
  requiresProject: true,
  schema: z.object({
    id: z.string().regex(PROCESS_ID, 'Expected an id like proc_1a2b3c4d.'),
    reason: z.string().min(3).max(300).describe('Why it is being stopped. Shown to the user.'),
  }),
  describeCall: (a) => a.id,
  async execute(args, ctx) {
    const before = ownProcess(ctx, args.id);
    if (before.status !== 'running' && before.status !== 'stopping')
      return { content: processLine(before), summary: `already ${describeStatus(before)}` };
    const p = (await manager(ctx).stop(args.id, 'friday'))!;
    const tail = manager(ctx).read(args.id, { tailLines: 15 })!;
    return {
      content: `${processLine(p)}\n--- last lines ---\n${tail.output || '(no output)'}`,
      summary: describeStatus(p),
    };
  },
});
