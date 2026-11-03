import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../lib/api';
import { SidePanel } from '../SidePanel';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(api, 'projectTree').mockResolvedValue({
    path: '.',
    entries: [{ path: 'src', name: 'src', type: 'dir', size: null }],
    truncated: false,
  });
});

function panel() {
  render(
    <SidePanel
      project={
        { id: 'p1', name: 'shop', rootPath: '/x', available: true, externalFolders: [] } as never
      }
      plan={null}
      changes={[]}
      onRevert={vi.fn()}
    />,
  );
}

describe('project search', () => {
  it('searches as you type, groups results by file, and opens one at its line', async () => {
    const search = vi.spyOn(api, 'searchProject').mockResolvedValue({
      matches: [
        { path: 'src/users.ts', line: 1, text: 'export function getUser() {}' },
        { path: 'src/users.ts', line: 9, text: '  return getUser();' },
        { path: 'src/orders.php', line: 4, text: 'getUser();' },
      ],
      truncated: false,
      engine: 'builtin',
    });
    vi.spyOn(api, 'projectFile').mockResolvedValue({
      path: 'src/users.ts',
      size: 10,
      binary: false,
      tooLarge: false,
      content: 'line\n'.repeat(20),
      language: 'typescript',
    });
    panel();
    await act(async () => undefined);
    expect(screen.getByRole('button', { name: /src/ })).toBeTruthy();

    const box = screen.getByRole('searchbox', { name: 'Search in files' });
    fireEvent.change(box, { target: { value: 'get' } });
    fireEvent.change(box, { target: { value: 'getUser\\(' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use regular expression' }));
    fireEvent.change(screen.getByLabelText('Files to include'), { target: { value: '*.ts' } });
    await waitFor(() => expect(screen.getByRole('list', { name: 'Search results' })).toBeTruthy());
    // Debounced: only the final query was sent.
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith(
      'p1',
      { query: 'getUser\\(', regex: true, caseSensitive: false, glob: '*.ts' },
      expect.any(AbortSignal),
    );
    expect(screen.getByText('3 results in 2 files')).toBeTruthy();
    // The tree is replaced by the results while there is a query.
    expect(screen.queryByRole('button', { name: /^src$/ })).toBeNull();

    const results = screen.getByRole('list', { name: 'Search results' });
    fireEvent.click(within(results).getByRole('button', { name: 'src/users.ts line 9' }));
    expect(await screen.findByText('src/users.ts:9')).toBeTruthy();
  });

  it('shows an invalid or runaway regex, and Esc brings the tree back', async () => {
    vi.spyOn(api, 'searchProject').mockRejectedValue(
      new Error('Invalid regex: Unterminated group'),
    );
    panel();
    await act(async () => undefined);
    const box = screen.getByRole('searchbox', { name: 'Search in files' });
    fireEvent.click(screen.getByRole('button', { name: 'Use regular expression' }));
    fireEvent.change(box, { target: { value: '(unclosed' } });
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Invalid regex: Unterminated group',
    );
    fireEvent.keyDown(box, { key: 'Escape' });
    expect((box as HTMLInputElement).value).toBe('');
    expect(screen.getByRole('button', { name: /src/ })).toBeTruthy();
  });
});
