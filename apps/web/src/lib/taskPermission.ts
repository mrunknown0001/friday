import type { ApprovalDto } from '@friday/shared';

/**
 * Whether an approval can also "allow similar actions for this task": file creations or
 * modifications, an exact command in the project root without a shell or network, or browser
 * flows on the same local site, at most medium risk. Mirrors the server's similarScope, which is
 * what actually decides.
 */
export function canAllowSimilar(a: ApprovalDto): 'files' | 'command' | 'site' | null {
  if (a.confirmationRequired || a.risk === 'high' || a.risk === 'critical') return null;
  const d = a.details;
  if (['write_file', 'edit_file', 'edit_files'].includes(a.toolName) && d.kind === 'file_change') {
    return d.changes.length > 0 &&
      d.changes.every((c) => c.change === 'create' || c.change === 'modify')
      ? 'files'
      : null;
  }
  if (a.toolName === 'run_command' && d.kind === 'command') {
    return !d.shell && d.argv && d.cwd === '.' && !d.network ? 'command' : null;
  }
  if (a.toolName === 'run_browser_flow' && d.kind === 'browser_flow') return 'site';
  return null;
}
