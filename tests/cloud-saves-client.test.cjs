'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

function browserModule(relativePath) {
  const filename = path.resolve(__dirname, '..', relativePath);
  const compiled = new Module(filename, module);
  compiled.require = requested => requested === '../custom-decks' ? browserModule('src/custom-decks.ts') : require(requested);
  compiled._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, filename);
  return compiled.exports;
}
const { createCloudSaveClient, MATCH_HISTORY_KEY, TRAINING_PROGRESS_KEY } = browserModule('src/account/cloud-saves.ts');
const { createAccountStorage } = browserModule('src/account/storage.ts');
const { readCustomDecks, upsertCustomDeck, removeStoredCustomDeck, CUSTOM_DECKS_KEY } = browserModule('src/custom-decks.ts');
const SESSION = 'swu-command-session', PREFS = 'swu-command-preferences';
const checkpointKey = id => `swu-command-checkpoint:${id}`;
const tokenKey = id => `swu-command-state:${id}`;
const copy = value => structuredClone(value);
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => copy(data) });
function disk() {
  const values = new Map();
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
function deck(id, name = id) {
  const leader = { id: 'SOR_005', name: 'Luke Skywalker' }, base = { id: 'SOR_029', name: 'Capital City' };
  return { id: `custom-${id}`, name, custom: true, leader, base, cards: [{ count: 3, card: { id: 'SOR_195', name: 'Auzituck Liberator Gunship' } }],
    validation: { valid: true, errors: [], warnings: [] }, savedAt: 10,
    recipe: { custom: true, id: `custom-${id}`, name, metadata: { name }, leader: { id: leader.id, count: 1 }, base: { id: base.id, count: 1 }, deck: [{ id: 'SOR_195', count: 3 }], sideboard: [] } };
}
function snapshot() { return { enabled: true, revision: 0, decks: [], preferences: { version: 0, value: null }, currentGame: { version: 0, value: null }, matches: [], training: { version: 0, value: null } }; }
function checkpoint(storage, id, version, token = `swu1.${id}-turn-${version}`) {
  storage.setItem(checkpointKey(id), JSON.stringify({ id, version, sessionToken: token }));
  storage.setItem(SESSION, id);
  storage.setItem(tokenKey(id), token);
}
function server() {
  let state = snapshot(), offline = false;
  const calls = [];
  const record = operation => {
    if (operation.kind === 'deck' || operation.kind === 'match') return state[operation.kind === 'deck' ? 'decks' : 'matches'].find(item => item.id === operation.id) || { version: 0, value: null };
    return state[operation.kind];
  };
  const fetch = async (url, init) => {
    calls.push({ url, init: { ...init, signal: undefined }, body: init.body ? JSON.parse(init.body) : null });
    if (offline) throw new Error('offline');
    assert.equal(init.headers.Authorization, 'Bearer account-token');
    assert.equal(init.credentials, 'same-origin');
    if (init.method === 'GET') return response(state);
    assert.equal(init.headers['X-SWU-CSRF'], '1');
    if (url.endsWith('/restore')) {
      const saved = state.currentGame.value;
      const player = { base: {}, leader: {}, hand: [], ground: [], space: [], resources: [], discard: [], leaders: [] };
      return response({ id: saved.gameId, version: saved.version, sessionToken: `swu1.restored-${saved.version}`, phase: 'action', round: 1,
        players: { human: player, bot: player }, prompt: { buttons: [], selectedCardIds: [], selectableCardIds: [], displayCards: [] }, legalActions: [], winnerIds: [], log: [] });
    }
    const operations = JSON.parse(init.body).operations;
    if (operations.some(operation => record(operation).version !== operation.expectedVersion)) return response({ code: 'ACCOUNT_CONFLICT', snapshot: state }, 409);
    for (const operation of operations) {
      const old = record(operation);
      let value = operation.value;
      if (operation.kind === 'deck' && value) value = { ...deck(value.id.replace('custom-', ''), value.name), recipe: value };
      if (operation.kind === 'currentGame' && value) value = { ...value, version: Number(value.sessionToken.match(/-(\d+)$/)?.[1] || 0) };
      if (operation.kind === 'match' && value) value = { gameId: value.gameId, review: { winner: 'human' }, completedAt: '2030-01-01T00:00:00Z' };
      if (operation.kind === 'training' && value) value = { completedLessonIds: [...new Set([...(old.value?.completedLessonIds || []), value.gameId])] };
      const next = { version: old.version + 1, value, updatedAt: 20, ...(operation.id ? { id: operation.id, deleted: value === null } : {}) };
      if (operation.id) {
        const list = state[operation.kind === 'deck' ? 'decks' : 'matches'];
        state[operation.kind === 'deck' ? 'decks' : 'matches'] = [...list.filter(item => item.id !== operation.id), next];
      } else state[operation.kind] = next;
    }
    state.revision++;
    return response(state);
  };
  return { fetch, calls, state: () => copy(state), replace: next => { state = copy(next); }, offline: value => { offline = value; } };
}
function device(service, sharedDisk = disk(), ownerId = 'owner_A') {
  const scoped = createAccountStorage(ownerId, sharedDisk);
  const statuses = [];
  const client = createCloudSaveClient({ ownerId, storage: scoped, fetch: service.fetch, getAccessToken: async () => 'account-token', onStatus: status => statuses.push(status), debounceMs: 100_000 });
  return { client, storage: scoped, disk: sharedDisk, statuses };
}
const patchCalls = service => service.calls.filter(call => call.init.method === 'PATCH');

test('a second device loads its account decks, settings and signed checkpoint before any default settings upload', async () => {
  const service = server(), first = device(service);
  await first.client.load();
  upsertCustomDeck(deck('fleet', 'Rebel Fleet'), first.client.storage);
  first.client.storage.setItem(PREFS, JSON.stringify({ deckId: 'custom-fleet', difficulty: 'easy', compact: true }));
  checkpoint(first.client.storage, 'game_A', 7);
  await first.client.flush();
  const writes = patchCalls(service).length;
  const second = device(service);
  await second.client.load();
  assert.equal(readCustomDecks(second.client.storage)[0].name, 'Rebel Fleet');
  assert.equal(JSON.parse(second.storage.getItem(PREFS)).difficulty, 'easy');
  assert.deepEqual(JSON.parse(second.storage.getItem(checkpointKey('game_A'))), { id: 'game_A', version: 7, sessionToken: 'swu1.game_A-turn-7' });
  await second.client.flush();
  assert.equal(patchCalls(service).length, writes, 'Hydrating an account never replaces cloud settings with mount defaults.');
  assert.equal(second.client.getStatus().state, 'synced');
  first.client.dispose(); second.client.dispose();
});

test('offline writes survive a reload and tombstones prevent old local decks from reappearing', async () => {
  const service = server(), localDisk = disk(), original = device(service, localDisk);
  await original.client.load();
  service.offline(true);
  upsertCustomDeck(deck('new'), original.client.storage);
  original.client.storage.setItem(PREFS, JSON.stringify({ difficulty: 'easy' }));
  await original.client.flush();
  assert.equal(original.client.getStatus().state, 'offline');
  original.client.dispose();
  const remote = snapshot(); remote.revision = 3; remote.decks = [{ id: 'custom-old', version: 3, value: null, deleted: true }]; service.replace(remote);
  const scoped = createAccountStorage('owner_A', localDisk);
  upsertCustomDeck(deck('old'), scoped);
  service.offline(false);
  const reloaded = device(service, localDisk);
  await reloaded.client.load(); await reloaded.client.flush();
  assert.deepEqual(readCustomDecks(reloaded.storage).map(item => item.id), ['custom-new']);
  assert.equal(service.state().preferences.value.difficulty, 'easy');
  assert.equal(service.state().decks.find(item => item.id === 'custom-old').deleted, true);
  assert.ok(patchCalls(service).every(call => call.body.operations.every(operation => operation.id !== 'custom-old')));
  reloaded.client.dispose();
});

test('simultaneous edits to independent decks merge while an edit to the same deck needs an explicit choice', async () => {
  const service = server(), a = device(service), b = device(service);
  await Promise.all([a.client.load(), b.client.load()]);
  upsertCustomDeck(deck('a'), a.client.storage); upsertCustomDeck(deck('b'), b.client.storage);
  await a.client.flush(); await b.client.flush();
  assert.deepEqual(service.state().decks.map(item => item.id).sort(), ['custom-a', 'custom-b']);
  assert.equal(b.client.getStatus().conflicts.length, 0);
  await a.client.load();
  upsertCustomDeck(deck('a', 'This device draft'), a.client.storage);
  upsertCustomDeck(deck('a', 'Other device draft'), b.client.storage);
  await b.client.flush(); await a.client.flush();
  assert.equal(a.client.getStatus().state, 'conflict');
  assert.equal(readCustomDecks(a.storage).find(item => item.id === 'custom-a').name, 'This device draft');
  assert.equal(service.state().decks.find(item => item.id === 'custom-a').value.name, 'Other device draft');
  await a.client.resolveConflict('deck:custom-a', 'cloud');
  assert.equal(readCustomDecks(a.storage).find(item => item.id === 'custom-a').name, 'Other device draft');
  assert.equal(a.client.getStatus().conflicts.length, 0);
  a.client.dispose(); b.client.dispose();
});

test('a conflicting current game keeps its local turn until chosen and never uploads an older checkpoint', async () => {
  const service = server(), a = device(service), b = device(service);
  await a.client.load(); checkpoint(a.client.storage, 'game_A', 2); await a.client.flush(); await b.client.load();
  checkpoint(a.client.storage, 'game_A', 3); checkpoint(b.client.storage, 'game_A', 4); await b.client.flush(); await a.client.flush();
  assert.equal(a.client.getStatus().conflicts[0].kind, 'currentGame');
  assert.equal(a.client.getStatus().conflicts[0].canKeepLocal, false);
  await assert.rejects(a.client.resolveConflict('currentGame', 'local'), error => error.code === 'OLDER_TURN');
  assert.equal(JSON.parse(a.storage.getItem(checkpointKey('game_A'))).version, 3);
  await a.client.resolveConflict('currentGame', 'cloud');
  assert.equal(JSON.parse(a.storage.getItem(checkpointKey('game_A'))).version, 4);
  const count = patchCalls(service).length;
  checkpoint(a.client.storage, 'game_A', 1); await a.client.flush();
  assert.equal(patchCalls(service).length, count);
  assert.equal(service.state().currentGame.value.version, 4);
  a.client.dispose(); b.client.dispose();
});

test('continuing a game during an upload retains the newer turn in the journal and serializes its next upload', async () => {
  const service = server(), originalFetch = service.fetch;
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  service.fetch = async (url, init) => {
    if (init.method === 'PATCH' && !release) {
      entered(); await new Promise(resolve => { release = resolve; });
    }
    return originalFetch(url, init);
  };
  const a = device(service); await a.client.load();
  checkpoint(a.client.storage, 'game_A', 1);
  const saving = a.client.flush(); await waiting;
  checkpoint(a.client.storage, 'game_A', 2); checkpoint(a.client.storage, 'game_A', 3);
  release(); await saving;
  assert.equal(service.state().currentGame.value.version, 3);
  assert.equal(patchCalls(service).length, 2, 'Only the first and latest turn are uploaded.');
  assert.equal(a.client.getStatus().pendingCount, 0); a.client.dispose();
});

test('several offline native lesson proofs survive reload, merge other-device progress, and save finished match history', async () => {
  const service = server(), shared = disk(), a = device(service, shared);
  await a.client.load(); service.offline(true);
  a.client.saveTraining({ gameId: 'ambush', sessionToken: 'swu1.lesson-ambush' });
  a.client.saveTraining({ gameId: 'resources', sessionToken: 'swu1.lesson-resources' });
  a.client.saveMatch({ gameId: 'match_A', sessionToken: 'swu1.finished-match' });
  a.storage.setItem(TRAINING_PROGRESS_KEY, JSON.stringify({ completedLessonIds: ['ambush', 'resources'] }));
  a.storage.setItem(MATCH_HISTORY_KEY, JSON.stringify([{ gameId: 'match_A', review: { winner: 'human' } }]));
  await a.client.flush(); a.client.dispose();
  const latest = snapshot(); latest.revision = 2; latest.training = { version: 2, value: { completedLessonIds: ['sentinel'] } }; service.replace(latest);
  service.offline(false); const reloaded = device(service, shared);
  await reloaded.client.load();
  assert.deepEqual(JSON.parse(reloaded.storage.getItem(TRAINING_PROGRESS_KEY)).completedLessonIds.sort(), ['ambush', 'resources', 'sentinel'], 'Loading remote progress keeps this device’s pending native completions visible.');
  assert.equal(JSON.parse(reloaded.storage.getItem(MATCH_HISTORY_KEY))[0].gameId, 'match_A', 'A pending match review stays visible before upload confirmation.');
  await reloaded.client.flush();
  assert.deepEqual(JSON.parse(reloaded.storage.getItem(TRAINING_PROGRESS_KEY)).completedLessonIds.sort(), ['ambush', 'resources', 'sentinel']);
  assert.equal(JSON.parse(reloaded.storage.getItem(MATCH_HISTORY_KEY))[0].gameId, 'match_A');
  reloaded.client.removeMatch('match_A'); await reloaded.client.flush();
  assert.deepEqual(JSON.parse(reloaded.storage.getItem(MATCH_HISTORY_KEY)), []);
  assert.equal(service.state().matches[0].deleted, true); reloaded.client.dispose();
});

test('deleting a saved deck on one device cannot be undone by an offline edit without choosing that edit', async () => {
  const service = server(), a = device(service), b = device(service);
  await a.client.load(); upsertCustomDeck(deck('fleet'), a.client.storage); await a.client.flush(); await b.client.load();
  upsertCustomDeck(deck('fleet', 'Offline edit'), b.client.storage);
  removeStoredCustomDeck('custom-fleet', a.client.storage); await a.client.flush(); await b.client.flush();
  assert.equal(b.client.getStatus().state, 'conflict');
  assert.equal(service.state().decks[0].deleted, true);
  await b.client.resolveConflict('deck:custom-fleet', 'local');
  assert.equal(service.state().decks[0].value.name, 'Offline edit');
  assert.equal(service.state().decks[0].deleted, false);
  a.client.dispose(); b.client.dispose();
});

test('sign-out during token lookup prevents sending old-owner requests, and late cloud responses cannot touch another account', async () => {
  const service = server(), shared = disk();
  let resolveToken;
  const delayedToken = new Promise(resolve => { resolveToken = resolve; });
  const oldScope = createAccountStorage('owner_A', shared), nextScope = createAccountStorage('owner_B', shared);
  nextScope.setItem(PREFS, 'B settings');
  const client = createCloudSaveClient({ ownerId: 'owner_A', storage: oldScope, fetch: service.fetch, getAccessToken: () => delayedToken });
  const loading = client.load(); client.dispose(); resolveToken('account-token'); await loading;
  assert.equal(service.calls.length, 0, 'An access token arriving after sign-out cannot start a fetch.');
  assert.equal(nextScope.getItem(PREFS), 'B settings');
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  const lateClient = createCloudSaveClient({ ownerId: 'owner_A', storage: oldScope, getAccessToken: async () => 'account-token', fetch: () => delayed });
  const late = lateClient.load(); await new Promise(resolve => setImmediate(resolve)); lateClient.dispose();
  const remote = snapshot(); remote.preferences = { version: 1, value: { difficulty: 'hard' } }; release(response(remote)); await late;
  assert.equal(oldScope.getItem(PREFS), null, 'Disposed owner cannot hydrate a late response.');
  assert.equal(nextScope.getItem(PREFS), 'B settings');
});

test('restoring a signed account game stores its refreshed native version and excludes the token from the operation identity', async () => {
  const service = server(), remote = snapshot(); remote.revision = 1; remote.currentGame = { version: 1, value: { gameId: 'game_A', version: 9, sessionToken: 'swu1.expired-9' } }; service.replace(remote);
  const a = device(service); await a.client.load(); const view = await a.client.restoreCurrentGame();
  assert.equal(view.version, 9);
  assert.equal(JSON.parse(a.storage.getItem(checkpointKey('game_A'))).sessionToken, 'swu1.restored-9');
  assert.equal(a.storage.getItem(SESSION), 'game_A');
  assert.deepEqual(service.calls.find(call => call.url.endsWith('/restore')).body, {});
  a.client.dispose();
});

test('a journal copied into a different owner scope cannot upload another player’s pending saves', async () => {
  const service = server(), shared = disk(), a = device(service, shared);
  upsertCustomDeck(deck('private'), a.client.storage); a.client.dispose();
  const aScope = createAccountStorage('owner_A', shared), bScope = createAccountStorage('owner_B', shared);
  bScope.setItem('swu-command-cloud-sync:v1', aScope.getItem('swu-command-cloud-sync:v1'));
  const b = device(service, shared, 'owner_B'); await b.client.load(); await b.client.flush();
  assert.deepEqual(service.state().decks, []);
  assert.deepEqual(readCustomDecks(b.storage), []); b.client.dispose();
});

test('an account JWT belonging to a switched user cannot fetch or write cloud saves into the captured old owner', async () => {
  const oldId = '00000000-0000-4000-8000-000000000001', nextId = '00000000-0000-4000-8000-000000000002';
  const jwt = `header.${Buffer.from(JSON.stringify({ sub: nextId })).toString('base64url')}.signature`;
  const storage = createAccountStorage(`supabase_${oldId}`, disk());
  let calls = 0;
  const client = createCloudSaveClient({ ownerId: `supabase_${oldId}`, storage, getAccessToken: async () => jwt, fetch: async () => { calls++; return response(snapshot()); } });
  await client.load();
  assert.equal(calls, 0);
  assert.equal(client.getStatus().state, 'unavailable');
  assert.equal(storage.getItem(CUSTOM_DECKS_KEY), null); client.dispose();
});

test('a timed-out access token lookup does not send a fetch when its result arrives later', async () => {
  let release, calls = 0;
  const delayed = new Promise(resolve => { release = resolve; });
  const client = createCloudSaveClient({ ownerId: 'owner_A', storage: disk(), getAccessToken: () => delayed, timeoutMs: 5, fetch: async () => { calls++; return response(snapshot()); } });
  await client.load();
  assert.equal(client.getStatus().state, 'offline');
  release('account-token'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 0); client.dispose();
});

test('a slow older GET response cannot replace a newer snapshot confirmed by a concurrent upload', async () => {
  const service = server(), nativeFetch = service.fetch;
  let release, entered, delay = false;
  const waiting = new Promise(resolve => { entered = resolve; });
  service.fetch = async (url, init) => {
    if (init.method === 'GET' && delay) {
      const previous = service.state(); entered(); await new Promise(resolve => { release = resolve; }); return response(previous);
    }
    return nativeFetch(url, init);
  };
  const a = device(service); await a.client.load(); delay = true;
  const refreshing = a.client.load(); await waiting;
  upsertCustomDeck(deck('newest'), a.client.storage); await a.client.flush();
  release(); await refreshing;
  assert.equal(a.client.getSnapshot().revision, 1);
  assert.equal(a.client.getSnapshot().decks[0].id, 'custom-newest');
  assert.equal(a.client.getStatus().pendingCount, 0); a.client.dispose();
});

test('an incomplete restore response cannot replace the saved checkpoint or resume pointer', async () => {
  const service = server(), remote = snapshot(); remote.revision = 1; remote.currentGame = { version: 1, value: { gameId: 'game_A', version: 9, sessionToken: 'swu1.kept-9' } }; service.replace(remote);
  const nativeFetch = service.fetch;
  service.fetch = (url, init) => url.endsWith('/restore') ? Promise.resolve(response({ id: 'game_A', version: 10, sessionToken: 'swu1.bad-10' })) : nativeFetch(url, init);
  const a = device(service); await a.client.load();
  await assert.rejects(a.client.restoreCurrentGame(), error => error.code === 'BAD_RESPONSE');
  assert.equal(a.storage.getItem(SESSION), 'game_A');
  assert.equal(JSON.parse(a.storage.getItem(checkpointKey('game_A'))).sessionToken, 'swu1.kept-9'); a.client.dispose();
});

test('local writes keep unavailable and offline cloud notices truthful until a successful retry resumes syncing', async () => {
  const service = server(), nativeFetch = service.fetch;
  let configured = false;
  service.fetch = (url, init) => configured ? nativeFetch(url, init) : Promise.resolve(response({ code: 'ACCOUNT_SAVES_UNAVAILABLE' }, 503));
  const a = device(service);
  await a.client.load();
  const unavailableMessage = a.client.getStatus().message;
  a.client.storage.setItem(PREFS, JSON.stringify({ difficulty: 'easy' }));
  assert.equal(a.client.getStatus().state, 'unavailable');
  assert.equal(a.client.getStatus().message, unavailableMessage);
  assert.equal(a.client.getStatus().pendingCount, 1);
  configured = true;
  await a.client.retry();
  assert.equal(a.client.getStatus().state, 'synced');
  assert.equal(service.state().preferences.value.difficulty, 'easy');
  service.offline(true);
  upsertCustomDeck(deck('offline'), a.client.storage);
  await a.client.flush();
  const offlineMessage = a.client.getStatus().message;
  a.client.storage.setItem(PREFS, JSON.stringify({ difficulty: 'hard' }));
  a.client.saveTraining({ gameId: 'ambush', sessionToken: 'swu1.lesson-ambush' });
  a.client.saveTraining({ gameId: 'sentinel', sessionToken: 'swu1.lesson-sentinel' });
  assert.equal(a.client.getStatus().state, 'offline');
  assert.equal(a.client.getStatus().message, offlineMessage);
  service.offline(false);
  await a.client.retry();
  assert.equal(a.client.getStatus().state, 'synced');
  assert.equal(a.client.getStatus().pendingCount, 0);
  assert.equal(service.state().preferences.value.difficulty, 'hard');
  assert.deepEqual(service.state().training.value.completedLessonIds, ['ambush', 'sentinel']);
  a.client.dispose();
});
