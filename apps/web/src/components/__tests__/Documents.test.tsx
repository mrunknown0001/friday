import type { ApprovalDto } from '@friday/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../lib/api';
import { ApprovalCard } from '../ApprovalCard';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const card = (status: ApprovalDto['status']): ApprovalDto => ({
  id: 'a1',
  sessionId: 's1',
  runId: 'r1',
  projectId: 'p1',
  toolCallId: 'c1',
  toolName: 'create_document',
  category: 'file_create',
  risk: 'low',
  title: 'Create docs/roadmap.pdf',
  summary: 'Creates the PDF document docs/roadmap.pdf ("Q4 Roadmap").',
  reason: 'The user asked for a roadmap',
  details: {
    kind: 'document',
    path: 'docs/roadmap.pdf',
    format: 'pdf',
    change: 'create',
    title: 'Q4 Roadmap',
    outline: ['Summary', '  Milestones', '~420 words, 1 table'],
  },
  actionHash: 'a'.repeat(64),
  status,
  decisionNote: null,
  resultSummary: null,
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  decidedAt: null,
  confirmationRequired: null,
  grantedBy: null,
});

describe('document approval card', () => {
  it('shows the format, path and outline before approval, with no actions yet', () => {
    render(<ApprovalCard approval={card('pending')} onDecide={vi.fn()} />);
    expect(screen.getByText('PDF')).toBeTruthy();
    expect(screen.getByText('new file')).toBeTruthy();
    const outline = screen.getByRole('list', { name: 'Document outline' });
    expect(outline.textContent).toContain('Milestones');
    expect(screen.queryByRole('link', { name: /Download/ })).toBeNull();
  });

  it('offers Open (desktop) and Download once the file was written', async () => {
    vi.spyOn(api, 'previewStatus').mockResolvedValue({ screenshots: 'desktop', openFiles: true });
    const open = vi.spyOn(api, 'openProjectFile').mockResolvedValue({ opened: true });
    render(<ApprovalCard approval={card('executed')} onDecide={vi.fn()} />);
    expect(screen.getByRole('link', { name: 'Download roadmap.pdf' }).getAttribute('href')).toBe(
      '/api/projects/p1/download?path=docs%2Froadmap.pdf',
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Open roadmap.pdf' }));
    await waitFor(() => expect(open).toHaveBeenCalledWith('p1', 'docs/roadmap.pdf'));
  });
});
