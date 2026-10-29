import { X } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { Button } from './button';

/** Modal built on the native <dialog> element, which provides focus trapping and Esc handling. */
export function Dialog({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-labelledby="dialog-title"
      className="m-auto w-[min(760px,calc(100vw-2rem))] max-h-[calc(100vh-4rem)] rounded-xl border border-zinc-800 bg-zinc-900 p-0 text-zinc-100 shadow-2xl backdrop:bg-black/60"
    >
      {open && (
        <div className="flex max-h-[calc(100vh-4rem)] flex-col">
          <header className="flex items-center justify-between border-b border-zinc-800 px-5 py-3">
            <h2 id="dialog-title" className="text-base font-semibold">
              {title}
            </h2>
            <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
              <X className="h-4 w-4" />
            </Button>
          </header>
          <div className="overflow-y-auto px-5 py-4">{children}</div>
        </div>
      )}
    </dialog>
  );
}
