import type {
  ApprovalDto,
  AttachmentDto,
  DeploymentPlanDto,
  ReviewDto,
  TestRunDto,
  ToolCallStatus,
} from '@friday/shared';
import { Ban, Check, ChevronRight, CircleSlash, Loader2, X } from 'lucide-react';
import { useState } from 'react';
import { cn } from '../lib/cn';
import { ApprovalCard } from './ApprovalCard';
import { AttachmentThumbs } from './Attachments';
import { DeploymentPlanCard } from './DeploymentPlanCard';
import { ReviewCard } from './ReviewCard';
import { TestRunCard } from './TestRunCard';
import { isFailedCommand } from './RunRecord';

export interface ToolItem {
  key: string;
  name: string;
  arguments: string;
  status: ToolCallStatus | 'running';
  summary: string;
  durationMs: number | null;
  /** Full result text, available once the result is persisted. */
  output?: string | undefined;
  truncated?: boolean | undefined;
  /** The approval this call went through, if it was a protected action. */
  approval?: ApprovalDto | undefined;
  /** Plan recorded by this call (prepare_deployment_plan). Always shown, never collapsed. */
  deploymentPlan?: DeploymentPlanDto | undefined;
  review?: ReviewDto | undefined;
  /** Results of a run_tests call. */
  testRun?: TestRunDto | undefined;
  /** Live process output while a command runs. */
  terminal?: string | undefined;
  /** Images the tool showed the model (view_image). */
  attachments?: AttachmentDto[] | undefined;
}

/** Compact, human-readable form of a tool call's arguments. */
export function toolLabel(name: string, argsJson: string): string {
  let a: Record<string, unknown>;
  try {
    a = JSON.parse(argsJson || '{}') as Record<string, unknown>;
  } catch {
    // Long arguments (a document's body) are stored clipped; the path still leads them.
    const p = /^\{\s*"path"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(argsJson);
    return p ? p[1]! : argsJson.slice(0, 80);
  }
  const str = (v: unknown) =>
    typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v);
  switch (name) {
    case 'read_file':
      return a.start_line || a.end_line
        ? `${str(a.path)}:${str(a.start_line ?? 1)}-${str(a.end_line ?? '')}`
        : str(a.path);
    case 'search_code':
      return `"${str(a.query)}"${a.path && a.path !== '.' ? ` in ${str(a.path)}` : ''}${a.glob ? ` (${str(a.glob)})` : ''}`;
    case 'list_directory':
      return str(a.path ?? '.');
    case 'find_files':
      return str(a.pattern);
    case 'file_info':
      return str(a.path);
    case 'update_plan':
      return Array.isArray(a.steps) ? `${a.steps.length} steps` : '';
    case 'inspect_project':
      return '';
    case 'write_file':
    case 'delete_file':
      return str(a.path);
    case 'edit_file':
      return `${str(a.path)}${Array.isArray(a.edits) ? ` (${a.edits.length} edit${a.edits.length === 1 ? '' : 's'})` : ''}`;
    case 'move_file':
      return `${str(a.from)} → ${str(a.to)}`;
    case 'edit_files':
      return Array.isArray(a.changes) ? `${a.changes.length} files` : '';
    case 'git_diff':
      return [a.staged ? '--staged' : '', str(a.ref), str(a.path)].filter(Boolean).join(' ');
    case 'git_log':
    case 'git_show':
      return [str(a.ref), str(a.path)].filter(Boolean).join(' ');
    case 'git_commit':
      return str(a.message).split('\n')[0]!;
    case 'git_create_branch':
      return str(a.name);
    case 'search_logs':
      return `${str(a.source)}${a.query ? ` "${str(a.query)}"` : ''}`;
    case 'inspect_docker':
      return `${str(a.view)}${a.container ? ` ${str(a.container)}` : ''}`;
    case 'validate_config':
      return str(a.path);
    case 'prepare_deployment_plan':
      return `${str(a.environment)}: ${str(a.title)}`;
    case 'remote_diagnose':
      return `${str(a.host)}: ${str(a.check)}${a.target ? ` ${str(a.target)}` : ''}`;
    case 'remote_command':
      return `${str(a.host)}: ${str(a.command)}`;
    case 'git_status':
    case 'git_branches':
    case 'inspect_environment':
      return '';
    case 'run_command':
      return Array.isArray(a.argv)
        ? (a.argv as unknown[]).map(str).join(' ')
        : str(a.shell_command);
    case 'start_process':
      return `${str(a.name)}: ${
        Array.isArray(a.argv) ? (a.argv as unknown[]).map(str).join(' ') : str(a.shell_command)
      }`;
    case 'read_process_output':
    case 'stop_process':
      return str(a.id);
    case 'list_processes':
      return '';
    case 'view_image':
      return str(a.path);
    case 'create_document':
    case 'create_spreadsheet':
    case 'create_presentation':
      return str(a.path);
    case 'screenshot':
      return `${str(a.url ?? a.process_id)}${a.path ? str(a.path) : ''}${a.full_page ? ' (full page)' : ''}`;
    case 'code_map':
      return str(a.path ?? '.');
    case 'find_symbol':
      return `${str(a.name)}${a.references ? ' +refs' : ''}`;
    case 'detect_tests':
      return '';
    case 'run_tests': {
      const scope =
        a.scope === 'all'
          ? 'all tests'
          : a.scope === 'files'
            ? Array.isArray(a.files)
              ? (a.files as unknown[]).map(str).join(' ')
              : 'chosen tests'
            : 'tests related to the changes';
      return `${scope}${a.suite && a.suite !== '.' ? ` in ${str(a.suite)}` : ''}${a.coverage ? ', with coverage' : ''}`;
    }
    default:
      return Object.values(a).map(str).join(' ').slice(0, 80);
  }
}

const STATUS_ICON = {
  running: <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-400" aria-label="running" />,
  awaiting: (
    <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-400" aria-label="awaiting approval" />
  ),
  completed: <Check className="h-3.5 w-3.5 text-emerald-400" aria-label="completed" />,
  error: <X className="h-3.5 w-3.5 text-red-400" aria-label="failed" />,
  denied: <Ban className="h-3.5 w-3.5 text-amber-400" aria-label="denied" />,
  skipped: <CircleSlash className="h-3.5 w-3.5 text-zinc-500" aria-label="skipped" />,
} as const;

function ToolRow({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false);
  const live = item.status === 'running' && !!item.terminal;
  const expandable =
    !!item.output || !!item.approval || !!item.terminal || !!item.attachments?.length;
  const shown = open || live;
  const label = toolLabel(item.name, item.arguments);
  return (
    <li>
      <button
        type="button"
        disabled={!expandable}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={expandable ? shown : undefined}
        className={cn(
          'flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs',
          expandable && 'hover:bg-zinc-800/70',
        )}
      >
        <ChevronRight
          className={cn(
            'h-3 w-3 shrink-0 text-zinc-500 transition-transform',
            shown && 'rotate-90',
            !expandable && 'opacity-0',
          )}
          aria-hidden
        />
        {item.status === 'running' && item.approval?.status === 'pending'
          ? STATUS_ICON.awaiting
          : item.status === 'completed' &&
              item.name === 'run_command' &&
              isFailedCommand(item.summary)
            ? STATUS_ICON.error
            : STATUS_ICON[item.status]}
        <span className="font-mono text-zinc-200">{item.name}</span>
        {label && <span className="min-w-0 truncate font-mono text-zinc-400">{label}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-2 pl-2 text-zinc-500">
          {item.summary && <span className="max-w-72 truncate">{item.summary}</span>}
          {item.durationMs !== null && item.status !== 'running' && (
            <span>{item.durationMs} ms</span>
          )}
        </span>
      </button>
      {shown && item.approval && (
        <div className="mx-2 mb-1 rounded border border-zinc-800 bg-zinc-950/60">
          <ApprovalCard approval={item.approval} onDecide={async () => undefined} compact />
        </div>
      )}
      {shown && (item.output ?? item.terminal) && (
        <pre
          aria-label={live ? 'Live command output' : 'Tool output'}
          className="mx-2 mb-1 mt-0.5 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded border border-zinc-800 bg-black p-2 font-mono text-[0.75rem] leading-snug text-zinc-300"
        >
          {item.output ?? item.terminal}
          {item.truncated && '\n[output was truncated before being sent to the model]'}
        </pre>
      )}
      {/* Screenshots are the point of the call: always visible, like an attached image. */}
      {(shown || item.name === 'screenshot') && item.attachments && (
        <AttachmentThumbs attachments={item.attachments} className="mx-2 mb-1" />
      )}
    </li>
  );
}

/** A group of consecutive tool calls, shown as a compact timeline. */
export function ToolActivity({ items }: { items: ToolItem[] }) {
  if (items.length === 0) return null;
  const plans = items.flatMap((i) => (i.deploymentPlan ? [i.deploymentPlan] : []));
  const reviews = items.flatMap((i) => (i.review ? [i.review] : []));
  const testRuns = items.flatMap((i) => (i.testRun ? [i.testRun] : []));
  return (
    <>
      <div className="ml-10 rounded-lg border border-zinc-800 bg-zinc-900/40 py-1">
        <ul aria-label="Tool activity">
          {items.map((item) => (
            <ToolRow key={item.key} item={item} />
          ))}
        </ul>
      </div>
      {plans.map((p) => (
        <DeploymentPlanCard key={p.id} plan={p} />
      ))}
      {reviews.map((r) => (
        <ReviewCard key={r.id} review={r} />
      ))}
      {testRuns.map((t) => (
        <TestRunCard key={t.id} run={t} />
      ))}
    </>
  );
}
