import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, apiPage } from '../lib/api';
import { dateTime, inr, label } from '../lib/format';
import { ActionDialog } from '../components/ActionDialog';
import { AgentSelect } from '../components/shared';
import { Badge, Card, DataTable, Field, FilterBar, PageHeader, Pagination, Select, Textarea, Button, useToast } from '../components/ui';

interface Entry {
  opId: string;
  opType: 'PAYMENT_CREATE' | 'VISIT_CREATE' | 'FOLLOWUP_DONE';
  status: 'NEEDS_REVIEW' | 'REJECTED';
  flags: string[];
  errorCode: string | null;
  errorMessage: string | null;
  payload: { amount?: string; mode?: string; provisionalRef?: string; outcome?: string } | null;
  clientCreatedAt: string;
  effectiveAt: string;
  clockSkewSeconds: number;
  recordedOffline: boolean;
  receivedAt: string;
  reviewedAt: string | null;
  reviewNote: string | null;
  reviewedByName: string | null;
  paymentId: string | null;
  agentId: string;
  agentName: string;
  agentCode: string | null;
  customerId: string | null;
  customerCode: string | null;
  customerName: string | null;
  amount: string | null;
  mode: string | null;
  paymentStatus: string | null;
  provisionalRef: string | null;
}

/** What each flag means and what the office should do about it. */
const FLAG_HELP: Record<string, string> = {
  REASSIGNED_BEFORE_SYNC: 'Collected while the customer was this agent’s; moved to another agent before the phone synced. Tell the new agent it is paid.',
  NOT_ASSIGNED_AT_COLLECTION: 'The customer was not this agent’s at the recorded time (moved shortly before, or a wrong phone clock). Confirm with the agent.',
  CUSTOMER_INACTIVE: 'The customer is inactive or disconnected. Check whether the payment should be refunded or the connection restored.',
  POSSIBLE_DUPLICATE: 'Same amount, mode and customer around the same time as another payment. If it was entered twice, reverse one.',
  CLOCK_SKEW: 'The phone clock was more than a day off. The time was corrected using the server clock; check the date.',
  LATE_SYNC: 'Reached the office later than the back-dating limit. Check the cash was handed over.',
};

const what = (r: Entry) =>
  r.opType === 'PAYMENT_CREATE'
    ? `Payment ${inr(r.amount ?? r.payload?.amount ?? null)} ${label(r.mode ?? r.payload?.mode ?? '')}`
    : r.opType === 'VISIT_CREATE'
      ? `Visit: ${label(r.payload?.outcome ?? '')}`
      : 'Follow-up done';

export default function OfflineEntriesPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [state, setState] = useState('open');
  const [agentId, setAgentId] = useState('');
  const [page, setPage] = useState(1);
  const [reviewing, setReviewing] = useState<Entry | null>(null);
  const [note, setNote] = useState('');
  const q = { state, agentId: agentId || undefined, page, pageSize: 25 };
  const { data, isLoading } = useQuery({ queryKey: ['sync-review', q], queryFn: () => apiPage<Entry>('/sync/review', q) });

  return (
    <div>
      <PageHeader
        title="Offline entries to check"
        subtitle="Payments and visits from agents’ phones that need a look. Held payments (customer reassigned, wrong phone clock, sent late) are not in the books until verified under Payments; other flagged payments are posted and can be corrected with the normal tools (reverse, reassign)."
      />
      <Card padded={false}>
        <FilterBar>
          <Select value={state} onChange={(e) => { setState(e.target.value); setPage(1); }} className="w-44" aria-label="Show">
            <option value="open">To check</option>
            <option value="reviewed">Checked</option>
            <option value="all">All</option>
          </Select>
          <AgentSelect value={agentId} onChange={(v) => { setAgentId(v); setPage(1); }} />
        </FilterBar>
        <DataTable
          rows={data?.items}
          loading={isLoading}
          rowKey={(r) => r.opId}
          empty="Nothing to check"
          columns={[
            { key: 'r', header: 'Received', cell: (r) => dateTime(r.receivedAt) },
            { key: 'a', header: 'Agent', cell: (r) => `${r.agentName}${r.agentCode ? ` (${r.agentCode})` : ''}` },
            {
              key: 'c',
              header: 'Customer',
              cell: (r) => (r.customerId ? <Link className="text-brand-700 hover:underline" to={`/customers/${r.customerId}`}>{r.customerName} ({r.customerCode})</Link> : '—'),
            },
            {
              key: 'w',
              header: 'Entry',
              cell: (r) => (
                <div>
                  <div>{what(r)}</div>
                  <div className="text-xs text-muted">
                    Collected {dateTime(r.effectiveAt)}
                    {r.recordedOffline ? ' · offline' : ''}
                    {(r.provisionalRef ?? r.payload?.provisionalRef) ? ` · ${r.provisionalRef ?? r.payload?.provisionalRef}` : ''}
                  </div>
                </div>
              ),
            },
            {
              key: 's',
              header: 'Result',
              cell: (r) =>
                r.status === 'REJECTED' ? (
                  <Badge tone="bad">Not accepted</Badge>
                ) : r.paymentStatus === 'PENDING_VERIFICATION' ? (
                  <Link to="/payments?status=PENDING_VERIFICATION">
                    <Badge tone="warn">Held — verify in Payments</Badge>
                  </Link>
                ) : (
                  <Badge tone="warn">Posted · check</Badge>
                ),
            },
            {
              key: 'why',
              header: 'Why',
              cell: (r) => (
                <ul className="space-y-1 text-sm">
                  {r.status === 'REJECTED' && <li>{r.errorMessage}</li>}
                  {r.flags.map((f) => (
                    <li key={f}>
                      <span className="font-medium">{label(f)}</span>
                      <span className="block text-xs text-muted">{FLAG_HELP[f] ?? ''}</span>
                    </li>
                  ))}
                </ul>
              ),
            },
            {
              key: 'x',
              header: '',
              cell: (r) =>
                r.reviewedAt ? (
                  <span className="text-xs text-muted">
                    Checked by {r.reviewedByName} {dateTime(r.reviewedAt)}
                    {r.reviewNote ? `: ${r.reviewNote}` : ''}
                  </span>
                ) : (
                  <Button size="sm" variant="secondary" onClick={() => { setNote(''); setReviewing(r); }}>
                    Mark checked
                  </Button>
                ),
            },
          ]}
        />
        {data && <Pagination page={page} pageSize={25} total={data.meta.total} onPage={setPage} />}
      </Card>
      <ActionDialog
        open={!!reviewing}
        onClose={() => setReviewing(null)}
        title="Mark as checked"
        onSubmit={async () => {
          await api('POST', `/sync/review/${reviewing!.opId}`, { body: { note: note.trim() || null } });
          toast('Marked as checked');
          await qc.invalidateQueries({ queryKey: ['sync-review'] });
          await qc.invalidateQueries({ queryKey: ['sync-review-count'] });
        }}
      >
        {() => (
          <>
            <p className="text-sm">
              {reviewing && what(reviewing)} — {reviewing?.customerName ?? ''} — {reviewing?.agentName}
            </p>
            <Field label="Note (what you checked or did)">{(id) => <Textarea id={id} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
          </>
        )}
      </ActionDialog>
    </div>
  );
}
