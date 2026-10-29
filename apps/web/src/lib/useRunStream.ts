import type { RunDto, RunEvent, RunPhase } from '@friday/shared';
import { useEffect, useState } from 'react';

export interface LiveRun {
  runId: string;
  text: string;
  phase: RunPhase | null;
  phaseDetail: string | null;
  finished: RunDto | null;
  connectionLost: boolean;
}

const EVENT_TYPES: RunEvent['type'][] = [
  'run_started',
  'phase',
  'text_delta',
  'message_saved',
  'run_finished',
];

/**
 * Follows a run's Server-Sent Events. EventSource reconnects automatically and sends
 * Last-Event-ID, so the server replays only what was missed.
 */
const initial = (runId: string): LiveRun => ({
  runId,
  text: '',
  phase: null,
  phaseDetail: null,
  finished: null,
  connectionLost: false,
});

export function useRunStream(
  runId: string | null,
  onFinished: (run: RunDto) => void,
): LiveRun | null {
  const [live, setLive] = useState<LiveRun | null>(null);

  useEffect(() => {
    if (!runId) return;
    const source = new EventSource(`/api/runs/${runId}/events`);
    let lastSeq = 0;

    const handle = (raw: MessageEvent<string>) => {
      const event = JSON.parse(raw.data) as RunEvent;
      if (event.seq !== 0 && event.seq <= lastSeq) return;
      lastSeq = event.seq;
      setLive((prev) => {
        const next = { ...(prev?.runId === runId ? prev : initial(runId)), connectionLost: false };
        switch (event.type) {
          case 'text_delta':
            next.text += event.delta;
            break;
          case 'phase':
            next.phase = event.phase;
            next.phaseDetail = event.detail ?? null;
            break;
          case 'run_finished':
            next.finished = event.run;
            break;
          default:
            break;
        }
        return next;
      });
      if (event.type === 'run_finished') {
        source.close();
        onFinished(event.run);
      }
    };

    for (const type of EVENT_TYPES) source.addEventListener(type, handle as EventListener);
    source.onerror = () =>
      setLive((prev) => {
        const current = prev?.runId === runId ? prev : initial(runId);
        return current.finished ? current : { ...current, connectionLost: true };
      });
    return () => source.close();
    // onFinished is intentionally excluded: a new callback identity must not reopen the stream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  if (!runId) return null;
  return live?.runId === runId ? live : initial(runId);
}
