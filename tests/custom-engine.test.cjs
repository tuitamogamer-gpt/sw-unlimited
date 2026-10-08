'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { normalizeDeckRecipe, createGame } = require('../server/engine.cjs');
const { chooseAction } = require('../server/bot.cjs');
const { readDecks, runGame } = require('../scripts/smoke.cjs');

const decks = readDecks();
const definitions = fs.readdirSync(path.join(__dirname, '../vendor/forceteki/test/json/Card'))
  .map(file => JSON.parse(fs.readFileSync(path.join(__dirname, '../vendor/forceteki/test/json/Card', file), 'utf8')));
const aliases = require('../vendor/forceteki/test/json/_setCodeMap.json');
const code = card => `${card.setId.set}_${String(card.setId.number).padStart(3, '0')}`;
const starterIds = new Set(decks.flatMap(deck => [deck.leader, deck.base, ...deck.deck].map(entry => aliases[entry.id])));
const clone = value => structuredClone(value);
function take(entries, amount) {
  const result = [];
  for (const entry of entries) {
    if (!amount) break;
    const count = Math.min(amount, entry.count);
    result.push({ id: entry.id, count });
    amount -= count;
  }
  assert.equal(amount, 0);
  return result;
}

async function firstActionWithReplacement(replacement, keepName) {
  const recipe = clone(decks[1]);
  recipe.deck[recipe.deck.findIndex(entry => entry.count === 3)] = { id: replacement, count: 3 };
  const game = await createGame({ playerDeck: recipe, botDeck: decks[0], seed: 6 });
  try {
    let view = ['human', 'bot'].map(seat => game.view(seat)).find(view => view.prompt.active);
    game.submit(view.legalActions.find(action => action.label === (view.viewerId === 'human' ? 'Yourself' : 'Opponent')), view.viewerId);
    for (let step = 0; step < 12; step++) {
      view = ['human', 'bot'].map(seat => game.view(seat)).find(view => view.prompt.active);
      if (view.prompt.stage === 'action') break;
      const action = view.legalActions.find(action => action.arg === 'keep')
        || view.legalActions.find(action => action.arg === 'done')
        || view.legalActions.find(action => action.type === 'card' && action.label !== keepName && !view.prompt.selectedCardIds.includes(action.cardId));
      assert.ok(action, `Expected a setup action during ${view.prompt.title}.`);
      game.submit(action, view.viewerId);
    }
    assert.equal(game.view('human').prompt.stage, 'action');
    return game;
  } catch (error) { game.close(); throw error; }
}

test('a custom nonstarter event resolves its real draw ability and resource payment', async () => {
  assert.ok(!starterIds.has(aliases.LOF_175), 'Do or Do Not is outside the starter pool.');
  const game = await firstActionWithReplacement('LOF_175', 'Do or Do Not');
  try {
    let view = game.view('human');
    const event = view.players.human.hand.find(card => card.name === 'Do or Do Not');
    const before = view.players.human;
    assert.equal(event.playable, true);
    assert.equal(event.playCost, 2);
    assert.equal(before.force, false, 'Without a Force token, the real event draws one card.');
    view = game.submit(view.legalActions.find(action => action.cardId === event.uuid));
    assert.equal(view.players.human.deckCount, before.deckCount - 1);
    assert.equal(view.players.human.handCount, before.handCount, 'Playing the event spends one card and then draws a replacement.');
    assert.equal(view.players.human.readyResources, 0);
    assert.ok(view.players.human.discard.some(card => card.uuid === event.uuid));
    assert.equal(view.players.human.ground.length, 0, 'The event resolves an ability rather than becoming a unit.');
  } finally { game.close(); }
});

test('Fortify attaches visibly to a base and its actual continuous ability affects later units', async () => {
  const game = await firstActionWithReplacement('HMW_112', 'Military Academy');
  try {
    let view = game.view('human');
    const fortification = view.players.human.hand.find(card => card.name === 'Military Academy');
    view = game.submit(view.legalActions.find(action => action.cardId === fortification.uuid));
    assert.match(view.prompt.title, /to a base/);
    const target = view.legalActions.find(action => action.cardId === view.players.human.base.uuid);
    assert.ok(target);
    view = game.submit(target);
    for (const seat of ['human', 'bot']) {
      const observation = game.view(seat);
      const attached = observation.players.human.base.upgrades.find(card => card.uuid === fortification.uuid);
      assert.ok(attached, 'Fortify attachments must stay visible and inspectable after resolving.');
      assert.equal(attached.parentCardId, observation.players.human.base.uuid);
      assert.match(attached.text, /Friendly units gain Overwhelm/);
      assert.ok(![...observation.players.human.ground, ...observation.players.human.space].some(card => card.uuid === attached.uuid));
    }
    assert.equal(view.players.human.readyResources, 1);
    const memory = { human: {}, bot: {} };
    let affectedUnit;
    for (let step = 0; step < 80; step++) {
      view = ['human', 'bot'].map(seat => game.view(seat)).find(view => view.prompt.active);
      affectedUnit = [...view.players.human.ground, ...view.players.human.space].find(card => !card.deployed);
      if (affectedUnit) break;
      const choice = chooseAction(view, { difficulty: 'normal', memory: memory[view.viewerId] });
      game.submit(choice.action, view.viewerId);
    }
    assert.ok(affectedUnit, 'A later unit must actually enter play under the Fortify ability.');
    assert.ok(affectedUnit.keywords.some(keyword => keyword.name === 'overwhelm'));
  } finally { game.close(); }
});

test('custom recipes aggregate reprints and reject copy-limit bypasses before constructing a game', async () => {
  const recipe = clone(decks[0]);
  recipe.deck = recipe.deck.filter(entry => entry.id !== 'SOR_237');
  recipe.deck.push({ id: 'sor_237', count: 1 }, { id: 'LAW_253', count: 2 });
  const normalized = await normalizeDeckRecipe(recipe);
  assert.deepEqual(normalized.deck.filter(entry => aliases[entry.id] === '0494601180'), [{ id: 'SOR_237', count: 3 }]);
  assert.equal(normalized.deck.reduce((sum, entry) => sum + entry.count, 0), 50);
  await assert.rejects(normalizeDeckRecipe({ ...recipe, sideboard: [{ id: 'LAW_253', count: 1 }] }), /at most 3 copies.*received 4/);
  await assert.rejects(normalizeDeckRecipe({ ...recipe, deck: [...recipe.deck, { id: 'SOR_237', count: 1 }] }), /at most 3 copies/);
  const game = await createGame({ playerDeck: normalized, botDeck: decks[1], seed: 'custom-reprints' });
  try {
    const player = game.view().players.human;
    assert.equal(player.deckCount + player.handCount + player.resourceCount, 50, 'Native Deck must not silently drop duplicate entries.');
  } finally { game.close(); }
});

test('custom validation honors printed base-size and Swarming Vulture Droid copy exceptions', async () => {
  const thermal = { ...clone(decks[0]), base: { id: 'JTL_025' }, deck: take(decks[0].deck, 45) };
  assert.equal((await normalizeDeckRecipe(thermal)).deck.reduce((sum, entry) => sum + entry.count, 0), 45);
  await assert.rejects(normalizeDeckRecipe({ ...thermal, base: decks[0].base }), /at least 50/);
  await assert.rejects(normalizeDeckRecipe({ ...clone(decks[0]), base: { id: 'JTL_024' } }), /at least 60/);
  const vault = { ...clone(decks[0]), base: { id: 'JTL_024' }, deck: [...take(decks[0].deck, 45), { id: 'JTL_256', count: 15 }] };
  assert.equal((await normalizeDeckRecipe(vault)).deck.reduce((sum, entry) => sum + entry.count, 0), 60);
  await assert.rejects(normalizeDeckRecipe({ ...vault, sideboard: [{ id: 'JTL_256', count: 1 }] }), /at most 15 copies.*received 16/);
  for (const recipe of [thermal, vault]) {
    const game = await createGame({ playerDeck: recipe, botDeck: decks[1], seed: 'printed-construction-exception' });
    try {
      const player = game.view().players.human;
      assert.equal(player.deckCount + player.handCount, recipe.deck.reduce((sum, entry) => sum + entry.count, 0));
    } finally { game.close(); }
  }
});

test('custom validation rejects invalid slots, counts, unknown cards and incomplete previews', async () => {
  const recipe = clone(decks[0]);
  for (const [patch, expected] of [
    [{ leader: { ...recipe.leader, count: 2 } }, /leader slot.*exactly one/],
    [{ base: { ...recipe.base, count: 0 } }, /base slot.*exactly one/],
    [{ secondleader: recipe.leader }, /exactly one leader/],
    [{ leader: recipe.base }, /leader slot/],
    [{ base: recipe.leader }, /base slot/],
    [{ deck: [...recipe.deck, { id: recipe.base.id, count: 1 }] }, /main deck or sideboard/],
    [{ deck: [...recipe.deck, { id: 'SOR_9999', count: 1 }] }, /Unknown card ID/],
    [{ deck: [...recipe.deck, { id: 'SOR_061', count: -1 }] }, /positive whole numbers/],
    [{ deck: [...recipe.deck, { id: 'SOR_061', count: 0.5 }] }, /positive whole numbers/],
    [{ leader: { id: 'IC27_001' } }, /incomplete preview data/],
  ]) await assert.rejects(normalizeDeckRecipe({ ...recipe, ...patch }), expected);
});

test('published catalog support flags agree with the complete native registry, including vanilla cards and incomplete previews', () => {
  const catalog = require('../data/card-catalog.json');
  const { Card } = require('../vendor/forceteki/build/server/game/core/card/Card.js');
  const { cards, overrideNotImplementedCards } = require('../vendor/forceteki/build/server/game/cards/Index.js');
  const byId = new Map(definitions.map(card => [card.id, card]));
  let scripted = 0;
  let keywordOnly = 0;
  let unavailablePreview = 0;
  for (const entry of catalog.cards) {
    const data = byId.get(entry.engineId);
    assert.ok(data, `${entry.code} resolves to actual engine data.`);
    const native = !overrideNotImplementedCards.has(data.id) && (cards.has(data.id) || !Card.checkHasNonKeywordAbilityText(data));
    assert.equal(entry.nativeImplemented, native, `${entry.code} implementation status matches the engine.`);
    if (/mock ability text/i.test([data.text, data.deployBox, data.pilotText].join(' ')) || !/^\d{10}$/.test(data.id)) {
      assert.equal(entry.engineSupported, false, `${entry.code}: mock preview data cannot be offered as fully playable.`);
      unavailablePreview++;
    } else {
      assert.equal(entry.engineSupported, native);
      if (cards.has(data.id)) scripted++;
      else keywordOnly++;
    }
  }
  assert.ok(scripted > 2000);
  assert.ok(keywordOnly > 300, 'Vanilla and keyword-only cards do not need redundant per-card scripts.');
  assert.ok(unavailablePreview > 0, 'The fixture includes incomplete upstream previews.');
});

test('nonstarter custom cards complete real matches across all complete expansion pools', { timeout: 180_000 }, async t => {
  for (const [index, set] of ['SOR', 'SHD', 'TWI', 'JTL', 'LOF', 'SEC', 'LAW', 'ASH', 'HMW', 'TS26'].entries()) {
    await t.test(set, async () => {
      const pool = definitions.filter(card => card.setId?.set === set && !starterIds.has(card.id)
        && card.types.includes('unit') && !card.types.includes('token') && !card.types.includes('leader')
        && card.cost <= 4 && !card.aspects.includes('heroism'))
        .sort((a, b) => a.cost - b.cost || a.internalName.localeCompare(b.internalName));
      assert.ok(pool.length >= 17, `${set} has enough real nonstarter cards for this custom fixture.`);
      const recipe = { ...clone(decks[1]), id: `custom-regression-${set.toLowerCase()}`, name: `${set} nonstarter regression`,
        deck: pool.slice(0, 17).map((card, position) => ({ id: code(card), count: position === 16 ? 2 : 3 })) };
      const included = new Set(recipe.deck.map(entry => aliases[entry.id]));
      let played = false;
      const result = await runGame({ playerDeck: recipe, botDeck: decks[0], seed: 1200 + index, maxActions: 800,
        beforeSubmit({ view }) {
          if ([...view.players.human.ground, ...view.players.human.space].some(card => included.has(card.id))) played = true;
        } });
      assert.ok(played, 'A nonstarter card must actually enter play, not merely load in a deck.');
      assert.ok(result.winnerIds.length);
      t.diagnostic(`${set}: ${result.actions} legal actions, ${result.rounds} rounds.`);
    });
  }
});
