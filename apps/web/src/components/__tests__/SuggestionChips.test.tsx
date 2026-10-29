import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SuggestionChips } from '../SuggestionChips';

afterEach(cleanup);

const steps = [
  {
    label: 'Run npm test',
    prompt: 'Run `npm test` now and report the actual result.',
    action: 'prompt' as const,
    source: 'records' as const,
  },
  {
    label: 'Review 1 proposed memory',
    prompt: '',
    action: 'open_memory' as const,
    source: 'records' as const,
  },
  {
    label: 'Add an empty-cart test',
    prompt: 'Add a test for cartTotal([]) returning 0.',
    action: 'prompt' as const,
    source: 'model' as const,
  },
];

describe('SuggestionChips', () => {
  it('sends the chip prompt, opens memory, and marks where each came from', async () => {
    const onPrompt = vi.fn();
    const onOpenMemory = vi.fn();
    render(
      <SuggestionChips
        steps={steps}
        disabled={false}
        onPrompt={onPrompt}
        onOpenMemory={onOpenMemory}
      />,
    );
    const group = screen.getByRole('group', { name: 'Suggested next steps' });
    expect(group).toBeTruthy();
    expect(screen.getByLabelText("from Friday's records")).toBeTruthy();
    expect(screen.getByLabelText('suggested by the model')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Run npm test/ }).getAttribute('title')).toBe(
      'Run `npm test` now and report the actual result.',
    );
    await userEvent.click(screen.getByRole('button', { name: /Run npm test/ }));
    expect(onPrompt).toHaveBeenCalledWith('Run `npm test` now and report the actual result.');
    await userEvent.click(screen.getByRole('button', { name: /Review 1 proposed memory/ }));
    expect(onOpenMemory).toHaveBeenCalledOnce();
    expect(onPrompt).toHaveBeenCalledOnce();
  });

  it('is inert while disabled and renders nothing without steps', async () => {
    const onPrompt = vi.fn();
    const { unmount } = render(
      <SuggestionChips steps={steps} disabled onPrompt={onPrompt} onOpenMemory={vi.fn()} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Add an empty-cart test/ }));
    expect(onPrompt).not.toHaveBeenCalled();
    unmount();
    const { container } = render(
      <SuggestionChips steps={[]} disabled={false} onPrompt={onPrompt} onOpenMemory={vi.fn()} />,
    );
    expect(container.innerHTML).toBe('');
  });
});

describe('chat rows (regression: report hidden behind suggestion tool row)', async () => {
  const { toRows } = await import('../ChatView');
  it('anchors the run record to the last visible message when suggest_next_steps ends the run', () => {
    const base = { sessionId: 's', status: 'complete' as const, model: null, createdAt: '' };
    const messages = [
      { ...base, id: 1, runId: null, role: 'user' as const, content: 'fix it' },
      {
        ...base,
        id: 2,
        runId: 'r1',
        role: 'assistant' as const,
        content: 'Fixed.',
        toolCalls: [{ id: 'c', name: 'suggest_next_steps', arguments: '{}' }],
      },
      {
        ...base,
        id: 3,
        runId: 'r1',
        role: 'tool' as const,
        content: 'Suggestions recorded.',
        toolCallId: 'c',
        tool: {
          callId: 'c',
          name: 'suggest_next_steps',
          arguments: '{}',
          status: 'completed' as const,
          summary: '',
          durationMs: 1,
          truncated: false,
          approvalId: null,
        },
      },
    ];
    const approval = { id: 'a', runId: 'r1' } as Parameters<typeof toRows>[1] extends Map<
      string,
      infer A
    >
      ? A
      : never;
    const rows = toRows(messages, new Map([['a', approval]]), new Map(), {});
    expect(rows.map((r) => r.kind)).toEqual(['user', 'assistant', 'record']);
  });
});
