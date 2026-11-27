/**
 * Near-real-time sync: listens to the server's event stream and refetches affected queries.
 * Events carry only a type and branch id; the data itself always comes from the API.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

const KEYS: Record<string, string[][]> = {
  schedule: [['week'], ['month'], ['dashboard'], ['my-shifts'], ['my-home'], ['history'], ['versions'], ['candidates']],
  availability: [['availability'], ['my-availability'], ['week'], ['candidates'], ['dashboard']],
  cover: [['cover'], ['opportunities'], ['my-cover'], ['week'], ['dashboard'], ['my-shifts'], ['my-home']],
  sickness: [['sickness'], ['dashboard'], ['week']],
  notification: [['notifications'], ['unread']],
  announcement: [['announcements'], ['my-home']],
  employees: [['employees'], ['employee'], ['week'], ['me']],
  settings: [['branches'], ['skills'], ['policy'], ['settings'], ['me'], ['week']],
};

export type SyncState = 'connecting' | 'live' | 'offline';

export function useRealtime(enabled: boolean): SyncState {
  const qc = useQueryClient();
  const [state, setState] = useState<SyncState>('connecting');

  useEffect(() => {
    if (!enabled) return;
    let es: EventSource | null = null;
    let retry: number | undefined;
    const open = () => {
      es = new EventSource('/api/events', { withCredentials: true });
      es.addEventListener('ready', () => setState('live'));
      es.addEventListener('change', (ev) => {
        try {
          const { t } = JSON.parse((ev as MessageEvent).data);
          for (const key of KEYS[t] ?? []) void qc.invalidateQueries({ queryKey: key });
        } catch {
          /* ignore */
        }
      });
      es.addEventListener('resync', () => void qc.invalidateQueries());
      es.onerror = () => {
        setState(navigator.onLine ? 'connecting' : 'offline');
        if (es?.readyState === EventSource.CLOSED) {
          es.close();
          retry = window.setTimeout(open, 5000);
        }
      };
    };
    open();
    const online = () => {
      setState('connecting');
      void qc.invalidateQueries();
    };
    const offline = () => setState('offline');
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    return () => {
      es?.close();
      if (retry) clearTimeout(retry);
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
    };
  }, [enabled, qc]);

  return state;
}
