import {
  CalendarBlank,
  CalendarDot,
  CalendarDots,
  CaretLeft,
  CaretRight,
  ClockCounterClockwise,
  Coffee,
  FirstAidKit,
  HourglassHigh,
  Lightning,
  ListChecks,
  PaperPlaneTilt,
  WarningCircle,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ScheduleStatus } from '../../components/StatusPills';
import { Button, Drawer, EmptyState, ErrorNotice, Field, Modal, PageLoader, Pill, Segmented, SkillTag, Skeleton, useToast } from '../../components/ui';
import { BranchSwitcher, useBranch } from '../../layouts/ManagerLayout';
import { api } from '../../lib/api';
import { skillMap, useSkills, useWeek, type Issue, type WeekAssignment, type WeekData } from '../../lib/hooks';
import {
  addDays,
  addMonths,
  dayMonth,
  fullDate,
  instant,
  isoWeekNumber,
  monthName,
  monthOf,
  monthRange,
  shiftTime,
  todayLocal,
  weekLabel,
  weekStartOf,
  weekdayName,
  weekdayShort,
} from '../../lib/time';
import { AssignmentModal, CandidatesDrawer, IssueList, ShiftCell, apiErrorIssues, cellData, shortName } from './schedule-parts';

type View = 'week' | 'month' | 'day';

export default function Schedule() {
  const { branchId, branch } = useBranch();
  const [params, setParams] = useSearchParams();
  const today = todayLocal();
  const view = (params.get('view') as View) || 'week';
  const week = params.get('week') ?? weekStartOf(today);
  const day = params.get('day') ?? (weekStartOf(today) === week ? today : week);
  const month = params.get('month') ?? monthOf(view === 'month' ? today : week);
  const set = (patch: Record<string, string>) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) p.set(k, v);
    setParams(p, { replace: true });
  };

  const weekForData = view === 'day' ? weekStartOf(day) : week;
  const wq = useWeek(branchId, weekForData);
  const skillsQ = useSkills();
  const skills = useMemo(() => skillMap(skillsQ.data), [skillsQ.data]);

  const [seat, setSeat] = useState<{ date: string; slot: number } | null>(null);
  const [replace, setReplace] = useState<WeekAssignment | null>(null);
  const [selected, setSelected] = useState<WeekAssignment | null>(null);
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [validated, setValidated] = useState<{ issues: Issue[]; revision: number; policyNote?: string | null } | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [genOpen, setGenOpen] = useState(false);
  const [pubOpen, setPubOpen] = useState(false);
  const [histOpen, setHistOpen] = useState(false);
  const [deadlineOpen, setDeadlineOpen] = useState(false);

  useEffect(() => {
    setValidated(null);
  }, [branchId, weekForData, wq.data?.schedule?.revision]);

  const step = (dir: number) => {
    if (view === 'month') set({ month: addMonths(month, dir) });
    else if (view === 'day') {
      const d = addDays(day, dir);
      set({ day: d, week: weekStartOf(d) });
    } else set({ week: addDays(week, dir * 7) });
  };
  const goToday = () => set({ week: weekStartOf(today), day: today, month: monthOf(today) });

  const data = wq.data;
  const errorCount = data?.issues.filter((i) => i.severity === 'error').length ?? 0;
  const jump = (i: Issue) => {
    setIssuesOpen(false);
    if (!i.date) return;
    if (view !== 'week' && view !== 'day') set({ view: 'week', week: weekStartOf(i.date) });
    const id = `${i.date}-${i.slot ?? 1}`;
    setHighlight(id);
    window.setTimeout(() => document.getElementById(`cell-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' }), 60);
    window.setTimeout(() => setHighlight(null), 4000);
  };

  return (
    <div className="page full" style={{ maxWidth: 1800 }}>
      <div className="page-head">
        <div>
          <h1>Schedule</h1>
          <p className="lead">{branch.name}</p>
        </div>
        <BranchSwitcher />
      </div>

      <div className="sched-toolbar">
        <div className="week-nav">
          <button className="icon-btn sm" onClick={() => step(-1)} aria-label={`Previous ${view}`}>
            <CaretLeft size={18} />
          </button>
          <span className="week-label" aria-live="polite">
            {view === 'month' ? monthName(month) : view === 'day' ? `${weekdayShort(day)} ${dayMonth(day)}` : `Week ${isoWeekNumber(week)} · ${weekLabel(week)}`}
          </span>
          <button className="icon-btn sm" onClick={() => step(1)} aria-label={`Next ${view}`}>
            <CaretRight size={18} />
          </button>
        </div>
        <Button size="sm" variant="ghost" onClick={goToday}>
          Today
        </Button>
        <Segmented<View>
          label="Schedule view"
          value={view}
          onChange={(v) => set(v === 'month' ? { view: v, month: monthOf(view === 'day' ? day : week) } : v === 'day' ? { view: v, day: weekStartOf(day) === week ? day : week, week } : { view: v, week: weekStartOf(view === 'day' ? day : week) })}
          options={[
            { value: 'week', label: 'Weekly', icon: CalendarDots },
            { value: 'month', label: 'Monthly', icon: CalendarBlank },
            { value: 'day', label: 'Daily', icon: CalendarDot },
          ]}
        />
        <div className="grow" />
        {view !== 'month' && data && (
          <div className="row wrap">
            <ScheduleStatus status={data.schedule?.status ?? 'none'} changed={data.schedule?.status === 'published' && data.schedule.hasUnpublishedChanges} />
            {data.schedule?.availabilityDeadline && (
              <Pill tone="teal" icon={HourglassHigh}>
                Availability due {dayMonth(data.schedule.availabilityDeadline)}
              </Pill>
            )}
            <Button size="sm" icon={HourglassHigh} variant="ghost" onClick={() => setDeadlineOpen(true)}>
              Deadline
            </Button>
            <Button size="sm" icon={ClockCounterClockwise} variant="ghost" onClick={() => setHistOpen(true)} disabled={!data.schedule}>
              History
            </Button>
            <Button size="sm" icon={ListChecks} onClick={() => setIssuesOpen(true)}>
              Problems {errorCount ? <Pill tone="red">{errorCount}</Pill> : <Pill tone="green">0</Pill>}
            </Button>
            <Button size="sm" icon={Lightning} onClick={() => setGenOpen(true)}>
              Generate
            </Button>
            <Button size="sm" variant="primary" icon={PaperPlaneTilt} onClick={() => setPubOpen(true)} disabled={!data.schedule || !data.schedule.hasUnpublishedChanges}>
              {data.schedule?.status === 'published' ? 'Publish changes' : 'Publish'}
            </Button>
          </div>
        )}
      </div>

      {view === 'month' ? (
        <MonthView branchId={branchId} month={month} onPick={(d) => set({ view: 'day', day: d, week: weekStartOf(d) })} />
      ) : wq.isLoading ? (
        <div className="stack">
          <Skeleton height={56} />
          <Skeleton height={420} />
        </div>
      ) : wq.error ? (
        <ErrorNotice error={wq.error} onRetry={() => void wq.refetch()} />
      ) : data ? (
        <>
          {data.employees.length === 0 && (
            <div className="banner info" style={{ marginBottom: 14 }}>
              <WarningCircle size={22} /> This branch has no employees yet. Add employees under Employees, then ask them to submit availability.
            </div>
          )}
          {view === 'week' ? (
            <>
              <div className="week-grid-wrap mobile-stack">
                <div className="week-grid" style={{ ['--cell-min' as any]: `${cellPairs(data) * 112 + 22}px` }}>
                  <div className="wg-corner">Day</div>
                  {data.templates.map((t) => (
                    <div className="wg-head" key={t.slot}>
                      <strong>{t.start}–{t.end}</strong> Shift {t.slot}
                    </div>
                  ))}
                  {data.dates.map((d) => (
                    <DayRow key={d} d={d} data={data} today={today} skills={skills} highlight={highlight} onSeat={(date, slot) => setSeat({ date, slot })} onCard={setSelected} />
                  ))}
                </div>
              </div>
              <MobileWeek data={data} skills={skills} today={today} onSeat={(date, slot) => setSeat({ date, slot })} onCard={setSelected} />
            </>
          ) : (
            <DayView data={data} date={day} skills={skills} onSeat={(slot) => setSeat({ date: day, slot })} onCard={setSelected} />
          )}
        </>
      ) : null}

      {data && seat && (
        <CandidatesDrawer open onClose={() => setSeat(null)} branchId={branchId} weekStart={data.weekStart} date={seat.date} slot={seat.slot} data={data} skills={skills} />
      )}
      {data && replace && (
        <CandidatesDrawer open onClose={() => setReplace(null)} branchId={branchId} weekStart={data.weekStart} date={replace.date} slot={replace.slot} data={data} skills={skills} replace={replace} />
      )}
      {data && (
        <AssignmentModal
          a={selected}
          onClose={() => setSelected(null)}
          data={data}
          skills={skills}
          branchId={branchId}
          onReplace={(a) => {
            setSelected(null);
            setReplace(a);
          }}
        />
      )}
      {data && (
        <Drawer open={issuesOpen} onClose={() => setIssuesOpen(false)} title="Validation report">
          <div className="stack">
            <p className="muted">
              Checked live against staffing, role coverage, breaks, availability, working-time limits and rest rules. Errors block publication.
            </p>
            {validated?.policyNote && <div className="banner warn">{validated.policyNote}</div>}
            <IssueList issues={validated?.issues ?? data.issues} onJump={jump} />
          </div>
        </Drawer>
      )}
      {data && <GenerateModal open={genOpen} onClose={() => setGenOpen(false)} data={data} branchId={branchId} onIssues={() => setIssuesOpen(true)} />}
      {data?.schedule && <PublishModal open={pubOpen} onClose={() => setPubOpen(false)} data={data} onIssues={(v) => { setValidated(v); setIssuesOpen(true); }} />}
      {data?.schedule && <HistoryDrawer open={histOpen} onClose={() => setHistOpen(false)} scheduleId={data.schedule.id} />}
      {data && <DeadlineModal open={deadlineOpen} onClose={() => setDeadlineOpen(false)} data={data} branchId={branchId} />}
    </div>
  );
}

/** Widest shift (in stacked pairs) so all four columns line up. */
function cellPairs(data: WeekData) {
  let max = 1;
  for (const r of data.requirements) {
    const people = data.assignments.filter((a) => a.date === r.date && a.slot === r.slot && a.status !== 'replaced').length;
    max = Math.max(max, Math.ceil(Math.max(r.minStaff, people) / 2));
  }
  return max;
}

function DayRow({ d, data, today, skills, highlight, onSeat, onCard }: { d: string; data: WeekData; today: string; skills: Map<string, any>; highlight: string | null; onSeat: (date: string, slot: number) => void; onCard: (a: WeekAssignment) => void }) {
  return (
    <>
      <div className={`wg-day ${d === today ? 'today' : ''}`}>
        <span className="dname">{weekdayName(d)}</span>
        <span className="ddate">{dayMonth(d)}</span>
      </div>
      {data.templates.map((t) => (
        <ShiftCell key={t.slot} data={data} date={d} slot={t.slot} skills={skills} highlight={highlight === `${d}-${t.slot}`} onSeat={onSeat} onCard={onCard} />
      ))}
    </>
  );
}

function MobileWeek({ data, skills, today, onSeat, onCard }: { data: WeekData; skills: Map<string, any>; today: string; onSeat: (date: string, slot: number) => void; onCard: (a: WeekAssignment) => void }) {
  return (
    <div className="mobile-week">
      {data.dates.map((d) => {
        const short = data.templates.filter((t) => !(data.coverage.find((c) => c.date === d && c.slot === t.slot)?.ok ?? true)).length;
        return (
          <details key={d} open={d === today || (today < data.dates[0] && d === data.dates[0])}>
            <summary>
              <span>
                {weekdayName(d)} <span className="subtle">{dayMonth(d)}</span>
              </span>
              {short ? <Pill tone="amber" icon={WarningCircle}>{short} short</Pill> : <Pill tone="green">OK</Pill>}
            </summary>
            {data.templates.map((t) => (
              <div className="m-shift" key={t.slot}>
                <strong>{t.start}–{t.end}</strong>
                <ShiftCell data={data} date={d} slot={t.slot} skills={skills} onSeat={onSeat} onCard={onCard} />
              </div>
            ))}
          </details>
        );
      })}
    </div>
  );
}

function DayView({ data, date, skills, onSeat, onCard }: { data: WeekData; date: string; skills: Map<string, any>; onSeat: (slot: number) => void; onCard: (a: WeekAssignment) => void }) {
  const dayIssues = data.issues.filter((i) => i.date === date && i.severity !== 'info');
  return (
    <div className="stack lg">
      <h2>{fullDate(date)}</h2>
      <div className="day-cols">
        {data.templates.map((t) => {
          const c = cellData(data, date, t.slot);
          const ok = c.cov?.ok ?? true;
          return (
            <section key={t.slot} className="card day-col" id={`cell-${date}-${t.slot}`}>
              <div className="card-head">
                <h3>{t.start}–{t.end}</h3>
                <Pill tone={ok ? 'green' : 'amber'} icon={ok ? undefined : WarningCircle}>
                  {c.active.length} / {c.min} staff
                </Pill>
              </div>
              {(c.cov?.skills ?? []).length > 0 && (
                <div className="row wrap" style={{ marginBottom: 10 }}>
                  {c.cov!.skills.map((s) => (
                    <Pill key={s.skillId} tone={s.have >= s.need ? 'green' : 'amber'}>
                      {skills.get(s.skillId)?.name} {s.have}/{s.need}
                    </Pill>
                  ))}
                </div>
              )}
              {[...c.active, ...c.sick].map((a) => {
                const role = a.roleSkillId ? skills.get(a.roleSkillId) : null;
                const b = data.breaks.find((x) => x.userId === a.userId && x.date === date && x.start < t.end && x.end > t.start);
                return (
                  <button key={a.id} className="emp-row" style={{ width: '100%', border: 0, cursor: 'pointer', textAlign: 'left' }} onClick={() => onCard(a)}>
                    <div className="grow">
                      <strong style={{ textDecoration: a.status === 'sick' ? 'line-through' : undefined }}>{a.name}</strong>
                      <div className="row wrap" style={{ gap: 8 }}>
                        {role ? <SkillTag name={role.name} colorIndex={role.colorIndex} /> : <span className="subtle">General</span>}
                        {b && (
                          <span className="subtle">
                            <Coffee size={14} style={{ verticalAlign: -2 }} /> {b.start}–{b.end}
                          </span>
                        )}
                      </div>
                    </div>
                    {a.status === 'sick' && <Pill tone="yellow" icon={FirstAidKit}>Sick</Pill>}
                  </button>
                );
              })}
              {!c.active.length && !c.sick.length && <p className="subtle">Nobody assigned yet.</p>}
              <Button size="sm" block style={{ marginTop: 10 }} onClick={() => onSeat(t.slot)}>
                {c.active.length < c.min ? `Fill ${c.min - c.active.length} open seat${c.min - c.active.length > 1 ? 's' : ''}` : 'Add employee'}
              </Button>
              {c.issues.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <IssueList issues={c.issues} />
                </div>
              )}
            </section>
          );
        })}
      </div>
      {dayIssues.filter((i) => !i.slot).length > 0 && <IssueList issues={dayIssues.filter((i) => !i.slot)} />}
    </div>
  );
}

function MonthView({ branchId, month, onPick }: { branchId: string; month: string; onPick: (d: string) => void }) {
  const q = useQuery({ queryKey: ['month', branchId, month], queryFn: () => api.get(`/api/branches/${branchId}/month?month=${month}`) });
  const today = todayLocal();
  if (q.isLoading) return <PageLoader label="Loading month" />;
  if (q.error) return <ErrorNotice error={q.error} onRetry={() => void q.refetch()} />;
  const { from, to } = monthRange(month);
  const start = weekStartOf(from);
  const cells: string[] = [];
  for (let d = start; d <= to || cells.length % 7 !== 0; d = addDays(d, 1)) cells.push(d);
  const byDate = new Map<string, any>(q.data.days.map((d: any) => [d.date, d]));
  return (
    <div className="stack">
      <div className="legend">
        <span><span className="swatch" style={{ background: 'var(--green-soft)' }} /> Staffed to minimum</span>
        <span><span className="swatch" style={{ background: 'var(--amber-soft)' }} /> Below minimum or missing skills</span>
        <span><span className="swatch" style={{ background: 'var(--surface-2)' }} /> No requirement</span>
      </div>
      <div className="month-grid" role="grid" aria-label={monthName(month)}>
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
          <div key={d} className="month-dow" role="columnheader">
            {d}
          </div>
        ))}
        {cells.map((d) => {
          const info = byDate.get(d);
          const inMonth = d >= from && d <= to;
          const short = info?.shifts.filter((s: any) => s.assigned < s.minStaff || s.skillGaps).length ?? 0;
          return (
            <button key={d} className={`month-day ${inMonth ? '' : 'other'} ${d === today ? 'today' : ''}`} onClick={() => onPick(d)} aria-label={`${fullDate(d)}${short ? `, ${short} shifts need attention` : ''}`}>
              <span className="d">
                {Number(d.slice(8))}
                {info?.scheduleStatus === 'published' && <span className="subtle">Published</span>}
                {info?.scheduleStatus === 'draft' && <span className="subtle">Draft</span>}
                {info?.scheduleStatus === 'changed' && <span className="subtle">Changed</span>}
              </span>
              <span className="row wrap tags" style={{ gap: 4 }}>
                {info?.openCover > 0 && <Pill tone="purple">{info.openCover} cover</Pill>}
                {info?.sickness > 0 && <Pill tone="yellow" icon={FirstAidKit}>{info.sickness}</Pill>}
              </span>
              {info && (
                <span className="mini-bars">
                  {info.shifts.map((s: any) => (
                    <span
                      key={s.slot}
                      className={`mini-bar ${s.minStaff === 0 ? 'none' : s.assigned >= s.minStaff && !s.skillGaps ? 'ok' : 'short'}`}
                      title={`${shiftTime(s.slot)}: ${s.assigned} of ${s.minStaff}${s.skillGaps ? `, ${s.skillGaps} skill gap(s)` : ''}`}
                    >
                      {s.assigned}/{s.minStaff}
                    </span>
                  ))}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function GenerateModal({ open, onClose, data, branchId, onIssues }: { open: boolean; onClose: () => void; data: WeekData; branchId: string; onIssues: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [mode, setMode] = useState<'fill' | 'replace'>('fill');
  const m = useMutation({
    mutationFn: () => api.post(`/api/branches/${branchId}/weeks/${data.weekStart}/generate`, { mode }),
    onSuccess: (r: any) => {
      void qc.invalidateQueries({ queryKey: ['week', branchId] });
      const errors = r.issues.filter((i: Issue) => i.severity === 'error').length;
      toast.success(`Added ${r.added} assignment${r.added === 1 ? '' : 's'}`, errors ? `${errors} problem(s) remain. The report explains why.` : 'The draft meets every requirement. Review it, then publish.');
      onClose();
      if (errors) onIssues();
    },
    onError: (e) => toast.error(e, 'Generation failed'),
  });
  const notSubmitted = data.employees.filter((e) => !e.submitted).length;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Generate a suggested schedule"
      description={weekLabel(data.weekStart)}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon={Lightning} loading={m.isPending} onClick={() => m.mutate()}>
            Generate draft
          </Button>
        </>
      }
    >
      <div className="stack">
        <p>
          The generator only uses employees who marked themselves <strong>available</strong>, checks every working-time rule, fills required skills first, adds break relief, and spreads hours fairly using recent history and preferences.
        </p>
        <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="label" style={{ marginBottom: 6 }}>Mode</legend>
          <label className="check">
            <input type="radio" name="mode" checked={mode === 'fill'} onChange={() => setMode('fill')} /> Fill open seats and keep everything already planned
          </label>
          <label className="check">
            <input type="radio" name="mode" checked={mode === 'replace'} onChange={() => setMode('replace')} /> Rebuild: replace earlier generated assignments (manual and cover assignments stay)
          </label>
        </fieldset>
        {notSubmitted > 0 && (
          <div className="banner warn">
            <WarningCircle size={22} /> {notSubmitted} employee{notSubmitted > 1 ? 's have' : ' has'} not submitted availability for this week and will not be scheduled automatically.
          </div>
        )}
        <p className="subtle">The result stays a draft until you publish it.</p>
      </div>
    </Modal>
  );
}

function PublishModal({ open, onClose, data, onIssues }: { open: boolean; onClose: () => void; data: WeekData; onIssues: (v: any) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const s = data.schedule!;
  const check = useQuery({
    queryKey: ['validate', s.id, s.revision],
    queryFn: () => api.post<{ issues: Issue[]; revision: number; policyNote: string | null }>(`/api/schedules/${s.id}/validate`),
    enabled: open,
    staleTime: 0,
  });
  const errors = check.data?.issues.filter((i) => i.severity === 'error') ?? [];
  const warnings = check.data?.issues.filter((i) => i.severity === 'warning') ?? [];
  const pub = useMutation({
    mutationFn: () => api.post(`/api/schedules/${s.id}/publish`, { revision: check.data!.revision }),
    onSuccess: (r: any) => {
      toast.success(`Published version ${r.versionNo}`, r.affected ? `${r.affected} employee${r.affected > 1 ? 's were' : ' was'} notified.` : 'Employees can now see their shifts.');
      void qc.invalidateQueries({ queryKey: ['week'] });
      onClose();
    },
    onError: (e) => {
      const issues = apiErrorIssues(e);
      toast.error(e, 'Not published');
      if (issues) {
        onClose();
        onIssues({ issues, revision: s.revision });
      } else void check.refetch();
    },
  });
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={s.status === 'published' ? 'Publish changes' : 'Publish schedule'}
      description={weekLabel(data.weekStart)}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {errors.length > 0 ? (
            <Button
              onClick={() => {
                onClose();
                onIssues(check.data);
              }}
            >
              View problems
            </Button>
          ) : (
            <Button variant="primary" icon={PaperPlaneTilt} disabled={!check.data} loading={pub.isPending} onClick={() => pub.mutate()}>
              Publish now
            </Button>
          )}
        </>
      }
    >
      {check.isLoading ? (
        <PageLoader label="Validating the schedule" />
      ) : check.data ? (
        <div className="stack">
          {errors.length ? (
            <div className="banner error">
              <WarningCircle size={22} /> {errors.length} problem{errors.length > 1 ? 's' : ''} must be fixed first. Nothing invalid can be published.
            </div>
          ) : (
            <div className="banner">
              <ListChecks size={22} /> All requirements are met. Employees will see their confirmed shifts and those affected by changes are notified.
            </div>
          )}
          {warnings.length > 0 && <IssueList issues={warnings} />}
          {check.data.policyNote && <div className="banner warn">{check.data.policyNote}</div>}
        </div>
      ) : (
        <ErrorNotice error={check.error} onRetry={() => void check.refetch()} />
      )}
    </Modal>
  );
}

function HistoryDrawer({ open, onClose, scheduleId }: { open: boolean; onClose: () => void; scheduleId: string }) {
  const q = useQuery({ queryKey: ['versions', scheduleId], queryFn: () => api.get<any[]>(`/api/schedules/${scheduleId}/versions`), enabled: open });
  const [openId, setOpenId] = useState<string | null>(null);
  const detail = useQuery({ queryKey: ['version', openId], queryFn: () => api.get(`/api/schedule-versions/${openId}`), enabled: !!openId });
  const REASON: Record<string, string> = { publish: 'Published by manager', cover: 'Cover approved', sickness: 'Sickness reported' };
  return (
    <Drawer open={open} onClose={onClose} title="Version history">
      {q.isLoading ? (
        <PageLoader />
      ) : !q.data?.length ? (
        <EmptyState icon={ClockCounterClockwise} title="Not published yet">
          Each publication, approved cover and sickness report creates a version here.
        </EmptyState>
      ) : (
        <div className="stack">
          {q.data.map((v) => (
            <div key={v.id} className="card flat tight">
              <div className="row between">
                <strong>Version {v.versionNo}</strong>
                <span className="subtle">{instant(v.createdAt)}</span>
              </div>
              <div className="muted">
                {REASON[v.reason]} {v.createdBy ? `· ${v.createdBy}` : ''}
              </div>
              <div className="subtle">{v.summary}</div>
              <button className="btn ghost sm" style={{ marginTop: 6 }} onClick={() => setOpenId(openId === v.id ? null : v.id)} aria-expanded={openId === v.id}>
                {openId === v.id ? 'Hide changes' : 'Show changes'}
              </button>
              {openId === v.id && detail.data && (
                <ul className="subtle" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                  {detail.data.assignments
                    .filter((a: any) => a.change === 'added' || a.status !== 'active')
                    .map((a: any) => (
                      <li key={`${a.userId}${a.date}${a.slot}`}>
                        {a.change === 'added' ? 'Added' : a.status === 'sick' ? 'Sick' : 'Replaced'}: {shortName(a.name)}, {weekdayShort(a.date)} {shiftTime(a.slot)}
                      </li>
                    ))}
                  {detail.data.removed.map((r: any) => (
                    <li key={`r${r.userId}${r.date}${r.slot}`}>
                      Removed: {weekdayShort(r.date)} {shiftTime(r.slot)}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </Drawer>
  );
}

function DeadlineModal({ open, onClose, data, branchId }: { open: boolean; onClose: () => void; data: WeekData; branchId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [value, setValue] = useState(data.schedule?.availabilityDeadline ?? '');
  const m = useMutation({
    mutationFn: (v: string | null) => api.put(`/api/branches/${branchId}/weeks/${data.weekStart}/settings`, { availabilityDeadline: v }),
    onSuccess: () => {
      toast.success('Deadline saved', 'Employees see it on their home page.');
      void qc.invalidateQueries({ queryKey: ['week', branchId] });
      onClose();
    },
    onError: (e) => toast.error(e, 'Could not save'),
  });
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Availability deadline"
      description={`For the week of ${dayMonth(data.weekStart)}`}
      footer={
        <>
          {data.schedule?.availabilityDeadline && (
            <Button variant="ghost" onClick={() => m.mutate(null)}>
              Remove
            </Button>
          )}
          <Button variant="primary" disabled={!value} loading={m.isPending} onClick={() => m.mutate(value)}>
            Save
          </Button>
        </>
      }
    >
      <Field label="Employees should submit availability by" htmlFor="dl">
        <input id="dl" type="date" className="input" value={value} max={addDays(data.weekStart, -1)} onChange={(e) => setValue(e.target.value)} />
      </Field>
    </Modal>
  );
}
