import { cn } from '../lib/cn';

interface DiffLine {
  kind: 'add' | 'del' | 'ctx' | 'hunk' | 'meta';
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

/** Parse a unified diff into display lines with old/new line numbers. File headers are dropped. */
export function parseUnifiedDiff(diff: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('---') || line.startsWith('+++')) continue;
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      out.push({ kind: 'hunk', text: line, oldNo: null, newNo: null });
    } else if (line.startsWith('+')) {
      out.push({ kind: 'add', text: line.slice(1), oldNo: null, newNo: newNo++ });
    } else if (line.startsWith('-')) {
      out.push({ kind: 'del', text: line.slice(1), oldNo: oldNo++, newNo: null });
    } else if (line.startsWith(' ')) {
      out.push({ kind: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
    } else if (line.startsWith('\\') || line.startsWith('[diff truncated')) {
      out.push({ kind: 'meta', text: line, oldNo: null, newNo: null });
    }
  }
  return out;
}

const ROW: Record<DiffLine['kind'], string> = {
  add: 'bg-emerald-950/50 text-emerald-200',
  del: 'bg-red-950/50 text-red-200',
  ctx: 'text-zinc-300',
  hunk: 'bg-sky-950/40 text-sky-300',
  meta: 'text-zinc-500 italic',
};

const SIGN: Record<DiffLine['kind'], string> = { add: '+', del: '-', ctx: ' ', hunk: '', meta: '' };

export function DiffView({ diff, maxHeight = 'max-h-96' }: { diff: string; maxHeight?: string }) {
  const lines = parseUnifiedDiff(diff);
  if (lines.length === 0) {
    return <p className="px-3 py-2 text-xs text-zinc-500">No textual changes to show.</p>;
  }
  return (
    <div className={cn('overflow-auto rounded-md border border-zinc-800 bg-zinc-950', maxHeight)}>
      <table
        className="w-full border-collapse font-mono text-[0.75rem] leading-snug"
        aria-label="Diff"
      >
        <tbody>
          {lines.map((l, i) => (
            <tr key={i} className={ROW[l.kind]} data-kind={l.kind}>
              <td className="w-10 select-none border-r border-zinc-800/80 px-1.5 text-right text-zinc-500">
                {l.oldNo ?? ''}
              </td>
              <td className="w-10 select-none border-r border-zinc-800/80 px-1.5 text-right text-zinc-500">
                {l.newNo ?? ''}
              </td>
              <td className="whitespace-pre px-2">
                <span className="select-none opacity-60">{SIGN[l.kind]}</span>
                {l.text}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
