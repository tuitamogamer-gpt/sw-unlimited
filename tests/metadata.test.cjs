'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { loadCard } = require('../server/engine.cjs');
const { readDecks, runGame } = require('../scripts/smoke.cjs');

const decks = readDecks();
const deck = id => decks.find(candidate => candidate.id === id);
const units = view => Object.values(view.players).flatMap(player => [...player.ground, ...player.space]);

test('attached pilots expose their active rules and upgrade stats while hidden cards stay private', { timeout: 30_000 }, async () => {
  const boba = await loadCard('JTL_189');
  assert.equal(boba.upgradePower, 2);
  assert.equal(boba.upgradeHp, 3);
  assert.match(boba.pilotText, /When played as an upgrade: You may deal 1 damage/);
  assert.equal(boba.text, 'Shielded', 'The catalog retains the normal unit text alongside its pilot rules.');

  let checkedPilot = false;
  let checkedShield = false;
  await runGame({
    playerDeck: deck('jtl-boba-fett'), botDeck: deck('jtl-han-solo'), seed: 101,
    beforeSubmit({ view }) {
      // runGame also checks both seats' hidden-card redaction before every action.
      for (const host of units(view)) {
        for (const upgrade of host.upgrades) {
          if (!checkedPilot && upgrade.internalName === 'chewbacca#faithful-first-mate') {
            assert.equal(host.internalName, 'cartel-turncoat');
            assert.equal(upgrade.type, 'nonLeaderUnitUpgrade');
            assert.equal(upgrade.parentCardId, host.uuid);
            assert.equal(upgrade.upgradePower, 3);
            assert.equal(upgrade.upgradeHp, 3);
            assert.equal(upgrade.power, 3);
            assert.equal(upgrade.hp, 3);
            assert.equal(upgrade.text, upgrade.pilotText);
            assert.match(upgrade.text, /friendly Vehicle without a Pilot/);
            assert.match(upgrade.text, /Attached unit gains:/);
            assert.equal(host.power, 5, 'Cartel Turncoat receives Chewbacca’s +3 power.');
            assert.equal(host.hp, 6, 'Cartel Turncoat receives Chewbacca’s +3 HP.');
            assert.equal(host.remainingHp, host.hp - host.damage);
            checkedPilot = true;
          }
          if (!checkedShield && upgrade.internalName === 'shield') {
            assert.equal(upgrade.type, 'tokenUpgrade');
            assert.equal(upgrade.parentCardId, host.uuid);
            assert.equal(upgrade.power, 0);
            assert.equal(upgrade.hp, 0);
            assert.match(upgrade.text, /prevent that damage/);
            assert.ok(!units(view).some(unit => unit.uuid === upgrade.uuid), 'A Shield is an attachment, not a combatant.');
            checkedShield = true;
          }
        }
      }
    },
  });
  assert.ok(checkedPilot, 'The real game must actually attach Chewbacca as a pilot.');
  assert.ok(checkedShield, 'The real game must actually create a Shield token.');
});

test('public unit keywords include gained Sentinel and remove it when its duration expires', { timeout: 30_000 }, async () => {
  let droidId;
  let gained = false;
  let expired = false;
  await runGame({
    playerDeck: deck('twi-ahsoka-tano'), botDeck: deck('twi-general-grievous'), seed: 101,
    beforeSubmit({ view }) {
      const droid = units(view).find(unit => unit.uuid === droidId || (!droidId
        && unit.internalName === 'battle-droid' && unit.keywords.some(keyword => keyword.name === 'sentinel')));
      if (!droid) return;
      droidId = droid.uuid;
      const sentinel = droid.keywords.some(keyword => keyword.name === 'sentinel');
      assert.equal(droid.sentinel, sentinel, 'The native targeting flag and inspector keywords must agree.');
      if (sentinel) gained = true;
      if (gained && !sentinel) expired = true;
    },
  });
  assert.ok(gained, 'Grievous must actually grant Sentinel to a Battle Droid.');
  assert.ok(expired, 'The same surviving Droid must lose the temporary keyword.');
});
