import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { formatInr, toPaise } from '@cablenet/domain';
import { api, ApiError } from '../../lib/api';
import { useApp } from '../../lib/app-state';
import { useOffline } from '../../lib/offline';
import { Button, C, Card, ErrorBox, Field, Screen, T, useOnline } from '../../components/ui';

interface Warning {
  code: string;
  message: string;
}

/**
 * Edit everything about one of the agent's customers: name, mobiles, address, Customer ID, set-top
 * box / MQ number, notes and the monthly charge. Saved straight to the office (needs internet) so
 * mistakes such as a box already used elsewhere are reported at once.
 */
export default function EditCustomer() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useApp();
  const online = useOnline();
  const { store, engine } = useOffline();
  const c = store.getCustomer(id);

  const initial = {
    name: c?.name ?? '',
    customerCode: c?.customerCode ?? '',
    mobile: c?.mobile ?? '',
    altMobile: c?.altMobile ?? '',
    addressLine: c?.addressLine ?? '',
    landmark: c?.landmark ?? '',
    stbNumber: c?.stbNumbers?.[0] ?? '',
    mqNumber: c?.mqNumbers?.[0] ?? '',
    notes: c?.notes ?? '',
  };
  const [f, setF] = useState(initial);
  // The charge that will be billed next: an upcoming one if set, else the current one.
  const latestRate = c?.upcomingRate?.monthlyRate ?? c?.monthlyRate ?? null;
  const [rate, setRate] = useState(latestRate ? String(Number(latestRate)) : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [warnings, setWarnings] = useState<Warning[] | null>(null);

  if (!c) {
    return (
      <Screen>
        <T>{t('notInList')}</T>
      </Screen>
    );
  }
  const up = (k: keyof typeof f) => (v: string) => {
    setF((x) => ({ ...x, [k]: v }));
    setWarnings(null);
  };
  const changed = (Object.keys(f) as (keyof typeof f)[]).filter((k) => f[k].trim() !== initial[k].trim());
  const rateOk = /^\d{1,7}(\.\d{1,2})?$/.test(rate.trim());
  const rateChanged = rateOk && (!latestRate || toPaise(rate.trim()) !== toPaise(latestRate));
  const rateInvalid = rate.trim() !== '' && !rateOk;
  const nameMissing = f.name.trim().length === 0;
  const codeMissing = f.customerCode.trim().length === 0;
  const addressMissing = f.addressLine.trim().length === 0;
  const canSave = online && !busy && (changed.length > 0 || rateChanged) && !nameMissing && !codeMissing && !addressMissing && !rateInvalid;

  const save = async (acknowledge = false) => {
    setBusy(true);
    setError(null);
    try {
      if (changed.length > 0) {
        const body: Record<string, unknown> = { acknowledgeWarnings: acknowledge, reason: 'Changed by the agent in the app' };
        for (const k of changed) {
          const v = f[k].trim();
          if (k === 'name' || k === 'customerCode' || k === 'addressLine') body[k] = v;
          else if (k === 'stbNumber') body.stbNumber = v;
          else body[k] = v === '' ? null : v;
        }
        await api('PATCH', `/customers/${c.id}`, { body });
      }
      if (rateChanged) {
        await api('POST', `/customers/${c.id}/monthly-charge`, { body: { monthlyRate: rate.trim(), reason: 'Changed by the agent in the app' } });
      }
      await engine.sync();
      router.back();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CONFIRMATION_REQUIRED') {
        setWarnings(((e.details as { warnings?: Warning[] } | undefined)?.warnings ?? []) as Warning[]);
      } else {
        setError(e);
      }
      setBusy(false);
    }
  };

  return (
    <Screen>
      {!online && (
        <Card style={{ backgroundColor: C.warningSoft, borderColor: 'transparent' }}>
          <T style={{ color: C.warning, fontWeight: '600' }}>{t('editNeedsInternet')}</T>
        </Card>
      )}
      <Field testID="edit-name" label={t('fullName')} value={f.name} onChangeText={up('name')} error={nameMissing ? '!' : null} />
      <Field testID="edit-code" label={t('customerId')} value={f.customerCode} onChangeText={up('customerCode')} autoCapitalize="characters" error={codeMissing ? '!' : null} />
      <Field testID="edit-mobile" label={t('mobile')} value={f.mobile} onChangeText={up('mobile')} keyboardType="phone-pad" maxLength={14} />
      <Field label={t('otherMobile')} value={f.altMobile} onChangeText={up('altMobile')} keyboardType="phone-pad" maxLength={14} />
      <Field label={t('address')} value={f.addressLine} onChangeText={up('addressLine')} error={addressMissing ? '!' : null} />
      <Field label={t('landmark')} value={f.landmark} onChangeText={up('landmark')} />
      <Field testID="edit-stb" label={t('stbNumber')} value={f.stbNumber} onChangeText={up('stbNumber')} autoCapitalize="characters" hint={t('stbEmptyHint')} />
      <Field testID="edit-mq" label={t('mqNumber')} value={f.mqNumber} onChangeText={up('mqNumber')} />

      <Card style={{ backgroundColor: C.brandSoft, borderColor: '#99f6e4' }}>
        <Field
          testID="edit-rate"
          label={t('monthlyCharge')}
          value={rate}
          onChangeText={(v) => {
            const clean = v.replace(/[^\d.]/g, '');
            if (/^\d{0,7}(\.\d{0,2})?$/.test(clean)) setRate(clean);
          }}
          keyboardType="decimal-pad"
          placeholder="0"
          style={{ fontSize: 22, fontWeight: '700' }}
          error={rateInvalid ? '!' : null}
          hint={latestRate ? `${t('monthlyChargeHint')}${rateChanged ? `  ${formatInr(latestRate)} → ${formatInr(rate)}` : ''}` : t('noPlanHint')}
        />
      </Card>

      <Field label={t('customerNotes')} value={f.notes} onChangeText={up('notes')} multiline style={{ minHeight: 80, textAlignVertical: 'top', paddingTop: 12 }} />

      {warnings && (
        <Card style={{ backgroundColor: C.warningSoft, borderColor: 'transparent' }}>
          <T weight="700" style={{ color: C.warning }}>
            {t('checkWarnings')}
          </T>
          {warnings.map((w) => (
            <T key={w.code + w.message} size={14}>
              • {w.message}
            </T>
          ))}
          <Button title={t('saveAnyway')} onPress={() => void save(true)} busy={busy} />
        </Card>
      )}
      <ErrorBox error={error} />
      <View style={{ height: 4 }} />
      <Button testID="save-customer" title={t('saveChanges')} busy={busy} disabled={!canSave} onPress={() => void save(false)} />
    </Screen>
  );
}
