import type { MonitorDto, ProjectDto, SshHostDto } from '@friday/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../lib/api';
import { investigatePrompt, monitorNotification, MonitorsDialog, targetText } from '../Monitors';
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

const project = { id: 'p1', name: 'shop', worktree: null } as unknown as ProjectDto;

const monitor = (over: Partial<MonitorDto> = {}): MonitorDto => ({
  id: 'm1',
  name: 'shop staging',
  projectId: 'p1',
  target: {
    kind: 'http',
    url: 'https://staging.example.com/health',
    expectedStatus: null,
    contains: null,
    timeoutSeconds: 10,
  },
  intervalMinutes: 5,
  failuresBeforeAlert: 2,
  enabled: true,
  status: 'down',
  statusSince: new Date(Date.now() - 12 * 60_000).toISOString(),
  lastCheckedAt: new Date().toISOString(),
  lastMessage: 'HTTP 503 Service Unavailable (expected 2xx or 3xx)',
  consecutiveFailures: 3,
  recent: [
    { at: '2026-10-31T10:00:00Z', ok: true, durationMs: 40, message: 'HTTP 200 OK' },
    { at: '2026-10-31T10:05:00Z', ok: false, durationMs: 41, message: 'HTTP 503' },
  ],
  createdAt: '',
  updatedAt: '',
  ...over,
});

function open(
  monitors: MonitorDto[],
  handlers: { onInvestigate?: () => void; onChanged?: () => void } = {},
) {
  vi.spyOn(api, 'sshHosts').mockResolvedValue({ hosts: [staging] });
  render(
    <MonitorsDialog
      monitors={monitors}
      projects={[project]}
      defaultProjectId="p1"
      onClose={vi.fn()}
      onChanged={handlers.onChanged ?? vi.fn()}
      onInvestigate={handlers.onInvestigate ?? vi.fn()}
    />,
  );
}

describe('health monitors panel', () => {
  it('shows status, how long it has been down, recent checks and Investigate', () => {
    const onInvestigate = vi.fn();
    open(
      [monitor(), monitor({ id: 'm2', name: 'api', status: 'up', lastMessage: 'HTTP 200 OK' })],
      {
        onInvestigate,
      },
    );
    const row = screen.getByRole('listitem', { name: 'Monitor shop staging' });
    expect(within(row).getByText('down')).toBeTruthy();
    expect(within(row).getByText('Down for 12 min')).toBeTruthy();
    expect(within(row).getByText(/HTTP 503 Service Unavailable/)).toBeTruthy();
    expect(within(row).getByLabelText('Recent checks').children).toHaveLength(2);
    fireEvent.click(within(row).getByRole('button', { name: /Investigate/ }));
    expect(onInvestigate).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }));
    const ok = screen.getByRole('listitem', { name: 'Monitor api' });
    expect(within(ok).queryByRole('button', { name: /Investigate/ })).toBeNull();
  });

  it('adds an SSH monitor from the form', async () => {
    const create = vi.spyOn(api, 'createMonitor').mockResolvedValue(monitor());
    const onChanged = vi.fn();
    open([], { onChanged });
    expect(screen.getByText(/No monitors yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Add monitor/ }));
    const form = screen.getByRole('form', { name: 'Monitor' });
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'staging box' } });
    fireEvent.change(within(form).getByLabelText('Checks'), { target: { value: 'ssh' } });
    await waitFor(() => within(form).getByRole('option', { name: 'web-staging (staging)' }));
    fireEvent.change(within(form).getByLabelText(/SSH host/), { target: { value: 'h1' } });
    fireEvent.change(within(form).getByLabelText(/systemd service/), {
      target: { value: 'nginx' },
    });
    fireEvent.change(within(form).getByLabelText(/Disk path/), { target: { value: '/' } });
    fireEvent.change(within(form).getByLabelText(/Max disk usage/), { target: { value: '90' } });
    fireEvent.submit(form);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(create).toHaveBeenCalledWith({
      name: 'staging box',
      projectId: 'p1',
      target: { kind: 'ssh', hostId: 'h1', service: 'nginx', diskPath: '/', diskMaxPercent: 90 },
      intervalMinutes: 5,
      failuresBeforeAlert: 2,
      enabled: true,
    });
  });

  it('pauses a monitor and checks one on request', async () => {
    const update = vi.spyOn(api, 'updateMonitor').mockResolvedValue(monitor());
    const checkNow = vi.spyOn(api, 'checkMonitor').mockResolvedValue(monitor());
    open([monitor()]);
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    await waitFor(() => expect(checkNow).toHaveBeenCalledWith('m1'));
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith('m1', expect.objectContaining({ enabled: false })),
    );
    expect(update.mock.calls[0]![1]).not.toHaveProperty('status');
  });

  it('words notifications, the investigation request and targets', () => {
    const m = monitor();
    expect(monitorNotification(m, 'down')).toEqual({
      title: '“shop staging” is down',
      body: 'HTTP 503 Service Unavailable (expected 2xx or 3xx)',
    });
    expect(monitorNotification({ ...m, lastMessage: 'HTTP 200 OK' }, 'up').title).toBe(
      '“shop staging” recovered',
    );
    expect(investigatePrompt(m)).toMatch(
      /^The health monitor "shop staging" is down since .*Last result: HTTP 503.*monitor_status.*Don't change anything without asking me\.$/,
    );
    expect(
      targetText(
        { kind: 'ssh', hostId: 'h1', service: 'nginx', diskPath: '/', diskMaxPercent: 90 },
        [staging],
      ),
    ).toBe('web-staging · nginx active · / ≤ 90%');
    expect(toolLabel('monitor_status', JSON.stringify({ name: 'shop' }))).toBe('shop');
  });
});
