import type { PermissionCategory } from '@friday/shared';

export type PolicyDecision =
  | { action: 'allow' }
  | { action: 'deny'; reason: string }
  | { action: 'require_approval'; reason: string };

/**
 * Backend-enforced permission policy. The model only proposes tool calls; this decides.
 *
 * Phase 2 allows read-only inspection and the agent's own plan state. Every mutating category is
 * denied outright until the approval engine (Phase 3) exists, after which they will map to
 * `require_approval`. Unknown categories are denied. Nothing here can be changed by a tool call.
 */
export function decide(category: PermissionCategory | undefined): PolicyDecision {
  switch (category) {
    case 'read_only':
    case 'agent_state':
      return { action: 'allow' };
    case undefined:
      return { action: 'deny', reason: 'Unknown tool.' };
    default:
      return {
        action: 'deny',
        reason: `Tools in the "${category}" category are not enabled yet; Friday is currently read-only.`,
      };
  }
}
