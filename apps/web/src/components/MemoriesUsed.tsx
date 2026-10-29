import type { MemoryRef } from '@friday/shared';
import { Brain, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { cn } from '../lib/cn';

const REASON: Record<MemoryRef['reason'], string> = {
  pinned: 'pinned',
  preference: 'your preference',
  session: 'this conversation',
  relevant: 'relevant to your request',
};

/** Discloses exactly which saved memories were shown to the model for a run. */
export function MemoriesUsed({ refs }: { refs: MemoryRef[] }) {
  const [open, setOpen] = useState(false);
  if (refs.length === 0) return null;
  return (
    <div className="ml-10 text-xs">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded px-1.5 py-0.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
      >
        <ChevronRight
          className={cn('h-3 w-3 transition-transform', open && 'rotate-90')}
          aria-hidden
        />
        <Brain className="h-3.5 w-3.5 text-violet-400" aria-hidden />
        Used {refs.length} saved {refs.length === 1 ? 'memory' : 'memories'}
      </button>
      {open && (
        <ul
          aria-label="Memories used"
          className="mt-1 space-y-1 rounded-md border border-zinc-800 bg-zinc-900/40 p-2"
        >
          {refs.map((r) => (
            <li key={r.id} className="text-zinc-300">
              <span className="mr-1 font-mono text-[10px] text-zinc-500">
                {r.scope}/{r.category} · {REASON[r.reason]}
              </span>
              <span className="block">{r.content}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
