import { execFile } from 'node:child_process';

export interface ToolEnvironment {
  /** Executable name for ripgrep if available, else null. */
  ripgrep: string | null;
  ripgrepVersion: string | null;
}

/** Detect optional executables once at startup. Missing tools degrade features; they never fail startup. */
export function detectToolEnvironment(): Promise<ToolEnvironment> {
  return new Promise((resolve) => {
    execFile('rg', ['--version'], { timeout: 5_000 }, (err, stdout) => {
      if (err) return resolve({ ripgrep: null, ripgrepVersion: null });
      resolve({ ripgrep: 'rg', ripgrepVersion: stdout.split('\n')[0]?.trim() ?? 'rg' });
    });
  });
}
