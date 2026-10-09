'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createRecord, applyAction, sealRecord, restoreRecord } = require('../server/replay.cjs');
const { publicPresentationCard } = require('../server/public-presentation.cjs');
const { readDecks, assertPrivateView } = require('../scripts/smoke.cjs');

const decks = readDecks();
const unit = (view, seat, name) => [...view.players[seat].ground, ...view.players[seat].space].find(card => card.name === name);
const cardAction = (view, card) => {
  const action = view.legalActions.find(action => action.type === 'card' && action.cardId === card.uuid);
  assert.ok(action, `Expected ${card.name} during ${view.prompt.title}.`);
  return action;
};

// Build the reported situation through ordinary starter-deck choices. No
// engine-object mutation, mocked API, fabricated damage or forced board state.
async function combatFixture(activeSeat = 'human') {
  const fixture = await createRecord({
    playerDeck: decks.find(deck => deck.id === 'sor-luke-skywalker'),
    botDeck: decks.find(deck => deck.id === 'sor-darth-vader'), seed: 1, difficulty: 'normal',
  });
  const { game, record } = fixture;
  fixture.act = (view, action) => applyAction(record, game, action, view.viewerId);
  try {
    for (let step = 0; step < 180; step++) {
      const view = ['human', 'bot'].map(seat => game.view(seat)).find(view => view.prompt.active);
      assert.ok(view, 'The fixture must have a legal decision.');
      const humanUnits = ['Consular Security Force', 'Alliance X-Wing'].map(name => unit(view, 'human', name));
      const snow = unit(view, 'bot', 'First Legion Snowtrooper');
      const vader = view.players.bot.leader;
      if (view.viewerId === activeSeat && view.prompt.stage === 'action' && humanUnits.every(card => card && !card.exhausted)
        && snow && !snow.exhausted && vader.deployed && !vader.exhausted) return fixture;
      const ownNames = view.viewerId === 'human' ? ['Consular Security Force', 'Alliance X-Wing'] : ['First Legion Snowtrooper'];
      const player = view.players[view.viewerId];
      let action;
      if (view.prompt.stage === 'initiative') action = view.legalActions.find(action => action.label === (view.viewerId === 'human' ? 'Yourself' : 'Opponent'));
      else if (view.prompt.stage === 'mulligan') action = view.legalActions.find(action => action.arg === 'keep');
      else if (view.prompt.stage === 'resource') {
        if (view.prompt.selectedCardIds.length < view.prompt.resourceSelection.max) action = view.legalActions.find(action => action.type === 'card'
          && !view.prompt.selectedCardIds.includes(action.cardId) && !ownNames.includes(action.label));
        action ||= view.legalActions.find(action => action.arg === 'done');
      } else if (view.prompt.stage === 'action') {
        if (view.viewerId === 'bot' && !vader.deployed && player.resourceCount >= 7) action = view.legalActions.find(action => action.cardId === vader.uuid
          && action.abilities?.some(ability => ability.type === 'deploy'));
        action ||= view.legalActions.find(action => action.intent === 'play' && ownNames.includes(action.label) && !unit(view, view.viewerId, action.label));
        action ||= view.legalActions.find(action => action.arg === 'claimInitiative') || view.legalActions.find(action => action.arg === 'pass');
      } else action = view.legalActions.find(action => /^Deploy/.test(action.label))
        || view.legalActions.find(action => action.arg === 'pass') || view.legalActions[0];
      assert.ok(action, `Expected a setup decision during ${view.prompt.title}.`);
      fixture.act(view, action);
    }
    assert.fail('The legal fixture must reach ready combatants and deployed Vader.');
  } catch (error) { game.close(); throw error; }
}

function attack(fixture, view, attacker, target) {
  view = fixture.act(view, cardAction(view, attacker));
  return fixture.act(view, cardAction(view, target));
}

function assertFeed(game) {
  const human = game.view('human');
  const bot = game.view('bot');
  assertPrivateView(human);
  assertPrivateView(bot);
  assert.deepEqual(human.publicDamageEvents, bot.publicDamageEvents, 'Damage history contains only information public to both seats.');
  const damage = human.publicDamageEvents;
  assert.ok(damage.length <= 200);
  for (let index = 0; index < damage.length; index++) {
    const event = damage[index];
    assert.equal(event.id, `${human.id}:public-damage:${event.sequence}`);
    assert.equal(event.kind, 'damage');
    assert.ok(event.amount > 0);
    assert.ok(['human', 'bot'].includes(event.playerId));
    assert.ok(['combat', 'ability', 'overwhelm', 'excess', 'other'].includes(event.damageType));
    assert.match(event.targetCard.uuid, /^swucard_[a-f0-9]{24}$/);
    assert.equal(event.targetCard.hidden, false);
    assert.ok(!Object.hasOwn(event, 'context'));
    assert.ok(!Object.hasOwn(event, 'damageSource'));
    if (event.attack) {
      assert.match(event.attack.id, /:public-attack:\d+$/);
      assert.match(event.attack.attacker.uuid, /^swucard_[a-f0-9]{24}$/);
      assert.ok(event.attack.defenders.length);
    }
    if (index) assert.equal(event.sequence, damage[index - 1].sequence + 1);
  }
  const merged = [...human.publicPlayEvents, ...damage].sort((a, b) => a.order - b.order);
  assert.deepEqual(merged.map(event => event.order), merged.map((_event, index) => index + 1), 'Plays and damage share one chronological presentation order.');
  return damage;
}

for (const exhausted of [false, true]) {
  test(`native combat records the real ${exhausted ? 'exhausted' : 'ready'} defender as the source of returned damage, never Vader`, async () => {
    const fixture = await combatFixture(exhausted ? 'bot' : 'human');
    const { game } = fixture;
    try {
      let view = game.view(exhausted ? 'bot' : 'human');
      if (exhausted) {
        attack(fixture, view, unit(view, 'bot', 'First Legion Snowtrooper'), view.players.human.base);
        view = game.view('human');
      }
      const attacker = unit(view, 'human', 'Consular Security Force');
      const defender = unit(view, 'bot', 'First Legion Snowtrooper');
      assert.equal(defender.exhausted, exhausted);
      const previousEvents = structuredClone(view.publicDamageEvents);
      const after = attack(fixture, view, attacker, defender);
      const events = assertFeed(game).slice(previousEvents.length);
      assert.equal(events.length, 2);
      assert.deepEqual(events.map(event => [event.damageType, event.amount, event.sourceCard.name, event.targetCard.name, event.playerId]), [
        ['combat', 3, 'Consular Security Force', 'First Legion Snowtrooper', 'human'],
        ['combat', 2, 'First Legion Snowtrooper', 'Consular Security Force', 'bot'],
      ]);
      assert.equal(events[0].attack.id, events[1].attack.id);
      assert.equal(events[0].attack.attacker.uuid, attacker.uuid);
      assert.equal(events[1].attack.defender.uuid, defender.uuid);
      assert.equal(events[1].sourceCard.exhausted, exhausted);
      assert.equal(events[0].targetCard.remainingHp, 0, 'A lethally damaged target remains available as an immutable image snapshot.');
      assert.ok(after.players.bot.discard.some(card => card.uuid === defender.uuid));
      assert.equal(events[1].targetCard.damage, 2);
      assert.equal(events[1].targetCard.remainingHp, 5);
      assert.equal(events[1].targetCard.power, 3);
      assert.equal(unit(after, 'bot', 'Darth Vader').damage, 0);
      assert.equal(unit(after, 'bot', 'Darth Vader').exhausted, false);
      assert.deepEqual(after.publicDamageEvents.slice(0, previousEvents.length), previousEvents);
    } finally { game.close(); }
  });
}

test('Vader ability damage precedes his combat damage, uses the deployed face and survives checkpoint replay unchanged', async () => {
  const fixture = await combatFixture('bot');
  const { game, record } = fixture;
  try {
    let view = game.view('bot');
    const vader = view.players.bot.leader;
    view = attack(fixture, view, vader, view.players.human.base);
    assert.equal(view.prompt.title, 'Deal 2 damage to a unit');
    assert.deepEqual(view.publicDamageEvents, [], 'Declaring an attack does not fabricate damage before the native effect resolves.');
    view = fixture.act(view, cardAction(view, unit(view, 'human', 'Consular Security Force')));
    const events = assertFeed(game);
    assert.deepEqual(events.map(event => [event.damageType, event.amount, event.sourceCard.name, event.targetCard.name]), [
      ['ability', 2, 'Darth Vader', 'Consular Security Force'],
      ['combat', 5, 'Darth Vader', "Administrator's Tower"],
    ]);
    assert.equal(events[0].attack.id, events[1].attack.id, 'The trigger has attack context but remains a separate ability-damage event.');
    for (const event of events) {
      assert.equal(event.sourceCard.image, vader.backImage);
      assert.equal(event.sourceCard.deployed, true);
      assert.equal(event.sourceCard.power, 5);
      assert.equal(event.sourceCard.exhausted, true);
    }
    const snapshot = structuredClone(events);
    events[0].sourceCard.name = 'Browser mutation';
    assert.deepEqual(game.view().publicDamageEvents, snapshot);
    const restored = await restoreRecord(sealRecord(record), { decks });
    try {
      assert.deepEqual(restored.game.view().publicDamageEvents, snapshot, 'Native attack IDs, public IDs, ordering and snapshots are replay-stable.');
      assert.deepEqual(restored.game.view().publicPlayEvents, game.view().publicPlayEvents);
    } finally { restored.game.close(); }
  } finally { game.close(); }
});

test('a Shield-prevented return hit emits no damage event', async () => {
  const fixture = await combatFixture();
  const { game } = fixture;
  try {
    let view = game.view('human');
    view = fixture.act(view, cardAction(view, view.players.human.leader));
    if (!view.players.human.leader.deployed) {
      const deploy = view.legalActions.find(action => /^Deploy/.test(action.label));
      assert.ok(deploy);
      view = fixture.act(view, deploy);
    }
    view = attack(fixture, view, view.players.human.leader, view.players.bot.base);
    view = fixture.act(view, cardAction(view, unit(view, 'human', 'Consular Security Force')));
    const force = unit(view, 'human', 'Consular Security Force');
    assert.ok(force.upgrades.some(card => card.name === 'Shield'));
    const before = view.publicDamageEvents.length;
    const snow = unit(view, 'bot', 'First Legion Snowtrooper');
    view = attack(fixture, view, force, snow);
    const events = assertFeed(game).slice(before);
    assert.equal(events.length, 1, 'The Shield consumes the two-power retaliation without a fake damage hit.');
    assert.equal(events[0].sourceCard.uuid, force.uuid);
    assert.equal(events[0].targetCard.uuid, snow.uuid);
    assert.equal(events[0].amount, 3);
    assert.equal(unit(view, 'human', 'Consular Security Force').damage, 0);
    assert.ok(!unit(view, 'human', 'Consular Security Force').upgrades.some(card => card.name === 'Shield'));
  } finally { game.close(); }
});

test('the damage feed reports actual damage added rather than unspent overkill power', async () => {
  const fixture = await combatFixture('bot');
  const { game } = fixture;
  try {
    let view = game.view('bot');
    view = attack(fixture, view, view.players.bot.leader, view.players.human.base);
    // Vader may damage any unit: leave his three-HP Snowtrooper at one HP.
    view = fixture.act(view, cardAction(view, unit(view, 'bot', 'First Legion Snowtrooper')));
    view = game.view('human');
    const snow = unit(view, 'bot', 'First Legion Snowtrooper');
    assert.equal(snow.remainingHp, 1);
    const before = view.publicDamageEvents.length;
    view = attack(fixture, view, unit(view, 'human', 'Consular Security Force'), snow);
    const events = assertFeed(game).slice(before);
    assert.deepEqual(events.map(event => [event.amount, event.sourceCard.power, event.targetCard.name]), [
      [1, 3, 'First Legion Snowtrooper'], [2, 2, 'Consular Security Force'],
    ]);
    assert.equal(events[0].targetCard.damage, 3);
    assert.equal(events[0].targetCard.remainingHp, 0);
  } finally { game.close(); }
});

test('private source snapshots are omitted without forced visibility or reading their printed identity', () => {
  const players = [{ id: 'human' }, { id: 'bot' }];
  const printed = { id: '1234567890', types: ['unit'], text: 'Private text', traits: ['secret'] };
  const card = { cardData: printed, uuid: 'private-card', zoneName: 'hand', getSummary(player, forceVisible) {
    assert.equal(forceVisible, undefined, 'The normal visibility API must be used.');
    return player.id === 'human' ? { id: printed.id, type: 'basicUnit' } : { zone: 'hand' };
  } };
  assert.equal(publicPresentationCard(card, players, () => assert.fail('Hidden printed card data cannot be published.')), undefined);
  card.zoneName = 'resource';
  assert.equal(publicPresentationCard(card, players, () => assert.fail('Private resource data cannot be published.')), undefined);
  card.zoneName = 'groundArena';
  card.getSummary = (_player, forceVisible) => {
    assert.equal(forceVisible, undefined);
    return { id: printed.id, type: 'basicUnit', hp: 5, power: 2, damage: 1, exhausted: true, controllerId: 'human', ownerId: 'bot' };
  };
  const snapshot = publicPresentationCard(card, players, data => ({ ...data, image: 'public-card.png' }));
  assert.equal(snapshot.remainingHp, 4);
  assert.equal(snapshot.controllerId, 'human');
  assert.equal(snapshot.ownerId, 'bot');
  printed.traits.push('later mutation');
  assert.deepEqual(snapshot.traits, ['secret'], 'A public snapshot does not retain mutable card-data arrays.');
  assert.equal(snapshot.hidden, false);
});
