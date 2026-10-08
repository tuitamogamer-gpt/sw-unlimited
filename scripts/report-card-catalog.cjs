'use strict';
const catalog = require('../data/card-catalog.json');
const coverage = require('../data/card-coverage.json');
console.table(catalog.summary.sets.map(set => ({ set: set.code, records: set.total, usable: set.implemented, unavailable: set.missing, release: set.releaseStatus })));
console.log(`Normal set-code records (reprints/tokens included): ${catalog.summary.total}`);
console.log(`Canonical engine identities: ${catalog.summary.uniqueIdentities.total}; complete usable: ${catalog.summary.uniqueIdentities.implemented}; provisional: ${catalog.summary.uniqueIdentities.provisional}`);
console.log(`API inventory: ${catalog.summary.apiSets} advertised sets, ${catalog.summary.apiPrintings} printings, ${catalog.summary.unresolvedPrintings} unresolved alternate printings.`);
if (coverage.missing.length) console.table(coverage.missing);
if (coverage.unresolvedPrintings.length) console.table(coverage.unresolvedPrintings.map(({code,name,reason}) => ({code,name,reason})));
if (coverage.aliasConflicts.length) { console.error(coverage.aliasConflicts); process.exitCode = 1; }
