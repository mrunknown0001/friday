import type { ProjectDto } from '@friday/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../lib/api';
import { ProjectSettingsDialog } from '../ProjectSettingsDialog';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const project = {
  id: 'p1',
  name: 'shop',
  rootPath: '/home/u/shop',
  available: true,
  sandbox: null,
} as unknown as ProjectDto;

describe('code map in project settings', () => {
  it('shows what is indexed and rebuilds on request', async () => {
    vi.spyOn(api, 'projectSandbox').mockResolvedValue({
      docker: null,
      suggestedImage: 'node:22-bookworm-slim',
      imagePresent: null,
    } as never);
    vi.spyOn(api, 'projectCodeMap').mockResolvedValue({ files: 0, symbols: 0, lastRefresh: null });
    const rebuild = vi.spyOn(api, 'rebuildCodeMap').mockResolvedValue({
      files: 1234,
      symbols: 5678,
      lastRefresh: { at: new Date().toISOString(), durationMs: 900, truncated: false },
    });
    render(<ProjectSettingsDialog project={project} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(await screen.findByText('Not built yet.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Rebuild' }));
    await waitFor(() => expect(screen.getByText(/1,234 source files, 5,678/)).toBeTruthy());
    expect(rebuild).toHaveBeenCalledWith('p1');
  });
});
