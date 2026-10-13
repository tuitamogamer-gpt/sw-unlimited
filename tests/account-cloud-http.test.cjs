'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { once } = require('node:events');
const { randomBytes } = require('node:crypto');
const express = require('express');
const { createAccountSyncRouter } = require('../server/account-sync.cjs');
const { createAccountStore, createMemoryAccountAdapter } = require('../server/account-store.cjs');
const { importCustomDeck } = require('../server/custom-decks.cjs');
const { createRecord, sealRecord } = require('../server/replay.cjs');
const decks = require('../data/decks.json');
process.env.SWU_SESSION_SECRET ||= randomBytes(32).toString('hex');
const owner = `google_${'a'.repeat(64)}`;
const other = 'supabase_12345678-1234-1234-1234-123456789abc';

async function worker({ store = createAccountStore({ adapter: createMemoryAccountAdapter() }), ownerId = owner, ...injections } = {}) {
  const app = express(); let origin;
  app.use(express.json({ limit: '1mb' }));
  app.use(createAccountSyncRouter({ store, origin: () => origin,
    authenticate: async req => req.get('cookie') === 'verified-test-session=1' ? { id: ownerId } : null,
    logger: { error() {} }, ...injections }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, async request(path = '/api/account/saves', { method = 'GET', body, headers = {}, signedIn = true, csrf = true } = {}) {
    const response = await fetch(`${origin}${path}`, { method, headers: {
      ...(signedIn ? { Cookie: 'verified-test-session=1' } : {}), ...(csrf && method !== 'GET' ? { Origin: origin, 'X-SWU-CSRF': '1' } : {}),
      'Content-Type': 'application/json', 'X-SWU-Owner': ownerId, ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, headers: response.headers, data: await response.json() };
  }, async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
const mutation = (value, expectedVersion = 0) => ({ method: 'PATCH', body: { operations: [{ kind: 'preferences', expectedVersion, value }] } });

test('cloud HTTP authenticates owner server-side and isolates account reads despite spoofed identity inputs', async () => {
  const store = createAccountStore({ adapter: createMemoryAccountAdapter() });
  const first = await worker({ store }); const second = await worker({ store, ownerId: other });
  try {
    assert.equal((await first.request(undefined, { signedIn: false, headers: { 'x-account-id': owner } })).status, 401);
    const saved = await first.request(undefined, mutation({ difficulty: 'easy' }));
    assert.equal(saved.status, 200); assert.equal(saved.data.preferences.version, 1);
    assert.equal(saved.headers.get('cache-control'), 'private, no-store'); assert.equal(saved.headers.get('vary'), 'Cookie');
    assert.equal((await second.request(`/api/account/saves?ownerId=${owner}`, { headers: { 'x-account-id': owner } })).data.preferences.value, null);
    assert.equal((await first.request(undefined, { ...mutation({ difficulty: 'hard' }, 1), body: { ...mutation({}).body, ownerId: other } })).status, 400);
    assert.equal((await first.request()).data.preferences.value.difficulty, 'easy');
    const stale = await first.request(undefined, mutation({ difficulty: 'hard' }));
    assert.equal(stale.status, 409); assert.equal(stale.data.code, 'ACCOUNT_CONFLICT');
    assert.equal(stale.data.snapshot.preferences.value.difficulty, 'easy');
  } finally { await Promise.all([first.close(), second.close()]); }
});

test('cloud mutations reject missing CSRF, foreign origins, non-JSON and invalid preference schemas', async () => {
  const instance = await worker();
  try {
    for (const options of [
      { ...mutation({ compact: true }), csrf: false },
      { ...mutation({ compact: true }), headers: { Origin: 'https://attacker.example' } },
      { ...mutation({ compact: true }), headers: { 'sec-fetch-site': 'cross-site' } },
    ]) assert.equal((await instance.request(undefined, options)).status, 403);
    assert.equal((await instance.request(undefined, { ...mutation({ compact: true }), headers: { 'Content-Type': 'text/plain' } })).status, 415);
    for (const value of [{ difficulty: 'cheater' }, { compact: 1 }, { deckId: '../sensitive' }, { ownerId: other }, { language: 'xx' }]) {
      assert.equal((await instance.request(undefined, mutation(value))).status, 400);
    }
    assert.equal((await instance.request()).data.revision, 0);
  } finally { await instance.close(); }
});

test('account header is a verified-owner precondition that rejects old client requests after an account switch', async () => {
  const store = createAccountStore({ adapter: createMemoryAccountAdapter() });
  const first = await worker({ store }); const switched = await worker({ store, ownerId: other });
  try {
    assert.equal((await first.request(undefined, mutation({ difficulty: 'easy' }))).status, 200);
    const oldRead = await switched.request(undefined, { headers: { 'X-SWU-Owner': owner } });
    assert.equal(oldRead.status, 401); assert.equal(oldRead.data.code, 'ACCOUNT_CHANGED');
    const oldWrite = await switched.request(undefined, { ...mutation({ difficulty: 'hard' }), headers: { 'X-SWU-Owner': owner } });
    assert.equal(oldWrite.status, 401); assert.equal(oldWrite.data.code, 'ACCOUNT_CHANGED');
    assert.equal((await store.read(other)).revision, 0, 'A rejected old-client request leaves the newly signed-in account untouched.');
    assert.equal((await store.read(owner)).preferences.value.difficulty, 'easy');
    assert.equal((await switched.request(undefined, { headers: { 'X-SWU-Owner': '' } })).status, 401);
    const current = await switched.request(undefined, mutation({ difficulty: 'normal' }));
    assert.equal(current.status, 200); assert.equal(current.data.preferences.value.difficulty, 'normal');
    assert.equal((await first.request()).data.preferences.value.difficulty, 'easy');
  } finally { await Promise.all([first.close(), switched.close()]); }
});

test('deck cloud saves are rebuilt from server card data and illegal/tampered identities never commit', { timeout: 60_000 }, async () => {
  const instance = await worker();
  try {
    const imported = await importCustomDeck(decks[0], { name: 'Saved Rebels' });
    assert.equal(imported.errors.length, 0);
    const input = structuredClone(imported.deck); input.cards[0].card.power = 999; input.cards[0].card.text = 'Client invented effect'; input.leader.name = 'Invented Leader';
    const body = { operations: [{ kind: 'deck', id: imported.deck.id, expectedVersion: 0, value: input }] };
    const saved = await instance.request(undefined, { method: 'PATCH', body });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    const canonicalCard = saved.data.decks[0].value.cards.find(row => row.card.id === imported.deck.cards[0].card.id).card;
    assert.equal(canonicalCard.power, imported.deck.cards[0].card.power);
    assert.notEqual(canonicalCard.text, 'Client invented effect');
    assert.equal(saved.data.decks[0].value.leader.name, imported.deck.leader.name);
    assert.equal(saved.data.decks[0].value.savedAt > 0, true);
    const invalid = structuredClone(body); invalid.operations[0].id = `custom-${'b'.repeat(24)}`;
    assert.equal((await instance.request(undefined, { method: 'PATCH', body: invalid })).status, 422);
    const illegal = structuredClone(body); illegal.operations[0].expectedVersion = 1; illegal.operations[0].value.recipe.deck[0].count = 99;
    assert.equal((await instance.request(undefined, { method: 'PATCH', body: illegal })).status, 422);
    assert.equal((await instance.request()).data.decks[0].version, 1);
  } finally { await instance.close(); }
});

test('native encrypted checkpoints must match the game ID and restoration only reads the authenticated cloud document', { timeout: 60_000 }, async () => {
  const store = createAccountStore({ adapter: createMemoryAccountAdapter() });
  const calls = [];
  const instance = await worker({ store, restoreCheckpoint: async (saved, { ownerId }) => { calls.push({ saved, ownerId }); return { id: saved.gameId, sessionToken: saved.sessionToken, restored: true }; } });
  const stranger = await worker({ store, ownerId: other, restoreCheckpoint: async () => { throw new Error('Must not restore another account'); } });
  const { record, game } = await createRecord({ playerDeck: decks[0], botDeck: decks[1], seed: 'cloud-checkpoint' });
  try {
    const token = sealRecord(record);
    const update = value => ({ method: 'PATCH', body: { operations: [{ kind: 'currentGame', expectedVersion: 0, value }] } });
    assert.equal((await instance.request(undefined, update({ gameId: record.id, sessionToken: 'swu1.invalid' }))).status, 401);
    assert.equal((await instance.request(undefined, update({ gameId: '11111111-1111-1111-1111-111111111111', sessionToken: token }))).status, 401);
    assert.equal((await instance.request(undefined, update({ gameId: record.id, sessionToken: token, actionCount: 999 }))).status, 400);
    const saved = await instance.request(undefined, update({ gameId: record.id, sessionToken: token }));
    assert.equal(saved.status, 200); assert.equal(saved.data.currentGame.value.actionCount, record.actions.length);
    assert.equal(saved.data.currentGame.value.deckId, record.deckId); assert.equal(saved.data.currentGame.value.seed, undefined);
    const restored = await instance.request('/api/account/saves/current-game/restore', { method: 'POST', body: {} });
    assert.equal(restored.status, 200); assert.equal(restored.data.id, record.id);
    assert.equal(calls[0].ownerId, owner); assert.equal(calls[0].saved.sessionToken, token);
    assert.equal((await stranger.request('/api/account/saves/current-game/restore', { method: 'POST', body: {} })).status, 404);
    assert.equal((await instance.request('/api/account/saves/current-game/restore', { method: 'POST', body: { gameId: record.id } })).status, 400);
  } finally { game.close(); await Promise.all([instance.close(), stranger.close()]); }
});

test('match history and training accept native validators and union previously completed lessons', async () => {
  const checks = [];
  const instance = await worker({
    validateMatch: async (value, context) => { checks.push({ value, context }); return { gameId: context.gameId, outcome: 'human', moments: [] }; },
    validateTraining: async value => ({ completedLessonIds: [value.lessonForServerOnlyTest] }),
  });
  try {
    const id = '11111111-1111-1111-1111-111111111111';
    const saved = await instance.request(undefined, { method: 'PATCH', body: { operations: [
      { kind: 'match', id, expectedVersion: 0, value: { gameId: id, sessionToken: 'validated-by-server-injection' } },
      { kind: 'training', expectedVersion: 0, value: { lessonForServerOnlyTest: 'resources' } },
    ] } });
    assert.equal(saved.status, 200); assert.equal(saved.data.matches[0].value.outcome, 'human');
    assert.equal(checks[0].context.ownerId, owner); assert.equal(checks[0].context.gameId, id);
    const updated = await instance.request(undefined, { method: 'PATCH', body: { operations: [{ kind: 'training', expectedVersion: 1, value: { lessonForServerOnlyTest: 'space-ambush' } }] } });
    assert.equal(updated.status, 200); assert.deepEqual(updated.data.training.value.completedLessonIds, ['resources', 'space-ambush']);
  } finally { await instance.close(); }
  const unavailable = await worker();
  try {
    const notProof = await unavailable.request(undefined, { method: 'PATCH', body: { operations: [{ kind: 'training', expectedVersion: 0, value: { completedLessonIds: ['resources'] } }] } });
    assert.equal(notProof.status, 503); assert.equal(notProof.data.code, 'ACCOUNT_TRAINING_UNAVAILABLE');
  } finally { await unavailable.close(); }
});
