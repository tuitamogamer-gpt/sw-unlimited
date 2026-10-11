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
    googleId: process.env.AUTH_GOOGLE_ID, googleSecret: process.env.AUTH_GOOGLE_SECRET };
}
function settings(config) {
  const value = typeof config === 'function' ? config() : config;
  if (!value || typeof value.secret !== 'string' || value.secret.length < 32
    || ![value.googleId, value.googleSecret].every(item => typeof item === 'string' && item.trim())) return null;
  try {
    const url = new URL(value.url);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || !['/', AUTH_PATH, AUTH_PATH + '/'].includes(url.pathname)
      || url.protocol !== 'https:' && !(local && url.protocol === 'http:')) return null;
    return { ...value, origin: url.origin, secure: url.protocol === 'https:' };
  } catch { return null; }
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
function createAuthRouter({ config = environmentConfig, oauthFetch, logger = console } = {}) {
  const router = express.Router();
  let cached;
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
    res.set('Vary', 'Cookie');
    const value = settings(config);
    if (!value) {
      if (req.method === 'GET' && req.path === '/api/account') return res.json({ enabled: false, user: null });
      return res.status(503).json({ error: UNAVAILABLE, code: 'AUTH_UNAVAILABLE' });
    }
    const canonical = new URL(value.origin);
    // The production callback host is configured, never chosen by forwarded
    // headers or a client callbackUrl. Local factories use a loopback origin.
    if (req.get('host') !== canonical.host || req.method === 'POST' && req.get('origin') && req.get('origin') !== value.origin) {
      return res.status(403).json({ error: 'Use the configured sign-in address.', code: 'AUTH_ORIGIN' });
    }
    Object.defineProperty(req, 'protocol', { value: canonical.protocol.slice(0, -1), configurable: true });
    req.headers['x-forwarded-host'] = canonical.host;
    req.headers['x-forwarded-proto'] = canonical.protocol.slice(0, -1);
    res.locals.authSettings = value;
    next();
  });
  router.get('/api/account', async (req, res, next) => {
    try {
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
    logger.error?.('Account request failed:', error.type || error.name || 'AuthError');
    if (!res.headersSent) res.status(503).json({ error: 'Google sign-in is unavailable. You can continue as a guest.', code: 'AUTH_UNAVAILABLE' });
  });
  return router;
}

const authRouter = createAuthRouter();
const authApp = express();
authApp.disable('x-powered-by');
authApp.use(authRouter);
module.exports = { createAuthRouter, authRouter, authApp, isAuthRequest };
