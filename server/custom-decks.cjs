'use strict';

const { createHash } = require('node:crypto');
const { getCardCatalog } = require('./card-catalog.cjs');
const { loadCard, normalizeDeckRecipe } = require('./engine.cjs');

const MAX_INPUT_BYTES = 100 * 1024;
const MAX_MAIN_CARDS = 200;
const MAX_ROWS = 256;
const MAX_NAME = 120;
const URL_TIMEOUT_MS = 8_000;
let index;

const plainObject = value => value && typeof value === 'object' && !Array.isArray(value);
const normalizeName = value => String(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[’‘]/g, "'").replace(/[^a-z0-9]+/g, ' ').trim();
const render = (message, params) => message.replace(/\{(\w+)\}/g, (_all, name) => String(params[name] ?? ''));
function issue(code, message, params = {}, severity = 'error') { return { code, message, params, severity }; }
function result(issues, deck, status) {
  const errors = issues.filter(item => item.severity === 'error').map(item => render(item.message, item.params));
  const warnings = issues.filter(item => item.severity === 'warning').map(item => render(item.message, item.params));
  if (deck) deck.validation = { valid: errors.length === 0, errors, warnings, issues };
  return { ...(deck ? { deck } : {}), errors, warnings, issues, status: status || (errors.length ? 422 : 200) };
}
function fail(code, message, params = {}, status = 400) {
  const error = new Error(render(message, params));
  error.importIssue = issue(code, message, params); error.status = status; throw error;
}

function cardIndex() {
  if (index) return index;
  const catalog = getCardCatalog();
  const byReference = new Map(), byName = new Map();
  const identity = card => String(card.engineId || card.id || card.engineCode || card.code);
  for (const card of catalog.cards) {
    for (const ref of [card.code, card.engineCode, card.id, card.engineId, card.internalName, ...(card.aliases || []), ...(card.idAliases || [])].filter(Boolean)) {
      const key = String(ref).toUpperCase();
      // Prefer the engine's canonical printing when reprint rows share aliases.
      if (!byReference.has(key) || card.code === card.engineCode) byReference.set(key, card);
    }
    for (const name of [card.name, card.title, `${card.name || card.title || ''} ${card.subtitle || ''}`].filter(Boolean)) {
      const key = normalizeName(name);
      if (!byName.has(key)) byName.set(key, new Map());
      const entries = byName.get(key);
      if (!entries.has(identity(card)) || card.code === card.engineCode) entries.set(identity(card), card);
    }
  }
  index = { byReference, byName, identity };
  return index;
}
function resolveCard(reference, section) {
  if (typeof reference !== 'string' || !reference.trim() || reference.length > 300) {
    fail('CARD_REFERENCE', 'Each card needs a set code or an unambiguous name.', {}, 422);
  }
  const ref = reference.trim();
  const lookup = cardIndex();
  let card = lookup.byReference.get(ref.toUpperCase());
  const code = ref.match(/^([a-z][a-z0-9]{1,5})[_ -](\d{1,4})$/i) || ref.match(/^([a-z]{3})(\d{1,3})$/i);
  if (!card && code) card = lookup.byReference.get(`${code[1].toUpperCase()}_${code[2].padStart(3, '0')}`);
  if (!card) {
    // A printed identifier in a copied list can accompany a full card name.
    const embedded = [...ref.matchAll(/\b([a-z][a-z0-9]{1,5})[_ -](\d{1,4})\b/gi)]
      .map(match => lookup.byReference.get(`${match[1].toUpperCase()}_${match[2].padStart(3, '0')}`)).filter(Boolean);
    if (new Set(embedded.map(lookup.identity)).size === 1) card = embedded[0];
  }
  if (!card) {
    let matches = [...(lookup.byName.get(normalizeName(ref))?.values() || [])];
    if (section === 'leader' || section === 'base') matches = matches.filter(entry => (entry.types || []).includes(section));
    if (matches.length === 1) card = matches[0];
    else if (matches.length > 1) fail('AMBIGUOUS_CARD', 'Ambiguous card name: {card}. Include its subtitle or set code.', { card: ref }, 422);
  }
  if (!card) fail('UNKNOWN_CARD', 'Unknown card: {card}. Check the name or set code.', { card: ref }, 422);
  return { card, id: card.engineCode || card.code, identity: lookup.identity(card) };
}

function parseText(text) {
  const deck = { metadata: {}, leader: [], base: [], deck: [], sideboard: [] };
  let section = null;
  const sections = { leader: 'leader', leaders: 'leader', base: 'base', bases: 'base', deck: 'deck', maindeck: 'deck', mainboard: 'deck', main: 'deck', sideboard: 'sideboard' };
  for (const [lineIndex, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('//') || line.startsWith('#')) continue;
    const named = line.match(/^(?:deck\s*name|name)\s*:\s*(.+)$/i);
    if (named) { deck.metadata.name = named[1]; continue; }
    const heading = line.match(/^\[?(leaders?|bases?|main\s*deck|mainboard|main|deck|sideboard)\]?\s*(?:\(\d+(?:\s+cards?)?\))?\s*(?::\s*(.*))?$/i);
    let content = line;
    if (heading) {
      section = sections[heading[1].toLowerCase().replace(/\s/g, '')];
      if (!heading[2]) continue;
      content = heading[2];
    }
    if (!section) fail('TEXT_SECTION', 'Line {line}: add a Leader, Base, Main Deck, or Sideboard heading.', { line: lineIndex + 1 });
    const counted = content.match(/^(\d+)\s*[x×]?\s+(.+)$/i) || content.match(/^(\d+)[x×]\s*(.+)$/i);
    if (!counted && section !== 'leader' && section !== 'base') fail('TEXT_COUNT', 'Line {line}: start the card entry with a quantity, such as 3 SOR_042.', { line: lineIndex + 1 });
    deck[section].push({ id: counted ? counted[2].trim() : content, count: counted ? Number(counted[1]) : 1 });
  }
  return deck;
}

function publicDeckId(input) {
  let url;
  try { url = new URL(input); } catch { fail('DECK_URL', 'Use a public HTTPS deck link from swudb.com, or paste its JSON export.'); }
  if (url.protocol !== 'https:' || !['swudb.com', 'www.swudb.com'].includes(url.hostname.toLowerCase()) || url.username || url.password || url.port) {
    fail('DECK_URL', 'Use a public HTTPS deck link from swudb.com, or paste its JSON export.');
  }
  const match = url.pathname.match(/^\/(?:deck\/(?:view\/)?|api\/getDeckJson\/)([a-zA-Z0-9_-]{1,64})\/?$/);
  if (!match) fail('DECK_URL', 'Use a public HTTPS deck link from swudb.com, or paste its JSON export.');
  return match[1];
}
async function fetchPublicDeck(input, fetcher = fetch) {
  const id = publicDeckId(input);
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); const error = new Error('Timeout'); error.importIssue = issue('DECK_FETCH_TIMEOUT', 'SWUDB did not respond in time. Paste its JSON export instead.'); error.status = 400; reject(error); }, URL_TIMEOUT_MS);
  });
  try {
    return await Promise.race([deadline, (async () => {
      // Never fetch a user-controlled origin or follow redirects.
      const response = await fetcher(`https://swudb.com/api/getDeckJson/${encodeURIComponent(id)}`, { signal: controller.signal, redirect: 'error', headers: { Accept: 'application/json' } });
      if (!response.ok) fail('DECK_FETCH', 'The SWUDB deck is private or unavailable. Paste its JSON export instead.');
      if (Number(response.headers.get('content-length')) > MAX_INPUT_BYTES) fail('INPUT_SIZE', 'Deck input is too large. The limit is {limit} KB.', { limit: MAX_INPUT_BYTES / 1024 });
      const reader = response.body?.getReader();
      if (!reader) fail('DECK_FETCH', 'SWUDB returned an invalid deck export. Paste its JSON export instead.');
      const chunks = []; let bytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_INPUT_BYTES) { await reader.cancel(); fail('INPUT_SIZE', 'Deck input is too large. The limit is {limit} KB.', { limit: MAX_INPUT_BYTES / 1024 }); }
        chunks.push(Buffer.from(value));
      }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { fail('JSON_FORMAT', 'The deck JSON is invalid. Check the export and try again.'); }
    })()]);
  } catch (error) {
    if (error.importIssue) throw error;
    fail('DECK_FETCH', 'SWUDB could not be reached. Paste its JSON export instead.');
  } finally { clearTimeout(timer); controller.abort(); }
}

function entryReference(entry) {
  if (typeof entry === 'string') return entry;
  if (!plainObject(entry)) return undefined;
  if (entry.id != null) return String(entry.id);
  if (entry.code != null) return String(entry.code);
  if (entry.name) return `${entry.name}${entry.subtitle ? `, ${entry.subtitle}` : ''}`;
  return undefined;
}
function normalizeEntries(raw, section, issues) {
  const entries = section === 'leader' || section === 'base'
    ? Array.isArray(raw) ? raw : raw ? [raw] : [] : raw;
  if (!Array.isArray(entries)) { issues.push(issue('SECTION_FORMAT', 'The {section} section must be an array of card entries.', { section })); return []; }
  if (entries.length > MAX_ROWS) { issues.push(issue('ENTRY_LIMIT', 'A deck section may contain at most {limit} entries.', { limit: MAX_ROWS })); return []; }
  if ((section === 'leader' || section === 'base') && entries.length !== 1) issues.push(issue('SLOT_COUNT', 'Choose exactly one {section}.', { section }));
  const combined = new Map();
  for (const entry of entries) {
    const count = plainObject(entry) ? entry.count === undefined ? (['leader', 'base'].includes(section) ? 1 : undefined) : entry.count : 1;
    if (!Number.isSafeInteger(count) || count < 1 || count > MAX_MAIN_CARDS) {
      issues.push(issue('QUANTITY', 'Card quantities must be positive integers no greater than {limit}.', { limit: MAX_MAIN_CARDS })); continue;
    }
    if (['leader', 'base'].includes(section) && count !== 1) issues.push(issue('SLOT_COUNT', 'Choose exactly one {section}.', { section }));
    try {
      const resolved = resolveCard(entryReference(entry), section);
      const existing = combined.get(resolved.identity);
      if (existing) existing.count += count;
      else combined.set(resolved.identity, { ...resolved, count });
    } catch (error) {
      if (!error.importIssue) throw error;
      issues.push(error.importIssue);
    }
  }
  return [...combined.values()];
}

function compactRecipe(recipe) {
  return { id: recipe.id, name: recipe.name, custom: true, metadata: { name: recipe.name },
    leader: { id: recipe.leader.id, count: 1 }, base: { id: recipe.base.id, count: 1 },
    deck: recipe.deck.map(({ id, count }) => ({ id, count })), sideboard: (recipe.sideboard || []).map(({ id, count }) => ({ id, count })) };
}
function isStoredCustomRecipe(recipe, expectedId) {
  return plainObject(recipe) && recipe.custom === true && recipe.id === expectedId && /^custom-[a-f0-9]{24}$/.test(recipe.id)
    && typeof recipe.name === 'string' && recipe.name.length <= MAX_NAME
    && [recipe.leader, recipe.base].every(entry => plainObject(entry) && typeof entry.id === 'string' && entry.id.length <= 40 && entry.count === 1)
    && [recipe.deck, recipe.sideboard].every(entries => Array.isArray(entries) && entries.length <= MAX_ROWS
      && entries.every(entry => plainObject(entry) && typeof entry.id === 'string' && entry.id.length <= 40 && Number.isSafeInteger(entry.count) && entry.count > 0 && entry.count <= MAX_MAIN_CARDS));
}

async function importCustomDeck(input, { name, allowUrl = true, fetcher } = {}) {
  const issues = [];
  try {
    if (typeof input !== 'string' && !plainObject(input)) fail('INPUT_FORMAT', 'Paste a SWUDB JSON export, a sectioned card list, or a public SWUDB deck link.');
    let serialized;
    try { serialized = typeof input === 'string' ? input : JSON.stringify(input); } catch { fail('JSON_FORMAT', 'The deck JSON is invalid. Check the export and try again.'); }
    if (Buffer.byteLength(serialized, 'utf8') > MAX_INPUT_BYTES) fail('INPUT_SIZE', 'Deck input is too large. The limit is {limit} KB.', { limit: MAX_INPUT_BYTES / 1024 });
    if (typeof input === 'string') {
      const text = input.replace(/^\uFEFF/, '').trim();
      if (/^https?:\/\//i.test(text)) {
        if (!allowUrl) fail('RECIPE_REQUIRED', 'Start a game with an imported deck recipe, not a URL.');
        input = await fetchPublicDeck(text, fetcher);
      } else if (/^[{[]/.test(text) && !/^\[(?:leader|base|main|deck|sideboard)/i.test(text)) {
        try { input = JSON.parse(text); } catch { fail('JSON_FORMAT', 'The deck JSON is invalid. Check the export and try again.'); }
      } else input = parseText(text);
    }
    if (!plainObject(input)) fail('DECK_FORMAT', 'The deck export must be a JSON object.');
    if (input.secondleader != null || input.secondLeader != null) issues.push(issue('SECOND_LEADER', 'Solo Premier uses one leader. Twin Suns decks are not supported.'));
    const resolved = {
      leader: normalizeEntries(input.leader, 'leader', issues),
      base: normalizeEntries(input.base, 'base', issues),
      deck: normalizeEntries(input.deck ?? input.mainDeck ?? input.mainboard, 'deck', issues),
      sideboard: normalizeEntries(input.sideboard ?? [], 'sideboard', issues),
    };
    const mainCount = resolved.deck.reduce((sum, row) => sum + row.count, 0);
    const sideboardCount = resolved.sideboard.reduce((sum, row) => sum + row.count, 0);
    if (mainCount > MAX_MAIN_CARDS) issues.push(issue('MAIN_LIMIT', 'The main deck may contain at most {limit} cards in this app.', { limit: MAX_MAIN_CARDS }));
    if (sideboardCount > 10) issues.push(issue('SIDEBOARD_LIMIT', 'The sideboard may contain at most 10 cards.'));
    if (resolved.leader.length !== 1 || resolved.base.length !== 1) return result(issues.length ? issues : [issue('SLOTS_REQUIRED', 'Choose exactly one leader and one base.')]);
    const rawName = name ?? input.metadata?.name ?? input.name ?? `${resolved.leader[0].card.name} custom deck`;
    const deckName = typeof rawName === 'string' ? rawName.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_NAME) || 'Custom deck' : 'Custom deck';
    const recipe = { name: deckName, metadata: { name: deckName }, custom: true,
      leader: { id: resolved.leader[0].id, count: 1 }, base: { id: resolved.base[0].id, count: 1 },
      deck: resolved.deck.map(({ id, count }) => ({ id, count })).sort((a, b) => a.id.localeCompare(b.id)),
      sideboard: resolved.sideboard.map(({ id, count }) => ({ id, count })).sort((a, b) => a.id.localeCompare(b.id)) };
    recipe.id = `custom-${createHash('sha256').update(JSON.stringify(recipe)).digest('hex').slice(0, 24)}`;
    const all = [...resolved.leader, ...resolved.base, ...resolved.deck, ...resolved.sideboard];
    const unique = [...new Map(all.map(row => [row.identity, row])).values()];
    const unsupported = unique.filter(row => row.card.engineSupported !== true);
    for (const row of unsupported) issues.push(issue('UNSUPPORTED_CARD', 'Card scripts or verified data are unavailable for {card} ({code}).', { card: row.card.name, code: row.card.code }));
    if (!unsupported.length && !issues.some(item => item.severity === 'error')) {
      try { await normalizeDeckRecipe(recipe); }
      catch (error) { issues.push(issue('DECK_RULES', error.message || 'This deck does not meet the deck-building rules.')); }
    }
    const enriched = async row => {
      try { return { ...await loadCard(row.id), unimplemented: row.card.engineSupported !== true, engineSupported: row.card.engineSupported, engineStatus: row.card.engineStatus }; }
      catch { return { id: row.card.id, code: row.card.code, name: row.card.name, subtitle: row.card.subtitle,
        image: row.card.image, backImage: row.card.backImage, types: row.card.types, type: (row.card.types || []).join(' '),
        aspects: row.card.aspects || [], traits: row.card.traits || [], text: row.card.text || '',
        cost: row.card.cost, power: row.card.power, hp: row.card.hp, unimplemented: true }; }
    };
    const [leader, base, cards, sideboardCards] = await Promise.all([
      enriched(resolved.leader[0]), enriched(resolved.base[0]),
      Promise.all(resolved.deck.map(async row => ({ count: row.count, card: await enriched(row) }))),
      Promise.all(resolved.sideboard.map(async row => ({ count: row.count, card: await enriched(row) }))),
    ]);
    issues.push(issue('SOLO_FORMAT', 'Solo Premier uses all available sets; tournament rotation and suspensions are not checked.', {}, 'warning'));
    if (sideboardCount) issues.push(issue('SIDEBOARD_UNUSED', 'Sideboard cards are validated but are not used in this single-game match.', {}, 'warning'));
    const errors = issues.filter(item => item.severity === 'error');
    const deck = { ...recipe, custom: true, recipe: compactRecipe(recipe), leader, base, cards, sideboardCards,
      leaderRef: recipe.leader, baseRef: recipe.base, set: 'CUSTOM', setName: 'Custom deck', product: 'Imported deck', format: 'Solo Premier',
      count: mainCount, cardCount: mainCount, sideboardCount, baseHealth: base.hp,
      aspects: [...new Set([...(leader.aspects || []), ...(base.aspects || [])])],
      playable: errors.length === 0, supported: unsupported.length === 0 && errors.length === 0,
      unsupportedCards: unsupported.map(row => ({ code: row.card.code, name: row.card.name })),
      coverage: { total: unique.length, implemented: unique.length - unsupported.length, missing: unsupported.map(row => `${row.card.name} (${row.card.code})`) } };
    return result(issues, deck);
  } catch (error) {
    if (!error.importIssue) throw error;
    return result([...issues, error.importIssue], undefined, error.status);
  }
}

module.exports = { importCustomDeck, compactRecipe, isStoredCustomRecipe, publicDeckId, MAX_INPUT_BYTES, MAX_MAIN_CARDS };
