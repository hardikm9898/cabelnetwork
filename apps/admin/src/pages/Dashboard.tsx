import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { addDays } from '@cablenet/domain';
import { api } from '../lib/api';
import { date, inr, label, monthStart, today } from '../lib/format';
import { AgentSelect, AreaSelect, SocietySelect } from '../components/shared';
import { ChartCard, HBars, Lines, Meter, ORDINAL, StackedBars } from '../components/charts';
import { Card, cx, DataTable, ErrorNote, Field, Input, PageHeader, Select, Spinner } from '../components/ui';

interface Overview {
  filters: { from: string; to: string };
  kpis: Record<string, number | string>;
  dailyCollection: { date: string; cash: string; upi: string; other: string; total: string }[];
  monthlyTrend: { month: string; billed: string; collected: string }[];
  agentPerformance: {
    agentId: string;
    agent: string;
    agentCode: string;
    assignedCustomers: number;
    outstanding: string;
    expectedCollection: string;
    actualCollection: string;
    collectionPct: number | null;
    visits: number;
    successfulVisits: number;
    pendingFollowUps: number;
    cashInHand: string;
  }[];
  societyCollection: { society: string; customers: number; collected: string; outstanding: string }[];
  ageing: { bucket: string; invoices: number; amount: string }[];
  paymentModes: { mode: string; payments: number; amount: string }[];
  billingFrequency: { intervalMonths: number; customers: number }[];
  definitions: Record<string, string>;
}

const PRESETS = {
  today: () => ({ from: today(), to: today() }),
  month: () => ({ from: monthStart(), to: today() }),
  last30: () => ({ from: addDays(today(), -29), to: today() }),
  last90: () => ({ from: addDays(today(), -89), to: today() }),
} as const;
type Preset = keyof typeof PRESETS | 'custom';

const monthName = (ym: string) => new Date(`${ym}-01T00:00:00`).toLocaleString('en-IN', { month: 'short', year: '2-digit' });
const dayName = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

function Kpi({ title, value, sub, to, tone }: { title: string; value: string; sub?: string; to?: string; tone?: 'bad' | 'warn' }) {
  const body = (
    <div className={cx('h-full rounded-xl border border-line bg-white p-4 transition-colors', to && 'hover:border-brand-500')}>
      <div className="text-xs font-medium text-muted">{title}</div>
      <div className={cx('num mt-1 text-xl font-semibold', tone === 'bad' ? 'text-danger' : tone === 'warn' ? 'text-warning' : 'text-ink')}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted">{sub}</div>}
    </div>
  );
  return to ? <Link to={to}>{body}</Link> : body;
}

const SimpleTable = ({ head, rows }: { head: string[]; rows: (string | number)[][] }) => (
  <table className="w-full text-sm">
    <thead>
      <tr className="text-left text-xs text-muted">
        {head.map((h, i) => (
          <th key={h} className={cx('py-1 font-medium', i > 0 && 'text-right')}>
            {h}
          </th>
        ))}
      </tr>
    </thead>
    <tbody>
      {rows.map((r, i) => (
        <tr key={i} className="border-t border-line">
          {r.map((c, j) => (
            <td key={j} className={cx('py-1.5', j > 0 && 'num text-right')}>
              {c}
            </td>
          ))}
        </tr>
      ))}
    </tbody>
  </table>
);

export default function DashboardPage() {
  const [preset, setPreset] = useState<Preset>('month');
  const [range, setRange] = useState(PRESETS.month());
  const [agentId, setAgentId] = useState('');
  const [societyId, setSocietyId] = useState('');
  const [areaId, setAreaId] = useState('');

  const { data, isLoading, error } = useQuery({
    queryKey: ['dashboard', range, agentId, societyId, areaId],
    queryFn: () => api<Overview>('GET', '/dashboard', { query: { ...range, agentId, societyId, areaId } }),
    refetchInterval: 120_000,
  });

  const k = data?.kpis;
  const periodLabel = range.from === range.to ? date(range.from) : `${date(range.from)} – ${date(range.to)}`;

  return (
    <div className="space-y-5">
      <PageHeader title="Dashboard" subtitle={`Business overview · ${periodLabel}`} />

      <Card padded={false}>
        <div className="flex flex-wrap items-end gap-3 p-3">
          <Field label="Period">
            {(id) => (
              <Select
                id={id}
                value={preset}
                onChange={(e) => {
                  const p = e.target.value as Preset;
                  setPreset(p);
                  if (p !== 'custom') setRange(PRESETS[p]());
                }}
              >
                <option value="today">Today</option>
                <option value="month">This month</option>
                <option value="last30">Last 30 days</option>
                <option value="last90">Last 90 days</option>
                <option value="custom">Custom…</option>
              </Select>
            )}
          </Field>
          {preset === 'custom' && (
            <>
              <Field label="From">{(id) => <Input id={id} type="date" value={range.from} max={range.to} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} />}</Field>
              <Field label="To">{(id) => <Input id={id} type="date" value={range.to} min={range.from} max={today()} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} />}</Field>
            </>
          )}
          <Field label="Agent">{(id) => <AgentSelect id={id} value={agentId} onChange={setAgentId} />}</Field>
          <Field label="Area">{(id) => <AreaSelect id={id} value={areaId} onChange={setAreaId} />}</Field>
          <Field label="Society">{(id) => <SocietySelect id={id} value={societyId} onChange={setSocietyId} />}</Field>
        </div>
      </Card>

      <ErrorNote error={error} />
      {isLoading || !data || !k ? (
        <Spinner />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5" data-testid="kpis">
            <Kpi title="Collected today" value={inr(k.todayCollection as string)} to="/payments" />
            <Kpi title="Collected in period" value={inr(k.periodCollection as string)} sub={`Billed ${inr(k.periodBilled as string)}`} />
            <Kpi title="Collected this month" value={inr(k.monthCollection as string)} />
            <Kpi title="Total outstanding" value={inr(k.totalOutstanding as string)} sub={`Overdue ${inr(k.overdueAmount as string)}`} tone="bad" to="/reports/outstanding" />
            <Kpi title="Total advance" value={inr(k.totalAdvance as string)} to="/reports/advance" />
            <Kpi title="Active customers" value={String(k.activeCustomers)} sub={`${k.inactiveCustomers} inactive`} to="/customers" />
            <Kpi title="Due today" value={String(k.dueTodayCustomers)} sub="customers" />
            <Kpi title="Overdue" value={String(k.overdueCustomers)} sub="customers" tone={Number(k.overdueCustomers) > 0 ? 'bad' : undefined} to="/reports/overdue-customers" />
            <Kpi title="Cash with agents" value={inr(k.agentCashInHand as string)} to="/cash" />
            <Kpi
              title="Pending handovers"
              value={String(k.pendingHandovers)}
              sub={inr(k.pendingHandoverAmount as string)}
              tone={Number(k.pendingHandovers) > 0 ? 'warn' : undefined}
              to="/cash"
            />
            <Kpi
              title="Payments to verify"
              value={String(k.pendingVerifications)}
              sub={inr(k.pendingVerificationAmount as string)}
              tone={Number(k.pendingVerifications) > 0 ? 'warn' : undefined}
              to="/payments?status=PENDING_VERIFICATION"
            />
            <Kpi title="Follow-ups due" value={String(k.followUpsDue)} to="/follow-ups" tone={Number(k.followUpsDue) > 0 ? 'warn' : undefined} />
            <Kpi title="Missed promises" value={String(k.missedPromises)} to="/reports/promise-to-pay" tone={Number(k.missedPromises) > 0 ? 'bad' : undefined} />
            <Kpi title="Open alerts" value={String(k.openAlerts)} to="/alerts" tone={Number(k.openAlerts) > 0 ? 'bad' : undefined} />
          </div>

          {Number(k.openAlerts) > 0 && (
            <Link to="/alerts" className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              <AlertTriangle className="size-4" aria-hidden /> {k.openAlerts} alert(s) need attention (reconciliation, cash mismatches, possible duplicates).
            </Link>
          )}

          <div className="grid gap-4 xl:grid-cols-3">
            <ChartCard
              className="xl:col-span-2"
              title="Daily collection"
              subtitle="by payment mode"
              table={<SimpleTable head={['Date', 'Cash', 'UPI', 'Other', 'Total']} rows={data.dailyCollection.map((d) => [date(d.date), inr(d.cash), inr(d.upi), inr(d.other), inr(d.total)])} />}
            >
              <StackedBars
                rows={data.dailyCollection}
                x="date"
                xFormat={dayName}
                series={[
                  { key: 'cash', label: 'Cash' },
                  { key: 'upi', label: 'UPI' },
                  { key: 'other', label: 'Other' },
                ]}
              />
            </ChartCard>
            <ChartCard
              title="Payment modes"
              subtitle="in period"
              table={<SimpleTable head={['Mode', 'Payments', 'Amount']} rows={data.paymentModes.map((m) => [label(m.mode), m.payments, inr(m.amount)])} />}
            >
              {data.paymentModes.length ? (
                <HBars rows={data.paymentModes.map((m) => ({ ...m, mode: label(m.mode) }))} label="mode" value="amount" valueLabel="Collected" />
              ) : (
                <p className="py-10 text-center text-sm text-muted">No payments in this period</p>
              )}
            </ChartCard>
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <ChartCard
              title="Billed vs collected"
              subtitle="last 12 months"
              table={<SimpleTable head={['Month', 'Billed', 'Collected']} rows={data.monthlyTrend.map((m) => [monthName(m.month), inr(m.billed), inr(m.collected)])} />}
            >
              <Lines
                rows={data.monthlyTrend}
                x="month"
                xFormat={monthName}
                series={[
                  { key: 'billed', label: 'Billed' },
                  { key: 'collected', label: 'Collected' },
                ]}
              />
            </ChartCard>
            <ChartCard
              title="Outstanding ageing"
              subtitle="open bills by days past due"
              table={<SimpleTable head={['Age', 'Bills', 'Amount']} rows={data.ageing.map((a) => [a.bucket, a.invoices, inr(a.amount)])} />}
            >
              <HBars rows={data.ageing} label="bucket" value="amount" valueLabel="Outstanding" colors={ORDINAL} />
            </ChartCard>
          </div>

          <Card title="Agent performance" padded={false}>
            <DataTable
              rows={data.agentPerformance}
              rowKey={(r) => r.agentId}
              empty="No active agents"
              columns={[
                { key: 'agent', header: 'Agent', cell: (r) => <Link className="font-medium text-brand-800 hover:underline" to={`/agents/${r.agentId}`}>{r.agent} <span className="text-xs text-muted">{r.agentCode}</span></Link> },
                { key: 'assigned', header: 'Customers', align: 'right', cell: (r) => r.assignedCustomers },
                { key: 'out', header: 'Outstanding', align: 'right', cell: (r) => inr(r.outstanding) },
                { key: 'exp', header: 'Expected', align: 'right', cell: (r) => inr(r.expectedCollection) },
                { key: 'act', header: 'Collected', align: 'right', cell: (r) => inr(r.actualCollection) },
                { key: 'pct', header: 'Collection %', cell: (r) => <Meter pct={r.collectionPct} /> },
                { key: 'visits', header: 'Visits (paid)', align: 'right', cell: (r) => `${r.visits} (${r.successfulVisits})` },
                { key: 'fu', header: 'Follow-ups due', align: 'right', cell: (r) => r.pendingFollowUps },
                { key: 'cash', header: 'Cash in hand', align: 'right', cell: (r) => inr(r.cashInHand) },
              ]}
            />
            <p className="border-t border-line px-3 py-2 text-xs text-muted">
              Expected = {data.definitions.expectedCollection} Collection % = {data.definitions.collectionPct}
            </p>
          </Card>

          <div className="grid gap-4 xl:grid-cols-3">
            <ChartCard
              className="xl:col-span-2"
              title="Society-wise collection"
              subtitle="collected in period"
              table={<SimpleTable head={['Society', 'Customers', 'Collected', 'Outstanding']} rows={data.societyCollection.map((s) => [s.society, s.customers, inr(s.collected), inr(s.outstanding)])} />}
            >
              {data.societyCollection.length ? (
                <HBars rows={data.societyCollection} label="society" value="collected" valueLabel="Collected" />
              ) : (
                <p className="py-10 text-center text-sm text-muted">No societies yet</p>
              )}
            </ChartCard>
            <Card title="Billing frequency">
              <SimpleTable
                head={['Billed every', 'Customers']}
                rows={data.billingFrequency.map((b) => [b.intervalMonths === 1 ? 'Month' : `${b.intervalMonths} months`, b.customers])}
              />
              {data.billingFrequency.length === 0 && <p className="py-4 text-center text-sm text-muted">No subscriptions yet</p>}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
