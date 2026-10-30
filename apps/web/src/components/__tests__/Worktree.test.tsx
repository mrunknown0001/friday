import type { ProjectDto, WorktreeInfo, WorktreeStatusDto } from '@friday/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../lib/api';
import { WorktreeBadge } from '../WorktreeBadge';
import { WorktreeDialog } from '../WorktreeDialog';

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

const info = (over: Partial<WorktreeInfo> = {}): WorktreeInfo => ({
  parentId: 'p0',
  branch: 'friday/task-a1b2c3',
  base: 'abcdef1234567890',
  baseBranch: 'main',
  linked: ['node_modules'],
  status: 'active',
  outcome: null,
  createdAt: '',
  ...over,
});

const project = (wt = info()): ProjectDto => ({
  id: 'w1',
  name: 'shop · friday/task-a1b2c3',
  rootPath: '/data/worktrees/shop-a1b2c3',
  createdAt: '',
  lastOpenedAt: null,
  available: wt.status === 'active',
  sandbox: null,
  worktree: wt,
});

const status = (over: Partial<WorktreeStatusDto> = {}): WorktreeStatusDto => ({
  project: project(),
  commits: [{ sha: '1111111122222222', subject: 'Fix the total' }],
  uncommitted: [{ path: 'src/cart.js', status: 'modified' }],
  target: { branch: 'main', head: 'abc', dirty: [] },
  idle: true,
  ...over,
});

function open(action: 'accept' | 'discard') {
  const onDone = vi.fn();
  const onClose = vi.fn();
  render(
    <WorktreeDialog
      project={project()}
      action={action}
      defaultMessage="Fix the cart"
      onClose={onClose}
      onDone={onDone}
    />,
  );
  return { onDone, onClose };
}

describe('task worktree dialog', () => {
  it('shows what the task changed and merges it with the message', async () => {
    vi.spyOn(api, 'worktreeStatus').mockResolvedValue(status());
    const accept = vi.spyOn(api, 'acceptWorktree').mockResolvedValue({ project: project() });
    const { onDone, onClose } = open('accept');
    expect(await screen.findByText('Fix the total')).toBeTruthy();
    expect(screen.getByText('src/cart.js')).toBeTruthy();
    expect(screen.getByText('Merge into main')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Fix the cart total' } });
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(accept).toHaveBeenCalledWith('w1', 'merge', 'Fix the cart total');
    expect(onClose).toHaveBeenCalled();
  });

  it("won't merge into a checkout with uncommitted changes, but can keep the branch", async () => {
    vi.spyOn(api, 'worktreeStatus').mockResolvedValue(
      status({ target: { branch: 'main', head: 'abc', dirty: ['src/cart.js', 'README.md'] } }),
    );
    const accept = vi.spyOn(api, 'acceptWorktree').mockResolvedValue({ project: project() });
    open('accept');
    expect(
      await screen.findByText(/Your checkout has uncommitted changes \(src\/cart.js, README.md\)/),
    ).toBeTruthy();
    const button = screen.getByRole('button', { name: 'Accept' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: /Squash/ }));
    expect(button.disabled).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: /Keep the branch friday\/task-a1b2c3/ }));
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(accept).toHaveBeenCalledWith('w1', 'branch', 'Fix the cart'));
  });

  it('shows server errors, waits for a running task, and discards', async () => {
    vi.spyOn(api, 'worktreeStatus').mockResolvedValueOnce(status({ idle: false }));
    open('discard');
    expect(await screen.findByText(/A task is still running/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Discard' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    cleanup();

    vi.spyOn(api, 'worktreeStatus').mockResolvedValue(status());
    const discard = vi
      .spyOn(api, 'discardWorktree')
      .mockRejectedValueOnce(new Error('git worktree remove failed: busy'))
      .mockResolvedValue({ project: project() });
    const { onDone } = open('discard');
    await screen.findByText(/removes the worktree folder and the branch/);
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect((await screen.findByRole('alert')).textContent).toBe('git worktree remove failed: busy');
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(discard).toHaveBeenCalledTimes(2);
  });
});

describe('task worktree badge', () => {
  it('offers accept and discard while active, then says what happened', () => {
    const onAccept = vi.fn();
    render(
      <WorktreeBadge project={project()} busy={false} onAccept={onAccept} onDiscard={vi.fn()} />,
    );
    expect(screen.getByText(/worktree · friday\/task-a1b2c3/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Accept/ }));
    expect(onAccept).toHaveBeenCalled();
    cleanup();

    render(
      <WorktreeBadge
        project={project(
          info({
            status: 'accepted',
            outcome: { mode: 'squash', branch: 'main', commit: '9f8e7d6c5b', at: '' },
          }),
        )}
        busy={false}
        onAccept={vi.fn()}
        onDiscard={vi.fn()}
      />,
    );
    expect(screen.getByText(/Task squashed into main \(9f8e7d6\)/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Accept/ })).toBeNull();
  });
});
