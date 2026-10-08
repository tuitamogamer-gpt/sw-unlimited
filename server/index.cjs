const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { listDeckStatus } = require('./engine.cjs');
const { chooseAction } = require('./bot.cjs');
const { createRecord, applyAction, sealRecord, decodeRecord, restoreRecord } = require('./replay.cjs');

const root = path.resolve(__dirname, '..');
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
const sessions = new Map();
const restoring = new Set();
const SESSION_TTL = 6 * 60 * 60 * 1000;
const MAX_SESSIONS = 40;
const difficulties = new Set(['easy', 'normal', 'hard']);
let deckCatalog;
let deckRecipes;
let initializePromise;

const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
function fail(status, message) { const error = new Error(message); error.status = status; error.publicMessage = message; throw error; }
async function initialize() {
  if (!initializePromise) initializePromise = (async () => {
    const raw = JSON.parse(fs.readFileSync(path.join(root, 'data/decks.json'), 'utf8'));
    deckRecipes = Array.isArray(raw) ? raw : raw.decks;
    deckCatalog = await listDeckStatus(deckRecipes);
  })().catch(error => { initializePromise = undefined; throw error; });
  return initializePromise;
}
function cacheSession(entry) {
  if (sessions.size >= MAX_SESSIONS) {
    const oldest = [...sessions.entries()].filter(([, value]) => !value.busy).sort((a, b) => a[1].lastAccess - b[1].lastAccess)[0];
    if (oldest) { oldest[1].game.close?.(); sessions.delete(oldest[0]); }
  }
  sessions.set(entry.record.id, entry);
}
async function getSession(req, { allowStale = false } = {}) {
  await initialize();
  const token = req.body?.sessionToken || req.get('x-game-state');
  if (typeof token !== 'string' || !token) fail(404, 'Nedostaje spremljena partija. Pokreni novu partiju.');
  const record = decodeRecord(token, { id: req.params.id });
  if (record.id !== req.params.id) fail(404, 'Spremljena partija ne odgovara traženoj partiji.');
  let entry = sessions.get(record.id);
  if (entry?.busy || restoring.has(record.id)) fail(409, 'Prethodna akcija se još obrađuje.');
  if (entry && record.actions.length < entry.record.actions.length) {
    if (!allowStale) fail(409, 'Stanje partije se promijenilo. Osvježi partiju prije sljedeće akcije.');
  } else if (!entry || JSON.stringify(record.actions) !== JSON.stringify(entry.record.actions)) {
    // Instances are disposable: the encrypted browser checkpoint owns the game.
    // A newer checkpoint can arrive after another instance processed the last turn.
    restoring.add(record.id);
    try {
      const restored = await restoreRecord(token, { decks: deckRecipes });
      entry?.game.close?.();
      entry = { ...restored, lastAccess: Date.now(), busy: false };
      cacheSession(entry);
    } finally { restoring.delete(record.id); }
  }
  entry.lastAccess = Date.now();
  return entry;
}
function humanView(entry) {
  const view = entry.game.view('human');
  const record = entry.record;
  return { ...view, sessionToken: sealRecord(record), difficulty: record.difficulty, botReason: record.botHistory.at(-1)?.reason,
    botThinking: record.botHistory.at(-1), botHistory: record.botHistory.slice(-12),
    warnings: [...(view.warnings || []), ...(record.warning ? [record.warning] : [])] };
}
async function playBot(entry) {
  const record = entry.record;
  record.warning = null;
  for (let step = 0; step < 120; step++) {
    const observation = entry.game.botView();
    if (observation.ended || observation.winnerIds?.length || !observation.legalActions?.length || !observation.prompt?.active) return;
    let choice;
    try {
      choice = chooseAction(observation, { difficulty: record.difficulty, memory: record.memory });
    } catch (error) {
      console.error('Bot decision failed:', error.code || error.name);
      record.warning = 'AI odluka nije dovršena. Pokušaj nastaviti AI potez.';
      return;
    }
    if (!choice?.action) {
      record.warning = 'AI nije uspio odabrati legalnu akciju. Partija je sačuvana; pokušaj ponovno.';
      return;
    }
    const before = observation.version;
    try {
      await applyAction(record, entry.game, choice.action, 'bot');
    } catch (error) {
      // A failed engine action may be partially applied. Discard this instance;
      // the client's previous checkpoint remains an atomic recovery point.
      throw error;
    }
    // Card labels can name a privately selected resource or a searched hand card.
    // Publish only the action category and the bot's generic explanation.
    record.botHistory.push({ action: ({ card: 'Odabir karte', button: 'Odluka', stateful: 'Raspodjela', perCard: 'Odabir učinka' })[choice.action.type], reason: choice.reason,
      score: Number.isFinite(choice.score) ? choice.score : undefined });
    if (record.botHistory.length > 100) record.botHistory.shift();
    if (entry.game.botView().version === before) {
      record.warning = 'AI akcija nije promijenila stanje igre. Pokušaj ponovno.';
      return;
    }
  }
  record.warning = 'AI je dosegnuo granicu jednog niza odluka. Nastavi AI potez.';
}

app.get('/api/health', (_req, res) => res.json({ ok: true, engine: 'Forceteki', ready: Boolean(deckCatalog), sessions: sessions.size }));
app.get('/api/decks', asyncRoute(async (_req, res) => {
  await initialize();
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
}));
app.post('/api/games', asyncRoute(async (req, res) => {
  await initialize();
  const { deckId, opponentDeckId, difficulty = 'normal' } = req.body || {};
  if (!difficulties.has(difficulty)) fail(400, 'Nepoznata težina protivnika.');
  const playerDeck = deckRecipes.find(deck => deck.id === deckId);
  const botDeck = deckRecipes.find(deck => deck.id === opponentDeckId);
  if (!playerDeck || !botDeck) fail(400, 'Odaberi dva postojeća starter špila.');
  for (const deck of [playerDeck, botDeck]) {
    if (deckCatalog.find(item => item.id === deck.id)?.supported === false) fail(400, `Špil ${deck.name} sadrži nepodržane karte.`);
  }
  const created = await createRecord({ playerDeck, botDeck, difficulty });
  const entry = { ...created, lastAccess: Date.now(), busy: false };
  try { await playBot(entry); } catch (error) { entry.game.close?.(); throw error; }
  cacheSession(entry);
  res.status(201).json(humanView(entry));
}));
const readGame = asyncRoute(async (req, res) => {
  const entry = await getSession(req, { allowStale: true });
  if (entry.busy) fail(409, 'Prethodna akcija se još obrađuje.');
  res.json(humanView(entry));
});
app.get('/api/games/:id', readGame);
app.post('/api/games/:id/state', readGame);
app.post('/api/games/:id/actions', asyncRoute(async (req, res) => {
  const entry = await getSession(req);
  if (entry.busy) fail(409, 'Prethodna akcija se još obrađuje.');
  if (!req.body || !['card', 'button', 'stateful', 'perCard'].includes(req.body.type)) fail(400, 'Nepoznata akcija.');
  entry.busy = true;
  try {
    const { sessionToken: _token, ...action } = req.body;
    await applyAction(entry.record, entry.game, action, 'human');
    await playBot(entry);
    res.json(humanView(entry));
  } catch (error) { entry.game.close?.(); sessions.delete(req.params.id); throw error; }
  finally { entry.busy = false; }
}));
app.post('/api/games/:id/bot', asyncRoute(async (req, res) => {
  const entry = await getSession(req);
  if (entry.busy) fail(409, 'AI već obrađuje potez.');
  entry.busy = true;
  try { await playBot(entry); res.json(humanView(entry)); }
  catch (error) { entry.game.close?.(); sessions.delete(req.params.id); throw error; }
  finally { entry.busy = false; }
}));
app.delete('/api/games/:id', asyncRoute(async (req, res) => {
  const entry = await getSession(req);
  if (entry.busy) fail(409, 'Akcija se još obrađuje.');
  entry.game.close?.(); sessions.delete(req.params.id); res.status(204).end();
}));
app.use('/api', (_req, res) => res.status(404).json({ error: 'Nepoznata API ruta.' }));
app.use(express.static(path.join(root, 'dist')));
app.get('*', (_req, res) => {
  const file = path.join(root, 'dist/index.html');
  if (!fs.existsSync(file)) return res.status(503).send('Pokreni npm run build, ili koristi npm run dev za razvojno sučelje.');
  res.sendFile(file);
});
app.use((error, _req, res, _next) => {
  const status = error.status || (error.type === 'entity.parse.failed' ? 400 : error.type === 'entity.too.large' ? 413 : 500);
  const messages = { STALE_PROMPT: 'Odabir se promijenio. Osvježi partiju.', STALE_STATE: 'Stanje partije se promijenilo. Osvježi partiju.',
    ILLEGAL_ACTION: 'Akcija nije dostupna u trenutačnom stanju partije.', GAME_ENDED: 'Partija je završila.',
    INVALID_SESSION: 'Spremljena partija nije valjana. Pokreni novu partiju.', SESSION_EXPIRED: 'Spremljena partija je istekla. Pokreni novu partiju.' };
  console.error(`[${status}] ${error.code || error.type || error.name}`);
  res.status(status).json({ error: error.publicMessage || messages[error.code] || 'Akcija nije uspjela. Pokušaj ponovno.' });
});
const cleanup = setInterval(() => {
  for (const [id, entry] of sessions) if (!entry.busy && Date.now() - entry.lastAccess > SESSION_TTL) {
    entry.game.close?.(); sessions.delete(id);
  }
}, 60_000);
cleanup.unref();

async function start() {
  await initialize();
  const port = Number(process.env.PORT || 3001);
  const server = app.listen(port, process.env.HOST || '0.0.0.0', () => console.log(`SWU Command ready: http://localhost:${port} · ${deckCatalog.length} decks`));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
    for (const entry of sessions.values()) entry.game.close?.();
    server.close(() => process.exit(0));
  });
  return server;
}
if (require.main === module) start().catch(error => { console.error(error); process.exit(1); });
module.exports = { app, start, initialize };
