import type { NextStep } from '@friday/shared';
import { Brain, ClipboardCheck, Sparkles } from 'lucide-react';
import { cn } from '../lib/cn';

/**
 * One-click follow-ups after a run. "records" chips come from what actually happened (failing
 * checks, unverified changes, uncommitted work, plan steps); "model" chips are the model's ideas.
 * Clicking sends the prompt as a normal message, so every resulting action still needs approval.
 */
export function SuggestionChips({
  steps,
  disabled,
  onPrompt,
  onOpenMemory,
}: {
  steps: NextStep[];
  disabled: boolean;
  onPrompt: (prompt: string) => void;
  onOpenMemory: () => void;
}) {
  if (steps.length === 0) return null;
  return (
    <div className="ml-10 flex flex-wrap gap-2" role="group" aria-label="Suggested next steps">
      {steps.map((s) => (
        <button
          key={`${s.source}-${s.label}`}
          type="button"
          disabled={disabled}
          title={s.action === 'prompt' ? s.prompt : 'Open the memory manager'}
          onClick={() => (s.action === 'open_memory' ? onOpenMemory() : onPrompt(s.prompt))}
          className={cn(
            'flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50',
            s.source === 'records'
              ? 'border-sky-800 bg-sky-950/40 text-sky-200 hover:bg-sky-900/60'
              : 'border-zinc-700 bg-zinc-900 text-zinc-200 hover:bg-zinc-800',
          )}
        >
          {s.action === 'open_memory' ? (
            <Brain className="h-3.5 w-3.5" aria-hidden />
          ) : s.source === 'records' ? (
            <ClipboardCheck className="h-3.5 w-3.5" aria-label="from Friday's records" />
          ) : (
            <Sparkles className="h-3.5 w-3.5" aria-label="suggested by the model" />
          )}
          {s.label}
        </button>
      ))}
    </div>
  );
}
