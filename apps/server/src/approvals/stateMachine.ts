import { createHash } from 'node:crypto';
import type { ApprovalStatus } from '@friday/shared';

/**
 * Allowed approval transitions. Terminal states have no outgoing edges.
 *
 *   pending ──approve──▶ approved ──▶ executed | failed | stale
 *      │
 *      ├──reject──▶ rejected
 *      ├──timeout─▶ expired
 *      └──cancel──▶ cancelled        (run cancelled, server restart)
 *
 * An approval authorizes exactly one execution: `approved` can only move to a terminal state.
 */
export const TRANSITIONS: Record<ApprovalStatus, readonly ApprovalStatus[]> = {
  pending: ['approved', 'rejected', 'expired', 'cancelled'],
  approved: ['executed', 'failed', 'stale', 'cancelled'],
  rejected: [],
  expired: [],
  cancelled: [],
  executed: [],
  failed: [],
  stale: [],
};

export function canTransition(from: ApprovalStatus, to: ApprovalStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/**
 * Binds an approval to one specific action: its id (no replay across approvals), session,
 * project root, tool, exact arguments, and the preconditions observed when it was proposed
 * (e.g. the hash of the file being edited). Any difference produces a different hash.
 */
export function computeActionHash(input: {
  approvalId: string;
  sessionId: string;
  projectRoot: string | null;
  tool: string;
  args: unknown;
  fingerprint: string;
}): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(input)))
    .digest('hex');
}
