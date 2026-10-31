import type { ApprovalDto, TestRunDto } from '@friday/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalCard } from '../ApprovalCard';
import { TestRunCard } from '../TestRunCard';
import { toolLabel } from '../ToolActivity';

afterEach(cleanup);

HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
  this.open = true;
};
HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
  this.open = false;
};

const run: TestRunDto = {
  id: 'tr',
  sessionId: 's',
  runId: 'r',
  toolCallId: 'c',
  projectId: 'p1',
  suite: '.',
  framework: 'playwright',
  scope: 'all',
  command: 'node_modules/.bin/playwright test --reporter=list,json --retries=1',
  status: 'failed',
  exitCode: 1,
  durationMs: 8800,
  counts: { passed: 2, failed: 1, skipped: 0, flaky: 0 },
  error: null,
  failures: [
    {
      name: 'adds green tea to the cart',
      file: 'e2e/cart.spec.ts',
      message: 'Error: expect(locator).toContainText(expected) failed',
      at: { file: 'e2e/cart.spec.ts', line: 10 },
      failedBefore: 0,
      artifacts: {
        screenshotId: 'shot-1',
        trace: 'test-results/cart-adds-green-tea-to-the-cart-retry1/trace.zip',
        video: null,
      },
    },
  ],
  flaky: [],
  slowest: [],
  coverage: null,
  createdAt: '',
};

describe('Playwright runs', () => {
  it('shows a failure with its screenshot and how to open the trace', () => {
    render(<TestRunCard run={run} />);
    const shot = screen.getByRole('button', {
      name: 'View the screenshot of adds green tea to the cart',
    });
    expect(within(shot).getByRole('img').getAttribute('src')).toBe('/api/attachments/shot-1');
    expect(
      screen.getByText(
        'npx playwright show-trace test-results/cart-adds-green-tea-to-the-cart-retry1/trace.zip',
      ),
    ).toBeTruthy();
    fireEvent.click(shot);
    expect(within(screen.getByRole('dialog')).getByRole('img')).toBeTruthy();
  });

  it('says which web server Playwright starts and how it retries', () => {
    const approval: ApprovalDto = {
      id: 'a',
      sessionId: 's',
      runId: 'r',
      projectId: 'p1',
      toolCallId: 'c',
      toolName: 'run_tests',
      category: 'shell',
      risk: 'medium',
      title: 'Run tests: playwright in the project root',
      summary: 'Runs the whole suite on this machine, for up to 300s.',
      reason: 'check the cart flow',
      details: {
        kind: 'command',
        argv: ['node_modules/.bin/playwright', 'test', '--reporter=list,json', '--retries=1'],
        shellCommand: null,
        shell: false,
        cwd: '.',
        host: 'local',
        timeoutSeconds: 300,
        env: ['CI', 'PATH', 'PLAYWRIGHT_JSON_OUTPUT_FILE'],
        network: false,
        riskReasons: [],
        sandbox: null,
        tests: {
          framework: 'playwright',
          suite: '.',
          scope: 'all',
          changedFiles: [],
          testFiles: [],
          nameFilter: null,
          coverage: false,
          retryFailures: true,
          webServer: 'node server.js',
        },
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
    render(<ApprovalCard approval={approval} onDecide={vi.fn()} />);
    expect(screen.getByText('node server.js')).toBeTruthy();
    expect(
      screen.getByText(/Playwright retries each failed test once in the same run/),
    ).toBeTruthy();
    expect(screen.getByText(/Screenshots and traces of failures stay in the project/)).toBeTruthy();
    expect(toolLabel('run_tests', JSON.stringify({ framework: 'playwright', scope: 'all' }))).toBe(
      'Playwright: all tests',
    );
  });
});
