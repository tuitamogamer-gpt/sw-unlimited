'use strict';
// Offline catalog import. Never infer scripted support from card text or an API row.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const ENGINE = path.join(ROOT, 'vendor/forceteki');
const ENGINE_COMMIT = JSON.parse(fs.readFileSync(path.join(DATA, 'coverage.json'))).engineCommit;
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const CHECK_ONLY = process.argv.includes('--check');
const write = (file, value) => {
  const expected = JSON.stringify(value, null, 2) + '\n';
  if (CHECK_ONLY) {
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== expected) throw new Error(`Generated artifact is stale: ${path.relative(ROOT, file)}. Run node scripts/sync-card-catalog.cjs`);
  } else fs.writeFileSync(file, expected);
};
const codeOf = (set, number) => `${String(set).toUpperCase()}_${String(number).padStart(3, '0')}`;
const nameKey = (value) => String(value || '').split(' // ')[0].normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const apiTypes = (card) => String(card.Type || '').toLowerCase().split(/\s+/).filter(Boolean);
const identityKey = (name, subtitle, types) => `${nameKey(name)}|${types.includes('base') ? '' : nameKey(subtitle)}|${[...types].sort().join(',')}`;
const apiKey = (card) => identityKey(card.Name, card.Subtitle, apiTypes(card));
const asOfFlag = process.argv.indexOf('--as-of');
const AS_OF = asOfFlag >= 0 ? process.argv[asOfFlag + 1] : '2026-10-08';
if (!/^\d{4}-\d{2}-\d{2}$/.test(AS_OF)) throw new Error('--as-of must be YYYY-MM-DD');
if (process.argv.includes('--refresh')) {
  const result = spawnSync('python', [path.join(__dirname, 'fetch-card-api.py')], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
if (!fs.existsSync(path.join(ENGINE, 'build/server/game/cards/Index.js'))) throw new Error('Build the engine first: npm run engine:setup');
const { cards: registry, overrideNotImplementedCards } = require('../vendor/forceteki/build/server/game/cards/Index.js');
const { Card } = require('../vendor/forceteki/build/server/game/core/card/Card.js');
const definitions = fs.readdirSync(path.join(ENGINE, 'test/json/Card')).filter(f => f.endsWith('.json')).map(f => read(path.join(ENGINE, 'test/json/Card', f)));
const byEngineId = new Map(definitions.map(d => [d.id, d]));
const engineMap = read(path.join(ENGINE, 'test/json/_setCodeMap.json'));
const reviewedAliases = new Map(read(path.join(DATA, 'card-alias-overrides.json')).overrides.map(alias => [alias.sourceCode, alias]));
const engineAliases = new Map();
for (const [code, id] of Object.entries(engineMap)) {
  if (!byEngineId.has(id)) throw new Error(`Engine alias points to absent definition: ${code}`);
  if (!engineAliases.has(id)) engineAliases.set(id, []);
  engineAliases.get(id).push(code);
}
const setMetadata = read(path.join(DATA, 'card-api/sets.json'));
const setByCode = new Map(setMetadata.map(s => [s.setId, s]));
function releaseDate(set) {
  const date = set.releaseDate || setByCode.get(set.parentSetId)?.releaseDate;
  if (!date) return null;
  const [m, d, y] = date.split('/').map(Number);
  return `${y < 100 ? y + 2000 : y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}
function releaseInfo(code) {
  const set = setByCode.get(code) || {};
  const date = releaseDate(set);
  return { releaseDate: date, releaseStatus: date ? (date > AS_OF ? 'preview' : 'released') : 'unknown', preview: !!date && date > AS_OF };
}
const snapshots = [];
const allPrintings = [];
for (const set of setMetadata) {
  const file = path.join(DATA, 'card-api', `${set.setId.toLowerCase()}.json`);
  if (!fs.existsSync(file)) throw new Error(`Missing snapshot ${file}; run --refresh`);
  const raw = fs.readFileSync(file);
  const response = JSON.parse(raw);
  snapshots.push({ set: set.setId, url: `https://api.swu-db.com/cards/${set.setId.toLowerCase()}`, count: response.data.length, sha256: createHash('sha256').update(raw).digest('hex') });
  for (const card of response.data) allPrintings.push({ ...card, code: codeOf(card.Set, card.Number) });
}
const allNormals = allPrintings.filter(c => c.VariantType === 'Normal' && setByCode.get(c.Set)?.isBaseSet);
const normalsByCode = new Map(allNormals.map(c => [c.code, c]));
const aliasesByIdentityKey = new Map();
function addIdentityKey(key, id) {
  if (!id) return;
  if (!aliasesByIdentityKey.has(key)) aliasesByIdentityKey.set(key, new Set());
  aliasesByIdentityKey.get(key).add(id);
}
for (const definition of definitions) addIdentityKey(identityKey(definition.title, definition.subtitle, definition.types), definition.id);
// API spelling (C-3P0, etc.) and engine spelling can differ. A known native
// set code anchors the API spelling to the verified engine identity.
for (const printing of allNormals) addIdentityKey(apiKey(printing), engineMap[printing.code] || (byEngineId.has(printing.cid) ? printing.cid : null));
function matchEngine(printing) {
  const override = reviewedAliases.get(printing.code);
  if (override) {
    if (printing.cid !== override.expectedApiId || !engineMap[override.targetCode]) throw new Error(`Reviewed promo alias changed: ${printing.code}`);
    return { id: engineMap[override.targetCode], method: 'reviewed-card-image' };
  }
  if (engineMap[printing.code]) return { id: engineMap[printing.code], method: 'native-set-code' };
  if (byEngineId.has(printing.cid)) return { id: printing.cid, method: 'official-id' };
  const candidates = aliasesByIdentityKey.get(apiKey(printing));
  if (candidates?.size === 1) return { id: [...candidates][0], method: 'unique-name-subtitle-type' };
  return { id: null, method: candidates?.size ? 'ambiguous-identity' : 'no-engine-identity' };
}
const normalCodes = new Set([...Object.keys(engineMap), ...allNormals.map(c => c.code)]);
const rows = [];
const rowsByEngineId = new Map();
for (const code of [...normalCodes].sort()) {
  const api = normalsByCode.get(code);
  const match = api ? matchEngine(api) : { id: engineMap[code], method: 'native-set-code' };
  const definition = byEngineId.get(match.id);
  const set = code.split('_')[0];
  const types = definition?.types || apiTypes(api || {});
  const nativeImplemented = !!definition && !overrideNotImplementedCards.has(definition.id) && (registry.has(definition.id) || !Card.checkHasNonKeywordAbilityText(definition));
  const syntheticId = !!definition && !/^\d{10}$/.test(definition.id);
  const mockText = !!definition && /\bmock(?: ability)? text\b/i.test([definition.text, definition.pilotText, definition.deployBox, definition.epicAction].join('\n'));
  const dataCompleteness = !definition ? 'missing' : (mockText || syntheticId ? 'provisional' : 'complete');
  const engineSupported = nativeImplemented && dataCompleteness === 'complete';
  const engineCode = definition ? (engineMap[code] ? code : (engineAliases.get(definition.id) || [])[0] || null) : null;
  const status = dataCompleteness !== 'complete' ? 'missing-data' : (nativeImplemented ? 'scripted' : 'missing-script');
  const row = {
    code, id: definition?.id || api?.cid || code, engineId: definition?.id || null, engineCode,
    internalName: definition?.internalName || null, set, setName: setByCode.get(set)?.fullName || set,
    name: definition?.title || api?.Name || code, subtitle: definition?.subtitle || api?.Subtitle || '',
    type: types.join(' '), types, aspects: definition?.aspects || (api?.Aspects || []).map(x => x.toLowerCase()),
    traits: definition?.traits || (api?.Traits || []).map(x => x.toLowerCase()), keywords: definition?.keywords || api?.Keywords || [],
    cost: definition?.cost ?? (api?.Cost ? Number(api.Cost) : null), power: definition?.power ?? (api?.Power ? Number(api.Power) : null), hp: definition?.hp ?? (api?.HP ? Number(api.HP) : null),
    upgradePower: definition?.upgradePower ?? null, upgradeHp: definition?.upgradeHp ?? null,
    text: definition?.text || api?.FrontText || '', deployText: definition?.deployBox || api?.BackText || '', pilotText: definition?.pilotText || '', epicAction: definition?.epicAction || api?.EpicAction || '',
    arena: definition?.arena || api?.Arenas?.[0]?.toLowerCase() || null, unique: definition?.unique ?? !!api?.Unique,
    image: api?.FrontArt || null, backImage: api?.BackArt || null, aliases: [code], idAliases: [api?.cid, definition?.id].filter(Boolean), printings: [],
    engineSupported, engineStatus: status, nativeImplemented, implementationType: nativeImplemented ? (registry.has(definition.id) ? 'scripted' : 'generic') : status,
    dataCompleteness, source: api ? 'swu-db-and-engine' : 'engine', identityMatch: match.method,
    deckEligible: !types.includes('token') && ['base','leader','unit','event','upgrade'].some(t => types.includes(t)) && !!engineCode,
    ...releaseInfo(set),
  };
  if (api && definition && (nameKey(api.Name) !== nameKey(definition.title) || (!types.includes('base') && nameKey(api.Subtitle) !== nameKey(definition.subtitle)))) {
    row.apiName = api.Name; row.apiSubtitle = api.Subtitle || '';
  }
  rows.push(row);
  if (definition) {
    if (!rowsByEngineId.has(definition.id)) rowsByEngineId.set(definition.id, []);
    rowsByEngineId.get(definition.id).push(row);
  }
}
const byRowCode = new Map(rows.map(r => [r.code, r]));
const unresolvedPrintings = [];
const images = {}, backImages = {};
const byCode = {}, byId = {};
const conflicts = [];
function aliasEntry(row) { return { code: row.code, engineCode: row.engineCode, engineId: row.engineId, engineSupported: row.engineSupported, deckEligible: row.deckEligible }; }
function assignAlias(target, alias, row, kind) {
  if (!alias) return;
  if (target[alias] && target[alias].engineId !== row.engineId) { conflicts.push({ kind, alias, previous: target[alias].engineId, incoming: row.engineId }); return; }
  target[alias] ||= aliasEntry(row);
}
for (const row of rows) { assignAlias(byCode, row.code, row, 'code'); for (const id of row.idAliases) assignAlias(byId, id, row, 'id'); }
for (const printing of allPrintings) {
  if (printing.FrontArt) { images[printing.code] = printing.FrontArt; images[`${printing.Set}_${printing.Number}`] = printing.FrontArt; }
  if (printing.BackArt) backImages[printing.code] = printing.BackArt;
  const match = matchEngine(printing);
  const candidates = rowsByEngineId.get(match.id) || [];
  const row = byRowCode.get(printing.code) || candidates.find(r => r.set === printing.Set) || candidates.find(r => !r.preview) || candidates[0];
  if (!row) {
    unresolvedPrintings.push({ code: printing.code, id: printing.cid || null, name: printing.Name, subtitle: printing.Subtitle || '', type: printing.Type, variant: printing.VariantType, image: printing.FrontArt || null, reason: match.method });
    continue;
  }
  row.printings.push({ code: printing.code, id: printing.cid || null, variant: printing.VariantType, image: printing.FrontArt || null, backImage: printing.BackArt || null });
  row.aliases.push(printing.code);
  if (printing.cid) row.idAliases.push(printing.cid);
  if (!row.image && printing.FrontArt) row.image = printing.FrontArt;
  if (!row.backImage && printing.BackArt) row.backImage = printing.BackArt;
  assignAlias(byCode, printing.code, row, 'code');
  assignAlias(byCode, `${printing.Set}_${printing.Number}`, row, 'code');
  assignAlias(byId, printing.cid, row, 'id');
}
for (const row of rows) { row.aliases = [...new Set(row.aliases)].sort(); row.idAliases = [...new Set(row.idAliases)].sort(); }
const countRows = (list) => ({ total: list.length, implemented: list.filter(r => r.engineSupported).length, missing: list.filter(r => !r.engineSupported).length });
const sets = [...new Set(rows.map(r => r.set))].sort().map(code => ({ code, name: setByCode.get(code)?.fullName || code, ...countRows(rows.filter(r => r.set === code)), ...releaseInfo(code) }));
const definitionSupport = definitions.map(definition => ({ id: definition.id, nativeImplemented: !overrideNotImplementedCards.has(definition.id) && (registry.has(definition.id) || !Card.checkHasNonKeywordAbilityText(definition)), provisional: !/^\d{10}$/.test(definition.id) || /\bmock(?: ability)? text\b/i.test([definition.text, definition.pilotText, definition.deployBox, definition.epicAction].join('\n')) }));
const summary = { ...countRows(rows), sets, countingUnit: 'normal-set-code-records-including-reprints-and-tokens', uniqueIdentities: { total: definitions.length, nativeImplemented: definitionSupport.filter(x => x.nativeImplemented).length, implemented: definitionSupport.filter(x => x.nativeImplemented && !x.provisional).length, provisional: definitionSupport.filter(x => x.provisional).length, scriptClasses: registry.size, generic: definitions.filter(d => !registry.has(d.id) && !Card.checkHasNonKeywordAbilityText(d)).length }, apiSets: snapshots.length, apiPrintings: allPrintings.length, aliasedCodes: Object.keys(byCode).length, unresolvedPrintings: unresolvedPrintings.length, images: Object.keys(images).length, aliasConflicts: conflicts.length, released: countRows(rows.filter(r => r.releaseStatus === 'released')), preview: countRows(rows.filter(r => r.preview)) };
const catalog = { version: 1, asOf: AS_OF, engineCommit: ENGINE_COMMIT, engineDataVersion: fs.readFileSync(path.join(ENGINE, 'card-data-version.txt'),'utf8').trim(), engineDataHash: fs.readFileSync(path.join(ENGINE, 'test/json/card-data-hash.txt'),'utf8').trim(), summary, sets, cards: rows };
write(path.join(DATA, 'card-catalog.json'), catalog);
write(path.join(DATA, 'card-aliases.json'), { version: 1, engineCommit: ENGINE_COMMIT, byCode, byId });
write(path.join(DATA, 'card-coverage.json'), { version: 1, asOf: AS_OF, engineCommit: ENGINE_COMMIT, summary, snapshots, missing: rows.filter(r => !r.engineSupported).map(r => ({ code:r.code, name:r.name, status:r.engineStatus, dataCompleteness:r.dataCompleteness, nativeImplemented:r.nativeImplemented })), unresolvedPrintings, aliasConflicts: conflicts });
write(path.join(DATA, 'card-images.json'), Object.fromEntries(Object.entries(images).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
write(path.join(DATA, 'card-back-images.json'), Object.fromEntries(Object.entries(backImages).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
console.log(JSON.stringify(summary, null, 2));
if (conflicts.length) { console.error(`Review ${conflicts.length} alias identity conflicts in data/card-coverage.json`); process.exitCode = 1; }
