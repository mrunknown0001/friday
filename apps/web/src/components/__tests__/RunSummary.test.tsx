import type { ApprovalDto, RunDto, RunReport } from '@friday/shared';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalCard } from '../ApprovalCard';
import { RunSummary } from '../RunSummary';

afterEach(cleanup);

const report = (over: Partial<RunReport> = {}): RunReport => ({
  status: 'failed',
  note: '`npm test` did not pass after the last change (exit code 1 (0.2s)).',
  files: [
    { path: 'src/cart.js', change: 'modify', fromPath: null, reverted: false, modifiedSince: true },
    { path: 'old.txt', change: 'delete', fromPath: null, reverted: true, modifiedSince: false },
  ],
  commands: [
    {
      title: 'npm test',
      result: 'exit code 1 (0.2s)',
      exitCode: 1,
      verification: true,
      afterLastChange: true,
    },
    {
      title: 'ls',
      result: 'exit code 0 (0.0s)',
      exitCode: 0,
      verification: false,
      afterLastChange: false,
    },
  ],
  commits: ['abc1234 Fix cart'],
  ...over,
});

const run = (r: RunReport | null): RunDto => ({
  id: 'r1',
  sessionId: 's1',
  status: 'completed',
  model: 'm',
  errorKind: null,
  errorMessage: null,
  retryable: false,
  startedAt: '',
  finishedAt: '',
  checkpoint: null,
  suggestions: null,
  report: r,
});

describe('RunSummary', () => {
  it('shows a failed verification with files, commands, commits and drift', () => {
    render(<RunSummary run={run(report())} approvals={[]} onRollback={vi.fn()} />);
    const card = screen.getByRole('group', { name: 'Verification report' });
    expect(within(card).getByText('verification failed')).toBeTruthy();
    expect(within(card).getByText(/did not pass after the last change/)).toBeTruthy();
    expect(within(card).getByText('edited elsewhere since')).toBeTruthy();
    expect(within(card).getByText('undone')).toBeTruthy();
    expect(within(card).getByText('check after last change')).toBeTruthy();
    expect(within(card).getByLabelText('failed')).toBeTruthy();
    expect(within(card).getByText(/abc1234 Fix cart/)).toBeTruthy();
  });

  it('offers rollback only while changes remain, and calls it', async () => {
    const onRollback = vi.fn().mockResolvedValue(undefined);
    const { unmount } = render(
      <RunSummary
        run={run(report({ status: 'verified', note: 'ok' }))}
        approvals={[]}
        onRollback={onRollback}
      />,
    );
    expect(screen.getByText('verified')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /Roll back this run/ }));
    expect(onRollback).toHaveBeenCalledWith('r1');
    unmount();
    render(
      <RunSummary
        run={run(
          report({
            status: 'no_changes',
            note: 'All file changes from this run were undone.',
            files: [
              { path: 'a', change: 'modify', fromPath: null, reverted: true, modifiedSince: false },
            ],
          }),
        )}
        approvals={[]}
        onRollback={onRollback}
      />,
    );
    expect(screen.queryByRole('button', { name: /Roll back/ })).toBeNull();
  });

  it('falls back to the plain run record without a report', () => {
    const approval = {
      id: 'a',
      title: 'Run: ls',
      status: 'executed',
      resultSummary: 'exit code 0 (0.1s)',
    } as ApprovalDto;
    render(<RunSummary run={run(null)} approvals={[approval]} onRollback={vi.fn()} />);
    expect(screen.getByRole('group', { name: 'Run record' })).toBeTruthy();
  });
});

describe('ApprovalCard: git', () => {
  it('shows branch, commit message, hooks, files, and that nothing is pushed', () => {
    const a = {
      id: 'g',
      sessionId: 's',
      runId: 'r',
      projectId: 'p',
      toolCallId: 'c',
      toolName: 'git_commit',
      category: 'git',
      risk: 'high',
      title: 'Commit 1 file to main',
      summary: 'Stages and commits only the listed paths on main. Nothing is pushed.',
      reason: 'user asked',
      details: {
        kind: 'git',
        operation: 'commit',
        branch: 'main',
        head: 'abcdef1234567890',
        message: 'Fix cart total\n\nStart at index 0.',
        newBranch: null,
        hooks: ['pre-commit'],
        files: [
          {
            path: 'src/cart.js',
            change: 'modify',
            diff: '@@ -1 +1 @@\n-a\n+b\n',
            added: 1,
            removed: 1,
          },
        ],
      },
      actionHash: 'f'.repeat(64),
      status: 'pending',
      decisionNote: null,
      resultSummary: null,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      decidedAt: null,
    } as ApprovalDto;
    render(<ApprovalCard approval={a} onDecide={vi.fn()} />);
    expect(screen.getByText('main')).toBeTruthy();
    expect(screen.getByText('abcdef123456')).toBeTruthy();
    expect(screen.getByLabelText('Commit message').textContent).toBe(
      'Fix cart total\n\nStart at index 0.',
    );
    expect(screen.getByText(/hooks will run during the commit: pre-commit/)).toBeTruthy();
    expect(screen.getByText(/nothing leaves this machine/)).toBeTruthy();
    expect(screen.getByText('src/cart.js')).toBeTruthy();
    expect(screen.getByText('high risk')).toBeTruthy();
  });
});
