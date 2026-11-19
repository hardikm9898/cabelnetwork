import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toPaise } from '@cablenet/domain';
import { api, apiPage } from '../lib/api';
import { dateTime, inr, today } from '../lib/format';
import { ActionDialog } from '../components/ActionDialog';
import { AgentSelect, MoneyInput, ReasonDialog } from '../components/shared';
import { Button, Card, cx, DataTable, Field, PageHeader, Pagination, Select, StatusBadge, Tabs, Textarea, useToast } from '../components/ui';

interface AgentCash {
  agent: { id: string; fullName: string; agentCode: string };
  cashInHand: string;
  cashNotYetHandedOver: string;
  paymentsNotYetHandedOver: number;
  pendingHandoverAmount: string;
  day: { date: string; openingCash: string; cashCollected: string; upiCollected: string; otherCollected: string; pendingVerification: string; payments: number };
}
interface Handover {
  id: string;
  handoverNumber: string;
  agentId: string;
  agentName: string;
  submittedAt: string;
  expectedAmount: string;
  declaredAmount: string;
  receivedAmount: string | null;
  difference: string | null;
  status: string;
  mismatchReason: string | null;
  notes: string | null;
}

export default function CashPage() {
  const [tab, setTab] = useState<'agents' | 'handovers'>('agents');
  const [adjust, setAdjust] = useState(false);
  return (
    <div className="space-y-4">
      <PageHeader
        title="Cash & handovers"
        subtitle="Cash only — UPI and bank payments never count as cash in hand."
        actions={
          <Button variant="secondary" onClick={() => setAdjust(true)}>
            Cash adjustment
          </Button>
        }
      />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'agents', label: 'Cash with agents' }, { id: 'handovers', label: 'Handovers' }]} />
      {tab === 'agents' ? <AgentsCash /> : <Handovers />}
      <AdjustmentDialog open={adjust} onClose={() => setAdjust(false)} />
    </div>
  );
}

function AgentsCash() {
  const { data, isLoading } = useQuery({ queryKey: ['cash-agents'], queryFn: () => api<AgentCash[]>('GET', '/cash/agents'), refetchInterval: 60_000 });
  return (
    <Card padded={false}>
      <DataTable
        rows={data}
        loading={isLoading}
        rowKey={(r) => r.agent.id}
        empty="No agents"
        columns={[
          { key: 'a', header: 'Agent', cell: (r) => `${r.agent.fullName} (${r.agent.agentCode})` },
          { key: 'today', header: `Cash today`, align: 'right', cell: (r) => inr(r.day.cashCollected) },
          { key: 'upi', header: 'UPI today', align: 'right', cell: (r) => inr(r.day.upiCollected) },
          { key: 'pv', header: 'Pending verification', align: 'right', cell: (r) => inr(r.day.pendingVerification) },
          { key: 'not', header: 'Not handed over', align: 'right', cell: (r) => `${inr(r.cashNotYetHandedOver)} (${r.paymentsNotYetHandedOver})` },
          { key: 'pend', header: 'Awaiting office', align: 'right', cell: (r) => inr(r.pendingHandoverAmount) },
          {
            key: 'hand',
            header: 'Cash in hand',
            align: 'right',
            cell: (r) => <span className={cx('font-semibold', r.cashInHand !== '0.00' && 'text-warning')}>{inr(r.cashInHand)}</span>,
          },
        ]}
      />
      <p className="border-t border-line px-3 py-2 text-xs text-muted">Cash in hand = confirmed cash collected − cash received by the office − adjustments. A shortage stays with the agent until recovered or written off.</p>
    </Card>
  );
}

function Handovers() {
  const qc = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState('SUBMITTED');
  const [agentId, setAgentId] = useState('');
  const [page, setPage] = useState(1);
  const [confirm, setConfirm] = useState<Handover | null>(null);
  const [reject, setReject] = useState<Handover | null>(null);
  const [received, setReceived] = useState('');
  const [reason, setReason] = useState('');
  const q = { status, agentId, page, pageSize: 25 };
  const { data, isLoading } = useQuery({ queryKey: ['handovers', q], queryFn: () => apiPage<Handover>('/cash/handovers', q) });
  const differs = (() => {
    if (!confirm || !received) return false;
    try {
      return toPaise(received) !== toPaise(confirm.expectedAmount);
    } catch {
      return true;
    }
  })();
  return (
    <Card padded={false}>
      <div className="flex flex-wrap gap-2 border-b border-line p-3">
        <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} aria-label="Status" className="w-44">
          <option value="SUBMITTED">Waiting for office</option>
          <option value="CONFIRMED">Confirmed</option>
          <option value="REJECTED">Rejected</option>
          <option value="">All</option>
        </Select>
        <div className="w-56">
          <AgentSelect value={agentId} onChange={(v) => { setAgentId(v); setPage(1); }} />
        </div>
      </div>
      <DataTable
        rows={data?.items}
        loading={isLoading}
        rowKey={(r) => r.id}
        empty="No handovers"
        columns={[
          { key: 'n', header: 'Handover', cell: (r) => <span className="num">{r.handoverNumber}</span> },
          { key: 'a', header: 'Agent', cell: (r) => r.agentName },
          { key: 'w', header: 'Submitted', cell: (r) => dateTime(r.submittedAt) },
          { key: 'e', header: 'Expected', align: 'right', cell: (r) => inr(r.expectedAmount) },
          { key: 'd', header: 'Agent says', align: 'right', cell: (r) => inr(r.declaredAmount) },
          { key: 'r', header: 'Received', align: 'right', cell: (r) => (r.receivedAmount ? inr(r.receivedAmount) : '—') },
          { key: 'diff', header: 'Difference', align: 'right', cell: (r) => (r.difference && r.difference !== '0.00' ? <span className="text-danger">{inr(r.difference)}</span> : r.difference ? '—' : '') },
          { key: 's', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
          {
            key: 'x',
            header: '',
            cell: (r) =>
              r.status === 'SUBMITTED' ? (
                <div className="flex gap-1">
                  <Button size="sm" onClick={() => { setReceived(r.declaredAmount); setReason(''); setConfirm(r); }}>Count & confirm</Button>
                  <Button size="sm" variant="ghost" onClick={() => setReject(r)}>Reject</Button>
                </div>
              ) : r.mismatchReason ? (
                <span className="text-xs text-muted">{r.mismatchReason}</span>
              ) : null,
          },
        ]}
      />
      {data && <Pagination page={page} pageSize={25} total={data.meta.total} onPage={setPage} />}
      <ActionDialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title={`Confirm handover ${confirm?.handoverNumber ?? ''}`}
        submitLabel="Confirm received"
        disabled={!received || (!!differs && reason.trim().length < 3)}
        onSubmit={async (key) => {
          await api('POST', `/cash/handovers/${confirm!.id}/confirm`, { body: { receivedAmount: received, mismatchReason: differs ? reason : null }, idempotencyKey: key });
          toast('Handover confirmed');
          await qc.invalidateQueries({ predicate: (q) => ['handovers', 'cash-agents', 'dashboard'].includes(String(q.queryKey[0])) });
        }}
      >
        {() => (
          <>
            <p className="text-sm">
              System expects <span className="num font-semibold">{inr(confirm?.expectedAmount)}</span> from {confirm?.agentName} (agent says {inr(confirm?.declaredAmount)}).
            </p>
            <Field label="Cash counted by the office" required>{(id) => <MoneyInput id={id} value={received} onChange={setReceived} autoFocus />}</Field>
            {differs && <Field label="Why is it different?" required hint="The difference stays on the agent until recovered or written off.">{(id) => <Textarea id={id} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>}
          </>
        )}
      </ActionDialog>
      <ReasonDialog
        open={!!reject}
        onClose={() => setReject(null)}
        title="Reject handover"
        danger
        confirmLabel="Reject"
        description="The payments go back to “not yet handed over” and the agent can submit again."
        onConfirm={async (r, key) => {
          await api('POST', `/cash/handovers/${reject!.id}/reject`, { body: { reason: r }, idempotencyKey: key });
          toast('Handover rejected');
          await qc.invalidateQueries({ predicate: (q) => ['handovers', 'cash-agents'].includes(String(q.queryKey[0])) });
        }}
      />
    </Card>
  );
}

function AdjustmentDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({ agentId: '', amount: '', kind: 'RECOVERY', direction: 'reduce', reason: '' });
  return (
    <ActionDialog
      open={open}
      onClose={onClose}
      title="Cash adjustment"
      disabled={!f.agentId || !f.amount || f.reason.trim().length < 3}
      onSubmit={async (key) => {
        await api('POST', '/cash/adjustments', {
          body: { agentId: f.agentId, amount: f.direction === 'reduce' ? f.amount : `-${f.amount}`, kind: f.kind, reason: f.reason },
          idempotencyKey: key,
        });
        toast('Adjustment recorded');
        setF({ agentId: '', amount: '', kind: 'RECOVERY', direction: 'reduce', reason: '' });
        await qc.invalidateQueries({ queryKey: ['cash-agents'] });
      }}
    >
      {() => (
        <>
          <Field label="Agent" required>{(id) => <AgentSelect id={id} value={f.agentId} onChange={(v) => setF({ ...f, agentId: v })} includeAll={false} />}</Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Type">
              {(id) => (
                <Select id={id} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value, direction: e.target.value === 'CORRECTION' ? f.direction : 'reduce' })}>
                  <option value="RECOVERY">Recovery (agent paid the shortage)</option>
                  <option value="WRITE_OFF">Write-off (business absorbs)</option>
                  <option value="CORRECTION">Correction</option>
                </Select>
              )}
            </Field>
            {f.kind === 'CORRECTION' && (
              <Field label="Effect">
                {(id) => (
                  <Select id={id} value={f.direction} onChange={(e) => setF({ ...f, direction: e.target.value })}>
                    <option value="reduce">Reduce cash in hand</option>
                    <option value="increase">Increase cash in hand</option>
                  </Select>
                )}
              </Field>
            )}
          </div>
          <Field label="Amount" required>{(id) => <MoneyInput id={id} value={f.amount} onChange={(v) => setF({ ...f, amount: v })} />}</Field>
          <Field label="Reason" required>{(id) => <Textarea id={id} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />}</Field>
          <p className="text-xs text-muted">Recorded on {today()} and audited.</p>
        </>
      )}
    </ActionDialog>
  );
}
