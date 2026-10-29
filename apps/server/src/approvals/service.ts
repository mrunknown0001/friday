import { randomUUID } from 'node:crypto';
import type { ApprovalDto } from '@friday/shared';
import { HttpError } from '../http/errors.js';
import type { ApprovalRepo, NewApproval } from '../repositories/approvals.js';
import type { AuditRepo } from '../repositories/telemetry.js';
import { computeActionHash } from './stateMachine.js';

export type ApprovalOutcome =
  | { outcome: 'approved'; approval: ApprovalDto; allowSimilar?: boolean }
  | { outcome: 'rejected'; approval: ApprovalDto; note: string | null }
  | { outcome: 'expired'; approval: ApprovalDto | null }
  | { outcome: 'cancelled'; approval: ApprovalDto | null };

interface Waiter {
  resolve: (o: ApprovalOutcome) => void;
  timer: NodeJS.Timeout;
  onAbort: () => void;
  signal: AbortSignal;
}

export interface ApprovalRequest extends Omit<NewApproval, 'id' | 'actionHash' | 'expiresAt'> {
  projectRoot: string | null;
  args: unknown;
  fingerprint: string;
  /** Shorter validity for sensitive actions (never longer than the configured TTL). */
  ttlMs?: number;
}

export interface DecisionInput {
  decision: 'approve' | 'reject';
  /** The hash shown to the user; must match for an approval to count. */
  actionHash: string;
  sessionId: string;
  note?: string | undefined;
  /** Typed confirmation, required when the approval sets `confirmationRequired`. */
  confirmation?: string | undefined;
  /**
   * Also allow further actions of the same kind for this task (same files, or the same exact
   * command). Honoured only for eligible actions; see similarScope.
   */
  allowSimilar?: boolean | undefined;
}

/**
 * Coordinates human decisions with waiting agent runs. Decisions only arrive through the HTTP
 * API (a user action); there is no code path from a tool call to `decide`.
 */
export class ApprovalService {
  private readonly waiters = new Map<string, Waiter>();

  constructor(
    private readonly repo: ApprovalRepo,
    private readonly audit: AuditRepo,
    private readonly ttlMs: number,
  ) {}

  request(req: ApprovalRequest): ApprovalDto {
    const id = randomUUID();
    const { projectRoot, args, fingerprint, ttlMs, ...rest } = req;
    const actionHash = computeActionHash({
      approvalId: id,
      sessionId: req.sessionId,
      projectRoot,
      tool: req.toolName,
      args,
      fingerprint,
    });
    const approval = this.repo.create({
      ...rest,
      id,
      actionHash,
      expiresAt: new Date(Date.now() + Math.min(this.ttlMs, ttlMs ?? this.ttlMs)).toISOString(),
    });
    this.audit.record({
      sessionId: req.sessionId,
      actor: 'agent',
      action: 'approval_requested',
      details: {
        approvalId: id,
        tool: req.toolName,
        category: req.category,
        risk: req.risk,
        title: req.title,
      },
    });
    return approval;
  }

  /** Recompute the hash for the same approval with freshly observed preconditions. */
  hashFor(approval: ApprovalDto, projectRoot: string | null, args: unknown, fingerprint: string) {
    return computeActionHash({
      approvalId: approval.id,
      sessionId: approval.sessionId,
      projectRoot,
      tool: approval.toolName,
      args,
      fingerprint,
    });
  }

  /** Resolves when the user decides, the request expires, or the run is cancelled. */
  wait(approval: ApprovalDto, signal: AbortSignal): Promise<ApprovalOutcome> {
    return new Promise((resolve) => {
      const finish = (o: ApprovalOutcome) => {
        const w = this.waiters.get(approval.id);
        if (!w) return;
        clearTimeout(w.timer);
        w.signal.removeEventListener('abort', w.onAbort);
        this.waiters.delete(approval.id);
        resolve(o);
      };
      const onAbort = () => {
        const updated = this.repo.transition(approval.id, 'pending', 'cancelled', {
          decisionNote: 'The run was cancelled.',
        });
        finish({ outcome: 'cancelled', approval: updated });
      };
      const ms = Math.max(0, Date.parse(approval.expiresAt) - Date.now());
      const timer = setTimeout(() => {
        const updated = this.repo.transition(approval.id, 'pending', 'expired');
        if (updated) {
          this.audit.record({
            sessionId: approval.sessionId,
            actor: 'system',
            action: 'approval_expired',
            details: { approvalId: approval.id },
          });
        }
        finish({ outcome: 'expired', approval: updated });
      }, ms);
      this.waiters.set(approval.id, { resolve: finish, timer, onAbort, signal });
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  decide(id: string, input: DecisionInput): ApprovalDto {
    const approval = this.repo.get(id);
    if (!approval) throw new HttpError(404, 'approval_not_found', 'Approval not found.');
    if (approval.sessionId !== input.sessionId) {
      throw new HttpError(
        403,
        'wrong_session',
        'This approval belongs to a different conversation.',
      );
    }
    if (approval.status !== 'pending') {
      throw new HttpError(
        409,
        'approval_not_pending',
        `This request is already ${approval.status}.`,
      );
    }
    const waiter = this.waiters.get(id);
    if (Date.now() >= Date.parse(approval.expiresAt)) {
      const updated = this.repo.transition(id, 'pending', 'expired');
      waiter?.resolve({ outcome: 'expired', approval: updated });
      throw new HttpError(409, 'approval_expired', 'This request expired before it was approved.');
    }
    if (!waiter) {
      this.repo.transition(id, 'pending', 'cancelled', {
        decisionNote: 'No run was waiting for this approval.',
      });
      throw new HttpError(
        409,
        'run_not_waiting',
        'The run that asked for this is no longer active.',
      );
    }
    if (
      input.decision === 'approve' &&
      approval.confirmationRequired &&
      input.confirmation?.trim() !== approval.confirmationRequired
    ) {
      throw new HttpError(
        409,
        'confirmation_required',
        `Type "${approval.confirmationRequired}" to confirm this action.`,
      );
    }
    if (input.decision === 'approve' && input.actionHash !== approval.actionHash) {
      throw new HttpError(
        409,
        'action_changed',
        'The action differs from the one you reviewed. Reload and review it again.',
      );
    }

    const note = input.note?.trim() ? input.note.trim().slice(0, 2_000) : null;
    const updated = this.repo.transition(
      id,
      'pending',
      input.decision === 'approve' ? 'approved' : 'rejected',
      { decisionNote: note },
    );
    if (!updated) {
      throw new HttpError(409, 'approval_not_pending', 'This request was already decided.');
    }
    this.audit.record({
      sessionId: approval.sessionId,
      actor: 'user',
      action: input.decision === 'approve' ? 'approval_approved' : 'approval_rejected',
      details: {
        approvalId: id,
        tool: approval.toolName,
        actionHash: approval.actionHash,
        note,
        ...(input.decision === 'approve' && input.allowSimilar ? { allowSimilar: true } : {}),
      },
    });
    waiter.resolve(
      input.decision === 'approve'
        ? { outcome: 'approved', approval: updated, allowSimilar: input.allowSimilar === true }
        : { outcome: 'rejected', approval: updated, note },
    );
    return updated;
  }

  /**
   * Approve an action because it falls within a task permission the user approved earlier
   * (`grantedBy` is that approval). Only the run manager calls this, after `covers` matched the
   * prepared proposal; the action is still re-checked before it runs.
   */
  approveByPermission(id: string, grantedBy: string): ApprovalDto | null {
    const updated = this.repo.transition(id, 'pending', 'approved', {
      decisionNote: 'Approved automatically: covered by the task permission you approved.',
      grantedBy,
    });
    if (updated) {
      this.audit.record({
        sessionId: updated.sessionId,
        actor: 'system',
        action: 'approval_approved_by_task_permission',
        details: {
          approvalId: id,
          grantedBy,
          tool: updated.toolName,
          actionHash: updated.actionHash,
        },
      });
    }
    return updated;
  }

  /** Record what happened after an approved action ran. */
  complete(
    id: string,
    to: 'executed' | 'failed' | 'stale',
    resultSummary: string,
  ): ApprovalDto | null {
    const updated = this.repo.transition(id, 'approved', to, {
      resultSummary: resultSummary.slice(0, 500),
    });
    if (updated) {
      this.audit.record({
        sessionId: updated.sessionId,
        actor: 'system',
        action: `approval_${to}`,
        details: { approvalId: id, tool: updated.toolName, result: resultSummary.slice(0, 200) },
      });
    }
    return updated;
  }
}
