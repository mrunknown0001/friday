import { Download, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { cn } from '../lib/cn';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';

type Format = 'md' | 'pdf';
type Detail = 'summary' | 'full';

/** Hand a downloaded file to the browser (the desktop app asks where to save it). */
function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function Choice<T extends string>({
  name,
  value,
  current,
  onChange,
  label,
  hint,
  disabled,
}: {
  name: string;
  value: T;
  current: T;
  onChange: (v: T) => void;
  label: string;
  hint: string;
  disabled?: boolean;
}) {
  return (
    <label
      className={cn(
        'flex cursor-pointer gap-2 rounded-md border px-3 py-2',
        current === value ? 'border-sky-600 bg-sky-950/30' : 'border-zinc-800',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={current === value}
        disabled={disabled}
        onChange={() => onChange(value)}
        className="mt-1 accent-sky-500"
      />
      <span>
        <span className="block text-sm text-zinc-100">{label}</span>
        <span className="block text-xs text-zinc-400">{hint}</span>
      </span>
    </label>
  );
}

/** Export the conversation as Markdown or PDF. */
export function ExportDialog({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const [format, setFormat] = useState<Format>('md');
  const [detail, setDetail] = useState<Detail>('summary');
  const [pdf, setPdf] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .previewStatus()
      .then((s) => !cancelled && setPdf(s.screenshots !== null))
      .catch(() => !cancelled && setPdf(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const { blob, name } = await api.exportConversation(sessionId, {
        format,
        detail,
        tzOffsetMinutes: -new Date().getTimezoneOffset(),
      });
      save(blob, name);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title="Export conversation">
      <div className="space-y-4">
        <fieldset className="space-y-2">
          <legend className="mb-1 text-xs font-medium text-zinc-400">Format</legend>
          <Choice
            name="format"
            value="md"
            current={format}
            onChange={setFormat}
            label="Markdown (.md)"
            hint="Plain text that reads well anywhere, and renders on GitHub."
          />
          <Choice
            name="format"
            value="pdf"
            current={format}
            onChange={setFormat}
            disabled={pdf === false}
            label="PDF"
            hint={
              pdf === false
                ? 'Needs a browser engine: use the desktop app, or set FRIDAY_CHROME.'
                : 'In the same clean style as the documents Friday writes.'
            }
          />
        </fieldset>
        <fieldset className="space-y-2">
          <legend className="mb-1 text-xs font-medium text-zinc-400">Detail</legend>
          <Choice
            name="detail"
            value="summary"
            current={detail}
            onChange={setDetail}
            label="Summary"
            hint="Messages, one line per tool call and approval, and each run's report."
          />
          <Choice
            name="detail"
            value="full"
            current={detail}
            onChange={setDetail}
            label="Full"
            hint="Also tool results, diffs and exact commands. Can be long."
          />
        </fieldset>
        <p className="text-xs text-zinc-500">
          Secrets Friday recognizes are redacted, as everywhere else. Images are listed by name, not
          included.
        </p>
        {error && (
          <p role="alert" className="text-xs text-red-400">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void run()} disabled={busy}>
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Download className="h-4 w-4" aria-hidden />
            )}
            Export
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
