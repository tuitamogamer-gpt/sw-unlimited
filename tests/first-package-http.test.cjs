'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { once } = require('node:events');
const { randomBytes } = require('node:crypto');
const express = require('express');
const { createApplication } = require('../server/index.cjs');
const { createAccountStore, createMemoryAccountAdapter } = require('../server/account-store.cjs');
const { createRecord, applyAction, sealRecord, decodeRecord, bindAccountCheckpoint, SESSION_TTL, ACCOUNT_RETENTION } = require('../server/replay.cjs');
const { createTraining, trainingGameView, assertTrainingAction, advanceTraining } = require('../server/training.cjs');
const { chooseAction } = require('../server/bot.cjs');
const { captureReviewDecision, commitReviewDecision, publicReview } = require('../server/match-review.cjs');
const { readDecks, assertPrivateView } = require('../scripts/smoke.cjs');

process.env.SWU_SESSION_SECRET ||= randomBytes(32).toString('hex');
const owner = 'supabase_12345678-1234-1234-1234-123456789abc';
const other = `google_${'b'.repeat(64)}`;
const decks = readDecks();

async function worker({ store = createAccountStore({ adapter: createMemoryAccountAdapter() }), ownerId = owner } = {}) {
  let origin;
  const { app } = createApplication({ auth: express.Router(), accountStore: store, accountOrigin: () => origin,
    // Identity is a trusted fixture session, never read from an owner header or
    // request body. The expected-owner header is only a race precondition.
    authenticate: async req => req.get('cookie') === 'server-verified-fixture=1' ? { id: ownerId } : null });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    async request(path, body, method = body === undefined ? 'GET' : 'POST', headers = {}) {
      const response = await fetch(`${origin}${path}`, { method,
        headers: { 'Content-Type': 'application/json', Cookie: 'server-verified-fixture=1',
          Origin: origin, 'X-SWU-CSRF': '1', 'X-SWU-Owner': ownerId, ...headers },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, data: response.status === 204 ? null : await response.json() };
    },
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}
const proof = view => ({ gameId: view.id, sessionToken: view.sessionToken });
const operation = (kind, value, expectedVersion = 0, id) => ({ kind, value, expectedVersion, ...(id ? { id } : {}) });
const save = (instance, operations) => instance.request('/api/account/saves', { operations }, 'PATCH');
async function submit(instance, view, action) {
  const response = await instance.request(`/api/games/${view.id}/actions`, { ...action, version: view.version, promptId: view.prompt.id, sessionToken: view.sessionToken });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.ok(response.data.version > view.version);
  return response.data;
}
async function completedNativeMatch() {
  const session = await createRecord({ playerDeck: decks.find(deck => deck.id === 'sor-luke-skywalker'),
    botDeck: decks.find(deck => deck.id === 'sor-darth-vader'), seed: 123, difficulty: 'normal' });
  const memories = { human: {}, bot: {} };
  try {
    for (let step = 0; step < 1500 && !session.game.view('human').ended; step++) {
      const current = ['human', 'bot'].map(seat => session.game.view(seat)).find(candidate => candidate.prompt.active);
      assert.ok(current, 'The native fixture must expose a real decision until its game ends.');
      const action = chooseAction(current, { difficulty: 'normal', memory: memories[current.viewerId] }).action;
      assert.ok(action);
      const captured = captureReviewDecision(session.record, session.game, action, current.viewerId);
      applyAction(session.record, session.game, action, current.viewerId); commitReviewDecision(session.record, captured, session.game);
    }
    assert.equal(session.game.view('human').ended, true); return session;
  } catch (error) { session.game.close(); throw error; }
}

test('real HTTP training guides native resource decisions, recovers rejected actions and saves only verified completion', { timeout: 60_000 }, async () => {
  const store = createAccountStore({ adapter: createMemoryAccountAdapter() });
  const first = await worker({ store }); const fresh = await worker({ store });
  let view;
  try {
    const catalog = await first.request('/api/training');
    assert.equal(catalog.status, 200);
    assert.deepEqual(catalog.data.lessons.map(lesson => lesson.id), ['resources', 'space-ambush', 'leader-deploy']);
    const created = await first.request('/api/training/resources', {});
    assert.equal(created.status, 201, JSON.stringify(created.data)); view = created.data;
    assert.equal(view.training.status, 'active'); assert.equal(view.prompt.stage, 'resource');
    assert.equal(view.players.human.resourceCount, 0); assert.equal(view.review, null); assertPrivateView(view);
    const unfinished = await save(first, [operation('training', proof(view))]);
    assert.equal(unfinished.status, 422); assert.equal(unfinished.data.code, 'ACCOUNT_TRAINING_UNFINISHED');
    assert.equal((await store.read(owner)).training.value, null);
    const bypass = await first.request(`/api/games/${view.id}/actions`, { type: 'button', arg: 'done', promptId: view.prompt.id, version: view.version, sessionToken: view.sessionToken });
    assert.equal(bypass.status, 400, 'Native lesson guards reject early confirmation even when a command is sent directly.');
    // The failed action discards its worker instance. Ordinary checkpoint
    // recovery must still restore the lesson and its guided legal choices.
    view = await submit(first, view, view.legalActions.find(action => action.type === 'card'));
    const nextCard = view.legalActions.find(action => action.type === 'card' && !view.prompt.selectedCardIds.includes(action.cardId));
    view = await submit(first, view, nextCard);
    assert.equal(view.training.step, 2);
    view = await submit(first, view, view.legalActions.find(action => action.arg === 'done'));
    assert.equal(view.training.status, 'complete'); assert.equal(view.players.human.resourceCount, 2);
    assert.deepEqual(view.legalActions, []);
    const saved = await save(first, [operation('training', proof(view))]);
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    assert.deepEqual(saved.data.training.value.completedLessonIds, ['resources']);
    const rawClaim = await save(first, [operation('training', { completedLessonIds: ['leader-deploy'] }, 1)]);
    assert.equal(rawClaim.status, 400, 'Browser claims cannot add a completed lesson.');
    const recovered = await fresh.request(`/api/games/${view.id}/state`, { sessionToken: view.sessionToken });
    assert.equal(recovered.status, 200); assert.equal(recovered.data.training.status, 'complete');
    assert.equal(recovered.data.version, view.version); assert.deepEqual(recovered.data.players, view.players);
  } finally {
    if (view) for (const instance of [first, fresh]) await instance.request(`/api/games/${view.id}`, { sessionToken: view.sessionToken }, 'DELETE');
    await Promise.all([first.close(), fresh.close()]);
  }
});

test('real account restore binds its owner, preserves native board versions and refreshes an expired six-hour checkpoint privately', { timeout: 60_000 }, async () => {
  const store = createAccountStore({ adapter: createMemoryAccountAdapter() });
  const first = await worker({ store }); const fresh = await worker({ store }); const stranger = await worker({ store, ownerId: other });
  const originalNow = Date.now; let view;
  try {
    const created = await first.request('/api/games', { deckId: 'sor-luke-skywalker', opponentDeckId: 'sor-darth-vader', difficulty: 'easy' });
    assert.equal(created.status, 201); view = created.data;
    const ongoingMatch = await save(first, [operation('match', proof(view), 0, view.id)]);
    assert.equal(ongoingMatch.status, 422); assert.equal(ongoingMatch.data.code, 'ACCOUNT_MATCH_UNFINISHED');
    const saved = await save(first, [operation('currentGame', proof(view))]);
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    let checkpoint = saved.data.currentGame.value;
    let record = decodeRecord(checkpoint.sessionToken, { id: view.id });
    assert.equal(record.accountOwnerId, owner); assert.equal(checkpoint.version, view.version);
    assert.equal(checkpoint.actionCount, record.actions.length);
    view = await submit(first, view, view.legalActions[0]);
    const cachedRestore = await first.request('/api/account/saves/current-game/restore', {});
    assert.equal(cachedRestore.status, 200, JSON.stringify(cachedRestore.data));
    assert.equal(cachedRestore.data.version, view.version, 'Restoring an older cloud checkpoint cannot replace a newer cached native board.');
    assert.deepEqual(cachedRestore.data.players, view.players);
    view = cachedRestore.data;
    const renewedSave = await save(first, [operation('currentGame', proof(view), 1)]);
    assert.equal(renewedSave.status, 200);
    checkpoint = renewedSave.data.currentGame.value;
    record = decodeRecord(checkpoint.sessionToken, { id: view.id });
    const cloudRead = await fresh.request('/api/account/saves');
    assert.equal(cloudRead.status, 200); assert.deepEqual(cloudRead.data.currentGame.value, checkpoint);
    const wrongOwner = await save(stranger, [operation('currentGame', { gameId: checkpoint.gameId, sessionToken: checkpoint.sessionToken })]);
    assert.equal(wrongOwner.status, 403); assert.equal(wrongOwner.data.code, 'ACCOUNT_CHECKPOINT_OWNER');
    const staleClient = await fresh.request('/api/account/saves', undefined, 'GET', { 'X-SWU-Owner': other });
    assert.equal(staleClient.status, 401); assert.equal(staleClient.data.code, 'ACCOUNT_CHANGED');
    const future = record.expiresAt + 1;
    Date.now = () => future;
    const expiredGuest = await fresh.request(`/api/games/${view.id}/state`, { sessionToken: checkpoint.sessionToken });
    assert.equal(expiredGuest.status, 410, 'An ordinary game route cannot bypass the six-hour checkpoint lifetime.');
    const restored = await fresh.request('/api/account/saves/current-game/restore', {});
    assert.equal(restored.status, 200, JSON.stringify(restored.data));
    assert.equal(restored.data.id, view.id); assert.equal(restored.data.version, view.version);
    assert.deepEqual(restored.data.players, view.players); assert.deepEqual(restored.data.legalActions, view.legalActions);
    assertPrivateView(restored.data);
    view = restored.data;
    const renewed = decodeRecord(view.sessionToken, { id: view.id });
    assert.equal(renewed.accountOwnerId, owner); assert.equal(renewed.createdAt, future);
    assert.equal(renewed.expiresAt, future + SESSION_TTL); assert.equal(renewed.originalCreatedAt, record.originalCreatedAt || record.createdAt);
    assert.deepEqual(renewed.actions, record.actions);
    const changedRestore = await fresh.request('/api/account/saves/current-game/restore', {}, 'POST', { 'X-SWU-Owner': other });
    assert.equal(changedRestore.status, 401); assert.equal(changedRestore.data.code, 'ACCOUNT_CHANGED');
    assert.equal((await store.read(other)).currentGame.value, null);
  } finally {
    // Close cached games while the renewed checkpoint's clock is still valid.
    if (view) for (const instance of [first, fresh]) await instance.request(`/api/games/${view.id}`, { sessionToken: view.sessionToken }, 'DELETE');
    Date.now = originalNow;
    await Promise.all([first.close(), fresh.close(), stranger.close()]);
  }
});

test('actual match-history route derives its review from a completed native replay and rejects client summary fields', { timeout: 60_000 }, async () => {
  const instance = await worker();
  const { record, game } = await completedNativeMatch();
  try {
    const expected = publicReview(record, game); assert.ok(expected);
    const native = { gameId: record.id, sessionToken: sealRecord(record) };
    const injectedStats = await save(instance, [operation('match', { ...native, review: { outcome: 'win', stats: { baseDamage: 99999 } } }, 0, record.id)]);
    assert.equal(injectedStats.status, 400, 'Only an opaque native proof may authorize a completed match entry.');
    const saved = await save(instance, [operation('match', native, 0, record.id)]);
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    assert.equal(saved.data.matches.length, 1);
    const summary = saved.data.matches[0].value;
    assert.deepEqual(summary.review, expected); assert.equal(summary.gameId, record.id);
    assert.equal(summary.playerLeader, game.view('human').players.human.leader.name);
    assert.equal(summary.opponentLeader, game.view('human').players.bot.leader.name);
    assert.equal(summary.difficulty, 'normal'); assert.ok(summary.completedAt >= record.createdAt);
    for (const privateField of ['sessionToken', 'seed', 'actions', 'memory', 'playerDeck', 'opponentDeck']) assert.equal(summary[privateField], undefined);
    assert.ok(summary.review.moments.length <= 3);
  } finally { game.close(); await instance.close(); }
});

test('a cached native game preserves account binding on state reads and actions using its cloud checkpoint', { timeout: 60_000 }, async () => {
  const instance = await worker(); let view;
  try {
    const created = await instance.request('/api/games', { deckId: 'sor-luke-skywalker', opponentDeckId: 'sor-darth-vader', difficulty: 'easy' });
    assert.equal(created.status, 201); view = created.data;
    const saved = await save(instance, [operation('currentGame', proof(view))]);
    assert.equal(saved.status, 200);
    const boundToken = saved.data.currentGame.value.sessionToken;
    assert.equal(decodeRecord(boundToken).accountOwnerId, owner);
    const state = await instance.request(`/api/games/${view.id}/state`, { sessionToken: boundToken });
    assert.equal(state.status, 200); view = state.data;
    const stateOwner = decodeRecord(view.sessionToken).accountOwnerId;
    view = await submit(instance, { ...view, sessionToken: boundToken }, view.legalActions[0]);
    const actionOwner = decodeRecord(view.sessionToken).accountOwnerId;
    assert.deepEqual([{ step: 'state', owner: stateOwner }, { step: 'action', owner: actionOwner }],
      [{ step: 'state', owner }, { step: 'action', owner }], 'Every newly sealed checkpoint must retain the account binding of its verified input.');
  } finally {
    if (view) await instance.request(`/api/games/${view.id}`, { sessionToken: view.sessionToken }, 'DELETE');
    await instance.close();
  }
});

test('delayed bound account proofs survive offline queues while expired guest, wrong-owner and over-retention proofs stay rejected', { timeout: 60_000 }, async () => {
  const store = createAccountStore({ adapter: createMemoryAccountAdapter() });
  const instance = await worker({ store }); const stranger = await worker({ store, ownerId: other });
  const lesson = await createTraining('resources', { decks });
  const match = await completedNativeMatch(); const originalNow = Date.now;
  try {
    while (trainingGameView(lesson.record, lesson.game).training.status !== 'complete') {
      const view = trainingGameView(lesson.record, lesson.game);
      const action = view.legalActions.find(candidate => candidate.arg === 'done')
        || view.legalActions.find(candidate => candidate.type === 'card' && !view.prompt.selectedCardIds.includes(candidate.cardId));
      assert.ok(action); assertTrainingAction(lesson.record, lesson.game, action);
      applyAction(lesson.record, lesson.game, action); advanceTraining(lesson.record, lesson.game);
    }
    const expectedReview = publicReview(match.record, match.game);
    const guestMatchToken = sealRecord(match.record);
    const boundMatch = bindAccountCheckpoint(guestMatchToken, { id: match.record.id, ownerId: owner });
    const boundTraining = bindAccountCheckpoint(sealRecord(lesson.record), { id: lesson.record.id, ownerId: owner });
    const value = bound => ({ gameId: bound.gameId, sessionToken: bound.sessionToken });
    const future = Math.max(boundMatch.expiresAt, boundTraining.expiresAt) + 1;
    Date.now = () => future;
    const saved = await save(instance, [operation('currentGame', value(boundMatch)), operation('training', value(boundTraining)),
      operation('match', value(boundMatch), 0, boundMatch.gameId)]);
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    assert.deepEqual(saved.data.training.value.completedLessonIds, ['resources']);
    assert.deepEqual(saved.data.matches[0].value.review, expectedReview);
    const renewed = decodeRecord(saved.data.currentGame.value.sessionToken, { id: match.record.id });
    assert.equal(renewed.accountOwnerId, owner); assert.equal(renewed.createdAt, future);
    assert.equal(renewed.expiresAt, future + SESSION_TTL);
    assert.equal(saved.data.currentGame.value.version, match.game.view('human').version);
    assert.deepEqual(renewed.actions, match.record.actions, 'The queue renewal preserves every verified native decision.');
    const expiredGuest = await save(instance, [operation('currentGame', { gameId: match.record.id, sessionToken: guestMatchToken }, 1)]);
    assert.equal(expiredGuest.status, 403); assert.equal(expiredGuest.data.code, 'ACCOUNT_CHECKPOINT_OWNER');
    const wrongOwner = await save(stranger, [operation('training', value(boundTraining))]);
    assert.equal(wrongOwner.status, 403); assert.equal(wrongOwner.data.code, 'ACCOUNT_CHECKPOINT_OWNER');
    assert.equal((await store.read(other)).revision, 0);
    Date.now = () => future + ACCOUNT_RETENTION;
    const tooOld = await save(instance, [operation('currentGame', value(boundMatch), 1)]);
    assert.equal(tooOld.status, 410); assert.equal(tooOld.data.code, 'ACCOUNT_CHECKPOINT_EXPIRED');
    assert.equal((await store.read(owner)).currentGame.version, 1, 'Rejected proofs never replace a renewed cloud save.');
  } finally {
    Date.now = originalNow; lesson.game.close(); match.game.close(); await Promise.all([instance.close(), stranger.close()]);
  }
});
