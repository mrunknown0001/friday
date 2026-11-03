import type { QuestionAnswer, QuestionItem } from '@friday/shared';
import { Loader2 } from 'lucide-react';
import { useId, useState } from 'react';
import { cn } from '../lib/cn';
import { Button } from './ui/button';

/** Answering is possible with a chosen option, the user's own words, or both. */
export function isAnswered(a: QuestionAnswer): boolean {
  return a.selected.length > 0 || !!a.text?.trim();
}

/** One line per answer, for the enhancer and for showing what was answered. */
export function answerText(a: QuestionAnswer): string {
  return [...a.selected, ...(a.text?.trim() ? [a.text.trim()] : [])].join('; ');
}

/**
 * Clarifying questions with choices. Each question also takes the user's own words; the user can
 * skip them all and leave the choice to Friday.
 */
export function QuestionForm({
  questions,
  busy = false,
  submitLabel,
  skipLabel,
  onSubmit,
  onSkip,
}: {
  questions: QuestionItem[];
  busy?: boolean;
  submitLabel: string;
  skipLabel: string;
  onSubmit: (answers: QuestionAnswer[]) => void;
  onSkip: () => void;
}) {
  const id = useId();
  const [answers, setAnswers] = useState<QuestionAnswer[]>(() =>
    questions.map(() => ({ selected: [], text: null })),
  );
  const update = (i: number, patch: Partial<QuestionAnswer>) =>
    setAnswers((list) => list.map((a, j) => (j === i ? { ...a, ...patch } : a)));
  const complete = answers.every(isAnswered);

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (complete && !busy) onSubmit(answers);
      }}
    >
      {questions.map((q, i) => {
        const a = answers[i]!;
        const toggle = (label: string) =>
          update(i, {
            selected: q.multiSelect
              ? a.selected.includes(label)
                ? a.selected.filter((s) => s !== label)
                : [...a.selected, label]
              : a.selected.includes(label)
                ? []
                : [label],
          });
        return (
          <fieldset key={i} className="space-y-1.5" disabled={busy}>
            <legend className="text-sm text-zinc-100">
              {q.header && (
                <span className="mr-2 rounded bg-zinc-800 px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-zinc-400">
                  {q.header}
                </span>
              )}
              {q.question}
              {q.multiSelect && <span className="ml-1 text-xs text-zinc-500">(choose any)</span>}
            </legend>
            <div className="flex flex-wrap gap-1.5 pt-1">
              {q.options.map((o) => {
                const on = a.selected.includes(o.label);
                return (
                  <label
                    key={o.label}
                    title={o.description ?? undefined}
                    className={cn(
                      'flex cursor-pointer items-start gap-2 rounded-md border px-2.5 py-1.5 text-xs transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-sky-600',
                      on
                        ? 'border-sky-600 bg-sky-950/60 text-sky-100'
                        : 'border-zinc-700 bg-zinc-900 text-zinc-200 hover:border-zinc-500',
                    )}
                  >
                    <input
                      type={q.multiSelect ? 'checkbox' : 'radio'}
                      name={`${id}-${i}`}
                      className="sr-only"
                      checked={on}
                      // A radio can't be unchecked by clicking it; the click toggles instead.
                      onChange={() => undefined}
                      onClick={() => toggle(o.label)}
                    />
                    <span>
                      <span className="font-medium">{o.label}</span>
                      {o.description && (
                        <span className="block text-[11px] text-zinc-400">{o.description}</span>
                      )}
                    </span>
                  </label>
                );
              })}
            </div>
            <input
              type="text"
              aria-label={`Your own answer: ${q.question}`}
              placeholder={
                a.selected.length ? 'Add details (optional)' : 'Or answer in your own words'
              }
              value={a.text ?? ''}
              maxLength={2000}
              onChange={(e) => update(i, { text: e.target.value || null })}
              className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-zinc-600"
            />
          </fieldset>
        );
      })}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onSkip} disabled={busy}>
          {skipLabel}
        </Button>
        <Button type="submit" variant="primary" size="sm" disabled={!complete || busy}>
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
