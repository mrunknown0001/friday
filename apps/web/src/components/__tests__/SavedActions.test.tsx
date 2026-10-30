import type { ApprovalDto, SavedActionDto, SshHostDto } from '@friday/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../lib/api';
import { ApprovalCard } from '../ApprovalCard';
import { RunActionDialog, runRequest, SavedActionsSection } from '../SavedActions';
import { toolLabel } from '../ToolActivity';

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

const staging: SshHostDto = {
  id: 'h1',
  name: 'web-staging',
  hostname: '203.0.113.5',
  port: 22,
  username: 'deploy',
  identityFile: null,
  environment: 'staging',
  trustedFingerprints: ['SHA256:x'],
  createdAt: '',
};

const deploy: SavedActionDto = {
  id: 'a1',
  projectId: 'p1',
  name: 'deploy staging',
  description: 'Build, then restart staging.',
  risk: 'medium',
  steps: [
    {
      title: 'Build',
      target: { kind: 'local', cwd: '.' },
      command: 'npm run build',
      timeoutSeconds: 120,
      continueOnError: false,
    },
    {
      title: 'Restart',
      target: { kind: 'ssh', hostId: 'h1' },
      command: 'sudo systemctl restart shop',
      timeoutSeconds: 60,
      continueOnError: false,
    },
  ],
  createdAt: '',
  updatedAt: '',
};

describe('saved actions in Project settings', () => {
  it('lists actions and creates one step by step', async () => {
    vi.spyOn(api, 'sshHosts').mockResolvedValue({ hosts: [staging] });
    const list = vi
      .spyOn(api, 'savedActions')
      .mockResolvedValue({ projectId: 'p1', actions: [deploy] });
    const create = vi.spyOn(api, 'createSavedAction').mockResolvedValue(deploy);
    render(<SavedActionsSection projectId="p1" />);
    const listed = await screen.findByRole('list', { name: 'Saved actions' });
    expect(within(listed).getByText('deploy staging')).toBeTruthy();
    expect(within(listed).getByText('Build → Restart @ web-staging (staging)')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Add action/ }));
    const save = screen.getByRole('button', { name: /Save action/ });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Action name'), { target: { value: 'restart queue' } });
    fireEvent.change(screen.getByLabelText('Action risk'), { target: { value: 'high' } });
    fireEvent.change(screen.getByLabelText('Step 1 title'), { target: { value: 'Migrate' } });
    fireEvent.change(screen.getByLabelText('Step 1 command'), {
      target: { value: 'php artisan migrate --force' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Add step/ }));
    fireEvent.change(screen.getByLabelText('Step 2 title'), { target: { value: 'Restart' } });
    fireEvent.change(screen.getByLabelText('Step 2 runs on'), { target: { value: 'h1' } });
    fireEvent.change(screen.getByLabelText('Step 2 command'), {
      target: { value: 'sudo supervisorctl restart queue' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Step 1: continue if it fails' }));
    // Restart first, then migrate.
    fireEvent.click(screen.getByRole('button', { name: 'Move step 2 up' }));
    fireEvent.click(save);
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0]).toEqual([
      'p1',
      {
        name: 'restart queue',
        description: '',
        risk: 'high',
        steps: [
          {
            title: 'Restart',
            target: { kind: 'ssh', hostId: 'h1' },
            command: 'sudo supervisorctl restart queue',
            timeoutSeconds: 300,
            continueOnError: false,
          },
          {
            title: 'Migrate',
            target: { kind: 'local', cwd: '.' },
            command: 'php artisan migrate --force',
            timeoutSeconds: 300,
            continueOnError: true,
          },
        ],
      },
    ]);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('edits and deletes an action', async () => {
    vi.spyOn(api, 'sshHosts').mockResolvedValue({ hosts: [staging] });
    vi.spyOn(api, 'savedActions').mockResolvedValue({ projectId: 'p1', actions: [deploy] });
    const update = vi.spyOn(api, 'updateSavedAction').mockResolvedValue(deploy);
    const del = vi.spyOn(api, 'deleteSavedAction').mockResolvedValue(undefined);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<SavedActionsSection projectId="p1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit deploy staging' }));
    expect((screen.getByLabelText('Step 2 runs on') as HTMLSelectElement).value).toBe('h1');
    fireEvent.change(screen.getByLabelText('Step 1 command'), {
      target: { value: 'npm ci && npm run build' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save action/ }));
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0]![0]).toBe('a1');
    expect(update.mock.calls[0]![1].steps[0]!.command).toBe('npm ci && npm run build');
    fireEvent.click(screen.getByRole('button', { name: 'Delete deploy staging' }));
    await waitFor(() => expect(del).toHaveBeenCalledWith('a1'));
  });
});

describe('running a saved action', () => {
  it('asks Friday to run the chosen action', async () => {
    vi.spyOn(api, 'savedActions').mockResolvedValue({ projectId: 'p1', actions: [deploy] });
    const onRun = vi.fn();
    render(<RunActionDialog projectId="p1" canSend onRun={onRun} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Run/ }));
    expect(onRun).toHaveBeenCalledWith(runRequest('deploy staging'));
    expect(runRequest('deploy staging')).toBe('Run the saved action "deploy staging".');
    expect(toolLabel('run_saved_action', JSON.stringify({ name: 'deploy staging' }))).toBe(
      'deploy staging',
    );
  });

  it('shows every step on the approval card', () => {
    const approval: ApprovalDto = {
      id: 'ap',
      sessionId: 's',
      runId: 'r',
      projectId: 'p1',
      toolCallId: 'c',
      toolName: 'run_saved_action',
      category: 'deployment',
      risk: 'critical',
      title: 'PRODUCTION · Run saved action "deploy prod"',
      summary: 'Runs 2 steps (1 on this machine and 1 on web-prod) in order.',
      reason: 'the user asked',
      details: {
        kind: 'saved_action',
        action: { id: 'a2', name: 'deploy prod', description: 'Ship to production.', risk: 'high' },
        steps: [
          {
            title: 'Build',
            command: 'npm run build',
            timeoutSeconds: 120,
            continueOnError: false,
            riskReasons: [],
            where: { kind: 'local', cwd: '.', sandbox: null },
          },
          {
            title: 'Restart',
            command: 'sudo systemctl restart shop',
            timeoutSeconds: 60,
            continueOnError: true,
            riskReasons: ['Requests elevated (root) privileges.'],
            where: {
              kind: 'ssh',
              host: {
                name: 'web-prod',
                hostname: '198.51.100.7',
                port: 22,
                username: 'deploy',
                environment: 'production',
              },
            },
          },
        ],
        productionHosts: ['web-prod'],
      },
      actionHash: 'f'.repeat(64),
      status: 'pending',
      decisionNote: null,
      resultSummary: null,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      decidedAt: null,
      confirmationRequired: 'web-prod',
      grantedBy: null,
    };
    render(<ApprovalCard approval={approval} onDecide={vi.fn()} />);
    const steps = screen.getByRole('list', { name: 'Steps' });
    expect(within(steps).getByText('this machine · project root')).toBeTruthy();
    expect(within(steps).getByText('web-prod · production')).toBeTruthy();
    expect(within(steps).getByText('deploy@198.51.100.7:22')).toBeTruthy();
    expect(screen.getByLabelText('Command of step 2').textContent).toBe(
      '$ sudo systemctl restart shop',
    );
    expect(within(steps).getByText('Requests elevated (root) privileges.')).toBeTruthy();
    expect(within(steps).getByText(/continues if it fails/)).toBeTruthy();
    expect(screen.getByText(/It touches production \(web-prod\)/)).toBeTruthy();
  });
});
