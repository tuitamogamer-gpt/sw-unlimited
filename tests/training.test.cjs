'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createRecord, applyAction, sealRecord, restoreRecord } = require('../server/replay.cjs');
const { trainingCatalog, createTraining, trainingView, trainingGameView, assertTrainingAction, advanceTraining } = require('../server/training.cjs');
const { readDecks, assertPrivateView } = require('../scripts/smoke.cjs');

const decks = readDecks();
const units = player => [...player.ground, ...player.space];

function submit(record, game, allowed) {
    const action = game.view('human').legalActions.find(action => action.type === allowed.type
        && action.cardId === allowed.cardId && action.arg === allowed.arg);
    assert.ok(action, 'Every teaching choice must still be a native legal action.');
    assertTrainingAction(record, game, action);
    applyAction(record, game, action, 'human');
    advanceTraining(record, game);
    return trainingGameView(record, game);
}

async function assertRestores(record, game) {
    const restored = await restoreRecord(sealRecord(record), { decks });
    try {
        assert.deepEqual(restored.record.training, record.training);
        for (const seat of ['human', 'bot']) {
            assert.deepEqual(restored.game.canonicalView(seat), game.canonicalView(seat), 'The teaching board is recreated from recorded legal actions.');
            assertPrivateView(restored.game.view(seat));
        }
        assert.deepEqual(trainingView(restored.record, restored.game), trainingView(record, game));
    } finally { restored.game.close(); }
}

test('training only creates server-owned, allowlisted starter lessons', async () => {
    assert.deepEqual(trainingCatalog.map(lesson => lesson.id), ['resources', 'space-ambush', 'leader-deploy']);
    for (const lessonId of [undefined, 'constructor', '__proto__', 'ranked', { id: 'resources' }]) {
        await assert.rejects(createTraining(lessonId, { decks }), { code: 'TRAINING_LESSON', status: 400 });
    }
    await assert.rejects(createTraining('resources', { decks: [] }), { code: 'TRAINING_UNAVAILABLE', status: 503 });
});

test('resource training requires exactly two actual starting cards, permits changing selections, and restores completion', async () => {
    const { record, game } = await createTraining('resources', { decks });
    try {
        let view = trainingGameView(record, game);
        assert.equal(view.prompt.stage, 'resource');
        assert.equal(view.players.human.resourceCount, 0);
        assert.equal(view.training.step, 1);
        assert.equal(view.prompt.resourceSelection.min, 2);
        assert.ok(!view.prompt.buttons.some(button => button.arg === 'done'));
        const nativeDone = game.view('human').legalActions.find(action => action.arg === 'done');
        // The engine itself may expose a confirmation command before two cards
        // are selected; the exercise must not accept it as lesson completion.
        assert.throws(() => assertTrainingAction(record, game, nativeDone || { type: 'button', arg: 'done' }), { code: 'TRAINING_ACTION' });
        const first = view.training.allowedActions[0];
        view = submit(record, game, first);
        assert.equal(view.prompt.selectedCardIds.length, 1);
        await assertRestores(record, game);
        view = submit(record, game, first);
        assert.equal(view.prompt.selectedCardIds.length, 0, 'The real selection may be undone.');
        view = submit(record, game, first);
        const second = view.training.allowedActions.find(action => action.type === 'card' && action.cardId !== first.cardId);
        view = submit(record, game, second);
        assert.equal(view.training.step, 2);
        assert.equal(view.training.status, 'active');
        assert.ok(view.prompt.buttons.some(button => button.arg === 'done'));
        await assertRestores(record, game);
        view = submit(record, game, view.training.allowedActions.find(action => action.arg === 'done'));
        assert.equal(view.training.status, 'complete');
        assert.equal(view.players.human.resourceCount, 2);
        assert.equal(view.players.human.handCount, 4);
        assert.equal(view.players.human.resources.length, 2);
        assert.deepEqual(view.legalActions, []);
        assert.throws(() => assertTrainingAction(record, game, { type: 'button', arg: 'pass' }), { code: 'TRAINING_ACTION' });
        await assertRestores(record, game);
    } finally { game.close(); }
});

test('space Ambush training guides the actual exhausted attack and rejects skipping or other targets', async () => {
    const { record, game } = await createTraining('space-ambush', { decks });
    try {
        let view = trainingGameView(record, game);
        assert.equal(view.training.step, 1);
        assert.equal(view.training.allowedActions.length, 1);
        assert.ok(view.players.bot.ground.some(card => card.name === 'Cell Block Guard'));
        assert.ok(view.players.bot.space.some(card => card.name === 'TIE/ln Fighter'));
        const pass = game.view('human').legalActions.find(action => action.arg === 'pass');
        assert.ok(pass, 'Passing is a legal ordinary action but not this teaching objective.');
        const before = game.canonicalView('human');
        assert.throws(() => assertTrainingAction(record, game, pass), { code: 'TRAINING_ACTION' });
        assert.deepEqual(game.canonicalView('human'), before);
        await assertRestores(record, game);
        view = submit(record, game, view.training.allowedActions[0]);
        const ship = view.players.human.space.find(card => card.uuid === record.training.sourceId);
        assert.equal(ship.name, 'Auzituck Liberator Gunship');
        assert.equal(ship.exhausted, true);
        assert.equal(view.training.step, 2);
        assert.deepEqual(view.prompt.buttons.map(button => button.arg), ['trigger']);
        assert.throws(() => assertTrainingAction(record, game, { type: 'button', arg: 'pass' }), { code: 'TRAINING_ACTION' });
        await assertRestores(record, game);
        view = submit(record, game, view.training.allowedActions[0]);
        assert.equal(view.training.step, 3);
        assert.equal(view.prompt.attackerId, ship.uuid);
        for (const card of [view.players.bot.base, view.players.bot.ground[0]]) {
            assert.throws(() => assertTrainingAction(record, game, { type: 'card', cardId: card.uuid }), { code: 'TRAINING_ACTION' });
            assert.ok(!game.view('human').legalActions.some(action => action.cardId === card.uuid), 'The native Ambush rules also disallow other arenas and the base.');
        }
        await assertRestores(record, game);
        const resources = view.players.human.readyResources;
        view = submit(record, game, view.training.allowedActions[0]);
        assert.equal(view.training.status, 'complete');
        assert.ok(view.players.bot.discard.some(card => card.uuid === record.training.targetId));
        assert.equal(view.players.human.space.find(card => card.uuid === ship.uuid).exhausted, true);
        assert.equal(view.players.bot.base.damage, 0);
        assert.equal(view.players.human.readyResources, resources, 'Ambush adds no resource payment.');
        assert.deepEqual(view.legalActions, []);
        await assertRestores(record, game);
    } finally { game.close(); }
});

test('leader training reaches six exhausted resources by legal plays and uses the native once-per-game deploy', async () => {
    const { record, game } = await createTraining('leader-deploy', { decks });
    try {
        let view = trainingGameView(record, game);
        assert.equal(view.players.human.resourceCount, 6);
        assert.equal(view.players.human.readyResources, 0);
        assert.equal(view.players.human.leader.deployed, false);
        assert.deepEqual(units(view.players.human).map(card => card.name).sort(), ['Consular Security Force', 'Rebel Pathfinder']);
        const source = record.training.sourceId;
        assert.equal(view.legalActions[0].intent, 'deploy');
        await assertRestores(record, game);
        view = submit(record, game, view.training.allowedActions[0]);
        assert.equal(view.training.status, 'active');
        assert.ok(view.prompt.buttons.length === 1 && /^Deploy Luke Skywalker/.test(view.prompt.buttons[0].text));
        await assertRestores(record, game);
        view = submit(record, game, view.training.allowedActions[0]);
        assert.equal(view.training.status, 'complete');
        assert.equal(view.players.human.leader.deployed, true);
        assert.equal(view.players.human.leader.uuid, source);
        assert.equal(view.players.human.resourceCount, 6);
        assert.equal(view.players.human.readyResources, 0);
        assert.ok(view.players.human.ground.some(card => card.uuid === source));
        assert.equal(game.view('human').legalActions.some(action => action.intent === 'deploy'), false);
        await assertRestores(record, game);
    } finally { game.close(); }
});

test('training helpers leave ordinary game actions and private observations unchanged', async () => {
    const { record, game } = await createRecord({ playerDeck: decks.find(deck => deck.id === 'sor-luke-skywalker'),
        botDeck: decks.find(deck => deck.id === 'sor-darth-vader'), seed: 2, difficulty: 'normal' });
    try {
        const view = game.view('human');
        assert.equal(trainingView(record, game), undefined);
        assert.strictEqual(trainingGameView(record, game, view), view);
        assert.doesNotThrow(() => assertTrainingAction(record, game, { type: 'button', arg: 'unrelated' }));
        const prefix = record.actions.length;
        advanceTraining(record, game);
        assert.equal(record.actions.length, prefix);
        assertPrivateView(view);
    } finally { game.close(); }
});
