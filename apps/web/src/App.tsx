import type {
  ApprovalDto,
  FileChangeDto,
  ProjectDto,
  RunDto,
  SessionDetailDto,
  SessionSummaryDto,
  SettingsDto,
} from '@friday/shared';
import { X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { AddProjectDialog } from './components/AddProjectDialog';
import { ChatView } from './components/ChatView';
import { MemoryDialog } from './components/MemoryDialog';
import { SettingsDialog } from './components/SettingsDialog';
import { SidePanel } from './components/SidePanel';
import { Sidebar } from './components/Sidebar';
import { api } from './lib/api';
import { useRunStream } from './lib/useRunStream';

const ACTIVE_KEY = 'friday.activeSession';
const PROJECT_KEY = 'friday.project';
const PANEL_KEY = 'friday.sidePanel';

// Per-viewer UI conveniences only; everything that matters lives on the server.
function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStored(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: not critical */
  }
}

export function App() {
  const [settings, setSettings] = useState<SettingsDto | null>(null);
  const [sessions, setSessions] = useState<SessionSummaryDto[]>([]);
  const [activeId, setActiveId] = useState<string | null>(() => readStored(ACTIVE_KEY));
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [projectId, setProjectId] = useState<string | null>(() => readStored(PROJECT_KEY));
  const [sidePanelOpen, setSidePanelOpen] = useState(() => readStored(PANEL_KEY) !== '0');
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [detail, setDetail] = useState<SessionDetailDto | null>(null);
  const [changes, setChanges] = useState<{ sessionId: string; list: FileChangeDto[] } | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const report = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  const loadSettings = useCallback(() => api.settings().then(setSettings).catch(report), []);
  const loadProjects = useCallback(
    () =>
      api
        .projects()
        .then((r) => {
          setProjects(r.projects);
          // Forget a remembered project that has since been removed.
          setProjectId((id) => (id && !r.projects.some((p) => p.id === id) ? null : id));
        })
        .catch(report),
    [],
  );
  const loadSessions = useCallback(
    () =>
      api
        .sessions(projectId)
        .then((r) => setSessions(r.sessions))
        .catch(report),
    [projectId],
  );

  const loadDetail = useCallback(async (id: string) => {
    try {
      const d = await api.session(id);
      setDetail(d);
      // Keep the project switcher in sync with the conversation being shown.
      setProjectId(d.projectId);
      // Reattach to a run that is still in progress (e.g. after a page reload).
      const active =
        d.latestRun?.status === 'running' || d.latestRun?.status === 'awaiting_approval';
      setRunId(active ? d.latestRun!.id : null);
      api
        .sessionChanges(id)
        .then((r) => setChanges({ sessionId: id, list: r.changes }))
        .catch(() => setChanges({ sessionId: id, list: [] }));
    } catch (e) {
      setDetail(null);
      setActiveId(null);
      report(e);
    }
  }, []);

  useEffect(() => {
    void loadSettings();
    void loadProjects();
  }, [loadSettings, loadProjects]);

  useEffect(() => {
    writeStored(PROJECT_KEY, projectId);
    void loadSessions();
  }, [projectId, loadSessions]);

  useEffect(() => {
    writeStored(ACTIVE_KEY, activeId);
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
  const project = projects.find((p) => p.id === projectId) ?? null;

  // Persisted approvals, overlaid with live updates from the current run.
  const approvals: ApprovalDto[] = (() => {
    const byId = new Map((shownDetail?.approvals ?? []).map((a) => [a.id, a]));
    if (live && live.runId === runId)
      for (const a of Object.values(live.approvals)) byId.set(a.id, a);
    return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  })();
  const sessionChanges = changes && changes.sessionId === activeId ? changes.list : [];

  // Refresh the change list as soon as an approved file change has been applied.
  const appliedCount = Object.values(live?.approvals ?? {}).filter(
    (a) => a.status === 'executed' && a.details.kind === 'file_change',
  ).length;
  useEffect(() => {
    if (!activeId || appliedCount === 0) return;
    let cancelled = false;
    api
      .sessionChanges(activeId)
      .then((r) => !cancelled && setChanges({ sessionId: activeId, list: r.changes }))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [activeId, appliedCount]);

  const decide = async (
    a: ApprovalDto,
    decision: 'approve' | 'reject',
    note?: string,
    confirmation?: string,
  ) => {
    try {
      await api.decideApproval(a.id, {
        decision,
        actionHash: a.actionHash,
        sessionId: a.sessionId,
        ...(note ? { note } : {}),
        ...(confirmation ? { confirmation } : {}),
      });
    } catch (e) {
      report(e);
      // The approval may have expired or changed; show its current state.
      if (activeId) void loadDetail(activeId);
    }
  };

  const rollback = async (runId: string) => {
    if (
      !window.confirm(
        "Roll back all of this run's file changes? Files edited since then will block the rollback.",
      )
    )
      return;
    try {
      await api.rollbackRun(runId);
    } catch (e) {
      report(e);
    }
    if (activeId) void loadDetail(activeId);
  };

  const revert = async (c: FileChangeDto) => {
    const what =
      c.change === 'create'
        ? `delete ${c.path} (it was created by Friday)`
        : `restore ${c.fromPath ?? c.path} to its previous state`;
    if (!window.confirm(`Undo this change? This will ${what}.`)) return;
    try {
      await api.revertChange(c.id);
    } catch (e) {
      report(e);
    }
    if (activeId) void loadDetail(activeId);
  };

  const selectProject = (id: string | null) => {
    if (id === projectId) return;
    setActiveId(null);
    setRunId(null);
    setProjectId(id);
  };

  const newSession = async () => {
    try {
      const s = await api.createSession(projectId);
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
        id = (await api.createSession(projectId)).id;
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
        projects={projects}
        projectId={projectId}
        onSelectProject={selectProject}
        onAddProject={() => setAddProjectOpen(true)}
        onRemoveProject={(id) =>
          void api
            .removeProject(id)
            .then(() => {
              selectProject(null);
              return loadProjects();
            })
            .catch(report)
        }
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
        onOpenMemory={() => setMemoryOpen(true)}
        settingsWarning={!!blockedReason}
      />
      <div className="relative flex min-w-0 flex-1">
        <ChatView
          detail={shownDetail}
          project={project}
          live={live}
          sidePanelOpen={sidePanelOpen}
          onToggleSidePanel={() => {
            writeStored(PANEL_KEY, sidePanelOpen ? '0' : '1');
            setSidePanelOpen(!sidePanelOpen);
          }}
          canSend={!blockedReason}
          blockedReason={blockedReason}
          onSend={send}
          onStop={stop}
          onRetry={() => void retry()}
          onOpenSettings={() => setSettingsOpen(true)}
          approvals={approvals}
          onDecide={decide}
          deploymentPlans={[
            ...(shownDetail?.deploymentPlans ?? []),
            ...(live?.deploymentPlans ?? []).filter(
              (p) => !shownDetail?.deploymentPlans.some((q) => q.id === p.id),
            ),
          ]}
          onRollback={rollback}
          onOpenMemory={() => setMemoryOpen(true)}
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
      {sidePanelOpen && (
        <SidePanel
          project={project}
          plan={live?.plan ?? shownDetail?.plan ?? null}
          changes={sessionChanges}
          onRevert={(c) => void revert(c)}
        />
      )}
      {addProjectOpen && (
        <AddProjectDialog
          onClose={() => setAddProjectOpen(false)}
          onAdded={(p) => {
            setAddProjectOpen(false);
            void loadProjects();
            selectProject(p.id);
          }}
        />
      )}
      {memoryOpen && <MemoryDialog project={project} onClose={() => setMemoryOpen(false)} />}
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
