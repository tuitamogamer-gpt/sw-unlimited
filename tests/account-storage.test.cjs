'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

// Use the shipped browser modules, following the existing game-client test harness.
function browserModule(relativePath) {
  const filename = path.resolve(__dirname, '..', relativePath);
  const compiled = new Module(filename, module);
  compiled._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, filename);
  return compiled.exports;
}

const { createAccountStorage } = browserModule('src/account/storage.ts');
const { createGameClient, SESSION_KEY, CLIENT_MESSAGES } = browserModule('src/game-client.ts');
const { readCustomDecks, persistCustomDecks, upsertCustomDeck, removeStoredCustomDeck, CUSTOM_DECKS_KEY } = browserModule('src/custom-decks.ts');

const GAME_ID = '00000000-0000-4000-8000-000000000019';
const CHECKPOINT_KEY = `swu-command-checkpoint:${GAME_ID}`;
const TOKEN_KEY = `swu-command-state:${GAME_ID}`;
const PREFERENCES_KEY = 'swu-command-preferences';
const prefix = owner => owner === null ? '' : `swu-command-account:${owner}:`;

function storage() {
  const values = new Map();
  return {
    values,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  };
}
function game(owner = 'guest', version = 0) {
  const player = { base: {}, leader: {}, hand: [], ground: [], space: [], resources: [], discard: [], leaders: [] };
  return {
    id: GAME_ID, version, sessionToken: `swu1.${owner}-turn-${version}`, phase: 'setup', round: 1,
    players: { human: player, bot: player },
    prompt: { id: `prompt-${version}`, buttons: [], selectedCardIds: [], selectableCardIds: [], displayCards: [] },
    legalActions: [], winnerIds: [], log: [],
  };
}
function savedDeck(owner) {
  const id = `custom-${owner}`;
  const leader = { id: 'SOR_005', code: 'SOR_005', name: 'Luke Skywalker' };
  const base = { id: 'SOR_025', code: 'SOR_025', name: 'Starter base' };
  const unit = { id: 'SOR_095', code: 'SOR_095', name: `${owner} saved unit` };
  return {
    id, custom: true, name: `${owner} collection`, leader, base,
    cards: [{ count: 3, card: unit }], sideboardCards: [], savedAt: 1728000000000,
    validation: { valid: true, errors: [], warnings: [] },
    recipe: { id, custom: true, name: `${owner} collection`, leader: { id: leader.id, count: 1 },
      base: { id: base.id, count: 1 }, deck: [{ id: unit.id, count: 3 }], sideboard: [] },
  };
}
function response(value) { return { ok: true, status: 200, json: async () => value }; }
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function client(scopedStorage, options = {}) {
  return createGameClient({ storage: scopedStorage, locks: null, timeoutMs: 1000, recoveryTimeoutMs: 1000,
    recoveryDelayMs: 0, ...options });
}
function checkpoint(scopedStorage) { return JSON.parse(scopedStorage.getItem(CHECKPOINT_KEY)); }
function otherScopes(disk, owner) {
  return [...disk.values].filter(([key]) => !key.startsWith(prefix(owner))).sort(([a], [b]) => a.localeCompare(b));
}
function seedOwner(disk, owner, version) {
  const scoped = createAccountStorage(owner, disk);
  const c = client(scoped);
  assert.equal(c.rememberGame(game(owner || 'guest', version)), true);
  persistCustomDecks([savedDeck(owner || 'guest')], scoped);
  scoped.setItem(PREFERENCES_KEY, JSON.stringify({ deckId: `custom-${owner || 'guest'}`, difficulty: owner ? 'hard' : 'easy' }));
  return { scoped, client: c };
}

test('guest storage keeps all legacy keys and resumes the existing guest checkpoint', async () => {
  const disk = storage();
  const legacy = game('guest', 3);
  disk.setItem(SESSION_KEY, GAME_ID);
  disk.setItem(TOKEN_KEY, legacy.sessionToken);
  disk.setItem(CUSTOM_DECKS_KEY, JSON.stringify({ version: 1, decks: [savedDeck('guest')] }));
  disk.setItem(PREFERENCES_KEY, JSON.stringify({ deckId: 'custom-guest', difficulty: 'easy' }));
  const guest = createAccountStorage(null, disk);
  const c = client(guest, { fetch: async (url, init) => {
    assert.equal(url, `/api/games/${GAME_ID}/state`);
    assert.equal(JSON.parse(init.body).sessionToken, legacy.sessionToken);
    return response(game('guest', 4));
  } });

  assert.equal(c.storedValue(SESSION_KEY), GAME_ID);
  assert.deepEqual(readCustomDecks(guest), [savedDeck('guest')]);
  assert.equal(JSON.parse(guest.getItem(PREFERENCES_KEY)).difficulty, 'easy');
  assert.equal((await c.resumeGame(GAME_ID)).version, 4);
  assert.deepEqual(checkpoint(disk), { id: GAME_ID, version: 4, sessionToken: game('guest', 4).sessionToken });
  assert.deepEqual([...disk.values.keys()].sort(), [SESSION_KEY, TOKEN_KEY, CHECKPOINT_KEY, CUSTOM_DECKS_KEY, PREFERENCES_KEY].sort());
  guest.removeItem(PREFERENCES_KEY);
  assert.equal(disk.getItem(PREFERENCES_KEY), null);
});

test('accounts A and B isolate game pointers, same-ID checkpoints, custom decks and preferences from guests', () => {
  const disk = storage();
  const guest = seedOwner(disk, null, 30);
  const a = seedOwner(disk, 'account_A', 8);
  const b = seedOwner(disk, 'account_B', 2);

  for (const [owner, entry, version] of [[null, guest, 30], ['account_A', a, 8], ['account_B', b, 2]]) {
    assert.equal(entry.client.storedValue(SESSION_KEY), GAME_ID);
    assert.equal(checkpoint(entry.scoped).version, version);
    assert.equal(checkpoint(entry.scoped).sessionToken, game(owner || 'guest', version).sessionToken);
    assert.deepEqual(readCustomDecks(entry.scoped), [savedDeck(owner || 'guest')]);
    assert.equal(JSON.parse(entry.scoped.getItem(PREFERENCES_KEY)).deckId, `custom-${owner || 'guest'}`);
    assert.equal(disk.getItem(`${prefix(owner)}${SESSION_KEY}`), GAME_ID);
  }
  assert.equal(disk.values.size, 15, 'Five independent persisted keys exist for each of the three owners.');
  assert.equal(a.scoped.getItem(`${prefix('account_B')}${TOKEN_KEY}`), null, 'A cannot escape its prefix by using a B-prefixed key.');
});

test('a new signed-in account cannot silently inherit guest saves or another account collection', () => {
  const disk = storage();
  seedOwner(disk, null, 3);
  seedOwner(disk, 'account_A', 9);
  const b = createAccountStorage('account_B', disk);
  assert.equal(client(b).storedValue(SESSION_KEY), '');
  assert.equal(b.getItem(CHECKPOINT_KEY), null);
  assert.equal(b.getItem(TOKEN_KEY), null);
  assert.deepEqual(readCustomDecks(b), []);
  assert.equal(b.getItem(PREFERENCES_KEY), null);
});

test('each storage wrapper captures its owner even when the current login variable changes', () => {
  const disk = storage();
  let currentOwner = 'account_A';
  const a = createAccountStorage(currentOwner, disk);
  currentOwner = 'account_B';
  const b = createAccountStorage(currentOwner, disk);
  a.setItem(PREFERENCES_KEY, 'A settings');
  b.setItem(PREFERENCES_KEY, 'B settings');
  currentOwner = null;
  const guest = createAccountStorage(currentOwner, disk);
  guest.setItem(PREFERENCES_KEY, 'Guest settings');
  a.setItem(PREFERENCES_KEY, 'Late A settings');
  assert.equal(disk.getItem(`${prefix('account_A')}${PREFERENCES_KEY}`), 'Late A settings');
  assert.equal(b.getItem(PREFERENCES_KEY), 'B settings');
  assert.equal(guest.getItem(PREFERENCES_KEY), 'Guest settings');
});

test('an in-flight A response arriving after a switch to B writes only A checkpoints', async () => {
  const disk = storage();
  const delayed = deferred();
  const guest = seedOwner(disk, null, 20);
  const a = createAccountStorage('account_A', disk);
  let sentToken;
  const aClient = client(a, { fetch: async (_url, init) => {
    sentToken = JSON.parse(init.body).sessionToken;
    return delayed.promise;
  } });
  aClient.rememberGame(game('account_A', 0));
  const pendingA = aClient.api(`/api/games/${GAME_ID}`);

  const b = seedOwner(disk, 'account_B', 11);
  const activeClient = b.client;
  const untouched = otherScopes(disk, 'account_A');
  delayed.resolve(response(game('account_A', 1)));
  assert.equal((await pendingA).version, 1);

  assert.equal(sentToken, game('account_A', 0).sessionToken);
  assert.equal(checkpoint(a).sessionToken, game('account_A', 1).sessionToken);
  assert.equal(checkpoint(b.scoped).sessionToken, game('account_B', 11).sessionToken);
  assert.equal(checkpoint(guest.scoped).version, 20);
  assert.equal(activeClient.storedValue(SESSION_KEY), GAME_ID);
  assert.deepEqual(otherScopes(disk, 'account_A'), untouched, 'The completed request cannot change any guest or B key.');
});

test('logging out and forgetting A game cannot remove B or guest saves and leaves A collections intact', () => {
  const disk = storage();
  const guest = seedOwner(disk, null, 5);
  const a = seedOwner(disk, 'account_A', 3);
  seedOwner(disk, 'account_B', 9);
  const others = otherScopes(disk, 'account_A');

  // Logout switches the caller to a new guest client; the previous scoped client
  // may still finish its own cleanup, but it must never clear the next scope.
  const loggedOut = client(createAccountStorage(null, disk));
  a.client.forgetGame(GAME_ID);
  assert.equal(loggedOut.storedValue(SESSION_KEY), GAME_ID);
  assert.equal(checkpoint(guest.scoped).version, 5);
  assert.equal(a.scoped.getItem(CHECKPOINT_KEY), null);
  assert.equal(a.scoped.getItem(TOKEN_KEY), null);
  assert.equal(a.client.storedValue(SESSION_KEY), '');
  assert.deepEqual(readCustomDecks(a.scoped), [savedDeck('account_A')]);
  assert.equal(JSON.parse(a.scoped.getItem(PREFERENCES_KEY)).deckId, 'custom-account_A');
  assert.deepEqual(otherScopes(disk, 'account_A'), others);
});

test('corrupt A deck storage does not hide or overwrite B and guest collections', () => {
  const disk = storage();
  const guest = seedOwner(disk, null, 1);
  const a = seedOwner(disk, 'account_A', 1);
  const b = seedOwner(disk, 'account_B', 1);
  const others = otherScopes(disk, 'account_A');
  a.scoped.setItem(CUSTOM_DECKS_KEY, '{invalid JSON');
  assert.deepEqual(readCustomDecks(a.scoped), []);
  assert.deepEqual(readCustomDecks(b.scoped), [savedDeck('account_B')]);
  assert.deepEqual(readCustomDecks(guest.scoped), [savedDeck('guest')]);
  persistCustomDecks([], a.scoped);
  assert.deepEqual(readCustomDecks(a.scoped), []);
  assert.deepEqual(otherScopes(disk, 'account_A'), others);
});

test('deck saves from two tabs preserve imports made since their collection was loaded', () => {
  const disk = storage();
  const firstTab = createAccountStorage('account_A', disk);
  const secondTab = createAccountStorage('account_A', disk);
  assert.deepEqual(readCustomDecks(firstTab), []);
  assert.deepEqual(readCustomDecks(secondTab), []);
  const firstDeck = savedDeck('first');
  const secondDeck = savedDeck('second');
  assert.deepEqual(upsertCustomDeck(firstDeck, firstTab), [firstDeck]);
  assert.deepEqual(upsertCustomDeck(secondDeck, secondTab), [secondDeck, firstDeck]);
  assert.deepEqual(readCustomDecks(firstTab), [secondDeck, firstDeck]);
});

test('removing and updating decks from a stale tab preserve newer imports without resurrecting removed decks', () => {
  const disk = storage();
  const firstTab = createAccountStorage('account_A', disk);
  const secondTab = createAccountStorage('account_A', disk);
  const original = savedDeck('original');
  const other = savedDeck('other');
  persistCustomDecks([original, other], firstTab);
  assert.deepEqual(readCustomDecks(secondTab), [original, other]);
  const imported = savedDeck('imported');
  upsertCustomDeck(imported, firstTab);
  assert.deepEqual(removeStoredCustomDeck(original.id, secondTab), [imported, other]);
  const updated = { ...other, name: 'Updated collection', recipe: { ...other.recipe, name: 'Updated collection' } };
  assert.deepEqual(upsertCustomDeck(updated, firstTab), [updated, imported]);
  assert.deepEqual(readCustomDecks(secondTab), [updated, imported]);
});

test('collection operations stay in their account scope and failed saves preserve the durable collection', () => {
  const disk = storage();
  seedOwner(disk, null, 1);
  seedOwner(disk, 'account_B', 1);
  const scoped = createAccountStorage('account_A', disk);
  const others = otherScopes(disk, 'account_A');
  const existing = savedDeck('existing');
  upsertCustomDeck(existing, scoped);
  const broken = {
    getItem: scoped.getItem,
    setItem() { throw Object.assign(new Error('Quota exceeded'), { name: 'QuotaExceededError' }); },
  };
  assert.throws(() => upsertCustomDeck(savedDeck('unsaved'), broken), /browser storage is full/);
  assert.throws(() => removeStoredCustomDeck(existing.id, broken), /browser storage is full/);
  assert.deepEqual(readCustomDecks(scoped), [existing]);
  removeStoredCustomDeck(existing.id, scoped);
  assert.deepEqual(readCustomDecks(scoped), []);
  assert.deepEqual(otherScopes(disk, 'account_A'), others);
});

test('invalid account identifiers are rejected instead of falling back to guest storage', () => {
  const disk = storage();
  disk.setItem(SESSION_KEY, 'guest-save');
  for (const owner of ['', 'account:A', 'user@example.com', '../account_B', 'A B', 'A\nB', 'račun', 'a'.repeat(129)]) {
    assert.throws(() => createAccountStorage(owner, disk), /Invalid account storage scope/);
  }
  const longest = 'a'.repeat(128);
  createAccountStorage(longest, disk).setItem(SESSION_KEY, 'long-owner-save');
  assert.equal(disk.getItem(`${prefix(longest)}${SESSION_KEY}`), 'long-owner-save');
  assert.equal(disk.getItem(SESSION_KEY), 'guest-save');
});

test('denied browser storage retains game-client memory in its original account and warns on mutation', async () => {
  const attemptedKeys = [];
  const deny = key => { attemptedKeys.push(key); throw new Error('Browser storage denied'); };
  const denied = { getItem: deny, setItem: deny, removeItem: deny };
  const a = createAccountStorage('account_A', denied);
  const aClient = client(a, { fetch: async (_url, init) => {
    assert.equal(JSON.parse(init.body).sessionToken, game('account_A', 2).sessionToken);
    return response(game('account_A', 3));
  } });
  assert.equal(aClient.rememberGame(game('account_A', 2)), false);
  assert.equal(aClient.storedValue(SESSION_KEY), GAME_ID);
  assert.equal(aClient.checkpointNotice(GAME_ID), CLIENT_MESSAGES.storage);
  const result = await aClient.mutateGame(game('account_A', 2), { type: 'button', arg: 'keep', promptId: 'prompt-2' });
  assert.equal(result.view.version, 3);
  assert.equal(result.notice, CLIENT_MESSAGES.storage);
  assert.equal(result.restored, false);
  assert.ok(attemptedKeys.every(key => key.startsWith(prefix('account_A'))));

  const bClient = client(createAccountStorage('account_B', denied));
  assert.equal(bClient.storedValue(SESSION_KEY), '', 'A new account never inherits another client’s memory-only game.');
  assert.equal(bClient.checkpointNotice(GAME_ID), undefined);
  assert.deepEqual(readCustomDecks(a), []);
  assert.throws(() => persistCustomDecks([savedDeck('account_A')], a), /not been saved/);
  assert.doesNotThrow(() => aClient.forgetGame(GAME_ID));
  assert.equal(aClient.storedValue(SESSION_KEY), '');
});

test('a browser that denies access to localStorage itself still permits memory-only gameplay', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  try {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('SecurityError'); } });
    const scoped = createAccountStorage('account_A');
    const c = client(scoped, { fetch: async (_url, init) => {
      assert.equal(JSON.parse(init.body).sessionToken, game('account_A', 0).sessionToken);
      return response(game('account_A', 1));
    } });
    assert.equal(c.rememberGame(game('account_A')), false);
    assert.equal(c.storedValue(SESSION_KEY), GAME_ID);
    assert.equal((await c.resumeGame(GAME_ID)).version, 1);
    assert.equal(c.checkpointNotice(GAME_ID), CLIENT_MESSAGES.storage);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete globalThis.localStorage;
  }
});
