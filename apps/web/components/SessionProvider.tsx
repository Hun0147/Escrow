'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { io, Socket } from 'socket.io-client';
import type { Notification, SelfUser, Wallet } from '@escrow/shared';
import { API_URL, api, getToken, setToken } from '../lib/api';

interface SessionValue {
  user: SelfUser | null;
  wallet: Wallet | null;
  notifications: Notification[];
  loading: boolean;
  socket: Socket | null;
  refresh: () => Promise<void>;
  signIn: (token: string) => Promise<void>;
  signOut: () => void;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<SelfUser | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const socketRef = useRef<Socket | null>(null);
  const [socket, setSocket] = useState<Socket | null>(null);
  const router = useRouter();

  const refresh = useCallback(async () => {
    if (!getToken()) {
      setUser(null);
      setWallet(null);
      setLoading(false);
      return;
    }
    try {
      const me = await api<{ user: SelfUser; wallet: Wallet }>('/me');
      setUser(me.user);
      setWallet(me.wallet);
      const inbox = await api<{ notifications: Notification[] }>('/me/notifications');
      setNotifications(inbox.notifications);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // One socket per session. The wallet balance and the notification bell are
  // pushed, never polled — a payout that lands while you are staring at the
  // screen should appear without a refresh.
  useEffect(() => {
    const token = getToken();
    if (!user || !token) {
      socketRef.current?.disconnect();
      socketRef.current = null;
      setSocket(null);
      return;
    }
    if (socketRef.current) return;

    const next = io(API_URL, { auth: { token }, transports: ['websocket', 'polling'] });
    next.on('wallet:updated', (updated: Wallet) => setWallet(updated));
    next.on('notification', (notification: Notification) =>
      setNotifications((current) => [notification, ...current].slice(0, 50)),
    );
    next.on('trust:updated', ({ trustScore }: { trustScore: number }) =>
      setUser((current) => (current ? { ...current, trustScore } : current)),
    );
    socketRef.current = next;
    setSocket(next);

    return () => {
      next.disconnect();
      socketRef.current = null;
      setSocket(null);
    };
  }, [user?.id]);

  const signIn = useCallback(
    async (token: string) => {
      setToken(token);
      await refresh();
    },
    [refresh],
  );

  const signOut = useCallback(() => {
    setToken(null);
    setUser(null);
    setWallet(null);
    socketRef.current?.disconnect();
    socketRef.current = null;
    router.push('/');
  }, [router]);

  const value = useMemo(
    () => ({ user, wallet, notifications, loading, socket, refresh, signIn, signOut }),
    [user, wallet, notifications, loading, socket, refresh, signIn, signOut],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession must be used inside SessionProvider');
  return context;
}

/** Redirects to the splash screen once we know there is no session. */
export function useRequireSession(): SessionValue {
  const session = useSession();
  const router = useRouter();
  useEffect(() => {
    if (!session.loading && !session.user) router.replace('/');
  }, [session.loading, session.user, router]);
  return session;
}
