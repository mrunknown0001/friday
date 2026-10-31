import type { ApprovalDto, TaskPermissionDto } from '@friday/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyEvent, initial } from '../../lib/useRunStream';
import { ApprovalCard } from '../ApprovalCard';
import { TaskPermissionBanner } from '../TaskPermissionBanner';

afterEach(cleanup);

const request: ApprovalDto = {
  id: 'g1',
  sessionId: 's1',
  runId: 'r1',
  projectId: 'p1',
  toolCallId: 'c1',
  toolName: 'request_task_permissions',
  category: 'task_permission',
  risk: 'medium',
  title: 'Task permission: 2 files, 1 command',
  summary: 'Lets Friday edit src/cart.js, test/ and run npm test without asking each time.',
  reason: 'Fix and verify',
  details: {
    kind: 'task_permissions',
    plan: ['Fix the loop', 'Run the tests'],
    files: ['src/cart.js', 'test/'],
    commands: [['npm', 'test']],
    maxActions: 20,
    minutes: 30,
  },
  actionHash: 'a'.repeat(64),
  status: 'pending',
  decisionNote: null,
  resultSummary: null,
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  decidedAt: null,
  confirmationRequired: null,
  grantedBy: null,
};

const permission = (over: Partial<TaskPermissionDto> = {}): TaskPermissionDto => ({
  approvalId: 'g1',
  runId: 'r1',
  files: ['src/cart.js', 'test/'],
  commands: [['npm', 'test']],
  sites: [],
  maxActions: 20,
  used: 3,
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  active: true,
  ended: null,
  ...over,
});

describe('task permission request card', () => {
  it('shows the plan, exact scope, limits and what still asks', () => {
    render(<ApprovalCard approval={request} onDecide={vi.fn()} />);
    const card = screen.getByRole('region', { name: /Task permission/ });
    expect(card.textContent).toContain('Fix the loop');
    expect(card.textContent).toContain('src/cart.js');
    expect(card.textContent).toContain('test/ (anything in this folder)');
    expect(card.textContent).toContain('$ npm test');
    expect(card.textContent).toContain('up to 20 actions within 30 minutes');
    expect(card.textContent).toMatch(/Deleting or moving files, git, remote servers/);
    expect(screen.getByRole('button', { name: /approve/i })).toBeTruthy();
  });
});

describe('allow similar actions while approving', () => {
  const edit: ApprovalDto = {
    ...request,
    id: 'e1',
    toolName: 'edit_file',
    category: 'file_modify',
    title: 'Edit src/cart.js',
    details: {
      kind: 'file_change',
      changes: [{ path: 'src/cart.js', change: 'modify', diff: '', added: 1, removed: 1 }],
    },
  };

  it('offers the option for an eligible edit and sends it with the approval', () => {
    const onDecide = vi.fn(async () => {});
    render(<ApprovalCard approval={edit} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /further edits to these files/ }));
    fireEvent.click(screen.getByRole('button', { name: /^approve$/i }));
    expect(onDecide).toHaveBeenCalledWith('approve', undefined, undefined, true);
  });

  it('is not offered for deletes, shell scripts or risky commands', () => {
    const del: ApprovalDto = {
      ...edit,
      toolName: 'delete_file',
      details: {
        kind: 'file_change',
        changes: [{ path: 'src/cart.js', change: 'delete', diff: '', added: 0, removed: 1 }],
      },
    };
    const shell: ApprovalDto = {
      ...edit,
      toolName: 'run_command',
      details: {
        kind: 'command',
        argv: null,
        shellCommand: 'npm test | tee log',
        shell: true,
        cwd: '.',
        host: 'local',
        timeoutSeconds: 60,
        env: [],
        network: false,
        riskReasons: [],
        sandbox: null,
      },
    };
    for (const a of [del, shell, { ...edit, risk: 'high' as const }]) {
      const { unmount } = render(<ApprovalCard approval={a} onDecide={vi.fn()} />);
      expect(screen.queryByRole('checkbox')).toBeNull();
      unmount();
    }
  });
});

describe('task permission banner', () => {
  it('shows usage and revokes', () => {
    const onRevoke = vi.fn(async () => {});
    render(<TaskPermissionBanner permission={permission()} onRevoke={onRevoke} />);
    expect(screen.getByRole('status').textContent).toMatch(/3 of 20 actions used/);
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(onRevoke).toHaveBeenCalled();
  });

  it('says when it has ended', () => {
    render(
      <TaskPermissionBanner
        permission={permission({ active: false, ended: 'revoked' })}
        onRevoke={vi.fn()}
      />,
    );
    expect(screen.getByRole('status').textContent).toMatch(/ended: you revoked it/);
    expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull();
  });

  it('is tracked from live run events', () => {
    const live = applyEvent(initial('r1'), {
      seq: 1,
      type: 'task_permission',
      permission: permission(),
    });
    expect(live.taskPermission?.used).toBe(3);
  });
});
