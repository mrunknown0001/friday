import type { AttachmentDto, ProcessDto } from '@friday/shared';
import {
  Camera,
  ExternalLink,
  Loader2,
  Monitor,
  RotateCw,
  Smartphone,
  Tablet,
  X,
} from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { cn } from '../lib/cn';
import { Button } from './ui/button';

/** Fired with a screenshot attachment the composer should add to the next message. */
export const ATTACH_IMAGE_EVENT = 'friday:attach-image';

const LOCAL = /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d{1,5})?(\/.*)?$/i;

/** A local address, normalised (0.0.0.0 means this machine), or null if it is not local. */
export function localAddress(input: string): string | null {
  const t = input.trim();
  if (!LOCAL.test(t)) return null;
  const u = new URL(/^https?:\/\//i.test(t) ? t : `http://${t}`);
  if (u.hostname === '0.0.0.0') u.hostname = 'localhost';
  return u.toString();
}

const WIDTHS = [
  { key: 'full', label: 'Full width', icon: Monitor, px: null },
  { key: 'tablet', label: 'Tablet (768px)', icon: Tablet, px: 768 },
  { key: 'mobile', label: 'Phone (390px)', icon: Smartphone, px: 390 },
] as const;

/**
 * A live view of a dev server running on this machine, next to the conversation. The page runs
 * in a sandboxed frame from its own origin: it cannot reach Friday's UI, and in the desktop app
 * its requests never carry Friday's launch token.
 */
export function PreviewPane({
  url,
  processes,
  onNavigate,
  onClose,
}: {
  url: string | null;
  processes: ProcessDto[];
  onNavigate: (url: string) => void;
  onClose: () => void;
}) {
  const [input, setInput] = useState(url ?? '');
  const [inputError, setInputError] = useState<string | null>(null);
  const [width, setWidth] = useState<(typeof WIDTHS)[number]['key']>('full');
  const [reloads, setReloads] = useState(0);
  const [engine, setEngine] = useState<string | null>(null);
  const [shooting, setShooting] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .previewStatus()
      .then((s) => !cancelled && setEngine(s.screenshots))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const targets = processes
    .filter((p) => p.status === 'running')
    .flatMap((p) =>
      p.urls.map((u) => ({ url: u, label: `${p.name} · ${u.replace(/^https?:\/\//, '')}` })),
    );

  const go = (e: FormEvent) => {
    e.preventDefault();
    const next = localAddress(input);
    if (!next) {
      setInputError('Only pages on this machine (localhost or 127.0.0.1) can be previewed.');
      return;
    }
    setInputError(null);
    setInput(next);
    onNavigate(next);
  };

  const screenshot = async () => {
    if (!url) return;
    setShooting(true);
    setNote(null);
    try {
      const preset = WIDTHS.find((w) => w.key === width)!;
      const r = await api.previewScreenshot({ url, width: preset.px ?? 1280 });
      window.dispatchEvent(
        new CustomEvent<AttachmentDto>(ATTACH_IMAGE_EVENT, { detail: r.attachment }),
      );
      setNote(
        `Screenshot added to your message${r.problems.length ? ` (${r.problems.length} page problem${r.problems.length > 1 ? 's' : ''} seen)` : ''}.`,
      );
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setShooting(false);
    }
  };

  const frameWidth = WIDTHS.find((w) => w.key === width)!.px;
  return (
    <aside
      aria-label="Live preview"
      // Shares the width with the conversation (both grow equally; neither gets squeezed away).
      className="flex min-w-[340px] flex-[1_1_0] flex-col border-l border-zinc-800 bg-zinc-950"
    >
      <div className="flex shrink-0 items-center gap-1 border-b border-zinc-800 px-2 py-1.5">
        <form onSubmit={go} className="flex min-w-0 flex-1 items-center gap-1">
          <label htmlFor="preview-url" className="sr-only">
            Preview address
          </label>
          <input
            id="preview-url"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="localhost:5173"
            spellCheck={false}
            list="preview-targets"
            className="h-7 min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-2 font-mono text-xs outline-none focus:border-sky-500"
          />
          <datalist id="preview-targets">
            {targets.map((t) => (
              <option key={t.url} value={t.url}>
                {t.label}
              </option>
            ))}
          </datalist>
        </form>
        {WIDTHS.map((w) => (
          <Button
            key={w.key}
            variant="ghost"
            size="icon"
            onClick={() => setWidth(w.key)}
            aria-pressed={width === w.key}
            aria-label={w.label}
            title={w.label}
            className={cn('h-7 w-7', width === w.key && 'bg-zinc-800 text-zinc-100')}
          >
            <w.icon className="h-3.5 w-3.5" />
          </Button>
        ))}
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => setReloads((n) => n + 1)}
          disabled={!url}
          aria-label="Reload preview"
          title="Reload"
        >
          <RotateCw className="h-3.5 w-3.5" />
        </Button>
        {engine && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => void screenshot()}
            disabled={!url || shooting}
            aria-label="Add a screenshot to your message"
            title="Screenshot to message"
          >
            {shooting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Camera className="h-3.5 w-3.5" />
            )}
          </Button>
        )}
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            aria-label="Open in browser"
            title="Open in browser"
            className="grid h-7 w-7 place-items-center rounded-md text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={onClose}
          aria-label="Close preview"
          title="Close preview"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      {inputError && (
        <p role="alert" className="px-3 py-1 text-xs text-red-400">
          {inputError}
        </p>
      )}
      {note && (
        <p role="status" className="px-3 py-1 text-xs text-zinc-300">
          {note}
        </p>
      )}
      {url ? (
        <div className="flex min-h-0 flex-1 justify-center overflow-auto bg-zinc-900/40">
          <iframe
            key={`${url}#${reloads}`}
            src={url}
            title={`Preview of ${url}`}
            // Its own origin, so it cannot reach Friday; no top-level navigation of the app.
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
            referrerPolicy="no-referrer"
            className="h-full border-0 bg-white"
            style={{ width: frameWidth ? `${frameWidth}px` : '100%' }}
          />
        </div>
      ) : (
        <div className="grid flex-1 place-items-center p-6 text-center text-sm text-zinc-400">
          <div className="max-w-xs space-y-2">
            <p>See your app here while Friday works on it.</p>
            <p className="text-xs">
              {targets.length
                ? 'Pick a running dev server from the address box.'
                : 'Ask Friday to start the dev server, or type a local address such as localhost:5173.'}
            </p>
            {targets.map((t) => (
              <Button key={t.url} size="sm" onClick={() => onNavigate(t.url)}>
                {t.label}
              </Button>
            ))}
          </div>
        </div>
      )}
      <p className="shrink-0 border-t border-zinc-800 px-3 py-1 text-[11px] text-zinc-500">
        Only pages on this machine. If a page stays blank, it refuses to be shown inside another
        page: open it in the browser instead.
      </p>
    </aside>
  );
}
