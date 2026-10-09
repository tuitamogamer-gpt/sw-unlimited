'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const filename = path.resolve(__dirname, '../src/opponent-presentation.ts');
const compiled = new Module(filename, module);
compiled._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, filename);
const { newOpponentPlays, withUnrevealedPlaysHidden } = compiled.exports;

function card(uuid, extra = {}) {
  return { uuid, name: uuid, type: 'unit', hp: 6, power: 3, hidden: false, upgrades: [], captured: [], ...extra };
}
function play(sequence, uuid = `unit-${sequence}`, extra = {}) {
  return { id: `match:public-play:${sequence}`, sequence, playerId: 'bot', kind: 'play', card: card(uuid), ...extra };
}
function game(version = 1, publicPlayEvents = [], extra = {}) {
  const player = id => ({
    id, name: id, base: card(`${id}-base`, { type: 'base', hp: 30 }),
    leader: card(`${id}-leader`, { type: 'leader' }), leaders: [],
    hand: [], ground: [], space: [], resources: [], discard: [], outsideTheGame: [],
    handCount: 0, deckCount: 42, resourceCount: 2, readyResources: 2,
    hasInitiative: id === 'human', active: id === 'human',
  });
  return {
    id: 'match', version, viewerId: 'human', phase: 'action', round: 2,
    winnerIds: [], players: { human: player('human'), bot: player('bot') },
    prompt: { id: `prompt-${version}`, active: true, selectedCardIds: [], selectableCardIds: [], buttons: [], displayCards: [] },
    legalActions: [], log: [], publicPlayEvents, ...extra,
  };
}
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}
const ids = cards => cards.map(card => card.uuid);

test('opening, restored and reconnected snapshots do not replay historical opponent highlights', () => {
  const before = game(4, [play(1)]);
  const after = game(7, [play(1), play(2)]);
  assert.deepEqual(newOpponentPlays(null, after), []);
  assert.deepEqual(newOpponentPlays(before, after, true), [], 'Explicit resume/recovery establishes a fresh baseline.');
  assert.deepEqual(newOpponentPlays(before, { ...after, id: 'another-match' }), []);
  assert.deepEqual(newOpponentPlays(before, { ...after, viewerId: 'bot' }), []);
  assert.deepEqual(newOpponentPlays(before, { ...after, version: before.version }), []);
  assert.deepEqual(newOpponentPlays(before, { ...after, version: before.version - 1 }), []);
  assert.deepEqual(newOpponentPlays(before, game(8, [play(1)])), [], 'A fresh read with no new play does not repeat the highlight.');
});

test('new plays are ordered, deduplicated by event and retain separate replays of the same physical card', () => {
  const before = game(4, [play(4), play(2)]);
  const first = play(5, 'returning-unit');
  const second = play(7, 'returning-unit');
  const deploy = play(6, 'leader', { kind: 'deploy' });
  const after = deepFreeze(game(8, [second, play(3), first, deploy, first]));
  const result = newOpponentPlays(before, after);
  assert.deepEqual(result, [first, deploy, second]);
  assert.notEqual(result[0].id, result[2].id);
  assert.equal(result[0].card.uuid, result[2].card.uuid);
  assert.deepEqual(after.publicPlayEvents.map(event => event.sequence), [7, 3, 5, 6, 5], 'Sorting must not mutate the checkpoint.');
});

test('human actions, invalid events and hidden cards cannot create an opponent spotlight', () => {
  const before = game(3, [play(1)]);
  const after = game(4, [
    play(2, 'your-play', { playerId: 'human' }),
    play(3, 'unknown-player', { playerId: 'spectator' }),
    play(4, 'resource', { kind: 'resource' }),
    play(5, 'private-choice', { card: { hidden: true, uuid: 'private-choice' } }),
    play(6, 'missing-card', { card: undefined }),
    play(7, 'missing-id', { card: { name: 'No public identity' } }),
    play(8.5), play(NaN), play(Number.MAX_SAFE_INTEGER + 1),
  ]);
  assert.deepEqual(newOpponentPlays(before, after), []);
  assert.deepEqual(newOpponentPlays(game(1, [], { publicPlayEvents: undefined }), game(2, [], { publicPlayEvents: undefined })), [], 'Old checkpoints without a feed remain compatible.');
  const botView = { ...game(4, [play(2, 'human-card', { playerId: 'human' })]), viewerId: 'bot' };
  assert.equal(newOpponentPlays({ ...before, viewerId: 'bot' }, botView)[0].card.uuid, 'human-card', 'Opponent is relative to the viewer.');
});

test('movement, capture, discard and control changes without a native play do not inspect or reveal a private hand', () => {
  const before = game(3);
  const after = game(4);
  after.players.bot.ground = [card('controlled-unit'), card('captured-unit-returned')];
  after.players.bot.discard = [card('discarded-from-hand')];
  Object.defineProperty(after.players.bot, 'hand', { get() { throw new Error('Never read the opponent hand to infer a play.'); } });
  Object.defineProperty(after.players.bot, 'resources', { get() { throw new Error('Never read resources to infer a play.'); } });
  assert.deepEqual(newOpponentPlays(before, after), []);
});

test('pending card reveals stay out of both arenas, public discard and nested attachments without changing the checkpoint', () => {
  const view = game(10);
  const before = game(9);
  before.players.bot.leader = card('bot-leader', { type: 'leader', deployed: false, image: 'leader-front.webp', text: 'Leader ability', exhausted: true });
  before.players.bot.leaders = [before.players.bot.leader];
  view.players.bot.leader = card('bot-leader', {
    type: 'leader unit', deployed: true, image: 'leader-back.webp', frontImage: 'leader-front.webp',
    text: 'Deployed ability', frontText: 'Leader ability', exhausted: false,
  });
  view.players.bot.leaders = [view.players.bot.leader];
  view.players.bot.ground = [card('pending-ground'), card('visible-host', {
    upgrades: [card('pending-pilot'), card('visible-upgrade')],
    captured: [card('pending-captured'), card('visible-captive')],
  })];
  view.players.bot.space = [card('pending-space'), card('visible-space')];
  view.players.bot.discard = [card('pending-event'), card('visible-discard')];
  view.players.human.ground = [card('pending-stolen'), card('human-unit')];
  view.players.human.space = [card('pending-friendly-space')];
  view.players.human.base.upgrades = [card('pending-base-upgrade'), card('visible-base-upgrade')];
  view.players.bot.ground.push(view.players.bot.leader);
  const pending = ['pending-ground', 'pending-pilot', 'pending-captured', 'pending-space', 'pending-event', 'pending-stolen', 'pending-friendly-space', 'pending-base-upgrade', 'bot-leader']
    .map((uuid, index) => play(index + 1, uuid));
  const original = structuredClone(view);
  deepFreeze(view);
  deepFreeze(before);
  deepFreeze(pending);
  const shown = withUnrevealedPlaysHidden(view, pending, new Set(), before);
  assert.deepEqual(ids(shown.players.bot.ground), ['visible-host']);
  assert.deepEqual(ids(shown.players.bot.ground[0].upgrades), ['visible-upgrade']);
  assert.deepEqual(ids(shown.players.bot.ground[0].captured), ['visible-captive']);
  assert.deepEqual(ids(shown.players.bot.space), ['visible-space']);
  assert.deepEqual(ids(shown.players.bot.discard), ['visible-discard']);
  assert.deepEqual(ids(shown.players.human.ground), ['human-unit']);
  assert.deepEqual(shown.players.human.space, []);
  assert.deepEqual(ids(shown.players.human.base.upgrades), ['visible-base-upgrade']);
  assert.deepEqual(shown.players.bot.leader, before.players.bot.leader, 'A queued deployment retains the previous public commander face and state.');
  assert.deepEqual(shown.players.bot.leaders, before.players.bot.leaders);
  const fallback = withUnrevealedPlaysHidden(view, pending);
  assert.equal(fallback.players.bot.leader.deployed, false);
  assert.equal(fallback.players.bot.leader.image, 'leader-front.webp');
  assert.equal(fallback.players.bot.leader.text, 'Leader ability');
  assert.deepEqual(fallback.players.bot.leaders[0], fallback.players.bot.leader);
  const deployed = withUnrevealedPlaysHidden(view, pending, new Set(['bot-leader']), before);
  assert.equal(deployed.players.bot.leader.deployed, true, 'Once spotlighted, a leader can show its deployed face.');
  assert.ok(deployed.players.bot.ground.some(card => card.uuid === 'bot-leader'));
  assert.deepEqual(view, original, 'Presentation masking must never mutate the saved authoritative response.');
  assert.equal(shown.version, view.version);
  assert.equal(shown.prompt, view.prompt);
  assert.equal(shown.legalActions, view.legalActions);
  assert.equal(shown.publicPlayEvents, view.publicPlayEvents);
});

test('a revealed card remains visible if the same physical card is played again later in the queued response', () => {
  const view = game(10);
  view.players.bot.ground = [card('returning-unit'), card('next-unit')];
  const replay = play(3, 'returning-unit');
  const next = play(4, 'next-unit');
  const shown = withUnrevealedPlaysHidden(view, [replay, next], new Set(['returning-unit']));
  assert.deepEqual(ids(shown.players.bot.ground), ['returning-unit'], 'An already spotlighted physical card cannot disappear during another queued highlight.');
  assert.deepEqual(ids(view.players.bot.ground), ['returning-unit', 'next-unit']);
  assert.equal(withUnrevealedPlaysHidden(view, []), view, 'Completing the queue restores the complete response.');
});
