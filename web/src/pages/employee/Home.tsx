import { ArrowRight, Bell, CalendarBlank, CalendarCheck, ClockCountdown, HandHeart, Megaphone } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { EmptyState, ErrorNotice, Pill, Skeleton } from '../../components/ui';
import { api } from '../../lib/api';
import { useMe } from '../../lib/auth';
import { dayMonth, fullDate, instant, weekLabel, weekdayName, weekdayShort } from '../../lib/time';

export default function Home() {
  const me = useMe();
  const q = useQuery({ queryKey: ['my-home'], queryFn: () => api.get<any>('/api/me/home') });
  const ann = useQuery({ queryKey: ['announcements'], queryFn: () => api.get<any[]>('/api/announcements') });
  const d = q.data;
  const next = d?.upcoming[0];
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Europe/Amsterdam' }).format(new Date()));
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const schedulable = me.memberships.some((m) => m.role === 'employee');
  return (
    <div className="page" style={{ maxWidth: 1080 }}>
      <div className="page-head">
        <div>
          <h1>{greet}, {me.user.firstName}</h1>
          {d && <p className="lead">{fullDate(d.today)}</p>}
        </div>
      </div>
      {q.error && <ErrorNotice error={q.error} onRetry={() => void q.refetch()} />}
      {q.isLoading || !d ? (
        <div className="grid-2"><Skeleton height={180} radius={28} /><Skeleton height={180} radius={20} /></div>
      ) : (
        <div className="stack lg">
          {!schedulable && <div className="banner info">Your account is not set up to be scheduled at a branch yet. Ask your manager.</div>}
          <div className="grid-2">
            {next ? (
              <Link to="/my/schedule" className="hero-shift" style={{ textDecoration: 'none' }}>
                <div className="row between"><span className="pill">Next shift</span><CalendarCheck size={28} /></div>
                <div className="big" style={{ marginTop: 18 }}>{next.start}–{next.end}</div>
                <div style={{ fontSize: 17, fontWeight: 600 }}>{weekdayName(next.date)} {dayMonth(next.date)}</div>
                <div style={{ opacity: 0.85 }}>{next.branchName}{next.role ? ` · ${next.role}` : ''}</div>
              </Link>
            ) : (
              <div className="card">
                <EmptyState icon={CalendarCheck} title="No upcoming shifts">Published shifts for the next three weeks appear here.</EmptyState>
              </div>
            )}
            <section className="card stack">
              <h2 className="row"><CalendarBlank size={22} /> Availability</h2>
              {d.availability.nextWeekEntries > 0 ? (
                <p>You submitted availability for the week of {dayMonth(d.availability.nextWeekStart)} ({d.availability.nextWeekEntries} of 28 shifts answered).</p>
              ) : (
                <p>You have not submitted availability for the week of {dayMonth(d.availability.nextWeekStart)} yet. Without it you will not be scheduled automatically.</p>
              )}
              {d.deadlines.map((x: any) => (
                <Pill key={x.weekStart + x.branchName} tone="teal" icon={ClockCountdown}>
                  {weekLabel(x.weekStart)} due {weekdayShort(x.deadline)} {dayMonth(x.deadline)}
                </Pill>
              ))}
              <Link to="/my/availability" className="btn primary" style={{ alignSelf: 'flex-start' }}>
                {d.availability.nextWeekEntries ? 'Review availability' : 'Submit availability'} <ArrowRight size={18} />
              </Link>
            </section>
          </div>

          <div className="grid-2">
            <section className="card">
              <div className="card-head"><h2><CalendarCheck size={22} /> Upcoming shifts</h2></div>
              {d.upcoming.length <= 1 ? (
                <p className="muted">{d.upcoming.length ? 'Your next shift is shown above.' : 'Nothing planned yet.'}</p>
              ) : (
                d.upcoming.slice(1, 7).map((s: any) => (
                  <Link key={s.assignmentId} to="/my/schedule" className="list-item">
                    <div className="when"><b>{s.date.slice(8)}</b><span>{weekdayShort(s.date)}</span></div>
                    <div className="grow"><strong>{s.start}–{s.end}</strong><div className="subtle">{s.branchName}{s.role ? ` · ${s.role}` : ''}</div></div>
                  </Link>
                ))
              )}
            </section>
            <section className="card stack">
              <div className="card-head" style={{ marginBottom: 0 }}><h2><HandHeart size={22} /> Cover and updates</h2></div>
              <Link to="/my/cover" className="list-item">
                <HandHeart size={24} />
                <span className="grow">{d.openCoverInBranches ? `${d.openCoverInBranches} colleague request${d.openCoverInBranches > 1 ? 's' : ''} for cover in your branches` : 'No open cover requests'}</span>
                <ArrowRight size={18} />
              </Link>
              <Link to="/my/notifications" className="list-item">
                <Bell size={24} />
                <span className="grow">{d.unreadNotifications ? `${d.unreadNotifications} unread notification${d.unreadNotifications > 1 ? 's' : ''}` : 'No unread notifications'}</span>
                <ArrowRight size={18} />
              </Link>
            </section>
          </div>

          <section className="card">
            <div className="card-head"><h2><Megaphone size={22} /> Announcements</h2></div>
            {ann.isLoading ? <Skeleton height={80} /> : !ann.data?.length ? (
              <EmptyState icon={Megaphone} title="No announcements">News from your manager appears here.</EmptyState>
            ) : (
              ann.data.slice(0, 5).map((a) => (
                <article key={a.id} className="announcement">
                  <div className="row between wrap"><strong>{a.title}</strong><span className="subtle">{instant(a.publishedAt)}</span></div>
                  <p>{a.body}</p>
                  <div className="subtle" style={{ marginTop: 6 }}>{a.author} · {a.targets.map((t: any) => t.name).join(', ')}</div>
                </article>
              ))
            )}
          </section>
        </div>
      )}
    </div>
  );
}
