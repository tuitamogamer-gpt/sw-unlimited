const fs = require('node:fs');
const path = require('node:path');
const { listDeckStatus } = require('../server/engine.cjs');
const decks = require('../data/decks.json');
async function main() {
  const catalog = await listDeckStatus(decks);
  const report = { engineCommit: '1f0e9783c4743acdc67df0c4ab3f3610a349c32a',
    decks: catalog.map(deck => ({ id: deck.id, name: deck.name, supported: deck.supported,
      cardCount: deck.cardCount, coverage: deck.coverage, error: deck.error })) };
  fs.writeFileSync(path.join(__dirname, '../data/coverage.json'), JSON.stringify(report, null, 2) + '\n');
  console.table(report.decks.map(deck => ({ id: deck.id, main: deck.cardCount, scripted: deck.coverage?.implemented,
    required: deck.coverage?.total, supported: deck.supported })));
  if (report.decks.some(deck => !deck.supported || deck.cardCount !== 50)) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
