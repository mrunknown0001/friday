import type { AttachmentDto, MessageDto, SessionDetailDto } from '@friday/shared';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../lib/api';
import type * as Images from '../../lib/images';
import { targetSize } from '../../lib/images';
import { ChatView } from '../ChatView';

// jsdom cannot decode images; the upload path is what is under test here.
vi.mock('../../lib/images', async (orig) => ({
  ...(await orig<typeof Images>()),
  prepareImage: async (file: Blob) => file,
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const shot: AttachmentDto = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'checkout.png',
  mime: 'image/png',
  size: 2048,
  width: 1280,
  height: 720,
  createdAt: '2026-10-30T10:00:00.000Z',
};

const detail = (messages: MessageDto[]): SessionDetailDto => ({
  id: 's1',
  projectId: null,
  title: 'Chat',
  createdAt: '2026-10-30T10:00:00.000Z',
  updatedAt: '2026-10-30T10:00:00.000Z',
  lastRunStatus: null,
  messages,
  latestRun: null,
  hasSummary: false,
  plan: null,
  approvals: [],
  runs: [],
  deploymentPlans: [],
  reviews: [],
  testRuns: [],
  browserFlows: [],
  loadTests: [],
  memoryUsage: {},
});

const props = (d: SessionDetailDto, onSend = vi.fn(async () => true)) => ({
  detail: d,
  project: null,
  live: null,
  canSend: true,
  blockedReason: null,
  sidePanelOpen: false,
  onToggleSidePanel: () => {},
  onSend,
  onStop: () => {},
  onRetry: () => {},
  onOpenSettings: () => {},
  approvals: [],
  onDecide: async () => {},
  deploymentPlans: [],
  reviews: [],
  testRuns: [],
  browserFlows: [],
  loadTests: [],
  onRollback: async () => {},
  onOpenMemory: () => {},
  onRevokeTaskPermission: async () => {},
});

function paste(target: HTMLElement, files: File[], text = '') {
  fireEvent.paste(target, {
    clipboardData: {
      items: files.map((f) => ({ kind: 'file', type: f.type, getAsFile: () => f })),
      getData: () => text,
    },
  });
}

describe('image attachments', () => {
  it('shows images sent with a message, and opens one full size', () => {
    const m: MessageDto = {
      id: 1,
      sessionId: 's1',
      runId: null,
      role: 'user',
      content: 'Why is this button purple?',
      status: 'complete',
      model: null,
      createdAt: '2026-10-30T10:00:00.000Z',
      attachments: [shot],
    };
    render(<ChatView {...props(detail([m]))} />);
    const img = screen.getByRole('img', { name: 'checkout.png' });
    expect(img.getAttribute('src')).toBe(`/api/attachments/${shot.id}`);
    fireEvent.click(screen.getByRole('button', { name: 'View checkout.png' }));
    expect(screen.getByText(/1280×720 px · PNG/)).toBeTruthy();
  });

  it('uploads pasted screenshots and sends them with the message (even without text)', async () => {
    let finish!: (a: AttachmentDto) => void;
    const upload = vi
      .spyOn(api, 'uploadAttachment')
      .mockReturnValue(new Promise<AttachmentDto>((r) => (finish = r)));
    const onSend = vi.fn(async () => true);
    render(<ChatView {...props(detail([]), onSend)} />);
    const box = screen.getByLabelText('Message');
    paste(box, [new File([new Uint8Array([1])], 'image.png', { type: 'image/png' })]);

    expect(await screen.findByLabelText('Uploading pasted image')).toBeTruthy();
    const sendButton = screen.getByRole('button', { name: 'Send message' });
    expect((sendButton as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Images are sent to the model provider/)).toBeTruthy();
    expect(upload).toHaveBeenCalledWith(expect.any(File), 'pasted image');

    await act(async () => finish(shot));
    await waitFor(() => expect((sendButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(sendButton);
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('', [shot.id]));
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Images to send' })).toBeNull());
  });

  it('leaves pasted text alone and can remove an image before sending', async () => {
    vi.spyOn(api, 'uploadAttachment').mockResolvedValue(shot);
    const remove = vi.spyOn(api, 'removeAttachment').mockResolvedValue(undefined);
    render(<ChatView {...props(detail([]))} />);
    const box = screen.getByLabelText('Message');
    paste(box, [], 'just text');
    expect(screen.queryByRole('list', { name: 'Images to send' })).toBeNull();

    paste(box, [new File([new Uint8Array([1])], 'error.png', { type: 'image/png' })]);
    const thumb = await screen.findByRole('img', { name: 'error.png' });
    expect(thumb.getAttribute('src')).toBe(`/api/attachments/${shot.id}`);
    fireEvent.click(screen.getByRole('button', { name: 'Remove error.png' }));
    expect(remove).toHaveBeenCalledWith(shot.id);
    expect(screen.queryByRole('img', { name: 'error.png' })).toBeNull();
  });

  it('shows upload failures on the thumbnail', async () => {
    vi.spyOn(api, 'uploadAttachment').mockRejectedValue(new Error('Images can be at most 5 MB.'));
    render(<ChatView {...props(detail([]))} />);
    paste(screen.getByLabelText('Message'), [
      new File([new Uint8Array([1])], 'huge.png', { type: 'image/png' }),
    ]);
    expect(await screen.findByLabelText('huge.png: Images can be at most 5 MB.')).toBeTruthy();
  });

  it('downsizes to what models actually look at', () => {
    expect(targetSize(800, 600)).toEqual({ width: 800, height: 600 });
    expect(targetSize(3840, 2160)).toEqual({ width: 1430, height: 804 });
    expect(targetSize(1000, 4000)).toEqual({ width: 392, height: 1568 });
  });
});
