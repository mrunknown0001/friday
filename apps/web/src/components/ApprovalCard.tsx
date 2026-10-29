import type { ApprovalDto, ApprovalStatus, RiskLevel } from '@friday/shared';
import {
  Check,
  FileDiff,
  KeyRound,
  GitCommitHorizontal,
  Loader2,
  Server,
  ShieldAlert,
  SquareTerminal,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { displayArgv } from '../lib/format';
import { canAllowSimilar } from '../lib/taskPermission';
import { DiffView } from './DiffView';
import { Badge, type Tone } from './ui/badge';
import { Button } from './ui/button';

const RISK_TONE: Record<RiskLevel, Tone> = {
  none: 'neutral',
  low: 'neutral',
  medium: 'info',
  high: 'warning',
  critical: 'danger',
};

const STATUS: Record<ApprovalStatus, { label: string; tone: Tone }> = {
  pending: { label: 'awaiting your decision', tone: 'warning' },
  approved: { label: 'approved, running', tone: 'info' },
  rejected: { label: 'rejected', tone: 'neutral' },
  expired: { label: 'expired', tone: 'neutral' },
  cancelled: { label: 'cancelled', tone: 'neutral' },
  executed: { label: 'approved and executed', tone: 'success' },
  failed: { label: 'approved, but failed', tone: 'danger' },
  stale: { label: 'not run: changed after review', tone: 'warning' },
};

const CATEGORY_LABEL: Record<string, string> = {
  file_create: 'Create file',
  file_modify: 'Modify file',
  file_delete: 'Delete / move file',
  shell: 'Run command',
  git: 'Git',
  remote: 'Remote server',
  deployment: 'Production change',
  task_permission: 'Task permission',
  process_control: 'Process',
};

function TaskPermissionDetails({
  d,
}: {
  d: Extract<ApprovalDto['details'], { kind: 'task_permissions' }>;
}) {
  return (
    <div className="space-y-2 text-xs">
      <ol className="list-decimal space-y-0.5 pl-5 text-zinc-300">
        {d.plan.map((step, i) => (
          <li key={i}>{step}</li>
        ))}
      </ol>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt className="text-zinc-500">May create or edit</dt>
        <dd>
          <ul className="space-y-0.5 font-mono text-zinc-100">
            {d.files.map((f) => (
              <li key={f}>{f.endsWith('/') ? `${f} (anything in this folder)` : f}</li>
            ))}
          </ul>
        </dd>
        <dt className="text-zinc-500">May run</dt>
        <dd>
          {d.commands.length ? (
            <ul className="space-y-0.5 font-mono text-zinc-100">
              {d.commands.map((c) => (
                <li key={c.join('\0')}>$ {displayArgv(c)}</li>
              ))}
            </ul>
          ) : (
            <span className="text-zinc-300">No commands</span>
          )}
          <span className="text-zinc-500">
            {' '}
            Exactly as written, in the project root, without a shell.
          </span>
        </dd>
        <dt className="text-zinc-500">Limits</dt>
        <dd className="text-zinc-300">
          This task only, up to {d.maxActions} actions within {d.minutes} minutes. You can revoke it
          at any time.
        </dd>
      </dl>
      <p className="text-zinc-400">
        Each change is still checked right before it runs, shown in the conversation and can be
        undone. Deleting or moving files, git, remote servers, shell scripts and anything not listed
        here still ask you.
      </p>
    </div>
  );
}

function useCountdown(expiresAt: string, active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return Math.max(0, Date.parse(expiresAt) - now);
}

function formatRemaining(ms: number): string {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function FileDiffs({
  changes,
}: {
  changes: Extract<ApprovalDto['details'], { kind: 'file_change' }>['changes'];
}) {
  return (
    <div className="space-y-3">
      {changes.map((c) => (
        <div key={`${c.fromPath ?? ''}${c.path}`}>
          <div className="mb-1 flex flex-wrap items-center gap-2 text-xs">
            <FileDiff className="h-3.5 w-3.5 text-zinc-400" aria-hidden />
            <span className="font-mono text-zinc-200">
              {c.fromPath ? `${c.fromPath} → ${c.path}` : c.path}
            </span>
            <Badge>{c.change}</Badge>
            <span className="text-emerald-400">+{c.added}</span>
            <span className="text-red-400">−{c.removed}</span>
          </div>
          {c.change !== 'move' && <DiffView diff={c.diff} />}
        </div>
      ))}
    </div>
  );
}

function Details({ approval }: { approval: ApprovalDto }) {
  const d = approval.details;
  if (d.kind === 'git') {
    return (
      <div className="space-y-2">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
          <dt className="text-zinc-500">Branch</dt>
          <dd className="font-mono text-zinc-300">{d.branch ?? '(detached HEAD)'}</dd>
          <dt className="text-zinc-500">HEAD</dt>
          <dd className="font-mono text-zinc-300">{d.head?.slice(0, 12) ?? '(no commits)'}</dd>
          {d.newBranch && (
            <>
              <dt className="text-zinc-500">New branch</dt>
              <dd className="font-mono text-zinc-100">{d.newBranch}</dd>
            </>
          )}
          <dt className="text-zinc-500">Push</dt>
          <dd className="text-zinc-300">No: nothing leaves this machine</dd>
        </dl>
        {d.message !== null && (
          <pre
            aria-label="Commit message"
            className="whitespace-pre-wrap rounded-md border border-zinc-800 bg-zinc-950 p-2 font-mono text-[0.8rem] text-zinc-100"
          >
            {d.message}
          </pre>
        )}
        {d.hooks.length > 0 && (
          <p className="text-xs text-amber-300">
            Repository hooks will run during the commit: {d.hooks.join(', ')}.
          </p>
        )}
        {d.files.length > 0 && <FileDiffs changes={d.files} />}
      </div>
    );
  }
  if (d.kind === 'file_change') return <FileDiffs changes={d.changes} />;
  if (d.kind === 'remote') return <RemoteDetails d={d} />;
  if (d.kind === 'task_permissions') return <TaskPermissionDetails d={d} />;
  const shown = d.argv ? displayArgv(d.argv) : (d.shellCommand ?? '');
  return (
    <div className="space-y-2">
      <pre
        aria-label="Exact command"
        className="overflow-x-auto whitespace-pre-wrap break-all rounded-md border border-zinc-800 bg-zinc-950 p-2 font-mono text-[0.8rem] text-zinc-100"
      >
        <span className="select-none text-zinc-500">$ </span>
        {shown}
      </pre>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        <dt className="text-zinc-500">Working directory</dt>
        <dd className="font-mono text-zinc-300">{d.cwd}</dd>
        <dt className="text-zinc-500">Shell</dt>
        <dd className="text-zinc-300">
          {d.shell
            ? 'Yes: interpreted by /bin/sh'
            : 'No: program run directly with these arguments'}
        </dd>
        <dt className="text-zinc-500">Runs</dt>
        {d.sandbox ? (
          <dd className="text-emerald-300">
            In a container: <code className="font-mono">{d.sandbox.image}</code>,{' '}
            {d.sandbox.network === 'none' ? 'no network' : 'outbound network allowed'}, only the
            project folder mounted (writable)
            {d.sandbox.gitReadOnly ? ', .git read-only' : ''}
            {d.sandbox.hiddenCredentials
              ? `, ${d.sandbox.hiddenCredentials} credential file${d.sandbox.hiddenCredentials === 1 ? '' : 's'} hidden`
              : ''}
            {d.sandbox.ports?.length
              ? `, port${d.sandbox.ports.length === 1 ? '' : 's'} ${d.sandbox.ports.join(', ')} published on 127.0.0.1`
              : ''}
          </dd>
        ) : (
          <dd className="text-zinc-300">On this machine, as your user (not sandboxed)</dd>
        )}
        {d.background ? (
          <>
            <dt className="text-zinc-500">Duration</dt>
            <dd className="text-amber-200">
              Keeps running in the background as “{d.background.name}” until you stop it (Processes
              panel) or Friday quits
            </dd>
          </>
        ) : (
          <>
            <dt className="text-zinc-500">Timeout</dt>
            <dd className="text-zinc-300">{d.timeoutSeconds}s</dd>
          </>
        )}
        <dt className="text-zinc-500">Network</dt>
        <dd className={d.network ? 'text-amber-300' : 'text-zinc-300'}>
          {d.network ? 'Likely' : 'Not expected'}
          {d.sandbox?.network === 'none' ? ' (the container has none)' : ''}
        </dd>
        <dt className="text-zinc-500">Environment</dt>
        <dd className="font-mono text-zinc-400">{d.env.join(' ')}</dd>
      </dl>
      {d.riskReasons.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-amber-200/90">
          {d.riskReasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

const ENV_TONE: Record<string, Tone> = {
  development: 'neutral',
  staging: 'warning',
  production: 'danger',
};

function RemoteDetails({ d }: { d: Extract<ApprovalDto['details'], { kind: 'remote' }> }) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Server className="h-3.5 w-3.5 text-zinc-400" aria-hidden />
        <span className="font-mono text-zinc-100">{d.host.name}</span>
        <span className="font-mono text-zinc-400">
          {d.host.username}@{d.host.hostname}:{d.host.port}
        </span>
        <Badge
          tone={ENV_TONE[d.host.environment]}
          className={d.host.environment === 'production' ? 'uppercase' : ''}
        >
          {d.host.environment}
        </Badge>
      </div>
      <pre
        aria-label="Exact command"
        className="overflow-x-auto whitespace-pre-wrap break-all rounded-md border border-zinc-800 bg-zinc-950 p-2 font-mono text-[0.8rem] text-zinc-100"
      >
        <span className="select-none text-zinc-500">{d.host.name}$ </span>
        {d.command}
      </pre>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        <dt className="text-zinc-500">Expected impact</dt>
        <dd className="text-zinc-200">{d.expectedImpact}</dd>
        <dt className="text-zinc-500">Downtime</dt>
        <dd className="text-zinc-200">{d.downtime}</dd>
        <dt className="text-zinc-500">Rollback</dt>
        <dd className="text-zinc-200">{d.rollback}</dd>
        <dt className="text-zinc-500">Verification</dt>
        <dd className="text-zinc-200">{d.verification}</dd>
        <dt className="text-zinc-500">Runs via</dt>
        <dd className="text-zinc-300">
          SSH, through the remote user's shell, up to {d.timeoutSeconds}s
        </dd>
      </dl>
      {d.riskReasons.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-amber-200/90">
          {d.riskReasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export interface ApprovalCardProps {
  approval: ApprovalDto;
  onDecide: (
    decision: 'approve' | 'reject',
    note?: string,
    confirmation?: string,
    allowSimilar?: boolean,
  ) => Promise<void>;
  onCancelRun?: (() => void) | undefined;
  /** Compact read-only view (inside tool history). */
  compact?: boolean;
}

export function ApprovalCard({ approval, onDecide, onCancelRun, compact }: ApprovalCardProps) {
  const pending = approval.status === 'pending';
  const remaining = useCountdown(approval.expiresAt, pending);
  const expired = pending && remaining <= 0;
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const [typed, setTyped] = useState('');
  const similar = canAllowSimilar(approval);
  const [allowSimilar, setAllowSimilar] = useState(false);
  const confirmed =
    !approval.confirmationRequired || typed.trim() === approval.confirmationRequired;
  const status = expired ? STATUS.expired : STATUS[approval.status];
  const Icon =
    approval.details.kind === 'command'
      ? SquareTerminal
      : approval.details.kind === 'git'
        ? GitCommitHorizontal
        : approval.details.kind === 'task_permissions'
          ? KeyRound
          : ShieldAlert;

  const decide = async (decision: 'approve' | 'reject') => {
    setBusy(decision);
    try {
      await onDecide(
        decision,
        decision === 'reject' && note.trim() ? note.trim() : undefined,
        decision === 'approve' && approval.confirmationRequired ? typed.trim() : undefined,
        decision === 'approve' && similar !== null && allowSimilar ? true : undefined,
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <section
      // Only the actionable card is a named region; compact history views are plain content.
      aria-label={compact ? undefined : `Approval request: ${approval.title}`}
      className={
        compact
          ? 'space-y-2 p-2'
          : 'space-y-3 rounded-lg border border-amber-800/60 bg-zinc-900 p-4 shadow-lg shadow-black/30'
      }
    >
      {!compact && (
        <header className="flex flex-wrap items-center gap-2">
          <Icon className="h-4 w-4 text-amber-400" aria-hidden />
          <h2 className="text-sm font-semibold text-zinc-100">{approval.title}</h2>
          <Badge tone={RISK_TONE[approval.risk]}>{approval.risk} risk</Badge>
          <Badge>{CATEGORY_LABEL[approval.category] ?? approval.category}</Badge>
          <Badge tone={status.tone} className="ml-auto">
            {status.label}
          </Badge>
        </header>
      )}
      {!compact && <p className="text-sm text-zinc-300">{approval.summary}</p>}
      {approval.reason && (
        <p className="text-xs text-zinc-400">
          <span className="font-medium text-zinc-300">Friday’s stated reason:</span>{' '}
          {approval.reason}
        </p>
      )}
      <Details approval={approval} />
      {approval.decisionNote && !pending && (
        <p className="text-xs text-zinc-400">
          <span className="font-medium text-zinc-300">Note:</span> {approval.decisionNote}
        </p>
      )}
      {approval.resultSummary && (
        <p className="text-xs text-zinc-400">
          <span className="font-medium text-zinc-300">Result:</span> {approval.resultSummary}
        </p>
      )}

      {pending && !compact && (
        <div className="space-y-2 border-t border-zinc-800 pt-3">
          {similar && !rejecting && (
            <label className="flex items-start gap-2 text-xs text-zinc-300">
              <input
                type="checkbox"
                className="mt-0.5 accent-sky-500"
                checked={allowSimilar}
                onChange={(e) => setAllowSimilar(e.target.checked)}
              />
              <span>
                {similar === 'files'
                  ? 'Also allow further edits to these files for this task without asking.'
                  : 'Also allow re-running this exact command for this task without asking.'}{' '}
                <span className="text-zinc-500">
                  Each one is still checked, shown and undoable; up to 20 actions within 30 minutes;
                  you can revoke it.
                </span>
              </span>
            </label>
          )}
          {approval.confirmationRequired && !rejecting && (
            <div className="rounded-md border border-red-900/70 bg-red-950/30 p-2">
              <label htmlFor={`confirm-${approval.id}`} className="mb-1 block text-xs text-red-200">
                This affects <strong>production</strong>. Type{' '}
                <code className="font-mono">{approval.confirmationRequired}</code> to enable
                approval.
              </label>
              <input
                id={`confirm-${approval.id}`}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                className="w-full rounded-md border border-red-900 bg-zinc-950 px-2 py-1 font-mono text-sm outline-none focus:border-red-600"
              />
            </div>
          )}
          {rejecting && (
            <div>
              <label htmlFor={`note-${approval.id}`} className="mb-1 block text-xs text-zinc-400">
                Optional note for Friday (what to do instead)
              </label>
              <textarea
                id={`note-${approval.id}`}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                maxLength={2000}
                className="w-full resize-none rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm outline-none focus:border-sky-500"
              />
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {rejecting ? (
              <>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => void decide('reject')}
                  disabled={busy !== null}
                >
                  {busy === 'reject' ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <X className="h-3.5 w-3.5" />
                  )}
                  Confirm reject
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setRejecting(false)}
                  disabled={busy !== null}
                >
                  Back
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => void decide('approve')}
                  disabled={busy !== null || expired || !confirmed}
                >
                  {busy === 'approve' ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Check className="h-3.5 w-3.5" />
                  )}
                  {similar && allowSimilar ? 'Approve' : 'Approve once'}
                </Button>
                <Button
                  size="sm"
                  onClick={() => setRejecting(true)}
                  disabled={busy !== null || expired}
                >
                  <X className="h-3.5 w-3.5" /> Reject
                </Button>
                {onCancelRun && (
                  <Button size="sm" variant="ghost" onClick={onCancelRun} disabled={busy !== null}>
                    Cancel run
                  </Button>
                )}
              </>
            )}
            <span className="ml-auto text-xs text-zinc-500" aria-live="off">
              {expired ? 'Expired' : `Expires in ${formatRemaining(remaining)}`}
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
