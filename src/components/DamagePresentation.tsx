import { ArrowLeft, ArrowRight, Layers3, Orbit, Swords, Zap } from 'lucide-react';
import type { Card, PublicDamageEvent } from '../types';
import { t } from '../i18n';
import { CardArtwork, isLandscapeCard } from './CardArtwork';
import './damage-presentation.css';

export interface DamagePresentationProps {
  /** Native public damage events from one exchange; the parent controls the 1.6s hold. */
  events: PublicDamageEvent[];
}

const DAMAGE_LABELS = {
  combat: 'Combat damage', ability: 'Ability damage', overwhelm: 'Overwhelm', excess: 'Excess damage', other: 'Damage',
};

function visibleName(card?: Card) {
  return card?.hidden ? t('Hidden card') : card?.name || t('Game effect');
}

function sourceCards(event: PublicDamageEvent): Card[] {
  const cards = event.sourceCards?.length ? event.sourceCards : event.sourceCard ? [event.sourceCard] : [];
  return cards.filter((card, index) => cards.findIndex(candidate => candidate.uuid === card.uuid) === index);
}

function sourceName(event: PublicDamageEvent) {
  const cards = sourceCards(event);
  return cards.length ? cards.map(card => visibleName(card)).join(' + ') : t('Game effect');
}

function retaliates(event: PublicDamageEvent) {
  return event.damageType === 'combat' && event.targetCard.uuid === event.attack?.attacker.uuid;
}

function DamageAmount({ events, className = '' }: { events: PublicDamageEvent[]; className?: string }) {
  if (!events.length) return null;
  const amount = events.reduce((total, event) => total + event.amount, 0);
  return <strong
    className={`damage-presentation-amount ${className}`}
    data-damage-amount={amount}
    data-damage-target-id={events[0].targetCard.uuid}
    data-damage-event-ids={events.map(event => event.id).join(',')}
  ><span>−{amount}</span><small>{t('damage')}</small></strong>;
}

function DamageActor({ card, role, hits }: { card?: Card; role: string; hits: PublicDamageEvent[] }) {
  return <div className={`damage-presentation-actor${hits.length ? ' takes-damage' : ''}`} data-damage-card-id={card?.uuid}>
    <span className="damage-presentation-role">{t(role)}</span>
    <div className={`damage-presentation-card${card && isLandscapeCard(card) ? ' is-landscape' : ''}`}>
      {card ? <CardArtwork card={card} decorative eager /> : <span className="damage-presentation-effect"><Orbit size={30} strokeWidth={1.2} /></span>}
      {hits.length > 0 && <><i className="damage-presentation-burst" /><i className="damage-presentation-flash" /></>}
      <DamageAmount events={hits} />
    </div>
    <strong className="damage-presentation-name">{visibleName(card)}</strong>
  </div>;
}

function DamageBeam({ amount, reverse = false }: { amount: number; reverse?: boolean }) {
  if (amount <= 0) return null;
  return <span className={`damage-presentation-beam${reverse ? ' is-return' : ''}`} data-damage-direction={reverse ? 'return' : 'forward'}>
    <span className="damage-presentation-beam-copy">{reverse ? <ArrowLeft size={17} /> : null}<b>{amount}</b>{!reverse ? <ArrowRight size={17} /> : null}</span>
    <i className="damage-presentation-beam-track"><i className="damage-presentation-bolt" /></i>
  </span>;
}

/** Larger exchanges retain each real event amount rather than inventing a split among sources. */
function DamageRows({ events }: { events: PublicDamageEvent[] }) {
  return <div className="damage-presentation-rows">{events.map(event => {
    const sources = sourceCards(event);
    return <div className={`damage-presentation-row${retaliates(event) ? ' is-return' : ''}`} key={event.id} data-damage-row={event.id}>
      <span className="damage-presentation-row-art" data-damage-card-id={sources.length === 1 ? sources[0].uuid : undefined}>
        {sources.length === 1 ? <CardArtwork card={sources[0]} decorative eager /> : sources.length > 1 ? <Layers3 size={22} /> : <Zap size={22} />}
      </span>
      <div className="damage-presentation-row-copy"><span>{sources.length > 1 ? t('Multiple sources') : sourceName(event)}</span><strong><ArrowRight size={12} />{visibleName(event.targetCard)}</strong></div>
      <span className="damage-presentation-row-art takes-damage" data-damage-card-id={event.targetCard.uuid}><CardArtwork card={event.targetCard} decorative eager /><i className="damage-presentation-flash" /></span>
      <DamageAmount events={[event]} />
      <span className="damage-presentation-row-beam" aria-hidden="true"><i className="damage-presentation-bolt" /></span>
    </div>;
  })}</div>;
}

function DamageExchange({ events }: DamagePresentationProps) {
  const first = events[0];
  const attack = events.find(event => event.attack)?.attack;
  const isCombat = events.every(event => event.damageType === 'combat');
  const kinds = [...new Set(events.map(event => event.damageType))];
  const type = kinds.length === 1 ? kinds[0] : 'other';
  const allSources = events.flatMap(sourceCards);
  const source = isCombat && attack ? attack.attacker : sourceCards(first)[0];
  const target = isCombat && attack ? events.find(event => event.targetCard.uuid !== attack.attacker.uuid)?.targetCard || attack.defender || attack.defenders[0] : first.targetCard;
  const actorIds = new Set([...allSources.map(card => card.uuid), ...events.map(event => event.targetCard.uuid)]);
  const useRows = !target || source?.uuid === target.uuid || actorIds.size > 2 || events.some(event => sourceCards(event).length > 1) || !isCombat && events.some(event => event.targetCard.uuid !== target.uuid);
  const sourceHits = source ? events.filter(event => event.targetCard.uuid === source.uuid) : [];
  const targetHits = target ? events.filter(event => event.targetCard.uuid === target.uuid) : [];
  const hasReturnDamage = events.some(retaliates);
  const summary = events.map(event => t('{source} deals {amount} damage to {target}.', { source: sourceName(event), amount: event.amount, target: visibleName(event.targetCard) })).join(' ');

  return <div
    className={`damage-presentation${isCombat ? ' is-combat' : ''}${useRows ? ' has-damage-rows' : ''}`}
    data-damage-presentation=""
    data-damage-type={type}
    data-damage-event-ids={events.map(event => event.id).join(',')}
    data-damage-duration="1600"
    role="status"
    aria-live="polite"
    aria-atomic="true"
  >
    <span className="sr-only">{summary}{hasReturnDamage ? ` ${t('Defender deals damage back')}.` : ''}</span>
    <div className="damage-presentation-sheet" aria-hidden="true">
      <div className="damage-presentation-heading">{isCombat ? <Swords size={14} /> : <Zap size={14} />}<span>{t(DAMAGE_LABELS[type])}</span><i /></div>
      {useRows ? <DamageRows events={events} /> : <div className="damage-presentation-exchange">
        <DamageActor card={source} role={isCombat ? 'Attacker' : 'Source'} hits={sourceHits} />
        <div className="damage-presentation-path">
          <DamageBeam amount={targetHits.reduce((total, event) => total + event.amount, 0)} />
          <DamageBeam amount={sourceHits.reduce((total, event) => total + event.amount, 0)} reverse />
        </div>
        <DamageActor card={target} role={isCombat ? 'Defender' : 'Target'} hits={targetHits} />
      </div>}
      <div className="damage-presentation-caption">{hasReturnDamage ? <><ArrowLeft size={13} /><span>{t('Defender deals damage back')}</span></> : events.some(event => event.isIndirect) ? <span>{t('Indirect damage')}</span> : <span>{t('Damage resolved')}</span>}</div>
      <span className="damage-presentation-progress"><i /></span>
    </div>
  </div>;
}

/** Keyed exchanges restart impact graphics even for consecutive hits on the same card. */
export function DamagePresentation({ events }: DamagePresentationProps) {
  if (!events.length) return null;
  return <DamageExchange key={events.map(event => event.id).join('|')} events={events} />;
}
