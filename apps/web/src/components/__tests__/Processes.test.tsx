import type { ProcessDto } from '@friday/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../lib/api';
import { crashed, ProcessList } from '../Processes';
import { SidePanel } from '../SidePanel';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const proc = (over: Partial<ProcessDto> = {}): ProcessDto => ({
  id: 'proc_1a2b3c4d',
  projectId: 'p1',
  sessionId: 's1',
  name: 'dev server',
  command: 'npm run dev',
  cwd: '.',
  sandbox: null,
  status: 'running',
  exitCode: null,
  signal: null,
  error: null,
  stoppedBy: null,
  urls: ['http://localhost:5173/'],
  startedAt: new Date().toISOString(),
  endedAt: null,
  ...over,
});

describe('processes panel', () => {
  it('lists processes with status, local links and the right control', () => {
    const onStop = vi.fn();
    const onDismiss = vi.fn();
    render(
      <ProcessList
        processes={[
          proc(),
          proc({ id: 'proc_00000002', name: 'tsc watch', status: 'exited', exitCode: 2, urls: [] }),
        ]}
        onStop={onStop}
        onDismiss={onDismiss}
      />,
    );
    const link = screen.getByRole('link', { name: /localhost:5173/ });
    expect(link.getAttribute('href')).toBe('http://localhost:5173/');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(screen.getByText('exited (code 2)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stop dev server' }));
    expect(onStop).toHaveBeenCalledWith(expect.objectContaining({ id: 'proc_1a2b3c4d' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove tsc watch from the list' }));
    expect(onDismiss).toHaveBeenCalledWith(expect.objectContaining({ id: 'proc_00000002' }));
    expect(screen.queryByRole('button', { name: 'Stop tsc watch' })).toBeNull();
  });

  it('follows output: the latest lines first, then only what is new', async () => {
    const output = vi
      .spyOn(api, 'processOutput')
      .mockResolvedValueOnce({
        process: proc(),
        output: 'VITE ready\n',
        cursor: 11,
        dropped: false,
      })
      .mockResolvedValue({ process: proc(), output: 'page reload\n', cursor: 23, dropped: false });
    render(<ProcessList processes={[proc()]} onStop={vi.fn()} onDismiss={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show output of dev server' }));
    const log = await screen.findByRole('log', { name: 'Output of dev server' });
    await waitFor(() => expect(log.textContent).toBe('VITE ready\npage reload\n'), {
      timeout: 3_000,
    });
    expect(output).toHaveBeenNthCalledWith(1, 'proc_1a2b3c4d', undefined);
    expect(output).toHaveBeenNthCalledWith(2, 'proc_1a2b3c4d', 11);
  });

  it('only flags processes that failed by themselves', () => {
    expect(crashed(proc({ status: 'exited', exitCode: 1 }))).toBe(true);
    expect(crashed(proc({ status: 'exited', exitCode: 0 }))).toBe(false);
    expect(crashed(proc({ status: 'stopped', stoppedBy: 'user', signal: 'SIGTERM' }))).toBe(false);
    expect(crashed(proc({ status: 'exited', error: 'Command not found: vite' }))).toBe(true);
  });

  it('appears in the side panel only when the project has processes', () => {
    vi.spyOn(api, 'projectTree').mockResolvedValue({ path: '.', entries: [] } as never);
    const project = {
      id: 'p1',
      name: 'shop',
      rootPath: '/home/u/shop',
      available: true,
    } as never;
    const { rerender } = render(
      <SidePanel project={project} plan={null} changes={[]} onRevert={vi.fn()} />,
    );
    expect(screen.queryByRole('heading', { name: 'Processes' })).toBeNull();
    rerender(
      <SidePanel
        project={project}
        plan={null}
        changes={[]}
        onRevert={vi.fn()}
        processes={[proc()]}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Processes' })).toBeTruthy();
  });
});
