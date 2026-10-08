'use strict';

// Adapter only: every game rule and card resolution is delegated to the MIT-licensed
// Forceteki engine. Never expose the Game object across the HTTP or bot boundary.
const path = require('node:path');
const fs = require('node:fs');
const { randomUUID, createHash } = require('node:crypto');
const ROOT = path.resolve(__dirname, '../vendor/forceteki');
const CARD_IMAGES = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../data/card-images.json'), 'utf8'));
const CARD_BACK_IMAGES = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../data/card-back-images.json'), 'utf8'));
const compiled = (name) => require(path.join(ROOT, 'build/server', name));
let runtimePromise;

class ActionError extends Error {
    constructor(message, code = 'ILLEGAL_ACTION') { super(message); this.name = 'ActionError'; this.code = code; this.status = 409; }
}

async function runtime() {
    if (!runtimePromise) runtimePromise = (async () => {
        if (!fs.existsSync(path.join(ROOT, 'build/server/game/core/Game.js'))) {
            throw new Error('Forceteki is not built. Run npm run engine:setup.');
        }
        const { Game } = compiled('game/core/Game.js');
        const { Deck } = compiled('utils/deck/Deck.js');
        const { LocalFolderCardDataGetter } = compiled('utils/cardData/LocalFolderCardDataGetter.js');
        const { getUserWithDefaultsSet } = compiled('Settings.js');
        const getter = await LocalFolderCardDataGetter.createAsync(path.join(ROOT, 'test/json'));
        return { Game, Deck, getter, getUserWithDefaultsSet };
    })();
    return runtimePromise;
}

function setCode(setId) {
    return setId && setId.number != null ? `${String(setId.set).toUpperCase()}_${String(setId.number).padStart(3, '0')}` : null;
}

function catalogCard(data) {
    const code = setCode(data.setId);
    return {
        id: data.id, code, name: data.title, subtitle: data.subtitle || '',
        image: CARD_IMAGES[code] || null,
        backImage: CARD_BACK_IMAGES[code] || null,
        cost: data.cost ?? null, power: data.power ?? null, hp: data.hp ?? null,
        text: data.text || '', deployText: data.deployBox || '', epicAction: data.epicAction || '',
        types: data.types, type: data.types?.join(' '), aspects: data.aspects || [],
        traits: data.traits || [], keywords: data.keywords || [], arena: data.arena,
        unique: !!data.unique, internalName: data.internalName,
    };
}

async function loadCard(code) {
    const { getter } = await runtime();
    const data = await getter.getCardBySetCodeAsync(code);
    return { ...catalogCard(data), code, image: CARD_IMAGES[code] || CARD_IMAGES[setCode(data.setId)] || null,
        backImage: CARD_BACK_IMAGES[code] || CARD_BACK_IMAGES[setCode(data.setId)] || null };
}

// Scoped real timers allow the host to release a session deterministically.
class SessionScheduler {
    tasks = new Set();
    error = null;
    now() { return Date.now(); }
    currentDate() { return new Date(); }
    schedule(callback, ms, repeat) {
        let handle;
        const guarded = () => {
            if (!repeat) this.tasks.delete(handle);
            try { Promise.resolve(callback()).catch((error) => { this.error = error; }); }
            catch (error) { this.error = error; }
        };
        handle = (repeat ? setInterval : setTimeout)(guarded, Math.max(1, ms));
        handle.unref?.();
        this.tasks.add(handle);
        return { cancel: () => { clearTimeout(handle); clearInterval(handle); this.tasks.delete(handle); } };
    }
    setTimeout(callback, ms) { return this.schedule(callback, ms, false); }
    setInterval(callback, ms) { return this.schedule(callback, ms, true); }
    close() { for (const task of this.tasks) { clearTimeout(task); clearInterval(task); } this.tasks.clear(); }
}

function plainMessage(value) {
    if (value == null) return '';
    if (typeof value !== 'object') return String(value);
    if (Array.isArray(value)) return value.map(plainMessage).join('');
    if (value.alert) return plainMessage(value.alert.message);
    return value.name || value.title || plainMessage(value.message);
}

function normalizeDeck(deck) {
    if (!deck || !deck.leader?.id || !deck.base?.id || !Array.isArray(deck.deck)) throw new ActionError('A complete starter deck is required.', 'INVALID_DECK');
    if (deck.deck.some((entry) => !entry.id || !Number.isInteger(entry.count) || entry.count < 1 || entry.count > 3)) throw new ActionError('Invalid card quantities.', 'INVALID_DECK');
    const size = deck.deck.reduce((sum, card) => sum + card.count, 0);
    if (size < 50) throw new ActionError(`Premier decks require at least 50 cards; received ${size}.`, 'INVALID_DECK');
    return { ...deck, metadata: { ...deck.metadata, name: deck.metadata?.name || deck.name }, sideboard: deck.sideboard || [] };
}

async function makeSession({ playerDeck, botDeck, seed = randomUUID(), difficulty = 'tactical', allowUnsupported = false }) {
    const { Game, Deck, getter, getUserWithDefaultsSet } = await runtime();
    const scheduler = new SessionScheduler();
    const id = randomUUID();
    let version = 0;
    let closed = false;
    let engineError = null;
    const router = {
        id,
        handleError(_game, error) { engineError = error; throw error; },
        handleSerializationFailure(_game, error) { engineError = error; throw error; },
        handleGameEnd() {},
        sendGameState() {},
        handleUndoGameEnd() {},
    };
    const game = new Game({
        id, owner: 'human', allowSpectators: false, format: 'premier',
        players: [getUserWithDefaultsSet({ id: 'human', username: 'Player', settings: { optionSettings: { autoSingleTarget: false } } }),
            getUserWithDefaultsSet({ id: 'bot', username: 'AI', settings: { optionSettings: { autoSingleTarget: false } } })],
        cardDataGetter: getter, scheduler, pushUpdate() {}, userTimeoutDisconnect() {},
        useActionTimer: false, undoMode: 'disabled',
    }, { router });
    game.setRandomSeed(String(seed));
    try {
        game.selectDeck('human', new Deck(normalizeDeck(playerDeck), getter));
        game.selectDeck('bot', new Deck(normalizeDeck(botDeck), getter));
        await game.initialiseAsync();
    } catch (error) { scheduler.close(); throw error; }

    const unsupported = [...new Map(game.allCards.filter((card) => !card.isImplemented).map((card) => [card.cardData.id, catalogCard(card.cardData)])).values()];
    if (unsupported.length && !allowUnsupported) {
        scheduler.close();
        throw new ActionError(`Cards are not fully scripted in this engine: ${unsupported.map((card) => card.name).join(', ')}`, 'UNSUPPORTED_CARDS');
    }

    function checkSession(playerId) {
        if (closed) throw new ActionError('This game session is closed.', 'SESSION_CLOSED');
        if (engineError || scheduler.error) throw engineError || scheduler.error;
        if (!['human', 'bot'].includes(playerId)) throw new ActionError('Unknown player.', 'INVALID_PLAYER');
        return game.getPlayerById(playerId);
    }

    function summarizeCard(card, viewer, forceVisible = false, depth = 0) {
        const summary = card.getSummary(viewer, forceVisible);
        if (!summary.id) return { hidden: true, ownerId: summary.ownerId, controllerId: summary.controllerId, zone: summary.zone, exhausted: summary.exhausted };
        const data = card.cardData;
        const deployedLeader = data.types.includes('leader') && (card.deployed === true || summary.type !== 'leader');
        const backImage = CARD_BACK_IMAGES[setCode(data.setId)] || null;
        const result = {
            ...catalogCard(data), ...summary,
            hidden: false, subtitle: card.subtitle || '',
            // Pilot units attached as upgrades have no enabled damage property.
            damage: summary.damage ?? 0,
            exhausted: !!summary.exhausted,
            keywords: card.keywords.map((keyword) => ({ name: keyword.name, value: keyword.value, cost: keyword.cost })),
            traits: [...card.traits], text: data.text || '', deployText: data.deployBox || '', epicAction: data.epicAction || '',
            upgrades: [], captured: [],
        };
        result.frontImage = CARD_IMAGES[setCode(data.setId)] || null;
        result.backImage = backImage;
        result.deployed = deployedLeader;
        result.frontText = data.text || '';
        if (deployedLeader) result.text = data.deployBox || data.text || '';
        if (deployedLeader && backImage) result.image = backImage;
        if (typeof result.hp === 'number') result.remainingHp = result.hp - result.damage;
        if (depth < 2 && card.isUnit?.() && card.isInPlay?.()) {
            result.attacking = card.isAttacking();
            result.attackPower = card.getPower() + (result.attacking ? 0 : card.getNumericKeywordTotal('raid'));
            result.upgrades = (card.upgrades || []).map((upgrade) => summarizeCard(upgrade, viewer, false, depth + 1));
            result.captured = (card.capturedUnits || []).map((unit) => summarizeCard(unit, viewer, false, depth + 1));
        }
        return result;
    }

    function legalActionsFor(viewer, state) {
        const openPrompt = game.getCurrentOpenPrompt();
        if (game.isEnded || !state.promptUuid || !openPrompt?.activeCondition(viewer)) return [];
        const promptId = state.promptUuid;
        const actions = [];
        const selected = new Set(viewer.selectedCards.map((card) => card.uuid));
        const resourceLimit = state.promptType === 'resource' ? openPrompt.nCardsToResource : undefined;
        if (!state.distributeAmongTargets) {
            for (const card of viewer.selectableCards) {
                if (resourceLimit !== undefined && selected.size >= resourceLimit && !selected.has(card.uuid)) continue;
                const abilities = state.promptType === 'actionWindow'
                    ? openPrompt.getCardLegalActions(card, viewer).map((ability, index) => {
                        const context = ability.createContext(viewer);
                        const title = ability.getTitle(context);
                        return { index, title, type: ability.isAttackAction?.() ? 'attack' : /deploy/i.test(title) ? 'deploy' : ability.isPlayCardAbility?.() ? 'play' : 'action', cost: ability.getAdjustedCost?.(context) ?? null };
                    }) : undefined;
                const visible = card.getSummary(viewer).id;
                actions.push({ type: 'card', cardId: card.uuid, promptId, label: visible ? card.title : 'Face-down card', abilities });
            }
        }
        for (const button of state.buttons || []) {
            if (button.disabled || button.command === 'statefulPromptResults') continue;
            actions.push({ type: 'button', arg: String(button.arg), method: button.method || 'menuButton', promptId, label: button.text, sourceCard: button.sourceCard, hasLegalEffects: button.hasLegalEffects });
        }
        for (const display of state.displayCards || []) {
            if (!['selectable', 'selected'].includes(display.selectionState)) continue;
            if (state.perCardButtons?.length) {
                for (const button of state.perCardButtons) {
                    if (!button.disabled) actions.push({ type: 'perCard', cardId: display.cardUuid, arg: String(button.arg), method: 'perCardMenuButton', promptId, label: button.text });
                }
            } else actions.push({ type: 'button', cardId: display.cardUuid, arg: display.cardUuid, method: 'menuButton', promptId, label: display.internalName });
        }
        if (state.selectNumber) {
            for (let number = state.selectNumber.min; number <= state.selectNumber.max; number++) actions.push({ type: 'button', arg: String(number), method: 'menuButton', promptId, label: String(number) });
        }
        for (const option of state.dropdownListOptions || []) actions.push({ type: 'button', arg: option, method: 'menuButton', promptId, label: option });
        if (state.distributeAmongTargets) actions.push({ type: 'stateful', promptId, label: 'Distribute' });
        return actions;
    }

    function view(playerId = 'human') {
        const viewer = checkSession(playerId);
        const state = viewer.promptState.getState();
        const legalActions = legalActionsFor(viewer, state);
        const players = {};
        for (const player of game.getPlayers()) {
            const summarize = (card) => summarizeCard(card, viewer);
            players[player.id] = {
                id: player.id, name: player.name, base: summarize(player.base), leader: summarize(player.getSingleLeader()),
                leaders: player.getAllDeckLeaders().map(summarize),
                hand: player.hand.map(summarize), resources: player.resourceZone.cards.map(summarize),
                // Arena zones also contain attached upgrades. They are already nested under
                // their host; expose only units as combatants on the board and to the bot.
                ground: player.getCardsInZone('groundArena').filter((card) => card.isUnit()).map(summarize),
                space: player.getCardsInZone('spaceArena').filter((card) => card.isUnit()).map(summarize),
                discard: player.discardZone.cards.map(summarize), outsideTheGame: player.getCardsInZone('outsideTheGame').map(summarize),
                handCount: player.hand.length, deckCount: player.drawDeck.length,
                resourceCount: player.resourceZone.cards.length, readyResources: player.readyResourceCount,
                hasInitiative: game.initiativePlayer === player, active: game.actionPhaseActivePlayer === player,
                passed: player.passedActionPhase, force: player.hasTheForce,
                forceToken: { active: player.hasTheForce, uuid: player.baseZone.forceToken?.uuid,
                    selectable: player.baseZone.forceToken ? viewer.selectableCards.includes(player.baseZone.forceToken) : false },
                credits: player.baseZone.credits.map(summarize),
            };
        }
        const displayCards = (state.displayCards || []).map((display) => {
            const card = game.findAnyCardInAnyList(display.cardUuid);
            return { ...(card ? summarizeCard(card, viewer, true) : {}), ...display, uuid: display.cardUuid };
        });
        const legalIds = new Set(legalActions.filter((action) => action.type === 'card').map((action) => action.cardId));
        const prompt = {
            id: state.promptUuid, title: state.menuTitle, subtitle: state.promptTitle, type: state.promptType || 'select',
            selectMode: state.selectCardMode, selectOrder: state.selectOrder,
            selectedCardIds: viewer.selectedCards.map((card) => card.uuid),
            selectableCardIds: state.distributeAmongTargets ? viewer.selectableCards.map((card) => card.uuid) : [...legalIds],
            buttons: state.buttons.map(({ text, arg, command, disabled, method }) => ({ text, arg: String(arg), command, disabled, method })), displayCards,
            perCardButtons: state.perCardButtons.map(({ text, arg, command, disabled, method }) => ({ text, arg: String(arg), command, disabled, method })),
            number: state.selectNumber || null, dropdown: state.dropdownListOptions || [],
            distribution: state.distributeAmongTargets || null,
            attackerId: viewer.promptState.attackTargetingHighlightAttacker?.uuid || null,
            active: legalActions.length > 0,
        };
        return JSON.parse(JSON.stringify({
            id, version, difficulty, phase: game.currentPhase, round: game.roundNumber,
            initiativePlayerId: game.initiativePlayer?.id || null, initiativeClaimed: game.isInitiativeClaimed,
            winnerIds: game.getPlayers().filter((player) => game.winnerNames.includes(player.name)).map((player) => player.id),
            ended: game.isEnded, viewerId: playerId, players, prompt, legalActions,
            log: game.gameChat.messages.map((entry, index) => ({ id: index, at: entry.date, text: plainMessage(entry.message) })),
        }));
    }

    function validateDistribution(action, player, state) {
        const spec = state.distributeAmongTargets;
        const result = action.result;
        if (!spec || !result || result.type !== spec.type || !Array.isArray(result.valueDistribution)) throw new ActionError('Invalid distribution result.');
        const targets = new Map(player.selectableCards.map((card) => [card.uuid, card]));
        const seen = new Set();
        let sum = 0;
        let count = 0;
        for (const target of result.valueDistribution) {
            if (!targets.has(target.uuid) || seen.has(target.uuid) || !Number.isSafeInteger(target.amount) || target.amount < 0) throw new ActionError('Distribution targets and amounts must be legal, unique, nonnegative integers.');
            seen.add(target.uuid); sum += target.amount;
            if (target.amount > 0) count++;
            const card = targets.get(target.uuid);
            if (spec.isIndirectDamage && card.isUnit() && target.amount > card.remainingHp) throw new ActionError('Indirect damage cannot exceed a unit’s remaining HP.');
        }
        if (sum === 0 ? !spec.canChooseNoTargets : spec.canDistributeLess ? sum > spec.amount : sum !== spec.amount) throw new ActionError('The distributed total is not allowed by this ability.');
        if (spec.maxTargets && count > spec.maxTargets) throw new ActionError('Too many targets selected.');
    }

    function submit(action, playerId = 'human') {
        const player = checkSession(playerId);
        if (!action || typeof action !== 'object') throw new ActionError('An action is required.');
        if (game.isEnded) throw new ActionError('This game has ended.', 'GAME_ENDED');
        const state = player.promptState.getState();
        if (!action.promptId || action.promptId !== state.promptUuid) throw new ActionError('The prompt changed; refresh the game state.', 'STALE_PROMPT');
        if (action.version !== undefined && action.version !== version) throw new ActionError('The game state changed; refresh the game state.', 'STALE_STATE');
        const actions = legalActionsFor(player, state);
        const match = actions.find((candidate) => candidate.type === action.type &&
            (candidate.type !== 'card' && candidate.type !== 'perCard' || candidate.cardId === action.cardId) &&
            (candidate.type !== 'button' && candidate.type !== 'perCard' || candidate.arg === String(action.arg)));
        if (!match) throw new ActionError('This action is not legal for the current prompt.');
        if (action.type === 'stateful') validateDistribution(action, player, state);
        switch (action.type) {
            case 'card': game.cardClicked(playerId, action.cardId); break;
            case 'button': {
                // HandlerMenuPrompt uses numeric indices; dropdown/number prompts use strings.
                // Preserve the engine's typed value after comparing the public string token.
                const native = state.buttons.find((button) => String(button.arg) === match.arg);
                game.menuButton(playerId, native ? native.arg : match.arg, action.promptId, match.method);
                break;
            }
            case 'perCard': game.perCardMenuButton(playerId, match.arg, match.cardId, action.promptId, 'perCardMenuButton'); break;
            case 'stateful': game.statefulPromptResults(playerId, {
                type: action.result.type,
                valueDistribution: action.result.valueDistribution.filter((target) => target.amount > 0),
            }, action.promptId); break;
            default: throw new ActionError('Unknown action type.');
        }
        game.continue();
        version++;
        return view(playerId);
    }

    return {
        id, view, submit, botView: () => view('bot'), unsupported,
        close() { closed = true; scheduler.close(); game.getPlayers().forEach((player) => player.actionTimer.stop()); game.removeAllListeners(); },
    };
}

async function createGame(options) { return makeSession(options); }

const statusCache = new Map();
async function listDeckStatus(decks) {
    const result = [];
    for (const deck of decks) {
        const key = createHash('sha256').update(JSON.stringify(deck)).digest('hex');
        if (!statusCache.has(key)) {
            let session;
            try {
                session = await makeSession({ playerDeck: deck, botDeck: deck, seed: 'coverage-audit', allowUnsupported: true });
                const leaderCard = await loadCard(deck.leader.id);
                const baseCard = await loadCard(deck.base.id);
                const cards = await Promise.all(deck.deck.map(async (entry) => ({ count: entry.count, card: await loadCard(entry.id) })));
                statusCache.set(key, {
                    ...deck, playable: session.unsupported.length === 0, supported: session.unsupported.length === 0,
                    unsupportedCards: session.unsupported,
                    coverage: { total: deck.deck.length + 2, implemented: deck.deck.length + 2 - session.unsupported.length, missing: session.unsupported.map((card) => card.name) },
                    cardCount: deck.deck.reduce((sum, entry) => sum + entry.count, 0),
                    leaderRef: deck.leader, baseRef: deck.base, leader: leaderCard, base: baseCard,
                    leaderCard, baseCard, cards,
                });
            } catch (error) {
                statusCache.set(key, { ...deck, playable: false, supported: false, error: error.message, unsupportedCards: [] });
            } finally { session?.close(); }
        }
        result.push(statusCache.get(key));
    }
    return result;
}

module.exports = { createGame, listDeckStatus, loadCard, ActionError, ENGINE_ROOT: ROOT };
