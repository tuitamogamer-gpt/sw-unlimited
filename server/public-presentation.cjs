'use strict';

// Immutable card snapshots for public action history. The engine's normal
// visibility check must approve both seats before printed data is published.
function publicPresentationCard(card, players, catalogCard) {
    if (!card?.cardData || !card.getSummary) return undefined;
    const summaries = players.map(player => card.getSummary(player));
    if (summaries.length !== 2 || summaries.some(summary => !summary.id)) return undefined;
    const summary = summaries[0];
    const data = card.cardData;
    const printed = catalogCard(data);
    const deployed = data.types.includes('leader') && (card.deployed === true || summary.type !== 'leader');
    const damage = summary.damage ?? 0;
    return JSON.parse(JSON.stringify({
        ...printed, uuid: card.uuid, hidden: false, type: summary.type,
        ownerId: summary.ownerId, controllerId: summary.controllerId, zone: card.zoneName,
        frontImage: printed.image, frontText: data.text || '', deployed,
        image: deployed && printed.backImage ? printed.backImage : printed.image,
        text: deployed ? data.deployBox || data.text || '' : data.text || '',
        power: summary.power, hp: summary.hp, damage, exhausted: !!summary.exhausted,
        remainingHp: typeof summary.hp === 'number' ? Math.max(0, summary.hp - damage) : undefined,
    }));
}

module.exports = { publicPresentationCard };
