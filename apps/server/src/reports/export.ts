import type { ApprovalDetails, ApprovalDto, MessageDto, RunDto, RunReport } from '@friday/shared';
import { displayArgv } from '../tools/commandTool.js';

/**
 * A conversation as one Markdown document: messages, the tools Friday used and what came of them,
 * approvals and decisions, and each run's verification report. Used for the Markdown download
 * and, through the document renderer, the PDF. The caller redacts the result.
 */

export interface ExportInput {
  title: string;
  createdAt: string;
  project: { name: string; rootPath: string } | null;
  messages: MessageDto[];
  approvals: ApprovalDto[];
  runs: RunDto[];
  /** "summary": one line per tool call; "full": also tool results, diffs and commands. */
  detail: 'summary' | 'full';
  /** Minutes east of UTC, for the times shown. */
  tzOffsetMinutes: number;
  now?: Date;
}

/** Characters of one tool result kept in a full export. */
export const EXPORT_TOOL_OUTPUT_CHARS = 20_000;

function stamp(iso: string, tz: number, withDate = true): string {
  const d = new Date(Date.parse(iso) + tz * 60_000).toISOString();
  return withDate ? `${d.slice(0, 10)} ${d.slice(11, 16)}` : d.slice(11, 16);
}

function utcOffset(tz: number): string {
  const sign = tz < 0 ? '-' : '+';
  const a = Math.abs(tz);
  return `UTC${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

/** A code block whose fence cannot be closed early by the content (the PDF parser takes ``` or ~~~). */
export function fenced(content: string, lang = ''): string {
  const lines = content.replace(/\s+$/, '').split('\n');
  const opens = (f: string) => lines.some((l) => l.trim().startsWith(f));
  const fence = !opens('```') ? '```' : !opens('~~~') ? '~~~' : '```';
  // Both kinds appear: break the ones that would close the block with a zero-width space.
  const body =
    fence === '```' && opens('```')
      ? lines.map((l) => (l.trim().startsWith('```') ? l.replace('```', '`​``') : l))
      : lines;
  return `${fence}${lang}\n${body.join('\n')}\n${fence}`;
}

/**
 * Message text nested under the export's own headings: its headings move down two levels
 * (outside code blocks), so "# Plan" in a reply doesn't outrank the conversation title.
 */
export function nestHeadings(text: string): string {
  let inFence: string | null = null;
  return text
    .split('\n')
    .map((line) => {
      const fence = /^\s*(```|~~~)/.exec(line)?.[1];
      if (fence) {
        if (inFence === null) inFence = fence;
        else if (fence === inFence) inFence = null;
        return line;
      }
      if (inFence !== null) return line;
      const h = /^(#{1,6})(\s+.*)$/.exec(line);
      return h ? `${'#'.repeat(Math.min(6, h[1]!.length + 2))}${h[2]}` : line;
    })
    .join('\n');
}

const STATUS_LABEL: Record<RunReport['status'], string> = {
  verified: '✅ Verified',
  failed: '❌ Checks failed',
  unverified: '⚠️ Not verified',
  no_changes: 'No file changes',
};

function reportMarkdown(r: RunReport): string {
  const out = [`**Run report: ${STATUS_LABEL[r.status]}.** ${r.note}`];
  if (r.files.length) {
    out.push('', 'Files:');
    for (const f of r.files)
      out.push(
        `- \`${f.fromPath ? `${f.fromPath} → ${f.path}` : f.path}\` (${f.change}${f.reverted ? ', undone' : ''}${f.modifiedSince ? ', edited since' : ''})`,
      );
  }
  if (r.commands.length) {
    out.push('', 'Commands:');
    for (const c of r.commands) out.push(`- \`${c.title.replace(/`/g, "'")}\`: ${c.result}`);
  }
  if (r.commits.length) {
    out.push('', 'Commits:');
    for (const c of r.commits) out.push(`- ${c}`);
  }
  return out.join('\n');
}

const DECISION: Record<ApprovalDto['status'], string> = {
  pending: 'waiting for a decision',
  approved: 'approved',
  rejected: 'rejected',
  expired: 'expired (no decision)',
  stale: 'not run: things changed before it could run',
  executed: 'approved and done',
  failed: 'approved, then failed',
  cancelled: 'cancelled',
};

/** The exact action an approval covered, for a full export. */
function approvalAction(d: ApprovalDetails): string | null {
  switch (d.kind) {
    case 'file_change':
      return d.changes
        .filter((c) => c.diff)
        .map((c) => fenced(c.diff, 'diff'))
        .join('\n\n');
    case 'command':
      return fenced(d.argv ? displayArgv(d.argv) : (d.shellCommand ?? ''), 'sh');
    case 'remote':
      return `On ${d.host.name} (${d.host.username}@${d.host.hostname}):\n\n${fenced(d.command, 'sh')}`;
    case 'git':
      return d.message ? fenced(d.message) : null;
    case 'git_remote':
      return d.pullRequest
        ? `Pull request on ${d.pullRequest.repo} into ${d.pullRequest.base}: **${d.pullRequest.title}**`
        : `Push ${d.branch} to ${d.remote} (${d.commitCount} commit${d.commitCount === 1 ? '' : 's'})`;
    case 'mcp':
      return fenced(d.arguments, 'json');
    case 'document':
      return `${d.format.toUpperCase()} at \`${d.path}\``;
    case 'task_permissions':
      return [
        ...d.files.map((f) => `- edit \`${f}\``),
        ...d.commands.map((c) => `- run \`${displayArgv(c)}\``),
      ].join('\n');
    case 'saved_action':
      return d.steps
        .map(
          (st, i) =>
            `${i + 1}. ${st.title} (${st.where.kind === 'local' ? `this machine, ${st.where.cwd}` : `${st.where.host.name}, ${st.where.host.environment}`}):\n\n${fenced(st.command, 'sh')}`,
        )
        .join('\n\n');
    case 'compose':
      return fenced(displayArgv(d.argv), 'sh');
  }
}

export function conversationMarkdown(input: ExportInput): string {
  const tz = input.tzOffsetMinutes;
  const approvals = new Map(input.approvals.map((a) => [a.id, a]));
  const runs = new Map(input.runs.map((r) => [r.id, r]));
  const toolResults = new Map(
    input.messages.filter((m) => m.role === 'tool' && m.toolCallId).map((m) => [m.toolCallId!, m]),
  );
  const models = [...new Set(input.messages.map((m) => m.model).filter(Boolean))];

  const out: string[] = [`# ${input.title.replace(/\n/g, ' ')}`, ''];
  const meta = [
    `Exported from Friday on ${stamp((input.now ?? new Date()).toISOString(), tz)} (${utcOffset(tz)}).`,
    `Started ${stamp(input.createdAt, tz)}.`,
    input.project
      ? `Project: ${input.project.name} (\`${input.project.rootPath}\`).`
      : 'No project.',
    models.length ? `Model${models.length > 1 ? 's' : ''}: ${models.join(', ')}.` : null,
  ].filter(Boolean);
  out.push(meta.join(' '), '');
  out.push(
    input.detail === 'full'
      ? '_Full export: tool results, diffs and commands included. Secrets are redacted._'
      : '_Summary export: one line per tool call. Secrets are redacted._',
  );

  const reported = new Set<string>();
  const finishRun = (runId: string | null) => {
    if (!runId || reported.has(runId)) return;
    reported.add(runId);
    const run = runs.get(runId);
    if (!run) return;
    // A run that only talked has nothing to report.
    const r = run.report;
    if (r && (r.status !== 'no_changes' || r.files.length || r.commands.length || r.commits.length))
      out.push('', reportMarkdown(r));
    if (['failed', 'cancelled', 'interrupted', 'blocked'].includes(run.status))
      out.push(
        '',
        `_This run ended ${run.status}${run.errorMessage ? `: ${run.errorMessage}` : ''}._`,
      );
  };

  let currentRun: string | null = null;
  // A heading when the speaker changes (or a new run starts); Friday's consecutive turns
  // within one run read as one reply.
  let lastSpeaker: string | null = null;
  for (const m of input.messages) {
    if (m.role === 'tool' || m.role === 'system') continue;
    if (m.runId !== currentRun) {
      finishRun(currentRun);
      currentRun = m.runId;
      lastSpeaker = null;
    }
    const who = m.role === 'user' ? 'You' : `Friday${m.model ? ` · ${m.model}` : ''}`;
    const text = m.content.trim();
    const calls = m.toolCalls ?? [];
    if (m.role === 'user' || who !== lastSpeaker)
      out.push('', '---', '', `## ${who} · ${stamp(m.createdAt, tz)}`);
    lastSpeaker = who;
    if (text) out.push('', nestHeadings(text));
    if (m.status === 'partial' || m.status === 'cancelled' || m.status === 'error')
      out.push('', `_(${m.status === 'partial' ? 'incomplete' : m.status})_`);
    if (m.attachments?.length)
      out.push(
        '',
        `_Images: ${m.attachments.map((a) => `${a.name ?? 'image'} (${a.width}×${a.height})`).join(', ')}_`,
      );

    if (!calls.length) continue;
    out.push('');
    for (const c of calls) {
      const result = toolResults.get(c.id);
      const tool = result?.tool;
      const approval = tool?.approvalId ? approvals.get(tool.approvalId) : undefined;
      const line = approval
        ? `- **${approval.title}**: ${DECISION[approval.status]}${approval.resultSummary ? `, ${approval.resultSummary}` : ''}${approval.decisionNote ? (approval.status === 'rejected' ? ` (your note: "${approval.decisionNote}")` : ` (${approval.decisionNote})`) : ''}`
        : `- \`${c.name}\`${tool?.summary ? `: ${tool.summary}` : ''}${tool && tool.status !== 'completed' ? ` (${tool.status})` : ''}`;
      out.push(line);
      if (input.detail !== 'full') continue;

      const parts: string[] = [];
      if (approval) {
        parts.push(`Reason given: ${approval.reason}`);
        const action = approvalAction(approval.details);
        if (action) parts.push(action);
      } else if (c.arguments && c.arguments !== '{}') {
        parts.push(`Arguments: \`${c.arguments.replace(/`/g, "'").slice(0, 500)}\``);
      }
      if (result?.content.trim()) {
        const body = result.content.trim();
        parts.push(
          fenced(
            body.length > EXPORT_TOOL_OUTPUT_CHARS
              ? `${body.slice(0, EXPORT_TOOL_OUTPUT_CHARS)}\n[… ${body.length - EXPORT_TOOL_OUTPUT_CHARS} more characters not exported]`
              : body,
          ),
        );
      }
      // The call's details follow its line.
      if (parts.length) out.push('', ...parts.flatMap((p) => [p, '']));
    }
  }
  finishRun(currentRun);
  return `${out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()}\n`;
}
