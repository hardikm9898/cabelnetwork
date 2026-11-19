import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { formatDateIN } from '@cablenet/domain';
import { api, newId } from '../lib/api';
import { useApp } from '../lib/app-state';
import { useOffline } from '../lib/offline';
import { Badge, Button, C, Card, ErrorBox, Field, Loading, Money, Row, Screen, T, useOnline } from '../components/ui';

interface CashSummary {
  cashInHand: string;
  cashNotYetHandedOver: string;
  paymentsNotYetHandedOver: number;
  pendingHandoverAmount: string;
  day: { cashCollected: string; upiCollected: string };
}
interface Handover {
  id: string;
  handoverNumber: string;
  submittedAt: string;
  expectedAmount: string;
  declaredAmount: string;
  receivedAmount: string | null;
  difference: string | null;
  status: string;
}

export default function Cash() {
  const { t } = useApp();
  const online = useOnline();
  const qc = useQueryClient();
  const { store, engine } = useOffline();
  const summary = useQuery({ queryKey: ['cash-me'], queryFn: () => api<CashSummary>('GET', '/cash/me'), enabled: online });
  const history = useQuery({ queryKey: ['handovers-mine'], queryFn: () => api<Handover[]>('GET', '/cash/handovers', { query: { pageSize: 20 } }), enabled: online });
  const [declared, setDeclared] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState<string | null>(null);
  const key = useRef(newId());
  const s = summary.data;
  const waiting = history.data?.find((h) => h.status === 'SUBMITTED');

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      // Payments still on the phone must reach the office first, or they would be missing from the count.
      if (engine.pending().length > 0) {
        await engine.sync();
        if (engine.pending().length > 0) throw new Error(`${t('waitingToSend')}: ${engine.pending().length}`);
        await qc.invalidateQueries();
        setBusy(false);
        return;
      }
      await api('POST', '/cash/handovers', { body: { declaredAmount: declared }, idempotencyKey: key.current });
      key.current = newId();
      setDeclared('');
      setMessage(t('handoverSubmitted'));
      await qc.invalidateQueries();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  if (!online) {
    const day = store.getHeader()?.day;
    return (
      <Screen>
        <Card>
          <T muted>{t('cashInHand')}</T>
          <Money value={day?.cashInHand ?? '0.00'} size={26} weight="800" />
        </Card>
        <T style={{ color: C.warning }} testID="handover-offline">
          {t('handoverNeedsInternet')}
        </T>
      </Screen>
    );
  }
  if (summary.isLoading) return <Loading />;
  return (
    <Screen>
      <ErrorBox error={summary.error} onRetry={() => summary.refetch()} />
      {s && (
        <Card>
          <Row>
            <T muted>{t('cashInHand')}</T>
            <Money value={s.cashInHand} size={24} weight="800" />
          </Row>
          <Row>
            <T muted>{t('cashToHandOver')}</T>
            <T testID="cash-to-hand-over" weight="700">
              <Money value={s.cashNotYetHandedOver} /> · {s.paymentsNotYetHandedOver} {t('payments')}
            </T>
          </Row>
          <Row>
            <T muted size={13}>
              {t('today')}: {t('cash')} / {t('upi')}
            </T>
            <T size={13}>
              <Money value={s.day.cashCollected} size={13} /> / <Money value={s.day.upiCollected} size={13} />
            </T>
          </Row>
        </Card>
      )}
      {message && <T style={{ color: C.success }}>{message}</T>}
      {waiting ? (
        <Card style={{ backgroundColor: C.warningSoft, borderColor: 'transparent' }}>
          <T weight="700" style={{ color: C.warning }}>
            {t('handoverWaiting')}
          </T>
          <T>
            {waiting.handoverNumber} · <Money value={waiting.declaredAmount} />
          </T>
        </Card>
      ) : s && s.paymentsNotYetHandedOver > 0 ? (
        <>
          <T>{t('handoverIntro')}</T>
          <Field
            testID="declared"
            label={t('amountGiven')}
            value={declared}
            onChangeText={(v) => setDeclared(v.replace(/[^\d.]/g, ''))}
            keyboardType="decimal-pad"
            placeholder={s.cashNotYetHandedOver}
          />
          <Button title={`${t('fullAmount')}: ${s.cashNotYetHandedOver}`} variant="secondary" onPress={() => setDeclared(s.cashNotYetHandedOver)} />
          <ErrorBox error={error} />
          <Button testID="submit-handover" title={t('submitHandover')} busy={busy} disabled={!declared || !online} onPress={submit} />
        </>
      ) : (
        <T muted>{t('nothingToHandOver')}</T>
      )}

      <T weight="700">{t('history')}</T>
      {history.data?.map((h) => (
        <Card key={h.id}>
          <Row>
            <T weight="600">{h.handoverNumber}</T>
            <Badge tone={h.status === 'CONFIRMED' ? (h.difference && h.difference !== '0.00' ? 'warn' : 'good') : h.status === 'REJECTED' ? 'bad' : 'info'} text={h.status.toLowerCase()} />
          </Row>
          <Row>
            <T muted size={13}>
              {formatDateIN(h.submittedAt.slice(0, 10))}
            </T>
            <Money value={h.receivedAmount ?? h.declaredAmount} />
          </Row>
          {h.difference && h.difference !== '0.00' && (
            <T size={13} style={{ color: C.danger }}>
              <Money value={h.difference} size={13} color={C.danger} />
            </T>
          )}
        </Card>
      ))}
    </Screen>
  );
}
