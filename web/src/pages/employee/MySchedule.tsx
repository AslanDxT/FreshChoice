import { ArrowsLeftRight, CalendarCheck, CaretLeft, CaretRight, Coffee, FirstAidKit } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { CoverStatus } from '../../components/StatusPills';
import { Button, EmptyState, ErrorNotice, Pill, Skeleton } from '../../components/ui';
import { api } from '../../lib/api';
import { addDays, dayMonth, todayLocal, weekDates, weekLabel, weekStartOf, weekdayName } from '../../lib/time';
import { ShiftActionModal, type ConfirmedShift } from './ShiftActions';

export default function MySchedule() {
  const today = todayLocal();
  const [params, setParams] = useSearchParams();
  const week = params.get('week') ?? weekStartOf(today);
  const setWeek = (w: string) => setParams({ week: w }, { replace: true });
  const [active, setActive] = useState<ConfirmedShift | null>(null);
  const q = useQuery({ queryKey: ['my-shifts', week], queryFn: () => api.get<any>(`/api/me/shifts?from=${week}&to=${addDays(week, 6)}`) });
  const shifts = q.data?.shifts ?? [];
  const total = shifts.filter((s: any) => s.status === 'active').length;
  return (
    <div className="page" style={{ maxWidth: 900 }}>
      <div className="page-head">
        <div>
          <h1>My schedule</h1>
          <p className="lead">Your confirmed shifts. Tap a shift to call in sick or find cover.</p>
        </div>
      </div>
      <div className="sched-toolbar">
        <div className="week-nav">
          <button className="icon-btn sm" aria-label="Previous week" onClick={() => setWeek(addDays(week, -7))}><CaretLeft size={18} /></button>
          <span className="week-label">{weekLabel(week)}</span>
          <button className="icon-btn sm" aria-label="Next week" onClick={() => setWeek(addDays(week, 7))}><CaretRight size={18} /></button>
        </div>
        <Button size="sm" variant="ghost" onClick={() => setWeek(weekStartOf(today))}>This week</Button>
        {q.data && <Pill tone="green">{total} shift{total === 1 ? '' : 's'}</Pill>}
      </div>
      {q.error && <ErrorNotice error={q.error} onRetry={() => void q.refetch()} />}
      {q.isLoading ? (
        <Skeleton height={300} radius={20} />
      ) : !shifts.length ? (
        <EmptyState icon={CalendarCheck} title="No confirmed shifts this week">
          Shifts appear here after your manager publishes the schedule. Make sure your availability is submitted.
        </EmptyState>
      ) : (
        <div className="stack">
          {weekDates(week).map((d) => {
            const day = shifts.filter((s: any) => s.date === d);
            if (!day.length) return null;
            const brk = q.data.breaks.filter((b: any) => b.date === d);
            return (
              <section key={d} className="card">
                <div className="card-head">
                  <h3>{weekdayName(d)} {dayMonth(d)}{d === today && <Pill tone="coral">Today</Pill>}</h3>
                  {brk.map((b: any) => <Pill key={b.start} tone="teal" icon={Coffee}>Break {b.start}–{b.end}</Pill>)}
                </div>
                {day.map((s: any) => {
                  const actionable = s.status === 'active' && d >= today;
                  return (
                    <button
                      key={s.assignmentId}
                      className="list-item"
                      style={{ width: '100%', border: 0, cursor: actionable ? 'pointer' : 'default', textAlign: 'left', background: s.status === 'active' ? 'var(--green-soft)' : undefined }}
                      onClick={() => actionable && setActive({ assignmentId: s.assignmentId, date: s.date, slot: s.slot, branchName: s.branchName, role: s.role, coverStatus: s.cover?.status })}
                      disabled={!actionable}
                    >
                      <div className="when"><b>{s.start.slice(0, 2)}</b><span>{s.start.slice(3)}</span></div>
                      <div className="grow">
                        <strong style={{ textDecoration: s.status !== 'active' ? 'line-through' : undefined }}>{s.start}–{s.end}</strong>
                        <div className="subtle">{s.branchName}{s.role ? ` · ${s.role}` : ''}</div>
                      </div>
                      {s.status === 'sick' && <Pill tone="yellow" icon={FirstAidKit}>Reported sick</Pill>}
                      {s.status === 'replaced' && <Pill icon={ArrowsLeftRight}>Covered by a colleague</Pill>}
                      {s.status === 'active' && s.cover && ['open', 'pending'].includes(s.cover.status) && <CoverStatus status={s.cover.status} />}
                    </button>
                  );
                })}
              </section>
            );
          })}
        </div>
      )}
      <ShiftActionModal shift={active} onClose={() => setActive(null)} />
    </div>
  );
}
