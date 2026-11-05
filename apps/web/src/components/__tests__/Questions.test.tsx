import type { MessageDto, QuestionDto, SessionDetailDto } from '@friday/shared';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../lib/api';
import { ChatView } from '../ChatView';
import { QuestionCard } from '../QuestionCard';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const detail = (over: Partial<SessionDetailDto> = {}): SessionDetailDto => ({
  id: 's1',
  projectId: null,
  title: 'Chat',
  createdAt: '2026-11-03T10:00:00.000Z',
  updatedAt: '2026-11-03T10:00:00.000Z',
  lastRunStatus: null,
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
  mode: 'auto',
  memoryUsage: {},
  ...over,
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
  onRollback: async () => {},
  onOpenMemory: () => {},
  onRevokeTaskPermission: async () => {},
  onAnswerQuestion: async () => {},
  mode: 'auto' as const,
  onModeChange: () => {},
  onSwitchMode: async () => {},
});

const question = (over: Partial<QuestionDto> = {}): QuestionDto => ({
  id: 'q1',
  sessionId: 's1',
  runId: 'r1',
  toolCallId: 'c1',
  questions: [
    {
      question: 'Which database?',
      header: 'Database',
      options: [
        { label: 'Redis', description: 'Already running' },
        { label: 'Postgres', description: null },
      ],
      multiSelect: false,
    },
    {
      question: 'Which environments?',
      header: null,
      options: [
        { label: 'staging', description: null },
        { label: 'production', description: null },
      ],
      multiSelect: true,
    },
  ],
  answers: null,
  status: 'pending',
  createdAt: '2026-11-03T10:00:00.000Z',
  expiresAt: '2026-11-03T10:15:00.000Z',
  answeredAt: null,
  ...over,
});

const composer = () => screen.getByLabelText('Message') as HTMLTextAreaElement;

describe('prompt enhancement', () => {
  it('asks first, writes the prompt from the answers, and can be undone', async () => {
    const enhance = vi
      .spyOn(api, 'enhancePrompt')
      .mockResolvedValueOnce({
        kind: 'questions',
        questions: [
          {
            question: 'Which page is slow?',
            header: 'Page',
            options: [
              { label: 'Cart', description: null },
              { label: 'Checkout', description: 'The payment step' },
            ],
            multiSelect: false,
          },
        ],
      })
      .mockResolvedValueOnce({ kind: 'prompt', prompt: 'Find why the cart page is slow.' });
    render(<ChatView {...props(detail())} />);
    const improve = screen.getByRole('button', { name: 'Improve prompt' });
    expect((improve as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(composer(), { target: { value: 'make it faster' } });
    await act(async () => fireEvent.click(improve));
    expect(enhance).toHaveBeenLastCalledWith({
      draft: 'make it faster',
      projectId: null,
      sessionId: 's1',
    });

    const panel = screen.getByRole('region', { name: 'Questions about your prompt' });
    const write = within(panel).getByRole('button', { name: 'Write prompt' }) as HTMLButtonElement;
    // Every question needs an answer: an option or the user's own words.
    expect(write.disabled).toBe(true);
    fireEvent.click(within(panel).getByRole('radio', { name: /Cart/ }));
    fireEvent.change(within(panel).getByLabelText('Your own answer: Which page is slow?'), {
      target: { value: 'on mobile' },
    });
    expect(write.disabled).toBe(false);
    await act(async () => fireEvent.click(write));
    expect(enhance).toHaveBeenLastCalledWith({
      draft: 'make it faster',
      projectId: null,
      sessionId: 's1',
      answers: [{ question: 'Which page is slow?', answer: 'Cart; on mobile' }],
    });
    expect(composer().value).toBe('Find why the cart page is slow.');
    expect(screen.queryByRole('region', { name: 'Questions about your prompt' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(composer().value).toBe('make it faster');
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('works from the keyboard: Ctrl+E improves, Esc closes the questions, Ctrl+Z undoes', async () => {
    const asks = { kind: 'questions' as const, questions: question().questions.slice(0, 1) };
    const enhance = vi
      .spyOn(api, 'enhancePrompt')
      .mockResolvedValueOnce(asks)
      .mockResolvedValueOnce(asks)
      .mockResolvedValueOnce({ kind: 'prompt', prompt: 'Add a Redis cache.' });
    render(<ChatView {...props(detail())} />);
    fireEvent.change(composer(), { target: { value: 'add cache' } });
    await act(async () => fireEvent.keyDown(composer(), { key: 'e', ctrlKey: true }));
    expect(screen.getByRole('region', { name: 'Questions about your prompt' })).toBeTruthy();
    fireEvent.keyDown(composer(), { key: 'Escape' });
    expect(screen.queryByRole('region', { name: 'Questions about your prompt' })).toBeNull();

    // Skipping the questions asks for the prompt without them.
    await act(async () => fireEvent.keyDown(composer(), { key: 'e', ctrlKey: true }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Skip questions' })));
    expect(enhance).toHaveBeenCalledTimes(3);
    expect(enhance).toHaveBeenLastCalledWith({
      draft: 'add cache',
      projectId: null,
      sessionId: 's1',
      noQuestions: true,
    });
    expect(composer().value).toBe('Add a Redis cache.');
    fireEvent.keyDown(composer(), { key: 'z', ctrlKey: true });
    expect(composer().value).toBe('add cache');
  });

  it('shows why it could not improve the prompt', async () => {
    vi.spyOn(api, 'enhancePrompt').mockRejectedValue(
      new Error('Select a model in Settings first.'),
    );
    render(<ChatView {...props(detail())} />);
    fireEvent.change(composer(), { target: { value: 'add cache' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Improve prompt' })));
    expect(screen.getByRole('alert').textContent).toContain('Select a model in Settings first.');
    expect(composer().value).toBe('add cache');
  });
});

describe('question card', () => {
  it('takes one option, several where allowed, or the user’s own words', async () => {
    const onAnswer = vi.fn(async () => {});
    render(<QuestionCard question={question()} onAnswer={onAnswer} />);
    const card = screen.getByRole('region', { name: 'Friday has a question' });
    const answer = within(card).getByRole('button', { name: 'Answer' }) as HTMLButtonElement;
    expect(answer.disabled).toBe(true);

    fireEvent.click(within(card).getByRole('radio', { name: /Redis/ }));
    fireEvent.click(within(card).getByRole('radio', { name: /Postgres/ }));
    expect((within(card).getByRole('radio', { name: /Redis/ }) as HTMLInputElement).checked).toBe(
      false,
    );
    fireEvent.click(within(card).getByRole('checkbox', { name: 'staging' }));
    fireEvent.click(within(card).getByRole('checkbox', { name: 'production' }));
    fireEvent.change(within(card).getByLabelText('Your own answer: Which environments?'), {
      target: { value: 'not on Fridays' },
    });
    await act(async () => fireEvent.click(answer));
    expect(onAnswer).toHaveBeenCalledWith({
      answers: [
        { selected: ['Postgres'], text: null },
        { selected: ['staging', 'production'], text: 'not on Fridays' },
      ],
    });

    await act(async () =>
      fireEvent.click(within(card).getByRole('button', { name: 'Let Friday decide' })),
    );
    expect(onAnswer).toHaveBeenLastCalledWith({ skip: true });
  });

  it('shows a failed answer, and what was answered afterwards', async () => {
    const { rerender } = render(
      <QuestionCard
        question={question()}
        onAnswer={async () => {
          throw new Error('The run that asked this is no longer active.');
        }}
      />,
    );
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Let Friday decide' })),
    );
    expect(screen.getByRole('alert').textContent).toBe(
      'The run that asked this is no longer active.',
    );

    rerender(
      <QuestionCard
        question={question({
          status: 'answered',
          answers: [
            { selected: ['Redis'], text: null },
            { selected: ['staging'], text: 'first' },
          ],
        })}
      />,
    );
    const card = screen.getByRole('region', { name: 'Friday asked' });
    expect(within(card).queryByRole('button')).toBeNull();
    expect(card.textContent).toContain('Which database?Redis');
    expect(card.textContent).toContain('Which environments?staging; first');
    expect(card.textContent).toContain('answered');
  });

  it('waits at the end of the conversation, and joins its tool call once answered', async () => {
    const onAnswerQuestion = vi.fn(async () => {});
    const tool: MessageDto = {
      id: 2,
      sessionId: 's1',
      runId: 'r1',
      role: 'tool',
      content: 'The user answered',
      status: 'complete',
      model: null,
      createdAt: '2026-11-03T10:01:00.000Z',
      toolCallId: 'c1',
      tool: {
        name: 'ask_user',
        arguments: '{"questions":[{"question":"Which database?"}]}',
        status: 'completed',
        summary: 'answered',
        durationMs: 1000,
        approvalId: null,
      },
    } as MessageDto;
    const { rerender } = render(
      <ChatView
        {...props(detail({ questions: [question()] }))}
        onAnswerQuestion={onAnswerQuestion}
      />,
    );
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Let Friday decide' })),
    );
    expect(onAnswerQuestion).toHaveBeenCalledWith(expect.objectContaining({ id: 'q1' }), {
      skip: true,
    });

    rerender(
      <ChatView
        {...props(detail({ messages: [tool], questions: [question({ status: 'skipped' })] }))}
      />,
    );
    await waitFor(() => expect(screen.getByRole('region', { name: 'Friday asked' })).toBeTruthy());
    expect(screen.queryByRole('region', { name: 'Friday has a question' })).toBeNull();
    expect(screen.getByText('Friday decided')).toBeTruthy();
  });

  it('keeps its hidden choice inputs inside the scrolling conversation', () => {
    // The radios and checkboxes are visually hidden and absolutely positioned. Unless an ancestor
    // inside the scroller is positioned, they are placed outside it: the page grows blank space
    // and a scrollbar, and focusing a choice scrolls the whole window.
    render(<ChatView {...props(detail({ questions: [question()] }))} />);
    const card = screen.getByRole('region', { name: 'Friday has a question' });
    const inputs = [
      ...within(card).getAllByRole('radio'),
      ...within(card).getAllByRole('checkbox'),
    ];
    expect(inputs).toHaveLength(4);
    for (const input of inputs) expect(input.closest('label')!.className).toMatch(/\brelative\b/);
    const scroller = card.closest('.overflow-y-auto')!;
    expect(scroller.className).toMatch(/\brelative\b/);
    // Nor does the conversation scroll sideways: its content wraps (see .chat-wrap).
    expect(scroller.className).toMatch(/\boverflow-x-hidden\b/);
    expect(scroller.firstElementChild!.className).toMatch(/\bchat-wrap\b/);
  });
});
