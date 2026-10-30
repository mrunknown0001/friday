import type { MessageDto, SessionDetailDto } from '@friday/shared';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatView } from '../ChatView';

const message = (id: number, role: 'user' | 'assistant', content: string): MessageDto => ({
  id,
  sessionId: 's1',
  runId: null,
  role,
  content,
  status: 'complete',
  model: role === 'assistant' ? 'test-model' : null,
  createdAt: '2026-10-29T10:00:00.000Z',
});

const detail = (messages: MessageDto[]): SessionDetailDto => ({
  id: 's1',
  projectId: null,
  title: 'Chat',
  createdAt: '2026-10-29T10:00:00.000Z',
  updatedAt: '2026-10-29T10:00:00.000Z',
  lastRunStatus: null,
  messages,
  latestRun: null,
  hasSummary: false,
  plan: null,
  approvals: [],
  runs: [],
  deploymentPlans: [],
  reviews: [],
  testRuns: [],
  memoryUsage: {},
});

const props = (d: SessionDetailDto) => ({
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
  reviews: [],
  testRuns: [],
  onRollback: async () => {},
  onOpenMemory: () => {},
  onRevokeTaskPermission: async () => {},
});

// jsdom has no layout: give the conversation a fixed viewport and a tall content height.
const VIEWPORT = 500;
const CONTENT = 3000;
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(CONTENT);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(VIEWPORT);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function conversation(el: HTMLElement) {
  return el.querySelector('[aria-live="polite"]') as HTMLDivElement;
}

describe('scroll to latest', () => {
  it('appears when scrolled up, flags new activity, and jumps to the bottom', () => {
    const first = [message(1, 'user', 'hello'), message(2, 'assistant', 'hi')];
    const { container, rerender } = render(<ChatView {...props(detail(first))} />);
    const list = conversation(container);
    const scrollTo = vi.fn();
    list.scrollTo = scrollTo;

    // At the bottom: no button.
    expect(screen.queryByRole('button', { name: /scroll to latest/i })).toBeNull();

    // Scroll up.
    act(() => {
      list.scrollTop = 200;
      fireEvent.scroll(list);
    });
    expect(screen.getByRole('button', { name: 'Scroll to latest' })).toBeTruthy();

    // A new message arrives while scrolled up: the view stays put and the button says so.
    rerender(<ChatView {...props(detail([...first, message(3, 'assistant', 'more')]))} />);
    expect(list.scrollTop).toBe(200);
    const button = screen.getByRole('button', { name: 'Scroll to latest (new activity)' });
    expect(button.textContent).toContain('New activity');

    fireEvent.click(button);
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: CONTENT }));

    // Back at the bottom: the button goes away.
    act(() => {
      list.scrollTop = CONTENT - VIEWPORT;
      fireEvent.scroll(list);
    });
    expect(screen.queryByRole('button', { name: /scroll to latest/i })).toBeNull();
  });
});
