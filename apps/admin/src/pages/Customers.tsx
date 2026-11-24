import { FormEvent, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { ApiError, api, apiPage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { inr, today } from '../lib/format';
import { AgentSelect, AreaSelect, MoneyInput, ReasonDialog, SocietySelect } from '../components/shared';
import { Badge, Button, Card, DataTable, ErrorNote, Field, FilterBar, Input, Modal, PageHeader, Pagination, Select, StatusBadge, Textarea, useDebounced, useToast } from '../components/ui';

export interface CustomerListRow {
  id: string;
  customerCode: string;
  name: string;
  mobile: string | null;
  mobileValid: boolean;
  addressLine: string;
  status: string;
  societyName: string;
  areaName: string | null;
  agentName: string | null;
  assignmentKind: string | null;
  stbNumbers: string | null;
  mqNumbers: string | null;
  monthlyRate: string | null;
  pendingDecision: string | null;
  deletedAt: string | null;
  outstanding: string;
  advance: string;
}

export const DELETE_REASONS = ['Entered by mistake', 'Duplicate entry', 'Customer left / connection closed', 'Wrong import'];

interface BulkResult {
  deleted: number;
  deletedCodes: string[];
  blocked: { customerId: string; customerCode: string | null; reason: string }[];
}

export default function CustomersPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [bulkDelete, setBulkDelete] = useState(false);
  const [result, setResult] = useState<BulkResult | null>(null);
  const qc = useQueryClient();
  const toast = useToast();
  const get = (k: string, d = '') => params.get(k) ?? d;
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    if (k !== 'page') next.delete('page');
    setParams(next, { replace: true });
  };
  const [q, setQ] = useState(get('q'));
  const dq = useDebounced(q);
  const page = Number(get('page', '1'));
  const filters = {
    q: dq,
    societyId: get('societyId'),
    areaId: get('areaId'),
    agentId: get('agentId'),
    status: get('status'),
    balance: get('balance'),
    deleted: get('deleted'),
    sort: get('sort', 'name'),
    page,
    pageSize: 25,
  };
  const showingDeleted = filters.deleted === 'true';
  const { data, isLoading, error } = useQuery({
    queryKey: ['customers', filters],
    queryFn: () => apiPage<CustomerListRow>('/customers', filters),
    placeholderData: (p) => p,
  });

  return (
    <div>
      <PageHeader
        title={showingDeleted ? 'Deleted customers' : 'Customers'}
        subtitle={data ? `${data.meta.total} ${showingDeleted ? 'deleted customers (open one to restore it)' : 'customers'}` : undefined}
        actions={
          <>
            {can('customers:manage') && (
              <Button variant="ghost" onClick={() => set('deleted', showingDeleted ? '' : 'true')}>
                {showingDeleted ? 'Back to customers' : 'Deleted customers'}
              </Button>
            )}
            {can('customers:manage') && !showingDeleted && (
              <Button onClick={() => setCreating(true)}>
                <Plus className="size-4" aria-hidden /> Add customer
              </Button>
            )}
          </>
        }
      />
      {selected.length > 0 && (
        <div className="sticky top-0 z-10 mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-brand-200 bg-brand-50 px-4 py-2 text-sm">
          <span className="font-medium">{selected.length} selected</span>
          <Button size="sm" variant="danger" onClick={() => setBulkDelete(true)}>
            <Trash2 className="size-4" aria-hidden /> Delete selected
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected([])}>
            Clear selection
          </Button>
        </div>
      )}
      <Card padded={false}>
        <FilterBar>
          <div className="w-full min-w-0 sm:min-w-64 sm:flex-1">
            <Input
              placeholder="Search ID, name, mobile, address or STB…"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                set('q', e.target.value);
              }}
              aria-label="Search customers"
            />
          </div>
          <div className="w-[calc(50%-0.25rem)] sm:w-44">
            <SocietySelect value={filters.societyId} onChange={(v) => set('societyId', v)} />
          </div>
          <div className="w-[calc(50%-0.25rem)] sm:w-44">
            <AreaSelect value={filters.areaId} onChange={(v) => set('areaId', v)} />
          </div>
          <div className="w-[calc(50%-0.25rem)] sm:w-44">
            <AgentSelect value={filters.agentId} onChange={(v) => set('agentId', v)} />
          </div>
          <div className="w-[calc(50%-0.25rem)] sm:w-44">
            <Select value={filters.status} onChange={(e) => set('status', e.target.value)} aria-label="Status">
              <option value="">Any status</option>
              <option value="ACTIVE">Active</option>
              <option value="SUSPENDED">Suspended</option>
              <option value="INACTIVE">Inactive</option>
              <option value="DISCONNECTED">Disconnected</option>
            </Select>
          </div>
          <div className="w-[calc(50%-0.25rem)] sm:w-44">
            <Select value={filters.balance} onChange={(e) => set('balance', e.target.value)} aria-label="Balance">
              <option value="">Any balance</option>
              <option value="OUTSTANDING">Owes money</option>
              <option value="ADVANCE">Has advance</option>
              <option value="SETTLED">Settled</option>
            </Select>
          </div>
        </FilterBar>
        <ErrorNote error={error} />
        <DataTable
          rows={data?.items}
          loading={isLoading}
          rowKey={(r) => r.id}
          onRowClick={(r) => navigate(`/customers/${r.id}`)}
          selected={can('customers:manage') && !showingDeleted ? selected : undefined}
          onSelect={can('customers:manage') && !showingDeleted ? setSelected : undefined}
          sort={filters.sort}
          onSort={(s) => set('sort', s)}
          empty="No customers match these filters"
          columns={[
            { key: 'code', header: 'ID', sortKey: 'code', primary: true, cell: (r) => <span className="num font-medium">{r.customerCode}</span> },
            {
              key: 'name',
              header: 'Name',
              sortKey: 'name',
              primary: true,
              cell: (r) => (
                <div>
                  <div className="font-medium">
                    {r.name} {r.pendingDecision && <Badge tone="warn">rate to decide</Badge>}
                  </div>
                  <div className="text-xs text-muted">{r.addressLine}</div>
                  {(r.stbNumbers || r.mqNumbers) && (
                    <div className="num text-xs text-muted">
                      {r.stbNumbers && `STB ${r.stbNumbers}`}
                      {r.mqNumbers && ` · MQ ${r.mqNumbers}`}
                    </div>
                  )}
                </div>
              ),
            },
            {
              key: 'mobile',
              header: 'Mobile',
              cell: (r) => (r.mobile ? <span className={r.mobileValid ? '' : 'text-danger'} title={r.mobileValid ? undefined : 'Not a valid mobile number'}>{r.mobile}</span> : '—'),
            },
            { key: 'society', header: 'Society', sortKey: 'society', cell: (r) => r.societyName },
            {
              key: 'agent',
              header: 'Agent',
              cell: (r) => (r.agentName ? <span>{r.agentName}{r.assignmentKind === 'TEMPORARY' && <Badge tone="info">temp</Badge>}</span> : <span className="text-muted">Unassigned</span>),
            },
            { key: 'rate', header: 'Monthly', align: 'right', cell: (r) => (r.monthlyRate ? inr(r.monthlyRate) : <span className="text-muted">not billed</span>) },
            { key: 'status', header: 'Status', cell: (r) => (r.deletedAt ? <Badge tone="bad">deleted</Badge> : <StatusBadge status={r.status} />) },
            {
              key: 'balance',
              header: 'Balance',
              sortKey: 'outstanding',
              align: 'right',
              cell: (r) =>
                r.outstanding !== '0.00' ? (
                  <span className="text-danger">{inr(r.outstanding)} due</span>
                ) : r.advance !== '0.00' ? (
                  <span className="text-success">{inr(r.advance)} adv.</span>
                ) : (
                  <span className="text-muted">Settled</span>
                ),
            },
          ]}
        />
        {data && <Pagination page={page} pageSize={25} total={data.meta.total} onPage={(p) => set('page', String(p))} />}
      </Card>
      <CustomerFormModal open={creating} onClose={() => setCreating(false)} onSaved={(id) => navigate(`/customers/${id}`)} />
      <ReasonDialog
        open={bulkDelete}
        onClose={() => setBulkDelete(false)}
        title={`Delete ${selected.length} customer${selected.length === 1 ? '' : 's'}`}
        description="Deleted customers disappear from the lists, the agents' phones and billing. Their payment history stays, and they can be restored from 'Deleted customers'. Customers who still owe money or have an advance are not deleted."
        confirmLabel="Delete"
        danger
        presets={DELETE_REASONS}
        onConfirm={async (reason) => {
          const res = await api<BulkResult>('POST', '/customers/bulk-delete', { body: { customerIds: selected, reason } });
          setSelected([]);
          await qc.invalidateQueries({ queryKey: ['customers'] });
          if (res.blocked.length) setResult(res);
          else toast(`${res.deleted} customer${res.deleted === 1 ? '' : 's'} deleted`);
        }}
      />
      <Modal open={!!result} onClose={() => setResult(null)} title="Delete result" footer={<Button onClick={() => setResult(null)}>OK</Button>}>
        {result && (
          <div className="space-y-3 text-sm">
            <p>
              <strong>{result.deleted}</strong> deleted. <strong>{result.blocked.length}</strong> could not be deleted:
            </p>
            <ul className="space-y-1">
              {result.blocked.map((b) => (
                <li key={b.customerId} className="rounded-lg bg-amber-50 px-3 py-2 text-amber-900">
                  {b.reason}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Modal>
    </div>
  );
}

interface FormState {
  customerCode: string;
  name: string;
  mobile: string;
  altMobile: string;
  addressLine: string;
  landmark: string;
  societyId: string;
  stbNumber: string;
  mqNumber: string;
  notes: string;
  agentId: string;
  startBilling: boolean;
  monthlyRate: string;
  startDate: string;
  billingIntervalMonths: string;
}

const blank = (): FormState => ({
  customerCode: '',
  name: '',
  mobile: '',
  altMobile: '',
  addressLine: '',
  landmark: '',
  societyId: '',
  stbNumber: '',
  mqNumber: '',
  notes: '',
  agentId: '',
  startBilling: true,
  monthlyRate: '',
  startDate: today(),
  billingIntervalMonths: '1',
});

export function CustomerFormModal({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: (id: string) => void }) {
  const [f, setF] = useState<FormState>(blank);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [needsConfirm, setNeedsConfirm] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  const up = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((s) => ({ ...s, [k]: v }));
  const fieldErrors = error instanceof ApiError ? error.fieldErrors() : {};

  const submit = async (e: FormEvent | null, acknowledge = false) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ customer: { id: string }; warnings: { code: string; message: string }[] }>('POST', '/customers', {
        body: {
          customerCode: f.customerCode,
          name: f.name,
          mobile: f.mobile || null,
          altMobile: f.altMobile || null,
          addressLine: f.addressLine,
          landmark: f.landmark || null,
          societyId: f.societyId,
          stbNumber: f.stbNumber || null,
          mqNumber: f.mqNumber || null,
          notes: f.notes || null,
          agentId: f.agentId || null,
          acknowledgeWarnings: acknowledge,
        },
      });
      if (f.startBilling && f.monthlyRate) {
        await api('POST', `/customers/${res.customer.id}/subscription`, {
          body: { monthlyRate: f.monthlyRate, startDate: f.startDate, billingIntervalMonths: Number(f.billingIntervalMonths) },
        });
      }
      await qc.invalidateQueries({ queryKey: ['customers'] });
      toast(`Customer ${f.customerCode} added`);
      for (const w of res.warnings.filter((w) => w.code === 'UNASSIGNED')) toast(w.message, 'bad');
      setF(blank());
      setNeedsConfirm(false);
      onClose();
      onSaved(res.customer.id);
    } catch (err) {
      setError(err);
      setNeedsConfirm(err instanceof ApiError && err.code === 'CONFIRMATION_REQUIRED');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add customer"
      wide
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          {needsConfirm ? (
            <Button busy={busy} onClick={() => submit(null, true)}>
              Save anyway
            </Button>
          ) : (
            <Button busy={busy} type="submit" form="customer-form">
              Save customer
            </Button>
          )}
        </>
      }
    >
      <form id="customer-form" onSubmit={(e) => submit(e)} className="grid gap-4 sm:grid-cols-2">
        <Field label="Customer ID" required error={fieldErrors.customerCode} hint="Usually the last 6 digits of the STB number">
          {(id) => <Input id={id} value={f.customerCode} onChange={(e) => up('customerCode', e.target.value)} required />}
        </Field>
        <Field label="Name" required error={fieldErrors.name}>
          {(id) => <Input id={id} value={f.name} onChange={(e) => up('name', e.target.value)} required />}
        </Field>
        <Field label="Mobile" error={fieldErrors.mobile}>
          {(id) => <Input id={id} inputMode="tel" value={f.mobile} onChange={(e) => up('mobile', e.target.value)} />}
        </Field>
        <Field label="Alternate mobile">{(id) => <Input id={id} inputMode="tel" value={f.altMobile} onChange={(e) => up('altMobile', e.target.value)} />}</Field>
        <div className="sm:col-span-2">
          <Field label="Address" required error={fieldErrors.addressLine}>
            {(id) => <Input id={id} value={f.addressLine} onChange={(e) => up('addressLine', e.target.value)} required />}
          </Field>
        </div>
        <Field label="Landmark">{(id) => <Input id={id} value={f.landmark} onChange={(e) => up('landmark', e.target.value)} />}</Field>
        <Field label="Society" required error={fieldErrors.societyId}>
          {(id) => <SocietySelect id={id} value={f.societyId} onChange={(v) => up('societyId', v)} includeAll={false} />}
        </Field>
        <Field label="STB number" error={fieldErrors.stbNumber}>
          {(id) => <Input id={id} value={f.stbNumber} onChange={(e) => up('stbNumber', e.target.value)} />}
        </Field>
        <Field label="MQ number">{(id) => <Input id={id} value={f.mqNumber} onChange={(e) => up('mqNumber', e.target.value)} />}</Field>
        <Field label="Agent" hint="Leave empty to follow the area's agent">
          {(id) => <AgentSelect id={id} value={f.agentId} onChange={(v) => up('agentId', v)} allLabel="Area default" />}
        </Field>
        <Field label="Notes">{(id) => <Textarea id={id} value={f.notes} onChange={(e) => up('notes', e.target.value)} rows={1} />}</Field>

        <fieldset className="rounded-lg border border-line p-3 sm:col-span-2">
          <legend className="px-1 text-sm font-medium">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={f.startBilling} onChange={(e) => up('startBilling', e.target.checked)} /> Start billing now
            </label>
          </legend>
          {f.startBilling && (
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Monthly rate" required>
                {(id) => <MoneyInput id={id} value={f.monthlyRate} onChange={(v) => up('monthlyRate', v)} />}
              </Field>
              <Field label="Start date">{(id) => <Input id={id} type="date" value={f.startDate} onChange={(e) => up('startDate', e.target.value)} />}</Field>
              <Field label="Bill every">
                {(id) => (
                  <Select id={id} value={f.billingIntervalMonths} onChange={(e) => up('billingIntervalMonths', e.target.value)}>
                    {[1, 2, 3, 4, 6, 12].map((m) => (
                      <option key={m} value={m}>
                        {m === 1 ? 'Month' : `${m} months`}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
          )}
        </fieldset>
        <div className="sm:col-span-2">
          <ErrorNote error={error} />
        </div>
      </form>
    </Modal>
  );
}
