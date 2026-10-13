'use strict';

// A serverless worker can disappear between any two turns. Store an encrypted,
// authenticated replay in the browser so another worker can rebuild the game.
// Neither the shuffle seed nor either player's private choices leave this module
// as plaintext. Client-side history rollback is possible in this solo game; this
// envelope is intentionally not a ranked multiplayer persistence protocol.
const { randomBytes, randomUUID, createHash, createCipheriv, createDecipheriv } = require('node:crypto');
const { deflateRawSync, inflateRawSync } = require('node:zlib');
const { createGame } = require('./engine.cjs');
const { compactRecipe, isStoredCustomRecipe } = require('./custom-decks.cjs');

const FORMAT = 1;
const ENGINE_VERSION = '1f0e9783c4743acdc67df0c4ab3f3610a349c32a';
const RULES_REVISION = 1;
const SESSION_TTL = 6 * 60 * 60 * 1000;
const ACCOUNT_RETENTION = 30 * 24 * 60 * 60 * 1000;
const MAX_ACTIONS = 4000;
const MAX_TOKEN_BYTES = 700 * 1024;
const MAX_RECORD_BYTES = 2 * 1024 * 1024;
const AAD = Buffer.from('sw-unlimited:private-session:v1');
const localSecret = randomBytes(32);
const ACCOUNT_OWNER = /^(?:google_[a-f0-9]{64}|supabase_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/;
const PUBLIC_CARD_ID = /^swucard_[a-f0-9]{24}$/;

function sessionError(message, code = 'INVALID_SESSION', status = 401) {
    const error = new Error(message); error.code = code; error.status = status; return error;
}

function encryptionKey() {
    const secret = process.env.SWU_SESSION_SECRET;
    if (secret && secret.length >= 32) return createHash('sha256').update(secret).digest();
    if (process.env.VERCEL || secret) {
        throw sessionError('Poslužitelj nema ispravno postavljenu zaštitu sesije.', 'SESSION_CONFIGURATION', 503);
    }
    // Local development remains immediately runnable. A configured secret is
    // required to recover a session after the local Node process restarts.
    return localSecret;
}

function validateTraining(training, actionCount) {
    if (!training || typeof training !== 'object' || Array.isArray(training)
        || !['resources', 'space-ambush', 'leader-deploy'].includes(training.lessonId)
        || !Number.isSafeInteger(training.setupActions) || training.setupActions < 0 || training.setupActions > actionCount) return false;
    const keys = training.lessonId === 'resources' ? ['lessonId', 'setupActions']
        : training.lessonId === 'space-ambush' ? ['lessonId', 'setupActions', 'sourceId', 'targetId']
            : ['lessonId', 'setupActions', 'sourceId'];
    if (Object.keys(training).some(key => !keys.includes(key))) return false;
    if (training.lessonId !== 'resources' && (typeof training.sourceId !== 'string' || !PUBLIC_CARD_ID.test(training.sourceId))) return false;
    if (training.lessonId === 'space-ambush' && (typeof training.targetId !== 'string' || !PUBLIC_CARD_ID.test(training.targetId)
        || training.targetId === training.sourceId)) return false;
    return true;
}

function validateRecord(record, expectedId, { allowExpired = false } = {}) {
    if (!record || typeof record !== 'object' || Array.isArray(record)
        || record.format !== FORMAT || record.engineVersion !== ENGINE_VERSION
        || typeof record.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(record.id)
        || expectedId !== undefined && record.id !== expectedId
        || typeof record.seed !== 'string' || record.seed.length > 256
        || !['easy', 'normal', 'hard'].includes(record.difficulty)
        || ![record.deckId, record.opponentDeckId].every((id) => typeof id === 'string' && id.length > 0 && id.length <= 128)
        || !Number.isSafeInteger(record.createdAt) || !Number.isSafeInteger(record.expiresAt)
        || record.createdAt > Date.now() + 60_000 || record.expiresAt <= record.createdAt
        || record.expiresAt - record.createdAt > SESSION_TTL
        || !Array.isArray(record.actions) || record.actions.length > MAX_ACTIONS
        || !record.memory || typeof record.memory !== 'object' || Array.isArray(record.memory)
        || !Array.isArray(record.botHistory) || record.botHistory.length > 100
        || record.accountOwnerId !== undefined && (typeof record.accountOwnerId !== 'string' || !ACCOUNT_OWNER.test(record.accountOwnerId))
        || record.originalCreatedAt !== undefined && (!Number.isSafeInteger(record.originalCreatedAt)
            || record.originalCreatedAt < 0 || record.originalCreatedAt > record.createdAt)
        || record.training !== undefined && !validateTraining(record.training, record.actions?.length)) {
        throw sessionError('Nevažeća spremljena partija. Pokreni novu partiju.');
    }
    for (const [field, deckId] of [['playerDeck', record.deckId], ['opponentDeck', record.opponentDeckId]]) {
        if (record[field] !== undefined && !isStoredCustomRecipe(record[field], deckId)) {
            throw sessionError('Invalid saved custom deck. Start a new game.');
        }
    }
    if (!allowExpired && record.expiresAt <= Date.now()) throw sessionError('Spremljena partija je istekla. Pokreni novu partiju.', 'SESSION_EXPIRED', 410);
    for (const item of record.actions) {
        const action = item?.action;
        if (!['human', 'bot'].includes(item?.playerId) || !action || typeof action !== 'object' || Array.isArray(action)
            || item.rulesRevision !== undefined && item.rulesRevision !== 0 && item.rulesRevision !== RULES_REVISION
            || !['card', 'button', 'perCard', 'stateful'].includes(action.type)
            || action.cardId !== undefined && (typeof action.cardId !== 'string' || !/^swucard_[a-f0-9]{24}$/.test(action.cardId))
            || action.arg !== undefined && (typeof action.arg !== 'string' || action.arg.length > 1000)) {
            throw sessionError('Nevažeća spremljena partija. Pokreni novu partiju.');
        }
    }
    return record;
}

async function createRecord({ playerDeck, botDeck, difficulty = 'normal', seed = randomUUID() }) {
    // Fail before starting an expensive game if production encryption is absent.
    encryptionKey();
    const createdAt = Date.now();
    const record = {
        format: FORMAT, engineVersion: ENGINE_VERSION, id: randomUUID(),
        deckId: playerDeck.id, opponentDeckId: botDeck.id, difficulty, seed: String(seed),
        createdAt, expiresAt: createdAt + SESSION_TTL,
        actions: [], memory: {}, botHistory: [], warning: null,
        ...(playerDeck.custom ? { playerDeck: compactRecipe(playerDeck) } : {}),
        ...(botDeck.custom ? { opponentDeck: compactRecipe(botDeck) } : {}),
    };
    validateRecord(record);
    const game = await createGame({ id: record.id, playerDeck, botDeck, difficulty, seed: record.seed });
    return { record, game };
}

function applyAction(record, game, action, playerId = 'human') {
    if (record.actions.length >= MAX_ACTIONS) throw sessionError('Partija je dosegla ograničenje spremljenih odluka.', 'SESSION_LIMIT', 413);
    // Only inputs that actually affect the engine belong in a replay. Discard
    // UI labels, old prompt UUIDs, abilities and bot evaluation annotations.
    const saved = { type: action.type };
    if (action.cardId !== undefined) saved.cardId = action.cardId;
    if (action.arg !== undefined) saved.arg = String(action.arg);
    if (action.result !== undefined) saved.result = structuredClone(action.result);
    const view = game.submit(action, playerId);
    // Revision belongs to each saved action, not the record: a resumed game
    // retains its historical prefix while all new decisions use current rules.
    record.actions.push({ playerId, action: saved, rulesRevision: RULES_REVISION });
    return view;
}

function sealRecord(record) {
    validateRecord(record);
    const plaintext = Buffer.from(JSON.stringify(record));
    if (plaintext.length > MAX_RECORD_BYTES) throw sessionError('Partija je prevelika za spremanje.', 'SESSION_LIMIT', 413);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
    cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([cipher.update(deflateRawSync(plaintext)), cipher.final()]);
    const token = `swu1.${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url')}`;
    if (token.length > MAX_TOKEN_BYTES) throw sessionError('Partija je prevelika za spremanje.', 'SESSION_LIMIT', 413);
    return token;
}

// Expiration relaxation is confined to this private decoder. HTTP callers of
// decodeRecord and restoreRecord cannot opt into account checkpoint renewal.
function decodeEnvelope(token, { id, allowExpired = false } = {}) {
    if (typeof token !== 'string' || token.length > MAX_TOKEN_BYTES || !/^swu1\.[A-Za-z0-9_-]{40,}$/.test(token)) {
        throw sessionError('Nevažeća spremljena partija. Pokreni novu partiju.');
    }
    const key = encryptionKey();
    let record;
    try {
        const payload = Buffer.from(token.slice(5), 'base64url');
        const decipher = createDecipheriv('aes-256-gcm', key, payload.subarray(0, 12));
        decipher.setAAD(AAD);
        decipher.setAuthTag(payload.subarray(12, 28));
        const compressed = Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]);
        const plaintext = inflateRawSync(compressed, { maxOutputLength: MAX_RECORD_BYTES });
        record = JSON.parse(plaintext.toString('utf8'));
    } catch {
        throw sessionError('Nevažeća spremljena partija. Pokreni novu partiju.');
    }
    return validateRecord(record, id, { allowExpired });
}

function decodeRecord(token, { id } = {}) { return decodeEnvelope(token, { id }); }

async function replayRecord(record, decks) {
    const playerDeck = record.playerDeck || decks?.find((deck) => deck.id === record.deckId);
    const botDeck = record.opponentDeck || decks?.find((deck) => deck.id === record.opponentDeckId);
    if (!playerDeck || !botDeck) throw sessionError('Špil spremljene partije više nije dostupan.', 'SESSION_EXPIRED', 410);
    const game = await createGame({ id: record.id, playerDeck, botDeck, difficulty: record.difficulty, seed: record.seed });
    try {
        for (const { playerId, action, rulesRevision = 0 } of record.actions) {
            const current = game.view(playerId);
            game.submit({ ...action, promptId: current.prompt.id, version: current.version }, playerId, { rulesRevision });
        }
    } catch (error) {
        game.close();
        // Avoid reflecting private action details from engine errors to clients.
        const failure = sessionError('Spremljena partija ne odgovara trenutačnim pravilima.', 'SESSION_RESTORE_FAILED', 409);
        failure.cause = error;
        throw failure;
    }
    return { record, game };
}

async function restoreRecord(token, { decks, id } = {}) {
    return replayRecord(decodeRecord(token, { id }), decks);
}

function requireAccountOwner(ownerId) {
    if (typeof ownerId !== 'string' || !ACCOUNT_OWNER.test(ownerId)) {
        throw sessionError('Sign in to resume your cloud save.', 'ACCOUNT_REQUIRED', 401);
    }
}

function requireMatchingOwner(record, ownerId) {
    if (record.accountOwnerId !== ownerId) {
        throw sessionError('This cloud save belongs to a different account.', 'ACCOUNT_CHECKPOINT_OWNER', 403);
    }
}

/** Called only with an identity resolved by the server's account auth layer. */
function bindAccountCheckpoint(token, { id, ownerId } = {}) {
    requireAccountOwner(ownerId);
    const record = decodeRecord(token, { id });
    if (record.accountOwnerId !== undefined) requireMatchingOwner(record, ownerId);
    record.accountOwnerId = ownerId;
    record.originalCreatedAt ??= record.createdAt;
    return { gameId: record.id, sessionToken: sealRecord(record), deckId: record.deckId,
        opponentDeckId: record.opponentDeckId, difficulty: record.difficulty,
        createdAt: record.createdAt, expiresAt: record.expiresAt,
        actionCount: record.actions.length, version: record.actions.length };
}

/** Only account storage may select this path; a browser token cannot claim an owner. */
async function restoreAccountRecord(token, { decks, id, ownerId } = {}) {
    requireAccountOwner(ownerId);
    const record = decodeEnvelope(token, { id, allowExpired: true });
    requireMatchingOwner(record, ownerId);
    if (record.expiresAt <= Date.now() - ACCOUNT_RETENTION) {
        throw sessionError('This cloud save has expired after 30 days without a renewed checkpoint.', 'ACCOUNT_CHECKPOINT_EXPIRED', 410);
    }
    const restored = await replayRecord(record, decks);
    // Renew only after the same native board was reconstructed successfully.
    // Historical inputs, shuffle, bot memory and lesson/review state stay exact.
    record.originalCreatedAt ??= record.createdAt;
    record.createdAt = Date.now();
    record.expiresAt = record.createdAt + SESSION_TTL;
    return restored;
}

module.exports = {
    createRecord, applyAction, sealRecord, decodeRecord, restoreRecord, bindAccountCheckpoint, restoreAccountRecord,
    SESSION_TTL, ACCOUNT_RETENTION, MAX_ACTIONS, MAX_TOKEN_BYTES, MAX_RECORD_BYTES, ENGINE_VERSION,
};
