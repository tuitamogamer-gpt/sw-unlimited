'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { once } = require('node:events');

function freshApp() {
  delete require.cache[require.resolve('../server/index.cjs')];
  return require('../server/index.cjs').app;
}

async function worker() {
  const server = freshApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    async request(path, body, method = body === undefined ? 'GET' : 'POST', headers = {}) {
      const response = await fetch(`${origin}${path}`, {
        method, headers: { 'Content-Type': 'application/json', ...headers },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, headers: response.headers, data: await response.json().catch(() => null) };
    },
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}

test('HTTP checkpoints resume on fresh workers and reject unauthorized or stale changes', { timeout: 60_000 }, async () => {
  const first = await worker();
  const second = await worker();
  const games = [];
  try {
    const catalog = await first.request('/api/decks');
    assert.equal(catalog.status, 200, 'The exported app initializes its catalog without start().');
    assert.equal(catalog.data.decks.length, 18);
    assert.ok(catalog.data.decks.every(deck => deck.supported));
    const created = await first.request('/api/games', {
      deckId: catalog.data.decks[0].id, opponentDeckId: catalog.data.decks[1].id, difficulty: 'normal',
    });
    assert.equal(created.status, 201);
    assert.equal(created.headers.get('cache-control'), 'no-store');
    const initial = created.data;
    games.push(initial);
    assert.match(initial.sessionToken, /^swu1\./);
    assert.ok(initial.players.bot.hand.every(card => card.hidden && !card.name && !card.id));
    assert.equal(initial.seed, undefined);
    assert.equal(initial.actions, undefined);
    const path = `/api/games/${initial.id}`;
    const resumed = await second.request(`${path}/state`, { sessionToken: initial.sessionToken });
    assert.equal(resumed.status, 200, JSON.stringify(resumed.data));
    assert.equal(resumed.data.id, initial.id);
    assert.equal(resumed.data.version, initial.version);
    assert.deepEqual(resumed.data.players, initial.players);
    assert.deepEqual(resumed.data.prompt, initial.prompt);
    assert.deepEqual(resumed.data.legalActions, initial.legalActions);

    const moved = await second.request(`${path}/actions`, {
      ...initial.legalActions[0], version: initial.version, sessionToken: initial.sessionToken,
    });
    assert.equal(moved.status, 200, JSON.stringify(moved.data));
    games.push(moved.data);
    assert.ok(moved.data.version > initial.version);
    const recovered = await first.request(path, undefined, 'GET', { 'x-game-state': moved.data.sessionToken });
    assert.equal(recovered.status, 200, JSON.stringify(recovered.data));
    assert.deepEqual(recovered.data.players, moved.data.players);
    assert.deepEqual(recovered.data.legalActions, moved.data.legalActions);
    const stale = await first.request(`${path}/actions`, {
      ...initial.legalActions[0], version: initial.version, sessionToken: initial.sessionToken,
    });
    assert.equal(stale.status, 409);
    const refreshed = await first.request(`${path}/state`, { sessionToken: initial.sessionToken });
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.data.version, moved.data.version, 'A stale read recovers the latest cached checkpoint.');
    assert.equal((await first.request(path)).status, 404, 'An ID alone does not authorize a session.');
    const tampered = moved.data.sessionToken.slice(0, 20) + (moved.data.sessionToken[20] === 'A' ? 'B' : 'A') + moved.data.sessionToken.slice(21);
    const invalid = await first.request(`${path}/state`, { sessionToken: tampered });
    assert.equal(invalid.status, 401);
    assert.deepEqual(Object.keys(invalid.data), ['error']);
    assert.equal((await first.request('/api/games/00000000-0000-0000-0000-000000000000/state', { sessionToken: moved.data.sessionToken })).status, 401);
    const afterRejects = await first.request(`${path}/state`, { sessionToken: moved.data.sessionToken });
    assert.equal(afterRejects.data.version, moved.data.version);
  } finally {
    const latest = games.at(-1);
    if (latest) {
      for (const instance of [first, second]) await instance.request(`/api/games/${latest.id}`, { sessionToken: latest.sessionToken }, 'DELETE');
    }
    await Promise.all([first.close(), second.close()]);
  }
});
