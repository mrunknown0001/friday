/**
 * Reading a GitHub Actions job log: strip timestamps and colours, split it into steps, and find
 * the first line that is an actual error, not the runner's closing "Process completed with exit
 * code 1".
 */

const TIMESTAMP = /^\uFEFF?\d{4}-\d\d-\d\dT[\d:.]+Z ?/;
// eslint-disable-next-line no-control-regex -- terminal colour codes are what this removes
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*\u0007/g;

export function cleanLog(raw: string): string[] {
  return raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(TIMESTAMP, '').replace(ANSI, ''));
}

export interface LogStep {
  /** What the step ran: the command, or the action it used. */
  title: string;
  /** Index of its first line in the cleaned log. */
  start: number;
  end: number;
}

/** Steps start at "##[group]Run …" lines; everything before the first is runner setup. */
export function splitSteps(lines: string[]): LogStep[] {
  const steps: LogStep[] = [];
  lines.forEach((l, i) => {
    const m = /^##\[group\]Run (.*)$/.exec(l);
    if (!m) return;
    if (steps.length) steps.at(-1)!.end = i;
    steps.push({ title: m[1]!.trim(), start: i, end: lines.length });
  });
  return steps;
}

/** Lines that are a real error from a test runner, compiler, linter, package manager or shell. */
const SPECIFIC_ERROR = [
  /^\s*(FAIL|FAILED|FAILURE)\b/,
  /^\s*--- FAIL:/, // go test
  /^\s*(×|✗|✕|✖)\s/, // vitest, jest, mocha
  /\b(Error|AssertionError|TypeError|ReferenceError|SyntaxError|RangeError)\b(\s\[[\w-]+\])?:/,
  /\berror TS\d+:/i, // tsc
  /^\s*error(\[\w+\])?:/i, // rust, generic
  /^\s*\S+:\d+:\d+:?\s+(error|Error)\b/, // file:line:col: error
  /^\s*\d+:\d+\s+error\s/, // eslint stylish
  /^npm (ERR!|error)/,
  /\bERR_PNPM_\w+/,
  /^Traceback \(most recent call last\):/,
  /^E\s{3}/, // pytest
  /^\s*panic:/,
  /^fatal:/,
  /^##\[error\](?!Process completed with exit code)/,
];

const GENERIC_END = /^##\[error\]Process completed with exit code \d+/;

export interface Failure {
  step: string;
  /** The excerpt, around the first real error (or the end of the failing step). */
  excerpt: string[];
  /** Whether a specific error line was found, or this is just the end of the step. */
  specific: boolean;
  /** "##[error]" messages other than the generic exit code one. */
  errors: string[];
}

const BEFORE = 3;
const AFTER = 45;
const MAX_LINES = 80;
const MAX_CHARS = 8_000;

function clip(lines: string[]): string[] {
  const out: string[] = [];
  let size = 0;
  for (const l of lines) {
    const line = l.length > 400 ? `${l.slice(0, 400)} […]` : l;
    if (out.length >= MAX_LINES || size + line.length > MAX_CHARS) {
      out.push('[…]');
      break;
    }
    out.push(line);
    size += line.length + 1;
  }
  return out;
}

const noise = (l: string) => /^##\[(group|endgroup)\]/.test(l) || /^\s*$/.test(l);

/** The first real failure in a job log, or null when the log shows none. */
export function firstFailure(raw: string): Failure | null {
  const lines = cleanLog(raw);
  const steps = splitSteps(lines);
  const errorAt = lines.findIndex((l) => l.startsWith('##[error]'));
  if (errorAt < 0) return null;
  const step = steps.findLast((s) => s.start <= errorAt) ?? {
    title: 'job setup',
    start: 0,
    end: lines.length,
  };
  // The failing step ends where the runner reports the exit code (or the next step starts).
  const endAt = lines.findIndex((l, i) => i >= errorAt && GENERIC_END.test(l));
  const stop = endAt >= 0 ? Math.min(endAt, step.end) : step.end;
  const body = lines.slice(step.start + 1, stop);

  // Skip the step's own echo of its script (the "##[group]Run" header block).
  const shellEnd = body.findIndex((l) => l.startsWith('##[endgroup]'));
  const from = shellEnd >= 0 && shellEnd < 40 ? shellEnd + 1 : 0;
  const hit = body.findIndex((l, i) => i >= from && SPECIFIC_ERROR.some((re) => re.test(l)));

  const errors = lines
    .filter((l) => l.startsWith('##[error]') && !GENERIC_END.test(l))
    .map((l) => l.slice('##[error]'.length))
    .slice(0, 10);

  if (hit >= 0) {
    const excerpt = body
      .slice(Math.max(from, hit - BEFORE), hit + AFTER)
      .filter((l) => !noise(l) || l === '');
    return { step: step.title, excerpt: clip(trimBlank(excerpt)), specific: true, errors };
  }
  const tail = body.slice(from).filter((l) => !noise(l));
  return { step: step.title, excerpt: clip(tail.slice(-40)), specific: false, errors };
}

function trimBlank(lines: string[]): string[] {
  let a = 0;
  let b = lines.length;
  while (a < b && !lines[a]!.trim()) a++;
  while (b > a && !lines[b - 1]!.trim()) b--;
  return lines.slice(a, b);
}

/**
 * CI runners check the repository out under their own workspace folder; turn those paths into
 * project-relative ones so they can be matched against the project.
 */
export function relativizeRunnerPaths(text: string): string {
  return text
    .replace(/(?:\/home\/runner\/work|\/Users\/runner\/work)\/[^/\s]+\/[^/\s]+\//g, '')
    .replace(/[A-Z]:\\a\\[^\\\s]+\\[^\\\s]+\\/g, '')
    .replace(/\/__w\/[^/\s]+\/[^/\s]+\//g, '');
}
