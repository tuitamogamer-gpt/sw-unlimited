'use strict';

// Adapter only: every game rule and card resolution is delegated to the MIT-licensed
// Forceteki engine. Never expose the Game object across the HTTP or bot boundary.
const path = require('node:path');
const fs = require('node:fs');
const { randomUUID, createHash } = require('node:crypto');
const ROOT = path.resolve(__dirname, '../vendor/forceteki');
const CARD_IMAGES = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../data/card-images.json'), 'utf8'));
const CARD_BACK_IMAGES = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../data/card-back-images.json'), 'utf8'));
let runtimePromise;

class ActionError extends Error {
    constructor(message, code = 'ILLEGAL_ACTION') { super(message); this.name = 'ActionError'; this.code = code; this.status = 409; }
}

async function runtime() {
    if (!runtimePromise) runtimePromise = (async () => {
        if (!fs.existsSync(path.join(ROOT, 'build/server/game/core/Game.js'))) {
            throw new Error('Forceteki is not built. Run npm run engine:setup.');
        }
        // Literal paths also let the deployment bundler trace engine dependencies.
        const { Game } = require('../vendor/forceteki/build/server/game/core/Game.js');
        const { Deck } = require('../vendor/forceteki/build/server/utils/deck/Deck.js');
        const { LocalFolderCardDataGetter } = require('../vendor/forceteki/build/server/utils/cardData/LocalFolderCardDataGetter.js');
        const { getUserWithDefaultsSet } = require('../vendor/forceteki/build/server/Settings.js');
        const getter = await LocalFolderCardDataGetter.createAsync(path.join(ROOT, 'test/json'));
        // Card definitions are immutable input. Cache the JSON, returning a fresh
        // copy to the engine; replay must not issue hundreds of filesystem reads.
        const cardDefinitions = new Map();
        getter.getCardInternalAsync = async (relativePath) => {
            if (!cardDefinitions.has(relativePath)) {
                cardDefinitions.set(relativePath, JSON.parse(fs.readFileSync(path.join(ROOT, 'test/json', relativePath), 'utf8')));
            }
            return structuredClone(cardDefinitions.get(relativePath));
        };
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

async function makeSession({ playerDeck, botDeck, seed = randomUUID(), difficulty = 'tactical', allowUnsupported = false, id = randomUUID() }) {
    const { Game, Deck, getter, getUserWithDefaultsSet } = await runtime();
    const scheduler = new SessionScheduler();
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

    // Engine object IDs depend on asynchronous deck construction. Keep stable
    // public references based on the ordered physical-card list instead. Tokens
    // receive a new reference the first time an action leaves them in the game;
    // retain removed references so bot memory and logs remain stable too.
    const publicCardIds = new Map();
    const engineCardIds = new Map();
    function refreshCardIds() {
        for (const card of game.allCards) if (!publicCardIds.has(card.uuid)) {
            // The seed is private: an opaque identifier must not reveal the
            // deck-list position (and identity) of a selectable facedown card.
            const opaqueId = createHash('sha256').update(`${seed}:${id}:${publicCardIds.size}`).digest('hex').slice(0, 24);
            const reference = `swucard_${opaqueId}`;
            publicCardIds.set(card.uuid, reference);
            engineCardIds.set(reference, card.uuid);
        }
    }
    function translateIds(value, mapping, outward) {
        if (typeof value === 'string') return value.replace(outward ? /\b[A-Za-z][A-Za-z0-9]*_\d+\b/g : /\bswucard_[a-f0-9]{24}\b/g,
            (reference) => mapping.get(reference) || reference);
        if (Array.isArray(value)) return value.map((item) => translateIds(item, mapping, outward));
        if (!value || typeof value !== 'object') return value;
        return Object.fromEntries(Object.entries(value).map(([key, item]) =>
            [translateIds(key, mapping, outward), translateIds(item, mapping, outward)]));
    }
    refreshCardIds();
    const promptIds = { human: new Map(), bot: new Map() };
    function publicPromptId(playerId) {
        // A prompt must retain its identity while cards are being selected.
        // Refresh both seats in fixed order so observations by either caller
        // produce the same prompt epochs during a subsequent replay.
        for (const player of game.getPlayers()) {
            const uuid = player.promptState.getState().promptUuid;
            if (uuid && !promptIds[player.id].has(uuid)) promptIds[player.id].set(uuid, promptIds[player.id].size);
        }
        const uuid = game.getPlayerById(playerId).promptState.getState().promptUuid;
        return uuid ? `${id}:${playerId}:${promptIds[playerId].get(uuid)}` : null;
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
                const label = visible ? card.title : 'Face-down card';
                const abilityTypes = new Set((abilities || []).map((ability) => ability.type));
                const intent = state.promptType === 'resource' ? 'resource'
                    : abilityTypes.has('play') ? 'play'
                    : abilityTypes.has('attack') ? 'attack'
                    : abilityTypes.has('deploy') ? 'deploy'
                    : abilities?.length ? 'ability' : 'select';
                const verb = { resource: selected.has(card.uuid) ? 'Unselect resource' : 'Resource', play: 'Play',
                    attack: 'Attack with', deploy: 'Deploy', ability: 'Use ability on', select: 'Select' }[intent];
                actions.push({ type: 'card', cardId: card.uuid, promptId, label, abilities, intent, displayLabel: `${verb} ${label}` });
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

    function handPlayability(card, viewer, state, legalActions) {
        const cardAction = legalActions.find((action) => action.type === 'card' && action.cardId === card.uuid);
        const legalPlayTitles = new Set((cardAction?.abilities || []).filter((ability) => ability.type === 'play').map((ability) => ability.title));
        const stageReason = game.isEnded ? 'gameEnded'
            : state.promptType === 'resource' ? 'resourceStep'
            : game.currentPhase !== 'action' ? 'phase'
            : state.promptType !== 'actionWindow' ? 'notYourAction' : null;
        const reasons = {
            gameEnded: 'The game has ended.',
            resourceStep: 'Choose resources now. Cards can be played during the action phase.',
            phase: 'Cards can be played during the action phase.',
            notYourAction: 'Wait for your next action before playing a card.',
            cost: 'You cannot pay this card’s cost with the available resources and payment options.',
            attachTarget: 'There is no legal unit to attach this card to.',
            gameStateChange: 'This card has no legal effect right now.',
            restriction: 'An active card effect prevents this card from being played.',
            cannotTrigger: 'An active card effect prevents this card from being played.',
            otherActionRequired: 'Resolve the current required action first.',
        };
        const playOptions = card.getActions().filter((ability) => ability.isPlayCardAbility?.()).map((ability) => {
            const context = ability.createContext(viewer);
            const title = ability.getTitle(context);
            const cost = ability.getAdjustedCost(context);
            const legal = legalPlayTitles.has(title);
            const requirement = ability.meetsRequirements(context);
            const reasonCode = legal ? null : stageReason || requirement || 'otherActionRequired';
            return { title, cost, legal, reasonCode, reason: legal ? null : reasons[reasonCode] || 'This play option is not available right now.' };
        });
        const legalOptions = playOptions.filter((option) => option.legal);
        const preferred = legalOptions.length ? legalOptions : playOptions;
        const playCost = preferred.length ? Math.min(...preferred.map((option) => option.cost)) : card.cardData.cost ?? null;
        return { playOptions, playCost, playable: legalOptions.length > 0,
            playBlockedReason: legalOptions.length ? null : playOptions[0]?.reason || 'This card cannot be played from your hand right now.' };
    }

    function view(playerId = 'human') {
        const viewer = checkSession(playerId);
        refreshCardIds();
        const state = viewer.promptState.getState();
        const promptId = publicPromptId(playerId);
        const legalActions = legalActionsFor(viewer, state).map((action) => ({ ...action, promptId }));
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
        // Hand affordability is public only to its owner. A card click has a
        // different purpose in setup/regroup than in an action window, so keep
        // the current play options explicit for the human UI.
        players[playerId].hand = players[playerId].hand.map((summary, index) => ({
            ...summary, ...handPlayability(viewer.hand[index], viewer, state, legalActions),
        }));
        const displayCards = (state.displayCards || []).map((display) => {
            const card = game.findAnyCardInAnyList(display.cardUuid);
            return { ...(card ? summarizeCard(card, viewer, true) : {}), ...display, uuid: display.cardUuid };
        });
        const legalIds = new Set(legalActions.filter((action) => action.type === 'card').map((action) => action.cardId));
        const openPrompt = game.getCurrentOpenPrompt();
        const active = legalActions.length > 0;
        const resourceSelection = active && state.promptType === 'resource' ? {
            min: openPrompt.minCardsToResource ?? openPrompt.nCardsToResource,
            max: openPrompt.maxCardsToResource ?? openPrompt.nCardsToResource,
            selected: viewer.selectedCards.length,
            canSkip: (openPrompt.minCardsToResource ?? openPrompt.nCardsToResource) === 0,
        } : null;
        const stage = game.isEnded ? 'finished' : !active ? 'waiting'
            : state.promptType === 'resource' ? 'resource'
            : state.promptType === 'actionWindow' ? 'action'
            : state.promptType === 'initiative' ? 'initiative'
            : /mulligan/i.test(state.menuTitle) ? 'mulligan'
            : viewer.selectableCards.length > 0 ? 'target' : 'choice';
        const prompt = {
            id: promptId, title: state.menuTitle, subtitle: state.promptTitle, type: state.promptType || 'select',
            stage, resourceSelection,
            selectMode: state.selectCardMode, selectOrder: state.selectOrder,
            selectedCardIds: viewer.selectedCards.map((card) => card.uuid),
            selectableCardIds: state.distributeAmongTargets ? viewer.selectableCards.map((card) => card.uuid) : [...legalIds],
            buttons: state.buttons.map(({ text, arg, command, disabled, method }) => ({ text, arg: String(arg), command, disabled, method })), displayCards,
            perCardButtons: state.perCardButtons.map(({ text, arg, command, disabled, method }) => ({ text, arg: String(arg), command, disabled, method })),
            number: state.selectNumber || null, dropdown: state.dropdownListOptions || [],
            distribution: state.distributeAmongTargets || null,
            attackerId: viewer.promptState.attackTargetingHighlightAttacker?.uuid || null,
            active,
        };
        return translateIds(JSON.parse(JSON.stringify({
            id, version, difficulty, phase: game.currentPhase, round: game.roundNumber,
            initiativePlayerId: game.initiativePlayer?.id || null, initiativeClaimed: game.isInitiativeClaimed,
            winnerIds: game.getPlayers().filter((player) => game.winnerNames.includes(player.name)).map((player) => player.id),
            ended: game.isEnded, viewerId: playerId, players, prompt, legalActions,
            log: game.gameChat.messages.map((entry, index) => ({ id: index, at: entry.date, text: plainMessage(entry.message) })),
        })), publicCardIds, true);
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
        if (!action.promptId || action.promptId !== publicPromptId(playerId)) throw new ActionError('The prompt changed; refresh the game state.', 'STALE_PROMPT');
        if (action.version !== undefined && action.version !== version) throw new ActionError('The game state changed; refresh the game state.', 'STALE_STATE');
        refreshCardIds();
        action = { ...translateIds(action, engineCardIds, false), promptId: state.promptUuid };
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
        canonicalView(playerId = 'human') {
            const result = view(playerId);
            result.log = result.log.map(({ at, ...entry }) => entry);
            return result;
        },
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
