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
const { newDamageEvents, newBattlePresentations, DAMAGE_PRESENTATION_MS } = compiled.exports;

function card(uuid, extra = {}) {
  return { uuid, name: uuid, type: 'unit', hidden: false, hp: 8, power: 3, damage: 0, ...extra };
}
function attack(id = 'attack-1') {
  const defender = card('bot-defender', { controllerId: 'bot' });
  return { id, attacker: card('human-attacker', { controllerId: 'human' }), defender, defenders: [defender] };
}
function damage(sequence, extra = {}) {
  return {
    id: `match:damage:${sequence}`, sequence, order: sequence, playerId: 'bot', kind: 'damage',
    damageType: 'ability', amount: 2,
    sourceCard: card('vader', { controllerId: 'bot' }),
    targetCard: card('human-target', { controllerId: 'human', damage: 2 }),
    ...extra,
  };
}
function play(sequence, order, extra = {}) {
  return { id: `match:play:${sequence}`, sequence, order, playerId: 'bot', kind: 'play', card: card(`played-${sequence}`), ...extra };
}
function game(version = 1, publicDamageEvents = [], publicPlayEvents = [], extra = {}) {
  return { id: 'match', version, viewerId: 'human', publicDamageEvents, publicPlayEvents, ...extra };
}
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}
const damageSlides = entries => entries.filter(entry => entry.kind === 'damage');
const eventIds = entries => entries.map(event => event.id);

test('damage explanations have a short fixed presentation interval', () => {
  assert.equal(DAMAGE_PRESENTATION_MS, 1600);
});

test('initial, restored, reconnected, different-game and non-advancing snapshots never replay damage', () => {
  const before = game(4, [damage(1)], [play(1, 2)]);
  const after = game(7, [damage(1), damage(2, { order: 3 })], [play(1, 2), play(2, 4)]);
  for (const [previous, next, restored] of [
    [null, after], [before, after, true], [before, { ...after, id: 'another-match' }],
    [before, { ...after, viewerId: 'bot' }], [before, { ...after, version: 4 }],
    [before, { ...after, version: 3 }],
  ]) {
    assert.deepEqual(newDamageEvents(previous, next, restored), []);
    assert.deepEqual(newBattlePresentations(previous, next, restored), []);
  }
  assert.deepEqual(newDamageEvents(after, { ...after, version: 8 }), [], 'A new read without new events must remain silent.');
});

test('old checkpoints without a damage feed remain compatible and use actual events only', () => {
  assert.deepEqual(newDamageEvents(game(1, undefined), game(2, undefined)), []);
  assert.deepEqual(newBattlePresentations(game(1, undefined), game(2, undefined)), []);
  const after = game(2, undefined, [play(1, 1)]);
  assert.deepEqual(newBattlePresentations(game(1, undefined), after), [{ kind: 'play', event: after.publicPlayEvents[0] }]);
});

test('new damage is ordered and deduplicated by id and sequence without merging repeated hits on one card', () => {
  const before = game(4, [damage(4), damage(2)]);
  const first = damage(5);
  const second = damage(7, { amount: 1 });
  const after = deepFreeze(game(8, [second, damage(3), first, { ...first, sequence: 6, order: 6 },
    { ...first, id: 'duplicate-sequence' }, first]));
  const original = structuredClone(after);
  assert.deepEqual(newDamageEvents(before, after), [first, second]);
  assert.equal(first.targetCard.uuid, second.targetCard.uuid);
  assert.notEqual(first.id, second.id, 'Two real damage events on the same card must stay separate.');
  assert.deepEqual(after, original, 'Filtering and sorting must not alter the saved authoritative snapshot.');
});

test('opponent plays and both players damage are interleaved in native public-event order', () => {
  const before = game(2, [damage(1, { order: 1 })]);
  const arrival = play(1, 2);
  const humanHit = damage(2, { order: 3, playerId: 'human' });
  const ownArrival = play(2, 4, { playerId: 'human' });
  const nextArrival = play(3, 5);
  const enemyHit = damage(3, { order: 6 });
  const after = deepFreeze(game(5, [enemyHit, humanHit, damage(1)], [nextArrival, ownArrival, arrival]));
  assert.deepEqual(newBattlePresentations(before, after), [
    { kind: 'play', event: arrival }, { kind: 'damage', events: [humanHit] },
    { kind: 'play', event: nextArrival }, { kind: 'damage', events: [enemyHit] },
  ]);
});

test('simultaneous combat explains attacker damage and defender retaliation together', () => {
  const context = attack();
  const outgoing = damage(1, { playerId: 'human', damageType: 'combat', amount: 3,
    sourceCard: context.attacker, targetCard: context.defender, attack: context });
  const retaliation = damage(2, { playerId: 'bot', damageType: 'combat', amount: 4,
    sourceCard: context.defender, targetCard: context.attacker, attack: context });
  assert.deepEqual(newBattlePresentations(game(), game(2, [outgoing, retaliation])), [
    { kind: 'damage', events: [outgoing, retaliation] },
  ]);
});

test('Vader ability damage remains separate from combat even inside the same attack context', () => {
  const context = attack('vader-attack');
  const onAttack = damage(1, { attack: context, damageType: 'ability', amount: 2 });
  const combat = damage(2, { attack: context, damageType: 'combat', amount: 5 });
  const retaliation = damage(3, { attack: context, damageType: 'combat', amount: 3, playerId: 'human' });
  const followup = damage(4, { attack: context, damageType: 'ability', amount: 2 });
  assert.deepEqual(newBattlePresentations(game(), game(2, [onAttack, combat, retaliation, followup])), [
    { kind: 'damage', events: [onAttack] },
    { kind: 'damage', events: [combat, retaliation] },
    { kind: 'damage', events: [followup] },
  ]);
});

test('only consecutive combat from the same attack can share an explanation', () => {
  const first = damage(1, { order: 1, damageType: 'combat', attack: attack('first') });
  const nextAttack = damage(2, { order: 2, damageType: 'combat', attack: attack('second') });
  const arrival = play(1, 3);
  const afterPlay = damage(3, { order: 4, damageType: 'combat', attack: attack('second') });
  const excess = damage(4, { order: 5, damageType: 'overwhelm', attack: attack('second') });
  assert.deepEqual(newBattlePresentations(game(), game(2, [first, nextAttack, afterPlay, excess], [arrival])), [
    { kind: 'damage', events: [first] }, { kind: 'damage', events: [nextAttack] },
    { kind: 'play', event: arrival }, { kind: 'damage', events: [afterPlay] },
    { kind: 'damage', events: [excess] },
  ]);
});

test('large simultaneous exchanges show at most four damage rows per slide without dropping events', () => {
  const context = attack('large-exchange');
  const events = Array.from({ length: 11 }, (_, index) => damage(index + 1, {
    damageType: 'combat', attack: context, amount: index + 1,
    targetCard: card(`target-${index}`, { damage: index + 1 }),
  }));
  const slides = damageSlides(newBattlePresentations(game(), deepFreeze(game(2, events))));
  assert.deepEqual(slides.map(slide => slide.events.length), [4, 4, 3]);
  assert.deepEqual(eventIds(slides.flatMap(slide => slide.events)), eventIds(events));
});

test('invalid amounts, identities, order and private target cards cannot create damage previews', () => {
  const malformed = [
    damage(1, { amount: 0 }), damage(2, { amount: -1 }), damage(3, { amount: NaN }),
    damage(4, { amount: Infinity }), damage(5, { targetCard: undefined }),
    damage(6, { targetCard: card('secret', { hidden: true }) }),
    damage(7, { targetCard: { name: 'Missing public identity' } }),
    damage(8, { id: '' }), damage(9, { sequence: 0 }), damage(10, { sequence: 1.5 }),
    damage(11, { sequence: Number.MAX_SAFE_INTEGER + 1 }), damage(12, { order: 0 }),
    damage(13, { order: -1 }), damage(14, { order: 1.5 }), damage(15, { order: Infinity }),
    damage(16, { order: Number.MAX_SAFE_INTEGER + 1 }),
    damage(17, { kind: 'heal' }), damage(18, { playerId: 'spectator' }),
  ];
  assert.deepEqual(newDamageEvents(game(), game(2, malformed)), []);
  assert.deepEqual(newBattlePresentations(game(), game(2, malformed)), []);
});

test('provided source and attack snapshots must be public, while an omitted private source is safe', () => {
  const hidden = card('hidden-source', { hidden: true });
  const malformed = [
    damage(1, { sourceCard: hidden }),
    damage(2, { sourceCard: undefined, sourceCards: [card('visible'), hidden] }),
    damage(3, { attack: { ...attack(), attacker: hidden } }),
    damage(4, { attack: { ...attack(), defender: hidden } }),
    damage(5, { attack: { ...attack(), defenders: [hidden] } }),
    damage(6, { sourceCard: { name: 'Unidentified source' } }),
  ];
  assert.deepEqual(newDamageEvents(game(), game(2, malformed)), []);
  const unknownSource = damage(7, { sourceCard: undefined, sourceCards: undefined, damageType: 'other' });
  assert.deepEqual(newDamageEvents(game(), game(2, [unknownSource])), [unknownSource], 'Public damage can be shown without inspecting its private source.');
});

test('damage presentation never reads hand, resources or deck to reconstruct an effect', () => {
  const after = game(2, [damage(1)]);
  Object.defineProperty(after, 'players', { get() { throw new Error('Damage must be described using only the public event feed.'); } });
  const before = game();
  Object.defineProperty(before, 'players', { get() { throw new Error('Prior private zones are not a presentation source.'); } });
  assert.deepEqual(newDamageEvents(before, after), after.publicDamageEvents);
  assert.deepEqual(newBattlePresentations(before, after), [{ kind: 'damage', events: after.publicDamageEvents }]);
});
