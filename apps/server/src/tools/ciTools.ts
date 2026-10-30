import { z } from 'zod';
import { firstFailure, relativizeRunnerPaths, type Failure } from '../ci/logs.js';
import { extractLocations } from '../commands/locations.js';
import { assertRepoRoot, runGit } from '../git/git.js';
import { ghApiGet, ghReady, projectGitHubRepo, type GitHubRepo } from '../git/github.js';
import { assertRootAvailable, isSecretPath, WorkspaceError } from '../workspace/paths.js';
import { defineTool, type ToolContext } from './types.js';

/**
 * Reading the project's GitHub Actions runs and logs with the user's own gh sign-in. GET requests
 * only; nothing here can re-run, cancel or change anything on GitHub.
 */

interface Run {
  id: number;
  name: string | null;
  display_title: string;
  head_branch: string | null;
  head_sha: string;
  status: string;
  conclusion: string | null;
  event: string;
  created_at: string;
  html_url: string;
  run_attempt?: number;
}

interface Job {
  id: number;
  name: string;
  conclusion: string | null;
  steps?: Array<{ number: number; name: string; conclusion: string | null }>;
}

interface Annotation {
  path: string;
  start_line: number;
  annotation_level: string;
  title: string | null;
  message: string;
}

const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);

async function setup(ctx: ToolContext) {
  if (!ctx.project)
    throw new WorkspaceError('unsupported', 'This conversation is not attached to a project.');
  const root = ctx.project.rootPath;
  await assertRootAvailable(root);
  await assertRepoRoot(root);
  const { repo } = await projectGitHubRepo(root);
  await ghReady(repo, ctx.signal, 'CI runs are read from GitHub Actions');
  return { root, repo };
}

async function getJson<T>(repo: GitHubRepo, path: string, signal: AbortSignal): Promise<T | null> {
  const body = await ghApiGet(repo, `repos/${repo.owner}/${repo.name}/${path}`, { signal });
  return body === null ? null : (JSON.parse(body) as T);
}

const when = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
const short = (sha: string) => sha.slice(0, 7);

async function currentBranch(root: string): Promise<string | null> {
  const r = await runGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return r.code === 0 ? r.stdout.trim() : null;
}

/** How the commit a run tested relates to the local checkout. */
async function relation(root: string, sha: string): Promise<string> {
  const head = (await runGit(root, ['rev-parse', 'HEAD'])).stdout.trim();
  if (head === sha) return 'The run tested exactly your current commit.';
  if ((await runGit(root, ['cat-file', '-e', `${sha}^{commit}`])).code !== 0)
    return `The run tested ${short(sha)}, which is not in your local history (fetch to get it).`;
  if ((await runGit(root, ['merge-base', '--is-ancestor', sha, 'HEAD'])).code === 0) {
    const n = (await runGit(root, ['rev-list', '--count', `${sha}..HEAD`])).stdout.trim();
    return `The run tested ${short(sha)}; your HEAD is ${n} commit(s) newer, so the failure may already be fixed or changed locally.`;
  }
  return `The run tested ${short(sha)}, which is not an ancestor of your HEAD (${short(head)}): compare before relying on line numbers.`;
}

function runLine(r: Run, head: string): string {
  const result = r.status === 'completed' ? (r.conclusion ?? 'completed') : r.status;
  return `#${r.id} ${result} · ${r.name ?? 'workflow'} · "${r.display_title}" · ${r.head_branch ?? '?'} @ ${short(r.head_sha)}${r.head_sha === head ? ' (your HEAD)' : ''} · ${r.event} · ${when(r.created_at)}`;
}

export const ciRuns = defineTool({
  name: 'ci_runs',
  description:
    "List the project's recent GitHub Actions runs (newest first): workflow, result, branch and commit, and which one tested your current commit. Read-only, through the user's own gh sign-in. Use ci_failure to see why a run failed.",
  category: 'read_only',
  risk: 'none',
  requiresProject: true,
  schema: z.object({
    branch: z
      .string()
      .regex(/^(?!-)[A-Za-z0-9._/-]{1,200}$/)
      .optional()
      .describe('Defaults to the current branch. Use "*" for every branch.'),
    status: z.enum(['any', 'failure', 'success', 'in_progress']).default('any'),
    limit: z.number().int().min(1).max(20).default(10),
  }),
  describeCall: (a) => [a.branch, a.status !== 'any' ? a.status : null].filter(Boolean).join(' '),
  async execute(args, ctx) {
    const { root, repo } = await setup(ctx);
    const branch = args.branch === '*' ? null : (args.branch ?? (await currentBranch(root)));
    const q = new URLSearchParams({ per_page: String(args.limit) });
    if (branch) q.set('branch', branch);
    if (args.status !== 'any') q.set('status', args.status);
    const data = await getJson<{ workflow_runs: Run[] }>(repo, `actions/runs?${q}`, ctx.signal);
    const runs = data?.workflow_runs ?? [];
    const scope = `${repo.owner}/${repo.name}${branch ? ` on ${branch}` : ''}`;
    if (!runs.length)
      return {
        content: `No ${args.status === 'any' ? '' : `${args.status} `}GitHub Actions runs for ${scope}.`,
        summary: 'no runs',
      };
    const head = (await runGit(root, ['rev-parse', 'HEAD'])).stdout.trim();
    const failed = runs.filter((r) => FAILED.has(r.conclusion ?? '')).length;
    return {
      content: [
        `GitHub Actions runs for ${scope} (newest first):`,
        ...runs.map((r) => runLine(r, head)),
      ].join('\n'),
      summary: `${runs.length} run${runs.length === 1 ? '' : 's'}${failed ? `, ${failed} failed` : ''}`,
    };
  },
});

/** Path:line mentions in the error that are not files at the project root (monorepo packages). */
function unresolvedMentions(text: string, resolved: string[]): string[] {
  const known = new Set(resolved.map((r) => r.split(':')[0]));
  const out = new Set<string>();
  for (const m of text.matchAll(/(?:^|[\s(])((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z]{1,6}):(\d+)/g)) {
    const p = m[1]!;
    if (!known.has(p) && !/^https?/.test(p)) out.add(`${p}:${m[2]}`);
    if (out.size >= 8) break;
  }
  return [...out];
}

/**
 * CI often runs inside a package folder, so "test/a.test.ts" may be "packages/x/test/a.test.ts"
 * here: match the project's tracked files by suffix, and name the file when only a few fit.
 */
async function bySuffix(root: string, mentions: string[]): Promise<string[]> {
  if (!mentions.length) return [];
  const files = (await runGit(root, ['ls-files', '-z'])).stdout.split('\0').filter(Boolean);
  const out: string[] = [];
  for (const mention of mentions) {
    const [p, line] = mention.split(':');
    const hits = files.filter((f) => f.endsWith(`/${p}`) && !isSecretPath(f));
    if (hits.length >= 1 && hits.length <= 3)
      out.push(`${mention} → ${hits.map((h) => `${h}:${line}`).join(' or ')}`);
  }
  return out;
}

async function failureSection(
  job: Job,
  failure: Failure | null,
  annotations: Annotation[],
  root: string,
): Promise<{ text: string; locations: string[] }> {
  const failedStep = job.steps?.find((s) => FAILED.has(s.conclusion ?? ''));
  const head = `Job "${job.name}"${failedStep ? `, step ${failedStep.number} "${failedStep.name}"` : ''}:`;
  if (!failure)
    return {
      text: `${head}\nThe log shows no error line (it may have expired, or the job was cancelled before running).`,
      locations: [],
    };
  const excerpt = relativizeRunnerPaths(failure.excerpt.join('\n'));
  const notes = annotations
    .filter((a) => a.path !== '.github' && !/^Process completed with exit code/.test(a.message))
    .slice(0, 15)
    .map(
      (a) =>
        `- ${relativizeRunnerPaths(a.path)}:${a.start_line} ${a.annotation_level}: ${a.title ? `${a.title}: ` : ''}${a.message.split('\n')[0]!.slice(0, 300)}`,
    );
  const fromAnnotations = notes.join('\n');
  const locations = extractLocations(`${excerpt}\n${fromAnnotations}`, root, root, 10);
  const parts = [
    head,
    `${failure.specific ? 'First error' : 'No specific error line found; the end of the failing step'} (\`${failure.step}\`):`,
    '```',
    excerpt,
    '```',
  ];
  if (failure.errors.length)
    parts.push('Error annotations in the log:', ...failure.errors.map((e) => `- ${e}`));
  if (notes.length) parts.push('Annotations:', fromAnnotations);
  if (locations.length) parts.push(`Project files in the error: ${locations.join(', ')}`);
  const other = unresolvedMentions(excerpt, locations);
  const matched = await bySuffix(root, other);
  if (matched.length)
    parts.push(
      'Paths relative to a package folder, matched to project files:',
      ...matched.map((m) => `- ${m}`),
    );
  const rest = other.filter((o) => !matched.some((m) => m.startsWith(`${o} →`)));
  if (rest.length) parts.push(`Also mentioned, not found in the project: ${rest.join(', ')}`);
  return { text: parts.join('\n'), locations };
}

export const ciFailure = defineTool({
  name: 'ci_failure',
  description:
    'Explain why a GitHub Actions run failed: the failed jobs and steps, the first real error from the log (not just "exit code 1"), annotations, and which project files it points at, plus how the run\'s commit relates to your checkout. Without run_id, uses the latest failed run on the current branch. Read-only, through the user\'s own gh sign-in. Read the files it names before proposing a fix; the fix itself is a normal approved edit.',
  category: 'read_only',
  risk: 'none',
  requiresProject: true,
  schema: z.object({
    run_id: z.number().int().positive().optional().describe('From ci_runs.'),
  }),
  describeCall: (a) => (a.run_id ? `#${a.run_id}` : 'latest failure'),
  async execute(args, ctx) {
    const { root, repo } = await setup(ctx);
    let run: Run | null;
    if (args.run_id) {
      run = await getJson<Run>(repo, `actions/runs/${args.run_id}`, ctx.signal);
      if (!run) throw new WorkspaceError('not_found', `Run #${args.run_id} was not found.`);
    } else {
      const branch = await currentBranch(root);
      const q = new URLSearchParams({ per_page: '1', status: 'failure' });
      if (branch) q.set('branch', branch);
      run =
        (await getJson<{ workflow_runs: Run[] }>(repo, `actions/runs?${q}`, ctx.signal))
          ?.workflow_runs[0] ?? null;
      if (!run)
        return {
          content: `No failed GitHub Actions runs${branch ? ` on ${branch}` : ''}. Use ci_runs to see recent runs.`,
          summary: 'no failed runs',
        };
    }

    const head = (await runGit(root, ['rev-parse', 'HEAD'])).stdout.trim();
    const lines = [runLine(run, head), run.html_url, await relation(root, run.head_sha)];
    if (run.status !== 'completed')
      lines.push('This run is still in progress; its logs may be incomplete.');

    const jobs =
      (
        await getJson<{ jobs: Job[] }>(
          repo,
          `actions/runs/${run.id}/jobs?filter=latest&per_page=100`,
          ctx.signal,
        )
      )?.jobs ?? [];
    const failedJobs = jobs.filter((j) => FAILED.has(j.conclusion ?? ''));
    if (!failedJobs.length) {
      lines.push(
        jobs.length
          ? `No job failed in this run (conclusion: ${run.conclusion ?? run.status}).`
          : 'The run has no jobs: it failed before any started (for example a workflow file error, or it is waiting for approval). Check the run page.',
      );
      return { content: lines.join('\n'), summary: `run ${run.id}: no failed jobs` };
    }
    lines.push(
      '',
      `Failed jobs (${failedJobs.length} of ${jobs.length}):`,
      ...failedJobs.map((j) => {
        const s = j.steps?.find((x) => FAILED.has(x.conclusion ?? ''));
        return `- ${j.name}${s ? `: step ${s.number} "${s.name}"` : ''} (${j.conclusion})`;
      }),
    );

    // Logs of the first two failed jobs: enough to see the error, and usually the same one.
    const allLocations: string[] = [];
    for (const job of failedJobs.slice(0, 2)) {
      const log = await ghApiGet(
        repo,
        `repos/${repo.owner}/${repo.name}/actions/jobs/${job.id}/logs`,
        { signal: ctx.signal, timeoutMs: 90_000 },
      );
      const annotations =
        (await getJson<Annotation[]>(repo, `check-runs/${job.id}/annotations`, ctx.signal)) ?? [];
      const section = log
        ? await failureSection(job, firstFailure(log), annotations, root)
        : {
            text: `Job "${job.name}": its log is no longer available (GitHub keeps logs for a limited time).`,
            locations: [],
          };
      allLocations.push(...section.locations);
      lines.push('', section.text);
    }
    if (failedJobs.length > 2)
      lines.push('', `(${failedJobs.length - 2} more failed job(s) not shown.)`);

    const files = [...new Set(allLocations.map((l) => l.split(':')[0]))];
    return {
      content: lines.join('\n'),
      summary: `run ${run.id} failed${files.length ? `: ${files.slice(0, 3).join(', ')}` : ''}`,
    };
  },
});
