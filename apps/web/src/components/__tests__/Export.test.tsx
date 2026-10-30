import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../../lib/api';
import { ExportDialog } from '../ExportDialog';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// jsdom has no <dialog> modal support or object URLs.
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
  this.open = true;
};
HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
  this.open = false;
};

describe('export dialog', () => {
  it('exports the chosen format and detail, then closes', async () => {
    vi.spyOn(api, 'previewStatus').mockResolvedValue({ screenshots: 'chrome', openFiles: false });
    const exp = vi
      .spyOn(api, 'exportConversation')
      .mockResolvedValue({ blob: new Blob(['%PDF']), name: 'Fix-2026-10-30.pdf' });
    const createUrl = vi.fn(() => 'blob:x');
    Object.assign(URL, { createObjectURL: createUrl, revokeObjectURL: vi.fn() });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    const onClose = vi.fn();
    render(<ExportDialog sessionId="s1" onClose={onClose} />);

    const pdf = screen.getByRole('radio', { name: /PDF/ }) as HTMLInputElement;
    await waitFor(() => expect(pdf.disabled).toBe(false));
    fireEvent.click(pdf);
    fireEvent.click(screen.getByRole('radio', { name: /Full/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(exp).toHaveBeenCalledWith('s1', {
      format: 'pdf',
      detail: 'full',
      tzOffsetMinutes: -new Date().getTimezoneOffset(),
    });
    expect(createUrl).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
  });

  it('offers only Markdown without a browser engine, and shows errors', async () => {
    vi.spyOn(api, 'previewStatus').mockResolvedValue({ screenshots: null, openFiles: false });
    vi.spyOn(api, 'exportConversation').mockRejectedValue(
      new ApiError(404, 'session_not_found', 'Conversation not found.'),
    );
    const onClose = vi.fn();
    render(<ExportDialog sessionId="s1" onClose={onClose} />);
    const pdf = screen.getByRole('radio', { name: /PDF/ }) as HTMLInputElement;
    await waitFor(() => expect(pdf.disabled).toBe(true));
    expect(screen.getByText(/Needs a browser engine/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Conversation not found.');
    expect(onClose).not.toHaveBeenCalled();
  });
});
