'use strict';

const { createRecord, applyAction } = require('./replay.cjs');

// These short exercises use ordinary starter decks and native engine decisions.
// Fixed, server-owned seeds make the teaching position repeatable; all setup
// decisions remain in the authenticated replay just like a normal solo game.
const trainingCatalog = Object.freeze([
    Object.freeze({ id: 'resources', title: 'Choose your resources',
        summary: 'Choose two starting resources, then confirm your selection.', duration: '1 minute' }),
    Object.freeze({ id: 'space-ambush', title: 'Ambush in space',
        summary: 'Play a Gunship and use Ambush against an enemy space unit.', duration: '2 minutes' }),
    Object.freeze({ id: 'leader-deploy', title: 'Deploy your leader',
        summary: 'Deploy Luke with six total resources, even when all are exhausted.', duration: '1 minute' }),
]);
const lessonIds = new Set(trainingCatalog.map(lesson => lesson.id));
const units = player => [...player.ground, ...player.space];
const signature = action => JSON.stringify([action?.type, action?.cardId || null, action?.arg ?? null]);

function trainingError(message, code = 'TRAINING_ACTION', status = 400) {
    const error = new Error(message);
    error.code = code; error.status = status; error.publicMessage = message;
    return error;
}

function activeView(game) {
    return ['human', 'bot'].map(seat => game.view(seat)).find(view => view.prompt.active);
}

function setupAction(view, { preserveHuman = [], preserveBot = [], targets = [] } = {}) {
    const button = arg => view.legalActions.find(action => action.type === 'button' && action.arg === arg);
    if (view.prompt.stage === 'initiative') {
        return view.legalActions.find(action => action.label === (view.viewerId === 'human' ? 'Yourself' : 'Opponent'));
    }
    if (view.prompt.stage === 'mulligan') return button('keep');
    if (view.prompt.stage === 'resource') {
        const preserve = view.viewerId === 'human' ? preserveHuman : preserveBot;
        if (view.prompt.selectedCardIds.length < view.prompt.resourceSelection.max) {
            const card = view.legalActions.find(action => action.type === 'card'
                && !view.prompt.selectedCardIds.includes(action.cardId) && !preserve.includes(action.label));
            if (card) return card;
        }
        return button('done');
    }
    if (view.prompt.stage === 'action') {
        if (view.viewerId === 'bot') {
            const play = view.legalActions.find(action => action.intent === 'play' && targets.includes(action.label)
                && !units(view.players.bot).some(card => card.name === action.label));
            if (play) return play;
        }
        return button('claimInitiative') || button('pass');
    }
    // Setup decks have no mandatory complex choices on this route. Optional
    // effects may be declined through their actual native command.
    return button('pass') || view.legalActions[0];
}

async function createTraining(lessonId, { decks } = {}) {
    if (!lessonIds.has(lessonId)) throw trainingError('Unknown training lesson.', 'TRAINING_LESSON');
    const playerDeck = decks?.find(deck => deck.id === 'sor-luke-skywalker');
    const botDeck = decks?.find(deck => deck.id === 'sor-darth-vader');
    if (!playerDeck || !botDeck) throw trainingError('Training starter decks are unavailable.', 'TRAINING_UNAVAILABLE', 503);
    const created = await createRecord({ playerDeck, botDeck, seed: 2, difficulty: 'easy' });
    const { record, game } = created;
    const gunship = 'Auzituck Liberator Gunship';
    const defenders = ['TIE/ln Fighter', 'Cell Block Guard'];
    let deploymentPlays = 0;
    try {
        for (let step = 0; step < 260; step++) {
            const view = activeView(game);
            if (!view) throw trainingError('The training position could not be prepared.', 'TRAINING_UNAVAILABLE', 503);
            let action;
            if (view.viewerId === 'human') {
                if (lessonId === 'resources' && view.prompt.stage === 'resource' && view.players.human.resourceCount === 0) {
                    record.training = { lessonId, setupActions: record.actions.length };
                    return created;
                }
                if (lessonId === 'space-ambush' && view.prompt.stage === 'action'
                    && defenders.every(name => units(view.players.bot).some(card => card.name === name))) {
                    const play = view.legalActions.find(action => action.intent === 'play' && action.label === gunship);
                    if (play) {
                        record.training = { lessonId, setupActions: record.actions.length, sourceId: play.cardId,
                            targetId: view.players.bot.space.find(card => card.name === defenders[0]).uuid };
                        return created;
                    }
                }
                if (lessonId === 'leader-deploy' && view.prompt.stage === 'action' && view.players.human.resourceCount === 6) {
                    if (view.players.human.readyResources === 0) {
                        const leader = view.legalActions.find(action => action.intent === 'deploy'
                            && action.cardId === view.players.human.leader.uuid);
                        if (leader) {
                            record.training = { lessonId, setupActions: record.actions.length, sourceId: leader.cardId };
                            return created;
                        }
                    }
                    // Costs four and two respectively. Each is a normal, legal
                    // play and the bot passes between them; no resource state
                    // or exhausted flag is patched for the exercise.
                    action = view.legalActions.find(action => action.intent === 'play'
                        && action.label === ['Consular Security Force', 'Rebel Pathfinder'][deploymentPlays]);
                    if (action) deploymentPlays++;
                }
            }
            action ||= setupAction(view, lessonId === 'space-ambush'
                ? { preserveHuman: [gunship], preserveBot: defenders, targets: defenders }
                : {});
            if (!action) throw trainingError('The training position could not be prepared.', 'TRAINING_UNAVAILABLE', 503);
            // Once spending has begun, a bot pass keeps this action phase open.
            if (lessonId === 'leader-deploy' && deploymentPlays && view.viewerId === 'bot' && view.prompt.stage === 'action') {
                action = view.legalActions.find(action => action.arg === 'pass');
            }
            applyAction(record, game, action, view.viewerId);
        }
        throw trainingError('The training position could not be prepared.', 'TRAINING_UNAVAILABLE', 503);
    } catch (error) { game.close(); throw error; }
}

function trainingView(record, game) {
    const metadata = record.training;
    if (!metadata) return undefined;
    if (!lessonIds.has(metadata.lessonId) || !Number.isSafeInteger(metadata.setupActions)
        || metadata.setupActions < 0 || metadata.setupActions > record.actions.length) {
        throw trainingError('The saved training lesson is invalid.', 'TRAINING_LESSON');
    }
    const view = game.view('human');
    const lesson = trainingCatalog.find(lesson => lesson.id === metadata.lessonId);
    const decisions = record.actions.slice(metadata.setupActions).filter(item => item.playerId === 'human');
    let step = 1; let totalSteps; let instruction; let complete = false; let actions = [];
    if (metadata.lessonId === 'resources') {
        totalSteps = 2;
        complete = view.players.human.resourceCount === 2 && decisions.some(item => item.action.arg === 'done');
        if (complete) {
            step = 2;
            instruction = 'Two cards are now resources. They leave your hand and can pay for plays; they ready again during regroup.';
        } else if (view.prompt.selectedCardIds.length === 2) {
            step = 2;
            instruction = 'Confirm your two selected cards. You can still change your selection before confirming.';
        } else {
            instruction = 'Choose two cards from your hand as resources. Keep some affordable units to play this round.';
        }
        if (!complete && view.prompt.stage === 'resource') {
            actions = view.legalActions.filter(action => action.type === 'card'
                || action.arg === 'done' && view.prompt.selectedCardIds.length === 2);
        }
    } else if (metadata.lessonId === 'space-ambush') {
        totalSteps = 3;
        const source = view.players.human.space.find(card => card.uuid === metadata.sourceId);
        complete = !!source && source.exhausted && view.players.bot.discard.some(card => card.uuid === metadata.targetId)
            && decisions.some(item => item.action.type === 'card' && item.action.cardId === metadata.targetId);
        if (complete) {
            step = 3;
            instruction = 'Ambush defeated the enemy space unit. The Gunship stays exhausted, and the enemy base was not attacked.';
        } else if (view.prompt.attackerId === metadata.sourceId) {
            step = 3;
            instruction = 'Choose the enemy TIE/ln Fighter. This Ambush can attack an enemy unit in space, not a ground unit or the base.';
            actions = view.legalActions.filter(action => action.type === 'card' && action.cardId === metadata.targetId);
        } else if (view.prompt.ability?.label === 'Ambush' && view.prompt.ability.sourceCard?.uuid === metadata.sourceId) {
            step = 2;
            instruction = 'Use Ambush. It allows this immediate attack even though the newly played Gunship is exhausted.';
            actions = view.legalActions.filter(action => action.arg === 'trigger');
        } else {
            instruction = 'Play Auzituck Liberator Gunship from your hand. Its Ambush has a legal enemy target in the space arena.';
            actions = view.legalActions.filter(action => action.intent === 'play' && action.cardId === metadata.sourceId);
        }
    } else {
        totalSteps = 1;
        complete = view.players.human.leader.deployed === true && view.players.human.leader.uuid === metadata.sourceId
            && decisions.some(item => item.action.cardId === metadata.sourceId);
        instruction = complete
            ? 'Luke is deployed and your six resources remain exhausted. Deploy checks total resources and does not spend them. The epic deploy action is once per game.'
            : 'Deploy Luke Skywalker. You have six total resources and zero ready resources. Exhausted resources still count toward his deploy requirement.';
        if (!complete) {
            actions = view.legalActions.filter(action => action.type === 'card' && action.cardId === metadata.sourceId && action.intent === 'deploy'
                || action.type === 'button' && /^Deploy Luke Skywalker\b/.test(action.label || ''));
        }
    }
    const nextIndex = trainingCatalog.findIndex(lesson => lesson.id === metadata.lessonId) + 1;
    return {
        lessonId: metadata.lessonId, title: lesson.title, step, totalSteps, instruction,
        status: complete ? 'complete' : 'active',
        allowedActions: actions.map(({ type, cardId, arg }) => ({ type, ...(cardId ? { cardId } : {}), ...(arg !== undefined ? { arg } : {}) })),
        ...(trainingCatalog[nextIndex] ? { nextLessonId: trainingCatalog[nextIndex].id } : {}),
    };
}

function assertTrainingAction(record, game, action) {
    const training = trainingView(record, game);
    if (!training) return;
    if (training.status === 'complete' || !training.allowedActions.some(allowed => signature(allowed) === signature(action))) {
        throw trainingError('Follow the highlighted training action.');
    }
}

function advanceTraining(record, game) {
    if (!record.training) return;
    for (let step = 0; step < 30; step++) {
        if (trainingView(record, game).status === 'complete') return;
        const view = game.view('bot');
        if (!view.prompt.active) return;
        const action = view.prompt.stage === 'action'
            ? view.legalActions.find(action => action.arg === 'pass') : setupAction(view);
        if (!action) throw trainingError('The training opponent could not continue.', 'TRAINING_UNAVAILABLE', 503);
        applyAction(record, game, action, 'bot');
    }
    throw trainingError('The training opponent could not continue.', 'TRAINING_UNAVAILABLE', 503);
}

function trainingGameView(record, game, view = game.view('human')) {
    const training = trainingView(record, game);
    if (!training) return view;
    const allowed = new Set(training.allowedActions.map(signature));
    const legalActions = view.legalActions.filter(action => allowed.has(signature(action)));
    const cards = new Set(legalActions.filter(action => action.type === 'card').map(action => action.cardId));
    const buttons = new Set(legalActions.filter(action => action.type === 'button').map(action => String(action.arg)));
    return { ...view, training, legalActions,
        prompt: { ...view.prompt, selectableCardIds: [...cards],
            buttons: view.prompt.buttons.filter(button => buttons.has(String(button.arg))) } };
}

module.exports = { trainingCatalog, createTraining, trainingView, trainingGameView, assertTrainingAction, advanceTraining };
