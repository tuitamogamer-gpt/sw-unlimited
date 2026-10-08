'use strict';

const fs = require('node:fs');
const path = require('node:path');
let catalog;
let indexed;

function getCardCatalog() {
    if (!catalog) {
        catalog = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/card-catalog.json'), 'utf8'));
        if (!Array.isArray(catalog.cards) || !catalog.summary) throw new Error('Invalid card catalog.');
    }
    return catalog;
}

const fold = value => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
const single = value => typeof value === 'string' ? value : '';
const integer = (value, fallback, maximum) => /^\d{1,8}$/.test(single(value)) ? Math.min(maximum, Number(value)) : fallback;

function searchCards(query = {}) {
    const data = getCardCatalog();
    if (!indexed) indexed = data.cards.map(card => ({ card, text: fold([
        card.code, card.name, card.subtitle, card.text, card.pilotText,
        ...(card.traits || []), ...(card.aliases || []), ...(card.idAliases || []),
    ].join(' ')) }));
    const words = fold(single(query.search).slice(0, 160)).trim().split(/\s+/).filter(Boolean);
    const set = single(query.set).toUpperCase();
    const type = single(query.type).toLowerCase();
    const status = single(query.status);
    const offset = integer(query.offset, 0, 100000);
    const limit = Math.max(1, integer(query.limit, 48, 100));
    const rows = indexed.filter(({ card, text }) => (!set || set === 'ALL' || card.code.split('_')[0] === set)
        && (!type || type === 'all' || (card.types || []).includes(type))
        && (!status || status === 'all' || (status === 'supported' ? card.engineSupported
            : status === 'unsupported' ? !card.engineSupported : card.engineStatus === status))
        && words.every(word => text.includes(word)));
    return {
        cards: rows.slice(offset, offset + limit).map(({ card }) => {
            const { aliases, idAliases, printings, ...publicCard } = card;
            return { ...publicCard, uuid: `catalog_${card.code}`, unimplemented: !card.engineSupported };
        }),
        total: rows.length, offset, limit, summary: data.summary, engineCommit: data.engineCommit, asOf: data.asOf,
    };
}

module.exports = { getCardCatalog, searchCards };
