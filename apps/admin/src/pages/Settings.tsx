import { FormEvent, ReactNode, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateTime } from '../lib/format';
import { ActionDialog } from '../components/ActionDialog';
import { MoneyInput, ReasonDialog } from '../components/shared';
import { Button, Card, DataTable, ErrorNote, Field, Input, PageHeader, Select, StatusBadge, Textarea, useToast } from '../components/ui';

type Settings = {
  'business.profile': { name: string; address?: string | null; phone?: string | null; email?: string | null; gstin?: string | null; receiptFooter?: string | null; logoUrl?: string | null };
  'customers.duplicateRules': { mobile: 'off' | 'warn' | 'block'; stb: 'warn' | 'block' };
  'field.gpsCheckIn': { enabled: boolean };
  'payments.rules': { maxAmount: string; agentMaxBackdateDays: number; duplicateWindowMinutes: number };
  'billing.defaults': { dueDays: number };
  'sync.rules': { staleAfterHours: number };
  'credits.limits': { adminMaxAmount: string };
};

function SettingCard<K extends keyof Settings>({ k, title, value, children }: { k: K; title: string; value: Settings[K]; children: (v: Settings[K], set: (v: Settings[K]) => void, disabled: boolean) => ReactNode }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [v, setV] = useState(value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => setV(value), [value]);
  const editable = can('settings:manage');
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('PUT', `/settings/${k}`, { body: v });
      toast(`${title} saved`);
      await qc.invalidateQueries({ queryKey: ['settings'] });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title={title}>
      <form onSubmit={save} className="space-y-3">
        {children(v, setV, !editable)}
        <ErrorNote error={error} />
        {editable && (
          <Button type="submit" busy={busy} size="sm">
            Save
          </Button>
        )}
      </form>
    </Card>
  );
}

export default function SettingsPage() {
  const { can } = useAuth();
  const { data } = useQuery({ queryKey: ['settings'], queryFn: () => api<Settings>('GET', '/settings') });
  if (!data) return null;
  return (
    <div className="space-y-4">
      <PageHeader title="Settings" subtitle={can('settings:manage') ? undefined : 'Only the super admin can change settings.'} />
      <div className="grid gap-4 lg:grid-cols-2">
        <SettingCard k="business.profile" title="Business profile (printed on receipts)" value={data['business.profile']}>
          {(v, set, disabled) => (
            <fieldset disabled={disabled} className="grid gap-3 sm:grid-cols-2">
              <Field label="Business name" required>{(id) => <Input id={id} value={v.name} onChange={(e) => set({ ...v, name: e.target.value })} />}</Field>
              <Field label="Phone">{(id) => <Input id={id} value={v.phone ?? ''} onChange={(e) => set({ ...v, phone: e.target.value })} />}</Field>
              <div className="sm:col-span-2">
                <Field label="Address">{(id) => <Input id={id} value={v.address ?? ''} onChange={(e) => set({ ...v, address: e.target.value })} />}</Field>
              </div>
              <Field label="GSTIN" hint="Leave empty if not registered">{(id) => <Input id={id} value={v.gstin ?? ''} onChange={(e) => set({ ...v, gstin: e.target.value })} />}</Field>
              <Field label="Email">{(id) => <Input id={id} type="email" value={v.email ?? ''} onChange={(e) => set({ ...v, email: e.target.value || null })} />}</Field>
              <div className="sm:col-span-2">
                <Field label="Receipt footer">{(id) => <Textarea id={id} rows={2} value={v.receiptFooter ?? ''} onChange={(e) => set({ ...v, receiptFooter: e.target.value })} />}</Field>
              </div>
            </fieldset>
          )}
        </SettingCard>
        <div className="space-y-4">
          <SettingCard k="payments.rules" title="Payment rules" value={data['payments.rules']}>
            {(v, set, disabled) => (
              <fieldset disabled={disabled} className="grid gap-3 sm:grid-cols-3">
                <Field label="Largest single payment">{(id) => <MoneyInput id={id} value={v.maxAmount} onChange={(x) => set({ ...v, maxAmount: x })} />}</Field>
                <Field label="Agents may back-date (days)">{(id) => <Input id={id} type="number" min={0} max={60} value={v.agentMaxBackdateDays} onChange={(e) => set({ ...v, agentMaxBackdateDays: Number(e.target.value) })} />}</Field>
                <Field label="Duplicate warning (minutes)">{(id) => <Input id={id} type="number" min={0} max={1440} value={v.duplicateWindowMinutes} onChange={(e) => set({ ...v, duplicateWindowMinutes: Number(e.target.value) })} />}</Field>
              </fieldset>
            )}
          </SettingCard>
          <SettingCard k="credits.limits" title="Approval limit" value={data['credits.limits']}>
            {(v, set, disabled) => (
              <fieldset disabled={disabled}>
                <Field label="Discounts, credits and refunds above this need the super admin">{(id) => <MoneyInput id={id} value={v.adminMaxAmount} onChange={(x) => set({ ...v, adminMaxAmount: x })} />}</Field>
              </fieldset>
            )}
          </SettingCard>
          <SettingCard k="billing.defaults" title="Billing defaults" value={data['billing.defaults']}>
            {(v, set, disabled) => (
              <fieldset disabled={disabled}>
                <Field label="Bills are due after (days)">{(id) => <Input id={id} type="number" min={0} max={90} value={v.dueDays} onChange={(e) => set({ ...v, dueDays: Number(e.target.value) })} />}</Field>
              </fieldset>
            )}
          </SettingCard>
          <SettingCard k="sync.rules" title="Agent app (offline)" value={data['sync.rules']}>
            {(v, set, disabled) => (
              <fieldset disabled={disabled}>
                <Field label="Warn agents that balances may be out of date after (hours without syncing)">
                  {(id) => <Input id={id} type="number" min={1} max={168} value={v.staleAfterHours} onChange={(e) => set({ ...v, staleAfterHours: Number(e.target.value) })} />}
                </Field>
              </fieldset>
            )}
          </SettingCard>
          <SettingCard k="customers.duplicateRules" title="Duplicate checks" value={data['customers.duplicateRules']}>
            {(v, set, disabled) => (
              <fieldset disabled={disabled} className="grid gap-3 sm:grid-cols-2">
                <Field label="Same mobile on two customers">
                  {(id) => (
                    <Select id={id} value={v.mobile} onChange={(e) => set({ ...v, mobile: e.target.value as Settings['customers.duplicateRules']['mobile'] })}>
                      <option value="off">Allow</option>
                      <option value="warn">Warn and confirm</option>
                      <option value="block">Block</option>
                    </Select>
                  )}
                </Field>
                <Field label="Re-using an old set-top box">
                  {(id) => (
                    <Select id={id} value={v.stb} onChange={(e) => set({ ...v, stb: e.target.value as 'warn' | 'block' })}>
                      <option value="warn">Warn and confirm</option>
                      <option value="block">Block</option>
                    </Select>
                  )}
                </Field>
              </fieldset>
            )}
          </SettingCard>
          <SettingCard k="field.gpsCheckIn" title="Field privacy" value={data['field.gpsCheckIn']}>
            {(v, set, disabled) => (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" disabled={disabled} checked={v.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
                Record the agent’s location when they check in at a visit (never tracked continuously)
              </label>
            )}
          </SettingCard>
        </div>
      </div>
      {can('users:manage') && <AdminUsers />}
    </div>
  );
}

interface AdminUser {
  id: string;
  fullName: string;
  mobile: string;
  role: string;
  status: string;
  lastLoginAt: string | null;
}

function AdminUsers() {
  const qc = useQueryClient();
  const toast = useToast();
  const { me } = useAuth();
  const { data, isLoading } = useQuery({ queryKey: ['admin-users'], queryFn: () => api<AdminUser[]>('GET', '/users') });
  const [creating, setCreating] = useState(false);
  const [status, setStatus] = useState<AdminUser | null>(null);
  const [f, setF] = useState({ fullName: '', mobile: '', role: 'ADMIN', temporaryPassword: '' });
  return (
    <Card title="Office users" padded={false} actions={<Button size="sm" onClick={() => setCreating(true)}><Plus className="size-4" aria-hidden /> User</Button>}>
      <DataTable
        rows={data}
        loading={isLoading}
        rowKey={(r) => r.id}
        columns={[
          { key: 'n', header: 'Name', cell: (r) => r.fullName },
          { key: 'm', header: 'Mobile', cell: (r) => r.mobile },
          { key: 'r', header: 'Role', cell: (r) => r.role.replace('_', ' ').toLowerCase() },
          { key: 's', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
          { key: 'l', header: 'Last sign-in', cell: (r) => dateTime(r.lastLoginAt) },
          { key: 'x', header: '', cell: (r) => r.id !== me?.id && <Button size="sm" variant="ghost" onClick={() => setStatus(r)}>{r.status === 'ACTIVE' ? 'Suspend' : 'Activate'}</Button> },
        ]}
      />
      <ActionDialog
        open={creating}
        onClose={() => setCreating(false)}
        title="Add office user"
        onSubmit={async () => {
          await api('POST', '/users', { body: f });
          toast('User added. They must change the temporary password at first sign-in.');
          setF({ fullName: '', mobile: '', role: 'ADMIN', temporaryPassword: '' });
          await qc.invalidateQueries({ queryKey: ['admin-users'] });
        }}
      >
        {(err) => (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Full name" required error={err.fullName}>{(id) => <Input id={id} value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} />}</Field>
            <Field label="Mobile (login)" required error={err.mobile}>{(id) => <Input id={id} value={f.mobile} onChange={(e) => setF({ ...f, mobile: e.target.value })} />}</Field>
            <Field label="Role">
              {(id) => (
                <Select id={id} value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
                  <option value="ADMIN">Admin</option>
                  <option value="SUPER_ADMIN">Super admin</option>
                </Select>
              )}
            </Field>
            <Field label="Temporary password" required error={err.temporaryPassword}>{(id) => <Input id={id} value={f.temporaryPassword} onChange={(e) => setF({ ...f, temporaryPassword: e.target.value })} autoComplete="off" />}</Field>
          </div>
        )}
      </ActionDialog>
      <ReasonDialog
        open={!!status}
        onClose={() => setStatus(null)}
        title={status?.status === 'ACTIVE' ? `Suspend ${status.fullName}` : `Activate ${status?.fullName ?? ''}`}
        danger={status?.status === 'ACTIVE'}
        onConfirm={async (reason) => {
          await api('POST', `/users/${status!.id}/status`, { body: { status: status!.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE', reason } });
          toast('Status changed');
          await qc.invalidateQueries({ queryKey: ['admin-users'] });
        }}
      />
    </Card>
  );
}
