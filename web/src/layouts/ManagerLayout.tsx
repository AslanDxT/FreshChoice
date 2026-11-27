import {
  Bell,
  Buildings,
  CalendarDots,
  ClipboardText,
  GearSix,
  HandHeart,
  SquaresFour,
  UsersThree,
} from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useMemo } from 'react';
import { Link, NavLink, Outlet, useLocation, useSearchParams } from 'react-router';
import { EmptyState, Logo, PageLoader } from '../components/ui';
import { api } from '../lib/api';
import { useMe } from '../lib/auth';
import { getLastBranch, setLastBranch } from '../lib/prefs';
import { useRealtime } from '../lib/realtime';
import { SyncIndicator, UserMenu, useUnread } from './shared';

export interface BranchInfo {
  id: string;
  name: string;
  managed: boolean;
  defaultMinStaff?: number;
  employeeCount?: number;
  code?: string | null;
  address?: string | null;
  expectedHeadcount?: number | null;
  isActive: boolean;
  managers?: { id: string; name: string }[];
}

interface BranchCtx {
  branches: BranchInfo[];
  branchId: string;
  branch: BranchInfo;
  setBranchId: (id: string) => void;
}
const Ctx = createContext<BranchCtx | null>(null);
export const useOptionalBranch = () => useContext(Ctx);
export const useBranch = () => {
  const v = useContext(Ctx);
  if (!v) throw new Error('useBranch outside ManagerLayout');
  return v;
};

export function useBranches() {
  return useQuery({ queryKey: ['branches'], queryFn: () => api.get<BranchInfo[]>('/api/branches') });
}

export function BranchSwitcher() {
  const { branches, branchId, setBranchId } = useBranch();
  if (branches.length <= 1) return <span className="pill teal">{branches[0]?.name}</span>;
  return (
    <label className="row" style={{ gap: 8 }}>
      <span className="sr-only">Branch</span>
      <Buildings size={20} aria-hidden="true" />
      <select className="select sm" value={branchId} onChange={(e) => setBranchId(e.target.value)} style={{ width: 'auto', minWidth: 170 }}>
        {branches.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </select>
    </label>
  );
}

export default function ManagerLayout() {
  const me = useMe();
  const unread = useUnread();
  const sync = useRealtime(true);
  const q = useBranches();
  const [params, setParams] = useSearchParams();
  const loc = useLocation();
  const branchless = ['/manage/branches', '/manage/settings', '/manage/profile'].some((p) => loc.pathname.startsWith(p));
  const managed = useMemo(() => (q.data ?? []).filter((b) => b.managed && b.isActive), [q.data]);
  const wanted = params.get('branch') ?? getLastBranch();
  const branchId = managed.find((b) => b.id === wanted)?.id ?? managed[0]?.id ?? '';

  useEffect(() => {
    if (branchId) setLastBranch(branchId);
  }, [branchId]);

  const coverCount = useQuery({
    queryKey: ['cover', branchId, 'count'],
    queryFn: () => api.get<any[]>(`/api/cover-requests?branchId=${branchId}`),
    enabled: !!branchId,
    select: (d) => d.length,
  }).data;

  const ctx: BranchCtx | null = branchId
    ? {
        branches: managed,
        branchId,
        branch: managed.find((b) => b.id === branchId)!,
        setBranchId: (id) => {
          setLastBranch(id);
          const next = new URLSearchParams(params);
          next.set('branch', id);
          setParams(next, { replace: true });
        },
      }
    : null;

  const nav = [
    { to: '/manage', label: 'Dashboard', short: 'Home', icon: SquaresFour, end: true },
    { to: '/manage/schedule', label: 'Schedule', short: 'Schedule', icon: CalendarDots },
    { to: '/manage/availability', label: 'Availability', short: 'Availability', icon: ClipboardText },
    { to: '/manage/cover', label: 'Cover', short: 'Cover', icon: HandHeart, count: coverCount },
    { to: '/manage/notifications', label: 'Notifications', short: 'Alerts', icon: Bell, count: unread },
    { to: '/manage/employees', label: 'Employees', short: 'Staff', icon: UsersThree },
    { to: '/manage/branches', label: 'Branches', short: 'Branches', icon: Buildings },
    ...(me.user.isAdmin ? [{ to: '/manage/settings', label: 'Rules & settings', short: 'Settings', icon: GearSix }] : []),
  ];
  const schedulable = me.memberships.some((m) => m.role === 'employee');

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-inner">
          <Link to="/manage" className="brand" aria-label="Fresh Choice home">
            <Logo subtitle={me.user.isAdmin ? 'Administrator' : 'Manager'} />
          </Link>
          <nav className="topnav" aria-label="Main">
            {nav.map((n) => (
              <NavLink key={n.to} to={{ pathname: n.to, search: branchId ? `?branch=${branchId}` : '' }} end={n.end} className={({ isActive }) => (isActive ? 'active' : '')}>
                <n.icon size={20} aria-hidden="true" />
                <span className="lbl">
                  <span className="long">{n.label}</span>
                  <span className="short" aria-hidden="true">{n.short}</span>
                </span>
                {n.count ? <span className="count" aria-label={`${n.count} items`}>{n.count}</span> : null}
              </NavLink>
            ))}
          </nav>
          <SyncIndicator state={sync} />
          <UserMenu profilePath="/manage/profile" switchTo={schedulable ? { path: '/my', label: 'My shifts and availability' } : undefined} />
        </div>
      </header>
      <main id="main">
        {q.isLoading ? (
          <PageLoader />
        ) : !ctx && branchless ? (
          <Outlet />
        ) : !ctx ? (
          <div className="page">
            <EmptyState icon={Buildings} title="No branch to manage yet">
              {me.user.isAdmin ? (
                <>
                  Create a branch first. <Link to="/manage/branches">Go to Branches</Link>
                </>
              ) : (
                'Ask a system administrator to assign you to a branch.'
              )}
            </EmptyState>
          </div>
        ) : (
          <Ctx.Provider value={ctx}>
            <Outlet />
          </Ctx.Provider>
        )}
      </main>
    </div>
  );
}
