import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { monthCalendar, monthName, type MonthBill, type MonthState } from '@cablenet/domain';
import { api } from '../lib/api';
import { date, inr } from '../lib/format';
import { Button, Card, cx, Spinner } from './ui';

interface Months {
  today: string;
  bills: MonthBill[];
  openingBalance: { total: string; paid: string } | null;
}

const LOOK: Record<MonthState, { cell: string; text: string; label: string }> = {
  PAID: { cell: 'border-emerald-200 bg-emerald-50', text: 'text-emerald-800', label: 'Paid' },
  PARTIAL: { cell: 'border-amber-200 bg-amber-50', text: 'text-amber-800', label: 'Part paid' },
  DUE: { cell: 'border-red-200 bg-red-50', text: 'text-red-800', label: 'Not paid' },
  NOT_BILLED: { cell: 'border-line bg-slate-50', text: 'text-muted', label: 'No bill' },
  UPCOMING: { cell: 'border-dashed border-line bg-white', text: 'text-muted', label: 'Coming' },
};

/**
 * One year of the customer's months at a glance: paid (green), part paid (amber), not paid (red)
 * or not billed, with the bill amount, what was paid and when. Arrows move between years.
 */
export function MonthCalendar({ customerId }: { customerId: string }) {
  const { data, isLoading } = useQuery({ queryKey: ['customer', customerId, 'months'], queryFn: () => api<Months>('GET', `/customers/${customerId}/months`) });
  const thisYear = Number((data?.today ?? new Date().toISOString()).slice(0, 4));
  const [year, setYear] = useState<number | null>(null);
  const y = year ?? thisYear;
  if (isLoading || !data) {
    return (
      <Card title="Month by month" className="lg:col-span-2">
        <Spinner />
      </Card>
    );
  }
  const cells = monthCalendar(data.bills, `${y}-12`, 12, data.today);
  const firstYear = data.bills.length ? Number(data.bills[0]!.periodStart.slice(0, 4)) : thisYear;
  const count = (s: MonthState) => cells.filter((c) => c.state === s).length;
  const ob = data.openingBalance;
  return (
    <Card
      title="Month by month"
      className="lg:col-span-2"
      actions={
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" aria-label="Previous year" disabled={y <= Math.min(firstYear, thisYear)} onClick={() => setYear(y - 1)}>
            <ChevronLeft className="size-4" />
          </Button>
          <span className="w-12 text-center text-sm font-semibold">{y}</span>
          <Button size="sm" variant="ghost" aria-label="Next year" disabled={y >= thisYear + 1} onClick={() => setYear(y + 1)}>
            <ChevronRight className="size-4" />
          </Button>
        </div>
      }
    >
      <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        {(['PAID', 'PARTIAL', 'DUE', 'NOT_BILLED'] as const).map((s) => (
          <span key={s} className="inline-flex items-center gap-1.5">
            <span className={cx('inline-block size-3 rounded border', LOOK[s].cell)} />
            {LOOK[s].label} ({count(s)})
          </span>
        ))}
        {ob && (
          <span className="ml-auto">
            Previous balance {inr(ob.total)} · {ob.paid === ob.total ? 'paid' : `${inr((Number(ob.total) - Number(ob.paid)).toFixed(2))} left`}
          </span>
        )}
      </div>
      <ol className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6" aria-label={`Payments in ${y}`}>
        {cells.map((c) => {
          const look = LOOK[c.state];
          const left = c.bill ? Number(c.bill.total) - Number(c.bill.paid) : 0;
          return (
            <li key={c.month} className={cx('rounded-lg border p-2.5', look.cell)} title={c.bill ? `${monthName(c.month, true)}: bill ${inr(c.bill.total)}, paid ${inr(c.bill.paid)}` : undefined}>
              <div className="flex items-baseline justify-between gap-1">
                <span className="text-sm font-semibold text-ink">{monthName(c.month)}</span>
                <span className={cx('text-xs font-semibold', look.text)}>{look.label}</span>
              </div>
              {c.bill ? (
                <div className="mt-1 space-y-0.5 text-xs">
                  <div className="num text-ink">{inr(c.bill.total)}{c.billMonths > 1 ? ` · ${c.billMonths} mo` : ''}</div>
                  {c.state === 'PARTIAL' || c.state === 'DUE' ? (
                    <div className={cx('num', look.text)}>{inr(left.toFixed(2))} left</div>
                  ) : null}
                  {c.bill.paidOn && <div className="text-muted">paid {date(c.bill.paidOn)}</div>}
                </div>
              ) : (
                <div className="mt-1 text-xs text-muted">—</div>
              )}
            </li>
          );
        })}
      </ol>
    </Card>
  );
}
