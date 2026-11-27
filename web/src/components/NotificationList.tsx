import {
  ArrowsLeftRight,
  Bell,
  CalendarCheck,
  CheckCircle,
  Checks,
  ClipboardText,
  FirstAidKit,
  HandHeart,
  Megaphone,
  WarningCircle,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../lib/api';
import { relative } from '../lib/time';
import { Button, EmptyState, ErrorNotice, Segmented, Skeleton, useToast } from './ui';

const ICONS: Record<string, any> = {
  schedule_published: CalendarCheck,
  schedule_changed: CalendarCheck,
  sickness_reported: FirstAidKit,
  cover_requested: HandHeart,
  cover_opportunity: HandHeart,
  cover_awaiting_approval: HandHeart,
  cover_claimed: ArrowsLeftRight,
  cover_approved: CheckCircle,
  cover_filled: ArrowsLeftRight,
  cover_rejected: WarningCircle,
  cover_claim_rejected: WarningCircle,
  cover_cancelled: WarningCircle,
  cover_expired: WarningCircle,
  availability_withdrawn: ClipboardText,
  announcement: Megaphone,
};

export function NotificationList({ manager }: { manager?: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const nav = useNavigate();
  const [filter, setFilter] = useState<'all' | 'unread' | 'unresolved'>('all');
  const q = useQuery({ queryKey: ['notifications', filter], queryFn: () => api.get<any[]>(`/api/notifications?filter=${filter}`) });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['notifications'] });
    void qc.invalidateQueries({ queryKey: ['unread'] });
  };
  const read = useMutation({ mutationFn: (id: string) => api.post(`/api/notifications/${id}/read`), onSuccess: refresh });
  const resolve = useMutation({ mutationFn: (id: string) => api.post(`/api/notifications/${id}/resolve`), onSuccess: refresh, onError: (e) => toast.error(e) });
  const readAll = useMutation({ mutationFn: () => api.post('/api/notifications/read-all'), onSuccess: refresh, onError: (e) => toast.error(e) });

  return (
    <div className="stack">
      <div className="row between wrap">
        <Segmented
          label="Filter notifications"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'All' },
            { value: 'unread', label: 'Unread' },
            ...(manager ? [{ value: 'unresolved' as const, label: 'Unresolved' }] : []),
          ]}
        />
        <Button size="sm" variant="ghost" icon={Checks} onClick={() => readAll.mutate()} loading={readAll.isPending}>
          Mark all as read
        </Button>
      </div>
      {q.error && <ErrorNotice error={q.error} />}
      {q.isLoading ? (
        <Skeleton height={220} radius={20} />
      ) : !q.data?.length ? (
        <EmptyState icon={Bell} title={filter === 'all' ? 'No notifications yet' : 'Nothing here'}>
          Schedule updates, cover requests and announcements will show up here.
        </EmptyState>
      ) : (
        <div>
          {q.data.map((n) => {
            const Ico = ICONS[n.type] ?? Bell;
            return (
              <div key={n.id} className={`notif ${n.readAt ? '' : 'unread'}`}>
                <span className="ico" aria-hidden="true">
                  <Ico size={22} />
                </span>
                <div className="grow">
                  <div className="row between wrap">
                    <strong>
                      {!n.readAt && <span className="sr-only">Unread: </span>}
                      {n.title}
                    </strong>
                    <span className="subtle nowrap">{relative(n.createdAt)}</span>
                  </div>
                  {n.body && <p className="body">{n.body}</p>}
                  <div className="row wrap" style={{ marginTop: 8, gap: 6 }}>
                    {n.branchName && <span className="subtle">{n.branchName}</span>}
                    {n.link && (
                      <Button
                        size="sm"
                        onClick={() => {
                          if (!n.readAt) read.mutate(n.id);
                          nav(n.link);
                        }}
                      >
                        Open
                      </Button>
                    )}
                    {!n.readAt && (
                      <Button size="sm" variant="ghost" onClick={() => read.mutate(n.id)}>
                        Mark as read
                      </Button>
                    )}
                    {manager && !n.resolvedAt && (
                      <Button size="sm" variant="ghost" icon={CheckCircle} onClick={() => resolve.mutate(n.id)}>
                        Resolve
                      </Button>
                    )}
                    {n.resolvedAt && <span className="pill green">Resolved</span>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
