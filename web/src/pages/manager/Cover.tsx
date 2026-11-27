import { CheckCircle, FirstAidKit, HandHeart, Prohibit, UserPlus, X } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { CoverStatus } from '../../components/StatusPills';
import { Button, Confirm, Drawer, EmptyState, ErrorNotice, Field, Pill, Skeleton, Tabs, useToast } from '../../components/ui';
import { BranchSwitcher, useBranch } from '../../layouts/ManagerLayout';
import { api } from '../../lib/api';
import { dayMonth, instant, shiftTime, weekdayName } from '../../lib/time';

export default function Cover() {
  const { branchId, branch } = useBranch();
  const [params] = useSearchParams();
  const [tab, setTab] = useState<'active' | 'sickness' | 'all'>((params.get('tab') as any) || 'active');
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Cover management</h1>
          <p className="lead">{branch.name}</p>
        </div>
        <BranchSwitcher />
      </div>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'active', label: 'Open requests', icon: HandHeart },
          { value: 'sickness', label: 'Sickness reports', icon: FirstAidKit },
          { value: 'all', label: 'History', icon: CheckCircle },
        ]}
      />
      {tab === 'sickness' ? <Sickness branchId={branchId} /> : <Requests branchId={branchId} status={tab === 'all' ? 'all' : 'active'} />}
    </div>
  );
}

function Requests({ branchId, status }: { branchId: string; status: 'active' | 'all' }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['cover', branchId, status], queryFn: () => api.get<any[]>(`/api/cover-requests?branchId=${branchId}&status=${status}`) });
  const [pick, setPick] = useState<any | null>(null);
  const [reject, setReject] = useState<any | null>(null);
  const [note, setNote] = useState('');
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['cover'] });
    void qc.invalidateQueries({ queryKey: ['week'] });
  };
  const approve = useMutation({
    mutationFn: ({ id, userId }: { id: string; userId: string }) => api.post(`/api/cover-requests/${id}/approve`, { userId }),
    onSuccess: () => {
      toast.success('Replacement approved', 'The schedule is updated and both employees were notified.');
      setPick(null);
      refresh();
    },
    onError: (e) => toast.error(e, 'Not approved'),
  });
  const rejectClaim = useMutation({
    mutationFn: (id: string) => api.post(`/api/cover-requests/${id}/reject-claim`, {}),
    onSuccess: () => {
      toast.success('Offer declined', 'The request is open again for other colleagues.');
      refresh();
    },
    onError: (e) => toast.error(e, 'Could not decline'),
  });
  const rejectReq = useMutation({
    mutationFn: (id: string) => api.post(`/api/cover-requests/${id}/reject`, { note: note || undefined }),
    onSuccess: (r: any) => {
      toast.success(r.status === 'rejected' ? 'Request declined' : 'Request closed');
      setReject(null);
      setNote('');
      refresh();
    },
    onError: (e) => toast.error(e, 'Could not close the request'),
  });

  if (q.isLoading) return <Skeleton height={240} radius={20} />;
  if (q.error) return <ErrorNotice error={q.error} onRetry={() => void q.refetch()} />;
  if (!q.data?.length)
    return (
      <EmptyState icon={HandHeart} title={status === 'active' ? 'No open requests' : 'No cover history yet'}>
        When an employee asks for cover or reports sick, the request appears here for review.
      </EmptyState>
    );
  return (
    <div className="grid-2">
      {q.data.map((r) => {
        const claimant = r.claims.find((c: any) => c.status === 'claimed');
        const interested = r.claims.filter((c: any) => c.status === 'interested');
        const live = r.status === 'open' || r.status === 'pending';
        return (
          <article key={r.id} className="card">
            <div className="card-head">
              <div>
                <h3>
                  {weekdayName(r.date)} {dayMonth(r.date)} · {r.start}–{r.end}
                </h3>
                <div className="muted">
                  {r.kind === 'sickness' ? 'Replacement for' : 'Requested by'} {r.requesterName}
                  {r.role ? ` · ${r.role}` : ''}
                </div>
              </div>
              <div className="row wrap" style={{ justifyContent: 'flex-end' }}>
                {r.kind === 'sickness' && <Pill tone="yellow" icon={FirstAidKit}>Sickness</Pill>}
                <CoverStatus status={r.status} />
              </div>
            </div>
            {r.note && <p className="muted" style={{ marginBottom: 10 }}>“{r.note}”</p>}
            {claimant && live && (
              <div className="banner info" style={{ marginBottom: 10 }}>
                <span className="grow">
                  <strong>{claimant.name}</strong> offered to take this shift.
                </span>
                <Button size="sm" variant="primary" loading={approve.isPending} onClick={() => approve.mutate({ id: r.id, userId: claimant.userId })}>
                  Approve
                </Button>
                <Button size="sm" variant="ghost" onClick={() => rejectClaim.mutate(r.id)} loading={rejectClaim.isPending}>
                  Decline
                </Button>
              </div>
            )}
            {interested.length > 0 && live && (
              <div className="stack sm" style={{ marginBottom: 10 }}>
                <span className="label">Also interested</span>
                {interested.map((c: any) => (
                  <div key={c.userId} className="row between">
                    <span>{c.name}</span>
                    <Button size="sm" onClick={() => approve.mutate({ id: r.id, userId: c.userId })}>
                      Approve instead
                    </Button>
                  </div>
                ))}
              </div>
            )}
            {r.replacement && <p className="muted">Replaced by {r.replacement.name}{r.decidedBy ? `, approved by ${r.decidedBy}` : ''} {instant(r.decidedAt)}</p>}
            {r.decisionNote && !live && <p className="subtle">{r.decisionNote}</p>}
            {live && (
              <div className="row wrap" style={{ marginTop: 8 }}>
                <Button size="sm" icon={UserPlus} onClick={() => setPick(r)}>
                  Choose replacement
                </Button>
                <Button size="sm" variant="ghost" icon={r.kind === 'sickness' ? Prohibit : X} onClick={() => setReject(r)}>
                  {r.kind === 'sickness' ? 'Close without replacement' : 'Decline request'}
                </Button>
              </div>
            )}
          </article>
        );
      })}
      {pick && <PickReplacement r={pick} onClose={() => setPick(null)} onApprove={(userId) => approve.mutate({ id: pick.id, userId })} busy={approve.isPending} />}
      <Confirm
        open={!!reject}
        onClose={() => setReject(null)}
        onConfirm={() => rejectReq.mutate(reject.id)}
        title={reject?.kind === 'sickness' ? 'Close without a replacement?' : 'Decline this cover request?'}
        confirmLabel={reject?.kind === 'sickness' ? 'Close request' : 'Decline'}
        danger
        loading={rejectReq.isPending}
      >
        <div className="stack">
          <p>{reject?.kind === 'sickness' ? 'The shift stays short-staffed. You can still add someone from the schedule.' : `${reject?.requesterName} keeps the shift and will be notified.`}</p>
          <Field label="Note for the employee (optional)" htmlFor="rnote">
            <textarea id="rnote" className="textarea" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>
      </Confirm>
    </div>
  );
}

function PickReplacement({ r, onClose, onApprove, busy }: { r: any; onClose: () => void; onApprove: (userId: string) => void; busy: boolean }) {
  const q = useQuery({ queryKey: ['cover', 'candidates', r.id], queryFn: () => api.get<any[]>(`/api/cover-requests/${r.id}/candidates`) });
  const eligible = (q.data ?? []).filter((c) => c.eligible);
  const blocked = (q.data ?? []).filter((c) => !c.eligible);
  return (
    <Drawer open onClose={onClose} title="Choose a replacement">
      <p className="muted" style={{ marginBottom: 12 }}>
        {weekdayName(r.date)} {dayMonth(r.date)} · {shiftTime(r.slot)}
        {r.role ? ` · ${r.role}` : ''}. Only employees who pass every rule can be chosen.
      </p>
      {q.isLoading && <Skeleton height={200} />}
      {eligible.map((c) => (
        <div key={c.userId} className="cand">
          <strong className="grow">{c.name}</strong>
          <Button size="sm" variant="primary" loading={busy} onClick={() => onApprove(c.userId)}>
            Assign
          </Button>
        </div>
      ))}
      {q.data && !eligible.length && <EmptyState icon={UserPlus} title="Nobody is eligible">See the reasons below.</EmptyState>}
      {blocked.length > 0 && (
        <details style={{ marginTop: 14 }}>
          <summary className="btn ghost sm">Not eligible ({blocked.length})</summary>
          {blocked.map((c) => (
            <div key={c.userId} className="cand no">
              <div>
                <strong>{c.name}</strong>
                <ul className="reasons">
                  {c.reasons.map((x: string) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              </div>
            </div>
          ))}
        </details>
      )}
    </Drawer>
  );
}

function Sickness({ branchId }: { branchId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['sickness', branchId], queryFn: () => api.get<any[]>(`/api/sickness?branchId=${branchId}`) });
  const ack = useMutation({
    mutationFn: (id: string) => api.post(`/api/sickness/${id}/acknowledge`, {}),
    onSuccess: () => {
      toast.success('Acknowledged');
      void qc.invalidateQueries({ queryKey: ['sickness'] });
    },
    onError: (e) => toast.error(e),
  });
  if (q.isLoading) return <Skeleton height={200} radius={20} />;
  if (q.error) return <ErrorNotice error={q.error} />;
  if (!q.data?.length)
    return (
      <EmptyState icon={FirstAidKit} title="No sickness reports">
        Reports from the last 30 days and upcoming shifts appear here. No medical details are collected.
      </EmptyState>
    );
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Employee</th>
            <th>Date</th>
            <th>Shifts</th>
            <th>Note</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {q.data.map((s) => (
            <tr key={s.id}>
              <td><strong>{s.name}</strong></td>
              <td className="nowrap">{weekdayName(s.date)} {dayMonth(s.date)}</td>
              <td>
                <div className="row wrap" style={{ gap: 6 }}>
                  {s.shifts.map((x: any) => (
                    <span key={x.assignmentId} className="row" style={{ gap: 4 }}>
                      {shiftTime(x.slot)} {x.cover && <CoverStatus status={x.cover.status} />}
                    </span>
                  ))}
                </div>
              </td>
              <td className="muted">{s.note ?? '–'}</td>
              <td>{s.status === 'reported' ? <Pill tone="yellow">New</Pill> : <Pill tone="green">Acknowledged{ s.reviewedBy ? ` by ${s.reviewedBy}` : ''}</Pill>}</td>
              <td>
                {s.status === 'reported' && (
                  <Button size="sm" onClick={() => ack.mutate(s.id)} loading={ack.isPending && ack.variables === s.id}>
                    Acknowledge
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
