'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createGame } = require('../server/engine.cjs');
const { chooseAction } = require('../server/bot.cjs');
const { readDecks, assertPrivateView } = require('../scripts/smoke.cjs');

const decks = readDecks();
const options = {
  playerDeck: decks.find(deck => deck.id === 'sor-luke-skywalker'),
  botDeck: decks.find(deck => deck.id === 'sor-darth-vader'),
};
const difficulties = ['easy', 'normal', 'hard'];

// Reach actual native prompts using only the normal policy and public commands.
// No cards, resource counts, prompts or private deck information are injected.
async function nativePrompt(seed, predicate, maxActions = 450) {
  const game = await createGame({ ...options, seed });
  const memories = { human: {}, bot: {} };
  try {
    for (let step = 0; step < maxActions; step++) {
      const views = ['human', 'bot'].map(seat => game.view(seat));
      views.forEach(assertPrivateView);
      const view = views.find(view => view.prompt.active);
      assert.ok(view, `The real game must reach the requested prompt before ending (seed ${seed}, step ${step}).`);
      if (predicate(view)) return { game, view, memory: memories[view.viewerId], step };
      const decision = chooseAction(view, { difficulty: 'normal', memory: memories[view.viewerId] });
      assert.ok(decision.action, 'The policy must choose a native legal command.');
      game.submit(decision.action, view.viewerId);
    }
    assert.fail(`The real game must reach the requested prompt within ${maxActions} public actions.`);
  } catch (error) { game.close(); throw error; }
}

function decisions(view, memory) {
  return difficulties.map(difficulty => chooseAction(view, { difficulty, memory: structuredClone(memory) }));
}

test('all difficulties cancel Vader’s explicit no-effect warning without spending resources, exhausting him or repeating the action', async () => {
  const { game, view, memory, step } = await nativePrompt(1,
    view => view.viewerId === 'bot' && /will have no effect/.test(view.prompt.title), 80);
  try {
    assert.equal(step, 40, 'The original starter regression stays bounded and deterministic.');
    assert.equal(view.round, 3);
    assert.match(view.prompt.title, /Deal 1 damage to a unit and 1 damage to a base/);
    assert.deepEqual(view.legalActions.map(action => action.label), ['Use it anyway', 'Cancel']);
    assert.equal(view.players.bot.readyResources, 1);
    assert.equal(view.players.bot.leader.exhausted, false);
    const choices = decisions(view, memory);
    for (const choice of choices) {
      assert.equal(choice.action.label, 'Cancel', choice.difficulty);
      assert.equal(choice.reason, 'Canceling an ability that would have no effect.');
      assert.doesNotMatch(choice.reason, /beneficial|gain an advantage/i);
    }

    const normal = choices.find(choice => choice.difficulty === 'normal');
    const after = game.submit(normal.action, view.viewerId);
    assert.equal(after.players.bot.readyResources, view.players.bot.readyResources);
    assert.equal(after.players.bot.resourceCount, view.players.bot.resourceCount);
    assert.equal(after.players.bot.leader.exhausted, view.players.bot.leader.exhausted);
    assert.deepEqual(after.publicDamageEvents, view.publicDamageEvents);
    assert.equal(after.prompt.type, 'actionWindow');
    assert.equal(after.prompt.active, true, 'Cancellation returns to the same player’s action.');
    const next = chooseAction(after, { difficulty: 'normal', memory: normal.memory });
    assert.ok(next.action);
    assert.notEqual(next.action.cardId, after.players.bot.leader.uuid,
      'Existing no-progress memory must prevent immediately reopening the same effectless action.');
    game.submit(next.action, view.viewerId);
    assertPrivateView(game.view('human'));
    assertPrivateView(game.botView());
  } finally { game.close(); }
});

test('a meaningful native leader deployment confirmation is still accepted at every difficulty', async () => {
  const { game, view, memory } = await nativePrompt(1, view => view.prompt.type !== 'actionWindow'
    && view.legalActions.some(action => action.type === 'button' && /^Deploy\b/.test(action.label))
    && view.legalActions.some(action => action.type === 'button' && action.label === 'Cancel'));
  try {
    assert.doesNotMatch(view.prompt.title, /will have no effect/);
    const choices = decisions(view, memory);
    for (const choice of choices) {
      assert.match(choice.action.label, /^Deploy\b/, choice.difficulty);
      assert.equal(choice.reason, 'Continuing the planned tactical action.');
    }
    const before = view.players[view.viewerId];
    const after = game.submit(choices.find(choice => choice.difficulty === 'normal').action, view.viewerId);
    assert.equal(after.players[view.viewerId].leader.deployed, true);
    assert.equal(after.players[view.viewerId].readyResources, before.readyResources,
      'The normal meaningful deployment still resolves under native rules without paying resources.');
  } finally { game.close(); }
});

test('an ordinary native optional Ambush remains accepted at every difficulty', async () => {
  const { game, view, memory } = await nativePrompt(101,
    view => view.prompt.type === 'optionalTrigger' && view.prompt.ability?.label === 'Ambush', 160);
  try {
    assert.deepEqual(view.legalActions.map(action => action.label), ['Trigger', 'Pass']);
    const choices = decisions(view, memory);
    for (const choice of choices) {
      assert.equal(choice.action.arg, 'trigger', choice.difficulty);
      assert.equal(choice.reason, 'Using a beneficial card effect.');
    }
    const after = game.submit(choices.find(choice => choice.difficulty === 'normal').action, view.viewerId);
    assert.equal(after.prompt.attackerId, view.prompt.ability.sourceCard.uuid);
    assert.equal(after.prompt.ability.label, 'Ambush');
    assert.ok(after.legalActions.some(action => action.type === 'card'), 'The normal optional effect still reaches real target selection.');
  } finally { game.close(); }
});
