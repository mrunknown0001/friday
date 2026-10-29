import type { MessageDto, RunDto, SessionDetailDto } from '@friday/shared';
import { AlertTriangle, ArrowUp, Loader2, RotateCcw, Square, User, WifiOff } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { LiveRun } from '../lib/useRunStream';
import { Markdown } from './Markdown';
import { MESSAGE_STATUS_LABEL, PHASE_LABEL } from './status';
import { Badge } from './ui/badge';
import { Button } from './ui/button';

interface Props {
  detail: SessionDetailDto | null;
  live: LiveRun | null;
  canSend: boolean;
  blockedReason: string | null;
  onSend: (text: string) => Promise<boolean>;
  onStop: () => void;
  onRetry: () => void;
  onOpenSettings: () => void;
}

function MessageRow({ m }: { m: MessageDto }) {
  const status = m.status !== 'complete' ? MESSAGE_STATUS_LABEL[m.status] : null;
  if (m.role === 'user') {
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
  return (
    <div className="flex gap-3">
      <div className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md bg-sky-600 text-xs font-bold">
        F
      </div>
      <div className="min-w-0 flex-1 pt-0.5">
        <Markdown content={m.content} />
        {(status || m.model) && (
          <div className="mt-2 flex items-center gap-2 text-[11px] text-zinc-500">
            {status && <Badge tone={status.tone}>{status.label}</Badge>}
            {m.model && <span>{m.model}</span>}
          </div>
        )}
      </div>
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
  const title =
    run.status === 'failed'
      ? 'The request failed'
      : run.status === 'interrupted'
        ? 'This response was interrupted'
        : 'Stopped';
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
        {run.status === 'failed' && !run.retryable && (
          <p className="mt-1 text-xs text-amber-100/60">
            Retrying will likely fail until the underlying problem is fixed.
          </p>
        )}
      </div>
      <Button size="sm" onClick={onRetry} disabled={disabled}>
        <RotateCcw className="h-3.5 w-3.5" /> Retry
      </Button>
    </div>
  );
}

export function ChatView({
  detail,
  live,
  canSend,
  blockedReason,
  onSend,
  onStop,
  onRetry,
  onOpenSettings,
}: Props) {
  const [draft, setDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const running = !!live && !live.finished;

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [detail?.messages.length, live?.text, live?.phase]);

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

  // While a run streams, its checkpointed partial message is shown via the live text instead.
  const messages = (detail?.messages ?? []).filter(
    (m) => !(running && m.runId === live?.runId && m.role === 'assistant'),
  );
  const latest = detail?.latestRun;
  const showProblem =
    !running && latest && ['failed', 'cancelled', 'interrupted'].includes(latest.status);

  return (
    <main className="flex min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center border-b border-zinc-800 px-5">
        <h1 className="truncate text-sm font-medium text-zinc-200">{detail?.title ?? 'Friday'}</h1>
        {detail?.hasSummary && (
          <Badge
            className="ml-3"
            title="Older messages were summarized to fit the model context window."
          >
            summarized history
          </Badge>
        )}
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
        <div className="mx-auto flex max-w-3xl flex-col gap-6 px-5 py-6">
          {messages.length === 0 && !running && (
            <div className="mt-16 text-center text-zinc-400">
              <p className="text-lg font-medium text-zinc-200">What are we working on?</p>
              <p className="mt-2 text-sm">
                Friday is in conversation-only mode: it can explain, plan, and draft, but cannot
                read your files or run commands yet.
              </p>
            </div>
          )}
          {messages.map((m) => (
            <MessageRow key={m.id} m={m} />
          ))}
          {running && (
            <div className="flex gap-3">
              <div className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md bg-sky-600 text-xs font-bold">
                F
              </div>
              <div className="min-w-0 flex-1 pt-0.5">
                {live.text && <Markdown content={live.text} />}
                <div className="mt-2 flex items-center gap-2 text-xs text-zinc-400" role="status">
                  {live.connectionLost ? (
                    <>
                      <WifiOff className="h-3.5 w-3.5 text-amber-400" /> Reconnecting to server…
                    </>
                  ) : (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      {live.phase ? PHASE_LABEL[live.phase] : 'Starting'}
                      {live.phaseDetail && (
                        <span className="text-zinc-500">· {live.phaseDetail}</span>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          )}
          {showProblem && <RunProblem run={latest} onRetry={onRetry} disabled={!canSend} />}
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
                detail
                  ? 'Ask about code, DevOps, deployments… (Shift+Enter for a new line)'
                  : 'Create a conversation to start'
              }
              disabled={!detail}
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
                disabled={!draft.trim() || submitting || !canSend || !detail}
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
