import { lazy, ReactNode, Suspense } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import type { Permission } from '@cablenet/domain';
import { useAuth } from './lib/auth';
import { AppShell } from './components/AppShell';
import { Card, Spinner } from './components/ui';
import { ChangePasswordPage, LoginPage } from './pages/Login';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const Customers = lazy(() => import('./pages/Customers'));
const CustomerDetail = lazy(() => import('./pages/CustomerDetail'));
const Collect = lazy(() => import('./pages/Collect'));
const FollowUps = lazy(() => import('./pages/FollowUps'));
const Payments = lazy(() => import('./pages/Payments'));
const Billing = lazy(() => import('./pages/Billing'));
const Cash = lazy(() => import('./pages/Cash'));
const Reports = lazy(() => import('./pages/Reports'));
const Agents = lazy(() => import('./pages/Agents'));
const AgentDetail = lazy(() => import('./pages/AgentDetail'));
const Areas = lazy(() => import('./pages/Areas'));
const Assignments = lazy(() => import('./pages/Assignments'));
const Alerts = lazy(() => import('./pages/Alerts'));
const OfflineEntries = lazy(() => import('./pages/OfflineEntries'));
const ImportPage = lazy(() => import('./pages/Import'));
const Audit = lazy(() => import('./pages/Audit'));
const SettingsPage = lazy(() => import('./pages/Settings'));

function Protected({ children }: { children: ReactNode }) {
  const { status, me } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <Spinner />;
  if (status !== 'authenticated' || !me) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (me.mustChangePassword) return <Navigate to="/change-password" replace />;
  if (me.role === 'AGENT') {
    return (
      <div className="grid min-h-full place-items-center p-6">
        <Card title="Agent account">
          <p className="max-w-sm text-sm text-muted">This website is for the office. Please use the Cable Network agent app on your phone.</p>
        </Card>
      </div>
    );
  }
  return <>{children}</>;
}

function Need({ perm, children }: { perm: Permission; children: ReactNode }) {
  const { can } = useAuth();
  return can(perm) ? <>{children}</> : <Card title="Not available">You do not have access to this page.</Card>;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/change-password" element={<ChangePasswordPage />} />
      <Route
        element={
          <Protected>
            <AppShell />
          </Protected>
        }
      >
        {(
          [
            ['/', 'dashboard:read', <Dashboard />],
            ['/collect', 'payments:record', <Collect />],
            ['/customers', 'customers:read:all', <Customers />],
            ['/customers/:id', 'customers:read:all', <CustomerDetail />],
            ['/follow-ups', 'followups:manage', <FollowUps />],
            ['/payments', 'payments:read:all', <Payments />],
            ['/billing', 'billing:read', <Billing />],
            ['/cash', 'cash:manage', <Cash />],
            ['/offline-entries', 'payments:verify', <OfflineEntries />],
            ['/reports', 'reports:read', <Reports />],
            ['/reports/:key', 'reports:read', <Reports />],
            ['/agents', 'agents:read', <Agents />],
            ['/agents/:id', 'agents:read', <AgentDetail />],
            ['/areas', 'areas:read', <Areas />],
            ['/assignments', 'assignments:read', <Assignments />],
            ['/alerts', 'reconciliation:run', <Alerts />],
            ['/import', 'import:manage', <ImportPage />],
            ['/audit', 'audit:read', <Audit />],
            ['/settings', 'settings:read', <SettingsPage />],
          ] as const
        ).map(([path, perm, el]) => (
          <Route
            key={path}
            path={path}
            element={
              <Need perm={perm}>
                <Suspense fallback={<Spinner />}>{el}</Suspense>
              </Need>
            }
          />
        ))}
        <Route path="*" element={<Card title="Page not found">That page does not exist.</Card>} />
      </Route>
    </Routes>
  );
}
