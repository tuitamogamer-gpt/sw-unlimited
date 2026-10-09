import type { Card, GameView, PublicPlayEvent, PublicDamageEvent } from './types';

export const OPPONENT_PREVIEW_MS = 3000;
export const DAMAGE_PRESENTATION_MS = 1600;

export type BattlePresentation = { kind: 'play'; event: PublicPlayEvent } | { kind: 'damage'; events: PublicDamageEvent[] };

/** Use resolved native damage, including its actual source. A board delta
 * cannot distinguish a defender's combat damage from a separate AI ability. */
export function newDamageEvents(before: GameView | null, after: GameView, restored = false): PublicDamageEvent[] {
  if (restored || !before || before.id !== after.id || before.viewerId !== after.viewerId || after.version <= before.version) return [];
  const previousSequence = Math.max(0, ...(before.publicDamageEvents || []).map(event => event.sequence));
  const seen = new Set<string>();
  const seenSequences = new Set<number>();
  const visible = (card: Card | undefined) => !!card && !card.hidden && !!card.uuid;
  return (after.publicDamageEvents || []).filter(event => {
    if (!event.id || event.kind !== 'damage' || !Number.isSafeInteger(event.sequence) || event.sequence <= previousSequence
      || !Number.isSafeInteger(event.order) || event.order <= 0 || seen.has(event.id) || seenSequences.has(event.sequence)
      || !['human', 'bot'].includes(event.playerId)
      || !Number.isFinite(event.amount) || event.amount <= 0 || !visible(event.targetCard)
      || event.sourceCard && !visible(event.sourceCard) || event.sourceCards?.some(card => !visible(card))
      || event.attack && (!event.attack.id || !visible(event.attack.attacker)
        || event.attack.defender && !visible(event.attack.defender) || event.attack.defenders?.some(card => !visible(card)))) return false;
    seen.add(event.id); seenSequences.add(event.sequence); return true;
  }).sort((left, right) => left.order - right.order);
}

/** Combat damage in both directions belongs to one simultaneous exchange.
 * On Attack abilities remain separate, even when they share that attack. */
export function newBattlePresentations(before: GameView | null, after: GameView, restored = false): BattlePresentation[] {
  const entries = [
    ...newOpponentPlays(before, after, restored).map(event => ({ kind: 'play' as const, event })),
    ...newDamageEvents(before, after, restored).map(event => ({ kind: 'damage' as const, event })),
  ].sort((left, right) => (left.event.order ?? left.event.sequence) - (right.event.order ?? right.event.sequence));
  const result: BattlePresentation[] = [];
  for (const entry of entries) {
    if (entry.kind === 'play') { result.push(entry); continue; }
    const previous = result.at(-1);
    const event = entry.event;
    if (event.damageType === 'combat' && event.attack?.id && previous?.kind === 'damage'
      && previous.events.length < 4 && previous.events[0].damageType === 'combat'
      && previous.events[0].attack?.id === event.attack.id) previous.events.push(event);
    else result.push({ kind: 'damage', events: [event] });
  }
  return result;
}

/** Only native, public play events can start a spotlight. Never infer a play
 * from an opponent hand, discarded card, control change or zone movement. */
export function newOpponentPlays(before: GameView | null, after: GameView, restored = false): PublicPlayEvent[] {
  if (restored || !before || before.id !== after.id || before.viewerId !== after.viewerId || after.version <= before.version) return [];
  const previousSequence = Math.max(0, ...(before.publicPlayEvents || []).map(event => event.sequence));
  const seen = new Set<string>();
  return (after.publicPlayEvents || []).filter(event => {
    if (!Number.isSafeInteger(event.sequence) || event.sequence <= previousSequence || seen.has(event.id)
      || event.playerId === after.viewerId || !['human', 'bot'].includes(event.playerId)
      || !['play', 'deploy'].includes(event.kind) || !event.card?.uuid || event.card.hidden) return false;
    seen.add(event.id);
    return true;
  }).sort((left, right) => left.sequence - right.sequence);
}

/** Presentation only: do not put a queued card on the table ahead of its
 * spotlight. The full authoritative checkpoint is already saved by the client;
 * actions stay locked until the complete, unchanged server view is displayed. */
export function withUnrevealedPlaysHidden(view: GameView, pending: readonly PublicPlayEvent[], revealedIds: ReadonlySet<string> = new Set(), before?: GameView): GameView {
  if (!pending.length) return view;
  const ids = new Set(pending.map(event => event.card.uuid).filter(id => !revealedIds.has(id)));
  const visible = (cards: Card[]): Card[] => cards.filter(card => !ids.has(card.uuid)).map(card => ({
    ...card,
    ...(card.upgrades ? { upgrades: visible(card.upgrades) } : {}),
    ...(card.captured ? { captured: visible(card.captured) } : {}),
  }));
  // A queued deployment must not flip the commander thumbnail before its
  // spotlight, even when an earlier card in the same response is now visible.
  const priorLeaders = new Map(before?.id === view.id
    ? Object.values(before.players).flatMap(player => [player.leader, ...player.leaders])
      .filter(card => !card.hidden).map(card => [card.uuid, card] as const)
    : []);
  const visibleLeader = (card: Card): Card => !ids.has(card.uuid) ? card : priorLeaders.get(card.uuid) || {
    ...card, deployed: false, image: card.frontImage || card.image, text: card.frontText || card.text,
  };
  const players = Object.fromEntries(Object.entries(view.players).map(([id, player]) => [id, {
    ...player, base: visible([player.base])[0] || player.base,
    leader: visibleLeader(player.leader), leaders: player.leaders.map(visibleLeader),
    ground: visible(player.ground), space: visible(player.space), discard: visible(player.discard),
  }])) as GameView['players'];
  return { ...view, players };
}
