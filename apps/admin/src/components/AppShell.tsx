import { ReactNode, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Banknote,
  Bell,
  CloudOff,
  CalendarClock,
  ClipboardList,
  FileSpreadsheet,
  FileBarChart,
  FileText,
  LayoutDashboard,
  LogOut,
  Map,
  Menu,
  ReceiptIndianRupee,
  Settings,
  ShieldCheck,
  Shuffle,
  UserCog,
  Users,
  Wallet,
} from 'lucide-react';
import type { Permission } from '@cablenet/domain';
import { api, apiPage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateTime } from '../lib/format';
import { Button, cx, Modal } from './ui';

const NAV: { to: string; label: string; icon: typeof Users; perm?: Permission; section?: string }[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, perm: 'dashboard:read' },
  { to: '/collect', label: 'Collect payment', icon: ReceiptIndianRupee, perm: 'payments:record' },
  { to: '/customers', label: 'Customers', icon: Users, perm: 'customers:read:all' },
  { to: '/follow-ups', label: 'Follow-ups', icon: CalendarClock, perm: 'followups:manage' },
  { to: '/payments', label: 'Payments', icon: Wallet, perm: 'payments:read:all', section: 'Money' },
  { to: '/billing', label: 'Bills & billing', icon: FileText, perm: 'billing:read' },
  { to: '/cash', label: 'Cash & handovers', icon: Banknote, perm: 'cash:manage' },
  { to: '/offline-entries', label: 'Offline entries', icon: CloudOff, perm: 'payments:verify' },
  { to: '/reports', label: 'Reports', icon: FileBarChart, perm: 'reports:read' },
  { to: '/agents', label: 'Agents', icon: UserCog, perm: 'agents:read', section: 'Team & areas' },
  { to: '/areas', label: 'Areas & societies', icon: Map, perm: 'areas:read' },
  { to: '/assignments', label: 'Assignments', icon: Shuffle, perm: 'assignments:read' },
  { to: '/alerts', label: 'Alerts', icon: AlertTriangle, perm: 'reconciliation:run', section: 'Control' },
  { to: '/import', label: 'Excel import', icon: FileSpreadsheet, perm: 'import:manage' },
  { to: '/audit', label: 'Audit log', icon: ShieldCheck, perm: 'audit:read' },
  { to: '/settings', label: 'Settings', icon: Settings, perm: 'settings:read' },
];

interface Notification {
  id: string;
  type: string;
  title: string;
  body: string;
  readAt: string | null;
  createdAt: string;
}

function Notifications() {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => apiPage<Notification>('/notifications', { pageSize: 20 }),
    refetchInterval: 60_000,
  });
  const unread = (data?.meta as { unread?: number } | undefined)?.unread ?? 0;
  const markAll = useMutation({
    mutationFn: () => api('POST', '/notifications/read', { body: { ids: 'all' } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
  return (
    <>
      <button onClick={() => setOpen(true)} className="relative rounded-lg p-2 text-muted hover:bg-slate-100 hover:text-ink" aria-label={`Notifications (${unread} unread)`}>
        <Bell className="size-5" />
        {unread > 0 && <span className="absolute -top-0.5 -right-0.5 rounded-full bg-danger px-1.5 text-[10px] font-semibold text-white">{unread}</span>}
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Notifications"
        footer={
          <Button variant="secondary" onClick={() => markAll.mutate()} disabled={unread === 0}>
            Mark all as read
          </Button>
        }
      >
        <ul className="divide-y divide-line">
          {data?.items.length === 0 && <li className="py-6 text-center text-sm text-muted">No notifications</li>}
          {data?.items.map((n) => (
            <li key={n.id} className={cx('py-3', !n.readAt && 'font-medium')}>
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span>{n.title}</span>
                <span className="shrink-0 text-xs font-normal text-muted">{dateTime(n.createdAt)}</span>
              </div>
              <p className="mt-0.5 text-sm font-normal text-muted">{n.body}</p>
            </li>
          ))}
        </ul>
      </Modal>
    </>
  );
}

export function AppShell({ children }: { children?: ReactNode }) {
  const { me, can, logout } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const navigate = useNavigate();
  const items = NAV.filter((n) => !n.perm || can(n.perm));
  // Entries from agents' phones that were flagged or not accepted, waiting for an office look.
  const review = useQuery({
    queryKey: ['sync-review-count'],
    queryFn: () => api<{ open: number }>('GET', '/sync/review/count'),
    enabled: can('payments:verify'),
    refetchInterval: 60_000,
  });

  const nav = (
    <nav className="flex flex-col gap-0.5 p-3" aria-label="Main">
      {items.map((n) => (
        <div key={n.to}>
          {n.section && <div className="mt-4 mb-1 px-3 text-[11px] font-semibold tracking-wide text-muted uppercase">{n.section}</div>}
          <NavLink
            to={n.to}
            end={n.to === '/'}
            onClick={() => setMobileOpen(false)}
            className={({ isActive }) =>
              cx('flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm', isActive ? 'bg-brand-50 font-medium text-brand-800' : 'text-slate-600 hover:bg-slate-100 hover:text-ink')
            }
          >
            <n.icon className="size-4" aria-hidden />
            {n.label}
            {n.to === '/offline-entries' && !!review.data?.open && (
              <span className="ml-auto rounded-full bg-amber-100 px-2 text-xs font-semibold text-amber-800" aria-label={`${review.data.open} to review`}>
                {review.data.open}
              </span>
            )}
          </NavLink>
        </div>
      ))}
    </nav>
  );

  return (
    <div className="flex h-full">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-line bg-white lg:flex">
        <div className="flex h-14 items-center gap-2 border-b border-line px-5">
          <div className="grid size-7 place-items-center rounded-lg bg-brand-700 text-white">
            <ClipboardList className="size-4" aria-hidden />
          </div>
          <span className="font-semibold">Cable Network</span>
        </div>
        <div className="flex-1 overflow-y-auto">{nav}</div>
      </aside>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 bg-ink/40 lg:hidden" onClick={() => setMobileOpen(false)}>
          <aside className="h-full w-64 overflow-y-auto bg-white" onClick={(e) => e.stopPropagation()}>
            {nav}
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-line bg-white px-4">
          <button className="rounded-lg p-2 hover:bg-slate-100 lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Open menu">
            <Menu className="size-5" />
          </button>
          <div className="flex-1" />
          <Notifications />
          <div className="hidden text-right sm:block">
            <div className="text-sm font-medium">{me?.fullName}</div>
            <div className="text-xs text-muted">{me?.role.replace('_', ' ').toLowerCase()}</div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={async () => {
              await logout();
              navigate('/login');
            }}
            aria-label="Sign out"
          >
            <LogOut className="size-4" />
          </Button>
        </header>
        <main className="min-w-0 flex-1 overflow-y-auto p-4 sm:p-6">{children ?? <Outlet />}</main>
      </div>
    </div>
  );
}
