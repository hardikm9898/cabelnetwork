import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { addDays, businessDateOf, formatDateIN, isBusinessDate } from '@cablenet/domain';
import { useActions, useOffline } from '../../lib/offline';
import { useApp } from '../../lib/app-state';
import type { Key } from '../../lib/i18n';
import { isValidAmount } from '../../lib/share';
import { Button, C, Chips, ErrorBox, Field, Screen, T, useOnline } from '../../components/ui';

type Outcome = 'NOT_AVAILABLE' | 'REFUSED' | 'WILL_PAY_LATER' | 'ALREADY_PAID_ADMIN' | 'WRONG_ADDRESS' | 'SERVICE_DISCONTINUED' | 'OTHER';
const OUTCOMES: [Outcome, Key][] = [
  ['NOT_AVAILABLE', 'outcomeNotAvailable'],
  ['WILL_PAY_LATER', 'outcomeLater'],
  ['REFUSED', 'outcomeRefused'],
  ['ALREADY_PAID_ADMIN', 'outcomePaidAdmin'],
  ['WRONG_ADDRESS', 'outcomeWrongAddress'],
  ['SERVICE_DISCONTINUED', 'outcomeDiscontinued'],
  ['OTHER', 'outcomeOther'],
];

/** Visit without payment (payments record their own visit automatically). */
export default function Visit() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useApp();
  const online = useOnline();
  const { store } = useOffline();
  const act = useActions(online);
  const customer = store.getCustomer(id);
  const today = businessDateOf(new Date());
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [notes, setNotes] = useState('');
  const [promised, setPromised] = useState('');
  const [promiseDate, setPromiseDate] = useState('');
  const [followUp, setFollowUp] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const later = outcome === 'WILL_PAY_LATER';
  const quick: { value: string; label: string }[] = [
    { value: addDays(today, 1), label: t('tomorrow') },
    { value: addDays(today, 2), label: t('inTwoDays') },
    { value: addDays(today, 7), label: t('nextWeek') },
  ];
  const valid =
    !!outcome &&
    (outcome !== 'OTHER' || notes.trim().length > 0) &&
    (!later || !promised || (isValidAmount(promised) && isBusinessDate(promiseDate))) &&
    (!followUp || isBusinessDate(followUp));

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!customer || !outcome) return;
      await act.recordVisit(customer, {
        outcome,
        notes: notes.trim() || null,
        promisedAmount: later && promised ? promised : null,
        promisedDate: later && promised ? promiseDate : null,
        followUpDate: followUp || null,
      });
      router.back();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <T weight="700" size={17}>
        {t('outcome')}
      </T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        {OUTCOMES.map(([o, k]) => (
          <Pressable
            key={o}
            testID={`outcome-${o}`}
            accessibilityRole="button"
            accessibilityState={{ selected: outcome === o }}
            onPress={() => setOutcome(o)}
            style={{ flexBasis: '47%', flexGrow: 1, minHeight: 56, borderRadius: 14, borderWidth: 2, borderColor: outcome === o ? C.brand : C.line, backgroundColor: outcome === o ? C.brandSoft : '#fff', justifyContent: 'center', padding: 10 }}
          >
            <Text style={{ fontSize: 16, fontWeight: '600', color: C.ink, textAlign: 'center' }}>{t(k)}</Text>
          </Pressable>
        ))}
      </View>
      {later && (
        <>
          <Field label={t('promisedAmount')} value={promised} onChangeText={(v) => setPromised(v.replace(/[^\d.]/g, ''))} keyboardType="decimal-pad" />
          <T weight="600">{t('promisedBy')}</T>
          <Chips value={promiseDate || null} onChange={(v) => { setPromiseDate(v); if (!followUp) setFollowUp(v); }} options={quick} />
          {promiseDate ? <T muted>{formatDateIN(promiseDate)}</T> : null}
        </>
      )}
      <T weight="600">{t('followUpOn')}</T>
      <Chips value={followUp || null} onChange={setFollowUp} options={quick} />
      {followUp ? <T muted>{formatDateIN(followUp)}</T> : null}
      <Field label={t('notes')} value={notes} onChangeText={setNotes} multiline style={{ minHeight: 80, textAlignVertical: 'top' }} />
      <ErrorBox error={error} />
      <Button testID="save-visit" title={t('save')} busy={busy} disabled={!valid || !customer} onPress={save} />
    </Screen>
  );
}
