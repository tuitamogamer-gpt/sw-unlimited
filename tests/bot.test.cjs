'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseAction, observe } = require('../server/bot.cjs');

function card(uuid, controllerId = 'bot', props = {}) {
    return { uuid, id: uuid, name: uuid, controllerId, ownerId: controllerId, type: 'basicUnit',
        zone: 'groundArena', cost: 3, power: 3, hp: 4, remainingHp: 4, damage: 0,
        exhausted: false, keywords: [], traits: [], upgrades: [], text: '', ...props };
}
function player(id) {
    return { id, base: card(`${id}-base`, id, { type: 'base', hp: 30, remainingHp: 30, zone: 'base', power: 0 }),
        leaders: [], hand: [], resources: [], ground: [], space: [], discard: [],
        handCount: 0, deckCount: 40, resourceCount: 4, readyResources: 4 };
}
function view() {
    return { viewerId: 'bot', players: { bot: player('bot'), human: player('human') }, round: 3, version: 1,
        prompt: { id: 'prompt', title: 'Choose an action', type: 'actionWindow', selectedCardIds: [],
            selectableCardIds: [], displayCards: [], buttons: [], active: true }, legalActions: [] };
}
function action(cardId, type = 'attack') {
    return { type: 'card', cardId, promptId: 'prompt', label: cardId, abilities: [{ title: type, type }] };
}
function button(arg, label = arg) { return { type: 'button', arg, label, promptId: 'prompt', method: 'menuButton' }; }
function decide(v, memory = {}) { return chooseAction(v, { difficulty: 'hard', memory }); }

test('takes available lethal before playing another card', () => {
    const v = view();
    v.players.bot.ground = [card('attacker', 'bot', { power: 4 })];
    v.players.bot.hand = [card('unit', 'bot', { zone: 'hand', cost: 4, power: 7 })];
    v.players.human.base.remainingHp = 4;
    v.legalActions = [action('unit', 'play'), action('attacker'), button('claimInitiative')];
    const decision = decide(v);
    assert.equal(decision.action.cardId, 'attacker');
    assert.equal(decision.memory.plan.targetId, 'human-base');
    assert.match(decision.reason, /Završavam/);
});

test('removes an immediate lethal attacker ahead of base pressure', () => {
    const v = view();
    v.players.bot.base.remainingHp = 3;
    v.players.bot.ground = [card('defender', 'bot', { power: 4, hp: 6, remainingHp: 6 })];
    v.players.human.ground = [card('threat', 'human', { power: 3, remainingHp: 4 })];
    v.prompt = { ...v.prompt, type: 'select', title: 'Choose attack target', attackerId: 'defender' };
    v.legalActions = [action('human-base'), action('threat')];
    assert.equal(decide(v).action.cardId, 'threat');
});

test('sentinel blocks planned base lethal and is removed first', () => {
    const v = view();
    v.players.bot.ground = [card('attacker', 'bot', { power: 5 })];
    v.players.human.base.remainingHp = 3;
    v.players.human.ground = [card('sentinel', 'human', { keywords: [{ name: 'sentinel' }] })];
    v.legalActions = [action('attacker')];
    assert.equal(decide(v).memory.plan.targetId, 'sentinel');
});

test('saboteur can plan lethal through sentinel', () => {
    const v = view();
    v.players.bot.ground = [card('attacker', 'bot', { power: 5, keywords: [{ name: 'saboteur' }] })];
    v.players.human.base.remainingHp = 3;
    v.players.human.ground = [card('sentinel', 'human', { keywords: [{ name: 'sentinel' }] })];
    v.legalActions = [action('attacker')];
    assert.equal(decide(v).memory.plan.targetId, 'human-base');
});

test('mulligans a hand without early units', () => {
    const v = view();
    v.prompt.title = 'Choose whether to mulligan or keep your hand';
    v.players.bot.hand = Array.from({ length: 6 }, (_, i) => card(`hand${i}`, 'bot', { zone: 'hand', cost: 6 }));
    v.legalActions = [button('keep'), button('mulligan')];
    assert.equal(decide(v).action.arg, 'mulligan');
});

test('resources expensive redundancy and preserves an early unit', () => {
    const v = view();
    v.players.bot.resourceCount = 0;
    v.players.bot.hand = [card('cheap', 'bot', { zone: 'hand', cost: 2 }), card('expensive', 'bot', { zone: 'hand', cost: 8 })];
    v.prompt = { ...v.prompt, title: 'Select 2 cards to resource', type: 'resource' };
    v.legalActions = [action('cheap'), action('expensive')];
    assert.equal(decide(v).action.cardId, 'expensive');
});

test('confirms resources without deselecting an already selected card', () => {
    const v = view();
    v.players.bot.hand = [card('chosen', 'bot', { zone: 'hand' })];
    v.prompt = { ...v.prompt, title: 'Select 1 card to resource', type: 'resource', selectedCardIds: ['chosen'] };
    v.legalActions = [action('chosen'), button('done', 'Confirm Resources')];
    assert.equal(decide(v).action.arg, 'done');
});

test('skips late optional resources when preserving a small hand', () => {
    const v = view();
    v.players.bot.resourceCount = 9;
    v.players.bot.hand = [card('valuable', 'bot', { zone: 'hand' })];
    v.prompt = { ...v.prompt, title: 'Select between 0 and 1 cards to resource', type: 'resource' };
    v.legalActions = [action('valuable'), button('done', 'Skip Resourcing')];
    assert.equal(decide(v).action.arg, 'done');
});

test('indirect damage uses only legal targets, respects unit HP and protects lethal base', () => {
    const v = view();
    v.players.bot.base.remainingHp = 2;
    v.players.bot.ground = [card('unit', 'bot', { remainingHp: 3 })];
    v.prompt = { ...v.prompt, type: 'distributeAmongTargets', selectableCardIds: ['bot-base', 'unit'],
        distribution: { type: 'distributeIndirectDamage', amount: 3, isIndirectDamage: true } };
    v.legalActions = [{ type: 'stateful', promptId: 'prompt', label: 'Distribute' }];
    const allocations = decide(v).action.result.valueDistribution;
    assert.equal(allocations.reduce((a, x) => a + x.amount, 0), 3);
    assert.ok(allocations.every((x) => x.uuid === 'bot-base' ? x.amount < 2 : x.uuid === 'unit' && x.amount <= 3));
});

test('damage distribution concentrates lethal on a base and respects maxTargets', () => {
    const v = view();
    v.players.human.base.remainingHp = 3;
    v.players.human.ground = [card('unit', 'human')];
    v.prompt = { ...v.prompt, type: 'distributeAmongTargets', selectableCardIds: ['human-base', 'unit'],
        distribution: { type: 'distributeDamage', amount: 3, maxTargets: 1 } };
    v.legalActions = [{ type: 'stateful', promptId: 'prompt' }];
    assert.deepEqual(decide(v).action.result.valueDistribution, [{ uuid: 'human-base', amount: 3 }]);
});

test('healing fills exact mandatory amount even above damage', () => {
    const v = view();
    v.players.bot.base.damage = 1;
    v.prompt = { ...v.prompt, type: 'distributeAmongTargets', selectableCardIds: ['bot-base'],
        distribution: { type: 'distributeHealing', amount: 3 } };
    v.legalActions = [{ type: 'stateful', promptId: 'prompt' }];
    assert.deepEqual(decide(v).action.result.valueDistribution, [{ uuid: 'bot-base', amount: 3 }]);
});

test('continues useful multiple selection and then confirms without toggling', () => {
    const v = view();
    v.players.bot.ground = [card('first'), card('second')];
    v.prompt = { ...v.prompt, type: 'select', title: 'Give shields to friendly units', selectMode: 'multiple', selectedCardIds: ['first'] };
    v.legalActions = [action('first'), action('second'), button('done')];
    assert.equal(decide(v).action.cardId, 'second');
    v.prompt.selectedCardIds.push('second');
    assert.equal(decide(v).action.arg, 'done');
});

test('handles card display and per-card menu commands with provided IDs', () => {
    const v = view();
    v.prompt = { ...v.prompt, type: 'displayCards', title: 'Choose a card to draw',
        displayCards: [card('reveal', 'bot', { selectionState: 'selectable', cardUuid: 'reveal', zone: 'deck' })] };
    v.legalActions = [{ type: 'perCard', cardId: 'reveal', arg: 'top', label: 'Put on top', promptId: 'prompt' },
        { type: 'perCard', cardId: 'reveal', arg: 'bottom', label: 'Put on bottom', promptId: 'prompt' }];
    assert.equal(decide(v).action.arg, 'top');
});

test('number and dropdown choices are always members of legalActions', () => {
    const v = view();
    v.prompt = { ...v.prompt, type: 'number', number: { min: 1, max: 3 }, title: 'Choose a number' };
    v.legalActions = [button('1'), button('2'), button('3')];
    assert.equal(decide(v).action.arg, '3');
    v.prompt.title = 'Pay resources';
    assert.equal(decide(v).action.arg, '1');
    v.prompt = { ...v.prompt, number: null, dropdown: ['Aggression', 'Cunning'] };
    v.legalActions = [button('Aggression'), button('Cunning')];
    assert.ok(v.legalActions.some((a) => a.arg === decide(v).action.arg));
});

test('never reads opponent hand/resources/deck or own hidden deck', () => {
    const v = view();
    v.players.bot.ground = [card('attacker')];
    v.legalActions = [action('attacker'), button('pass')];
    const forbid = (target, property) => Object.defineProperty(target, property, { get() { throw new Error(`Private ${property} was accessed`); } });
    for (const field of ['hand', 'resources', 'deck', 'drawDeck']) forbid(v.players.human, field);
    for (const field of ['deck', 'drawDeck']) forbid(v.players.bot, field);
    assert.doesNotThrow(() => decide(v));
    const safe = observe(v);
    assert.equal('hand' in safe.enemy, false);
    assert.equal('resources' in safe.enemy, false);
    assert.equal('deck' in safe.me, false);
});

test('different opponent hidden identities and deck order cannot change a decision', () => {
    const v = view();
    v.players.bot.ground = [card('attacker')];
    v.legalActions = [action('attacker'), button('claimInitiative')];
    const before = decide(v);
    v.players.human.hand = [card('secret-removal', 'human', { power: 1000 })];
    v.players.human.deck = [card('secret-top', 'human')];
    v.players.bot.deck = [card('unknown-top', 'bot')];
    const after = decide(v);
    assert.deepEqual(before.action, after.action);
    assert.equal(before.reason, after.reason);
    assert.equal(before.score, after.score);
});

test('works from either player seat and yields when no legal prompt is present', () => {
    const v = view();
    v.viewerId = 'human';
    v.players.human.ground = [card('human-attacker', 'human', { power: 5 })];
    v.players.bot.base.remainingHp = 4;
    v.legalActions = [action('human-attacker')];
    assert.equal(decide(v).memory.plan.targetId, 'bot-base');
    v.legalActions = [];
    assert.equal(decide(v).action, null);
});

test('repeated unchanged menu prompts choose a different legal option instead of looping', () => {
    const v = view();
    v.prompt = { ...v.prompt, type: 'select', title: 'Choose ability', buttons: [] };
    v.legalActions = [button('one', 'Draw'), button('two', 'Gain experience')];
    const memory = {};
    const first = decide(v, memory).action.arg;
    const second = decide(v, memory).action.arg;
    assert.notEqual(first, second);
});

test('avoids repeated no-op abilities across new prompt IDs', () => {
    const v = view();
    v.players.bot.leaders = [card('leader', 'bot', { type: 'leader', zone: 'base' })];
    v.legalActions = [action('leader', 'action'), button('pass')];
    const memory = {};
    assert.equal(decide(v, memory).action.cardId, 'leader');
    v.prompt = { ...v.prompt, id: 'nested', title: 'Choose a unit', type: 'select' };
    v.legalActions = [button('done')];
    decide(v, memory);
    v.prompt = { ...v.prompt, id: 'new-action', title: 'Choose an action', type: 'actionWindow' };
    v.legalActions = [action('leader', 'action'), button('pass')];
    assert.equal(decide(v, memory).action.arg, 'pass');
});

test('does not activate play-from-hand ability when only target is unaffordable', () => {
    const v = view();
    v.players.bot.leaders = [card('jabba', 'bot', { type: 'leader', zone: 'base' })];
    v.players.bot.hand = [card('sarlacc', 'bot', { zone: 'hand', cost: 9, traits: ['underworld'] })];
    const playAbility = action('jabba', 'action');
    playAbility.abilities[0].title = 'Play an {trait:underworld} unit unit from your hand';
    v.legalActions = [playAbility, button('pass')];
    assert.equal(decide(v).action.arg, 'pass');
});

test('infers generic target prompt intent from the public source card', () => {
    const v = view();
    v.players.bot.ground = [card('friendly', 'bot', { cost: 8, power: 8, hp: 8, remainingHp: 8 })];
    v.players.human.ground = [card('enemy', 'human')];
    v.players.bot.discard = [card('event', 'bot', { zone: 'discard', type: 'event', name: 'Open Fire', text: 'Deal 4 damage to a unit.' })];
    v.prompt = { ...v.prompt, type: 'select', title: 'Choose a unit', subtitle: 'Open Fire' };
    v.legalActions = [action('friendly'), action('enemy')];
    assert.equal(decide(v, { plan: { cardId: 'event', ability: { type: 'play', title: 'Play Open Fire' } } }).action.cardId, 'enemy');
});

test('mandatory sacrifice minimizes friendly unit value', () => {
    const v = view();
    v.players.bot.ground = [card('valuable', 'bot', { cost: 8, power: 8, hp: 8, remainingHp: 8 }), card('token', 'bot', { cost: 0, power: 1, hp: 1, remainingHp: 1 })];
    v.prompt = { ...v.prompt, type: 'select', title: 'Defeat a friendly unit' };
    v.legalActions = [action('valuable'), action('token')];
    assert.equal(decide(v).action.cardId, 'token');
});

test('gives Advantage to a friendly unit even after previous attack context', () => {
    const v = view();
    v.players.bot.ground = [card('attacker', 'bot', { text: 'On Attack: Deal 1 damage.' })];
    v.players.human.ground = [card('enemy-sentinel', 'human', { keywords: [{ name: 'sentinel' }] })];
    v.prompt = { ...v.prompt, type: 'select', title: 'Give an Advantage token to a unit', subtitle: 'Regroup Phase' };
    v.legalActions = [action('attacker'), action('enemy-sentinel')];
    const memory = { plan: { cardId: 'attacker', ability: { type: 'attack', title: 'Attack' } } };
    assert.equal(decide(v, memory).action.cardId, 'attacker');
});
