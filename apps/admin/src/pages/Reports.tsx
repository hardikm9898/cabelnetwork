import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { FileDown, FileSpreadsheet } from 'lucide-react';
import { api, download } from '../lib/api';
import { date, dateTime, inr, label } from '../lib/format';
import { AgentSelect, AreaSelect, CustomerPicker, SocietySelect } from '../components/shared';
import { Button, Card, DataTable, ErrorNote, Field, FilterBar, Input, PageHeader, Pagination, Select, Spinner, useDebounced, useToast } from '../components/ui';

interface Column {
  key: string;
  label: string;
  type: 'text' | 'money' | 'number' | 'date' | 'datetime' | 'boolean';
  total?: boolean;
}
interface ReportDef {
  key: string;
  title: string;
  description: string;
  columns: Column[];
  filters: string[];
  statusOptions: string[] | null;
  requiresCustomer: boolean;
  formats: string[];
  defaultSort: string;
}
interface ReportResult {
  rows: Record<string, unknown>[];
  totals: Record<string, string>;
  filters: { from: string; to: string };
  meta: { page: number; pageSize: number; total: number };
}

const cell = (v: unknown, t: Column['type']) => {
  if (v === null || v === undefined || v === '') return '—';
  switch (t) {
    case 'money':
      return inr(String(v));
    case 'date':
      return date(String(v));
    case 'datetime':
      return dateTime(String(v));
    case 'boolean':
      return v ? 'Yes' : 'No';
    case 'text':
      return /^[A-Z_]+$/.test(String(v)) ? label(String(v)) : String(v);
    default:
      return String(v);
  }
};

export default function ReportsPage() {
  const { key } = useParams();
  const { data, isLoading } = useQuery({ queryKey: ['report-catalogue'], queryFn: () => api<ReportDef[]>('GET', '/reports'), staleTime: Infinity });
  if (isLoading || !data) return <Spinner />;
  const def = key ? data.find((d) => d.key === key) : undefined;
  if (key && def) return <ReportViewer def={def} />;
  return (
    <div>
      <PageHeader title="Reports" subtitle="Every report can be filtered, searched, sorted and exported to Excel (and PDF where useful)." />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {data.map((d) => (
          <Link key={d.key} to={`/reports/${d.key}`} className="rounded-xl border border-line bg-white p-4 transition-colors hover:border-brand-500">
            <div className="font-medium">{d.title}</div>
            <div className="mt-1 text-sm text-muted">{d.description}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}

function ReportViewer({ def }: { def: ReportDef }) {
  const navigate = useNavigate();
  const toast = useToast();
  const [f, setF] = useState<Record<string, string>>({});
  const [customerLabel, setCustomerLabel] = useState('');
  const [sort, setSort] = useState(def.defaultSort);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  useEffect(() => {
    setF({});
    setSort(def.defaultSort);
    setPage(1);
  }, [def.key, def.defaultSort]);
  const has = (name: string) => def.filters.includes(name);
  const query = { ...f, q: dq, sort, page, pageSize: 50 };
  const ready = !def.requiresCustomer || !!f.customerId;
  const { data, isFetching, error } = useQuery({
    queryKey: ['report', def.key, query],
    queryFn: () => api<ReportResult>('GET', `/reports/${def.key}`, { query }),
    enabled: ready,
    placeholderData: (p) => p,
  });
  const set = (k: string, v: string) => {
    setF((s) => ({ ...s, [k]: v }));
    setPage(1);
  };
  const exportAs = (format: 'xlsx' | 'pdf') =>
    download(`/reports/${def.key}`, { ...f, q: dq, sort, format }).catch((e: Error) => toast(e.message, 'bad'));

  return (
    <div className="space-y-4">
      <div className="text-sm text-muted">
        <Link to="/reports" className="hover:underline">
          Reports
        </Link>{' '}
        / {def.title}
      </div>
      <PageHeader
        title={def.title}
        subtitle={def.description}
        actions={
          <>
            <Button variant="secondary" onClick={() => exportAs('xlsx')} disabled={!ready}>
              <FileSpreadsheet className="size-4" aria-hidden /> Excel
            </Button>
            {def.formats.includes('pdf') && (
              <Button variant="secondary" onClick={() => exportAs('pdf')} disabled={!ready}>
                <FileDown className="size-4" aria-hidden /> PDF
              </Button>
            )}
          </>
        }
      />
      <Card padded={false}>
        <FilterBar>
          {has('customerId') && (
            <div className="w-80">
              <Field label="Customer" required={def.requiresCustomer}>
                {() =>
                  f.customerId ? (
                    <div className="flex h-10 items-center justify-between rounded-lg border border-line px-3 text-sm">
                      {customerLabel}
                      <button className="text-muted hover:text-ink" onClick={() => set('customerId', '')}>
                        change
                      </button>
                    </div>
                  ) : (
                    <CustomerPicker
                      onPick={(c) => {
                        set('customerId', c.id);
                        setCustomerLabel(`${c.name} (${c.customerCode})`);
                      }}
                    />
                  )
                }
              </Field>
            </div>
          )}
          {has('dateRange') && (
            <>
              <Field label="From">{(id) => <Input id={id} type="date" value={f.from ?? ''} onChange={(e) => set('from', e.target.value)} />}</Field>
              <Field label="To">{(id) => <Input id={id} type="date" value={f.to ?? ''} onChange={(e) => set('to', e.target.value)} />}</Field>
            </>
          )}
          {has('agentId') && <Field label="Agent">{(id) => <AgentSelect id={id} value={f.agentId ?? ''} onChange={(v) => set('agentId', v)} />}</Field>}
          {has('areaId') && <Field label="Area">{(id) => <AreaSelect id={id} value={f.areaId ?? ''} onChange={(v) => set('areaId', v)} />}</Field>}
          {has('societyId') && <Field label="Society">{(id) => <SocietySelect id={id} value={f.societyId ?? ''} onChange={(v) => set('societyId', v)} />}</Field>}
          {has('status') && def.statusOptions && (
            <Field label="Status">
              {(id) => (
                <Select id={id} value={f.status ?? ''} onChange={(e) => set('status', e.target.value)}>
                  <option value="">Any</option>
                  {def.statusOptions!.map((s) => <option key={s} value={s}>{label(s)}</option>)}
                </Select>
              )}
            </Field>
          )}
          <Field label="Search">{(id) => <Input id={id} value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search text columns" />}</Field>
          {data && (
            <span className="ml-auto self-center text-xs text-muted">
              {date(data.filters.from) !== '01-01-1900' && `${date(data.filters.from)} – ${date(data.filters.to)} · `}
              {data.meta.total} rows {isFetching && '· updating…'}
            </span>
          )}
        </FilterBar>
        <ErrorNote error={error} />
        {!ready ? (
          <p className="p-8 text-center text-sm text-muted">Choose a customer to see this report.</p>
        ) : (
          <>
            <DataTable
              rows={data?.rows.map((r, i) => ({ ...r, __row: i }))}
              loading={!data && isFetching}
              rowKey={(r) => String(r.__row)}
              sort={sort}
              onSort={(s) => { setSort(s); setPage(1); }}
              empty="No rows for these filters"
              columns={def.columns.map((c) => ({
                key: c.key,
                header: c.label,
                sortKey: c.key,
                align: c.type === 'money' || c.type === 'number' ? ('right' as const) : undefined,
                cell: (r: Record<string, unknown>) => cell(r[c.key], c.type),
              }))}
              footer={
                data && Object.keys(data.totals).length > 0 ? (
                  <tr className="border-t-2 border-line bg-slate-50 font-semibold">
                    {def.columns.map((c, i) => (
                      <td key={c.key} className={c.type === 'money' || c.type === 'number' ? 'num px-3 py-2 text-right' : 'px-3 py-2'}>
                        {i === 0 ? 'Total (all pages)' : data.totals[c.key] !== undefined ? cell(data.totals[c.key], c.type) : ''}
                      </td>
                    ))}
                  </tr>
                ) : undefined
              }
            />
            {data && <Pagination page={page} pageSize={50} total={data.meta.total} onPage={setPage} />}
          </>
        )}
      </Card>
      <Button variant="ghost" onClick={() => navigate('/reports')}>
        ← All reports
      </Button>
    </div>
  );
}
