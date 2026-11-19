import { router } from 'expo-router';
import { View } from 'react-native';
import { useApp } from '../lib/app-state';
import type { Key } from '../lib/i18n';
import { OutboxOp, useActions, useOffline } from '../lib/offline';
import { Button, C, Card, Money, Row, Screen, T, useOnline } from '../components/ui';
import { FLAG_TEXT, OpStateBadge, outcomeKey } from '../components/OpState';
import { when } from '../components/SyncBar';

function OpRow({ op }: { op: OutboxOp }) {
  const { t } = useApp();
  const what: Key = op.type === 'PAYMENT_CREATE' ? 'typePayment' : op.type === 'FOLLOWUP_DONE' ? 'typeFollowUp' : (outcomeKey[String(op.payload.outcome)] ?? 'typeVisit');
  return (
    <Card testID={`op-${op.state}`} onPress={op.type === 'PAYMENT_CREATE' ? () => router.push({ pathname: '/receipt/[id]', params: { id: op.opId } }) : undefined}>
      <Row>
        <T weight="600" numberOfLines={1} style={{ flex: 1 }}>
          {op.label.customerName ?? '—'}
        </T>
        {op.label.amount && <Money value={op.label.amount} />}
      </Row>
      <Row>
        <T muted size={13} style={{ flex: 1 }}>
          {t(what)} · {when(op.createdAt)}
          {op.label.provisionalRef ? ` · ${op.label.provisionalRef}` : ''}
        </T>
        <OpStateBadge op={op} />
      </Row>
      {op.flags.map((f) => (
        <T key={f} size={13} style={{ color: C.info }}>
          • {FLAG_TEXT[f] ? t(FLAG_TEXT[f]) : f}
        </T>
      ))}
      {op.error && (
        <T size={13} style={{ color: C.danger }}>
          {op.error.message}
        </T>
      )}
    </Card>
  );
}

/** Everything waiting to be sent, what the office flagged, and anything that was not accepted. */
export default function SyncCenter() {
  const { t, me } = useApp();
  const online = useOnline();
  const { store, engine, status } = useOffline();
  const act = useActions(online);
  const ops = store.getOps().reverse();
  const mine = ops.filter((o) => o.userId === me?.id);
  const attention = mine.filter((o) => o.state === 'REJECTED' && !o.acknowledgedAt);
  const waiting = mine.filter((o) => o.state === 'PENDING');
  const review = mine.filter((o) => o.state === 'NEEDS_REVIEW');
  const sent = mine.filter((o) => o.state === 'APPLIED').slice(0, 20);
  const others = ops.filter((o) => o.userId !== me?.id && o.state === 'PENDING').length;
  const storage = store.kv.info();

  return (
    <Screen>
      <Card>
        <Row>
          <T muted>{t('lastSynced')}</T>
          <T weight="700" testID="last-synced">
            {status.lastSyncAt ? when(status.lastSyncAt) : store.getHeader() ? when(store.getHeader()!.pulledAt) : t('neverSynced')}
          </T>
        </Row>
        <Row>
          <T muted>{t('waitingToSend')}</T>
          <T weight="700" testID="waiting-count">
            {waiting.length}
          </T>
        </Row>
        {status.lastError && !status.running && (
          <T size={13} style={{ color: C.warning }}>
            {online ? status.lastError : t('offline')}
          </T>
        )}
        <T size={13} style={{ color: storage.encrypted ? C.success : C.warning }} testID="storage-info">
          {storage.encrypted ? t('storageEncrypted') : t('storageNotEncrypted')}
        </T>
        <Button testID="sync-now-big" title={status.running ? t('syncing') : t('syncNow')} busy={status.running} disabled={!online} onPress={() => void engine.sync()} />
      </Card>

      {others > 0 && <T style={{ color: C.warning }}>{t('otherUserEntries')}</T>}

      {attention.length > 0 && (
        <View style={{ gap: 8 }}>
          <T weight="700" style={{ color: C.danger }}>
            {t('needsAttention')}
          </T>
          {attention.map((o) => (
            <View key={o.opId} style={{ gap: 6 }}>
              <OpRow op={o} />
              <Button testID="acknowledge" title={t('understood')} variant="secondary" onPress={() => void act.acknowledge(o.opId)} />
            </View>
          ))}
        </View>
      )}
      {waiting.length > 0 && <T weight="700">{t('waitingToSend')}</T>}
      {waiting.map((o) => (
        <OpRow key={o.opId} op={o} />
      ))}
      {review.length > 0 && <T weight="700">{t('officeWillCheck')}</T>}
      {review.map((o) => (
        <OpRow key={o.opId} op={o} />
      ))}
      {sent.length > 0 && <T weight="700">{t('sentToOffice')}</T>}
      {sent.map((o) => (
        <OpRow key={o.opId} op={o} />
      ))}
      {mine.length === 0 && <T muted style={{ textAlign: 'center', padding: 24 }}>{t('allSent')}</T>}
    </Screen>
  );
}
