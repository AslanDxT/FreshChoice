import { Desktop, Moon, SignOut, Sun, UserCircle, UserSwitch } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Avatar } from '../components/ui';
import { api } from '../lib/api';
import { useMe, useAuth } from '../lib/auth';
import { applyTheme, getTheme, type ThemePref } from '../lib/prefs';
import type { SyncState } from '../lib/realtime';

export function useUnread() {
  return useQuery({ queryKey: ['unread'], queryFn: () => api.get<{ count: number }>('/api/notifications/unread-count'), refetchInterval: 120_000 }).data?.count ?? 0;
}

export function SyncIndicator({ state }: { state: SyncState }) {
  const text = state === 'live' ? 'Live updates on' : state === 'offline' ? 'Offline' : 'Connecting…';
  return (
    <span className="row subtle" title={text} style={{ gap: 6 }}>
      <span className={`sync-dot ${state === 'live' ? '' : state === 'offline' ? 'off' : 'wait'}`} aria-hidden="true" />
      <span className="sr-only">{text}</span>
    </span>
  );
}

export function UserMenu({ profilePath, switchTo }: { profilePath: string; switchTo?: { path: string; label: string } }) {
  const me = useMe();
  const { logout } = useAuth();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<ThemePref>(getTheme());
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  const name = `${me.user.firstName} ${me.user.lastName}`;
  const pick = (t: ThemePref) => {
    setTheme(t);
    applyTheme(t);
  };
  return (
    <div style={{ position: 'relative' }} ref={ref}>
      <button className="user-chip" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Avatar name={name} size={32} />
        <span className="sr-only">Account menu for {name}</span>
      </button>
      {open && (
        <div className="menu" role="menu">
          <div style={{ padding: '8px 12px 10px' }}>
            <strong>{name}</strong>
            <div className="subtle">
              {me.user.employeeNumber} · {me.user.isAdmin ? 'Administrator' : me.user.isManager ? 'Branch manager' : 'Employee'}
            </div>
          </div>
          <hr />
          <Link to={profilePath} role="menuitem" onClick={() => setOpen(false)}>
            <UserCircle size={20} /> My profile
          </Link>
          {switchTo && (
            <Link to={switchTo.path} role="menuitem" onClick={() => setOpen(false)}>
              <UserSwitch size={20} /> {switchTo.label}
            </Link>
          )}
          <hr />
          <div className="label" style={{ padding: '4px 12px' }}>
            Theme
          </div>
          <div className="segmented" style={{ margin: '4px 8px 8px', display: 'flex' }} role="group" aria-label="Theme">
            {(
              [
                ['light', 'Light', Sun],
                ['dark', 'Dark', Moon],
                ['system', 'Auto', Desktop],
              ] as const
            ).map(([v, l, I]) => (
              <button key={v} aria-pressed={theme === v} onClick={() => pick(v)} style={{ flex: 1, justifyContent: 'center' }}>
                <I size={16} /> {l}
              </button>
            ))}
          </div>
          <hr />
          <button
            role="menuitem"
            onClick={async () => {
              await logout();
              nav('/login', { replace: true });
            }}
          >
            <SignOut size={20} /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}
