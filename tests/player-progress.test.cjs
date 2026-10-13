'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { createRecord, applyAction } = require('../server/replay.cjs');
const { chooseAction } = require('../server/bot.cjs');
const { captureReviewDecision, commitReviewDecision, publicReview } = require('../server/match-review.cjs');
const { readDecks } = require('../scripts/smoke.cjs');

function browserModule(relativePath) {
  const filename = path.resolve(__dirname, '..', relativePath);
  const compiled = new Module(filename, module);
  compiled.paths = Module._nodeModulePaths(path.dirname(filename));
  compiled.require = requested => requested.startsWith('.')
    ? browserModule(path.relative(path.resolve(__dirname, '..'), path.resolve(path.dirname(filename), requested + '.ts')))
    : require(requested);
  compiled._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, filename);
  return compiled.exports;
}
const helpers = browserModule('src/player-progress.ts');
const { MATCH_HISTORY_KEY } = browserModule('src/account/cloud-saves.ts');
const { createAccountStorage } = browserModule('src/account/storage.ts');
function disk() {
  const values = new Map(), writes = [];
  return { values, writes, getItem: key => values.get(key) ?? null,
    setItem(key, value) { writes.push(key); values.set(key, value); }, removeItem: key => values.delete(key) };
}

let nativeGamePromise;
function completedNativeGame() {
  return nativeGamePromise ||= (async () => {
    const decks = readDecks();
    const { record, game } = await createRecord({ playerDeck: decks[0], botDeck: decks[1], seed: 123, difficulty: 'normal' });
    const memory = { human: {}, bot: {} };
    try {
      for (let step = 0; step < 1500 && !game.view('human').ended; step++) {
        const view = ['human', 'bot'].map(seat => game.view(seat)).find(view => view.prompt.active);
        assert.ok(view);
        const action = chooseAction(view, { difficulty: 'normal', memory: memory[view.viewerId] }).action;
        const capture = captureReviewDecision(record, game, action, view.viewerId);
        applyAction(record, game, action, view.viewerId);
        commitReviewDecision(record, capture, game);
      }
      const view = game.view('human');
      assert.deepEqual(view.winnerIds, ['human']);
      return { ...view, review: publicReview(record, game), startedAt: record.createdAt, finishedAt: Date.now() };
    } finally { game.close(); }
  })();
}

test('removing a genuinely finished review survives a fresh helper instance and resuming the same completed game', { timeout: 30_000 }, async () => {
  const game = await completedNativeGame();
  const storage = disk();
  assert.equal(helpers.rememberBattle(storage, game).length, 1);
  const stale = storage.getItem(MATCH_HISTORY_KEY);
  storage.writes.length = 0;
  assert.deepEqual(helpers.removeBattle(storage, game.id), []);
  assert.deepEqual(storage.writes, [helpers.DELETED_BATTLES_KEY, MATCH_HISTORY_KEY], 'Deletion intent is stored before history removal.');
  const reloaded = browserModule('src/player-progress.ts');
  assert.equal(reloaded.isBattleDeleted(storage, game.id), true);
  assert.deepEqual(reloaded.rememberBattle(storage, game), [], 'A resumed finished native checkpoint cannot recreate its deleted review.');
  assert.deepEqual(JSON.parse(storage.getItem(MATCH_HISTORY_KEY)), []);
  storage.setItem(MATCH_HISTORY_KEY, stale);
  assert.deepEqual(reloaded.readBattleHistory(storage), [], 'A stale history write is filtered by the durable deletion intent.');
  assert.deepEqual(reloaded.rememberBattle(storage, game), []);
});

test('offline account and guest deletion markers remain scoped to the owner storage', async () => {
  const game = await completedNativeGame();
  const shared = disk();
  const guest = createAccountStorage(null, shared);
  const a = createAccountStorage('account_A', shared);
  const b = createAccountStorage('account_B', shared);
  for (const scope of [guest, a, b]) assert.equal(helpers.rememberBattle(scope, game).length, 1);
  helpers.removeBattle(a, game.id);
  assert.equal(helpers.isBattleDeleted(createAccountStorage('account_A', shared), game.id), true);
  assert.equal(helpers.isBattleDeleted(b, game.id), false);
  assert.equal(helpers.isBattleDeleted(guest, game.id), false);
  assert.deepEqual(helpers.rememberBattle(a, game), []);
  assert.equal(helpers.readBattleHistory(b).length, 1);
  assert.equal(helpers.readBattleHistory(guest).length, 1);
  helpers.removeBattle(guest, game.id);
  assert.deepEqual(helpers.rememberBattle(guest, game), []);
  assert.equal(helpers.readBattleHistory(b).length, 1, 'Guest deletion cannot remove the signed-in account history.');
});

test('storage failures preserve deletion ordering and cannot silently claim durable removal without its marker', async () => {
  const game = await completedNativeGame();
  const shared = disk();
  helpers.rememberBattle(shared, game);
  const markerFailure = { ...shared, setItem(key, value) {
    if (key === helpers.DELETED_BATTLES_KEY) throw new Error('Storage unavailable');
    shared.setItem(key, value);
  } };
  assert.throws(() => helpers.removeBattle(markerFailure, game.id), /Storage unavailable/);
  assert.equal(helpers.readBattleHistory(shared).length, 1);
  assert.equal(helpers.isBattleDeleted(shared, game.id), false);
  const historyFailure = { ...shared, setItem(key, value) {
    if (key === MATCH_HISTORY_KEY) throw new Error('History write failed');
    shared.setItem(key, value);
  } };
  assert.throws(() => helpers.removeBattle(historyFailure, game.id), /History write failed/);
  assert.equal(helpers.isBattleDeleted(shared, game.id), true);
  assert.deepEqual(helpers.readBattleHistory(shared), [], 'A saved deletion marker suppresses the older row even if history writing fails.');
  assert.deepEqual(browserModule('src/player-progress.ts').rememberBattle(shared, game), []);
});

test('deletion markers validate and bound stored IDs while independent clients preserve recent removal intents', () => {
  const shared = disk();
  const id = number => `${number.toString(16).padStart(8, '0')}-0000-0000-0000-000000000000`;
  for (const corrupt of ['{', 'null', '{}', JSON.stringify([12, 'not-a-game-id', null]), 'x'.repeat(65_000)]) {
    shared.setItem(helpers.DELETED_BATTLES_KEY, corrupt);
    assert.equal(helpers.isBattleDeleted(shared, id(1)), false);
  }
  assert.throws(() => helpers.removeBattle(shared, 'invalid'));
  shared.setItem(helpers.DELETED_BATTLES_KEY, JSON.stringify(Array.from({ length: 1005 }, (_, index) => id(index))));
  assert.equal(helpers.isBattleDeleted(shared, id(999)), true);
  assert.equal(helpers.isBattleDeleted(shared, id(1000)), false);
  const second = browserModule('src/player-progress.ts');
  helpers.removeBattle(shared, id(2000));
  second.removeBattle(shared, id(2001));
  const stored = JSON.parse(shared.getItem(helpers.DELETED_BATTLES_KEY));
  assert.equal(stored.length, 1000);
  assert.equal(stored[0], id(2001));
  assert.equal(stored[1], id(2000), 'A second client re-reads the first client’s latest marker.');
  helpers.removeBattle(shared, id(2001));
  assert.equal(JSON.parse(shared.getItem(helpers.DELETED_BATTLES_KEY)).filter(value => value === id(2001)).length, 1);
});
