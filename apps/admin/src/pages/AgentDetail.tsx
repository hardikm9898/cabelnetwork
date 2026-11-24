import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date, dateTime, inr, label } from '../lib/format';
import { ActionDialog } from '../components/ActionDialog';
import { ReasonDialog } from '../components/shared';
import { Button, Card, DataTable, DescriptionList, ErrorNote, Field, Input, PASSWORD_HINT, PasswordInput, Select, Spinner, StatusBadge, useToast } from '../components/ui';

interface Agent {
  id: string;
  fullName: string;
  mobile: string;
  email: string | null;
  status: string;
  agentCode: string;
  employmentStatus: string;
  joiningDate: string | null;
  lastLoginAt: string | null;
  mustChangePassword: boolean;
  areas: { id: string; name: string; since: string }[];
  primaryCustomers: number;
  currentCustomers: number;
  areasOwned: number;
  openTemporaryReassignments: number;
}

export default function AgentDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [dialog, setDialog] = useState<null | 'edit' | 'status' | 'password' | 'device' | 'delete'>(null);
  const navigate = useNavigate();
  const [target, setTarget] = useState<{ status?: string; deviceId?: string }>({});
  const agent = useQuery({ queryKey: ['agent', id], queryFn: () => api<Agent>('GET', `/agents/${id}`) });
  const cash = useQuery({ queryKey: ['agent', id, 'cash'], queryFn: () => api<{ cashInHand: string; day: { cashCollected: string; upiCollected: string } }>('GET', `/cash/agents/${id}`), enabled: can('cash:manage') });
  const sessions = useQuery({ queryKey: ['agent', id, 'sessions'], queryFn: () => api<{ familyId: string; signedInAt: string; ip: string | null; platform: string | null; model: string | null }[]>('GET', `/agents/${id}/sessions`) });
  const devices = useQuery({ queryKey: ['agent', id, 'devices'], queryFn: () => api<{ id: string; platform: string | null; model: string | null; appVersion: string | null; lastSeenAt: string; lastSyncAt: string | null; revokedAt: string | null }[]>('GET', `/agents/${id}/devices`) });
  const refresh = () => qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === 'agent' || q.queryKey[0] === 'agents' });

  if (agent.isLoading) return <Spinner />;
  if (!agent.data) return <ErrorNote error={agent.error} />;
  const a = agent.data;
  const manage = can('agents:manage');

  return (
    <div className="space-y-4">
      <div className="text-sm text-muted">
        <Link to="/agents" className="hover:underline">Agents</Link> / {a.agentCode}
      </div>
      <Card
        title={
          <span className="flex items-center gap-2">
            {a.fullName} <StatusBadge status={a.status} />
          </span>
        }
        actions={
          manage && (
            <>
              <Button size="sm" variant="secondary" onClick={() => setDialog('edit')}>Edit</Button>
              <Button size="sm" variant="secondary" onClick={() => setDialog('password')}>Reset password</Button>
              <Button size="sm" variant={a.status === 'ACTIVE' ? 'ghost' : 'primary'} onClick={() => { setTarget({ status: a.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE' }); setDialog('status'); }}>
                {a.status === 'ACTIVE' ? 'Suspend' : 'Activate'}
              </Button>
              <Button size="sm" variant="ghost" className="text-danger" onClick={() => setDialog('delete')}>
                Delete
              </Button>
            </>
          )
        }
      >
        <DescriptionList
          items={[
            ['Agent code', a.agentCode],
            ['Mobile (login)', a.mobile],
            ['Email', a.email ?? '—'],
            ['Employment', label(a.employmentStatus)],
            ['Joined', date(a.joiningDate)],
            ['Last sign-in', dateTime(a.lastLoginAt)],
            ['Customers now', `${a.currentCustomers} (own ${a.primaryCustomers})`],
            ['Areas owned', a.areas.map((x) => x.name).join(', ') || '—'],
            ['Open temporary cover', a.openTemporaryReassignments],
            ...(cash.data ? ([['Cash in hand', inr(cash.data.cashInHand)], ['Collected today', `${inr(cash.data.day.cashCollected)} cash · ${inr(cash.data.day.upiCollected)} UPI`]] as [string, string][]) : []),
            ...(a.mustChangePassword ? ([['Password', 'Temporary — must change at next sign-in']] as [string, string][]) : []),
          ]}
        />
        <div className="mt-4">
          <Link to={`/customers?agentId=${a.id}`} className="text-sm text-brand-800 hover:underline">View this agent’s customers →</Link>
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Signed-in sessions" padded={false}>
          <DataTable
            rows={sessions.data}
            loading={sessions.isLoading}
            rowKey={(r) => r.familyId}
            empty="Not signed in anywhere"
            columns={[
              { key: 'w', header: 'Since', cell: (r) => dateTime(r.signedInAt) },
              { key: 'd', header: 'Device', cell: (r) => [r.platform, r.model].filter(Boolean).join(' ') || 'Browser' },
              { key: 'ip', header: 'IP', cell: (r) => r.ip ?? '—' },
              {
                key: 'x',
                header: '',
                cell: (r) =>
                  manage && (
                    <Button size="sm" variant="ghost" onClick={async () => { await api('DELETE', `/agents/${id}/sessions/${r.familyId}`); toast('Signed out'); await refresh(); }}>
                      Sign out
                    </Button>
                  ),
              },
            ]}
          />
        </Card>
        <Card title="Devices" padded={false}>
          <DataTable
            rows={devices.data}
            loading={devices.isLoading}
            rowKey={(r) => r.id}
            empty="No app devices registered"
            columns={[
              { key: 'd', header: 'Device', cell: (r) => [r.platform, r.model].filter(Boolean).join(' ') || r.id.slice(0, 8) },
              { key: 'v', header: 'App', cell: (r) => r.appVersion ?? '—' },
              { key: 'l', header: 'Last seen', cell: (r) => dateTime(r.lastSeenAt) },
              { key: 'sy', header: 'Last synced', cell: (r) => (r.lastSyncAt ? dateTime(r.lastSyncAt) : '—') },
              {
                key: 'x',
                header: '',
                cell: (r) =>
                  r.revokedAt ? (
                    <StatusBadge status="REVOKED" />
                  ) : (
                    manage && (
                      <Button size="sm" variant="ghost" onClick={() => { setTarget({ deviceId: r.id }); setDialog('device'); }}>
                        Block (lost phone)
                      </Button>
                    )
                  ),
              },
            ]}
          />
        </Card>
      </div>

      <EditAgentDialog open={dialog === 'edit'} onClose={() => setDialog(null)} a={a} onSaved={async () => { toast('Agent updated'); await refresh(); }} />
      <ReasonDialog
        open={dialog === 'status'}
        onClose={() => setDialog(null)}
        title={target.status === 'ACTIVE' ? 'Activate agent' : 'Suspend agent'}
        danger={target.status !== 'ACTIVE'}
        description={target.status !== 'ACTIVE' ? 'The agent is signed out everywhere and cannot sign in. Their customers stay assigned — set up temporary cover under Assignments.' : undefined}
        onConfirm={async (reason) => {
          await api('POST', `/agents/${id}/status`, { body: { status: target.status, reason } });
          toast('Status changed');
          await refresh();
        }}
      />
      <ResetPasswordDialog open={dialog === 'password'} onClose={() => setDialog(null)} agentId={id} />
      <ReasonDialog
        open={dialog === 'delete'}
        onClose={() => setDialog(null)}
        title={`Delete agent ${a.fullName}`}
        danger
        confirmLabel="Delete agent"
        presets={['Left the job', 'Created by mistake']}
        description="The agent can no longer sign in and disappears from the lists; the payments they collected stay in the history. Move their customers and areas to another agent first (Areas & societies, Assignments)."
        onConfirm={async (reason) => {
          await api('POST', `/agents/${id}/delete`, { body: { reason } });
          toast('Agent deleted');
          await refresh();
          navigate('/agents');
        }}
      />
      <ReasonDialog
        open={dialog === 'device'}
        onClose={() => setDialog(null)}
        title="Block device"
        danger
        confirmLabel="Block"
        description="Signs the device out immediately; it can never sign in again."
        onConfirm={async (reason) => {
          await api('POST', `/agents/${id}/devices/${target.deviceId}/revoke`, { body: { reason } });
          toast('Device blocked');
          await refresh();
        }}
      />
    </div>
  );
}

function EditAgentDialog({ open, onClose, a, onSaved }: { open: boolean; onClose: () => void; a: Agent; onSaved: () => Promise<unknown> }) {
  const [f, setF] = useState({ fullName: a.fullName, mobile: a.mobile, email: a.email ?? '', joiningDate: a.joiningDate ?? '', employmentStatus: a.employmentStatus });
  return (
    <ActionDialog
      open={open}
      onClose={onClose}
      title="Edit agent"
      onSubmit={async () => {
        await api('PATCH', `/agents/${a.id}`, { body: { ...f, email: f.email || null, joiningDate: f.joiningDate || null } });
        await onSaved();
      }}
    >
      {(err) => (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Full name" error={err.fullName}>{(id) => <Input id={id} value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} />}</Field>
          <Field label="Mobile (login)" error={err.mobile}>{(id) => <Input id={id} value={f.mobile} onChange={(e) => setF({ ...f, mobile: e.target.value })} />}</Field>
          <Field label="Email" error={err.email}>{(id) => <Input id={id} type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />}</Field>
          <Field label="Joining date">{(id) => <Input id={id} type="date" value={f.joiningDate} onChange={(e) => setF({ ...f, joiningDate: e.target.value })} />}</Field>
          <Field label="Employment">
            {(id) => (
              <Select id={id} value={f.employmentStatus} onChange={(e) => setF({ ...f, employmentStatus: e.target.value })}>
                <option value="ACTIVE">Active</option>
                <option value="ON_LEAVE">On leave</option>
                <option value="LEFT">Left</option>
              </Select>
            )}
          </Field>
        </div>
      )}
    </ActionDialog>
  );
}

function ResetPasswordDialog({ open, onClose, agentId }: { open: boolean; onClose: () => void; agentId: string }) {
  const toast = useToast();
  const [pwd, setPwd] = useState('');
  const [reason, setReason] = useState('');
  return (
    <ActionDialog
      open={open}
      onClose={onClose}
      title="Reset password"
      onSubmit={async () => {
        await api('POST', `/agents/${agentId}/reset-password`, { body: { temporaryPassword: pwd, reason } });
        toast('Password reset. The agent is signed out and must set a new password.');
        setPwd('');
        setReason('');
      }}
    >
      {(err) => (
        <>
          <Field label="Temporary password" required error={err.temporaryPassword} hint={PASSWORD_HINT}>{(id) => <PasswordInput id={id} initiallyVisible value={pwd} onChange={(e) => setPwd(e.target.value)} autoComplete="off" />}</Field>
          <Field label="Reason" required error={err.reason}>{(id) => <Input id={id} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
        </>
      )}
    </ActionDialog>
  );
}
