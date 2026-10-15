'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { once } = require('node:events');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { createApplication } = require('../server/index.cjs');
const { createAuthRouter } = require('../server/auth.cjs');

async function worker() {
  const auth = createAuthRouter({ config: () => null });
  const { app } = createApplication({ auth, authenticate: async () => null, accountStore: null });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    request(route, { method = 'GET', body, rawBody, headers = {} } = {}) {
      return new Promise((resolve, reject) => {
        // Native HTTP preserves conditional-request headers exactly. Fetch
        // implementations may add no-cache when given If-None-Match manually.
        const req = http.request(new URL(route, origin), { method, headers: { 'Content-Type': 'application/json', ...headers } }, res => {
          const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            resolve({ status: res.statusCode, headers: res.headers, text, data: text ? JSON.parse(text) : null });
          });
        });
        req.on('error', reject);
        if (rawBody !== undefined) req.write(rawBody);
        else if (body !== undefined) req.write(JSON.stringify(body));
        req.end();
      });
    },
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}
function assertPublic(response) {
  assert.equal(response.headers['cache-control'], 'public, max-age=0, must-revalidate');
  assert.equal(response.headers['vercel-cdn-cache-control'], 'public, s-maxage=3600, stale-while-revalidate=86400');
  assert.ok(response.headers.etag);
  assert.equal(response.headers['set-cookie'], undefined);
  assert.equal(response.headers.vary, undefined, 'Metadata has the same representation for all accounts.');
}
function assertUncached(response) {
  assert.match(response.headers['cache-control'], /(?:^|,\s*)no-store(?:,|$)/);
  assert.equal(response.headers['vercel-cdn-cache-control'], undefined);
}

test('public deck, card and training metadata revalidate with ETags and return body-free 304s', { timeout: 30_000 }, async () => {
  const instance = await worker();
  try {
    for (const route of ['/api/decks', '/api/cards?set=SOR&type=base&limit=3', '/api/training']) {
      const first = await instance.request(route);
      assert.equal(first.status, 200); assertPublic(first);
      const unchanged = await instance.request(route, { headers: { 'If-None-Match': first.headers.etag } });
      assert.equal(unchanged.status, 304, `${route} should reuse its unchanged public response.`);
      assert.equal(unchanged.text, ''); assert.equal(unchanged.headers.etag, first.headers.etag); assertPublic(unchanged);
      const authenticated = await instance.request(route, { headers: { Authorization: 'Bearer local-ignored-metadata-token', Cookie: 'untrusted-client-value=1' } });
      assert.equal(authenticated.status, 200); assert.equal(authenticated.text, first.text);
      assert.equal(authenticated.headers.etag, first.headers.etag);
      for (const privateField of ['sessionToken', 'user', 'accountOwnerId']) assert.equal(authenticated.data[privateField], undefined);
    }
  } finally { await instance.close(); }
});

test('card filters and pagination have representation-specific ETags, including stale validators from a different query', async () => {
  const instance = await worker();
  try {
    const first = await instance.request('/api/cards?set=SOR&type=unit&limit=3');
    const next = await instance.request('/api/cards?set=SOR&type=unit&limit=3&offset=3', { headers: { 'If-None-Match': first.headers.etag } });
    assert.equal(next.status, 200); assertPublic(next);
    assert.notEqual(next.headers.etag, first.headers.etag);
    assert.equal(next.data.offset, 3);
    assert.ok(next.data.cards.every(card => !first.data.cards.some(previous => previous.code === card.code)));
    const filtered = await instance.request('/api/cards?search=Vader&limit=3', { headers: { 'If-None-Match': first.headers.etag } });
    assert.equal(filtered.status, 200); assert.notEqual(filtered.headers.etag, first.headers.etag);
    assert.equal((await instance.request('/api/cards?search=Vader&limit=3', { headers: { 'If-None-Match': filtered.headers.etag } })).status, 304);
  } finally { await instance.close(); }
});

test('private games, account responses, health and failed routes retain no-store without shared-cache headers', { timeout: 30_000 }, async () => {
  const instance = await worker(); let game;
  try {
    for (const route of ['/api/account', '/api/account/saves', '/api/health', '/api/not-a-public-endpoint', '/api/games/missing']) {
      assertUncached(await instance.request(route));
    }
    const invalid = await instance.request('/api/games', { method: 'POST', body: { difficulty: 'invalid' } });
    assert.equal(invalid.status, 400); assertUncached(invalid);
    const malformed = await instance.request('/api/training/resources', { method: 'POST', rawBody: '{' });
    assert.equal(malformed.status, 400); assertUncached(malformed);
    const oversized = await instance.request('/api/games', { method: 'POST', rawBody: JSON.stringify({ input: 'x'.repeat(1024 * 1024 + 1) }) });
    assert.equal(oversized.status, 413); assertUncached(oversized);
    const created = await instance.request('/api/games', { method: 'POST', body: { deckId: 'sor-luke-skywalker', opponentDeckId: 'sor-darth-vader', difficulty: 'easy' } });
    assert.equal(created.status, 201); assertUncached(created); game = created.data;
    const restored = await instance.request(`/api/games/${game.id}`, { headers: { 'X-Game-State': game.sessionToken } });
    assert.equal(restored.status, 200); assertUncached(restored); game = restored.data;
    assert.match(game.sessionToken, /^swu1\./);
    const badTraining = await instance.request('/api/training/not-a-lesson', { method: 'POST', body: {} });
    assert.equal(badTraining.status, 400); assertUncached(badTraining);
  } finally {
    if (game) await instance.request(`/api/games/${game.id}`, { method: 'DELETE', body: { sessionToken: game.sessionToken } });
    await instance.close();
  }
});

test('production wrapper serves lightweight metadata before engine initialization and preserves retryable uncached 503 failures', { timeout: 30_000 }, () => {
  const child = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const http = require('node:http');
    (async () => {
      const engine = require('./server/engine.cjs');
      const original = engine.listDeckStatus; let attempts = 0;
      engine.listDeckStatus = async recipes => {
        attempts++;
        if (attempts === 1) throw new Error('Local initialization failure fixture');
        return original(recipes);
      };
      const { default: handler } = await import('./api/index.js');
      const server = http.createServer(handler);
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const origin = 'http://127.0.0.1:' + server.address().port;
      try {
        for (const route of ['/api/cards?limit=1', '/api/training']) {
          const response = await fetch(origin + route);
          assert.equal(response.status, 200); await response.arrayBuffer();
          assert.match(response.headers.get('cache-control'), /^public/);
        }
        assert.equal(attempts, 0, 'Public metadata must not construct the starter matches.');
        assert.equal(Object.keys(require.cache).some(file => file.endsWith('/build/server/game/core/Game.js')), false);
        const account = await fetch(origin + '/api/account');
        assert.deepEqual(await account.json(), { enabled: false, user: null });
        assert.match(account.headers.get('cache-control'), /no-store/);
        assert.equal(attempts, 0);
        const failure = await fetch(origin + '/api/decks');
        assert.equal(failure.status, 503);
        assert.equal(failure.headers.get('cache-control'), 'no-store');
        assert.equal(failure.headers.get('vercel-cdn-cache-control'), null);
        assert.deepEqual(await failure.json(), { error: 'The game server is currently unavailable. Try again.' });
        const retried = await fetch(origin + '/api/decks');
        assert.equal(retried.status, 200); assert.equal((await retried.json()).decks.length, 18);
        assert.equal(attempts, 2);
        process.stdout.write('lightweight public metadata; retryable uncached initialization failure');
      } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 25_000,
    env: { ...process.env, AUTH_GOOGLE_ID: '', AUTH_GOOGLE_SECRET: '', SUPABASE_URL: '', SUPABASE_PUBLISHABLE_KEY: '', SUPABASE_ANON_KEY: '', SUPABASE_SERVICE_ROLE_KEY: '' } });
  assert.equal(child.status, 0, child.error?.message || child.stderr);
  assert.equal(child.stdout, 'lightweight public metadata; retryable uncached initialization failure');
});
