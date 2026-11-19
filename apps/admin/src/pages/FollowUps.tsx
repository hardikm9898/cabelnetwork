import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, apiPage } from '../lib/api';
import { date, inr, label } from '../lib/format';
import { ActionDialog } from '../components/ActionDialog';
import { Badge, Button, Card, DataTable, Field, FilterBar, PageHeader, Pagination, Select, StatusBadge, Tabs, Textarea, useToast } from '../components/ui';

interface Task {
  id: string;
  customerId: string;
  customerCode: string;
  customerName: string;
  mobile: string | null;
  societyName: string;
  dueDate: string;
  title: string;
  assignedToName: string | null;
  overdue: boolean;
  status: string;
}
interface PromiseRow {
  id: string;
  customerId: string;
  customerCode: string;
  customerName: string;
  expectedAmount: string;
  promiseDate: string;
  status: string;
  recordedByName: string;
  notes: string | null;
}

export default function FollowUpsPage() {
  const [tab, setTab] = useState<'tasks' | 'promises'>('tasks');
  return (
    <div className="space-y-4">
      <PageHeader title="Follow-ups" subtitle="Calls to make, promises to chase, visits to repeat." />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'tasks', label: 'Tasks' },
          { id: 'promises', label: 'Promises to pay' },
        ]}
      />
      {tab === 'tasks' ? <TasksTab /> : <PromisesTab />}
    </div>
  );
}

function TasksTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const [due, setDue] = useState('overdue');
  const [scope, setScope] = useState('all');
  const [page, setPage] = useState(1);
  const [closing, setClosing] = useState<{ task: Task; status: 'complete' | 'cancel' } | null>(null);
  const [note, setNote] = useState('');
  const q = { due, scope, page, pageSize: 25 };
  const { data, isLoading } = useQuery({ queryKey: ['followups', q], queryFn: () => apiPage<Task>('/follow-ups', q) });
  return (
    <Card padded={false}>
      <FilterBar>
        <Select value={due} onChange={(e) => { setDue(e.target.value); setPage(1); }} aria-label="Due" className="w-40">
          <option value="overdue">Overdue</option>
          <option value="today">Due today</option>
          <option value="upcoming">Upcoming</option>
          <option value="any">All open</option>
        </Select>
        <Select value={scope} onChange={(e) => { setScope(e.target.value); setPage(1); }} aria-label="Whose" className="w-40">
          <option value="all">Everyone’s</option>
          <option value="mine">Mine</option>
        </Select>
      </FilterBar>
      <DataTable
        rows={data?.items}
        loading={isLoading}
        rowKey={(r) => r.id}
        empty="Nothing here — well done"
        columns={[
          { key: 'due', header: 'Due', cell: (r) => <span className={r.overdue ? 'font-medium text-danger' : ''}>{date(r.dueDate)}</span> },
          { key: 'cust', header: 'Customer', cell: (r) => <Link className="font-medium text-brand-800 hover:underline" to={`/customers/${r.customerId}`}>{r.customerName}</Link> },
          { key: 'soc', header: 'Society', cell: (r) => r.societyName },
          { key: 'mob', header: 'Mobile', cell: (r) => (r.mobile ? <a className="hover:underline" href={`tel:${r.mobile}`}>{r.mobile}</a> : '—') },
          { key: 'what', header: 'Task', cell: (r) => r.title },
          { key: 'who', header: 'Assigned', cell: (r) => r.assignedToName ?? <Badge>customer’s agent</Badge> },
          {
            key: 'act',
            header: '',
            cell: (r) => (
              <div className="flex gap-1">
                <Button size="sm" variant="secondary" onClick={() => { setNote(''); setClosing({ task: r, status: 'complete' }); }}>Done</Button>
                <Button size="sm" variant="ghost" onClick={() => { setNote(''); setClosing({ task: r, status: 'cancel' }); }}>Drop</Button>
              </div>
            ),
          },
        ]}
      />
      {data && <Pagination page={page} pageSize={25} total={data.meta.total} onPage={setPage} />}
      <ActionDialog
        open={!!closing}
        onClose={() => setClosing(null)}
        title={closing?.status === 'complete' ? 'Mark follow-up done' : 'Drop follow-up'}
        onSubmit={async () => {
          await api('POST', `/follow-ups/${closing!.task.id}/${closing!.status}`, { body: { note: note || null } });
          toast('Follow-up updated');
          await qc.invalidateQueries({ queryKey: ['followups'] });
        }}
      >
        {() => <Field label="Outcome note">{(id) => <Textarea id={id} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>}
      </ActionDialog>
    </Card>
  );
}

function PromisesTab() {
  const qc = useQueryClient();
  const [status, setStatus] = useState('PROMISE_TO_PAY');
  const [page, setPage] = useState(1);
  const q = { interactionType: 'PAYMENT_PROMISE', status, page, pageSize: 25 };
  const { data, isLoading } = useQuery({ queryKey: ['promises', q], queryFn: () => apiPage<PromiseRow>('/interactions', q) });
  const setState = async (id: string, s: string) => {
    await api('PATCH', `/interactions/${id}`, { body: { status: s } });
    await qc.invalidateQueries({ queryKey: ['promises'] });
  };
  return (
    <Card padded={false}>
      <FilterBar>
        <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} aria-label="Status" className="w-48">
          <option value="PROMISE_TO_PAY">Open promises</option>
          <option value="COMPLETED">Kept (paid)</option>
          <option value="NOT_INTERESTED">Not interested</option>
        </Select>
      </FilterBar>
      <DataTable
        rows={data?.items}
        loading={isLoading}
        rowKey={(r) => r.id}
        empty="No promises"
        columns={[
          { key: 'cust', header: 'Customer', cell: (r) => <Link className="font-medium text-brand-800 hover:underline" to={`/customers/${r.customerId}`}>{r.customerName} <span className="text-xs text-muted">{r.customerCode}</span></Link> },
          { key: 'amt', header: 'Promised', align: 'right', cell: (r) => inr(r.expectedAmount) },
          { key: 'by', header: 'By', cell: (r) => date(r.promiseDate) },
          { key: 'st', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
          { key: 'rec', header: 'Recorded by', cell: (r) => r.recordedByName },
          { key: 'notes', header: 'Notes', cell: (r) => r.notes ?? '—' },
          {
            key: 'act',
            header: '',
            cell: (r) =>
              r.status === 'PROMISE_TO_PAY' ? (
                <Button size="sm" variant="ghost" onClick={() => setState(r.id, 'NOT_INTERESTED')}>
                  {label('NOT_INTERESTED')}
                </Button>
              ) : null,
          },
        ]}
      />
      {data && <Pagination page={page} pageSize={25} total={data.meta.total} onPage={setPage} />}
    </Card>
  );
}
