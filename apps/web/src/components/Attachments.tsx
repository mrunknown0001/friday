import type { AttachmentDto } from '@friday/shared';
import { AlertCircle, Loader2, X } from 'lucide-react';
import { useState } from 'react';
import { cn } from '../lib/cn';
import { formatBytes } from '../lib/format';
import { Dialog } from './ui/dialog';

export const attachmentUrl = (id: string) => `/api/attachments/${id}`;

function label(a: AttachmentDto): string {
  return a.name ?? `Image ${a.width}×${a.height}`;
}

/** Thumbnails of a message's images; each opens a full-size view. */
export function AttachmentThumbs({
  attachments,
  className,
}: {
  attachments: AttachmentDto[];
  className?: string;
}) {
  const [open, setOpen] = useState<AttachmentDto | null>(null);
  if (!attachments.length) return null;
  return (
    <>
      <ul className={cn('flex flex-wrap gap-2', className)} aria-label="Attached images">
        {attachments.map((a) => (
          <li key={a.id}>
            <button
              type="button"
              onClick={() => setOpen(a)}
              aria-label={`View ${label(a)}`}
              className="block overflow-hidden rounded-md border border-zinc-700 bg-zinc-950 hover:border-sky-500"
            >
              <img
                src={attachmentUrl(a.id)}
                alt={label(a)}
                loading="lazy"
                className="h-24 max-w-48 object-contain"
              />
            </button>
          </li>
        ))}
      </ul>
      {open && <ImageViewer attachment={open} onClose={() => setOpen(null)} />}
    </>
  );
}

export function ImageViewer({
  attachment: a,
  onClose,
}: {
  attachment: AttachmentDto;
  onClose: () => void;
}) {
  return (
    <Dialog open onClose={onClose} title={label(a)}>
      <img
        src={attachmentUrl(a.id)}
        alt={label(a)}
        className="mx-auto max-h-[70vh] w-auto rounded border border-zinc-800 object-contain"
      />
      <p className="mt-2 text-xs text-zinc-500">
        {a.width}×{a.height} px · {a.mime.slice(6).toUpperCase()} · {formatBytes(a.size)}
      </p>
    </Dialog>
  );
}

/** An image in the composer: uploading, ready (with its thumbnail), or failed. */
export interface DraftImage {
  key: string;
  name: string;
  status: 'uploading' | 'ready' | 'error';
  attachment?: AttachmentDto;
  error?: string;
}

export function DraftImages({
  images,
  onRemove,
}: {
  images: DraftImage[];
  onRemove: (d: DraftImage) => void;
}) {
  if (!images.length) return null;
  return (
    <ul className="flex flex-wrap gap-2 px-1 pb-2" aria-label="Images to send">
      {images.map((d) => (
        <li
          key={d.key}
          className={cn(
            'relative grid h-16 w-16 place-items-center overflow-hidden rounded-md border bg-zinc-950',
            d.status === 'error' ? 'border-red-700' : 'border-zinc-700',
          )}
          title={d.error ?? d.name}
        >
          {d.status === 'ready' && d.attachment ? (
            <img
              src={attachmentUrl(d.attachment.id)}
              alt={d.name}
              className="h-full w-full object-cover"
            />
          ) : d.status === 'uploading' ? (
            <Loader2
              className="h-4 w-4 animate-spin text-zinc-400"
              aria-label={`Uploading ${d.name}`}
            />
          ) : (
            <AlertCircle className="h-4 w-4 text-red-400" aria-label={`${d.name}: ${d.error}`} />
          )}
          <button
            type="button"
            onClick={() => onRemove(d)}
            aria-label={`Remove ${d.name}`}
            className="absolute right-0.5 top-0.5 rounded-full bg-black/70 p-0.5 text-zinc-200 hover:bg-black"
          >
            <X className="h-3 w-3" />
          </button>
        </li>
      ))}
    </ul>
  );
}
