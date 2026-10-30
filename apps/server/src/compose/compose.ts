import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { childEnv } from '../commands/runner.js';
import { resolveInside, toRel, WorkspaceError } from '../workspace/paths.js';

/**
 * Docker Compose for the project's own compose file. Everything is scoped by the compose project
 * name and checked against the containers' config-file labels, so containers of other compose
 * projects (or another checkout that happens to use the same project name) are never touched.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/** Default file names, in compose's own lookup order, with the override it merges for each. */
const DEFAULT_FILES: Array<[string, string]> = [
  ['compose.yaml', 'compose.override.yaml'],
  ['compose.yml', 'compose.override.yml'],
  ['docker-compose.yml', 'docker-compose.override.yml'],
  ['docker-compose.yaml', 'docker-compose.override.yaml'],
];
const COMPOSE_NAME = /compose[\w.-]*\.ya?ml$/i;
export const SERVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;

export interface ComposeService {
  name: string;
  /** The image the containers run: declared, or compose's `<project>-<service>` for builds. */
  image: string;
  declaredImage: string | null;
  build: boolean;
  /** Published ports, e.g. "127.0.0.1:8080→80/tcp". */
  ports: string[];
  dependsOn: string[];
  healthcheck: boolean;
}

export interface ComposeProject {
  name: string;
  /** Project-relative paths of the files used (the base file first). */
  files: string[];
  abs: string[];
  dir: string;
  services: ComposeService[];
  /** Named volumes compose manages for this project (external ones are left out). */
  volumes: string[];
  /** Hash of the fully resolved configuration (it changes with the files and .env). */
  configHash: string;
}

export interface ComposeContainer {
  id: string;
  name: string;
  service: string;
  oneoff: boolean;
  state: string;
  exitCode: number;
  restartCount: number;
  startedAt: string;
  health: { status: string; failingStreak: number; lastOutput: string } | null;
  /** Published TCP ports: where to connect from this machine. */
  published: Array<{ host: string; port: number; target: string }>;
  anonymousVolumes: number;
}

export interface Containers {
  ours: ComposeContainer[];
  /** Containers with this project name that another compose file created. */
  foreign: Array<{ name: string; files: string }>;
}

export function docker(
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; signal?: AbortSignal } = {},
) {
  return new Promise<{ code: number; stdout: string; stderr: string; missing: boolean }>(
    (resolve) => {
      execFile(
        'docker',
        args,
        {
          env: childEnv(),
          timeout: opts.timeoutMs ?? 20_000,
          maxBuffer: 16 * 1024 * 1024,
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

async function exists(file: string) {
  return fs
    .stat(file)
    .then((s) => s.isFile())
    .catch(() => false);
}

/** The compose file(s) to use: the given one, or the project's default file and its override. */
export async function resolveComposeFiles(
  root: string,
  file?: string,
): Promise<{ rel: string[]; abs: string[] }> {
  if (file) {
    const r = await resolveInside(root, file);
    if (!COMPOSE_NAME.test(path.basename(r.abs)) || !(await exists(r.abs)))
      throw new WorkspaceError(
        'invalid_path',
        `"${file}" is not a compose file (expected a .yml or .yaml file with "compose" in its name).`,
      );
    return { rel: [r.rel], abs: [r.abs] };
  }
  for (const [base, override] of DEFAULT_FILES) {
    const abs = path.join(root, base);
    if (!(await exists(abs))) continue;
    const files = [abs];
    if (await exists(path.join(root, override))) files.push(path.join(root, override));
    return { rel: files.map((f) => toRel(root, f)), abs: files };
  }
  throw new WorkspaceError(
    'not_found',
    'No compose file in the project root (compose.yaml or docker-compose.yml). Pass file for one elsewhere in the project.',
  );
}

/** `docker compose` with the files and project name pinned, before the subcommand. */
export function composeBase(p: Pick<ComposeProject, 'abs' | 'dir' | 'name'>): string[] {
  return [
    'compose',
    '--ansi',
    'never',
    '--progress',
    'plain',
    ...p.abs.flatMap((f) => ['-f', f]),
    '--project-directory',
    p.dir,
    '-p',
    p.name,
  ];
}

function portText(p: Json): string | null {
  if (!p || typeof p !== 'object' || !p.published) return null;
  return `${p.host_ip ? `${p.host_ip}:` : ''}${p.published}→${p.target}/${p.protocol ?? 'tcp'}`;
}

/**
 * Parse `docker compose config --format json`. Only operational facts are kept; environment
 * values, labels, secrets and commands are never read, because they can hold credentials.
 */
export function parseConfig(raw: Json, files: { rel: string[]; abs: string[]; dir: string }) {
  const name = String(raw?.name ?? '');
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name))
    throw new WorkspaceError('unsupported', `Unexpected compose project name "${name}".`);
  const services: ComposeService[] = Object.entries<Json>(raw.services ?? {})
    .map(([svc, s]) => ({
      name: svc,
      image: s?.image ? String(s.image) : `${name}-${svc}`,
      declaredImage: s?.image ? String(s.image) : null,
      build: !!s?.build,
      ports: ((s?.ports ?? []) as Json[]).map(portText).filter((x): x is string => !!x),
      dependsOn: Object.keys(s?.depends_on ?? {}),
      healthcheck: !!s?.healthcheck && !s.healthcheck.disable,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const volumes = Object.entries<Json>(raw.volumes ?? {})
    .filter(([, v]) => !v?.external)
    .map(([key, v]) => String(v?.name ?? `${name}_${key}`));
  return { name, files: files.rel, abs: files.abs, dir: files.dir, services, volumes };
}

export async function loadComposeProject(
  root: string,
  file: string | undefined,
  signal?: AbortSignal,
): Promise<ComposeProject> {
  const files = await resolveComposeFiles(root, file);
  const dir = path.dirname(files.abs[0]!);
  const r = await docker(
    [
      'compose',
      ...files.abs.flatMap((f) => ['-f', f]),
      '--project-directory',
      dir,
      'config',
      '--format',
      'json',
    ],
    { cwd: dir, timeoutMs: 20_000, ...(signal ? { signal } : {}) },
  );
  if (r.missing) throw new WorkspaceError('unsupported', 'Docker is not installed.');
  if (r.code !== 0)
    throw new WorkspaceError(
      'unsupported',
      `The compose file is not valid: ${firstError(r.stderr || r.stdout)}`,
    );
  let raw: Json;
  try {
    raw = JSON.parse(r.stdout);
  } catch {
    throw new WorkspaceError('unsupported', 'docker compose config returned unreadable output.');
  }
  return {
    ...parseConfig(raw, { ...files, dir }),
    configHash: createHash('sha256').update(r.stdout).digest('hex'),
  };
}

/** The first meaningful line of docker's error output. */
export function firstError(text: string): string {
  const line =
    text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !/^(WARN|time=)/.test(l)) ?? 'unknown error';
  return line.slice(0, 400);
}

/** Containers labelled with the project name, split into ours and those of another compose file. */
export async function listContainers(
  p: Pick<ComposeProject, 'name' | 'abs'>,
  signal?: AbortSignal,
): Promise<Containers> {
  const ps = await docker(
    [
      'ps',
      '--all',
      '--quiet',
      '--no-trunc',
      '--filter',
      `label=com.docker.compose.project=${p.name}`,
    ],
    signal ? { signal } : {},
  );
  if (ps.missing) throw new WorkspaceError('unsupported', 'Docker is not installed.');
  if (ps.code !== 0)
    throw new WorkspaceError('unsupported', `Docker is not reachable: ${firstError(ps.stderr)}`);
  const ids = ps.stdout.split('\n').filter(Boolean);
  if (!ids.length) return { ours: [], foreign: [] };
  const r = await docker(['inspect', '--type', 'container', ...ids], signal ? { signal } : {});
  // A container removed between the two calls makes inspect fail; read what it returned.
  let items: Json[];
  try {
    items = JSON.parse(r.stdout || '[]');
  } catch {
    items = [];
  }
  return splitContainers(items, p.abs);
}

export function splitContainers(items: Json[], files: string[]): Containers {
  const ours: ComposeContainer[] = [];
  const foreign: Containers['foreign'] = [];
  for (const c of items) {
    const labels = c?.Config?.Labels ?? {};
    const name = String(c?.Name ?? '').replace(/^\//, '');
    const configFiles = String(labels['com.docker.compose.project.config_files'] ?? '');
    if (!configFiles.split(',').includes(files[0]!)) {
      foreign.push({ name, files: configFiles || 'unknown' });
      continue;
    }
    const health = c?.State?.Health;
    const published: ComposeContainer['published'] = [];
    for (const [target, binds] of Object.entries<Json>(c?.NetworkSettings?.Ports ?? {})) {
      if (!target.endsWith('/tcp') || !Array.isArray(binds)) continue;
      for (const b of binds) {
        const port = Number(b?.HostPort);
        if (!port) continue;
        const host = String(b?.HostIp ?? '');
        const local = !host || host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
        if (!published.some((x) => x.host === local && x.port === port))
          published.push({ host: local, port, target });
      }
    }
    ours.push({
      id: String(c?.Id ?? ''),
      name,
      service: String(labels['com.docker.compose.service'] ?? ''),
      oneoff: String(labels['com.docker.compose.oneoff'] ?? '').toLowerCase() === 'true',
      state: String(c?.State?.Status ?? 'unknown'),
      exitCode: Number(c?.State?.ExitCode ?? 0),
      restartCount: Number(c?.RestartCount ?? 0),
      startedAt: String(c?.State?.StartedAt ?? ''),
      health: health
        ? {
            status: String(health.Status ?? ''),
            failingStreak: Number(health.FailingStreak ?? 0),
            lastOutput: String((health.Log ?? []).at(-1)?.Output ?? '')
              .trim()
              .slice(0, 300),
          }
        : null,
      published,
      anonymousVolumes: ((c?.Mounts ?? []) as Json[]).filter(
        (m) => m?.Type === 'volume' && /^[0-9a-f]{64}$/.test(String(m?.Name ?? '')),
      ).length,
    });
  }
  ours.sort((a, b) => a.service.localeCompare(b.service) || a.name.localeCompare(b.name));
  return { ours, foreign };
}

/** Refuse to act while another compose file's containers share this project name. */
export function assertNoForeign(p: ComposeProject, c: Containers) {
  if (!c.foreign.length) return;
  throw new WorkspaceError(
    'unsupported',
    `Compose project "${p.name}" also has containers created from another compose file (${c.foreign
      .slice(0, 3)
      .map((f) => `${f.name} from ${f.files}`)
      .join(
        '; ',
      )}). Friday only controls this project's own containers. Give this project a distinct top-level "name:" in its compose file, or stop the other project yourself.`,
  );
}

/** The services and everything they depend on (what `up` starts). */
export function withDependencies(p: ComposeProject, names: string[]): string[] {
  const byName = new Map(p.services.map((s) => [s.name, s]));
  const out = new Set<string>();
  const visit = (n: string) => {
    if (out.has(n)) return;
    out.add(n);
    for (const d of byName.get(n)?.dependsOn ?? []) visit(d);
  };
  names.forEach(visit);
  return [...out].sort();
}

export function unknownServices(p: ComposeProject, names: string[]): string[] {
  const known = new Set(p.services.map((s) => s.name));
  return names.filter((n) => !known.has(n));
}

export async function imagePresent(image: string, signal?: AbortSignal): Promise<boolean> {
  const r = await docker(
    ['image', 'inspect', '--format', '{{.Id}}', '--', image],
    signal ? { signal } : {},
  );
  return r.code === 0;
}

export async function existingVolumes(signal?: AbortSignal): Promise<Set<string>> {
  const r = await docker(['volume', 'ls', '--format', '{{.Name}}'], signal ? { signal } : {});
  return new Set(r.code === 0 ? r.stdout.split('\n').filter(Boolean) : []);
}

/** Whether something accepts TCP connections on a published port (read-only reachability). */
export function probePort(host: string, port: number, timeoutMs = 1_500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

export type Verdict = 'ok' | 'starting' | 'completed' | 'failed' | 'stopped' | 'missing';

/** One service's state from its (non one-off) containers. */
export function verdict(containers: ComposeContainer[]): { verdict: Verdict; text: string } {
  if (!containers.length) return { verdict: 'missing', text: 'no container' };
  const parts = containers.map((c) => {
    if (c.state === 'running') {
      if (!c.health) return { v: 'ok' as Verdict, t: 'running' };
      if (c.health.status === 'healthy') return { v: 'ok' as Verdict, t: 'running, healthy' };
      if (c.health.status === 'starting')
        return { v: 'starting' as Verdict, t: 'running, health check starting' };
      return {
        v: 'failed' as Verdict,
        t: `running, UNHEALTHY (${c.health.failingStreak} failed checks${c.health.lastOutput ? `; last: ${c.health.lastOutput.split('\n')[0]}` : ''})`,
      };
    }
    if (c.state === 'restarting')
      return { v: 'failed' as Verdict, t: `restarting (${c.restartCount} restarts)` };
    if (c.state === 'created') return { v: 'stopped' as Verdict, t: 'created, not started' };
    if (c.state === 'paused') return { v: 'stopped' as Verdict, t: 'paused' };
    if (c.state === 'exited')
      return c.exitCode === 0
        ? { v: 'completed' as Verdict, t: 'exited (0)' }
        : { v: 'failed' as Verdict, t: `exited (${c.exitCode})` };
    return { v: 'failed' as Verdict, t: c.state };
  });
  const order: Verdict[] = ['failed', 'starting', 'stopped', 'missing', 'completed', 'ok'];
  const worst = order.find((v) => parts.some((p) => p.v === v)) ?? 'ok';
  const texts = [...new Set(parts.map((p) => p.t))];
  return {
    verdict: worst,
    text: `${containers.length > 1 ? `${containers.length} containers: ` : ''}${texts.join('; ')}`,
  };
}

export interface ServiceStatus {
  service: string;
  verdict: Verdict;
  text: string;
  ports: Array<{ port: string; open: boolean | null }>;
  restarts: number;
}

/** Each service's state, with a reachability probe of its published ports when running. */
export async function serviceStatus(
  p: ComposeProject,
  c: Containers,
  services: string[],
  probe = true,
): Promise<ServiceStatus[]> {
  return Promise.all(
    services.map(async (service) => {
      const mine = c.ours.filter((x) => x.service === service && !x.oneoff);
      const v = verdict(mine);
      const running = mine.filter((x) => x.state === 'running');
      const ports = await Promise.all(
        running
          .flatMap((x) => x.published)
          .map(async (b) => ({
            port: `${b.host.includes(':') ? `[${b.host}]` : b.host}:${b.port}→${b.target}`,
            open: probe ? await probePort(b.host, b.port) : null,
          })),
      );
      return {
        service,
        verdict: v.verdict,
        text: v.text,
        ports,
        restarts: mine.reduce((t, x) => t + x.restartCount, 0),
      };
    }),
  );
}

export function statusLines(rows: ServiceStatus[]): string[] {
  return rows.map(
    (r) =>
      `${r.service}: ${r.text}${r.restarts ? `, ${r.restarts} restarts` : ''}${
        r.ports.length
          ? `; ports ${r.ports
              .map(
                (x) =>
                  `${x.port}${x.open === null ? '' : x.open ? ' (accepting connections)' : ' (NOT accepting connections)'}`,
              )
              .join(', ')}`
          : ''
      }`,
  );
}
