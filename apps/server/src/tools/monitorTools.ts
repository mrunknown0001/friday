import type { MonitorDto } from '@friday/shared';
import { z } from 'zod';
import { describeTarget } from '../monitors/checks.js';
import { WorkspaceError } from '../workspace/paths.js';
import { defineTool, type ToolContext } from './types.js';

/**
 * Health monitors are defined by the user in the Monitors panel; the model can only read their
 * status and history (e.g. to diagnose why one is failing). It cannot add, change or pause them.
 */

const ago = (iso: string | null, now: number) => {
  if (!iso) return 'never';
  const min = Math.round((now - Date.parse(iso)) / 60_000);
  return min < 1 ? 'just now' : min < 120 ? `${min} min ago` : `${Math.round(min / 60)} h ago`;
};

function line(m: MonitorDto, ctx: ToolContext, now: number): string {
  const host = (id: string) => ctx.devops?.hosts.get(id)?.name ?? null;
  const status =
    m.status === 'down'
      ? `DOWN since ${m.statusSince} (${m.consecutiveFailures} failed checks in a row)`
      : m.status === 'up'
        ? `up${m.consecutiveFailures ? ` (last ${m.consecutiveFailures} check${m.consecutiveFailures === 1 ? '' : 's'} failed)` : ''}`
        : m.status;
  return `"${m.name}": ${status}. Checks ${describeTarget(m.target, host)} every ${m.intervalMinutes} min. Last check ${ago(m.lastCheckedAt, now)}${m.lastMessage ? `: ${m.lastMessage}` : ''}.`;
}

export const monitorStatus = defineTool({
  name: 'monitor_status',
  description:
    "Read the health monitors the user set up (URLs, SSH hosts, background processes, compose services): each one's status (up, down, pending, paused) and last result. With name: also its recent checks and when it went down or recovered. Read-only; only the user can add or change monitors (Monitors panel).",
  category: 'read_only',
  risk: 'none',
  requiresProject: false,
  schema: z.object({ name: z.string().trim().min(1).max(60).optional() }),
  describeCall: (a) => a.name ?? 'all',
  async execute(args, ctx) {
    if (!ctx.monitors) throw new WorkspaceError('unsupported', 'Monitors are not available here.');
    const now = Date.now();
    if (!args.name) {
      const all = ctx.monitors.list();
      if (!all.length)
        return {
          content:
            'No health monitors are set up. The user can add them in the Monitors panel; you cannot.',
          summary: 'none',
        };
      const down = all.filter((m) => m.status === 'down').length;
      return {
        content: all.map((m) => line(m, ctx, now)).join('\n'),
        summary: `${all.length} monitor${all.length === 1 ? '' : 's'}${down ? `, ${down} down` : ''}`,
      };
    }
    const m = ctx.monitors.byName(args.name);
    if (!m)
      throw new WorkspaceError(
        'not_found',
        `No monitor named "${args.name}". Monitors: ${
          ctx.monitors
            .list()
            .map((x) => `"${x.name}"`)
            .join(', ') || 'none'
        }.`,
      );
    const detail = ctx.monitors.detail(m.id, 20)!;
    const project = m.projectId ? ctx.project?.id === m.projectId : null;
    return {
      content: [
        line(m, ctx, now),
        project === false ? 'It belongs to another project than this conversation.' : null,
        '',
        'Recent checks (newest first):',
        ...detail.checks.map(
          (c) =>
            `${c.at} ${c.ok ? 'OK  ' : 'FAIL'} ${c.durationMs !== null ? `${c.durationMs} ms ` : ''}${c.message}`,
        ),
        '',
        'Status changes (newest first):',
        ...(detail.events.length
          ? detail.events.map((e) => `${e.at} ${e.status.toUpperCase()}: ${e.message}`)
          : ['(none yet)']),
      ]
        .filter((l) => l !== null)
        .join('\n'),
      summary: m.status,
    };
  },
});
