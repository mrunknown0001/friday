import type { QuestionItem } from '@friday/shared';
import { Loader2, Undo2, WandSparkles, X } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { api } from '../lib/api';
import { answerText, QuestionForm } from './QuestionForm';
import { Button } from './ui/button';

type State =
  | { kind: 'idle' }
  | { kind: 'working'; questions: QuestionItem[] | null }
  | { kind: 'questions'; questions: QuestionItem[] }
  | { kind: 'error'; message: string };

const SHORTCUT = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘E' : 'Ctrl+E';

/**
 * "Improve prompt" in the composer: Friday rewrites the draft into a clear, specific request,
 * first asking up to three questions when the answer would change it. The result replaces the
 * draft for the user to edit or send; Undo (or Ctrl+Z right after) brings the original back.
 */
export function usePromptEnhancer({
  draft,
  setDraft,
  projectId,
  sessionId,
  disabled,
}: {
  draft: string;
  setDraft: (text: string) => void;
  projectId: string | null;
  sessionId: string | null;
  disabled: boolean;
}): { button: ReactNode; panel: ReactNode; onKeyDown: (e: KeyboardEvent) => boolean } {
  const [state, setState] = useState<State>({ kind: 'idle' });
  // The draft before the last improvement, while the improved text is still untouched.
  const [undo, setUndo] = useState<{ original: string; improved: string } | null>(null);
  const request = useRef(0);

  // Another conversation starts fresh, and a reply still on its way is dropped.
  const [shownFor, setShownFor] = useState(sessionId);
  if (shownFor !== sessionId) {
    setShownFor(sessionId);
    setState({ kind: 'idle' });
    setUndo(null);
  }
  useEffect(() => {
    request.current++;
  }, [sessionId]);

  const working = state.kind === 'working';
  const canStart = !disabled && !!draft.trim() && !working;

  const run = (answers?: Array<{ question: string; answer: string }>, noQuestions?: boolean) => {
    const id = ++request.current;
    const original = draft;
    setState({ kind: 'working', questions: state.kind === 'questions' ? state.questions : null });
    void api
      .enhancePrompt({
        draft: original,
        projectId,
        sessionId,
        ...(answers ? { answers } : {}),
        ...(noQuestions ? { noQuestions } : {}),
      })
      .then((result) => {
        if (id !== request.current) return;
        if (result.kind === 'questions') {
          setState({ kind: 'questions', questions: result.questions });
          return;
        }
        setState({ kind: 'idle' });
        setUndo({ original, improved: result.prompt });
        setDraft(result.prompt);
      })
      .catch((e: unknown) => {
        if (id !== request.current) return;
        setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
      });
  };

  const cancel = () => {
    request.current++;
    setState({ kind: 'idle' });
  };

  const restore = () => {
    if (!undo) return;
    setDraft(undo.original);
    setUndo(null);
  };

  const onKeyDown = (e: KeyboardEvent): boolean => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'e') {
      e.preventDefault();
      if (canStart) run();
      return true;
    }
    if (mod && !e.shiftKey && e.key.toLowerCase() === 'z' && undo && draft === undo.improved) {
      e.preventDefault();
      restore();
      return true;
    }
    if (e.key === 'Escape' && state.kind !== 'idle') {
      e.preventDefault();
      cancel();
      return true;
    }
    return false;
  };

  const button = (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => (working ? cancel() : run())}
      disabled={!working && !canStart}
      aria-label={working ? 'Stop improving the prompt' : 'Improve prompt'}
      title={
        working
          ? 'Improving… (click or Esc to stop)'
          : `Improve prompt: Friday makes it clearer and more specific, asking first if something is unclear (${SHORTCUT})`
      }
    >
      {working ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <WandSparkles className="h-4 w-4" />
      )}
    </Button>
  );

  const showUndo = undo && draft === undo.improved && state.kind === 'idle';
  const questions =
    state.kind === 'questions' || (state.kind === 'working' && state.questions)
      ? (state as { questions: QuestionItem[] }).questions
      : null;

  const panel = (
    <>
      {questions && (
        <section
          aria-label="Questions about your prompt"
          className="mb-2 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3"
        >
          <header className="mb-2 flex items-start gap-2">
            <WandSparkles className="mt-0.5 h-4 w-4 shrink-0 text-sky-400" aria-hidden />
            <p className="flex-1 text-xs text-zinc-400">
              A few questions so the prompt says exactly what you want:
            </p>
            <button
              type="button"
              onClick={cancel}
              aria-label="Close questions"
              className="rounded p-0.5 text-zinc-500 hover:text-zinc-200"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </header>
          <QuestionForm
            questions={questions}
            busy={working}
            submitLabel="Write prompt"
            skipLabel="Skip questions"
            onSubmit={(answers) =>
              run(
                answers.map((a, i) => ({
                  question: questions[i]!.question,
                  answer: answerText(a),
                })),
              )
            }
            onSkip={() => run(undefined, true)}
          />
        </section>
      )}
      {state.kind === 'error' && (
        <p
          role="alert"
          className="mb-2 flex items-center gap-2 rounded-md border border-red-900/60 bg-red-950/30 px-3 py-1.5 text-xs text-red-200"
        >
          <span className="flex-1">{state.message}</span>
          <button
            type="button"
            onClick={cancel}
            aria-label="Dismiss"
            className="rounded p-0.5 text-red-300 hover:text-red-100"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </p>
      )}
      {showUndo && (
        <p className="mb-1 flex items-center gap-2 px-1 text-[11px] text-zinc-400" role="status">
          <WandSparkles className="h-3 w-3 text-sky-400" aria-hidden />
          Prompt improved. Edit it or send it as it is.
          <button
            type="button"
            onClick={restore}
            className="inline-flex items-center gap-1 text-zinc-300 hover:text-zinc-100"
          >
            <Undo2 className="h-3 w-3" /> Undo
          </button>
        </p>
      )}
    </>
  );

  return { button, panel, onKeyDown };
}
