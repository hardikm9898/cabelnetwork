import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AuthTokens } from '@cablenet/contracts';
import { hasPermission, Permission, Role } from '@cablenet/domain';
import { api, ensureSession, session } from './api';

export interface Me {
  id: string;
  fullName: string;
  mobile: string;
  email: string | null;
  role: Role;
  mustChangePassword: boolean;
  agentCode: string | null;
}

interface AuthState {
  status: 'loading' | 'anonymous' | 'authenticated';
  me: Me | null;
  login: (mobile: string, password: string) => Promise<Me>;
  logout: () => Promise<void>;
  reload: () => Promise<void>;
  /** UI hint only — the API enforces every permission. */
  can: (p: Permission) => boolean;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthState['status']>('loading');
  const [me, setMe] = useState<Me | null>(null);
  const qc = useQueryClient();

  const reload = useCallback(async () => {
    try {
      if (!(await ensureSession())) throw new Error('no session');
      setMe(await api<Me>('GET', '/auth/me'));
      setStatus('authenticated');
    } catch {
      setMe(null);
      setStatus('anonymous');
    }
  }, []);

  useEffect(() => {
    void reload();
    return session.onEnd(() => {
      setMe(null);
      setStatus('anonymous');
      qc.clear();
    });
  }, [reload, qc]);

  const login = useCallback(async (mobile: string, password: string) => {
    const res = await api<AuthTokens & { user: Me }>('POST', '/auth/login', { body: { mobile, password } });
    session.setTokens(res);
    setMe(res.user);
    setStatus('authenticated');
    return res.user;
  }, []);

  const logout = useCallback(async () => {
    try {
      await api('POST', '/auth/logout');
    } finally {
      session.clear();
    }
  }, []);

  const value = useMemo<AuthState>(
    () => ({ status, me, login, logout, reload, can: (p) => (me ? hasPermission(me.role, p) : false) }),
    [status, me, login, logout, reload],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
