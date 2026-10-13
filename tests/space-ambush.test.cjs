'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createRecord, applyAction, sealRecord, restoreRecord } = require('../server/replay.cjs');
const { importCustomDeck } = require('../server/custom-decks.cjs');
const { readDecks, assertPrivateView } = require('../scripts/smoke.cjs');

const decks = readDecks();
const luke = decks.find(deck => deck.id === 'sor-luke-skywalker');
const vader = decks.find(deck => deck.id === 'sor-darth-vader');
const units = player => [...player.ground, ...player.space];
const button = (view, arg) => {
  const action = view.legalActions.find(action => action.type === 'button' && action.arg === arg);
  assert.ok(action, `Expected ${arg} during ${view.prompt.title}.`);
  return action;
};

// Build every board through public game actions. Preserve the Ambush card and
// requested defenders in hand while both players resource and pass normally.
async function prepareSpaceAmbush({ playerDeck = luke, name = 'Auzituck Liberator Gunship',
  targets = ['TIE/ln Fighter'], minReadyResources = 0, seed = 2 } = {}) {
  const { game, record } = await createRecord({ playerDeck, botDeck: vader, seed, difficulty: 'normal' });
  try {
    for (let step = 0; step < 240; step++) {
      const views = ['human', 'bot'].map(seat => game.view(seat));
      views.forEach(assertPrivateView);
      const view = views.find(view => view.prompt.active);
      assert.ok(view, 'A real game decision must be available.');
      let action;
      if (view.prompt.stage === 'initiative') {
        action = view.legalActions.find(action => action.label === (view.viewerId === 'human' ? 'Yourself' : 'Opponent'));
      } else if (view.prompt.stage === 'mulligan') action = button(view, 'keep');
      else if (view.prompt.stage === 'resource') {
        if (view.prompt.selectedCardIds.length < view.prompt.resourceSelection.max) {
          action = view.legalActions.find(action => action.type === 'card'
            && !view.prompt.selectedCardIds.includes(action.cardId)
            && !(view.viewerId === 'human' ? action.label === name : targets.includes(action.label)));
        }
        action ||= button(view, 'done');
      } else if (view.prompt.stage === 'action') {
        if (view.viewerId === 'human' && view.players.human.readyResources >= minReadyResources
          && targets.every(name => units(view.players.bot).some(card => card.name === name))) {
          action = view.legalActions.find(action => action.intent === 'play' && action.label === name);
          if (action) return { game, record, view, action };
        }
        if (view.viewerId === 'bot') {
          action = view.legalActions.find(action => action.intent === 'play' && targets.includes(action.label)
            && !units(view.players.bot).some(card => card.name === action.label));
        }
        action ||= view.legalActions.find(action => action.arg === 'claimInitiative') || button(view, 'pass');
      } else action = view.legalActions.find(action => action.arg === 'pass') || view.legalActions[0];
      assert.ok(action, `A legal fixture choice must exist during ${view.prompt.title}.`);
      applyAction(record, game, action, view.viewerId);
    }
    assert.fail(`The real game must reach a playable ${name}.`);
  } catch (error) { game.close(); throw error; }
}

async function assertReplay(game, record) {
  const restored = await restoreRecord(sealRecord(record), { decks });
  try {
    for (const seat of ['human', 'bot']) {
      assert.deepEqual(restored.game.canonicalView(seat), game.canonicalView(seat));
      assertPrivateView(restored.game.view(seat));
    }
  } finally { restored.game.close(); }
}

test('the original Luke starter gives its Gunship a named space Ambush choice and preserves it through replay', async () => {
  const { game, record, action } = await prepareSpaceAmbush();
  try {
    let view = applyAction(record, game, action, 'human');
    const ship = view.players.human.space.find(card => card.uuid === action.cardId);
    assert.equal(ship.name, 'Auzituck Liberator Gunship');
    assert.equal(ship.exhausted, true);
    assert.equal(view.prompt.type, 'optionalTrigger');
    assert.equal(view.prompt.ability.label, 'Ambush');
    assert.equal(view.prompt.ability.sourceCard.uuid, ship.uuid);
    await assertReplay(game, record);

    view = applyAction(record, game, button(view, 'trigger'), 'human');
    assert.equal(view.prompt.attackerId, ship.uuid);
    assert.equal(view.prompt.ability.label, 'Ambush');
    assert.deepEqual(view.legalActions.filter(action => action.type === 'card').map(action => action.label), ['TIE/ln Fighter']);
    assert.throws(() => game.submit({ type: 'card', cardId: view.players.bot.base.uuid, promptId: view.prompt.id }, 'human'), /not legal/);
    assert.deepEqual(game.view('human'), view, 'Rejecting a base target must preserve the pending Ambush attack.');
    await assertReplay(game, record);
    const readyResources = view.players.human.readyResources;
    const target = view.legalActions.find(action => action.label === 'TIE/ln Fighter');
    view = applyAction(record, game, target, 'human');
    assert.ok(view.players.bot.discard.some(card => card.uuid === target.cardId));
    assert.equal(view.players.bot.base.damage, 0);
    assert.equal(view.players.human.readyResources, readyResources);
    assert.equal(view.players.human.space.find(card => card.uuid === ship.uuid).exhausted, true);
    assert.ok(game.botView().prompt.active);
  } finally { game.close(); }
});

for (const targets of [[], ['Cell Block Guard']]) {
  test(`Luke's space Ambush cannot attack ${targets.length ? 'an enemy ground unit' : 'the enemy base when no units are present'}`, async () => {
    const { game, record, action } = await prepareSpaceAmbush({ targets });
    try {
      const view = applyAction(record, game, action, 'human');
      assert.equal(view.players.bot.space.length, 0);
      assert.equal(view.players.human.space.find(card => card.uuid === action.cardId).exhausted, true);
      assert.equal(view.prompt.ability, undefined);
      assert.ok(!view.legalActions.some(action => action.arg === 'trigger'));
      assert.equal(view.players.bot.base.damage, 0);
      assert.ok(game.botView().prompt.active);
      assertPrivateView(view);
    } finally { game.close(); }
  });
}

let smugglerRecipe;
async function smugglerDeck() {
  if (!smugglerRecipe) {
    // Three existing singletons become three copies of this real space unit.
    // Echo Base provides Command so the printed cost is payable with five resources.
    const result = await importCustomDeck({ ...luke, base: { id: 'SOR_024' },
      deck: luke.deck.filter(card => !['SOR_244', 'SOR_198', 'SOR_195'].includes(card.id))
        .concat({ id: 'LAW_148', count: 3 }) }, { name: 'Space Ambush ordering fixture', allowUrl: false });
    assert.deepEqual(result.errors, []);
    smugglerRecipe = result.deck.recipe;
  }
  return smugglerRecipe;
}

function assertTriggerMenu(view, shipId, ambushHasEffects) {
  assert.equal(view.prompt.type, 'triggerWindow');
  assert.equal(view.prompt.ability, undefined, 'No single ability is active before choosing its resolution order.');
  assert.equal(view.prompt.buttons.length, 2);
  const ambush = view.prompt.buttons.find(button => button.label === 'Ambush');
  const whenPlayed = view.prompt.buttons.find(button => /give this unit \+1\/\+1/.test(button.label));
  assert.ok(ambush);
  assert.ok(whenPlayed);
  assert.equal(whenPlayed.label, 'Pay 1 resource to give this unit +1/+1 for this phase');
  assert.equal(Boolean(ambush.hasLegalEffects), ambushHasEffects);
  assert.equal(whenPlayed.hasLegalEffects, true);
  for (const choice of [ambush, whenPlayed]) {
    assert.equal(choice.sourceCard.uuid, shipId);
    assert.equal(choice.sourceCard.name, "Smuggler's YT-2400");
    const action = button(view, choice.arg);
    assert.equal(action.label, choice.text, 'The native action text remains compatible.');
    assert.equal(action.abilityLabel, choice.label);
    assert.equal(action.hasLegalEffects, choice.hasLegalEffects);
    assert.equal(action.sourceCard.uuid, shipId);
  }
  assertPrivateView(view);
  return { ambush, whenPlayed };
}

for (const first of ['ambush', 'whenPlayed']) {
  test(`space Ambush and When Played retain named source choices and both resolve when ${first} is chosen first`, async () => {
    const { game, record, action, view: before } = await prepareSpaceAmbush({ playerDeck: await smugglerDeck(),
      name: "Smuggler's YT-2400", minReadyResources: 6 });
    try {
      let view = applyAction(record, game, action, 'human');
      const choices = assertTriggerMenu(view, action.cardId, true);
      await assertReplay(game, record);
      view = applyAction(record, game, button(view, choices[first].arg), 'human');

      for (const kind of first === 'ambush' ? ['ambush', 'whenPlayed'] : ['whenPlayed', 'ambush']) {
        assert.equal(view.prompt.type, 'optionalTrigger');
        assert.equal(view.prompt.ability.sourceCard.uuid, action.cardId);
        assert.equal(view.prompt.ability.label === 'Ambush', kind === 'ambush');
        view = applyAction(record, game, button(view, 'trigger'), 'human');
        if (kind === 'ambush') {
          assert.equal(view.prompt.attackerId, action.cardId);
          const target = view.legalActions.find(action => action.label === 'TIE/ln Fighter');
          assert.ok(target);
          view = applyAction(record, game, target, 'human');
          assert.ok(view.players.bot.discard.some(card => card.uuid === target.cardId));
        }
      }
      const ship = view.players.human.space.find(card => card.uuid === action.cardId);
      assert.equal(ship.power, 5, 'The optional When Played payment grants +1 power.');
      assert.equal(ship.hp, 6, 'The optional When Played payment grants +1 HP.');
      assert.equal(ship.exhausted, true);
      assert.equal(view.players.human.readyResources, before.players.human.readyResources - 6,
        'The play costs five resources and When Played pays one more.');
      assert.equal(view.players.bot.base.damage, 0);
      assert.ok(['human', 'bot'].some(seat => game.view(seat).prompt.stage === 'action'));
      await assertReplay(game, record);
    } finally { game.close(); }
  });
}

test('a simultaneous Ambush with no legal space defender stays marked as no effect while When Played remains available', async () => {
  const { game, record, action } = await prepareSpaceAmbush({ playerDeck: await smugglerDeck(),
    name: "Smuggler's YT-2400", targets: ['Cell Block Guard'], minReadyResources: 6 });
  try {
    let view = applyAction(record, game, action, 'human');
    const { ambush } = assertTriggerMenu(view, action.cardId, false);
    view = applyAction(record, game, button(view, ambush.arg), 'human');
    assert.equal(view.prompt.type, 'optionalTrigger');
    assert.ok(/give this unit \+1\/\+1/.test(view.prompt.ability.label));
    assert.equal(view.players.human.space.find(card => card.uuid === action.cardId).exhausted, true);
    assert.equal(view.players.bot.base.damage, 0);
    view = applyAction(record, game, button(view, 'trigger'), 'human');
    assert.equal(view.players.human.space.find(card => card.uuid === action.cardId).power, 5);
    assert.ok(['human', 'bot'].some(seat => game.view(seat).prompt.stage === 'action'));
    await assertReplay(game, record);
  } finally { game.close(); }
});
