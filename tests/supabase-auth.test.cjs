'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const http = require('node:http');
const express = require('express');
const { createAuthRouter } = require('../server/auth.cjs');
const supabaseUrl = 'https://accounts.example.supabase.co';
const publicKey = 'sb_publishable_local_fixture_key';
const subject = '11111111-2222-4333-8444-555555555555';
function token(claims = {}) {
  return [Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url'),
    Buffer.from(JSON.stringify({ iss: `${supabaseUrl}/auth/v1`, sub: subject, exp: Math.floor(Date.now() / 1000) + 3600, ...claims })).toString('base64url'), 'providerchecksitsignature'].join('.');
}
async function fixture(overrides = {}) {
  let origin;
  const calls = [], messages = [];
  const state = { profile: { id: subject, email: 'pilot@example.test', email_confirmed_at: new Date().toISOString(),
    user_metadata: { full_name: 'Test Pilot', avatar_url: 'https://images.example.test/pilot.jpg' } }, status: 200 };
  const router = createAuthRouter({ config: () => ({ url: origin, supabaseUrl, supabasePublicKey: publicKey, supabaseGoogleEnabled: true, ...overrides }),
    supabaseFetch: async (url, init) => { calls.push({ url, init }); return { ok: state.status === 200, status: state.status, json: async () => state.profile }; },
    logger: { error: (...args) => messages.push(args.join(' ')) } });
  const app = express(); app.use(router);
  app.get('/api/trusted-owner', async (req, res) => {
    try { res.json(await router.resolveAccount(req)); } catch (error) { res.status(error.status || 503).json({ code: error.code || 'UNAVAILABLE' }); }
  });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, state, calls, messages,
    request: (path = '/api/account', bearer, headers = {}) => fetch(origin + path, { headers: { ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...headers } }),
    close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

test('Supabase guest configuration exposes only the public key and explicit Google availability', async () => {
  const f = await fixture({ secret: 'private-auth-secret', googleId: 'legacy-client', googleSecret: 'private-google-secret' });
  try {
    const response = await f.request();
    assert.deepEqual(await response.json(), { enabled: true, provider: 'supabase', user: null, googleEnabled: true, clientConfig: { url: supabaseUrl, publicKey } });
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.match(response.headers.get('vary'), /Authorization/);
    assert.equal(f.calls.length, 0);
    assert.equal((await f.request('/api/auth/csrf')).status, 404);
  } finally { await f.close(); }
});

test('the remote Supabase identity, rather than browser input, determines the account owner', async () => {
  const f = await fixture();
  try {
    const accessToken = token();
    const response = await f.request('/api/account?userId=admin', accessToken, { Cookie: 'authjs.session-token=another-account' });
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(data.user, { id: `supabase_${subject}`, name: 'Test Pilot', email: 'pilot@example.test', image: 'https://images.example.test/pilot.jpg' });
    assert.ok(Date.parse(data.expires) > Date.now());
    assert.equal(f.calls[0].url, `${supabaseUrl}/auth/v1/user`);
    assert.equal(f.calls[0].init.headers.apikey, publicKey);
    assert.equal(f.calls[0].init.headers.Authorization, `Bearer ${accessToken}`);
    assert.doesNotMatch(JSON.stringify(data), /providerchecksitsignature|refresh_token|access_token/);
    assert.deepEqual((await (await f.request('/api/trusted-owner', accessToken)).json()).user, data.user);
    assert.equal(await (await f.request('/api/trusted-owner')).json(), null);
  } finally { await f.close(); }
});

test('invalid or expired bearers never fall back to an unrelated Google cookie', async () => {
  const f = await fixture();
  try {
    for (const accessToken of ['forged', token({ exp: 1 }), token({ exp: null }), token({ iss: 'https://evil.example/auth/v1' }), token({ sub: 'admin' })]) {
      const response = await f.request('/api/account', accessToken, { Cookie: 'authjs.session-token=another-account' });
      assert.equal(response.status, 401);
      assert.equal((await response.json()).code, 'ACCOUNT_AUTH');
    }
    assert.equal(f.calls.length, 0, 'Malformed, missing-expiry and expired tokens are rejected before contacting the provider.');
    f.state.status = 401;
    const rejected = await f.request('/api/trusted-owner', token(), { Cookie: 'authjs.session-token=another-account' });
    assert.equal(rejected.status, 401);
    assert.deepEqual(f.messages, [], 'No bearer or provider error body is logged.');
  } finally { await f.close(); }
});

test('verified identity must match the token subject and have a confirmed nonanonymous account', async () => {
  const f = await fixture();
  try {
    for (const profile of [{ ...f.state.profile, id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }, { ...f.state.profile, email_confirmed_at: null }, { ...f.state.profile, is_anonymous: true }]) {
      f.state.profile = profile;
      assert.equal((await f.request('/api/trusted-owner', token())).status, 401);
    }
  } finally { await f.close(); }
});

test('private Supabase keys and invalid settings cannot leak or activate the legacy provider', async () => {
  const serviceKey = token({ role: 'service_role' });
  for (const invalid of [{ supabasePublicKey: 'sb_secret_do_not_publish_this' }, { supabasePublicKey: serviceKey }, { supabaseUrl: 'https://accounts.example.supabase.co/auth/v1' }]) {
    const f = await fixture({ secret: 'private-legacy-auth-secret-at-least-32-chars', googleId: 'legacy-client', googleSecret: 'private-google-secret', ...invalid });
    try {
      assert.deepEqual(await (await f.request()).json(), { enabled: false, user: null });
      assert.equal((await f.request('/api/auth/csrf')).status, 503);
      assert.equal(f.calls.length, 0);
    } finally { await f.close(); }
  }
});

test('the trusted cloud resolver applies canonical host and origin checks too', async () => {
  const f = await fixture();
  try {
    const status = await new Promise((resolve, reject) => {
      http.get(f.origin + '/api/trusted-owner', { headers: { Host: 'evil.example', Authorization: `Bearer ${token()}` } }, res => {
        res.resume(); res.on('end', () => resolve(res.statusCode));
      }).on('error', reject);
    });
    assert.equal(status, 403); assert.equal(f.calls.length, 0);
    assert.equal((await f.request('/api/account', token(), { 'X-Forwarded-Host': 'evil.example', 'X-Forwarded-Proto': 'http' })).status, 200);
  } finally { await f.close(); }
});
