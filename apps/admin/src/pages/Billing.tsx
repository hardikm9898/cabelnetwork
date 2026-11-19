import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Play } from 'lucide-react';
import { api, apiPage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date, dateTime, inr, label, today } from '../lib/format';
import { ActionDialog } from '../components/ActionDialog';
import { Button, Card, DataTable, Field, FilterBar, Input, PageHeader, Pagination, Select, StatusBadge, Tabs, useToast } from '../components/ui';

interface Invoice {
  id: string;
  invoiceNumber: string;
  kind: string;
  customerId: string;
  customerCode: string;
  customerName: string;
  periodStart: string | null;
  periodEnd: string | null;
  billingDate: string;
  dueDate: string;
  total: string;
  amountPaid: string;
  balance: string;
  displayStatus: string;
}
interface Run {
  id: string;
  asOf: string;
  trigger: string;
  startedAt: string;
  status: string;
  invoicesCreated: number;
  periodsSkipped: number;
  errors: { subscriptionId: string; message: string }[];
}

export default function BillingPage() {
  const [tab, setTab] = useState<'bills' | 'runs'>('bills');
  const [run, setRun] = useState(false);
  const [asOf, setAsOf] = useState(today());
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  return (
    <div className="space-y-4">
      <PageHeader
        title="Bills & billing"
        subtitle="Bills are raised automatically every few minutes. Run billing manually only to bill ahead or after fixing a rate."
        actions={
          can('billing:manage') && (
            <Button onClick={() => setRun(true)}>
              <Play className="size-4" aria-hidden /> Run billing now
            </Button>
          )
        }
      />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'bills', label: 'Bills' }, { id: 'runs', label: 'Billing runs' }]} />
      {tab === 'bills' ? <Bills /> : <Runs />}
      <ActionDialog
        open={run}
        onClose={() => setRun(false)}
        title="Run billing"
        submitLabel="Run"
        onSubmit={async () => {
          const r = await api<{ invoicesCreated: number; periodsSkipped: number; errors: unknown[] }>('POST', '/billing/runs', { body: { asOf } });
          toast(`${r.invoicesCreated} bill(s) raised${r.periodsSkipped ? `, ${r.periodsSkipped} suspended period(s) skipped` : ''}${r.errors.length ? `, ${r.errors.length} error(s)` : ''}`, r.errors.length ? 'bad' : 'good');
          await qc.invalidateQueries();
        }}
      >
        {() => (
          <>
            <p className="text-sm text-muted">Raises every bill due up to this date. Running it again never creates duplicates. You can bill up to 31 days ahead.</p>
            <Field label="Bill up to">{(id) => <Input id={id} type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />}</Field>
          </>
        )}
      </ActionDialog>
    </div>
  );
}

function Bills() {
  const [f, setF] = useState({ status: 'OPEN', from: '', to: '' });
  const [page, setPage] = useState(1);
  const q = { ...f, page, pageSize: 25 };
  const { data, isLoading } = useQuery({ queryKey: ['invoices', q], queryFn: () => apiPage<Invoice>('/invoices', q) });
  return (
    <Card padded={false}>
      <FilterBar>
        <Field label="Status">
          {(id) => (
            <Select id={id} value={f.status} onChange={(e) => { setF({ ...f, status: e.target.value }); setPage(1); }}>
              <option value="OPEN">Open</option>
              <option value="OVERDUE">Overdue</option>
              <option value="PARTIALLY_PAID">Partly paid</option>
              <option value="PAID">Paid</option>
              <option value="CANCELLED">Cancelled</option>
              <option value="">All</option>
            </Select>
          )}
        </Field>
        <Field label="Billed from">{(id) => <Input id={id} type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />}</Field>
        <Field label="to">{(id) => <Input id={id} type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />}</Field>
      </FilterBar>
      <DataTable
        rows={data?.items}
        loading={isLoading}
        rowKey={(r) => r.id}
        empty="No bills"
        columns={[
          { key: 'n', header: 'Bill', cell: (r) => <span className="num">{r.invoiceNumber}</span> },
          { key: 'c', header: 'Customer', cell: (r) => <Link className="font-medium text-brand-800 hover:underline" to={`/customers/${r.customerId}`}>{r.customerName} <span className="text-xs text-muted">{r.customerCode}</span></Link> },
          { key: 'p', header: 'For', cell: (r) => (r.periodStart ? `${date(r.periodStart)} – ${date(r.periodEnd)}` : label(r.kind)) },
          { key: 'due', header: 'Due', cell: (r) => date(r.dueDate) },
          { key: 't', header: 'Amount', align: 'right', cell: (r) => inr(r.total) },
          { key: 'b', header: 'Balance', align: 'right', cell: (r) => inr(r.balance) },
          { key: 's', header: 'Status', cell: (r) => <StatusBadge status={r.displayStatus} /> },
        ]}
      />
      {data && <Pagination page={page} pageSize={25} total={data.meta.total} onPage={setPage} />}
    </Card>
  );
}

function Runs() {
  const [page, setPage] = useState(1);
  const { data, isLoading } = useQuery({ queryKey: ['billing-runs', page], queryFn: () => apiPage<Run>('/billing/runs', { page, pageSize: 25 }) });
  return (
    <Card padded={false}>
      <DataTable
        rows={data?.items}
        loading={isLoading}
        rowKey={(r) => r.id}
        empty="No billing runs yet"
        columns={[
          { key: 'w', header: 'Started', cell: (r) => dateTime(r.startedAt) },
          { key: 'a', header: 'Billed up to', cell: (r) => date(r.asOf) },
          { key: 't', header: 'Trigger', cell: (r) => label(r.trigger) },
          { key: 'n', header: 'Bills raised', align: 'right', cell: (r) => r.invoicesCreated },
          { key: 'k', header: 'Skipped (suspended)', align: 'right', cell: (r) => r.periodsSkipped },
          { key: 's', header: 'Status', cell: (r) => <StatusBadge status={r.status === 'FAILED' ? 'FAILED' : r.status === 'COMPLETED' ? 'DONE' : 'OPEN'} /> },
          { key: 'e', header: 'Errors', cell: (r) => (r.errors.length ? r.errors.map((e) => e.message).join('; ') : '—') },
        ]}
      />
      {data && <Pagination page={page} pageSize={25} total={data.meta.total} onPage={setPage} />}
    </Card>
  );
}
