'use strict';

const express = require('express');
const { decodeRecord } = require('./replay.cjs');
const { importCustomDeck } = require('./custom-decks.cjs');
const { checkOwner, checkOperations, storeError } = require('./account-store.cjs');

const CANONICAL_ORIGIN = 'https://sw-unlimited-mu.vercel.app';
const CSRF_HEADER = 'x-swu-csrf';
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const hasOnly = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const inputError = message => storeError(400, 'ACCOUNT_INPUT', message || 'Invalid cloud save update.');

function preferences(value) {
  if (value === null) return null;
  if (!hasOnly(value, ['deckId', 'opponentDeckId', 'difficulty', 'compact', 'showLog', 'language', 'handView'])
    || ['deckId', 'opponentDeckId'].some(key => value[key] !== undefined && (typeof value[key] !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value[key])))
    || value.difficulty !== undefined && !['easy', 'normal', 'hard'].includes(value.difficulty)
    || ['compact', 'showLog'].some(key => value[key] !== undefined && typeof value[key] !== 'boolean')
    || value.language !== undefined && !['en', 'sr'].includes(value.language)
    || value.handView !== undefined && !['classic', 'fan'].includes(value.handView)) throw inputError('Invalid saved preferences.');
  return { ...value };
}
function training(value, lessonIds) {
  if (!hasOnly(value, ['completedLessonIds']) || !Array.isArray(value.completedLessonIds) || value.completedLessonIds.length > 100
    || value.completedLessonIds.some(id => typeof id !== 'string' || !/^[a-z0-9-]{1,64}$/.test(id) || lessonIds && !lessonIds.includes(id))) {
    throw inputError('Invalid training progress.');
  }
  return { completedLessonIds: [...new Set(value.completedLessonIds)] };
}
function checkpoint(value) {
  if (!hasOnly(value, ['gameId', 'sessionToken']) || typeof value.gameId !== 'string' || typeof value.sessionToken !== 'string') {
    throw inputError('A saved game needs its encrypted checkpoint.');
  }
  const record = decodeRecord(value.sessionToken, { id: value.gameId });
  return { gameId: record.id, sessionToken: value.sessionToken, deckId: record.deckId, opponentDeckId: record.opponentDeckId,
    difficulty: record.difficulty, createdAt: record.createdAt, expiresAt: record.expiresAt, actionCount: record.actions.length };
}
async function deck(value, id) {
  if (!object(value)) throw inputError('Invalid saved deck.');
  // Only printed references and quantities are input to the authoritative
  // importer. Images, card rules, stats and client legality flags are ignored.
  const recipe = value.recipe || value;
  const imported = await importCustomDeck(recipe, { allowUrl: false });
  if (!imported.deck || imported.errors.length || imported.deck.id !== id) {
    throw storeError(422, 'ACCOUNT_DECK_INVALID', imported.errors[0] || 'The saved deck does not match its recipe.');
  }
  return { ...imported.deck, savedAt: Date.now() };
}

// All injection arguments are server-only. HTTP input never supplies storage,
// account identity, origin, validation functions, or a Google session resolver.
function createAccountSyncRouter({ store, authenticate, origin = CANONICAL_ORIGIN, lessonIds = ['resources', 'space-ambush', 'leader-deploy'],
  validateCheckpoint = checkpoint, restoreCheckpoint, validateMatch, validateTraining, logger = console } = {}) {
  if (typeof authenticate !== 'function') throw new TypeError('A trusted account authentication resolver is required.');
  const router = express.Router();
  const route = handler => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);
  router.use('/api/account/saves', (req, res, next) => Promise.resolve().then(async () => {
    res.set('Cache-Control', 'private, no-store'); res.set('Vary', 'Cookie');
    const authenticated = await authenticate(req);
    const user = authenticated?.user || authenticated;
    checkOwner(user?.id);
    // This is an expected-account precondition, never an identity selector.
    // A cookie/token may switch while an old device request is in flight; that
    // request must neither read nor write the newly authenticated account.
    if (req.get('x-swu-owner') !== user.id) {
      throw storeError(401, 'ACCOUNT_CHANGED', 'Your account changed. Sign in again before syncing.');
    }
    res.locals.accountSaveOwner = user.id;
    if (!store) throw storeError(503, 'ACCOUNT_STORAGE_UNAVAILABLE', 'Cloud saves are not configured. Your local saves have been kept.');
    if (!['GET', 'HEAD'].includes(req.method)) {
      const expectedOrigin = typeof origin === 'function' ? origin() : origin;
      if (typeof expectedOrigin !== 'string' || req.get('origin') !== expectedOrigin || req.get(CSRF_HEADER) !== '1'
        || req.get('sec-fetch-site') === 'cross-site') {
        throw storeError(403, 'ACCOUNT_ORIGIN', 'Use this game page to update cloud saves.');
      }
      if (!req.is('application/json')) throw storeError(415, 'ACCOUNT_CONTENT_TYPE', 'Send cloud save updates as JSON.');
    }
  }).then(() => next(), next));
  router.get('/api/account/saves', route(async (_req, res) => res.json(await store.read(res.locals.accountSaveOwner))));
  router.patch('/api/account/saves', route(async (req, res) => {
    if (!hasOnly(req.body, ['operations']) || !Object.prototype.hasOwnProperty.call(req.body, 'operations')) throw inputError();
    checkOperations(req.body.operations);
    const operations = [];
    for (const operation of req.body.operations) {
      const { kind, id, expectedVersion, value } = operation;
      let validated = null;
      if (value !== null) {
        if (kind === 'deck') validated = await deck(value, id);
        if (kind === 'preferences') validated = preferences(value);
        if (kind === 'training') {
          if (typeof validateTraining !== 'function') throw storeError(503, 'ACCOUNT_TRAINING_UNAVAILABLE', 'Training progress is temporarily unavailable.');
          validated = training(await validateTraining(value, { ownerId: res.locals.accountSaveOwner }), lessonIds);
        }
        if (kind === 'currentGame') validated = await validateCheckpoint(value, { ownerId: res.locals.accountSaveOwner });
        if (kind === 'match') {
          if (typeof validateMatch !== 'function') throw storeError(503, 'ACCOUNT_REVIEW_UNAVAILABLE', 'Match history is temporarily unavailable.');
          validated = await validateMatch(value, { ownerId: res.locals.accountSaveOwner, gameId: id });
        }
      }
      operations.push({ kind, ...(id !== undefined ? { id } : {}), expectedVersion, value: validated });
    }
    res.json(await store.update(res.locals.accountSaveOwner, operations));
  }));
  router.post('/api/account/saves/current-game/restore', route(async (req, res) => {
    if (!hasOnly(req.body, []) || typeof restoreCheckpoint !== 'function') {
      throw typeof restoreCheckpoint !== 'function'
        ? storeError(503, 'ACCOUNT_RESTORE_UNAVAILABLE', 'Saved game restoration is temporarily unavailable.') : inputError();
    }
    const saved = await store.read(res.locals.accountSaveOwner);
    if (!saved.currentGame.value) throw storeError(404, 'ACCOUNT_GAME_MISSING', 'No game is saved to this account.');
    // This value came from an authenticated account document, never the POST
    // body. Only this boundary may invoke the account replay-lifetime refresh.
    const restored = await restoreCheckpoint(saved.currentGame.value, { ownerId: res.locals.accountSaveOwner });
    res.json(restored);
  }));
  router.use('/api/account/saves', (_req, res) => res.status(404).json({ error: 'Unknown cloud save route.', code: 'ACCOUNT_ROUTE' }));
  router.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    const known = error.status && typeof error.code === 'string';
    if (!known) logger.error?.('Cloud save request failed:', error.name || 'StorageError');
    res.status(known ? error.status : 503).json({ error: known ? error.message : 'Cloud saves are unavailable. Your local saves have been kept.',
      code: known ? error.code : 'ACCOUNT_STORAGE_UNAVAILABLE', ...(error.snapshot ? { snapshot: error.snapshot } : {}) });
  });
  return router;
}

module.exports = { createAccountSyncRouter, CSRF_HEADER };
