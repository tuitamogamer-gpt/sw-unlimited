import type { Card, GameView, PublicPlayEvent } from './types';

export const OPPONENT_PREVIEW_MS = 3000;

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
