import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useState } from 'react';
import { addDays, businessDateOf, formatDateIN } from '@cablenet/domain';
import { api } from '../lib/api';
import { useApp } from '../lib/app-state';
import { useOffline } from '../lib/offline';
import { Badge, Card, Chips, ErrorBox, Loading, Money, Row, Screen, T, useOnline } from '../components/ui';
import { OpStateBadge } from '../components/OpState';
import { when } from '../components/SyncBar';

interface Payment {
  id: string;
  amount: string;
  paymentDate: string;
  mode: string;
  status: string;
  customerName: string;
  customerCode: string;
}

/** Payments this agent collected (today / 7 days / 30 days); entries still on the phone first. */
export default function MyCollections() {
  const { t, me } = useApp();
  const online = useOnline();
  const { store, status } = useOffline();
  const onPhone = store
    .getOps()
    .filter((o) => o.type === 'PAYMENT_CREATE' && o.userId === me?.id && (o.state === 'PENDING' || (o.state === 'REJECTED' && !o.acknowledgedAt)))
    .reverse();
  const today = businessDateOf(new Date());
  const [range, setRange] = useState<'0' | '6' | '29'>('0');
  const from = addDays(today, -Number(range));
  const q = useQuery({
    queryKey: ['my-payments', from, status.lastSyncAt],
    queryFn: () => api<Payment[]>('GET', '/payments', { query: { from, to: today, pageSize: 100 } }),
    enabled: online,
  });
  return (
    <Screen>
      <Chips
        value={range}
        onChange={setRange}
        options={[
          { value: '0', label: t('today') },
          { value: '6', label: '7' },
          { value: '29', label: '30' },
        ]}
      />
      {onPhone.map((o) => (
        <Card key={o.opId} testID="on-phone" onPress={() => router.push({ pathname: '/receipt/[id]', params: { id: o.opId } })}>
          <Row>
            <T weight="600" numberOfLines={1} style={{ flex: 1 }}>
              {o.label.customerName}
            </T>
            <Money value={String(o.payload.amount)} />
          </Row>
          <Row>
            <T muted size={13}>
              {when(o.createdAt)} · {o.label.provisionalRef}
            </T>
            <OpStateBadge op={o} />
          </Row>
        </Card>
      ))}
      {!online && <T muted>{t('offline')}</T>}
      <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      {q.isLoading && <Loading />}
      {q.data?.length === 0 && <T muted style={{ textAlign: 'center', padding: 24 }}>{t('nothingHere')}</T>}
      {q.data?.map((p) => (
        <Card key={p.id} onPress={p.status === 'CONFIRMED' ? () => router.push({ pathname: '/receipt/[id]', params: { id: p.id } }) : undefined}>
          <Row>
            <T weight="600" numberOfLines={1} style={{ flex: 1 }}>
              {p.customerName}
            </T>
            <Money value={p.amount} />
          </Row>
          <Row>
            <T muted size={13}>
              {formatDateIN(p.paymentDate)} · {p.customerCode} · {p.mode === 'CASH' ? t('cash') : p.mode === 'UPI' ? t('upi') : t('other')}
            </T>
            {p.status !== 'CONFIRMED' && <Badge tone={p.status === 'PENDING_VERIFICATION' ? 'warn' : 'bad'} text={p.status === 'PENDING_VERIFICATION' ? t('pendingCheck') : p.status.toLowerCase()} />}
          </Row>
        </Card>
      ))}
    </Screen>
  );
}
