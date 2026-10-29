import type { PermissionCategory } from '@friday/shared';

export type PolicyDecision =
  { action: 'allow' } | { action: 'deny'; reason: string } | { action: 'require_approval' };

/**
 * Backend-enforced permission policy. The model only proposes tool calls; this decides.
 *
 * - Read-only inspection and the agent's own plan state run without approval.
 * - File creation, modification, deletion/movement and local commands always need a fresh,
 *   per-action approval from the user. There is no "always allow" or autonomous mode.
 * - Git mutations (commit, branch) also need approval. Network, remote, database and deployment
 *   categories are denied until their tools and
 *   safeguards exist. Unknown categories are denied.
 *
 * Nothing here can be changed by a tool call or by model output.
 */
export function decide(category: PermissionCategory | undefined): PolicyDecision {
  switch (category) {
    case 'read_only':
    case 'agent_state':
      return { action: 'allow' };
    case 'file_create':
    case 'file_modify':
    case 'file_delete':
    case 'shell':
    case 'git':
      return { action: 'require_approval' };
    case undefined:
      return { action: 'deny', reason: 'Unknown tool.' };
    default:
      return {
        action: 'deny',
        reason: `Tools in the "${category}" category are not enabled.`,
      };
  }
}
