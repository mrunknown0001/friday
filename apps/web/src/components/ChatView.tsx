import type {
  ApprovalDto,
  DeploymentPlanDto,
  MemoryRef,
  MessageDto,
  ProjectDto,
  RunDto,
  SessionDetailDto,
} from '@friday/shared';
import {
  AlertTriangle,
  ArrowUp,
  FolderOpen,
  Loader2,
  PanelRight,
  RotateCcw,
  Square,
  User,
  WifiOff,
} from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { LiveRun } from '../lib/useRunStream';
import { ApprovalCard } from './ApprovalCard';
import { MemoriesUsed } from './MemoriesUsed';
import { RunSummary } from './RunSummary';
import { SuggestionChips } from './SuggestionChips';
import { Markdown } from './Markdown';
import { MESSAGE_STATUS_LABEL, PHASE_LABEL } from './status';
import { ToolActivity, type ToolItem } from './ToolActivity';
import { Badge } from './ui/badge';
import { Button } from './ui/button';

interface Props {
  detail: SessionDetailDto | null;
  project: ProjectDto | null;
  live: LiveRun | null;
  canSend: boolean;
  blockedReason: string | null;
  sidePanelOpen: boolean;
  onToggleSidePanel: () => void;
  onSend: (text: string) => Promise<boolean>;
  onStop: () => void;
  onRetry: () => void;
  onOpenSettings: () => void;
  /** All approvals for the session, with live updates applied. */
  approvals: ApprovalDto[];
  onDecide: (
    approval: ApprovalDto,
    decision: 'approve' | 'reject',
    note?: string,
    confirmation?: string,
  ) => Promise<void>;
  /** Persisted and live deployment plans, matched to tool calls by id. */
  deploymentPlans: DeploymentPlanDto[];
  onRollback: (runId: string) => Promise<void>;
  onOpenMemory: () => void;
}

const Avatar = () => (
  <div className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md bg-sky-600 text-xs font-bold">
    F
  </div>
);

function UserRow({ m }: { m: MessageDto }) {
  return (
    <div className="flex gap-3">
      <div className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md bg-zinc-800">
        <User className="h-4 w-4 text-zinc-300" aria-hidden />
      </div>
      <div className="min-w-0 flex-1 whitespace-pre-wrap break-words pt-0.5 text-[0.94rem] text-zinc-100">
        {m.content}
      </div>
    </div>
  );
}

function AssistantRow({ content, footer }: { content: string; footer?: ReactNode }) {
  return (
    <div className="flex gap-3">
      <Avatar />
      <div className="min-w-0 flex-1 pt-0.5">
        <Markdown content={content} />
        {footer}
      </div>
    </div>
  );
}

type Row =
  | { kind: 'user'; m: MessageDto }
  | { kind: 'assistant'; m: MessageDto }
  | { kind: 'tools'; items: ToolItem[]; key: string }
  | { kind: 'record'; runId: string; approvals: ApprovalDto[]; memories: MemoryRef[] };

/** Turn persisted messages into rows; consecutive tool results form one activity group. */
/** Tool results shown elsewhere (suggest_next_steps becomes chips) rather than as tool rows. */
function isHiddenMessage(m: MessageDto): boolean {
  return m.role === 'tool' && m.tool?.name === 'suggest_next_steps';
}

export function toRows(
  messages: MessageDto[],
  approvals: Map<string, ApprovalDto>,
  plans: Map<string, DeploymentPlanDto>,
  memoryUsage: Record<string, MemoryRef[]>,
): Row[] {
  const rows: Row[] = [];
  for (const m of messages) {
    if (m.role === 'user') rows.push({ kind: 'user', m });
    else if (m.role === 'assistant') {
      if (m.content.trim() || m.status !== 'complete') rows.push({ kind: 'assistant', m });
    } else if (isHiddenMessage(m)) {
      // Shown as suggestion chips instead of a tool row.
      continue;
    } else if (m.role === 'tool') {
      const item: ToolItem = {
        key: String(m.id),
        name: m.tool?.name ?? 'tool',
        arguments: m.tool?.arguments ?? '',
        status: m.tool?.status ?? 'completed',
        summary: m.tool?.summary ?? '',
        durationMs: m.tool?.durationMs ?? null,
        output: m.content,
        truncated: m.tool?.truncated,
        approval: m.tool?.approvalId ? approvals.get(m.tool.approvalId) : undefined,
        deploymentPlan: m.toolCallId ? plans.get(m.toolCallId) : undefined,
      };
      const last = rows.at(-1);
      if (last?.kind === 'tools') last.items.push(item);
      else rows.push({ kind: 'tools', items: [item], key: `t${m.id}` });
    }
  }
  return withRunRecords(rows, messages, approvals, memoryUsage);
}

/** After each run's last message, add the factual record of its protected actions. */
function withRunRecords(
  rows: Row[],
  messages: MessageDto[],
  approvals: Map<string, ApprovalDto>,
  memoryUsage: Record<string, MemoryRef[]>,
): Row[] {
  const byRun = new Map<string, ApprovalDto[]>();
  for (const a of approvals.values()) byRun.set(a.runId, [...(byRun.get(a.runId) ?? []), a]);
  for (const runId of Object.keys(memoryUsage)) if (!byRun.has(runId)) byRun.set(runId, []);
  if (byRun.size === 0) return rows;
  const lastMessageOfRun = new Map<string, number>();
  // Only messages that are actually rendered can anchor the record (hidden tool rows cannot).
  for (const m of messages) if (m.runId && !isHiddenMessage(m)) lastMessageOfRun.set(m.runId, m.id);
  const out: Row[] = [];
  for (const r of rows) {
    out.push(r);
    const lastId =
      r.kind === 'tools' ? Number(r.items.at(-1)!.key) : r.kind === 'record' ? -1 : r.m.id;
    for (const [runId, last] of lastMessageOfRun) {
      if (last === lastId && byRun.has(runId))
        out.push({
          kind: 'record',
          runId,
          approvals: byRun.get(runId)!,
          memories: memoryUsage[runId] ?? [],
        });
    }
  }
  return out;
}

function MessageFooter({ m }: { m: MessageDto }) {
  const status = m.status !== 'complete' ? MESSAGE_STATUS_LABEL[m.status] : null;
  if (!status && !m.model) return null;
  return (
    <div className="mt-2 flex items-center gap-2 text-[11px] text-zinc-500">
      {status && <Badge tone={status.tone}>{status.label}</Badge>}
      {m.model && <span>{m.model}</span>}
    </div>
  );
}

function RunProblem({
  run,
  onRetry,
  disabled,
}: {
  run: RunDto;
  onRetry: () => void;
  disabled: boolean;
}) {
  const title = {
    failed: 'The request failed',
    interrupted: 'This response was interrupted',
    blocked: 'Paused by a safety limit',
    cancelled: 'Stopped',
  }[run.status as 'failed' | 'interrupted' | 'blocked' | 'cancelled'];
  return (
    <div
      role="alert"
      className="flex gap-3 rounded-lg border border-amber-900/70 bg-amber-950/30 p-3 text-sm"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="font-medium text-amber-200">
          {title}
          {run.errorKind && (
            <span className="ml-2 font-mono text-xs text-amber-400/80">{run.errorKind}</span>
          )}
        </div>
        {run.errorMessage && (
          <p className="mt-1 break-words text-amber-100/80">{run.errorMessage}</p>
        )}
        {run.checkpoint &&
          (run.checkpoint.filesChanged.length > 0 || run.checkpoint.lastCommand) && (
            <p className="mt-1 text-xs text-amber-100/70">
              Progress saved at step {run.checkpoint.iteration}
              {run.checkpoint.filesChanged.length > 0 && (
                <> · files changed: {run.checkpoint.filesChanged.join(', ')}</>
              )}
              {run.checkpoint.lastCommand && (
                <>
                  {' '}
                  · last command: <code>{run.checkpoint.lastCommand.title}</code> (
                  {run.checkpoint.lastCommand.result})
                </>
              )}
              . Resuming tells Friday what was already done.
            </p>
          )}
        {run.status === 'failed' && !run.retryable && (
          <p className="mt-1 text-xs text-amber-100/60">
            Retrying will likely fail until the underlying problem is fixed.
          </p>
        )}
      </div>
      <Button size="sm" onClick={onRetry} disabled={disabled}>
        <RotateCcw className="h-3.5 w-3.5" />{' '}
        {run.status === 'blocked'
          ? 'Continue'
          : run.checkpoint?.filesChanged.length
            ? 'Resume'
            : 'Retry'}
      </Button>
    </div>
  );
}

function LiveOutput({
  live,
  byCall,
  plans,
}: {
  live: LiveRun;
  byCall: Map<string, ApprovalDto>;
  plans: Map<string, DeploymentPlanDto>;
}) {
  const groups: Array<{ kind: 'text'; text: string } | { kind: 'tools'; items: ToolItem[] }> = [];
  for (const b of live.blocks) {
    if (b.kind === 'tool' && b.name === 'suggest_next_steps') continue;
    if (b.kind === 'text') groups.push({ kind: 'text', text: b.text });
    else {
      const item: ToolItem = {
        key: b.callId,
        name: b.name,
        arguments: b.arguments,
        status: b.status,
        summary: b.summary,
        durationMs: b.durationMs,
        terminal: b.output || undefined,
        approval: byCall.get(b.callId),
        deploymentPlan: plans.get(b.callId),
      };
      const last = groups.at(-1);
      if (last?.kind === 'tools') last.items.push(item);
      else groups.push({ kind: 'tools', items: [item] });
    }
  }
  return (
    <>
      {groups.map((g, i) =>
        g.kind === 'text' ? (
          <AssistantRow key={i} content={g.text} />
        ) : (
          <ToolActivity key={i} items={g.items} />
        ),
      )}
      <div className="ml-10 flex items-center gap-2 text-xs text-zinc-400" role="status">
        {live.connectionLost ? (
          <>
            <WifiOff className="h-3.5 w-3.5 text-amber-400" /> Reconnecting to server…
          </>
        ) : (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {live.phase ? PHASE_LABEL[live.phase] : 'Starting'}
            {live.phaseDetail && <span className="text-zinc-500">· {live.phaseDetail}</span>}
          </>
        )}
      </div>
    </>
  );
}

export function ChatView(props: Props) {
  const { detail, project, live, canSend, blockedReason, onSend, onStop, onRetry, onOpenSettings } =
    props;
  const { approvals, onDecide, onRollback } = props;
  const runsById = new Map((detail?.runs ?? []).map((r) => [r.id, r]));
  const [draft, setDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const running = !!live && !live.finished;

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [detail?.messages.length, live?.blocks, approvals.length]);

  const submit = async () => {
    const text = draft.trim();
    if (!text || running || submitting || !canSend) return;
    setSubmitting(true);
    stickToBottom.current = true;
    const ok = await onSend(text);
    setSubmitting(false);
    if (ok) setDraft('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  // While a run streams, its persisted messages are shown through the live view instead.
  const messages = (detail?.messages ?? []).filter((m) => !(running && m.runId === live?.runId));
  const byId = new Map(approvals.map((a) => [a.id, a]));
  const byCall = new Map(approvals.map((a) => [a.toolCallId, a]));
  const plansByCall = new Map(props.deploymentPlans.map((p) => [p.toolCallId, p]));
  const rows = toRows(messages, byId, plansByCall, detail?.memoryUsage ?? {});
  const pending = approvals.filter((a) => a.status === 'pending');
  const latest = detail?.latestRun;
  const showProblem =
    !running && latest && ['failed', 'cancelled', 'interrupted', 'blocked'].includes(latest.status);

  return (
    <main className="flex min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-zinc-800 px-5">
        <h1 className="truncate text-sm font-medium text-zinc-200">{detail?.title ?? 'Friday'}</h1>
        {project && (
          <Badge tone="info" title={project.rootPath}>
            <FolderOpen className="h-3 w-3" /> {project.name}
          </Badge>
        )}
        {detail?.hasSummary && (
          <Badge title="Older messages were summarized to fit the model context window.">
            summarized history
          </Badge>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto"
          onClick={props.onToggleSidePanel}
          aria-pressed={props.sidePanelOpen}
          aria-label="Toggle plan and files panel"
          title="Plan and files"
        >
          <PanelRight className="h-4 w-4" />
        </Button>
      </header>

      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="flex-1 overflow-y-auto"
        aria-live="polite"
      >
        <div className="mx-auto flex max-w-3xl flex-col gap-5 px-5 py-6">
          {rows.length === 0 && !running && (
            <div className="mt-16 text-center text-zinc-400">
              <p className="text-lg font-medium text-zinc-200">What are we working on?</p>
              <p className="mt-2 text-sm">
                {project
                  ? `Friday can explore ${project.name} with read-only tools: search, read files, and explain the code. It cannot edit files or run commands yet.`
                  : 'No project is selected, so Friday cannot see your code. Choose or add a project in the sidebar to let it read your files.'}
              </p>
            </div>
          )}
          {rows.map((r) =>
            r.kind === 'user' ? (
              <UserRow key={r.m.id} m={r.m} />
            ) : r.kind === 'assistant' ? (
              <AssistantRow key={r.m.id} content={r.m.content} footer={<MessageFooter m={r.m} />} />
            ) : r.kind === 'record' ? (
              <div key={`rec-${r.runId}`} className="space-y-2">
                <MemoriesUsed refs={r.memories} />
                {r.approvals.length > 0 && (
                  <RunSummary
                    run={runsById.get(r.runId)}
                    approvals={r.approvals}
                    onRollback={onRollback}
                  />
                )}
              </div>
            ) : (
              <ToolActivity key={r.key} items={r.items} />
            ),
          )}
          {running && <MemoriesUsed refs={live.memoriesUsed} />}
          {running && <LiveOutput live={live} byCall={byCall} plans={plansByCall} />}
          {pending.map((a) => (
            <ApprovalCard
              key={a.id}
              approval={a}
              onDecide={(decision, note, confirmation) => onDecide(a, decision, note, confirmation)}
              onCancelRun={running ? onStop : undefined}
            />
          ))}
          {showProblem && <RunProblem run={latest} onRetry={onRetry} disabled={!canSend} />}
          {!running && latest?.status === 'completed' && latest.suggestions && (
            <SuggestionChips
              steps={latest.suggestions}
              disabled={submitting || !canSend}
              onPrompt={(prompt) => {
                stickToBottom.current = true;
                setSubmitting(true);
                void onSend(prompt).finally(() => setSubmitting(false));
              }}
              onOpenMemory={props.onOpenMemory}
            />
          )}
        </div>
      </div>

      <div className="shrink-0 border-t border-zinc-800 bg-zinc-950 px-5 py-3">
        <div className="mx-auto max-w-3xl">
          {blockedReason && (
            <div className="mb-2 flex items-center justify-between gap-3 rounded-md border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
              <span>{blockedReason}</span>
              <Button size="sm" variant="secondary" onClick={onOpenSettings}>
                Open settings
              </Button>
            </div>
          )}
          <div className="flex items-end gap-2 rounded-xl border border-zinc-800 bg-zinc-900 p-2 focus-within:border-zinc-600">
            <label htmlFor="composer" className="sr-only">
              Message
            </label>
            <textarea
              id="composer"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              rows={Math.min(10, Math.max(1, draft.split('\n').length))}
              placeholder={
                project
                  ? `Ask about ${project.name}… (Shift+Enter for a new line)`
                  : 'Ask about code, DevOps, deployments… (Shift+Enter for a new line)'
              }
              className="max-h-64 min-h-[2.25rem] flex-1 resize-none bg-transparent px-2 py-1.5 text-[0.94rem] outline-none placeholder:text-zinc-500"
            />
            {running ? (
              <Button
                key="stop"
                variant="danger"
                size="md"
                onClick={onStop}
                aria-label="Stop generating"
              >
                <Square className="h-3.5 w-3.5 fill-current" /> Stop
              </Button>
            ) : (
              <Button
                key="send"
                variant="primary"
                size="icon"
                onClick={() => void submit()}
                disabled={!draft.trim() || submitting || !canSend}
                aria-label="Send message"
              >
                {submitting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ArrowUp className="h-4 w-4" />
                )}
              </Button>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
