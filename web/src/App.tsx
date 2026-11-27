import { ArrowClockwise, WifiSlash } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { Button, PageLoader } from './components/ui';
import { api } from './lib/api';
import { useAuth } from './lib/auth';

const Setup = lazy(() => import('./pages/auth/Setup'));
const Login = lazy(() => import('./pages/auth/Login'));
const ChangePassword = lazy(() => import('./pages/auth/ChangePassword'));
const ForgotPassword = lazy(() => import('./pages/auth/ForgotPassword'));
const ResetPassword = lazy(() => import('./pages/auth/ResetPassword'));
const VerifyEmail = lazy(() => import('./pages/auth/VerifyEmail'));

const ManagerLayout = lazy(() => import('./layouts/ManagerLayout'));
const Dashboard = lazy(() => import('./pages/manager/Dashboard'));
const Schedule = lazy(() => import('./pages/manager/Schedule'));
const Availability = lazy(() => import('./pages/manager/Availability'));
const Cover = lazy(() => import('./pages/manager/Cover'));
const ManagerNotifications = lazy(() => import('./pages/manager/Notifications'));
const Employees = lazy(() => import('./pages/manager/Employees'));
const Branches = lazy(() => import('./pages/manager/Branches'));
const Settings = lazy(() => import('./pages/manager/Settings'));

const EmployeeLayout = lazy(() => import('./layouts/EmployeeLayout'));
const Home = lazy(() => import('./pages/employee/Home'));
const MySchedule = lazy(() => import('./pages/employee/MySchedule'));
const MyAvailability = lazy(() => import('./pages/employee/MyAvailability'));
const FindCover = lazy(() => import('./pages/employee/FindCover'));
const MyNotifications = lazy(() => import('./pages/employee/Notifications'));
const Profile = lazy(() => import('./pages/employee/Profile'));

function RequireAuth({ children, manager, allowPasswordChange }: { children: ReactNode; manager?: boolean; allowPasswordChange?: boolean }) {
  const { me, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <PageLoader />;
  if (!me) return <Navigate to="/login" replace state={{ from: loc.pathname + loc.search }} />;
  if (me.user.mustChangePassword && !allowPasswordChange) return <Navigate to="/change-password" replace />;
  if (manager && !me.user.isManager) return <Navigate to="/my" replace />;
  return <>{children}</>;
}

function RootRedirect() {
  const { me, loading } = useAuth();
  const setup = useQuery({ queryKey: ['setup-status'], queryFn: () => api.get('/api/setup/status'), enabled: !loading && !me });
  if (loading || (!me && setup.isLoading)) return <PageLoader />;
  if (!me) return <Navigate to={setup.data?.needsSetup ? '/setup' : '/login'} replace />;
  if (me.user.mustChangePassword) return <Navigate to="/change-password" replace />;
  return <Navigate to={me.user.isManager ? '/manage' : '/my'} replace />;
}

function UpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, reg) {
      if (reg) setInterval(() => void reg.update(), 60 * 60 * 1000);
    },
  });
  if (!needRefresh) return null;
  return (
    <div className="toasts" style={{ left: 18, right: 'auto' }}>
      <div className="toast info" role="status">
        <ArrowClockwise size={22} />
        <div className="grow">
          <strong>A new version is available</strong>
          <p className="muted" style={{ fontSize: 14 }}>Reload to update. Unsaved changes on this page will be lost.</p>
          <div className="row" style={{ marginTop: 10 }}>
            <Button size="sm" variant="primary" onClick={() => void updateServiceWorker(true)}>
              Reload now
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setNeedRefresh(false)}>
              Later
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function OfflineBanner() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  if (online) return null;
  return (
    <div className="banner warn" role="status" style={{ borderRadius: 0, justifyContent: 'center' }}>
      <WifiSlash size={20} /> You are offline. Changes cannot be saved until the connection is back.
    </div>
  );
}

export function App() {
  return (
    <>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <OfflineBanner />
      <Suspense fallback={<PageLoader />}>
        <Routes>
          <Route path="/setup" element={<Setup />} />
          <Route path="/login" element={<Login />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/verify-email" element={<VerifyEmail />} />
          <Route
            path="/change-password"
            element={
              <RequireAuth allowPasswordChange>
                <ChangePassword />
              </RequireAuth>
            }
          />
          <Route
            path="/manage"
            element={
              <RequireAuth manager>
                <ManagerLayout />
              </RequireAuth>
            }
          >
            <Route index element={<Dashboard />} />
            <Route path="schedule" element={<Schedule />} />
            <Route path="availability" element={<Availability />} />
            <Route path="cover" element={<Cover />} />
            <Route path="notifications" element={<ManagerNotifications />} />
            <Route path="employees" element={<Employees />} />
            <Route path="branches" element={<Branches />} />
            <Route path="settings" element={<Settings />} />
            <Route path="profile" element={<Profile />} />
          </Route>
          <Route
            path="/my"
            element={
              <RequireAuth>
                <EmployeeLayout />
              </RequireAuth>
            }
          >
            <Route index element={<Home />} />
            <Route path="schedule" element={<MySchedule />} />
            <Route path="availability" element={<MyAvailability />} />
            <Route path="cover" element={<FindCover />} />
            <Route path="notifications" element={<MyNotifications />} />
            <Route path="profile" element={<Profile />} />
          </Route>
          <Route path="*" element={<RootRedirect />} />
        </Routes>
      </Suspense>
      <UpdatePrompt />
    </>
  );
}
