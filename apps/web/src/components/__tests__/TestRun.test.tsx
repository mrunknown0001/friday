import type { ApprovalDto, TestRunDto } from '@friday/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../lib/api';
import { ApprovalCard } from '../ApprovalCard';
import { ReviewActionsContext } from '../ReviewCard';
import { duration, TestRunCard } from '../TestRunCard';

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

const testRun = (over: Partial<TestRunDto> = {}): TestRunDto => ({
  id: 'tr1',
  sessionId: 's',
  runId: 'r',
  toolCallId: 'c',
  projectId: 'p1',
  suite: 'apps/server',
  framework: 'vitest',
  scope: 'changed',
  command: '../../node_modules/.bin/vitest related --run src/cart.ts',
  status: 'failed',
  exitCode: 1,
  durationMs: 4200,
  counts: { passed: 40, failed: 2, skipped: 1, flaky: 1 },
  error: null,
  failures: [
    {
      name: 'cart › adds tax',
      file: 'test/cart.test.ts',
      message: 'AssertionError: expected 110 to be 100',
      at: { file: 'src/cart.ts', line: 14 },
      failedBefore: 2,
    },
    {
      name: 'cart › rounds',
      file: 'test/cart.test.ts',
      message: 'AssertionError: expected 0.30000000000000004 to be 0.3',
      at: null,
      failedBefore: 0,
    },
  ],
  flaky: [
    {
      name: 'checkout › times out',
      file: 'test/checkout.test.ts',
      evidence: 'passed_on_retry',
      detail: 'failed, then passed when re-run with no change',
    },
  ],
  slowest: [
    { name: 'checkout › pays', file: 'test/checkout.test.ts', durationMs: 2400, usualMs: 300 },
    { name: 'cart › adds', file: 'test/cart.test.ts', durationMs: 40, usualMs: null },
  ],
  coverage: {
    available: true,
    note: null,
    files: [
      { file: 'src/cart.ts', lines: 6, covered: 4, uncovered: [[20, 21]], notLoaded: false },
      { file: 'src/new.ts', lines: 3, covered: 0, uncovered: [[1, 3]], notLoaded: true },
    ],
  },
  createdAt: '',
  ...over,
});

const show = (run: TestRunDto) =>
  render(
    <ReviewActionsContext.Provider value={{ projectId: 'p1', canSend: true, send: vi.fn() }}>
      <TestRunCard run={run} />
    </ReviewActionsContext.Provider>,
  );

describe('test run card', () => {
  it('shows the outcome, each failure with its first error and location, flaky and slow tests, and coverage', () => {
    show(testRun());
    const card = screen.getByRole('region', { name: 'Test run: failed' });
    expect(within(card).getByText('2 failed')).toBeTruthy();
    expect(within(card).getByText('40 passed')).toBeTruthy();
    expect(within(card).getByText('1 flaky')).toBeTruthy();
    expect(
      within(card).getByText(/vitest · apps\/server · tests related to the changes/),
    ).toBeTruthy();

    // The first failure is open; the others show their error on request.
    expect(screen.getByText('AssertionError: expected 110 to be 100')).toBeTruthy();
    expect(screen.getByText('failed 2 times before')).toBeTruthy();
    expect(screen.queryByText(/0\.30000000000000004/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show the error of cart › rounds' }));
    expect(screen.getByText(/0\.30000000000000004/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'src/cart.ts:14' })).toBeTruthy();

    const flaky = screen.getByRole('region', { name: 'Flaky: not caused by a code difference' });
    expect(within(flaky).getByText('failed, then passed when re-run with no change')).toBeTruthy();

    const slow = screen.getByRole('region', { name: 'Slowest' });
    expect(within(slow).getByText('usually 300 ms')).toBeTruthy();

    const cov = screen.getByRole('region', { name: 'Coverage of the changed lines' });
    expect(within(cov).getByText('4/6 changed lines ran')).toBeTruthy();
    expect(within(cov).getByText('never ran: 20–21')).toBeTruthy();
    expect(within(cov).getByText('not loaded by these tests')).toBeTruthy();
  });

  it('shows why a run could not start, and an empty run', () => {
    show(
      testRun({
        status: 'error',
        error: 'SyntaxError: Unexpected token',
        failures: [],
        flaky: [],
        slowest: [],
        coverage: null,
        counts: { passed: 0, failed: 0, skipped: 0, flaky: 0 },
      }),
    );
    expect(screen.getByRole('region', { name: 'Test run: could not run' })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('SyntaxError: Unexpected token');
    cleanup();
    show(
      testRun({
        status: 'passed',
        failures: [],
        flaky: [],
        slowest: [],
        coverage: { available: false, note: 'Coverage needs @vitest/coverage-v8.', files: [] },
        counts: { passed: 0, failed: 0, skipped: 0, flaky: 0 },
      }),
    );
    expect(screen.getByText('No tests ran.')).toBeTruthy();
    expect(screen.getByText('Coverage needs @vitest/coverage-v8.')).toBeTruthy();
  });

  it('opens the file at the failure’s line', async () => {
    vi.spyOn(api, 'projectFile').mockResolvedValue({
      path: 'src/cart.ts',
      content: Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n'),
      language: null,
      binary: false,
      tooLarge: false,
      size: 100,
    } as Awaited<ReturnType<typeof api.projectFile>>);
    show(testRun());
    fireEvent.click(screen.getByRole('button', { name: 'src/cart.ts:14' }));
    expect(await screen.findByText('src/cart.ts:14', { selector: 'h2' })).toBeTruthy();
    expect(await screen.findByTestId('line-mark')).toBeTruthy();
  });

  it('formats durations', () => {
    expect(duration(12.4)).toBe('12 ms');
    expect(duration(4200)).toBe('4.2 s');
    expect(duration(65_000)).toBe('65 s');
  });
});

describe('run_tests approval', () => {
  it('says what is tested and what Friday does around the command', () => {
    const approval: ApprovalDto = {
      id: 'a',
      sessionId: 's',
      runId: 'r',
      projectId: 'p1',
      toolCallId: 'c',
      toolName: 'run_tests',
      category: 'shell',
      risk: 'medium',
      title: 'Run tests: node in the project root',
      summary: 'Runs the tests related to 1 changed file on this machine.',
      reason: 'check the change',
      details: {
        kind: 'command',
        argv: ['node', '--test', 'cart.test.js'],
        shellCommand: null,
        shell: false,
        cwd: '.',
        host: 'local',
        timeoutSeconds: 300,
        env: ['CI', 'PATH'],
        network: false,
        riskReasons: [],
        sandbox: null,
        tests: {
          framework: 'node',
          suite: '.',
          scope: 'changed',
          changedFiles: ['cart.js'],
          testFiles: ['cart.test.js'],
          nameFilter: null,
          coverage: true,
          retryFailures: true,
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
    expect(screen.getByText(/1 test file related to the changes/)).toBeTruthy();
    expect(screen.getByText('cart.js')).toBeTruthy();
    expect(
      screen.getByText(
        /outside the project, read by Friday, then deleted; coverage is measured too/,
      ),
    ).toBeTruthy();
    expect(screen.getByText(/The failed tests run once more/)).toBeTruthy();
    expect(screen.getByLabelText('Exact command').textContent).toContain(
      'node --test cart.test.js',
    );
  });
});
