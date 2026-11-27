import { ArrowCounterClockwise, CheckCircle, HandHeart, HandWaving, PaperPlaneTilt, Prohibit, UsersThree } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { CoverStatus } from '../../components/StatusPills';
import { Button, Confirm, EmptyState, ErrorNotice, Field, Pill, Skeleton, useToast } from '../../components/ui';
import { api } from '../../lib/api';
import { addDays, dayMonth, fullDate, shiftTime, todayLocal, weekdayName } from '../../lib/time';

export default function FindCover() {
  const loc = useLocation();
  const nav = useNavigate();
  const state = (loc.state ?? {}) as { assignmentId?: string; growFrom?: Record<string, string> };
  const [requestFor, setRequestFor] = useState<string | null>(state.assignmentId ?? null);
  const today = todayLocal();
  const style = state.growFrom
    ? ({ ['--gm-top' as any]: state.growFrom.top, ['--gm-right' as any]: state.growFrom.right, ['--gm-bottom' as any]: state.growFrom.bottom, ['--gm-left' as any]: state.growFrom.left } as React.CSSProperties)
    : undefined;
  const shifts = useQuery({ queryKey: ['my-shifts', today, 'cover'], queryFn: () => api.get<any>(`/api/me/shifts?from=${today}&to=${addDays(today, 42)}`) });
  const mine = useQuery({ queryKey: ['my-cover'], queryFn: () => api.get<any[]>('/api/me/cover-requests') });
  const opps = useQuery({ queryKey: ['opportunities'], queryFn: () => api.get<any[]>('/api/cover/opportunities') });
  const upcoming = useMemo(() => (shifts.data?.shifts ?? []).filter((s: any) => s.status === 'active' && !(s.cover && ['open', 'pending'].includes(s.cover.status))), [shifts.data]);
  const selected = upcoming.find((s: any) => s.assignmentId === requestFor);

  return (
    <div className={`page ${state.growFrom ? 'grow-morph' : ''}`} style={{ maxWidth: 980, ...style }}>
      <div className="page-head">
        <div>
          <h1>Find cover</h1>
          <p className="lead">Ask colleagues to take a shift, or help someone out. Your manager approves every swap.</p>
        </div>
      </div>
      <div className="stack lg">
        <section className="card stack">
          <h2 className="row"><HandHeart size={24} /> Ask for cover</h2>
          {shifts.isLoading ? (
            <Skeleton height={60} />
          ) : !upcoming.length ? (
            <p className="muted">You have no upcoming confirmed shifts that can be offered.</p>
          ) : (
            <>
              <Field label="Shift" htmlFor="shift">
                <select id="shift" className="select" value={requestFor ?? ''} onChange={(e) => setRequestFor(e.target.value || null)}>
                  <option value="">Choose one of your shifts…</option>
                  {upcoming.map((s: any) => (
                    <option key={s.assignmentId} value={s.assignmentId}>
                      {weekdayName(s.date)} {dayMonth(s.date)} · {s.start}–{s.end} · {s.branchName}
                    </option>
                  ))}
                </select>
              </Field>
              {selected && <RequestForm shift={selected} onDone={() => { setRequestFor(null); nav('/my/cover', { replace: true, state: {} }); }} />}
            </>
          )}
        </section>

        <section className="stack">
          <h2>My requests</h2>
          {mine.error && <ErrorNotice error={mine.error} />}
          {mine.isLoading ? <Skeleton height={100} /> : !mine.data?.length ? (
            <EmptyState icon={HandWaving} title="No requests">When you ask for cover, you can follow its progress here.</EmptyState>
          ) : (
            <div className="grid-2">{mine.data.map((r) => <MyRequest key={r.id} r={r} />)}</div>
          )}
        </section>

        <section className="stack">
          <h2>Shifts you can take</h2>
          <p className="subtle">Only shifts that fit your availability, skills and working-time limits are shown.</p>
          {opps.error && <ErrorNotice error={opps.error} />}
          {opps.isLoading ? <Skeleton height={100} /> : !opps.data?.length ? (
            <EmptyState icon={UsersThree} title="No open shifts for you right now">You will get a notification when a colleague asks for cover that you can take.</EmptyState>
          ) : (
            <div className="grid-2">{opps.data.map((o) => <Opportunity key={o.id} o={o} />)}</div>
          )}
        </section>
      </div>
    </div>
  );
}

function RequestForm({ shift, onDone }: { shift: any; onDone: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [note, setNote] = useState('');
  const m = useMutation({
    mutationFn: () => api.post<{ message: string }>('/api/me/cover-requests', { assignmentId: shift.assignmentId, note: note || undefined }),
    onSuccess: (r) => {
      toast.success('Cover request sent', r.message);
      for (const k of ['my-cover', 'my-shifts', 'my-availability']) void qc.invalidateQueries({ queryKey: [k] });
      onDone();
    },
    onError: (e) => toast.error(e, 'Request not sent'),
  });
  return (
    <div className="stack">
      <div className="list-item">
        <div className="when"><b>{shift.date.slice(8)}</b><span>{dayMonth(shift.date).split(' ')[1]}</span></div>
        <div className="grow">
          <strong>{fullDate(shift.date)}</strong>
          <div className="subtle">{shift.start}–{shift.end} · {shift.branchName}{shift.role ? ` · ${shift.role}` : ''}</div>
        </div>
      </div>
      <Field label="Message for colleagues (optional)" htmlFor="cnote">
        <textarea id="cnote" className="textarea" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <p className="subtle">You stay responsible for this shift until your manager approves a replacement.</p>
      <div className="row end">
        <Button className="choice purple" style={{ width: 'auto', minHeight: 46, fontSize: 15 }} icon={PaperPlaneTilt} loading={m.isPending} onClick={() => m.mutate()}>Ask for cover</Button>
      </div>
    </div>
  );
}

function MyRequest({ r }: { r: any }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const cancel = useMutation({
    mutationFn: () => api.post(`/api/cover-requests/${r.id}/cancel`),
    onSuccess: () => {
      toast.success('Request cancelled', 'You keep the shift.');
      setConfirm(false);
      void qc.invalidateQueries({ queryKey: ['my-cover'] });
    },
    onError: (e) => toast.error(e),
  });
  const live = r.status === 'open' || r.status === 'pending';
  return (
    <article className="card stack sm">
      <div className="row between wrap">
        <strong>{weekdayName(r.date)} {dayMonth(r.date)} · {r.start}–{r.end}</strong>
        <CoverStatus status={r.status} />
      </div>
      <span className="subtle">{r.branchName}{r.kind === 'sickness' ? ' · sickness replacement' : ''}</span>
      {r.status === 'open' && <p className="muted">Waiting for a colleague to offer.</p>}
      {r.status === 'pending' && <p className="muted">{r.claimedBy} offered to take it. Waiting for your manager.</p>}
      {r.status === 'approved' && <p className="muted">Approved{r.claimedBy ? `: ${r.claimedBy} takes this shift` : ''}. You are no longer scheduled.</p>}
      {r.status === 'rejected' && <p className="muted">Declined by your manager. You remain scheduled.{r.decisionNote ? ` “${r.decisionNote}”` : ''}</p>}
      {r.status === 'cancelled' && <p className="muted">{r.decisionNote ?? 'Cancelled.'}</p>}
      {r.interested?.length > 0 && live && (
        <div className="row wrap" style={{ gap: 6 }}>
          <span className="subtle">Interested:</span>
          {r.interested.map((i: any, k: number) => <Pill key={k} tone={i.status === 'claimed' ? 'amber' : 'blue'}>{i.firstName}</Pill>)}
        </div>
      )}
      {live && r.kind === 'swap' && (
        <Button size="sm" variant="ghost" icon={Prohibit} style={{ alignSelf: 'flex-start' }} onClick={() => setConfirm(true)}>Cancel request</Button>
      )}
      <Confirm open={confirm} onClose={() => setConfirm(false)} onConfirm={() => cancel.mutate()} title="Cancel this cover request?" confirmLabel="Cancel request" loading={cancel.isPending}>
        <p>You keep the shift. Colleagues who offered are notified.</p>
      </Confirm>
    </article>
  );
}

function Opportunity({ o }: { o: any }) {
  const qc = useQueryClient();
  const toast = useToast();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['opportunities'] });
  };
  const claim = useMutation({
    mutationFn: (mode: 'claim' | 'interest') => api.post<{ message: string; result: string }>(`/api/cover-requests/${o.id}/${mode}`),
    onSuccess: (r) => {
      toast.success(r.result === 'claimed' ? 'Offer sent' : 'Interest noted', r.message);
      refresh();
    },
    onError: (e) => toast.error(e, 'Not sent'),
  });
  const withdraw = useMutation({
    mutationFn: () => api.post(`/api/cover-requests/${o.id}/withdraw`),
    onSuccess: () => {
      toast.success('Offer withdrawn');
      refresh();
    },
    onError: (e) => toast.error(e),
  });
  return (
    <article className="card stack sm">
      <div className="row between wrap">
        <strong>{weekdayName(o.date)} {dayMonth(o.date)} · {o.start}–{o.end}</strong>
        <CoverStatus status={o.status} />
      </div>
      <span className="subtle">{o.branchName}{o.role ? ` · ${o.role}` : ''}{o.requesterFirstName ? ` · for ${o.requesterFirstName}` : o.kind === 'sickness' ? ' · a colleague is ill' : ''}</span>
      {o.note && <p className="muted">“{o.note}”</p>}
      {o.myClaim === 'claimed' && <Pill tone="amber" icon={CheckCircle}>You offered · waiting for the manager</Pill>}
      {o.myClaim === 'interested' && <Pill tone="blue" icon={CheckCircle}>You are listed as interested</Pill>}
      <div className="row wrap">
        {!o.myClaim || o.myClaim === 'withdrawn' ? (
          <>
            {o.status === 'open' ? (
              <Button size="sm" className="choice purple" style={{ width: 'auto', minHeight: 38, fontSize: 14 }} loading={claim.isPending} onClick={() => claim.mutate('claim')}>I'll take this shift</Button>
            ) : (
              <Button size="sm" loading={claim.isPending} onClick={() => claim.mutate('interest')}>I'm available as backup</Button>
            )}
          </>
        ) : ['claimed', 'interested'].includes(o.myClaim) ? (
          <Button size="sm" variant="ghost" icon={ArrowCounterClockwise} loading={withdraw.isPending} onClick={() => withdraw.mutate()}>Withdraw</Button>
        ) : null}
      </div>
    </article>
  );
}
