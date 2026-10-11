'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const filename = path.resolve(__dirname, '../src/account/auth-client.ts');
const compiled = new Module(filename, module);
compiled._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, filename);
const { createAuthClient, isGoogleAuthorizationUrl, ACCOUNT_MESSAGES } = compiled.exports;
const origin = 'https://sw-unlimited.example';
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const user = { id: `google_${'a'.repeat(64)}`, name: 'Alice Pilot', email: 'alice@example.test', image: 'https://lh3.googleusercontent.com/example' };

function authFetch(url, init) {
  assert.equal(init.credentials, 'same-origin');
  assert.equal(init.cache, 'no-store');
  if (url === '/api/auth/csrf') return Promise.resolve(response({ csrfToken: 'server-csrf-token' }));
  throw new Error(`Unexpected endpoint: ${url}`);
}

test('account lookup returns only public profile data, never OAuth fields', async () => {
  const calls = [];
  const client = createAuthClient({ fetch: async (url, init) => {
    calls.push({ url, init });
    return response({ enabled: true, user: { ...user, access_token: 'not-for-browser', refresh_token: 'not-for-browser' }, expires: '2030-01-01T00:00:00Z', secret: 'not-for-browser' });
  } });
  assert.deepEqual(await client.account(), { enabled: true, user, expires: '2030-01-01T00:00:00Z' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/account');
  assert.equal(calls[0].init.credentials, 'same-origin');
  assert.equal(calls[0].init.method, undefined);
});

test('disabled Google authentication still returns an ordinary guest account', async () => {
  const client = createAuthClient({ fetch: async () => response({ enabled: false, user: null }) });
  assert.deepEqual(await client.account(), { enabled: false, user: null });
});

test('malformed account responses cannot select a browser account scope', async () => {
  for (const payload of [{ enabled: true }, { enabled: true, user: { ...user, id: '../guest' } }, { enabled: false, user }, { enabled: true, user: { ...user, name: 12 } }]) {
    const client = createAuthClient({ fetch: async () => response(payload) });
    await assert.rejects(client.account(), error => error.message === ACCOUNT_MESSAGES.status);
  }
});

test('Google sign-in obtains CSRF and posts a form before following the verified Google URL', async () => {
  const calls = [], navigations = [];
  const providerUrl = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=example&state=opaque';
  const client = createAuthClient({ origin, navigate: url => navigations.push(url), fetch: async (url, init) => {
    calls.push(url);
    if (url === '/api/auth/csrf') return authFetch(url, init);
    assert.equal(url, '/api/auth/signin/google');
    assert.equal(init.method, 'POST');
    assert.equal(init.credentials, 'same-origin');
    assert.equal(init.headers['X-Auth-Return-Redirect'], '1');
    assert.equal(init.headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.deepEqual(Object.fromEntries(new URLSearchParams(init.body)), { csrfToken: 'server-csrf-token', callbackUrl: '/' });
    return response({ url: providerUrl });
  } });
  await client.signIn();
  assert.deepEqual(calls, ['/api/auth/csrf', '/api/auth/signin/google']);
  assert.deepEqual(navigations, [providerUrl]);
});

test('sign-in rejects error redirects and look-alike or insecure provider URLs', async () => {
  const unsafe = ['http://accounts.google.com/o/oauth2/v2/auth', 'https://accounts.google.com.attacker.test/auth', 'https://accounts.google.com@attacker.test/auth', 'https://accounts.google.com:444/auth', 'javascript:alert(1)', '/api/auth/failure?error=OAuthSignin', `${origin}/?authError=signin`];
  for (const target of unsafe) {
    assert.equal(isGoogleAuthorizationUrl(target), false);
    const client = createAuthClient({ origin, navigate: () => assert.fail('Unsafe redirect must not navigate'), fetch: (url, init) => url === '/api/auth/csrf' ? authFetch(url, init) : Promise.resolve(response({ url: target })) });
    await assert.rejects(client.signIn(), error => error.message === ACCOUNT_MESSAGES.signin);
  }
});

test('missing CSRF stops sign-in before the mutation or any navigation', async () => {
  let calls = 0;
  const client = createAuthClient({ fetch: async () => { calls++; return response({}); }, navigate: () => assert.fail('No redirect expected') });
  await assert.rejects(client.signIn(), error => error.message === ACCOUNT_MESSAGES.signin);
  assert.equal(calls, 1);
});

test('sign-out posts CSRF and only accepts the configured successful root redirect', async () => {
  for (const target of ['/', `${origin}/`]) {
    const client = createAuthClient({ origin, navigate: () => assert.fail('Sign-out must not navigate'), fetch: (url, init) => {
      if (url === '/api/auth/csrf') return authFetch(url, init);
      assert.equal(url, '/api/auth/signout');
      assert.equal(init.method, 'POST');
      assert.equal(new URLSearchParams(init.body).get('csrfToken'), 'server-csrf-token');
      return Promise.resolve(response({ url: target }));
    } });
    await client.signOut();
  }
});

test('HTTP 200 sign-out error redirects never count as success', async () => {
  for (const target of ['/api/auth/failure?error=MissingCSRF', `${origin}/?authError=signin`, 'https://attacker.test/', null]) {
    const client = createAuthClient({ origin, fetch: (url, init) => url === '/api/auth/csrf' ? authFetch(url, init) : Promise.resolve(response({ url: target })) });
    await assert.rejects(client.signOut(), error => error.message === ACCOUNT_MESSAGES.signout);
  }
});

test('configuration errors are public and network/server details are not reflected', async () => {
  const unavailable = createAuthClient({ fetch: async () => response({ code: 'AUTH_UNAVAILABLE', error: 'internal details' }, 503) });
  await assert.rejects(unavailable.signIn(), error => error.message === ACCOUNT_MESSAGES.unavailable);
  const internal = createAuthClient({ fetch: async () => response({ error: 'secret stacktrace' }, 500) });
  await assert.rejects(internal.account(), error => error.message === ACCOUNT_MESSAGES.status && !error.message.includes('secret'));
});

test('a timed-out account request cannot hang or navigate from a late response', async () => {
  let signal, release;
  const delayed = new Promise(resolve => { release = resolve; });
  const client = createAuthClient({ timeoutMs: 5, navigate: () => assert.fail('Late response must not navigate'), fetch: async (_url, init) => { signal = init.signal; return delayed; } });
  await assert.rejects(client.signIn(), error => error.message === ACCOUNT_MESSAGES.timeout);
  assert.equal(signal.aborted, true);
  release(response({ csrfToken: 'late' }));
  await new Promise(resolve => setTimeout(resolve, 0));
});
