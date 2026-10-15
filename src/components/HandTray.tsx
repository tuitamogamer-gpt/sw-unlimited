import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowRight, ChevronDown, ChevronUp, Eye, Layers3, LayoutList, Radio, X, Zap } from 'lucide-react';
import { t } from '../i18n';
import { useOverflowCues } from '../battle-feedback';
import type { Card } from '../types';
import './hand-tray.css';

export type HandView = 'classic' | 'fan';

export function HandTray({ mode, onModeChange, gameId, stage, required, cards, message, openLog, renderCard }: {
  mode: HandView;
  onModeChange: (mode: HandView) => void;
  gameId: string;
  stage: string;
  required: boolean;
  cards: Card[];
  message?: string;
  openLog: () => void;
  renderCard: (card: Card, index: number, close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(required);
  const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' });
  const section = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const overflow = useOverflowCues();
  const close = useCallback(() => {
    // A played card disappears; return keyboard focus to a stable control.
    if (panel.current?.contains(document.activeElement)) toggle.current?.focus();
    setOpen(false);
  }, []);
  const openHand = useCallback(() => {
    setOpen(true);
    requestAnimationFrame(() => panel.current?.querySelector<HTMLButtonElement>('.game-card-click:not(:disabled)')?.focus({ preventScroll: true }));
  }, []);

  useEffect(() => { setOpen(required); }, [gameId]);
  // Selection updates can change prompt IDs. Reopen only on entering a hand choice.
  useEffect(() => { if (required) setOpen(true); }, [required, mode]);
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
      const landscape = innerWidth >= 721 && innerWidth <= 1280 && innerHeight <= 520;
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

  return <section ref={section} className={`hand-section hand-view-${mode}`} aria-label={t('Your hand')}>
    {mode === 'classic' ? <>
      <div className="hand-heading"><span className="eyebrow">{t('YOUR HAND')} <b>{cards.length}</b></span>
        {message ? <button className="battle-update" title={t(message)} onClick={openLog} aria-label={`${t('Latest move')}: ${t(message)}`}><Radio size={12} /><span>{t(message)}</span></button>
          : <span className={stage === 'resource' ? 'resource-hand-cue' : 'play-hand-cue'}>{overflow.overflowing ? <span className="hand-overflow-cue"><ArrowLeft size={11} />{t('Swipe for more')}<ArrowRight size={11} /></span> : cue}</span>}
        {modeButton}
      </div>
      <div ref={overflow.ref} tabIndex={0} aria-label={t('Your hand')} className={`hand-cards ${overflow.className}`}>
        {cards.map((card, i) => renderCard(card, i, close))}{!cards.length && empty}
      </div>
    </> : <div className="hand-fan-toolbar">
      <button ref={toggle} className={`hand-toggle ${open ? 'is-open' : ''}`} type="button"
        aria-label={t(open ? 'Hide hand' : 'Show hand')} aria-expanded={open} aria-controls={open ? 'hand-fan-panel' : undefined}
        aria-keyshortcuts="H" onClick={() => open ? close() : openHand()}>
        <span className="held-card-icon" aria-hidden="true"><i /><i /><i /></span>
        <span>{t('Hand')} <b>{cards.length}</b></span><kbd>H</kbd>{open ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
      </button>
      <span className={`hand-fan-hint ${required ? 'needs-hand' : ''}`}>{required ? t('Choose cards from your hand') : t('Open when you need it')}</span>
      {modeButton}
    </div>}
    <span className="sr-only" role="status" aria-live="polite">{message ? t(message) : ''}</span>
    {mode === 'fan' && open && createPortal(<div ref={panel} id="hand-fan-panel" className="hand-fan-panel" role="region" aria-label={t('Your hand')} style={position}>
      <div className="hand-fan-heading"><div><span className="eyebrow">{t('YOUR HAND')} <b>{cards.length}</b></span><span className="hand-fan-instruction">{cue}</span></div>
        <button className="hand-fan-close" type="button" aria-label={t('Hide hand')} onClick={() => { close(); toggle.current?.focus(); }}><span>{t('Hide')}</span><kbd>Esc</kbd><X size={17} /></button>
      </div>
      <div ref={overflow.ref} className={`hand-fan-cards ${overflow.className}`} tabIndex={0} aria-label={t('Your hand')}>
        {cards.map((card, i) => {
          const offset = (i - (cards.length - 1) / 2) / Math.max(1, (cards.length - 1) / 2);
          return <div className="hand-fan-slot" key={card.uuid || i} style={{ '--fan-angle': `${offset * 8}deg`, '--fan-drop': `${Math.abs(offset) ** 2 * 18}px`, '--fan-order': i } as CSSProperties}>
            {renderCard(card, i, close)}
          </div>;
        })}{!cards.length && empty}
      </div>
      <div className="hand-fan-footer"><span><Eye size={12} />{t('Inspect a card for its full text')}</span><span><ArrowLeft size={12} />{t('Scroll through your hand')}<ArrowRight size={12} /></span></div>
    </div>, document.querySelector('[data-game-content]') || document.body)}
  </section>;
}
