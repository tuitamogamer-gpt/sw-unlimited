'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

// Exercise the shipped browser module without adding a second test runner.
const filename = path.resolve(__dirname, '../src/game-client.ts');
const compiled = new Module(filename, module);
compiled._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, filename);
const { createGameClient, CLIENT_MESSAGES, SESSION_KEY } = compiled.exports;

const id = '00000000-0000-4000-8000-000000000001';
const checkpointKey = `swu-command-checkpoint:${id}`;
const tokenKey = `swu-command-state:${id}`;
function game(version = 0) {
  const player = { base: {}, leader: {}, hand: [], ground: [], space: [], resources: [], discard: [], leaders: [] };
  return { id, version, sessionToken: `swu1.saved-turn-${version}`, phase: 'setup', round: 1,
    players: { human: player, bot: player }, prompt: { id: `prompt-${version}`, buttons: [], selectedCardIds: [], selectableCardIds: [], displayCards: [] },
    legalActions: [], winnerIds: [], log: [] };
}
const action = { type: 'button', arg: 'keep', promptId: 'prompt-0' };
function storage() {
  const values = new Map();
  const writes = [];
  return { values, writes, getItem: key => values.get(key) ?? null, setItem(key, value) { values.set(key, value); writes.push(key); }, removeItem: key => values.delete(key) };
}
function response(data, status = 200) { return { ok: status >= 200 && status < 300, status, json: async () => data }; }
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function client(options = {}) { return createGameClient({ storage: storage(), locks: null, timeoutMs: 100, recoveryTimeoutMs: 100, recoveryDelayMs: 0, ...options }); }

test('deck validation errors retain their structured preview without changing game checkpoints', async () => {
  const disk = storage();
  const details = { error: 'Deck validation failed.', deck: { name: 'My fleet', supported: false }, errors: ['Missing a leader.'], warnings: [] };
  const c = client({ storage: disk, fetch: async () => response(details, 422) });
  c.rememberGame(game(2));
  const checkpoint = disk.getItem(checkpointKey);
  await assert.rejects(c.api('/api/decks/import', { input: '{}' }), error => {
    assert.equal(error.status, 422);
    assert.deepEqual(error.details, details);
    return true;
  });
  assert.equal(disk.getItem(checkpointKey), checkpoint);
});

test('a timed-out fetch cannot hang or commit a late successful response', async () => {
  const disk = storage();
  const delayed = deferred();
  let signal;
  const c = client({ storage: disk, timeoutMs: 5, fetch: async (_url, init) => { signal = init.signal; return delayed.promise; } });
  await assert.rejects(c.api('/api/games', {}), error => error.code === 'TIMEOUT');
  assert.equal(signal.aborted, true);
  delayed.resolve(response(game(1), 201));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(disk.getItem(checkpointKey), null);
  assert.equal(c.storedValue(SESSION_KEY), '');
});

test('legacy checkpoints migrate atomically before the game response reaches the UI', async () => {
  const disk = storage();
  disk.setItem(tokenKey, game(0).sessionToken);
  disk.setItem(SESSION_KEY, id);
  disk.writes.length = 0;
  let sent;
  const c = client({ storage: disk, fetch: async (url, init) => {
    assert.equal(url, `/api/games/${id}/state`); sent = JSON.parse(init.body);
    return response(game(1));
  } });
  const view = await c.resumeGame(id);
  assert.equal(sent.sessionToken, game(0).sessionToken);
  assert.equal(view.version, 1);
  assert.deepEqual(JSON.parse(disk.getItem(checkpointKey)), { id, version: 1, sessionToken: game(1).sessionToken });
  assert.deepEqual(disk.writes, [checkpointKey, SESSION_KEY, tokenKey]);
  assert.equal(disk.getItem(tokenKey), view.sessionToken);
});

test('stale or busy mutation recovery retries only state reads and never repeats the action', async () => {
  const paths = [];
  const replies = [response({ error: 'Stale turn' }, 409), response({ error: 'Busy' }, 409), response(game(3))];
  const c = client({ fetch: async url => { paths.push(url); return replies.shift(); } });
  c.rememberGame(game());
  const result = await c.mutateGame(game(), action);
  assert.equal(result.view.version, 3);
  assert.equal(result.notice, CLIENT_MESSAGES.stale);
  assert.deepEqual(paths, [`/api/games/${id}/actions`, `/api/games/${id}/state`, `/api/games/${id}/state`]);
});

test('lost mutation responses recover a saved board with an explicit uncertainty notice', async () => {
  const paths = [];
  const c = client({ fetch: async url => {
    paths.push(url);
    if (url.endsWith('/actions')) throw new TypeError('Connection closed after commit');
    return response(game(2));
  } });
  c.rememberGame(game());
  const result = await c.mutateGame(game(), action);
  assert.equal(result.view.version, 2);
  assert.equal(result.notice, CLIENT_MESSAGES.recovered);
  assert.equal(paths.filter(url => url.endsWith('/actions')).length, 1);
});

test('a failed recovery makes the next action click refresh only, without replaying a mutation', async () => {
  const paths = [];
  let disconnected = true;
  const c = client({ fetch: async url => {
    paths.push(url);
    if (disconnected) throw new TypeError('Offline');
    return response(game(url.endsWith('/actions') ? 1 : 0));
  } });
  c.rememberGame(game());
  await assert.rejects(c.mutateGame(game(), action), error => error.code === 'RECOVERY_FAILED' && error.requiresRefresh);
  disconnected = false;
  const recovered = await c.mutateGame(game(), action);
  assert.equal(recovered.notice, CLIENT_MESSAGES.refresh);
  assert.equal(paths.filter(url => url.endsWith('/actions')).length, 1);
  const next = await c.mutateGame(recovered.view, action);
  assert.equal(next.view.version, 1);
  assert.equal(paths.filter(url => url.endsWith('/actions')).length, 2);
});

test('a newer checkpoint from another tab replaces the memory token and refreshes before action', async () => {
  const disk = storage();
  const paths = [];
  const first = client({ storage: disk, fetch: async (url, init) => {
    paths.push(url); assert.equal(JSON.parse(init.body).sessionToken, game(4).sessionToken);
    return response(game(4));
  } });
  const second = client({ storage: disk });
  first.rememberGame(game());
  second.rememberGame(game(4));
  const result = await first.mutateGame(game(), action);
  assert.equal(result.view.version, 4);
  assert.deepEqual(paths, [`/api/games/${id}/state`]);
});

test('Web Locks prevent overlapping mutations from two browser tabs', async () => {
  const held = new Set();
  const locks = { async request(name, _options, callback) {
    if (held.has(name)) return callback(null);
    held.add(name);
    try { return await callback({ name }); } finally { held.delete(name); }
  } };
  const delayed = deferred();
  const disk = storage();
  let mutations = 0;
  const fetch = async () => { mutations++; return delayed.promise; };
  const first = client({ storage: disk, locks, fetch });
  const second = client({ storage: disk, locks, fetch });
  first.rememberGame(game());
  const updating = first.mutateGame(game(), action);
  await assert.rejects(second.mutateGame(game(), action), error => error.code === 'BUSY');
  assert.equal(mutations, 1);
  delayed.resolve(response(game(1)));
  assert.equal((await updating).view.version, 1);
});

test('malformed game responses cannot replace a checkpoint, while catalog JSON is left alone', async () => {
  const disk = storage();
  const c = client({ storage: disk, fetch: async url => response(url === '/api/decks' ? { decks: [] } : {}) });
  c.rememberGame(game());
  await assert.rejects(c.api(`/api/games/${id}`), error => error.code === 'BAD_RESPONSE');
  assert.equal(JSON.parse(disk.getItem(checkpointKey)).version, 0);
  assert.deepEqual(await c.api('/api/decks'), { decks: [] });
});

test('truncated JSON after a mutation is recovered without submitting the action again', async () => {
  let mutations = 0;
  const c = client({ fetch: async url => {
    if (url.endsWith('/actions')) { mutations++; return { ok: true, status: 200, json: async () => { throw new SyntaxError('Truncated'); } }; }
    return response(game(1));
  } });
  c.rememberGame(game());
  const result = await c.mutateGame(game(), action);
  assert.equal(result.view.version, 1);
  assert.equal(result.notice, CLIENT_MESSAGES.recovered);
  assert.equal(mutations, 1);
});

test('storage failures retain the latest memory token and warn against closing the tab', async () => {
  const disk = storage();
  let writesFail = false;
  const durableSet = disk.setItem.bind(disk);
  disk.setItem = (key, value) => { if (writesFail) throw new Error('Quota exceeded'); durableSet(key, value); };
  const c = client({ storage: disk, fetch: async (_url, init) => {
    assert.equal(JSON.parse(init.body).sessionToken, game(2).sessionToken);
    return response(game(3));
  } });
  c.rememberGame(game());
  writesFail = true;
  assert.equal(c.rememberGame(game(2)), false);
  const result = await c.mutateGame(game(2), action);
  assert.equal(result.view.version, 3);
  assert.equal(result.notice, CLIENT_MESSAGES.storage);
  assert.equal(JSON.parse(disk.getItem(checkpointKey)).version, 0);
});

test('a failed resume-pointer write warns even when the checkpoint itself was saved', () => {
  const disk = storage();
  const durableSet = disk.setItem.bind(disk);
  disk.setItem = (key, value) => { if (key === SESSION_KEY) throw new Error('Pointer quota failure'); durableSet(key, value); };
  const c = client({ storage: disk });
  assert.equal(c.rememberGame(game(1)), false);
  assert.equal(JSON.parse(disk.getItem(checkpointKey)).version, 1);
  assert.equal(disk.getItem(SESSION_KEY), null);
  assert.equal(c.storedValue(SESSION_KEY), id, 'The current tab still knows which game is active.');
  assert.equal(c.checkpointNotice(id), CLIENT_MESSAGES.storage);
});

test('a failed legacy-token write does not prevent durable resumption with the atomic checkpoint', async () => {
  const disk = storage();
  const durableSet = disk.setItem.bind(disk);
  disk.setItem = (key, value) => { if (key === tokenKey) throw new Error('Legacy-key quota failure'); durableSet(key, value); };
  const first = client({ storage: disk });
  assert.equal(first.rememberGame(game(2)), true);
  assert.equal(disk.getItem(SESSION_KEY), id);
  assert.equal(first.checkpointNotice(id), undefined);
  const reloaded = client({ storage: disk, fetch: async (_url, init) => {
    assert.equal(JSON.parse(init.body).sessionToken, game(2).sessionToken);
    return response(game(2));
  } });
  assert.equal((await reloaded.resumeGame(reloaded.storedValue(SESSION_KEY))).version, 2);
});

test('the request deadline also bounds a response body that never finishes downloading', async () => {
  const disk = storage();
  const c = client({ storage: disk, timeoutMs: 5, fetch: async () => ({ ok: true, status: 201, json: () => new Promise(() => {}) }) });
  await assert.rejects(c.api('/api/games', {}), error => error.code === 'TIMEOUT');
  assert.equal(disk.getItem(checkpointKey), null);
});

test('an older response cannot overwrite a newer checkpoint received while fetching', async () => {
  const disk = storage();
  const delayed = deferred();
  const c = client({ storage: disk, fetch: async () => delayed.promise });
  c.rememberGame(game());
  const request = c.api(`/api/games/${id}`);
  c.rememberGame(game(3));
  delayed.resolve(response(game(1)));
  await assert.rejects(request, error => error.code === 'STALE_CHECKPOINT');
  assert.equal(JSON.parse(disk.getItem(checkpointKey)).version, 3);
});

test('cancelled mutations do not retry or save late responses, and require a read before another action', async () => {
  const disk = storage();
  const delayed = deferred();
  const paths = [];
  const c = client({ storage: disk, fetch: async url => { paths.push(url); return url.endsWith('/actions') ? delayed.promise : response(game(1)); } });
  c.rememberGame(game());
  const controller = new AbortController();
  const request = c.mutateGame(game(), action, { signal: controller.signal });
  controller.abort();
  await assert.rejects(request, error => error.code === 'CANCELLED' && error.requiresRefresh);
  delayed.resolve(response(game(2)));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(JSON.parse(disk.getItem(checkpointKey)).version, 0);
  const result = await c.mutateGame(game(), action);
  assert.equal(result.view.version, 1);
  assert.equal(paths.filter(url => url.endsWith('/actions')).length, 1);
});
