import fs from 'node:fs';
import path from 'node:path';
import { isSecretPath, isWithin } from '../workspace/paths.js';

const LOCATION =
  /(?:^|[\s('"`[])((?:file:\/\/)?(?:[A-Za-z]:)?[\w@.~/\\-]*[\w-]\.[A-Za-z][A-Za-z0-9]{0,5}):(\d{1,6})(?::(\d{1,5}))?/gm;
const SKIP = /(^|\/)(node_modules|vendor|dist|build|\.git)\//;

/**
 * Find `file:line[:col]` references in tool output (stack traces, compiler and test errors) that
 * point at real files inside the project. Paths are resolved against the command's working
 * directory; anything outside the root, in dependency folders, or a credential file is ignored.
 */
export function extractLocations(output: string, root: string, cwd: string, max = 10): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const m of output.matchAll(LOCATION)) {
    const raw = m[1]!.replace(/^file:\/\//, '');
    const abs = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(cwd, raw);
    if (!isWithin(root, abs)) continue;
    const rel = path.relative(root, abs).split(path.sep).join('/');
    if (!rel || SKIP.test(rel) || isSecretPath(rel)) continue;
    const key = `${rel}:${m[2]}`;
    if (seen.has(key)) continue;
    try {
      if (!fs.statSync(abs).isFile()) continue;
    } catch {
      continue;
    }
    seen.add(key);
    found.push(m[3] ? `${key}:${m[3]}` : key);
    if (found.length >= max) break;
  }
  return found;
}

const INTERPRETER = /^(node|deno|bun|tsx|ts-node|python3?|php|ruby)$/;
const TEST_FILE =
  /^(tests?|spec)([._-][\w.-]*)?\.(m?[jt]sx?|cjs|py|php|rb)$|[._-](test|spec)\.(m?[jt]sx?|cjs|py|php|rb)$|^test_[\w-]+\.py$/;

const IN_TEST_DIR = /(^|\/)(tests?|spec|__tests__)\/[\w./-]+\.(m?[jt]sx?|cjs|py|php|rb)$/;

/** A test file run directly, e.g. `node test.js`, `python tests/test_cart.py`, `bun cart.test.ts`. */
function runsTestFile(c: string): boolean {
  const words = c.split(/\s+/);
  const exe = words[0]?.split('/').at(-1) ?? '';
  return (
    INTERPRETER.test(exe) &&
    words.slice(1).some((w) => TEST_FILE.test(w.split('/').at(-1) ?? '') || IN_TEST_DIR.test(w))
  );
}

/** Commands that check correctness: tests, builds, linters, type checkers. */
export function isVerificationCommand(command: string): boolean {
  const c = command.toLowerCase();
  return (
    runsTestFile(c.trim()) ||
    /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|build|lint|typecheck|type-check|check|verify|ci)\b/.test(
      c,
    ) ||
    /\b(vitest|jest|mocha|ava|playwright|cypress)\b/.test(c) ||
    /\bnode\s+(--test|--run\s+test)\b/.test(c) ||
    /\b(tsc|eslint|prettier\s+--check|biome\s+(check|lint)|ruff|mypy|flake8|pylint|black\s+--check)\b/.test(
      c,
    ) ||
    /\b(pytest|phpunit|pest|rspec|minitest)\b/.test(c) ||
    /\bphp\s+artisan\s+test\b/.test(c) ||
    /\bcomposer\s+(test|check|analyse|lint)\b/.test(c) ||
    /\bphpstan\b|\bpsalm\b/.test(c) ||
    /\b(go\s+(test|build|vet)|cargo\s+(test|build|check|clippy))\b/.test(c) ||
    /\b(mvn|gradle|\.\/gradlew)\b.*\b(test|build|verify|check)\b/.test(c) ||
    /\bmake\s+(test|check|build|lint)\b/.test(c) ||
    /\bdotnet\s+(test|build)\b/.test(c)
  );
}
