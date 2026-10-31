import { Loader2, Mic, Square, Volume2, VolumeX, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import {
  MAX_RECORDING_SECONDS,
  modelReady,
  player,
  recorder,
  setSpeakReplies,
  usePlayer,
  useSpeakReplies,
  useVoiceStatus,
  type Recording,
} from '../lib/voice';
import { Button } from './ui/button';

const canRecord = () =>
  typeof navigator !== 'undefined' &&
  !!navigator.mediaDevices?.getUserMedia &&
  typeof MediaRecorder !== 'undefined';

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

const micError = (e: unknown) =>
  e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError')
    ? 'Microphone access was blocked. Allow it for Friday in the browser’s site settings.'
    : e instanceof DOMException && e.name === 'NotFoundError'
      ? 'No microphone was found.'
      : e instanceof Error
        ? e.message
        : String(e);

/**
 * Composer voice controls: "Speak replies" (Friday also speaks each reply) and dictation (the
 * microphone records only while the button is on; the transcript goes into the message box).
 */
export function VoiceControls({
  onTranscript,
  onOpenSettings,
}: {
  onTranscript: (text: string) => void;
  onOpenSettings: () => void;
}) {
  const status = useVoiceStatus();
  const speaking = useSpeakReplies();
  const playing = usePlayer();
  const playError = playing.errorFor !== 'voice-test' ? playing.error : null;
  const [recording, setRecording] = useState<Recording | null>(null);
  const [startedAt, setStartedAt] = useState(0);
  const [now, setNow] = useState(0);
  const [level, setLevel] = useState(0);
  const [transcribing, setTranscribing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const stopping = useRef(false);

  const finish = async (r: Recording) => {
    if (stopping.current) return;
    stopping.current = true;
    setRecording(null);
    setTranscribing(true);
    try {
      const { text } = await api.transcribe(await r.stop());
      if (text) onTranscript(text);
      else setNotice('No speech was heard.');
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setTranscribing(false);
      stopping.current = false;
    }
  };

  // The indicator: elapsed time and level, and the time limit.
  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => {
      const n = Date.now();
      setNow(n);
      setLevel(recording.level());
      if (n - startedAt >= MAX_RECORDING_SECONDS * 1000) void finish(recording);
    }, 100);
    return () => clearInterval(t);
    // finish only reads refs and props that are stable for a recording.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, startedAt]);

  // Never leave the microphone on when the composer goes away.
  const live = useRef<Recording | null>(null);
  useEffect(() => {
    live.current = recording;
  }, [recording]);
  useEffect(() => () => live.current?.cancel(), []);

  const toggleMic = async () => {
    setNotice(null);
    if (recording) return finish(recording);
    if (!modelReady(status, 'transcription')) {
      setNotice('Voice input needs the transcription model. Download it in Settings → Voice.');
      return;
    }
    try {
      player.stop();
      const r = await recorder.start();
      const t = Date.now();
      setStartedAt(t);
      setNow(t);
      setRecording(r);
    } catch (e) {
      setNotice(micError(e));
    }
  };

  const toggleSpeak = () => {
    setNotice(null);
    if (!speaking && !modelReady(status, 'speech')) {
      setNotice('Spoken replies need the speech model. Download it in Settings → Voice.');
      return;
    }
    setSpeakReplies(!speaking);
  };

  return (
    <>
      {(recording || transcribing || notice || playError) && (
        <div className="absolute bottom-full left-0 right-0 mb-2 flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs">
          {recording ? (
            <>
              <span
                className="h-2 w-2 animate-pulse rounded-full bg-red-500 motion-reduce:animate-none"
                aria-hidden
              />
              <span role="status" className="text-zinc-200">
                Listening · {clock((now - startedAt) / 1000)}
              </span>
              <span
                className="h-1.5 w-20 overflow-hidden rounded-full bg-zinc-800"
                aria-hidden
                data-testid="mic-level"
              >
                <span
                  className="block h-full bg-red-400 transition-[width]"
                  style={{ width: `${Math.round(level * 100)}%` }}
                />
              </span>
              <span className="text-zinc-500">Click the microphone to stop</span>
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto h-6"
                onClick={() => {
                  recording.cancel();
                  setRecording(null);
                }}
              >
                <X className="h-3.5 w-3.5" /> Discard
              </Button>
            </>
          ) : transcribing ? (
            <span role="status" className="flex items-center gap-2 text-zinc-300">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Transcribing…
            </span>
          ) : (
            <>
              <span role="alert" className="text-amber-200">
                {notice ?? `Couldn’t speak: ${playError}`}
              </span>
              {notice?.includes('Settings') && (
                <Button
                  size="sm"
                  variant="secondary"
                  className="ml-auto h-6"
                  onClick={onOpenSettings}
                >
                  Open settings
                </Button>
              )}
            </>
          )}
        </div>
      )}
      <Button
        variant="ghost"
        size="icon"
        onClick={toggleSpeak}
        aria-pressed={speaking}
        aria-label="Speak replies"
        title={speaking ? 'Friday speaks its replies (click to turn off)' : 'Also speak replies'}
        className={speaking ? 'text-sky-400' : undefined}
      >
        {speaking ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
      </Button>
      {canRecord() && (
        <Button
          variant="ghost"
          size="icon"
          onClick={() => void toggleMic()}
          disabled={transcribing}
          aria-pressed={!!recording}
          aria-label={recording ? 'Stop dictation' : 'Dictate'}
          title={recording ? 'Stop and transcribe' : 'Dictate a message'}
          className={recording ? 'text-red-400' : undefined}
        >
          {recording ? (
            <Square className="h-3.5 w-3.5 fill-current" />
          ) : (
            <Mic className="h-4 w-4" />
          )}
        </Button>
      )}
    </>
  );
}

/** Play / stop for one reply, under the reply. */
export function SpeakReplyButton({ sessionId, runId }: { sessionId: string; runId: string }) {
  const status = useVoiceStatus();
  const p = usePlayer();
  if (!modelReady(status, 'speech')) return null;
  const mine = p.key === runId;
  return (
    <button
      type="button"
      onClick={() => (mine ? player.stop() : void player.playRun(sessionId, runId))}
      aria-label={mine ? 'Stop speaking' : 'Play reply aloud'}
      title={mine ? 'Stop' : 'Play aloud'}
      className="inline-flex items-center gap-1 rounded px-1 text-zinc-500 hover:text-zinc-200"
    >
      {mine && p.loading ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : mine ? (
        <Square className="h-3 w-3 fill-current" />
      ) : (
        <Volume2 className="h-3.5 w-3.5" />
      )}
      {mine && <span>{p.loading ? 'Preparing…' : 'Speaking'}</span>}
    </button>
  );
}
