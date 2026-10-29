import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

const tones: Record<Tone, string> = {
  neutral: 'bg-zinc-800 text-zinc-300 ring-zinc-700',
  info: 'bg-sky-950 text-sky-300 ring-sky-800',
  success: 'bg-emerald-950 text-emerald-300 ring-emerald-800',
  warning: 'bg-amber-950 text-amber-300 ring-amber-800',
  danger: 'bg-red-950 text-red-300 ring-red-800',
};

export function Badge({
  tone = 'neutral',
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset',
        tones[tone],
        className,
      )}
      {...props}
    />
  );
}
