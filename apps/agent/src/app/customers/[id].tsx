import * as Linking from 'expo-linking';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { businessDateOf, formatDateIN, formatInr } from '@cablenet/domain';
import type { SyncPayment } from '@cablenet/contracts';
import { useApp } from '../../lib/app-state';
import { OutboxOp, useOffline } from '../../lib/offline';
import { buildList, deletedPayments, notInSnapshot } from '../../lib/offline/view';
import { mapsUrl, telUrl } from '../../lib/share';
import { openExternal } from '../../lib/open';
import { Badge, Button, C, Card, Money, Row, Screen, T } from '../../components/ui';
import { when } from '../../components/SyncBar';
import { OpStateBadge, outcomeKey } from '../../components/OpState';
import { MonthGrid } from '../../components/MonthGrid';

/** One labelled value in the details card; long-press friendly, selectable text. */
function Detail({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <View style={{ flexDirection: 'row', gap: 8, paddingVertical: 3 }}>
      <T muted size={14} style={{ width: 110 }}>
        {label}
      </T>
      <Text selectable style={{ flex: 1, fontSize: 15, color: C.ink, fontWeight: '600' }}>
        {value}
      </Text>
    </View>
  );
}

function SmallAction({ title, onPress, tone = 'neutral', testID }: { title: string; onPress: () => void; tone?: 'neutral' | 'danger'; testID?: string }) {
  return (
    <Pressable testID={testID} onPress={onPress} accessibilityRole="button" hitSlop={8} style={({ pressed }) => ({ paddingVertical: 6, paddingHorizontal: 10, borderRadius: 10, borderWidth: 1, borderColor: tone === 'danger' ? '#fecdca' : C.line, backgroundColor: tone === 'danger' ? C.dangerSoft : C.surface, opacity: pressed ? 0.7 : 1 })}>
      <Text style={{ color: tone === 'danger' ? C.danger : C.ink, fontWeight: '700', fontSize: 13 }}>{title}</Text>
    </Pressable>
  );
}

export default function CustomerScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useApp();
  const { store } = useOffline();
  const header = store.getHeader();
  const raw = store.getCustomer(id);
  const c = raw && header ? buildList([raw], header, store.getOps(), header.followUps, new Date())[0] : undefined;
  if (!c) {
    return (
      <Screen>
        <T>{t('notInList')}</T>
      </Screen>
    );
  }
  const ops = store.getOps();
  const deleted = deletedPayments(ops);
  // Payments made on this phone that the downloaded list does not show yet.
  const localPays = notInSnapshot(ops, header)
    .filter((o) => o.type === 'PAYMENT_CREATE' && o.label.customerId === c.id)
    .reverse();
  const mine = ops
    .filter((o) => o.label.customerId === c.id && (o.type === 'VISIT_CREATE' || o.type === 'PAYMENT_CANCEL') && (o.state === 'PENDING' || (o.syncedAt ?? '') > header!.pulledAt))
    .reverse()
    .slice(0, 5);
  const today = businessDateOf(new Date());
  const modeText = (m: string) => (m === 'CASH' ? t('cash') : m === 'UPI' ? t('upi') : t('other'));
  const askDelete = (p: { paymentOpId: string | null; paymentId: string | null; amount: string; date: string; mode: string }) =>
    router.push({ pathname: '/delete-payment', params: { customerId: c.id, paymentOpId: p.paymentOpId ?? '', paymentId: p.paymentId ?? '', amount: p.amount, date: p.date, mode: p.mode } });

  const serverRow = (p: SyncPayment) => {
    const gone = p.status === 'REVERSED' || p.status === 'FAILED';
    const deletedHere = !gone && (deleted.has(p.id) || (!!p.clientTxnId && deleted.has(p.clientTxnId)));
    return (
      <View key={p.id} testID="payment-row" style={{ paddingVertical: 8, borderTopWidth: 1, borderColor: C.line, gap: 4 }}>
        <Row>
          <T size={14} style={{ flex: 1, textDecorationLine: gone || deletedHere ? 'line-through' : 'none' }}>
            {formatDateIN(p.paymentDate)} · {modeText(p.mode)}
            {p.receiptNumber ? ` · ${p.receiptNumber}` : ''}
          </T>
          <Money value={p.amount} size={15} color={gone || deletedHere ? C.muted : C.ink} />
        </Row>
        <Row>
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', flex: 1 }}>
            {gone && <Badge tone="bad" text={t('deleted')} />}
            {deletedHere && <Badge tone="warn" text={t('deletedNotSent')} />}
            {p.status === 'PENDING_VERIFICATION' && !deletedHere && <Badge tone="warn" text={t('pendingCheck')} />}
            {p.collectedByName && (
              <T muted size={12}>
                {p.collectedByName}
              </T>
            )}
          </View>
          {p.canDelete && !deletedHere && (
            <SmallAction testID="delete-payment" tone="danger" title={t('deleteConfirm')} onPress={() => askDelete({ paymentOpId: null, paymentId: p.id, amount: p.amount, date: p.paymentDate, mode: p.mode })} />
          )}
        </Row>
        {p.note && (
          <T muted size={12}>
            {p.note}
          </T>
        )}
      </View>
    );
  };

  const localRow = (o: OutboxOp) => {
    const isDeleted = deleted.has(o.opId);
    const amount = String(o.payload.amount);
    const mode = String(o.payload.mode);
    return (
      <View key={o.opId} testID="payment-row-local" style={{ paddingVertical: 8, borderTopWidth: 1, borderColor: C.line, gap: 4 }}>
        <Pressable onPress={() => router.push({ pathname: '/receipt/[id]', params: { id: o.opId } })}>
          <Row>
            <T size={14} style={{ flex: 1, textDecorationLine: isDeleted ? 'line-through' : 'none' }}>
              {when(o.createdAt)} · {modeText(mode)}
              {o.label.provisionalRef ? ` · ${o.label.provisionalRef}` : ''}
            </T>
            <Money value={amount} size={15} color={isDeleted ? C.muted : C.ink} />
          </Row>
        </Pressable>
        <Row>
          <View style={{ flexDirection: 'row', gap: 6, flex: 1 }}>{isDeleted ? <Badge tone="bad" text={t('deleted')} /> : <OpStateBadge op={o} />}</View>
          {!isDeleted && o.state !== 'REJECTED' && (
            <SmallAction testID="delete-payment" tone="danger" title={t('deleteConfirm')} onPress={() => askDelete({ paymentOpId: o.opId, paymentId: null, amount, date: businessDateOf(new Date(o.createdAt)), mode })} />
          )}
        </Row>
      </View>
    );
  };

  return (
    <Screen>
      <Stack.Screen
        options={{
          title: c.customerCode,
          headerRight: () => (
            <Pressable testID="edit-customer" onPress={() => router.push({ pathname: '/edit-customer/[id]', params: { id: c.id } })} hitSlop={10} accessibilityRole="button">
              <Text style={{ color: '#fff', fontWeight: '700', fontSize: 16 }}>✎ {t('edit')}</Text>
            </Pressable>
          ),
        }}
      />
      <Card>
        <T size={21} weight="800">
          {c.name}
        </T>
        <T muted>
          {c.addressLine}
          {c.landmark ? ` (${c.landmark})` : ''} · {c.society}
        </T>
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
          <Badge tone="info" text={`ID ${c.customerCode}`} />
          {c.monthlyRate && <Badge tone="good" text={`${formatInr(c.monthlyRate)}${t('perMonth')}`} />}
          {c.upcomingRate && <Badge tone="info" text={`${formatInr(c.upcomingRate.monthlyRate)}${t('perMonth')} ${t('fromDate')} ${formatDateIN(c.upcomingRate.from)}`} />}
          {c.status !== 'ACTIVE' && <Badge tone="warn" text={c.status.toLowerCase()} />}
          {c.assignment === 'TEMPORARY' && <Badge tone="info" text={t('temporary')} />}
        </View>
        <Row style={{ gap: 10 }}>
          {c.mobile && (
            <View style={{ flex: 1 }}>
              <Button title={`📞 ${c.mobile}`} variant="secondary" onPress={() => Linking.openURL(telUrl(c.mobile!))} />
            </View>
          )}
          <View style={{ flex: 1 }}>
            <Button title={`📍 ${t('directions')}`} variant="secondary" onPress={() => openExternal(mapsUrl(c.addressLine, c.society))} />
          </View>
        </Row>
      </Card>

      <Card style={{ backgroundColor: c.outstanding !== '0.00' ? C.dangerSoft : C.successSoft, borderColor: 'transparent' }}>
        {c.outstanding !== '0.00' ? (
          <>
            <T muted>{t('due')}</T>
            <View testID="customer-due">
              <Money value={c.outstanding} size={30} color={C.danger} weight="800" />
            </View>
            {c.oldestDueDate && (
              <T size={13} style={{ color: C.danger }}>
                {t('filterOverdue')}: {formatDateIN(c.oldestDueDate)}
              </T>
            )}
            {c.openInvoices.map((i) => (
              <Row key={i.id}>
                <T size={14}>{i.label === 'Previous balance' ? t('previousBalance') : i.label}</T>
                <Money value={i.balance} size={14} />
              </Row>
            ))}
          </>
        ) : (
          <>
            <T muted>{c.advance !== '0.00' ? t('advance') : t('settled')}</T>
            <Money value={c.advance !== '0.00' ? c.advance : '0'} size={26} color={C.success} weight="800" />
          </>
        )}
        {c.pendingVerification !== '0.00' && (
          <Row>
            <T size={13} style={{ color: C.warning }}>
              {t('pendingCheck')}
            </T>
            <Money value={c.pendingVerification} size={13} color={C.warning} />
          </Row>
        )}
        {c.unsentAmount && (
          <Row>
            <T size={13} style={{ color: C.warning }} testID="customer-unsent">
              {c.waitingToSend ? t('unsentCollected') : t('sentToOffice')}
            </T>
            <Money value={c.unsentAmount} size={13} color={C.warning} />
          </Row>
        )}
        <T muted size={12}>
          {t('updated')} {when(header!.pulledAt)}
        </T>
      </Card>

      <Button testID="collect" title={`₹  ${t('collectPayment')}`} onPress={() => router.push({ pathname: '/collect/[id]', params: { id: c.id } })} />
      <Row style={{ gap: 10 }}>
        <View style={{ flex: 1 }}>
          <Button title={t('recordVisit')} variant="secondary" onPress={() => router.push({ pathname: '/visit/[id]', params: { id: c.id } })} />
        </View>
        <View style={{ flex: 1 }}>
          <Button testID="edit-customer-button" title={`✎ ${t('edit')}`} variant="secondary" onPress={() => router.push({ pathname: '/edit-customer/[id]', params: { id: c.id } })} />
        </View>
      </Row>

      <MonthGrid bills={c.bills ?? []} today={today} />

      <Card>
        <T weight="700">{t('details')}</T>
        <Detail label={t('customerId')} value={c.customerCode} />
        <Detail
          label={t('monthlyCharge')}
          value={
            [c.monthlyRate ? `${formatInr(c.monthlyRate)}${t('perMonth')}` : null, c.upcomingRate ? `${formatInr(c.upcomingRate.monthlyRate)}${t('perMonth')} ${t('fromDate')} ${formatDateIN(c.upcomingRate.from)}` : null]
              .filter(Boolean)
              .join(' → ') || null
          }
        />
        <Detail label={t('stbNumber')} value={(c.stbNumbers ?? []).join(', ')} />
        <Detail label={t('mqNumber')} value={(c.mqNumbers ?? []).join(', ')} />
        <Detail label={t('mobile')} value={c.mobile} />
        <Detail label={t('otherMobile')} value={c.altMobile} />
        <Detail label={t('address')} value={c.addressLine} />
        <Detail label={t('landmark')} value={c.landmark} />
        <Detail label={t('sortSociety')} value={c.society} />
        <Detail label={t('customerNotes')} value={c.notes} />
      </Card>

      <Card>
        <T weight="700">{t('recentPayments')}</T>
        {localPays.length === 0 && c.recentPayments.length === 0 && <T muted>{t('nothingHere')}</T>}
        {localPays.map(localRow)}
        {c.recentPayments.map(serverRow)}
      </Card>

      {mine.length > 0 && (
        <Card>
          <T weight="700">{t('sync')}</T>
          {mine.map((o) => (
            <Row key={o.opId}>
              <T size={14} style={{ flex: 1 }}>
                {when(o.createdAt)} · {o.type === 'PAYMENT_CANCEL' ? t('typePaymentDeleted') : t(outcomeKey[String(o.payload.outcome)] ?? 'typeVisit')}
              </T>
              {o.label.amount && <Money value={o.label.amount} size={14} />}
              <OpStateBadge op={o} />
            </Row>
          ))}
          {mine.some((o) => o.type === 'PAYMENT_CANCEL' && o.state === 'REJECTED') && (
            <T size={13} style={{ color: C.danger }}>
              {mine.find((o) => o.type === 'PAYMENT_CANCEL' && o.state === 'REJECTED')?.error?.message}
            </T>
          )}
        </Card>
      )}

      <Card>
        <T weight="700">{t('recentVisits')}</T>
        {c.recentVisits.length === 0 && <T muted>{t('nothingHere')}</T>}
        {c.recentVisits.map((v) => (
          <View key={v.id}>
            <T size={14}>
              {formatDateIN(v.visitedAt.slice(0, 10))} · {t(outcomeKey[v.outcome] ?? 'outcomeOther')}
            </T>
            {v.notes && <T muted size={13}>{v.notes}</T>}
          </View>
        ))}
      </Card>
    </Screen>
  );
}
