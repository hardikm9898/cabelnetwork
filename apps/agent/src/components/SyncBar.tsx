import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { formatDateIN, businessDateOf } from '@cablenet/domain';
import { useApp } from '../lib/app-state';
import { useOffline } from '../lib/offline';
import { isStale } from '../lib/offline/view';
import { istTime } from '../lib/share';
import { C, T } from './ui';

/** "12:05" today, otherwise "18-11-2026 18:05" (India time). */
export function when(iso: string | null | undefined, now = new Date()) {
  if (!iso) return '';
  const d = new Date(iso);
  return businessDateOf(d) === businessDateOf(now) ? istTime(d) : `${formatDateIN(businessDateOf(d))} ${istTime(d)}`;
}

/** Current time that updates every minute, so time-based warnings appear without other changes. */
export function useNow(everyMs = 60_000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

/** Sync state in one line (tap → sync center) plus the "out of date" warning. */
export function SyncBar() {
  const { t, me } = useApp();
  const { store, engine, status } = useOffline();
  const header = store.getHeader();
  const ops = store.getOps();
  const waiting = ops.filter((o) => o.state === 'PENDING' && o.userId === me?.id).length;
  const attention = ops.filter((o) => o.state === 'REJECTED' && !o.acknowledgedAt && o.userId === me?.id).length;
  const now = useNow();
  const stale = isStale(header, now);
  const last = status.lastSyncAt ?? header?.pulledAt ?? null;

  return (
    <View>
      {stale && (
        <View testID="stale-banner" accessibilityRole="alert" style={{ backgroundColor: C.warningSoft, padding: 10, borderBottomWidth: 1, borderColor: '#fedf89' }}>
          <T style={{ color: C.warning, fontWeight: '600' }}>
            {t('staleData')} {when(header?.pulledAt)}
          </T>
        </View>
      )}
      <Pressable
        testID="sync-bar"
        accessibilityRole="button"
        accessibilityLabel={t('sync')}
        onPress={() => router.push('/sync')}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 8, backgroundColor: attention ? C.dangerSoft : '#fff', borderBottomWidth: 1, borderColor: C.line }}
      >
        <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: attention ? C.danger : waiting ? C.warning : C.success }} />
        <T size={13} style={{ flex: 1 }} testID="sync-status">
          {status.running
            ? t('syncing')
            : attention
              ? `${t('needsAttention')}: ${attention}`
              : waiting
                ? `${t('waitingToSend')}: ${waiting}`
                : t('allSent')}
          {!status.running && last ? ` · ${t('lastSynced')} ${when(last)}` : ''}
        </T>
        <Pressable testID="sync-now" accessibilityRole="button" onPress={() => void engine.sync()} hitSlop={10} disabled={status.running}>
          <T size={13} weight="700" style={{ color: C.brand }}>
            {t('syncNow')}
          </T>
        </Pressable>
      </Pressable>
    </View>
  );
}
