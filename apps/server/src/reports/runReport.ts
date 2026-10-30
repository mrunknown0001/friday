import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { PlanStep, RunCheckpoint, RunReport } from '@friday/shared';
import { isVerificationCommand } from '../commands/locations.js';
import type { ApprovalRepo } from '../repositories/approvals.js';
import type { CaptureRepo } from '../repositories/captures.js';
import type { FileChangeRepo } from '../repositories/fileChanges.js';
import type { ProjectRepo } from '../repositories/projects.js';
import type { RunRepo } from '../repositories/runs.js';
import { displayArgv } from '../tools/commandTool.js';

export interface ReportDeps {
  approvalRepo: ApprovalRepo;
  captures?: CaptureRepo;
  fileChanges: FileChangeRepo;
  projects: ProjectRepo;
  runs: RunRepo;
}

const UNFINISHED = new Set(['interrupted', 'failed', 'blocked', 'cancelled']);

/**
 * A task can span several runs: an attempt that was interrupted, failed or blocked, followed by
 * a resume. Returns the ids of the unfinished attempts this run continues, oldest first, plus the
 * run itself, so reports and rollbacks cover the whole task.
 */
export function taskRunIds(runId: string, runs: RunRepo): string[] {
  const ids = [runId];
  let current = runs.get(runId);
  for (let i = 0; current && i < 20; i++) {
    const prev = runs.previousRun(current.sessionId, current.startedAt);
    if (!prev || !UNFINISHED.has(prev.status)) break;
    ids.unshift(prev.id);
    current = prev;
  }
  return ids;
}

function currentHash(abs: string): string | null {
  try {
    return createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
  } catch {
    return null;
  }
}

/** Tools whose approvals are commands (run_tests builds its own test command). */
const COMMAND_TOOLS = new Set(['run_command', 'run_tests']);

const exitCodeOf = (summary: string | null): number | null => {
  const m = /^exit code (\d+)/.exec(summary ?? '');
  return m ? Number(m[1]) : null;
};

/**
 * Build a verification report for a run purely from Friday's records: applied file changes, the
 * commands that actually ran and their exit codes, and commits. The model's own claims are not
 * consulted, so the report stays truthful even when the final answer is not.
 */
export function buildRunReport(runId: string, deps: ReportDeps): RunReport {
  const chain = taskRunIds(runId, deps.runs);
  const approvals = chain.flatMap((id) => deps.approvalRepo.listByRun(id));
  const changes = chain.flatMap((id) => deps.fileChanges.listByRun(id)).sort((a, b) => a.id - b.id);

  // Latest record per path decides what the file should look like now.
  const latestByPath = new Map<string, (typeof changes)[number]>();
  for (const c of changes) latestByPath.set(c.path, c);
  const files: RunReport['files'] = changes.map((c) => {
    let modifiedSince = false;
    const root = deps.projects.get(c.projectId)?.rootPath;
    if (!c.revertedAt && root && latestByPath.get(c.path) === c) {
      const now = currentHash(path.join(root, c.path));
      modifiedSince = now !== c.afterHash;
    }
    return {
      path: c.path,
      change: c.change,
      fromPath: c.fromPath,
      reverted: c.revertedAt !== null,
      modifiedSince,
    };
  });

  const active = changes.filter((c) => !c.revertedAt);
  const lastChangeAt = active.at(-1)?.createdAt ?? null;

  const commands: RunReport['commands'] = approvals
    .filter(
      (a) => COMMAND_TOOLS.has(a.toolName) && (a.status === 'executed' || a.status === 'failed'),
    )
    .map((a) => {
      const d = a.details;
      const full =
        d.kind === 'command' ? (d.argv ? displayArgv(d.argv) : (d.shellCommand ?? '')) : a.title;
      return {
        title: full,
        result: a.resultSummary ?? a.status,
        exitCode: exitCodeOf(a.resultSummary),
        verification: isVerificationCommand(full),
        afterLastChange: lastChangeAt !== null && a.createdAt > lastChangeAt,
      };
    });

  const commits = approvals
    .filter((a) => a.toolName === 'git_commit' && a.status === 'executed')
    .map((a) => {
      const msg = a.details.kind === 'git' ? (a.details.message ?? '').split('\n')[0] : '';
      return `${(a.resultSummary ?? '').replace(/^committed /, '')} ${msg}`.trim();
    });

  const comparisons = deps.captures?.comparisons(chain) ?? [];
  const visuals = comparisons.length ? { visuals: comparisons } : {};

  const drifted = files.filter((f) => f.modifiedSince).length;
  const driftNote = drifted
    ? ` ${drifted} file(s) no longer match what Friday wrote (edited elsewhere since).`
    : '';

  if (active.length === 0) {
    return {
      status: 'no_changes',
      note: changes.length
        ? 'All file changes from this task were undone.'
        : 'This task did not change any files.',
      files,
      commands,
      commits,
      ...visuals,
    };
  }
  const checks = commands.filter((c) => c.verification && c.afterLastChange);
  const last = checks.at(-1);
  if (!last) {
    return {
      status: 'unverified',
      note: `Files changed, but no test, build, lint or type-check command ran after the last change.${driftNote}`,
      files,
      commands,
      commits,
      ...visuals,
    };
  }
  const passed = last.exitCode === 0;
  const earlierFailures = checks.slice(0, -1).filter((c) => c.exitCode !== 0).length;
  return {
    status: passed ? 'verified' : 'failed',
    note: passed
      ? `\`${last.title}\` passed after the last change${earlierFailures ? ` (${earlierFailures} earlier check(s) failed)` : ''}.${driftNote}`
      : `\`${last.title}\` did not pass after the last change (${last.result}).${driftNote}`,
    files,
    commands,
    commits,
    ...visuals,
  };
}

export function buildCheckpoint(
  runId: string,
  deps: ReportDeps,
  progress: { iteration: number; toolCalls: number; plan: PlanStep[] | null },
): RunCheckpoint {
  const commands = deps.approvalRepo
    .listByRun(runId)
    .filter(
      (a) => COMMAND_TOOLS.has(a.toolName) && (a.status === 'executed' || a.status === 'failed'),
    );
  const last = commands.at(-1);
  return {
    iteration: progress.iteration,
    toolCalls: progress.toolCalls,
    filesChanged: [
      ...new Set(
        deps.fileChanges
          .listByRun(runId)
          .filter((c) => !c.revertedAt)
          .map((c) => c.path),
      ),
    ],
    lastCommand: last
      ? { title: last.title.replace(/^Run: /, ''), result: last.resultSummary ?? last.status }
      : null,
    plan: progress.plan,
    updatedAt: new Date().toISOString(),
  };
}

/** Context for the model when a request is continued after an unfinished run. */
export function resumeContext(
  status: string,
  errorMessage: string | null,
  report: RunReport,
  plan: PlanStep[] | null,
): string | null {
  if (report.files.length === 0 && report.commands.length === 0 && report.commits.length === 0)
    return null;
  const lines = [
    '## Resuming earlier work',
    `The previous attempt ended with status "${status}"${errorMessage ? ` (${errorMessage})` : ''}. Friday's records show:`,
  ];
  const kept = report.files.filter((f) => !f.reverted);
  const undone = report.files.filter((f) => f.reverted);
  if (kept.length) {
    lines.push(
      `- Files changed and still in place: ${kept.map((f) => `${f.path}${f.modifiedSince ? ' (edited elsewhere since)' : ''}`).join(', ')}`,
    );
  }
  if (undone.length)
    lines.push(`- Changes undone by the user: ${undone.map((f) => f.path).join(', ')}`);
  for (const c of report.commands.slice(-5)) lines.push(`- Ran \`${c.title}\`: ${c.result}`);
  for (const c of report.commits) lines.push(`- Committed ${c}`);
  if (plan?.length)
    lines.push(
      `- Plan: ${plan.map((p) => `[${p.status === 'completed' ? 'x' : ' '}] ${p.title}`).join('; ')}`,
    );
  lines.push(
    'Continue from here: do not redo finished steps, re-read any file listed above before relying on it, and run verification again before reporting success.',
  );
  return lines.join('\n');
}
