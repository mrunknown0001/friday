import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { HostEnvironment, RiskLevel, SshHostDto } from '@friday/shared';
import { parseDocument, isMap, isSeq, type Document } from 'yaml';
import { z } from 'zod';
import { assessCommand } from '../commands/risk.js';
import { childEnv } from '../commands/runner.js';
import { explainSshFailure, shellQuote } from '../ssh/ssh.js';
import { looksBinary, splitLines } from '../workspace/files.js';
import { findJsonError } from '../workspace/jsonCheck.js';
import { assertRootAvailable, resolveInside, WorkspaceError } from '../workspace/paths.js';
import { defineTool, type DevopsContext, type Proposal, type ToolContext } from './types.js';

const reason = z.string().min(3).max(500).describe('Why this is needed. Shown to the user.');

/**
 * Untrusted parsed JSON/YAML (docker inspect output, workflow and compose files). Accessed
 * defensively with optional chaining and type checks rather than validated up front.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

function devops(ctx: ToolContext): DevopsContext {
  if (!ctx.devops)
    throw new WorkspaceError('unsupported', 'DevOps tools are not available in this context.');
  return ctx.devops;
}

function exec(
  file: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; signal?: AbortSignal } = {},
) {
  return new Promise<{ code: number; stdout: string; stderr: string; missing: boolean }>(
    (resolve) => {
      execFile(
        file,
        args,
        {
          env: childEnv(),
          timeout: opts.timeoutMs ?? 15_000,
          maxBuffer: 4 * 1024 * 1024,
          ...(opts.cwd ? { cwd: opts.cwd } : {}),
          ...(opts.signal ? { signal: opts.signal } : {}),
        },
        (err, stdout, stderr) =>
          resolve({
            code: err
              ? typeof (err as { code?: unknown }).code === 'number'
                ? Number((err as { code: number }).code)
                : -1
              : 0,
            stdout,
            stderr,
            missing: (err as NodeJS.ErrnoException | null)?.code === 'ENOENT',
          }),
      );
    },
  );
}

// ------------------------------------------------------------------ inspect_environment

const PROBES: Array<[string, string, string[]]> = [
  ['Node.js', 'node', ['--version']],
  ['npm', 'npm', ['--version']],
  ['PHP', 'php', ['-r', 'echo PHP_VERSION;']],
  ['Composer', 'composer', ['--version', '--no-ansi']],
  ['Python', 'python3', ['--version']],
  ['Git', 'git', ['--version']],
  ['Docker', 'docker', ['version', '--format', '{{.Server.Version}}']],
  ['Docker Compose', 'docker', ['compose', 'version', '--short']],
  ['Nginx', 'nginx', ['-v']],
  ['Apache', 'apache2', ['-v']],
  ['MySQL client', 'mysql', ['--version']],
  ['PostgreSQL client', 'psql', ['--version']],
  ['Redis CLI', 'redis-cli', ['--version']],
  ['PM2', 'pm2', ['--version']],
  ['Supervisor', 'supervisorctl', ['version']],
  ['Certbot', 'certbot', ['--version']],
];

export const inspectEnvironment = defineTool({
  name: 'inspect_environment',
  description:
    'Diagnose this machine: OS, CPU, memory, disk space for the project, and versions of common runtimes and services (Node, PHP, Composer, Python, Git, Docker, Nginx, databases, PM2, Supervisor, Certbot). Read-only; environment variables are never included.',
  category: 'read_only',
  risk: 'none',
  requiresProject: false,
  schema: z.object({}),
  describeCall: () => '',
  async execute(_args, ctx) {
    const results = await Promise.all(
      PROBES.map(async ([label, file, args]) => {
        const r = await exec(file, args, { timeoutMs: 8_000, signal: ctx.signal });
        const out = `${r.stdout}${r.stderr}`.trim().split('\n')[0]?.trim() ?? '';
        return `${label}: ${r.missing ? 'not installed' : r.code === 0 || out ? out : `error (exit ${r.code})`}`;
      }),
    );
    const disks: string[] = [];
    for (const p of [
      ...new Set([ctx.project?.rootPath, os.homedir(), '/'].filter((x): x is string => !!x)),
    ]) {
      try {
        const st = await fs.statfs(p);
        const free = (st.bavail * st.bsize) / 1024 ** 3;
        const total = (st.blocks * st.bsize) / 1024 ** 3;
        disks.push(
          `${p}: ${free.toFixed(1)} GB free of ${total.toFixed(1)} GB (${((1 - st.bavail / st.blocks) * 100).toFixed(0)}% used)`,
        );
      } catch {
        /* not accessible */
      }
    }
    const content = [
      `OS: ${os.type()} ${os.release()} (${os.platform()} ${os.arch()})${os.release().toLowerCase().includes('microsoft') ? ', running under WSL' : ''}`,
      `CPU: ${os.cpus().length} × ${os.cpus()[0]?.model ?? 'unknown'}; load average ${os
        .loadavg()
        .map((l) => l.toFixed(2))
        .join(' ')}`,
      `Memory: ${(os.freemem() / 1024 ** 3).toFixed(1)} GB free of ${(os.totalmem() / 1024 ** 3).toFixed(1)} GB`,
      `Uptime: ${(os.uptime() / 3600).toFixed(1)} h`,
      'Disk:',
      ...disks.map((d) => `  ${d}`),
      'Tools:',
      ...results.map((r) => `  ${r}`),
    ].join('\n');
    const installed = results.filter((r) => !r.endsWith('not installed')).length;
    return { content, summary: `${installed}/${results.length} tools found` };
  },
});

// ------------------------------------------------------------------ search_logs

const TAIL_BYTES = 4 * 1024 * 1024;

async function readTail(file: string): Promise<{ text: string; partial: boolean; size: number }> {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    await handle.read(buf, 0, buf.length, start);
    if (looksBinary(buf.subarray(0, 64 * 1024)))
      throw new WorkspaceError('unsupported', 'That file is binary, not a text log.');
    let text = buf.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1); // drop the partial first line
    return { text, partial: start > 0, size };
  } finally {
    await handle.close();
  }
}

export const searchLogs = defineTool({
  name: 'search_logs',
  description:
    'Read the end of a log file on THIS machine, optionally keeping only lines containing `query` (literal, case-insensitive). `source` is either the label of a log source the user authorized in Settings (e.g. "nginx-error") or a path inside the project (e.g. "storage/logs/laravel.log"). Reads at most the last 4 MB. Secrets are redacted. For logs on an SSH host, use remote_diagnose with check "tail_log" instead.',
  category: 'read_only',
  risk: 'none',
  requiresProject: false,
  schema: z.object({
    source: z.string().min(1).max(1024),
    query: z.string().min(1).max(300).optional(),
    tail_lines: z.number().int().min(1).max(2_000).default(200),
  }),
  describeCall: (a) => `${a.source}${a.query ? ` "${a.query}"` : ''}`,
  async execute(args, ctx) {
    const authorized = devops(ctx).logSources.byLabel(args.source);
    let file: string;
    let shown: string;
    if (authorized) {
      file = authorized.path;
      shown = `${authorized.label} (${authorized.path})`;
    } else {
      if (!ctx.project) {
        const labels = devops(ctx)
          .logSources.list()
          .map((l) => l.label);
        const remoteHint =
          /^[\w.-]+:\//.test(args.source) || args.source.startsWith('/var/log/')
            ? ' For a log on an SSH host, use remote_diagnose with check "tail_log" and target = the absolute path.'
            : '';
        throw new WorkspaceError(
          'not_found',
          `No authorized log source named "${args.source}". Available: ${labels.join(', ') || 'none (the user can add some in Settings → Log sources)'}.${remoteHint}`,
        );
      }
      await assertRootAvailable(ctx.project.rootPath);
      const target = await resolveInside(ctx.project.rootPath, args.source);
      file = target.abs;
      shown = target.rel;
    }
    const { text, partial, size } = await readTail(file);
    let lines = splitLines(text);
    const total = lines.length;
    if (args.query) {
      const q = args.query.toLowerCase();
      lines = lines.filter((l) => l.toLowerCase().includes(q));
    }
    const kept = lines
      .slice(-args.tail_lines)
      .map((l) => (l.length > 2_000 ? `${l.slice(0, 2_000)} …` : l));
    const header = `${shown}: ${(size / 1024).toFixed(0)} KB${partial ? ', last 4 MB read' : ''}; ${args.query ? `${lines.length} of ${total} lines match "${args.query}"` : `${total} lines`}; showing last ${kept.length}`;
    return {
      content: `${header}\n${kept.join('\n') || '(no matching lines)'}`,
      summary: args.query ? `${lines.length} matching lines` : `${kept.length} lines`,
      truncated: kept.length < lines.length,
    };
  },
});

// ------------------------------------------------------------------ inspect_docker

const CONTAINER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/** Reduce `docker inspect` output to operational facts. Environment values are never included. */
export function summarizeInspect(raw: unknown): unknown {
  const items = Array.isArray(raw) ? raw : [raw];
  return items.map((c: Record<string, Json>) => ({
    name: String(c.Name ?? '').replace(/^\//, ''),
    image: c.Config?.Image,
    created: c.Created,
    state: c.State && {
      status: c.State.Status,
      running: c.State.Running,
      restarting: c.State.Restarting,
      exitCode: c.State.ExitCode,
      error: c.State.Error || undefined,
      oomKilled: c.State.OOMKilled,
      startedAt: c.State.StartedAt,
      finishedAt: c.State.FinishedAt,
      health: c.State.Health && {
        status: c.State.Health.Status,
        failingStreak: c.State.Health.FailingStreak,
        lastOutput: (c.State.Health.Log ?? [])
          .slice(-2)
          .map((l: { Output?: string }) => String(l.Output ?? '').slice(0, 500)),
      },
    },
    restartCount: c.RestartCount,
    restartPolicy: c.HostConfig?.RestartPolicy?.Name,
    privileged: c.HostConfig?.Privileged,
    networkMode: c.HostConfig?.NetworkMode,
    ports: c.NetworkSettings?.Ports,
    mounts: (c.Mounts ?? []).map((m: Record<string, unknown>) => ({
      type: m.Type,
      source: m.Source,
      destination: m.Destination,
      rw: m.RW,
    })),
    command: [c.Config?.Entrypoint, c.Config?.Cmd].flat().filter(Boolean),
    workingDir: c.Config?.WorkingDir,
    envNames: (c.Config?.Env ?? []).map((e: string) => e.split('=')[0]),
  }));
}

export const inspectDocker = defineTool({
  name: 'inspect_docker',
  description:
    'Read-only Docker diagnostics. view: "containers" (all, with status and ports), "images", "compose" (services of the project\'s compose file), "logs" (last lines of one container), or "inspect" (state, health, restarts, ports, mounts of one container; environment variable values are never shown). Container log output is redacted.',
  category: 'read_only',
  risk: 'none',
  requiresProject: false,
  schema: z.object({
    view: z.enum(['containers', 'images', 'compose', 'logs', 'inspect']),
    container: z.string().regex(CONTAINER, 'invalid container name').optional(),
    tail: z.number().int().min(1).max(1_000).default(100),
  }),
  describeCall: (a) => `${a.view}${a.container ? ` ${a.container}` : ''}`,
  async execute(args, ctx) {
    const run = async (dockerArgs: string[], cwd?: string) => {
      const r = await exec('docker', dockerArgs, {
        timeoutMs: 20_000,
        signal: ctx.signal,
        ...(cwd ? { cwd } : {}),
      });
      if (r.missing) throw new WorkspaceError('unsupported', 'Docker is not installed.');
      if (r.code !== 0)
        throw new WorkspaceError(
          'unsupported',
          `docker ${dockerArgs[0]} failed: ${(r.stderr || r.stdout).trim().split('\n')[0]}`,
        );
      return r;
    };
    const needContainer = () => {
      if (!args.container)
        throw new WorkspaceError('invalid_path', `view "${args.view}" needs a container name.`);
      return args.container;
    };
    switch (args.view) {
      case 'containers': {
        const r = await run([
          'ps',
          '--all',
          '--no-trunc=false',
          '--format',
          '{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}',
        ]);
        const rows = r.stdout.trim().split('\n').filter(Boolean);
        return {
          content: `NAME\tIMAGE\tSTATUS\tPORTS\n${rows.join('\n') || '(no containers)'}`,
          summary: `${rows.length} containers`,
        };
      }
      case 'images': {
        const r = await run([
          'images',
          '--format',
          '{{.Repository}}:{{.Tag}}\t{{.Size}}\t{{.CreatedSince}}',
        ]);
        const rows = r.stdout.trim().split('\n').filter(Boolean);
        return { content: rows.join('\n') || '(no images)', summary: `${rows.length} images` };
      }
      case 'compose': {
        if (!ctx.project)
          throw new WorkspaceError('unsupported', 'The compose view needs a project.');
        const r = await run(
          [
            'compose',
            'ps',
            '--all',
            '--format',
            '{{.Service}}\t{{.Name}}\t{{.State}}\t{{.Status}}',
          ],
          ctx.project.rootPath,
        );
        const rows = r.stdout.trim().split('\n').filter(Boolean);
        return {
          content: `SERVICE\tCONTAINER\tSTATE\tSTATUS\n${rows.join('\n') || '(no services running)'}`,
          summary: `${rows.length} services`,
        };
      }
      case 'logs': {
        const r = await run([
          'logs',
          '--tail',
          String(args.tail),
          '--timestamps',
          '--',
          needContainer(),
        ]);
        const out = `${r.stdout}${r.stderr}`.trim();
        return {
          content: out || '(no log output)',
          summary: `${out ? out.split('\n').length : 0} lines`,
        };
      }
      case 'inspect': {
        const r = await run(['inspect', '--type', 'container', '--', needContainer()]);
        const summary = summarizeInspect(JSON.parse(r.stdout)) as Array<{
          state?: { status?: string };
        }>;
        return {
          content: JSON.stringify(summary, null, 2),
          summary: summary[0]?.state?.status ?? 'inspected',
        };
      }
    }
  },
});

// ------------------------------------------------------------------ validate_config

interface Finding {
  level: 'error' | 'warning';
  message: string;
  line?: number;
}

function lineOf(doc: Document, node: unknown, text: string): number | undefined {
  const range = (node as { range?: [number, number] } | null)?.range;
  return range ? text.slice(0, range[0]).split('\n').length : undefined;
}

function checkWorkflow(doc: Document, text: string): Finding[] {
  const f: Finding[] = [];
  const data = doc.toJS() as Record<string, Json> | null;
  if (!data || typeof data !== 'object')
    return [{ level: 'error', message: 'Workflow must be a YAML mapping.' }];
  if (!('on' in data)) f.push({ level: 'error', message: 'Missing "on" (workflow triggers).' });
  if (!data.jobs || typeof data.jobs !== 'object' || !Object.keys(data.jobs).length) {
    f.push({ level: 'error', message: 'Missing "jobs".' });
    return f;
  }
  if (!data.permissions)
    f.push({
      level: 'warning',
      message:
        'No top-level "permissions": the GITHUB_TOKEN gets the repository default, which may be broad. Consider "permissions: contents: read".',
    });
  const triggers =
    typeof data.on === 'string'
      ? [data.on]
      : Array.isArray(data.on)
        ? data.on
        : Object.keys(data.on ?? {});
  for (const [id, job] of Object.entries<Record<string, Json>>(data.jobs)) {
    // Point at the job's key ("build:"), not at its body.
    const jobsNode = doc.get('jobs', true) as
      { items?: Array<{ key?: { value?: unknown } }> } | undefined;
    const keyNode = jobsNode?.items?.find((p) => p.key?.value === id)?.key;
    const line = lineOf(doc, keyNode, text);
    if (!job || typeof job !== 'object') {
      f.push({
        level: 'error',
        message: `Job "${id}" must be a mapping.`,
        ...(line ? { line } : {}),
      });
      continue;
    }
    if (job.uses) continue; // reusable workflow call
    if (!job['runs-on'])
      f.push({
        level: 'error',
        message: `Job "${id}" has no "runs-on".`,
        ...(line ? { line } : {}),
      });
    if (!Array.isArray(job.steps) || job.steps.length === 0) {
      f.push({ level: 'error', message: `Job "${id}" has no "steps".`, ...(line ? { line } : {}) });
      continue;
    }
    job.steps.forEach((step: Record<string, Json>, i: number) => {
      const where = `Job "${id}" step ${i + 1}${step?.name ? ` (${step.name})` : ''}`;
      if (!step || (!step.run && !step.uses))
        f.push({ level: 'error', message: `${where} needs "run" or "uses".` });
      if (step?.run && step?.uses)
        f.push({ level: 'error', message: `${where} has both "run" and "uses".` });
      if (typeof step?.uses === 'string' && /@(main|master|latest)$/.test(step.uses)) {
        f.push({
          level: 'warning',
          message: `${where} uses an unpinned action (${step.uses}); pin a release tag or commit SHA.`,
        });
      }
      if (typeof step?.run === 'string') {
        if (
          /\$\{\{\s*github\.(event\.(issue|pull_request|comment|review|head_commit)\.[\w.]*(title|body|message|name|label)|head_ref)/.test(
            step.run,
          )
        ) {
          f.push({
            level: 'warning',
            message: `${where} interpolates untrusted event data directly into a shell script (script injection risk). Pass it through an env variable instead.`,
          });
        }
        if (/echo[^\n]*\$\{\{\s*secrets\./.test(step.run))
          f.push({ level: 'warning', message: `${where} echoes a secret.` });
      }
      if (
        triggers.includes('pull_request_target') &&
        typeof step?.uses === 'string' &&
        step.uses.startsWith('actions/checkout') &&
        /pull_request\.head|head_ref/.test(JSON.stringify(step.with ?? {}))
      ) {
        f.push({
          level: 'error',
          message: `${where} checks out pull-request code under pull_request_target, which runs untrusted code with secrets.`,
        });
      }
    });
  }
  return f;
}

const DB_PORTS = new Set(['3306', '5432', '6379', '27017', '9200', '11211']);

function checkCompose(doc: Document): Finding[] {
  const f: Finding[] = [];
  const data = doc.toJS() as Record<string, Json> | null;
  if (!data?.services || typeof data.services !== 'object')
    return [{ level: 'error', message: 'Missing "services".' }];
  for (const [name, svc] of Object.entries<Record<string, Json>>(data.services)) {
    if (!svc || typeof svc !== 'object') {
      f.push({ level: 'error', message: `Service "${name}" must be a mapping.` });
      continue;
    }
    if (!svc.image && !svc.build)
      f.push({ level: 'error', message: `Service "${name}" needs "image" or "build".` });
    if (svc.privileged) f.push({ level: 'warning', message: `Service "${name}" runs privileged.` });
    if (svc.network_mode === 'host')
      f.push({ level: 'warning', message: `Service "${name}" uses host networking.` });
    for (const v of svc.volumes ?? []) {
      if (String(typeof v === 'string' ? v : v?.source).includes('docker.sock')) {
        f.push({
          level: 'warning',
          message: `Service "${name}" mounts the Docker socket (root-equivalent access to the host).`,
        });
      }
    }
    for (const p of svc.ports ?? []) {
      const spec = String(
        typeof p === 'object' ? `${p.host_ip ?? ''}:${p.published ?? ''}:${p.target ?? ''}` : p,
      );
      const parts = spec.split(':');
      const target = parts.at(-1)?.split('/')[0] ?? '';
      const boundLocal = /^(127\.0\.0\.1|localhost|::1)$/.test(parts.length >= 3 ? parts[0]! : '');
      if (DB_PORTS.has(target) && !boundLocal) {
        f.push({
          level: 'warning',
          message: `Service "${name}" publishes database port ${target} on all interfaces; bind it to 127.0.0.1 or drop the port.`,
        });
      }
    }
    const env = svc.environment ?? {};
    const entries: Array<[string, unknown]> = Array.isArray(env)
      ? env.map((e: string) => [e.split('=')[0]!, e.split('=').slice(1).join('=')])
      : Object.entries(env);
    for (const [k, v] of entries) {
      if (/PASSWORD|SECRET|TOKEN|API_KEY|PRIVATE/i.test(k) && v && !String(v).includes('${')) {
        f.push({
          level: 'warning',
          message: `Service "${name}" hard-codes a value for ${k}; use an env file or \${VARIABLE} instead.`,
        });
      }
    }
  }
  return f;
}

export const validateConfig = defineTool({
  name: 'validate_config',
  description:
    'Validate a configuration file in the project and report errors with line numbers plus security warnings. Supports GitHub Actions workflows, Docker Compose files, generic YAML, and JSON. kind="auto" picks from the path.',
  category: 'read_only',
  risk: 'none',
  requiresProject: true,
  schema: z.object({
    path: z.string().min(1).max(1024),
    kind: z.enum(['auto', 'github_actions', 'docker_compose', 'yaml', 'json']).default('auto'),
  }),
  describeCall: (a) => a.path,
  async execute(args, ctx) {
    if (!ctx.project) throw new WorkspaceError('unsupported', 'No project.');
    await assertRootAvailable(ctx.project.rootPath);
    const target = await resolveInside(ctx.project.rootPath, args.path);
    const text = await fs.readFile(target.abs, 'utf8');
    const base = path.basename(target.rel).toLowerCase();
    const kind =
      args.kind !== 'auto'
        ? args.kind
        : /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(target.rel)
          ? 'github_actions'
          : /^(docker-)?compose(\.[\w-]+)?\.ya?ml$/.test(base)
            ? 'docker_compose'
            : base.endsWith('.json')
              ? 'json'
              : 'yaml';

    const findings: Finding[] = [];
    if (kind === 'json') {
      const err = findJsonError(text);
      if (err)
        findings.push({
          level: 'error',
          message: `${err.message} (column ${err.column})`,
          line: err.line,
        });
    } else {
      const doc = parseDocument(text, { prettyErrors: true, uniqueKeys: true });
      for (const e of doc.errors)
        findings.push({
          level: 'error',
          message: e.message.split('\n')[0]!,
          ...(e.linePos ? { line: e.linePos[0].line } : {}),
        });
      for (const w of doc.warnings)
        findings.push({
          level: 'warning',
          message: w.message.split('\n')[0]!,
          ...(w.linePos ? { line: w.linePos[0].line } : {}),
        });
      if (
        doc.errors.length === 0 &&
        (isMap(doc.contents) || isSeq(doc.contents) || doc.contents === null)
      ) {
        if (kind === 'github_actions') findings.push(...checkWorkflow(doc, text));
        if (kind === 'docker_compose') findings.push(...checkCompose(doc));
      }
    }
    const errors = findings.filter((x) => x.level === 'error');
    const warnings = findings.filter((x) => x.level === 'warning');
    const fmt = (x: Finding) => `  ${x.line ? `line ${x.line}: ` : ''}${x.message}`;
    const content = [
      `${target.rel} (${kind.replace('_', ' ')}): ${errors.length ? `INVALID, ${errors.length} error(s)` : 'valid'}${warnings.length ? `, ${warnings.length} warning(s)` : ''}`,
      ...(errors.length ? ['Errors:', ...errors.map(fmt)] : []),
      ...(warnings.length ? ['Warnings:', ...warnings.map(fmt)] : []),
      'Note: this checks syntax and common mistakes; it does not run the workflow or contact any service.',
    ].join('\n');
    return {
      content,
      summary: errors.length
        ? `${errors.length} errors, ${warnings.length} warnings`
        : `valid, ${warnings.length} warnings`,
    };
  },
});

// ------------------------------------------------------------------ prepare_deployment_plan

const DATA_RISK =
  /\b(migrate|db:seed|db:wipe|mysql|psql|pg_restore|mysqldump|drop\s+(table|database)|alter\s+table|truncate|redis-cli\s+flush)/i;

export const prepareDeploymentPlan = defineTool({
  name: 'prepare_deployment_plan',
  description:
    'Record a structured deployment, migration, or maintenance plan for the user to review before anything is executed: target environment, pre-checks (backups!), ordered steps with exact commands and where they run ("local" or a configured SSH host name), downtime, rollback, and verification. Required before any command on a production host. Recording a plan executes nothing.',
  category: 'agent_state',
  risk: 'none',
  requiresProject: false,
  schema: z.object({
    title: z.string().min(3).max(200),
    environment: z.enum(['development', 'staging', 'production']),
    target: z.string().min(1).max(200).describe('What is being deployed or changed, and where.'),
    summary: z.string().min(10).max(2_000),
    pre_checks: z.array(z.string().min(3).max(500)).max(20),
    steps: z
      .array(
        z.object({
          title: z.string().min(3).max(300),
          command: z.string().max(4_000).optional(),
          where: z.string().min(1).max(100).default('local'),
          risk: z.enum(['none', 'low', 'medium', 'high', 'critical']),
          causes_downtime: z.boolean().default(false),
          reversible: z.boolean(),
          rollback: z.string().max(2_000).optional(),
        }),
      )
      .min(1)
      .max(40),
    verification: z.array(z.string().min(3).max(500)).max(20),
    rollback_plan: z.string().max(4_000),
    data_loss_risk: z.string().min(2).max(1_000),
    downtime_estimate: z.string().min(1).max(300),
  }),
  describeCall: (a) => `${a.environment}: ${a.title}`,
  async execute(args, ctx) {
    const { hosts, plans } = devops(ctx);
    const problems: string[] = [];
    for (const [i, step] of args.steps.entries()) {
      if (step.where === 'local') continue;
      const host = hosts.byName(step.where);
      if (!host)
        problems.push(
          `Step ${i + 1} runs on "${step.where}", which is not a configured SSH host (${
            hosts
              .list()
              .map((h) => h.name)
              .join(', ') || 'none configured'
          }).`,
        );
      else if (host.environment !== args.environment)
        problems.push(
          `Step ${i + 1} targets ${host.name} (${host.environment}) but the plan is for ${args.environment}.`,
        );
    }
    if (args.environment !== 'development') {
      if (args.verification.length === 0)
        problems.push('Add at least one verification step (how success will be confirmed).');
      if (args.rollback_plan.trim().length < 10) problems.push('Describe the rollback plan.');
      if (args.pre_checks.length === 0)
        problems.push('Add pre-checks (e.g. backups, current health, disk space).');
    }
    if (
      args.steps.some((s) => s.command && DATA_RISK.test(s.command)) &&
      !args.pre_checks.some((c) => /backup|dump|snapshot/i.test(c))
    ) {
      problems.push(
        'This plan changes data (migrations or database commands): add a database backup to pre_checks.',
      );
    }
    if (args.steps.some((s) => !s.reversible && !s.rollback) && args.environment === 'production') {
      problems.push(
        'Irreversible production steps need a "rollback" note explaining recovery (e.g. restore from backup).',
      );
    }
    if (problems.length)
      throw new WorkspaceError(
        'unsupported',
        `The plan was not recorded:\n- ${problems.join('\n- ')}`,
      );

    const plan = plans.create({
      sessionId: ctx.sessionId,
      runId: ctx.runId,
      toolCallId: ctx.callId ?? '',
      title: args.title,
      environment: args.environment,
      target: args.target,
      summary: args.summary,
      preChecks: args.pre_checks,
      steps: args.steps.map((s) => ({
        title: s.title,
        command: s.command ?? null,
        where: s.where,
        risk: s.risk,
        causesDowntime: s.causes_downtime,
        reversible: s.reversible,
        rollback: s.rollback ?? null,
      })),
      verification: args.verification,
      rollbackPlan: args.rollback_plan,
      dataLossRisk: args.data_loss_risk,
      downtimeEstimate: args.downtime_estimate,
    });
    ctx.emitDeploymentPlan?.(plan);
    return {
      // Phrased as a plain result (not as instructions) so models do not mistake it for a prompt.
      content: `Result: plan ${plan.id} recorded and displayed. Environment: ${plan.environment}. Steps: ${plan.steps.length}. Executed so far: none.`,
      summary: `${plan.environment} plan, ${plan.steps.length} steps`,
    };
  },
});

// ------------------------------------------------------------------ remote tools

const SERVICE = /^[A-Za-z0-9@._-]{1,100}$/;
const REMOTE_LOG = /^\/var\/log\/[A-Za-z0-9._/-]{1,200}$/;

const CHECKS: Record<
  string,
  { needs?: 'service' | 'log'; command: (t: string) => string; label: string }
> = {
  uptime: { label: 'uptime and load', command: () => 'uptime' },
  os: { label: 'OS and kernel', command: () => 'cat /etc/os-release; uname -a' },
  // POSIX flags only: the same commands must work on GNU coreutils and BusyBox (Alpine).
  disk: {
    label: 'disk usage',
    command: () => "df -hP | awk 'NR==1 || $1 !~ /^(tmpfs|devtmpfs|shm|squashfs)$/'",
  },
  inodes: {
    label: 'inode usage',
    command: () => "df -iP | awk 'NR==1 || $1 !~ /^(tmpfs|devtmpfs|shm|squashfs)$/'",
  },
  memory: { label: 'memory', command: () => 'free -m' },
  failed_services: {
    label: 'failed systemd units',
    command: () => 'systemctl --failed --no-pager --plain',
  },
  service_status: {
    label: 'service status',
    needs: 'service',
    command: (t) => `systemctl status --no-pager --lines=30 ${shellQuote(t)}`,
  },
  service_journal: {
    label: 'service journal',
    needs: 'service',
    command: (t) => `journalctl -u ${shellQuote(t)} -n 100 --no-pager`,
  },
  tail_log: { label: 'log tail', needs: 'log', command: (t) => `tail -n 200 ${shellQuote(t)}` },
  listening_ports: {
    label: 'listening ports',
    command: () => 'ss -tuln 2>/dev/null || netstat -tuln',
  },
  docker_ps: {
    label: 'docker containers',
    command: () => "docker ps -a --format 'table {{.Names}}\\t{{.Status}}\\t{{.Image}}'",
  },
  nginx_config_test: { label: 'nginx -t', command: () => 'nginx -t 2>&1' },
  php_version: { label: 'PHP version', command: () => 'php -v' },
  certificates: { label: 'certbot certificates', command: () => 'certbot certificates 2>&1' },
};

function requireHost(ctx: ToolContext, name: string): SshHostDto {
  const { hosts } = devops(ctx);
  const host = hosts.byName(name);
  if (!host) {
    throw new WorkspaceError(
      'not_found',
      `No SSH host named "${name}". Configured hosts: ${
        hosts
          .list()
          .map((h) => `${h.name} (${h.environment})`)
          .join(', ') || 'none; the user can add one in Settings → SSH hosts'
      }.`,
    );
  }
  if (host.trustedFingerprints.length === 0) {
    throw new WorkspaceError(
      'unsupported',
      `SSH host "${name}" has no trusted host key. Ask the user to verify and trust it in Settings → SSH hosts.`,
    );
  }
  return host;
}

const RISK_ORDER: RiskLevel[] = ['none', 'low', 'medium', 'high', 'critical'];
export const atLeast = (r: RiskLevel, floor: RiskLevel): RiskLevel =>
  RISK_ORDER.indexOf(r) >= RISK_ORDER.indexOf(floor) ? r : floor;
export const PRODUCTION_TTL_MS = 5 * 60_000;

async function runRemote(ctx: ToolContext, host: SshHostDto, command: string, timeoutMs: number) {
  const r = await devops(ctx).ssh.run(host, command, {
    timeoutMs,
    signal: ctx.signal,
    ...(ctx.emitOutput ? { onOutput: ctx.emitOutput } : {}),
  });
  if (r.spawnError) throw new WorkspaceError('unsupported', r.spawnError);
  const status = r.timedOut
    ? `timed out after ${timeoutMs / 1000}s (ssh killed; the remote command may still be running)`
    : r.cancelled
      ? 'cancelled (ssh killed; the remote command may still be running)'
      : r.exitCode === 255
        ? `ssh error: ${explainSshFailure(r.output)}`
        : `exit code ${r.exitCode}`;
  const max = ctx.maxOutputChars - 400;
  const out =
    r.output.length > max
      ? `${r.output.slice(0, max / 2)}\n[... omitted ...]\n${r.output.slice(-max / 2)}`
      : r.output;
  return {
    content: [
      `$ ${command}`,
      `host: ${host.name} (${host.username}@${host.hostname}:${host.port}, ${host.environment})`,
      `${status} in ${(r.durationMs / 1000).toFixed(1)}s`,
      '--- output ---',
      out || '(no output)',
    ].join('\n'),
    summary: `${status} (${(r.durationMs / 1000).toFixed(1)}s)`,
  };
}

export const hostFingerprint = (h: SshHostDto) =>
  `${h.id}|${h.hostname}|${h.port}|${h.username}|${h.environment}|${h.trustedFingerprints.join(',')}`;

export const remoteDiagnose = defineTool({
  name: 'remote_diagnose',
  description:
    "Run one predefined read-only diagnostic on a configured SSH host: uptime, os, disk, inodes, memory, failed_services, service_status (target = unit name), service_journal (target = unit name), tail_log (target = absolute path under /var/log), listening_ports, docker_ps, nginx_config_test, php_version, certificates. Requires the user's approval.",
  category: 'remote',
  risk: 'low',
  requiresProject: false,
  schema: z.object({
    host: z.string().min(1).max(100),
    check: z.enum(Object.keys(CHECKS) as [string, ...string[]]),
    target: z.string().max(300).optional(),
    reason,
  }),
  describeCall: (a) => `${a.host}: ${a.check}${a.target ? ` ${a.target}` : ''}`,
  async prepare(args, ctx): Promise<Proposal> {
    const host = requireHost(ctx, args.host);
    const check = CHECKS[args.check]!;
    if (check.needs === 'service' && !(args.target && SERVICE.test(args.target))) {
      throw new WorkspaceError(
        'invalid_path',
        `Check "${args.check}" needs target = a systemd unit name (letters, digits, @ . _ -).`,
      );
    }
    if (
      check.needs === 'log' &&
      !(args.target && REMOTE_LOG.test(args.target) && !args.target.includes('..'))
    ) {
      throw new WorkspaceError(
        'invalid_path',
        'tail_log needs target = an absolute path under /var/log.',
      );
    }
    const command = check.command(args.target ?? '');
    return {
      title: `Diagnose ${host.name}: ${check.label}`,
      summary: `Connects to ${host.username}@${host.hostname} (${host.environment}) over SSH and runs a read-only check. Nothing is changed.`,
      category: 'remote',
      risk: host.environment === 'production' ? 'medium' : 'low',
      details: {
        kind: 'remote',
        host: {
          name: host.name,
          hostname: host.hostname,
          port: host.port,
          username: host.username,
          environment: host.environment,
        },
        command,
        check: args.check,
        expectedImpact: 'Read-only diagnostic; changes nothing on the server.',
        downtime: 'None',
        rollback: 'Not needed (read-only).',
        verification: 'Review the output.',
        riskReasons: [],
        timeoutSeconds: 60,
      },
      fingerprint: `${hostFingerprint(host)}|${command}`,
      timeoutMs: 70_000,
      ...(host.environment === 'production' ? { approvalTtlMs: PRODUCTION_TTL_MS } : {}),
      apply: (execCtx) => runRemote(execCtx, host, command, 60_000),
    };
  },
});

export const remoteCommand = defineTool({
  name: 'remote_command',
  description:
    'Run a command on a configured SSH host (deployments, service restarts, maintenance). Requires approval showing the host, environment, exact command, expected impact, downtime, rollback and verification. On production hosts a deployment plan must have been recorded in this conversation first (prepare_deployment_plan) and the user must type the host name to approve. Prefer remote_diagnose for read-only checks.',
  category: 'remote',
  risk: 'high',
  requiresProject: false,
  schema: z.object({
    host: z.string().min(1).max(100),
    command: z.string().min(1).max(4_000),
    expected_impact: z.string().min(5).max(1_000).describe('What will change on the server.'),
    downtime: z.string().min(2).max(300).describe('Expected downtime, or "none".'),
    rollback: z
      .string()
      .min(2)
      .max(1_000)
      .describe('How to undo this, or why it cannot be undone.'),
    verification: z.string().min(3).max(1_000).describe('How success will be checked afterwards.'),
    timeout_seconds: z.number().int().min(5).max(900).default(120),
    reason,
  }),
  describeCall: (a) => `${a.host}: ${(a.command ?? '').slice(0, 100)}`,
  async prepare(args, ctx): Promise<Proposal> {
    const host = requireHost(ctx, args.host);
    const env: HostEnvironment = host.environment;
    if (
      env === 'production' &&
      !devops(ctx)
        .plans.listBySession(ctx.sessionId)
        .some((p) => p.environment === 'production')
    ) {
      throw new WorkspaceError(
        'unsupported',
        'Commands on production hosts require a deployment plan recorded in this conversation first. Call prepare_deployment_plan (environment "production") so the user can review the whole change.',
      );
    }
    const assessed = assessCommand(null, args.command);
    const risk =
      env === 'production'
        ? atLeast(assessed.risk, 'high')
        : env === 'staging'
          ? atLeast(assessed.risk, 'medium')
          : assessed.risk;
    return {
      title: `${env === 'production' ? 'PRODUCTION · ' : ''}Run on ${host.name}: ${args.command.length > 60 ? `${args.command.slice(0, 60)}…` : args.command}`,
      summary: `Runs this command as ${host.username} on ${host.hostname} (${env}) through the remote shell, for up to ${args.timeout_seconds}s.`,
      category: env === 'production' ? 'deployment' : 'remote',
      risk,
      details: {
        kind: 'remote',
        host: {
          name: host.name,
          hostname: host.hostname,
          port: host.port,
          username: host.username,
          environment: env,
        },
        command: args.command,
        check: null,
        expectedImpact: args.expected_impact,
        downtime: args.downtime,
        rollback: args.rollback,
        verification: args.verification,
        riskReasons: assessed.reasons.filter((r) => !r.startsWith('Runs through /bin/sh')),
        timeoutSeconds: args.timeout_seconds,
      },
      fingerprint: `${hostFingerprint(host)}|${args.command}`,
      timeoutMs: (args.timeout_seconds + 15) * 1000,
      ...(env === 'production'
        ? { confirmationRequired: host.name, approvalTtlMs: PRODUCTION_TTL_MS }
        : {}),
      apply: (execCtx) => runRemote(execCtx, host, args.command, args.timeout_seconds * 1000),
    };
  },
});
