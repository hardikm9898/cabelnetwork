import { ReactNode, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { api, apiPage, newKey } from '../lib/api';
import { inr } from '../lib/format';
import { Button, cx, ErrorNote, Field, Modal, Select, Textarea, useDebounced } from './ui';

export interface AgentRow {
  id: string;
  fullName: string;
  agentCode: string;
  mobile: string;
  status: string;
  employmentStatus: string;
  primaryCustomers: number;
  currentCustomers: number;
  lastLoginAt: string | null;
}
export interface SocietyRow {
  id: string;
  name: string;
  areaId: string | null;
  areaName: string | null;
  collectionDay: number | null;
  status: string;
  customerCount: number;
  legacyName: string | null;
}
export interface AreaRow {
  id: string;
  name: string;
  description: string | null;
  status: string;
  ownerAgentId: string | null;
  ownerAgentName: string | null;
  societyCount: number;
  customerCount: number;
}

export const useAgents = () => useQuery({ queryKey: ['agents'], queryFn: () => api<AgentRow[]>('GET', '/agents'), staleTime: 60_000 });
export const useSocieties = () => useQuery({ queryKey: ['societies'], queryFn: () => api<SocietyRow[]>('GET', '/societies'), staleTime: 60_000 });
export const useAreas = () => useQuery({ queryKey: ['areas'], queryFn: () => api<AreaRow[]>('GET', '/areas'), staleTime: 60_000 });

export function AgentSelect({ value, onChange, allLabel = 'All agents', includeAll = true, id }: { value: string; onChange: (v: string) => void; allLabel?: string; includeAll?: boolean; id?: string }) {
  const { data } = useAgents();
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} aria-label={id ? undefined : 'Agent'}>
      {includeAll && <option value="">{allLabel}</option>}
      {!includeAll && <option value="">Choose agent…</option>}
      {data
        ?.filter((a) => a.status === 'ACTIVE' || a.id === value)
        .map((a) => (
          <option key={a.id} value={a.id}>
            {a.fullName} ({a.agentCode})
          </option>
        ))}
    </Select>
  );
}

export function SocietySelect({ value, onChange, includeAll = true, id }: { value: string; onChange: (v: string) => void; includeAll?: boolean; id?: string }) {
  const { data } = useSocieties();
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} aria-label={id ? undefined : 'Society'}>
      <option value="">{includeAll ? 'All societies' : 'Choose society…'}</option>
      {data
        ?.filter((s) => s.status === 'ACTIVE' || s.id === value)
        .map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
    </Select>
  );
}

export function AreaSelect({ value, onChange, id, includeAll = true }: { value: string; onChange: (v: string) => void; id?: string; includeAll?: boolean }) {
  const { data } = useAreas();
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} aria-label={id ? undefined : 'Area'}>
      <option value="">{includeAll ? 'All areas' : 'No area'}</option>
      {data?.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name}
        </option>
      ))}
    </Select>
  );
}

/**
 * Confirmation that requires a written reason (reversals, cancellations, status changes).
 * Holds one idempotency key per opening, so a retried click never double-applies.
 */
export function ReasonDialog({
  open,
  onClose,
  title,
  description,
  confirmLabel = 'Confirm',
  danger,
  onConfirm,
  children,
  presets,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: (reason: string, idempotencyKey: string) => Promise<unknown>;
  children?: ReactNode;
  /** One-tap reasons shown above the box. */
  presets?: string[];
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const key = useRef(newKey());
  useEffect(() => {
    if (open) {
      setReason('');
      setError(null);
      key.current = newKey();
    }
  }, [open]);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(reason.trim(), key.current);
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} busy={busy} disabled={reason.trim().length < 3} onClick={submit}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {description && <div className="text-sm text-muted">{description}</div>}
        {children}
        {presets && (
          <div className="flex flex-wrap gap-2" aria-label="Quick reasons">
            {presets.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setReason(p)}
                className={cx('rounded-full border px-3 py-1 text-sm', reason === p ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-line hover:bg-slate-50')}
              >
                {p}
              </button>
            ))}
          </div>
        )}
        <Field label="Reason" required hint="Recorded in the audit log.">
          {(id) => <Textarea id={id} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus={!presets} />}
        </Field>
        <ErrorNote error={error} />
      </div>
    </Modal>
  );
}

export interface CustomerHit {
  id: string;
  customerCode: string;
  name: string;
  mobile: string | null;
  societyName: string;
  outstanding: string;
  advance: string;
  status: string;
}

/** Type-ahead customer search (ID, name, mobile, STB). */
export function CustomerPicker({ onPick, autoFocus }: { onPick: (c: CustomerHit) => void; autoFocus?: boolean }) {
  const [q, setQ] = useState('');
  const debounced = useDebounced(q, 250);
  const { data, isFetching } = useQuery({
    queryKey: ['customer-search', debounced],
    queryFn: () => apiPage<CustomerHit>('/customers', { q: debounced, pageSize: 8 }),
    enabled: debounced.trim().length >= 2,
  });
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted" aria-hidden />
      <input
        className="h-10 w-full rounded-lg border border-line bg-white pr-3 pl-9 text-sm focus:border-brand-600 focus:ring-2 focus:ring-brand-100 focus:outline-none"
        placeholder="Search by customer ID, name, mobile or STB…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        aria-label="Search customers"
        autoFocus={autoFocus}
      />
      {debounced.trim().length >= 2 && (
        <ul className="absolute z-20 mt-1 max-h-80 w-full overflow-y-auto rounded-lg border border-line bg-white shadow-lg" role="listbox">
          {isFetching && !data && <li className="p-3 text-sm text-muted">Searching…</li>}
          {data?.items.length === 0 && <li className="p-3 text-sm text-muted">No customers found</li>}
          {data?.items.map((c) => (
            <li key={c.id}>
              <button
                role="option"
                aria-selected={false}
                className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-brand-50"
                onClick={() => {
                  onPick(c);
                  setQ('');
                }}
              >
                <span>
                  <span className="font-medium">{c.name}</span>
                  <span className="ml-2 text-xs text-muted">
                    {c.customerCode} · {c.societyName} {c.mobile ? `· ${c.mobile}` : ''}
                  </span>
                </span>
                <span className={cx('num text-sm', c.outstanding !== '0.00' ? 'text-danger' : 'text-muted')}>{c.outstanding !== '0.00' ? inr(c.outstanding) : 'Settled'}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Money text input: digits with up to 2 decimals (sent to the API as a string). */
export function MoneyInput({ value, onChange, id, autoFocus }: { value: string; onChange: (v: string) => void; id?: string; autoFocus?: boolean }) {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute top-2 left-3 text-muted">₹</span>
      <input
        id={id}
        inputMode="decimal"
        autoComplete="off"
        autoFocus={autoFocus}
        className="num h-10 w-full rounded-lg border border-line bg-white pr-3 pl-7 text-sm focus:border-brand-600 focus:ring-2 focus:ring-brand-100 focus:outline-none"
        value={value}
        onChange={(e) => {
          const v = e.target.value.replace(/[^\d.]/g, '');
          if (/^\d{0,10}(\.\d{0,2})?$/.test(v)) onChange(v);
        }}
      />
    </div>
  );
}
