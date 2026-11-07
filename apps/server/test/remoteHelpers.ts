import type { SshHostDto } from '@friday/shared';
import { runProcess } from '../src/commands/runner.js';
import { execSsh } from '../src/ssh/ssh.js';
import type { RemoteTransport } from '../src/workspace/remote.js';

export const fakeHost = (over: Partial<SshHostDto> = {}): SshHostDto => ({
  id: '00000000-0000-4000-8000-0000000000aa',
  name: 'web-1',
  hostname: '203.0.113.10',
  port: 22,
  username: 'deploy',
  identityFile: null,
  environment: 'staging',
  trustedFingerprints: ['ED25519 SHA256:test'],
  createdAt: '2026-11-07T10:00:00.000Z',
  ...over,
});

/**
 * A transport that runs the command with the local `sh` instead of ssh: the scripts, quoting and
 * parsing are exercised for real, only the network hop is skipped. `calls` records each command.
 */
export function localTransport(host: SshHostDto = fakeHost(), cwd = process.cwd()) {
  const calls: string[] = [];
  const transport: RemoteTransport = {
    host,
    exec: (command, opts) => {
      calls.push(command);
      return execSsh(['sh', '-c', command], cwd, opts);
    },
    run: (command, opts) => {
      calls.push(command);
      return runProcess({ argv: ['sh', '-c', command], shellCommand: null, cwd, ...opts });
    },
  };
  return { transport, calls };
}
