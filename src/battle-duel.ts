import type { Card, PublicDamageEvent } from './types';

/** What a card on the table does in the exchange being shown above it. */
export type DuelRole = 'strike' | 'hit' | 'clash';
export type Duel = { key: string; roles: Record<string, DuelRole> };

/** Roles come only from the native events of one exchange: a source strikes,
 * a target is hit, and a card that does both (combat with return damage)
 * clashes. A hidden card is never marked. */
export function duelRoles(events: readonly PublicDamageEvent[] | null | undefined): Duel | null {
  if (!events?.length) return null;
  const roles: Record<string, DuelRole> = {};
  const mark = (card: Card | undefined, role: 'strike' | 'hit') => {
    if (!card || card.hidden || !card.uuid) return;
    const current = roles[card.uuid];
    roles[card.uuid] = current && current !== role ? 'clash' : role;
  };
  for (const event of events) {
    mark(event.targetCard, 'hit');
    for (const source of event.sourceCards?.length ? event.sourceCards : event.sourceCard ? [event.sourceCard] : []) mark(source, 'strike');
    // The attacker belongs to its own attack even when its damage was prevented.
    if (event.damageType === 'combat') mark(event.attack?.attacker, 'strike');
  }
  return { key: events.map(event => event.id).join('|'), roles };
}
