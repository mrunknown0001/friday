import type { ProjectDto, SshHostDto } from '@friday/shared';
import type { ProjectRecord } from '../repositories/projects.js';
import type { SshHostRepo } from '../repositories/devops.js';
import type { SshService } from '../ssh/ssh.js';
import { assertRootAvailable, WorkspaceError } from './paths.js';
import { remoteTarget, RemoteWorkspace, type RemoteTransport } from './remote.js';
import type { Proposal } from '../tools/types.js';

/**
 * The project when its files are on this machine, else null. Code that reads the local disk at
 * the project's path uses this: for a project on an SSH host that path is on the server, and a
 * folder with the same path here must never be mistaken for it.
 */
export function localProject<T extends { sshHostId: string | null }>(
  p: T | null | undefined,
): T | null {
  return p && !p.sshHostId ? p : null;
}

/** What reaching a project on an SSH host needs. */
export interface SshAccess {
  hosts: SshHostRepo;
  ssh: SshService;
}

export function transportFor(ssh: SshService, host: RemoteTransport['host']): RemoteTransport {
  return {
    host,
    exec: (command, opts) => ssh.exec(host, command, opts),
    run: (command, opts) => ssh.run(host, command, opts),
  };
}

/**
 * The remote workspace of a project on an SSH host, or null for a project on this machine.
 * Refused when the host is gone or no longer trusted.
 */
export function remoteFor(
  project: Pick<ProjectRecord, 'rootPath' | 'sshHostId'>,
  access: SshAccess | undefined,
): RemoteWorkspace | null {
  if (!project.sshHostId) return null;
  if (!access)
    throw new WorkspaceError('unsupported', 'Projects on SSH hosts are not available here.');
  const host = access.hosts.get(project.sshHostId);
  if (!host) throw new WorkspaceError('root_unavailable', "This project's SSH host was removed.");
  if (host.trustedFingerprints.length === 0) {
    throw new WorkspaceError(
      'root_unavailable',
      `SSH host "${host.name}" has no trusted host key. Verify and trust its fingerprint in Settings → SSH hosts.`,
    );
  }
  return new RemoteWorkspace(project.rootPath, transportFor(access.ssh, host));
}

const PRODUCTION_TTL_MS = 5 * 60_000;

/**
 * Mark a proposed change in a project on an SSH host: its details name the host, and on a
 * production host approving it needs the host name typed (so it is never covered by "allow
 * similar"), within five minutes.
 */
export function markRemoteProposal(proposal: Proposal, host: SshHostDto): void {
  const d = proposal.details;
  if (d.kind === 'file_change' || d.kind === 'command' || d.kind === 'git') {
    d.remote = remoteTarget(host);
  }
  if (host.environment === 'production') {
    proposal.confirmationRequired = host.name;
    proposal.approvalTtlMs = Math.min(
      proposal.approvalTtlMs ?? PRODUCTION_TTL_MS,
      PRODUCTION_TTL_MS,
    );
  }
}

/**
 * A project for the web. A project on an SSH host counts as available while its host exists and
 * is trusted: reaching the server is checked when it is used, not on every list.
 */
export async function projectDto(p: ProjectRecord, hosts: SshHostRepo): Promise<ProjectDto> {
  const { sshHostId, ...rest } = p;
  if (sshHostId) {
    const host = hosts.get(sshHostId);
    return {
      ...rest,
      available: !!host && host.trustedFingerprints.length > 0,
      remote: host ? remoteTarget(host) : null,
    };
  }
  return {
    ...rest,
    available: await assertRootAvailable(p.rootPath).then(
      () => true,
      () => false,
    ),
    remote: null,
  };
}
