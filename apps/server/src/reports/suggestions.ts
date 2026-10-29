import type { NextStep, PlanStep, RunReport } from '@friday/shared';
import type { Redactor } from '../security/redact.js';

export interface SuggestionInput {
  report: RunReport | null;
  plan: PlanStep[] | null;
  /** User-scope memories this run proposed that await approval. */
  pendingMemories: number;
  /** The project's test command, if one was detected (e.g. "npm test"). */
  testCommand: string | null;
  /** Files with uncommitted changes, when the project is a git repository. */
  uncommitted: string[] | null;
  /** First project location referenced by the failing check's output. */
  failureLocation: string | null;
  /** Follow-ups the model proposed with suggest_next_steps. */
  modelSteps: Array<{ label: string; prompt: string }>;
}

const MAX_TOTAL = 5;
const MAX_RECORDS = 4;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
function overlaps(a: string, b: string): boolean {
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return false;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / Math.min(A.size, B.size) >= 0.6;
}

/** Coarse intent of a suggestion, so a model chip never duplicates a record chip in other words. */
function intent(text: string): string | null {
  const t = text.toLowerCase();
  if (/\bcommit/.test(t)) return 'commit';
  if (/\b(re-?)?run\b.*\b(tests?|specs?|suite|checks?)\b|\bverify\b/.test(t)) return 'test';
  if (/\bfix\b.*\b(failing|failure|error|check|test)/.test(t)) return 'fix';
  if (/\bmemor(y|ies)\b/.test(t)) return 'memory';
  return null;
}

/**
 * Follow-up chips for a completed run. Record-based chips come first: they are derived from what
 * actually happened (verification status, git state, plan, pending memories), so they stay
 * accurate even when the model's own summary is not. Model proposals fill the remaining slots.
 */
export function buildSuggestions(input: SuggestionInput, redactor: Redactor): NextStep[] {
  const records: NextStep[] = [];
  const add = (label: string, prompt: string, action: NextStep['action'] = 'prompt') =>
    records.push({ label: clip(label, 40), prompt, action, source: 'records' });
  const report = input.report;
  const active = report?.files.filter((f) => !f.reverted) ?? [];

  if (report?.status === 'failed') {
    const last = [...report.commands].reverse().find((c) => c.verification && c.afterLastChange);
    add(
      'Fix the failing check',
      `\`${last?.title ?? 'The last check'}\` failed after your last change (${last?.result ?? 'non-zero exit'}).${input.failureLocation ? ` Start from ${input.failureLocation}.` : ''} Find the cause in the output, fix it, and run the check again.`,
    );
  } else if (report?.status === 'unverified') {
    add(
      input.testCommand ? `Run ${input.testCommand}` : 'Run the tests',
      `Run ${input.testCommand ? `\`${input.testCommand}\`` : "the project's tests"} now and report the actual result.`,
    );
  }

  const drifted = active.filter((f) => f.modifiedSince).map((f) => f.path);
  if (drifted.length) {
    add(
      'Re-check edited files',
      `These files were changed outside Friday after your edit: ${drifted.join(', ')}. Re-read them and confirm your change still holds.`,
    );
  }

  const changedPaths = active.map((f) => f.path);
  if (
    report?.status !== 'failed' &&
    report?.commits.length === 0 &&
    input.uncommitted &&
    changedPaths.some((p) => input.uncommitted!.includes(p))
  ) {
    add(
      'Review & commit',
      'Show me a summary of the diff for the files you changed, then propose a commit with a clear message.',
    );
  }

  const next = input.plan?.find((s) => s.status === 'pending' || s.status === 'in_progress');
  if (next && report?.status !== 'failed')
    add(`Next: ${next.title}`, `Continue with the next step of the plan: ${next.title}.`);

  if (input.pendingMemories > 0) {
    add(
      `Review ${input.pendingMemories} proposed ${input.pendingMemories === 1 ? 'memory' : 'memories'}`,
      '',
      'open_memory',
    );
  }

  const out = records.slice(0, MAX_RECORDS);
  for (const s of input.modelSteps) {
    if (out.length >= MAX_TOTAL) break;
    const label = clip(redactor.redact(s.label.trim()), 40);
    const prompt = redactor.redact(s.prompt.trim());
    if (label.length < 2 || prompt.length < 5) continue;
    const kind = intent(`${label} ${prompt}`);
    if (kind && out.some((o) => intent(`${o.label} ${o.prompt}`) === kind)) continue;
    if (out.some((o) => overlaps(o.label, label) || (o.prompt && overlaps(o.prompt, prompt))))
      continue;
    out.push({ label, prompt, action: 'prompt', source: 'model' });
  }
  return out;
}
