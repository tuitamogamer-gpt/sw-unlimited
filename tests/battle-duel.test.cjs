'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

// The table marks only cards named by the native events of one exchange.
const filename = path.resolve(__dirname, '../src/battle-duel.ts');
const compiled = new Module(filename, module);
compiled._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, filename);
const { duelRoles } = compiled.exports;

function card(uuid, extra = {}) {
  return { uuid, name: uuid, type: 'unit', hidden: false, hp: 6, power: 3, damage: 0, ...extra };
}
function combat(sequence, source, target, attack) {
  return { id: `match:damage:${sequence}`, sequence, order: sequence, playerId: 'human', kind: 'damage', damageType: 'combat', amount: 2, sourceCard: source, targetCard: target, attack };
}

test('no exchange on screen marks nothing', () => {
  assert.equal(duelRoles(null), null);
  assert.equal(duelRoles(undefined), null);
  assert.equal(duelRoles([]), null);
});

test('an attack with return damage marks both combatants as clashing and nobody else', () => {
  const attacker = card('attacker'), defender = card('defender');
  const attack = { id: 'attack-1', attacker, defender, defenders: [defender] };
  const duel = duelRoles([combat(1, attacker, defender, attack), combat(2, defender, attacker, attack)]);
  assert.deepEqual(duel.roles, { attacker: 'clash', defender: 'clash' });
  assert.equal(duel.key, 'match:damage:1|match:damage:2');
});

test('a one-way attack separates the card that strikes from the card that is hit', () => {
  const attacker = card('attacker'), base = card('enemy-base', { type: 'base', hp: 30 });
  const duel = duelRoles([combat(1, attacker, base, { id: 'attack-2', attacker, defender: base, defenders: [base] })]);
  assert.deepEqual(duel.roles, { attacker: 'strike', 'enemy-base': 'hit' });
});

test('the attacker stays marked when only the return damage resolved', () => {
  const attacker = card('attacker'), defender = card('shielded-defender');
  const duel = duelRoles([combat(1, defender, attacker, { id: 'attack-3', attacker, defender, defenders: [defender] })]);
  assert.deepEqual(duel.roles, { attacker: 'clash', 'shielded-defender': 'strike' });
});

test('an ability marks its public source and each real target, and never a hidden card', () => {
  const source = card('vader');
  const duel = duelRoles([
    { id: 'match:damage:7', sequence: 7, order: 7, playerId: 'bot', kind: 'damage', damageType: 'ability', amount: 1, sourceCard: source, targetCard: card('guard') },
    { id: 'match:damage:8', sequence: 8, order: 8, playerId: 'bot', kind: 'damage', damageType: 'ability', amount: 1, sourceCard: source, targetCard: card('pilot') },
    { id: 'match:damage:9', sequence: 9, order: 9, playerId: 'bot', kind: 'damage', damageType: 'ability', amount: 1, sourceCard: card('secret', { hidden: true }), targetCard: card('scout') },
    { id: 'match:damage:10', sequence: 10, order: 10, playerId: 'bot', kind: 'damage', damageType: 'ability', amount: 1, targetCard: card('medic') },
  ]);
  assert.deepEqual(duel.roles, { vader: 'strike', guard: 'hit', pilot: 'hit', scout: 'hit', medic: 'hit' });
});

test('several sources of one hit are all marked', () => {
  const duel = duelRoles([{ id: 'match:damage:11', sequence: 11, order: 11, playerId: 'human', kind: 'damage', damageType: 'combat', amount: 4,
    sourceCards: [card('wing-one'), card('wing-two')], targetCard: card('cruiser') }]);
  assert.deepEqual(duel.roles, { 'wing-one': 'strike', 'wing-two': 'strike', cruiser: 'hit' });
});
