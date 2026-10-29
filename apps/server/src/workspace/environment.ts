import { execFile } from 'node:child_process';
import { dockerVersion } from '../sandbox/docker.js';

export interface ToolEnvironment {
  /** Executable name for ripgrep if available, else null. */
  ripgrep: string | null;
  ripgrepVersion: string | null;
  /** Docker server version when reachable (needed for the command sandbox), else null. */
  docker: string | null;
  /** Label for this server's sandbox containers, so cleanup never touches anyone else's. */
  sandboxInstance: string;
}

function ripgrep(): Promise<Pick<ToolEnvironment, 'ripgrep' | 'ripgrepVersion'>> {
  return new Promise((resolve) => {
    execFile('rg', ['--version'], { timeout: 5_000 }, (err, stdout) => {
      if (err) return resolve({ ripgrep: null, ripgrepVersion: null });
      resolve({ ripgrep: 'rg', ripgrepVersion: stdout.split('\n')[0]?.trim() ?? 'rg' });
    });
  });
}

/** Detect optional executables once at startup. Missing tools degrade features; they never fail startup. */
export async function detectToolEnvironment(sandboxInstance = 'default'): Promise<ToolEnvironment> {
  const [rg, docker] = await Promise.all([ripgrep(), dockerVersion()]);
  return { ...rg, docker, sandboxInstance };
}
