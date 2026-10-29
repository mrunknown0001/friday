import type { TaskPermissionDto } from '@friday/shared';
import { KeyRound } from 'lucide-react';
import { useState } from 'react';
import { displayArgv } from '../lib/format';
import { Button } from './ui/button';

const ENDED: Record<NonNullable<TaskPermissionDto['ended']>, string> = {
  revoked: 'you revoked it',
  expired: 'its time limit passed',
  used_up: 'its action limit was reached',
  replaced: 'a new one replaced it',
};

/**
 * Shown above the composer while a run has a task permission: what it covers, how much is used,
 * and a way to end it. After it ends, says so, since every action asks again from then on.
 */
export function TaskPermissionBanner({
  permission,
  onRevoke,
}: {
  permission: TaskPermissionDto;
  onRevoke: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const until = new Date(permission.expiresAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  const scope = [
    ...permission.files,
    ...permission.commands.map((c) => `$ ${displayArgv(c)}`),
  ].join('\n');

  if (!permission.active) {
    return (
      <p role="status" className="mb-2 flex items-center gap-2 text-xs text-zinc-400">
        <KeyRound className="h-3.5 w-3.5" aria-hidden />
        Task permission ended:{' '}
        {permission.ended ? ENDED[permission.ended] : 'it is no longer active'}. Friday will ask
        before each action again.
      </p>
    );
  }
  return (
    <div
      role="status"
      className="mb-2 flex items-center justify-between gap-3 rounded-md border border-sky-900/70 bg-sky-950/30 px-3 py-2 text-xs text-sky-100"
    >
      <span className="flex items-center gap-2" title={scope}>
        <KeyRound className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>
          Task permission active: {permission.used} of {permission.maxActions} actions used, until{' '}
          {until}. Covers {permission.files.length} file
          {permission.files.length === 1 ? '' : 's'}
          {permission.commands.length
            ? ` and ${permission.commands.length} command${permission.commands.length === 1 ? '' : 's'}`
            : ''}
          .
        </span>
      </span>
      <Button
        size="sm"
        variant="secondary"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void onRevoke().finally(() => setBusy(false));
        }}
      >
        Revoke
      </Button>
    </div>
  );
}
