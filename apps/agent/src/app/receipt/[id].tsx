import { useQuery } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import type { PaymentOpResult } from '@cablenet/contracts';
import { api } from '../../lib/api';
import { useApp } from '../../lib/app-state';
import { OutboxOp, useActions, useOffline } from '../../lib/offline';
import { provisionalMessage, receiptMessage, ReceiptSnapshot, whatsappUrl } from '../../lib/share';
import { openExternal } from '../../lib/open';
import { Button, C, Card, ErrorBox, Loading, Money, Row, Screen, T, useOnline } from '../../components/ui';
import { FLAG_TEXT } from '../../components/OpState';

interface PaymentDetail {
  id: string;
  status: string;
  amount: string;
  receipt: { id: string; receiptNumber: string; snapshot: ReceiptSnapshot } | null;
}

/** What the final receipt shows, from either the sync result or the server's payment. */
interface FinalView {
  amount: string;
  status: string;
  receiptId: string | null;
  receiptNumber: string | null;
  snapshot: ReceiptSnapshot | null;
}

function Final({ v, flags }: { v: FinalView; flags: string[] }) {
  const { t } = useApp();
  const [error, setError] = useState<unknown>(null);
  const s = v.snapshot;
  const confirmed = v.status === 'CONFIRMED' && !!v.receiptNumber;
  const link = async () => (await api<{ url: string }>('GET', `/receipts/${v.receiptId}/link`)).url;
  const share = async () => {
    try {
      setError(null);
      await openExternal(whatsappUrl(s!.customer.mobile, receiptMessage(s!, await link())));
    } catch (e) {
      setError(e);
    }
  };
  const open = async () => {
    try {
      setError(null);
      await openExternal(await link());
    } catch (e) {
      setError(e);
    }
  };
  return (
    <>
      <Card style={{ alignItems: 'center', backgroundColor: confirmed ? C.successSoft : C.warningSoft, borderColor: 'transparent' }}>
        <T size={44}>{confirmed ? '✓' : '⏳'}</T>
        <T testID="payment-result" size={20} weight="800" style={{ color: confirmed ? C.success : C.warning }}>
          {confirmed ? t('paymentSaved') : t('paymentPending')}
        </T>
        <Money value={v.amount} size={30} weight="800" />
        {confirmed && (
          <T testID="receipt-number" muted>
            {t('receipt')} {v.receiptNumber}
          </T>
        )}
      </Card>
      {flags.length > 0 && (
        <Card style={{ backgroundColor: C.infoSoft, borderColor: 'transparent' }}>
          <T weight="700" testID="office-will-check">
            {t('officeWillCheck')}
          </T>
          {flags.map((f) => (
            <T key={f} size={13}>
              • {FLAG_TEXT[f] ? t(FLAG_TEXT[f]) : f}
            </T>
          ))}
        </Card>
      )}
      {confirmed && s ? (
        <Card>
          <T weight="700">{t('allocated')}</T>
          {s.allocations.map((a, i) => (
            <Row key={i}>
              <T>{a.label}</T>
              <Money value={a.amount} />
            </Row>
          ))}
          {s.advanceCreated !== '0.00' && (
            <Row>
              <T style={{ color: C.success }}>{t('keptAsAdvance')}</T>
              <Money value={s.advanceCreated} color={C.success} />
            </Row>
          )}
          <View style={{ height: 1, backgroundColor: C.line }} />
          {s.remainingOutstanding !== '0.00' ? (
            <Row>
              <T weight="700">{t('stillDue')}</T>
              <Money value={s.remainingOutstanding} color={C.danger} />
            </Row>
          ) : (
            <T weight="700" style={{ color: C.success }}>
              {t('allCleared')}
            </T>
          )}
        </Card>
      ) : (
        !confirmed && <T style={{ color: C.warning }}>{flags.length ? t('officeWillCheck') : t('upiPendingNote')}</T>
      )}
      <ErrorBox error={error} />
      {confirmed && s && <Button testID="share-whatsapp" title={t('shareWhatsApp')} onPress={share} />}
      {confirmed && <Button title={t('openReceipt')} variant="secondary" onPress={open} />}
    </>
  );
}

function Provisional({ op }: { op: OutboxOp }) {
  const { t, me } = useApp();
  const { store } = useOffline();
  const header = store.getHeader();
  const customer = op.label.customerId ? store.getCustomer(op.label.customerId) : null;
  const message = provisionalMessage({
    business: header?.business.name ?? '',
    provisionalRef: op.label.provisionalRef ?? '',
    customerName: op.label.customerName ?? '',
    customerCode: op.label.customerCode ?? '',
    amount: String(op.payload.amount),
    mode: String(op.payload.mode),
    collectedAt: op.createdAt,
    agentName: me?.fullName ?? header?.agent.name ?? '',
  });
  return (
    <>
      <Card style={{ alignItems: 'center', backgroundColor: C.warningSoft, borderColor: 'transparent' }}>
        <T size={44}>⏳</T>
        <T testID="payment-result" size={20} weight="800" style={{ color: C.warning }}>
          {t('provisionalReceipt')}
        </T>
        <Money value={String(op.payload.amount)} size={30} weight="800" />
        <T testID="provisional-ref" muted>
          {op.label.provisionalRef}
        </T>
      </Card>
      <T style={{ color: C.warning }}>{t('provisionalNote')}</T>
      <Button testID="share-provisional" title={t('shareProvisional')} onPress={() => void openExternal(whatsappUrl(customer?.mobile ?? null, message))} />
    </>
  );
}

export default function Receipt() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useApp();
  const online = useOnline();
  const { store, status } = useOffline();
  const act = useActions(online);
  const op = store.getOp(id);
  // Not an entry from this phone: a payment from the server's history (needs internet).
  const server = useQuery({ queryKey: ['payment', id], queryFn: () => api<PaymentDetail>('GET', `/payments/${id}`), enabled: !op });

  let body;
  if (op) {
    const r = op.result as PaymentOpResult | null | undefined;
    if (op.state === 'REJECTED') {
      body = (
        <Card style={{ backgroundColor: C.dangerSoft, borderColor: 'transparent' }}>
          <T testID="payment-result" size={20} weight="800" style={{ color: C.danger }}>
            {t('notAccepted')}
          </T>
          <Money value={String(op.payload.amount)} size={24} weight="800" />
          <T>{op.error?.message}</T>
          {!op.acknowledgedAt && <Button testID="acknowledge" title={t('understood')} variant="secondary" onPress={() => void act.acknowledge(op.opId)} />}
        </Card>
      );
    } else if (r) {
      const customer = op.label.customerId ? store.getCustomer(op.label.customerId) : null;
      const header = store.getHeader();
      const snapshot: ReceiptSnapshot | null = r.receiptNumber
        ? {
            business: { name: header?.business.name ?? '' },
            receiptNumber: r.receiptNumber,
            payment: { amount: String(op.payload.amount), paymentDate: r.paymentDate, mode: String(op.payload.mode) },
            customer: { code: op.label.customerCode ?? '', name: op.label.customerName ?? '', mobile: customer?.mobile ?? null },
            allocations: r.allocations,
            advanceCreated: r.advanceCreated,
            remainingOutstanding: r.remainingOutstanding ?? '0.00',
            remainingAdvance: r.remainingAdvance ?? '0.00',
          }
        : null;
      body = <Final v={{ amount: String(op.payload.amount), status: r.status, receiptId: r.receiptId, receiptNumber: r.receiptNumber, snapshot }} flags={op.flags} />;
    } else if (online && status.running) {
      body = (
        <Card style={{ alignItems: 'center', gap: 10 }}>
          <ActivityIndicator color={C.brand} size="large" />
          <T testID="payment-sending">{t('sending')}</T>
        </Card>
      );
    } else {
      body = <Provisional op={op} />;
    }
  } else if (server.isLoading) {
    body = <Loading />;
  } else if (!server.data) {
    body = <ErrorBox error={server.error} onRetry={() => server.refetch()} />;
  } else {
    const p = server.data;
    body = <Final v={{ amount: p.amount, status: p.status, receiptId: p.receipt?.id ?? null, receiptNumber: p.receipt?.receiptNumber ?? null, snapshot: p.receipt?.snapshot ?? null }} flags={[]} />;
  }

  return (
    <Screen>
      {body}
      <Button testID="done" title={t('done')} variant="secondary" onPress={() => router.dismissTo('/customers')} />
    </Screen>
  );
}
