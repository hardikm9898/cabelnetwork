import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Shuffle, UserCheck } from 'lucide-react';
import { addDays } from '@cablenet/domain';
import { api, apiPage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date, today } from '../lib/format';
import { ActionDialog } from '../components/ActionDialog';
import { AgentSelect, ReasonDialog, useSocieties } from '../components/shared';
import { Button, Card, DataTable, Field, FilterBar, Input, PageHeader, Pagination, Select, StatusBadge, Textarea, useToast } from '../components/ui';

interface Temp {
  id: string;
  fromAgentName: string;
  toAgentName: string;
  scope: string;
  startsOn: string;
  endsOn: string;
  reason: string;
  customerCount: number;
  status: string;
}

export default function AssignmentsPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState('ACTIVE');
  const [page, setPage] = useState(1);
  const [wizard, setWizard] = useState(false);
  const [move, setMove] = useState(false);
  const [revoke, setRevoke] = useState<Temp | null>(null);
  const q = { status, page, pageSize: 25 };
  const { data, isLoading } = useQuery({ queryKey: ['temp-assignments', q], queryFn: () => apiPage<Temp>('/assignments/temporary', q) });
  const refresh = () => qc.invalidateQueries({ predicate: (x) => ['temp-assignments', 'customers', 'agents'].includes(String(x.queryKey[0])) });
  return (
    <div className="space-y-4">
      <PageHeader
        title="Assignments"
        subtitle="Temporary cover lends an agent’s customers to another agent for some days; the original agent gets them back automatically."
        actions={
          can('assignments:manage') && (
            <>
              <Button variant="secondary" onClick={() => setMove(true)}>
                <UserCheck className="size-4" aria-hidden /> Permanent move
              </Button>
              <Button onClick={() => setWizard(true)}>
                <Shuffle className="size-4" aria-hidden /> Temporary cover
              </Button>
            </>
          )
        }
      />
      <Card padded={false}>
        <FilterBar>
          <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="w-44" aria-label="Status">
            <option value="ACTIVE">Active now</option>
            <option value="SCHEDULED">Scheduled</option>
            <option value="ENDED">Ended</option>
            <option value="REVOKED">Revoked</option>
            <option value="">All</option>
          </Select>
        </FilterBar>
        <DataTable
          rows={data?.items}
          loading={isLoading}
          rowKey={(r) => r.id}
          empty="No temporary cover"
          columns={[
            { key: 'f', header: 'From', cell: (r) => r.fromAgentName },
            { key: 't', header: 'Covered by', cell: (r) => <span className="font-medium">{r.toAgentName}</span> },
            { key: 'p', header: 'Dates', cell: (r) => `${date(r.startsOn)} – ${date(r.endsOn)}` },
            { key: 'n', header: 'Customers', align: 'right', cell: (r) => r.customerCount },
            { key: 'r', header: 'Reason', cell: (r) => r.reason },
            { key: 's', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
            {
              key: 'x',
              header: '',
              cell: (r) => can('assignments:manage') && (r.status === 'ACTIVE' || r.status === 'SCHEDULED') && <Button size="sm" variant="ghost" onClick={() => setRevoke(r)}>End now</Button>,
            },
          ]}
        />
        {data && <Pagination page={page} pageSize={25} total={data.meta.total} onPage={setPage} />}
      </Card>
      <TempWizard open={wizard} onClose={() => setWizard(false)} onSaved={async (n) => { toast(`${n} customer(s) covered`); await refresh(); }} />
      <MoveDialog open={move} onClose={() => setMove(false)} onSaved={async (n) => { toast(`${n} customer(s) moved`); await refresh(); }} />
      <ReasonDialog
        open={!!revoke}
        onClose={() => setRevoke(null)}
        title="End temporary cover now"
        description={`${revoke?.customerCount ?? 0} customer(s) go back to ${revoke?.fromAgentName ?? ''} immediately. Both agents are notified.`}
        onConfirm={async (reason) => {
          await api('POST', `/assignments/temporary/${revoke!.id}/revoke`, { body: { reason } });
          toast('Temporary cover ended');
          await refresh();
        }}
      />
    </div>
  );
}

function TempWizard({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: (n: number) => Promise<unknown> }) {
  const societies = useSocieties();
  const [f, setF] = useState({ fromAgentId: '', toAgentId: '', scope: 'ALL_OF_AGENT', societyIds: [] as string[], startsOn: today(), endsOn: addDays(today(), 2), reason: '' });
  return (
    <ActionDialog
      open={open}
      onClose={onClose}
      title="Temporary cover"
      wide
      disabled={!f.fromAgentId || !f.toAgentId || f.reason.trim().length < 3 || (f.scope === 'SOCIETIES' && f.societyIds.length === 0)}
      onSubmit={async () => {
        const r = await api<{ customerCount: number }>('POST', '/assignments/temporary', {
          body: { ...f, societyIds: f.scope === 'SOCIETIES' ? f.societyIds : undefined },
        });
        await onSaved(r.customerCount);
      }}
    >
      {(err) => (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Agent who is away" required>{(id) => <AgentSelect id={id} value={f.fromAgentId} onChange={(v) => setF({ ...f, fromAgentId: v })} includeAll={false} />}</Field>
          <Field label="Covered by" required error={err.toAgentId}>{(id) => <AgentSelect id={id} value={f.toAgentId} onChange={(v) => setF({ ...f, toAgentId: v })} includeAll={false} />}</Field>
          <Field label="From" error={err.startsOn}>{(id) => <Input id={id} type="date" min={today()} value={f.startsOn} onChange={(e) => setF({ ...f, startsOn: e.target.value })} />}</Field>
          <Field label="To (inclusive)" error={err.endsOn}>{(id) => <Input id={id} type="date" min={f.startsOn} value={f.endsOn} onChange={(e) => setF({ ...f, endsOn: e.target.value })} />}</Field>
          <div className="sm:col-span-2">
            <Field label="Which customers">
              {(id) => (
                <Select id={id} value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value })}>
                  <option value="ALL_OF_AGENT">All of the agent’s customers</option>
                  <option value="SOCIETIES">Only some societies</option>
                </Select>
              )}
            </Field>
          </div>
          {f.scope === 'SOCIETIES' && (
            <fieldset className="grid max-h-48 grid-cols-2 gap-1 overflow-y-auto rounded-lg border border-line p-2 sm:col-span-2">
              <legend className="px-1 text-xs text-muted">Societies</legend>
              {societies.data?.map((s) => (
                <label key={s.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={f.societyIds.includes(s.id)}
                    onChange={(e) => setF({ ...f, societyIds: e.target.checked ? [...f.societyIds, s.id] : f.societyIds.filter((x) => x !== s.id) })}
                  />
                  {s.name}
                </label>
              ))}
            </fieldset>
          )}
          <div className="sm:col-span-2">
            <Field label="Reason" required>{(id) => <Textarea id={id} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="e.g. Ramesh on leave for a wedding" />}</Field>
          </div>
        </div>
      )}
    </ActionDialog>
  );
}

function MoveDialog({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: (n: number) => Promise<unknown> }) {
  const societies = useSocieties();
  const [f, setF] = useState({ agentId: '', societyId: '', reason: '' });
  return (
    <ActionDialog
      open={open}
      onClose={onClose}
      title="Move a society to another agent (permanent)"
      disabled={!f.agentId || !f.societyId || f.reason.trim().length < 3}
      onSubmit={async () => {
        const r = await api<{ changed: number }>('POST', '/assignments/permanent', { body: f });
        await onSaved(r.changed);
      }}
    >
      {() => (
        <>
          <p className="text-sm text-muted">Pins every customer of the society to this agent. To change who looks after a whole area, use Areas → Change agent instead.</p>
          <Field label="Society" required>
            {(id) => (
              <Select id={id} value={f.societyId} onChange={(e) => setF({ ...f, societyId: e.target.value })}>
                <option value="">Choose…</option>
                {societies.data?.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.customerCount})</option>)}
              </Select>
            )}
          </Field>
          <Field label="New agent" required>{(id) => <AgentSelect id={id} value={f.agentId} onChange={(v) => setF({ ...f, agentId: v })} includeAll={false} />}</Field>
          <Field label="Reason" required>{(id) => <Textarea id={id} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />}</Field>
        </>
      )}
    </ActionDialog>
  );
}
