import type {
  ApprovalDto,
  DeploymentPlanDto,
  MemoryDto,
  MemoryRef,
  PlanStep,
  RunDto,
  RunEvent,
  RunPhase,
  ToolCallStatus,
} from '@friday/shared';
import { useEffect, useState } from 'react';

export type LiveBlock =
  | { kind: 'text'; text: string }
  | {
      kind: 'tool';
      callId: string;
      name: string;
      arguments: string;
      status: ToolCallStatus | 'running';
      summary: string;
      durationMs: number | null;
      /** Live terminal output for commands. */
      output: string;
    };

export interface LiveRun {
  runId: string;
  /** Streamed output in order: assistant text interleaved with tool activity. */
  blocks: LiveBlock[];
  phase: RunPhase | null;
  phaseDetail: string | null;
  plan: PlanStep[] | null;
  /** Approvals requested during this run, latest state by id. */
  approvals: Record<string, ApprovalDto>;
  /** Deployment plans recorded during this run. */
  deploymentPlans: DeploymentPlanDto[];
  /** Memories shown to the model for this run. */
  memoriesUsed: MemoryRef[];
  /** Memories the agent saved or proposed during this run. */
  memoriesSaved: MemoryDto[];
  finished: RunDto | null;
  connectionLost: boolean;
}

const EVENT_TYPES: RunEvent['type'][] = [
  'run_started',
  'phase',
  'text_delta',
  'tool_started',
  'tool_finished',
  'plan_updated',
  'approval_requested',
  'approval_resolved',
  'command_output',
  'deployment_plan',
  'memories_used',
  'memory_saved',
  'message_saved',
  'run_finished',
];

export const initial = (runId: string): LiveRun => ({
  runId,
  blocks: [],
  phase: null,
  phaseDetail: null,
  plan: null,
  approvals: {},
  deploymentPlans: [],
  memoriesUsed: [],
  memoriesSaved: [],
  finished: null,
  connectionLost: false,
});

const MAX_LIVE_OUTPUT = 200_000;

export function applyEvent(prev: LiveRun, event: RunEvent): LiveRun {
  const next = { ...prev, connectionLost: false };
  switch (event.type) {
    case 'text_delta': {
      const last = prev.blocks.at(-1);
      next.blocks =
        last?.kind === 'text'
          ? [...prev.blocks.slice(0, -1), { kind: 'text', text: last.text + event.delta }]
          : [...prev.blocks, { kind: 'text', text: event.delta }];
      break;
    }
    case 'tool_started':
      next.blocks = [
        ...prev.blocks,
        {
          kind: 'tool',
          callId: event.callId,
          name: event.name,
          arguments: event.arguments,
          status: 'running',
          summary: '',
          durationMs: null,
          output: '',
        },
      ];
      break;
    case 'command_output':
      next.blocks = prev.blocks.map((b) =>
        b.kind === 'tool' && b.callId === event.callId && b.output.length < MAX_LIVE_OUTPUT
          ? { ...b, output: b.output + event.chunk }
          : b,
      );
      break;
    case 'memories_used':
      next.memoriesUsed = event.memories;
      break;
    case 'memory_saved':
      next.memoriesSaved = [
        ...prev.memoriesSaved.filter((m) => m.id !== event.memory.id),
        event.memory,
      ];
      break;
    case 'deployment_plan':
      next.deploymentPlans = [
        ...prev.deploymentPlans.filter((p) => p.id !== event.plan.id),
        event.plan,
      ];
      break;
    case 'approval_requested':
    case 'approval_resolved':
      next.approvals = { ...prev.approvals, [event.approval.id]: event.approval };
      break;
    case 'tool_finished':
      next.blocks = prev.blocks.map((b) =>
        b.kind === 'tool' && b.callId === event.callId
          ? { ...b, status: event.status, summary: event.summary, durationMs: event.durationMs }
          : b,
      );
      // Calls skipped before starting (limits, cancellation) have no tool_started event.
      if (!prev.blocks.some((b) => b.kind === 'tool' && b.callId === event.callId)) {
        next.blocks.push({
          kind: 'tool',
          callId: event.callId,
          name: event.name,
          arguments: '',
          status: event.status,
          summary: event.summary,
          durationMs: event.durationMs,
          output: '',
        });
      }
      break;
    case 'phase':
      next.phase = event.phase;
      next.phaseDetail = event.detail ?? null;
      break;
    case 'plan_updated':
      next.plan = event.plan;
      break;
    case 'run_finished':
      next.finished = event.run;
      break;
    default:
      break;
  }
  return next;
}

/**
 * Follows a run's Server-Sent Events. EventSource reconnects automatically and sends
 * Last-Event-ID, so the server replays only what was missed.
 */
export function useRunStream(
  runId: string | null,
  onFinished: (run: RunDto) => void,
): LiveRun | null {
  const [live, setLive] = useState<LiveRun | null>(null);

  useEffect(() => {
    if (!runId) return;
    const source = new EventSource(`/api/runs/${runId}/events`);
    let lastSeq = 0;

    const handle = (raw: MessageEvent<string>) => {
      const event = JSON.parse(raw.data) as RunEvent;
      if (event.seq !== 0 && event.seq <= lastSeq) return;
      lastSeq = event.seq;
      setLive((prev) => applyEvent(prev?.runId === runId ? prev : initial(runId), event));
      if (event.type === 'run_finished') {
        source.close();
        onFinished(event.run);
      }
    };

    for (const type of EVENT_TYPES) source.addEventListener(type, handle as EventListener);
    source.onerror = () =>
      setLive((prev) => {
        const current = prev?.runId === runId ? prev : initial(runId);
        return current.finished ? current : { ...current, connectionLost: true };
      });
    return () => source.close();
    // onFinished is intentionally excluded: a new callback identity must not reopen the stream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  if (!runId) return null;
  return live?.runId === runId ? live : initial(runId);
}
