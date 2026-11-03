import type { QuestionDto, QuestionReply } from '@friday/shared';
import { MessageCircleQuestion } from 'lucide-react';
import { useState } from 'react';
import { answerText, QuestionForm } from './QuestionForm';
import { Badge, type Tone } from './ui/badge';

const STATUS: Record<QuestionDto['status'], { label: string; tone: Tone }> = {
  pending: { label: 'waiting for you', tone: 'warning' },
  answered: { label: 'answered', tone: 'success' },
  skipped: { label: 'Friday decided', tone: 'neutral' },
  expired: { label: 'not answered', tone: 'neutral' },
  cancelled: { label: 'cancelled', tone: 'neutral' },
};

/**
 * Questions Friday asked during a run (ask_user). While the run waits it takes the answer;
 * afterwards it shows what was asked and answered.
 */
export function QuestionCard({
  question: q,
  onAnswer,
}: {
  question: QuestionDto;
  /** Present while the run waits for this answer. */
  onAnswer?: ((reply: QuestionReply) => Promise<void>) | undefined;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const s = STATUS[q.status];
  const waiting = q.status === 'pending' && !!onAnswer;

  const send = (reply: QuestionReply) => {
    setBusy(true);
    setError(null);
    void onAnswer!(reply)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  return (
    <section
      aria-label={waiting ? 'Friday has a question' : 'Friday asked'}
      className={
        waiting
          ? 'ml-10 rounded-lg border border-amber-800/70 bg-zinc-900 p-3 text-sm'
          : 'ml-10 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 text-sm'
      }
    >
      <header className="mb-2 flex items-center gap-2">
        <MessageCircleQuestion className="h-4 w-4 text-amber-400" aria-hidden />
        <h2 className="flex-1 font-medium text-zinc-200">
          {waiting ? 'Friday has a question' : 'Friday asked'}
        </h2>
        <Badge tone={s.tone}>{s.label}</Badge>
      </header>
      {waiting ? (
        <QuestionForm
          questions={q.questions}
          busy={busy}
          submitLabel="Answer"
          skipLabel="Let Friday decide"
          onSubmit={(answers) => send({ answers })}
          onSkip={() => send({ skip: true })}
        />
      ) : (
        <dl className="space-y-1.5 text-xs">
          {q.questions.map((item, i) => (
            <div key={i}>
              <dt className="text-zinc-400">{item.question}</dt>
              <dd className="text-zinc-100">
                {q.answers?.[i] ? (
                  answerText(q.answers[i])
                ) : (
                  <span className="text-zinc-500">—</span>
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-red-300">
          {error}
        </p>
      )}
    </section>
  );
}
