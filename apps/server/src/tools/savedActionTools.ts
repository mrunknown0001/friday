import type { ApprovalDetails, RiskLevel, SavedActionDto, SshHostDto } from '@friday/shared';
import { z } from 'zod';
import { assessCommand } from '../commands/risk.js';
import type { RunResult } from '../commands/runner.js';
import { hostPaths } from '../sandbox/docker.js';
import { explainSshFailure } from '../ssh/ssh.js';
import { WorkspaceError } from '../workspace/paths.js';
import { clipOutput, prepareCommand, runPrepared } from './commandTool.js';
import { atLeast, hostFingerprint, PRODUCTION_TTL_MS } from './devopsTools.js';
import { defineTool, type Proposal, type ToolContext } from './types.js';

/**
 * Saved actions (runbooks): procedures the user defined once in Project settings, such as
 * "deploy staging". The model can list them and ask to run one by name; it cannot change a step,
 * a command or where it runs. One approval covers a run and shows every step exactly.
 */

type Details = Extract<ApprovalDetails, { kind: 'saved_action' }>;

function actionsOf(ctx: ToolContext): SavedActionDto[] {
  if (!ctx.project)
    throw new WorkspaceError('unsupported', 'This conversation is not attached to a project.');
  if (!ctx.savedActions)
    throw new WorkspaceError('unsupported', 'Saved actions are not available here.');
  return ctx.savedActions.list(ctx.project);
}

const whereText = (step: SavedActionDto['steps'][number], hosts: Map<string, SshHostDto>) =>
  step.target.kind === 'local'
    ? `this machine, in ${step.target.cwd === '.' ? 'the project root' : step.target.cwd}`
    : (() => {
        const h = hosts.get(step.target.hostId);
        return h ? `${h.name} (${h.environment})` : 'a removed SSH host';
      })();

export const listSavedActions = defineTool({
  name: 'list_saved_actions',
  description:
    'List this project\'s saved actions: procedures the user defined once (such as "deploy staging"), each with its steps, where they run and the declared risk. Read-only. Run one with run_saved_action when the user asks for it.',
  category: 'read_only',
  risk: 'none',
  requiresProject: true,
  schema: z.object({}),
  describeCall: () => 'saved actions',
  async execute(_args, ctx) {
    const actions = actionsOf(ctx);
    if (!actions.length)
      return {
        content:
          'This project has no saved actions. The user can define them in Project settings › Saved actions; you cannot create them.',
        summary: 'none',
      };
    const hosts = new Map((ctx.devops?.hosts.list() ?? []).map((h) => [h.id, h]));
    const lines: string[] = [];
    for (const a of actions) {
      lines.push(`"${a.name}" (risk ${a.risk})${a.description ? `: ${a.description}` : ''}`);
      a.steps.forEach((s, i) =>
        lines.push(
          `  ${i + 1}. ${s.title} [${whereText(s, hosts)}]: ${s.command.split('\n')[0]}${s.command.includes('\n') ? ' …' : ''}`,
        ),
      );
    }
    return {
      content: `${lines.join('\n')}\n\nRun one with run_saved_action (by name). Its steps are fixed; to change them the user edits the action.`,
      summary: `${actions.length} action${actions.length === 1 ? '' : 's'}`,
    };
  },
});

interface Planned {
  step: SavedActionDto['steps'][number];
  local?: Awaited<ReturnType<typeof prepareCommand>>;
  host?: SshHostDto;
}

const okResult = (r: RunResult) => !r.timedOut && !r.cancelled && r.exitCode === 0;

export const runSavedAction = defineTool({
  name: 'run_saved_action',
  description:
    "Run one of the project's saved actions (see list_saved_actions) by name, when the user asks for it. One approval shows every step exactly: its command and where it runs (this machine, or an SSH host). Steps run in order; the run stops at the first failing step unless the user marked that step to continue. You cannot change the steps or pass arguments.",
  category: 'shell',
  risk: 'high',
  requiresProject: true,
  schema: z.object({
    name: z.string().trim().min(1).max(60),
    reason: z.string().min(3).max(500).describe('Why it is run now. Shown to the user.'),
  }),
  describeCall: (a) => a.name,
  async prepare(args, ctx): Promise<Proposal> {
    const actions = actionsOf(ctx);
    const action = actions.find((a) => a.name.toLowerCase() === args.name.toLowerCase());
    if (!action)
      throw new WorkspaceError(
        'not_found',
        actions.length
          ? `No saved action named "${args.name}". This project has: ${actions.map((a) => `"${a.name}"`).join(', ')}.`
          : 'This project has no saved actions. The user can define them in Project settings › Saved actions.',
      );

    let risk: RiskLevel = action.risk;
    const planned: Planned[] = [];
    const steps: Details['steps'] = [];
    const prints: string[] = [`${action.id}|${action.updatedAt}|${JSON.stringify(action.steps)}`];
    for (const [i, step] of action.steps.entries()) {
      const label = `Step ${i + 1} ("${step.title}")`;
      if (step.target.kind === 'local') {
        const local = await prepareCommand(
          { shell_command: step.command, cwd: step.target.cwd },
          ctx,
        );
        risk = atLeast(risk, local.assessment.risk);
        planned.push({ step, local });
        steps.push({
          title: step.title,
          command: step.command,
          timeoutSeconds: step.timeoutSeconds,
          continueOnError: step.continueOnError,
          riskReasons: local.assessment.reasons.filter((r) => r !== 'Runs through /bin/sh.'),
          where: {
            kind: 'local',
            cwd: local.cwd.rel,
            sandbox: local.sandbox
              ? { image: local.sandbox.image, network: local.sandbox.network }
              : null,
          },
        });
        prints.push(
          `local:${local.cwd.abs}|${local.sandbox ? JSON.stringify(local.sandbox) : 'off'}`,
        );
      } else {
        const host = ctx.devops?.hosts.get(step.target.hostId);
        if (!host)
          throw new WorkspaceError(
            'not_found',
            `${label} uses an SSH host that was removed. Ask the user to fix the action in Project settings.`,
          );
        if (!host.trustedFingerprints.length)
          throw new WorkspaceError(
            'unsupported',
            `${label} runs on ${host.name}, whose host key is not trusted yet. The user can trust it in Settings › DevOps.`,
          );
        const assessed = assessCommand(null, step.command);
        risk = atLeast(
          risk,
          host.environment === 'production'
            ? atLeast(assessed.risk, 'high')
            : host.environment === 'staging'
              ? atLeast(assessed.risk, 'medium')
              : assessed.risk,
        );
        planned.push({ step, host });
        steps.push({
          title: step.title,
          command: step.command,
          timeoutSeconds: step.timeoutSeconds,
          continueOnError: step.continueOnError,
          riskReasons: assessed.reasons.filter((r) => r !== 'Runs through /bin/sh.'),
          where: {
            kind: 'ssh',
            host: {
              name: host.name,
              hostname: host.hostname,
              port: host.port,
              username: host.username,
              environment: host.environment,
            },
          },
        });
        prints.push(`ssh:${hostFingerprint(host)}`);
      }
    }
    const productionHosts = [
      ...new Set(
        planned.filter((p) => p.host?.environment === 'production').map((p) => p.host!.name),
      ),
    ];
    const remoteHosts = [...new Set(planned.filter((p) => p.host).map((p) => p.host!.name))];
    const localCount = planned.filter((p) => p.local).length;
    const where = [
      localCount ? `${localCount} on this machine` : null,
      remoteHosts.length ? `${planned.length - localCount} on ${remoteHosts.join(', ')}` : null,
    ]
      .filter(Boolean)
      .join(' and ');
    const details: Details = {
      kind: 'saved_action',
      action: {
        id: action.id,
        name: action.name,
        description: action.description,
        risk: action.risk,
      },
      steps,
      productionHosts,
    };

    return {
      title: `${productionHosts.length ? 'PRODUCTION · ' : ''}Run saved action "${action.name}"`,
      summary: `Runs ${planned.length} step${planned.length === 1 ? '' : 's'} (${where}) in order, stopping at the first failing step${action.steps.some((s) => s.continueOnError) ? ' unless it is marked to continue' : ''}.`,
      category: productionHosts.length ? 'deployment' : remoteHosts.length ? 'remote' : 'shell',
      risk,
      details,
      fingerprint: prints.join('\n'),
      timeoutMs: action.steps.reduce((t, s) => t + (s.timeoutSeconds + 15) * 1000, 0),
      ...(productionHosts.length
        ? { confirmationRequired: productionHosts.join(', '), approvalTtlMs: PRODUCTION_TTL_MS }
        : {}),
      async apply(execCtx) {
        const results: string[] = [];
        let succeeded = 0;
        let stoppedAt: number | null = null;
        const budget = Math.max(600, Math.floor((execCtx.maxOutputChars - 1_000) / planned.length));
        for (const [i, p] of planned.entries()) {
          if (execCtx.signal.aborted) {
            stoppedAt = i;
            break;
          }
          const n = `${i + 1}/${planned.length}`;
          execCtx.emitOutput?.(
            `${i ? '\n' : ''}▶ Step ${n}: ${p.step.title}\n$ ${p.step.command}\n`,
          );
          let ok: boolean;
          let status: string;
          let output: string;
          let ms: number;
          if (p.local) {
            const r = await runPrepared(p.local, p.step.timeoutSeconds, execCtx);
            ok = okResult(r);
            status = r.timedOut
              ? `timed out after ${p.step.timeoutSeconds}s (killed)`
              : r.cancelled
                ? 'cancelled'
                : r.signal
                  ? `killed by ${r.signal}`
                  : `exit code ${r.exitCode}`;
            output = p.local.sandbox ? hostPaths(r.output, p.local.root) : r.output;
            ms = r.durationMs;
          } else {
            const r = await execCtx.devops!.ssh.run(p.host!, p.step.command, {
              timeoutMs: p.step.timeoutSeconds * 1000,
              signal: execCtx.signal,
              ...(execCtx.emitOutput ? { onOutput: execCtx.emitOutput } : {}),
            });
            if (r.spawnError) throw new WorkspaceError('unsupported', r.spawnError);
            ok = okResult(r);
            status = r.timedOut
              ? `timed out after ${p.step.timeoutSeconds}s (ssh killed; the remote command may still be running)`
              : r.cancelled
                ? 'cancelled (ssh killed; the remote command may still be running)'
                : r.exitCode === 255
                  ? `ssh error: ${explainSshFailure(r.output)}`
                  : `exit code ${r.exitCode}`;
            output = r.output;
            ms = r.durationMs;
          }
          if (ok) succeeded++;
          const where = p.local
            ? `this machine, ${p.local.cwd.rel}`
            : `${p.host!.name} (${p.host!.environment})`;
          results.push(
            `Step ${n} ${ok ? 'OK' : 'FAILED'}: ${p.step.title} [${where}]: ${status} in ${(ms / 1000).toFixed(1)}s`,
            `$ ${p.step.command}`,
            clipOutput(output.trim(), budget).text || '(no output)',
            '',
          );
          if (!ok && !p.step.continueOnError) {
            stoppedAt = i + 1;
            break;
          }
        }
        const total = planned.length;
        const notRun = stoppedAt === null ? 0 : total - stoppedAt;
        const head =
          succeeded === total
            ? `Saved action "${action.name}": ${total === 1 ? 'the step' : `all ${total} steps`} succeeded.`
            : `Saved action "${action.name}": ${succeeded} of ${total} steps succeeded${notRun ? `; stopped, ${notRun} step${notRun === 1 ? '' : 's'} not run` : ''}.`;
        return {
          content: [head, '', ...results].join('\n').trimEnd(),
          summary:
            succeeded === total
              ? total === 1
                ? 'the step succeeded'
                : `all ${total} steps succeeded`
              : `${succeeded}/${total} steps succeeded${notRun ? `, ${notRun} not run` : ''}`,
        };
      },
    };
  },
});
