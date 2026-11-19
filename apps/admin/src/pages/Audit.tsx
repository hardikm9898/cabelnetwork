import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiPage } from '../lib/api';
import { dateTime } from '../lib/format';
import { Card, DataTable, Field, FilterBar, Input, PageHeader, Pagination, Select, useDebounced } from '../components/ui';

interface Entry {
  id: string;
  occurredAt: string;
  actorName: string | null;
  actorRole: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  reason: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
}

const ENTITY_TYPES = ['customer', 'payment', 'invoice', 'credit_note', 'refund', 'subscription', 'cash_handover', 'user', 'area', 'society', 'temp_reassignment', 'setting', 'session'];

export default function AuditPage() {
  const [entityType, setEntityType] = useState('');
  const [action, setAction] = useState('');
  const da = useDebounced(action);
  const [page, setPage] = useState(1);
  const q = { entityType, action: da, page, pageSize: 50 };
  const { data, isLoading } = useQuery({ queryKey: ['audit', q], queryFn: () => apiPage<Entry>('/audit-logs', q) });
  return (
    <div>
      <PageHeader title="Audit log" subtitle="Every change, with who, when, from where, and why. Entries cannot be edited or deleted." />
      <Card padded={false}>
        <FilterBar>
          <Field label="Record type">
            {(id) => (
              <Select id={id} value={entityType} onChange={(e) => { setEntityType(e.target.value); setPage(1); }}>
                <option value="">Any</option>
                {ENTITY_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
              </Select>
            )}
          </Field>
          <Field label="Action starts with">{(id) => <Input id={id} value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }} placeholder="e.g. payment." />}</Field>
        </FilterBar>
        <DataTable
          rows={data?.items}
          loading={isLoading}
          rowKey={(r) => r.id}
          empty="No entries"
          columns={[
            { key: 'w', header: 'When', cell: (r) => <span className="whitespace-nowrap">{dateTime(r.occurredAt)}</span> },
            { key: 'u', header: 'Who', cell: (r) => r.actorName ?? 'System' },
            { key: 'a', header: 'Action', cell: (r) => <code className="text-xs">{r.action}</code> },
            { key: 'e', header: 'Record', cell: (r) => `${r.entityType.replace(/_/g, ' ')} ${r.entityId ? r.entityId.slice(0, 8) : ''}` },
            { key: 'r', header: 'Reason', cell: (r) => r.reason ?? '—' },
            {
              key: 'c',
              header: 'Change',
              cell: (r) => (
                <details className="max-w-md text-xs">
                  <summary className="cursor-pointer text-muted">view</summary>
                  <pre className="mt-1 break-all whitespace-pre-wrap">{JSON.stringify({ before: r.before, after: r.after }, null, 1)}</pre>
                </details>
              ),
            },
            { key: 'ip', header: 'IP', cell: (r) => r.ip ?? '—' },
          ]}
        />
        {data && <Pagination page={page} pageSize={50} total={data.meta.total} onPage={setPage} />}
      </Card>
    </div>
  );
}
