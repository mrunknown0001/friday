import { randomUUID } from 'node:crypto';
import type { QuestionAnswer, QuestionDto, QuestionItem } from '@friday/shared';
import { HttpError } from '../http/errors.js';
import type { QuestionRepo } from '../repositories/questions.js';
import type { AuditRepo } from '../repositories/telemetry.js';

export const MAX_ANSWER_CHARS = 2_000;

export type QuestionOutcome =
  | { outcome: 'answered' | 'skipped'; question: QuestionDto }
  | { outcome: 'expired' | 'cancelled'; question: QuestionDto | null };

export interface AnswerInput {
  sessionId: string;
  answers?: QuestionAnswer[] | undefined;
  skip?: boolean | undefined;
}

/**
 * Clarifying questions from a run to the user. The run waits in its ask_user call; answers only
 * arrive through the HTTP API (a user action).
 */
export class QuestionService {
  private readonly waiters = new Map<string, (o: QuestionOutcome) => void>();

  constructor(
    private readonly repo: QuestionRepo,
    private readonly audit: AuditRepo,
    readonly ttlMs: number,
  ) {}

  ask(meta: { sessionId: string; runId: string; toolCallId: string }, questions: QuestionItem[]) {
    const question = this.repo.create({
      ...meta,
      id: randomUUID(),
      questions,
      expiresAt: new Date(Date.now() + this.ttlMs).toISOString(),
    });
    this.audit.record({
      sessionId: meta.sessionId,
      actor: 'agent',
      action: 'question_asked',
      details: { questionId: question.id, count: questions.length },
    });
    return question;
  }

  /** Resolves when the user answers or skips, the question expires, or the run is cancelled. */
  wait(question: QuestionDto, signal: AbortSignal): Promise<QuestionOutcome> {
    return new Promise((resolve) => {
      const finish = (o: QuestionOutcome) => {
        if (!this.waiters.has(question.id)) return;
        this.waiters.delete(question.id);
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve(o);
      };
      const onAbort = () =>
        finish({ outcome: 'cancelled', question: this.repo.settle(question.id, 'cancelled') });
      const timer = setTimeout(
        () => finish({ outcome: 'expired', question: this.repo.settle(question.id, 'expired') }),
        Math.max(0, Date.parse(question.expiresAt) - Date.now()),
      );
      this.waiters.set(question.id, finish);
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  answer(id: string, input: AnswerInput): QuestionDto {
    const question = this.repo.get(id);
    if (!question) throw new HttpError(404, 'question_not_found', 'Question not found.');
    if (question.sessionId !== input.sessionId)
      throw new HttpError(
        403,
        'wrong_session',
        'This question belongs to a different conversation.',
      );
    if (question.status !== 'pending')
      throw new HttpError(
        409,
        'question_not_pending',
        `This question is already ${question.status}.`,
      );
    const waiter = this.waiters.get(id);
    if (!waiter) {
      this.repo.settle(id, 'cancelled');
      throw new HttpError(409, 'run_not_waiting', 'The run that asked this is no longer active.');
    }
    const answers = input.skip ? null : checkAnswers(question.questions, input.answers ?? []);
    const settled = this.repo.settle(id, answers ? 'answered' : 'skipped', answers);
    if (!settled)
      throw new HttpError(409, 'question_not_pending', 'This question was already answered.');
    this.audit.record({
      sessionId: question.sessionId,
      actor: 'user',
      action: answers ? 'question_answered' : 'question_skipped',
      details: { questionId: id },
    });
    waiter({ outcome: answers ? 'answered' : 'skipped', question: settled });
    return settled;
  }
}

/** One answer per question: offered options only, one unless multi-select, or the user's words. */
function checkAnswers(questions: QuestionItem[], answers: QuestionAnswer[]): QuestionAnswer[] {
  const bad = (message: string) => new HttpError(400, 'invalid_answer', message);
  if (answers.length !== questions.length) throw bad('Answer every question, or skip them.');
  return questions.map((q, i) => {
    const a = answers[i]!;
    const selected = [...new Set(a.selected)];
    if (selected.some((s) => !q.options.some((o) => o.label === s)))
      throw bad(`"${q.question}" has no such option.`);
    if (!q.multiSelect && selected.length > 1) throw bad(`Choose one option for "${q.question}".`);
    const text = a.text?.trim() || null;
    if (text && text.length > MAX_ANSWER_CHARS)
      throw bad(`Answers are limited to ${MAX_ANSWER_CHARS} characters.`);
    if (!selected.length && !text) throw bad(`Answer "${q.question}", or skip the questions.`);
    return { selected, text };
  });
}
