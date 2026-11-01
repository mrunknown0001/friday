import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Button } from './button';

export interface ConfirmOptions {
  title: string;
  message: ReactNode;
  /** The confirm button's label, naming the action ("Delete", "Remove"). */
  confirmLabel: string;
  /** A destructive action: the confirm button is red. */
  danger?: boolean;
}

/**
 * Asks the user to confirm in Friday's own modal instead of window.confirm. Returns `confirm`,
 * which resolves true or false, and the modal element, which the component must render.
 */
export function useConfirm(): [(o: ConfirmOptions) => Promise<boolean>, ReactNode] {
  const [pending, setPending] = useState<{
    options: ConfirmOptions;
    resolve: (ok: boolean) => void;
  } | null>(null);
  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => setPending({ options, resolve })),
    [],
  );
  const settle = (ok: boolean) => {
    pending?.resolve(ok);
    setPending(null);
  };
  return [confirm, pending ? <ConfirmDialog options={pending.options} onSettle={settle} /> : null];
}

function ConfirmDialog({
  options,
  onSettle,
}: {
  options: ConfirmOptions;
  onSettle: (ok: boolean) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const messageId = useId();

  useEffect(() => {
    const el = ref.current;
    // Opening focuses the first button, Cancel, so Enter never confirms by accident.
    if (el && !el.open) el.showModal();
  }, []);

  return (
    <dialog
      ref={ref}
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={messageId}
      // Esc
      onCancel={(e) => {
        e.preventDefault();
        onSettle(false);
      }}
      // A click on the backdrop lands on the dialog element itself.
      onClick={(e) => {
        if (e.target === e.currentTarget) onSettle(false);
      }}
      className="m-auto w-[min(440px,calc(100vw-2rem))] rounded-xl border border-zinc-800 bg-zinc-900 p-0 text-zinc-100 shadow-2xl backdrop:bg-black/60"
    >
      <div className="p-5">
        <h2 id={titleId} className="text-base font-semibold">
          {options.title}
        </h2>
        <div id={messageId} className="mt-2 text-sm text-zinc-300">
          {options.message}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => onSettle(false)}>
            Cancel
          </Button>
          <Button variant={options.danger ? 'danger' : 'primary'} onClick={() => onSettle(true)}>
            {options.confirmLabel}
          </Button>
        </div>
      </div>
    </dialog>
  );
}
