'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { randomBytes } = require('node:crypto');
process.env.SWU_SESSION_SECRET ||= randomBytes(32).toString('hex');
const { createGame } = require('../server/engine.cjs');
const { createRecord, applyAction, sealRecord, restoreRecord } = require('../server/replay.cjs');
const { chooseAction } = require('../server/bot.cjs');
const { readDecks, assertPrivateView } = require('../scripts/smoke.cjs');

const decks = readDecks();
const seats = ['human', 'bot'];
const deck = id => decks.find(candidate => candidate.id === id);
const activeView = game => seats.map(seat => game.view(seat)).find(view => view.prompt.active && view.legalActions.length);

async function openingWith(replacement, keepName) {
  const recipe = structuredClone(decks[1]);
  recipe.deck[recipe.deck.findIndex(entry => entry.count === 3)] = { id: replacement, count: 3 };
  const game = await createGame({ playerDeck: recipe, botDeck: decks[0], seed: 6 });
  try {
    let view = activeView(game);
    game.submit(view.legalActions.find(action => action.label === (view.viewerId === 'human' ? 'Yourself' : 'Opponent')), view.viewerId);
    for (let step = 0; step < 12; step++) {
      view = activeView(game);
      assert.deepEqual(view.publicPlayEvents, [], 'Mulligans and selecting facedown resources never publish card identities.');
      if (view.prompt.stage === 'action') break;
      const action = view.legalActions.find(action => action.arg === 'keep')
        || view.legalActions.find(action => action.arg === 'done')
        || view.legalActions.find(action => action.type === 'card' && action.label !== keepName && !view.prompt.selectedCardIds.includes(action.cardId));
      assert.ok(action);
      game.submit(action, view.viewerId);
    }
    assert.equal(game.view('human').prompt.stage, 'action');
    return game;
  } catch (error) { game.close(); throw error; }
}

function assertPublicFeed(game) {
  const views = seats.map(seat => game.view(seat));
  views.forEach(assertPrivateView);
  assert.deepEqual(views[0].publicPlayEvents, views[1].publicPlayEvents, 'Resolved plays are equally public to either seat.');
  const events = views[0].publicPlayEvents;
  assert.ok(events.length <= 200);
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    assert.ok(seats.includes(event.playerId));
    assert.ok(['play', 'deploy'].includes(event.kind));
    assert.equal(event.id, `${views[0].id}:public-play:${event.sequence}`);
    assert.match(event.card.uuid, /^swucard_[a-f0-9]{24}$/);
    assert.equal(event.card.hidden, false);
    assert.ok(event.card.name && event.card.image);
    if (index) assert.equal(event.sequence, events[index - 1].sequence + 1);
    for (const field of ['context', 'costs', 'originalZone', 'originallyOnTopOfDeck', 'hand', 'resources', 'upgrades', 'captured']) {
      assert.equal(Object.hasOwn(event, field), false, `Presentation events cannot contain private event ${field}.`);
      assert.equal(Object.hasOwn(event.card, field), false, `Printed snapshots cannot contain live card ${field}.`);
    }
  }
  return events;
}

test('a resolved nonstarter event has a public preview even after going to discard, without revealing resources', async () => {
  const game = await openingWith('LOF_175', 'Do or Do Not');
  try {
    const before = game.view('human');
    const card = before.players.human.hand.find(card => card.name === 'Do or Do Not');
    const action = before.legalActions.find(action => action.cardId === card.uuid);
    assert.throws(() => game.submit({ ...action, version: before.version + 1 }), /state/i);
    assert.deepEqual(game.view().publicPlayEvents, [], 'Rejected plays must not produce previews.');
    const after = game.submit(action);
    assert.ok(after.players.human.discard.some(item => item.uuid === card.uuid));
    const events = assertPublicFeed(game);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'play');
    assert.equal(events[0].playerId, 'human');
    assert.equal(events[0].card.uuid, card.uuid);
    assert.equal(events[0].card.name, 'Do or Do Not');
    assert.ok(events[0].card.types.includes('event'));
    events[0].card.name = 'Mutated browser response';
    assert.equal(game.view().publicPlayEvents[0].card.name, 'Do or Do Not', 'Client responses cannot mutate the retained snapshot.');
  } finally { game.close(); }
});

test('an upgrade awaiting an attachment target only publishes after its actual successful play', async () => {
  const game = await openingWith('HMW_112', 'Military Academy');
  try {
    let view = game.view('human');
    const card = view.players.human.hand.find(card => card.name === 'Military Academy');
    view = game.submit(view.legalActions.find(action => action.cardId === card.uuid));
    assert.match(view.prompt.title, /to a base/);
    assert.deepEqual(view.publicPlayEvents, [], 'Choosing how to play a card is not a resolved play.');
    view = game.submit(view.legalActions.find(action => action.cardId === view.players.human.base.uuid));
    assert.ok(view.players.human.base.upgrades.some(item => item.uuid === card.uuid));
    const events = assertPublicFeed(game);
    assert.equal(events.length, 1);
    assert.equal(events[0].card.uuid, card.uuid);
    assert.equal(events[0].kind, 'play');
    assert.ok(events[0].card.types.includes('upgrade'));
  } finally { game.close(); }
});

test('native units, pilots and leader deployments form one ordered replay-stable public feed, excluding created Shield tokens', { timeout: 60_000 }, async () => {
  const { game, record } = await createRecord({
    playerDeck: deck('jtl-boba-fett'), botDeck: deck('jtl-han-solo'), difficulty: 'normal', seed: 101,
  });
  const memories = { human: {}, bot: {} };
  let foundPilot = false;
  let foundShield = false;
  let oldSnapshot;
  try {
    for (let step = 0; step < 250; step++) {
      const events = assertPublicFeed(game);
      const view = activeView(game);
      if (!view) break;
      const board = Object.values(view.players).flatMap(player => [...player.ground, ...player.space]);
      for (const unit of board) for (const upgrade of unit.upgrades || []) {
        if (upgrade.internalName === 'shield') {
          foundShield = true;
          assert.ok(!events.some(event => event.card.uuid === upgrade.uuid), 'Creating a Shield does not play a card.');
        }
        if (upgrade.internalName === 'chewbacca#faithful-first-mate') {
          foundPilot = true;
          assert.ok(events.some(event => event.kind === 'play' && event.card.uuid === upgrade.uuid), 'A pilot played as an upgrade is a real card play.');
        }
      }
      if (events.length && !oldSnapshot) oldSnapshot = structuredClone(events[0]);
      if (oldSnapshot) assert.deepEqual(events.find(event => event.id === oldSnapshot.id), oldSnapshot, 'Damage, upgrades and later card movement cannot change a past reveal.');
      const decision = chooseAction(view, { difficulty: 'normal', memory: memories[view.viewerId] });
      applyAction(record, game, decision.action, view.viewerId);
      if (game.view().ended) break;
    }
    const events = assertPublicFeed(game);
    assert.ok(foundShield && foundPilot, 'The native fixture must exercise a pilot attachment and Shield creation.');
    for (const playerId of seats) {
      assert.ok(events.some(event => event.playerId === playerId && event.kind === 'play' && event.card.types.includes('unit')));
    }
    for (const event of events.filter(event => event.card.types.includes('unit') && event.kind === 'play')) {
      assert.ok(['groundArena', 'spaceArena'].includes(event.card.zone), `${event.card.name} retains its public play destination.`);
    }
    const deployed = events.filter(event => event.kind === 'deploy');
    assert.ok(deployed.length, 'The fixture reaches real leader deployment.');
    for (const event of deployed) {
      assert.ok(event.card.deployed);
      assert.equal(event.card.image, event.card.backImage);
      assert.ok(event.card.types.includes('leader'));
    }
    const restored = await restoreRecord(sealRecord(record), { decks });
    try {
      assert.deepEqual(restored.game.view().publicPlayEvents, events, 'Rebuilding an encrypted checkpoint preserves preview IDs, order and immutable printed cards.');
      assert.deepEqual(restored.game.canonicalView(), game.canonicalView());
    } finally { restored.game.close(); }
  } finally { game.close(); }
});
