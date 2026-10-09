import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CSSProperties, HTMLAttributes, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Card } from '../types';
import { t } from '../i18n';
import { activeCardFace, cardImage, isLandscapeCard } from './CardArtwork';
import type { CardFace } from './CardArtwork';
import './card-hover-preview.css';

export interface CardHoverOptions {
  face?: CardFace;
  disabled?: boolean;
}

interface HoverTarget {
  card: Card;
  face: CardFace;
  anchor: HTMLElement;
}

type CardHoverBindings = HTMLAttributes<HTMLElement> & { 'data-card-hover-id'?: string };

interface CardHoverContextValue {
  bindCardHover: (card: Partial<Card> | null | undefined, options?: CardHoverOptions) => CardHoverBindings;
  dismissCardHover: () => void;
}

const emptyContext: CardHoverContextValue = {
  bindCardHover: () => ({}),
  dismissCardHover: () => {},
};
const CardHoverContext = createContext<CardHoverContextValue>(emptyContext);
const HOVER_DELAY = 250;

function supportsCardHover() {
  return window.matchMedia('(hover: hover) and (pointer: fine)').matches;
}

/** Public cards inside the current dialog may be previewed; the covered board may not. */
function canPreviewTarget(target: HoverTarget) {
  if (target.card.hidden || !target.anchor.isConnected || target.anchor.closest('[inert], [disabled], [aria-disabled="true"]')) return false;
  if (document.querySelector('[data-opponent-preview]')) return false;
  const dialogs = document.querySelectorAll<HTMLElement>('[aria-modal="true"]');
  const topDialog = dialogs[dialogs.length - 1];
  return !topDialog || topDialog.contains(target.anchor);
}

function previewLayout(target: HoverTarget) {
  const margin = 12;
  const gap = 14;
  const rect = target.anchor.getBoundingClientRect();
  const landscape = isLandscapeCard(target.card, target.face);
  const ratio = landscape ? 1.4 : 1 / 1.4;
  const captionHeight = target.card.subtitle ? 55 : 39;
  const width = Math.min(landscape ? 320 : 240, window.innerWidth - margin * 2, Math.max(80, (window.innerHeight - margin * 2 - captionHeight) * ratio));
  const height = width / ratio + captionHeight;
  let left = rect.right + gap;
  if (left + width > window.innerWidth - margin) left = rect.left - width - gap;
  if (left < margin) left = Math.max(margin, Math.min(rect.right + gap, window.innerWidth - width - margin));
  const top = Math.max(margin, Math.min(rect.top + rect.height / 2 - height / 2, window.innerHeight - height - margin));
  return { left, top, width, landscape, ratio };
}

function HoverArtwork({ target }: { target: HoverTarget }) {
  const { card, face } = target;
  const url = cardImage(card, face);
  const [failed, setFailed] = useState(false);
  const text = (face === activeCardFace(card) ? card.text : face === 'front' ? card.frontText : card.deployText) || card.text;
  return <div className="card-hover-art">
    {url && !failed ? <img src={url} alt="" draggable={false} decoding="async" onError={() => setFailed(true)} /> : <div className="card-hover-fallback">
      <strong>{card.name || t('Card')}</strong>
      {card.subtitle && <span>{card.subtitle}</span>}
      {text && <p>{text.replace(/\\n/g, '\n')}</p>}
    </div>}
  </div>;
}

/** One small, non-interactive artwork preview shared by every visible card. */
export function CardHoverProvider({ children, disabled = false }: { children: ReactNode; disabled?: boolean }) {
  const [active, setActive] = useState<HoverTarget | null>(null);
  const pending = useRef<HoverTarget | null>(null);
  const timer = useRef<number | null>(null);
  const disabledRef = useRef(disabled);
  const tooltipId = useId();
  disabledRef.current = disabled;

  const dismissCardHover = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    pending.current = null;
    setActive(null);
  }, []);

  const queue = useCallback((target: HoverTarget) => {
    dismissCardHover();
    if (disabledRef.current || !supportsCardHover() || !canPreviewTarget(target)) return;
    pending.current = target;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      if (pending.current === target && !disabledRef.current && supportsCardHover() && canPreviewTarget(target)) setActive(target);
    }, HOVER_DELAY);
  }, [dismissCardHover]);

  const bindCardHover = useCallback((value: Partial<Card> | null | undefined, options: CardHoverOptions = {}): CardHoverBindings => {
    if (!value || value.hidden || options.disabled) return {};
    const card: Card = { ...value, uuid: value.uuid || value.id || value.code || `${value.name || 'card'}-${value.subtitle || ''}` };
    const face = options.face || activeCardFace(card);
    return {
      'data-card-hover-id': card.uuid,
      'aria-describedby': active?.card.uuid === card.uuid && active.face === face ? tooltipId : undefined,
      onPointerEnter: event => {
        if (event.pointerType === 'touch') return;
        queue({ card, face, anchor: event.currentTarget });
      },
      onPointerLeave: dismissCardHover,
      onFocus: event => {
        // Mouse clicks retain the original card action and never reopen a dismissed preview.
        if ((event.target as HTMLElement).matches(':focus-visible')) queue({ card, face, anchor: event.currentTarget });
      },
      onBlur: dismissCardHover,
    };
  }, [active, dismissCardHover, queue, tooltipId]);

  useEffect(() => {
    if (disabled) dismissCardHover();
  }, [disabled, dismissCardHover]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') dismissCardHover(); };
    const media = window.matchMedia('(hover: hover) and (pointer: fine)');
    window.addEventListener('pointerdown', dismissCardHover, true);
    window.addEventListener('click', dismissCardHover, true);
    window.addEventListener('scroll', dismissCardHover, true);
    window.addEventListener('resize', dismissCardHover);
    window.addEventListener('blur', dismissCardHover);
    window.addEventListener('keydown', onKeyDown, true);
    media.addEventListener('change', dismissCardHover);
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      window.removeEventListener('pointerdown', dismissCardHover, true);
      window.removeEventListener('click', dismissCardHover, true);
      window.removeEventListener('scroll', dismissCardHover, true);
      window.removeEventListener('resize', dismissCardHover);
      window.removeEventListener('blur', dismissCardHover);
      window.removeEventListener('keydown', onKeyDown, true);
      media.removeEventListener('change', dismissCardHover);
    };
  }, [dismissCardHover]);

  useEffect(() => {
    if (!active) return;
    const observer = new MutationObserver(() => { if (!canPreviewTarget(active)) dismissCardHover(); });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['inert', 'disabled', 'aria-disabled', 'aria-modal'] });
    return () => observer.disconnect();
  }, [active, dismissCardHover]);

  const context = useMemo(() => ({ bindCardHover, dismissCardHover }), [bindCardHover, dismissCardHover]);
  const layout = active && !disabled ? previewLayout(active) : null;
  return <CardHoverContext.Provider value={context}>
    {children}
    {active && layout && createPortal(<div
      id={tooltipId}
      role="tooltip"
      className={`card-hover-preview${layout.landscape ? ' is-landscape' : ''}`}
      data-card-hover=""
      data-hover-card-id={active.card.uuid}
      data-hover-card-face={active.face}
      style={{ left: layout.left, top: layout.top, width: layout.width, '--hover-card-ratio': layout.ratio } as CSSProperties}
    >
      <HoverArtwork key={`${active.card.uuid}-${active.face}-${cardImage(active.card, active.face)}`} target={active} />
      <div className="card-hover-caption"><strong>{active.card.name || t('Card')}</strong>{active.card.subtitle && <span>{active.card.subtitle}</span>}</div>
    </div>, document.body)}
  </CardHoverContext.Provider>;
}

export function useCardHover() {
  return useContext(CardHoverContext);
}
