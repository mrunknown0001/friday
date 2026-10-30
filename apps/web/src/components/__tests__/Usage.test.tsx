import type { UsageSummaryDto, UsageTotals } from '@friday/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../lib/api';
import { compact, duration, money, UsageSettings } from '../UsageSettings';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const totals = (over: Partial<UsageTotals> = {}): UsageTotals => ({
  calls: 0,
  errors: 0,
  estimatedCalls: 0,
  callsWithoutTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  durationMs: 0,
  cost: null,
  ...over,
});

const summary = (over: Partial<UsageSummaryDto> = {}): UsageSummaryDto => ({
  days: 7,
  since: '2026-10-23T16:00:00.000Z',
  totals: totals({
    calls: 12,
    errors: 1,
    inputTokens: 240_000,
    outputTokens: 9_500,
    durationMs: 95_000,
  }),
  byDay: ['24', '25', '26', '27', '28', '29', '30'].map((d, i) => ({
    day: `2026-10-${d}`,
    ...totals(
      i === 6 ? { calls: 12, inputTokens: 240_000, outputTokens: 9_500, durationMs: 95_000 } : {},
    ),
  })),
  byModel: [
    {
      model: 'claude-sonnet-4.6',
      ...totals({ calls: 12, inputTokens: 240_000, outputTokens: 9_500 }),
    },
  ],
  bySession: [
    {
      sessionId: 's1',
      title: 'Fix login',
      deleted: false,
      ...totals({ calls: 9, inputTokens: 200_000 }),
    },
    { sessionId: 's2', title: null, deleted: true, ...totals({ calls: 1, inputTokens: 1_000 }) },
  ],
  outsideSessions: totals({ calls: 2, inputTokens: 2_400 }),
  prices: {},
  ...over,
});

describe('usage view', () => {
  it('formats numbers', () => {
    expect([compact(950), compact(12_900), compact(1_250_000), compact(100_000)]).toEqual([
      '950',
      '12.9K',
      '1.3M',
      '100K',
    ]);
    expect([duration(4_000), duration(95_000), duration(3_780_000)]).toEqual([
      '4s',
      '1m 35s',
      '1h 3m',
    ]);
    expect([money(null), money(0.004), money(18.5)]).toEqual(['–', '<$0.01', '$18.50']);
  });

  it('shows totals, a bar per day, the top conversations and models', async () => {
    const load = vi.spyOn(api, 'usage').mockResolvedValue(summary());
    render(<UsageSettings />);
    await screen.findByText('Fix login');
    expect(load).toHaveBeenCalledWith(30, -new Date().getTimezoneOffset());
    expect(screen.getByText('240K in · 9.5K out')).toBeTruthy();
    expect(screen.getByText('1 failed')).toBeTruthy();
    expect(screen.getByText('1m 35s')).toBeTruthy();
    expect(screen.getByText('add prices below')).toBeTruthy();
    expect(screen.getAllByTestId('usage-day')).toHaveLength(7);
    expect(screen.getByText('Deleted conversation')).toBeTruthy();
    expect(screen.getByText('Probes and connection tests')).toBeTruthy();

    // Hovering a day shows its numbers.
    fireEvent.mouseEnter(screen.getAllByTestId('usage-day')[6]!);
    const tip = screen.getByRole('tooltip');
    expect(within(tip).getByText('240,000')).toBeTruthy();
    expect(within(tip).getByText('12')).toBeTruthy();

    // The same numbers as a table.
    fireEvent.click(screen.getByRole('button', { name: 'Show usage as a table' }));
    const table = screen.getByRole('region', { name: 'Usage per day' });
    expect(within(table).getAllByRole('row')).toHaveLength(8);

    // Changing the range reloads.
    fireEvent.click(screen.getByRole('button', { name: '7 days' }));
    await waitFor(() => expect(load).toHaveBeenLastCalledWith(7, expect.any(Number)));
  });

  it('saves prices per model and shows the estimate', async () => {
    const load = vi
      .spyOn(api, 'usage')
      .mockResolvedValueOnce(summary())
      .mockResolvedValue(
        summary({
          prices: { 'claude-sonnet-4.6': { input: 3, output: 15 } },
          totals: totals({ calls: 12, inputTokens: 240_000, outputTokens: 9_500, cost: 0.86 }),
        }),
      );
    const save = vi.spyOn(api, 'saveUsagePrices').mockResolvedValue({ prices: {} });
    render(<UsageSettings />);
    await screen.findByText('Fix login');

    const saveButton = screen.getByRole('button', { name: /Save prices/ });
    expect((saveButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('claude-sonnet-4.6 input price per million tokens'), {
      target: { value: '3' },
    });
    fireEvent.change(screen.getByLabelText('claude-sonnet-4.6 output price per million tokens'), {
      target: { value: '15' },
    });
    fireEvent.click(saveButton);
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({ 'claude-sonnet-4.6': { input: 3, output: 15 } }),
    );
    expect(await screen.findByText('$0.86')).toBeTruthy();
    expect(screen.getByText('from your prices')).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('marks token counts that include estimates', async () => {
    vi.spyOn(api, 'usage').mockResolvedValue(
      summary({
        totals: totals({
          calls: 12,
          estimatedCalls: 9,
          callsWithoutTokens: 3,
          inputTokens: 240_000,
          outputTokens: 9_500,
        }),
      }),
    );
    render(<UsageSettings />);
    expect(await screen.findByText('~250K')).toBeTruthy();
    expect(screen.getByText(/include Friday's estimates \(9 of 12 calls\)/)).toBeTruthy();
    expect(
      screen.getByText(
        /3 calls \(failed, or from before Friday estimated tokens\) have no token counts/,
      ),
    ).toBeTruthy();
  });

  it('says so when nothing was used', async () => {
    vi.spyOn(api, 'usage').mockResolvedValue(
      summary({
        totals: totals(),
        byDay: [],
        byModel: [],
        bySession: [],
        outsideSessions: totals(),
      }),
    );
    render(<UsageSettings />);
    expect(await screen.findByText('No model calls in the last 7 days.')).toBeTruthy();
  });
});
