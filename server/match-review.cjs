'use strict';

// Review only successful human inputs and the engine's public outcomes. This
// is an observation aid, not a search policy or a prediction of the next turn.
const VERSION = 1;
const MAX_MOMENTS = 12;
const MAX_PUBLIC_MOMENTS = 3;
const array = value => Array.isArray(value) ? value : [];
const number = value => Number.isFinite(value) ? value : 0;
const health = card => Math.max(0, number(card?.remainingHp ?? (number(card?.hp) - number(card?.damage))));
const power = card => Math.max(0, number(card?.attackPower ?? card?.power));
const name = card => typeof card?.name === 'string' ? card.name.slice(0, 160) : '';
const units = player => [...array(player?.ground), ...array(player?.space)].filter(card => card && !card.hidden);
const lastSequence = events => Math.max(0, ...array(events).map(event => number(event.sequence)));
const key = action => JSON.stringify([action?.type, action?.cardId || '', action?.arg === undefined ? '' : String(action.arg)]);
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const damageSource = event => event.sourceCard || (['combat', 'overwhelm', 'excess'].includes(event.damageType) ? event.attack?.attacker : undefined);

function initialReview(startedAtAction = 0, playSequence = 0, damageSequence = 0) {
    return { version: VERSION, startedAtAction, lastReviewedAction: -1, playSequence, damageSequence,
        stats: { decisions: 0, plays: 0, deploys: 0, baseDamage: 0, initiativeClaims: 0 }, moments: [] };
}

function addPublicStats(stats, view, playSequence, damageSequence) {
    for (const event of array(view.publicPlayEvents)) {
        if (event.sequence <= playSequence || event.playerId !== 'human') continue;
        if (event.kind === 'play') stats.plays++;
        if (event.kind === 'deploy') stats.deploys++;
    }
    for (const event of array(view.publicDamageEvents)) {
        if (event.sequence > damageSequence && event.playerId === 'human'
            && event.targetCard?.uuid === view.players?.bot?.base?.uuid) stats.baseDamage += Math.max(0, number(event.amount));
    }
}

/** Call before submission; null means this input has no reviewable human choice. */
function captureReviewDecision(record, game, action, seat = 'human') {
    if (seat !== 'human') return null;
    const view = game.view('human');
    if (view.ended || array(view.winnerIds).length || !view.prompt?.active) return null;
    const legal = array(view.legalActions).find(candidate => !candidate.disabled && key(candidate) === key(action));
    if (!legal) return null;
    const me = view.players?.human;
    const enemy = view.players?.bot;
    const capture = {
        actionIndex: array(record.actions).length, actionKey: key(legal), version: view.version,
        round: number(view.round), playSequence: lastSequence(view.publicPlayEvents),
        damageSequence: lastSequence(view.publicDamageEvents),
        initiative: legal.type === 'button' && legal.arg === 'claimInitiative',
        moments: [],
    };
    // Only an actual native attack-target prompt establishes these alternatives
    // as legal. We do not reconstruct Sentinel or effect targeting from text.
    const attacker = units(me).find(card => card.uuid === view.prompt.attackerId);
    if (!attacker || legal.type !== 'card' || array(view.prompt.selectedCardIds).length
        || view.prompt.selectMode !== 'single') return capture;
    const legalIds = new Set(array(view.legalActions).filter(candidate => candidate.type === 'card' && !candidate.disabled).map(candidate => candidate.cardId));
    const chosen = [enemy?.base, ...units(enemy)].find(card => card?.uuid === legal.cardId);
    if (!chosen) return capture;
    capture.attack = { cardId: attacker.uuid, targetId: chosen.uuid, card: name(attacker), target: name(chosen) };
    const enemyBaseHp = health(enemy?.base);
    if (chosen.uuid !== enemy?.base?.uuid && legalIds.has(enemy?.base?.uuid)
        && enemyBaseHp > 0 && power(attacker) >= enemyBaseHp) {
        capture.moments.push({ kind: 'base-option', round: capture.round, priority: 90,
            card: name(attacker), target: name(chosen), power: power(attacker), health: enemyBaseHp });
    }
    const ownBaseHp = health(me?.base);
    const threat = units(enemy).filter(card => card.uuid !== chosen.uuid && !card.exhausted
        && legalIds.has(card.uuid) && ownBaseHp > 0 && power(card) >= ownBaseHp)
        .sort((a, b) => power(b) - power(a) || compare(name(a), name(b)))[0];
    if (threat) capture.moments.push({ kind: 'threat-option', round: capture.round, priority: 80,
        card: name(attacker), target: name(threat), power: power(threat), health: ownBaseHp });
    return capture;
}

/** Call immediately after applyAction succeeds, before the bot continues. */
function commitReviewDecision(record, capture, game) {
    if (!capture) return;
    const last = array(record.actions).at(-1);
    if (array(record.actions).length !== capture.actionIndex + 1 || last?.playerId !== 'human'
        || key(last.action) !== capture.actionKey) return;
    const view = game.view('human');
    if (view.version <= capture.version) return;
    if (record.review?.version !== VERSION) {
        const earlierHumanChoice = array(record.actions).slice(0, capture.actionIndex).some(item => item.playerId === 'human');
        record.review = initialReview(earlierHumanChoice ? capture.actionIndex : 0, capture.playSequence, capture.damageSequence);
    }
    const review = record.review;
    if (Number.isFinite(review.lastReviewedAction) && review.lastReviewedAction >= capture.actionIndex) return;
    review.lastReviewedAction = capture.actionIndex;
    review.stats.decisions++;
    if (capture.initiative) review.stats.initiativeClaims++;
    // A human card can deal damage during the opponent's action. Include those
    // public outcomes once, without inspecting any bot choice or private card.
    addPublicStats(review.stats, view, number(review.playSequence), number(review.damageSequence));
    review.playSequence = lastSequence(view.publicPlayEvents);
    review.damageSequence = lastSequence(view.publicDamageEvents);
    const moments = capture.moments.slice();
    for (const event of array(view.publicPlayEvents)) {
        if (event.sequence <= capture.playSequence || event.playerId !== 'human') continue;
        if (event.kind === 'deploy') {
            moments.push({ kind: 'leader-deployed', round: capture.round, priority: 20, card: name(event.card) });
        }
    }
    const baseEvents = array(view.publicDamageEvents).filter(event => event.sequence > capture.damageSequence
        && event.playerId === 'human' && event.targetCard?.uuid === view.players?.bot?.base?.uuid);
    for (const event of baseEvents) {
        const damage = Math.max(0, number(event.amount));
        // A public event may omit a hidden source. Never retrieve it elsewhere.
        const source = damageSource(event);
        if (!source || source.hidden || !name(source)) continue;
        const finished = array(view.winnerIds).includes('human') && event === baseEvents.at(-1) && health(event.targetCard) === 0;
        if (finished || damage >= 5 || health(view.players?.bot?.base) <= 5) {
            moments.push({ kind: finished ? 'finishing-blow' : 'base-hit', round: capture.round,
                priority: finished ? 120 : 40 + Math.min(damage, 25), card: name(source),
                damage, health: health(view.players?.bot?.base) });
        }
    }
    if (capture.attack && array(view.players?.bot?.discard).some(card => card.uuid === capture.attack.targetId)
        && array(view.publicDamageEvents).some(event => event.sequence > capture.damageSequence
            && event.targetCard?.uuid === capture.attack.targetId && event.sourceCard?.uuid === capture.attack.cardId)) {
        moments.push({ kind: 'unit-defeated', round: capture.round, priority: 35,
            card: capture.attack.card, target: capture.attack.target });
    }
    for (const moment of moments) {
        const id = `${capture.actionIndex}:${moment.kind}:${moment.card}:${moment.target || ''}`;
        if (!array(review.moments).some(previous => previous.id === id)) review.moments.push({ ...moment, id });
    }
    review.moments.sort((a, b) => b.priority - a.priority || a.round - b.round || compare(a.id, b.id));
    review.moments = review.moments.slice(0, MAX_MOMENTS);
}

/** Safe to attach to the human response. Ongoing games expose no review. */
function publicReview(record, game) {
    const view = game.view('human');
    const winners = array(view.winnerIds).filter(id => ['human', 'bot'].includes(id));
    if (!view.ended && !winners.length) return null;
    const review = record.review?.version === VERSION ? record.review
        : initialReview(array(record.actions).some(item => item.playerId === 'human') ? array(record.actions).length : 0,
            lastSequence(view.publicPlayEvents), lastSequence(view.publicDamageEvents));
    const moments = array(review.moments).slice();
    if (winners.length === 1 && winners[0] === 'bot') {
        const finalHit = array(view.publicDamageEvents).filter(event => event.playerId === 'bot'
            && event.targetCard?.uuid === view.players?.human?.base?.uuid).at(-1);
        if (finalHit && health(finalHit.targetCard) === 0 && name(damageSource(finalHit))) moments.unshift({ id: 'opponent-final-hit',
            kind: 'opponent-finishing-blow', round: number(view.round), card: name(damageSource(finalHit)),
            damage: number(finalHit.amount), health: 0 });
    }
    const unique = [];
    const seen = new Set();
    for (const moment of moments) {
        // Repeated attacks often offer the same lesson; show it once.
        const lesson = `${moment.kind}:${moment.card}:${moment.target || ''}`;
        if (seen.has(lesson)) continue;
        seen.add(lesson);
        const clean = { id: String(moment.id), kind: moment.kind, round: number(moment.round), card: String(moment.card || '').slice(0, 160) };
        if (moment.target) clean.target = String(moment.target).slice(0, 160);
        for (const field of ['power', 'health', 'damage']) if (Number.isFinite(moment[field])) clean[field] = moment[field];
        unique.push(clean);
        if (unique.length === MAX_PUBLIC_MOMENTS) break;
    }
    const stats = {};
    for (const field of ['decisions', 'plays', 'deploys', 'baseDamage', 'initiativeClaims']) stats[field] = Math.max(0, number(review.stats?.[field]));
    addPublicStats(stats, view, number(review.playSequence), number(review.damageSequence));
    return { version: VERSION, outcome: winners.length === 1 ? winners[0] === 'human' ? 'win' : 'loss' : 'draw',
        winnerIds: winners, rounds: number(view.round), partial: number(review.startedAtAction) > 0, stats, moments: unique };
}

module.exports = { captureReviewDecision, commitReviewDecision, publicReview, MAX_MOMENTS };
