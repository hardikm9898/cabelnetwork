import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, login as apiLogin, Me, refreshSession, session } from './api';
import { Key, Lang, translate } from './i18n';
import { clearCustomerData, setActor } from './offline';
import { checkPin, clearPin, hasPin, savePin } from './pin';
import { KEYS, storage } from './storage';

/**
 * App session state machine:
 *   loading → anonymous (sign in) → [needsPassword: replace temporary password] → needsPin (set PIN) → ready
 *   cold start with a saved session → locked (PIN / fingerprint) → ready
 */
export type Status = 'loading' | 'anonymous' | 'needsPassword' | 'needsPin' | 'locked' | 'ready';

interface AppState {
  status: Status;
  me: Me | null;
  lang: Lang;
  t: (k: Key) => string;
  setLang: (l: Lang) => Promise<void>;
  signIn: (mobile: string, password: string) => Promise<void>;
  changePassword: (current: string, next: string) => Promise<void>;
  createPin: (pin: string) => Promise<void>;
  unlock: (pin: string) => Promise<'ok' | `wrong:${number}` | 'locked'>;
  unlockWithBiometrics: () => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AppState | null>(null);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [me, setMe] = useState<Me | null>(null);
  const [lang, setLangState] = useState<Lang>('en');
  const qc = useQueryClient();

  // Entries saved on the phone are tagged with the signed-in agent. Set synchronously with `me`
  // (not in an effect): child effects such as the first sync run before a parent's effects.
  const setUser = useCallback((user: Me | null) => {
    setActor(user && user.role === 'AGENT' ? { userId: user.id, agentCode: user.agentCode ?? 'AG' } : null);
    setMe(user);
  }, []);

  /** Customer data leaves the phone; entries not yet sent stay (they record money). */
  const forget = useCallback(async () => {
    await clearPin();
    await storage.remove(KEYS.me);
    await clearCustomerData().catch(() => undefined);
    qc.clear();
    setUser(null);
    setStatus('anonymous');
  }, [qc, setUser]);

  const signOut = useCallback(async () => {
    try {
      await api('POST', '/auth/logout');
    } catch {
      /* offline or already signed out */
    }
    await session.clear();
    await forget();
  }, [forget]);

  useEffect(() => {
    session.onEnd(() => void forget());
    void (async () => {
      const saved = (await storage.get(KEYS.lang)) as Lang | null;
      if (saved === 'gu' || saved === 'en') setLangState(saved);
      if (!(await session.hasRefresh())) return setStatus('anonymous');
      setStatus((await hasPin()) ? 'locked' : 'anonymous');
    })();
  }, [forget]);

  const remember = useCallback(
    async (user: Me) => {
      setUser(user);
      await storage.set(KEYS.me, JSON.stringify(user));
    },
    [setUser],
  );

  const loadMe = useCallback(async () => {
    const user = await api<Me>('GET', '/auth/me');
    await remember(user);
    return user;
  }, [remember]);

  const signIn = useCallback(
    async (mobile: string, password: string) => {
      const user = await apiLogin(mobile, password);
      if (user.role !== 'AGENT') {
        await session.clear();
        throw new Error('This app is for field agents. Office staff use the website.');
      }
      await remember(user);
      setStatus(user.mustChangePassword ? 'needsPassword' : 'needsPin');
    },
    [remember],
  );

  const changePassword = useCallback(async (current: string, next: string) => {
    await api('POST', '/auth/change-password', { body: { currentPassword: current, newPassword: next } });
    setMe((m) => (m ? { ...m, mustChangePassword: false } : m));
    // A forced change (temporary password) continues to PIN setup; a voluntary one stays where it is.
    setStatus((s) => (s === 'needsPassword' ? 'needsPin' : s));
  }, []);

  const createPin = useCallback(async (pin: string) => {
    await savePin(pin);
    setStatus('ready');
  }, []);

  const afterUnlock = useCallback(async () => {
    // Renew the session; offline the app opens with the data saved on the phone.
    await refreshSession();
    try {
      await loadMe();
    } catch {
      const saved = await storage.get(KEYS.me);
      if (saved) setUser(JSON.parse(saved) as Me);
    }
    setStatus('ready');
  }, [loadMe, setUser]);

  const unlock = useCallback(
    async (pin: string) => {
      const r = await checkPin(pin);
      if (r.result === 'ok') {
        await afterUnlock();
        return 'ok' as const;
      }
      if (r.result === 'locked') {
        await signOut();
        return 'locked' as const;
      }
      return `wrong:${r.left}` as const;
    },
    [afterUnlock, signOut],
  );

  const setLang = useCallback(async (l: Lang) => {
    setLangState(l);
    await storage.set(KEYS.lang, l);
  }, []);

  const value = useMemo<AppState>(
    () => ({
      status,
      me,
      lang,
      t: (k) => translate(lang, k),
      setLang,
      signIn,
      changePassword,
      createPin,
      unlock,
      unlockWithBiometrics: afterUnlock,
      signOut,
    }),
    [status, me, lang, setLang, signIn, changePassword, createPin, unlock, afterUnlock, signOut],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside AppStateProvider');
  return v;
}
