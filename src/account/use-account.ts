import { useCallback, useEffect, useRef, useState } from 'react';
import { ACCOUNT_MESSAGES, createAuthClient } from './auth-client';
import type { AccountInfo, AccountUser } from './auth-client';

export type { AccountInfo, AccountUser } from './auth-client';
export interface AccountController {
  account: AccountInfo | null;
  user: AccountUser | null;
  loading: boolean;
  authBusy: boolean;
  error: string;
  refresh: () => Promise<void>;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
}
const SIGNAL_KEY = 'swu-account-changed';
const CHANNEL_NAME = 'swu-account';

function callbackMessage(): string {
  if (typeof window === 'undefined') return '';
  const url = new URL(window.location.href);
  if (!url.searchParams.has('authError')) return '';
  return ACCOUNT_MESSAGES.callback;
}

export function useAccount(): AccountController {
  const client = useRef(createAuthClient());
  const initialNotice = useRef<string | null>(null);
  if (initialNotice.current === null) initialNotice.current = callbackMessage();
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const currentAccount = useRef<AccountInfo | null>(null);
  const acceptAccount = useCallback((next: AccountInfo) => { currentAccount.current = next; setAccount(next); }, []);
  const [loading, setLoading] = useState(true);
  const [authBusy, setAuthBusy] = useState(false);
  const [error, setError] = useState(initialNotice.current);
  const alive = useRef(true);
  const pendingAuth = useRef(false);
  const requestVersion = useRef(0);
  const loadedOnce = useRef(false);
  const channel = useRef<BroadcastChannel | null>(null);

  const announce = useCallback(() => {
    channel.current?.postMessage({ type: 'changed' });
    // A timestamp is only a cross-tab refresh signal, never a session or identity.
    try { localStorage.setItem(SIGNAL_KEY, `${Date.now()}-${Math.random()}`); } catch { /* Guest play works without storage. */ }
  }, []);
  const load = useCallback(async (clearNotice = false) => {
    if (pendingAuth.current) return;
    const version = ++requestVersion.current;
    if (clearNotice) { initialNotice.current = ''; if (alive.current) setError(''); }
    if (!loadedOnce.current && alive.current) setLoading(true);
    const previous = currentAccount.current;
    const expired = !!(previous?.user && previous.expires && Date.parse(previous.expires) <= Date.now());
    if (expired && alive.current) {
      initialNotice.current = ACCOUNT_MESSAGES.expired;
      acceptAccount({ enabled: previous!.enabled, user: null });
      setError(ACCOUNT_MESSAGES.expired);
    }
    try {
      const next = await client.current.account();
      if (!alive.current || version !== requestVersion.current) return;
      const firstLoad = !loadedOnce.current;
      loadedOnce.current = true;
      const alreadyExpired = !!(next.user && next.expires && Date.parse(next.expires) <= Date.now());
      acceptAccount(alreadyExpired ? { enabled: next.enabled, user: null } : next);
      if (alreadyExpired) { initialNotice.current = ACCOUNT_MESSAGES.expired; setError(ACCOUNT_MESSAGES.expired); }
      if (!alreadyExpired && next.user && initialNotice.current === ACCOUNT_MESSAGES.expired) initialNotice.current = '';
      if (!initialNotice.current) setError('');
      if (firstLoad) announce();
    } catch (caught) {
      if (alive.current && version === requestVersion.current) setError(expired ? ACCOUNT_MESSAGES.expired : caught instanceof Error ? caught.message : ACCOUNT_MESSAGES.status);
    } finally {
      if (alive.current && version === requestVersion.current) setLoading(false);
    }
  }, [acceptAccount, announce]);
  const refresh = useCallback(() => load(true), [load]);

  useEffect(() => {
    alive.current = true;
    const url = new URL(window.location.href);
    if (url.searchParams.has('authError')) {
      url.searchParams.delete('authError');
      window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    }
    try { channel.current = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL_NAME); } catch { channel.current = null; }
    const onSignal = () => { void load(); };
    const onMessage = (event: MessageEvent) => { if (event.data?.type === 'changed') onSignal(); };
    const onStorage = (event: StorageEvent) => { if (event.key === SIGNAL_KEY) onSignal(); };
    const onVisible = () => { if (document.visibilityState === 'visible') onSignal(); };
    channel.current?.addEventListener('message', onMessage);
    window.addEventListener('storage', onStorage);
    window.addEventListener('focus', onSignal);
    document.addEventListener('visibilitychange', onVisible);
    void load();
    return () => {
      alive.current = false;
      ++requestVersion.current;
      channel.current?.close(); channel.current = null;
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('focus', onSignal);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);
  useEffect(() => {
    if (!account?.user || !account.expires) return;
    const remaining = Date.parse(account.expires) - Date.now();
    const timer = setTimeout(() => { void load(); }, Math.max(0, Math.min(remaining + 10, 60 * 60 * 1000)));
    return () => clearTimeout(timer);
  }, [account, load]);

  const signIn = useCallback(async () => {
    if (pendingAuth.current || loading || !account?.enabled) return;
    pendingAuth.current = true;
    ++requestVersion.current;
    initialNotice.current = ''; setError(''); setAuthBusy(true);
    try { await client.current.signIn(); }
    catch (caught) { if (alive.current) setError(caught instanceof Error ? caught.message : ACCOUNT_MESSAGES.signin); }
    finally {
      pendingAuth.current = false;
      if (alive.current) {
        setAuthBusy(false);
        if (currentAccount.current?.user && currentAccount.current.expires && Date.parse(currentAccount.current.expires) <= Date.now()) void load();
      }
    }
  }, [account?.enabled, load, loading]);
  const signOut = useCallback(async () => {
    if (pendingAuth.current || loading || !account?.user) return;
    pendingAuth.current = true;
    ++requestVersion.current;
    initialNotice.current = ''; setError(''); setAuthBusy(true);
    try {
      await client.current.signOut();
      announce();
      // A confirmed sign-out must remove the old browser scope even if the
      // following status read loses its network response.
      if (alive.current) { acceptAccount({ enabled: account.enabled, user: null }); loadedOnce.current = true; }
      const next = await client.current.account();
      if (alive.current) {
        acceptAccount(next);
        if (next.user) setError(ACCOUNT_MESSAGES.signout);
      }
    } catch (caught) {
      if (alive.current) setError(caught instanceof Error ? caught.message : ACCOUNT_MESSAGES.signout);
    } finally {
      pendingAuth.current = false;
      if (alive.current) {
        setAuthBusy(false);
        if (currentAccount.current?.user && currentAccount.current.expires && Date.parse(currentAccount.current.expires) <= Date.now()) void load();
      }
    }
  }, [account, acceptAccount, announce, load, loading]);

  return { account, user: account?.user || null, loading, authBusy, error, refresh, signIn, signOut };
}
