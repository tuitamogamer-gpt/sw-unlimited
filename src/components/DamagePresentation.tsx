import type { CSSProperties } from 'react';
import { ArrowLeft, ArrowRight, Layers3, Orbit, Shield, Swords, X, Zap } from 'lucide-react';
import type { Card, PublicDamageEvent } from '../types';
import { t } from '../i18n';
import { CardArtwork, cardType, isLandscapeCard } from './CardArtwork';
import './damage-presentation.css';

export interface DamagePresentationProps {
  /** Native public damage events from one exchange; the parent controls the 1.6s hold. */
  events: PublicDamageEvent[];
  /** Units still in an arena once the whole response has resolved. A unit at
   * zero health that is missing from this set really left play. */
  survivorIds?: ReadonlySet<string>;
  /** The last exchange of a run of hits lifts the dimmed backdrop as it ends. */
  closing?: boolean;
  /** Seat of the person watching, to tell their cards from the opponent's. */
  viewerId?: string;
}

const DAMAGE_LABELS = {
  combat: 'Combat damage', ability: 'Ability damage', overwhelm: 'Overwhelm', excess: 'Excess damage', other: 'Damage',
};
const SPARKS = [0, 1, 2, 3, 4, 5, 6, 7];

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

function remainingHealth(card?: Card): number | undefined {
  if (!card || card.hidden || typeof card.hp !== 'number') return undefined;
  return typeof card.remainingHp === 'number' ? Math.max(0, card.remainingHp) : Math.max(0, card.hp - (card.damage || 0));
}

/** Every snapshot is taken after its own hit resolved and before a defeated
 * card leaves play, so the earlier health is derived from the first hit and
 * the final health is read from the last one. Nothing is estimated. */
function healthChange(hits: PublicDamageEvent[]): { before: number; after: number } | undefined {
  if (!hits.length) return undefined;
  const first = hits[0].targetCard;
  const after = remainingHealth(hits[hits.length - 1].targetCard);
  if (after === undefined || typeof first.hp !== 'number') return undefined;
  const earlierDamage = Math.max(0, (first.damage || 0) - hits[0].amount);
  return { before: Math.max(after, Math.min(first.hp, first.hp - earlierDamage)), after };
}

function leavesPlay(card: Card | undefined, health: { after: number } | undefined, survivorIds?: ReadonlySet<string>) {
  if (!card || !health || health.after > 0) return false;
  return cardType(card) === 'base' || !survivorIds || !survivorIds.has(card.uuid);
}

function DamageAmount({ events, className = '' }: { events: PublicDamageEvent[]; className?: string }) {
  if (!events.length) return null;
  const amount = events.reduce((total, event) => total + event.amount, 0);
  return <strong
    className={`damage-presentation-amount ${className}`}
    data-damage-amount={amount}
    data-damage-target-id={events[0].targetCard.uuid}
    data-damage-event-ids={events.map(event => event.id).join(',')}
  ><span>−{amount}</span><small>{t('Damage')}</small></strong>;
}

function ImpactEffects({ slash }: { slash: boolean }) {
  return <>
    <i className="damage-presentation-flash" />
    <i className="damage-presentation-burst" />
    {slash && <i className="damage-presentation-slash" />}
    <span className="damage-presentation-sparks">{SPARKS.map(spark => <i key={spark} style={{ '--spark': spark } as CSSProperties} />)}</span>
  </>;
}

/** Power and health as printed on the table; a hit shows the real change. */
function ActorStats({ card, hits }: { card?: Card; hits: PublicDamageEvent[] }) {
  const change = healthChange(hits);
  // A leader that has not deployed is not a unit yet: its unit-side numbers are not in play.
  const onTable = !!card && (cardType(card) !== 'leader' || !!card.deployed);
  const health = change ? change.after : onTable ? remainingHealth(card) : undefined;
  const power = onTable && card && !card.hidden && typeof card.power === 'number' && cardType(card) !== 'base' ? card.power : undefined;
  return <span className="damage-presentation-stats">
    {power !== undefined && <span className="damage-presentation-stat is-power"><Swords size={11} />{power}</span>}
    {health !== undefined && <span className={`damage-presentation-stat is-health${change ? ' is-hit' : ''}${change?.after === 0 ? ' is-lethal' : ''}`}>
      <Shield size={11} />
      {change && change.before !== change.after ? <><s>{change.before}</s><span className="damage-presentation-stat-next"><ArrowRight size={10} /><b>{change.after}</b></span></> : <b>{health}</b>}
    </span>}
  </span>;
}

function DamageActor({ card, role, hits, side, motion, slash, survivorIds, viewerId }: {
  card?: Card; role: string; hits: PublicDamageEvent[]; side: 'source' | 'target';
  motion: 'strike' | 'cast' | 'none'; slash: boolean; survivorIds?: ReadonlySet<string>; viewerId?: string;
}) {
  const defeated = leavesPlay(card, healthChange(hits), survivorIds);
  const landscape = !!card && isLandscapeCard(card);
  const owner = card && !card.hidden && card.controllerId && viewerId ? card.controllerId === viewerId ? 'is-friendly' : 'is-enemy' : '';
  const classes = ['damage-presentation-actor', `is-${side}`, owner, landscape ? 'is-wide' : '', hits.length ? 'takes-damage' : '',
    motion === 'strike' ? 'is-striking' : motion === 'cast' ? 'is-casting' : '', defeated ? 'is-defeated' : ''].filter(Boolean).join(' ');
  return <div className={classes} data-damage-card-id={card?.uuid}>
    <span className="damage-presentation-role">{owner && <i className="damage-presentation-owner" />}{t(role)}</span>
    <div className="damage-presentation-figure">
      <div className={`damage-presentation-card${landscape ? ' is-landscape' : ''}`}>
        <span className="damage-presentation-art">
          {card ? <CardArtwork card={card} decorative eager /> : <span className="damage-presentation-effect"><Orbit size={30} strokeWidth={1.2} /></span>}
        </span>
        {hits.length > 0 && <ImpactEffects slash={slash} />}
        <DamageAmount events={hits} />
        {defeated && <em className="damage-presentation-stamp">{t(card && cardType(card) === 'base' ? 'Destroyed' : 'Defeated')}</em>}
      </div>
    </div>
    <strong className="damage-presentation-name">{visibleName(card)}</strong>
    <ActorStats card={card} hits={hits} />
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
function DamageRows({ events, survivorIds }: { events: PublicDamageEvent[]; survivorIds?: ReadonlySet<string> }) {
  const stagger = events.length > 1 ? Math.min(110, Math.round(420 / (events.length - 1))) : 0;
  return <div className="damage-presentation-rows">{events.map((event, index) => {
    const sources = sourceCards(event);
    const defeated = leavesPlay(event.targetCard, healthChange([event]), survivorIds);
    return <div className={`damage-presentation-row${retaliates(event) ? ' is-return' : ''}${defeated ? ' is-defeated' : ''}`} key={event.id} data-damage-row={event.id}
      style={{ '--row-delay': `${index * stagger}ms` } as CSSProperties}>
      <span className="damage-presentation-row-art" data-damage-card-id={sources.length === 1 ? sources[0].uuid : undefined}>
        {sources.length === 1 ? <CardArtwork card={sources[0]} decorative eager /> : sources.length > 1 ? <Layers3 size={22} /> : <Zap size={22} />}
      </span>
      <div className="damage-presentation-row-copy"><span>{sources.length > 1 ? t('Multiple sources') : sourceName(event)}</span><strong><ArrowRight size={12} />{visibleName(event.targetCard)}</strong></div>
      <span className="damage-presentation-row-art takes-damage" data-damage-card-id={event.targetCard.uuid}><CardArtwork card={event.targetCard} decorative eager /><i className="damage-presentation-flash" />{defeated && <X className="damage-presentation-row-mark" size={18} />}</span>
      <DamageAmount events={[event]} />
      <span className="damage-presentation-row-beam" aria-hidden="true"><i className="damage-presentation-bolt" /></span>
    </div>;
  })}</div>;
}

function DamageExchange({ events, survivorIds, viewerId }: DamagePresentationProps) {
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
  // A real attack is a physical strike; every other source acts from where it is.
  const strikes = isCombat && !!attack;
  // Five damage or more, or a hit that removes a card, lands harder.
  const heavy = !useRows && (events.some(event => event.amount >= 5)
    || leavesPlay(target, healthChange(targetHits), survivorIds) || leavesPlay(source, healthChange(sourceHits), survivorIds));
  const ownBaseHit = !!viewerId && events.some(event => cardType(event.targetCard) === 'base' && event.targetCard.controllerId === viewerId);
  const summary = events.map(event => t('{source} deals {amount} damage to {target}.', { source: sourceName(event), amount: event.amount, target: visibleName(event.targetCard) })).join(' ');

  return <div
    className={`damage-presentation${isCombat ? ' is-combat' : ''}${useRows ? ' has-damage-rows' : ''}${strikes && hasReturnDamage ? ' is-clash' : ''}${heavy ? ' is-heavy' : ''}`}
    data-damage-presentation=""
    data-damage-type={type}
    data-damage-event-ids={events.map(event => event.id).join(',')}
    data-damage-duration="1600"
    role="status"
    aria-live="polite"
    aria-atomic="true"
  >
    {ownBaseHit && <i className="damage-presentation-vignette" aria-hidden="true" />}
    <span className="sr-only">{summary}{hasReturnDamage ? ` ${t('Defender deals damage back')}.` : ''}</span>
    <div className="damage-presentation-sheet" aria-hidden="true">
      <div className="damage-presentation-heading">{isCombat ? <Swords size={14} /> : <Zap size={14} />}<span>{t(DAMAGE_LABELS[type])}</span><i /></div>
      {useRows ? <DamageRows events={events} survivorIds={survivorIds} /> : <div className="damage-presentation-exchange">
        <DamageActor card={source} role={isCombat ? 'Attacker' : 'Source'} hits={sourceHits} side="source" motion={strikes ? 'strike' : 'cast'} slash={strikes} survivorIds={survivorIds} viewerId={viewerId} />
        <div className="damage-presentation-path">
          <DamageBeam amount={targetHits.reduce((total, event) => total + event.amount, 0)} />
          {strikes && <i className="damage-presentation-clash" />}
          <DamageBeam amount={sourceHits.reduce((total, event) => total + event.amount, 0)} reverse />
        </div>
        <DamageActor card={target} role={isCombat ? 'Defender' : 'Target'} hits={targetHits} side="target" motion={strikes && hasReturnDamage ? 'strike' : 'none'} slash={strikes} survivorIds={survivorIds} viewerId={viewerId} />
      </div>}
      <div className="damage-presentation-caption">{hasReturnDamage ? <><ArrowLeft size={13} /><span>{t('Defender deals damage back')}</span></> : events.some(event => event.isIndirect) ? <span>{t('Indirect damage')}</span> : <span>{t('Damage resolved')}</span>}</div>
      <span className="damage-presentation-progress"><i /></span>
    </div>
  </div>;
}

/** The dimmed table stays in place for a run of hits while each keyed exchange
 * restarts its own impact graphics, even for consecutive hits on one card. */
export function DamagePresentation({ events, survivorIds, closing = false, viewerId }: DamagePresentationProps) {
  if (!events.length) return null;
  return <>
    <i className={`damage-presentation-backdrop${closing ? ' is-closing' : ''}`} aria-hidden="true" />
    <DamageExchange key={events.map(event => event.id).join('|')} events={events} survivorIds={survivorIds} viewerId={viewerId} />
  </>;
}
