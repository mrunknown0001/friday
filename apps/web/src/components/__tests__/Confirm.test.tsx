import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useConfirm } from '../ui/confirm';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Harness({ onResult }: { onResult: (ok: boolean) => void }) {
  const [confirm, confirmDialog] = useConfirm();
  return (
    <div>
      <button
        type="button"
        onClick={async () =>
          onResult(
            await confirm({
              title: 'Delete “notes”?',
              message: 'This cannot be undone.',
              confirmLabel: 'Delete',
              danger: true,
            }),
          )
        }
      >
        Delete notes
      </button>
      {confirmDialog}
    </div>
  );
}

describe('confirm modal', () => {
  it('asks in a modal and resolves with the choice, never using window.confirm', async () => {
    const native = vi.spyOn(window, 'confirm');
    const results: boolean[] = [];
    render(<Harness onResult={(ok) => results.push(ok)} />);
    expect(screen.queryByRole('alertdialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Delete notes' }));
    const ask = screen.getByRole('alertdialog', { name: 'Delete “notes”?' });
    expect(ask.getAttribute('aria-describedby')).toBeTruthy();
    expect(within(ask).getByText('This cannot be undone.')).toBeTruthy();
    // Cancel comes first, so the dialog's initial focus is the safe choice.
    expect(
      within(ask)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Cancel', 'Delete']);
    await act(async () => fireEvent.click(within(ask).getByRole('button', { name: 'Delete' })));
    expect(results).toEqual([true]);
    expect(screen.queryByRole('alertdialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Delete notes' }));
    await act(async () =>
      fireEvent.click(
        within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }),
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete notes' }));
    // Esc fires the dialog's cancel event.
    await act(async () => fireEvent(screen.getByRole('alertdialog'), new Event('cancel')));
    expect(results).toEqual([true, false, false]);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(native).not.toHaveBeenCalled();
  });
});
