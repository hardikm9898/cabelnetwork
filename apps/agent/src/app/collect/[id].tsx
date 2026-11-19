import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { formatInr, toPaise } from '@cablenet/domain';
import { useApp } from '../../lib/app-state';
import { useActions, useOffline } from '../../lib/offline';
import { isValidAmount } from '../../lib/share';
import { Button, C, Card, Chips, ErrorBox, Field, Money, Row, Screen, T, useOnline } from '../../components/ui';

type Mode = 'CASH' | 'UPI' | 'OTHER';

/**
 * Fast payment entry: amount (one tap for "full due" / "1 month"), mode, save. The entry is saved
 * on the phone first, with its own id, and sent to the office at once when there is internet —
 * so a weak signal never loses or doubles a payment.
 */
export default function Collect() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useApp();
  const online = useOnline();
  const { store } = useOffline();
  const act = useActions(online);
  const customer = store.getCustomer(id);
  const maxAmount = store.getHeader()?.maxAmount ?? '100000.00';
  const [amount, setAmount] = useState('');
  const [mode, setMode] = useState<Mode>('CASH');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  if (!customer) {
    return (
      <Screen>
        <T>{t('notInList')}</T>
      </Screen>
    );
  }
  const due = customer.outstanding;
  const rate = customer.monthlyRate;
  const needsRef = mode !== 'CASH';
  const tooLarge = isValidAmount(amount) && toPaise(amount) > toPaise(maxAmount);
  const valid = isValidAmount(amount) && !tooLarge && (!needsRef || reference.trim().length >= 4);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const op = await act.recordPayment(customer, { amount, mode, reference: needsRef ? reference.trim() : null, notes: notes.trim() || null });
      router.replace({ pathname: '/receipt/[id]', params: { id: op.opId } });
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Card>
        <T size={18} weight="700">
          {customer.name}
        </T>
        <T muted>{customer.customerCode}</T>
        <Row>
          <T muted>{t('due')}</T>
          <Money value={due} size={22} color={due !== '0.00' ? C.danger : C.ink} weight="800" />
        </Row>
        {customer.advance !== '0.00' && (
          <Row>
            <T muted>{t('advance')}</T>
            <Money value={customer.advance} color={C.success} />
          </Row>
        )}
      </Card>

      <Field
        testID="amount"
        label={t('amount')}
        value={amount}
        onChangeText={(v) => {
          const clean = v.replace(/[^\d.]/g, '');
          if (/^\d{0,10}(\.\d{0,2})?$/.test(clean)) setAmount(clean);
        }}
        keyboardType="decimal-pad"
        style={{ fontSize: 28, fontWeight: '700' }}
        placeholder="0"
        autoFocus
        error={tooLarge ? `≤ ${formatInr(maxAmount)}` : null}
      />
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        {due !== '0.00' && <Button testID="amount-full" title={`${t('fullAmount')} ${formatInr(due)}`} variant="secondary" onPress={() => setAmount(due)} />}
        {rate && <Button title={`${t('oneMonth')} ${formatInr(rate)}`} variant="secondary" onPress={() => setAmount(rate)} />}
      </View>

      <T weight="600">{t('mode')}</T>
      <Chips<Mode>
        testIDPrefix="mode"
        value={mode}
        onChange={setMode}
        options={[
          { value: 'CASH', label: t('cash') },
          { value: 'UPI', label: t('upi') },
          { value: 'OTHER', label: t('other') },
        ]}
      />
      {needsRef && (
        <>
          <Field label={t('reference')} value={reference} onChangeText={setReference} autoCapitalize="characters" />
          <T size={13} style={{ color: C.warning }}>
            {t('upiPendingNote')}
          </T>
        </>
      )}
      <Field label={t('notes')} value={notes} onChangeText={setNotes} />
      <ErrorBox error={error} />
      <Button testID="save-payment" title={busy ? t('saving') : `${t('savePayment')}${isValidAmount(amount) ? ` ${formatInr(amount)}` : ''}`} busy={busy} disabled={!valid} onPress={save} />
    </Screen>
  );
}
