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
}
export const ACCOUNT_MESSAGES = {
  unavailable: 'Google sign-in is not configured. You can continue as a guest.',
  status: 'Your account could not be checked. Guest play is still available. Try again when your connection is ready.',
  signin: 'Google sign-in could not be started. Please try again.',
  signout: 'Sign-out could not be confirmed. Please try again.',
  timeout: 'The account request timed out. Please try again.',
  callback: 'Google sign-in was cancelled or could not be completed. Try again or continue as a guest.',
  expired: 'Your sign-in session expired. Your account saves are still on this device. Sign in again or continue as a guest.',
} as const;

export class AccountRequestError extends Error {
  status?: number;
  constructor(message: string, status?: number) { super(message); this.name = 'AccountRequestError'; this.status = status; }
}

type AuthClientOptions = { fetch?: typeof fetch; timeoutMs?: number; navigate?: (url: string) => void; origin?: string };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export function isGoogleAuthorizationUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'accounts.google.com' && !url.username && !url.password && (!url.port || url.port === '443');
  } catch { return false; }
}

/** Auth.js owns OAuth state, PKCE, CSRF and the HttpOnly session cookie. */
export function createAuthClient(options: AuthClientOptions = {}) {
  const fetchRequest = options.fetch || ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
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
  async function account(): Promise<AccountInfo> {
    const data = await request('/api/account', {}, ACCOUNT_MESSAGES.status);
    if (!object(data) || typeof data.enabled !== 'boolean' || data.user !== null && (!object(data.user)
      || typeof data.user.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(data.user.id) || typeof data.user.name !== 'string')) {
      throw new AccountRequestError(ACCOUNT_MESSAGES.status);
    }
    const user = data.user as Record<string, unknown> | null;
    if (!data.enabled && user) throw new AccountRequestError(ACCOUNT_MESSAGES.status);
    return {
      enabled: data.enabled,
      user: user ? { id: String(user.id), name: String(user.name),
        ...(typeof user.email === 'string' ? { email: user.email } : {}),
        ...(typeof user.image === 'string' && /^https:\/\//i.test(user.image) ? { image: user.image } : {}),
      } : null,
      ...(typeof data.expires === 'string' && Number.isFinite(Date.parse(data.expires)) ? { expires: data.expires } : {}),
    };
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
    const data = await submit('signin/google');
    if (!object(data) || !isGoogleAuthorizationUrl(data.url)) throw new AccountRequestError(ACCOUNT_MESSAGES.signin);
    (options.navigate || (url => window.location.assign(url)))(data.url);
  }
  async function signOut(): Promise<void> {
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
  return { account, signIn, signOut };
}
