import { useContext } from 'react';
import { ArrowUpRight, Shield, X } from 'lucide-react';
import { BattleFeedbackContext } from '../battle-feedback';
import { t } from '../i18n';

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
