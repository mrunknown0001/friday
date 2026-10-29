import type { AppNotice } from '@friday/shared';
import { useEffect, useEffectEvent } from 'react';

/** Follows app-wide notices (approvals waiting, finished runs) for every conversation. */
export function useAppNotices(onNotice: (notice: AppNotice) => void): void {
  const handle = useEffectEvent(onNotice);
  useEffect(() => {
    const source = new EventSource('/api/events');
    source.addEventListener('notice', (raw) => {
      handle(JSON.parse((raw as MessageEvent<string>).data) as AppNotice);
    });
    return () => source.close();
  }, []);
}
