import type { ProcessDto } from '@friday/shared';
import { ExternalLink, Square, SquareTerminal, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { cn } from '../lib/cn';
import { Badge, type Tone } from './ui/badge';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';

/** Characters of output kept in the viewer (the server keeps its own, smaller window). */
const VIEWER_MAX_CHARS = 400_000;
const POLL_MS = 1_000;

export function processStatus(p: ProcessDto): { label: string; tone: Tone } {
  if (p.error) return { label: 'failed to start', tone: 'danger' };
  if (p.status === 'running') return { label: 'running', tone: 'success' };
  if (p.status === 'stopping') return { label: 'stopping', tone: 'warning' };
  if (p.status === 'stopped') return { label: 'stopped', tone: 'neutral' };
  const how = p.signal ? p.signal : `code ${p.exitCode}`;
  return { label: `exited (${how})`, tone: p.exitCode === 0 ? 'neutral' : 'danger' };
}

/** Whether a process ended by itself with a failure (worth a notification). */
export function crashed(p: ProcessDto): boolean {
  return p.status === 'exited' && p.stoppedBy === null && (p.exitCode !== 0 || p.error !== null);
}

function Urls({ urls }: { urls: string[] }) {
  if (!urls.length) return null;
  return (
    <span className="flex flex-wrap gap-x-2">
      {urls.map((u) => (
        // Only local addresses are ever listed (the server filters them).
        <a
          key={u}
          href={u}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 font-mono text-[11px] text-sky-300 hover:underline"
        >
          {u.replace(/^https?:\/\//, '')}
          <ExternalLink className="h-3 w-3" aria-hidden />
        </a>
      ))}
    </span>
  );
}

/** Background processes of the current project, with their own controls. */
export function ProcessList({
  processes,
  onStop,
  onDismiss,
}: {
  processes: ProcessDto[];
  onStop: (p: ProcessDto) => void;
  onDismiss: (p: ProcessDto) => void;
}) {
  const [viewing, setViewing] = useState<string | null>(null);
  const shown = processes.find((p) => p.id === viewing) ?? null;
  return (
    <>
      <ul className="space-y-1.5 px-2">
        {processes.map((p) => {
          const status = processStatus(p);
          const active = p.status === 'running' || p.status === 'stopping';
          return (
            <li key={p.id} className="rounded px-1 py-0.5 text-[13px]">
              <div className="flex items-center gap-2">
                <span
                  aria-hidden
                  className={cn(
                    'h-2 w-2 shrink-0 rounded-full',
                    p.status === 'running'
                      ? 'animate-pulse bg-emerald-400'
                      : status.tone === 'danger'
                        ? 'bg-red-400'
                        : 'bg-zinc-600',
                  )}
                />
                <span className="min-w-0 flex-1 truncate text-zinc-200" title={p.command}>
                  {p.name}
                </span>
                <span
                  className={cn(
                    'shrink-0 text-[11px]',
                    status.tone === 'danger'
                      ? 'text-red-400'
                      : status.tone === 'success'
                        ? 'text-emerald-400'
                        : 'text-zinc-500',
                  )}
                >
                  {status.label}
                </span>
                <button
                  type="button"
                  onClick={() => setViewing(p.id)}
                  aria-label={`Show output of ${p.name}`}
                  title="Output"
                  className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
                >
                  <SquareTerminal className="h-3.5 w-3.5" />
                </button>
                {active ? (
                  <button
                    type="button"
                    onClick={() => onStop(p)}
                    disabled={p.status === 'stopping'}
                    aria-label={`Stop ${p.name}`}
                    title="Stop"
                    className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-red-300 disabled:opacity-50"
                  >
                    <Square className="h-3.5 w-3.5" />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => onDismiss(p)}
                    aria-label={`Remove ${p.name} from the list`}
                    title="Remove"
                    className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              {p.status === 'running' && (
                <div className="pl-4">
                  <Urls urls={p.urls} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {shown && (
        <ProcessOutputDialog process={shown} onClose={() => setViewing(null)} onStop={onStop} />
      )}
    </>
  );
}

/** Follows a process's output while it runs (polling only for what is new). */
export function ProcessOutputDialog({
  process: p,
  onClose,
  onStop,
}: {
  process: ProcessDto;
  onClose: () => void;
  onStop: (p: ProcessDto) => void;
}) {
  const [output, setOutput] = useState<{ id: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  const running = p.status === 'running' || p.status === 'stopping';

  useEffect(() => {
    let cancelled = false;
    let cursor: number | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const r = await api.processOutput(p.id, cursor ?? undefined);
        if (cancelled) return;
        // Updaters run later; use the cursor this response answered, not the next one.
        const first = cursor === null;
        const gap = !first && r.dropped ? '\n[… output skipped …]\n' : '';
        const head = first && r.dropped ? '[… older output discarded …]\n' : '';
        setOutput((prev) => {
          const base = first || prev?.id !== p.id ? '' : prev.text;
          return { id: p.id, text: (base + gap + head + r.output).slice(-VIEWER_MAX_CHARS) };
        });
        cursor = r.cursor;
        setError(null);
        if (r.process.status === 'running' || r.process.status === 'stopping')
          timer = setTimeout(() => void poll(), POLL_MS);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        timer = setTimeout(() => void poll(), POLL_MS * 3);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // Restart following when the process is restarted under the same dialog or ends.
  }, [p.id, running]);

  // Keep the newest output in view unless the user scrolled up to read.
  useEffect(() => {
    const el = logRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [output]);

  const status = processStatus(p);
  const text = output?.id === p.id ? output.text : null;
  return (
    <Dialog open onClose={onClose} title={`Process: ${p.name}`}>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge tone={status.tone}>{status.label}</Badge>
          <code className="min-w-0 break-all font-mono text-zinc-300">$ {p.command}</code>
          <span className="text-zinc-500">in {p.cwd === '.' ? 'the project root' : p.cwd}</span>
          {p.sandbox && <Badge>container {p.sandbox.image}</Badge>}
        </div>
        {p.status === 'running' && <Urls urls={p.urls} />}
        {p.error && <p className="text-sm text-red-400">{p.error}</p>}
        <pre
          ref={logRef}
          role="log"
          aria-label={`Output of ${p.name}`}
          tabIndex={0}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
          className="h-[55vh] overflow-auto whitespace-pre-wrap break-all rounded-md border border-zinc-800 bg-zinc-950 p-3 font-mono text-[0.75rem] leading-snug text-zinc-200"
        >
          {text === null ? 'Loading…' : text || '(no output yet)'}
        </pre>
        {error && (
          <p role="alert" className="text-xs text-red-400">
            {error}
          </p>
        )}
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] text-zinc-500">
            Started {new Date(p.startedAt).toLocaleTimeString()}. Only recent output is kept.
          </p>
          {running && (
            <Button
              variant="danger"
              size="sm"
              onClick={() => onStop(p)}
              disabled={p.status === 'stopping'}
            >
              <Square className="h-3.5 w-3.5" aria-hidden /> Stop
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
