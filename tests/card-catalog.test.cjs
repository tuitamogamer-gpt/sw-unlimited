'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { getCardCatalog, searchCards } = require('../server/card-catalog.cjs');

test('card searches find names, printed codes, diacritics and rules text across the expanded catalog', () => {
    const named = searchCards({ search: 'R2-D2', limit: '100' });
    assert.ok(named.cards.some(card => card.name === 'R2-D2'));
    assert.ok(searchCards({ search: 'padme' }).cards.some(card => /Padmé/i.test(card.name)));
    const specific = searchCards({ search: 'SOR_236' });
    assert.ok(specific.cards.some(card => card.code === 'SOR_236' && card.name === 'R2-D2'));
    assert.ok(searchCards({ search: 'Sentinel', type: 'unit' }).cards.length > 0);
    assert.equal(searchCards({ search: '[unmatched.*+\\(' }).total, 0, 'User search text is literal, not a regular expression.');
});

test('catalog filters combine set, card type and playable status while pagination stays bounded', () => {
    const first = searchCards({ set: 'SOR', type: 'unit', status: 'supported', limit: '5' });
    const second = searchCards({ set: 'SOR', type: 'unit', status: 'supported', limit: '5', offset: '5' });
    assert.equal(first.cards.length, 5);
    assert.equal(second.cards.length, 5);
    assert.ok(first.cards.every(card => card.code.startsWith('SOR_') && card.types.includes('unit') && card.engineSupported));
    assert.ok(second.cards.every(card => !first.cards.some(previous => previous.code === card.code)));
    assert.equal(searchCards({ limit: '99999' }).cards.length, 100);
    assert.equal(searchCards({ offset: '99999' }).cards.length, 0);
    assert.equal(searchCards({ set: 'NOT_A_SET' }).total, 0);
    const malformed = searchCards({ search: { bad: true }, set: ['SOR'], offset: '-1', limit: 'bad' });
    assert.equal(malformed.offset, 0);
    assert.equal(malformed.limit, 48);
});

test('incomplete preview metadata stays discoverable without claiming playable support', () => {
    const pending = searchCards({ status: 'unsupported', limit: '100' });
    assert.ok(pending.total > 0, 'Pinned preview placeholders must not be advertised as complete cards.');
    assert.ok(pending.cards.every(card => !card.engineSupported && card.unimplemented));
    const supported = searchCards({ status: 'supported', limit: '100' });
    assert.ok(supported.cards.every(card => card.engineSupported && !card.unimplemented));
    assert.ok(getCardCatalog().cards.length > 2000, 'The public inventory must include full sets beyond starter decks.');
});

test('alternate-printing codes find their displayed canonical card', () => {
    const card = getCardCatalog().cards.find(card => card.aliases?.some(alias => alias !== card.code));
    assert.ok(card);
    const alias = card.aliases.find(alias => alias !== card.code);
    assert.ok(searchCards({ search: alias, limit: '100' }).cards.some(result => result.code === card.code));
});

test('HTTP card library serves bounded public records without starting a game', async () => {
    const { app } = require('../server/index.cjs');
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/cards?set=SOR&type=base&limit=3`);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        const result = await response.json();
        assert.equal(result.cards.length, 3);
        assert.ok(result.cards.every(card => card.types.includes('base') && card.image && card.uuid));
        assert.equal(result.summary.total, getCardCatalog().summary.total);
        assert.equal(result.sessionToken, undefined);
    } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
});
