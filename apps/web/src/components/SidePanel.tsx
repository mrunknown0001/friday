import type {
  FileChangeDto,
  FileViewDto,
  PlanStep,
  ProjectDto,
  TreeEntryDto,
} from '@friday/shared';
import hljs from 'highlight.js/lib/common';
import {
  Undo2,
  CheckCircle2,
  ChevronRight,
  Circle,
  CircleDot,
  File,
  Folder,
  Link2,
  OctagonAlert,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { cn } from '../lib/cn';
import { formatBytes } from '../lib/format';
import { Dialog } from './ui/dialog';

const PLAN_ICON = {
  pending: <Circle className="h-4 w-4 text-zinc-500" aria-label="pending" />,
  in_progress: <CircleDot className="h-4 w-4 text-sky-400" aria-label="in progress" />,
  completed: <CheckCircle2 className="h-4 w-4 text-emerald-400" aria-label="completed" />,
  blocked: <OctagonAlert className="h-4 w-4 text-amber-400" aria-label="blocked" />,
};

function Plan({ plan }: { plan: PlanStep[] | null }) {
  if (!plan?.length) {
    return (
      <p className="px-3 text-xs text-zinc-500">
        No plan yet. Friday publishes one for multi-step tasks.
      </p>
    );
  }
  const done = plan.filter((s) => s.status === 'completed').length;
  return (
    <div className="px-3">
      <p className="mb-2 text-xs text-zinc-500">
        {done} of {plan.length} complete
      </p>
      <ol className="space-y-1.5">
        {plan.map((s, i) => (
          <li key={i} className="flex items-start gap-2 text-sm">
            <span className="mt-0.5 shrink-0">{PLAN_ICON[s.status]}</span>
            <span className={cn(s.status === 'completed' && 'text-zinc-500 line-through')}>
              {s.title}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function TreeNode({
  entry,
  projectId,
  depth,
  onOpen,
}: {
  entry: TreeEntryDto;
  projectId: string;
  depth: number;
  onOpen: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<TreeEntryDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggle = async () => {
    if (entry.type !== 'dir') {
      if (entry.type === 'file') onOpen(entry.path);
      return;
    }
    const next = !open;
    setOpen(next);
    if (next && children === null) {
      try {
        setChildren((await api.projectTree(projectId, entry.path)).entries);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
  };

  return (
    <li>
      <button
        type="button"
        onClick={() => void toggle()}
        aria-expanded={entry.type === 'dir' ? open : undefined}
        className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[13px] text-zinc-300 hover:bg-zinc-800"
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
        title={entry.path}
      >
        {entry.type === 'dir' ? (
          <>
            <ChevronRight
              className={cn(
                'h-3 w-3 shrink-0 text-zinc-500 transition-transform',
                open && 'rotate-90',
              )}
            />
            <Folder className="h-3.5 w-3.5 shrink-0 text-sky-400/80" />
          </>
        ) : (
          <>
            <span className="w-3 shrink-0" />
            {entry.type === 'symlink' ? (
              <Link2 className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
            ) : (
              <File className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
            )}
          </>
        )}
        <span className="truncate">{entry.name}</span>
        {entry.type === 'file' && (
          <span className="ml-auto shrink-0 text-[11px] text-zinc-600">
            {formatBytes(entry.size)}
          </span>
        )}
      </button>
      {error && <p className="px-6 text-xs text-red-400">{error}</p>}
      {open && children && (
        <ul>
          {children.map((c) => (
            <TreeNode
              key={c.path}
              entry={c}
              projectId={projectId}
              depth={depth + 1}
              onOpen={onOpen}
            />
          ))}
          {children.length === 0 && (
            <li
              className="py-0.5 text-xs text-zinc-600"
              style={{ paddingLeft: `${(depth + 1) * 12 + 24}px` }}
            >
              empty
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

function FileViewer({
  projectId,
  path,
  onClose,
}: {
  projectId: string;
  path: string;
  onClose: () => void;
}) {
  const [file, setFile] = useState<FileViewDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .projectFile(projectId, path)
      .then((f) => !cancelled && setFile(f))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [projectId, path]);

  // highlight.js escapes the source text, so its HTML output is safe to inject.
  const html = useMemo(() => {
    if (!file?.content) return null;
    if (file.language && hljs.getLanguage(file.language)) {
      return hljs.highlight(file.content, { language: file.language, ignoreIllegals: true }).value;
    }
    return null;
  }, [file]);

  return (
    <Dialog open onClose={onClose} title={path}>
      {error && <p className="text-sm text-red-400">{error}</p>}
      {!file && !error && <p className="text-sm text-zinc-500">Loading…</p>}
      {file && (file.binary || file.tooLarge) && (
        <p className="text-sm text-zinc-400">
          {file.binary ? 'Binary file' : 'File too large to preview'} ({formatBytes(file.size)}).
        </p>
      )}
      {file?.content != null && (
        <pre className="max-h-[70vh] overflow-auto rounded-md border border-zinc-800 bg-zinc-950 p-3 font-mono text-[0.78rem] leading-snug">
          {html ? (
            <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
          ) : (
            <code>{file.content}</code>
          )}
        </pre>
      )}
      <p className="mt-2 text-[11px] text-zinc-500">
        Read-only view. Credential files such as .env cannot be opened.
      </p>
    </Dialog>
  );
}

const CHANGE_LABEL: Record<FileChangeDto['change'], string> = {
  create: 'created',
  modify: 'modified',
  delete: 'deleted',
  move: 'moved',
};

function Changes({
  changes,
  onRevert,
}: {
  changes: FileChangeDto[];
  onRevert: (c: FileChangeDto) => void;
}) {
  if (changes.length === 0) {
    return <p className="px-3 text-xs text-zinc-500">No files changed in this conversation.</p>;
  }
  return (
    <ul className="space-y-1 px-2">
      {[...changes].reverse().map((c) => (
        <li key={c.id} className="flex items-center gap-2 rounded px-1 py-0.5 text-[13px]">
          <span
            className={cn(
              'w-16 shrink-0 text-[11px]',
              c.revertedAt
                ? 'text-zinc-600'
                : c.change === 'delete'
                  ? 'text-red-400'
                  : 'text-emerald-400',
            )}
          >
            {c.revertedAt ? 'undone' : CHANGE_LABEL[c.change]}
          </span>
          <span
            className={cn(
              'min-w-0 flex-1 truncate font-mono text-zinc-300',
              c.revertedAt && 'text-zinc-600 line-through',
            )}
            title={c.fromPath ? `${c.fromPath} → ${c.path}` : c.path}
          >
            {c.fromPath ? `${c.fromPath} → ${c.path}` : c.path}
          </span>
          {!c.revertedAt && (
            <button
              type="button"
              onClick={() => onRevert(c)}
              aria-label={`Undo change to ${c.path}`}
              title="Undo this change"
              className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
            >
              <Undo2 className="h-3.5 w-3.5" />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

export function SidePanel({
  project,
  plan,
  changes,
  onRevert,
}: {
  project: ProjectDto | null;
  plan: PlanStep[] | null;
  changes: FileChangeDto[];
  onRevert: (c: FileChangeDto) => void;
}) {
  const [root, setRoot] = useState<TreeEntryDto[] | null>(null);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const projectId = project?.id ?? null;

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    api
      .projectTree(projectId)
      .then((t) => {
        if (cancelled) return;
        setRoot(t.entries);
        setTreeError(null);
      })
      .catch(
        (e: unknown) => !cancelled && setTreeError(e instanceof Error ? e.message : String(e)),
      );
    return () => {
      cancelled = true;
    };
    // Re-list when files change so the tree reflects applied and undone changes.
  }, [projectId, changes]);

  return (
    <aside
      aria-label="Plan and files"
      className="flex w-80 shrink-0 flex-col border-l border-zinc-800 bg-zinc-900/30"
    >
      <section className="border-b border-zinc-800 py-3">
        <h2 className="mb-2 px-3 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
          Plan
        </h2>
        <Plan plan={plan} />
      </section>
      <section className="border-b border-zinc-800 py-3">
        <h2 className="mb-2 px-3 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
          Changes
        </h2>
        <Changes changes={changes} onRevert={onRevert} />
      </section>
      <section className="flex min-h-0 flex-1 flex-col py-3">
        <h2 className="mb-1 px-3 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
          Files
          {project && (
            <span className="ml-1 normal-case tracking-normal text-zinc-600">· {project.name}</span>
          )}
        </h2>
        {!project ? (
          <p className="px-3 text-xs text-zinc-500">Select a project to browse its files.</p>
        ) : !project.available ? (
          <p className="px-3 text-xs text-amber-400">The project folder is missing or has moved.</p>
        ) : treeError ? (
          <p className="px-3 text-xs text-red-400">{treeError}</p>
        ) : (
          <ul key={project.id} className="min-h-0 flex-1 overflow-y-auto px-1">
            {(root ?? []).map((e) => (
              <TreeNode
                key={e.path}
                entry={e}
                projectId={project.id}
                depth={0}
                onOpen={setViewing}
              />
            ))}
          </ul>
        )}
        <p className="mt-2 px-3 text-[11px] text-zinc-600">
          Respects .gitignore; dependency and build folders are hidden.
        </p>
      </section>
      {viewing && project && (
        <FileViewer projectId={project.id} path={viewing} onClose={() => setViewing(null)} />
      )}
    </aside>
  );
}
