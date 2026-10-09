import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, ChevronRight, CircleHelp, Crosshair, Eye, Layers3, RotateCcw, Shield, Swords, X, Zap, ZoomIn, ZoomOut } from 'lucide-react';
import type { Card, GameAction } from '../types';
import { t } from '../i18n';
import { activeCardFace, CardArtwork, cardType, isLandscapeCard } from './CardArtwork';
import type { CardFace } from './CardArtwork';
import { useCardHover } from './CardHoverPreview';
import './inspectors.css';

export interface CardInspectorProps {
  card: Card;
  onInspect: (card: Card) => void;
  /** A legal action from the current view, resolved again by the parent before submission. */
  action?: GameAction;
  /** The parent closes the inspector before submitting the action. */
  onAction?: (action: GameAction) => void;
  busy?: boolean;
  onBack?: () => void;
}

const ZONES: Record<string, string> = {
  hand: 'Hand', resource: 'Resources', groundArena: 'Ground arena', spaceArena: 'Space arena',
  discard: 'Discard pile', base: 'Base zone', capture: 'Captured', outsideTheGame: 'Outside the game',
};
const TYPE_LABELS = { leader: 'Leader', base: 'Base', unit: 'Unit', event: 'Event', upgrade: 'Upgrade', card: 'Card' };

function RulesCopy({ text }: { text: string }) {
  // Card data is plain text. Never interpret card text as markup or execute embedded content.
  const paragraphs = text.replace(/\\n/g, '\n').split(/\n+/).map(line => line.trim()).filter(Boolean);
  return <div className="ci-rules-copy">{paragraphs.map((paragraph, index) => {
    const heading = /^((?:When Played|When Defeated|On Attack|Action|Epic Action|Constant|On Defense)(?:\s*\[[^\]]*\])?):\s*(.*)$/i.exec(paragraph);
    return <p key={index}>{heading ? <><strong>{heading[1]}:</strong> {heading[2]}</> : paragraph}</p>;
  })}</div>;
}

function AttachedCards({ title, cards, onInspect }: { title: string; cards: Card[]; onInspect: (card: Card) => void }) {
  const { bindCardHover } = useCardHover();
  if (!cards.length) return null;
  return <section className="ci-attached" aria-label={t(title)}>
    <div className="ci-section-heading"><h3>{t(title)}</h3><span>{cards.length}</span></div>
    <div className="ci-attached-list">{cards.map((card, index) => <button {...bindCardHover(card)} type="button" key={card.uuid || card.id || index} className="ci-attached-card" disabled={card.hidden} onClick={() => onInspect(card)} aria-label={card.hidden ? t('Hidden card') : t('Inspect {name}', { name: card.name || '' })}>
      <span className="ci-attached-art"><CardArtwork card={card} decorative /></span>
      <span><strong>{card.hidden ? t('Hidden card') : card.name || t('Card')}</strong>{!card.hidden && card.subtitle && <small>{card.subtitle}</small>}</span>
      {!card.hidden && <ChevronRight size={15} />}
    </button>)}</div>
  </section>;
}

export function CardInspector({ card, onInspect, action, onAction, busy = false, onBack }: CardInspectorProps) {
  const activeFace = activeCardFace(card);
  const [face, setFace] = useState<CardFace>(activeFace);
  const [zoomed, setZoomed] = useState(false);
  const artViewport = useRef<HTMLDivElement>(null);
  const type = cardType(card);
  const isLeader = type === 'leader' || !!card.backImage;
  const landscape = isLandscapeCard(card, face);
  const inGame = !!card.zone;
  const effectiveCost = card.playCost ?? card.cost;
  const hasAdjustedCost = card.playCost != null && card.cost != null && card.playCost !== card.cost;
  const shownText = face === activeFace ? card.text : face === 'front' ? card.frontText : card.deployText;
  const text = shownText ?? (face === 'back' ? card.deployText : card.frontText || card.text) ?? '';
  const epicText = face === 'front' && card.epicAction ? card.epicAction.replace(/^Epic Action:\s*/i, '').trim() : '';
  const health = card.remainingHp ?? (card.hp != null ? card.hp - (card.damage || 0) : undefined);
  const keywordNames = useMemo(() => (card.keywords || []).map(keyword => typeof keyword === 'string' ? keyword : `${keyword.name}${keyword.value != null ? ` ${keyword.value}` : ''}${keyword.cost != null ? ` (${keyword.cost})` : ''}`), [card.keywords]);
  const actionLabel = action?.abilityLabel === 'Ambush' ? 'Use Ambush' : action?.intent === 'resource' ? card.selected ? 'Unselect resource' : 'Make a resource' : action?.intent === 'play' ? 'Play this card' : action?.intent === 'attack' ? 'Attack with this unit' : action?.intent === 'deploy' ? 'Deploy this leader' : action?.intent === 'ability' ? 'Use this ability' : 'Select this card';

  useEffect(() => { setFace(activeFace); setZoomed(false); }, [card.uuid, card.id, card.image, activeFace]);
  useEffect(() => { artViewport.current?.scrollTo({ left: 0, top: 0 }); }, [face, zoomed]);

  if (card.hidden) return <div className="ci-hidden"><Eye size={32} /><h3>{t('Hidden card')}</h3><p>{t('This card is not visible to you.')}</p>{onBack && <button className="secondary-button" onClick={onBack}><ArrowLeft size={15} />{t('Back')}</button>}</div>;

  return <div className={`ci-root ${landscape ? 'ci-landscape' : 'ci-portrait'}`} data-card-code={card.code}>
    {onBack && <div className="ci-breadcrumb"><button type="button" onClick={onBack}><ArrowLeft size={14} />{t('Back to previous card')}</button></div>}
    <div className="ci-layout">
      <div className="ci-art-column">
        <div className={`ci-art-stage ${zoomed ? 'is-zoomed' : ''}`}>
          <div ref={artViewport} className="ci-art-viewport" tabIndex={zoomed ? 0 : -1} aria-label={t('Card artwork')} onKeyDown={event => { if (event.key === 'Escape' && zoomed) { event.stopPropagation(); setZoomed(false); } }}>
            <button type="button" className="ci-art-button" onClick={() => setZoomed(value => !value)} aria-pressed={zoomed} aria-label={t(zoomed ? 'Zoom out' : 'Zoom in')}>
              <CardArtwork card={card} face={face} eager />
            </button>
          </div>
          <button className="ci-zoom-toggle" type="button" aria-label={t(zoomed ? 'Zoom out' : 'Zoom in')} aria-pressed={zoomed} onClick={() => setZoomed(value => !value)}>{zoomed ? <ZoomOut size={17} /> : <ZoomIn size={17} />}</button>
        </div>
        <div className="ci-art-controls">
          {card.backImage ? <div className="ci-face-switch" role="group" aria-label={t('Card side')}>
            <button type="button" className={face === 'front' ? 'active' : ''} aria-pressed={face === 'front'} onClick={() => setFace('front')}>{t(isLeader ? 'Leader side' : 'Front')}</button>
            <button type="button" className={face === 'back' ? 'active' : ''} aria-pressed={face === 'back'} onClick={() => setFace('back')}>{t(isLeader ? 'Unit side' : 'Back')}</button>
          </div> : <span className="ci-art-code">{card.code || t(TYPE_LABELS[type])}</span>}
          <span className="ci-art-hint">{zoomed ? t('Scroll or drag to explore the artwork.') : t('Tap artwork to zoom')}</span>
        </div>
        {inGame && card.backImage && <div className="ci-current-face"><span className="signal-dot" />{t('In play: {side}', { side: t(activeFace === 'back' ? 'Unit side' : 'Leader side') })}</div>}
      </div>

      <div className="ci-reading-column">
        <div className="ci-identity"><div className="ci-kicker"><span>{t(TYPE_LABELS[type])}</span><span>{card.code}</span></div><h2>{card.name}</h2>{card.subtitle && <p>{card.subtitle}</p>}</div>
        {card.aspects?.length ? <div className="ci-aspects" aria-label={t('Aspects')}>{card.aspects.map((aspect, index) => <span key={`${aspect}-${index}`}><i className={`aspect aspect-${aspect.toLowerCase()}`} />{t(aspect.charAt(0).toUpperCase() + aspect.slice(1))}</span>)}</div> : null}
        <div className="ci-stats">
          {effectiveCost != null && <div className="ci-stat"><Zap size={17} /><strong>{isLeader ? card.cost ?? effectiveCost : effectiveCost}</strong><span>{t(isLeader && face === 'front' ? 'Deploy threshold' : 'Resource cost')}</span>{hasAdjustedCost && !isLeader && <small>{t('Printed: {cost}', { cost: card.cost! })}</small>}</div>}
          {card.power != null && <div className="ci-stat"><Swords size={17} /><strong>{card.power}</strong><span>{t('Power')}</span></div>}
          {card.hp != null && <div className={`ci-stat ${(card.damage || 0) > 0 ? 'ci-stat-damaged' : ''}`}><Shield size={17} /><strong>{health}<small> / {card.hp}</small></strong><span>{t('Health')}</span>{(card.damage || 0) > 0 && <small>{t('{count} damage', { count: card.damage! })}</small>}</div>}
        </div>
        {inGame && <div className="ci-state" aria-label={t('Current state')}><span>{t(ZONES[card.zone || ''] || card.zone || '')}</span>{card.controllerId && <span>{t(card.controllerId === 'human' ? 'Your card' : 'Opponent card')}</span>}{card.exhausted != null && <span className={card.exhausted ? 'ci-exhausted' : 'ci-ready'}>{card.exhausted ? <RotateCcw size={12} /> : <Check size={12} />}{t(card.exhausted ? 'Exhausted' : 'Ready')}</span>}</div>}
        <section className="ci-abilities" aria-label={t('Card abilities')}>
          <div className="ci-section-heading"><h3>{t('Abilities')}</h3>{card.backImage && <span>{t(face === 'front' ? 'Leader side' : 'Unit side')}</span>}</div>
          {keywordNames.length > 0 && <div className="ci-keywords">{keywordNames.map((keyword, index) => <span key={`${keyword}-${index}`}>{keyword}</span>)}</div>}
          {text.trim() ? <RulesCopy text={text} /> : <p className="ci-no-text">{t('No additional rules text.')}</p>}
          {epicText && !text.includes(card.epicAction || '') && <div className="ci-epic"><div><Crosshair size={14} /><strong>{t('Epic Action')}</strong></div><RulesCopy text={epicText} /></div>}
        </section>
        {card.pilotText && <section className="ci-piloting" aria-label={t('Pilot ability')}><div className="ci-section-heading"><h3>{t(type === 'upgrade' ? 'Pilot bonuses' : 'As a pilot')}</h3></div>{(card.upgradePower != null || card.upgradeHp != null) && <div className="ci-pilot-bonuses">{card.upgradePower != null && <span><Swords size={13} />{card.upgradePower >= 0 ? '+' : ''}{card.upgradePower} {t('Power')}</span>}{card.upgradeHp != null && <span><Shield size={13} />{card.upgradeHp >= 0 ? '+' : ''}{card.upgradeHp} {t('Health')}</span>}</div>}{card.pilotText.trim() !== text.trim() && <RulesCopy text={card.pilotText} />}</section>}
        {card.traits?.length ? <div className="ci-traits"><Layers3 size={13} /><span>{card.traits.map(trait => trait.replace(/\b\w/g, letter => letter.toUpperCase())).join(' · ')}</span></div> : null}
        {!!card.playOptions?.length && (card.playOptions.length > 1 || hasAdjustedCost) && <section className="ci-play-options"><div className="ci-section-heading"><h3>{t('Play options')}</h3></div>{card.playOptions.map((option, index) => <div className={option.legal ? 'ci-option-legal' : ''} key={`${option.title}-${index}`}><span>{option.legal ? <Check size={13} /> : <X size={13} />}<strong>{t(option.title)}</strong>{!option.legal && option.reason && <small>{t(option.reason)}</small>}</span><span><Zap size={13} />{option.cost}</span></div>)}</section>}
        {card.playBlockedReason && !action && <div className="ci-reason"><CircleHelp size={16} /><p>{t(card.playBlockedReason)}</p></div>}
        <AttachedCards title="Attached upgrades" cards={card.upgrades || []} onInspect={onInspect} />
        <AttachedCards title="Captured units" cards={card.captured || []} onInspect={onInspect} />
        {card.unimplemented && <div className="ci-reason"><CircleHelp size={16} /><p>{t('This card has no available script in the game engine.')}</p></div>}
      </div>
    </div>
    {action && onAction && <div className="ci-action-bar"><div><span className="eyebrow">{t('AVAILABLE NOW')}</span><p>{t(action.intent === 'resource' ? card.selected ? 'Remove this card from the resource selection.' : 'This puts the card into your resource zone.' : action.intent === 'select' ? 'Choose this card for the current effect.' : 'Continue with this card on the battlefield.')}</p></div><button type="button" className="primary-button" disabled={busy || action.disabled} data-card-id={card.uuid} data-inspector-action={action.intent || 'select'} onClick={() => onAction(action)}>{t(actionLabel)}<ArrowRight size={16} /></button></div>}
  </div>;
}

export default CardInspector;
