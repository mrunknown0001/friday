import type { ApprovalDto, DeploymentPlanDto } from '@friday/shared';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalCard } from '../ApprovalCard';
import { DeploymentPlanCard } from '../DeploymentPlanCard';

afterEach(cleanup);

const remote = (over: Partial<ApprovalDto> = {}): ApprovalDto => ({
  id: 'a',
  sessionId: 's',
  runId: 'r',
  projectId: null,
  toolCallId: 'c',
  toolName: 'remote_command',
  category: 'deployment',
  risk: 'critical',
  title: 'PRODUCTION · Run on web-prod: sudo systemctl restart php8.3-fpm',
  summary: 'Runs this command as deploy on 203.0.113.10 (production).',
  reason: 'apply new pool config',
  details: {
    kind: 'remote',
    host: {
      name: 'web-prod',
      hostname: '203.0.113.10',
      port: 22,
      username: 'deploy',
      environment: 'production',
    },
    command: 'sudo systemctl restart php8.3-fpm',
    check: null,
    expectedImpact: 'Restarts PHP-FPM workers',
    downtime: '~2 seconds of 502s',
    rollback: 'Restore previous pool config and restart',
    verification: 'curl -fsS https://shop.example/health',
    riskReasons: ['Requests elevated (root) privileges.', 'Controls system services.'],
    timeoutSeconds: 120,
  },
  actionHash: 'f'.repeat(64),
  status: 'pending',
  decisionNote: null,
  resultSummary: null,
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  decidedAt: null,
  confirmationRequired: 'web-prod',
  ...over,
});

describe('production approvals', () => {
  it('shows host, environment, exact command, impact, downtime, rollback and verification', () => {
    render(<ApprovalCard approval={remote()} onDecide={vi.fn()} />);
    expect(screen.getByText('deploy@203.0.113.10:22')).toBeTruthy();
    expect(screen.getAllByText('production').length).toBeGreaterThan(0);
    expect(screen.getByLabelText('Exact command').textContent).toBe(
      'web-prod$ sudo systemctl restart php8.3-fpm',
    );
    for (const t of [
      'Restarts PHP-FPM workers',
      '~2 seconds of 502s',
      'Restore previous pool config and restart',
      'curl -fsS https://shop.example/health',
      'Requests elevated (root) privileges.',
    ]) {
      expect(screen.getByText(t)).toBeTruthy();
    }
    expect(screen.getByText('critical risk')).toBeTruthy();
  });

  it('keeps Approve disabled until the host name is typed, then sends it', async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    render(<ApprovalCard approval={remote()} onDecide={onDecide} />);
    const approve = screen.getByRole('button', { name: /Approve once/ }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    const box = screen.getByLabelText(/Type web-prod to enable approval/);
    await userEvent.type(box, 'web-pro');
    expect(approve.disabled).toBe(true);
    await userEvent.type(box, 'd');
    expect(approve.disabled).toBe(false);
    await userEvent.click(approve);
    expect(onDecide).toHaveBeenCalledWith('approve', undefined, 'web-prod');
  });

  it('does not ask for confirmation on non-production approvals', () => {
    render(<ApprovalCard approval={remote({ confirmationRequired: null })} onDecide={vi.fn()} />);
    expect(screen.queryByLabelText(/to enable approval/)).toBeNull();
    expect(
      (screen.getByRole('button', { name: /Approve once/ }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});

describe('DeploymentPlanCard', () => {
  it('shows environment, pre-checks, steps with risk flags, verification and rollback', () => {
    const plan: DeploymentPlanDto = {
      id: 'p',
      sessionId: 's',
      runId: 'r',
      toolCallId: 'c',
      title: 'Deploy v2',
      environment: 'production',
      target: 'shop on web-prod',
      summary: 'Pull, migrate, reload.',
      preChecks: ['Database backup with mysqldump'],
      steps: [
        {
          title: 'Pull code',
          command: 'git pull --ff-only',
          where: 'web-prod',
          risk: 'medium',
          causesDowntime: false,
          reversible: true,
          rollback: 'checkout previous tag',
        },
        {
          title: 'Migrate',
          command: 'php artisan migrate --force',
          where: 'web-prod',
          risk: 'high',
          causesDowntime: true,
          reversible: false,
          rollback: 'restore backup',
        },
      ],
      verification: ['curl health endpoint'],
      rollbackPlan: 'Previous tag + restore backup',
      dataLossRisk: 'low with backup',
      downtimeEstimate: '< 1 minute',
      createdAt: '',
    };
    render(<DeploymentPlanCard plan={plan} />);
    expect(screen.getByRole('region', { name: 'Deployment plan: Deploy v2' })).toBeTruthy();
    expect(screen.getByText('production')).toBeTruthy();
    expect(screen.getByText('Plan only: nothing has run')).toBeTruthy();
    expect(screen.getByText('Database backup with mysqldump')).toBeTruthy();
    expect(screen.getByText('$ php artisan migrate --force')).toBeTruthy();
    expect(screen.getByText('irreversible')).toBeTruthy();
    expect(screen.getByText('downtime')).toBeTruthy();
    expect(screen.getByText('Previous tag + restore backup')).toBeTruthy();
  });
});

describe('toolLabel for DevOps and git tools', async () => {
  const { toolLabel } = await import('../ToolActivity');
  it('formats arguments readably', () => {
    expect(
      toolLabel('remote_command', JSON.stringify({ host: 'web-prod', command: 'touch /x' })),
    ).toBe('web-prod: touch /x');
    expect(
      toolLabel(
        'remote_diagnose',
        JSON.stringify({ host: 'web-prod', check: 'tail_log', target: '/var/log/a.log' }),
      ),
    ).toBe('web-prod: tail_log /var/log/a.log');
    expect(
      toolLabel('git_commit', JSON.stringify({ message: 'Fix cart\n\nbody', paths: ['a'] })),
    ).toBe('Fix cart');
    expect(
      toolLabel(
        'prepare_deployment_plan',
        JSON.stringify({ environment: 'production', title: 'Deploy v2' }),
      ),
    ).toBe('production: Deploy v2');
    expect(toolLabel('inspect_environment', '{}')).toBe('');
  });
});
