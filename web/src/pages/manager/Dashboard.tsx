import {
  ArrowRight,
  CalendarCheck,
  CalendarDots,
  ClipboardText,
  ClockCountdown,
  FirstAidKit,
  HandHeart,
  PaperPlaneTilt,
  SealCheck,
  UsersThree,
  WarningCircle,
} from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { CoverStatus } from '../../components/StatusPills';
import { EmptyState, ErrorNotice, Pill, Skeleton } from '../../components/ui';
import { BranchSwitcher, useBranch } from '../../layouts/ManagerLayout';
import { api } from '../../lib/api';
import { dayMonth, fullDate, instant, shiftTime, weekLabel, weekdayShort } from '../../lib/time';

export default function Dashboard() {
  const { branchId, branch } = useBranch();
  const q = useQuery({ queryKey: ['dashboard', branchId], queryFn: () => api.get(`/api/dashboard?branchId=${branchId}`), refetchInterval: 5 * 60_000 });
  const d = q.data;
  const link = (path: string, extra = '') => `${path}?branch=${branchId}${extra}`;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Dashboard</h1>
          <p className="lead">
            {branch.name}
            {d ? ` · ${fullDate(d.today)}` : ''}
          </p>
        </div>
        <BranchSwitcher />
      </div>
      {q.error && <ErrorNotice error={q.error} onRetry={() => void q.refetch()} />}
      {q.isLoading || !d ? (
        <div className="grid-3">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} height={110} radius={20} />
          ))}
        </div>
      ) : (
        <div className="stack lg">
          <div className="grid-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 200px), 1fr))' }}>
            <Stat icon={UsersThree} label="Working today" value={new Set(d.todayShifts.filter((s: any) => s.status === 'active').map((s: any) => s.userId)).size} />
            <Stat icon={WarningCircle} label="Understaffed shifts (14 days)" value={d.shortages.length} warn={d.shortages.length > 0} />
            <Stat icon={ClipboardText} label="Missing skill coverage" value={d.skillGaps.length} warn={d.skillGaps.length > 0} />
            <Stat icon={HandHeart} label="Open cover requests" value={d.cover.filter((c: any) => c.status === 'open').length} />
            <Stat icon={ClockCountdown} label="Awaiting your approval" value={d.cover.filter((c: any) => c.status === 'pending').length} warn={d.cover.some((c: any) => c.status === 'pending')} />
            <Stat icon={CalendarCheck} label={`No availability for ${dayMonth(d.nextWeekStart)} week`} value={d.pendingAvailabilityNextWeek} />
          </div>

          <div className="grid-2">
            <section className="card">
              <div className="card-head">
                <h2><CalendarDots size={22} /> Today</h2>
                <Link className="btn sm ghost" to={link('/manage/schedule', '&view=day')}>
                  Open day <ArrowRight size={16} />
                </Link>
              </div>
              {d.todayShifts.length === 0 ? (
                <EmptyState icon={CalendarDots} title="Nobody is scheduled today">
                  Build and publish a schedule for this week on the Schedule page.
                </EmptyState>
              ) : (
                <div className="stack">
                  {d.templates.map((t: any) => {
                    const people = d.todayShifts.filter((s: any) => s.slot === t.slot);
                    const current = d.currentSlot === t.slot;
                    return (
                      <div key={t.slot} className="list-item" style={current ? { background: 'var(--primary-soft)' } : undefined}>
                        <div className="grow">
                          <div className="row" style={{ gap: 8 }}>
                            <strong>{t.start}–{t.end}</strong>
                            {current && <Pill tone="coral">Now</Pill>}
                            {people.some((p: any) => !p.published) && <Pill tone="amber">Not published</Pill>}
                          </div>
                          <div className="subtle">
                            {people.length
                              ? people.map((p: any) => `${p.name}${p.status === 'sick' ? ' (sick)' : ''}`).join(', ')
                              : 'Nobody scheduled'}
                          </div>
                        </div>
                        <Pill>{people.filter((p: any) => p.status === 'active').length}</Pill>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            <section className="card">
              <div className="card-head">
                <h2><WarningCircle size={22} /> Needs attention</h2>
              </div>
              {!d.shortages.length && !d.skillGaps.length && !d.unpublished.length ? (
                <EmptyState icon={SealCheck} title="Nothing urgent">
                  The next two weeks meet every staffing and skill requirement.
                </EmptyState>
              ) : (
                <div className="stack sm">
                  {d.unpublished.map((u: any) => (
                    <Link key={u.weekStart} className="list-item" to={link('/manage/schedule', `&week=${u.weekStart}`)}>
                      <PaperPlaneTilt size={22} />
                      <span className="grow">
                        Week of {dayMonth(u.weekStart)}: {u.status === 'draft' ? 'draft not published' : 'unpublished changes'}
                      </span>
                      <ArrowRight size={18} />
                    </Link>
                  ))}
                  {d.shortages.slice(0, 6).map((s: any) => (
                    <Link key={`${s.date}${s.slot}`} className="list-item" to={link('/manage/schedule', `&view=day&day=${s.date}`)}>
                      <WarningCircle size={22} style={{ color: 'var(--amber-ink)' }} />
                      <span className="grow">
                        {weekdayShort(s.date)} {dayMonth(s.date)} {shiftTime(s.slot)}: {s.assigned} of {s.minStaff} staff
                      </span>
                      <ArrowRight size={18} />
                    </Link>
                  ))}
                  {d.skillGaps.slice(0, 4).map((s: any) => (
                    <Link key={`${s.date}${s.slot}${s.skill}`} className="list-item" to={link('/manage/schedule', `&view=day&day=${s.date}`)}>
                      <ClipboardText size={22} style={{ color: 'var(--amber-ink)' }} />
                      <span className="grow">
                        {weekdayShort(s.date)} {dayMonth(s.date)} {shiftTime(s.slot)}: {s.have} of {s.need} {s.skill}
                      </span>
                      <ArrowRight size={18} />
                    </Link>
                  ))}
                  {d.shortages.length > 6 && <p className="subtle">and {d.shortages.length - 6} more understaffed shifts.</p>}
                </div>
              )}
            </section>

            <section className="card">
              <div className="card-head">
                <h2><HandHeart size={22} /> Cover and sickness</h2>
                <Link className="btn sm ghost" to={link('/manage/cover')}>
                  Manage <ArrowRight size={16} />
                </Link>
              </div>
              {!d.cover.length && !d.sickness.length ? (
                <EmptyState icon={HandHeart} title="No open requests">
                  Sickness reports and cover requests from your team appear here.
                </EmptyState>
              ) : (
                <div className="stack sm">
                  {d.sickness.filter((s: any) => s.status === 'reported').map((s: any) => (
                    <div key={s.id} className="list-item">
                      <FirstAidKit size={22} style={{ color: 'var(--yellow-ink)' }} />
                      <span className="grow">
                        {s.name} reported sick for {weekdayShort(s.date)} {dayMonth(s.date)}
                      </span>
                      <Pill tone="yellow">New</Pill>
                    </div>
                  ))}
                  {d.cover.map((c: any) => (
                    <div key={c.id} className="list-item">
                      <HandHeart size={22} />
                      <span className="grow">
                        {c.kind === 'sickness' ? 'Replacement for' : 'Cover for'} {c.requester}, {weekdayShort(c.date)} {dayMonth(c.date)} {shiftTime(c.slot)}
                      </span>
                      <CoverStatus status={c.status} />
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="card">
              <div className="card-head">
                <h2><ClockCountdown size={22} /> Deadlines and publications</h2>
              </div>
              {!d.deadlines.length && !d.recentlyPublished.length ? (
                <EmptyState icon={ClockCountdown} title="No upcoming deadlines">
                  Set an availability deadline for a week from the Schedule page.
                </EmptyState>
              ) : (
                <div className="stack sm">
                  {d.deadlines.map((x: any) => (
                    <div key={x.scheduleId} className="list-item">
                      <ClockCountdown size={22} />
                      <span className="grow">
                        Availability for {weekLabel(x.weekStart)} due {weekdayShort(x.deadline)} {dayMonth(x.deadline)}
                      </span>
                    </div>
                  ))}
                  {d.recentlyPublished.map((v: any) => (
                    <div key={v.id} className="list-item">
                      <SealCheck size={22} style={{ color: 'var(--green-ink)' }} />
                      <span className="grow">
                        Week of {dayMonth(v.weekStart)} · version {v.versionNo} <span className="subtle">({v.summary})</span>
                      </span>
                      <span className="subtle nowrap">{instant(v.createdAt)}</span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ icon: Ico, label, value, warn }: { icon: any; label: string; value: number; warn?: boolean }) {
  return (
    <div className={`stat ${warn ? 'warn' : ''}`}>
      <span className="label">
        <Ico size={18} /> {label}
      </span>
      <span className="value tabular">{value}</span>
    </div>
  );
}
