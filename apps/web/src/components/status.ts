import type { MessageStatus, RunPhase, RunStatus } from '@friday/shared';
import type { Tone } from './ui/badge';

export const RUN_STATUS_TONE: Record<RunStatus, Tone> = {
  running: 'info',
  completed: 'success',
  failed: 'danger',
  cancelled: 'warning',
  interrupted: 'warning',
};

export const MESSAGE_STATUS_LABEL: Record<
  Exclude<MessageStatus, 'complete'>,
  { label: string; tone: Tone }
> = {
  partial: { label: 'incomplete', tone: 'warning' },
  cancelled: { label: 'stopped', tone: 'warning' },
  error: { label: 'failed', tone: 'danger' },
};

export const PHASE_LABEL: Record<RunPhase, string> = {
  preparing: 'Preparing context',
  compacting: 'Compacting conversation',
  waiting_for_model: 'Thinking',
  streaming: 'Responding',
};
