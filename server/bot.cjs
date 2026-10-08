'use strict';

/**
 * A deterministic, information-limited SWU policy. The engine is the rules authority:
 * every command is taken from legalActions, except its validated distribution payload.
 * This module deliberately never imports the engine or receives a live Game object.
 */
const DIFFICULTIES = Object.freeze({
    easy: { name: 'Kadet', tactics: 0.65, planning: false, variance: 7 },
    normal: { name: 'Vitez', tactics: 1, planning: false, variance: 0.5 },
    hard: { name: 'Majstor', tactics: 1.25, planning: true, variance: 0 }
});

const CARD_FIELDS = ['uuid', 'id', 'code', 'name', 'subtitle', 'cost', 'power', 'hp', 'damage',
    'remainingHp', 'exhausted', 'zone', 'controllerId', 'ownerId', 'text', 'type', 'sentinel',
    'cannotBeAttacked', 'selected', 'selectable', 'isAttacker', 'epicDeployActionSpent', 'hidden', 'arena', 'unique', 'attackPower'];
const list = (value) => Array.isArray(value) ? value : [];
const num = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const str = (value) => value == null ? '' : String(value);
const lower = (value) => str(value).toLowerCase();
const sum = (values) => values.reduce((total, value) => total + value, 0);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function safeCard(card) {
    if (!card || typeof card !== 'object') return null;
    if (card.hidden) return { hidden: true };
    const result = {};
    for (const key of CARD_FIELDS) if (card[key] !== undefined) result[key] = card[key];
    result.keywords = list(card.keywords).map((keyword) => typeof keyword === 'string'
        ? keyword : { name: keyword.name, value: keyword.value ?? keyword.amount });
    result.traits = list(card.traits).map(str);
    result.upgrades = list(card.upgrades).map(safeCard).filter(Boolean);
    return result;
}

/** Explicit allowlist, including a second privacy boundary inside the policy. */
function observe(view) {
    const viewerId = view.viewerId || 'bot';
    const players = view.players || {};
    const mine = players[viewerId] || {};
    const opponentId = Object.keys(players).find((id) => id !== viewerId);
    const opponent = players[opponentId] || {};
    function player(source, own) {
        const result = {
            id: source.id, base: safeCard(source.base),
            leaders: list(source.leaders || (source.leader ? [source.leader] : [])).map(safeCard),
            ground: list(source.ground).map(safeCard), space: list(source.space).map(safeCard),
            discard: list(source.discard).map(safeCard),
            handCount: num(source.handCount), deckCount: num(source.deckCount),
            resourceCount: num(source.resourceCount), readyResources: num(source.readyResources),
            creditCount: list(source.credits).length,
            hasInitiative: Boolean(source.hasInitiative), active: Boolean(source.active)
        };
        if (own) {
            result.hand = list(source.hand).map(safeCard);
            result.resources = list(source.resources).map(safeCard);
        }
        return result;
    }
    const rawPrompt = view.prompt || {};
    const prompt = {};
    for (const key of ['id', 'title', 'subtitle', 'type', 'selectMode', 'selectOrder', 'attackerId', 'active']) {
        prompt[key] = rawPrompt[key];
    }
    prompt.selectedCardIds = list(rawPrompt.selectedCardIds).slice();
    prompt.selectableCardIds = list(rawPrompt.selectableCardIds).slice();
    prompt.displayCards = list(rawPrompt.displayCards).map((card) => ({
        ...safeCard(card), cardUuid: card.cardUuid, selectionState: card.selectionState,
        selectionOrder: card.selectionOrder, displayText: card.displayText
    }));
    prompt.buttons = list(rawPrompt.buttons).map((button) => ({
        arg: button.arg, text: button.text, label: button.label,
        disabled: button.disabled, selected: button.selected, hasLegalEffects: button.hasLegalEffects
    }));
    prompt.number = rawPrompt.number && { min: num(rawPrompt.number.min), max: num(rawPrompt.number.max) };
    prompt.dropdown = list(rawPrompt.dropdown).map(str);
    prompt.distribution = rawPrompt.distribution && {
        type: rawPrompt.distribution.type, amount: num(rawPrompt.distribution.amount),
        maxTargets: rawPrompt.distribution.maxTargets, tokenType: rawPrompt.distribution.tokenType,
        isIndirectDamage: Boolean(rawPrompt.distribution.isIndirectDamage),
        canDistributeLess: Boolean(rawPrompt.distribution.canDistributeLess),
        canChooseNoTargets: Boolean(rawPrompt.distribution.canChooseNoTargets)
    };
    const legalActions = list(view.legalActions).filter((action) => !action.disabled).map((action) => ({
        type: action.type, cardId: action.cardId, arg: action.arg, method: action.method,
        promptId: action.promptId, label: action.label,
        abilities: list(action.abilities).map((ability) => ({
            title: ability.title, type: ability.type, cost: ability.cost,
            targets: list(ability.targets).map((target) => typeof target === 'string' ? target : target.uuid)
        }))
    }));
    return {
        viewerId, phase: view.phase, round: num(view.round), version: num(view.version),
        initiativeClaimed: Boolean(view.initiativeClaimed),
        me: player(mine, true), enemy: player(opponent, false), prompt, legalActions
    };
}

function cardIndex(state) {
    const cards = new Map();
    const put = (card) => {
        if (!card || card.hidden) return;
        const uuid = card.uuid || card.cardUuid;
        if (uuid) cards.set(uuid, card);
        for (const upgrade of list(card.upgrades)) put(upgrade);
    };
    for (const player of [state.me, state.enemy]) {
        put(player.base);
        for (const zone of ['leaders', 'ground', 'space', 'discard', 'hand', 'resources']) {
            for (const card of list(player[zone])) put(card);
        }
    }
    for (const card of state.prompt.displayCards) put(card);
    return cards;
}

function keyword(card, name) {
    if (!card) return 0;
    if (name === 'sentinel' && card.sentinel) return 1;
    let amount = 0;
    for (const item of list(card.keywords)) {
        const text = lower(typeof item === 'string' ? item : item.name);
        if (text === name || text.startsWith(`${name} `)) {
            amount += typeof item === 'string' ? num(text.match(/\d+/)?.[0], 1) : num(item.value, 1);
        }
    }
    if (name === 'shielded' || name === 'shield') {
        amount += list(card.upgrades).filter((upgrade) => /shield/i.test(upgrade.name)).length;
    }
    return amount;
}
function remaining(card) { return Math.max(0, num(card?.remainingHp, num(card?.hp, 1) - num(card?.damage))); }
function lane(card) { return /space/i.test(card?.zone) ? 'space' : 'ground'; }
function isUnit(card) { return /unit/i.test(card?.type) || /arena/i.test(card?.zone); }
function isBase(card) { return /base/i.test(card?.type) || (num(card?.hp) >= 25 && !isUnit(card)); }
function isOwn(card, state) { return card?.controllerId === state.me.id || card?.controllerId === state.viewerId; }
function units(player) { return [...player.ground, ...player.space].filter((card) => card && !card.hidden); }
function damageValue(card) { return Math.max(0, num(card?.attackPower, num(card?.power) + keyword(card, 'raid'))); }
function shields(card) { return list(card?.upgrades).filter((upgrade) => /shield/i.test(upgrade.name)).length; }
function unitValue(card) {
    return 2.7 + num(card.cost) * 1.2 + num(card.power) * 1.4 + remaining(card) * 0.55
        + keyword(card, 'sentinel') * 2.5 + keyword(card, 'restore') * 1.5
        + keyword(card, 'overwhelm') * 1.5 + shields(card) * 2.5
        + (/leader/i.test(card.type) ? 4 : 0) + list(card.upgrades).length * 1.1;
}
function faceTargets(attacker, defenders) {
    const sameArena = defenders.filter((card) => lane(card) === lane(attacker) && !card.cannotBeAttacked);
    const sentinels = sameArena.filter((card) => keyword(card, 'sentinel'));
    return sentinels.length && !keyword(attacker, 'saboteur') ? sentinels : sameArena;
}
function canHitBase(attacker, defenders) {
    return keyword(attacker, 'saboteur') || !defenders.some((card) => lane(card) === lane(attacker) && keyword(card, 'sentinel'));
}
function potentialDamage(attackers, defenders) {
    return sum(attackers.filter((card) => !card.exhausted && canHitBase(card, defenders)).map(damageValue));
}

function evaluateAttack(attacker, target, state, config) {
    const ownUnits = units(state.me);
    const enemyUnits = units(state.enemy);
    const attackPower = damageValue(attacker);
    const enemyHp = remaining(state.enemy.base);
    const ownHp = remaining(state.me.base);
    if (isBase(target)) {
        if (attackPower >= remaining(target)) return { score: 100000 + attackPower, reason: 'Završavam partiju napadom na bazu.' };
        const race = potentialDamage(ownUnits, enemyUnits) >= enemyHp;
        const inDanger = potentialDamage(enemyUnits, ownUnits) >= ownHp;
        return {
            score: attackPower * (enemyHp <= 10 ? 5 : 3.2) + (race ? 22 : 0) - (inDanger && !race ? 12 : 0),
            reason: race ? 'Otvaram niz napada koji može srušiti bazu.' : 'Pritišćem protivničku bazu.'
        };
    }
    const targetShield = shields(target) && !keyword(attacker, 'saboteur');
    const attackerShield = shields(attacker);
    const dealt = targetShield ? 0 : attackPower;
    const received = attackerShield ? 0 : Math.max(0, num(target.power));
    const kill = dealt >= remaining(target);
    const die = received >= remaining(attacker);
    const overrun = keyword(attacker, 'overwhelm') ? Math.max(0, dealt - remaining(target)) : 0;
    if (overrun >= enemyHp && enemyHp > 0) return { score: 100000, reason: 'Overwhelm štetom završavam partiju.' };
    const futureDamage = potentialDamage(enemyUnits, ownUnits);
    const immediateLethal = !target.exhausted && canHitBase(target, ownUnits) && damageValue(target) >= ownHp;
    const stopsLethal = kill && !target.exhausted && futureDamage >= ownHp && futureDamage - damageValue(target) < ownHp;
    let score = (kill ? unitValue(target) * 1.4 : Math.min(dealt, remaining(target)) * 1.3)
        - (die ? unitValue(attacker) * 1.08 : Math.min(received, remaining(attacker)) * 0.85)
        + (targetShield ? 2.5 : 0) + overrun * 3.2;
    if (kill && !target.exhausted) score += damageValue(target) * 1.2;
    if (kill && keyword(target, 'sentinel')) score += 4 + potentialDamage(ownUnits.filter((card) => card.uuid !== attacker.uuid), enemyUnits.filter((card) => card.uuid !== target.uuid)) * 0.7;
    if (stopsLethal) score += 60 * config.tactics;
    if (immediateLethal && kill) score += 1000;
    if (config.planning && !die) {
        // One public-board reply: penalise leaving the attacker within reach of a ready unit.
        const replies = enemyUnits.filter((unit) => unit.uuid !== target.uuid && !unit.exhausted && lane(unit) === lane(attacker));
        if (replies.some((unit) => damageValue(unit) >= remaining(attacker) - received)) score -= unitValue(attacker) * 0.18;
    }
    return {
        score,
        reason: immediateLethal && kill ? 'Uklanjam jedinicu koja može odmah srušiti moju bazu.'
            : stopsLethal ? 'Uklanjam prijetnju i prekidam protivnički završni napad.'
                : kill && keyword(target, 'sentinel') ? 'Uklanjam Sentinel i otvaram arenu.'
                    : kill && !die ? 'Dobivam razmjenu i zadržavam svoju jedinicu.'
                        : kill ? 'Mijenjam jedinicu za važniju protivničku prijetnju.'
                            : targetShield ? 'Skidam štit za sljedeći napad.' : 'Pripremam povoljnu razmjenu u areni.'
    };
}

function bestAttack(card, ability, state, config, cards) {
    const enemyUnits = units(state.enemy);
    let targets = list(ability?.targets).map((id) => cards.get(id)).filter(Boolean);
    if (!targets.length) {
        targets = faceTargets(card, enemyUnits);
        if (canHitBase(card, enemyUnits) && state.enemy.base) targets.push(state.enemy.base);
    }
    const scores = targets.map((target) => ({ ...evaluateAttack(card, target, state, config), targetId: target.uuid }));
    return scores.sort((a, b) => b.score - a.score)[0] || { score: -20, reason: 'Tražim legalan napad.' };
}

function handValue(card, state) {
    const cost = num(card.cost);
    const ownUnits = units(state.me);
    let value = isUnit(card) ? unitValue(card) : 5 + cost * 1.1;
    if (cost <= state.me.resourceCount + 1) value += 4;
    if (cost > state.me.resourceCount + 3) value -= (cost - state.me.resourceCount - 3) * 2.7;
    if (isUnit(card) && cost <= 2 && state.me.resourceCount < 3) value += 10;
    if (/upgrade/i.test(card.type) && !ownUnits.length) value -= 6;
    if (/draw/i.test(card.text)) value += 2;
    if (/defeat|deal \d+ damage/i.test(card.text)) value += 2.5;
    const duplicates = state.me.hand.filter((entry) => entry.id === card.id).length;
    if (duplicates > 1) value -= (duplicates - 1) * 2;
    if (card.unique && ownUnits.some((entry) => entry.name === card.name)) value -= 7;
    return value;
}

function resourceChoice(state, actions, cards) {
    const selected = new Set(state.prompt.selectedCardIds);
    const confirm = actions.find((action) => /confirm|done|skip/i.test(`${action.label} ${action.arg}`) && action.type === 'button');
    const title = `${state.prompt.title} ${state.prompt.subtitle}`;
    const fixed = title.match(/select (\d+) cards? to resource/i);
    const desired = fixed ? num(fixed[1]) : 1;
    if (selected.size >= desired && confirm) return { action: confirm, score: 0, reason: 'Potvrđujem odabrane resurse.' };
    const candidates = actions.filter((action) => action.type === 'card' && !selected.has(action.cardId));
    const maxUsefulCost = Math.max(0, ...state.me.hand.map((card) => num(card.cost)), ...state.me.leaders.map((card) => num(card.cost)));
    if (!fixed && confirm && selected.size === 0 && state.me.resourceCount >= Math.max(6, maxUsefulCost)
        && (state.me.hand.length <= 3 || state.me.resourceCount >= 9)) {
        return { action: confirm, score: 0, reason: 'Imam dovoljno resursa; zadržavam karte u ruci.' };
    }
    candidates.sort((a, b) => handValue(cards.get(a.cardId) || {}, state) - handValue(cards.get(b.cardId) || {}, state));
    if (candidates.length) return { action: candidates[0], score: 0, reason: 'Resursiram najmanje korisnu kartu i čuvam ranu krivulju.' };
    return confirm ? { action: confirm, score: 0, reason: 'Završavam korak resursa.' } : null;
}

function mulliganChoice(state, actions) {
    const hand = state.me.hand;
    const earlyUnits = hand.filter((card) => isUnit(card) && num(card.cost) <= 2).length;
    const followups = hand.filter((card) => isUnit(card) && num(card.cost) >= 3 && num(card.cost) <= 4).length;
    const wantMulligan = earlyUnits === 0 || (earlyUnits + followups < 2 && hand.length >= 5);
    const desired = wantMulligan ? 'mulligan' : 'keep';
    const action = actions.find((entry) => lower(entry.arg) === desired || lower(entry.label) === desired);
    return action && { action, score: 0, reason: wantMulligan
        ? 'Mijenjam ruku bez pouzdane rane krivulje jedinica.' : 'Zadržavam ruku s ranim jedinicama i nastavkom krivulje.' };
}

function curveFollowup(excluded, state, budget) {
    const dp = Array(Math.max(0, Math.floor(budget)) + 1).fill(0);
    for (const card of state.me.hand) {
        const cost = Math.max(0, Math.floor(num(card.cost)));
        if (card.uuid === excluded || cost > budget) continue;
        for (let total = dp.length - 1; total >= cost; total--) {
            dp[total] = Math.max(dp[total], dp[total - cost] + Math.min(10, handValue(card, state) * 0.28));
        }
    }
    return Math.max(...dp);
}

function playValue(card, ability, state, config) {
    const cost = num(ability?.cost, num(card.cost));
    const enemyUnits = units(state.enemy);
    const ownUnits = units(state.me);
    const text = lower(card.text);
    let score = 5 + num(card.cost) * 0.8;
    let reason = 'Razvijam ploču i učinkovito koristim resurse.';
    if (isUnit(card)) {
        score = 6 + unitValue(card) * 0.8 + Math.min(cost, state.me.readyResources) * 0.7;
        const arena = /space/i.test(card.zone) || /space/i.test(card.type) || /space/i.test(card.arena) ? 'space' : 'ground';
        if (!ownUnits.some((entry) => lane(entry) === arena)) score += 2.5;
        if (keyword(card, 'ambush') || /\bambush\b/.test(text)) {
            score += 5;
            reason = 'Uvodim Ambush jedinicu radi trenutačnog utjecaja na arenu.';
        }
        if (keyword(card, 'sentinel') || /\bsentinel\b/.test(text)) {
            const danger = potentialDamage(enemyUnits, ownUnits) >= remaining(state.me.base);
            if (danger) { score += 70; reason = 'Postavljam Sentinel da zaštitim bazu.'; }
        }
    } else if (/upgrade/i.test(card.type)) {
        score += ownUnits.some((entry) => !entry.exhausted) ? 6 : -2;
        if (ownUnits.length === 0) score -= 25;
        reason = 'Pojačavam jedinicu za bolji napad ili preživljavanje.';
    } else {
        const damage = num(text.match(/deal (\d+) damage/)?.[1]);
        if (damage && /base/.test(text) && damage >= remaining(state.enemy.base)) {
            score += 10000; reason = 'Koristim štetu koja može završiti partiju.';
        } else if (damage) {
            const kills = enemyUnits.filter((unit) => remaining(unit) <= damage);
            score += kills.length ? Math.max(...kills.map(unitValue)) * 0.9 : enemyUnits.length ? damage : -10;
            reason = 'Koristim uklanjanje protiv važne prijetnje.';
        }
        if (/defeat|capture|return.*hand/.test(text)) score += enemyUnits.length ? Math.max(...enemyUnits.map(unitValue)) * 0.6 : -8;
        if (/draw/.test(text)) { score += state.me.hand.length <= 3 ? 9 : 3; reason = 'Obnavljam ruku za sljedeće akcije.'; }
        if (/heal|restore/.test(text)) score += num(state.me.base?.damage) >= 10 ? 9 : -3;
    }
    if (config.planning) score += curveFollowup(card.uuid, state, state.me.readyResources - cost);
    return { score, reason };
}

function abilityValue(card, ability, state, config, cards) {
    if (ability.type === 'attack') return bestAttack(card, ability, state, config, cards);
    if (ability.type === 'play') return playValue(card, ability, state, config);
    if (ability.type === 'deploy') {
        const enemyThreat = potentialDamage(units(state.enemy), units(state.me));
        return {
            score: 19 + unitValue(card) * 0.45 + (damageValue(card) >= remaining(state.enemy.base) ? 120 : 0)
                + (enemyThreat >= remaining(state.me.base) ? 5 : 0),
            reason: 'Deployam vođu radi dodatne spremne jedinice i pritiska.'
        };
    }
    const text = lower(ability.title);
    let score = 8;
    let reason = 'Koristim sposobnost za dodatnu vrijednost.';
    if (/play.*(?:unit|card).*from your hand/.test(text)) {
        const trait = text.match(/\{trait:([^}]+)\}/)?.[1];
        const affordable = state.me.hand.filter((entry) => (!trait || list(entry.traits).some((value) => lower(value) === trait))
            && isUnit(entry) && num(entry.cost) <= state.me.readyResources + state.me.creditCount);
        if (!affordable.length) return { score: -80, reason: 'Čuvam akciju jer nemam kartu koju mogu platiti.' };
        score = Math.max(...affordable.map((entry) => playValue(entry, null, state, config).score)) + 2;
        reason = 'Sposobnošću igram dostupnu jedinicu iz ruke.';
    }
    if (/draw/.test(text)) { score += state.me.hand.length <= 3 ? 10 : 4; reason = 'Sposobnošću obnavljam ruku.'; }
    if (/shield|experience|ready/.test(text)) score += 5;
    if (/damage|defeat|attack/.test(text)) score += units(state.enemy).length ? 5 : 1;
    if (/heal/.test(text)) score += num(state.me.base?.damage) > 7 ? 8 : -4;
    if (/exhaust/.test(text) && isUnit(card) && !card.exhausted) score -= damageValue(card) * 0.8;
    return { score, reason };
}

function actionWindowChoice(action, state, config, cards) {
    if (action.type !== 'card') {
        if (/claiminitiative|claim initiative/i.test(`${action.arg} ${action.label}`)) {
            const ready = units(state.me).filter((card) => !card.exhausted).length;
            return { score: ready === 0 ? 2 : -3, reason: 'Uzimam inicijativu za prvi potez sljedeće runde.' };
        }
        return { score: -30, reason: 'Prolazim jer nemam koristan legalan potez.' };
    }
    const card = cards.get(action.cardId);
    if (!card) return { score: 1, reason: 'Koristim dostupnu legalnu akciju.' };
    let abilities = action.abilities;
    if (!abilities.length) {
        const type = card.zone === 'hand' || card.zone === 'resource' ? 'play'
            : isUnit(card) && !card.exhausted ? 'attack' : 'action';
        abilities = [{ type }];
    }
    const options = abilities.map((ability) => ({ ...abilityValue(card, ability, state, config, cards), ability }));
    options.sort((a, b) => b.score - a.score);
    return { ...options[0], plan: { cardId: card.uuid, targetId: options[0].targetId, ability: options[0].ability } };
}

function targetValue(card, state, config, cards, memory) {
    let promptText = lower(`${state.prompt.title} ${state.prompt.subtitle}`);
    // Many engine selectors simply say "Choose a unit". The public source card
    // or selected ability explains whether this is damage, healing, or a buff.
    if (!/damage|heal|shield|experience|advantage|give.*token|defeat|capture|exhaust|discard|sacrifice|attach|ready|resource|return.*hand/.test(lower(state.prompt.title))) {
        const source = [...cards.values()].find((entry) => lower(entry.name) === lower(state.prompt.subtitle))
            || cards.get(memory.plan?.cardId);
        const plannedTitle = source?.uuid === memory.plan?.cardId ? memory.plan?.ability?.title : '';
        const effectTitle = /damage|heal|shield|experience|advantage|defeat|capture|exhaust|discard|sacrifice|attach|ready/i.test(plannedTitle || '')
            ? plannedTitle : source?.text;
        promptText += ` ${lower(effectTitle)}`;
    }
    const own = isOwn(card, state);
    const attacker = cards.get(state.prompt.attackerId)
        || (/(?:attack|defender)/i.test(`${state.prompt.title} ${state.prompt.subtitle}`) && cards.get(memory.plan?.cardId));
    if (attacker && !own) return evaluateAttack(attacker, card, state, config);
    if (own && card.zone === 'hand' && /play.*(?:unit|card).*from your hand/i.test(memory.plan?.ability?.title || '')) {
        return { score: num(card.cost) <= state.me.readyResources + state.me.creditCount ? handValue(card, state) + 20 : -80,
            reason: 'Biram jedinicu koju mogu platiti i odmah razviti.' };
    }
    if (/resource|discard.*(?:hand|card)|choose.*discard|sacrifice|defeat (?:a|one|another).*friendly/.test(promptText)) {
        return { score: own ? -handValue(card, state) : unitValue(card), reason: 'Biram najmanji gubitak vrijednosti.' };
    }
    if (/heal|remove.*damage/.test(promptText)) {
        return { score: (own ? 1 : -1) * (num(card.damage) * 3 + (isBase(card) && remaining(card) <= 8 ? 50 : 0)), reason: 'Liječim najugroženiji vlastiti cilj.' };
    }
    if (/shield|experience|advantage|give.*(?:power|\+|token)|upgrade|attach|ready|friendly/.test(promptText)) {
        return { score: (own ? 1 : -1) * (unitValue(card) + (card.exhausted && /ready/.test(promptText) ? 10 : 0)
            + (!card.exhausted ? 5 : 0)), reason: 'Pojačavam vlastiti cilj s najvećim utjecajem.' };
    }
    if (/defeat|damage|capture|exhaust|return.*hand|enemy|opponent/.test(promptText)) {
        let score = own ? -unitValue(card) : unitValue(card);
        if (!own && !card.exhausted) score += damageValue(card) * 1.4;
        if (!own && !card.exhausted && damageValue(card) >= remaining(state.me.base)) score += 70;
        if (isBase(card)) score = own ? -100 : remaining(card) <= 5 ? 60 : 10;
        return { score, reason: own ? 'Smanjujem gubitak pri obaveznom odabiru.' : 'Ciljam najveću protivničku prijetnju.' };
    }
    if (/deck|search|look|reveal|draw|hand|choose.*card/.test(promptText) || state.prompt.displayCards.length) {
        return { score: handValue(card, state), reason: 'Biram kartu koja najbolje dopunjuje ruku i krivulju.' };
    }
    return { score: own ? unitValue(card) : unitValue(card) * 0.7, reason: 'Biram najbolji dostupni legalni cilj.' };
}

function buttonValue(action, state, config, cards, memory) {
    const text = lower(`${action.label} ${action.arg}`);
    const promptText = lower(`${state.prompt.title} ${state.prompt.subtitle}`);
    const selected = state.prompt.selectedCardIds.length;
    if (/^(?:cancel|back|undo)|cancel ability|cancel prompt/.test(text)) return { score: -100, reason: 'Odustajem od neprovedive opcije.' };
    if (/pass ability|choose nothing|no target|skip/.test(text)) return { score: -15, reason: 'Preskačem izbor bez korisnog cilja.' };
    if (/\bdone\b|confirm|continue|ok\b/.test(text)) {
        const menuSelected = state.prompt.buttons.filter((button) => button.selected).length;
        return { score: selected || menuSelected ? 1 : 0, reason: 'Potvrđujem dovršeni odabir.' };
    }
    const card = cards.get(memory.plan?.cardId);
    const ability = memory.plan?.ability;
    if (ability && card && (lower(action.label) === lower(ability.title)
        || (ability.type === 'attack' && /attack/.test(text))
        || (ability.type === 'deploy' && /deploy/.test(text)))) {
        return { score: 60, reason: 'Nastavljam odabranu taktičku akciju.' };
    }
    if (/resolve all/.test(text)) return { score: 25, reason: 'Razrješavam dostupne okidače.' };
    if (/resolve|trigger|yes|use|pay|gain/.test(text)) return { score: 12, reason: 'Koristim korisni efekt karte.' };
    if (/\bno\b/.test(text)) return { score: -3, reason: 'Odbijam nepotreban dodatni trošak.' };
    if (/damage|defeat|attack/.test(text)) return { score: units(state.enemy).length ? 18 : 4, reason: 'Biram pritisak ili uklanjanje prijetnje.' };
    if (/draw/.test(text)) return { score: state.me.hand.length <= 3 ? 20 : 11, reason: 'Biram dodatne karte.' };
    if (/shield|experience|advantage|ready/.test(text)) return { score: units(state.me).length ? 17 : 1, reason: 'Biram razvoj vlastite ploče.' };
    if (/heal/.test(text)) return { score: num(state.me.base?.damage) >= 10 ? 22 : 5, reason: 'Biram liječenje pod pritiskom.' };
    if (/bottom/.test(text)) return { score: -1, reason: 'Manje korisnu kartu šaljem na dno špila.' };
    if (/top|hand/.test(text)) return { score: 8, reason: 'Zadržavam korisnu kartu za sljedeći potez.' };
    if (/initiative/.test(promptText)) return { score: /myself|yourself|me|bot|ai/.test(text) ? 25 : 3, reason: 'Biram prvi potez.' };
    return { score: 5, reason: 'Razrješavam legalnu opciju efekta.' };
}

function distributionChoice(action, state, cards) {
    const data = state.prompt.distribution;
    if (!data) return null;
    const targets = state.prompt.selectableCardIds.map((id) => cards.get(id)).filter(Boolean);
    const allocation = new Map();
    const maxTargets = num(data.maxTargets, Infinity) || Infinity;
    const healing = /healing/i.test(data.type);
    const tokens = /token/i.test(data.type);
    const indirect = data.isIndirectDamage || /indirect/i.test(data.type);
    let left = Math.max(0, Math.floor(data.amount));
    for (let i = 0; i < data.amount; i++) {
        const candidates = targets.filter((card) => {
            if (!allocation.has(card.uuid) && allocation.size >= maxTargets) return false;
            const assigned = allocation.get(card.uuid) || 0;
            if (indirect && !isBase(card) && assigned >= remaining(card)) return false;
            if (healing && assigned >= num(card.damage)) return false;
            return true;
        }).map((card) => {
            const assigned = allocation.get(card.uuid) || 0;
            const own = isOwn(card, state);
            let score;
            if (healing) {
                score = (own ? 1 : -1) * (isBase(card) ? remaining(card) + assigned < 8 ? 100 : 8 : unitValue(card) / Math.max(1, remaining(card) + assigned));
            } else if (tokens) {
                score = (own ? 1 : -1) * (unitValue(card) + (!card.exhausted ? 5 : 0) - assigned * (/shield/i.test(data.tokenType) ? 7 : 1));
            } else if (own) {
                const hpAfter = remaining(card) - assigned - 1;
                score = isBase(card) ? (hpAfter <= 0 ? -100000 : hpAfter < 6 ? -25 : -2)
                    : hpAfter <= 0 ? -unitValue(card) * 2 : -1 - unitValue(card) / Math.max(1, hpAfter) * 0.1;
            } else {
                const missing = remaining(card) - assigned;
                score = isBase(card) ? (missing <= left ? 100000 : 2)
                    : missing <= left ? unitValue(card) * 2 / Math.max(1, missing) : unitValue(card) / Math.max(1, missing);
                if (missing <= 0) score = -10;
            }
            return { card, score };
        }).sort((a, b) => b.score - a.score);
        if (!candidates.length) break;
        const best = candidates[0].card;
        allocation.set(best.uuid, (allocation.get(best.uuid) || 0) + 1);
        left--;
    }
    // Healing may legally be assigned above the damaged amount; it simply has no extra effect.
    // If full distribution is mandatory, complete it without violating indirect-damage caps.
    if (left > 0 && !data.canDistributeLess) {
        const fallback = targets.find((card) => (allocation.has(card.uuid) || allocation.size < maxTargets)
            && (!indirect || isBase(card) || remaining(card) - (allocation.get(card.uuid) || 0) >= left));
        if (fallback) { allocation.set(fallback.uuid, (allocation.get(fallback.uuid) || 0) + left); left = 0; }
    }
    if ((left > 0 && !data.canDistributeLess) || (!allocation.size && !data.canChooseNoTargets && data.amount > 0)) return null;
    return {
        action: { ...action, result: { type: data.type, valueDistribution: [...allocation].map(([uuid, amount]) => ({ uuid, amount })) } },
        score: 0,
        reason: healing ? 'Raspoređujem liječenje na ugrožene ciljeve.'
            : tokens ? 'Raspoređujem pojačanja prema vrijednosti jedinica.'
                : indirect ? 'Raspoređujem indirektnu štetu uz najmanji gubitak.' : 'Koncentriram štetu za uklanjanje važnih ciljeva.'
    };
}

function actionKey(action) { return `${action.type}|${action.cardId || ''}|${action.arg ?? ''}|${action.method || ''}`; }
function fingerprint(state) {
    return `${state.prompt.id}|${state.prompt.title}|${state.prompt.selectedCardIds.join(',')}|${state.prompt.displayCards.map((card) => `${card.cardUuid || card.uuid}:${card.selectionState}`).join(',')}|${state.prompt.buttons.map((button) => `${button.arg}:${button.selected || false}`).join(',')}|${state.legalActions.map(actionKey).join(',')}`;
}
function boardFingerprint(state) {
    const cards = (entries) => entries.map((card) => [card.uuid, card.zone, card.damage, card.power, card.hp,
        card.exhausted, card.epicDeployActionSpent, list(card.upgrades).map((upgrade) => upgrade.uuid)]);
    return JSON.stringify([state.round, state.initiativeClaimed, ...[state.me, state.enemy].map((player) => [
        player.readyResources, player.resourceCount, player.creditCount, player.handCount, player.deckCount,
        player.base?.damage, player.base?.remainingHp, cards([...player.ground, ...player.space, ...player.leaders, ...player.discard])
    ]), cards(state.me.hand)]);
}
function noise(seed) {
    let hash = 2166136261;
    for (const letter of seed) { hash ^= letter.charCodeAt(0); hash = Math.imul(hash, 16777619); }
    return ((hash >>> 0) % 1000) / 1000 - 0.5;
}

function chooseAction(view, options = {}) {
    const state = observe(view);
    const memory = options.memory || {};
    const requested = lower(options.difficulty || 'normal');
    const difficulty = ({ cadet: 'easy', apprentice: 'easy', knight: 'normal', master: 'hard', expert: 'hard' })[requested] || requested;
    const config = DIFFICULTIES[difficulty] || DIFFICULTIES.normal;
    const actions = state.legalActions;
    if (!actions.length) return { action: null, reason: 'Čekam protivnički potez.', difficulty, memory };
    const cards = cardIndex(state);
    const title = lower(`${state.prompt.title} ${state.prompt.subtitle}`);
    const fp = fingerprint(state);
    if (memory.fingerprint !== fp) { memory.fingerprint = fp; memory.attempts = {}; }
    if (state.prompt.type === 'actionWindow') {
        const board = boardFingerprint(state);
        if (memory.boardFingerprint !== board) { memory.boardFingerprint = board; memory.boardAttempts = {}; }
    }
    const selected = new Set(state.prompt.selectedCardIds);
    for (const card of state.prompt.displayCards) if (card.selectionState === 'selected') selected.add(card.uuid || card.cardUuid);
    let choice = null;
    if (/mulligan/.test(title) && actions.some((action) => /mulligan|keep/i.test(action.arg))) choice = mulliganChoice(state, actions);
    else if (state.prompt.type === 'resource' || /resource step/.test(title)) choice = resourceChoice(state, actions, cards);
    else if (state.prompt.distribution) choice = distributionChoice(actions.find((action) => action.type === 'stateful') || actions[0], state, cards);
    else if (state.prompt.number) {
        const harmful = /pay|suffer|discard|damage to (?:your|a friendly)/.test(title);
        const desired = harmful ? state.prompt.number.min : state.prompt.number.max;
        const action = actions.find((entry) => num(entry.arg, NaN) === desired);
        if (action) choice = { action, score: 0, reason: harmful ? 'Biram najmanji potreban trošak.' : 'Biram najveći legalni učinak.' };
    }
    if (!choice) {
        const ranked = actions.map((action, index) => {
            let result;
            const cardId = action.cardId || (action.type === 'button' && cards.has(action.arg) ? action.arg : null);
            const card = cards.get(cardId);
            if (state.prompt.type === 'actionWindow') result = actionWindowChoice(action, state, config, cards);
            else if (card && action.type === 'perCard') {
                result = buttonValue(action, state, config, cards, memory);
                const value = handValue(card, state);
                if (/bottom|discard/.test(lower(action.label))) result.score += Math.max(0, 14 - value);
                if (/top|hand/.test(lower(action.label))) result.score += value * 0.5;
            } else if (card) {
                result = targetValue(card, state, config, cards, memory);
                if (selected.has(cardId)) result.score = -1000; // Never oscillate by toggling chosen cards.
                if (state.prompt.selectOrder && /bottom|discard/.test(title)) result.score *= -1;
            } else result = buttonValue(action, state, config, cards, memory);
            const promptButton = state.prompt.buttons.find((button) => str(button.arg) === str(action.arg));
            if (promptButton?.selected) result.score = -1000;
            const attempts = memory.attempts?.[actionKey(action)] || 0;
            result.score -= attempts * 2000;
            if (state.prompt.type === 'actionWindow') result.score -= (memory.boardAttempts?.[actionKey(action)] || 0) * 2000;
            // Difficulty affects tactical evaluation, not hidden information or rules.
            if (result.score < 1000) result.score += noise(`${state.round}|${state.prompt.title}|${action.label}|${card?.code || card?.name || ''}|${index}`) * config.variance;
            return { ...result, action };
        }).sort((a, b) => b.score - a.score);
        choice = ranked[0];
        choice.alternatives = ranked.slice(1, 4).map((entry) => ({ label: entry.action.label, score: Math.round(entry.score * 10) / 10 }));
    }
    if (!choice?.action) return { action: null, reason: 'Nema valjanog rješenja za trenutačni izbor.', difficulty, memory };
    memory.attempts ||= {};
    const key = actionKey(choice.action);
    memory.attempts[key] = (memory.attempts[key] || 0) + 1;
    if (state.prompt.type === 'actionWindow') {
        memory.boardAttempts ||= {};
        memory.boardAttempts[key] = (memory.boardAttempts[key] || 0) + 1;
    }
    if (choice.plan) memory.plan = choice.plan;
    const decision = {
        action: choice.action, reason: choice.reason, difficulty,
        score: Math.round(num(choice.score) * 10) / 10, alternatives: choice.alternatives || [], memory
    };
    memory.lastDecision = { reason: decision.reason, difficulty, type: choice.action.type, label: choice.action.label };
    return decision;
}

module.exports = { chooseAction, observe, DIFFICULTIES, evaluateAttack, distributionChoice };
