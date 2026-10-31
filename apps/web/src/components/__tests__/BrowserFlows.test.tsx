import type { ApprovalDto, BrowserFlowDto } from '@friday/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalCard } from '../ApprovalCard';
import { BrowserFlowCard } from '../BrowserFlowCard';
import { toolLabel } from '../ToolActivity';

afterEach(cleanup);

const approval: ApprovalDto = {
  id: 'ap',
  sessionId: 's',
  runId: 'r',
  projectId: null,
  toolCallId: 'c',
  toolName: 'run_browser_flow',
  category: 'browser',
  risk: 'medium',
  title: 'Browser flow: Sign in',
  summary: '3 steps on http://localhost:5173, in a fresh 1280×800 browser window.',
  reason: 'check the login form',
  details: {
    kind: 'browser_flow',
    title: 'Sign in',
    startUrl: 'http://localhost:5173/login',
    origin: 'http://localhost:5173',
    width: 1280,
    height: 800,
    steps: [
      { action: 'fill', description: 'Type "test@example.com" into field labelled "Email"' },
      { action: 'fill', description: 'Type "seed-password" into field labelled "Password"' },
      { action: 'click', description: 'Click button "Sign in"' },
    ],
    engine: 'chrome (chromium)',
    riskReasons: ["Types a password at step 2: only a test account's."],
  },
  actionHash: 'f'.repeat(64),
  status: 'pending',
  decisionNote: null,
  resultSummary: null,
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  decidedAt: null,
  confirmationRequired: null,
  grantedBy: null,
};

const flow: BrowserFlowDto = {
  id: 'fl',
  sessionId: 's',
  runId: 'r',
  toolCallId: 'c',
  projectId: null,
  title: 'Sign in',
  startUrl: 'http://localhost:5173/login',
  width: 1280,
  height: 800,
  engine: 'chrome',
  status: 'failed',
  durationMs: 6_200,
  createdAt: new Date().toISOString(),
  steps: [
    {
      index: 0,
      label: 'Open http://localhost:5173/login',
      status: 'passed',
      durationMs: 200,
      url: 'http://localhost:5173/login',
      title: 'Shop',
      problems: [],
      notes: [],
      error: null,
      attachmentId: 'a0',
    },
    {
      index: 1,
      label: 'Click button "Log in"',
      status: 'failed',
      durationMs: 5_000,
      url: 'http://localhost:5173/login',
      title: 'Shop',
      problems: ['console.error: boom'],
      notes: [],
      error: 'button "Log in" was not found.',
      attachmentId: 'a1',
    },
    {
      index: 2,
      label: 'Expect the page to show "Welcome"',
      status: 'skipped',
      durationMs: 0,
      url: null,
      title: null,
      problems: [],
      notes: [],
      error: null,
      attachmentId: null,
    },
  ],
};

describe('browser flows', () => {
  it('shows every step with its typed values before it runs, and can cover the site', () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    render(<ApprovalCard approval={approval} onDecide={onDecide} />);
    const steps = within(screen.getByRole('list', { name: 'Steps' })).getAllByRole('listitem');
    expect(steps.map((s) => s.textContent)).toEqual([
      'Type "test@example.com" into field labelled "Email"',
      'Type "seed-password" into field labelled "Password"',
      'Click button "Sign in"',
    ]);
    expect(screen.getByText('http://localhost:5173/login')).toBeTruthy();
    expect(screen.getByText(/Types a password at step 2/)).toBeTruthy();
    fireEvent.click(
      screen.getByLabelText(
        /Also allow more browser flows on http:\/\/localhost:5173 for this task/,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onDecide).toHaveBeenCalledWith('approve', undefined, undefined, true);
  });

  it('shows each result with its screenshot, the failure and page problems', () => {
    render(<BrowserFlowCard flow={flow} />);
    const card = screen.getByRole('region', { name: 'Browser flow: Sign in, failed' });
    expect(within(card).getByText('0 of 2 steps passed')).toBeTruthy();
    expect(within(card).getByRole('alert').textContent).toBe('button "Log in" was not found.');
    expect(within(card).getByRole('list', { name: 'Problems in step 1' }).textContent).toBe(
      'console.error: boom',
    );
    expect(within(card).queryByRole('button', { name: /after step 2/ })).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: 'View the screenshot after step 1' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('img').getAttribute('src')).toBe('/api/attachments/a1');
  });

  it('labels the browser tools', () => {
    expect(
      toolLabel('inspect_page', JSON.stringify({ url: 'http://localhost:5173', path: '/cart' })),
    ).toBe('http://localhost:5173/cart');
    expect(
      toolLabel('run_browser_flow', JSON.stringify({ title: 'Sign in', steps: [{}, {}, {}] })),
    ).toBe('Sign in (3 steps)');
  });
});
