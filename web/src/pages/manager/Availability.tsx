import { CaretLeft, CaretRight, CheckCircle, ClipboardText, FunnelSimple, MagnifyingGlass, Minus, SealCheck, ThumbsDown, ThumbsUp, XCircle } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Drawer, EmptyState, ErrorNotice, Pill, SkillTag, Skeleton } from '../../components/ui';
import { BranchSwitcher, useBranch, useBranches } from '../../layouts/ManagerLayout';
import { api } from '../../lib/api';
import { useSkills } from '../../lib/hooks';
import { addDays, dayMonth, instant, shiftTime, todayLocal, weekDates, weekLabel, weekStartOf, weekdayShort } from '../../lib/time';

type Row = {
  id: string;
  employeeNumber: string;
  name: string;
  firstName: string;
  lastName: string;
  skills: { skillId: string; name: string; colorIndex: number; isPrimary: boolean }[];
  eligibleBranches: { branchId: string; branchName: string }[];
  preferredBranches: { branchId: string; rank: number }[];
  shiftPreferences: { slot: number; preference: number }[];
  lastSubmitted: string | null;
  entries: { date: string; slot: number; status: 'available' | 'unavailable'; note: string | null }[];
  assigned: { date: string; slot: number; branchId: string }[];
};

export default function Availability() {
  const { branchId, branch } = useBranch();
  const branches = useBranches().data ?? [];
  const skills = useSkills().data ?? [];
  const [params] = useSearchParams();
  const [week, setWeek] = useState(addDays(weekStartOf(todayLocal()), 7));
  const [search, setSearch] = useState('');
  const [skill, setSkill] = useState('');
  const [status, setStatus] = useState<'all' | 'submitted' | 'missing'>('all');
  const [slotFilter, setSlotFilter] = useState('');
  const [prefSlot, setPrefSlot] = useState('');
  const [prefBranch, setPrefBranch] = useState('');
  const [sort, setSort] = useState<'name' | 'available' | 'submitted'>('name');
  const [openId, setOpenId] = useState<string | null>(params.get('employee'));
  const dates = weekDates(week);
  const q = useQuery({
    queryKey: ['availability', branchId, week],
    queryFn: () => api.get<{ employees: Row[] }>(`/api/availability/overview?branchId=${branchId}&from=${week}&to=${addDays(week, 6)}`),
  });
  const branchName = (id: string) => branches.find((b) => b.id === id)?.name ?? 'Other branch';

  const rows = useMemo(() => {
    let r = q.data?.employees ?? [];
    if (search) {
      const s = search.toLowerCase();
      r = r.filter((e) => e.name.toLowerCase().includes(s) || e.employeeNumber.toLowerCase().includes(s));
    }
    if (skill) r = r.filter((e) => e.skills.some((x) => x.skillId === skill));
    if (status === 'submitted') r = r.filter((e) => e.entries.length > 0);
    if (status === 'missing') r = r.filter((e) => e.entries.length === 0);
    if (slotFilter) {
      const [d, s] = slotFilter.split(':');
      r = r.filter((e) => e.entries.some((x) => x.date === d && x.slot === Number(s) && x.status === 'available'));
    }
    if (prefSlot) r = r.filter((e) => e.shiftPreferences.some((p) => p.slot === Number(prefSlot) && p.preference === 1));
    if (prefBranch) r = r.filter((e) => e.preferredBranches.some((p) => p.branchId === prefBranch && p.rank === 1));
    const avail = (e: Row) => e.entries.filter((x) => x.status === 'available').length;
    return [...r].sort((a, b) =>
      sort === 'available' ? avail(b) - avail(a) : sort === 'submitted' ? Number(b.entries.length > 0) - Number(a.entries.length > 0) || a.lastName.localeCompare(b.lastName) : a.lastName.localeCompare(b.lastName),
    );
  }, [q.data, search, skill, status, slotFilter, prefSlot, prefBranch, sort]);

  const missing = (q.data?.employees ?? []).filter((e) => !e.entries.length).length;
  const selected = q.data?.employees.find((e) => e.id === openId) ?? null;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Employee availability</h1>
          <p className="lead">{branch.name}</p>
        </div>
        <BranchSwitcher />
      </div>
      <div className="sched-toolbar">
        <div className="week-nav">
          <button className="icon-btn sm" onClick={() => setWeek(addDays(week, -7))} aria-label="Previous week">
            <CaretLeft size={18} />
          </button>
          <span className="week-label">{weekLabel(week)}</span>
          <button className="icon-btn sm" onClick={() => setWeek(addDays(week, 7))} aria-label="Next week">
            <CaretRight size={18} />
          </button>
        </div>
        {q.data && (
          <>
            <Pill tone="green" icon={CheckCircle}>{q.data.employees.length - missing} submitted</Pill>
            <Pill tone={missing ? 'amber' : 'neutral'} icon={Minus}>{missing} not submitted</Pill>
          </>
        )}
      </div>

      <div className="card tight" style={{ marginBottom: 16 }}>
        <div className="row wrap" style={{ gap: 10 }}>
          <FunnelSimple size={20} aria-hidden="true" />
          <label className="row" style={{ gap: 6, flex: '1 1 200px' }}>
            <MagnifyingGlass size={18} aria-hidden="true" />
            <input className="input sm" placeholder="Name or employee number" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search employees" />
          </label>
          <select className="select sm" value={skill} onChange={(e) => setSkill(e.target.value)} aria-label="Filter by skill" style={{ width: 'auto' }}>
            <option value="">All skills</option>
            {skills.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          <select className="select sm" value={status} onChange={(e) => setStatus(e.target.value as any)} aria-label="Submission status" style={{ width: 'auto' }}>
            <option value="all">Any submission status</option>
            <option value="submitted">Submitted</option>
            <option value="missing">Not submitted</option>
          </select>
          <select className="select sm" value={slotFilter} onChange={(e) => setSlotFilter(e.target.value)} aria-label="Available for a shift" style={{ width: 'auto' }}>
            <option value="">Available for any shift</option>
            {dates.flatMap((d) => [1, 2, 3, 4].map((s) => <option key={`${d}:${s}`} value={`${d}:${s}`}>Available {weekdayShort(d)} {shiftTime(s)}</option>))}
          </select>
          <select className="select sm" value={prefSlot} onChange={(e) => setPrefSlot(e.target.value)} aria-label="Preferred shift" style={{ width: 'auto' }}>
            <option value="">Any preferred time</option>
            {[1, 2, 3, 4].map((s) => <option key={s} value={s}>Prefers {shiftTime(s)}</option>)}
          </select>
          <select className="select sm" value={prefBranch} onChange={(e) => setPrefBranch(e.target.value)} aria-label="Preferred branch" style={{ width: 'auto' }}>
            <option value="">Any preferred branch</option>
            {branches.map((b) => <option key={b.id} value={b.id}>Prefers {b.name}</option>)}
          </select>
          <select className="select sm" value={sort} onChange={(e) => setSort(e.target.value as any)} aria-label="Sort" style={{ width: 'auto' }}>
            <option value="name">Sort by name</option>
            <option value="available">Most available first</option>
            <option value="submitted">Submitted first</option>
          </select>
        </div>
      </div>

      <div className="legend" style={{ marginBottom: 10 }}>
        <span><span className="swatch" style={{ background: 'var(--blue)' }} /> Available</span>
        <span><span className="swatch" style={{ background: 'var(--red)' }} /> Unavailable</span>
        <span><span className="swatch" style={{ background: 'var(--green)' }} /> Assigned</span>
        <span><span className="swatch" style={{ background: 'var(--surface-3)' }} /> Not submitted</span>
        <span className="subtle">Each day shows four squares, one per shift (09, 12, 15, 18).</span>
      </div>

      {q.error && <ErrorNotice error={q.error} onRetry={() => void q.refetch()} />}
      {q.isLoading ? (
        <Skeleton height={400} radius={20} />
      ) : !rows.length ? (
        <EmptyState icon={ClipboardText} title={q.data?.employees.length ? 'No employees match these filters' : 'No employees in this branch yet'}>
          {q.data?.employees.length ? 'Clear a filter to see more people.' : 'Add employees under Employees. They submit availability from their own account.'}
        </EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Employee</th>
                <th>Skills</th>
                {dates.map((d) => (
                  <th key={d} style={{ textAlign: 'center' }}>
                    {weekdayShort(d)} {dayMonth(d).split(' ')[0]}
                  </th>
                ))}
                <th>Preferences</th>
                <th>Submitted</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id} className="clickable" onClick={() => setOpenId(e.id)} tabIndex={0} onKeyDown={(k) => k.key === 'Enter' && setOpenId(e.id)}>
                  <td>
                    <strong>{e.name}</strong>
                    <div className="subtle">#{e.employeeNumber}</div>
                  </td>
                  <td>
                    <div className="row wrap" style={{ gap: 6 }}>
                      {e.skills.length ? e.skills.map((s) => <SkillTag key={s.skillId} name={s.name} colorIndex={s.colorIndex} />) : <span className="subtle">None</span>}
                    </div>
                  </td>
                  {dates.map((d) => (
                    <td key={d} style={{ textAlign: 'center' }}>
                      <div className="mx-day" style={{ justifyContent: 'center' }} aria-label={`${weekdayShort(d)}: ${[1, 2, 3, 4].map((s) => statusOf(e, d, s)).join(', ')}`}>
                        {[1, 2, 3, 4].map((s) => (
                          <span key={s} className={`mx-dot ${statusOf(e, d, s)}`} title={`${shiftTime(s)}: ${statusOf(e, d, s).replace('_', ' ')}`} />
                        ))}
                      </div>
                    </td>
                  ))}
                  <td>
                    <div className="subtle">
                      {e.shiftPreferences.filter((p) => p.preference === 1).map((p) => shiftTime(p.slot)).join(', ') || 'No time preference'}
                    </div>
                    {e.preferredBranches[0] && <div className="subtle">Prefers {branchName(e.preferredBranches[0].branchId)}</div>}
                  </td>
                  <td>{e.entries.length ? <Pill tone="green" icon={SealCheck}>Yes</Pill> : <Pill tone="amber">No</Pill>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Drawer open={!!selected} onClose={() => setOpenId(null)} title={selected?.name ?? ''}>
        {selected && <EmployeeAvailability e={selected} dates={dates} branchName={branchName} />}
      </Drawer>
    </div>
  );
}

function statusOf(e: Row, d: string, s: number): 'assigned' | 'available' | 'unavailable' | 'not_submitted' {
  if (e.assigned.some((a) => a.date === d && a.slot === s)) return 'assigned';
  return e.entries.find((x) => x.date === d && x.slot === s)?.status ?? 'not_submitted';
}

function EmployeeAvailability({ e, dates, branchName }: { e: Row; dates: string[]; branchName: (id: string) => string }) {
  const history = useQuery({ queryKey: ['availability', 'history', e.id], queryFn: () => api.get<any[]>(`/api/availability/employee/${e.id}/history`) });
  const notes = e.entries.filter((x) => x.note);
  const prefIcon = (p?: number) => (p === 1 ? <ThumbsUp size={16} /> : p === -1 ? <ThumbsDown size={16} /> : <Minus size={16} />);
  return (
    <div className="stack lg">
      <dl className="dl">
        <dt>Employee number</dt>
        <dd>{e.employeeNumber}</dd>
        <dt>Eligible branches</dt>
        <dd>{e.eligibleBranches.map((b) => b.branchName).join(', ')}</dd>
        <dt>Preferred branches</dt>
        <dd>{e.preferredBranches.length ? e.preferredBranches.map((p) => `${p.rank}. ${branchName(p.branchId)}`).join(', ') : 'None given'}</dd>
        <dt>Skills</dt>
        <dd className="row wrap">{e.skills.length ? e.skills.map((s) => <SkillTag key={s.skillId} name={s.name} colorIndex={s.colorIndex} boxed />) : 'None'}</dd>
        <dt>Last submitted</dt>
        <dd>{e.lastSubmitted ? instant(e.lastSubmitted) : 'Not submitted for this week'}</dd>
      </dl>
      <section>
        <h3 style={{ marginBottom: 8 }}>Preferred working times</h3>
        <div className="row wrap">
          {[1, 2, 3, 4].map((s) => {
            const p = e.shiftPreferences.find((x) => x.slot === s)?.preference;
            return (
              <Pill key={s} tone={p === 1 ? 'green' : p === -1 ? 'red' : 'neutral'}>
                {prefIcon(p)} {shiftTime(s)}
              </Pill>
            );
          })}
        </div>
        <p className="subtle" style={{ marginTop: 6 }}>Preferences only affect ranking. They never override availability.</p>
      </section>
      <section>
        <h3 style={{ marginBottom: 8 }}>This week</h3>
        <div className="av-grid">
          <div />
          {[1, 2, 3, 4].map((s) => (
            <div key={s} className="av-head">{shiftTime(s)}</div>
          ))}
          {dates.map((d) => (
            <FragmentRow key={d} d={d} e={e} />
          ))}
        </div>
      </section>
      {notes.length > 0 && (
        <section>
          <h3 style={{ marginBottom: 8 }}>Notes</h3>
          {notes.map((n) => (
            <p key={`${n.date}${n.slot}`} className="muted">
              {weekdayShort(n.date)} {shiftTime(n.slot)}: {n.note}
            </p>
          ))}
        </section>
      )}
      <section>
        <h3 style={{ marginBottom: 8 }}>Recent changes</h3>
        {history.data?.length ? (
          <ul className="subtle" style={{ paddingLeft: 18, margin: 0 }}>
            {history.data.slice(0, 15).map((h, i) => (
              <li key={i}>
                {weekdayShort(h.date)} {dayMonth(h.date)} {shiftTime(h.slot)}: {h.from ?? 'not submitted'} → {h.to} <span>({instant(h.changedAt)})</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="subtle">No changes recorded.</p>
        )}
      </section>
    </div>
  );
}

function FragmentRow({ d, e }: { d: string; e: Row }) {
  return (
    <>
      <div className="av-day">
        <span className="dname">{weekdayShort(d)}</span>
        <span className="ddate">{dayMonth(d)}</span>
      </div>
      {[1, 2, 3, 4].map((s) => {
        const st = statusOf(e, d, s);
        const Ico = st === 'available' ? CheckCircle : st === 'unavailable' ? XCircle : st === 'assigned' ? SealCheck : Minus;
        return (
          <div key={s} className={`av-cell ${st === 'not_submitted' ? '' : st}`} style={{ cursor: 'default' }}>
            <Ico size={18} />
            <span className="lbl">{st === 'not_submitted' ? 'Not submitted' : st[0].toUpperCase() + st.slice(1)}</span>
          </div>
        );
      })}
    </>
  );
}
