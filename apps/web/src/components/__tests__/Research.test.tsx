import type { ResearchDto, WebStatusDto } from '@friday/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../lib/api';
import { ResearchCard } from '../ResearchCard';
import { toolLabel } from '../ToolActivity';
import { WebSettings } from '../WebSettings';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const base: ResearchDto = {
  id: 'r1',
  sessionId: 's',
  runId: 'run',
  toolCallId: 'c',
  projectId: null,
  question: 'How do we migrate to Vite 6?',
  status: 'running',
  phase: 'reading',
  subQuestions: ['What changed in Vite 6?', 'Is Node 18 supported?'],
  searches: [
    { query: 'vite 6 breaking changes', results: 6, error: null },
    { query: 'error in /home/x', results: 0, error: 'Not sent: Leave file paths out' },
  ],
  sources: [
    {
      n: null,
      url: 'https://vite.dev/guide/migration',
      title: 'Migration from v5',
      site: 'vite.dev',
      publishedAt: null,
      status: 'pending',
      error: null,
    },
    {
      n: null,
      url: 'https://example.com/gone',
      title: 'Gone',
      site: 'example.com',
      publishedAt: null,
      status: 'failed',
      error: 'https://example.com/gone answered HTTP 404.',
    },
  ],
  report: null,
  note: null,
  limits: { maxSearches: 12, maxPages: 15, maxMinutes: 5 },
  startedAt: '2026-10-31T10:00:00.000Z',
  finishedAt: null,
};

describe('research card', () => {
  it('shows live progress: phase, counts, queries sent and pages', () => {
    render(<ResearchCard research={base} />);
    const card = screen.getByRole('region', { name: 'Research: researching' });
    expect(within(card).getByRole('status').textContent).toBe(
      'Reading pages · 2 of 12 searches · 0 of 15 pages read',
    );
    expect(within(card).getByText('vite 6 breaking changes')).toBeTruthy();
    expect(within(card).getByText('Not sent: Leave file paths out')).toBeTruthy();
    const pages = within(card).getByRole('region', { name: 'Pages' });
    expect(within(pages).getByRole('img', { name: 'reading' })).toBeTruthy();
    expect(within(pages).getByText('https://example.com/gone answered HTTP 404.')).toBeTruthy();
    expect(
      within(pages).getByRole('link', { name: 'Migration from v5' }).getAttribute('href'),
    ).toBe('https://vite.dev/guide/migration');
  });

  it('shows the report when done and saves it as a document', async () => {
    const done: ResearchDto = {
      ...base,
      status: 'completed',
      phase: 'done',
      sources: [{ ...base.sources[0]!, n: 1, status: 'read' }],
      report:
        'Move to Node 20 first [[1]](https://vite.dev/guide/migration).\n\n## Sources\n\n1. x',
      note: '1 citation pointed at no source and was removed.',
    };
    const blob = new Blob(['# report']);
    const exp = vi.spyOn(api, 'exportResearch').mockResolvedValue({ blob, name: 'r.md' });
    vi.stubGlobal(
      'URL',
      Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL() {} }),
    );
    render(<ResearchCard research={done} />);
    const card = screen.getByRole('region', { name: 'Research: done' });
    expect(within(card).getByText('1 citation pointed at no source and was removed.')).toBeTruthy();
    // Steps are folded once it's done.
    expect(within(card).queryByRole('region', { name: 'Searches' })).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: 'Searches and pages' }));
    expect(within(card).getByRole('region', { name: 'Searches' })).toBeTruthy();
    expect(within(card).getByLabelText('Research report').textContent).toContain(
      'Move to Node 20 first',
    );
    fireEvent.click(within(card).getByRole('button', { name: 'Word' }));
    await waitFor(() => expect(exp).toHaveBeenCalledWith('r1', 'docx'));
    vi.unstubAllGlobals();
  });

  it('labels web tool calls by their query, page or question', () => {
    expect(toolLabel('web_search', JSON.stringify({ query: 'vite 6 migration' }))).toBe(
      'vite 6 migration',
    );
    expect(toolLabel('read_web_page', JSON.stringify({ url: 'https://vite.dev/guide' }))).toBe(
      'vite.dev/guide',
    );
    expect(toolLabel('deep_research', JSON.stringify({ question: 'Which PDF library?' }))).toBe(
      'Which PDF library?',
    );
  });
});

describe('web settings', () => {
  const status = (searchConfigured: boolean): WebStatusDto => ({
    settings: { enabled: true, maxSearches: 12, maxPages: 15, maxMinutes: 5 },
    searchConfigured,
    envFile: '/friday/.env',
    hardLimits: { maxSearches: 30, maxPages: 40, maxMinutes: 15 },
  });

  it('says where the Tavily key goes, and saves the switch and limits within bounds', async () => {
    vi.spyOn(api, 'web').mockResolvedValue(status(false));
    const save = vi.spyOn(api, 'setWebSettings').mockResolvedValue({} as never);
    render(<WebSettings />);
    await screen.findByText('no key');
    expect(screen.getByText('/friday/.env')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/^Searches/), { target: { value: '99' } });
    expect(save).toHaveBeenLastCalledWith({
      enabled: true,
      maxSearches: 30,
      maxPages: 15,
      maxMinutes: 5,
    });
    fireEvent.click(screen.getByLabelText('Let Friday search the web and read pages'));
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
  });
});
