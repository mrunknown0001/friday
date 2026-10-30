import type { ApprovalDto, McpServerDto } from '@friday/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../lib/api';
import { ApprovalCard } from '../ApprovalCard';
import { McpSettings } from '../McpSettings';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const server = (over: Partial<McpServerDto> = {}): McpServerDto => ({
  id: 's1',
  name: 'notes',
  url: 'https://notes.example.com/mcp',
  enabled: true,
  status: 'connected',
  error: null,
  signedIn: true,
  hasToken: false,
  tools: [
    {
      name: 'search_notes',
      title: 'Search notes',
      description: 'Find notes containing a word.',
      readOnly: true,
      destructive: null,
      policy: 'ask',
    },
    {
      name: 'delete_all',
      title: null,
      description: 'Delete every note.',
      readOnly: null,
      destructive: true,
      policy: 'ask',
    },
  ],
  toolsRefreshedAt: null,
  createdAt: '2026-10-30T10:00:00.000Z',
  ...over,
});

describe('connected apps settings', () => {
  it('adds an app and opens its sign-in page', async () => {
    const list = vi.spyOn(api, 'mcpServers').mockResolvedValue({ servers: [] });
    const add = vi.spyOn(api, 'addMcpServer').mockResolvedValue({
      server: server({ status: 'needs_auth', signedIn: false }),
      authorizeUrl: 'https://notes.example.com/authorize?x=1',
    });
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    render(<McpSettings />);
    expect(await screen.findByText('No apps connected.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Add app/ }));
    fireEvent.change(screen.getByLabelText('App name'), { target: { value: 'Notes' } });
    fireEvent.change(screen.getByLabelText('MCP server URL'), {
      target: { value: 'https://notes.example.com/mcp' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Add and sign in/ }));
    await waitFor(() =>
      expect(add).toHaveBeenCalledWith({ name: 'notes', url: 'https://notes.example.com/mcp' }),
    );
    expect(open).toHaveBeenCalledWith(
      'https://notes.example.com/authorize?x=1',
      '_blank',
      'noopener,noreferrer',
    );
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('shows tools with their hints and changes how each may be used', async () => {
    vi.spyOn(api, 'mcpServers').mockResolvedValue({ servers: [server()] });
    const setPolicy = vi.spyOn(api, 'setMcpToolPolicy').mockResolvedValue(server());
    render(<McpSettings />);
    expect(await screen.findByText('connected')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /2 tools/ }));
    expect(screen.getByText('read-only')).toBeTruthy();
    expect(screen.getByText('destructive')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('How Friday may use search_notes'), {
      target: { value: 'allow' },
    });
    await waitFor(() => expect(setPolicy).toHaveBeenCalledWith('s1', 'search_notes', 'allow'));
  });
});

describe('connected app approval card', () => {
  it('shows the app, the tool, its hints and the exact arguments', () => {
    const approval: ApprovalDto = {
      id: 'a1',
      sessionId: 's1',
      runId: 'r1',
      projectId: null,
      toolCallId: 'c1',
      toolName: 'mcp__notes__delete_all',
      category: 'mcp',
      risk: 'high',
      title: 'notes › delete_all',
      summary: 'Calls the tool "delete_all" of your connected app "notes".',
      reason: 'Clean up the test notes',
      details: {
        kind: 'mcp',
        server: 'notes',
        serverUrl: 'https://notes.example.com/mcp',
        tool: 'delete_all',
        title: null,
        description: 'Delete every note.',
        arguments: '{\n  "confirm": true\n}',
        readOnly: null,
        destructive: true,
        openWorld: null,
      },
      actionHash: 'a'.repeat(64),
      status: 'pending',
      decisionNote: null,
      resultSummary: null,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      decidedAt: null,
      confirmationRequired: null,
      grantedBy: null,
    };
    render(<ApprovalCard approval={approval} onDecide={vi.fn()} />);
    expect(screen.getByText('Connected app')).toBeTruthy();
    expect(screen.getByText('(notes.example.com)')).toBeTruthy();
    expect(screen.getByText('may delete or overwrite')).toBeTruthy();
    expect(screen.getByLabelText('Exact arguments').textContent).toBe('{\n  "confirm": true\n}');
    // Never offered as a "similar actions" grant.
    expect(screen.queryByText(/similar/i)).toBeNull();
  });
});
