'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { once } = require('node:events');
const { createGame } = require('../server/engine.cjs');
const { chooseAction } = require('../server/bot.cjs');
const { createRecord, applyAction, sealRecord } = require('../server/replay.cjs');
const { readDecks, assertPrivateView } = require('../scripts/smoke.cjs');

const decks = readDecks();
const luke = decks.find(deck => deck.id === 'sor-luke-skywalker');
const vader = decks.find(deck => deck.id === 'sor-darth-vader');
// A legal 50-card custom deck: replace three singletons with three Hunters.
// Every fixture is reached through the same public actions as a real game.
const hunterDeck = { ...luke, deck: luke.deck.filter(card => !['SOR_244', 'SOR_198', 'SOR_195'].includes(card.id))
  .concat({ id: 'JTL_216', count: 3 }) };
const units = player => [...player.ground, ...player.space];
const button = (view, arg) => {
  const action = view.legalActions.find(action => action.type === 'button' && action.arg === arg);
  assert.ok(action, `Expected ${arg} during ${view.prompt.title}.`);
  return action;
};

async function prepareHunter(scenario, attackerId = 'human') {
  const defenderId = attackerId === 'human' ? 'bot' : 'human';
  const game = await createGame({ playerDeck: attackerId === 'human' ? hunterDeck : vader,
    botDeck: attackerId === 'bot' ? hunterDeck : vader, seed: 1, difficulty: 'normal' });
  const targets = scenario === 'sentinel' ? ['Cell Block Guard', 'Death Star Stormtrooper']
    : scenario === 'ground' ? ['Cell Block Guard'] : scenario === 'space' ? ['TIE/ln Fighter'] : [];
  try {
    for (let step = 0; step < 160; step++) {
      const view = ['human', 'bot'].map(seat => game.view(seat)).find(view => view.prompt.active);
      assert.ok(view, 'A legal fixture decision must be available.');
      const player = view.players[view.viewerId];
      const attacking = view.viewerId === attackerId;
      let action;
      if (view.prompt.stage === 'initiative') action = view.legalActions.find(action => action.label === (attacking ? 'Yourself' : 'Opponent'));
      else if (view.prompt.stage === 'mulligan') action = button(view, 'keep');
      else if (view.prompt.stage === 'resource') {
        if (view.prompt.selectedCardIds.length < view.prompt.resourceSelection.max) {
          action = view.legalActions.find(action => action.type === 'card' && !view.prompt.selectedCardIds.includes(action.cardId)
            && !(attacking ? action.label === 'Contracted Hunter' : targets.includes(action.label)));
        }
        action ||= button(view, 'done');
      } else if (view.prompt.stage === 'action') {
        if (attacking && targets.every(name => units(view.players[defenderId]).some(card => card.name === name))) {
          action = view.legalActions.find(action => action.intent === 'play' && action.label === 'Contracted Hunter');
          if (action) return { game, view, action, attackerId, defenderId };
        }
        if (!attacking) action = view.legalActions.find(action => action.intent === 'play' && targets.includes(action.label)
          && !units(player).some(card => card.name === action.label));
        action ||= view.legalActions.find(action => action.arg === 'claimInitiative') || button(view, 'pass');
      } else action = view.legalActions.find(action => action.arg === 'pass') || view.legalActions[0];
      assert.ok(action, `A fixture choice must exist during ${view.prompt.title}.`);
      game.submit(action, view.viewerId);
    }
    assert.fail('The real custom deck must reach a playable Hunter.');
  } catch (error) { game.close(); throw error; }
}

test('Ambush names its optional ability and exhausted source, then attacks a legal Sentinel without readying', async () => {
  const { game, view: before, action } = await prepareHunter('sentinel');
  try {
    const initialEnemyBaseDamage = before.players.bot.base.damage;
    let view = game.submit(action, 'human');
    const hunterId = action.cardId;
    const hunter = units(view.players.human).find(card => card.uuid === hunterId);
    assert.equal(hunter.exhausted, true, 'Ambush does not make the unit ready for an ordinary action.');
    assert.equal(view.prompt.type, 'optionalTrigger');
    assert.equal(view.prompt.ability.label, 'Ambush');
    assert.equal(view.prompt.ability.optional, true);
    assert.equal(view.prompt.ability.sourceCard.uuid, hunterId);
    assert.equal(view.prompt.ability.sourceCard.exhausted, true);
    const trigger = button(view, 'trigger');
    assert.equal(trigger.label, 'Trigger', 'Native command labels stay compatible with saved actions and the bot.');
    assert.equal(trigger.abilityLabel, 'Ambush');
    assert.equal(trigger.sourceCard.uuid, hunterId);
    const triggerButton = view.prompt.buttons.find(button => button.arg === 'trigger');
    assert.equal(triggerButton.label, 'Ambush');
    assert.equal(triggerButton.sourceCard.image, hunter.image);
    assertPrivateView(view);
    const resourcesAfterPlay = view.players.human.readyResources;

    view = game.submit(trigger, 'human');
    assert.equal(view.prompt.ability.label, 'Ambush');
    assert.equal(view.prompt.ability.optional, false);
    assert.equal(view.prompt.attackerId, hunterId, 'The target picker identifies the native attacker.');
    const legalTargets = view.legalActions.filter(action => action.type === 'card');
    assert.deepEqual(legalTargets.map(action => action.label), ['Cell Block Guard'], 'Sentinel blocks the other enemy ground unit.');
    assert.ok(!view.legalActions.some(action => action.arg === 'pass'), 'After accepting Ambush, its attack must be completed.');
    for (const card of [view.players.bot.base, view.players.bot.ground.find(card => !card.sentinel)]) {
      assert.throws(() => game.submit({ type: 'card', cardId: card.uuid, promptId: view.prompt.id }, 'human'), /not legal/);
      assert.deepEqual(game.view('human'), view, 'Illegal Ambush targets cannot partially change the game.');
    }
    const target = units(view.players.bot).find(card => card.uuid === legalTargets[0].cardId);
    const after = game.submit(legalTargets[0], 'human');
    const survivor = units(after.players.human).find(card => card.uuid === hunterId);
    assert.equal(survivor.exhausted, true);
    assert.equal(survivor.damage, target.power, 'The exhausted Ambush attacker deals and receives real combat damage.');
    assert.ok(after.players.bot.discard.some(card => card.uuid === target.uuid));
    assert.equal(after.players.bot.base.damage, initialEnemyBaseDamage);
    assert.equal(after.players.human.readyResources, resourcesAfterPlay, 'The Ambush attack pays no additional resources.');
    assert.equal(after.prompt.ability, undefined, 'The completed attack does not leave a stale Ambush prompt.');
    assert.ok(game.view('bot').prompt.active, 'Ambush finishes within the same play action, then returns priority.');
  } finally { game.close(); }
});

test('declining Ambush keeps the played unit exhausted and does not attack or spend another action', async () => {
  const { game, action } = await prepareHunter('ground');
  try {
    const prompt = game.submit(action, 'human');
    const enemyBefore = prompt.players.bot;
    const after = game.submit(button(prompt, 'pass'), 'human');
    assert.equal(units(after.players.human).find(card => card.uuid === action.cardId).exhausted, true);
    assert.deepEqual(after.players.bot.ground, enemyBefore.ground);
    assert.deepEqual(after.players.bot.base, enemyBefore.base);
    assert.equal(after.prompt.ability, undefined);
    assert.ok(game.view('bot').prompt.active);
  } finally { game.close(); }
});

for (const scenario of ['empty', 'space']) {
  test(`Ambush with ${scenario === 'space' ? 'only enemy units in the other arena' : 'no enemy units'} offers no attack and leaves the unit exhausted`, async () => {
    const { game, action } = await prepareHunter(scenario);
    try {
      const view = game.submit(action, 'human');
      assert.equal(units(view.players.human).find(card => card.uuid === action.cardId).exhausted, true);
      assert.equal(view.prompt.ability, undefined);
      assert.ok(!view.legalActions.some(action => action.arg === 'trigger'));
      assert.equal(view.players.bot.base.damage, 0);
      assert.ok(game.view('bot').prompt.active);
    } finally { game.close(); }
  });
}

test('the opposing bot accepts its own Ambush and attacks only the native legal defender', async () => {
  const { game, action } = await prepareHunter('sentinel', 'bot');
  try {
    const prompt = game.submit(action, 'bot');
    const memory = {};
    assert.equal(prompt.prompt.ability.label, 'Ambush');
    const trigger = chooseAction(prompt, { difficulty: 'normal', memory });
    assert.equal(trigger.action.arg, 'trigger');
    const targets = game.submit(trigger.action, 'bot');
    assert.equal(targets.prompt.attackerId, action.cardId);
    const choice = chooseAction(targets, { difficulty: 'normal', memory });
    assert.equal(choice.action.type, 'card');
    assert.equal(choice.action.label, 'Cell Block Guard');
    assertPrivateView(game.view('human'));
    const result = game.submit(choice.action, 'bot');
    assert.ok(result.players.human.discard.some(card => card.uuid === choice.action.cardId));
    assert.equal(units(result.players.bot).find(card => card.uuid === action.cardId).exhausted, true);
  } finally { game.close(); }
});

test('real HTTP autoplay preserves the human Ambush choice and resolves its exhausted attack after confirmation', { timeout: 60_000 }, async () => {
  const { app } = require('../server/index.cjs');
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { game, record } = await createRecord({ playerDeck: luke, botDeck: vader, seed: 101, difficulty: 'normal' });
  const memories = { human: {}, bot: {} };
  let view;
  const request = async (path, body, expected = 200, method = 'POST') => {
    const response = await fetch(`${origin}/api/games/${record.id}${path}`, { method,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json().catch(() => null);
    assert.equal(response.status, expected, JSON.stringify(data));
    return data;
  };
  try {
    for (let step = 0; step < 80; step++) {
      const current = ['human', 'bot'].map(seat => game.view(seat)).find(view => view.prompt.active);
      if (current.viewerId === 'human' && current.prompt.ability?.label === 'Ambush') break;
      applyAction(record, game, chooseAction(current, { difficulty: 'normal', memory: memories[current.viewerId] }).action, current.viewerId);
    }
    assert.equal(game.view('human').prompt.ability?.sourceCard.name, 'Snowspeeder', 'The deterministic real game reaches the reported Ambush flow.');
    view = await request('/state', { sessionToken: sealRecord(record) });
    const version = view.version;
    view = await request('/bot', { sessionToken: view.sessionToken });
    assert.equal(view.version, version, 'Server bot autoplay must not accept or skip the human optional ability.');
    assert.equal(view.prompt.ability.label, 'Ambush');
    const attackerId = view.prompt.ability.sourceCard.uuid;
    view = await request('/actions', { ...button(view, 'trigger'), version: view.version, sessionToken: view.sessionToken });
    assert.equal(view.prompt.ability.label, 'Ambush');
    assert.equal(view.prompt.ability.optional, false);
    assert.equal(view.prompt.attackerId, attackerId);
    assert.equal(units(view.players.human).find(card => card.uuid === attackerId).exhausted, true);
    const targetAction = view.legalActions.find(action => action.type === 'card');
    const target = units(view.players.bot).find(card => card.uuid === targetAction.cardId);
    assert.equal(target.name, 'Cell Block Guard');
    assert.equal(target.sentinel, true);
    view = await request('/actions', { ...targetAction, version: view.version, sessionToken: view.sessionToken });
    assert.deepEqual(view.warnings, []);
    assert.ok(view.players.bot.discard.some(card => card.uuid === target.uuid));
    assert.ok(view.log.some(entry => /attacks Cell Block Guard with Snowspeeder/.test(entry.text)));
    assertPrivateView(view);
  } finally {
    game.close();
    if (view?.sessionToken) await request('', { sessionToken: view.sessionToken }, 204, 'DELETE');
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
