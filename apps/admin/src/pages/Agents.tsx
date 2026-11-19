import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateTime } from '../lib/format';
import { ActionDialog } from '../components/ActionDialog';
import { useAgents } from '../components/shared';
import { Button, Card, DataTable, Field, Input, PageHeader, StatusBadge, useToast } from '../components/ui';

export default function AgentsPage() {
  const { data, isLoading } = useAgents();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [creating, setCreating] = useState(false);
  return (
    <div>
      <PageHeader
        title="Agents"
        subtitle="Field collection staff"
        actions={
          can('agents:manage') && (
            <Button onClick={() => setCreating(true)}>
              <Plus className="size-4" aria-hidden /> Add agent
            </Button>
          )
        }
      />
      <Card padded={false}>
        <DataTable
          rows={data}
          loading={isLoading}
          rowKey={(r) => r.id}
          onRowClick={(r) => navigate(`/agents/${r.id}`)}
          empty="No agents yet"
          columns={[
            { key: 'code', header: 'Code', cell: (r) => <span className="num font-medium">{r.agentCode}</span> },
            { key: 'name', header: 'Name', cell: (r) => r.fullName },
            { key: 'mobile', header: 'Mobile (login)', cell: (r) => r.mobile },
            { key: 'cust', header: 'Customers', align: 'right', cell: (r) => (r.currentCustomers !== r.primaryCustomers ? `${r.currentCustomers} (own ${r.primaryCustomers})` : r.currentCustomers) },
            { key: 'status', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
            { key: 'login', header: 'Last sign-in', cell: (r) => dateTime(r.lastLoginAt) },
          ]}
        />
      </Card>
      <CreateAgentDialog open={creating} onClose={() => setCreating(false)} onCreated={(id) => navigate(`/agents/${id}`)} />
    </div>
  );
}

function CreateAgentDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({ fullName: '', mobile: '', agentCode: '', joiningDate: '', temporaryPassword: '' });
  return (
    <ActionDialog
      open={open}
      onClose={onClose}
      title="Add agent"
      onSubmit={async () => {
        const a = await api<{ id: string }>('POST', '/agents', { body: { ...f, joiningDate: f.joiningDate || null } });
        toast('Agent added. Share the temporary password; they must change it at first sign-in.');
        await qc.invalidateQueries({ queryKey: ['agents'] });
        setF({ fullName: '', mobile: '', agentCode: '', joiningDate: '', temporaryPassword: '' });
        onCreated(a.id);
      }}
    >
      {(err) => (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Full name" required error={err.fullName}>{(id) => <Input id={id} value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} />}</Field>
          <Field label="Mobile (used to sign in)" required error={err.mobile}>{(id) => <Input id={id} inputMode="tel" value={f.mobile} onChange={(e) => setF({ ...f, mobile: e.target.value })} />}</Field>
          <Field label="Agent code" required error={err.agentCode} hint="2–10 letters/digits, e.g. AG01">{(id) => <Input id={id} value={f.agentCode} onChange={(e) => setF({ ...f, agentCode: e.target.value.toUpperCase() })} />}</Field>
          <Field label="Joining date">{(id) => <Input id={id} type="date" value={f.joiningDate} onChange={(e) => setF({ ...f, joiningDate: e.target.value })} />}</Field>
          <div className="sm:col-span-2">
            <Field label="Temporary password" required error={err.temporaryPassword} hint="At least 8 characters with letters and digits">
              {(id) => <Input id={id} value={f.temporaryPassword} onChange={(e) => setF({ ...f, temporaryPassword: e.target.value })} autoComplete="off" />}
            </Field>
          </div>
        </div>
      )}
    </ActionDialog>
  );
}
