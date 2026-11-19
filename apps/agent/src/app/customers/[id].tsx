import * as Linking from 'expo-linking';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';
import { formatDateIN } from '@cablenet/domain';
import { useApp } from '../../lib/app-state';
import { useOffline } from '../../lib/offline';
import { buildList } from '../../lib/offline/view';
import { mapsUrl, telUrl } from '../../lib/share';
import { openExternal } from '../../lib/open';
import { Badge, Button, C, Card, Money, Row, Screen, T } from '../../components/ui';
import { when } from '../../components/SyncBar';
import { OpStateBadge, outcomeKey } from '../../components/OpState';

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
  const mine = store
    .getOps()
    .filter((o) => o.label.customerId === c.id && (o.type === 'PAYMENT_CREATE' || o.type === 'VISIT_CREATE'))
    .reverse()
    .slice(0, 5);

  return (
    <Screen>
      <Stack.Screen options={{ title: c.customerCode }} />
      <Card>
        <T size={20} weight="800">
          {c.name}
        </T>
        <T muted>
          {c.addressLine}
          {c.landmark ? ` (${c.landmark})` : ''} · {c.society}
        </T>
        <View style={{ flexDirection: 'row', gap: 6 }}>
          {c.status !== 'ACTIVE' && <Badge tone="warn" text={c.status.toLowerCase()} />}
          {c.assignment === 'TEMPORARY' && <Badge tone="info" text={t('temporary')} />}
        </View>
        <Row style={{ gap: 10 }}>
          {c.mobile && (
            <View style={{ flex: 1 }}>
              <Button title={`${t('call')} ${c.mobile}`} variant="secondary" onPress={() => Linking.openURL(telUrl(c.mobile!))} />
            </View>
          )}
          <View style={{ flex: 1 }}>
            <Button title={t('directions')} variant="secondary" onPress={() => openExternal(mapsUrl(c.addressLine, c.society))} />
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
                <T size={14}>{i.label}</T>
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

      <Button testID="collect" title={t('collectPayment')} onPress={() => router.push({ pathname: '/collect/[id]', params: { id: c.id } })} />
      <Button title={t('recordVisit')} variant="secondary" onPress={() => router.push({ pathname: '/visit/[id]', params: { id: c.id } })} />

      {mine.length > 0 && (
        <Card>
          <T weight="700">{t('sync')}</T>
          {mine.map((o) => (
            <Row key={o.opId}>
              <T size={14} style={{ flex: 1 }}>
                {when(o.createdAt)} · {o.type === 'PAYMENT_CREATE' ? t('typePayment') : t(outcomeKey[String(o.payload.outcome)] ?? 'typeVisit')}
              </T>
              {o.label.amount && <Money value={o.label.amount} size={14} />}
              <OpStateBadge op={o} />
            </Row>
          ))}
        </Card>
      )}

      <Card>
        <T weight="700">{t('recentPayments')}</T>
        {c.recentPayments.length === 0 && <T muted>{t('nothingHere')}</T>}
        {c.recentPayments.map((p) => (
          <Row key={p.id}>
            <T size={14}>
              {formatDateIN(p.paymentDate)} · {p.mode === 'CASH' ? t('cash') : p.mode === 'UPI' ? t('upi') : t('other')}
              {p.status !== 'CONFIRMED' ? ` · ${p.status === 'PENDING_VERIFICATION' ? t('pendingCheck') : p.status.toLowerCase()}` : ''}
            </T>
            <Money value={p.amount} size={14} />
          </Row>
        ))}
      </Card>
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
