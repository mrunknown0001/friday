// Runs the API server and the Vite dev server together; Ctrl+C stops both.
import { spawn } from 'node:child_process';

const procs = [
  ['server', ['run', 'dev', '-w', '@friday/server']],
  ['web', ['run', 'dev', '-w', '@friday/web']],
].map(([name, args]) => {
  const child = spawn('npm', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = (chunk) =>
    chunk
      .toString()
      .split('\n')
      .filter(Boolean)
      .map((line) => `[${name}] ${line}`)
      .join('\n') + '\n';
  child.stdout.on('data', (c) => process.stdout.write(prefix(c)));
  child.stderr.on('data', (c) => process.stderr.write(prefix(c)));
  child.on('exit', (code) => {
    console.log(`[${name}] exited with code ${code}`);
    stopAll();
  });
  return child;
});

let stopping = false;
function stopAll() {
  if (stopping) return;
  stopping = true;
  for (const p of procs) if (p.exitCode === null) p.kill('SIGTERM');
}
process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);
