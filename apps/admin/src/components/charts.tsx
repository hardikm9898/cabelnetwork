import { ReactNode, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from 'recharts';
import { formatInr } from '@cablenet/domain';
import { Card, cx } from './ui';

/**
 * Chart tokens (dataviz reference palette, validated for the white card surface):
 * categorical slots 1–3 = blue, orange, aqua (adjacent CVD ΔE ≥ 9.2); aqua is < 3:1 on white,
 * so every chart ships a legend and a table view (relief rule). Ordinal ramp = blue 250→650.
 */
export const SERIES = ['#2a78d6', '#eb6834', '#1baf7a'] as const;
export const ORDINAL = ['#86b6ef', '#5598e7', '#2a78d6', '#1c5cab', '#104281'] as const;
const INK = { primary: '#0b0b0b', secondary: '#52514e', muted: '#898781', grid: '#e1e0d9', axis: '#c3c2b7' };

/** Axis ticks only (precise values are shown as exact strings in tooltips/tables). */
export const compactInr = (v: number) => {
  const a = Math.abs(v);
  if (a >= 1e7) return `₹${(v / 1e7).toFixed(1)}Cr`;
  if (a >= 1e5) return `₹${(v / 1e5).toFixed(1)}L`;
  if (a >= 1e3) return `₹${(v / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`;
  return `₹${v}`;
};

export interface SeriesDef {
  key: string;
  label: string;
}

function Legend({ series, colors }: { series: SeriesDef[]; colors: readonly string[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[#52514e]" aria-label="Legend">
      {series.map((s, i) => (
        <li key={s.key} className="flex items-center gap-1.5">
          <span className="inline-block size-2.5 rounded-sm" style={{ background: colors[i] }} aria-hidden />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

/** Tooltip in text tokens; colour swatch carries identity. Values are the exact API strings. */
function MoneyTooltip({ active, payload, label, labelFormat }: TooltipContentProps<number, string> & { labelFormat?: (l: string) => string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-[rgba(11,11,11,0.10)] bg-white px-3 py-2 text-xs shadow-md">
      <div className="mb-1 font-medium text-[#0b0b0b]">{labelFormat ? labelFormat(String(label)) : label}</div>
      {payload.map((p) => (
        <div key={String(p.dataKey)} className="flex items-center justify-between gap-4 text-[#52514e]">
          <span className="flex items-center gap-1.5">
            <span className="inline-block size-2 rounded-sm" style={{ background: p.color }} aria-hidden />
            {p.name}
          </span>
          <span className="num font-medium text-[#0b0b0b]">{formatInr(String((p.payload as Record<string, string>)[`${String(p.dataKey)}_raw`] ?? p.value))}</span>
        </div>
      ))}
    </div>
  );
}

/** Card with a Chart / Table toggle (table view = accessible equivalent). */
export function ChartCard({ title, subtitle, legend, table, children, className }: { title: string; subtitle?: string; legend?: ReactNode; table: ReactNode; children: ReactNode; className?: string }) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  return (
    <Card
      className={className}
      title={
        <span>
          {title}
          {subtitle && <span className="ml-2 font-normal text-muted">{subtitle}</span>}
        </span>
      }
      actions={
        <div className="flex rounded-lg border border-line p-0.5 text-xs" role="group" aria-label={`${title} view`}>
          {(['chart', 'table'] as const).map((v) => (
            <button key={v} onClick={() => setView(v)} aria-pressed={view === v} className={cx('rounded-md px-2 py-0.5 capitalize', view === v ? 'bg-slate-100 font-medium' : 'text-muted')}>
              {v}
            </button>
          ))}
        </div>
      }
    >
      {view === 'chart' ? (
        <div className="space-y-3">
          {legend}
          {children}
        </div>
      ) : (
        <div className="max-h-72 overflow-auto">{table}</div>
      )}
    </Card>
  );
}

/** Plot values are numbers; the exact string is kept alongside as `<key>_raw` for tooltips. */
function plotRows<T extends Record<string, unknown>>(rows: T[], keys: string[]) {
  return rows.map((r) => {
    const out: Record<string, unknown> = { ...r };
    for (const k of keys) {
      out[`${k}_raw`] = r[k];
      out[k] = Number(r[k] ?? 0);
    }
    return out;
  });
}

const axisProps = { tick: { fill: INK.muted, fontSize: 11 }, tickLine: false, axisLine: { stroke: INK.axis } } as const;

export function StackedBars({ rows, x, series, xFormat, height = 240 }: { rows: Record<string, unknown>[]; x: string; series: SeriesDef[]; xFormat?: (v: string) => string; height?: number }) {
  const data = plotRows(rows, series.map((s) => s.key));
  return (
    <>
      <Legend series={series} colors={SERIES} />
      <div style={{ height }} role="img" aria-label={`Stacked bar chart of ${series.map((s) => s.label).join(', ')}`}>
        <ResponsiveContainer>
          <BarChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }} barCategoryGap="20%">
            <CartesianGrid vertical={false} stroke={INK.grid} />
            <XAxis dataKey={x} {...axisProps} tickFormatter={xFormat} minTickGap={12} />
            <YAxis {...axisProps} axisLine={false} tickFormatter={compactInr} width={56} />
            <Tooltip cursor={{ fill: 'rgba(11,11,11,0.04)' }} content={(p) => <MoneyTooltip {...(p as TooltipContentProps<number, string>)} labelFormat={xFormat} />} />
            {series.map((s, i) => (
              <Bar
                key={s.key}
                dataKey={s.key}
                name={s.label}
                stackId="a"
                fill={SERIES[i]}
                stroke="#ffffff"
                strokeWidth={1}
                radius={i === series.length - 1 ? [4, 4, 0, 0] : 0}
                maxBarSize={28}
                isAnimationActive={false}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </>
  );
}

export function Lines({ rows, x, series, xFormat, height = 240 }: { rows: Record<string, unknown>[]; x: string; series: SeriesDef[]; xFormat?: (v: string) => string; height?: number }) {
  const data = plotRows(rows, series.map((s) => s.key));
  return (
    <>
      <Legend series={series} colors={SERIES} />
      <div style={{ height }} role="img" aria-label={`Line chart of ${series.map((s) => s.label).join(' and ')}`}>
        <ResponsiveContainer>
          <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke={INK.grid} />
            <XAxis dataKey={x} {...axisProps} tickFormatter={xFormat} />
            <YAxis {...axisProps} axisLine={false} tickFormatter={compactInr} width={56} />
            <Tooltip cursor={{ stroke: INK.axis }} content={(p) => <MoneyTooltip {...(p as TooltipContentProps<number, string>)} labelFormat={xFormat} />} />
            {series.map((s, i) => (
              <Line
                key={s.key}
                dataKey={s.key}
                name={s.label}
                stroke={SERIES[i]}
                strokeWidth={2}
                dot={{ r: 4, fill: SERIES[i], stroke: '#ffffff', strokeWidth: 2 }}
                activeDot={{ r: 5, stroke: '#ffffff', strokeWidth: 2 }}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </>
  );
}

/** Horizontal bars for one measure across categories (sorted by the caller). */
export function HBars({ rows, label, value, valueLabel, colors, height }: { rows: Record<string, unknown>[]; label: string; value: string; valueLabel: string; colors?: readonly string[]; height?: number }) {
  const data = plotRows(rows, [value]);
  const h = height ?? Math.max(120, data.length * 34 + 24);
  return (
    <div style={{ height: h }} role="img" aria-label={`Bar chart of ${valueLabel} by ${label}`}>
      <ResponsiveContainer>
        <BarChart data={data} layout="vertical" margin={{ top: 0, right: 16, left: 0, bottom: 0 }} barCategoryGap={6}>
          <CartesianGrid horizontal={false} stroke={INK.grid} />
          <XAxis type="number" {...axisProps} tickFormatter={compactInr} />
          <YAxis type="category" dataKey={label} {...axisProps} width={128} tick={{ fill: INK.secondary, fontSize: 12 }} />
          <Tooltip cursor={{ fill: 'rgba(11,11,11,0.04)' }} content={(p) => <MoneyTooltip {...(p as TooltipContentProps<number, string>)} />} />
          <Bar dataKey={value} name={valueLabel} radius={[0, 4, 4, 0]} maxBarSize={22} isAnimationActive={false} fill={SERIES[0]}>
            {colors && data.map((_, i) => <Cell key={i} fill={colors[i % colors.length]} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Thin progress meter for a ratio (e.g. collection %). Text label always shown. */
export function Meter({ pct }: { pct: number | null }) {
  if (pct === null) return <span className="text-muted">—</span>;
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-slate-100" aria-hidden>
        <div className="h-full rounded-full" style={{ width: `${clamped}%`, background: SERIES[0] }} />
      </div>
      <span className="num text-xs text-[#52514e]">{pct.toFixed(1)}%</span>
    </div>
  );
}
