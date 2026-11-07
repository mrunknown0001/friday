import type { ApprovalDto, ProjectDto, RemoteTargetDto, SshHostDto } from '@friday/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../lib/api';
import { AddProjectDialog } from '../AddProjectDialog';
import { ApprovalCard } from '../ApprovalCard';
import { ProjectSettingsDialog } from '../ProjectSettingsDialog';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const host = (over: Partial<SshHostDto> = {}): SshHostDto => ({
  id: 'h1',
  name: 'web-1',
  hostname: '203.0.113.10',
  port: 22,
  username: 'deploy',
  identityFile: null,
  environment: 'production',
  trustedFingerprints: ['ED25519 SHA256:x'],
  createdAt: '2026-11-07T10:00:00.000Z',
  ...over,
});

const target: RemoteTargetDto = {
  hostId: 'h1',
  name: 'web-1',
  hostname: '203.0.113.10',
  port: 22,
  username: 'deploy',
  environment: 'production',
};

const project = {
  id: 'p1',
  name: 'shop',
  rootPath: '/var/www/shop',
  available: true,
  sandbox: null,
  worktree: null,
  externalFolders: [],
  remote: target,
} as unknown as ProjectDto;

describe('adding a project on an SSH host', () => {
  it('offers trusted hosts, browses folders there and adds the chosen one', async () => {
    vi.spyOn(api, 'sshHosts').mockResolvedValue({
      hosts: [host(), host({ id: 'h2', name: 'new-box', trustedFingerprints: [] })],
    });
    const folders = vi
      .spyOn(api, 'sshHostFolders')
      .mockResolvedValueOnce({ path: '/var/www', home: '/home/deploy', folders: ['shop', 'blog'] })
      .mockResolvedValueOnce({ path: '/var/www/shop', home: '/home/deploy', folders: ['app'] });
    const add = vi.spyOn(api, 'addProject').mockResolvedValue(project);
    const onAdded = vi.fn();
    render(<AddProjectDialog onClose={vi.fn()} onAdded={onAdded} />);

    fireEvent.click(screen.getByRole('radio', { name: /SSH host/ }));
    const select = (await screen.findByRole('combobox', { name: 'Host' })) as HTMLSelectElement;
    // Untrusted hosts can't hold projects.
    expect([...select.options].map((o) => o.textContent)).toEqual(['web-1 (deploy@203.0.113.10)']);
    expect(screen.getByText('production')).toBeTruthy();
    expect(screen.getByText(/approving also needs its name typed/)).toBeTruthy();

    // Browse from the typed folder, open a subfolder, use it.
    fireEvent.change(screen.getByRole('textbox', { name: 'Folder on the host' }), {
      target: { value: '/var/www' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Browse/ }));
    await waitFor(() => expect(folders).toHaveBeenCalledWith('h1', '/var/www'));
    fireEvent.click(await screen.findByRole('button', { name: 'shop' }));
    await waitFor(() => expect(folders).toHaveBeenLastCalledWith('h1', '/var/www/shop'));
    await screen.findByText('app');
    fireEvent.click(screen.getByRole('button', { name: 'Use this folder' }));
    expect(
      (screen.getByRole('textbox', { name: 'Folder on the host' }) as HTMLInputElement).value,
    ).toBe('/var/www/shop');

    fireEvent.click(screen.getByRole('button', { name: /Authorize folder/ }));
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith(project));
    expect(add).toHaveBeenCalledWith('/var/www/shop', undefined, 'h1');
    expect(folders).toHaveBeenCalledTimes(2);
  });

  it('says how to get a host when none is trusted', async () => {
    vi.spyOn(api, 'sshHosts').mockResolvedValue({ hosts: [host({ trustedFingerprints: [] })] });
    render(<AddProjectDialog onClose={vi.fn()} onAdded={vi.fn()} />);
    fireEvent.click(screen.getByRole('radio', { name: /SSH host/ }));
    expect(await screen.findByText(/No trusted SSH host yet/)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: /Authorize folder/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe('a project on an SSH host', () => {
  it('has its own settings view: where it is and what works there', () => {
    const sandbox = vi.spyOn(api, 'projectSandbox');
    render(<ProjectSettingsDialog project={project} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByText('deploy@203.0.113.10')).toBeTruthy();
    expect(screen.getByText('/var/www/shop')).toBeTruthy();
    expect(screen.getByText(/with the host name typed to confirm/)).toBeTruthy();
    // The local-only settings aren't loaded at all.
    expect(sandbox).not.toHaveBeenCalled();
  });

  it('names the server on approvals and asks for its name on production', () => {
    const approval = {
      id: 'a1',
      sessionId: 's1',
      runId: 'r1',
      projectId: 'p1',
      toolCallId: 'c1',
      toolName: 'run_command',
      category: 'shell',
      risk: 'medium',
      title: 'Run on web-1: php artisan migrate',
      summary: 'Runs a program directly in the project folder on web-1.',
      reason: 'Apply the migration',
      details: {
        kind: 'command',
        argv: ['php', 'artisan', 'migrate'],
        shellCommand: null,
        shell: false,
        cwd: '.',
        host: 'remote',
        remote: target,
        timeoutSeconds: 120,
        env: ['CI'],
        network: false,
        riskReasons: [],
        sandbox: null,
      },
      actionHash: 'f'.repeat(64),
      status: 'pending',
      decisionNote: null,
      resultSummary: null,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      decidedAt: null,
      confirmationRequired: 'web-1',
      grantedBy: null,
    } as unknown as ApprovalDto;
    render(<ApprovalCard approval={approval} onDecide={vi.fn()} />);
    const card = screen.getByRole('region', { name: /Approval request/ });
    const on = within(card).getByLabelText('Runs on server');
    expect(on.textContent).toContain('web-1');
    expect(on.textContent).toContain('deploy@203.0.113.10');
    expect(within(card).getByLabelText('Exact command').textContent).toBe(
      'web-1$ php artisan migrate',
    );
    expect(within(card).getByText(/On web-1, as deploy, in the project folder there/)).toBeTruthy();
    expect(within(card).getByText(/This affects/)).toBeTruthy();
    expect(within(card).queryByRole('checkbox', { name: /similar/i })).toBeNull();
  });
});
