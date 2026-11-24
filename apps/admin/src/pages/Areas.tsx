import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { ActionDialog } from '../components/ActionDialog';
import { AgentSelect, AreaRow, AreaSelect, ReasonDialog, SocietyRow, useAreas, useSocieties } from '../components/shared';
import { Badge, Button, Card, DataTable, Field, Input, PageHeader, Textarea, useToast } from '../components/ui';

export default function AreasPage() {
  const { can } = useAuth();
  const areas = useAreas();
  const societies = useSocieties();
  const qc = useQueryClient();
  const toast = useToast();
  const [areaDialog, setAreaDialog] = useState<AreaRow | 'new' | null>(null);
  const [ownerDialog, setOwnerDialog] = useState<AreaRow | null>(null);
  const [societyDialog, setSocietyDialog] = useState<SocietyRow | 'new' | null>(null);
  const [deleting, setDeleting] = useState<{ kind: 'area' | 'society'; id: string; name: string } | null>(null);
  const refresh = () => qc.invalidateQueries({ predicate: (q) => ['areas', 'societies', 'customers', 'agents'].includes(String(q.queryKey[0])) });
  const manage = can('areas:manage');

  return (
    <div className="space-y-4">
      <PageHeader title="Areas & societies" subtitle="Societies are grouped into areas. Each area has a default agent; its customers follow that agent unless pinned to someone else." />
      <Card
        title="Areas"
        padded={false}
        actions={manage && <Button size="sm" onClick={() => setAreaDialog('new')}><Plus className="size-4" aria-hidden /> Area</Button>}
      >
        <DataTable
          rows={areas.data}
          loading={areas.isLoading}
          rowKey={(r) => r.id}
          empty="No areas yet"
          columns={[
            { key: 'n', header: 'Area', cell: (r) => <span className="font-medium">{r.name}</span> },
            { key: 'o', header: 'Default agent', cell: (r) => r.ownerAgentName ?? <Badge tone="warn">none</Badge> },
            { key: 's', header: 'Societies', align: 'right', cell: (r) => r.societyCount },
            { key: 'c', header: 'Customers', align: 'right', cell: (r) => r.customerCount },
            {
              key: 'x',
              header: '',
              cell: (r) =>
                manage && (
                  <div className="flex justify-end gap-1">
                    <Button size="sm" variant="secondary" onClick={() => setOwnerDialog(r)}>Change agent</Button>
                    <Button size="sm" variant="ghost" onClick={() => setAreaDialog(r)}>Rename</Button>
                    <Button size="sm" variant="ghost" className="text-danger" onClick={() => setDeleting({ kind: 'area', id: r.id, name: r.name })}>Delete</Button>
                  </div>
                ),
            },
          ]}
        />
      </Card>
      <Card
        title="Societies"
        padded={false}
        actions={can('societies:manage') && <Button size="sm" onClick={() => setSocietyDialog('new')}><Plus className="size-4" aria-hidden /> Society</Button>}
      >
        <DataTable
          rows={societies.data}
          loading={societies.isLoading}
          rowKey={(r) => r.id}
          empty="No societies yet"
          columns={[
            { key: 'n', header: 'Society', cell: (r) => <span className="font-medium">{r.name}</span> },
            { key: 'l', header: 'As in Excel', cell: (r) => r.legacyName ?? '—' },
            { key: 'a', header: 'Area', cell: (r) => r.areaName ?? <Badge tone="warn">no area</Badge> },
            { key: 'd', header: 'Route day', align: 'right', cell: (r) => r.collectionDay ?? '—' },
            { key: 'c', header: 'Customers', align: 'right', cell: (r) => r.customerCount },
            {
              key: 'x',
              header: '',
              cell: (r) =>
                can('societies:manage') && (
                  <div className="flex justify-end gap-1">
                    <Button size="sm" variant="ghost" onClick={() => setSocietyDialog(r)}>Edit</Button>
                    <Button size="sm" variant="ghost" className="text-danger" onClick={() => setDeleting({ kind: 'society', id: r.id, name: r.name })}>Delete</Button>
                  </div>
                ),
            },
          ]}
        />
      </Card>

      <ReasonDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title={`Delete ${deleting?.kind ?? ''} ${deleting?.name ?? ''}`}
        danger
        confirmLabel="Delete"
        presets={['Created by mistake', 'Merged into another', 'Not used any more']}
        description={
          deleting?.kind === 'area'
            ? 'Only an area without societies can be deleted: move its societies to another area (Edit society) first.'
            : 'Only a society without customers can be deleted: move its customers to another society (Edit customer) or delete them first.'
        }
        onConfirm={async (reason) => {
          await api('POST', `/${deleting!.kind === 'area' ? 'areas' : 'societies'}/${deleting!.id}/delete`, { body: { reason } });
          toast(`${deleting!.name} deleted`);
          await refresh();
        }}
      />
      <AreaDialog
        area={areaDialog}
        onClose={() => setAreaDialog(null)}
        onSaved={async () => { toast('Area saved'); await refresh(); }}
      />
      <OwnerDialog area={ownerDialog} onClose={() => setOwnerDialog(null)} onSaved={async (n) => { toast(`Default agent changed; ${n} customer(s) moved`); await refresh(); }} />
      <SocietyDialog society={societyDialog} onClose={() => setSocietyDialog(null)} onSaved={async () => { toast('Society saved'); await refresh(); }} />
    </div>
  );
}

function AreaDialog({ area, onClose, onSaved }: { area: AreaRow | 'new' | null; onClose: () => void; onSaved: () => Promise<unknown> }) {
  const existing = area && area !== 'new' ? area : null;
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  return (
    <ActionDialog
      open={!!area}
      onClose={() => { setName(''); setDescription(''); onClose(); }}
      title={existing ? `Rename ${existing.name}` : 'New area'}
      onSubmit={async () => {
        if (existing) await api('PATCH', `/areas/${existing.id}`, { body: { name: name || existing.name, description: description || null } });
        else await api('POST', '/areas', { body: { name, description: description || null } });
        setName('');
        setDescription('');
        await onSaved();
      }}
    >
      {(err) => (
        <>
          <Field label="Name" required error={err.name}>{(id) => <Input id={id} value={name} placeholder={existing?.name} onChange={(e) => setName(e.target.value)} />}</Field>
          <Field label="Description">{(id) => <Textarea id={id} value={description} placeholder={existing?.description ?? ''} onChange={(e) => setDescription(e.target.value)} />}</Field>
        </>
      )}
    </ActionDialog>
  );
}

function OwnerDialog({ area, onClose, onSaved }: { area: AreaRow | null; onClose: () => void; onSaved: (moved: number) => Promise<unknown> }) {
  const [agentId, setAgentId] = useState('');
  const [reason, setReason] = useState('');
  const [all, setAll] = useState(false);
  return (
    <ActionDialog
      open={!!area}
      onClose={onClose}
      title={`Default agent for ${area?.name ?? ''}`}
      disabled={reason.trim().length < 3}
      onSubmit={async () => {
        const r = await api<{ customersMoved: number }>('PUT', `/areas/${area!.id}/owner`, { body: { agentId: agentId || null, reason, applyToManualOverrides: all } });
        setReason('');
        await onSaved(r.customersMoved);
      }}
    >
      {() => (
        <>
          <p className="text-sm text-muted">Currently: {area?.ownerAgentName ?? 'none'}. Customers following the area move to the new agent now.</p>
          <Field label="New default agent">{(id) => <AgentSelect id={id} value={agentId} onChange={setAgentId} allLabel="No default agent" />}</Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Also move customers who were pinned to a specific agent
          </label>
          <Field label="Reason" required>{(id) => <Textarea id={id} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
        </>
      )}
    </ActionDialog>
  );
}

function SocietyDialog({ society, onClose, onSaved }: { society: SocietyRow | 'new' | null; onClose: () => void; onSaved: () => Promise<unknown> }) {
  const existing = society && society !== 'new' ? society : null;
  const [f, setF] = useState<{ name?: string; areaId?: string; collectionDay?: string; reason?: string }>({});
  const areaChanged = existing && f.areaId !== undefined && f.areaId !== (existing.areaId ?? '');
  return (
    <ActionDialog
      open={!!society}
      onClose={() => { setF({}); onClose(); }}
      title={existing ? `Edit ${existing.name}` : 'New society'}
      disabled={!!areaChanged && (f.reason ?? '').trim().length < 3}
      onSubmit={async () => {
        const body = {
          name: f.name ?? existing?.name,
          areaId: f.areaId !== undefined ? f.areaId || null : (existing?.areaId ?? null),
          collectionDay: f.collectionDay !== undefined ? (f.collectionDay ? Number(f.collectionDay) : null) : (existing?.collectionDay ?? null),
          ...(areaChanged ? { reason: f.reason } : {}),
        };
        if (existing) await api('PATCH', `/societies/${existing.id}`, { body });
        else await api('POST', '/societies', { body });
        setF({});
        await onSaved();
      }}
    >
      {(err) => (
        <>
          <Field label="Name" required error={err.name}>{(id) => <Input id={id} value={f.name ?? existing?.name ?? ''} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
          <Field label="Area">{(id) => <AreaSelect id={id} value={f.areaId ?? existing?.areaId ?? ''} onChange={(v) => setF({ ...f, areaId: v })} includeAll={false} />}</Field>
          <Field label="Usual collection day (1–31)">{(id) => <Input id={id} type="number" min={1} max={31} value={f.collectionDay ?? existing?.collectionDay?.toString() ?? ''} onChange={(e) => setF({ ...f, collectionDay: e.target.value })} />}</Field>
          {areaChanged && (
            <Field label="Reason for moving area" required hint="Customers following the area default move to the new area's agent.">
              {(id) => <Textarea id={id} value={f.reason ?? ''} onChange={(e) => setF({ ...f, reason: e.target.value })} />}
            </Field>
          )}
        </>
      )}
    </ActionDialog>
  );
}
