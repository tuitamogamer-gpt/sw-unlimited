'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

// Exercise the browser's pure event projection with public game views only.
const filename = path.resolve(__dirname, '../src/battle-feedback-events.ts');
const compiled = new Module(filename, module);
compiled._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, filename);
const {
  captureBattleSnapshot,
  diffBattleSnapshots,
  mergeBattleEvents,
  summarizeBattleEvents,
} = compiled.exports;

function card(uuid, extra = {}) {
  return { uuid, name: uuid, type: 'unit', hp: 6, power: 3, damage: 0, hidden: false, upgrades: [], captured: [], ...extra };
}

function game(version = 1, extra = {}) {
  const player = id => ({
    id, name: id, base: card(`${id}-base`, { type: 'base', hp: 30 }),
    leader: card(`${id}-leader`, { type: 'leader' }), leaders: [],
    hand: [], ground: [], space: [], resources: [], discard: [], outsideTheGame: [],
    handCount: 0, deckCount: 42, resourceCount: 2, readyResources: 2,
    hasInitiative: id === 'human', active: id === 'human',
  });
  return {
    id: 'game-a', version, phase: 'action', round: 2, viewerId: 'human',
    winnerIds: [], players: { human: player('human'), bot: player('bot') },
    prompt: { id: `prompt-${version}`, active: true, selectedCardIds: [], selectableCardIds: [], buttons: [], displayCards: [] },
    legalActions: [], log: [], ...extra,
  };
}

function snapshot(view) { return captureBattleSnapshot(view); }
function diff(before, after, now = 1_000, options) {
  return diffBattleSnapshots(before && snapshot(before), snapshot(after), now, options);
}
function kinds(events) { return events.map(event => event.kind).sort(); }
function event(events, kind, cardId) {
  const found = events.find(value => value.kind === kind && value.cardId === cardId);
  assert.ok(found, `Expected ${kind} event on ${cardId}`);
  return found;
}

test('one resolution preserves simultaneous damage, healing, entry and a broken shield', () => {
  const before = game(4);
  before.players.human.base.damage = 4;
  before.players.human.ground = [card('guard', {
    upgrades: [card('shield-one', { type: 'token upgrade', name: 'Shield', hp: undefined, power: undefined })],
  })];
  const after = game(5);
  after.players.human.base.damage = 2;
  after.players.human.ground = [card('guard', { damage: 3 })];
  after.players.bot.space = [card('fighter')];

  const events = diff(before, after);
  assert.deepEqual(kinds(events), ['damage', 'enter', 'heal', 'shieldBreak']);
  assert.equal(event(events, 'damage', 'guard').amount, 3);
  assert.equal(event(events, 'heal', 'human-base').amount, 2);
  assert.equal(event(events, 'enter', 'fighter').zone, 'space');
  const shield = event(events, 'shieldBreak', 'guard');
  assert.equal(shield.subjectId, 'shield-one');
  assert.equal(shield.playerId, 'human');
  for (const item of events) {
    assert.equal(item.startedAt, 1_000);
    assert.equal(item.expiresAt, 3_000);
  }
  const summary = summarizeBattleEvents(events, 'Attack resolved');
  assert.equal(summary.message, 'Attack resolved');
  assert.deepEqual([...summary.added], ['fighter']);
  assert.deepEqual([...summary.damaged], ['guard']);
  assert.deepEqual([...summary.healed], ['human-base']);
  assert.equal(summary.baseChanges.human, 2);
  assert.equal(summary.byCard.guard.length, 2);
  assert.deepEqual(summary.events, events);
});

test('health and power changes do not masquerade as damage or healing', () => {
  const before = game(4);
  before.players.human.ground = [card('guard', { hp: 5, remainingHp: 3, damage: 2 })];
  before.players.human.base.damage = 8;
  const buffed = game(5);
  buffed.players.human.ground = [card('guard', { hp: 7, remainingHp: 5, power: 5, damage: 2 })];
  buffed.players.human.base = card('human-base', { type: 'base', hp: 35, damage: 8, remainingHp: 27 });
  assert.deepEqual(diff(before, buffed), []);

  const reduced = game(6);
  reduced.players.human.ground = [card('guard', { hp: 4, remainingHp: 2, power: 2, damage: 2 })];
  reduced.players.human.base = card('human-base', { type: 'base', hp: 25, damage: 8, remainingHp: 17 });
  assert.deepEqual(diff(buffed, reduced), []);
});

test('a newly entered unit can show damage already dealt within the same server response', () => {
  const before = game(6);
  const after = game(9);
  after.players.human.ground = [card('new-arrival', { hp: 7, damage: 3, remainingHp: 4 })];
  const events = diff(before, after);
  assert.deepEqual(kinds(events), ['damage', 'enter']);
  assert.equal(event(events, 'damage', 'new-arrival').amount, 3);
  assert.equal(summarizeBattleEvents(events).byCard['new-arrival'].length, 2);
});

test('two hits on the same card have distinct identities and retain their own expiry', () => {
  const first = game(10);
  first.players.human.ground = [card('guard')];
  const second = game(11);
  second.players.human.ground = [card('guard', { damage: 1 })];
  const third = game(12);
  third.players.human.ground = [card('guard', { damage: 3 })];
  const hitOne = diff(first, second, 1_000);
  const hitTwo = diff(second, third, 1_500);
  assert.notEqual(hitOne[0].id, hitTwo[0].id);
  assert.equal(hitOne[0].amount, 1);
  assert.equal(hitTwo[0].amount, 2);
  const active = mergeBattleEvents(hitOne, hitTwo, 1_500);
  assert.equal(active.length, 2);
  assert.deepEqual(active.map(value => value.expiresAt).sort(), [3_000, 3_500]);
  assert.deepEqual(mergeBattleEvents(active, [], 3_000), hitTwo);
  assert.deepEqual(mergeBattleEvents(active, [], 3_500), []);
});

test('rapid unrelated deltas merge without erasing live feedback or duplicating an event', () => {
  const first = game(20);
  const second = game(21);
  second.players.bot.base.damage = 3;
  const third = game(22);
  third.players.bot.base.damage = 3;
  third.players.human.space = [card('reinforcement')];
  const damage = diff(first, second, 100);
  const entry = diff(second, third, 500);
  const active = mergeBattleEvents(damage, entry, 500);
  assert.deepEqual(kinds(active), ['damage', 'enter']);
  const duplicate = mergeBattleEvents(active, entry, 600);
  assert.deepEqual(duplicate, active);
  assert.equal(summarizeBattleEvents(active).baseChanges.bot, -3);
  assert.deepEqual(mergeBattleEvents(active, [], 2_100), entry);
});

test('initial load, resume, another game, duplicate versions and rewinds suppress feedback', () => {
  const prior = game(8);
  const loaded = game(9);
  loaded.players.human.ground = [card('already-on-board')];
  loaded.players.bot.base.damage = 12;
  assert.deepEqual(diff(null, loaded), [], 'Loading a saved game must not animate its existing board.');
  assert.deepEqual(diff(prior, loaded, 1_000, { reset: true }), [], 'Explicit resume resets the baseline.');
  assert.deepEqual(diff(prior, { ...loaded, id: 'another-game' }), []);
  assert.deepEqual(diff(prior, { ...loaded, version: 8 }), []);
  assert.deepEqual(diff(prior, { ...loaded, version: 7 }), []);
  assert.deepEqual(diff(prior, { ...loaded, version: 0 }), []);
});

test('draw feedback uses only a new visible own-hand card, not a returning battlefield unit', () => {
  const before = game(30);
  before.players.human.hand = [card('kept-card')];
  before.players.human.ground = [card('bounced-unit')];
  before.players.human.discard = [card('recovered-unit')];
  const after = game(31);
  after.players.human.deckCount = 41;
  after.players.human.hand = [card('kept-card'), card('new-card'), card('bounced-unit'), card('recovered-unit')];
  const events = diff(before, after);
  assert.deepEqual(kinds(events), ['draw']);
  assert.equal(events[0].cardId, 'new-card');
  assert.equal(events[0].playerId, 'human');
  assert.equal(events[0].zone, 'hand');
});

test('snapshot capture never reads opponent hands, resource identities or private deck data', () => {
  const forbidden = label => ({ get() { throw new Error(`Private information read: ${label}`); }, configurable: true });
  const hidden = new Proxy({ hidden: true }, {
    get(target, key) {
      if (key === 'hidden') return true;
      throw new Error(`Hidden card field read: ${String(key)}`);
    },
  });
  const protect = view => {
    for (const player of Object.values(view.players)) {
      for (const property of ['resources', 'deck', 'drawDeck', 'decklist']) {
        Object.defineProperty(player, property, forbidden(`${player.id}.${property}`));
      }
    }
    Object.defineProperty(view.players.bot, 'hand', forbidden('bot.hand'));
    view.players.human.hand = [hidden];
    view.players.human.ground = [card('visible-guard')];
    return view;
  };
  const before = protect(game(40));
  const after = protect(game(41));
  after.players.bot.base.damage = 1;
  const events = diff(before, after);
  assert.deepEqual(kinds(events), ['damage']);
  assert.equal(events[0].cardId, 'bot-base');
});

test('own-hand visibility follows viewerId rather than a fixed player seat', () => {
  const before = game(44, { viewerId: 'bot' });
  const after = game(45, { viewerId: 'bot' });
  for (const view of [before, after]) {
    Object.defineProperty(view.players.human, 'hand', {
      get() { throw new Error('The other player hand is private.'); },
    });
  }
  after.players.bot.hand = [card('bot-visible-draw')];
  after.players.bot.deckCount = 41;
  const events = diff(before, after);
  assert.deepEqual(kinds(events), ['draw']);
  assert.equal(events[0].cardId, 'bot-visible-draw');
  assert.equal(events[0].playerId, 'bot');
});

test('a hand change without a public deck decrease is not labeled as a draw', () => {
  const before = game(46);
  const after = game(47);
  after.players.human.hand = [card('created-or-revealed-card')];
  assert.deepEqual(diff(before, after), []);
});

test('a missing battlefield unit is defeated only when its identity is now in public discard', () => {
  const before = game(50);
  before.players.human.ground = [card('destroyed'), card('bounced'), card('captured'), card('moved')];
  before.players.bot.ground = [card('captor')];
  const after = game(51);
  after.players.human.discard = [card('destroyed', { zone: 'discard' })];
  after.players.human.hand = [card('bounced')];
  after.players.human.space = [card('moved')];
  after.players.bot.ground = [card('captor', { captured: [card('captured')] })];
  const events = diff(before, after);
  assert.deepEqual(kinds(events), ['defeat']);
  assert.equal(events[0].cardId, 'destroyed');
  assert.equal(events[0].playerId, 'human');
  assert.equal(events[0].zone, 'ground');
});

test('removing a shield with its defeated host does not announce a separate shield break', () => {
  const before = game(60);
  before.players.human.ground = [card('destroyed', {
    upgrades: [card('shield-two', { type: 'token upgrade', name: 'Shield' })],
  })];
  const after = game(61);
  after.players.human.discard = [card('destroyed')];
  assert.deepEqual(kinds(diff(before, after)), ['defeat']);
});

test('each newly attached card is tracked separately from a host entering play', () => {
  const before = game(70);
  before.players.human.ground = [card('guard')];
  const after = game(71);
  after.players.human.ground = [card('guard', { upgrades: [card('weapon', { type: 'upgrade' })] })];
  const events = diff(before, after);
  assert.deepEqual(kinds(events), ['attach']);
  const attached = event(events, 'attach', 'guard');
  assert.equal(attached.subjectId, 'weapon');
  assert.equal(attached.zone, 'attachment');
  assert.equal(attached.playerId, 'human');
  assert.deepEqual([...summarizeBattleEvents(events).added], ['weapon']);
});
