import type { ApprovalDto } from '@friday/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalCard } from '../ApprovalCard';
import { toolLabel } from '../ToolActivity';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

type Details = Extract<ApprovalDto['details'], { kind: 'compose' }>;

const details = (over: Partial<Details> = {}): Details => ({
  kind: 'compose',
  action: 'up',
  project: 'shop',
  files: ['compose.yaml', 'compose.override.yaml'],
  argv: [
    'docker',
    'compose',
    '-p',
    'shop',
    'up',
    '--detach',
    '--pull',
    'never',
    '--no-build',
    '--',
    'web',
  ],
  services: [
    {
      name: 'db',
      image: 'postgres:17-alpine',
      build: false,
      ports: [],
      state: 'running, healthy',
      dependency: true,
    },
    {
      name: 'web',
      image: 'shop-web',
      build: true,
      ports: ['127.0.0.1:8080→80/tcp'],
      state: 'no container',
      dependency: false,
    },
  ],
  pull: 'never',
  build: false,
  removeVolumes: false,
  volumes: [],
  anonymousVolumes: 0,
  warnings: [],
  riskReasons: ['Recreates containers whose configuration or image changed.'],
  waitSeconds: 60,
  ...over,
});

const approval = (d: Details, over: Partial<ApprovalDto> = {}): ApprovalDto => ({
  id: 'ap',
  sessionId: 's',
  runId: 'r',
  projectId: 'p1',
  toolCallId: 'c',
  toolName: 'compose_control',
  category: 'shell',
  risk: 'medium',
  title: `docker compose ${d.action} (shop)`,
  summary: 'Start web and 1 dependency of compose project "shop".',
  reason: 'the user asked',
  details: d,
  actionHash: 'f'.repeat(64),
  status: 'pending',
  decisionNote: null,
  resultSummary: null,
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  decidedAt: null,
  confirmationRequired: null,
  grantedBy: null,
  ...over,
});

describe('Docker Compose approvals', () => {
  it('shows the services, the exact command and that nothing is pulled or built', () => {
    render(<ApprovalCard approval={approval(details())} onDecide={vi.fn()} />);
    expect(screen.getByText('compose.override.yaml')).toBeTruthy();
    const services = screen.getByRole('list', { name: 'Services' });
    expect(within(services).getByText('dependency')).toBeTruthy();
    expect(within(services).getByText('now: running, healthy')).toBeTruthy();
    expect(within(services).getByText('127.0.0.1:8080→80/tcp')).toBeTruthy();
    expect(screen.getByLabelText('Exact command').textContent).toBe(
      '$ docker compose -p shop up --detach --pull never --no-build -- web',
    );
    expect(screen.getByText('Not pulled; nothing is built')).toBeTruthy();
    expect(screen.getByText(/Waits up to 60s/)).toBeTruthy();
    expect(screen.queryByText(/Deleted, with all their data/)).toBeNull();
    // Medium risk without a typed confirmation: approvable directly.
    expect(screen.getByRole('button', { name: /Approve/ }).hasAttribute('disabled')).toBe(false);
  });

  it('lists the volumes and needs the project name typed to delete them', () => {
    const d = details({
      action: 'down',
      argv: ['docker', 'compose', '-p', 'shop', 'down', '--volumes'],
      removeVolumes: true,
      volumes: [
        { name: 'shop_pgdata', exists: true },
        { name: 'shop_cache', exists: false },
      ],
      anonymousVolumes: 2,
      waitSeconds: 0,
      warnings: ['Service "web" mounts the Docker socket (root-equivalent access to the host).'],
    });
    render(
      <ApprovalCard
        approval={approval(d, { risk: 'critical', confirmationRequired: 'shop' })}
        onDecide={vi.fn()}
      />,
    );
    const volumes = screen.getByRole('list', { name: 'Volumes deleted' });
    expect(within(volumes).getByText('shop_pgdata')).toBeTruthy();
    expect(within(volumes).getByText(/does not exist yet/)).toBeTruthy();
    expect(within(volumes).getByText(/2 anonymous volumes/)).toBeTruthy();
    expect(screen.getByText(/mounts the Docker socket/)).toBeTruthy();
    expect(screen.getByText(/deletes volumes/)).toBeTruthy();
    expect(screen.queryByText(/affects/)).toBeNull();
    const approve = screen.getByRole('button', { name: /Approve/ });
    expect(approve.hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'shop' } });
    expect(approve.hasAttribute('disabled')).toBe(false);
  });

  it('labels the compose tools in the activity list', () => {
    expect(toolLabel('compose_status', JSON.stringify({ view: 'logs', services: ['web'] }))).toBe(
      'logs web',
    );
    expect(
      toolLabel('compose_control', JSON.stringify({ action: 'down', removeVolumes: true })),
    ).toBe('down (remove volumes)');
  });
});
