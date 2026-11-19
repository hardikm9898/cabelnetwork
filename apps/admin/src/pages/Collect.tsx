import { FormEvent, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, FileDown, MessageCircle, X } from 'lucide-react';
import { ApiError, api, download, newKey } from '../lib/api';
import { date, inr, label, today } from '../lib/format';
import { CustomerPicker, MoneyInput } from '../components/shared';
import { Button, Card, cx, ErrorNote, Field, Input, PageHeader, Select, Spinner, StatusBadge, Textarea, useToast } from '../components/ui';

interface Picked {
  id: string;
  customerCode: string;
  name: string;
  mobile: string | null;
}
interface Balance {
  outstanding: string;
  advance: string;
  overdueAmount: string;
  openInvoices: { id: string; invoiceNumber: string; periodStart: string | null; periodEnd: string | null; dueDate: string; balance: string; overdue: boolean; kind: string }[];
  lastPayment: { amount: string; paymentDate: string; mode: string } | null;
  pendingVerification: { id: string; amount: string; mode: string }[];
}
interface Receipt {
  id: string;
  receiptNumber: string;
  snapshot: {
    business: { name: string };
    payment: { amount: string; paymentDate: string; mode: string };
    customer: { code: string; name: string; mobile: string | null };
    allocations: { label: string; amount: string }[];
    advanceCreated: string;
    remainingOutstanding: string;
    remainingAdvance: string;
  };
}
interface PaymentResult {
  id: string;
  status: string;
  amount: string;
  replayed: boolean;
  receipt: Receipt | null;
  customerBalance: { outstanding: string; advance: string };
}

/** WhatsApp text for the receipt (opens the phone's WhatsApp via wa.me). */
function whatsappLink(r: Receipt) {
  const s = r.snapshot;
  const lines = [
    `${s.business.name} – Payment receipt ${r.receiptNumber}`,
    `${s.customer.name} (${s.customer.code})`,
    `Received ${inr(s.payment.amount)} on ${date(s.payment.paymentDate)} by ${label(s.payment.mode)}`,
    ...s.allocations.map((a) => `• ${a.label}: ${inr(a.amount)}`),
    s.remainingOutstanding !== '0.00' ? `Balance due: ${inr(s.remainingOutstanding)}` : s.remainingAdvance !== '0.00' ? `Advance: ${inr(s.remainingAdvance)}` : 'All dues cleared. Thank you!',
  ];
  const mobile = s.customer.mobile && /^[6-9]\d{9}$/.test(s.customer.mobile) ? `91${s.customer.mobile}` : '';
  return `https://wa.me/${mobile}?text=${encodeURIComponent(lines.join('\n'))}`;
}

export default function CollectPage() {
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const toast = useToast();
  const customerId = params.get('customer') ?? '';
  const [result, setResult] = useState<PaymentResult | null>(null);

  const customer = useQuery({
    queryKey: ['customer', customerId],
    queryFn: () => api<Picked & { status: string; society: { name: string } }>('GET', `/customers/${customerId}`),
    enabled: !!customerId,
  });
  const balance = useQuery({
    queryKey: ['customer', customerId, 'balance'],
    queryFn: () => api<Balance>('GET', `/customers/${customerId}/balance`),
    enabled: !!customerId,
  });

  const pick = (c: Picked) => {
    setResult(null);
    setParams({ customer: c.id });
  };

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader title="Collect payment" subtitle="For customers who pay at the office, by UPI or bank transfer." />
      <Card>
        <CustomerPicker onPick={pick} autoFocus={!customerId} />
      </Card>

      {customerId && customer.isLoading && <Spinner />}
      {customer.data && (
        <div className="grid gap-4 md:grid-cols-5">
          <Card
            className="md:col-span-2"
            title={
              <Link to={`/customers/${customer.data.id}`} className="hover:underline">
                {customer.data.name}
              </Link>
            }
            actions={
              <button onClick={() => setParams({})} className="rounded p-1 text-muted hover:bg-slate-100" aria-label="Clear customer">
                <X className="size-4" />
              </button>
            }
          >
            <p className="text-sm text-muted">
              {customer.data.customerCode} · {customer.data.society.name} {customer.data.mobile && `· ${customer.data.mobile}`}
            </p>
            {balance.data && (
              <div className="mt-4 space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-lg bg-red-50 p-3">
                    <div className="text-xs text-red-800">Outstanding</div>
                    <div className="num text-lg font-semibold text-danger" data-testid="collect-outstanding">
                      {inr(balance.data.outstanding)}
                    </div>
                  </div>
                  <div className="rounded-lg bg-emerald-50 p-3">
                    <div className="text-xs text-emerald-800">Advance</div>
                    <div className="num text-lg font-semibold text-success">{inr(balance.data.advance)}</div>
                  </div>
                </div>
                {balance.data.openInvoices.length > 0 && (
                  <div>
                    <h3 className="mb-1 text-xs font-medium text-muted">Open bills (paid oldest first)</h3>
                    <ul className="space-y-1 text-sm">
                      {balance.data.openInvoices.map((i) => (
                        <li key={i.id} className="flex justify-between gap-2">
                          <span className={cx(i.overdue && 'text-danger')}>{i.periodStart ? `${date(i.periodStart)} – ${date(i.periodEnd)}` : label(i.kind)}</span>
                          <span className="num">{inr(i.balance)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {balance.data.lastPayment && (
                  <p className="text-xs text-muted">
                    Last paid {inr(balance.data.lastPayment.amount)} on {date(balance.data.lastPayment.paymentDate)}
                  </p>
                )}
                {balance.data.pendingVerification.length > 0 && (
                  <p className="text-xs text-warning">{balance.data.pendingVerification.length} payment(s) awaiting verification are not included above.</p>
                )}
              </div>
            )}
          </Card>
          <div className="md:col-span-3">
            {result ? (
              <SuccessCard
                result={result}
                onAnother={() => {
                  setResult(null);
                }}
                onDownload={() => result.receipt && download(`/receipts/${result.receipt.id}/pdf`, undefined, 'open').catch((e: Error) => toast(e.message, 'bad'))}
              />
            ) : (
              <PaymentForm
                customerId={customer.data.id}
                suggested={balance.data?.outstanding !== '0.00' ? balance.data?.outstanding : ''}
                onDone={async (r) => {
                  setResult(r);
                  await qc.invalidateQueries({ predicate: (q) => JSON.stringify(q.queryKey).includes(customerId) || ['customers', 'payments', 'dashboard'].includes(String(q.queryKey[0])) });
                }}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function PaymentForm({ customerId, suggested, onDone }: { customerId: string; suggested?: string; onDone: (r: PaymentResult) => void }) {
  const [amount, setAmount] = useState('');
  const [mode, setMode] = useState('CASH');
  const [paymentDate, setPaymentDate] = useState(today());
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // One transaction id per payment attempt: retries after a timeout never post twice.
  const txn = useRef(newKey());
  useEffect(() => {
    txn.current = newKey();
  }, [customerId]);
  const needsRef = ['UPI', 'BANK_TRANSFER', 'CHEQUE'].includes(mode);
  const fieldErrors = error instanceof ApiError ? error.fieldErrors() : {};

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<PaymentResult>('POST', '/payments', {
        body: { clientTxnId: txn.current, customerId, amount, paymentDate, mode, reference: reference || null, notes: notes || null },
      });
      txn.current = newKey();
      setAmount('');
      setReference('');
      setNotes('');
      onDone(r);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Payment">
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Amount received" required error={fieldErrors.amount} hint={suggested ? `Outstanding ${inr(suggested)}` : undefined}>
            {(id) => (
              <div className="flex gap-2">
                <div className="flex-1">
                  <MoneyInput id={id} value={amount} onChange={setAmount} autoFocus />
                </div>
                {suggested && (
                  <Button type="button" variant="secondary" onClick={() => setAmount(suggested)}>
                    Full
                  </Button>
                )}
              </div>
            )}
          </Field>
          <Field label="Date" error={fieldErrors.paymentDate}>{(id) => <Input id={id} type="date" max={today()} value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} />}</Field>
          <Field label="Mode">
            {(id) => (
              <Select id={id} value={mode} onChange={(e) => setMode(e.target.value)}>
                <option value="CASH">Cash</option>
                <option value="UPI">UPI</option>
                <option value="BANK_TRANSFER">Bank transfer</option>
                <option value="CHEQUE">Cheque</option>
                <option value="OTHER">Other</option>
              </Select>
            )}
          </Field>
          <Field label={mode === 'CHEQUE' ? 'Cheque number' : 'Transaction reference (UTR)'} required={needsRef} error={fieldErrors.reference}>
            {(id) => <Input id={id} value={reference} onChange={(e) => setReference(e.target.value)} disabled={!needsRef && mode === 'CASH'} />}
          </Field>
        </div>
        <Field label="Notes">{(id) => <Textarea id={id} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />}</Field>
        {mode === 'CHEQUE' && <p className="text-xs text-warning">Cheques stay pending until marked cleared under Payments → To verify.</p>}
        {(mode === 'UPI' || mode === 'BANK_TRANSFER') && <p className="text-xs text-muted">Check the money has arrived in the bank before saving — an office entry is treated as verified.</p>}
        <ErrorNote error={error && !(error instanceof ApiError && Object.keys(fieldErrors).length) ? error : null} />
        <Button type="submit" busy={busy} disabled={!amount || (needsRef && !reference)} className="w-full">
          Record payment
        </Button>
      </form>
    </Card>
  );
}

function SuccessCard({ result, onAnother, onDownload }: { result: PaymentResult; onAnother: () => void; onDownload: () => void }) {
  const r = result.receipt;
  return (
    <Card>
      <div className="space-y-4" data-testid="payment-success">
        <div className="flex items-center gap-2 text-success">
          <CheckCircle2 className="size-6" aria-hidden />
          <span className="text-lg font-semibold">{result.status === 'CONFIRMED' ? 'Payment recorded' : 'Payment saved — awaiting verification'}</span>
        </div>
        {r ? (
          <>
            <div className="num text-3xl font-semibold">{inr(result.amount)}</div>
            <p className="text-sm text-muted">
              Receipt <span className="font-medium text-ink" data-testid="receipt-number">{r.receiptNumber}</span>
            </p>
            <ul className="space-y-1 text-sm">
              {r.snapshot.allocations.map((a, i) => (
                <li key={i} className="flex justify-between">
                  <span>{a.label}</span>
                  <span className="num">{inr(a.amount)}</span>
                </li>
              ))}
              {r.snapshot.advanceCreated !== '0.00' && (
                <li className="flex justify-between text-success">
                  <span>Kept as advance</span>
                  <span className="num">{inr(r.snapshot.advanceCreated)}</span>
                </li>
              )}
            </ul>
            <div className="rounded-lg bg-slate-50 p-3 text-sm">
              {result.customerBalance.outstanding !== '0.00' ? (
                <>
                  Still due: <span className="num font-semibold text-danger">{inr(result.customerBalance.outstanding)}</span>
                </>
              ) : result.customerBalance.advance !== '0.00' ? (
                <>
                  Advance: <span className="num font-semibold text-success">{inr(result.customerBalance.advance)}</span>
                </>
              ) : (
                'All dues cleared.'
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={onDownload}>
                <FileDown className="size-4" aria-hidden /> Receipt PDF
              </Button>
              <a href={whatsappLink(r)} target="_blank" rel="noreferrer">
                <Button variant="secondary" type="button">
                  <MessageCircle className="size-4" aria-hidden /> Share on WhatsApp
                </Button>
              </a>
              <Button onClick={onAnother}>Collect another</Button>
            </div>
          </>
        ) : (
          <>
            <StatusBadge status={result.status} />
            <p className="text-sm text-muted">The receipt is issued once the payment is verified.</p>
            <Button onClick={onAnother}>Done</Button>
          </>
        )}
      </div>
    </Card>
  );
}
