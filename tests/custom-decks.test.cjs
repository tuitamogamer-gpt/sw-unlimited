'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { once } = require('node:events');
const { spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const { importCustomDeck, publicDeckId, MAX_INPUT_BYTES } = require('../server/custom-decks.cjs');
const { getCardCatalog } = require('../server/card-catalog.cjs');
const { createRecord, applyAction, sealRecord, restoreRecord, decodeRecord } = require('../server/replay.cjs');
const { chooseAction } = require('../server/bot.cjs');
const { assertPrivateView } = require('../scripts/smoke.cjs');
const decks = require('../data/decks.json');
const catalog = getCardCatalog();
process.env.SWU_SESSION_SECRET ||= randomBytes(32).toString('hex');
const starter = () => structuredClone(decks[0]);

test('JSON, sectioned names, codes and alternate printings produce the same canonical deck', async () => {
  const original = starter();
  const name = 'Custom Rebels';
  const baseline = await importCustomDeck(original, { name });
  assert.equal(baseline.status, 200, baseline.errors.join('; '));
  assert.equal(baseline.deck.custom, true);
  assert.equal(baseline.deck.count, 50);
  assert.match(baseline.deck.id, /^custom-[a-f0-9]{24}$/);
  assert.equal(baseline.deck.coverage.missing.length, 0);
  assert.equal(baseline.deck.validation.valid, true);
  assert.ok(baseline.warnings.some(message => /rotation/.test(message)));
  const rows = ['Leader: Luke Skywalker, Faithful Friend', "Base: Administrator's Tower, Cloud City", 'Main Deck (50 cards)',
    ...original.deck.map(row => `${row.count}x ${row.id.toLowerCase().replace('_', ' ')}`)];
  const text = await importCustomDeck(rows.join('\n'), { name });
  assert.equal(text.status, 200, text.errors.join('; '));
  assert.deepEqual(text.deck.recipe, baseline.deck.recipe);
  const variant = starter();
  variant.leader.id = catalog.cards.find(card => card.code === 'SOR_005').aliases.find(code => code !== 'SOR_005');
  const xwing = variant.deck.find(row => row.id === 'SOR_237');
  xwing.count = 1;
  variant.deck.push({ id: 'LAW_253', count: 2 });
  const reprinted = await importCustomDeck(JSON.stringify(variant), { name });
  assert.equal(reprinted.status, 200, reprinted.errors.join('; '));
  assert.deepEqual(reprinted.deck.recipe, baseline.deck.recipe, 'Reprint aliases merge by the same official card identity.');
  const numeric = starter();
  numeric.leader.id = catalog.cards.find(card => card.code === 'SOR_005').idAliases[0];
  assert.equal((await importCustomDeck(numeric, { name })).deck.id, baseline.deck.id);
});

test('ambiguous and unknown names, malformed input and nonintegral quantities return useful diagnostics', async () => {
  for (const [change, expected] of [
    [deck => { deck.leader = { name: 'Luke Skywalker' }; }, 'AMBIGUOUS_CARD'],
    [deck => { deck.deck[0].id = 'SOR_9999'; }, 'UNKNOWN_CARD'],
    [deck => { deck.deck[0].count = '3'; }, 'QUANTITY'],
    [deck => { deck.deck[0].count = -1; }, 'QUANTITY'],
    [deck => { deck.deck[0].count = 1.5; }, 'QUANTITY'],
    [deck => { deck.leader.count = 2; }, 'SLOT_COUNT'],
    [deck => { deck.base.count = 0; }, 'QUANTITY'],
    [deck => { deck.leader.count = null; }, 'QUANTITY'],
    [deck => { deck.secondleader = deck.leader; }, 'SECOND_LEADER'],
  ]) {
    const deck = starter(); change(deck);
    const result = await importCustomDeck(deck);
    assert.equal(result.status, 422);
    assert.ok(result.issues.some(item => item.code === expected), JSON.stringify(result.issues));
    assert.ok(result.errors.length);
    if (result.deck) assert.equal(result.deck.validation.valid, false);
  }
  const unknown = starter(); unknown.deck[0].id = 'SOR_9999';
  assert.ok((await importCustomDeck(unknown)).errors.some(message => message.includes('SOR_9999')));
  for (const invalid of ['{bad JSON', '3 SOR_042', 42, [], 'x'.repeat(MAX_INPUT_BYTES + 1)]) {
    const result = await importCustomDeck(invalid);
    assert.equal(result.status, 400);
    assert.ok(result.errors.length);
  }
});

test('combined main/sideboard reprints, deck sizes, wrong slots and tokens are rejected before play', async () => {
  const withTooMany = starter(); withTooMany.sideboard = [{ id: 'LAW_253', count: 1 }];
  const copies = await importCustomDeck(withTooMany);
  assert.equal(copies.status, 422);
  assert.match(copies.errors.join(' '), /at most 3 copies.*received 4/);
  const tooSmall = starter(); tooSmall.deck[0].count--;
  assert.match((await importCustomDeck(tooSmall)).errors.join(' '), /at least 50.*49/);
  const wrongSlot = starter(); wrongSlot.deck[0].id = 'SOR_005';
  assert.match((await importCustomDeck(wrongSlot)).errors.join(' '), /cannot be used/);
  const token = catalog.cards.find(card => card.types.includes('token'));
  const tokenDeck = starter(); tokenDeck.deck[0].id = token.code;
  const tokenResult = await importCustomDeck(tokenDeck);
  assert.equal(tokenResult.status, 422);
  assert.ok(tokenResult.errors.length);
  const tooLarge = starter(); tooLarge.deck = [{ id: 'SOR_237', count: 200 }, { id: 'SOR_236', count: 1 }];
  assert.ok((await importCustomDeck(tooLarge)).issues.some(item => item.code === 'MAIN_LIMIT'));
  const sideboard = starter(); sideboard.sideboard = [{ id: 'SOR_061', count: 3 }, { id: 'SOR_062', count: 3 }, { id: 'SOR_065', count: 3 }, { id: 'SOR_070', count: 2 }];
  assert.ok((await importCustomDeck(sideboard)).issues.some(item => item.code === 'SIDEBOARD_LIMIT'));
});

test('unverified preview cards remain visible in an invalid import preview and cannot start a game', async () => {
  const unavailable = catalog.cards.find(card => !card.engineSupported && card.types.includes('unit') && !card.types.includes('token'));
  assert.ok(unavailable, 'The catalog contains explicit unverified preview data.');
  const deck = starter(); deck.deck[0].id = unavailable.code;
  const result = await importCustomDeck(deck);
  assert.equal(result.status, 422);
  assert.equal(result.deck.supported, false);
  assert.equal(result.deck.validation.valid, false);
  assert.ok(result.deck.cards.some(row => row.card.code === unavailable.code));
  assert.equal(result.deck.cards.find(row => row.card.code === unavailable.code).card.unimplemented, true);
  assert.ok(result.deck.coverage.missing.some(name => name.includes(unavailable.code)));
  assert.ok(result.issues.some(item => item.code === 'UNSUPPORTED_CARD'));
});

test('official construction exceptions and a legal sideboard survive the import boundary', async () => {
  const thermal = starter(); thermal.base = { id: 'JTL_025' };
  let remove = 5;
  while (remove > 0) { const row = thermal.deck.at(-1); const n = Math.min(remove, row.count); row.count -= n; remove -= n; if (!row.count) thermal.deck.pop(); }
  const fortyFive = await importCustomDeck(thermal);
  assert.equal(fortyFive.status, 200, fortyFive.errors.join('; '));
  assert.equal(fortyFive.deck.count, 45);
  const dataVault = starter(); dataVault.base = { id: 'JTL_024' };
  assert.match((await importCustomDeck(dataVault)).errors.join(' '), /at least 60/);
  const vultures = starter(); vultures.deck.push({ id: 'JTL_256', count: 15 });
  assert.equal((await importCustomDeck(vultures)).status, 200);
  vultures.sideboard = [{ id: 'JTL_256', count: 1 }];
  assert.match((await importCustomDeck(vultures)).errors.join(' '), /at most 15 copies/);
  const sided = starter(); sided.sideboard = [{ id: 'SOR_061', count: 2 }];
  const legal = await importCustomDeck(sided);
  assert.equal(legal.status, 200, legal.errors.join('; '));
  assert.equal(legal.deck.sideboardCount, 2);
  assert.equal(legal.deck.recipe.sideboard[0].count, 2);
  assert.ok(legal.warnings.some(message => /not used/.test(message)));
});

test('public SWUDB URLs use only the fixed export origin, never follow redirects and have bounded payloads', async () => {
  const urls = ['https://swudb.com/deck/abcXYZ123', 'https://www.swudb.com/deck/view/abcXYZ123', 'https://swudb.com/api/getDeckJson/abcXYZ123'];
  for (const url of urls) {
    assert.equal(publicDeckId(url), 'abcXYZ123');
    const result = await importCustomDeck(url, { fetcher: async (target, options) => {
      assert.equal(target, 'https://swudb.com/api/getDeckJson/abcXYZ123');
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      return new Response(JSON.stringify(starter()), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } });
    assert.equal(result.status, 200, result.errors.join('; '));
  }
  for (const url of ['http://swudb.com/deck/id', 'https://evil.example/deck/id', 'https://swudb.com.evil.example/deck/id', 'https://swudb.com@127.0.0.1/deck/id', 'https://swudb.com:444/deck/id', 'https://swudb.com/api/other']) {
    let fetched = false;
    const result = await importCustomDeck(url, { fetcher: async () => { fetched = true; throw new Error('Must not fetch'); } });
    assert.equal(result.status, 400, url);
    assert.equal(fetched, false, url);
  }
  const oversized = await importCustomDeck(urls[0], { fetcher: async () => new Response('x'.repeat(MAX_INPUT_BYTES + 1)) });
  assert.ok(oversized.issues.some(item => item.code === 'INPUT_SIZE'));
  const forbidden = await importCustomDeck(urls[0], { fetcher: async () => new Response('', { status: 403 }) });
  assert.match(forbidden.errors.join(' '), /private or unavailable.*JSON/);
});

test('encrypted custom recipes replay in a fresh process without the saved deck library', { timeout: 30_000 }, async () => {
  const human = (await importCustomDeck(starter(), { name: 'Cold restart human' })).deck.recipe;
  const bot = (await importCustomDeck(decks[1], { name: 'Cold restart opponent' })).deck.recipe;
  const { record, game } = await createRecord({ playerDeck: human, botDeck: bot, difficulty: 'normal', seed: 'custom-cold-restart' });
  try {
    const memory = { human: {}, bot: {} };
    for (let step = 0; step < 45; step++) {
      const view = ['human', 'bot'].map(seat => game.view(seat)).find(view => view.legalActions.length);
      if (!view) break;
      const choice = chooseAction(view, { difficulty: 'normal', memory: memory[view.viewerId] });
      applyAction(record, game, choice.action, view.viewerId);
    }
    assertPrivateView(game.view('human'));
    const token = sealRecord(record);
    assert.deepEqual(decodeRecord(token).playerDeck, human);
    assert.deepEqual(decodeRecord(token).opponentDeck, bot);
    assert.ok(!token.includes('Cold restart'));
    const child = spawnSync(process.execPath, ['-e', `
      const {restoreRecord}=require('./server/replay.cjs');
      restoreRecord(require('node:fs').readFileSync(0,'utf8'),{decks:[]}).then(({game})=>{
        process.stdout.write(JSON.stringify(game.canonicalView('human')));game.close();
      }).catch(e=>{console.error(e);process.exitCode=1});
    `], { cwd: path.resolve(__dirname, '..'), env: { ...process.env }, input: token, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: 20_000 });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), game.canonicalView('human'));
    const invalid = { ...record, playerDeck: { ...human, id: 'custom-forged' } };
    assert.throws(() => sealRecord(invalid), /custom deck/i);
  } finally { game.close(); }
  const legacy = await createRecord({ playerDeck: decks[0], botDeck: decks[1], seed: 'starter-compatibility' });
  try {
    assert.equal(legacy.record.playerDeck, undefined);
    const restored = await restoreRecord(sealRecord(legacy.record), { decks });
    try { assert.deepEqual(restored.game.canonicalView('human'), legacy.game.canonicalView('human')); } finally { restored.game.close(); }
  } finally { legacy.game.close(); }
});

test('HTTP import, custom versus starter/custom and tampered start recipes are validated', { timeout: 30_000 }, async () => {
  const { app } = require('../server/index.cjs');
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const games = [];
  const request = async (route, body, method = 'POST') => {
    const response = await fetch(origin + route, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: response.status === 204 ? null : await response.json() };
  };
  try {
    const imported = await request('/api/decks/import', { input: starter(), name: 'HTTP custom deck' });
    assert.equal(imported.status, 200, JSON.stringify(imported.body.errors));
    const recipe = imported.body.deck.recipe;
    for (const opponent of [{ opponentDeckId: decks[1].id }, { opponentDeck: recipe }]) {
      const game = await request('/api/games', { playerDeck: recipe, ...opponent, difficulty: 'normal' });
      assert.equal(game.status, 201, JSON.stringify(game.body)); games.push(game.body);
      assertPrivateView(game.body);
      assert.equal(decodeRecord(game.body.sessionToken).playerDeck.id, recipe.id);
    }
    const tampered = structuredClone(recipe); tampered.deck[0].count = 99; tampered.supported = true;
    const rejected = await request('/api/games', { playerDeck: tampered, opponentDeckId: decks[1].id });
    assert.equal(rejected.status, 422);
    assert.ok(rejected.body.errors.length);
    assert.equal(rejected.body.seat, 'human');
    const malformed = await request('/api/decks/import', { input: '{' });
    assert.equal(malformed.status, 400);
    assert.ok(malformed.body.issues.length);
  } finally {
    for (const game of games) await request(`/api/games/${game.id}`, { sessionToken: game.sessionToken }, 'DELETE');
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});
