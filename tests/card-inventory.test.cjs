'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const catalog = require('../data/card-catalog.json');
const aliases = require('../data/card-aliases.json');
const coverage = require('../data/card-coverage.json');
const nativeAliases = require('../vendor/forceteki/test/json/_setCodeMap.json');
const { cards: registry, overrideNotImplementedCards } = require('../vendor/forceteki/build/server/game/cards/Index.js');
const { Card } = require('../vendor/forceteki/build/server/game/core/card/Card.js');
const defs = new Map(fs.readdirSync(path.join(__dirname, '../vendor/forceteki/test/json/Card')).map(file => {
  const def = require(`../vendor/forceteki/test/json/Card/${file}`);
  return [def.id, def];
}));

test('catalog covers every native set-code identity and reports actual registry support', () => {
  const byCode = new Map(catalog.cards.map(card => [card.code, card]));
  for (const [code, id] of Object.entries(nativeAliases)) {
    const card = byCode.get(code);
    assert.ok(card, `Missing native normal printing ${code}`);
    assert.equal(card.engineId, id);
    const def = defs.get(id);
    const supported = !overrideNotImplementedCards.has(id) && (registry.has(id) || !Card.checkHasNonKeywordAbilityText(def));
    assert.equal(card.nativeImplemented, supported, code);
    assert.equal(card.engineSupported, supported && card.dataCompleteness === 'complete', code);
  }
  assert.equal(catalog.summary.total, catalog.cards.length);
  assert.equal(coverage.aliasConflicts.length, 0);
});

test('foil, promo and reprinted identifiers resolve to the same canonical game identity', () => {
  assert.equal(aliases.byCode.SOR_051.engineId, aliases.byCode.SOR_051F.engineId);
  assert.equal(aliases.byCode.SOR_172.engineId, aliases.byCode.TWI_174.engineId);
  assert.equal(aliases.byCode.IBH_003.engineId, aliases.byCode.IBH_046.engineId);
  assert.equal(aliases.byCode.IBH_003.engineId, aliases.byCode.IBH_3.engineId);
  assert.equal(aliases.byId['3016373545'].engineId, aliases.byCode.SOR_051.engineId);
  for (const [code, alias] of Object.entries(aliases.byCode)) {
    if (alias.deckEligible) assert.equal(nativeAliases[alias.engineCode], alias.engineId, code);
  }
});

test('placeholder IC27 definitions are unavailable independently of compiled scripts', () => {
  const provisional = catalog.cards.filter(card => card.set === 'IC27');
  assert.ok(provisional.length > 0);
  for (const card of provisional) {
    assert.equal(card.preview, true);
    assert.equal(card.dataCompleteness, 'provisional');
    assert.equal(card.engineSupported, false);
    assert.equal(card.engineStatus, 'missing-data');
  }
  assert.ok(catalog.cards.some(card => card.set === 'HMW' && card.preview && card.engineSupported));
});

test('tokens remain browseable but cannot normalize into main-deck game cards', () => {
  const tokens = catalog.cards.filter(card => card.types.includes('token'));
  assert.ok(tokens.length >= 13);
  for (const card of tokens) assert.equal(card.deckEligible, false, card.code);
});

test('every card image used by the catalog comes from a downloaded API record', () => {
  const images = new Set();
  const root = path.join(__dirname, '../data/card-api');
  for (const file of fs.readdirSync(root)) {
    for (const record of JSON.parse(fs.readFileSync(path.join(root,file))).data || []) {
      if (record.FrontArt) images.add(record.FrontArt);
      if (record.BackArt) images.add(record.BackArt);
    }
  }
  for (const card of catalog.cards) {
    if (card.image) assert.ok(images.has(card.image), card.code);
    if (card.backImage) assert.ok(images.has(card.backImage), card.code);
  }
});
