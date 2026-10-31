import type { TaskPermissionDto } from '@friday/shared';
import type { Proposal } from '../tools/types.js';

/**
 * A task permission: the user approved, in one decision, a bounded set of actions for the current
 * run (exact files to create or modify, exact commands to run in the project root, browser flows
 * on named local sites). Matching
 * actions are approved automatically; they are still re-checked right before execution, recorded
 * as approvals linked to this one, and undoable. Anything else still asks the user.
 */
export interface TaskPermission {
  approvalId: string;
  runId: string;
  files: string[];
  commands: string[][];
  /** Origins (http://localhost:5173) where browser flows may run. */
  sites: string[];
  maxActions: number;
  used: number;
  expiresAt: number;
  ended: TaskPermissionDto['ended'];
}

export const TASK_PERMISSION_LIMITS = {
  maxFiles: 30,
  maxCommands: 10,
  maxSites: 5,
  defaultActions: 20,
  maxActions: 40,
  defaultMinutes: 30,
  maxMinutes: 60,
} as const;

/** Tools whose actions a task permission can cover. Nothing else ever can. */
const FILE_TOOLS = new Set(['write_file', 'edit_file', 'edit_files']);
const COMMAND_TOOL = 'run_command';
const FLOW_TOOL = 'run_browser_flow';

export function toDto(p: TaskPermission, now = Date.now()): TaskPermissionDto {
  const ended =
    p.ended ?? (now >= p.expiresAt ? 'expired' : p.used >= p.maxActions ? 'used_up' : null);
  return {
    approvalId: p.approvalId,
    runId: p.runId,
    files: p.files,
    commands: p.commands,
    sites: p.sites,
    maxActions: p.maxActions,
    used: p.used,
    expiresAt: new Date(p.expiresAt).toISOString(),
    active: ended === null,
    ended,
  };
}

/** A file entry covers the path itself, or everything below it when it ends in "/". */
export function fileCovered(files: string[], rel: string): boolean {
  return files.some((f) => (f.endsWith('/') ? rel.startsWith(f) : rel === f));
}

const sameArgv = (a: string[], b: string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

type Reviewable = Pick<Proposal, 'risk' | 'details' | 'confirmationRequired'>;

/**
 * What "allow similar actions for this task" may cover when the user approves this action:
 * exactly its files (created or modified), exactly its command (argv, project root, no shell,
 * no network), or browser flows on the same local site. Null when the action is not eligible:
 * everything else is always asked per action.
 */
export function similarScope(
  toolName: string,
  proposal: Reviewable,
): { files: string[]; commands: string[][]; sites: string[] } | null {
  if (proposal.confirmationRequired) return null;
  if (proposal.risk === 'high' || proposal.risk === 'critical') return null;
  const d = proposal.details;
  if (FILE_TOOLS.has(toolName) && d.kind === 'file_change') {
    if (!d.changes.length || d.changes.some((c) => c.change !== 'create' && c.change !== 'modify'))
      return null;
    return { files: d.changes.map((c) => c.path), commands: [], sites: [] };
  }
  if (toolName === COMMAND_TOOL && d.kind === 'command') {
    if (d.shell || !d.argv || d.cwd !== '.' || d.network) return null;
    return { files: [], commands: [d.argv], sites: [] };
  }
  if (toolName === FLOW_TOOL && d.kind === 'browser_flow')
    return { files: [], commands: [], sites: [d.origin] };
  return null;
}

/**
 * Whether `proposal` (already prepared and validated by its tool) falls entirely within the
 * permission. Judged on the proposal's own details, the same data the user would review, so
 * the model's raw arguments cannot be used to claim coverage.
 */
export function covers(
  p: TaskPermission | null,
  toolName: string,
  proposal: Reviewable,
  now = Date.now(),
): boolean {
  if (!p || !toDto(p, now).active) return false;
  // Production confirmations and high-risk actions always go to the user.
  if (proposal.confirmationRequired) return false;
  if (proposal.risk === 'high' || proposal.risk === 'critical') return false;
  const d = proposal.details;

  if (FILE_TOOLS.has(toolName) && d.kind === 'file_change') {
    return (
      d.changes.length > 0 &&
      d.changes.every(
        (c) => (c.change === 'create' || c.change === 'modify') && fileCovered(p.files, c.path),
      )
    );
  }
  if (toolName === COMMAND_TOOL && d.kind === 'command') {
    return (
      !d.shell &&
      d.argv !== null &&
      d.cwd === '.' &&
      !d.network &&
      p.commands.some((c) => sameArgv(c, d.argv!))
    );
  }
  if (toolName === FLOW_TOOL && d.kind === 'browser_flow') return p.sites.includes(d.origin);
  return false;
}
