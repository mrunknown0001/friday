import type { MonitorDto, MonitorTarget, ProcessDto, SshHostDto } from '@friday/shared';
import {
  assertNoForeign,
  listContainers,
  loadComposeProject,
  verdict,
} from '../compose/compose.js';
import type { RunResult } from '../commands/runner.js';
import { explainSshFailure, shellQuote } from '../ssh/ssh.js';

/**
 * The checks behind health monitors. Every check is read-only: an HTTP GET without credentials,
 * fixed commands over SSH (no command text comes from anywhere but this file), and Friday's own
 * view of background processes and compose services.
 */

export interface CheckDeps {
  fetch: typeof fetch;
  sshHost: (id: string) => SshHostDto | null;
  sshRun: (
    host: SshHostDto,
    command: string,
    opts: { timeoutMs: number; signal: AbortSignal },
  ) => Promise<RunResult>;
  processes: (projectId: string) => ProcessDto[];
  projectRoot: (projectId: string) => string | null;
}

export interface CheckResult {
  ok: boolean;
  message: string;
}

export const UNIT = /^[A-Za-z0-9][A-Za-z0-9@._:-]{0,99}$/;
export const DISK_PATH = /^\/[A-Za-z0-9._/-]{0,200}$/;
const BODY_LIMIT = 256 * 1024;
const MAX_REDIRECTS = 5;
const USER_AGENT = 'Friday-monitor/0.1';

/** Validate a URL a user entered for a monitor: http(s), no embedded credentials. */
export function checkUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Not a valid URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error('Only http and https URLs can be monitored.');
  if (url.username || url.password)
    throw new Error(
      'Remove the user name and password from the URL; monitors send no credentials.',
    );
  return url;
}

/** The URL as shown to the model: the query string can carry tokens, so it is left out. */
export function shownUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}${u.search ? '?…' : ''}`;
  } catch {
    return '(invalid URL)';
  }
}

function networkError(err: unknown, timeoutSeconds: number, signal: AbortSignal): string {
  if (signal.aborted) return `no response within ${timeoutSeconds}s`;
  const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
  const code = cause?.code;
  const known: Record<string, string> = {
    ECONNREFUSED: 'connection refused',
    ENOTFOUND: 'host name not found',
    EAI_AGAIN: 'host name lookup failed',
    ECONNRESET: 'connection reset',
    EHOSTUNREACH: 'host unreachable',
    ENETUNREACH: 'network unreachable',
    CERT_HAS_EXPIRED: 'TLS certificate has expired',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'TLS certificate is self-signed',
    SELF_SIGNED_CERT_IN_CHAIN: 'TLS certificate chain is self-signed',
    ERR_TLS_CERT_ALTNAME_INVALID: 'TLS certificate does not match the host name',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS certificate could not be verified',
  };
  if (code && known[code]) return `${known[code]} (${code})`;
  return (cause?.message ?? (err instanceof Error ? err.message : String(err))).slice(0, 200);
}

async function readCapped(res: Response): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size >= BODY_LIMIT) {
      await reader.cancel();
      break;
    }
  }
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, BODY_LIMIT));
}

async function checkHttp(
  t: Extract<MonitorTarget, { kind: 'http' }>,
  deps: CheckDeps,
  outer: AbortSignal,
): Promise<CheckResult> {
  const signal = AbortSignal.any([outer, AbortSignal.timeout(t.timeoutSeconds * 1000)]);
  let url = checkUrl(t.url);
  const origin = url.host;
  try {
    for (let hop = 0; ; hop++) {
      const res = await deps.fetch(url, {
        method: 'GET',
        redirect: 'manual',
        credentials: 'omit',
        headers: { 'user-agent': USER_AGENT, accept: '*/*' },
        signal,
      });
      const location = res.headers.get('location');
      // Follow redirects on the same host only (e.g. http → https, / → /login).
      if (res.status >= 300 && res.status < 400 && location && hop < MAX_REDIRECTS) {
        const next = new URL(location, url);
        if (next.host === origin && (next.protocol === 'http:' || next.protocol === 'https:')) {
          await res.body?.cancel();
          url = next;
          continue;
        }
      }
      const statusOk =
        t.expectedStatus === null
          ? res.status >= 200 && res.status < 400
          : res.status === t.expectedStatus;
      const statusText = `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`;
      if (!statusOk) {
        await res.body?.cancel();
        return {
          ok: false,
          message: `${statusText} (expected ${t.expectedStatus ?? '2xx or 3xx'})`,
        };
      }
      if (t.contains !== null) {
        const body = await readCapped(res);
        if (!body.includes(t.contains))
          return {
            ok: false,
            message: `${statusText}, but the response does not contain the expected text`,
          };
      } else await res.body?.cancel();
      return { ok: true, message: statusText };
    }
  } catch (err) {
    return { ok: false, message: networkError(err, t.timeoutSeconds, signal) };
  }
}

/** The fixed shell script for an SSH monitor (unit and path are validated and quoted). */
export function sshScript(t: Extract<MonitorTarget, { kind: 'ssh' }>): string {
  const parts = ['echo FRIDAY_MONITOR_OK'];
  if (t.service) {
    if (!UNIT.test(t.service)) throw new Error('Invalid systemd unit name.');
    parts.push(`echo "SERVICE $(systemctl is-active ${shellQuote(t.service)} 2>&1 | head -n 1)"`);
  }
  if (t.diskPath) {
    if (!DISK_PATH.test(t.diskPath)) throw new Error('Invalid disk path.');
    parts.push(
      `echo "DISK $(df -P ${shellQuote(t.diskPath)} 2>/dev/null | tail -n 1 | awk '{print $5}')"`,
    );
  }
  return parts.join('; ');
}

export function parseSsh(
  t: Extract<MonitorTarget, { kind: 'ssh' }>,
  r: RunResult,
  host: SshHostDto,
): CheckResult {
  if (r.timedOut) return { ok: false, message: `${host.name}: no answer within 20s` };
  if (r.spawnError) return { ok: false, message: r.spawnError };
  if (!r.output.includes('FRIDAY_MONITOR_OK'))
    return {
      ok: false,
      message: `${host.name}: ${r.exitCode === 255 ? explainSshFailure(r.output) : `exit code ${r.exitCode}`}`,
    };
  const problems: string[] = [];
  const facts: string[] = ['reachable'];
  const line = (key: string) =>
    r.output
      .split('\n')
      .find((l) => l.startsWith(`${key} `))
      ?.slice(key.length + 1)
      .trim() ?? '';
  if (t.service) {
    const state = line('SERVICE') || 'unknown';
    (state === 'active' ? facts : problems).push(`${t.service} is ${state}`);
  }
  if (t.diskPath) {
    const pct = Number(line('DISK').replace('%', ''));
    if (!line('DISK') || Number.isNaN(pct)) problems.push(`disk usage of ${t.diskPath} unknown`);
    else if (t.diskMaxPercent !== null && pct > t.diskMaxPercent)
      problems.push(`${t.diskPath} is ${pct}% full (limit ${t.diskMaxPercent}%)`);
    else facts.push(`${t.diskPath} ${pct}% full`);
  }
  return problems.length
    ? { ok: false, message: `${host.name}: ${problems.join('; ')}` }
    : { ok: true, message: `${host.name}: ${facts.join(', ')}` };
}

function checkProcess(
  m: MonitorDto,
  t: Extract<MonitorTarget, { kind: 'process' }>,
  deps: CheckDeps,
): CheckResult {
  const mine = deps
    .processes(m.projectId!)
    .filter((p) => p.name.toLowerCase() === t.processName.toLowerCase())
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const running = mine.find((p) => p.status === 'running');
  if (running) return { ok: true, message: `"${running.name}" is running (${running.id})` };
  const last = mine[0];
  if (!last)
    return {
      ok: false,
      message: `no background process named "${t.processName}" has run since Friday started`,
    };
  const how = last.error
    ? last.error
    : last.stoppedBy
      ? `stopped by ${last.stoppedBy}`
      : `exited with ${last.signal ?? `code ${last.exitCode}`}`;
  return { ok: false, message: `"${last.name}" is not running: ${how}` };
}

async function checkCompose(
  m: MonitorDto,
  t: Extract<MonitorTarget, { kind: 'compose' }>,
  deps: CheckDeps,
  signal: AbortSignal,
): Promise<CheckResult> {
  const root = deps.projectRoot(m.projectId!);
  if (!root) return { ok: false, message: 'the project was removed' };
  try {
    const p = await loadComposeProject(root, t.file ?? undefined, signal);
    if (!p.services.some((s) => s.name === t.service))
      return { ok: false, message: `compose project "${p.name}" has no service "${t.service}"` };
    const c = await listContainers(p, signal);
    assertNoForeign(p, c);
    const v = verdict(c.ours.filter((x) => x.service === t.service && !x.oneoff));
    // A health check still starting is not an outage: Docker turns it unhealthy if it never passes.
    return {
      ok: v.verdict === 'ok' || v.verdict === 'starting',
      message: `${t.service}: ${v.text}`,
    };
  } catch (err) {
    return { ok: false, message: (err instanceof Error ? err.message : String(err)).slice(0, 300) };
  }
}

export async function runCheck(
  m: MonitorDto,
  deps: CheckDeps,
  signal: AbortSignal,
): Promise<CheckResult> {
  const t = m.target;
  switch (t.kind) {
    case 'http':
      return checkHttp(t, deps, signal);
    case 'ssh': {
      const host = deps.sshHost(t.hostId);
      if (!host) return { ok: false, message: 'the SSH host was removed' };
      if (!host.trustedFingerprints.length)
        return { ok: false, message: `${host.name}: host key not trusted (Settings › SSH hosts)` };
      const r = await deps.sshRun(host, sshScript(t), { timeoutMs: 20_000, signal });
      return parseSsh(t, r, host);
    }
    case 'process':
      return checkProcess(m, t, deps);
    case 'compose':
      return checkCompose(m, t, deps, signal);
  }
}

/** One line describing what a monitor checks (for the model and the panel). */
export function describeTarget(t: MonitorTarget, hostName: (id: string) => string | null): string {
  switch (t.kind) {
    case 'http':
      return `GET ${shownUrl(t.url)} (expects ${t.expectedStatus ?? '2xx/3xx'}${t.contains !== null ? ', with expected text' : ''})`;
    case 'ssh': {
      const extra = [
        t.service ? `${t.service} active` : null,
        t.diskPath ? `${t.diskPath} ≤ ${t.diskMaxPercent ?? 100}% full` : null,
      ].filter(Boolean);
      return `SSH ${hostName(t.hostId) ?? '(removed host)'} reachable${extra.length ? `, ${extra.join(', ')}` : ''}`;
    }
    case 'process':
      return `background process "${t.processName}" running`;
    case 'compose':
      return `compose service "${t.service}" running and healthy${t.file ? ` (${t.file})` : ''}`;
  }
}
