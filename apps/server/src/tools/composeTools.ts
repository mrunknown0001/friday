import fs from 'node:fs/promises';
import type { ApprovalDetails, RiskLevel } from '@friday/shared';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import {
  assertNoForeign,
  composeBase,
  docker,
  existingVolumes,
  firstError,
  imagePresent,
  listContainers,
  loadComposeProject,
  SERVICE_NAME,
  serviceStatus,
  statusLines,
  unknownServices,
  verdict,
  withDependencies,
  type ComposeProject,
} from '../compose/compose.js';
import { runProcess } from '../commands/runner.js';
import { assertRootAvailable, WorkspaceError } from '../workspace/paths.js';
import { clipOutput } from './commandTool.js';
import { atLeast, checkCompose, PRODUCTION_TTL_MS } from './devopsTools.js';
import { defineTool, type Proposal, type ToolContext } from './types.js';

/**
 * Docker Compose control for the project's own compose file: status and logs freely, and
 * up/start/stop/restart/down with approval. Images are never pulled or built unless asked for,
 * and volumes are removed only with a typed confirmation of the compose project name.
 */

type Details = Extract<ApprovalDetails, { kind: 'compose' }>;

const file = z
  .string()
  .max(512)
  .optional()
  .describe(
    'A compose file inside the project, e.g. "docker/compose.dev.yml". Omit for the default compose.yaml / docker-compose.yml in the project root (with its override file).',
  );
const services = z
  .array(z.string().regex(SERVICE_NAME, 'invalid service name'))
  .max(30)
  .optional()
  .describe('Services to act on. Omit for all services.');

async function projectOf(ctx: ToolContext, fileArg: string | undefined) {
  if (!ctx.project)
    throw new WorkspaceError('unsupported', 'Docker Compose needs a project attached.');
  await assertRootAvailable(ctx.project.rootPath);
  return loadComposeProject(ctx.project.rootPath, fileArg, ctx.signal);
}

function checkServices(p: ComposeProject, names: string[] | undefined) {
  const unknown = unknownServices(p, names ?? []);
  if (unknown.length)
    throw new WorkspaceError(
      'not_found',
      `Not a service of compose project "${p.name}": ${unknown.join(', ')}. Services: ${p.services.map((s) => s.name).join(', ') || '(none)'}.`,
    );
}

/** `docker compose` as shown to the model: file names relative to the project. */
const shown = (p: ComposeProject, args: string[]) =>
  `docker compose ${p.files.map((f) => `-f ${f}`).join(' ')} -p ${p.name} ${args.join(' ')}`;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export const composeStatus = defineTool({
  name: 'compose_status',
  description:
    'Read-only status of the project\'s Docker Compose services. view "status" (default): every service with its image, state, health check result, restarts and whether its published ports accept connections. view "logs": the last lines of the services\' logs (redacted). Only this project\'s own containers are shown.',
  category: 'read_only',
  risk: 'none',
  requiresProject: true,
  schema: z.object({
    view: z.enum(['status', 'logs']).default('status'),
    file,
    services,
    tail: z.number().int().min(1).max(1_000).default(100),
    since: z
      .string()
      .regex(/^\d{1,4}[smh]$/, 'like "10m", "30s" or "2h"')
      .optional()
      .describe('Logs only: just lines newer than this, e.g. "10m".'),
  }),
  describeCall: (a) => `${a.view}${a.services?.length ? ` ${a.services.join(', ')}` : ''}`,
  async execute(args, ctx) {
    const p = await projectOf(ctx, args.file);
    checkServices(p, args.services);
    const containers = await listContainers(p, ctx.signal);
    const head = `Compose project "${p.name}" (${p.files.join(' + ')})`;

    if (args.view === 'logs') {
      assertNoForeign(p, containers);
      if (!containers.ours.length)
        return { content: `${head}: no containers yet.`, summary: 'no containers' };
      const r = await docker(
        [
          ...composeBase(p),
          'logs',
          '--no-color',
          '--timestamps',
          '--tail',
          String(args.tail),
          ...(args.since ? ['--since', args.since] : []),
          '--',
          ...(args.services ?? []),
        ],
        { cwd: p.dir, timeoutMs: 30_000, signal: ctx.signal },
      );
      if (r.code !== 0)
        throw new WorkspaceError(
          'unsupported',
          `docker compose logs failed: ${firstError(r.stderr)}`,
        );
      const out = `${r.stdout}${r.stderr}`.trim();
      return {
        content: `${head}, logs:\n${out || '(no log output)'}`,
        summary: `${out ? out.split('\n').length : 0} lines`,
      };
    }

    const names = args.services?.length ? args.services : p.services.map((s) => s.name);
    const rows = await serviceStatus(p, containers, names);
    const lines = statusLines(rows).map((line, i) => {
      const svc = p.services.find((s) => s.name === rows[i]!.service)!;
      const facts = [
        svc.image,
        svc.healthcheck ? 'has a health check' : 'no health check',
        // Live ports are probed below; otherwise say where it would publish.
        ...(rows[i]!.ports.length || !svc.ports.length
          ? []
          : [`publishes ${svc.ports.join(', ')}`]),
      ];
      const label = `${svc.name} (${facts.join(', ')}):`;
      return label + line.slice(svc.name.length + 1);
    });
    const known = new Set(p.services.map((s) => s.name));
    const orphans = containers.ours.filter((c) => !known.has(c.service) && !c.oneoff);
    if (orphans.length)
      lines.push(
        `Containers of services no longer in the compose file: ${orphans.map((c) => `${c.name} (${c.state})`).join(', ')}.`,
      );
    if (containers.foreign.length)
      lines.push(
        `Warning: ${plural(containers.foreign.length, 'container')} with the same project name came from another compose file (${containers.foreign[0]!.files}); they are not shown and Friday will not control this project until the names differ.`,
      );
    const count = (v: string) => rows.filter((r) => r.verdict === v).length;
    const failed = count('failed');
    const up = count('ok');
    const down = rows.length - up - failed - count('starting') - count('completed');
    return {
      content: `${head}:\n${lines.join('\n')}`,
      summary: [
        `${up}/${rows.length} up`,
        failed ? `${failed} failing` : null,
        count('starting') ? `${count('starting')} starting` : null,
        down ? `${down} not running` : null,
      ]
        .filter(Boolean)
        .join(', '),
    };
  },
});

const SETTLED = new Set(['ok', 'completed', 'failed']);
const HOST_ACCESS = /privileged|host networking|Docker socket/;

/** Risky settings in the compose files themselves (warnings only; compose already validated it). */
async function fileWarnings(p: ComposeProject): Promise<string[]> {
  const out: string[] = [];
  for (const f of p.abs) {
    const text = await fs.readFile(f, 'utf8').catch(() => '');
    if (!text || text.length > 1_000_000) continue;
    for (const finding of checkCompose(parseDocument(text)))
      if (finding.level === 'warning' && !out.includes(finding.message)) out.push(finding.message);
  }
  return out;
}

const BASE_RISK: Record<Details['action'], RiskLevel> = {
  start: 'low',
  stop: 'medium',
  restart: 'medium',
  up: 'medium',
  down: 'high',
};

export const composeControl = defineTool({
  name: 'compose_control',
  description:
    'Change the state of the project\'s Docker Compose services, with approval: "up" (create/start in the background, recreating containers whose configuration changed; starts dependencies too), "start", "stop", "restart", or "down" (stop and remove the containers and networks). Only this project\'s own containers are touched. Images are not pulled or built unless you set pull or build (use them only when the user wants new images). removeVolumes deletes the project\'s volumes and their data: use it only when the user explicitly asks; they must type the project name to approve. After up/start/restart Friday waits for the services to be running and healthy, then reports each one.',
  category: 'shell',
  risk: 'medium',
  requiresProject: true,
  schema: z.object({
    action: z.enum(['up', 'start', 'stop', 'restart', 'down']),
    file,
    services,
    pull: z
      .enum(['never', 'missing', 'always'])
      .default('never')
      .describe(
        'up only: pull images from their registry ("missing": only images not on this machine).',
      ),
    build: z
      .boolean()
      .default(false)
      .describe('up only: build the services that have a build section.'),
    removeVolumes: z
      .boolean()
      .default(false)
      .describe(
        'down only, whole project: also delete its volumes (data loss). Only when the user explicitly asks.',
      ),
    waitSeconds: z.number().int().min(0).max(300).default(60),
    reason: z.string().min(3).max(500).describe('Why this is needed. Shown to the user.'),
  }),
  describeCall: (a) =>
    `${a.action}${a.services?.length ? ` ${a.services.join(', ')}` : ''}${a.removeVolumes ? ' (remove volumes)' : ''}`,
  async prepare(args, ctx): Promise<Proposal> {
    if (args.action !== 'up' && (args.pull !== 'never' || args.build))
      throw new WorkspaceError('invalid_path', 'pull and build only apply to action "up".');
    if (args.removeVolumes && args.action !== 'down')
      throw new WorkspaceError('invalid_path', 'removeVolumes only applies to action "down".');
    if (args.removeVolumes && args.services?.length)
      throw new WorkspaceError(
        'invalid_path',
        'removeVolumes applies to the whole project; leave services out.',
      );

    const p = await projectOf(ctx, args.file);
    if (!p.services.length)
      throw new WorkspaceError('unsupported', `Compose project "${p.name}" has no services.`);
    checkServices(p, args.services);
    const containers = await listContainers(p, ctx.signal);
    assertNoForeign(p, containers);

    const requested = args.services?.length ? [...new Set(args.services)] : [];
    const affected =
      args.action === 'up'
        ? withDependencies(p, requested.length ? requested : p.services.map((s) => s.name))
        : requested.length
          ? requested
          : p.services.map((s) => s.name);

    if (args.action === 'up') {
      const missing: string[] = [];
      for (const name of affected) {
        const svc = p.services.find((s) => s.name === name)!;
        if (svc.build && args.build) continue;
        if (svc.declaredImage && args.pull !== 'never') continue;
        if (!(await imagePresent(svc.image, ctx.signal)))
          missing.push(`${name} (${svc.image}${svc.build ? ', has a build section' : ''})`);
      }
      if (missing.length)
        throw new WorkspaceError(
          'unsupported',
          `Not on this machine: ${missing.join(', ')}. Friday does not pull or build images unless asked; if the user wants that, propose again with pull: "missing" or build: true.`,
        );
    }

    const starts = ['up', 'start', 'restart'].includes(args.action);
    const riskReasons: string[] = [];
    let risk = BASE_RISK[args.action];
    if (args.action === 'up')
      riskReasons.push('Recreates containers whose configuration or image changed.');
    if (args.action === 'down')
      riskReasons.push('Removes the containers; data not kept in a volume is lost.');
    if (args.pull !== 'never') {
      risk = atLeast(risk, 'medium');
      riskReasons.push(
        args.pull === 'always'
          ? 'Pulls every image from its registry (may change versions).'
          : 'Pulls images that are not on this machine yet.',
      );
    }
    if (args.build) {
      risk = atLeast(risk, 'high');
      riskReasons.push('Builds images: the Dockerfile steps run, and base images may be pulled.');
    }
    const warnings = await fileWarnings(p);
    if (starts && warnings.some((w) => HOST_ACCESS.test(w))) {
      risk = atLeast(risk, 'high');
      riskReasons.push('A service gets broad access to this machine (see the warnings).');
    }

    let volumes: Details['volumes'] = [];
    const ours = containers.ours;
    const anonymousVolumes = args.removeVolumes
      ? ours.reduce((t, c) => t + c.anonymousVolumes, 0)
      : 0;
    if (args.removeVolumes) {
      const present = await existingVolumes(ctx.signal);
      volumes = p.volumes.map((name) => ({ name, exists: present.has(name) }));
      risk = 'critical';
      riskReasons.push(
        "Deletes the project's volumes and all data in them. This cannot be undone.",
      );
    }

    const sub: string[] =
      args.action === 'up'
        ? ['up', '--detach', '--pull', args.pull, args.build ? '--build' : '--no-build']
        : args.action === 'down'
          ? ['down', ...(args.removeVolumes ? ['--volumes'] : [])]
          : [args.action];
    const tail = [...sub, ...(requested.length ? ['--', ...requested] : [])];
    const argv = ['docker', ...composeBase(p), ...tail];
    const waits = starts ? args.waitSeconds : 0;

    const details: Details = {
      kind: 'compose',
      action: args.action,
      project: p.name,
      files: p.files,
      argv,
      services: affected.map((name) => {
        const svc = p.services.find((s) => s.name === name)!;
        return {
          name,
          image: svc.image,
          build: svc.build,
          ports: svc.ports,
          state: verdict(ours.filter((c) => c.service === name && !c.oneoff)).text,
          dependency: !!requested.length && !requested.includes(name),
        };
      }),
      pull: args.pull,
      build: args.build,
      removeVolumes: args.removeVolumes,
      volumes,
      anonymousVolumes,
      warnings,
      riskReasons,
      waitSeconds: waits,
    };

    const what = requested.length ? requested.join(', ') : 'all services';
    const verb: Record<Details['action'], string> = {
      up: 'Start',
      start: 'Start',
      stop: 'Stop',
      restart: 'Restart',
      down: 'Remove',
    };
    const deps = affected.length - (requested.length || affected.length);
    return {
      title: `${args.removeVolumes ? 'DELETE VOLUMES · ' : ''}docker compose ${args.action} (${p.name})`,
      summary: `${verb[args.action]} ${what}${deps > 0 ? ` and ${plural(deps, 'dependency')}` : ''} of compose project "${p.name}"${args.removeVolumes ? `, deleting ${plural(volumes.length, 'named volume')}${anonymousVolumes ? ` and ${plural(anonymousVolumes, 'anonymous volume')}` : ''}` : ''}.`,
      category: 'shell',
      risk,
      details,
      fingerprint: [
        p.configHash,
        argv.join('\0'),
        ours
          .map((c) => c.id)
          .sort()
          .join(','),
        volumes.map((v) => `${v.name}:${v.exists}`).join(','),
      ].join('\n'),
      timeoutMs: (args.build ? 30 * 60 : 10 * 60) * 1000 + waits * 1000,
      ...(args.removeVolumes
        ? { confirmationRequired: p.name, approvalTtlMs: PRODUCTION_TTL_MS }
        : {}),
      async apply(execCtx) {
        execCtx.emitOutput?.(`$ ${shown(p, tail)}\n`);
        const r = await runProcess({
          argv,
          shellCommand: null,
          cwd: p.dir,
          timeoutMs: (args.build ? 30 * 60 : 10 * 60) * 1000,
          signal: execCtx.signal,
          ...(execCtx.emitOutput ? { onOutput: execCtx.emitOutput } : {}),
        });
        if (r.spawnError) throw new WorkspaceError('unsupported', r.spawnError);
        const ok = !r.timedOut && !r.cancelled && r.exitCode === 0;
        const status = r.timedOut
          ? 'timed out (killed)'
          : r.cancelled
            ? 'cancelled'
            : `exit code ${r.exitCode}`;

        // Wait for the services to settle: running (and healthy when they have a check), or done.
        let after = await listContainers(p, execCtx.signal);
        const started = Date.now();
        if (ok && waits) {
          execCtx.emitOutput?.(
            `\nWaiting up to ${waits}s for the services to be running and healthy…\n`,
          );
          for (;;) {
            const rows = await serviceStatus(p, after, affected, false);
            if (rows.every((x) => SETTLED.has(x.verdict))) break;
            if (Date.now() - started > waits * 1000 || execCtx.signal.aborted) break;
            await new Promise((res) => setTimeout(res, 1_000));
            after = await listContainers(p, execCtx.signal);
          }
        }
        const rows = args.action === 'down' ? [] : await serviceStatus(p, after, affected, true);
        const waited = Math.round((Date.now() - started) / 1000);
        const failing = rows.filter((x) => x.verdict !== 'ok' && x.verdict !== 'completed');

        const output = dedupeProgress(r.output).trim();
        const lines = [
          `docker compose ${args.action} ${ok ? 'succeeded' : 'FAILED'} (${status}) in ${(r.durationMs / 1000).toFixed(1)}s.`,
          `$ ${shown(p, tail)}`,
          clipOutput(output, Math.max(2_000, execCtx.maxOutputChars - 4_000)).text || '(no output)',
        ];
        if (args.action === 'down') {
          const left = after.ours.filter((c) => affected.includes(c.service));
          lines.push(
            '',
            left.length
              ? `Still present: ${left.map((c) => `${c.name} (${c.state})`).join(', ')}.`
              : `No containers left for ${what}.`,
          );
        } else {
          lines.push(
            '',
            `Services${waits && ok ? ` after ${waited}s` : ''}:`,
            ...statusLines(rows),
          );
          if (ok && starts && failing.length)
            lines.push(
              '',
              `Not healthy yet: ${failing.map((x) => x.service).join(', ')}. Check compose_status (view "logs") before reporting success.`,
            );
        }
        return {
          content: lines.join('\n'),
          summary: !ok
            ? `failed (${status})`
            : !starts
              ? args.action === 'down'
                ? 'removed'
                : 'stopped'
              : failing.length
                ? `${rows.length - failing.length}/${rows.length} healthy`
                : `${plural(rows.length, 'service')} up`,
        };
      },
    };
  },
});

/** Plain progress output repeats lines (" Container x Started"); keep the first of each. */
export function dedupeProgress(output: string): string {
  const seen = new Set<string>();
  return output
    .split('\n')
    .filter((l) => {
      if (!/^ ?(Container|Network|Volume|Image) /.test(l)) return true;
      if (seen.has(l)) return false;
      seen.add(l);
      return true;
    })
    .join('\n');
}
