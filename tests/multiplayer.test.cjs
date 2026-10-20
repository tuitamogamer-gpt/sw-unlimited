const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { createApplication } = require('../server/index.cjs');
const { createMemoryRoomAdapter, createSupabaseRoomAdapter } = require('../server/room-store.cjs');
const { assertPrivateView } = require('../scripts/smoke.cjs');
const key = () => randomBytes(32).toString('base64url');

async function start(adapter) {
  const application = createApplication({ roomAdapter: adapter });
  const server = application.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  return { application, server, async request(path, body, playerKey) {
    const res = await fetch(url + path, { method: body === undefined ? 'GET' : 'POST', headers: {
      'Content-Type': 'application/json', ...(playerKey ? { 'x-room-key': playerKey } : {}),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.match(res.headers.get('cache-control'), /no-store/);
    assert.equal(res.headers.get('vercel-cdn-cache-control'), null);
    return { status: res.status, body: res.status === 204 ? null : await res.json() };
  }, close: () => new Promise(resolve => server.close(resolve)) };
}
function privacy(result) {
  assert.equal(result.game.viewerId, 'human'); assertPrivateView(result.game);
  assert.equal(result.game.sessionToken, undefined);
  const raw = JSON.stringify(result);
  for (const forbidden of ['checkpoint', 'hostKey', 'guestKey', 'inviteHash', 'seed', 'swu1.']) assert.ok(!raw.includes(`"${forbidden}"`) && !raw.includes('swu1.'), forbidden);
  assert.equal(result.game.players.human.id, 'human'); assert.equal(result.game.players.bot.id, 'bot');
  assert.equal(result.game.players.human.name, 'You'); assert.equal(result.game.players.bot.name, 'Opponent');
}

test('online rooms fail closed when shared storage is not configured', async () => {
  const worker = await start(null);
  try {
    assert.deepEqual((await worker.request('/api/rooms/config')).body, { enabled: false });
    assert.equal((await worker.request('/api/rooms', {})).status, 503);
  } finally { await worker.close(); }
});

test('two independent workers share private seats, atomic native turns and authoritative reconnect', async t => {
  const adapter = createMemoryRoomAdapter();
  const workers = await Promise.all([start(adapter), start(adapter)]);
  const [a, b] = workers;
  const id = randomUUID(), host = key(), invite = key(), guestA = key(), guestB = key();
  let guest; let state;
  const create = { id, playerKey: host, inviteKey: invite, deckId: 'sor-luke-skywalker' };
  try {
    await t.test('creation is retryable and invitations contain no seat access or board', async () => {
      assert.equal((await a.request('/api/rooms/config')).body.enabled, true);
      const room = await a.request('/api/rooms', create); assert.equal(room.status, 201);
      assert.equal(room.body.room.status, 'waiting'); assert.equal(room.body.game, undefined);
      assert.equal((await b.request('/api/rooms', create)).status, 200);
      assert.equal((await b.request(`/api/rooms/${id}`, undefined, invite)).status, 403);
      assert.equal((await b.request(`/api/rooms/${id}`, undefined, key())).status, 403);
      assert.equal((await b.request(`/api/rooms/${id}`)).status, 401);
      assert.equal((await b.request(`/api/rooms/${id}?revision=0`, undefined, host)).status, 204);
    });
    await t.test('only one simultaneous guest can join; its view owns the bottom hand', async () => {
      const attempts = await Promise.all([a.request(`/api/rooms/${id}/join`, { inviteKey: invite, playerKey: guestA, deckId: 'sor-darth-vader' }),
        b.request(`/api/rooms/${id}/join`, { inviteKey: invite, playerKey: guestB, deckId: 'sor-darth-vader' })]);
      assert.deepEqual(attempts.map(r => r.status).sort(), [200, 409]);
      guest = attempts[0].status === 200 ? guestA : guestB;
      const outsider = guest === guestA ? guestB : guestA;
      assert.equal((await b.request(`/api/rooms/${id}`, undefined, outsider)).status, 403);
      state = (await a.request(`/api/rooms/${id}`, undefined, host)).body;
      const other = (await b.request(`/api/rooms/${id}`, undefined, guest)).body;
      privacy(state); privacy(other);
      assert.equal(state.game.version, 0, 'No bot acts when the second human joins.');
      assert.equal(other.game.version, 0);
      assert.equal(state.game.players.human.leader.name, 'Luke Skywalker');
      assert.equal(other.game.players.human.leader.name, 'Darth Vader');
      assert.equal(state.game.players.human.hand.length, 0);
      assert.equal(other.game.players.human.hand.length, 0);
      assert.equal((await b.request(`/api/rooms/${id}/join`, { inviteKey: invite, playerKey: guest, deckId: 'sor-darth-vader' })).status, 200);
    });
    await t.test('another seat cannot submit the active player prompt or spoof a seat', async () => {
      const states = await Promise.all([a.request(`/api/rooms/${id}`, undefined, host), b.request(`/api/rooms/${id}`, undefined, guest)]);
      const active = states.findIndex(result => result.body.game.legalActions.length);
      const view = states[active].body; const action = view.game.legalActions[0];
      const clean = { type: action.type, arg: action.arg, promptId: action.promptId, version: view.game.version, ...(action.cardId ? { cardId: action.cardId } : {}) };
      assert.equal((await a.request(`/api/rooms/${id}/actions`, { revision: view.room.revision, requestId: randomUUID(), action: clean }, active === 0 ? guest : host)).status, 409);
      assert.equal((await a.request(`/api/rooms/${id}/actions`, { revision: view.room.revision, requestId: randomUUID(), action: clean, playerId: 'bot' }, host)).status, 400);
      assert.equal((await a.request(`/api/rooms/${id}`, undefined, host)).body.game.version, 0);
    });
    await t.test('concurrent and duplicate moves cannot advance or fork the match twice', async () => {
      const states = await Promise.all([a.request(`/api/rooms/${id}`, undefined, host), b.request(`/api/rooms/${id}`, undefined, guest)]);
      const active = states.findIndex(result => result.body.game.legalActions.length);
      const view = states[active].body; const action = view.game.legalActions[0];
      const clean = { type: action.type, arg: action.arg, promptId: action.promptId, version: view.game.version, ...(action.cardId ? { cardId: action.cardId } : {}) };
      const requests = [0, 1].map(() => ({ revision: view.room.revision, requestId: randomUUID(), action: clean }));
      const who = active === 0 ? host : guest;
      const attempts = await Promise.all([a.request(`/api/rooms/${id}/actions`, requests[0], who), b.request(`/api/rooms/${id}/actions`, requests[1], who)]);
      assert.deepEqual(attempts.map(r => r.status).sort(), [200, 409]);
      const accepted = requests[attempts.findIndex(r => r.status === 200)];
      assert.equal((await b.request(`/api/rooms/${id}/actions`, accepted, who)).body.game.version, 1);
      assert.equal((await b.request(`/api/rooms/${id}/actions`, { ...accepted, action: { ...clean, arg: 'tampered' } }, who)).status, 409);
      const next = (await a.request(`/api/rooms/${id}`, undefined, host)).body;
      assert.equal(next.game.version, 1); assert.equal(next.room.revision, 2);
      assert.equal((await a.request(`/api/rooms/${id}/actions`, { ...accepted, requestId: randomUUID(), action: { ...clean, version: undefined } }, who)).status, 409);
    });
    await t.test('both humans complete native setup and resource choices without an AI turn', async () => {
      for (let step = 0; step < 30; step++) {
        const states = await Promise.all([a.request(`/api/rooms/${id}`, undefined, host), b.request(`/api/rooms/${id}`, undefined, guest)]);
        states.forEach(result => privacy(result.body));
        if (states[0].body.game.phase === 'action') { state = states[0].body; break; }
        const active = states.findIndex(result => result.body.game.legalActions.length);
        assert.ok(active >= 0); const view = states[active].body;
        const actions = view.game.legalActions;
        const pick = view.game.prompt.stage === 'resource'
          ? view.game.prompt.selectedCardIds.length < view.game.prompt.resourceSelection.max
            ? actions.find(action => action.type === 'card' && !view.game.prompt.selectedCardIds.includes(action.cardId))
            : actions.find(action => action.arg === 'done')
          : actions.find(action => action.arg === 'keep') || actions[0];
        const action = { type: pick.type, promptId: pick.promptId, version: view.game.version, ...(pick.arg !== undefined ? { arg: pick.arg } : {}), ...(pick.cardId ? { cardId: pick.cardId } : {}) };
        const result = await workers[step % 2].request(`/api/rooms/${id}/actions`, { revision: view.room.revision, requestId: randomUUID(), action }, active === 0 ? host : guest);
        assert.equal(result.status, 200); assert.equal(result.body.game.version, view.game.version + 1);
      }
      assert.equal(state.game.phase, 'action');
      assert.equal(state.game.players.human.resourceCount, 2); assert.equal(state.game.players.bot.resourceCount, 2);
      assert.equal(state.game.players.human.handCount, 4); assert.equal(state.game.players.bot.handCount, 4);
      const fresh = await start(adapter); workers.push(fresh);
      const restored = (await fresh.request(`/api/rooms/${id}`, undefined, host)).body;
      assert.equal(restored.game.version, state.game.version);
      assert.deepEqual(restored.game.players, state.game.players);
      assert.deepEqual(restored.game.prompt, state.game.prompt);
    });
    await t.test('concession is atomic, shared, and uses each player perspective', async () => {
      const result = await b.request(`/api/rooms/${id}/leave`, { revision: state.room.revision }, guest);
      assert.equal(result.status, 200); assert.equal(result.body.room.status, 'finished');
      assert.deepEqual(result.body.game.winnerIds, ['bot']); assert.equal(result.body.game.legalActions.length, 0);
      const hostView = (await a.request(`/api/rooms/${id}`, undefined, host)).body;
      assert.deepEqual(hostView.game.winnerIds, ['human']); assert.equal(hostView.game.prompt.stage, 'finished');
      assert.equal((await a.request(`/api/rooms/${id}/join`, { inviteKey: invite, playerKey: key(), deckId: 'sor-luke-skywalker' })).status, 409);
    });
    await t.test('closed and expired invitations do not admit a new player', async () => {
      const emptyId = randomUUID();
      await a.request('/api/rooms', { ...create, id: emptyId });
      assert.equal((await b.request(`/api/rooms/${emptyId}/leave`, { revision: 0 }, host)).body.room.status, 'cancelled');
      assert.equal((await b.request(`/api/rooms/${emptyId}/join`, { inviteKey: invite, playerKey: key(), deckId: 'sor-luke-skywalker' })).status, 409);
      const row = await adapter.read(id);
      await adapter.compareAndSwap(id, row.revision, { ...row, revision: row.revision + 1, expiresAt: Date.now() - 1 });
      assert.equal((await b.request(`/api/rooms/${id}`, undefined, host)).status, 410);
    });
  } finally { await Promise.all(workers.map(worker => worker.close())); }
});

test('Supabase room adapter uses the private atomic RPC and never leaks its failure response', async () => {
  const calls = []; const id = randomUUID();
  const adapter = createSupabaseRoomAdapter({ url: 'https://example.supabase.co', key: 'private-server-key', fetcher: async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify(options.method === 'POST' ? true : [{ document: { id, revision: 4 } }]));
  } });
  assert.deepEqual(await adapter.read(id), { id, revision: 4 });
  assert.equal(await adapter.compareAndSwap(id, 4, { id, revision: 5 }), true);
  assert.equal(calls[1].options.headers.Authorization, 'Bearer private-server-key');
  assert.equal(new URL(calls[1].url).pathname, '/rest/v1/rpc/swu_compare_room');
  assert.deepEqual(JSON.parse(calls[1].options.body), { p_id: id, p_expected_revision: 4, p_document: { id, revision: 5 } });
  const broken = createSupabaseRoomAdapter({ url: 'https://example.supabase.co', key: 'secret', fetcher: async () => new Response('secret internal details', { status: 500 }) });
  await assert.rejects(broken.read(id), error => error.status === 503 && !error.message.includes('secret'));
});
