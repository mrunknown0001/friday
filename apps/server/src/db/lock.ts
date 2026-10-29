import fs from 'node:fs';
import path from 'node:path';
import { ConfigError } from '../config.js';

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Claim the data directory for this process with an exclusive lock file holding our PID. A lock
 * left by a process that no longer exists is replaced. Returns a release function.
 */
export function acquireDataDirLock(dataDir: string): () => void {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, 'friday.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 });
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          if (fs.readFileSync(file, 'utf8') === String(process.pid)) fs.unlinkSync(file);
        } catch {
          // Already gone.
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const pid = Number.parseInt(fs.readFileSync(file, 'utf8'), 10);
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && isRunning(pid)) {
        throw new ConfigError(
          `Another Friday server (pid ${pid}) is already using ${dataDir}. Stop it first, or set FRIDAY_DATA_DIR to a different folder.`,
        );
      }
      fs.rmSync(file, { force: true });
    }
  }
  throw new ConfigError(`Could not lock ${dataDir}.`);
}
