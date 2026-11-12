import { useContext } from 'react';
import { ArrowUpRight, Shield, X } from 'lucide-react';
import { BattleFeedbackContext, DuelContext } from '../battle-feedback';
import type { Card } from '../types';
import { phaseName, t } from '../i18n';
import { cardImage } from './CardArtwork';

/** Stable cards keep focus; only the brief visual effects remount on each hit. */
export function CardEffects({ cardId }: { cardId: string }) {
  const { byCard } = useContext(BattleFeedbackContext);
  const events = (byCard[cardId] || []).filter(event => event.kind !== 'defeat');
  if (!events.length) return null;
  return <span className="card-fx-layer" aria-hidden="true">
    {events.map(event => <span key={event.id} className={`card-fx card-fx-${event.kind}`}
      data-fx-id={event.id} data-fx-kind={event.kind} data-fx-card-id={event.cardId} data-fx-amount={event.amount}
      data-feedback-id={event.id} data-feedback-kind={event.kind}>
      <i className="card-fx-ring" />
      {(event.kind === 'damage' || event.kind === 'heal') && <strong className="card-fx-value">{event.kind === 'damage' ? '−' : '+'}{event.amount}</strong>}
      {event.kind === 'shieldBreak' && <span className="card-fx-symbol"><Shield className="card-fx-icon" size={27} /><small className="card-fx-label">{t('Shield lost')}</small></span>}
      {event.kind === 'attach' && <ArrowUpRight className="card-fx-icon" size={22} />}
    </span>)}
  </span>;
}

/** A removed unit has no card element left to animate. Use the arena divider. */
export function ArenaDefeats({ kind }: { kind: 'ground' | 'space' }) {
  const { events } = useContext(BattleFeedbackContext);
  const defeats = events.filter(event => event.kind === 'defeat' && event.zone === kind);
  const latest = defeats.at(-1);
  if (!latest) return null;
  return <span className="arena-defeat-token" key={latest.id} data-fx-kind="defeat" data-fx-id={latest.id}
    title={t('{card} defeated', { card: latest.cardName || t('Unit') })}>
    <X size={11} /><span>{t('Defeated')} · {latest.cardName || t('Unit')}{defeats.length > 1 ? ` +${defeats.length - 1}` : ''}</span>
  </span>;
}

/** Rings a card that takes part in the exchange shown above the table. The
 * ring is keyed per exchange, so a card hit twice in a row is marked twice,
 * and it never moves or resizes the card it sits on. */
export function DuelMark({ cardId }: { cardId?: string }) {
  const duel = useContext(DuelContext);
  const role = cardId ? duel?.roles[cardId] : undefined;
  if (!duel || !role) return null;
  return <i key={duel.key} className={`card-duel card-duel-${role}`} data-duel-role={role} aria-hidden="true" />;
}

/** The last public face of a unit that was just defeated, drawn where it stood. */
export function DefeatGhost({ card, enemy = false }: { card: Card; enemy?: boolean }) {
  const image = cardImage(card);
  return <div className={`defeat-ghost${enemy ? ' enemy-ghost' : ''}`} aria-hidden="true">
    <span className="defeat-ghost-face">{image && <img src={image} alt="" loading="eager" decoding="sync" draggable={false} />}</span>
    <i className="defeat-ghost-flash" />
    <X className="defeat-ghost-mark" size={30} strokeWidth={2.4} />
  </div>;
}

/** Announces a new round across the arenas. It is decoration over the round
 * label in the top bar, so it takes no input and is hidden from assistive
 * technology. */
export function RoundBanner({ round }: { round: number }) {
  return <div className="round-banner" data-round-banner={round} aria-hidden="true">
    <span className="round-banner-copy"><small>{t('ROUND')}</small><strong>{String(round).padStart(2, '0')}</strong><i /><em>{phaseName('action')}</em></span>
  </div>;
}
