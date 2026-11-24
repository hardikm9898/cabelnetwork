import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { formatDateIN } from '@cablenet/domain';
import { useApp } from '../lib/app-state';
import type { Key } from '../lib/i18n';
import { useActions, useOffline } from '../lib/offline';
import { Button, C, Card, ErrorBox, Field, Money, Row, Screen, T, useOnline } from '../components/ui';

const REASONS: Key[] = ['reasonWrongCustomer', 'reasonWrongAmount', 'reasonTwice', 'reasonNotPaid', 'reasonOther'];
/** Sent to the office in English (the office site is in English). */
const REASON_EN: Partial<Record<Key, string>> = {
  reasonWrongCustomer: 'Wrong customer',
  reasonWrongAmount: 'Wrong amount',
  reasonTwice: 'Entered twice',
  reasonNotPaid: 'Customer did not pay',
};

/**
 * The agent deletes a payment entered by mistake. Works offline (sent in order after the payment
 * itself). The office sees the deletion with the reason; the receipt is cancelled.
 */
export default function DeletePayment() {
  const p = useLocalSearchParams<{ customerId: string; paymentOpId?: string; paymentId?: string; amount: string; date: string; mode: string }>();
  const { t } = useApp();
  const online = useOnline();
  const { store } = useOffline();
  const act = useActions(online);
  const customer = store.getCustomer(p.customerId);
  const [reason, setReason] = useState<Key | null>(null);
  const [other, setOther] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  if (!customer) {
    return (
      <Screen>
        <T>{t('notInList')}</T>
      </Screen>
    );
  }
  const text = reason === 'reasonOther' ? other.trim() : reason ? (REASON_EN[reason] ?? '') : '';
  const extra = reason && reason !== 'reasonOther' && other.trim() ? `${text}: ${other.trim()}` : text;
  const valid = extra.length >= 3;
  const modeText = p.mode === 'CASH' ? t('cash') : p.mode === 'UPI' ? t('upi') : t('other');

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await act.cancelPayment(customer, { paymentOpId: p.paymentOpId || null, paymentId: p.paymentId || null, amount: p.amount, reason: extra });
      router.back();
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Card style={{ backgroundColor: C.dangerSoft, borderColor: 'transparent', alignItems: 'center' }}>
        <T size={18} weight="800" style={{ color: C.danger }}>
          {t('deletePaymentTitle')}
        </T>
        <Money value={p.amount} size={30} weight="800" color={C.danger} />
        <T>
          {customer.name} · {customer.customerCode}
        </T>
        <T muted size={14}>
          {p.date ? formatDateIN(p.date) : ''} · {modeText}
        </T>
      </Card>

      <T weight="700">{t('deleteReason')}</T>
      <View style={{ gap: 8 }}>
        {REASONS.map((r) => {
          const active = reason === r;
          return (
            <Pressable
              key={r}
              testID={`reason-${r}`}
              accessibilityRole="radio"
              accessibilityState={{ selected: active }}
              onPress={() => setReason(r)}
              style={{ minHeight: 50, borderRadius: 12, borderWidth: active ? 2 : 1, borderColor: active ? C.danger : C.line, backgroundColor: active ? C.dangerSoft : C.surface, paddingHorizontal: 14, justifyContent: 'center' }}
            >
              <Row>
                <Text style={{ fontSize: 16, fontWeight: '600', color: C.ink }}>{t(r)}</Text>
                <Text style={{ fontSize: 18, color: active ? C.danger : C.line }}>{active ? '●' : '○'}</Text>
              </Row>
            </Pressable>
          );
        })}
      </View>
      {reason && (
        <Field
          testID="delete-reason-text"
          label={reason === 'reasonOther' ? t('writeReason') : t('notes')}
          value={other}
          onChangeText={setOther}
          autoFocus={reason === 'reasonOther'}
          maxLength={250}
        />
      )}
      <T size={13} style={{ color: C.warning }}>
        {t('deleteWarning')}
      </T>
      <ErrorBox error={error} />
      <Button testID="confirm-delete" title={`${t('deletePayment')}`} variant="danger" busy={busy} disabled={!valid} onPress={() => void confirm()} />
      <Button title={t('back')} variant="secondary" onPress={() => router.back()} />
    </Screen>
  );
}
