import { Bell, Briefcase, CalendarCheck, CaretDoubleLeft, CaretDoubleRight, HandHeart, House, UserCircle, CalendarBlank } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, NavLink, Outlet } from 'react-router';
import { Logo } from '../components/ui';
import { api } from '../lib/api';
import { useMe } from '../lib/auth';
import { getRailOpen, setRailOpen } from '../lib/prefs';
import { useRealtime } from '../lib/realtime';
import { SyncIndicator, UserMenu, useUnread } from './shared';

export default function EmployeeLayout() {
  const me = useMe();
  const [open, setOpen] = useState(getRailOpen());
  const unread = useUnread();
  const sync = useRealtime(true);
  const opps = useQuery({ queryKey: ['opportunities'], queryFn: () => api.get<any[]>('/api/cover/opportunities'), select: (d) => d.filter((o) => !o.myClaim).length }).data;
  const toggle = () => {
    setOpen((o) => {
      setRailOpen(!o);
      return !o;
    });
  };
  const items = [
    { to: '/my', label: 'Home', short: 'Home', icon: House, end: true },
    { to: '/my/schedule', label: 'My Schedule', short: 'Schedule', icon: CalendarCheck },
    { to: '/my/availability', label: 'My Availability', short: 'Availability', icon: CalendarBlank },
    { to: '/my/cover', label: 'Find Cover', short: 'Cover', icon: HandHeart, badge: opps },
    { to: '/my/notifications', label: 'Notifications', short: 'Alerts', icon: Bell, badge: unread },
    { to: '/my/profile', label: 'My Profile', short: 'Profile', icon: UserCircle },
  ];
  return (
    <div className="rail-shell">
      <div className="rail-top">
        <Link to="/my" className="brand">
          <Logo size={30} />
        </Link>
        <div className="row">
          <SyncIndicator state={sync} />
          <UserMenu profilePath="/my/profile" switchTo={me.user.isManager ? { path: '/manage', label: 'Manager view' } : undefined} />
        </div>
      </div>
      <nav className={`rail ${open ? 'open' : ''}`} aria-label="Main">
        <Link to="/my" className="brand" aria-label="Fresh Choice home">
          <Logo size={36} />
        </Link>
        {items.map((i) => (
          <NavLink key={i.to} to={i.to} end={i.end} className={({ isActive }) => (isActive ? 'active' : '')} title={open ? undefined : i.label}>
            <i.icon size={24} aria-hidden="true" />
            <span className="lbl">
              <span className="long">{i.label}</span>
              <span className="short" aria-hidden="true">{i.short}</span>
            </span>
            {i.badge ? <span className="badge" aria-label={`${i.badge} new`}>{i.badge}</span> : null}
          </NavLink>
        ))}
        <div className="rail-spacer" style={{ flex: 1 }} />
        {me.user.isManager && (
          <Link to="/manage" className="rail-extra" title={open ? undefined : 'Manager view'}>
            <Briefcase size={24} aria-hidden="true" />
            <span className="lbl">Manager view</span>
          </Link>
        )}
        <div className="rail-extra row" style={{ padding: '6px 8px', justifyContent: open ? 'space-between' : 'center', flexDirection: open ? 'row' : 'column' }}>
          <SyncIndicator state={sync} />
          <UserMenu profilePath="/my/profile" switchTo={me.user.isManager ? { path: '/manage', label: 'Manager view' } : undefined} />
        </div>
        <button className="rail-item rail-toggle" onClick={toggle} aria-expanded={open} aria-label={open ? 'Collapse navigation' : 'Expand navigation'}>
          {open ? <CaretDoubleLeft size={22} /> : <CaretDoubleRight size={22} />}
          <span className="lbl">Collapse</span>
        </button>
      </nav>
      <main id="main" className="rail-main">
        <Outlet />
      </main>
    </div>
  );
}
