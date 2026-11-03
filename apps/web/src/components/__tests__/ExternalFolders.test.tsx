import type { ApprovalDto, ProjectDto } from '@friday/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../lib/api';
import { canAllowSimilar } from '../../lib/taskPermission';
import { ProjectSettingsDialog } from '../ProjectSettingsDialog';
import { SidePanel } from '../SidePanel';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const project = (externalFolders: string[] = []) =>
  ({
    id: 'p1',
    name: 'shop',
    rootPath: '/srv/shop',
    available: true,
    sandbox: null,
    worktree: null,
    externalFolders,
  }) as unknown as ProjectDto;

describe('external folders in project settings', () => {
  it('adds and removes folders, saving each change and showing refusals', async () => {
    vi.spyOn(api, 'projectSandbox').mockResolvedValue({
      docker: null,
      suggestedImage: 'node:22-bookworm-slim',
      imagePresent: null,
    } as never);
    vi.spyOn(api, 'projectCodeMap').mockResolvedValue({ files: 0, symbols: 0, lastRefresh: null });
    vi.spyOn(api, 'savedActions').mockResolvedValue({ actions: [] } as never);
    const save = vi
      .spyOn(api, 'setExternalFolders')
      .mockResolvedValueOnce(project(['/srv/lib']))
      .mockRejectedValueOnce(new Error('That folder is too broad to authorize.'))
      .mockResolvedValueOnce(project([]));
    const onSaved = vi.fn();
    render(<ProjectSettingsDialog project={project()} onClose={vi.fn()} onSaved={onSaved} />);

    const input = screen.getByRole('textbox', { name: 'Folder to add' });
    fireEvent.change(input, { target: { value: ' /srv/lib ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    const list = await screen.findByRole('list', { name: 'External folders' });
    expect(within(list).getByText('/srv/lib')).toBeTruthy();
    expect(save).toHaveBeenLastCalledWith('p1', ['/srv/lib']);
    expect(onSaved).toHaveBeenCalledWith(
      expect.objectContaining({ externalFolders: ['/srv/lib'] }),
    );
    expect((input as HTMLInputElement).value).toBe('');

    fireEvent.change(input, { target: { value: '/home/u' } });
    fireEvent.submit(input.closest('form')!);
    expect((await screen.findByRole('alert')).textContent).toMatch(/too broad/);
    expect((input as HTMLInputElement).value).toBe('/home/u');

    fireEvent.click(screen.getByRole('button', { name: 'Remove /srv/lib' }));
    await waitFor(() =>
      expect(screen.queryByRole('list', { name: 'External folders' })).toBeNull(),
    );
    expect(save).toHaveBeenLastCalledWith('p1', []);
  });
});

describe('external folders in the side panel', () => {
  it('lists them under the project files and browses them by absolute path', async () => {
    const tree = vi.spyOn(api, 'projectTree').mockImplementation(async (_id, path = '.') => ({
      path,
      truncated: false,
      entries:
        path === '.'
          ? [{ name: 'src', path: 'src', type: 'dir', size: null }]
          : [{ name: 'math.ts', path: '/srv/lib/math.ts', type: 'file', size: 10 }],
    }));
    render(
      <SidePanel project={project(['/srv/lib'])} plan={null} changes={[]} onRevert={vi.fn()} />,
    );
    expect(await screen.findByText('External folders')).toBeTruthy();
    fireEvent.click(screen.getByTitle('/srv/lib'));
    expect(await screen.findByText('math.ts')).toBeTruthy();
    expect(tree).toHaveBeenCalledWith('p1', '/srv/lib');
  });
});

describe('allow similar', () => {
  it('is not offered for changes in an external folder', () => {
    const approval = (path: string) =>
      ({
        toolName: 'edit_file',
        risk: 'medium',
        confirmationRequired: false,
        details: {
          kind: 'file_change',
          changes: [{ path, change: 'modify', diff: '', added: 1, removed: 1 }],
        },
      }) as unknown as ApprovalDto;
    expect(canAllowSimilar(approval('src/a.ts'))).toBe('files');
    expect(canAllowSimilar(approval('/srv/lib/a.ts'))).toBeNull();
  });
});
