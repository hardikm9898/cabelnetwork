import { router } from 'expo-router';
import { RefreshControl, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { businessDateOf, toPaise } from '@cablenet/domain';
import { useApp } from '../lib/app-state';
import { useOffline } from '../lib/offline';
import { buildList, counts, unsentToday } from '../lib/offline/view';
import { Button, C, Card, Loading, Money, OfflineBanner, Row, T, useOnline } from '../components/ui';
import { SyncBar, useNow, when } from '../components/SyncBar';

function Stat({ label, value, money, tone }: { label: string; value: string | number; money?: boolean; tone?: string }) {
  return (
    <View style={{ flexBasis: '47%', flexGrow: 1, backgroundColor: '#fff', borderRadius: 14, borderWidth: 1, borderColor: C.line, padding: 12, gap: 4 }}>
      <T muted size={13}>
        {label}
      </T>
      {money ? <Money value={String(value)} size={18} color={tone} /> : <T size={20} weight="700" style={tone ? { color: tone } : undefined}>{value}</T>}
    </View>
  );
}

/** Progress bar width from two decimal strings, using exact paise (display only). */
const percent = (part: string, whole: string) => {
  const w = toPaise(whole);
  if (w <= 0n) return 0;
  return Math.min(100, Number((toPaise(part) * 100n) / w));
};

export default function Home() {
  const { t, me } = useApp();
  const online = useOnline();
  const { store, engine, status } = useOffline();
  const header = store.getHeader();
  const now = useNow();
  const items = header ? buildList(store.getCustomers(), header, store.getOps(), header.followUps, now) : [];
  const c = counts(items);
  const unsent = unsentToday(store.getOps(), header, now);
  const d = header?.day;
  // Day figures belong to the snapshot's date; yesterday's "collected today" is not today's.
  const sameDay = header?.today === businessDateOf(now);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.canvas }} edges={['bottom', 'left', 'right']}>
      <OfflineBanner />
      <SyncBar />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }} refreshControl={<RefreshControl refreshing={status.running} onRefresh={() => void engine.sync()} />}>
        <T size={20} weight="700">
          {t('hello')}, {me?.fullName ?? ''}
        </T>
        {!header ? (
          status.running ? (
            <Loading />
          ) : (
            <Card>
              <T>{online ? t('errorGeneric') : t('needsDownload')}</T>
              {online && <Button title={t('retry')} variant="secondary" onPress={() => void engine.sync()} />}
            </Card>
          )
        ) : (
          <>
            <Card>
              <Row>
                <T muted>{t('collectedToday')}</T>
                <T muted>{t('expectedToday')}</T>
              </Row>
              <Row>
                <View testID="collected-today">
                  <Money value={sameDay ? d!.collectedToday : '0.00'} size={26} color={C.success} weight="800" />
                </View>
                <Money value={d!.expectedToday} size={18} />
              </Row>
              <View style={{ height: 8, backgroundColor: '#e2e8f0', borderRadius: 4, overflow: 'hidden' }} accessibilityLabel="Progress">
                <View style={{ height: 8, backgroundColor: C.brand, width: `${sameDay ? percent(d!.collectedToday, d!.expectedToday) : 0}%` }} />
              </View>
              <Row>
                <T muted size={13}>
                  {t('remaining')}
                </T>
                <Money value={d!.remainingToday} />
              </Row>
              {unsent.count > 0 && (
                <Row>
                  <T size={13} style={{ color: C.warning }} testID="unsent-today">
                    {t('unsentCollected')} ({unsent.count})
                  </T>
                  <Money value={unsent.amount} size={14} color={C.warning} />
                </Row>
              )}
              <T muted size={12}>
                {t('updated')} {when(header.pulledAt, now)}
              </T>
            </Card>

            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
              <Stat label={t('assignedCustomers')} value={c.all} />
              <Stat label={t('paid')} value={c.paid} tone={C.success} />
              <Stat label={t('partlyPaid')} value={c.partial} tone={C.warning} />
              <Stat label={t('filterPending')} value={c.pending} />
              <Stat label={t('followUps')} value={c.follow_up} tone={c.follow_up ? C.warning : undefined} />
              <Stat label={t('cashInHand')} value={d!.cashInHand} money />
            </View>
          </>
        )}

        <View style={{ gap: 10 }}>
          <Button testID="go-list" title={t('todaysList')} onPress={() => router.push('/customers')} />
          <Row style={{ gap: 10 }}>
            <View style={{ flex: 1 }}>
              <Button title={t('followUps')} variant="secondary" onPress={() => router.push('/followups')} />
            </View>
            <View style={{ flex: 1 }}>
              <Button title={t('myCollections')} variant="secondary" onPress={() => router.push('/collections')} />
            </View>
          </Row>
          <Row style={{ gap: 10 }}>
            <View style={{ flex: 1 }}>
              <Button testID="go-cash" title={t('cashHandover')} variant="secondary" onPress={() => router.push('/cash')} />
            </View>
            <View style={{ flex: 1 }}>
              <Button title={t('profile')} variant="secondary" onPress={() => router.push('/profile')} />
            </View>
          </Row>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
