import { createContext, ReactNode, useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { AppState as RNAppState, Text, View } from 'react-native';
import type { SyncCustomer, SyncPullResponse, SyncPushRequest, SyncPushResponse, VisitOpPayload } from '@cablenet/contracts';
import { api, newId } from '../api';
import * as actions from './actions';
import { openKV } from './kv-open';
import { LocalStore, OutboxOp } from './store';
import { SyncEngine, Transport } from './sync-engine';

export type { OutboxOp, SnapshotHeader } from './store';

const transport: Transport = {
  pull: (etag?: string) => api<SyncPullResponse>('GET', '/sync/pull', { query: { etag } }),
  push: (body: SyncPushRequest) => api<SyncPushResponse>('POST', '/sync/push', { body }),
};

/** Signed-in agent; entries are tagged with it and only its own are sent. */
let actor: actions.Actor | null = null;
export function setActor(a: actions.Actor | null) {
  actor = a;
}

let opening: Promise<{ store: LocalStore; engine: SyncEngine }> | null = null;

/** Opens the local database once per app run. */
export function openOffline() {
  opening ??= (async () => {
    const store = new LocalStore(await openKV());
    await store.load();
    const engine = new SyncEngine(store, transport, () => actor?.userId ?? null);
    return { store, engine };
  })();
  return opening;
}

/** Sign-out / session ended: customer data leaves the phone, unsent entries stay. */
export async function clearCustomerData() {
  const { store } = await openOffline();
  await store.clearSnapshot();
}

const Ctx = createContext<{ store: LocalStore; engine: SyncEngine } | null>(null);

export function OfflineProvider({ children, fallback }: { children: ReactNode; fallback: ReactNode }) {
  const [value, setValue] = useState<{ store: LocalStore; engine: SyncEngine } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    openOffline().then(setValue, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  if (error) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', padding: 24 }}>
        <Text style={{ fontSize: 16 }}>The phone storage could not be opened: {error}</Text>
      </View>
    );
  }
  if (!value) return <>{fallback}</>;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Read-only view of the local data at one version. */
export type StoreView = Pick<LocalStore, 'getHeader' | 'getCustomers' | 'getCustomer' | 'getOps' | 'getOp' | 'getCounters' | 'kv'> & {
  version: number;
  /** Entries of the signed-in agent still waiting to be sent. */
  pending: () => OutboxOp[];
};

/**
 * Re-renders on every change to local data or sync status. `store` is a new object for every
 * data version, so values derived from it are recomputed (the React Compiler memoizes on
 * object identity, and the underlying store object never changes).
 */
export function useOffline() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useOffline outside OfflineProvider');
  const version = useSyncExternalStore(ctx.store.subscribe, ctx.store.getVersion);
  const status = useSyncExternalStore(ctx.engine.subscribe, ctx.engine.getStatus);
  const store = useMemo<StoreView>(() => {
    const s = ctx.store;
    return {
      version,
      kv: s.kv,
      getHeader: () => s.getHeader(),
      getCustomers: () => s.getCustomers(),
      getCustomer: (id: string) => s.getCustomer(id),
      getOps: () => s.getOps(),
      getOp: (id: string) => s.getOp(id),
      getCounters: () => s.getCounters(),
      pending: () => ctx.engine.pending(),
    };
  }, [ctx, version]);
  return { store, engine: ctx.engine, status };
}

const FIFTEEN_MIN = 15 * 60_000;

/**
 * Sync triggers: sign-in/unlock, connection back, app back in front, every 15 minutes, and
 * shortly after any new entry (with back-off after failures).
 */
export function useAutoSync(enabled: boolean, online: boolean) {
  const { engine } = useOffline();
  useEffect(() => {
    if (enabled && online) void engine.sync();
  }, [enabled, online, engine]);
  useEffect(() => {
    if (!enabled) return;
    const sub = RNAppState.addEventListener('change', (s) => {
      if (s === 'active' && engine.due()) void engine.sync();
    });
    const timer = setInterval(() => {
      const last = engine.getStatus().lastSyncAt;
      const old = !last || Date.now() - new Date(last).getTime() > FIFTEEN_MIN;
      if (engine.due() && (engine.pending().length > 0 || old)) void engine.sync();
    }, 10_000);
    return () => {
      sub.remove();
      clearInterval(timer);
    };
  }, [enabled, engine]);
}

function requireActor() {
  if (!actor) throw new Error('Not signed in');
  return actor;
}

/** Saving always goes to the phone first, then to the server as soon as possible. */
export function useActions(online: boolean) {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useActions outside OfflineProvider');
  const { store, engine } = ctx;
  return useMemo(
    () => ({
      recordPayment: async (customer: SyncCustomer, p: { amount: string; mode: 'CASH' | 'UPI' | 'OTHER'; reference: string | null; notes: string | null }) => {
        const op = await actions.recordPayment(store, requireActor(), { customer, ...p, offline: !online, now: new Date(), newId });
        if (online) void engine.sync();
        return op;
      },
      recordVisit: async (customer: SyncCustomer, visit: Omit<VisitOpPayload, 'customerId'>) => {
        const op = await actions.recordVisit(store, requireActor(), { customer, visit, offline: !online, now: new Date(), newId });
        if (online) void engine.sync();
        return op;
      },
      completeFollowUp: async (followUpId: string, customer: SyncCustomer | null) => {
        const op = await actions.completeFollowUp(store, requireActor(), { followUpId, customer, offline: !online, now: new Date(), newId });
        if (online) void engine.sync();
        return op;
      },
      cancelPayment: async (customer: SyncCustomer, p: { paymentOpId: string | null; paymentId: string | null; amount: string; reason: string }) => {
        const op = await actions.cancelPayment(store, requireActor(), { customer, ...p, offline: !online, now: new Date(), newId });
        if (online) void engine.sync();
        return op;
      },
      acknowledge: (opId: string) => actions.acknowledge(store, opId, new Date()),
      syncNow: () => engine.sync(),
    }),
    [store, engine, online],
  );
}
