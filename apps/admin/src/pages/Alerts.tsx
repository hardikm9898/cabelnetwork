import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { api, apiPage } from '../lib/api';
import { dateTime, label } from '../lib/format';
import { ActionDialog } from '../components/ActionDialog';
import { Badge, Button, Card, DataTable, Field, FilterBar, PageHeader, Pagination, Select, Textarea, useToast } from '../components/ui';

interface Alert {
  id: string;
  type: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  entityType: string | null;
  entityId: string | null;
  message: string;
  createdAt: string;
  resolvedAt: string | null;
  resolution: string | null;
}

export default function AlertsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState('true');
  const [page, setPage] = useState(1);
  const [resolve, setResolve] = useState<Alert | null>(null);
  const [note, setNote] = useState('');
  const [running, setRunning] = useState(false);
  const q = { open, page, pageSize: 25 };
  const { data, isLoading } = useQuery({ queryKey: ['alerts', q], queryFn: () => apiPage<Alert>('/system-alerts', q) });

  const reconcile = async () => {
    setRunning(true);
    try {
      const r = await api<{ checkedCustomers: number; newAlerts: number; customerMismatches: unknown[]; invoiceCacheMismatches: unknown[]; overAllocatedCredits: unknown[] }>('POST', '/reconciliation/run');
      const issues = r.customerMismatches.length + r.invoiceCacheMismatches.length + r.overAllocatedCredits.length;
      toast(issues === 0 ? `Books balance: ${r.checkedCustomers} customers checked` : `${issues} mismatch(es) found — see alerts`, issues ? 'bad' : 'good');
      await qc.invalidateQueries({ queryKey: ['alerts'] });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Alerts"
        subtitle="Reconciliation mismatches, cash differences, possible duplicate payments, billing problems."
        actions={
          <Button variant="secondary" busy={running} onClick={reconcile}>
            <RefreshCw className="size-4" aria-hidden /> Check the books now
          </Button>
        }
      />
      <Card padded={false}>
        <FilterBar>
          <Select value={open} onChange={(e) => { setOpen(e.target.value); setPage(1); }} className="w-40" aria-label="Show">
            <option value="true">Open</option>
            <option value="false">All</option>
          </Select>
        </FilterBar>
        <DataTable
          rows={data?.items}
          loading={isLoading}
          rowKey={(r) => r.id}
          empty="No open alerts"
          columns={[
            { key: 'w', header: 'When', cell: (r) => dateTime(r.createdAt) },
            { key: 's', header: 'Severity', cell: (r) => <Badge tone={r.severity === 'CRITICAL' ? 'bad' : r.severity === 'WARNING' ? 'warn' : 'info'}>{label(r.severity)}</Badge> },
            { key: 't', header: 'Type', cell: (r) => label(r.type) },
            { key: 'm', header: 'Details', cell: (r) => r.message },
            {
              key: 'x',
              header: '',
              cell: (r) =>
                r.resolvedAt ? (
                  <span className="text-xs text-muted">Resolved: {r.resolution}</span>
                ) : (
                  <Button size="sm" variant="secondary" onClick={() => { setNote(''); setResolve(r); }}>Resolve</Button>
                ),
            },
          ]}
        />
        {data && <Pagination page={page} pageSize={25} total={data.meta.total} onPage={setPage} />}
      </Card>
      <ActionDialog
        open={!!resolve}
        onClose={() => setResolve(null)}
        title="Resolve alert"
        disabled={note.trim().length < 3}
        onSubmit={async () => {
          await api('POST', `/system-alerts/${resolve!.id}/resolve`, { body: { resolution: note } });
          toast('Alert resolved');
          await qc.invalidateQueries({ queryKey: ['alerts'] });
        }}
      >
        {() => (
          <>
            <p className="text-sm">{resolve?.message}</p>
            <Field label="What was done" required>{(id) => <Textarea id={id} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
          </>
        )}
      </ActionDialog>
    </div>
  );
}
