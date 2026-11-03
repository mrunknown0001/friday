import type { MessageDto, RunDto, SessionDetailDto } from '@friday/shared';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatView } from '../ChatView';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const runOf = (over: Partial<RunDto>): RunDto => ({
  id: 'r1',
  sessionId: 's1',
  status: 'completed',
  mode: 'plan',
  model: 'test-model',
  errorKind: null,
  errorMessage: null,
  retryable: false,
  startedAt: '2026-11-03T10:00:00.000Z',
  finishedAt: '2026-11-03T10:01:00.000Z',
  checkpoint: null,
  report: null,
  suggestions: null,
  ...over,
});

const reply: MessageDto = {
  id: 2,
  sessionId: 's1',
  runId: 'r1',
  role: 'assistant',
  content: 'Here is the plan.',
  status: 'complete',
  model: 'test-model',
  createdAt: '2026-11-03T10:01:00.000Z',
};

const detail = (over: Partial<SessionDetailDto> = {}): SessionDetailDto => ({
  id: 's1',
  projectId: null,
  title: 'Chat',
  createdAt: '2026-11-03T10:00:00.000Z',
  updatedAt: '2026-11-03T10:00:00.000Z',
  lastRunStatus: null,
  mode: 'plan',
  messages: [],
  latestRun: null,
  hasSummary: false,
  plan: null,
  approvals: [],
  runs: [],
  deploymentPlans: [],
  reviews: [],
  testRuns: [],
  browserFlows: [],
  loadTests: [],
  research: [],
  questions: [],
  memoryUsage: {},
  ...over,
});

const props = (d: SessionDetailDto | null) => ({
  detail: d,
  project: null,
  live: null,
  canSend: true,
  blockedReason: null,
  sidePanelOpen: false,
  onToggleSidePanel: () => {},
  onSend: async () => true,
  onStop: () => {},
  onRetry: () => {},
  onOpenSettings: () => {},
  approvals: [],
  onDecide: async () => {},
  deploymentPlans: [],
  onRollback: async () => {},
  onOpenMemory: () => {},
  onRevokeTaskPermission: async () => {},
  onAnswerQuestion: async () => {},
  mode: 'plan' as const,
  onModeChange: () => {},
  onSwitchMode: async () => {},
});

describe('modes', () => {
  it('picks the mode next to the message box, with a hint for each', () => {
    const onModeChange = vi.fn();
    const { rerender } = render(
      <ChatView {...props(null)} mode="auto" onModeChange={onModeChange} />,
    );
    const picker = screen.getByRole('button', { name: 'Mode: Auto' });
    expect(picker.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(picker);
    const list = screen.getByRole('listbox', { name: 'Mode' });
    const options = within(list).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([
      'AutoFriday chooses how to work (it may suggest another mode)',
      'CodeImplement changes and verify them',
      'PlanInvestigate and write a plan; changes nothing until you accept it',
      'DebugReproduce the problem, find the cause, fix it and prove it',
      'AskAnswers and explanations only; reads, never changes anything',
    ]);
    expect(options[0]!.getAttribute('aria-selected')).toBe('true');
    fireEvent.click(options[3]!);
    expect(onModeChange).toHaveBeenCalledWith('debug');
    expect(screen.queryByRole('listbox')).toBeNull();

    // Keyboard: open with an arrow, move, choose with Enter; Escape closes without a change.
    fireEvent.keyDown(picker, { key: 'ArrowDown' });
    const keys = screen.getByRole('listbox', { name: 'Mode' });
    fireEvent.keyDown(keys, { key: 'ArrowDown' });
    fireEvent.keyDown(keys, { key: 'Enter' });
    expect(onModeChange).toHaveBeenLastCalledWith('code');
    fireEvent.click(picker);
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onModeChange).toHaveBeenCalledTimes(2);

    rerender(<ChatView {...props(null)} mode="ask" onModeChange={onModeChange} />);
    expect(screen.getByLabelText('Message').getAttribute('placeholder')).toBe(
      'Ask a question; Friday only reads in this mode…',
    );
    expect(screen.getByRole('button', { name: 'Mode: Ask' }).getAttribute('title')).toBe(
      'Ask mode: Answers and explanations only; reads, never changes anything',
    );
  });

  it('marks replies with their mode and offers to build an accepted plan', async () => {
    const onSwitchMode = vi.fn(async () => {});
    const run = runOf({
      suggestions: [
        {
          label: 'Accept and build',
          prompt: 'I accept the plan. Carry it out step by step, keeping the plan up to date.',
          action: 'switch_mode',
          mode: 'code',
          source: 'records',
        },
      ],
    });
    render(
      <ChatView
        {...props(detail({ messages: [reply], runs: [run], latestRun: run }))}
        onSwitchMode={onSwitchMode}
      />,
    );
    // The reply says it was written in plan mode.
    expect(screen.getByText('Plan', { selector: 'span' })).toBeTruthy();

    const chips = screen.getByRole('group', { name: 'Suggested next steps' });
    const accept = within(chips).getByRole('button', { name: /Accept and build/ });
    expect(accept.getAttribute('title')).toBe(
      'Switch this conversation to code mode and send: I accept the plan. Carry it out step by step, keeping the plan up to date.',
    );
    await act(async () => fireEvent.click(accept));
    expect(onSwitchMode).toHaveBeenCalledWith(
      'code',
      'I accept the plan. Carry it out step by step, keeping the plan up to date.',
    );
  });
});
