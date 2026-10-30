import type { AttachmentDto, ProcessDto } from '@friday/shared';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../lib/api';
import { ATTACH_IMAGE_EVENT, localAddress, PreviewPane } from '../PreviewPane';
import { SidePanel } from '../SidePanel';
import { ToolActivity } from '../ToolActivity';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const devServer: ProcessDto = {
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
};

const shot: AttachmentDto = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'screenshot.png',
  mime: 'image/png',
  size: 1000,
  width: 1280,
  height: 800,
  createdAt: new Date().toISOString(),
};

describe('live preview', () => {
  it('accepts only local addresses', () => {
    expect(localAddress('localhost:5173')).toBe('http://localhost:5173/');
    expect(localAddress('0.0.0.0:3000/cart')).toBe('http://localhost:3000/cart');
    expect(localAddress('https://example.com')).toBeNull();
    expect(localAddress('http://localhost.evil.com')).toBeNull();
  });

  it('shows the page in a sandboxed frame and offers running dev servers', () => {
    vi.spyOn(api, 'previewStatus').mockResolvedValue({ screenshots: null });
    const onNavigate = vi.fn();
    const { rerender } = render(
      <PreviewPane url={null} processes={[devServer]} onNavigate={onNavigate} onClose={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /dev server · localhost:5173/ }));
    expect(onNavigate).toHaveBeenCalledWith('http://localhost:5173/');

    const input = screen.getByLabelText('Preview address');
    fireEvent.change(input, { target: { value: 'https://example.com' } });
    fireEvent.submit(input.closest('form')!);
    expect(screen.getByRole('alert').textContent).toMatch(/Only pages on this machine/);

    rerender(
      <PreviewPane
        url="http://localhost:5173/"
        processes={[devServer]}
        onNavigate={onNavigate}
        onClose={vi.fn()}
      />,
    );
    const frame = screen.getByTitle('Preview of http://localhost:5173/');
    expect(frame.getAttribute('sandbox')).toBe(
      'allow-scripts allow-same-origin allow-forms allow-popups allow-modals',
    );
    expect(frame.getAttribute('sandbox')).not.toContain('allow-top-navigation');
    fireEvent.click(screen.getByRole('button', { name: 'Phone (390px)' }));
    expect((frame as HTMLIFrameElement).style.width).toBe('390px');
  });

  it('sends a screenshot of the previewed page to the message being written', async () => {
    vi.spyOn(api, 'previewStatus').mockResolvedValue({ screenshots: 'desktop' });
    const capture = vi
      .spyOn(api, 'previewScreenshot')
      .mockResolvedValue({ attachment: shot, title: 'Shop', finalUrl: 'x', problems: [] });
    const received: AttachmentDto[] = [];
    const listener = (e: Event) => received.push((e as CustomEvent<AttachmentDto>).detail);
    window.addEventListener(ATTACH_IMAGE_EVENT, listener);
    render(
      <PreviewPane
        url="http://localhost:5173/"
        processes={[]}
        onNavigate={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Add a screenshot to your message' }),
    );
    await waitFor(() => expect(received).toEqual([shot]));
    expect(capture).toHaveBeenCalledWith({ url: 'http://localhost:5173/', width: 1280 });
    expect(screen.getByRole('status').textContent).toMatch(/added to your message/);
    window.removeEventListener(ATTACH_IMAGE_EVENT, listener);
  });

  it('shows screenshots in the conversation without expanding the tool row', () => {
    render(
      <ToolActivity
        items={[
          {
            key: 'c1',
            name: 'screenshot',
            arguments: '{"url":"localhost:5173"}',
            status: 'completed',
            summary: '1280×800',
            durationMs: 900,
            attachments: [shot],
          },
        ]}
      />,
    );
    expect(screen.getByRole('img', { name: 'screenshot.png' }).getAttribute('src')).toBe(
      `/api/attachments/${shot.id}`,
    );
  });

  it('opens image files in the file viewer as images', async () => {
    vi.spyOn(api, 'projectTree').mockResolvedValue({
      path: '.',
      entries: [{ path: 'docs/mockup.png', name: 'mockup.png', type: 'file', size: 2048 }],
    } as never);
    const file = vi.spyOn(api, 'projectFile');
    render(
      <SidePanel
        project={{ id: 'p1', name: 'shop', rootPath: '/x', available: true } as never}
        plan={null}
        changes={[]}
        onRevert={vi.fn()}
      />,
    );
    await act(async () => undefined);
    fireEvent.click(await screen.findByRole('button', { name: /mockup\.png/ }));
    const img = await screen.findByRole('img', { name: 'docs/mockup.png' });
    expect(img.getAttribute('src')).toBe('/api/projects/p1/raw?path=docs%2Fmockup.png');
    expect(file).not.toHaveBeenCalled();
  });
});
