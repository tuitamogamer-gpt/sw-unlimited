import { useEffect, useState } from 'react';
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

export function CardArtwork({ card, face, className = '', decorative = false, eager = false }: {
  card: Card;
  face?: CardFace;
  className?: string;
  decorative?: boolean;
  eager?: boolean;
}) {
  const url = cardImage(card, face);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  if (!url || failed || card.hidden) {
    return <div className={`inspector-art-fallback ${className}`} role={decorative ? undefined : 'img'} aria-label={decorative ? undefined : card.hidden ? t('Hidden card') : card.name || t('Card')}>
      <Orbit size={34} strokeWidth={1.25} />
      <span>{card.hidden ? t('Hidden card') : card.name || t('Card')}</span>
    </div>;
  }
  return <img className={className} src={url} alt={decorative ? '' : `${card.name || t('Card')}${face === 'back' ? ` · ${t('Unit side')}` : ''}`} loading={eager ? 'eager' : 'lazy'} decoding="async" draggable={false} onError={() => setFailed(true)} />;
}
