import type { ReviewDto, ReviewFinding } from '@friday/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../lib/api';
import { fixRequest, ReviewActionsContext, ReviewCard } from '../ReviewCard';
import { reviewRequest, ReviewStartDialog } from '../ReviewStartDialog';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
  this.open = true;
};
HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
  this.open = false;
};

const finding = (over: Partial<ReviewFinding> = {}): ReviewFinding => ({
  n: 1,
  severity: 'high',
  title: 'Skips the first item',
  file: 'cart.js',
  line: 3,
  reason: 'The loop starts at 1, so cartTotal([{price: 2}]) returns 0.',
  suggestion: { oldText: 'let i = 1', newText: 'let i = 0', applies: true },
  fix: null,
  location: 'in_change',
  status: 'open',
  ...over,
});

const review = (findings: ReviewFinding[]): ReviewDto => ({
  id: 'rv1',
  sessionId: 's',
  runId: 'r',
  toolCallId: 'c',
  target: {
    kind: 'pull_request',
    label: 'pull request #7: Add tax',
    base: 'main',
    head: 'tax',
    url: 'https://github.com/o/shop/pull/7',
  },
  summary: 'One real bug, one nit.',
  findings,
  createdAt: '',
});

function show(r: ReviewDto, send = vi.fn().mockResolvedValue(true)) {
  render(
    <ReviewActionsContext.Provider value={{ projectId: 'p1', canSend: true, send }}>
      <ReviewCard review={r} />
    </ReviewActionsContext.Provider>,
  );
  return send;
}

describe('review card', () => {
  it('lists findings with severity, location, reason and the suggested change', () => {
    show(
      review([
        finding(),
        finding({
          n: 2,
          severity: 'nit',
          title: 'Naming',
          line: 2,
          suggestion: null,
          fix: 'Rename total to sum.',
          location: 'outside_change',
        }),
        finding({
          n: 3,
          severity: 'medium',
          title: 'Ghost',
          reason: 'A file that is not there.',
          file: 'nope.js',
          line: 9,
          suggestion: null,
          location: 'not_found',
        }),
      ]),
    );
    const card = screen.getByRole('region', { name: 'Code review: pull request #7: Add tax' });
    expect(within(card).getByText('1 high')).toBeTruthy();
    expect(within(card).getByText('1 nit')).toBeTruthy();
    expect(within(card).getByText('cart.js:3')).toBeTruthy();
    expect(within(card).getByText(/cartTotal\(\[\{price: 2\}\]\) returns 0/)).toBeTruthy();
    const change = within(card).getByLabelText('Suggested change for finding 1');
    expect(change.textContent).toContain('− let i = 1');
    expect(change.textContent).toContain('+ let i = 0');
    expect(within(card).getByText('not in the changed lines')).toBeTruthy();
    expect(within(card).getByText('file or line not found: check before acting')).toBeTruthy();
    // Nits start collapsed.
    expect(within(card).queryByText('Fix: Rename total to sum.')).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: 'Show finding 2' }));
    expect(within(card).getByText('Fix: Rename total to sum.')).toBeTruthy();
    expect(
      within(card)
        .getByRole('link', { name: /on GitHub/ })
        .getAttribute('href'),
    ).toBe('https://github.com/o/shop/pull/7');
  });

  it('asks Friday for exactly the suggested fix, then marks it requested', async () => {
    const status = vi
      .spyOn(api, 'setFindingStatus')
      .mockResolvedValue(review([finding({ status: 'fix_requested' })]));
    const send = show(review([finding()]));
    fireEvent.click(screen.getByRole('button', { name: /Fix this/ }));
    await waitFor(() => expect(status).toHaveBeenCalledWith('rv1', 1, 'fix_requested'));
    expect(send).toHaveBeenCalledWith(fixRequest(finding()));
    expect(fixRequest(finding())).toContain(
      'replace\n```\nlet i = 1\n```\nwith\n```\nlet i = 0\n```',
    );
    expect(await screen.findByText('fix requested')).toBeTruthy();
  });

  it('dismisses and restores findings', async () => {
    vi.spyOn(api, 'setFindingStatus')
      .mockResolvedValueOnce(review([finding({ status: 'dismissed' })]))
      .mockResolvedValueOnce(review([finding()]));
    show(review([finding()]));
    fireEvent.click(screen.getByRole('button', { name: /Dismiss/ }));
    expect(await screen.findByRole('button', { name: /Restore/ })).toBeTruthy();
    expect(screen.getByText('no open findings')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Restore/ }));
    expect(await screen.findByRole('button', { name: /Fix this/ })).toBeTruthy();
  });

  it('opens the file at the finding’s line', async () => {
    vi.spyOn(api, 'projectFile').mockResolvedValue({
      path: 'cart.js',
      content: 'a\nb\nlet i = 1\n',
      language: null,
      binary: false,
      tooLarge: false,
      size: 12,
    } as Awaited<ReturnType<typeof api.projectFile>>);
    show(review([finding()]));
    fireEvent.click(screen.getByRole('button', { name: 'cart.js:3' }));
    expect(await screen.findByText('cart.js:3', { selector: 'h2' })).toBeTruthy();
    expect(await screen.findByTestId('line-mark')).toBeTruthy();
  });
});

describe('starting a review', () => {
  it('writes the request for each kind of target', () => {
    expect(reviewRequest('uncommitted', {})).toBe(
      "Review my uncommitted changes. Report the findings; don't change any files.",
    );
    expect(reviewRequest('branch', { base: 'develop', focus: 'security' })).toBe(
      "Review this branch against develop. Focus on: security. Report the findings; don't change any files.",
    );
    expect(reviewRequest('pull_request', { number: 12 })).toContain('Review pull request #12.');
  });

  it('needs a number for a pull request', () => {
    const onStart = vi.fn();
    render(<ReviewStartDialog onClose={vi.fn()} onStart={onStart} />);
    fireEvent.click(screen.getByRole('radio', { name: /A pull request/ }));
    const start = screen.getByRole('button', { name: /Start review/ }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Pull request number'), { target: { value: '12' } });
    fireEvent.click(start);
    expect(onStart).toHaveBeenCalledWith(
      reviewRequest('pull_request', { number: 12, base: '', focus: '' }),
    );
  });
});
