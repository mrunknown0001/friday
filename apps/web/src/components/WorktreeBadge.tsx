import type { ProjectDto } from '@friday/shared';
import { GitBranch, GitMerge, Trash2 } from 'lucide-react';
import { Badge } from './ui/badge';
import { Button } from './ui/button';

/** Where a task worktree's conversation works, and the user's accept/discard actions. */
export function WorktreeBadge({
  project,
  busy,
  onAccept,
  onDiscard,
}: {
  project: ProjectDto;
  busy: boolean;
  onAccept: () => void;
  onDiscard: () => void;
}) {
  const wt = project.worktree!;
  if (wt.status !== 'active') {
    const o = wt.outcome;
    const text =
      wt.status === 'discarded'
        ? 'discarded'
        : o?.mode === 'branch'
          ? `kept as branch ${wt.branch}`
          : `${o?.mode === 'squash' ? 'squashed' : 'merged'} into ${o?.branch ?? 'your branch'}${o?.commit ? ` (${o.commit.slice(0, 7)})` : ''}`;
    return (
      <Badge
        tone={wt.status === 'accepted' ? 'success' : 'neutral'}
        title={`Task worktree ${wt.branch}`}
      >
        <GitBranch className="h-3 w-3" aria-hidden /> Task {text}
      </Badge>
    );
  }
  return (
    <>
      <Badge
        tone="info"
        className="whitespace-nowrap"
        title={`A separate worktree at ${project.rootPath}, from ${wt.baseBranch ?? 'a detached HEAD'} @ ${wt.base.slice(0, 8)}. Your own checkout is untouched until you accept.`}
      >
        <GitBranch className="h-3 w-3" aria-hidden /> worktree · {wt.branch}
      </Badge>
      <Button
        size="sm"
        variant="ghost"
        onClick={onAccept}
        disabled={busy}
        title="Merge, squash or keep the branch"
      >
        <GitMerge className="h-3.5 w-3.5" aria-hidden /> Accept…
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={onDiscard}
        disabled={busy}
        title="Remove the worktree and its branch"
      >
        <Trash2 className="h-3.5 w-3.5" aria-hidden /> Discard…
      </Button>
    </>
  );
}
