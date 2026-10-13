'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createRecord, applyAction, sealRecord, restoreRecord } = require('../server/replay.cjs');
const { chooseAction } = require('../server/bot.cjs');
const { captureReviewDecision, commitReviewDecision, publicReview, MAX_MOMENTS } = require('../server/match-review.cjs');
const { readDecks } = require('../scripts/smoke.cjs');

const decks = readDecks();
const playerDeck = decks.find(deck => deck.id === 'sor-luke-skywalker');
const botDeck = decks.find(deck => deck.id === 'sor-darth-vader');
const seats = ['human', 'bot'];

async function play(seed, beforeChoice) {
    const session = await createRecord({ playerDeck, botDeck, seed, difficulty: 'normal' });
    const memories = { human: {}, bot: {} };
    try {
        for (let step = 0; step < 1500; step++) {
            const view = seats.map(seat => session.game.view(seat)).find(view => view.prompt.active);
            if (!view) return session;
            const result = beforeChoice?.(session, view, step);
            if (result === 'stop') return session;
            const action = result || chooseAction(view, { difficulty: 'normal', memory: memories[view.viewerId] }).action;
            assert.ok(action, 'The fixture chooses a native legal action.');
            const capture = captureReviewDecision(session.record, session.game, action, view.viewerId);
            applyAction(session.record, session.game, action, view.viewerId);
            commitReviewDecision(session.record, capture, session.game);
        }
        assert.fail('The deterministic native game must finish within its decision budget.');
    } catch (error) { session.game.close(); throw error; }
}

test('native attack alternatives are recorded only after a successful human choice and stay hidden until the game ends', { timeout: 30_000 }, async () => {
    let found;
    const session = await play(123, ({ record, game }, view) => {
        if (view.viewerId !== 'human') return;
        for (const action of view.legalActions) {
            const capture = captureReviewDecision(record, game, action);
            if (capture?.moments.some(moment => moment.kind === 'base-option')) {
                found = { action, capture, view };
                return 'stop';
            }
        }
    });
    try {
        assert.ok(found, 'A real Luke versus Vader game reaches a legal base-or-unit attack choice.');
        const { action, capture, view } = found;
        const before = JSON.stringify(session.record.review);
        const base = view.players.bot.base;
        const attacker = [...view.players.human.ground, ...view.players.human.space].find(card => card.uuid === view.prompt.attackerId);
        const lesson = capture.moments.find(moment => moment.kind === 'base-option');
        assert.ok(view.legalActions.some(candidate => candidate.cardId === base.uuid), 'The alternative base target comes from native legality.');
        assert.equal(lesson.health, base.remainingHp);
        assert.equal(lesson.power, attacker.attackPower);
        assert.ok(lesson.power >= lesson.health);
        assert.equal(lesson.target, action.label);
        commitReviewDecision(session.record, capture, session.game);
        assert.equal(JSON.stringify(session.record.review), before, 'Opening a choice cannot count or create a review moment.');
        assert.throws(() => applyAction(session.record, session.game, { type: 'button', arg: 'illegal-review-action', promptId: view.prompt.id }));
        commitReviewDecision(session.record, capture, session.game);
        assert.equal(JSON.stringify(session.record.review), before, 'An invalid action cannot enter the review.');
        applyAction(session.record, session.game, action);
        commitReviewDecision(session.record, capture, session.game);
        assert.ok(session.record.review.moments.some(moment => moment.kind === 'base-option'));
        const once = JSON.stringify(session.record.review);
        commitReviewDecision(session.record, capture, session.game);
        assert.equal(JSON.stringify(session.record.review), once, 'Committing the same successful choice twice cannot double-count it.');
        assert.equal(publicReview(session.record, session.game), null, 'Suggestions are available after the game, not during it.');
        assert.ok(session.record.review.moments.length <= MAX_MOMENTS);
    } finally { session.game.close(); }
});

test('a completed native game has actual outcome statistics and a deterministic private-checkpoint review', { timeout: 30_000 }, async () => {
    const { record, game } = await play(123);
    let restored;
    try {
        const view = game.view('human');
        const review = publicReview(record, game);
        assert.equal(review.outcome, 'win');
        assert.deepEqual(review.winnerIds, view.winnerIds);
        assert.equal(review.rounds, view.round);
        assert.equal(review.partial, false, 'Initial bot setup before the first human choice does not mark a new game as a partial review.');
        assert.equal(review.stats.decisions, record.actions.filter(item => item.playerId === 'human').length);
        assert.equal(review.stats.plays, view.publicPlayEvents.filter(event => event.playerId === 'human' && event.kind === 'play').length);
        assert.equal(review.stats.deploys, view.publicPlayEvents.filter(event => event.playerId === 'human' && event.kind === 'deploy').length);
        assert.equal(review.stats.baseDamage, view.publicDamageEvents.filter(event => event.playerId === 'human' && event.targetCard.uuid === view.players.bot.base.uuid)
            .reduce((sum, event) => sum + event.amount, 0));
        assert.ok(review.moments.length > 0 && review.moments.length <= 3);
        const final = review.moments.find(moment => moment.kind === 'finishing-blow');
        assert.ok(final, 'The actual winning damage is a key moment.');
        assert.equal(final.health, 0);
        assert.ok(view.publicDamageEvents.some(event => event.sourceCard?.name === final.card && event.amount === final.damage && event.targetCard.uuid === view.players.bot.base.uuid));

        restored = await restoreRecord(sealRecord(record), { decks });
        assert.deepEqual(publicReview(restored.record, restored.game), review, 'Rebuilding on a new worker returns the same review.');
        assert.deepEqual(restored.record.review, record.review, 'The bounded review survives the encrypted checkpoint.');

        record.seed = 'PRIVATE_SEED_SHOULD_NEVER_APPEAR';
        record.review.secret = 'PRIVATE_REVIEW_EXTENSION';
        record.memory.privateHand = ['PRIVATE_BOT_HAND'];
        const json = JSON.stringify(publicReview(record, game));
        for (const value of ['PRIVATE_SEED_SHOULD_NEVER_APPEAR', 'PRIVATE_REVIEW_EXTENSION', 'PRIVATE_BOT_HAND', 'playerDeck', 'opponentDeck', 'sourceCard', 'promptId', 'cardId']) {
            assert.ok(!json.includes(value), `Public review must omit ${value}.`);
        }
        const allowedMomentKeys = new Set(['id', 'kind', 'round', 'card', 'target', 'power', 'health', 'damage']);
        for (const moment of review.moments) for (const key of Object.keys(moment)) assert.ok(allowedMomentKeys.has(key), `Unexpected public moment field: ${key}`);
    } finally { restored?.game.close(); game.close(); }
});

test('the opponent finishing damage is factual and old checkpoints are clearly marked as partial reviews', { timeout: 30_000 }, async () => {
    let skipped = false;
    const { record, game } = await play(303, ({ record, game }, view) => {
        if (skipped || view.viewerId !== 'human') return;
        skipped = true;
        const action = chooseAction(view, { difficulty: 'normal', memory: {} }).action;
        applyAction(record, game, action);
        // This mimics one successful choice from an older checkpoint where the
        // review feature was not yet present. Stop this iteration before it can
        // submit the same now-stale choice twice; the helper resumes below.
        return 'stop';
    });
    const memories = { human: {}, bot: {} };
    try {
        assert.equal(record.review, undefined);
        for (let step = 0; step < 1500 && !game.view('human').ended; step++) {
            const view = seats.map(seat => game.view(seat)).find(view => view.prompt.active);
            assert.ok(view);
            const action = chooseAction(view, { difficulty: 'normal', memory: memories[view.viewerId] }).action;
            if (view.viewerId === 'bot') assert.equal(captureReviewDecision(record, game, action, 'bot'), null, 'Private bot choices cannot create human review candidates.');
            const capture = captureReviewDecision(record, game, action, view.viewerId);
            applyAction(record, game, action, view.viewerId);
            commitReviewDecision(record, capture, game);
        }
        const review = publicReview(record, game);
        assert.equal(review.outcome, 'loss');
        assert.equal(review.partial, true);
        const final = review.moments.find(moment => moment.kind === 'opponent-finishing-blow');
        assert.ok(final);
        const event = game.view('human').publicDamageEvents.filter(event => event.playerId === 'bot' && event.targetCard.uuid === game.view('human').players.human.base.uuid).at(-1);
        assert.equal(final.card, event.sourceCard?.name || event.attack?.attacker.name);
        assert.equal(final.damage, event.amount);
        assert.ok(review.stats.decisions < record.actions.filter(item => item.playerId === 'human').length);
    } finally { game.close(); }
});
