import type { ApprovalDto } from '@friday/shared';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalCard } from '../ApprovalCard';
import { parseUnifiedDiff } from '../DiffView';

afterEach(cleanup);

const DIFF = `--- a/src/cart.js
+++ b/src/cart.js
@@ -3,3 +3,3 @@
 export function cartTotal(items) {
-  for (let i = 1; i < items.length; i++) {
+  for (let i = 0; i < items.length; i++) {
     total += items[i].price;
`;

function approval(over: Partial<ApprovalDto> = {}): ApprovalDto {
  return {
    id: 'a1',
    sessionId: 's1',
    runId: 'r1',
    projectId: 'p1',
    toolCallId: 'c1',
    toolName: 'edit_file',
    category: 'file_modify',
    risk: 'medium',
    title: 'Edit src/cart.js',
    summary: 'Applies 1 edit to src/cart.js (+1 −1).',
    reason: 'Fix the off-by-one in the loop',
    details: {
      kind: 'file_change',
      changes: [{ path: 'src/cart.js', change: 'modify', diff: DIFF, added: 1, removed: 1 }],
    },
    actionHash: 'f'.repeat(64),
    status: 'pending',
    decisionNote: null,
    resultSummary: null,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    decidedAt: null,
    confirmationRequired: null,
    grantedBy: null,
    ...over,
  };
}

describe('ApprovalCard: file changes', () => {
  it('shows the file, counts, reason, and a line-numbered diff', () => {
    render(<ApprovalCard approval={approval()} onDecide={vi.fn()} />);
    const card = screen.getByRole('region', { name: /Approval request: Edit src\/cart.js/ });
    expect(within(card).getByText('src/cart.js')).toBeTruthy();
    expect(within(card).getByText('+1')).toBeTruthy();
    expect(within(card).getByText('−1')).toBeTruthy();
    expect(within(card).getByText(/Fix the off-by-one/)).toBeTruthy();
    expect(within(card).getByText('medium risk')).toBeTruthy();
    const diff = within(card).getByRole('table', { name: 'Diff' });
    const removed = diff.querySelector('tr[data-kind="del"]')!;
    const added = diff.querySelector('tr[data-kind="add"]')!;
    expect(removed.textContent).toContain('for (let i = 1;');
    expect(added.textContent).toContain('for (let i = 0;');
    // Old/new line numbers come from the hunk header.
    expect(removed.querySelectorAll('td')[0]!.textContent).toBe('4');
    expect(added.querySelectorAll('td')[1]!.textContent).toBe('4');
    expect(within(card).getByText(/Expires in 1?\d:\d\d/)).toBeTruthy();
  });

  it('approves once', async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    render(<ApprovalCard approval={approval()} onDecide={onDecide} />);
    await userEvent.click(screen.getByRole('button', { name: /Approve once/ }));
    expect(onDecide).toHaveBeenCalledExactlyOnceWith('approve', undefined, undefined, undefined);
  });

  it('rejects with an optional note, only after confirmation', async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    render(<ApprovalCard approval={approval()} onDecide={onDecide} />);
    await userEvent.click(screen.getByRole('button', { name: /Reject/ }));
    expect(onDecide).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText(/Optional note/), 'Use for...of instead');
    await userEvent.click(screen.getByRole('button', { name: /Confirm reject/ }));
    expect(onDecide).toHaveBeenCalledExactlyOnceWith(
      'reject',
      'Use for...of instead',
      undefined,
      undefined,
    );
  });

  it('offers cancelling the whole run', async () => {
    const onCancelRun = vi.fn();
    render(<ApprovalCard approval={approval()} onDecide={vi.fn()} onCancelRun={onCancelRun} />);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel run' }));
    expect(onCancelRun).toHaveBeenCalledOnce();
  });

  it('disables approval once expired', () => {
    render(
      <ApprovalCard
        approval={approval({ expiresAt: new Date(Date.now() - 1000).toISOString() })}
        onDecide={vi.fn()}
      />,
    );
    expect(
      (screen.getByRole('button', { name: /Approve once/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getAllByText(/expired/i).length).toBeGreaterThan(0);
  });

  it('shows decided approvals without action buttons', () => {
    render(
      <ApprovalCard
        approval={approval({ status: 'rejected', decisionNote: 'Not now' })}
        onDecide={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: /Approve once/ })).toBeNull();
    expect(screen.getByText('rejected')).toBeTruthy();
    expect(screen.getByText('Not now')).toBeTruthy();
  });
});

describe('ApprovalCard: commands', () => {
  const cmd = approval({
    toolName: 'run_command',
    category: 'shell',
    risk: 'high',
    title: 'Run: npm install left-pad',
    details: {
      kind: 'command',
      argv: ['npm', 'install', 'left pad'],
      shellCommand: null,
      shell: false,
      cwd: 'packages/app',
      host: 'local',
      timeoutSeconds: 120,
      env: ['CI', 'HOME', 'PATH'],
      network: true,
      riskReasons: [
        'Installs or fetches packages with npm; this downloads code and may run its install scripts.',
      ],
      sandbox: null,
    },
  });

  it('says when a command runs in the project container, and what it can reach', () => {
    const details = cmd.details as Extract<ApprovalDto['details'], { kind: 'command' }>;
    render(
      <ApprovalCard
        approval={{
          ...cmd,
          details: {
            ...details,
            sandbox: {
              image: 'node:22-bookworm-slim',
              network: 'none',
              hiddenCredentials: 2,
              gitReadOnly: true,
            },
          },
        }}
        onDecide={vi.fn()}
      />,
    );
    const runs = screen.getByText(/In a container/);
    expect(runs.textContent).toContain('node:22-bookworm-slim');
    expect(runs.textContent).toContain('no network');
    expect(runs.textContent).toContain('.git read-only');
    expect(runs.textContent).toContain('2 credential files hidden');
    expect(screen.getByText(/the container has none/)).toBeTruthy();
  });

  it('shows the exact command, working directory, shell use, host, environment and risks', () => {
    render(<ApprovalCard approval={cmd} onDecide={vi.fn()} />);
    expect(screen.getByLabelText('Exact command').textContent).toBe("$ npm install 'left pad'");
    expect(screen.getByText('packages/app')).toBeTruthy();
    expect(screen.getByText(/No: program run directly/)).toBeTruthy();
    expect(screen.getByText(/On this machine, as your user/)).toBeTruthy();
    expect(screen.getByText('Likely')).toBeTruthy();
    expect(screen.getByText('CI HOME PATH')).toBeTruthy();
    expect(screen.getByText(/may run its install scripts/)).toBeTruthy();
    expect(screen.getByText('high risk')).toBeTruthy();
  });

  it('shows shell scripts verbatim and says a shell is involved', () => {
    const shell = {
      ...cmd,
      details: {
        ...cmd.details,
        argv: null,
        shellCommand: 'npm test 2>&1 | tail -n 20',
        shell: true,
      },
    } as ApprovalDto;
    render(<ApprovalCard approval={shell} onDecide={vi.fn()} />);
    expect(screen.getByLabelText('Exact command').textContent).toBe('$ npm test 2>&1 | tail -n 20');
    expect(screen.getByText(/Yes: interpreted by \/bin\/sh/)).toBeTruthy();
  });
});

describe('parseUnifiedDiff', () => {
  it('tracks line numbers across hunks and skips file headers', () => {
    const lines = parseUnifiedDiff(
      '--- a/x\n+++ b/x\n@@ -10,2 +10,3 @@\n a\n+b\n c\n@@ -30 +31 @@\n-d\n+e\n\\ No newline at end of file',
    );
    expect(lines.map((l) => [l.kind, l.oldNo, l.newNo])).toEqual([
      ['hunk', null, null],
      ['ctx', 10, 10],
      ['add', null, 11],
      ['ctx', 11, 12],
      ['hunk', null, null],
      ['del', 30, null],
      ['add', null, 31],
      ['meta', null, null],
    ]);
  });
});

describe('RunRecord', () => {
  it('reports failed commands from records even when the model says it passed', async () => {
    const { RunRecord } = await import('../RunRecord');
    render(
      <RunRecord
        approvals={[
          approval({
            id: 'e',
            status: 'executed',
            title: 'Edit src/cart.js',
            resultSummary: 'edited src/cart.js (+1 −1)',
          }),
          approval({
            id: 'n',
            status: 'executed',
            title: 'Run: npm test',
            resultSummary: 'exit code 1 (0.2s)',
          }),
          approval({
            id: 'o',
            status: 'executed',
            title: 'Run: node --test',
            resultSummary: 'exit code 0 (0.1s)',
          }),
          approval({
            id: 'r',
            status: 'rejected',
            title: 'Delete README.md',
            decisionNote: 'keep it',
          }),
          approval({ id: 'p', status: 'pending', title: 'Still pending' }),
        ]}
      />,
    );
    const record = screen.getByRole('group', { name: 'Run record' });
    expect(within(record).getByText(/1 did not succeed/)).toBeTruthy();
    expect(within(record).getByText('exit code 1 (0.2s)').className).toContain('text-red');
    expect(within(record).getByText('rejected: keep it')).toBeTruthy();
    expect(within(record).queryByText('Still pending')).toBeNull();
  });
});
