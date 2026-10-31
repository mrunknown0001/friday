import type {
  ApprovalDto,
  AttachmentDto,
  BrowserFlowDto,
  DeploymentPlanDto,
  LoadTestDto,
  ResearchDto,
  MemoryDto,
  MemoryRef,
  PlanStep,
  ReviewDto,
  RunDto,
  RunEvent,
  RunPhase,
  TaskPermissionDto,
  TestRunDto,
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
      /** Images the tool produced (screenshots). */
      attachments?: AttachmentDto[];
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
  /** Code reviews reported during this run. */
  reviews: ReviewDto[];
  /** Test runs (run_tests) finished during this run. */
  testRuns: TestRunDto[];
  /** Browser flows (run_browser_flow) finished during this run. */
  browserFlows: BrowserFlowDto[];
  /** Load tests (run_load_test) finished during this run. */
  loadTests: LoadTestDto[];
  /** Deep research (deep_research) in this run, latest state of each. */
  research: ResearchDto[];
  /** Memories shown to the model for this run. */
  memoriesUsed: MemoryRef[];
  /** Memories the agent saved or proposed during this run. */
  memoriesSaved: MemoryDto[];
  /** Latest state of the task permission granted in this run, if any. */
  taskPermission: TaskPermissionDto | null;
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
  'task_permission',
  'command_output',
  'deployment_plan',
  'review',
  'test_run',
  'browser_flow',
  'load_test',
  'research',
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
  reviews: [],
  testRuns: [],
  browserFlows: [],
  loadTests: [],
  research: [],
  memoriesUsed: [],
  memoriesSaved: [],
  taskPermission: null,
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
    case 'review':
      next.reviews = [...prev.reviews.filter((r) => r.id !== event.review.id), event.review];
      break;
    case 'test_run':
      next.testRuns = [...prev.testRuns.filter((t) => t.id !== event.testRun.id), event.testRun];
      break;
    case 'load_test':
      next.loadTests = [
        ...prev.loadTests.filter((t) => t.id !== event.loadTest.id),
        event.loadTest,
      ];
      break;
    case 'research':
      next.research = [...prev.research.filter((r) => r.id !== event.research.id), event.research];
      break;
    case 'browser_flow':
      next.browserFlows = [...prev.browserFlows.filter((f) => f.id !== event.flow.id), event.flow];
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
          ? {
              ...b,
              status: event.status,
              summary: event.summary,
              durationMs: event.durationMs,
              ...(event.attachments ? { attachments: event.attachments } : {}),
            }
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
    case 'task_permission':
      next.taskPermission = event.permission;
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
