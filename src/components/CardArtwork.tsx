import { useCallback, useState } from 'react';
import { Orbit } from 'lucide-react';
import type { Card } from '../types';
import { t } from '../i18n';

export type CardFace = 'front' | 'back';

export function activeCardFace(card: Card): CardFace {
  return card.backImage && (card.deployed || card.image === card.backImage) ? 'back' : 'front';
}

export function cardImage(card: Card, face: CardFace = activeCardFace(card)): string | undefined {
  if (card.hidden) return undefined;
  if (face === 'back') return card.backImage || card.image;
  if (card.frontImage) return card.frontImage;
  if (card.image && card.image !== card.backImage) return card.image;
  if (card.code) {
    const [set, number] = card.code.split('_');
    if (set && number) return `https://cdn.swu-db.com/images/cards/${set.toUpperCase()}/${number}.png`;
  }
  return card.image;
}

export function isLandscapeCard(card: Card, face: CardFace = activeCardFace(card)): boolean {
  const type = (card.type || '').toLowerCase();
  const leader = type.includes('leader') && !type.includes('nonleader');
  return type.includes('base') || (face === 'front' && (leader || !!card.backImage));
}

export function cardType(card: Card): 'leader' | 'base' | 'unit' | 'event' | 'upgrade' | 'card' {
  const type = (card.type || '').toLowerCase();
  if (type.includes('base')) return 'base';
  if (type.includes('upgrade')) return 'upgrade';
  if (type.includes('leader') && !type.includes('nonleader')) return 'leader';
  if (type.includes('unit')) return 'unit';
  if (type.includes('event')) return 'event';
  return 'card';
}

/** Tracks one image URL from request to paint. An image that was already in
 * the browser cache is shown at once; one that had to load fades in. */
function useArtState(url: string | undefined) {
  const [state, setState] = useState<{ url?: string; status: 'ready' | 'revealed' | 'failed' }>({ status: 'ready' });
  const current = state.url === url ? state.status : 'pending';
  const attach = useCallback((node: HTMLImageElement | null) => {
    if (node?.complete && node.naturalWidth > 0) setState(old => old.url === url ? old : { url, status: 'ready' });
  }, [url]);
  const onLoad = useCallback(() => setState(old => old.url === url ? old : { url, status: 'revealed' }), [url]);
  const onError = useCallback(() => setState({ url, status: 'failed' }), [url]);
  return { status: current, attach, onLoad, onError };
}
function artClass(status: string) { return status === 'pending' ? 'is-pending' : status === 'revealed' ? 'is-revealed' : ''; }

export function CardArtwork({ card, face, className = '', decorative = false, eager = false }: {
  card: Card;
  face?: CardFace;
  className?: string;
  decorative?: boolean;
  eager?: boolean;
}) {
  const url = cardImage(card, face);
  const art = useArtState(url);
  if (!url || art.status === 'failed' || card.hidden) {
    return <div className={`inspector-art-fallback ${className}`} role={decorative ? undefined : 'img'} aria-label={decorative ? undefined : card.hidden ? t('Hidden card') : card.name || t('Card')}>
      <Orbit size={34} strokeWidth={1.25} />
      <span>{card.hidden ? t('Hidden card') : card.name || t('Card')}</span>
    </div>;
  }
  return <img ref={art.attach} className={`card-image ${artClass(art.status)} ${className}`} src={url} alt={decorative ? '' : `${card.name || t('Card')}${face === 'back' ? ` · ${t('Unit side')}` : ''}`} loading={eager ? 'eager' : 'lazy'} decoding="async" draggable={false} onLoad={art.onLoad} onError={art.onError} />;
}

/** Lobby and battlefield artwork. `leaderArt` shows the leader side and lets
 * the stylesheet zoom into its illustration instead of the printed rules box. */
export function CardImage({ card, className = '', decorative = false, leaderArt = false }: {
  card?: Partial<Card>;
  className?: string;
  decorative?: boolean;
  leaderArt?: boolean;
}) {
  const url = card ? cardImage(card as Card, leaderArt ? 'front' : undefined) : undefined;
  const art = useArtState(url);
  if (!url || art.status === 'failed') {
    return <div className={`card-art-fallback ${className}`}><Orbit size={36} /><span>{card?.name || 'STAR WARS'}</span></div>;
  }
  return <img ref={art.attach} className={`card-image ${leaderArt ? 'art-leader' : ''} ${artClass(art.status)} ${className}`} src={url} alt={decorative ? '' : card?.name || t('Karta')} loading="lazy" draggable={false} onLoad={art.onLoad} onError={art.onError} />;
}
