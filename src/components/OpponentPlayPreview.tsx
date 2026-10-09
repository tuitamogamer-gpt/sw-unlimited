import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Crosshair, Orbit, Sparkles } from 'lucide-react';
import type { Card } from '../types';
import { t } from '../i18n';
import { cardImage, cardType, isLandscapeCard } from './CardArtwork';
import './opponent-play-preview.css';

export interface OpponentPlayPreviewProps {
  card: Card;
  sequenceKey: string;
  kind?: 'play' | 'deploy';
  durationMs?: number;
  /** The parent starts the full display duration after artwork or its fallback is visible. */
  onReady: () => void;
}

const TYPE_LABELS = { leader: 'Leader', base: 'Base', unit: 'Unit', event: 'Event', upgrade: 'Upgrade', card: 'Card' };

function Preview({ card, sequenceKey, kind = 'play', durationMs = 3000, onReady }: OpponentPlayPreviewProps) {
  const imageUrl = cardImage(card);
  const imageRef = useRef<HTMLImageElement>(null);
  const onReadyRef = useRef(onReady);
  const notified = useRef(false);
  const [ready, setReady] = useState(!imageUrl);
  const [failed, setFailed] = useState(!imageUrl);
  onReadyRef.current = onReady;
  const type = cardType(card);
  const landscape = isLandscapeCard(card);
  const arena = card.zone === 'groundArena' ? 'Ground arena' : card.zone === 'spaceArena' ? 'Space arena' : null;
  const title = t(kind === 'deploy' ? 'Opponent deploys' : 'Opponent plays');
  const markFailed = useCallback(() => { setFailed(true); setReady(true); }, []);

  useEffect(() => {
    if (ready) return;
    // A cached image may have finished before its load listener was attached.
    if (imageRef.current?.complete) {
      if (imageRef.current.naturalWidth > 0) setReady(true);
      else markFailed();
      return;
    }
    // An unavailable image host must never stall the match. The fallback still
    // gets the entire preview duration and includes the public card rules.
    const timeout = window.setTimeout(markFailed, 1500);
    return () => window.clearTimeout(timeout);
  }, [markFailed, ready]);

  useEffect(() => {
    if (!ready || notified.current) return;
    notified.current = true;
    onReadyRef.current();
  }, [ready]);

  return <div
    className={`opponent-play-preview${ready ? ' is-ready' : ''}${landscape ? ' is-landscape-card' : ''}`}
    data-opponent-preview=""
    data-preview-card-id={card.uuid}
    data-preview-sequence={sequenceKey}
    data-preview-ready={ready ? 'true' : 'false'}
    style={{ '--opponent-preview-duration': `${durationMs}ms` } as CSSProperties}
    role="status"
    aria-live="polite"
    aria-atomic="true"
  >
    <div className="opponent-play-sheet">
      <div className="opponent-play-heading"><span className="opponent-play-signal" aria-hidden="true" /><span>{title}</span></div>
      <div className="opponent-play-art">
        {!failed && imageUrl ? <img
          ref={imageRef}
          src={imageUrl}
          alt={card.name || t('Card')}
          loading="eager"
          decoding="async"
          draggable={false}
          onLoad={() => setReady(true)}
          onError={markFailed}
        /> : <div className="opponent-play-art-fallback">
          <Orbit size={42} strokeWidth={1.1} aria-hidden="true" />
          <span className="opponent-play-fallback-type">{t(TYPE_LABELS[type])}</span>
          <strong>{card.name || t('Card')}</strong>
          {card.subtitle && <span>{card.subtitle}</span>}
          {card.text && <p>{card.text.replace(/\\n/g, '\n')}</p>}
        </div>}
        <i className="opponent-play-art-rim" aria-hidden="true" />
      </div>
      <div className="opponent-play-identity">
        <h2>{card.name || t('Card')}</h2>
        {card.subtitle && <p className="opponent-play-subtitle">{card.subtitle}</p>}
        <div className="opponent-play-meta"><span>{t(TYPE_LABELS[type])}</span>{arena && <><i aria-hidden="true" /><span>{t(arena)}</span></>}</div>
        <p className="opponent-play-destination">{arena ? <Crosshair size={12} aria-hidden="true" /> : <Sparkles size={12} aria-hidden="true" />}<span>{t(arena ? 'Joining the battlefield' : 'Resolving card')}</span></p>
      </div>
      <div className="opponent-play-progress" aria-hidden="true"><i /></div>
    </div>
  </div>;
}

/** A keyed child resets image readiness and the progress strip for every play,
 * including consecutive plays of the same printed card. */
export function OpponentPlayPreview(props: OpponentPlayPreviewProps) {
  return <Preview key={props.sequenceKey} {...props} />;
}
