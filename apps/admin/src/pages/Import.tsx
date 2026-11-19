import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, FileSpreadsheet, Upload, XCircle } from 'lucide-react';
import type { ImportIssue, ImportReport } from '@cablenet/contracts';
import { api, apiPage } from '../lib/api';
import { dateTime, inr } from '../lib/format';
import { Badge, Button, Card, DataTable, DescriptionList, ErrorNote, Field, FilterBar, Input, Modal, PageHeader, Select, StatusBadge, useToast } from '../components/ui';

interface Batch {
  id: string;
  fileName: string;
  fileSize: number;
  status: string;
  option: 'FULL_HISTORY' | 'OPENING_BALANCE' | null;
  cutoverDate: string | null;
  uploadedAt: string;
  uploadedByName: string | null;
  dryRunAt: string | null;
  dryRunByName: string | null;
  dryRunHash: string | null;
  approvedAt: string | null;
  approvedByName: string | null;
  committedAt: string | null;
  committedByName: string | null;
  report: ImportReport | null;
  summary: {
    historyYear: number;
    monthsFound: number[];
    lastMonthWithPayments: number;
    suggestedCutover: string | null;
    customers: number;
    billable: number;
    monthlyTotal: string;
    pendingDecision: number;
    collections: string;
    perMonth: { month: number; payments: number; amount: string }[];
    errors: number;
    warnings: number;
  };
  customers: { row: number; code: string; name: string; addressLine: string; mobile: string | null; mobileValid: boolean; rateRaw: string; rate: string | null; society: string; stb: string | null; corrected: string[] }[];
  issues: ImportIssue[];
}
interface BatchRow {
  id: string;
  fileName: string;
  status: string;
  option: string | null;
  cutoverDate: string | null;
  uploadedAt: string;
  committedAt: string | null;
  uploadedByName: string;
}

const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const STEP_LABEL: Record<string, string> = {
  ANALYSED: 'Checked — run a dry run',
  DRY_RUN_OK: 'Dry run reconciles — waiting for approval',
  DRY_RUN_FAILED: 'Dry run does not reconcile',
  APPROVED: 'Approved — ready to import',
  COMMITTED: 'Imported',
  DISCARDED: 'Discarded',
};

function UploadCard({ onDone }: { onDone: (id: string) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const go = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const b = await api<Batch>('POST', '/imports', { form });
      onDone(b.id);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Upload the workbook">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Excel workbook (.xlsx)">
          {(id) => <Input id={id} type="file" accept=".xlsx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />}
        </Field>
        <Button busy={busy} disabled={!file} onClick={go}>
          <Upload className="size-4" aria-hidden /> Upload and check
        </Button>
      </div>
      <p className="mt-2 text-sm text-muted">Nothing is written to the customer records until a dry run reconciles, the result is approved, and you import it.</p>
      <ErrorNote error={error} />
    </Card>
  );
}

interface CompareResult {
  month: string;
  compared: number;
  equal: number;
  mismatches: { customerCode: string; name: string; excelBalance: string; systemBalance: string; excelCollected: string; systemCollected: string }[];
  onlyInWorkbook: string[];
  totals: { excelCollected: string; systemCollected: string; excelOutstanding: string; systemOutstanding: string };
  ok: boolean;
}

/** Parallel run: compare the workbook still kept by the office with the system for one month. */
function CompareCard() {
  const [file, setFile] = useState<File | null>(null);
  const [month, setMonth] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<CompareResult | null>(null);
  const go = async () => {
    if (!file || !month) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      setResult(await api<CompareResult>('POST', `/imports/compare?month=${month}`, { form }));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Compare with the workbook (parallel run)">
      <p className="mb-3 text-sm text-muted">While Excel is still kept alongside the system, check that both agree: each customer's balance at the end of the month and what was collected in it. Nothing is saved.</p>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Workbook to compare (.xlsx)">{(id) => <Input id={id} type="file" accept=".xlsx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />}</Field>
        <Field label="Month">{(id) => <Input id={id} type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="w-44" />}</Field>
        <Button variant="secondary" busy={busy} disabled={!file || !month} onClick={go}>
          Compare
        </Button>
      </div>
      <ErrorNote error={error} />
      {result && (
        <div className="mt-4 grid gap-3">
          <p className={result.ok ? 'font-medium text-success' : 'font-medium text-danger'}>
            {result.ok ? `All ${result.compared} customers agree for ${result.month}.` : `${result.mismatches.length} of ${result.compared} customers differ for ${result.month}.`}
            {result.onlyInWorkbook.length > 0 && ` ${result.onlyInWorkbook.length} customers are only in the workbook.`}
          </p>
          <DescriptionList
            items={[
              ['Collected in the month', `Excel ${inr(result.totals.excelCollected)} · system ${inr(result.totals.systemCollected)}`],
              ['Outstanding at month end', `Excel ${inr(result.totals.excelOutstanding)} · system ${inr(result.totals.systemOutstanding)}`],
            ]}
          />
          {result.mismatches.length > 0 && (
            <DataTable
              rows={result.mismatches}
              rowKey={(r) => r.customerCode}
              columns={[
                { key: 'c', header: 'ID', cell: (r) => r.customerCode },
                { key: 'n', header: 'Name', cell: (r) => r.name },
                { key: 'eb', header: 'Excel balance', align: 'right', cell: (r) => inr(r.excelBalance) },
                { key: 'sb', header: 'System balance', align: 'right', cell: (r) => inr(r.systemBalance) },
                { key: 'ec', header: 'Excel collected', align: 'right', cell: (r) => inr(r.excelCollected) },
                { key: 'sc', header: 'System collected', align: 'right', cell: (r) => inr(r.systemCollected) },
              ]}
            />
          )}
        </div>
      )}
    </Card>
  );
}

function CorrectDialog({ batchId, customer, onClose, onSaved }: { batchId: string; customer: Batch['customers'][number] | null; onClose: () => void; onSaved: () => void }) {
  const [v, setV] = useState({ name: '', mobile: '', addressLine: '', society: '', monthlyRate: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (customer) setV({ name: customer.name, mobile: customer.mobile ?? '', addressLine: customer.addressLine, society: customer.society, monthlyRate: customer.rate ?? '' });
  }, [customer]);
  if (!customer) return null;
  const original = { name: customer.name, mobile: customer.mobile ?? '', addressLine: customer.addressLine, society: customer.society, monthlyRate: customer.rate ?? '' };
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      for (const field of Object.keys(v) as (keyof typeof v)[]) {
        if (v[field] !== original[field]) {
          await api('PUT', `/imports/${batchId}/corrections`, { body: { customerCode: customer.code, field, value: v[field] } });
        }
      }
      onSaved();
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={`Correct ${customer.code}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button busy={busy} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <p className="text-sm text-muted">Corrections are kept with the import (the workbook itself is not changed) and require a new dry run.</p>
        <Field label="Name">{(id) => <Input id={id} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />}</Field>
        <Field label="Mobile">{(id) => <Input id={id} value={v.mobile} onChange={(e) => setV({ ...v, mobile: e.target.value })} />}</Field>
        <Field label="Address">{(id) => <Input id={id} value={v.addressLine} onChange={(e) => setV({ ...v, addressLine: e.target.value })} />}</Field>
        <Field label="Society (group)">{(id) => <Input id={id} value={v.society} onChange={(e) => setV({ ...v, society: e.target.value })} />}</Field>
        <Field label="Monthly rate from cutover" hint={`Workbook: "${customer.rateRaw || 'blank'}". Leave empty to import without billing ("needs decision").`}>
          {(id) => <Input id={id} inputMode="decimal" value={v.monthlyRate} onChange={(e) => setV({ ...v, monthlyRate: e.target.value })} />}
        </Field>
        <ErrorNote error={error} />
      </div>
    </Modal>
  );
}

function Report({ report }: { report: ImportReport }) {
  return (
    <div className="grid gap-3">
      <DataTable
        rows={report.lines}
        rowKey={(r) => r.key}
        columns={[
          { key: 'c', header: 'Check', cell: (r) => r.check },
          { key: 'e', header: 'Excel', align: 'right', cell: (r) => (/^\d+\.\d{2}$/.test(r.excel) ? inr(r.excel) : r.excel) },
          { key: 's', header: 'System', align: 'right', cell: (r) => (/^\d+\.\d{2}$/.test(r.system) ? inr(r.system) : r.system) },
          {
            key: 'ok',
            header: 'Match',
            cell: (r) =>
              r.ok ? (
                <span className="inline-flex items-center gap-1 text-success">
                  <CheckCircle2 className="size-4" aria-hidden /> Yes
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-danger">
                  <XCircle className="size-4" aria-hidden /> No
                </span>
              ),
          },
        ]}
      />
      {report.blockingIssues.length > 0 && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm">
          <p className="font-medium text-danger">Nothing can be imported until these are fixed:</p>
          <ul className="mt-1 list-disc pl-5">
            {report.blockingIssues.slice(0, 20).map((i, n) => (
              <li key={n}>
                {i.customerCode ? `${i.customerCode}: ` : ''}
                {i.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      {report.perCustomer.mismatches.length > 0 && (
        <DataTable
          rows={report.perCustomer.mismatches}
          rowKey={(r) => r.customerCode}
          columns={[
            { key: 'c', header: 'Customer', cell: (r) => r.customerCode },
            { key: 'e', header: 'Excel balance', align: 'right', cell: (r) => inr(r.excel) },
            { key: 's', header: 'System balance', align: 'right', cell: (r) => r.system },
          ]}
        />
      )}
      <p className="text-sm text-muted">
        Would create: {report.created.customers} customers, {report.created.societies} new societies, {report.created.subscriptions} subscriptions, {report.created.invoices} bills, {report.created.payments} payments,{' '}
        {report.created.openingBalances} opening balances, {report.created.legacyLines} Excel history lines. {report.created.pendingDecision} customers wait for a rate decision.
      </p>
    </div>
  );
}

function BatchView({ id }: { id: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: b, error } = useQuery({ queryKey: ['import', id], queryFn: () => api<Batch>('GET', `/imports/${id}`) });
  const [severity, setSeverity] = useState('');
  const [option, setOption] = useState<'FULL_HISTORY' | 'OPENING_BALANCE' | ''>('');
  const [cutover, setCutover] = useState('');
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [editing, setEditing] = useState<Batch['customers'][number] | null>(null);
  const [confirmCommit, setConfirmCommit] = useState(false);
  useEffect(() => {
    if (!b) return;
    if (!cutover) setCutover((b.cutoverDate ?? b.summary.suggestedCutover ?? '').slice(0, 7));
    if (!option && b.option) setOption(b.option);
  }, [b, cutover, option]);
  const issues = useMemo(() => (b?.issues ?? []).filter((i) => !severity || i.severity === severity), [b, severity]);
  const flagged = useMemo(() => {
    if (!b) return [];
    const codes = new Set(b.issues.filter((i) => i.customerCode && /^(D-1|D-2|D-3|V-)/.test(i.code)).map((i) => i.customerCode));
    return b.customers.filter((c) => codes.has(c.code) || c.corrected.length > 0);
  }, [b]);

  if (error) return <ErrorNote error={error} />;
  if (!b) return null;
  const refresh = () => qc.invalidateQueries({ queryKey: ['import', id] }).then(() => qc.invalidateQueries({ queryKey: ['imports'] }));
  const act = async (name: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(name);
    setActionError(null);
    try {
      await fn();
      if (done) toast(done);
      await refresh();
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(null);
    }
  };
  const final = b.status === 'COMMITTED' || b.status === 'DISCARDED';
  const s = b.summary;

  return (
    <div className="grid gap-4">
      <Card
        title={
          <span className="flex items-center gap-2">
            <FileSpreadsheet className="size-4" aria-hidden /> {b.fileName}
          </span>
        }
        actions={<Badge tone={b.status === 'COMMITTED' ? 'good' : b.status === 'DRY_RUN_FAILED' ? 'bad' : b.status === 'DISCARDED' ? 'neutral' : 'info'}>{STEP_LABEL[b.status] ?? b.status}</Badge>}
      >
        <DescriptionList
          items={[
            ['Customers', `${s.customers} (billable ${s.billable}, waiting for a rate decision ${s.pendingDecision})`],
            ['Monthly billing', inr(s.monthlyTotal)],
            ['Collections in the workbook', `${inr(s.collections)} (${s.historyYear})`],
            ['Months', s.perMonth.map((m) => `${MONTH[m.month - 1]}: ${m.payments}`).join(' · ')],
            ['Findings', `${s.errors} to fix, ${s.warnings} warnings`],
            ['Uploaded', `${dateTime(b.uploadedAt)} by ${b.uploadedByName ?? '—'}`],
            ...(b.dryRunAt ? ([['Dry run', `${dateTime(b.dryRunAt)} by ${b.dryRunByName}`]] as [string, string][]) : []),
            ...(b.approvedAt ? ([['Approved', `${dateTime(b.approvedAt)} by ${b.approvedByName}`]] as [string, string][]) : []),
            ...(b.committedAt ? ([['Imported', `${dateTime(b.committedAt)} by ${b.committedByName}`]] as [string, string][]) : []),
          ]}
        />
      </Card>

      <Card title="Findings" padded={false}>
        <FilterBar>
          <Select aria-label="Severity" value={severity} onChange={(e) => setSeverity(e.target.value)} className="w-44">
            <option value="">All ({b.issues.length})</option>
            <option value="error">To fix ({s.errors})</option>
            <option value="warning">Warnings ({s.warnings})</option>
          </Select>
        </FilterBar>
        <DataTable
          rows={issues}
          rowKey={(r) => `${r.code}:${r.customerCode}:${r.sheet}:${r.row}:${r.message}`}
          empty="No findings"
          columns={[
            { key: 's', header: '', cell: (r) => <Badge tone={r.severity === 'error' ? 'bad' : 'warn'}>{r.severity === 'error' ? 'Fix' : 'Note'}</Badge> },
            { key: 'c', header: 'Code', cell: (r) => r.code },
            { key: 'cu', header: 'Customer', cell: (r) => r.customerCode ?? '' },
            { key: 'w', header: 'Where', cell: (r) => (r.sheet ? `${r.sheet}${r.row ? ` row ${r.row}` : ''}` : '') },
            { key: 'm', header: 'Finding', cell: (r) => r.message },
          ]}
        />
      </Card>

      {flagged.length > 0 && (
        <Card title="Customers to look at" padded={false}>
          <DataTable
            rows={flagged}
            rowKey={(r) => r.code}
            columns={[
              { key: 'c', header: 'ID', cell: (r) => r.code },
              { key: 'n', header: 'Name', cell: (r) => r.name },
              { key: 'm', header: 'Mobile', cell: (r) => <span className={r.mobileValid ? '' : 'text-danger'}>{r.mobile ?? '—'}</span> },
              { key: 'r', header: 'Rate', cell: (r) => (r.rate ? inr(r.rate) : <Badge tone="warn">Needs decision ({r.rateRaw || 'blank'})</Badge>) },
              { key: 'x', header: 'Corrected', cell: (r) => r.corrected.join(', ') },
              { key: 'e', header: '', cell: (r) => !final && <Button size="sm" variant="secondary" onClick={() => setEditing(r)}>Correct</Button> },
            ]}
          />
        </Card>
      )}

      {!final && (
        <Card title="Dry run">
          <fieldset className="grid gap-3">
            <legend className="sr-only">How to bring in the history</legend>
            <label className="flex gap-3 rounded-lg border border-line p-3">
              <input type="radio" name="option" checked={option === 'FULL_HISTORY'} onChange={() => setOption('FULL_HISTORY')} />
              <span>
                <span className="font-medium">Option A — full history.</span> Every month before cutover becomes a bill, and every amount typed in Excel becomes a payment (mode "legacy"). Choose this
                only if the workbook's payments are real collections with real dates (question Q2).
              </span>
            </label>
            <label className="flex gap-3 rounded-lg border border-line p-3">
              <input type="radio" name="option" checked={option === 'OPENING_BALANCE'} onChange={() => setOption('OPENING_BALANCE')} />
              <span>
                <span className="font-medium">Option B — opening balance.</span> Each customer starts with the balance Excel shows at cutover. The month grid is kept read-only as "Excel history" and
                not counted as collections. Safer if the history was filled in afterwards.
              </span>
            </label>
            <Field label="Cutover month (the new system bills from the 1st)" hint={s.suggestedCutover ? `Suggested: ${s.suggestedCutover.slice(0, 7)} (the month after the last payments in the workbook)` : undefined}>
              {(fid) => <Input id={fid} type="month" value={cutover} onChange={(e) => setCutover(e.target.value)} className="w-48" />}
            </Field>
            <div>
              <Button busy={busy === 'dry'} disabled={!option || !cutover} onClick={() => act('dry', () => api('POST', `/imports/${id}/dry-run`, { body: { option, cutoverDate: `${cutover}-01` } }), 'Dry run finished')}>
                Run dry run
              </Button>
            </div>
          </fieldset>
        </Card>
      )}

      {b.report && (
        <Card title={b.status === 'COMMITTED' ? 'Import result' : 'Reconciliation (dry run — nothing was saved)'}>
          <Report report={b.report} />
          {(b.status === 'DRY_RUN_OK' || b.status === 'APPROVED') && (
            <div className="mt-4 grid gap-3 border-t border-line pt-4">
              {b.status === 'DRY_RUN_OK' && (
                <>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} /> I have checked this report against the workbook.
                  </label>
                  <div>
                    <Button busy={busy === 'approve'} disabled={!checked} onClick={() => act('approve', () => api('POST', `/imports/${id}/approve`, { body: { dryRunHash: b.dryRunHash, confirm: true } }), 'Approved')}>
                      Approve this result
                    </Button>
                  </div>
                </>
              )}
              {b.status === 'APPROVED' && (
                <div>
                  <Button onClick={() => setConfirmCommit(true)}>Import now</Button>
                </div>
              )}
            </div>
          )}
        </Card>
      )}
      <ErrorNote error={actionError} />
      {!final && (
        <div>
          <Button variant="secondary" busy={busy === 'discard'} onClick={() => act('discard', () => api('POST', `/imports/${id}/discard`), 'Discarded')}>
            Discard this upload
          </Button>
        </div>
      )}

      <CorrectDialog batchId={id} customer={editing} onClose={() => setEditing(null)} onSaved={() => void refresh()} />
      <Modal
        open={confirmCommit}
        onClose={() => setConfirmCommit(false)}
        title="Import into the live system?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmCommit(false)}>
              Cancel
            </Button>
            <Button
              busy={busy === 'commit'}
              onClick={() =>
                act('commit', async () => {
                  await api('POST', `/imports/${id}/commit`);
                  setConfirmCommit(false);
                }, 'Imported')
              }
            >
              Import
            </Button>
          </>
        }
      >
        <p className="text-sm">
          This creates {b.report?.created.customers} customers with their bills and balances exactly as in the approved dry run. If anything in the system changed since then, nothing is written and you are
          asked to run the dry run again. An import cannot be undone; corrections afterwards use reversals and adjustments.
        </p>
      </Modal>
    </div>
  );
}

export default function ImportPage() {
  const [selected, setSelected] = useState<string | null>(null);
  const batches = useQuery({ queryKey: ['imports'], queryFn: () => apiPage<BatchRow>('/imports', { pageSize: 20 }) });
  const pending = useQuery({ queryKey: ['imports', 'pending'], queryFn: () => api<{ id: string; customerCode: string; name: string; society: string; pendingDecision: string }[]>('GET', '/imports/pending-decisions') });
  useEffect(() => {
    if (!selected && batches.data?.items[0] && batches.data.items[0].status !== 'DISCARDED') setSelected(batches.data.items[0].id);
  }, [batches.data, selected]);

  return (
    <div className="grid gap-4">
      <PageHeader title="Excel import" subtitle="Bring the customer workbook into the system: check it, correct it, rehearse with a dry run, approve, then import. Super admin only." />
      {!!pending.data?.length && (
        <Card title={`Customers waiting for a rate decision (${pending.data.length})`} padded={false}>
          <DataTable
            rows={pending.data}
            rowKey={(r) => r.id}
            columns={[
              { key: 'c', header: 'ID', cell: (r) => <Link className="text-brand-700 hover:underline" to={`/customers/${r.id}`}>{r.customerCode}</Link> },
              { key: 'n', header: 'Name', cell: (r) => r.name },
              { key: 's', header: 'Society', cell: (r) => r.society },
              { key: 'w', header: 'Why', cell: (r) => r.pendingDecision },
            ]}
          />
          <p className="border-t border-line px-3 py-2 text-xs text-muted">Set up a subscription on the customer to start billing; the customer then leaves this list.</p>
        </Card>
      )}
      <UploadCard onDone={(newId) => { setSelected(newId); void batches.refetch(); }} />
      {!!batches.data?.items.length && (
        <Card title="Uploads" padded={false}>
          <DataTable
            rows={batches.data.items}
            rowKey={(r) => r.id}
            onRowClick={(r) => setSelected(r.id)}
            columns={[
              { key: 'f', header: 'File', cell: (r) => <span className={r.id === selected ? 'font-semibold' : ''}>{r.fileName}</span> },
              { key: 'u', header: 'Uploaded', cell: (r) => `${dateTime(r.uploadedAt)} · ${r.uploadedByName}` },
              { key: 's', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
              { key: 'o', header: 'Option', cell: (r) => (r.option === 'FULL_HISTORY' ? 'A — full history' : r.option === 'OPENING_BALANCE' ? 'B — opening balance' : '') },
              { key: 'c', header: 'Cutover', cell: (r) => r.cutoverDate ?? '' },
            ]}
          />
        </Card>
      )}
      {selected && <BatchView key={selected} id={selected} />}
      <CompareCard />
    </div>
  );
}
