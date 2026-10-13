'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { randomBytes, createHash, createCipheriv } = require('node:crypto');
const { deflateRawSync } = require('node:zlib');
process.env.SWU_SESSION_SECRET ||= randomBytes(32).toString('hex');
const { createRecord, applyAction, sealRecord, decodeRecord, restoreRecord, bindAccountCheckpoint, restoreAccountRecord,
    SESSION_TTL, ACCOUNT_RETENTION } = require('../server/replay.cjs');
const { chooseAction } = require('../server/bot.cjs');
const { captureReviewDecision, commitReviewDecision } = require('../server/match-review.cjs');
const { createTraining, trainingView } = require('../server/training.cjs');
const { readDecks } = require('../scripts/smoke.cjs');

const decks = readDecks();
const owner = `google_${'a'.repeat(64)}`;
const other = `supabase_12345678-1234-1234-1234-123456789abc`;
const sessions = ['human', 'bot'];
const create = () => createRecord({ playerDeck: decks[0], botDeck: decks[1], seed: 123, difficulty: 'normal' });

// Test a cryptographically authentic but invalid schema at the decode boundary,
// rather than merely checking that the normal server refuses to seal bad input.
function signedFixture(record) {
    const key = createHash('sha256').update(process.env.SWU_SESSION_SECRET).digest();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from('sw-unlimited:private-session:v1'));
    const encrypted = Buffer.concat([cipher.update(deflateRawSync(Buffer.from(JSON.stringify(record)))), cipher.final()]);
    return `swu1.${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url')}`;
}

async function progress(record, game, count = 40) {
    const memory = { human: {}, bot: {} };
    for (let step = 0; step < count; step++) {
        const view = sessions.map(seat => game.view(seat)).find(view => view.prompt.active);
        assert.ok(view, 'The native fixture is still playing.');
        const action = chooseAction(view, { difficulty: 'normal', memory: memory[view.viewerId] }).action;
        const capture = captureReviewDecision(record, game, action, view.viewerId);
        applyAction(record, game, action, view.viewerId);
        commitReviewDecision(record, capture, game);
    }
}

test('binding an active native checkpoint derives canonical metadata and isolates its signed account owner', async () => {
    const { record, game } = await create();
    let restored;
    try {
        await progress(record, game, 16);
        const guest = sealRecord(record);
        const bound = bindAccountCheckpoint(guest, { id: record.id, ownerId: owner });
        assert.deepEqual(Object.keys(bound).sort(), ['gameId', 'sessionToken', 'deckId', 'opponentDeckId', 'difficulty', 'createdAt', 'expiresAt', 'actionCount', 'version'].sort());
        assert.equal(bound.gameId, record.id);
        assert.equal(bound.deckId, record.deckId);
        assert.equal(bound.opponentDeckId, record.opponentDeckId);
        assert.equal(bound.version, game.view('human').version);
        assert.equal(bound.actionCount, record.actions.length);
        const decoded = decodeRecord(bound.sessionToken);
        assert.equal(decoded.accountOwnerId, owner);
        assert.equal(decoded.originalCreatedAt, record.createdAt);
        assert.deepEqual(decoded.actions, record.actions);
        assert.throws(() => bindAccountCheckpoint(bound.sessionToken, { ownerId: other }), error => error.code === 'ACCOUNT_CHECKPOINT_OWNER');
        assert.throws(() => bindAccountCheckpoint(guest, { ownerId: 'human' }), error => error.code === 'ACCOUNT_REQUIRED');
        assert.throws(() => bindAccountCheckpoint(guest, { ownerId: owner, id: '00000000-0000-0000-0000-000000000000' }));
        const rebound = bindAccountCheckpoint(bound.sessionToken, { ownerId: owner });
        assert.deepEqual(decodeRecord(rebound.sessionToken), decoded, 'Binding to the same verified account preserves native state.');

        restored = await restoreRecord(guest, { decks });
        assert.equal(restored.record.accountOwnerId, undefined, 'Legacy guest records keep their existing behavior.');
        assert.deepEqual(restored.game.canonicalView('human'), game.canonicalView('human'));
    } finally { restored?.game.close(); game.close(); }
});

test('an expired account checkpoint renews the same native board while guest and browser expiry overrides stay rejected', { timeout: 30_000 }, async () => {
    const { record, game } = await create();
    const originalNow = Date.now;
    let restored; let renewedAgain;
    try {
        await progress(record, game);
        const before = sessions.map(seat => game.canonicalView(seat));
        const originalCreatedAt = record.createdAt;
        const guest = sealRecord(record);
        const bound = bindAccountCheckpoint(guest, { ownerId: owner });
        const later = record.expiresAt + 24 * 60 * 60 * 1000;
        Date.now = () => later;
        assert.throws(() => decodeRecord(guest, { allowExpired: true }), error => error.code === 'SESSION_EXPIRED');
        assert.throws(() => decodeRecord(bound.sessionToken), error => error.code === 'SESSION_EXPIRED');
        await assert.rejects(() => restoreRecord(guest, { decks, allowExpired: true, ownerId: owner }), error => error.code === 'SESSION_EXPIRED');
        assert.throws(() => bindAccountCheckpoint(bound.sessionToken, { ownerId: owner }), error => error.code === 'SESSION_EXPIRED');
        await assert.rejects(() => restoreAccountRecord(guest, { decks, ownerId: owner }), error => error.code === 'ACCOUNT_CHECKPOINT_OWNER');
        await assert.rejects(() => restoreAccountRecord(bound.sessionToken, { decks, ownerId: other }), error => error.code === 'ACCOUNT_CHECKPOINT_OWNER');
        restored = await restoreAccountRecord(bound.sessionToken, { decks, id: record.id, ownerId: owner });
        assert.deepEqual(sessions.map(seat => restored.game.canonicalView(seat)), before);
        assert.equal(restored.record.createdAt, later);
        assert.equal(restored.record.expiresAt, later + SESSION_TTL);
        assert.equal(restored.record.originalCreatedAt, originalCreatedAt);
        for (const key of ['actions', 'seed', 'deckId', 'opponentDeckId', 'difficulty', 'review', 'memory']) assert.deepEqual(restored.record[key], record[key]);
        assert.equal(restored.record.accountOwnerId, owner);
        const renewed = sealRecord(restored.record);
        assert.equal(decodeRecord(renewed).expiresAt, later + SESSION_TTL, 'The ordinary game endpoint accepts the newly renewed six-hour token.');
        Date.now = () => later + 2 * 24 * 60 * 60 * 1000;
        renewedAgain = await restoreAccountRecord(renewed, { decks, ownerId: owner });
        assert.equal(renewedAgain.record.originalCreatedAt, originalCreatedAt, 'Repeated renewal never rewrites the original game date.');
        assert.deepEqual(renewedAgain.record.actions, record.actions);
        assert.deepEqual(renewedAgain.game.canonicalView('human'), before[0]);
    } finally { Date.now = originalNow; renewedAgain?.game.close(); restored?.game.close(); game.close(); }
});

test('signed thirty-day retention cannot be extended by a caller or by malformed expiration metadata', async () => {
    const { record, game } = await create();
    const originalNow = Date.now;
    let restored;
    try {
        const bound = bindAccountCheckpoint(sealRecord(record), { ownerId: owner });
        Date.now = () => record.expiresAt + ACCOUNT_RETENTION;
        await assert.rejects(() => restoreAccountRecord(bound.sessionToken, { decks, ownerId: owner, expiresAt: Date.now() + SESSION_TTL }), error => error.code === 'ACCOUNT_CHECKPOINT_EXPIRED');
        Date.now = () => record.expiresAt + ACCOUNT_RETENTION - 1;
        restored = await restoreAccountRecord(bound.sessionToken, { decks, ownerId: owner });
        assert.equal(restored.record.expiresAt, Date.now() + SESSION_TTL);
        const signed = { ...record, accountOwnerId: owner, expiresAt: record.createdAt + SESSION_TTL + 1 };
        await assert.rejects(() => restoreAccountRecord(signedFixture(signed), { decks, ownerId: owner }), error => error.code === 'INVALID_SESSION');
        signed.expiresAt = record.expiresAt;
        signed.originalCreatedAt = record.createdAt + 1;
        await assert.rejects(() => restoreAccountRecord(signedFixture(signed), { decks, ownerId: owner }), error => error.code === 'INVALID_SESSION');
        const offset = Math.floor(bound.sessionToken.length / 2);
        const tampered = bound.sessionToken.slice(0, offset) + (bound.sessionToken[offset] === 'A' ? 'B' : 'A') + bound.sessionToken.slice(offset + 1);
        await assert.rejects(() => restoreAccountRecord(tampered, { decks, ownerId: owner }), error => error.code === 'INVALID_SESSION');
    } finally { Date.now = originalNow; restored?.game.close(); game.close(); }
});

test('all native training lessons retain their exact position and metadata after account renewal', { timeout: 30_000 }, async () => {
    const originalNow = Date.now;
    try {
        for (const lessonId of ['resources', 'space-ambush', 'leader-deploy']) {
            const { record, game } = await createTraining(lessonId, { decks });
            let restored;
            try {
                const before = trainingView(record, game);
                const token = bindAccountCheckpoint(sealRecord(record), { ownerId: other }).sessionToken;
                const later = record.expiresAt + 1000;
                Date.now = () => later;
                restored = await restoreAccountRecord(token, { decks, ownerId: other });
                assert.deepEqual(restored.record.training, record.training);
                assert.deepEqual(trainingView(restored.record, restored.game), before);
                assert.deepEqual(restored.game.canonicalView('human'), game.canonicalView('human'));
            } finally { Date.now = originalNow; restored?.game.close(); game.close(); }
        }
    } finally { Date.now = originalNow; }
});

test('malformed lesson metadata is rejected even inside an authenticated account envelope', async () => {
    const { record, game } = await create();
    try {
        const sourceId = 'swucard_' + 'a'.repeat(24);
        const targetId = 'swucard_' + 'b'.repeat(24);
        const bad = [
            null,
            { lessonId: 'unknown', setupActions: 0 },
            { lessonId: 'resources', setupActions: 1 },
            { lessonId: 'resources', setupActions: 0, sourceId },
            { lessonId: 'resources', setupActions: 0, ownerId: owner },
            { lessonId: 'space-ambush', setupActions: 0, sourceId },
            { lessonId: 'space-ambush', setupActions: 0, sourceId: 'private-card-id', targetId },
            { lessonId: 'space-ambush', setupActions: 0, sourceId, targetId: sourceId },
            { lessonId: 'leader-deploy', setupActions: 0, sourceId, targetId },
            { lessonId: 'leader-deploy', setupActions: -1, sourceId },
        ];
        for (const training of bad) {
            const invalid = { ...record, accountOwnerId: owner, training };
            assert.throws(() => sealRecord(invalid), error => error.code === 'INVALID_SESSION');
            const token = signedFixture(invalid);
            assert.throws(() => decodeRecord(token), error => error.code === 'INVALID_SESSION');
            await assert.rejects(() => restoreAccountRecord(token, { decks, ownerId: owner }), error => error.code === 'INVALID_SESSION');
        }
    } finally { game.close(); }
});
