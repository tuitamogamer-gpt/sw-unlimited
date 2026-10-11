'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { createAuthRouter } = require('../server/auth.cjs');
const { createMockGoogle } = require('./helpers/mock-google.cjs');

async function fixture({ disabled = false, secure = false } = {}) {
  let origin;
  const messages = [];
  const mock = createMockGoogle({ origin: () => origin });
  const app = express();
  app.use(createAuthRouter({
    config: () => disabled ? {} : { url: origin, secret: 'test-auth-secret-independent-of-game-checkpoints',
      googleId: 'test-google-client', googleSecret: 'test-google-secret' },
    oauthFetch: mock.oauthFetch, logger: { error: (...args) => messages.push(args.join(' ')), warn: () => {} },
  }));
  app.get('/mock/google', mock.authorize);
  app.get('/api/guest-probe', (_req, res) => res.json({ guest: true }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = `127.0.0.1:${server.address().port}`;
  origin = `${secure ? 'https' : 'http'}://${address}`;
  const transport = `http://${address}`;
  const jar = new Map();
  const cookies = [];
  async function request(path, body, headers = {}) {
    const response = await fetch(transport + path, { method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
      headers: { Cookie: [...jar].map(([key, value]) => `${key}=${value}`).join('; '),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: origin }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const cookie of response.headers.getSetCookie()) {
      cookies.push(cookie);
      const pair = cookie.split(';')[0];
      const at = pair.indexOf('=');
      const name = pair.slice(0, at), value = pair.slice(at + 1);
      if (/Max-Age=0(?:;|$)/i.test(cookie)) jar.delete(name); else jar.set(name, value);
    }
    return response;
  }
  async function csrf() { return (await (await request('/api/auth/csrf')).json()).csrfToken; }
  async function begin(callbackUrl = '/') {
    const response = await request('/api/auth/signin/google', { csrfToken: await csrf(), callbackUrl }, { 'X-Auth-Return-Redirect': '1' });
    assert.equal(response.status, 200);
    const { url } = await response.json();
    assert.equal(new URL(url).origin, 'https://accounts.google.com');
    assert.equal(new URL(url).searchParams.get('redirect_uri'), `${origin}/api/auth/callback/google`);
    assert.ok(new URL(url).searchParams.get('state'));
    assert.ok(new URL(url).searchParams.get('nonce'));
    assert.ok(new URL(url).searchParams.get('code_challenge'));
    return url;
  }
  async function callback(url) {
    const response = await request(new URL(mock.authorizationUrl(url)).pathname + new URL(url).search);
    assert.equal(response.status, 302);
    return new URL(response.headers.get('location'));
  }
  async function signIn(callbackUrl) {
    const target = await callback(await begin(callbackUrl));
    return request(target.pathname + target.search);
  }
  return { origin, mock, request, csrf, begin, callback, signIn, jar, cookies, messages,
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

test('missing Google configuration remains a friendly guest account with working guest routes', async () => {
  const f = await fixture({ disabled: true });
  try {
    const response = await f.request('/api/account');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { enabled: false, user: null });
    assert.match(response.headers.get('cache-control'), /no-store/);
    for (const path of ['/api/auth/csrf', '/api/auth/signin/google', '/api/auth/signout']) {
      const response = await f.request(path, path.endsWith('csrf') ? undefined : {});
      assert.equal(response.status, 503);
      assert.equal((await response.json()).code, 'AUTH_UNAVAILABLE');
    }
    assert.deepEqual(await (await f.request('/api/guest-probe')).json(), { guest: true });
    assert.equal(f.mock.counts.discovery, 0);
  } finally { await f.close(); }
});

test('the serverless account route works without loading or initializing the game engine', () => {
  const child = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const http = require('node:http');
    (async () => {
      const { default: handler } = await import('./api/index.js');
      const server = http.createServer(handler);
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      try {
        const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/account');
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { enabled: false, user: null });
        assert.equal(Object.keys(require.cache).some(file => /server\\/(engine|index)\\.cjs$/.test(file)), false);
        process.stdout.write('lightweight account route');
      } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, AUTH_GOOGLE_ID: '', AUTH_GOOGLE_SECRET: '' } });
  assert.equal(child.status, 0, child.error?.message || child.stderr);
  assert.equal(child.stdout, 'lightweight account route');
});

test('real Google OIDC code flow yields a stable verified identity and secure private session cookies', async () => {
  const f = await fixture({ secure: true });
  try {
    assert.deepEqual(await (await f.request('/api/account')).json(), { enabled: true, user: null });
    const response = await f.signIn('https://evil.example/steal');
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), `${f.origin}/`, 'Only the canonical root is a valid return location.');
    const account = await (await f.request('/api/account')).json();
    assert.equal(account.user.id, `google_${createHash('sha256').update(f.mock.identity.sub).digest('hex')}`);
    assert.equal(account.user.name, 'Test Pilot');
    assert.equal(account.user.email, 'pilot@example.test');
    assert.ok(Date.parse(account.expires) > Date.now());
    const { decode } = await import('@auth/core/jwt');
    const heldCookie = await decode({ token: f.jar.get('__Secure-authjs.session-token'),
      secret: 'test-auth-secret-independent-of-game-checkpoints', salt: '__Secure-authjs.session-token' });
    assert.equal(account.expires, new Date(heldCookie.exp * 1000).toISOString(),
      'Account reads report the held cookie expiry, rather than a rolling expiry that was not sent to the browser.');
    assert.deepEqual(Object.keys(account.user).sort(), ['email', 'id', 'image', 'name']);
    for (const cookie of f.cookies.filter(cookie => /authjs\.(session-token|csrf-token|state|nonce|pkce)/.test(cookie))) {
      assert.match(cookie, /HttpOnly/i); assert.match(cookie, /Secure/i); assert.match(cookie, /SameSite=Lax/i);
    }
    assert.ok(f.cookies.some(cookie => cookie.startsWith('__Secure-authjs.session-token=')));
    assert.ok(f.cookies.some(cookie => cookie.startsWith('__Host-authjs.csrf-token=')));
    const nativeSession = await (await f.request('/api/auth/session')).json();
    assert.equal(nativeSession.user.id, account.user.id);
    assert.doesNotMatch(JSON.stringify({ account, nativeSession, cookies: f.cookies }), /mock-google-(?:access|refresh)-secret|id_token|access_token|refresh_token/);
    assert.ok(f.mock.counts.discovery >= 2);
    assert.equal(f.mock.counts.token, 1);

    // Account updates supplied by the browser cannot select a user or email.
    await f.request('/api/auth/session', { csrfToken: await f.csrf(), data: { user: { id: 'admin', email: 'spoofed@example.test' } } });
    assert.deepEqual((await (await f.request('/api/account')).json()).user, account.user);
    f.mock.identity.email = 'changed@example.test';
    await f.signIn('//evil.example/');
    const renamed = await (await f.request('/api/account')).json();
    assert.equal(renamed.user.id, account.user.id, 'Identity follows the Google subject, never the email address.');
    assert.equal(renamed.user.email, 'changed@example.test');
  } finally { await f.close(); }
});

test('native CSRF, state, nonce, audience and verified-email checks reject forged sign-in', async t => {
  await t.test('CSRF and forwarded headers', async () => {
    const f = await fixture();
    try {
      await f.csrf();
      const rejected = await f.request('/api/auth/signin/google', { csrfToken: 'forged', callbackUrl: '/' }, { 'X-Auth-Return-Redirect': '1' });
      assert.notEqual(new URL((await rejected.json()).url).origin, 'https://accounts.google.com');
      assert.equal(f.mock.counts.token, 0);
      const evilOrigin = await f.request('/api/auth/signin/google', { csrfToken: await f.csrf() }, { Origin: 'https://evil.example' });
      assert.equal(evilOrigin.status, 403);
      const forwarded = await f.request('/api/auth/signin/google', { csrfToken: await f.csrf(), callbackUrl: '/' },
        { 'X-Auth-Return-Redirect': '1', 'X-Forwarded-Host': 'evil.example', 'X-Forwarded-Proto': 'http' });
      assert.equal(new URL((await forwarded.json()).url).searchParams.get('redirect_uri'), `${f.origin}/api/auth/callback/google`);
      const spoofed = await f.request('/api/account?userId=admin', undefined, { Authorization: 'Bearer forged-google-token' });
      assert.equal((await spoofed.json()).user, null);
      // Fetch normalizes Host, so use the native HTTP client to exercise a
      // forged wire-level host rather than silently testing the real host.
      const wrongHost = await new Promise((resolve, reject) => {
        http.get(`${f.origin}/api/account`, { headers: { Host: 'evil.example' } }, response => {
          response.resume(); response.on('end', () => resolve(response.statusCode));
        }).on('error', reject);
      });
      assert.equal(wrongHost, 403);
      assert.equal((await f.request('/api/auth')).status, 404, 'The bare auth base path must complete rather than hang.');
    } finally { await f.close(); }
  });
  for (const invalid of ['state', 'PKCE cookie', 'nonce', 'audience', 'issuer', 'expired ID token', 'unverified email', 'cancel', 'provider failure']) {
    await t.test(invalid, async () => {
      const f = await fixture();
      try {
        if (invalid === 'nonce') f.mock.claimOverrides.nonce = 'forged';
        if (invalid === 'audience') f.mock.claimOverrides.aud = 'another-client';
        if (invalid === 'issuer') f.mock.claimOverrides.iss = 'https://evil.example';
        if (invalid === 'expired ID token') f.mock.claimOverrides.exp = Math.floor(Date.now() / 1000) - 60;
        if (invalid === 'unverified email') f.mock.identity.email_verified = false;
        if (invalid === 'cancel') f.mock.cancel = true;
        if (invalid === 'provider failure') f.mock.tokenError = true;
        const callback = await f.callback(await f.begin());
        if (invalid === 'state') callback.searchParams.set('state', 'forged');
        if (invalid === 'PKCE cookie') f.jar.delete('authjs.pkce.code_verifier');
        const response = await f.request(callback.pathname + callback.search);
        assert.equal(response.status, 302);
        const failure = new URL(response.headers.get('location'));
        assert.equal(failure.pathname, '/api/auth/failure');
        const safe = await f.request(failure.pathname + failure.search);
        assert.equal(safe.headers.get('location'), `${f.origin}/?authError=signin`);
        assert.equal((await (await f.request('/api/account')).json()).user, null);
        assert.deepEqual(await (await f.request('/api/guest-probe')).json(), { guest: true });
      } finally { await f.close(); }
    });
  }
});

test('tampered and expired account cookies never authenticate an identity', async () => {
  const f = await fixture();
  try {
    await f.signIn();
    const cookieName = 'authjs.session-token';
    const valid = f.jar.get(cookieName);
    assert.ok(valid);
    f.jar.set(cookieName, valid.slice(0, -8) + 'tampered');
    assert.equal((await (await f.request('/api/account')).json()).user, null);
    const { decode, encode } = await import('@auth/core/jwt');
    const secret = 'test-auth-secret-independent-of-game-checkpoints';
    const claims = await decode({ token: valid, secret, salt: cookieName });
    f.jar.set(cookieName, await encode({ token: claims, secret, salt: cookieName, maxAge: -60 }));
    assert.deepEqual(await (await f.request('/api/account')).json(), { enabled: true, user: null });
    assert.deepEqual(await (await f.request('/api/guest-probe')).json(), { guest: true });
  } finally { await f.close(); }
});

test('sign-out requires native CSRF, removes only account cookies, and leaves guest access intact', async () => {
  const f = await fixture();
  try {
    await f.signIn();
    f.jar.set('guest-marker', 'unchanged');
    const failed = await f.request('/api/auth/signout', { csrfToken: 'forged' }, { 'X-Auth-Return-Redirect': '1' });
    assert.match((await failed.json()).url, /error|failure/);
    assert.ok((await (await f.request('/api/account')).json()).user);
    const signedOut = await f.request('/api/auth/signout', { csrfToken: await f.csrf(), callbackUrl: 'https://evil.example' },
      { 'X-Auth-Return-Redirect': '1' });
    assert.deepEqual(await signedOut.json(), { url: `${f.origin}/` });
    assert.equal((await (await f.request('/api/account')).json()).user, null);
    assert.equal(f.jar.get('guest-marker'), 'unchanged');
    assert.deepEqual(await (await f.request('/api/guest-probe')).json(), { guest: true });
  } finally { await f.close(); }
});
