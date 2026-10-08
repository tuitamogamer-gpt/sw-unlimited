const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { createGame, listDeckStatus } = require('./engine.cjs');
const { chooseAction } = require('./bot.cjs');

const root = path.resolve(__dirname, '..');
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
const sessions = new Map();
const SESSION_TTL = 6 * 60 * 60 * 1000;
const MAX_SESSIONS = 40;
const difficulties = new Set(['easy', 'normal', 'hard']);
let deckCatalog;
let deckRecipes;

const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
function fail(status, message) { const error = new Error(message); error.status = status; throw error; }
function getSession(id) {
  const entry = sessions.get(id);
  if (!entry) fail(404, 'Partija je istekla ili je poslužitelj ponovno pokrenut. Pokreni novu partiju.');
  entry.lastAccess = Date.now();
  return entry;
}
function humanView(entry) {
  const view = entry.game.view('human');
  return { ...view, difficulty: entry.difficulty, botReason: entry.botHistory.at(-1)?.reason,
    botThinking: entry.botHistory.at(-1), botHistory: entry.botHistory.slice(-12),
    warnings: [...(view.warnings || []), ...(entry.warning ? [entry.warning] : [])] };
}
async function playBot(entry) {
  entry.warning = null;
  for (let step = 0; step < 120; step++) {
    const observation = entry.game.botView();
    if (observation.winnerIds?.length || !observation.legalActions?.length || !observation.prompt?.active) return;
    let choice;
    try {
      choice = chooseAction(observation, { difficulty: entry.difficulty, memory: entry.memory });
    } catch (error) {
      entry.warning = `AI odluka nije dovršena: ${error.message}. Pokušaj nastaviti AI potez.`;
      return;
    }
    if (!choice?.action) {
      entry.warning = 'AI nije uspio odabrati legalnu akciju. Partija je sačuvana; pokušaj ponovno.';
      return;
    }
    const before = observation.version;
    try {
      await entry.game.submit(choice.action, 'bot');
    } catch (error) {
      entry.warning = `AI akcija nije dovršena: ${error.message}. Pokušaj nastaviti AI potez.`;
      return;
    }
    // Card labels can name a privately selected resource or a searched hand card.
    // Publish only the action category and the bot's generic explanation.
    entry.botHistory.push({ action: ({ card: 'Odabir karte', button: 'Odluka', stateful: 'Raspodjela', perCard: 'Odabir učinka' })[choice.action.type], reason: choice.reason,
      score: Number.isFinite(choice.score) ? choice.score : undefined });
    if (entry.botHistory.length > 100) entry.botHistory.shift();
    if (entry.game.botView().version === before) {
      entry.warning = 'AI akcija nije promijenila stanje igre. Pokušaj ponovno.';
      return;
    }
  }
  entry.warning = 'AI je dosegnuo granicu jednog niza odluka. Nastavi AI potez.';
}

app.get('/api/health', (_req, res) => res.json({ ok: true, engine: 'Forceteki', ready: Boolean(deckCatalog), sessions: sessions.size }));
app.get('/api/decks', (_req, res) => {
  if (!deckCatalog) return res.status(503).json({ error: 'Učitavanje karata… Pokušaj ponovno za trenutak.' });
  res.json({ decks: deckCatalog, engineVersion: '1f0e9783c4743acdc67df0c4ab3f3610a349c32a',
    rulesVersion: 'Forceteki pinned snapshot; official rules reference v9.0 (dated 2026-10-09)',
    sources: [
      { title: 'Službena pravila i errata', url: 'https://starwarsunlimited.com/how-to-play?chapter=rules', description: 'Fantasy Flight Games · primarni izvor' },
      { title: 'Comprehensive Rules v9.0', url: 'https://cdn.starwarsunlimited.com//SWH_Comp_Rules_v9_0_c4aa591948.pdf', description: 'Naslovnica datirana 9.10.2026.; verzijska napomena u dokumentaciji' },
      { title: 'SWUDB API karata', url: 'https://api.swu-db.com/cards/sor', description: 'Javni JSON API; lokalni snapshot definicija za igru' },
      { title: 'Forceteki · MIT', url: 'https://github.com/SWU-Karabast/forceteki', description: 'Skriptirani engine · fiksna verzija u projektu' },
      { title: 'Reddit · Ambush i When Played', url: 'https://www.reddit.com/r/starwarsunlimited/comments/1bmwkpw/order_for_ambush_when_played/', description: 'Rasprava zajednice, povijesno tumačenje; službena pravila imaju prednost' },
      { title: 'BoardGameGeek · Overwhelm i Shield', url: 'https://boardgamegeek.com/thread/3269976/overwhelm-vs-shielded-unit', description: 'Dostupan izvadak rasprave; nije autoritet za aktualno pravilo' }
    ] });
});
app.post('/api/games', asyncRoute(async (req, res) => {
  if (!deckRecipes) fail(503, 'Karte se još učitavaju.');
  if (sessions.size >= MAX_SESSIONS) fail(503, 'Poslužitelj je popunjen. Zatvori prethodnu partiju pa pokušaj ponovno.');
  const { deckId, opponentDeckId, difficulty = 'normal' } = req.body || {};
  if (!difficulties.has(difficulty)) fail(400, 'Nepoznata težina protivnika.');
  const playerDeck = deckRecipes.find(deck => deck.id === deckId);
  const botDeck = deckRecipes.find(deck => deck.id === opponentDeckId);
  if (!playerDeck || !botDeck) fail(400, 'Odaberi dva postojeća starter špila.');
  for (const deck of [playerDeck, botDeck]) {
    if (deckCatalog.find(item => item.id === deck.id)?.supported === false) fail(400, `Špil ${deck.name} sadrži nepodržane karte.`);
  }
  const game = await createGame({ playerDeck, botDeck, difficulty });
  const entry = { game, difficulty, memory: {}, botHistory: [], lastAccess: Date.now(), busy: false };
  try { await playBot(entry); } catch (error) { game.close?.(); throw error; }
  sessions.set(game.id, entry);
  res.status(201).json(humanView(entry));
}));
app.get('/api/games/:id', (req, res) => res.json(humanView(getSession(req.params.id))));
app.post('/api/games/:id/actions', asyncRoute(async (req, res) => {
  const entry = getSession(req.params.id);
  if (entry.busy) fail(409, 'Prethodna akcija se još obrađuje.');
  if (!req.body || !['card', 'button', 'stateful', 'perCard'].includes(req.body.type)) fail(400, 'Nepoznata akcija.');
  entry.busy = true;
  try {
    await entry.game.submit(req.body, 'human');
    await playBot(entry);
    res.json(humanView(entry));
  } finally { entry.busy = false; }
}));
app.post('/api/games/:id/bot', asyncRoute(async (req, res) => {
  const entry = getSession(req.params.id);
  if (entry.busy) fail(409, 'AI već obrađuje potez.');
  entry.busy = true;
  try { await playBot(entry); res.json(humanView(entry)); } finally { entry.busy = false; }
}));
app.delete('/api/games/:id', (req, res) => {
  const entry = getSession(req.params.id);
  if (entry.busy) fail(409, 'Akcija se još obrađuje.');
  entry.game.close?.(); sessions.delete(req.params.id); res.status(204).end();
});
app.use('/api', (_req, res) => res.status(404).json({ error: 'Nepoznata API ruta.' }));
app.use(express.static(path.join(root, 'dist')));
app.get('*', (_req, res) => {
  const file = path.join(root, 'dist/index.html');
  if (!fs.existsSync(file)) return res.status(503).send('Pokreni npm run build, ili koristi npm run dev za razvojno sučelje.');
  res.sendFile(file);
});
app.use((error, _req, res, _next) => {
  const status = error.status || (error.type === 'entity.parse.failed' ? 400 : 422);
  console.error(`[${status}] ${error.message}`);
  res.status(status).json({ error: error.message || 'Akcija nije uspjela.' });
});
const cleanup = setInterval(() => {
  for (const [id, entry] of sessions) if (!entry.busy && Date.now() - entry.lastAccess > SESSION_TTL) {
    entry.game.close?.(); sessions.delete(id);
  }
}, 60_000);
cleanup.unref();

async function start() {
  const raw = JSON.parse(fs.readFileSync(path.join(root, 'data/decks.json'), 'utf8'));
  deckRecipes = Array.isArray(raw) ? raw : raw.decks;
  deckCatalog = await listDeckStatus(deckRecipes);
  const port = Number(process.env.PORT || 3001);
  const server = app.listen(port, process.env.HOST || '0.0.0.0', () => console.log(`SWU Command ready: http://localhost:${port} · ${deckCatalog.length} decks`));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
    for (const entry of sessions.values()) entry.game.close?.();
    server.close(() => process.exit(0));
  });
  return server;
}
if (require.main === module) start().catch(error => { console.error(error); process.exit(1); });
module.exports = { app, start };
