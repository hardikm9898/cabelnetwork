import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { FlatList, RefreshControl, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { formatDateIN } from '@cablenet/domain';
import { useApp } from '../../lib/app-state';
import { useOffline } from '../../lib/offline';
import { buildList, counts, FILTERS, Filter, ListItem, search, Sort, SORTS } from '../../lib/offline/view';
import { Badge, C, Card, Chips, Loading, Money, OfflineBanner, Row, T } from '../../components/ui';
import { SyncBar, useNow } from '../../components/SyncBar';

function StatusBadge({ item }: { item: ListItem }) {
  const { t } = useApp();
  switch (item.todayStatus) {
    case 'PAID':
      return <Badge tone="good" text={t('paid')} />;
    case 'PARTIAL':
      return <Badge tone="warn" text={t('partlyPaid')} />;
    case 'VISITED':
      return <Badge tone="info" text={item.lastVisitOutcome === 'NOT_AVAILABLE' ? t('notAvailable') : t('recordVisit')} />;
    case 'PENDING':
      return <Badge tone={item.overdue ? 'bad' : 'warn'} text={item.overdue ? t('filterOverdue') : t('filterPending')} />;
    default:
      return <Badge text={t('settled')} />;
  }
}

function ItemCard({ item }: { item: ListItem }) {
  const { t } = useApp();
  const owes = item.outstanding !== '0.00';
  return (
    <Card onPress={() => router.push({ pathname: '/customers/[id]', params: { id: item.id } })} accessibilityLabel={`${item.name}, ${item.customerCode}`}>
      <Row>
        <View style={{ flex: 1 }}>
          <T size={17} weight="700" numberOfLines={1}>
            {item.name}
          </T>
          <T muted size={13} numberOfLines={1}>
            {item.customerCode} · {item.society}
          </T>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          {owes ? <Money value={item.outstanding} size={18} color={C.danger} weight="800" /> : item.advance !== '0.00' ? <Money value={item.advance} color={C.success} /> : <T muted>{t('settled')}</T>}
        </View>
      </Row>
      <T muted size={13} numberOfLines={1}>
        {item.addressLine}
        {item.mobile ? ` · ${item.mobile}` : ''}
      </T>
      {item.unsentAmount && (
        <Row>
          <T size={13} style={{ color: C.warning }}>
            {item.waitingToSend ? t('unsentCollected') : t('sentToOffice')}
          </T>
          <Money value={item.unsentAmount} size={14} color={C.warning} />
        </Row>
      )}
      <Row>
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', flex: 1 }}>
          <StatusBadge item={item} />
          {item.assignment === 'TEMPORARY' && <Badge tone="info" text={t('temporary')} />}
          {item.followUpDue && <Badge tone="warn" text={t('followUps')} />}
        </View>
        <T muted size={12}>
          {item.overdue && item.nextDueDate
            ? `${t('dueSince')} ${formatDateIN(item.nextDueDate)}`
            : item.lastPaymentDate
              ? `${t('lastPaid')} ${formatDateIN(item.lastPaymentDate)}`
              : item.nextDueDate
                ? `${t('nextDue')} ${formatDateIN(item.nextDueDate)}`
                : ''}
        </T>
      </Row>
    </Card>
  );
}

export default function WorklistScreen() {
  const { t } = useApp();
  const { store, engine, status } = useOffline();
  const [filter, setFilter] = useState<Filter>('pending');
  const [sort, setSort] = useState<Sort>('outstanding');
  const [q, setQ] = useState('');
  const header = store.getHeader();
  const version = store.version;
  const now = useNow();

  const all = useMemo(
    () => (header ? buildList(store.getCustomers(), header, store.getOps(), header.followUps, now) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, version, header, now],
  );
  const c = counts(all);
  const items = useMemo(() => search(all.filter(FILTERS[filter]), q).sort(SORTS[sort]), [all, filter, q, sort]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.canvas }} edges={['bottom', 'left', 'right']}>
      <OfflineBanner />
      <SyncBar />
      <View style={{ padding: 12, gap: 10, backgroundColor: '#fff', borderBottomWidth: 1, borderColor: C.line }}>
        <TextInput
          testID="search"
          accessibilityLabel={t('search')}
          placeholder={t('search')}
          placeholderTextColor="#94a3b8"
          value={q}
          onChangeText={setQ}
          style={{ minHeight: 48, borderWidth: 1, borderColor: C.line, borderRadius: 12, paddingHorizontal: 14, fontSize: 16, color: C.ink }}
        />
        <Chips<Filter>
          testIDPrefix="filter"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'pending', label: t('filterPending'), count: c.pending },
            { value: 'due_today', label: t('filterDueToday'), count: c.due_today },
            { value: 'overdue', label: t('filterOverdue'), count: c.overdue },
            { value: 'partial', label: t('filterPartial'), count: c.partial },
            { value: 'paid', label: t('filterPaid'), count: c.paid },
            { value: 'follow_up', label: t('filterFollowUp'), count: c.follow_up },
            { value: 'all', label: t('filterAll'), count: c.all },
          ]}
        />
        <Chips<Sort>
          value={sort}
          onChange={setSort}
          options={[
            { value: 'outstanding', label: t('sortOutstanding') },
            { value: 'due_date', label: t('sortDueDate') },
            { value: 'society', label: t('sortSociety') },
            { value: 'name', label: t('sortName') },
            { value: 'last_visit', label: t('sortLastVisit') },
          ]}
        />
      </View>
      {!header && status.running ? (
        <Loading />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(i) => i.id}
          renderItem={({ item }) => <ItemCard item={item} />}
          contentContainerStyle={{ padding: 12, gap: 10 }}
          refreshControl={<RefreshControl refreshing={status.running} onRefresh={() => void engine.sync()} />}
          ListEmptyComponent={<T muted style={{ textAlign: 'center', padding: 24 }}>{header ? t('nothingHere') : t('needsDownload')}</T>}
        />
      )}
    </SafeAreaView>
  );
}
