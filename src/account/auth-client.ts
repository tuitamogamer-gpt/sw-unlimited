import type { SupabaseClient } from '@supabase/supabase-js';

export interface AccountUser {
  id: string;
  name: string;
  email?: string;
  image?: string;
}
export interface AccountInfo {
  enabled: boolean;
  user: AccountUser | null;
  expires?: string;
  provider?: 'supabase';
  googleEnabled?: boolean;
  clientConfig?: { url: string; publicKey: string };
}
export const ACCOUNT_MESSAGES = {
  unavailable: 'Google sign-in is not configured. You can continue as a guest.',
  status: 'Your account could not be checked. Guest play is still available. Try again when your connection is ready.',
  signin: 'Google sign-in could not be started. Please try again.',
  signout: 'Sign-out could not be confirmed. Please try again.',
  timeout: 'The account request timed out. Please try again.',
  callback: 'Google sign-in was cancelled or could not be completed. Try again or continue as a guest.',
  expired: 'Your sign-in session expired. Your account saves are still on this device. Sign in again or continue as a guest.',
  emailSignin: 'Sign-in could not be completed. Check your email and password, then try again.',
  emailSignup: 'Your account could not be created. Check your details and try again.',
  confirmation: 'Check your email for the confirmation link, then return here to sign in.',
  signedIn: 'Signed in. Your account is ready.',
  invalidCredentials: 'Enter a valid email address and a password of at least 8 characters.',
} as const;

export class AccountRequestError extends Error {
  status?: number;
  account?: AccountInfo;
  constructor(message: string, status?: number) { super(message); this.name = 'AccountRequestError'; this.status = status; }
}

type SupabaseAuthClient = Pick<SupabaseClient, 'auth'>;
type AuthClientOptions = { fetch?: typeof fetch; timeoutMs?: number; navigate?: (url: string) => void; origin?: string;
  supabaseFactory?: (url: string, publicKey: string) => SupabaseAuthClient };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
let supabaseModule: Promise<typeof import('@supabase/supabase-js')> | undefined;
function loadSupabase() {
  return supabaseModule ||= import('@supabase/supabase-js').catch(error => {
    supabaseModule = undefined;
    throw error;
  });
}

export function isGoogleAuthorizationUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'accounts.google.com' && !url.username && !url.password && (!url.port || url.port === '443');
  } catch { return false; }
}

/** Supabase owns its PKCE/session lifecycle; legacy Auth.js owns HTTP-only cookies. */
export function createAuthClient(options: AuthClientOptions = {}) {
  const fetchRequest = options.fetch || ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  const providerFetch: typeof fetch = async (input, init) => {
    const controller = new AbortController();
    const incoming = init?.signal;
    const abort = () => controller.abort();
    if (incoming?.aborted) abort(); else incoming?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, options.timeoutMs ?? 12_000);
    try { return await fetchRequest(input, { ...init, signal: controller.signal, credentials: 'omit', cache: 'no-store' }); }
    finally { clearTimeout(timer); incoming?.removeEventListener('abort', abort); }
  };
  let supabase: SupabaseAuthClient | null = null;
  let providerConfig: AccountInfo | null = null;
  let verifiedOwner: string | null = null;
  let subscription: { unsubscribe(): void } | null = null;
  let configuration = Promise.resolve();
  const listeners = new Set<() => void>();
  function subscribeToProvider() {
    if (!supabase || subscription || !listeners.size) return;
    subscription = supabase.auth.onAuthStateChange(() => {
      // Supabase holds an auth lock during this callback. Start any account
      // refresh in a later task rather than awaiting another SDK operation.
      setTimeout(() => { for (const listener of listeners) listener(); }, 0);
    }).data.subscription;
  }
  function configure(info: AccountInfo): Promise<void> {
    // Serialize configuration so concurrent account reads share one SDK client.
    // The provider bundle is loaded only after the server enables Supabase.
    configuration = configuration.catch(() => {}).then(async () => {
      if (info.provider === 'supabase' && info.clientConfig) {
        if (!supabase || providerConfig?.clientConfig?.url !== info.clientConfig.url || providerConfig?.clientConfig?.publicKey !== info.clientConfig.publicKey) {
          subscription?.unsubscribe(); subscription = null;
          verifiedOwner = null;
          supabase = options.supabaseFactory
            ? options.supabaseFactory(info.clientConfig.url, info.clientConfig.publicKey)
            : (await loadSupabase()).createClient(info.clientConfig.url, info.clientConfig.publicKey, { global: { fetch: providerFetch },
              auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
        }
      } else { subscription?.unsubscribe(); subscription = null; supabase = null; verifiedOwner = null; }
      providerConfig = info;
      subscribeToProvider();
    });
    return configuration;
  }
  async function request(path: string, init: RequestInit = {}, failure: string): Promise<unknown> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new AccountRequestError(ACCOUNT_MESSAGES.timeout)); }, options.timeoutMs ?? 12_000);
    });
    try {
      return await Promise.race([deadline, (async () => {
        const response = await fetchRequest(path, { ...init, signal: controller.signal, credentials: 'same-origin', cache: 'no-store' });
        const data: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          throw new AccountRequestError(object(data) && data.code === 'AUTH_UNAVAILABLE' ? ACCOUNT_MESSAGES.unavailable : failure, response.status);
        }
        return data;
      })()]);
    } catch (error) {
      if (error instanceof AccountRequestError) throw error;
      throw new AccountRequestError(controller.signal.aborted ? ACCOUNT_MESSAGES.timeout : failure);
    } finally { clearTimeout(timer); }
  }
  function accountInfo(data: unknown): AccountInfo {
    if (!object(data) || typeof data.enabled !== 'boolean' || data.user !== null && (!object(data.user)
      || typeof data.user.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(data.user.id) || typeof data.user.name !== 'string')) {
      throw new AccountRequestError(ACCOUNT_MESSAGES.status);
    }
    const user = data.user as Record<string, unknown> | null;
    if (!data.enabled && user) throw new AccountRequestError(ACCOUNT_MESSAGES.status);
    let clientConfig: AccountInfo['clientConfig'];
    if (data.provider !== undefined && data.provider !== 'supabase') throw new AccountRequestError(ACCOUNT_MESSAGES.status);
    if (data.provider === 'supabase') {
      if (!data.enabled || !object(data.clientConfig) || typeof data.clientConfig.url !== 'string' || typeof data.clientConfig.publicKey !== 'string'
        || !data.clientConfig.publicKey || data.clientConfig.publicKey.startsWith('sb_secret_') || data.clientConfig.publicKey.length > 4096
        || typeof data.googleEnabled !== 'boolean') throw new AccountRequestError(ACCOUNT_MESSAGES.status);
      try {
        const url = new URL(data.clientConfig.url);
        if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
          || url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Invalid account URL');
        clientConfig = { url: url.origin, publicKey: data.clientConfig.publicKey };
      } catch { throw new AccountRequestError(ACCOUNT_MESSAGES.status); }
    }
    return {
      enabled: data.enabled,
      user: user ? { id: String(user.id), name: String(user.name),
        ...(typeof user.email === 'string' ? { email: user.email } : {}),
        ...(typeof user.image === 'string' && /^https:\/\//i.test(user.image) ? { image: user.image } : {}),
      } : null,
      ...(typeof data.expires === 'string' && Number.isFinite(Date.parse(data.expires)) ? { expires: data.expires } : {}),
      ...(data.provider === 'supabase' ? { provider: 'supabase' as const, googleEnabled: data.googleEnabled as boolean, clientConfig } : {}),
    };
  }
  async function sessionToken(): Promise<{ token: string; owner: string | null } | null> {
    if (!supabase) return null;
    const { data, error } = await supabase.auth.getSession();
    if (error) throw new AccountRequestError(ACCOUNT_MESSAGES.expired, 401);
    if (!data.session) return null;
    const session = data.session;
    if (!session.expires_at || !Number.isFinite(session.expires_at) || session.expires_at <= Date.now() / 1000
      || typeof session.access_token !== 'string' || !session.access_token) throw new AccountRequestError(ACCOUNT_MESSAGES.expired, 401);
    return { token: session.access_token, owner: typeof session.user?.id === 'string' ? `supabase_${session.user.id.toLowerCase()}` : null };
  }
  async function getAccessToken(): Promise<string | null> {
    const current = await sessionToken();
    if (!current) return null;
    // A provider session can change before React's account refresh completes.
    // Never upload the old local scope with the new account's credential.
    if (!verifiedOwner || current.owner !== verifiedOwner) throw new AccountRequestError(ACCOUNT_MESSAGES.expired, 401);
    return current.token;
  }
  async function account(): Promise<AccountInfo> {
    const initial = accountInfo(await request('/api/account', {}, ACCOUNT_MESSAGES.status));
    try { await configure(initial); } catch { throw new AccountRequestError(ACCOUNT_MESSAGES.status); }
    if (!supabase) return initial;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const current = await sessionToken();
        if (!current) { verifiedOwner = null; return { ...initial, user: null, expires: undefined }; }
        const verified = accountInfo(await request('/api/account', { headers: { Authorization: `Bearer ${current.token}` } }, ACCOUNT_MESSAGES.status));
        if (verified.provider !== 'supabase' || !verified.user || !verified.expires || Date.parse(verified.expires) <= Date.now()) throw new AccountRequestError(ACCOUNT_MESSAGES.expired, 401);
        if ((await sessionToken())?.token === current.token) { verifiedOwner = verified.user.id; return verified; }
      }
      throw new AccountRequestError(ACCOUNT_MESSAGES.status);
    } catch (error) {
      if (error instanceof AccountRequestError && error.status === 401) { verifiedOwner = null; error.account = { ...initial, user: null, expires: undefined }; }
      throw error;
    }
  }
  function redirectOrigin(): string {
    const origin = options.origin || (typeof window !== 'undefined' ? window.location.origin : undefined);
    try {
      const url = new URL(origin || '');
      if (url.origin !== origin || url.origin !== 'https://sw-unlimited-mu.vercel.app'
        && !(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && ['http:', 'https:'].includes(url.protocol))) throw new Error('Unexpected callback origin');
      return `${url.origin}/`;
    } catch { throw new AccountRequestError(ACCOUNT_MESSAGES.signin); }
  }
  async function submit(action: 'signin/google' | 'signout'): Promise<unknown> {
    const failure = action === 'signout' ? ACCOUNT_MESSAGES.signout : ACCOUNT_MESSAGES.signin;
    const csrf = await request('/api/auth/csrf', {}, failure);
    if (!object(csrf) || typeof csrf.csrfToken !== 'string' || !csrf.csrfToken) throw new AccountRequestError(failure);
    return request(`/api/auth/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Auth-Return-Redirect': '1' },
      body: new URLSearchParams({ csrfToken: csrf.csrfToken, callbackUrl: '/' }).toString(),
    }, failure);
  }
  async function signIn(): Promise<void> {
    if (supabase) {
      if (!providerConfig?.googleEnabled) throw new AccountRequestError(ACCOUNT_MESSAGES.unavailable);
      try {
        const { data, error } = await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: redirectOrigin(), skipBrowserRedirect: true } });
        if (error || !data.url) throw new Error('Invalid account redirect');
        const target = new URL(data.url);
        if (target.origin !== providerConfig.clientConfig?.url || target.pathname !== '/auth/v1/authorize'
          || target.username || target.password || target.hash) throw new Error('Invalid account redirect');
        (options.navigate || (url => window.location.assign(url)))(data.url);
      } catch { throw new AccountRequestError(ACCOUNT_MESSAGES.signin); }
      return;
    }
    const data = await submit('signin/google');
    if (!object(data) || !isGoogleAuthorizationUrl(data.url)) throw new AccountRequestError(ACCOUNT_MESSAGES.signin);
    (options.navigate || (url => window.location.assign(url)))(data.url);
  }
  async function signOut(): Promise<void> {
    if (supabase) {
      try { const { error } = await supabase.auth.signOut({ scope: 'local' }); if (error) throw error; verifiedOwner = null; }
      catch { throw new AccountRequestError(ACCOUNT_MESSAGES.signout); }
      return;
    }
    const data = await submit('signout');
    if (!object(data) || typeof data.url !== 'string') throw new AccountRequestError(ACCOUNT_MESSAGES.signout);
    // Auth.js may report a CSRF failure with HTTP 200 and an error redirect.
    // Only its configured successful root redirect confirms the sign-out POST.
    const origin = options.origin || (typeof window !== 'undefined' ? window.location.origin : undefined);
    try {
      if (data.url !== '/') {
        const url = new URL(data.url);
        if (!origin || url.origin !== origin || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error('Unexpected sign-out URL');
      }
    } catch { throw new AccountRequestError(ACCOUNT_MESSAGES.signout); }
  }
  function credentials(email: string, password: string, signup = false) {
    const normalized = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) || normalized.length > 320 || password.length < (signup ? 8 : 1) || password.length > 256) throw new AccountRequestError(signup ? ACCOUNT_MESSAGES.invalidCredentials : ACCOUNT_MESSAGES.emailSignin);
    return { email: normalized, password };
  }
  async function signInWithEmail(email: string, password: string): Promise<void> {
    if (!supabase) throw new AccountRequestError(ACCOUNT_MESSAGES.unavailable);
    const input = credentials(email, password);
    try { const { error, data } = await supabase.auth.signInWithPassword(input); if (error || !data.session) throw error || new Error('No account session'); }
    catch { throw new AccountRequestError(ACCOUNT_MESSAGES.emailSignin); }
  }
  async function signUpWithEmail(email: string, password: string): Promise<{ confirmationRequired: boolean }> {
    if (!supabase) throw new AccountRequestError(ACCOUNT_MESSAGES.unavailable);
    const input = credentials(email, password, true);
    try {
      const { error, data } = await supabase.auth.signUp({ ...input, options: { emailRedirectTo: redirectOrigin() } });
      if (error || !data.user) throw error || new Error('No account signup');
      return { confirmationRequired: !data.session };
    } catch { throw new AccountRequestError(ACCOUNT_MESSAGES.emailSignup); }
  }
  function subscribe(listener: () => void): () => void {
    listeners.add(listener); subscribeToProvider();
    return () => { listeners.delete(listener); if (!listeners.size) { subscription?.unsubscribe(); subscription = null; } };
  }
  return { account, signIn, signOut, getAccessToken, signInWithEmail, signUpWithEmail, subscribe };
}
