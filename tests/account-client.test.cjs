'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const filename = path.resolve(__dirname, '../src/account/auth-client.ts');
const compiled = new Module(filename, module);
compiled.paths = Module._nodeModulePaths(path.dirname(filename));
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

function supabaseFixture() {
  const id = '11111111-2222-4333-8444-555555555555';
  const config = { enabled: true, provider: 'supabase', user: null, googleEnabled: true,
    clientConfig: { url: 'https://accounts.example.supabase.co', publicKey: 'sb_publishable_local_fixture_key' } };
  const state = { session: null, confirmation: true, error: null, oauthUrl: `${config.clientConfig.url}/auth/v1/authorize?provider=google`, callback: null, signupCalls: [], signInCalls: [], calls: [] };
  const freshSession = (access_token = 'verified-access-token') => ({ access_token, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id } });
  const sdk = { auth: {
    getSession: async () => ({ data: { session: state.session }, error: null }),
    signInWithPassword: async input => { state.signInCalls.push(input); if (!state.error) state.session = freshSession(); return { data: { session: state.session }, error: state.error }; },
    signUp: async input => { state.signupCalls.push(input); if (!state.error && !state.confirmation) state.session = freshSession(); return { data: { user: { id }, session: state.session }, error: state.error }; },
    signInWithOAuth: async input => { state.oauthInput = input; return { data: { url: state.oauthUrl }, error: state.error }; },
    signOut: async input => { state.signOutInput = input; if (!state.error) state.session = null; return { error: state.error }; },
    onAuthStateChange: callback => { state.callback = callback; return { data: { subscription: { unsubscribe: () => { state.callback = null; } } } }; },
  } };
  const navigations = [];
  const client = createAuthClient({ origin: 'http://127.0.0.1:4173', navigate: url => navigations.push(url),
    supabaseFactory: (url, key) => { assert.equal(url, config.clientConfig.url); assert.equal(key, config.clientConfig.publicKey); return sdk; },
    fetch: async (url, init) => {
      state.calls.push({ url, init }); assert.equal(url, '/api/account');
      const authorization = init.headers?.Authorization;
      if (authorization) state.onVerify?.(authorization);
      return response({ ...config, ...(authorization ? { user: { id: `supabase_${id}`, name: 'Verified Pilot' }, expires: new Date(Date.now() + 3600_000).toISOString() } : {}) });
    } });
  return { client, state, config, freshSession, navigations, id };
}

test('Supabase browser sessions are verified by the server before they select an account scope', async () => {
  const f = supabaseFixture();
  assert.equal((await f.client.account()).user, null);
  f.state.session = f.freshSession();
  f.state.session.user.id = 'untrusted-browser-owner';
  const info = await f.client.account();
  assert.equal(info.user.id, `supabase_${f.id}`);
  assert.notEqual(info.user.id, f.state.session.user.id);
  await assert.rejects(f.client.getAccessToken(), error => error.status === 401);
  f.state.session.user.id = f.id;
  assert.equal(await f.client.getAccessToken(), 'verified-access-token');
  assert.equal(f.state.calls.at(-1).init.headers.Authorization, 'Bearer verified-access-token');
  assert.equal(f.state.calls.at(-1).init.credentials, 'same-origin');
});

test('a new SDK account cannot upload the old account scope before server reverification', async () => {
  const f = supabaseFixture(); await f.client.account(); f.state.session = f.freshSession();
  await f.client.account();
  f.state.session = { ...f.freshSession('different-account-token'), user: { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' } };
  await assert.rejects(f.client.getAccessToken(), error => error.status === 401);
});

test('Supabase missing or expired session expiry never retains a signed-in account', async () => {
  const f = supabaseFixture(); await f.client.account();
  for (const expires_at of [undefined, 1, NaN]) {
    f.state.session = { ...f.freshSession(), expires_at };
    await assert.rejects(f.client.account(), error => error.status === 401 && error.message === ACCOUNT_MESSAGES.expired
      && error.account?.provider === 'supabase' && error.account.user === null && error.account.enabled,
    'An invalid stored session still exposes safe provider configuration so the player can sign in again.');
  }
});

test('a session changed during verification is reverified before returning the new owner', async () => {
  const f = supabaseFixture(); await f.client.account();
  f.state.session = f.freshSession('before-change');
  let reads = 0;
  // The injected browser session changes at the independent network boundary.
  f.state.onVerify = authorization => { if (authorization === 'Bearer before-change') { reads++; f.state.session = f.freshSession('after-change'); } };
  const info = await f.client.account();
  assert.equal(info.user.id, `supabase_${f.id}`); assert.equal(reads, 1);
  assert.equal(f.state.calls.at(-1).init.headers.Authorization, 'Bearer after-change');
});

test('email signup reports confirmation truthfully and password inputs only go to the auth SDK', async () => {
  const f = supabaseFixture(); await f.client.account();
  assert.deepEqual(await f.client.signUpWithEmail(' pilot@example.test ', 'private-password'), { confirmationRequired: true });
  assert.equal((await f.client.account()).user, null);
  assert.deepEqual(f.state.signupCalls[0], { email: 'pilot@example.test', password: 'private-password', options: { emailRedirectTo: 'http://127.0.0.1:4173/' } });
  assert.doesNotMatch(JSON.stringify(f.state.calls), /private-password/);
  f.state.confirmation = false;
  assert.deepEqual(await f.client.signUpWithEmail('pilot@example.test', 'another-password'), { confirmationRequired: false });
  assert.equal((await f.client.account()).user.id, `supabase_${f.id}`);
});

test('email sign-in errors are private and Supabase sign-out clears the local account session', async () => {
  const f = supabaseFixture(); await f.client.account();
  f.state.error = new Error('Account exists; internal provider details');
  await assert.rejects(f.client.signInWithEmail('pilot@example.test', 'private-password'), error => error.message === ACCOUNT_MESSAGES.emailSignin);
  await assert.rejects(f.client.signUpWithEmail('pilot@example.test', 'private-password'), error => error.message === ACCOUNT_MESSAGES.emailSignup);
  f.state.error = null;
  await f.client.signInWithEmail('pilot@example.test', 'older6');
  assert.equal(f.state.signInCalls.at(-1).password, 'older6', 'Existing Supabase accounts may have a shorter password than this app permits for new accounts.');
  await assert.rejects(f.client.signUpWithEmail('pilot@example.test', 'older6'), error => error.message === ACCOUNT_MESSAGES.invalidCredentials);
  assert.ok((await f.client.account()).user);
  await f.client.signOut();
  assert.deepEqual(f.state.signOutInput, { scope: 'local' });
  assert.equal((await f.client.account()).user, null);
});

test('Supabase Google redirects use the configured provider and a canonical app callback', async () => {
  const f = supabaseFixture(); await f.client.account(); await f.client.signIn();
  assert.deepEqual(f.state.oauthInput, { provider: 'google', options: { redirectTo: 'http://127.0.0.1:4173/', skipBrowserRedirect: true } });
  assert.deepEqual(f.navigations, [f.state.oauthUrl]);
  for (const url of ['https://evil.example/auth/v1/authorize', 'http://accounts.example.supabase.co/auth/v1/authorize', `${f.config.clientConfig.url}/not-authorize`]) {
    f.state.oauthUrl = url;
    await assert.rejects(f.client.signIn(), error => error.message === ACCOUNT_MESSAGES.signin);
  }
  assert.equal(f.navigations.length, 1);
});

test('Supabase auth events defer account refresh beyond the SDK auth lock', async () => {
  const f = supabaseFixture(); let notified = 0;
  const unsubscribe = f.client.subscribe(() => { notified++; });
  await f.client.account();
  f.state.callback('SIGNED_IN', f.freshSession());
  assert.equal(notified, 0);
  await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(notified, 1);
  unsubscribe(); assert.equal(f.state.callback, null);
});

test('real Supabase SDK provider requests have a deadline and abort before a late sign-in can succeed', async () => {
  let providerSignal;
  const client = createAuthClient({ timeoutMs: 5, origin: 'http://127.0.0.1:4173', fetch: async (url, init) => {
    if (url === '/api/account') return response({ enabled: true, provider: 'supabase', user: null, googleEnabled: false,
      clientConfig: { url: 'https://deadline-test.supabase.co', publicKey: 'sb_publishable_local_fixture_key' } });
    assert.equal(url, 'https://deadline-test.supabase.co/auth/v1/token?grant_type=password');
    assert.equal(init.credentials, 'omit'); providerSignal = init.signal;
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('Transport aborted')), { once: true }));
  } });
  await client.account();
  await assert.rejects(client.signInWithEmail('pilot@example.test', 'private-password'), error => error.message === ACCOUNT_MESSAGES.emailSignin);
  assert.equal(providerSignal.aborted, true);
  assert.equal(await client.getAccessToken(), null);
});
