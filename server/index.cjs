const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { listDeckStatus } = require('./engine.cjs');
const { chooseAction } = require('./bot.cjs');
const { createRecord, applyAction, sealRecord, decodeRecord, restoreRecord, bindAccountCheckpoint, restoreAccountRecord } = require('./replay.cjs');
const { importCustomDeck } = require('./custom-decks.cjs');
const { searchCards } = require('./card-catalog.cjs');
const { authRouter, resolveAccount } = require('./auth.cjs');
const { createAccountStore, createSupabaseAccountAdapter, storeError } = require('./account-store.cjs');
const { createAccountSyncRouter } = require('./account-sync.cjs');
const { trainingCatalog, createTraining, trainingView, trainingGameView, assertTrainingAction, advanceTraining } = require('./training.cjs');
const { captureReviewDecision, commitReviewDecision, publicReview } = require('./match-review.cjs');

function environmentAccountStore() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
  try { return createAccountStore({ adapter: createSupabaseAccountAdapter() }); }
  catch { return null; }
}

function createApplication({ auth = authRouter, authenticate = resolveAccount, accountStore = environmentAccountStore(),
  accountOrigin = () => process.env.AUTH_URL || 'https://sw-unlimited-mu.vercel.app' } = {}) {

const root = path.resolve(__dirname, '..');
const app = express();
app.disable('x-powered-by');
app.use(auth);
app.use('/api/account/saves', express.json({ limit: '2mb' }));
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
function publicMetadata(res, value) {
  // Serialize before changing the default no-store policy. A failed metadata
  // request must never inherit a successful response's shared-cache headers.
  const body = JSON.stringify(value);
  const etag = `"${createHash('sha256').update(body).digest('base64url')}"`;
  return res.type('json').set({
    'Cache-Control': 'public, max-age=0, must-revalidate',
    'Vercel-CDN-Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
    ETag: etag,
  }).send(body);
}
async function initialize() {
  if (!initializePromise) initializePromise = (async () => {
    const raw = JSON.parse(fs.readFileSync(path.join(root, 'data/decks.json'), 'utf8'));
    deckRecipes = Array.isArray(raw) ? raw : raw.decks;
    deckCatalog = await listDeckStatus(deckRecipes);
  })().catch(error => {
    initializePromise = undefined;
    const failure = new Error('The game server is currently unavailable. Try again.', { cause: error });
    failure.status = 503; failure.code = 'ENGINE_INITIALIZATION'; failure.publicMessage = failure.message;
    throw failure;
  });
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
  if (typeof token !== 'string' || !token) fail(404, 'No saved game was found. Start a new game.');
  const record = decodeRecord(token, { id: req.params.id });
  if (record.id !== req.params.id) fail(404, 'The saved game does not match the requested game.');
  let entry = sessions.get(record.id);
  if (entry?.record.accountOwnerId && record.accountOwnerId && entry.record.accountOwnerId !== record.accountOwnerId) {
    fail(403, 'This saved game belongs to another account.');
  }
  if (entry?.busy || restoring.has(record.id)) fail(409, 'The previous action is still being processed.');
  if (entry && record.actions.length < entry.record.actions.length) {
    if (!allowStale) fail(409, 'The game state has changed. Refresh the game before your next action.');
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
  // An account-bound envelope may contain the same engine decisions as an
  // already cached guest board. Keep its verified ownership and renewed clock
  // without replaying or replacing that board's newer decisions.
  if (record.accountOwnerId) {
    entry.record.accountOwnerId = record.accountOwnerId;
    if (record.originalCreatedAt && !entry.record.originalCreatedAt) entry.record.originalCreatedAt = record.originalCreatedAt;
    if (record.createdAt > entry.record.createdAt) {
      entry.record.createdAt = record.createdAt;
      entry.record.expiresAt = record.expiresAt;
    }
  }
  entry.lastAccess = Date.now();
  return entry;
}
function humanView(entry) {
  const view = entry.game.view('human');
  const record = entry.record;
  if (view.winnerIds?.length && !record.finishedAt) record.finishedAt = Date.now();
  const decorated = trainingGameView(record, entry.game, view);
  return { ...decorated, review: record.training ? null : publicReview(record, entry.game),
    startedAt: record.originalCreatedAt || record.createdAt, finishedAt: record.finishedAt,
    sessionToken: sealRecord(record), difficulty: record.difficulty, botReason: record.botHistory.at(-1)?.reason,
    botThinking: record.botHistory.at(-1), botHistory: record.botHistory.slice(-12),
    warnings: [...(view.warnings || []), ...(record.warning ? [record.warning] : [])] };
}
async function playBot(entry) {
  const record = entry.record;
  if (record.training) { advanceTraining(record, entry.game); return; }
  record.warning = null;
  for (let step = 0; step < 120; step++) {
    const observation = entry.game.botView();
    if (observation.ended || observation.winnerIds?.length || !observation.legalActions?.length || !observation.prompt?.active) return;
    let choice;
    try {
      choice = chooseAction(observation, { difficulty: record.difficulty, memory: record.memory });
    } catch (error) {
      console.error('Bot decision failed:', error.code || error.name);
      record.warning = 'The AI could not complete its decision. Try continuing the AI turn.';
      return;
    }
    if (!choice?.action) {
      record.warning = 'The AI could not choose a legal action. Your game is saved; try again.';
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
    record.botHistory.push({ action: ({ card: 'Card selection', button: 'Decision', stateful: 'Distribution', perCard: 'Effect selection' })[choice.action.type], reason: choice.reason,
      score: Number.isFinite(choice.score) ? choice.score : undefined });
    if (record.botHistory.length > 100) record.botHistory.shift();
    if (entry.game.botView().version === before) {
      record.warning = 'The AI action did not change the game state. Try again.';
      return;
    }
  }
  record.warning = 'The AI reached its decision limit for this turn. Continue the AI turn.';
}

// Account data is read only after the native session has established its owner.
// Proofs are encrypted game records. Browser-supplied summaries are never saved.
function checkedProof(value, ownerId, expectedId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['gameId', 'sessionToken'].includes(key))
    || typeof value.gameId !== 'string' || typeof value.sessionToken !== 'string'
    || expectedId && expectedId !== value.gameId) {
    throw storeError(400, 'ACCOUNT_INPUT', 'A saved game needs its encrypted checkpoint.');
  }
  return bindAccountCheckpoint(value.sessionToken, { id: value.gameId, ownerId });
}
async function nativeProof(value, ownerId, expectedId) {
  await initialize();
  let proof;
  try { proof = checkedProof(value, ownerId, expectedId); }
  catch (error) {
    if (error.code !== 'SESSION_EXPIRED') throw error;
    // Offline account changes can arrive after the guest checkpoint clock.
    // Only a signed, matching account owner can renew this proof; the native
    // replay still verifies every action and enforces the 30-day retention.
    return restoreAccountRecord(value.sessionToken, { decks: deckRecipes, id: value.gameId, ownerId });
  }
  return restoreRecord(proof.sessionToken, { decks: deckRecipes, id: proof.gameId });
}
app.use(createAccountSyncRouter({ store: accountStore, authenticate, origin: accountOrigin,
  validateCheckpoint: async (value, { ownerId }) => {
    try { return checkedProof(value, ownerId); }
    catch (error) {
      if (error.code !== 'SESSION_EXPIRED') throw error;
      const restored = await nativeProof(value, ownerId);
      try { return bindAccountCheckpoint(sealRecord(restored.record), { id: value.gameId, ownerId }); }
      finally { restored.game.close(); }
    }
  },
  restoreCheckpoint: async (saved, { ownerId }) => {
    await initialize();
    const restored = await restoreAccountRecord(saved.sessionToken, { decks: deckRecipes, id: saved.gameId, ownerId });
    const current = sessions.get(saved.gameId);
    if (current?.busy || restoring.has(saved.gameId)) {
      restored.game.close(); fail(409, 'The previous action is still being processed.');
    }
    if (current?.record.accountOwnerId && current.record.accountOwnerId !== ownerId) {
      restored.game.close();
      throw storeError(403, 'ACCOUNT_SCOPE', 'This saved game belongs to another account.');
    }
    // A second device may have a newer active board on this same worker.
    // Never replace it with an older stored account checkpoint.
    if (current && current.record.actions.length > restored.record.actions.length) {
      restored.game.close();
      current.record.accountOwnerId = ownerId;
      current.record.originalCreatedAt ||= current.record.createdAt;
      current.record.createdAt = restored.record.createdAt;
      current.record.expiresAt = restored.record.expiresAt;
      return humanView(current);
    }
    current?.game.close();
    const entry = { ...restored, lastAccess: Date.now(), busy: false };
    cacheSession(entry);
    return humanView(entry);
  },
  validateMatch: async (value, { ownerId, gameId }) => {
    const restored = await nativeProof(value, ownerId, gameId);
    try {
      const review = publicReview(restored.record, restored.game);
      if (!review || restored.record.training) throw storeError(422, 'ACCOUNT_MATCH_UNFINISHED', 'Finish this game before saving its review.');
      const view = restored.game.view('human');
      return { gameId: restored.record.id, review, playerLeader: view.players.human.leader.name,
        opponentLeader: view.players.bot.leader.name, difficulty: restored.record.difficulty,
        startedAt: restored.record.originalCreatedAt || restored.record.createdAt,
        completedAt: restored.record.finishedAt || Date.now() };
    } finally { restored.game.close(); }
  },
  validateTraining: async (value, { ownerId }) => {
    const restored = await nativeProof(value, ownerId);
    try {
      const lesson = trainingView(restored.record, restored.game);
      if (lesson?.status !== 'complete') throw storeError(422, 'ACCOUNT_TRAINING_UNFINISHED', 'Complete this lesson before saving its progress.');
      return { completedLessonIds: [lesson.lessonId] };
    } finally { restored.game.close(); }
  },
}));
app.get('/api/training', (_req, res) => publicMetadata(res, { lessons: trainingCatalog }));
app.post('/api/training/:lessonId', asyncRoute(async (req, res) => {
  await initialize();
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length) fail(400, 'Choose an available training lesson.');
  const created = await createTraining(req.params.lessonId, { decks: deckRecipes });
  const entry = { ...created, lastAccess: Date.now(), busy: false };
  cacheSession(entry);
  res.status(201).json(humanView(entry));
}));

app.get('/api/health', (_req, res) => res.json({ ok: true, engine: 'Forceteki', ready: Boolean(deckCatalog), sessions: sessions.size }));
app.get('/api/cards', asyncRoute(async (req, res) => publicMetadata(res, await searchCards(req.query))));
app.post('/api/decks/import', asyncRoute(async (req, res) => {
  const { input, name } = req.body || {};
  const { status, ...result } = await importCustomDeck(input, { name });
  res.status(status).json(result);
}));
app.get('/api/decks', asyncRoute(async (_req, res) => {
  await initialize();
  publicMetadata(res, { decks: deckCatalog, engineVersion: '1f0e9783c4743acdc67df0c4ab3f3610a349c32a',
    rulesVersion: 'Forceteki pinned snapshot; official rules reference v9.0 (dated 2026-10-09)',
    sources: [
      { title: 'Official rules and errata', url: 'https://starwarsunlimited.com/how-to-play?chapter=rules', description: 'Fantasy Flight Games · primary source' },
      { title: 'Comprehensive Rules v9.0', url: 'https://cdn.starwarsunlimited.com//SWH_Comp_Rules_v9_0_c4aa591948.pdf', description: 'Cover dated October 9, 2026; version note in the documentation' },
      { title: 'SWUDB card API', url: 'https://api.swu-db.com/cards/sor', description: 'Public JSON API; local snapshot of game card definitions' },
      { title: 'Forceteki · MIT', url: 'https://github.com/SWU-Karabast/forceteki', description: 'Scripted rules engine · pinned project version' },
      { title: 'Reddit · Ambush and When Played', url: 'https://www.reddit.com/r/starwarsunlimited/comments/1bmwkpw/order_for_ambush_when_played/', description: 'Community discussion and historical interpretation; official rules take priority' },
      { title: 'BoardGameGeek · Overwhelm and Shield', url: 'https://boardgamegeek.com/thread/3269976/overwhelm-vs-shielded-unit', description: 'Available discussion excerpt; not an authority on the current rule' }
    ] });
}));
app.post('/api/games', asyncRoute(async (req, res) => {
  await initialize();
  const { deckId, opponentDeckId, difficulty = 'normal' } = req.body || {};
  if (!difficulties.has(difficulty)) fail(400, 'Unknown opponent difficulty.');
  let playerDeck = deckRecipes.find(deck => deck.id === deckId);
  let botDeck = deckRecipes.find(deck => deck.id === opponentDeckId);
  for (const [key, seat] of [['playerDeck', 'human'], ['opponentDeck', 'bot']]) {
    if (req.body?.[key] === undefined) continue;
    if (!req.body[key] || typeof req.body[key] !== 'object' || Array.isArray(req.body[key])) {
      return res.status(400).json({ error: 'Start a game with an imported deck recipe.', errors: ['Start a game with an imported deck recipe.'], warnings: [], seat });
    }
    const validated = await importCustomDeck(req.body[key], { allowUrl: false });
    if (validated.errors.length) {
      const { status, ...diagnostics } = validated;
      return res.status(status).json({ ...diagnostics, error: validated.errors[0], seat });
    }
    if (seat === 'human') playerDeck = validated.deck.recipe;
    else botDeck = validated.deck.recipe;
  }
  if (!playerDeck || !botDeck) fail(400, 'Choose two available starter decks.');
  for (const deck of [playerDeck, botDeck]) {
    if (deckCatalog.find(item => item.id === deck.id)?.supported === false) fail(400, `Deck ${deck.name} contains unsupported cards.`);
  }
  const created = await createRecord({ playerDeck, botDeck, difficulty });
  const entry = { ...created, lastAccess: Date.now(), busy: false };
  try { await playBot(entry); } catch (error) { entry.game.close?.(); throw error; }
  cacheSession(entry);
  res.status(201).json(humanView(entry));
}));
const readGame = asyncRoute(async (req, res) => {
  const entry = await getSession(req, { allowStale: true });
  if (entry.busy) fail(409, 'The previous action is still being processed.');
  res.json(humanView(entry));
});
app.get('/api/games/:id', readGame);
app.post('/api/games/:id/state', readGame);
app.post('/api/games/:id/actions', asyncRoute(async (req, res) => {
  const entry = await getSession(req);
  if (entry.busy) fail(409, 'The previous action is still being processed.');
  if (!req.body || !['card', 'button', 'stateful', 'perCard'].includes(req.body.type)) fail(400, 'Unknown action.');
  entry.busy = true;
  try {
    const { sessionToken: _token, ...action } = req.body;
    assertTrainingAction(entry.record, entry.game, action);
    const captured = entry.record.training ? null : captureReviewDecision(entry.record, entry.game, action);
    await applyAction(entry.record, entry.game, action, 'human');
    commitReviewDecision(entry.record, captured, entry.game);
    await playBot(entry);
    res.json(humanView(entry));
  } catch (error) { entry.game.close?.(); sessions.delete(req.params.id); throw error; }
  finally { entry.busy = false; }
}));
app.post('/api/games/:id/bot', asyncRoute(async (req, res) => {
  const entry = await getSession(req);
  if (entry.busy) fail(409, 'The AI is already processing its turn.');
  entry.busy = true;
  try { await playBot(entry); res.json(humanView(entry)); }
  catch (error) { entry.game.close?.(); sessions.delete(req.params.id); throw error; }
  finally { entry.busy = false; }
}));
app.delete('/api/games/:id', asyncRoute(async (req, res) => {
  const entry = await getSession(req);
  if (entry.busy) fail(409, 'The action is still being processed.');
  entry.game.close?.(); sessions.delete(req.params.id); res.status(204).end();
}));
app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown API route.' }));
app.use(express.static(path.join(root, 'dist')));
app.get('*', (_req, res) => {
  const file = path.join(root, 'dist/index.html');
  if (!fs.existsSync(file)) return res.status(503).send('Run npm run build, or use npm run dev for the development interface.');
  res.sendFile(file);
});
app.use((error, _req, res, _next) => {
  // Body parsing can fail before the API middleware runs. Errors must never
  // retain public metadata caching, including malformed or oversized requests.
  res.set('Cache-Control', 'no-store');
  res.removeHeader('Vercel-CDN-Cache-Control');
  const status = error.status || (error.type === 'entity.parse.failed' ? 400 : error.type === 'entity.too.large' ? 413 : 500);
  const messages = { STALE_PROMPT: 'The available choice has changed. Refresh the game.', STALE_STATE: 'The game state has changed. Refresh the game.',
    ILLEGAL_ACTION: 'That action is not available in the current game state.', GAME_ENDED: 'The game has ended.',
    INVALID_SESSION: 'The saved game is invalid. Start a new game.', SESSION_EXPIRED: 'The saved game has expired. Start a new game.' };
  console.error(`[${status}] ${error.code || error.type || error.name}`);
  res.status(status).json({ error: error.publicMessage || messages[error.code] || 'The action failed. Try again.' });
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
return { app, start, initialize };
}

const { app, start, initialize } = createApplication();
if (require.main === module) start().catch(error => { console.error(error); process.exit(1); });
module.exports = { app, start, initialize, createApplication };
