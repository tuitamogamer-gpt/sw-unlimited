import type { Card, GameView } from './types';

export const BATTLE_EVENT_DURATION_MS = 2000;
export type BattleEventKind = 'enter' | 'attach' | 'damage' | 'heal' | 'shieldBreak' | 'defeat' | 'draw';
export type BattleEventZone = 'base' | 'ground' | 'space' | 'attachment' | 'hand';
export type BattleEvent = {
  id: string;
  kind: BattleEventKind;
  cardId: string;
  playerId: string;
  subjectId?: string;
  cardName?: string;
  amount?: number;
  zone: BattleEventZone;
  startedAt: number;
  expiresAt: number;
};
type VisibleCardState = {
  id: string;
  playerId: string;
  zone: BattleEventZone;
  parentId?: string;
  name?: string;
  damage: number;
  shield: boolean;
};
export type BattleSnapshot = {
  id: string;
  version: number;
  viewerId: string;
  cards: ReadonlyMap<string, VisibleCardState>;
  hand: ReadonlyMap<string, VisibleCardState>;
  discardIds: ReadonlySet<string>;
  deckCount: number;
  messages: readonly string[];
};
export type BattleFeedback = {
  added: ReadonlySet<string>;
  damaged: ReadonlySet<string>;
  healed: ReadonlySet<string>;
  baseChanges: Record<string, number>;
  message: string;
  events: readonly BattleEvent[];
  byCard: Record<string, BattleEvent[]>;
};

const nonnegative = (value: number | undefined) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;

/** Copy only public battlefield data and the viewer's own visible hand. */
export function captureBattleSnapshot(view: GameView): BattleSnapshot {
  const cards = new Map<string, VisibleCardState>();
  const hand = new Map<string, VisibleCardState>();
  const discardIds = new Set<string>();
  const copy = (card: Card | undefined, playerId: string, zone: BattleEventZone, parentId?: string): VisibleCardState | null => {
    if (!card || card.hidden || typeof card.uuid !== 'string' || !card.uuid) return null;
    const definition = card as Card & { internalName?: string };
    return { id: card.uuid, playerId, zone, parentId, name: card.name, damage: nonnegative(card.damage),
      shield: definition.internalName === 'shield' || card.name?.toLowerCase() === 'shield' };
  };
  const visit = (card: Card | undefined, playerId: string, zone: BattleEventZone, parentId?: string, depth = 0) => {
    const visible = copy(card, playerId, zone, parentId);
    if (!visible || !card || depth > 4) return;
    cards.set(visible.id, visible);
    for (const upgrade of card.upgrades || []) visit(upgrade, playerId, 'attachment', visible.id, depth + 1);
  };
  for (const [playerId, player] of Object.entries(view.players)) {
    visit(player.base, playerId, 'base');
    for (const card of player.ground) visit(card, playerId, 'ground');
    for (const card of player.space) visit(card, playerId, 'space');
    // Defeat feedback is only inferred from a card's actual public destination.
    for (const card of player.discard) if (card && !card.hidden && card.uuid) discardIds.add(card.uuid);
    if (playerId === view.viewerId) {
      for (const card of player.hand) {
        const visible = copy(card, playerId, 'hand');
        if (visible) hand.set(visible.id, visible);
      }
    }
  }
  const viewer = view.players[view.viewerId as keyof GameView['players']];
  return { id: view.id, version: view.version, viewerId: view.viewerId, cards, hand, discardIds,
    deckCount: viewer?.deckCount ?? 0,
    messages: view.log.map(entry => typeof entry === 'string' ? entry : entry.text || entry.message || '') };
}

/** These are observed state deltas, not a replacement for the rules event log. */
export function diffBattleSnapshots(before: BattleSnapshot | null, after: BattleSnapshot, now: number, { reset = false }: { reset?: boolean } = {}): BattleEvent[] {
  if (reset || !before || before.id !== after.id || before.viewerId !== after.viewerId || before.version >= after.version) return [];
  const events: BattleEvent[] = [];
  const add = (kind: BattleEventKind, card: VisibleCardState, options: Partial<Pick<BattleEvent, 'cardId' | 'subjectId' | 'amount'>> = {}) => {
    const cardId = options.cardId || card.id;
    events.push({ id: `${after.id}:${after.version}:${kind}:${cardId}${options.subjectId ? `:${options.subjectId}` : ''}`,
      kind, cardId, playerId: card.playerId, cardName: card.name, zone: card.zone,
      startedAt: now, expiresAt: now + BATTLE_EVENT_DURATION_MS, ...options });
  };
  for (const card of after.cards.values()) {
    const prior = before.cards.get(card.id);
    if (card.zone === 'attachment') {
      if (card.parentId && (!prior || prior.parentId !== card.parentId)) add('attach', card, { cardId: card.parentId, subjectId: card.id });
      continue;
    }
    const enteredArena = card.zone !== 'base' && (!prior || prior.zone === 'attachment' || prior.zone === 'base');
    if (enteredArena) add('enter', card);
    if (!prior || prior.zone === 'attachment' || (prior.zone === 'base') !== (card.zone === 'base')) {
      // One HTTP result can include entry and an immediate opposing response.
      // The new arena card's actual damage counter is still observable.
      if (enteredArena && card.damage > 0) add('damage', card, { amount: card.damage });
      continue;
    }
    // Max-HP buffs, upgrade removal and other stat changes are not damage.
    const delta = card.damage - prior.damage;
    if (delta > 0) add('damage', card, { amount: delta });
    if (delta < 0) add('heal', card, { amount: -delta });
  }
  for (const card of before.cards.values()) {
    if (after.cards.has(card.id)) continue;
    const survivingHost = card.parentId ? after.cards.get(card.parentId) : undefined;
    if (card.zone === 'attachment' && card.shield && card.parentId && survivingHost && survivingHost.zone !== 'attachment') {
      add('shieldBreak', card, { cardId: card.parentId, subjectId: card.id, amount: 1 });
    } else if ((card.zone === 'ground' || card.zone === 'space') && after.discardIds.has(card.id)) {
      add('defeat', card);
    }
  }
  if (after.deckCount < before.deckCount) {
    for (const card of after.hand.values()) {
      if (!before.hand.has(card.id) && !before.cards.has(card.id) && !before.discardIds.has(card.id)) add('draw', card);
    }
  }
  return events;
}

/** A fresh response must not erase another card's still-running feedback. */
export function mergeBattleEvents(current: readonly BattleEvent[], incoming: readonly BattleEvent[], now: number): BattleEvent[] {
  const active = new Map<string, BattleEvent>();
  for (const event of [...current, ...incoming]) {
    if (event.expiresAt > now && !active.has(event.id)) active.set(event.id, event);
  }
  return [...active.values()];
}

export function summarizeBattleEvents(events: readonly BattleEvent[], message = ''): BattleFeedback {
  const added = new Set<string>(), damaged = new Set<string>(), healed = new Set<string>();
  const byCard: Record<string, BattleEvent[]> = {};
  const baseChanges: Record<string, number> = {};
  for (const event of events) {
    (byCard[event.cardId] ||= []).push(event);
    if (event.kind === 'enter' || event.kind === 'draw') added.add(event.cardId);
    if (event.kind === 'attach' && event.subjectId) added.add(event.subjectId);
    if (event.kind === 'damage') damaged.add(event.cardId);
    if (event.kind === 'heal') healed.add(event.cardId);
    if (event.zone === 'base' && (event.kind === 'damage' || event.kind === 'heal')) {
      baseChanges[event.playerId] = (baseChanges[event.playerId] || 0) + (event.kind === 'damage' ? -1 : 1) * (event.amount || 0);
    }
  }
  return { added, damaged, healed, baseChanges, message, events, byCard };
}

export function latestBattleMessage(before: BattleSnapshot, after: BattleSnapshot): string {
  const recent = after.messages.slice(before.messages.length).reverse();
  const important = /\b(?:plays|attacks|uses|deploys|captures|defeats|heals)\b/i;
  return recent.find(entry => /^AI\b/.test(entry) && important.test(entry))
    || recent.find(entry => important.test(entry)) || recent.find(entry => /claims initiative|has won|Round:/.test(entry)) || '';
}
