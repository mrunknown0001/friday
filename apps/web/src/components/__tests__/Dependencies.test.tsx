import type { ApprovalDto } from '@friday/shared';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalCard } from '../ApprovalCard';
import { toolLabel } from '../ToolActivity';

afterEach(cleanup);

const approval: ApprovalDto = {
  id: 'ap',
  sessionId: 's',
  runId: 'r',
  projectId: 'p1',
  toolCallId: 'c',
  toolName: 'upgrade_dependencies',
  category: 'shell',
  risk: 'high',
  title: 'Upgrade 2 dependencies',
  summary: '1 major, 1 patch in npm in the project root; 2 commands.',
  reason: 'security fix and the user asked for semver 7',
  details: {
    kind: 'dependency_upgrade',
    ecosystem: 'npm',
    folder: '.',
    packages: [
      {
        name: 'semver',
        workspace: null,
        dev: true,
        from: '5.7.1',
        to: '7.8.5',
        specBefore: '5.7.1',
        specAfter: '7.8.5',
        change: 'major',
        releasedAt: '2026-07-01T00:00:00Z',
        ageDays: 120,
        recent: false,
        fixes: [{ title: 'ReDoS', severity: 'high', url: 'https://x' }],
        remaining: [],
        breaking: ['Drop support for very old node versions'],
        repo: 'npm/node-semver',
        notesError: null,
      },
      {
        name: 'ms',
        workspace: 'apps/api',
        dev: false,
        from: '2.0.0',
        to: '2.1.3',
        specBefore: '~2.0.0',
        specAfter: '~2.1.3',
        change: 'minor',
        releasedAt: null,
        ageDays: 5,
        recent: true,
        fixes: [],
        remaining: [{ title: 'Slow parse', severity: 'moderate', url: null }],
        breaking: [],
        repo: null,
        notesError: 'its source repository is not on GitHub',
      },
    ],
    commands: [
      ['npm', 'install', '--no-fund', '--no-audit', '--save-dev', 'semver@7.8.5'],
      [
        'npm',
        'install',
        '--no-fund',
        '--no-audit',
        '--save-prod',
        '--workspace',
        'apps/api',
        'ms@~2.1.3',
      ],
    ],
    sandbox: null,
    files: ['package.json', 'apps/api/package.json', 'package-lock.json'],
    riskReasons: ['Includes a major upgrade: breaking changes are possible.'],
    minAgeDays: 14,
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

describe('dependency upgrade approvals', () => {
  it('shows each version change, advisories, breaking changes and the exact commands', () => {
    render(<ApprovalCard approval={approval} onDecide={vi.fn()} />);
    const list = screen.getByRole('list', { name: 'Packages' });
    const semver = within(list).getByText('semver').closest('li')!;
    expect(within(semver).getByText('5.7.1 → 7.8.5')).toBeTruthy();
    expect(within(semver).getByText('major')).toBeTruthy();
    expect(within(semver).getByText(/Fixes:.*high ReDoS/)).toBeTruthy();
    expect(
      within(screen.getByRole('list', { name: 'Breaking changes in semver' })).getByText(
        'Drop support for very old node versions',
      ),
    ).toBeTruthy();
    const ms = within(list).getByText('ms').closest('li')!;
    expect(within(ms).getByText(/5 days old \(under 14 days\)/)).toBeTruthy();
    expect(within(ms).getByText(/Still affected:.*moderate Slow parse/)).toBeTruthy();
    expect(
      within(ms).getByText(/Release notes not checked: its source repository is not on GitHub/),
    ).toBeTruthy();
    expect(screen.getByLabelText('Command 2').textContent).toBe(
      "$ npm install --no-fund --no-audit --save-prod --workspace apps/api 'ms@~2.1.3'",
    );
    expect(screen.getByText('On this machine, as your user')).toBeTruthy();
    expect(screen.getByText('package.json, apps/api/package.json, package-lock.json')).toBeTruthy();
  });

  it('labels the dependency tools', () => {
    expect(
      toolLabel(
        'upgrade_dependencies',
        JSON.stringify({
          packages: [
            { name: 'ms', version: '2.1.3' },
            { name: 'semver', version: '5.7.2' },
          ],
        }),
      ),
    ).toBe('ms@2.1.3, semver@5.7.2');
    expect(toolLabel('dependency_changelog', JSON.stringify({ name: 'semver', to: '7.8.5' }))).toBe(
      'semver → 7.8.5',
    );
  });
});
