import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, FocusEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowRight, ChevronDown, ChevronUp, Eye, Layers3, LayoutList, Radio, X, Zap } from 'lucide-react';
import { t } from '../i18n';
import { useOverflowCues } from '../battle-feedback';
import type { Card } from '../types';
import './hand-tray.css';

export type HandView = 'classic' | 'fan';

export function HandTray({ mode, onModeChange, gameId, stage, required, cards, readyResources, totalResources, playableCount, resourceSelection, busy, message, openLog, renderCard }: {
  mode: HandView;
  onModeChange: (mode: HandView) => void;
  gameId: string;
  stage: string;
  required: boolean;
  cards: Card[];
  readyResources: number;
  totalResources: number;
  playableCount: number;
  resourceSelection?: { selected: number; max: number } | null;
  busy: boolean;
  message?: string;
  openLog: () => void;
  renderCard: (card: Card, index: number, close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(mode === 'fan' && required);
  const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' });
  const section = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const overflow = useOverflowCues();
  const instructionsId = useId();
  const lastCardId = useRef<string | null>(null);
  const lastScrollLeft = useRef(0);
  const focusOnOpen = useRef(false);
  const close = useCallback(() => {
    if (panel.current && overflow.ref.current) lastScrollLeft.current = overflow.ref.current.scrollLeft;
    // A played card disappears; return keyboard focus to a stable control.
    if (panel.current?.contains(document.activeElement)) toggle.current?.focus();
    setOpen(false);
  }, [overflow.ref]);
  const openHand = useCallback(() => {
    focusOnOpen.current = true;
    setOpen(true);
  }, []);

  useEffect(() => {
    lastCardId.current = null;
    lastScrollLeft.current = 0;
    focusOnOpen.current = false;
    setOpen(mode === 'fan' && required);
  }, [gameId]);
  useLayoutEffect(() => {
    const lane = overflow.ref.current;
    if (mode !== 'fan' || !open || !lane) return;
    // Wait for the positioned portal and adaptive card overlap to be laid out.
    const frame = requestAnimationFrame(() => {
      lane.scrollLeft = lastScrollLeft.current;
      if (!focusOnOpen.current) return;
      focusOnOpen.current = false;
      const buttons = [...lane.querySelectorAll<HTMLButtonElement>('.game-card-click:not(:disabled)')];
      const remembered = buttons.find(button => button.dataset.cardId === lastCardId.current);
      // A played or resourced card may have left the hand since it was closed.
      const target = remembered || buttons[0];
      target?.focus({ preventScroll: true });
      target?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    });
    return () => cancelAnimationFrame(frame);
  }, [mode, open, overflow.ref]);
  // Selection updates can change prompt IDs. Reopen only on entering a hand choice.
  useEffect(() => {
    if (mode === 'fan' && required) setOpen(true);
    else close();
  }, [required, mode, close]);
  useEffect(() => { if (!required && stage !== 'action') close(); }, [required, stage, close]);
  useEffect(() => {
    if (mode !== 'fan') return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.ctrlKey || event.altKey || event.metaKey
        || document.querySelector('[role="dialog"], [aria-modal="true"], [data-game-content][inert]')) return;
      const target = event.target;
      if (target instanceof Element && target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
      if (event.key.toLowerCase() === 'h') {
        event.preventDefault();
        if (open) close();
        else openHand();
      } else if (event.key === 'Escape' && open) {
        event.preventDefault(); close(); toggle.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [mode, open, close, openHand]);

  useLayoutEffect(() => {
    if (mode !== 'fan' || !open || !section.current) return;
    const node = section.current;
    const field = node.closest('.battlefield');
    const arenas = field?.querySelector('.arenas');
    const dock = field?.querySelector('.command-dock');
    const update = () => {
      const anchor = node.getBoundingClientRect();
      const landscape = innerWidth >= 600 && innerWidth <= 1280 && innerHeight <= 520;
      const bounds = (landscape ? arenas : field)?.getBoundingClientRect() || anchor;
      const bottom = landscape ? 10 : Math.max(8, innerHeight - anchor.top + 6);
      const width = Math.min(980, bounds.width, innerWidth - 16);
      const maxHeight = Math.max(120, innerHeight - bottom - 12);
      setPosition({ left: Math.max(8, bounds.left + (bounds.width - width) / 2), width, bottom,
        maxHeight, '--fan-room': `${Math.max(55, maxHeight - (innerHeight <= 520 ? 94 : 150))}px` } as CSSProperties);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    if (field) observer.observe(field);
    if (dock) observer.observe(dock);
    window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update);
    return () => { observer.disconnect(); window.removeEventListener('resize', update); window.visualViewport?.removeEventListener('resize', update); };
  }, [mode, open]);

  // Fit a normal hand on the table while leaving at least half of every card
  // exposed. Larger hands scroll; touch devices keep separate tap targets.
  useLayoutEffect(() => {
    const lane = overflow.ref.current;
    if (mode !== 'fan' || !open || !lane) return;
    const update = () => {
      const card = lane.querySelector<HTMLElement>('.hand-fan-slot');
      if (!card) return;
      const style = getComputedStyle(lane);
      const room = lane.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const width = card.offsetWidth;
      const needed = (cards.length * width - room) / Math.max(1, cards.length - 1);
      lane.style.setProperty('--fan-overlap', `${Math.max(width * .18, Math.min(width * .46, needed))}px`);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(lane);
    const first = lane.firstElementChild;
    if (first) observer.observe(first);
    return () => observer.disconnect();
  }, [mode, open, cards.length, overflow.ref]);

  const scrollHand = (direction: number) => {
    const lane = overflow.ref.current;
    lane?.scrollBy({ left: direction * lane.clientWidth * .7,
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  };
  const navigateHand = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const inspectKey = event.key.toLowerCase() === 'i';
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey
      || (!inspectKey && !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key))) return;
    const card = (event.target as HTMLElement).closest('.game-card');
    if (inspectKey) {
      const inspect = card?.querySelector<HTMLButtonElement>('.card-inspect:not(:disabled)');
      if (inspect && !event.repeat) { event.preventDefault(); inspect.click(); }
      return;
    }
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('.game-card-click:not(:disabled)'));
    if (!buttons.length) return;
    event.preventDefault();
    const current = buttons.indexOf(card?.querySelector<HTMLButtonElement>('.game-card-click') as HTMLButtonElement);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : current === -1 ? event.key === 'ArrowRight' ? 0 : buttons.length - 1
        : Math.max(0, Math.min(buttons.length - 1, current + (event.key === 'ArrowRight' ? 1 : -1)));
    buttons[index].focus({ preventScroll: true });
    buttons[index].scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  };
  const rememberCard = (event: FocusEvent<HTMLDivElement>) => {
    const button = (event.target as HTMLElement).closest('.game-card')?.querySelector<HTMLButtonElement>('.game-card-click');
    if (button?.dataset.cardId) lastCardId.current = button.dataset.cardId;
  };

  const modeButton = <button className="hand-view-switch" type="button"
    aria-label={t(mode === 'classic' ? 'Switch to fan hand' : 'Switch to classic hand')}
    title={t(mode === 'classic' ? 'Switch to fan hand' : 'Switch to classic hand')}
    onClick={() => onModeChange(mode === 'classic' ? 'fan' : 'classic')}>
    {mode === 'classic' ? <Layers3 size={15} /> : <LayoutList size={15} />}
    <span>{t(mode === 'classic' ? 'Fan view' : 'Classic view')}</span>
  </button>;
  const cue = stage === 'resource' ? <><Zap size={12} />{t('SELECT RESOURCES')}</>
    : stage === 'action' ? <><Zap size={12} />{t(cards.some(card => card.playable) ? 'TAP A PLAY BUTTON' : 'NO PLAYABLE CARDS')}</>
    : <><Eye size={12} />{t('TAP TO INSPECT')}</>;
  const empty = <div className="empty-hand"><Layers3 size={20} />{t('Your hand is empty.')}</div>;
  const selection = stage === 'resource' ? resourceSelection : null;
  const availability = busy ? t('Processing…') : selection
    ? t('{selected}/{max} selected', selection)
    : stage === 'action' ? t('{count} playable', { count: playableCount }) : t('Review your cards');
  const navigation = overflow.overflowing && <div className="hand-navigation" role="group" aria-label={t('Browse hand')}>
    <button type="button" aria-label={t('Previous cards')} disabled={!overflow.className.includes('can-scroll-left')} onClick={() => scrollHand(-1)}><ArrowLeft size={16} /></button>
    <button type="button" aria-label={t('Next cards')} disabled={!overflow.className.includes('can-scroll-right')} onClick={() => scrollHand(1)}><ArrowRight size={16} /></button>
  </div>;

  return <section ref={section} className={`hand-section hand-view-${mode}`} aria-label={t('Your hand')}>
    {mode === 'classic' ? <>
      <div className="hand-heading"><span className="eyebrow">{t('YOUR HAND')} <b>{cards.length}</b></span>
        {message ? <button className="battle-update" title={t(message)} onClick={openLog} aria-label={`${t('Latest move')}: ${t(message)}`}><Radio size={12} /><span>{t(message)}</span></button>
          : <span className={stage === 'resource' ? 'resource-hand-cue' : 'play-hand-cue'}>{overflow.overflowing ? <span className="hand-overflow-cue"><ArrowLeft size={11} />{t('Swipe for more')}<ArrowRight size={11} /></span> : cue}</span>}
        {navigation}{modeButton}
      </div>
      <div ref={overflow.ref} tabIndex={0} aria-label={t('Your hand')} aria-describedby={instructionsId}
        className={`hand-cards ${overflow.className}`} onKeyDown={navigateHand} onFocusCapture={rememberCard}>
        {cards.map((card, i) => renderCard(card, i, close))}{!cards.length && empty}
      </div>
    </> : <div className="hand-fan-toolbar">
      <button ref={toggle} className={`hand-toggle ${open ? 'is-open' : ''}`} type="button"
        aria-label={t(open ? 'Hide hand' : 'Show hand')} aria-expanded={open} aria-controls={open ? 'hand-fan-panel' : undefined}
        aria-keyshortcuts="H" onClick={() => open ? close() : openHand()}>
        <span className="held-card-icon" aria-hidden="true"><i /><i /><i /></span>
        <span className="hand-toggle-copy"><span>{t('Hand')} <b>{cards.length}</b></span><small>{availability}</small></span><kbd>H</kbd>{open ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
      </button>
      <span className={`hand-fan-hint ${required ? 'needs-hand' : ''}`}>{required ? t('Choose cards from your hand') : t('H to open · Esc to close')}</span>
      {modeButton}
    </div>}
    <span id={instructionsId} className="sr-only">{t('Use Left and Right to browse cards, Home and End to jump, I to inspect, and Enter to choose.')}</span>
    <span className="sr-only" role="status" aria-live="polite">{message ? t(message) : ''}</span>
    {mode === 'fan' && open && createPortal(<div ref={panel} id="hand-fan-panel" className="hand-fan-panel" role="region" aria-label={t('Your hand')} style={position}>
      <div className="hand-fan-heading"><div className="hand-fan-summary"><span className="eyebrow">{t('YOUR HAND')} <b>{cards.length}</b></span>
        <div className="hand-fan-status">
          <span className="hand-resource-status" title={t('Ready resources')}><Zap size={13} /><strong className="hand-resource-value">{readyResources}<small>/{totalResources}</small></strong><span>{t('ready')}</span></span>
          <span className={selection ? 'hand-selection-status' : 'hand-playable-status'} data-available={!busy && playableCount > 0 || !!selection}>{availability}</span>
        </div></div>
        <div className="hand-fan-controls">{navigation}
        <button className="hand-fan-close" type="button" aria-label={t('Hide hand')} onClick={() => { close(); toggle.current?.focus(); }}><span>{t('Hide')}</span><kbd>Esc</kbd><X size={17} /></button>
        </div>
      </div>
      <div ref={overflow.ref} className={`hand-fan-cards ${overflow.className}`} tabIndex={0} aria-label={t('Your hand')}
        aria-describedby={instructionsId} onKeyDown={navigateHand} onFocusCapture={rememberCard}>
        {cards.map((card, i) => {
          const offset = (i - (cards.length - 1) / 2) / Math.max(1, (cards.length - 1) / 2);
          return <div className="hand-fan-slot" key={card.uuid || i} style={{ '--fan-angle': `${offset * 6}deg`, '--fan-drop': `${Math.abs(offset) ** 2 * 14}px`, '--fan-order': i } as CSSProperties}>
            {renderCard(card, i, close)}
          </div>;
        })}{!cards.length && empty}
      </div>
      <div className="hand-fan-footer"><span><Eye size={12} />{t('Inspect a card for its full text')}</span><span className="hand-keyboard-hint"><ArrowLeft size={12} /><ArrowRight size={12} />{t('Browse cards')}<span>·</span>{t('I to inspect')}<span>·</span>{t('Enter to choose')}</span>{overflow.overflowing && <span className="hand-swipe-hint">{t('Swipe or use the arrows')}</span>}</div>
    </div>, document.querySelector('[data-game-content]') || document.body)}
  </section>;
}
