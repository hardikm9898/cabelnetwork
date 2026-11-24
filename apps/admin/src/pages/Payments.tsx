import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileDown, Trash2 } from 'lucide-react';
import { api, apiPage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date, inr, label, monthStart, today } from '../lib/format';
import { AgentSelect, ReasonDialog } from '../components/shared';
import { ActionDialog } from '../components/ActionDialog';
import { Badge, Button, Card, DataTable, Field, FilterBar, Input, Modal, PageHeader, Pagination, Select, StatusBadge, Tabs, Textarea, useToast } from '../components/ui';
import { openReceipt, PAYMENT_DELETE_HELP, PAYMENT_DELETE_REASONS, PaymentStatus } from './CustomerDetail';

interface Row {
  id: string;
  amount: string;
  paymentDate: string;
  mode: string;
  reference: string | null;
  source: string;
  status: string;
  reviewFlags: string[];
  recordedOffline: boolean;
  customerId: string;
  customerCode: string;
  customerName: string;
  collectedByName: string | null;
  correctionNote: string | null;
  deletedByAgent: boolean;
}

export default function PaymentsPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('status') === 'PENDING_VERIFICATION' ? 'verify' : 'all';
  return (
    <div className="space-y-4">
      <PageHeader title="Payments" />
      <Tabs
        value={tab}
        onChange={(t) => setParams(t === 'verify' ? { status: 'PENDING_VERIFICATION' } : {})}
        tabs={[
          { id: 'all', label: 'All payments' },
          { id: 'verify', label: 'To verify (UPI / bank / cheque)' },
        ]}
      />
      {tab === 'verify' ? <VerifyQueue /> : <AllPayments />}
    </div>
  );
}

function AllPayments() {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [f, setF] = useState({ from: monthStart(), to: today(), collectedBy: '', mode: '', status: 'CONFIRMED' });
  const [page, setPage] = useState(1);
  const [reverse, setReverse] = useState<Row | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [bulk, setBulk] = useState(false);
  const [bulkResult, setBulkResult] = useState<{ deleted: number; failed: string[] } | null>(null);
  const q = { ...f, page, pageSize: 25 };
  const { data, isLoading } = useQuery({ queryKey: ['payments', q], queryFn: () => apiPage<Row>('/payments', q) });
  const up = (k: keyof typeof f, v: string) => {
    setF((s) => ({ ...s, [k]: v }));
    setPage(1);
    setSelected([]);
  };
  const canDelete = can('payments:reverse');
  const chosen = (data?.items ?? []).filter((r) => selected.includes(r.id));
  const deletable = chosen.filter((r) => r.status === 'CONFIRMED');
  return (
    <Card padded={false}>
      {selected.length > 0 && (
        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-brand-200 bg-brand-50 px-4 py-2 text-sm">
          <span className="font-medium">
            {selected.length} selected · {inr(deletable.reduce((s, r) => s + Number(r.amount), 0).toFixed(2))}
          </span>
          <Button size="sm" variant="danger" disabled={deletable.length === 0} onClick={() => setBulk(true)}>
            <Trash2 className="size-4" aria-hidden /> Delete selected
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected([])}>
            Clear selection
          </Button>
          {deletable.length < chosen.length && <span className="text-xs text-muted">Only confirmed payments can be deleted; the others are skipped.</span>}
        </div>
      )}
      <FilterBar>
        <Field label="From">{(id) => <Input id={id} type="date" value={f.from} onChange={(e) => up('from', e.target.value)} />}</Field>
        <Field label="To">{(id) => <Input id={id} type="date" value={f.to} onChange={(e) => up('to', e.target.value)} />}</Field>
        <Field label="Collected by">{(id) => <AgentSelect id={id} value={f.collectedBy} onChange={(v) => up('collectedBy', v)} allLabel="Anyone" />}</Field>
        <Field label="Mode">
          {(id) => (
            <Select id={id} value={f.mode} onChange={(e) => up('mode', e.target.value)}>
              <option value="">Any</option>
              {['CASH', 'UPI', 'BANK_TRANSFER', 'CHEQUE', 'OTHER'].map((m) => <option key={m} value={m}>{label(m)}</option>)}
            </Select>
          )}
        </Field>
        <Field label="Status">
          {(id) => (
            <Select id={id} value={f.status} onChange={(e) => up('status', e.target.value)}>
              <option value="">Any</option>
              {['CONFIRMED', 'PENDING_VERIFICATION', 'REVERSED', 'FAILED'].map((m) => <option key={m} value={m}>{label(m)}</option>)}
            </Select>
          )}
        </Field>
        <div className="ml-auto self-center text-sm">
          Total <span className="num font-semibold">{inr((data?.meta as { totalAmount?: string } | undefined)?.totalAmount ?? '0')}</span>
        </div>
      </FilterBar>
      <DataTable
        rows={data?.items}
        loading={isLoading}
        rowKey={(r) => r.id}
        selected={canDelete ? selected : undefined}
        onSelect={canDelete ? setSelected : undefined}
        empty="No payments"
        columns={[
          { key: 'd', header: 'Date', cell: (r) => date(r.paymentDate) },
          { key: 'c', header: 'Customer', cell: (r) => <Link className="font-medium text-brand-800 hover:underline" to={`/customers/${r.customerId}`}>{r.customerName} <span className="text-xs text-muted">{r.customerCode}</span></Link> },
          { key: 'a', header: 'Amount', align: 'right', cell: (r) => inr(r.amount) },
          { key: 'm', header: 'Mode', cell: (r) => `${label(r.mode)}${r.reference ? ` · ${r.reference}` : ''}` },
          { key: 'by', header: 'Collected by', cell: (r) => r.collectedByName ?? '—' },
          {
            key: 's',
            header: 'Status',
            cell: (r) => (
              <span className="flex flex-wrap gap-1">
                <PaymentStatus status={r.status} deletedByAgent={r.deletedByAgent} note={r.correctionNote} />
                {r.reviewFlags.includes('POSSIBLE_DUPLICATE') && <Badge tone="warn">possible duplicate</Badge>}
                {r.recordedOffline && <Badge tone="info">offline</Badge>}
              </span>
            ),
          },
          {
            key: 'x',
            header: '',
            cell: (r) => (
              <div className="flex justify-end gap-1">
                {r.status !== 'PENDING_VERIFICATION' && r.status !== 'FAILED' && (
                  <Button size="sm" variant="ghost" onClick={() => openReceipt(r.id).catch((e: Error) => toast(e.message, 'bad'))} aria-label="Receipt PDF">
                    <FileDown className="size-4" />
                  </Button>
                )}
                {canDelete && r.status === 'CONFIRMED' && (
                  <Button size="sm" variant="ghost" className="text-red-700" onClick={() => setReverse(r)}>
                    <Trash2 className="size-4" aria-hidden /> Delete
                  </Button>
                )}
              </div>
            ),
          },
        ]}
      />
      {data && <Pagination page={page} pageSize={25} total={data.meta.total} onPage={setPage} />}
      <ReasonDialog
        open={!!reverse}
        onClose={() => setReverse(null)}
        title={`Delete ${reverse ? inr(reverse.amount) : ''} payment of ${reverse?.customerName ?? ''}`}
        danger
        confirmLabel="Delete payment"
        presets={PAYMENT_DELETE_REASONS}
        description={PAYMENT_DELETE_HELP}
        onConfirm={async (reason, key) => {
          await api('POST', `/payments/${reverse!.id}/reverse`, { body: { reason }, idempotencyKey: key });
          toast('Payment deleted');
          await qc.invalidateQueries();
        }}
      />
      <ReasonDialog
        open={bulk}
        onClose={() => setBulk(false)}
        title={`Delete ${deletable.length} payment${deletable.length === 1 ? '' : 's'} (${inr(deletable.reduce((s, r) => s + Number(r.amount), 0).toFixed(2))})`}
        danger
        confirmLabel="Delete payments"
        presets={PAYMENT_DELETE_REASONS}
        description={PAYMENT_DELETE_HELP}
        onConfirm={async (reason) => {
          const failed: string[] = [];
          for (const r of deletable) {
            try {
              await api('POST', `/payments/${r.id}/reverse`, { body: { reason }, idempotencyKey: crypto.randomUUID() });
            } catch (e) {
              failed.push(`${r.customerName} ${inr(r.amount)}: ${e instanceof Error ? e.message : 'failed'}`);
            }
          }
          setSelected([]);
          await qc.invalidateQueries();
          const done = deletable.length - failed.length;
          if (failed.length) setBulkResult({ deleted: done, failed });
          else toast(`${done} payment${done === 1 ? '' : 's'} deleted`);
        }}
      />
      <Modal open={!!bulkResult} onClose={() => setBulkResult(null)} title="Delete result" footer={<Button onClick={() => setBulkResult(null)}>OK</Button>}>
        {bulkResult && (
          <div className="space-y-3 text-sm">
            <p>
              <strong>{bulkResult.deleted}</strong> deleted. <strong>{bulkResult.failed.length}</strong> could not be deleted:
            </p>
            <ul className="space-y-1">
              {bulkResult.failed.map((f) => (
                <li key={f} className="rounded-lg bg-amber-50 px-3 py-2 text-amber-900">
                  {f}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Modal>
    </Card>
  );
}

function VerifyQueue() {
  const qc = useQueryClient();
  const toast = useToast();
  const [verify, setVerify] = useState<Row | null>(null);
  const [fail, setFail] = useState<Row | null>(null);
  const [note, setNote] = useState('');
  const q = { status: 'PENDING_VERIFICATION', pageSize: 100 };
  const { data, isLoading } = useQuery({ queryKey: ['payments', q], queryFn: () => apiPage<Row>('/payments', q) });
  return (
    <Card padded={false}>
      <p className="border-b border-line p-3 text-sm text-muted">
        Check each entry against the bank statement (UPI/transfer) or cleared cheque before confirming. Confirmed payments reduce the customer’s balance and get a receipt.
      </p>
      <DataTable
        rows={data?.items}
        loading={isLoading}
        rowKey={(r) => r.id}
        empty="Nothing waiting for verification"
        columns={[
          { key: 'd', header: 'Date', cell: (r) => date(r.paymentDate) },
          { key: 'c', header: 'Customer', cell: (r) => <Link className="font-medium text-brand-800 hover:underline" to={`/customers/${r.customerId}`}>{r.customerName}</Link> },
          { key: 'a', header: 'Amount', align: 'right', cell: (r) => inr(r.amount) },
          { key: 'm', header: 'Mode', cell: (r) => label(r.mode) },
          { key: 'ref', header: 'Reference', cell: (r) => <span className="num">{r.reference}</span> },
          { key: 'by', header: 'Entered by', cell: (r) => r.collectedByName ?? '—' },
          {
            key: 'x',
            header: '',
            cell: (r) => (
              <div className="flex justify-end gap-1">
                <Button size="sm" onClick={() => { setNote(''); setVerify(r); }}>Confirm</Button>
                <Button size="sm" variant="ghost" onClick={() => setFail(r)}>Reject</Button>
              </div>
            ),
          },
        ]}
      />
      <ActionDialog
        open={!!verify}
        onClose={() => setVerify(null)}
        title={`Confirm ${verify ? inr(verify.amount) : ''} (${verify?.reference ?? ''})`}
        submitLabel="Confirm received"
        onSubmit={async (key) => {
          await api('POST', `/payments/${verify!.id}/verify`, { body: { note: note || null }, idempotencyKey: key });
          toast('Payment confirmed');
          await qc.invalidateQueries();
        }}
      >
        {() => <Field label="Note" hint="e.g. seen in bank statement 18 Nov">{(id) => <Textarea id={id} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>}
      </ActionDialog>
      <ReasonDialog
        open={!!fail}
        onClose={() => setFail(null)}
        title="Reject payment"
        danger
        confirmLabel="Reject"
        description="Use when the money never arrived or the cheque bounced. Nothing is posted to the customer’s account."
        onConfirm={async (reason, key) => {
          await api('POST', `/payments/${fail!.id}/fail`, { body: { reason }, idempotencyKey: key });
          toast('Payment rejected');
          await qc.invalidateQueries();
        }}
      />
    </Card>
  );
}
