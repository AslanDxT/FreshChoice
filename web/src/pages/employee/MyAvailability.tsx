import { ArrowsLeftRight, CalendarBlank, CalendarDots, CaretLeft, CaretRight, CheckCircle, Circle, FirstAidKit, HourglassHigh, PaperPlaneTilt, SealCheck, XCircle } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Button, Confirm, ErrorNotice, Modal, Pill, Segmented, Skeleton, useToast } from '../../components/ui';
import { api } from '../../lib/api';
import { addDays, addMonths, dayMonth, fullDate, monthName, monthOf, monthRange, shiftTime, todayLocal, weekLabel, weekStartOf, weekdayName, weekdayShort, SHIFTS } from '../../lib/time';
import { ShiftActionModal, type ConfirmedShift } from './ShiftActions';

type St = 'available' | 'unavailable';
type Period = 'week' | 'month';

interface Data {
  today: string;
  entries: { date: string; slot: number; status: St; note: string | null }[];
  assigned: { assignmentId: string; date: string; slot: number; status: 'active' | 'sick' | 'replaced'; branchName: string; coverStatus: string | null }[];
  deadlines: { weekStart: string; deadline: string; branchName: string }[];
  submissions: { periodType: string; startDate: string; endDate: string; submittedAt: string; entryCount: number }[];
}

export default function MyAvailability() {
  const qc = useQueryClient();
  const toast = useToast();
  const today = todayLocal();
  const [period, setPeriod] = useState<Period>('week');
  const [week, setWeek] = useState(addDays(weekStartOf(today), 7));
  const [month, setMonth] = useState(monthOf(addDays(today, 14)));
  const [draft, setDraft] = useState<Map<string, St>>(new Map());
  const [picking, setPicking] = useState<{ date: string; slot: number } | null>(null);
  const [confirmed, setConfirmed] = useState<ConfirmedShift | null>(null);
  const [review, setReview] = useState(false);
  const [pendingNav, setPendingNav] = useState<(() => void) | null>(null);

  const range = period === 'week' ? { from: week, to: addDays(week, 6) } : monthRange(month);
  const startDate = period === 'week' ? week : range.from;
  const q = useQuery({ queryKey: ['my-availability', range.from, range.to], queryFn: () => api.get<Data>(`/api/me/availability?from=${range.from}&to=${range.to}`) });
  const dates = useMemo(() => {
    const out: string[] = [];
    for (let d = range.from; d <= range.to; d = addDays(d, 1)) out.push(d);
    return out;
  }, [range.from, range.to]);

  const guard = (fn: () => void) => (draft.size ? setPendingNav(() => fn) : fn());
  const saved = (d: string, s: number) => q.data?.entries.find((e) => e.date === d && e.slot === s)?.status;
  const assignedAt = (d: string, s: number) => q.data?.assigned.find((a) => a.date === d && a.slot === s);
  const stateOf = (d: string, s: number) => {
    const a = assignedAt(d, s);
    if (a) return a.status === 'active' ? 'assigned' : a.status;
    return draft.get(`${d}:${s}`) ?? saved(d, s) ?? 'none';
  };

  const submit = useMutation({
    mutationFn: () =>
      api.post<{ saved: number; changed: number }>('/api/me/availability', {
        periodType: period,
        startDate,
        entries: [...draft.entries()].map(([k, status]) => {
          const [date, slot] = k.split(':');
          return { date, slot: Number(slot), status };
        }),
      }),
    onSuccess: (r) => {
      toast.success('Availability submitted', `${r.saved} shift${r.saved === 1 ? '' : 's'} saved. Your manager can see it now.`);
      setDraft(new Map());
      setReview(false);
      void qc.invalidateQueries({ queryKey: ['my-availability'] });
      void qc.invalidateQueries({ queryKey: ['my-home'] });
    },
    onError: (e) => toast.error(e, 'Not submitted'),
  });

  const setCell = (d: string, s: number, st: St) => {
    const next = new Map(draft);
    if (saved(d, s) === st) next.delete(`${d}:${s}`);
    else next.set(`${d}:${s}`, st);
    setDraft(next);
  };
  const fillRemaining = (st: St) => {
    const next = new Map(draft);
    for (const d of dates) {
      if (d < today) continue;
      for (const s of SHIFTS) if (!assignedAt(d, s.slot) && !saved(d, s.slot) && !next.has(`${d}:${s.slot}`)) next.set(`${d}:${s.slot}`, st);
    }
    setDraft(next);
  };
  const deadline = q.data?.deadlines.find((x) => x.weekStart >= weekStartOf(range.from) && x.weekStart <= range.to);
  const unsubmittedCount = dates.filter((d) => d >= today).reduce((n, d) => n + SHIFTS.filter((s) => stateOf(d, s.slot) === 'none').length, 0);

  return (
    <div className="page" style={{ maxWidth: 980 }}>
      <div className="page-head">
        <div>
          <h1>My availability</h1>
          <p className="lead">Tap a shift to say whether you can work it. Your manager schedules only from submitted availability.</p>
        </div>
      </div>
      <div className="sched-toolbar">
        <Segmented<Period>
          label="Period"
          value={period}
          onChange={(p) => guard(() => setPeriod(p))}
          options={[
            { value: 'week', label: 'One week', icon: CalendarDots },
            { value: 'month', label: 'One month', icon: CalendarBlank },
          ]}
        />
        <div className="week-nav">
          <button className="icon-btn sm" aria-label="Previous" onClick={() => guard(() => (period === 'week' ? setWeek(addDays(week, -7)) : setMonth(addMonths(month, -1))))}>
            <CaretLeft size={18} />
          </button>
          <span className="week-label">{period === 'week' ? weekLabel(week) : monthName(month)}</span>
          <button className="icon-btn sm" aria-label="Next" onClick={() => guard(() => (period === 'week' ? setWeek(addDays(week, 7)) : setMonth(addMonths(month, 1))))}>
            <CaretRight size={18} />
          </button>
        </div>
        {deadline && <Pill tone="teal" icon={HourglassHigh}>Due {weekdayShort(deadline.deadline)} {dayMonth(deadline.deadline)}</Pill>}
      </div>

      <div className="legend" style={{ marginBottom: 14 }}>
        <span><Circle size={16} /> Not submitted</span>
        <span><CheckCircle size={16} style={{ color: 'var(--blue)' }} /> Available</span>
        <span><XCircle size={16} style={{ color: 'var(--red)' }} /> Unavailable</span>
        <span><SealCheck size={16} style={{ color: 'var(--green)' }} /> Assigned (confirmed shift)</span>
        <span><span className="swatch" style={{ background: 'var(--primary)', borderRadius: 99, width: 9, height: 9 }} /> Changed, not submitted yet</span>
      </div>

      {q.error && <ErrorNotice error={q.error} onRetry={() => void q.refetch()} />}
      {q.isLoading ? (
        <Skeleton height={420} radius={20} />
      ) : (
        <>
          {unsubmittedCount > 0 && (
            <div className="row wrap" style={{ marginBottom: 12 }}>
              <span className="subtle">{unsubmittedCount} open shift{unsubmittedCount === 1 ? '' : 's'} without an answer.</span>
              <Button size="sm" onClick={() => fillRemaining('available')}>Mark the rest available</Button>
              <Button size="sm" variant="ghost" onClick={() => fillRemaining('unavailable')}>Mark the rest unavailable</Button>
            </div>
          )}
          <div className="card" style={{ padding: 14 }}>
            <div className="av-grid" role="grid" aria-label="Availability per shift">
              <div />
              {SHIFTS.map((s) => (
                <div key={s.slot} className="av-head" role="columnheader">{s.start}–{s.end}</div>
              ))}
              {dates.map((d) => (
                <Row key={d} d={d} today={today} stateOf={stateOf} dirty={(s) => draft.has(`${d}:${s}`)} onPick={(slot) => {
                  const a = assignedAt(d, slot);
                  if (a) {
                    if (a.status === 'active' && d >= today) setConfirmed({ assignmentId: a.assignmentId, date: d, slot, branchName: a.branchName, coverStatus: a.coverStatus });
                    return;
                  }
                  if (d >= today) setPicking({ date: d, slot });
                }} />
              ))}
            </div>
          </div>
          {q.data?.submissions[0] && <p className="subtle" style={{ marginTop: 10 }}>Last submitted {new Date(q.data.submissions[0].submittedAt).toLocaleString('en-GB', { timeZone: 'Europe/Amsterdam', dateStyle: 'medium', timeStyle: 'short' })}.</p>}
        </>
      )}

      {draft.size > 0 && (
        <div className="submit-bar" role="region" aria-label="Unsubmitted changes">
          <span><strong>{draft.size}</strong> change{draft.size === 1 ? '' : 's'} not submitted yet</span>
          <div className="row">
            <Button size="sm" variant="ghost" style={{ color: 'inherit' }} onClick={() => setDraft(new Map())}>Discard</Button>
            <Button size="sm" variant="primary" icon={PaperPlaneTilt} onClick={() => setReview(true)}>Review and submit</Button>
          </div>
        </div>
      )}

      {picking && (
        <Modal open onClose={() => setPicking(null)} title={`${weekdayName(picking.date)} ${dayMonth(picking.date)}`} description={`Shift ${shiftTime(picking.slot)}`}>
          <div className="stack">
            <button className="choice blue" data-autofocus onClick={() => { setCell(picking.date, picking.slot, 'available'); setPicking(null); }}>
              <span className="ico"><CheckCircle size={24} /></span>
              <span>Available<small>I can and want to work this shift</small></span>
            </button>
            <button className="choice red" onClick={() => { setCell(picking.date, picking.slot, 'unavailable'); setPicking(null); }}>
              <span className="ico"><XCircle size={24} /></span>
              <span>Unavailable<small>I cannot work this shift</small></span>
            </button>
            <div className="row end">
              <Button variant="ghost" size="sm" onClick={() => setPicking(null)}>Cancel</Button>
            </div>
          </div>
        </Modal>
      )}

      <ShiftActionModal shift={confirmed} onClose={() => setConfirmed(null)} />

      <Modal
        open={review}
        onClose={() => setReview(false)}
        title="Review your availability"
        description={period === 'week' ? weekLabel(week) : monthName(month)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setReview(false)}>Keep editing</Button>
            <Button variant="primary" icon={PaperPlaneTilt} loading={submit.isPending} onClick={() => submit.mutate()}>Submit {draft.size} change{draft.size === 1 ? '' : 's'}</Button>
          </>
        }
      >
        <div className="stack sm" style={{ maxHeight: '50vh', overflow: 'auto' }}>
          {[...draft.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, st]) => {
            const [d, s] = k.split(':');
            return (
              <div key={k} className="row between list-item" style={{ padding: '10px 14px' }}>
                <span>{weekdayShort(d)} {dayMonth(d)} · {shiftTime(Number(s))}</span>
                {st === 'available' ? <Pill tone="blue" icon={CheckCircle}>Available</Pill> : <Pill tone="red" icon={XCircle}>Unavailable</Pill>}
              </div>
            );
          })}
        </div>
        <p className="subtle" style={{ marginTop: 12 }}>Being available is not a confirmed shift. Confirmed shifts turn green once your manager publishes the schedule.</p>
      </Modal>

      <Confirm open={!!pendingNav} onClose={() => setPendingNav(null)} onConfirm={() => { setDraft(new Map()); pendingNav?.(); setPendingNav(null); }} title="Discard unsubmitted changes?" confirmLabel="Discard" danger>
        <p>You have {draft.size} change{draft.size === 1 ? '' : 's'} that were not submitted. They will be lost.</p>
      </Confirm>
    </div>
  );
}

function Row({ d, today, stateOf, dirty, onPick }: { d: string; today: string; stateOf: (d: string, s: number) => string; dirty: (s: number) => boolean; onPick: (slot: number) => void }) {
  const past = d < today;
  return (
    <>
      <div className="av-day" role="rowheader">
        <span className="dname">{weekdayShort(d)}</span>
        <span className="ddate">{dayMonth(d)}</span>
      </div>
      {SHIFTS.map((s) => {
        const st = stateOf(d, s.slot);
        const meta: Record<string, { icon: any; label: string; cls: string }> = {
          none: { icon: Circle, label: 'Not submitted', cls: '' },
          available: { icon: CheckCircle, label: 'Available', cls: 'available' },
          unavailable: { icon: XCircle, label: 'Unavailable', cls: 'unavailable' },
          assigned: { icon: SealCheck, label: 'Assigned', cls: 'assigned' },
          sick: { icon: FirstAidKit, label: 'Sick', cls: 'sick' },
          replaced: { icon: ArrowsLeftRight, label: 'Covered', cls: 'replaced' },
        };
        const m = meta[st] ?? meta.none;
        const isDirty = dirty(s.slot);
        return (
          <button
            key={s.slot}
            type="button"
            className={`av-cell ${m.cls} ${past ? 'past' : ''} ${isDirty ? 'dirty' : ''}`}
            onClick={() => onPick(s.slot)}
            disabled={past && st !== 'assigned'}
            aria-label={`${fullDate(d)} ${s.start} to ${s.end}: ${m.label}${isDirty ? ', not submitted yet' : ''}`}
          >
            <m.icon size={20} weight={st === 'none' ? 'light' : 'regular'} />
            <span className="lbl">{m.label}</span>
          </button>
        );
      })}
    </>
  );
}

