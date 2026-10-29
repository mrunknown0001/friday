import type { MemoryDto, ProjectDto } from '@friday/shared';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoriesUsed } from '../MemoriesUsed';

const apiMock = vi.hoisted(() => ({
  memorySettings: vi.fn(),
  memories: vi.fn(),
  setMemorySettings: vi.fn(),
  updateMemory: vi.fn(),
  deleteMemory: vi.fn(),
  createMemory: vi.fn(),
  exportMemory: vi.fn(),
}));
vi.mock('../../lib/api', () => ({ api: apiMock }));
const { MemoryDialog } = await import('../MemoryDialog');

afterEach(cleanup);

const mem = (over: Partial<MemoryDto>): MemoryDto => ({
  id: 'm1',
  scope: 'project',
  category: 'command',
  content: 'Tests run with pnpm test.',
  projectId: 'p1',
  sessionId: null,
  status: 'active',
  confidence: 'confirmed',
  pinned: false,
  source: 'agent',
  sourceRunId: null,
  supersedesId: null,
  createdAt: '',
  updatedAt: '',
  lastUsedAt: null,
  useCount: 2,
  ...over,
});
const project: ProjectDto = {
  id: 'p1',
  name: 'shop',
  rootPath: '/srv/shop',
  createdAt: '',
  lastOpenedAt: null,
  available: true,
  sandbox: null,
};

describe('MemoriesUsed', () => {
  it('discloses which memories informed an answer and why', async () => {
    render(
      <MemoriesUsed
        refs={[
          {
            id: 'a',
            scope: 'project',
            category: 'command',
            content: 'Tests run with pnpm test.',
            reason: 'relevant',
          },
          {
            id: 'b',
            scope: 'user',
            category: 'preference',
            content: 'Prefers concise answers.',
            reason: 'pinned',
          },
        ]}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Used 2 saved memories/ }));
    const list = screen.getByRole('list', { name: 'Memories used' });
    expect(within(list).getByText('Tests run with pnpm test.')).toBeTruthy();
    expect(within(list).getByText(/project\/command · relevant to your request/)).toBeTruthy();
    expect(within(list).getByText(/user\/preference · pinned/)).toBeTruthy();
  });

  it('renders nothing when no memories were used', () => {
    const { container } = render(<MemoriesUsed refs={[]} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('MemoryDialog', () => {
  beforeEach(() => {
    for (const f of Object.values(apiMock)) f.mockReset();
    apiMock.memorySettings.mockResolvedValue({ enabled: true, disabledProjectIds: [] });
    apiMock.memories.mockImplementation(async (f: { status?: string }) =>
      f.status === 'pending'
        ? {
            memories: [
              mem({
                id: 'pend',
                scope: 'user',
                category: 'preference',
                content: 'Prefers small commits.',
                status: 'pending',
                projectId: null,
              }),
            ],
          }
        : { memories: [mem({})] },
    );
    apiMock.updateMemory.mockResolvedValue(mem({}));
    apiMock.deleteMemory.mockResolvedValue(undefined);
    apiMock.setMemorySettings.mockImplementation(async (s: unknown) => s);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  it('lets the user approve proposed preferences, delete memories, and disable memory per project', async () => {
    render(<MemoryDialog project={project} onClose={() => undefined} />);
    const pending = await screen.findByRole('region', { name: 'Proposed preferences' });
    await userEvent.click(within(pending).getByRole('button', { name: /Approve/ }));
    expect(apiMock.updateMemory).toHaveBeenCalledWith('pend', { status: 'active' });

    const saved = screen.getByRole('region', { name: 'Saved memories' });
    await waitFor(() => expect(within(saved).getByText('Tests run with pnpm test.')).toBeTruthy());
    await userEvent.click(within(saved).getByRole('button', { name: 'Delete memory' }));
    expect(apiMock.deleteMemory).toHaveBeenCalledWith('m1');

    await userEvent.click(screen.getByLabelText('Use memory in shop'));
    expect(apiMock.setMemorySettings).toHaveBeenCalledWith({
      enabled: true,
      disabledProjectIds: ['p1'],
    });
  });
});
