import type { ProjectDto, SessionSearchResultDto, SessionSummaryDto } from '@friday/shared';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../lib/api';
import { Sidebar } from '../Sidebar';
import { SidePanel } from '../SidePanel';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  localStorage.clear();
});

const project = (id: string, name: string, rootPath: string, over: Partial<ProjectDto> = {}) =>
  ({
    id,
    name,
    rootPath,
    available: true,
    sandbox: null,
    worktree: null,
    externalFolders: [],
    ...over,
  }) as unknown as ProjectDto;

const session = (id: string, title: string): SessionSummaryDto => ({
  id,
  projectId: 'p1',
  title,
  createdAt: '2026-11-05T10:00:00.000Z',
  updatedAt: '2026-11-05T10:00:00.000Z',
  lastRunStatus: null,
  mode: 'auto',
});

const PROJECTS = [
  project('p1', 'shop', '/srv/shop'),
  project('p2', 'blog', '/home/u/sites/blog'),
  project('p3', 'api', '/srv/api', { available: false }),
  project('w1', 'shop task', '/srv/shop-wt', { worktree: { status: 'active' } as never }),
];

function renderSidebar(over: Partial<Parameters<typeof Sidebar>[0]> = {}) {
  const props = {
    projects: PROJECTS,
    projectId: 'p1',
    onSelectProject: vi.fn(),
    onAddProject: vi.fn(),
    onRemoveProject: vi.fn(),
    onProjectSettings: vi.fn(),
    sessions: [session('s1', 'Deploy to staging'), session('s2', 'Caching')],
    activeId: 's1',
    onSelect: vi.fn(),
    onNew: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenMemory: vi.fn(),
    onOpenMonitors: vi.fn(),
    monitorsDown: 0,
    settingsWarning: false,
    ...over,
  };
  return { props, ...render(<Sidebar {...props} />) };
}

describe('project picker', () => {
  it('finds projects by name or folder and picks with the mouse or keyboard', () => {
    const { props } = renderSidebar();
    const button = screen.getByRole('button', { name: 'Project' });
    expect(button.textContent).toBe('shop');

    fireEvent.click(button);
    const search = screen.getByRole('combobox', { name: 'Search projects' });
    const names = () =>
      within(screen.getByRole('listbox', { name: 'Projects' }))
        .getAllByRole('option')
        .map((o) => o.textContent);
    // Worktree projects are reached through their parent.
    expect(names()).toEqual([
      'No project (chat only)',
      'shop/srv/shop',
      'blog/home/u/sites/blog',
      'api (missing)/srv/api',
    ]);
    expect(screen.getByRole('option', { name: /shop/ }).getAttribute('aria-selected')).toBe('true');

    fireEvent.change(search, { target: { value: 'SITES' } });
    expect(names()).toEqual(['blog/home/u/sites/blog']);
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(props.onSelectProject).toHaveBeenCalledWith('p2');
    expect(screen.queryByRole('listbox')).toBeNull();

    fireEvent.click(button);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'srv' } });
    expect(names()).toEqual(['shop/srv/shop', 'api (missing)/srv/api']);
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
    expect(props.onSelectProject).toHaveBeenLastCalledWith('p3');

    fireEvent.click(button);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'nothing here' } });
    expect(screen.getByText('No project matches “nothing here”.')).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();

    fireEvent.click(button);
    fireEvent.click(screen.getByRole('option', { name: 'No project (chat only)' }));
    expect(props.onSelectProject).toHaveBeenLastCalledWith(null);
  });
});

describe('conversation search', () => {
  const hit = (id: string, title: string, snippet: string | null, titleMatch = false) =>
    ({ session: session(id, title), titleMatch, snippet }) as SessionSearchResultDto;

  it('searches titles and messages in the project and opens a result', async () => {
    vi.useFakeTimers();
    const searchSessions = vi.spyOn(api, 'searchSessions').mockResolvedValue({
      results: [
        hit('s2', 'Caching', '…we add Redis for sessions?'),
        hit('s9', 'Redis plan', null, true),
      ],
    });
    const { props, rerender } = renderSidebar();
    const box = screen.getByRole('searchbox', { name: 'Search conversations' });

    fireEvent.change(box, { target: { value: 're' } });
    fireEvent.change(box, { target: { value: ' redis ' } });
    await act(async () => vi.advanceTimersByTimeAsync(250));
    // Typing quickly sends one search.
    expect(searchSessions).toHaveBeenCalledTimes(1);
    expect(searchSessions).toHaveBeenCalledWith('redis', 'p1');

    const results = screen.getByRole('list', { name: 'Search results' });
    const items = within(results).getAllByRole('button');
    expect(items.map((b) => b.textContent)).toEqual([
      'Caching…we add Redis for sessions?',
      'Redis plan',
    ]);
    expect([...results.querySelectorAll('mark')].map((m) => m.textContent)).toEqual([
      'Redis',
      'Redis',
    ]);
    fireEvent.click(items[1]!);
    expect(props.onSelect).toHaveBeenCalledWith('s9');

    // Escape clears the search and the full list returns.
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.queryByRole('list', { name: 'Search results' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Deploy to staging' })).toBeTruthy();

    searchSessions.mockResolvedValue({ results: [] });
    fireEvent.change(box, { target: { value: 'kafka' } });
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(screen.getByRole('status').textContent).toBe('No conversation mentions “kafka”.');

    // Another project starts with an empty search.
    rerender(<Sidebar {...props} projectId="p2" />);
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('');
  });

  it('shows why a search failed', async () => {
    vi.useFakeTimers();
    vi.spyOn(api, 'searchSessions').mockRejectedValue(new Error('Friday server unreachable.'));
    renderSidebar();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'x' } });
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(screen.getByRole('alert').textContent).toBe('Friday server unreachable.');
  });
});

describe('side panel sections', () => {
  it('fold away and back, and stay folded after a reload', async () => {
    vi.spyOn(api, 'projectTree').mockResolvedValue({ path: '.', truncated: false, entries: [] });
    const props = {
      project: PROJECTS[0]!,
      plan: null,
      changes: [],
      onRevert: vi.fn(),
    };
    const { unmount } = render(<SidePanel {...props} />);
    const plan = screen.getByRole('button', { name: 'Plan' });
    expect(plan.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText(/No plan yet/)).toBeTruthy();

    fireEvent.click(plan);
    expect(plan.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText(/No plan yet/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Files · shop' }));
    expect(screen.queryByText(/Respects .gitignore/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Changes' }).getAttribute('aria-expanded')).toBe(
      'true',
    );

    unmount();
    render(<SidePanel {...props} />);
    expect(screen.getByRole('button', { name: 'Plan' }).getAttribute('aria-expanded')).toBe(
      'false',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Plan' }));
    expect(screen.getByText(/No plan yet/)).toBeTruthy();
  });
});
