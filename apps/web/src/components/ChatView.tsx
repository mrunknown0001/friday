import type {
  ApprovalDto,
  AttachmentDto,
  BrowserFlowDto,
  DeploymentPlanDto,
  LoadTestDto,
  MemoryRef,
  MessageDto,
  ProjectDto,
  ReviewDto,
  RunDto,
  SessionDetailDto,
  TestRunDto,
} from '@friday/shared';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  FolderOpen,
  ImagePlus,
  Loader2,
  FileDown,
  ListChecks,
  MonitorPlay,
  PanelRight,
  Play,
  RotateCcw,
  Square,
  User,
  WifiOff,
} from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { LiveRun } from '../lib/useRunStream';
import { api } from '../lib/api';
import { ACCEPTED, imageFiles, prepareImage } from '../lib/images';
import { ApprovalCard } from './ApprovalCard';
import { AttachmentThumbs, DraftImages, type DraftImage } from './Attachments';
import { ExportDialog } from './ExportDialog';
import { ReviewActionsContext } from './ReviewCard';
import { ReviewStartDialog } from './ReviewStartDialog';
import { RunActionDialog } from './SavedActions';
import { WorktreeBadge } from './WorktreeBadge';
import { WorktreeDialog } from './WorktreeDialog';
import { ATTACH_IMAGE_EVENT } from './PreviewPane';
import { MemoriesUsed } from './MemoriesUsed';
import { RunSummary } from './RunSummary';
import { SuggestionChips } from './SuggestionChips';
import { TaskPermissionBanner } from './TaskPermissionBanner';
import { Markdown } from './Markdown';
import { MESSAGE_STATUS_LABEL, PHASE_LABEL } from './status';
import { ToolActivity, type ToolItem } from './ToolActivity';
import { cn } from '../lib/cn';
import {
  approvalAnnouncement,
  modelReady,
  player,
  useSpeakReplies,
  useVoiceStatus,
} from '../lib/voice';
import { SpeakReplyButton, VoiceControls } from './VoiceControls';
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
  previewOpen?: boolean;
  onTogglePreview?: () => void;
  onSend: (text: string, attachmentIds?: string[]) => Promise<boolean>;
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
    allowSimilar?: boolean,
  ) => Promise<void>;
  /** Persisted and live deployment plans, matched to tool calls by id. */
  deploymentPlans: DeploymentPlanDto[];
  onRollback: (runId: string) => Promise<void>;
  /** After a task worktree was accepted or discarded. */
  onWorktreeChanged?: () => void;
  onOpenMemory: () => void;
  onRevokeTaskPermission: (runId: string) => Promise<void>;
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
      <div className="min-w-0 flex-1 pt-0.5">
        {m.content && (
          <div className="whitespace-pre-wrap break-words text-[0.94rem] text-zinc-100">
            {m.content}
          </div>
        )}
        {m.attachments && <AttachmentThumbs attachments={m.attachments} className="mt-2" />}
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

/** Cards recorded by tool calls (by call id), shown under the tool activity. */
export interface CallCards {
  reviews: Map<string, ReviewDto>;
  testRuns: Map<string, TestRunDto>;
  browserFlows: Map<string, BrowserFlowDto>;
  loadTests: Map<string, LoadTestDto>;
}

const NO_CARDS: CallCards = {
  reviews: new Map(),
  testRuns: new Map(),
  browserFlows: new Map(),
  loadTests: new Map(),
};

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
  cards: CallCards = NO_CARDS,
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
        review: m.toolCallId ? cards.reviews.get(m.toolCallId) : undefined,
        testRun: m.toolCallId ? cards.testRuns.get(m.toolCallId) : undefined,
        browserFlow: m.toolCallId ? cards.browserFlows.get(m.toolCallId) : undefined,
        loadTest: m.toolCallId ? cards.loadTests.get(m.toolCallId) : undefined,
        attachments: m.attachments,
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

function MessageFooter({ m, speak }: { m: MessageDto; speak?: ReactNode }) {
  const status = m.status !== 'complete' ? MESSAGE_STATUS_LABEL[m.status] : null;
  if (!status && !m.model && !speak) return null;
  return (
    <div className="mt-2 flex items-center gap-2 text-[11px] text-zinc-500">
      {status && <Badge tone={status.tone}>{status.label}</Badge>}
      {m.model && <span>{m.model}</span>}
      {speak}
    </div>
  );
}

/** The last assistant message with text in each run: where its reply's play button goes. */
function lastReplyOfRuns(messages: MessageDto[]): Set<number> {
  const last = new Map<string, number>();
  for (const m of messages)
    if (m.runId && m.role === 'assistant' && m.content.trim()) last.set(m.runId, m.id);
  return new Set(last.values());
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
  cards,
}: {
  live: LiveRun;
  byCall: Map<string, ApprovalDto>;
  plans: Map<string, DeploymentPlanDto>;
  cards: CallCards;
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
        attachments: b.attachments,
        approval: byCall.get(b.callId),
        deploymentPlan: plans.get(b.callId),
        review: cards.reviews.get(b.callId),
        testRun: cards.testRuns.get(b.callId),
        browserFlow: cards.browserFlows.get(b.callId),
        loadTest: cards.loadTests.get(b.callId),
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

/** Images per message (the server enforces the same limit). */
const MAX_IMAGES = 4;

export function ChatView(props: Props) {
  const { detail, project, live, canSend, blockedReason, onSend, onStop, onRetry, onOpenSettings } =
    props;
  const { approvals, onDecide, onRollback } = props;
  const runsById = new Map((detail?.runs ?? []).map((r) => [r.id, r]));
  const [draft, setDraft] = useState('');
  const [images, setImages] = useState<DraftImage[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [submitting, setSubmitting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [pickingAction, setPickingAction] = useState(false);
  const [worktreeAction, setWorktreeAction] = useState<'accept' | 'discard' | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  // Shown when the user has scrolled up; `unseen` marks new activity below since then.
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const [unseen, setUnseen] = useState(false);
  const running = !!live && !live.finished;
  const sessionId = detail?.id;
  const voiceStatus = useVoiceStatus();
  const speakReplies = useSpeakReplies() && modelReady(voiceStatus, 'speech');

  const isNearBottom = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight < 80;

  // A different conversation always opens at its latest message.
  useEffect(() => {
    stickToBottom.current = true;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [sessionId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    } else if (!isNearBottom(el)) {
      setUnseen(true);
    }
    setAwayFromBottom(!isNearBottom(el));
  }, [sessionId, detail?.messages.length, live?.blocks, approvals.length]);

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = true;
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    el.scrollTo({ top: el.scrollHeight, behavior: reduceMotion ? 'auto' : 'smooth' });
  };

  const uploading = images.some((d) => d.status === 'uploading');
  const ready = images.filter((d) => d.status === 'ready' && d.attachment);

  /** Downsize and upload pasted, dropped or picked images; each shows in the composer at once. */
  const addImages = (files: File[]) => {
    const room = MAX_IMAGES - images.length;
    if (room <= 0 || !files.length) return;
    for (const file of files.slice(0, room)) {
      const key = `${Date.now()}-${Math.random()}`;
      const name = file.name && file.name !== 'image.png' ? file.name : 'pasted image';
      setImages((list) => [...list, { key, name, status: 'uploading' }]);
      const update = (patch: Partial<DraftImage>) =>
        setImages((list) => list.map((d) => (d.key === key ? { ...d, ...patch } : d)));
      void prepareImage(file)
        .then((blob) => api.uploadAttachment(blob, name))
        .then((attachment) => update({ status: 'ready', attachment }))
        .catch((e: unknown) =>
          update({ status: 'error', error: e instanceof Error ? e.message : String(e) }),
        );
    }
  };
  // A screenshot from the preview pane joins the message being written.
  useEffect(() => {
    const onAttach = (e: Event) => {
      const attachment = (e as CustomEvent<AttachmentDto>).detail;
      setImages((list) =>
        list.length >= MAX_IMAGES
          ? list
          : [...list, { key: attachment.id, name: 'screenshot.png', status: 'ready', attachment }],
      );
    };
    window.addEventListener(ATTACH_IMAGE_EVENT, onAttach);
    return () => window.removeEventListener(ATTACH_IMAGE_EVENT, onAttach);
  }, []);

  const removeImage = (d: DraftImage) => {
    setImages((list) => list.filter((x) => x.key !== d.key));
    if (d.attachment) void api.removeAttachment(d.attachment.id).catch(() => undefined);
  };

  const submit = async () => {
    const text = draft.trim();
    if ((!text && !ready.length) || uploading || running || submitting || !canSend) return;
    setSubmitting(true);
    stickToBottom.current = true;
    const ok = await onSend(
      text,
      ready.map((d) => d.attachment!.id),
    );
    setSubmitting(false);
    if (ok) {
      setDraft('');
      setImages([]);
    }
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
  const cards: CallCards = {
    reviews: new Map(
      [...(detail?.reviews ?? []), ...(live?.reviews ?? [])].map((r) => [r.toolCallId, r]),
    ),
    testRuns: new Map(
      [...(detail?.testRuns ?? []), ...(live?.testRuns ?? [])].map((r) => [r.toolCallId, r]),
    ),
    loadTests: new Map(
      [...(detail?.loadTests ?? []), ...(live?.loadTests ?? [])].map((t) => [t.toolCallId, t]),
    ),
    browserFlows: new Map(
      [...(detail?.browserFlows ?? []), ...(live?.browserFlows ?? [])].map((f) => [
        f.toolCallId,
        f,
      ]),
    ),
  };
  const rows = toRows(messages, byId, plansByCall, detail?.memoryUsage ?? {}, cards);
  const pending = approvals.filter((a) => a.status === 'pending');
  const replyEnds = lastReplyOfRuns(messages);
  const latest = detail?.latestRun;
  const showProblem =
    !running && latest && ['failed', 'cancelled', 'interrupted', 'blocked'].includes(latest.status);

  // Speak replies: a run's reply when it finishes, and an approval card when it appears. Turning
  // the toggle on, or opening another conversation, does not replay what is already there.
  const finishedId = live?.finished?.status === 'completed' ? live.finished.id : null;
  const spokenRun = useRef<string | null>(null);
  useEffect(() => {
    if (!finishedId || spokenRun.current === finishedId) return;
    spokenRun.current = finishedId;
    if (speakReplies && sessionId) void player.playRun(sessionId, finishedId);
    // Only a newly finished run starts speech.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finishedId]);
  const pendingKey = pending.map((a) => a.id).join(',');
  const announced = useRef<{ session: string | undefined; ids: Set<string> } | null>(null);
  useEffect(() => {
    const seen = announced.current;
    if (!seen || seen.session !== sessionId || !speakReplies) {
      announced.current = { session: sessionId, ids: new Set(pending.map((a) => a.id)) };
      return;
    }
    const fresh = pending.filter((a) => !seen.ids.has(a.id));
    for (const a of fresh) seen.ids.add(a.id);
    if (fresh[0])
      void player.say(`approval:${fresh[0].id}`, approvalAnnouncement(fresh[0].category));
    // pendingKey stands for the pending list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingKey, sessionId, speakReplies]);

  const reviewActions = {
    projectId: project?.available ? project.id : null,
    canSend: canSend && !running,
    send: (text: string) => onSend(text),
  };

  return (
    <ReviewActionsContext.Provider value={reviewActions}>
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-zinc-800 px-5">
          <h1 className="truncate text-sm font-medium text-zinc-200">
            {detail?.title ?? 'Friday'}
          </h1>
          {project && !project.worktree && (
            <Badge tone="info" title={project.rootPath}>
              <FolderOpen className="h-3 w-3" /> {project.name}
            </Badge>
          )}
          {project?.worktree && (
            <WorktreeBadge
              project={project}
              onAccept={() => setWorktreeAction('accept')}
              onDiscard={() => setWorktreeAction('discard')}
              busy={running}
            />
          )}
          {worktreeAction && project?.worktree && (
            <WorktreeDialog
              project={project}
              action={worktreeAction}
              defaultMessage={detail?.title ?? 'Task'}
              onClose={() => setWorktreeAction(null)}
              onDone={() => props.onWorktreeChanged?.()}
            />
          )}
          {detail?.hasSummary && (
            <Badge title="Older messages were summarized to fit the model context window.">
              summarized history
            </Badge>
          )}
          {project?.available && canSend && (
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              onClick={() => setReviewing(true)}
              disabled={running}
              title="Review uncommitted changes, this branch, or a pull request"
            >
              <ListChecks className="h-4 w-4" /> Review…
            </Button>
          )}
          {project?.available && canSend && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPickingAction(true)}
              disabled={running}
              title="Run one of this project's saved actions"
            >
              <Play className="h-4 w-4" /> Actions…
            </Button>
          )}
          {pickingAction && project && (
            <RunActionDialog
              projectId={project.id}
              canSend={canSend && !running}
              onRun={(text) => void onSend(text)}
              onClose={() => setPickingAction(false)}
            />
          )}
          {reviewing && (
            <ReviewStartDialog
              onClose={() => setReviewing(false)}
              onStart={(text) => {
                setReviewing(false);
                void onSend(text);
              }}
            />
          )}
          {detail && (
            <Button
              variant="ghost"
              size="icon"
              className={project?.available && canSend ? undefined : 'ml-auto'}
              onClick={() => setExporting(true)}
              aria-label="Export conversation"
              title="Export"
            >
              <FileDown className="h-4 w-4" />
            </Button>
          )}
          {exporting && detail && (
            <ExportDialog sessionId={detail.id} onClose={() => setExporting(false)} />
          )}
          {props.onTogglePreview && (
            <Button
              variant="ghost"
              size="icon"
              className={detail ? undefined : 'ml-auto'}
              onClick={props.onTogglePreview}
              aria-pressed={!!props.previewOpen}
              aria-label="Toggle live preview"
              title="Live preview"
            >
              <MonitorPlay className="h-4 w-4" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className={props.onTogglePreview || detail ? undefined : 'ml-auto'}
            onClick={props.onToggleSidePanel}
            aria-pressed={props.sidePanelOpen}
            aria-label="Toggle plan and files panel"
            title="Plan and files"
          >
            <PanelRight className="h-4 w-4" />
          </Button>
        </header>

        <div className="relative flex min-h-0 flex-1 flex-col">
          <div
            ref={scrollRef}
            onScroll={(e) => {
              const near = isNearBottom(e.currentTarget);
              stickToBottom.current = near;
              setAwayFromBottom(!near);
              if (near) setUnseen(false);
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
                      ? `Friday can read and search ${project.name} on its own. Editing files, running commands and committing each wait for your approval.`
                      : 'No project is selected, so Friday cannot see your code. Choose or add a project in the sidebar to let it read your files.'}
                  </p>
                </div>
              )}
              {rows.map((r) =>
                r.kind === 'user' ? (
                  <UserRow key={r.m.id} m={r.m} />
                ) : r.kind === 'assistant' ? (
                  <AssistantRow
                    key={r.m.id}
                    content={r.m.content}
                    footer={
                      <MessageFooter
                        m={r.m}
                        speak={
                          sessionId && r.m.runId && replyEnds.has(r.m.id) ? (
                            <SpeakReplyButton sessionId={sessionId} runId={r.m.runId} />
                          ) : undefined
                        }
                      />
                    }
                  />
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
              {running && (
                <LiveOutput live={live} byCall={byCall} plans={plansByCall} cards={cards} />
              )}
              {pending.map((a) => (
                <ApprovalCard
                  key={a.id}
                  approval={a}
                  onDecide={(decision, note, confirmation, allowSimilar) =>
                    onDecide(a, decision, note, confirmation, allowSimilar)
                  }
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
          {awayFromBottom && (
            <button
              type="button"
              onClick={scrollToBottom}
              aria-label={unseen ? 'Scroll to latest (new activity)' : 'Scroll to latest'}
              title="Scroll to latest"
              className={cn(
                'absolute bottom-4 left-1/2 flex h-9 -translate-x-1/2 items-center justify-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-900/95 text-xs text-zinc-200 shadow-lg shadow-black/40 backdrop-blur transition-colors hover:bg-zinc-800',
                unseen ? 'px-3' : 'w-9',
              )}
            >
              <ArrowDown className="h-4 w-4" aria-hidden />
              {unseen && (
                <>
                  New activity
                  <span className="h-1.5 w-1.5 rounded-full bg-sky-400" aria-hidden />
                </>
              )}
            </button>
          )}
        </div>

        <div className="shrink-0 border-t border-zinc-800 bg-zinc-950 px-5 py-3">
          <div className="mx-auto max-w-3xl">
            {running && live.taskPermission && (
              <TaskPermissionBanner
                permission={live.taskPermission}
                onRevoke={() => props.onRevokeTaskPermission(live.runId)}
              />
            )}
            {blockedReason && (
              <div className="mb-2 flex items-center justify-between gap-3 rounded-md border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
                <span>{blockedReason}</span>
                <Button size="sm" variant="secondary" onClick={onOpenSettings}>
                  Open settings
                </Button>
              </div>
            )}
            <div
              onDragOver={(e) => {
                if (!Array.from(e.dataTransfer.types).includes('Files')) return;
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                const files = imageFiles(e.dataTransfer.files);
                setDragging(false);
                if (!files.length) return;
                e.preventDefault();
                addImages(files);
              }}
              className={cn(
                'relative rounded-xl border bg-zinc-900 p-2 focus-within:border-zinc-600',
                dragging ? 'border-sky-500' : 'border-zinc-800',
              )}
            >
              <DraftImages images={images} onRemove={removeImage} />
              {images.length > 0 && (
                <p className="px-1 pb-1 text-[11px] text-zinc-500">
                  Images are sent to the model provider with your message. Don’t attach screenshots
                  that show passwords, keys or other secrets.
                </p>
              )}
              <div className="flex items-end gap-2">
                <label htmlFor="composer" className="sr-only">
                  Message
                </label>
                <input
                  ref={fileInput}
                  type="file"
                  accept={ACCEPTED.join(',')}
                  multiple
                  hidden
                  onChange={(e) => {
                    addImages(imageFiles(e.target.files));
                    e.target.value = '';
                  }}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => fileInput.current?.click()}
                  disabled={images.length >= MAX_IMAGES}
                  aria-label="Attach images"
                  title={`Attach images (or paste / drop them), up to ${MAX_IMAGES}`}
                >
                  <ImagePlus className="h-4 w-4" />
                </Button>
                <textarea
                  id="composer"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onPaste={(e) => {
                    const files = imageFiles(e.clipboardData.items);
                    if (!files.length) return;
                    // Only images are taken over; pasted text still goes into the message.
                    if (!e.clipboardData.getData('text/plain')) e.preventDefault();
                    addImages(files);
                  }}
                  onKeyDown={onKeyDown}
                  title="Enter sends · Shift+Enter for a new line"
                  rows={Math.min(10, Math.max(1, draft.split('\n').length))}
                  placeholder={
                    project ? `Ask about ${project.name}…` : 'Ask about code, DevOps, deployments…'
                  }
                  className="max-h-64 min-h-[2.25rem] flex-1 resize-none bg-transparent px-2 py-1.5 text-[0.94rem] outline-none placeholder:text-zinc-500"
                />
                <VoiceControls
                  onTranscript={(text) =>
                    setDraft((d) => (d.trim() ? `${d.trimEnd()} ${text}` : text))
                  }
                  onOpenSettings={onOpenSettings}
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
                    disabled={
                      (!draft.trim() && !ready.length) || uploading || submitting || !canSend
                    }
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
        </div>
      </main>
    </ReviewActionsContext.Provider>
  );
}
