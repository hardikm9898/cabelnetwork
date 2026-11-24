import { ReactNode, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarPlus, FileDown, MoreHorizontal, Phone, ReceiptIndianRupee } from 'lucide-react';
import { api, apiPage, download } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date, dateTime, inr, label, today } from '../lib/format';
import { ActionDialog } from '../components/ActionDialog';
import { MonthCalendar } from '../components/MonthCalendar';
import { AgentSelect, MoneyInput, ReasonDialog, SocietySelect } from '../components/shared';
import { DELETE_REASONS } from './Customers';
import {
  Badge,
  Button,
  Card,
  cx,
  DataTable,
  DescriptionList,
  ErrorNote,
  Field,
  Input,
  Pagination,
  Select,
  Spinner,
  StatusBadge,
  Tabs,
  Textarea,
  useToast,
} from '../components/ui';

interface CustomerDetail {
  deletedAt: string | null;
  deleteReason: string | null;
  pendingDecision: string | null;
  imported: boolean;
  id: string;
  customerCode: string;
  name: string;
  mobile: string | null;
  mobileValid: boolean;
  altMobile: string | null;
  addressLine: string;
  landmark: string | null;
  status: string;
  statusReason: string | null;
  notes: string | null;
  collectionDay: number | null;
  paymentPreferenceMonths: number | null;
  createdAt: string;
  society: { id: string; name: string };
  area: { id: string; name: string } | null;
  currentAgent: { agentId: string; agentName: string; agentCode: string; kind: string; source: string } | null;
  primaryAgent: { agentId: string; agentName: string; agentCode: string; source: string } | null;
  activeConnections: { id: string; stbNumber: string; mqNumber: string | null; activeFrom: string }[];
}
interface Balance {
  balance: string;
  outstanding: string;
  advance: string;
  overdueAmount: string;
  oldestDueDate: string | null;
  lastPayment: { amount: string; paymentDate: string; mode: string } | null;
  pendingVerification: { id: string; amount: string; mode: string; reference: string | null }[];
}
interface Subscription {
  id: string;
  status: string;
  startDate: string;
  endDate: string | null;
  billingMode: string;
  billingIntervalMonths: number;
  billingAnchorDay: number;
  billingTiming: string;
  dueDays: number;
  currentMonthlyRate: string | null;
  /** Current rate, or the first upcoming one (then monthlyRateFrom is its start date). */
  monthlyRate: string | null;
  monthlyRateFrom: string | null;
  cycleAmount: string | null;
  nextBilling: { start: string; end: string; billingDate: string; dueDate: string; amount: string } | null;
  rates: { id: string; monthlyRate: string; effectiveFrom: string; reason: string | null }[];
  suspensions: { id: string; fromDate: string; toDate: string | null; reason: string; cancelledAt: string | null }[];
  suspendedToday: boolean;
}

type Tab = 'overview' | 'bills' | 'payments' | 'ledger' | 'excel' | 'activity' | 'assignments' | 'boxes' | 'audit';
type Dialog =
  | null
  | 'edit'
  | 'deactivate'
  | 'reactivate'
  | 'delete'
  | 'restore'
  | 'interaction'
  | 'followup'
  | 'credit'
  | 'debit'
  | 'refund'
  | 'opening'
  | 'stb'
  | 'agent'
  | 'subscription'
  | 'rate'
  | 'terms'
  | 'suspend'
  | 'resume'
  | 'end';

export default function CustomerDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('overview');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [menu, setMenu] = useState(false);
  const navigate = useNavigate();
  const close = () => setDialog(null);
  const refresh = () => qc.invalidateQueries({ predicate: (q) => JSON.stringify(q.queryKey).includes(id) || q.queryKey[0] === 'customers' });

  const customer = useQuery({ queryKey: ['customer', id], queryFn: () => api<CustomerDetail>('GET', `/customers/${id}`) });
  const balance = useQuery({ queryKey: ['customer', id, 'balance'], queryFn: () => api<Balance>('GET', `/customers/${id}/balance`) });
  const sub = useQuery({ queryKey: ['customer', id, 'subscription'], queryFn: () => api<Subscription | null>('GET', `/customers/${id}/subscription`) });

  if (customer.isLoading) return <Spinner />;
  if (customer.error || !customer.data) return <ErrorNote error={customer.error} />;
  const c = customer.data;
  const b = balance.data;
  const s = sub.data;
  const live = s && s.status !== 'ENDED';
  const done = (msg: string) => {
    toast(msg);
    return refresh();
  };

  return (
    <div className="space-y-4">
      <div className="text-sm text-muted">
        <Link to="/customers" className="hover:underline">
          Customers
        </Link>{' '}
        / {c.customerCode}
      </div>

      {c.deletedAt && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
          <span>
            This customer was <strong>deleted</strong> on {date(c.deletedAt)}
            {c.deleteReason && ` (${c.deleteReason})`}. The history below is kept.
          </span>
          {can('customers:manage') && (
            <Button size="sm" variant="secondary" onClick={() => setDialog('restore')}>
              Restore customer
            </Button>
          )}
        </div>
      )}
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold">{c.name}</h1>
              <StatusBadge status={c.status} />
              {c.currentAgent?.kind === 'TEMPORARY' && <Badge tone="info">temporarily with {c.currentAgent.agentName}</Badge>}
              {c.pendingDecision && <Badge tone="warn">Needs a rate decision</Badge>}
            </div>
            {c.pendingDecision && <p className="mt-1 text-sm text-warning">{c.pendingDecision}. Set up a subscription to start billing.</p>}
            <p className="mt-1 text-sm text-muted">
              <span className="num font-medium text-ink">{c.customerCode}</span> · {c.society.name}
              {c.area && ` · ${c.area.name}`} · {c.addressLine}
            </p>
            <p className="mt-1 flex flex-wrap items-center gap-3 text-sm">
              {c.mobile && (
                <a href={`tel:${c.mobile}`} className={cx('inline-flex items-center gap-1 hover:underline', !c.mobileValid && 'text-danger')}>
                  <Phone className="size-3.5" aria-hidden /> {c.mobile}
                  {!c.mobileValid && ' (invalid)'}
                </a>
              )}
              <span className="text-muted">Agent: {c.currentAgent ? `${c.currentAgent.agentName} (${c.currentAgent.agentCode})` : 'unassigned'}</span>
            </p>
            <div className="mt-3 flex flex-wrap gap-2 text-sm">
              <span className="rounded-lg bg-slate-100 px-2.5 py-1">
                Monthly charge:{' '}
                <strong className="num">
                  {s?.monthlyRate && s.status !== 'ENDED' ? `${inr(s.monthlyRate)}${s.monthlyRateFrom ? ` from ${date(s.monthlyRateFrom)}` : ''}` : 'not billed'}
                </strong>
              </span>
              {c.activeConnections.map((x) => (
                <span key={x.id} className="num rounded-lg bg-slate-100 px-2.5 py-1">
                  STB {x.stbNumber}
                  {x.mqNumber && ` · MQ ${x.mqNumber}`}
                </span>
              ))}
            </div>
          </div>
          <div className="text-right" data-testid="customer-balance">
            {b ? (
              b.outstanding !== '0.00' ? (
                <>
                  <div className="text-xs text-muted">Outstanding</div>
                  <div className="num text-2xl font-semibold text-danger">{inr(b.outstanding)}</div>
                  {b.overdueAmount !== '0.00' && <div className="text-xs text-danger">{inr(b.overdueAmount)} overdue since {date(b.oldestDueDate)}</div>}
                </>
              ) : (
                <>
                  <div className="text-xs text-muted">{b.advance !== '0.00' ? 'Advance' : 'Balance'}</div>
                  <div className={cx('num text-2xl font-semibold', b.advance !== '0.00' ? 'text-success' : 'text-ink')}>{b.advance !== '0.00' ? inr(b.advance) : 'Settled'}</div>
                </>
              )
            ) : (
              <Spinner />
            )}
            {b?.pendingVerification.length ? <div className="text-xs text-warning">{b.pendingVerification.length} payment(s) awaiting verification</div> : null}
          </div>
        </div>
        <div className={cx('mt-4 flex flex-wrap gap-2', c.deletedAt && 'hidden')}>
          {can('payments:record') && (
            <Link to={`/collect?customer=${c.id}`}>
              <Button>
                <ReceiptIndianRupee className="size-4" aria-hidden /> Collect payment
              </Button>
            </Link>
          )}
          {can('interactions:manage') && (
            <Button variant="secondary" onClick={() => setDialog('interaction')}>
              <Phone className="size-4" aria-hidden /> Log call / promise
            </Button>
          )}
          <Button variant="secondary" onClick={() => setDialog('followup')}>
            <CalendarPlus className="size-4" aria-hidden /> Follow-up
          </Button>
          {can('customers:manage') && (
            <Button variant="secondary" onClick={() => setDialog('edit')}>
              Edit
            </Button>
          )}
          <div className="relative">
            <Button variant="secondary" onClick={() => setMenu((m) => !m)} aria-expanded={menu} aria-label="More actions">
              <MoreHorizontal className="size-4" />
            </Button>
            {menu && (
              <div className="absolute right-0 z-20 mt-1 w-56 rounded-lg border border-line bg-white py-1 shadow-lg" onClick={() => setMenu(false)}>
                {(
                  [
                    ['credits:manage', 'credit', 'Discount / credit'],
                    ['credits:manage', 'debit', 'Extra charge'],
                    ['credits:manage', 'refund', 'Refund advance'],
                    ['credits:manage', 'opening', 'Opening balance'],
                    ['assignments:manage', 'agent', 'Change agent'],
                    ['customers:manage', 'stb', 'Replace set-top box'],
                    ['customers:manage', c.status === 'INACTIVE' ? 'reactivate' : 'deactivate', c.status === 'INACTIVE' ? 'Reactivate customer' : 'Deactivate customer'],
                    ['customers:manage', 'delete', 'Delete customer'],
                  ] as const
                )
                  .filter(([p]) => can(p))
                  .map(([, d, text]) => (
                    <button key={d} className={cx('block w-full px-3 py-2 text-left text-sm hover:bg-slate-50', d === 'delete' && 'text-danger')} onClick={() => setDialog(d)}>
                      {text}
                    </button>
                  ))}
              </div>
            )}
          </div>
        </div>
      </Card>

      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'overview', label: 'Overview' },
          { id: 'bills', label: 'Bills' },
          { id: 'payments', label: 'Payments' },
          { id: 'ledger', label: 'Ledger' },
          ...(c.imported ? [{ id: 'excel' as const, label: 'Excel history' }] : []),
          { id: 'activity', label: 'Calls, visits & follow-ups' },
          { id: 'assignments', label: 'Agent history' },
          { id: 'boxes', label: 'Set-top boxes' },
          ...(can('audit:read') ? [{ id: 'audit' as const, label: 'Audit' }] : []),
        ]}
      />

      {tab === 'overview' && (
        <div className="grid gap-4 lg:grid-cols-2">
          <MonthCalendar customerId={id} />
          <Card title="Details">
            <DescriptionList
              items={[
                ['Customer ID', c.customerCode],
                ['Mobile', c.mobile ?? '—'],
                ['Alternate mobile', c.altMobile ?? '—'],
                ['Address', c.addressLine],
                ['Landmark', c.landmark ?? '—'],
                ['Society', c.society.name],
                ['Area', c.area?.name ?? '—'],
                ['Set-top box', c.activeConnections.map((x) => x.stbNumber).join(', ') || '—'],
                ['MQ number', c.activeConnections.map((x) => x.mqNumber).filter(Boolean).join(', ') || '—'],
                ['Monthly charge', s?.monthlyRate && s.status !== 'ENDED' ? `${inr(s.monthlyRate)}${s.monthlyRateFrom ? ` from ${date(s.monthlyRateFrom)}` : ''}` : 'Not billed'],
                ['Status', <StatusBadge key="st" status={c.status} />],
                ['Primary agent', c.primaryAgent ? `${c.primaryAgent.agentName} (${label(c.primaryAgent.source)})` : '—'],
                ['Collection day', c.collectionDay ?? '—'],
                ['Usually pays', c.paymentPreferenceMonths ? `${c.paymentPreferenceMonths} month(s) at a time` : '—'],
                ['Customer since', date(c.createdAt)],
                ['Last payment', b?.lastPayment ? `${inr(b.lastPayment.amount)} on ${date(b.lastPayment.paymentDate)} (${label(b.lastPayment.mode)})` : '—'],
                ['Notes', c.notes ?? '—'],
                ...(c.statusReason ? ([['Status reason', c.statusReason]] as [string, string][]) : []),
                ...(c.pendingDecision ? ([['Needs decision', c.pendingDecision]] as [string, string][]) : []),
              ]}
            />
          </Card>
          <Card
            title="Subscription & billing"
            actions={
              can('billing:manage') &&
              (live ? (
                <>
                  <Button size="sm" variant="secondary" onClick={() => setDialog('rate')}>
                    Change rate
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => setDialog('terms')}>
                    Terms
                  </Button>
                </>
              ) : (
                c.status !== 'INACTIVE' && (
                  <Button size="sm" onClick={() => setDialog('subscription')}>
                    Start billing
                  </Button>
                )
              ))
            }
          >
            {!s ? (
              <p className="text-sm text-muted">No subscription yet — this customer is not being billed.</p>
            ) : (
              <div className="space-y-4">
                <DescriptionList
                  items={[
                    ['Status', <StatusBadge key="s" status={s.status} />],
                    ['Monthly rate', s.monthlyRate ? `${inr(s.monthlyRate)}${s.monthlyRateFrom ? ` from ${date(s.monthlyRateFrom)}` : ''}` : '—'],
                    ['Billed', `${s.billingIntervalMonths === 1 ? 'Monthly' : `Every ${s.billingIntervalMonths} months`} (${inr(s.cycleAmount)}), ${s.billingTiming === 'ADVANCE' ? 'in advance' : 'in arrears'}`],
                    ['Billing day', `${s.billingAnchorDay} of the month · due after ${s.dueDays} days`],
                    ['Mode', s.billingMode === 'AUTO' ? 'Automatic' : 'Manual (office raises bills)'],
                    ['Next bill', s.nextBilling ? `${inr(s.nextBilling.amount)} on ${date(s.nextBilling.billingDate)}` : s.status === 'ENDED' ? `Ended ${date(s.endDate)}` : '—'],
                  ]}
                />
                {live && can('billing:manage') && (
                  <div className="flex flex-wrap gap-2">
                    {s.suspendedToday || s.suspensions.some((x) => !x.cancelledAt && (x.toDate === null || x.toDate >= today())) ? (
                      <Button size="sm" variant="secondary" onClick={() => setDialog('resume')}>
                        Resume service
                      </Button>
                    ) : (
                      <Button size="sm" variant="secondary" onClick={() => setDialog('suspend')}>
                        Suspend
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => setDialog('end')}>
                      End billing
                    </Button>
                  </div>
                )}
                <div>
                  <h3 className="mb-1 text-xs font-medium text-muted">Rate history</h3>
                  <ul className="space-y-1 text-sm">
                    {s.rates.map((r) => (
                      <li key={r.id} className="flex justify-between gap-2">
                        <span>from {date(r.effectiveFrom)}</span>
                        <span className="num">{inr(r.monthlyRate)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                {s.suspensions.length > 0 && (
                  <div>
                    <h3 className="mb-1 text-xs font-medium text-muted">Suspensions</h3>
                    <ul className="space-y-1 text-sm">
                      {s.suspensions.map((x) => (
                        <li key={x.id} className={x.cancelledAt ? 'text-muted line-through' : ''}>
                          {date(x.fromDate)} → {x.toDate ? date(x.toDate) : 'until resumed'} · {x.reason}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </Card>
        </div>
      )}

      {tab === 'bills' && <BillsTab customerId={id} onChanged={refresh} />}
      {tab === 'payments' && <PaymentsTab customerId={id} onChanged={refresh} />}
      {tab === 'ledger' && <LedgerTab customerId={id} />}
      {tab === 'excel' && <ExcelHistoryTab customerId={id} />}
      {tab === 'activity' && <ActivityTab customerId={id} onChanged={refresh} />}
      {tab === 'assignments' && <AssignmentsTab customerId={id} />}
      {tab === 'boxes' && <BoxesTab customerId={id} />}
      {tab === 'audit' && <AuditTab customerId={id} />}

      {/* ----------------------------- dialogs ----------------------------- */}
      <EditCustomerDialog open={dialog === 'edit'} onClose={close} c={c} sub={s ?? null} onSaved={() => done('Customer updated')} />
      <ReasonDialog
        open={dialog === 'delete'}
        onClose={close}
        title={`Delete ${c.name}`}
        description="The customer disappears from the lists, the agent's phone and billing. The payment history stays, and you can restore the customer later from 'Deleted customers'. Customers who still owe money or have an advance cannot be deleted: settle it first, or deactivate them instead."
        confirmLabel="Delete customer"
        danger
        presets={DELETE_REASONS}
        onConfirm={async (reason) => {
          await api('POST', `/customers/${c.id}/delete`, { body: { reason } });
          toast(`Customer ${c.customerCode} deleted`);
          await refresh();
          navigate('/customers');
        }}
      />
      <ReasonDialog
        open={dialog === 'restore'}
        onClose={close}
        title={`Restore ${c.name}`}
        description="The customer comes back as inactive, with the agent of its area. Add the set-top box (Edit) and start billing again if needed, then reactivate."
        confirmLabel="Restore"
        presets={['Deleted by mistake', 'Customer came back']}
        onConfirm={async (reason) => {
          await api('POST', `/customers/${c.id}/restore`, { body: { reason } });
          await done('Customer restored');
        }}
      />
      <ReasonDialog
        open={dialog === 'deactivate'}
        onClose={close}
        title="Deactivate customer"
        danger
        confirmLabel="Deactivate"
        description="Billing stops today. Any outstanding amount stays collectable. Nothing is deleted."
        onConfirm={async (reason) => {
          await api('POST', `/customers/${id}/deactivate`, { body: { reason } });
          await done('Customer deactivated');
        }}
      />
      <ReasonDialog
        open={dialog === 'reactivate'}
        onClose={close}
        title="Reactivate customer"
        description="Start a new subscription afterwards to resume billing."
        onConfirm={async (reason) => {
          await api('POST', `/customers/${id}/reactivate`, { body: { reason } });
          await done('Customer reactivated');
        }}
      />
      <InteractionDialog open={dialog === 'interaction'} onClose={close} customerId={id} onSaved={() => done('Interaction recorded')} />
      <FollowUpDialog open={dialog === 'followup'} onClose={close} customerId={id} onSaved={() => done('Follow-up added')} />
      <MoneyReasonDialog
        open={dialog === 'credit'}
        onClose={close}
        title="Discount / credit"
        extra={(st, set) => (
          <Field label="Type">
            {(fid) => (
              <Select id={fid} value={st.kind ?? 'DISCOUNT'} onChange={(e) => set('kind', e.target.value)}>
                <option value="DISCOUNT">Discount</option>
                <option value="CREDIT_ADJUSTMENT">Credit adjustment</option>
              </Select>
            )}
          </Field>
        )}
        onSubmit={(v, key) => api('POST', `/customers/${id}/credits`, { body: { kind: v.kind ?? 'DISCOUNT', amount: v.amount, reason: v.reason }, idempotencyKey: key }).then(() => done('Credit applied'))}
      />
      <MoneyReasonDialog
        open={dialog === 'debit'}
        onClose={close}
        title="Extra charge"
        extra={(st, set) => <Field label="What is it for?" required>{(fid) => <Input id={fid} value={st.description ?? ''} onChange={(e) => set('description', e.target.value)} placeholder="e.g. Reconnection fee" />}</Field>}
        onSubmit={(v, key) => api('POST', `/customers/${id}/debits`, { body: { amount: v.amount, description: v.description, reason: v.reason }, idempotencyKey: key }).then(() => done('Charge added'))}
      />
      <MoneyReasonDialog
        open={dialog === 'refund'}
        onClose={close}
        title="Refund advance"
        note={b ? `Available advance: ${inr(b.advance)}` : undefined}
        extra={(st, set) => (
          <Field label="Paid back by">
            {(fid) => (
              <Select id={fid} value={st.mode ?? 'CASH'} onChange={(e) => set('mode', e.target.value)}>
                <option value="CASH">Cash</option>
                <option value="UPI">UPI</option>
                <option value="BANK_TRANSFER">Bank transfer</option>
              </Select>
            )}
          </Field>
        )}
        onSubmit={(v, key) => api('POST', `/customers/${id}/refunds`, { body: { amount: v.amount, mode: v.mode ?? 'CASH', reason: v.reason }, idempotencyKey: key }).then(() => done('Refund recorded'))}
      />
      <MoneyReasonDialog
        open={dialog === 'opening'}
        onClose={close}
        title="Opening balance"
        note="One-time balance brought forward from the old records. Choose whether the customer owed money or had paid ahead."
        extra={(st, set) => (
          <>
            <Field label="The customer…">
              {(fid) => (
                <Select id={fid} value={st.sign ?? 'due'} onChange={(e) => set('sign', e.target.value)}>
                  <option value="due">owed this amount</option>
                  <option value="advance">had paid this in advance</option>
                </Select>
              )}
            </Field>
            <Field label="As of">{(fid) => <Input id={fid} type="date" max={today()} value={st.asOf ?? today()} onChange={(e) => set('asOf', e.target.value)} />}</Field>
          </>
        )}
        onSubmit={(v, key) =>
          api('POST', `/customers/${id}/opening-balance`, {
            body: { amount: v.sign === 'advance' ? `-${v.amount}` : v.amount, asOf: v.asOf ?? today(), reason: v.reason },
            idempotencyKey: key,
          }).then(() => done('Opening balance recorded'))
        }
      />
      <StbDialog open={dialog === 'stb'} onClose={close} customerId={id} onSaved={() => done('Set-top box replaced')} />
      <AgentDialog open={dialog === 'agent'} onClose={close} customerId={id} onSaved={() => done('Agent changed')} />
      <SubscriptionDialogs which={dialog} onClose={close} customerId={id} sub={s ?? null} onSaved={done} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

interface InvoiceRow {
  id: string;
  invoiceNumber: string;
  kind: string;
  periodStart: string | null;
  periodEnd: string | null;
  billingDate: string;
  dueDate: string;
  total: string;
  amountPaid: string;
  balance: string;
  displayStatus: string;
  description: string | null;
}

function BillsTab({ customerId, onChanged }: { customerId: string; onChanged: () => void }) {
  const { can } = useAuth();
  const [page, setPage] = useState(1);
  const [cancel, setCancel] = useState<InvoiceRow | null>(null);
  const { data, isLoading } = useQuery({ queryKey: ['customer', customerId, 'invoices', page], queryFn: () => apiPage<InvoiceRow>(`/customers/${customerId}/invoices`, { page, pageSize: 20 }) });
  return (
    <Card padded={false}>
      <DataTable
        rows={data?.items}
        loading={isLoading}
        rowKey={(r) => r.id}
        empty="No bills yet"
        columns={[
          { key: 'no', header: 'Bill', cell: (r) => <span className="num">{r.invoiceNumber}</span> },
          { key: 'what', header: 'For', cell: (r) => (r.periodStart ? `${date(r.periodStart)} – ${date(r.periodEnd)}` : r.description ?? label(r.kind)) },
          { key: 'due', header: 'Due', cell: (r) => date(r.dueDate) },
          { key: 'total', header: 'Amount', align: 'right', cell: (r) => inr(r.total) },
          { key: 'paid', header: 'Paid', align: 'right', cell: (r) => inr(r.amountPaid) },
          { key: 'bal', header: 'Balance', align: 'right', cell: (r) => inr(r.balance) },
          { key: 'st', header: 'Status', cell: (r) => <StatusBadge status={r.displayStatus} /> },
          {
            key: 'act',
            header: '',
            cell: (r) =>
              can('billing:manage') && r.displayStatus !== 'CANCELLED' ? (
                <Button size="sm" variant="ghost" onClick={() => setCancel(r)}>
                  Cancel
                </Button>
              ) : null,
          },
        ]}
      />
      {data && <Pagination page={page} pageSize={20} total={data.meta.total} onPage={setPage} />}
      <ReasonDialog
        open={!!cancel}
        onClose={() => setCancel(null)}
        title={`Cancel bill ${cancel?.invoiceNumber ?? ''}`}
        danger
        confirmLabel="Cancel bill"
        description="The charge is reversed in the ledger. Any money paid against it moves to the next open bill or becomes advance."
        onConfirm={async (reason, key) => {
          await api('POST', `/invoices/${cancel!.id}/cancel`, { body: { reason }, idempotencyKey: key });
          onChanged();
        }}
      />
    </Card>
  );
}

interface PaymentRow {
  id: string;
  amount: string;
  paymentDate: string;
  mode: string;
  reference: string | null;
  status: string;
  source: string;
  collectedByName: string | null;
  correctionNote: string | null;
  deletedByAgent: boolean;
}

/** Status of a payment, with "Deleted by agent" and the reason for a reversed / failed one. */
export function PaymentStatus({ status, deletedByAgent, note }: { status: string; deletedByAgent?: boolean; note?: string | null }) {
  return (
    <span className="flex flex-col items-start gap-0.5">
      {deletedByAgent ? <Badge tone="bad">deleted by agent</Badge> : <StatusBadge status={status} />}
      {note && <span className="max-w-64 text-xs text-muted">{note.replace(/^Deleted by agent: /, '')}</span>}
    </span>
  );
}

export async function openReceipt(paymentId: string) {
  const p = await api<{ receipt: { id: string } | null }>('GET', `/payments/${paymentId}`);
  if (!p.receipt) throw new Error('No receipt yet');
  await download(`/receipts/${p.receipt.id}/pdf`, undefined, 'open');
}

function PaymentsTab({ customerId, onChanged }: { customerId: string; onChanged: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const [page, setPage] = useState(1);
  const [reverse, setReverse] = useState<PaymentRow | null>(null);
  const { data, isLoading } = useQuery({ queryKey: ['customer', customerId, 'payments', page], queryFn: () => apiPage<PaymentRow>(`/customers/${customerId}/payments`, { page, pageSize: 20 }) });
  return (
    <Card padded={false}>
      <DataTable
        rows={data?.items}
        loading={isLoading}
        rowKey={(r) => r.id}
        empty="No payments yet"
        columns={[
          { key: 'd', header: 'Date', cell: (r) => date(r.paymentDate) },
          { key: 'amt', header: 'Amount', align: 'right', cell: (r) => inr(r.amount) },
          { key: 'mode', header: 'Mode', cell: (r) => `${label(r.mode)}${r.reference ? ` · ${r.reference}` : ''}` },
          { key: 'by', header: 'Collected by', cell: (r) => `${r.collectedByName ?? '—'} (${label(r.source)})` },
          { key: 'st', header: 'Status', cell: (r) => <PaymentStatus status={r.status} deletedByAgent={r.deletedByAgent} note={r.correctionNote} /> },
          {
            key: 'act',
            header: '',
            cell: (r) => (
              <div className="flex justify-end gap-1">
                {(r.status === 'CONFIRMED' || r.status === 'REVERSED') && (
                  <Button size="sm" variant="ghost" onClick={() => openReceipt(r.id).catch((e: Error) => toast(e.message, 'bad'))} aria-label="Receipt PDF">
                    <FileDown className="size-4" /> Receipt
                  </Button>
                )}
                {can('payments:reverse') && r.status === 'CONFIRMED' && (
                  <Button size="sm" variant="ghost" onClick={() => setReverse(r)}>
                    Reverse
                  </Button>
                )}
              </div>
            ),
          },
        ]}
      />
      {data && <Pagination page={page} pageSize={20} total={data.meta.total} onPage={setPage} />}
      <ReasonDialog
        open={!!reverse}
        onClose={() => setReverse(null)}
        title={`Reverse ${reverse ? inr(reverse.amount) : ''} payment`}
        danger
        confirmLabel="Reverse payment"
        description="Use this for a wrong entry. The payment stays in history, its receipt is cancelled, and the bills it paid reopen. Enter the correct payment separately."
        onConfirm={async (reason, key) => {
          await api('POST', `/payments/${reverse!.id}/reverse`, { body: { reason }, idempotencyKey: key });
          toast('Payment reversed');
          onChanged();
        }}
      />
    </Card>
  );
}

function LedgerTab({ customerId }: { customerId: string }) {
  const toast = useToast();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [reverse, setReverse] = useState<{ creditNoteId: string; description: string } | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ['customer', customerId, 'ledger'],
    queryFn: () =>
      api<{ entries: { id: string; entryDate: string; type: string; description: string; debit: string | null; credit: string | null; runningBalance: string; creditNoteId: string | null; reversesEntryId: string | null }[] }>(
        'GET',
        `/customers/${customerId}/ledger`,
      ),
  });
  return (
    <Card
      padded={false}
      title="Statement"
      actions={
        <Button size="sm" variant="secondary" onClick={() => download('/reports/customer-ledger', { customerId, format: 'pdf' }).catch((e: Error) => toast(e.message, 'bad'))}>
          <FileDown className="size-4" /> PDF
        </Button>
      }
    >
      <DataTable
        rows={data?.entries}
        loading={isLoading}
        rowKey={(r) => r.id}
        empty="No entries yet"
        columns={[
          { key: 'd', header: 'Date', cell: (r) => date(r.entryDate) },
          { key: 't', header: 'Type', cell: (r) => <Badge>{label(r.type)}</Badge> },
          { key: 'desc', header: 'Description', cell: (r) => r.description },
          { key: 'dr', header: 'Charge', align: 'right', cell: (r) => (r.debit ? inr(r.debit) : '') },
          { key: 'cr', header: 'Paid / credit', align: 'right', cell: (r) => (r.credit ? inr(r.credit) : '') },
          { key: 'bal', header: 'Balance', align: 'right', cell: (r) => <span className={r.runningBalance.startsWith('-') ? 'text-success' : ''}>{inr(r.runningBalance)}</span> },
          {
            key: 'x',
            header: '',
            cell: (r) =>
              can('credits:manage') &&
              r.creditNoteId &&
              !r.reversesEntryId &&
              !data?.entries.some((x) => x.reversesEntryId === r.id) && (
                <Button size="sm" variant="ghost" onClick={() => setReverse({ creditNoteId: r.creditNoteId!, description: r.description })}>
                  Reverse
                </Button>
              ),
          },
        ]}
      />
      <p className="border-t border-line px-3 py-2 text-xs text-muted">Positive balance = customer owes; negative = advance.</p>
      <ReasonDialog
        open={!!reverse}
        onClose={() => setReverse(null)}
        title="Reverse discount / credit"
        description={`${reverse?.description ?? ''}. The amount is added back to the customer's balance; both entries stay in the statement.`}
        confirmLabel="Reverse"
        danger
        presets={['Entered by mistake', 'Wrong amount']}
        onConfirm={async (reason) => {
          await api('POST', `/credits/${reverse!.creditNoteId}/reverse`, { body: { reason } });
          toast('Credit reversed');
          await qc.invalidateQueries({ predicate: (q) => JSON.stringify(q.queryKey).includes(customerId) });
        }}
      />
    </Card>
  );
}

/** The customer's month grid from the Excel workbook, read-only (EXCEL_MIGRATION_MAPPING §6.2). */
function ExcelHistoryTab({ customerId }: { customerId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['customer', customerId, 'legacy'],
    queryFn: () =>
      api<{ month: string; rateRaw: string | null; rate: string; opening: string; received: string; feeAdjusted: string; closingAdvance: string; amountDue: string; paymentDate: string | null; notes: string | null }[]>(
        'GET',
        `/customers/${customerId}/legacy-statement`,
      ),
  });
  return (
    <Card padded={false} title="Excel history (read-only)">
      <DataTable
        rows={data}
        loading={isLoading}
        rowKey={(r) => r.month}
        empty="No Excel history for this customer"
        columns={[
          { key: 'm', header: 'Month', cell: (r) => r.month.slice(0, 7) },
          { key: 'r', header: 'Rate', align: 'right', cell: (r) => (r.rateRaw && !/^\d/.test(r.rateRaw) ? r.rateRaw : inr(r.rate)) },
          { key: 'o', header: 'Opening (+adv / −due)', align: 'right', cell: (r) => inr(r.opening) },
          { key: 'p', header: 'Received', align: 'right', cell: (r) => inr(r.received) },
          { key: 'd', header: 'Date', cell: (r) => date(r.paymentDate) },
          { key: 'f', header: 'Fee adjusted', align: 'right', cell: (r) => inr(r.feeAdjusted) },
          { key: 'a', header: 'Closing advance', align: 'right', cell: (r) => inr(r.closingAdvance) },
          { key: 'due', header: 'Amount due', align: 'right', cell: (r) => inr(r.amountDue) },
        ]}
      />
      <p className="border-t border-line px-3 py-2 text-xs text-muted">As calculated by the workbook. Kept for reference; balances and receipts come from the ledger.</p>
    </Card>
  );
}

function ActivityTab({ customerId, onChanged }: { customerId: string; onChanged: () => void }) {
  const toast = useToast();
  const interactions = useQuery({
    queryKey: ['customer', customerId, 'interactions'],
    queryFn: () =>
      apiPage<{ id: string; createdAt: string; channel: string; interactionType: string; status: string; expectedAmount: string | null; promiseDate: string | null; notes: string | null; recordedByName: string }>(
        '/interactions',
        { customerId, pageSize: 50 },
      ),
  });
  const visits = useQuery({
    queryKey: ['customer', customerId, 'visits'],
    queryFn: () => apiPage<{ id: string; visitedAt: string; outcome: string; notes: string | null; agentName: string; promisedAmount: string | null; followUpDate: string | null }>(`/customers/${customerId}/visits`, { pageSize: 50 }),
  });
  const followUps = useQuery({
    queryKey: ['customer', customerId, 'followups'],
    queryFn: () => apiPage<{ id: string; dueDate: string; title: string; assignedToName: string | null; overdue: boolean }>('/follow-ups', { scope: 'all', customerId, pageSize: 50 }),
  });
  const complete = async (taskId: string) => {
    await api('POST', `/follow-ups/${taskId}/complete`, { body: {} });
    toast('Follow-up done');
    onChanged();
  };
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card title="Open follow-ups" padded={false}>
        <ul className="divide-y divide-line">
          {followUps.data?.items.length === 0 && <li className="p-4 text-sm text-muted">Nothing pending</li>}
          {followUps.data?.items.map((t) => (
            <li key={t.id} className="flex items-start justify-between gap-2 p-3 text-sm">
              <div>
                <div className={t.overdue ? 'text-danger' : ''}>{date(t.dueDate)}</div>
                <div>{t.title}</div>
                <div className="text-xs text-muted">{t.assignedToName ?? 'Customer’s agent'}</div>
              </div>
              <Button size="sm" variant="secondary" onClick={() => complete(t.id)}>
                Done
              </Button>
            </li>
          ))}
        </ul>
      </Card>
      <Card title="Calls & promises" padded={false}>
        <ul className="divide-y divide-line">
          {interactions.data?.items.length === 0 && <li className="p-4 text-sm text-muted">No calls recorded</li>}
          {interactions.data?.items.map((i) => (
            <li key={i.id} className="space-y-0.5 p-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{label(i.interactionType)}</span>
                <StatusBadge status={i.status} />
              </div>
              {i.expectedAmount && (
                <div>
                  Promised {inr(i.expectedAmount)} by {date(i.promiseDate)}
                </div>
              )}
              {i.notes && <div className="text-muted">{i.notes}</div>}
              <div className="text-xs text-muted">
                {label(i.channel)} · {i.recordedByName} · {dateTime(i.createdAt)}
              </div>
            </li>
          ))}
        </ul>
      </Card>
      <Card title="Field visits" padded={false}>
        <ul className="divide-y divide-line">
          {visits.data?.items.length === 0 && <li className="p-4 text-sm text-muted">No visits recorded</li>}
          {visits.data?.items.map((v) => (
            <li key={v.id} className="space-y-0.5 p-3 text-sm">
              <div className="font-medium">{label(v.outcome)}</div>
              {v.notes && <div className="text-muted">{v.notes}</div>}
              <div className="text-xs text-muted">
                {v.agentName} · {dateTime(v.visitedAt)}
              </div>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function AssignmentsTab({ customerId }: { customerId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['customer', customerId, 'assignments'],
    queryFn: () =>
      api<{ id: string; kind: string; source: string; agentName: string; agentCode: string; validFrom: string | null; validTo: string | null; cancelledBeforeStart: boolean; isCurrent: boolean; reason: string | null; endedReason: string | null }[]>(
        'GET',
        `/customers/${customerId}/assignments`,
      ),
  });
  return (
    <Card padded={false}>
      <DataTable
        rows={data}
        loading={isLoading}
        rowKey={(r) => r.id}
        empty="Never assigned"
        columns={[
          { key: 'agent', header: 'Agent', cell: (r) => `${r.agentName} (${r.agentCode})` },
          { key: 'kind', header: 'Type', cell: (r) => <Badge tone={r.kind === 'TEMPORARY' ? 'info' : 'neutral'}>{label(r.kind)}</Badge> },
          { key: 'src', header: 'How', cell: (r) => label(r.source) },
          { key: 'from', header: 'From', cell: (r) => (r.cancelledBeforeStart ? <span className="text-muted">cancelled</span> : dateTime(r.validFrom)) },
          { key: 'to', header: 'To', cell: (r) => (r.isCurrent ? <Badge tone="good">current</Badge> : r.validTo ? dateTime(r.validTo) : '—') },
          { key: 'why', header: 'Reason', cell: (r) => r.endedReason ?? r.reason ?? '—' },
        ]}
      />
    </Card>
  );
}

function BoxesTab({ customerId }: { customerId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['customer', customerId, 'connections'],
    queryFn: () => api<{ id: string; stbNumber: string; mqNumber: string | null; activeFrom: string; activeTo: string | null; reason: string | null }[]>('GET', `/customers/${customerId}/connections`),
  });
  return (
    <Card padded={false}>
      <DataTable
        rows={data}
        loading={isLoading}
        rowKey={(r) => r.id}
        empty="No set-top box recorded"
        columns={[
          { key: 'stb', header: 'STB number', cell: (r) => <span className="num">{r.stbNumber}</span> },
          { key: 'mq', header: 'MQ', cell: (r) => r.mqNumber ?? '—' },
          { key: 'from', header: 'Active from', cell: (r) => date(r.activeFrom) },
          { key: 'to', header: 'Until', cell: (r) => (r.activeTo ? date(r.activeTo) : <Badge tone="good">active</Badge>) },
          { key: 'why', header: 'Reason', cell: (r) => r.reason ?? '—' },
        ]}
      />
    </Card>
  );
}

function AuditTab({ customerId }: { customerId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['customer', customerId, 'audit'],
    queryFn: () => apiPage<{ id: string; occurredAt: string; action: string; actorName: string | null; reason: string | null; before: unknown; after: unknown }>('/audit-logs', { entityType: 'customer', entityId: customerId, pageSize: 100 }),
  });
  return (
    <Card padded={false}>
      <DataTable
        rows={data?.items}
        loading={isLoading}
        rowKey={(r) => r.id}
        empty="No audit entries"
        columns={[
          { key: 'when', header: 'When', cell: (r) => dateTime(r.occurredAt) },
          { key: 'who', header: 'Who', cell: (r) => r.actorName ?? 'System' },
          { key: 'what', header: 'Action', cell: (r) => r.action },
          { key: 'why', header: 'Reason', cell: (r) => r.reason ?? '—' },
          {
            key: 'chg',
            header: 'Change',
            cell: (r) => (
              <code className="block max-w-md text-xs break-all whitespace-pre-wrap text-muted">
                {r.before ? `${JSON.stringify(r.before)} → ` : ''}
                {r.after ? JSON.stringify(r.after) : ''}
              </code>
            ),
          },
        ]}
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

/** First day of next month (YYYY-MM-DD): when billing starts for a customer set up from Edit. */
const nextMonthStart = () => {
  const [y, m] = today().split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
};

function EditCustomerDialog({ open, onClose, c, sub, onSaved }: { open: boolean; onClose: () => void; c: CustomerDetail; sub: Subscription | null; onSaved: () => void }) {
  const box = c.activeConnections[0];
  const live = sub && sub.status !== 'ENDED' ? sub : null;
  const currentRate = live?.monthlyRate ?? '';
  const [rate, setRate] = useState(currentRate);
  const rateChanged = rate.trim() !== '' && Number(rate) !== Number(currentRate || NaN);
  const rateFrom = live ? (live.nextBilling?.start ?? today()) : nextMonthStart();
  const [f, setF] = useState({ customerCode: c.customerCode, stbNumber: box?.stbNumber ?? '', mqNumber: box?.mqNumber ?? '', name: c.name, mobile: c.mobile ?? '', altMobile: c.altMobile ?? '', addressLine: c.addressLine, landmark: c.landmark ?? '', societyId: c.society.id, notes: c.notes ?? '', collectionDay: c.collectionDay?.toString() ?? '', paymentPreferenceMonths: c.paymentPreferenceMonths?.toString() ?? '', ack: false });
  const up = (k: keyof typeof f, v: string | boolean) => setF((s) => ({ ...s, [k]: v }));
  return (
    <ActionDialog
      open={open}
      onClose={onClose}
      title="Edit customer"
      wide
      onSubmit={async () => {
        await api('PATCH', `/customers/${c.id}`, {
          body: {
            customerCode: f.customerCode,
            stbNumber: f.stbNumber.trim(),
            mqNumber: f.mqNumber.trim() || null,
            name: f.name,
            mobile: f.mobile || null,
            altMobile: f.altMobile || null,
            addressLine: f.addressLine,
            landmark: f.landmark || null,
            societyId: f.societyId,
            notes: f.notes || null,
            collectionDay: f.collectionDay ? Number(f.collectionDay) : null,
            paymentPreferenceMonths: f.paymentPreferenceMonths ? Number(f.paymentPreferenceMonths) : null,
            acknowledgeWarnings: f.ack,
          },
        });
        if (rateChanged) {
          if (live) {
            await api('POST', `/subscriptions/${live.id}/rates`, { body: { monthlyRate: rate.trim(), effectiveFrom: rateFrom, reason: 'Changed in Edit customer' } });
          } else {
            await api('POST', `/customers/${c.id}/subscription`, { body: { monthlyRate: rate.trim(), startDate: rateFrom, billingIntervalMonths: 1 } });
          }
        }
        onSaved();
      }}
    >
      {(err) => (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Customer ID" error={err.customerCode}>{(id) => <Input id={id} value={f.customerCode} onChange={(e) => up('customerCode', e.target.value)} />}</Field>
          <Field label="Name" error={err.name}>{(id) => <Input id={id} value={f.name} onChange={(e) => up('name', e.target.value)} />}</Field>
          <Field label="STB number" error={err.stbNumber} hint="Fix a typing mistake here. For a new box use ⋯ → Replace set-top box (keeps history).">
            {(id) => <Input id={id} value={f.stbNumber} onChange={(e) => up('stbNumber', e.target.value)} />}
          </Field>
          <Field label="MQ number" error={err.mqNumber}>{(id) => <Input id={id} value={f.mqNumber} onChange={(e) => up('mqNumber', e.target.value)} />}</Field>
          <Field
            label="Monthly charge"
            error={err.monthlyRate}
            hint={
              rateChanged
                ? live
                  ? `New charge applies from ${date(rateFrom)} (next bill). Past bills do not change.`
                  : `Billing starts on ${date(rateFrom)} at this charge.`
                : live
                  ? 'Current charge. Change it here; past bills do not change.'
                  : 'Not billed yet. Enter the charge to start billing next month.'
            }
          >
            {(id) => <MoneyInput id={id} value={rate} onChange={setRate} />}
          </Field>
          <Field label="Mobile" error={err.mobile}>{(id) => <Input id={id} value={f.mobile} onChange={(e) => up('mobile', e.target.value)} />}</Field>
          <Field label="Alternate mobile">{(id) => <Input id={id} value={f.altMobile} onChange={(e) => up('altMobile', e.target.value)} />}</Field>
          <Field label="Society">{(id) => <SocietySelect id={id} value={f.societyId} onChange={(v) => up('societyId', v)} includeAll={false} />}</Field>
          <div className="sm:col-span-2">
            <Field label="Address" error={err.addressLine}>{(id) => <Input id={id} value={f.addressLine} onChange={(e) => up('addressLine', e.target.value)} />}</Field>
          </div>
          <Field label="Landmark">{(id) => <Input id={id} value={f.landmark} onChange={(e) => up('landmark', e.target.value)} />}</Field>
          <Field label="Collection day (1–31)">{(id) => <Input id={id} type="number" min={1} max={31} value={f.collectionDay} onChange={(e) => up('collectionDay', e.target.value)} />}</Field>
          <Field label="Usually pays (months at a time)">{(id) => <Input id={id} type="number" min={1} max={24} value={f.paymentPreferenceMonths} onChange={(e) => up('paymentPreferenceMonths', e.target.value)} />}</Field>
          <Field label="Notes">{(id) => <Textarea id={id} value={f.notes} onChange={(e) => up('notes', e.target.value)} />}</Field>
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input type="checkbox" checked={f.ack} onChange={(e) => up('ack', e.target.checked)} /> Save even if the mobile is shared or looks invalid
          </label>
        </div>
      )}
    </ActionDialog>
  );
}

function InteractionDialog({ open, onClose, customerId, onSaved }: { open: boolean; onClose: () => void; customerId: string; onSaved: () => void }) {
  const [f, setF] = useState({ channel: 'CALL', interactionType: 'PAYMENT_PROMISE', expectedAmount: '', promiseDate: '', followUpDate: '', notes: '' });
  const up = (k: keyof typeof f, v: string) => setF((s) => ({ ...s, [k]: v }));
  const promise = f.interactionType === 'PAYMENT_PROMISE';
  return (
    <ActionDialog
      open={open}
      onClose={onClose}
      title="Log a call or promise"
      onSubmit={async () => {
        await api('POST', `/customers/${customerId}/interactions`, {
          body: {
            channel: f.channel,
            interactionType: f.interactionType,
            expectedAmount: promise ? f.expectedAmount : null,
            promiseDate: promise ? f.promiseDate : null,
            followUpDate: f.followUpDate || null,
            notes: f.notes || null,
          },
        });
        onSaved();
      }}
    >
      {(err) => (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="How">
              {(id) => (
                <Select id={id} value={f.channel} onChange={(e) => up('channel', e.target.value)}>
                  {['CALL', 'WHATSAPP', 'WALK_IN', 'OTHER'].map((x) => <option key={x} value={x}>{label(x)}</option>)}
                </Select>
              )}
            </Field>
            <Field label="About">
              {(id) => (
                <Select id={id} value={f.interactionType} onChange={(e) => up('interactionType', e.target.value)}>
                  {['PAYMENT_PROMISE', 'COMPLAINT', 'QUERY', 'DISCONNECTION_REQUEST', 'RECONNECTION_REQUEST', 'OTHER'].map((x) => <option key={x} value={x}>{label(x)}</option>)}
                </Select>
              )}
            </Field>
            {promise && (
              <>
                <Field label="Promised amount" required error={err.expectedAmount}>{(id) => <MoneyInput id={id} value={f.expectedAmount} onChange={(v) => up('expectedAmount', v)} />}</Field>
                <Field label="Will pay by" required error={err.promiseDate}>{(id) => <Input id={id} type="date" min={today()} value={f.promiseDate} onChange={(e) => up('promiseDate', e.target.value)} />}</Field>
              </>
            )}
            <Field label="Follow up on" hint={promise ? 'Defaults to the promise date' : undefined}>{(id) => <Input id={id} type="date" value={f.followUpDate} onChange={(e) => up('followUpDate', e.target.value)} />}</Field>
          </div>
          <Field label="Notes">{(id) => <Textarea id={id} value={f.notes} onChange={(e) => up('notes', e.target.value)} />}</Field>
          {promise && <p className="text-xs text-muted">A promise does not change the balance. It is closed automatically when a payment is received.</p>}
        </>
      )}
    </ActionDialog>
  );
}

function FollowUpDialog({ open, onClose, customerId, onSaved }: { open: boolean; onClose: () => void; customerId: string; onSaved: () => void }) {
  const [f, setF] = useState({ dueDate: today(), title: '', assignedTo: '' });
  return (
    <ActionDialog
      open={open}
      onClose={onClose}
      title="Add follow-up"
      onSubmit={async () => {
        await api('POST', `/customers/${customerId}/follow-ups`, { body: { dueDate: f.dueDate, title: f.title, assignedTo: f.assignedTo || null } });
        onSaved();
      }}
    >
      {(err) => (
        <>
          <Field label="What needs doing" required error={err.title}>{(id) => <Input id={id} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />}</Field>
          <Field label="When">{(id) => <Input id={id} type="date" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} />}</Field>
          <Field label="Assign to agent" hint="Leave empty to keep it with you">{(id) => <AgentSelect id={id} value={f.assignedTo} onChange={(v) => setF({ ...f, assignedTo: v })} allLabel="Me" />}</Field>
        </>
      )}
    </ActionDialog>
  );
}

/** Amount + reason dialog with optional extra fields (credits, debits, refunds, opening balance). */
function MoneyReasonDialog({
  open,
  onClose,
  title,
  note,
  extra,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  note?: string;
  extra?: (state: Record<string, string>, set: (k: string, v: string) => void) => ReactNode;
  onSubmit: (v: Record<string, string>, key: string) => Promise<unknown>;
}) {
  const [st, setSt] = useState<Record<string, string>>({});
  const set = (k: string, v: string) => setSt((s) => ({ ...s, [k]: v }));
  return (
    <ActionDialog
      open={open}
      onClose={() => {
        setSt({});
        onClose();
      }}
      title={title}
      disabled={!st.amount || (st.reason ?? '').trim().length < 3}
      onSubmit={(key) => onSubmit(st, key).then(() => setSt({}))}
    >
      {(err) => (
        <>
          {note && <p className="text-sm text-muted">{note}</p>}
          <Field label="Amount" required error={err.amount}>{(id) => <MoneyInput id={id} value={st.amount ?? ''} onChange={(v) => set('amount', v)} autoFocus />}</Field>
          {extra?.(st, set)}
          <Field label="Reason" required error={err.reason}>{(id) => <Textarea id={id} value={st.reason ?? ''} onChange={(e) => set('reason', e.target.value)} />}</Field>
        </>
      )}
    </ActionDialog>
  );
}

function StbDialog({ open, onClose, customerId, onSaved }: { open: boolean; onClose: () => void; customerId: string; onSaved: () => void }) {
  const [f, setF] = useState({ stbNumber: '', mqNumber: '', effectiveDate: today(), reason: '' });
  return (
    <ActionDialog
      open={open}
      onClose={onClose}
      title="Replace set-top box"
      onSubmit={async () => {
        await api('POST', `/customers/${customerId}/connections/replace`, { body: { ...f, mqNumber: f.mqNumber || null } });
        onSaved();
      }}
    >
      {(err) => (
        <>
          <Field label="New STB number" required error={err.stbNumber}>{(id) => <Input id={id} value={f.stbNumber} onChange={(e) => setF({ ...f, stbNumber: e.target.value })} />}</Field>
          <Field label="MQ number">{(id) => <Input id={id} value={f.mqNumber} onChange={(e) => setF({ ...f, mqNumber: e.target.value })} />}</Field>
          <Field label="Effective">{(id) => <Input id={id} type="date" value={f.effectiveDate} onChange={(e) => setF({ ...f, effectiveDate: e.target.value })} />}</Field>
          <Field label="Reason" required error={err.reason}>{(id) => <Textarea id={id} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />}</Field>
        </>
      )}
    </ActionDialog>
  );
}

function AgentDialog({ open, onClose, customerId, onSaved }: { open: boolean; onClose: () => void; customerId: string; onSaved: () => void }) {
  const [f, setF] = useState({ agentId: '', reason: '' });
  return (
    <ActionDialog
      open={open}
      onClose={onClose}
      title="Change agent (permanent)"
      disabled={!f.agentId}
      onSubmit={async () => {
        await api('POST', '/assignments/permanent', { body: { agentId: f.agentId, customerIds: [customerId], reason: f.reason } });
        onSaved();
      }}
    >
      {(err) => (
        <>
          <p className="text-sm text-muted">This pins the customer to the agent regardless of the area. For a few days’ cover, use Assignments → Temporary cover instead.</p>
          <Field label="Agent" required>{(id) => <AgentSelect id={id} value={f.agentId} onChange={(v) => setF({ ...f, agentId: v })} includeAll={false} />}</Field>
          <Field label="Reason" required error={err.reason}>{(id) => <Textarea id={id} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />}</Field>
        </>
      )}
    </ActionDialog>
  );
}

function SubscriptionDialogs({ which, onClose, customerId, sub, onSaved }: { which: Dialog; onClose: () => void; customerId: string; sub: Subscription | null; onSaved: (msg: string) => unknown }) {
  const [f, setF] = useState<Record<string, string>>({});
  const set = (k: string, v: string) => setF((s) => ({ ...s, [k]: v }));
  const v = (k: string, d = '') => f[k] ?? d;
  const closeAll = () => {
    setF({});
    onClose();
  };
  return (
    <>
      <ActionDialog
        open={which === 'subscription'}
        onClose={closeAll}
        title="Start billing"
        disabled={!v('monthlyRate')}
        onSubmit={async () => {
          await api('POST', `/customers/${customerId}/subscription`, {
            body: {
              monthlyRate: v('monthlyRate'),
              startDate: v('startDate', today()),
              billingIntervalMonths: Number(v('interval', '1')),
              billingTiming: v('timing', 'ADVANCE'),
              billingMode: v('mode', 'AUTO'),
              ...(v('anchor') ? { billingAnchorDay: Number(v('anchor')) } : {}),
            },
          });
          setF({});
          await onSaved('Billing started');
        }}
      >
        {(err) => (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Monthly rate" required error={err.monthlyRate}>{(id) => <MoneyInput id={id} value={v('monthlyRate')} onChange={(x) => set('monthlyRate', x)} autoFocus />}</Field>
            <Field label="Start date">{(id) => <Input id={id} type="date" value={v('startDate', today())} onChange={(e) => set('startDate', e.target.value)} />}</Field>
            <Field label="Bill every">
              {(id) => (
                <Select id={id} value={v('interval', '1')} onChange={(e) => set('interval', e.target.value)}>
                  {[1, 2, 3, 4, 6, 12].map((m) => <option key={m} value={m}>{m === 1 ? 'Month' : `${m} months`}</option>)}
                </Select>
              )}
            </Field>
            <Field label="Billing day" hint="Default: the start date’s day">{(id) => <Input id={id} type="number" min={1} max={28} value={v('anchor')} onChange={(e) => set('anchor', e.target.value)} />}</Field>
            <Field label="Bill">
              {(id) => (
                <Select id={id} value={v('timing', 'ADVANCE')} onChange={(e) => set('timing', e.target.value)}>
                  <option value="ADVANCE">At the start of each period</option>
                  <option value="ARREARS">At the end of each period</option>
                </Select>
              )}
            </Field>
            <Field label="Mode">
              {(id) => (
                <Select id={id} value={v('mode', 'AUTO')} onChange={(e) => set('mode', e.target.value)}>
                  <option value="AUTO">Automatic</option>
                  <option value="MANUAL">Manual (office raises bills)</option>
                </Select>
              )}
            </Field>
          </div>
        )}
      </ActionDialog>

      {sub && (
        <>
          <ActionDialog
            open={which === 'rate'}
            onClose={closeAll}
            title="Change monthly rate"
            disabled={!v('monthlyRate') || v('reason').length < 3}
            onSubmit={async () => {
              await api('POST', `/subscriptions/${sub.id}/rates`, { body: { monthlyRate: v('monthlyRate'), effectiveFrom: v('effectiveFrom', sub.nextBilling?.start ?? today()), reason: v('reason') } });
              setF({});
              await onSaved('Rate changed');
            }}
          >
            {(err) => (
              <>
                <p className="text-sm text-muted">Bills already issued never change. The new rate applies to periods starting on or after the date below.</p>
                <Field label="New monthly rate" required>{(id) => <MoneyInput id={id} value={v('monthlyRate')} onChange={(x) => set('monthlyRate', x)} autoFocus />}</Field>
                <Field label="From" error={err.effectiveFrom}>{(id) => <Input id={id} type="date" value={v('effectiveFrom', sub.nextBilling?.start ?? today())} onChange={(e) => set('effectiveFrom', e.target.value)} />}</Field>
                <Field label="Reason" required>{(id) => <Textarea id={id} value={v('reason')} onChange={(e) => set('reason', e.target.value)} />}</Field>
              </>
            )}
          </ActionDialog>
          <ActionDialog
            open={which === 'terms'}
            onClose={closeAll}
            title="Billing terms"
            disabled={v('reason').length < 3}
            onSubmit={async () => {
              const res = await api<{ unbilledGap: { from: string; to: string } | null }>('PATCH', `/subscriptions/${sub.id}`, {
                body: {
                  billingIntervalMonths: Number(v('interval', String(sub.billingIntervalMonths))),
                  billingAnchorDay: Number(v('anchor', String(sub.billingAnchorDay))),
                  billingTiming: v('timing', sub.billingTiming),
                  billingMode: v('mode', sub.billingMode),
                  dueDays: Number(v('dueDays', String(sub.dueDays))),
                  reason: v('reason'),
                },
              });
              setF({});
              await onSaved(res.unbilledGap ? `Terms updated. Days ${date(res.unbilledGap.from)}–${date(res.unbilledGap.to)} are not covered by any bill.` : 'Terms updated');
            }}
          >
            {() => (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Bill every">
                  {(id) => (
                    <Select id={id} value={v('interval', String(sub.billingIntervalMonths))} onChange={(e) => set('interval', e.target.value)}>
                      {[1, 2, 3, 4, 6, 12].map((m) => <option key={m} value={m}>{m === 1 ? 'Month' : `${m} months`}</option>)}
                    </Select>
                  )}
                </Field>
                <Field label="Billing day">{(id) => <Input id={id} type="number" min={1} max={28} value={v('anchor', String(sub.billingAnchorDay))} onChange={(e) => set('anchor', e.target.value)} />}</Field>
                <Field label="Bill">
                  {(id) => (
                    <Select id={id} value={v('timing', sub.billingTiming)} onChange={(e) => set('timing', e.target.value)}>
                      <option value="ADVANCE">At the start of each period</option>
                      <option value="ARREARS">At the end of each period</option>
                    </Select>
                  )}
                </Field>
                <Field label="Mode">
                  {(id) => (
                    <Select id={id} value={v('mode', sub.billingMode)} onChange={(e) => set('mode', e.target.value)}>
                      <option value="AUTO">Automatic</option>
                      <option value="MANUAL">Manual</option>
                    </Select>
                  )}
                </Field>
                <Field label="Due after (days)">{(id) => <Input id={id} type="number" min={0} max={90} value={v('dueDays', String(sub.dueDays))} onChange={(e) => set('dueDays', e.target.value)} />}</Field>
                <div className="sm:col-span-2">
                  <Field label="Reason" required>{(id) => <Textarea id={id} value={v('reason')} onChange={(e) => set('reason', e.target.value)} />}</Field>
                </div>
                <p className="text-xs text-muted sm:col-span-2">Changes apply from the next bill. Issued bills are not changed.</p>
              </div>
            )}
          </ActionDialog>
          <ActionDialog
            open={which === 'suspend'}
            onClose={closeAll}
            title="Suspend service"
            disabled={v('reason').length < 3}
            onSubmit={async () => {
              await api('POST', `/subscriptions/${sub.id}/suspensions`, { body: { fromDate: v('from', today()), toDate: v('to') || null, reason: v('reason') } });
              setF({});
              await onSaved('Service suspended');
            }}
          >
            {() => (
              <>
                <p className="text-sm text-muted">No bill is raised for periods that start during the suspension. Existing dues stay collectable.</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="From">{(id) => <Input id={id} type="date" value={v('from', today())} onChange={(e) => set('from', e.target.value)} />}</Field>
                  <Field label="Until" hint="Leave empty until resumed">{(id) => <Input id={id} type="date" value={v('to')} onChange={(e) => set('to', e.target.value)} />}</Field>
                </div>
                <Field label="Reason" required>{(id) => <Textarea id={id} value={v('reason')} onChange={(e) => set('reason', e.target.value)} />}</Field>
              </>
            )}
          </ActionDialog>
          <ReasonDialog
            open={which === 'resume'}
            onClose={closeAll}
            title="Resume service"
            description="Billing resumes from the next period."
            onConfirm={async (reason) => {
              await api('POST', `/subscriptions/${sub.id}/reactivate`, { body: { reason } });
              await onSaved('Service resumed');
            }}
          />
          <ReasonDialog
            open={which === 'end'}
            onClose={closeAll}
            title="End billing"
            danger
            confirmLabel="End billing"
            description="No further bills will be raised after today. Outstanding dues remain."
            onConfirm={async (reason) => {
              await api('POST', `/subscriptions/${sub.id}/end`, { body: { endDate: today(), reason } });
              await onSaved('Billing ended');
            }}
          />
        </>
      )}
    </>
  );
}
