import type { RunDto, SessionDetailDto, SessionSummaryDto, SettingsDto } from '@friday/shared';
import { X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { ChatView } from './components/ChatView';
import { SettingsDialog } from './components/SettingsDialog';
import { Sidebar } from './components/Sidebar';
import { api } from './lib/api';
import { useRunStream } from './lib/useRunStream';

const ACTIVE_KEY = 'friday.activeSession';

function readStoredSession(): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

export function App() {
  const [settings, setSettings] = useState<SettingsDto | null>(null);
  const [sessions, setSessions] = useState<SessionSummaryDto[]>([]);
  const [activeId, setActiveId] = useState<string | null>(readStoredSession);
  const [detail, setDetail] = useState<SessionDetailDto | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const report = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  const loadSettings = useCallback(() => api.settings().then(setSettings).catch(report), []);
  const loadSessions = useCallback(
    () =>
      api
        .sessions()
        .then((r) => setSessions(r.sessions))
        .catch(report),
    [],
  );

  const loadDetail = useCallback(async (id: string) => {
    try {
      const d = await api.session(id);
      setDetail(d);
      // Reattach to a run that is still in progress (e.g. after a page reload).
      setRunId(d.latestRun?.status === 'running' ? d.latestRun.id : null);
    } catch (e) {
      setDetail(null);
      setActiveId(null);
      report(e);
    }
  }, []);

  useEffect(() => {
    void loadSettings();
    void loadSessions();
  }, [loadSettings, loadSessions]);

  useEffect(() => {
    try {
      if (activeId) localStorage.setItem(ACTIVE_KEY, activeId);
      else localStorage.removeItem(ACTIVE_KEY);
    } catch {
      /* storage unavailable: not critical */
    }
    // loadDetail only sets state after its fetch resolves; the rule cannot see through the await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (activeId) void loadDetail(activeId);
  }, [activeId, loadDetail]);
  // Never show a stale conversation after switching or deleting.
  const shownDetail = detail && detail.id === activeId ? detail : null;

  const onRunFinished = useCallback(
    (run: RunDto) => {
      void loadDetail(run.sessionId).then(() => setRunId(null));
      void loadSessions();
    },
    [loadDetail, loadSessions],
  );
  const live = useRunStream(runId, onRunFinished);

  const newSession = async () => {
    try {
      const s = await api.createSession();
      await loadSessions();
      setActiveId(s.id);
    } catch (e) {
      report(e);
    }
  };

  const send = async (text: string): Promise<boolean> => {
    try {
      let id = activeId;
      if (!id) {
        id = (await api.createSession()).id;
        setActiveId(id);
      }
      const { run } = await api.sendMessage(id, text);
      await loadDetail(id);
      setRunId(run.id);
      void loadSessions();
      return true;
    } catch (e) {
      report(e);
      return false;
    }
  };

  const retry = async () => {
    if (!activeId) return;
    try {
      const { run } = await api.retry(activeId);
      await loadDetail(activeId);
      setRunId(run.id);
    } catch (e) {
      report(e);
    }
  };

  const stop = () => {
    if (runId) api.cancelRun(runId).catch(report);
  };

  const blockedReason = !settings
    ? null
    : !settings.apiKeyConfigured
      ? 'NoTokenLimit API key is not configured.'
      : !settings.model
        ? 'No model selected.'
        : null;

  return (
    <div className="flex h-full">
      <Sidebar
        sessions={sessions}
        activeId={activeId}
        onSelect={setActiveId}
        onNew={() => void newSession()}
        onRename={(id, title) =>
          void api
            .renameSession(id, title)
            .then(() => Promise.all([loadSessions(), id === activeId ? loadDetail(id) : null]))
            .catch(report)
        }
        onDelete={(id) =>
          void api
            .deleteSession(id)
            .then(() => {
              if (id === activeId) {
                setActiveId(null);
                setRunId(null);
              }
              return loadSessions();
            })
            .catch(report)
        }
        onOpenSettings={() => setSettingsOpen(true)}
        settingsWarning={!!blockedReason}
      />
      <div className="relative flex min-w-0 flex-1">
        <ChatView
          detail={shownDetail}
          live={live}
          canSend={!blockedReason}
          blockedReason={blockedReason}
          onSend={send}
          onStop={stop}
          onRetry={() => void retry()}
          onOpenSettings={() => setSettingsOpen(true)}
        />
        {error && (
          <div
            role="alert"
            className="absolute right-4 top-14 z-10 flex max-w-md items-start gap-2 rounded-lg border border-red-900 bg-red-950/95 px-3 py-2 text-sm text-red-100 shadow-lg"
          >
            <span className="flex-1 break-words">{error}</span>
            <button
              type="button"
              aria-label="Dismiss error"
              onClick={() => setError(null)}
              className="text-red-300 hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>
      {/* Mounted only while open so each opening starts from fresh state. */}
      {settingsOpen && (
        <SettingsDialog
          onClose={() => setSettingsOpen(false)}
          settings={settings}
          onSettingsChanged={() => void loadSettings()}
        />
      )}
    </div>
  );
}
