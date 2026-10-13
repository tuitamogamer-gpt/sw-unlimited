'use strict';

// Accounts are optional. A Google session never replaces or authorizes the
// independent encrypted checkpoints used by guest games.
const express = require('express');
const { createHash } = require('node:crypto');

const CANONICAL_ORIGIN = 'https://sw-unlimited-mu.vercel.app';
const AUTH_PATH = '/api/auth';
const UNAVAILABLE = 'Google sign-in is not configured. You can continue as a guest.';
let modules;
function authModules() {
  return modules ||= Promise.all([import('@auth/express'), import('@auth/express/providers/google')]);
}
function environmentConfig() {
  return { url: process.env.AUTH_URL || CANONICAL_ORIGIN, secret: process.env.AUTH_SECRET,
    googleId: process.env.AUTH_GOOGLE_ID, googleSecret: process.env.AUTH_GOOGLE_SECRET,
    supabaseUrl: process.env.SUPABASE_URL,
    supabasePublicKey: process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY,
    supabaseGoogleEnabled: process.env.SUPABASE_GOOGLE_ENABLED === 'true' };
}
function originSettings(value) {
  try {
    const url = new URL(value.url);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || !['/', AUTH_PATH, AUTH_PATH + '/'].includes(url.pathname)
      || url.protocol !== 'https:' && !(local && url.protocol === 'http:')) return null;
    return { origin: url.origin, secure: url.protocol === 'https:' };
  } catch { return null; }
}
function jwtClaims(token) {
  if (typeof token !== 'string' || token.length > 16_384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return null;
  try { const value = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); return value && typeof value === 'object' ? value : null; }
  catch { return null; }
}
function publicSupabaseKey(key) {
  if (typeof key !== 'string' || key.length > 4096) return false;
  if (/^sb_publishable_[A-Za-z0-9_-]{8,}$/.test(key)) return true;
  // A service-role or secret key must never appear in public configuration.
  return jwtClaims(key)?.role === 'anon';
}
function supabaseSettings(value) {
  if (!value?.supabaseUrl && !value?.supabasePublicKey) return null;
  const origin = originSettings(value);
  if (!origin || !publicSupabaseKey(value.supabasePublicKey)) return null;
  try {
    const url = new URL(value.supabaseUrl);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || url.protocol !== 'https:' && !(local && url.protocol === 'http:')) return null;
    return { ...origin, url: url.origin, publicKey: value.supabasePublicKey, googleEnabled: value.supabaseGoogleEnabled === true };
  } catch { return null; }
}
function settings(config) {
  const value = typeof config === 'function' ? config() : config;
  if (!value || typeof value.secret !== 'string' || value.secret.length < 32
    || ![value.googleId, value.googleSecret].every(item => typeof item === 'string' && item.trim())) return null;
  const origin = originSettings(value);
  return origin ? { ...value, ...origin } : null;
}
function accountId(subject) { return `google_${createHash('sha256').update(subject).digest('hex')}`; }
function verifiedProfile(profile) {
  return profile && typeof profile.sub === 'string' && profile.sub.length > 0 && profile.sub.length <= 255
    && profile.email_verified === true && typeof profile.email === 'string' && profile.email.length <= 320;
}
function publicUser(token) {
  if (!token || typeof token.sub !== 'string' || !/^google_[a-f0-9]{64}$/.test(token.sub)) return null;
  const user = { id: token.sub, name: typeof token.name === 'string' ? token.name.slice(0, 200) : 'Player' };
  if (typeof token.email === 'string') user.email = token.email.slice(0, 320);
  if (typeof token.picture === 'string') {
    try { if (new URL(token.picture).protocol === 'https:') user.image = token.picture; } catch { /* Invalid provider image. */ }
  }
  return user;
}
function isAuthRequest(url) {
  const pathname = String(url || '').split('?')[0];
  return pathname === '/api/account' || pathname === AUTH_PATH || pathname.startsWith(AUTH_PATH + '/');
}

// Configuration and transport injection are server-only factory arguments for
// local integration tests. No HTTP input can select a provider, key, or identity.
function createAuthRouter({ config = environmentConfig, oauthFetch, supabaseFetch = globalThis.fetch, logger = console } = {}) {
  const router = express.Router();
  let cached;
  function currentSettings() {
    const raw = typeof config === 'function' ? config() : config;
    // Explicit but invalid Supabase configuration does not silently activate
    // another provider and therefore cannot select an unexpected account scope.
    // A URL alone may configure cloud storage for the legacy Google provider.
    if (raw?.supabasePublicKey) return { supabase: supabaseSettings(raw), native: null };
    return { supabase: null, native: settings(raw) };
  }
  function checkOrigin(req, value) {
    const canonical = new URL(value.origin);
    if (req.get('host') !== canonical.host || !['GET', 'HEAD'].includes(req.method) && req.get('origin') && req.get('origin') !== value.origin) {
      const error = new Error('Use the configured sign-in address.'); Object.assign(error, { status: 403, code: 'AUTH_ORIGIN' }); throw error;
    }
    return canonical;
  }
  function rejectedAccount() {
    const error = new Error('Your sign-in session could not be verified. Sign in again.');
    Object.assign(error, { status: 401, code: 'ACCOUNT_AUTH' }); return error;
  }
  async function supabaseAccount(req, value) {
    const authorization = req.get('authorization');
    if (!authorization) return null;
    const matched = /^Bearer ([A-Za-z0-9_.-]+)$/i.exec(authorization);
    const claims = matched && jwtClaims(matched[1]);
    if (!claims || !Number.isFinite(claims.exp) || claims.exp <= Date.now() / 1000
      || claims.iss !== `${value.url}/auth/v1` || typeof claims.sub !== 'string'
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(claims.sub)) throw rejectedAccount();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await supabaseFetch(`${value.url}/auth/v1/user`, { headers: { apikey: value.publicKey, Authorization: `Bearer ${matched[1]}` }, signal: controller.signal, redirect: 'error' });
      if (!response.ok) {
        if ([401, 403].includes(response.status)) throw rejectedAccount();
        throw new Error('AccountProviderUnavailable');
      }
      const profile = await response.json();
      if (claims.exp <= Date.now() / 1000 || !profile || profile.id !== claims.sub || profile.is_anonymous === true
        || !profile.email_confirmed_at && !profile.confirmed_at) throw rejectedAccount();
      const metadata = profile.user_metadata || {};
      const name = typeof metadata.full_name === 'string' ? metadata.full_name : typeof metadata.name === 'string' ? metadata.name : 'Player';
      const user = { id: `supabase_${profile.id.toLowerCase()}`, name: name.slice(0, 200) };
      if (typeof profile.email === 'string') user.email = profile.email.slice(0, 320);
      const picture = metadata.avatar_url || metadata.picture;
      if (typeof picture === 'string') { try { if (new URL(picture).protocol === 'https:') user.image = picture; } catch { /* Invalid provider image. */ } }
      return { user, expires: new Date(claims.exp * 1000).toISOString() };
    } finally { clearTimeout(timer); }
  }
  async function resolveAccount(req) {
    const value = currentSettings();
    if (!value.supabase && !value.native) return null;
    const canonical = checkOrigin(req, value.supabase || value.native);
    Object.defineProperty(req, 'protocol', { value: canonical.protocol.slice(0, -1), configurable: true });
    req.headers['x-forwarded-host'] = canonical.host;
    req.headers['x-forwarded-proto'] = canonical.protocol.slice(0, -1);
    if (value.supabase) return supabaseAccount(req, value.supabase);
    // A supplied bearer never falls back to a different signed-in cookie.
    if (req.get('authorization')) throw rejectedAccount();
    const session = await (await configured(value.native)).session(req);
    if (!session?.user) return null;
    if (!session.expires || !Number.isFinite(Date.parse(session.expires)) || Date.parse(session.expires) <= Date.now()) throw rejectedAccount();
    return { user: session.user, expires: session.expires };
  }
  async function configured(value) {
    const key = JSON.stringify(value);
    if (cached?.key === key) return cached.promise;
    const promise = authModules().then(([{ ExpressAuth, getSession, customFetch }, { default: Google }]) => {
      const options = {
        clientId: value.googleId, clientSecret: value.googleSecret,
        checks: ['pkce', 'state', 'nonce'],
        authorization: { params: { scope: 'openid email profile' } },
        ...(oauthFetch ? { [customFetch]: oauthFetch } : {}),
      };
      const authConfig = {
        secret: value.secret, basePath: AUTH_PATH, trustHost: true,
        useSecureCookies: value.secure,
        session: { strategy: 'jwt', maxAge: 30 * 24 * 60 * 60 },
        providers: [Google(options)],
        pages: { signIn: '/api/auth/failure', error: '/api/auth/failure' },
        callbacks: {
          redirect: () => `${value.origin}/`,
          signIn: ({ account, profile }) => account?.provider === 'google'
            && verifiedProfile(profile) && account.providerAccountId === profile.sub,
          jwt: ({ token, account, profile }) => {
            if (account) {
              if (account.provider !== 'google' || !verifiedProfile(profile) || account.providerAccountId !== profile.sub) return null;
              // Rebuild the token from verified provider claims. Ignore browser
              // session updates and never persist Google's access/refresh tokens.
              return { sub: accountId(profile.sub), name: typeof profile.name === 'string' ? profile.name.slice(0, 200) : 'Player',
                email: profile.email, picture: profile.picture };
            }
            return token;
          },
          session: ({ session, token }) => ({ user: publicUser(token),
            // getSession reads do not send Auth.js's refreshed cookie. Report
            // the expiration of the verified cookie the browser actually holds.
            expires: Number.isFinite(token.exp) ? new Date(token.exp * 1000).toISOString() : session.expires }),
        },
        logger: {
          error: error => logger.error?.('Google sign-in failed:', error.type || error.name || 'AuthError'),
          warn: code => { if (code !== 'env-url-basepath-redundant') logger.warn?.('Google sign-in warning:', code); },
          debug: () => {},
        },
      };
      return { handler: ExpressAuth(authConfig), session: req => getSession(req, authConfig) };
    });
    cached = { key, promise };
    return promise;
  }
  router.use((req, res, next) => {
    if (!isAuthRequest(req.path)) return next();
    res.set('Cache-Control', 'private, no-store');
    res.set('Vary', 'Cookie, Authorization');
    const selected = currentSettings();
    const value = selected.supabase || selected.native;
    if (!value) {
      if (req.method === 'GET' && req.path === '/api/account') return res.json({ enabled: false, user: null });
      return res.status(503).json({ error: UNAVAILABLE, code: 'AUTH_UNAVAILABLE' });
    }
    let canonical;
    // The production callback host is configured, never chosen by forwarded
    // headers or a client callbackUrl. Local factories use a loopback origin.
    try { canonical = checkOrigin(req, value); } catch (error) { return res.status(error.status).json({ error: error.message, code: error.code }); }
    Object.defineProperty(req, 'protocol', { value: canonical.protocol.slice(0, -1), configurable: true });
    req.headers['x-forwarded-host'] = canonical.host;
    req.headers['x-forwarded-proto'] = canonical.protocol.slice(0, -1);
    res.locals.authSettings = selected.native;
    res.locals.supabaseSettings = selected.supabase;
    if (selected.supabase && req.path !== '/api/account') return res.status(404).json({ error: 'Use the account panel to sign in.', code: 'AUTH_PROVIDER' });
    next();
  });
  router.get('/api/account', async (req, res, next) => {
    try {
      if (res.locals.supabaseSettings) {
        const value = res.locals.supabaseSettings;
        const session = await resolveAccount(req);
        return res.json({ enabled: true, provider: 'supabase', googleEnabled: value.googleEnabled,
          clientConfig: { url: value.url, publicKey: value.publicKey }, user: session?.user || null,
          ...(session?.user ? { expires: session.expires } : {}) });
      }
      const native = await configured(res.locals.authSettings);
      const session = await native.session(req);
      res.json({ enabled: true, user: session?.user || null, ...(session?.user ? { expires: session.expires } : {}) });
    } catch (error) { next(error); }
  });
  router.get('/api/auth/failure', (_req, res) => {
    res.redirect(303, `${res.locals.authSettings.origin}/?authError=signin`);
  });
  router.all('/api/auth', (_req, res) => res.status(404).json({ error: 'Unknown account route.' }));
  router.use('/api/auth/*', async (req, res, next) => {
    try { (await configured(res.locals.authSettings)).handler(req, res, next); }
    catch (error) { next(error); }
  });
  router.use((error, _req, res, _next) => {
    if (error.status && error.code) return res.status(error.status).json({ error: error.message, code: error.code });
    logger.error?.('Account request failed:', error.type || error.name || 'AuthError');
    if (!res.headersSent) res.status(503).json({ error: 'Sign-in is unavailable. You can continue as a guest.', code: 'AUTH_UNAVAILABLE' });
  });
  router.resolveAccount = resolveAccount;
  return router;
}

const authRouter = createAuthRouter();
const authApp = express();
authApp.disable('x-powered-by');
authApp.use(authRouter);
module.exports = { createAuthRouter, authRouter, authApp, isAuthRequest, resolveAccount: authRouter.resolveAccount };
