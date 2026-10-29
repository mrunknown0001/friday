import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { SshHostDto } from '@friday/shared';
import { childEnv, runProcess, type RunResult } from '../commands/runner.js';
import type { SshHostRepo, TrustedKey } from '../repositories/devops.js';
import { WorkspaceError } from '../workspace/paths.js';

export const HOST_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
export const HOSTNAME = /^(?!-)[A-Za-z0-9.:-]{1,253}$/;
export const USERNAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/;

/** Single-quote a value for a POSIX shell (the remote side always runs commands through one). */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** ssh-agent is passed through only to ssh processes, never to local commands. */
function sshEnv(): Record<string, string> {
  return process.env.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK } : {};
}

/**
 * ssh options used for every connection. The user's ~/.ssh/config is ignored (no surprise
 * ProxyCommand or forwarding), only key authentication is allowed, and host keys are checked
 * strictly against the fingerprints the user explicitly trusted for this host.
 */
export function sshArgs(host: SshHostDto, knownHostsFile: string): string[] {
  return [
    '-F',
    '/dev/null',
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    `UserKnownHostsFile=${knownHostsFile}`,
    '-o',
    'GlobalKnownHostsFile=/dev/null',
    '-o',
    'PasswordAuthentication=no',
    '-o',
    'KbdInteractiveAuthentication=no',
    '-o',
    'ForwardAgent=no',
    '-o',
    'ForwardX11=no',
    '-o',
    'ClearAllForwardings=yes',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=2',
    '-o',
    'LogLevel=ERROR',
    ...(host.identityFile ? ['-o', 'IdentitiesOnly=yes', '-i', host.identityFile] : []),
    '-p',
    String(host.port),
    '-l',
    host.username,
    '--',
    host.hostname,
  ];
}

export class SshService {
  constructor(
    private readonly hosts: SshHostRepo,
    private readonly dir: string,
  ) {}

  /** Per-host known_hosts containing only keys the user trusted for that host. */
  private async knownHostsFor(host: SshHostDto): Promise<string> {
    const keys = this.hosts.trustedKeys(host.id);
    if (keys.length === 0) {
      throw new WorkspaceError(
        'unsupported',
        `SSH host "${host.name}" has no trusted host key yet. Verify and trust its fingerprint in Settings → SSH hosts.`,
      );
    }
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const file = path.join(this.dir, `known_hosts_${host.id}`);
    await fs.writeFile(file, `${keys.map((k) => k.line).join('\n')}\n`, { mode: 0o600 });
    return file;
  }

  /** Fetch the host's public keys (for the user to verify) without trusting anything. */
  async scan(host: SshHostDto): Promise<TrustedKey[]> {
    const scanned = await new Promise<string>((resolve, reject) =>
      execFile(
        'ssh-keyscan',
        ['-T', '5', '-p', String(host.port), '--', host.hostname],
        { timeout: 15_000, env: childEnv() },
        (err, stdout) =>
          stdout.trim()
            ? resolve(stdout)
            : reject(
                new WorkspaceError(
                  'unsupported',
                  `Could not reach ${host.hostname}:${host.port} (${err?.message.split('\n')[0] ?? 'no keys returned'}).`,
                ),
              ),
      ),
    );
    const lines = scanned.split('\n').filter((l) => l.trim() && !l.startsWith('#'));
    const keys: TrustedKey[] = [];
    for (const line of lines) {
      const fp = await new Promise<string>((resolve) => {
        const child = execFile(
          'ssh-keygen',
          ['-l', '-E', 'sha256', '-f', '-'],
          { timeout: 5_000 },
          (_e, out) => resolve(out),
        );
        child.stdin?.end(`${line}\n`);
      });
      const m = /(SHA256:[A-Za-z0-9+/=]+)\s+.*\((\w+)\)/.exec(fp);
      if (m) keys.push({ fingerprint: `${m[2]} ${m[1]}`, line });
    }
    if (keys.length === 0)
      throw new WorkspaceError('unsupported', 'The host returned no usable keys.');
    return keys;
  }

  async trust(host: SshHostDto, fingerprint: string): Promise<SshHostDto> {
    const keys = await this.scan(host);
    const match = keys.find((k) => k.fingerprint === fingerprint);
    if (!match) {
      throw new WorkspaceError(
        'unsupported',
        'That fingerprint is not offered by the host right now. Scan again and compare.',
      );
    }
    const existing = this.hosts.trustedKeys(host.id).filter((k) => k.fingerprint !== fingerprint);
    this.hosts.setTrusted(host.id, [...existing, match]);
    return this.hosts.get(host.id)!;
  }

  async run(
    host: SshHostDto,
    command: string,
    opts: { timeoutMs: number; signal: AbortSignal; onOutput?: (c: string) => void },
  ): Promise<RunResult> {
    const knownHosts = await this.knownHostsFor(host);
    return runProcess({
      argv: ['ssh', ...sshArgs(host, knownHosts), command],
      shellCommand: null,
      cwd: this.dir,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      extraEnv: sshEnv(),
      ...(opts.onOutput ? { onOutput: opts.onOutput } : {}),
    });
  }
}

/** Explain an ssh failure (exit 255) in terms the user can act on. */
export function explainSshFailure(output: string): string {
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(output)) {
    return 'Host key verification failed: the server key does not match the trusted fingerprint. Do not proceed until you have checked why.';
  }
  if (/Permission denied/i.test(output))
    return 'Authentication failed (key not accepted). Check the user and key.';
  if (/Connection refused|timed out|No route|Could not resolve/i.test(output))
    return 'Could not connect to the host.';
  return 'SSH failed.';
}
