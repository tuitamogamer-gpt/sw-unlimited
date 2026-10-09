import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, CircleCheck, Database, LoaderCircle, Search } from 'lucide-react';
import type { Card } from '../types';
import { api } from '../game-client';
import { t } from '../i18n';
import { CardArtwork, isLandscapeCard } from './CardArtwork';
import { useCardHover } from './CardHoverPreview';
import './card-catalog.css';

type CatalogCard = Card & { engineSupported: boolean; engineStatus: string; preview?: boolean; releaseStatus?: string };
type CatalogResponse = {
  cards: CatalogCard[]; total: number; offset: number; limit: number; asOf?: string;
  summary: { total: number; implemented: number; missing: number; sets: { code: string; total: number; implemented: number; missing: number; name?: string }[] };
};
const PAGE_SIZE = 48;

export function CardCatalog({ onInspect }: { onInspect: (card: Card) => void }) {
  const { bindCardHover } = useCardHover();
  const [search, setSearch] = useState('');
  const [set, setSet] = useState('all');
  const [type, setType] = useState('all');
  const [status, setStatus] = useState('all');
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<CatalogResponse | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true); setError('');
    const timer = setTimeout(() => {
      const query = new URLSearchParams({ search, set, type, status, offset: String(offset), limit: String(PAGE_SIZE) });
      api<CatalogResponse>(`/api/cards?${query}`, undefined, 'GET', { signal: controller.signal })
        .then(result => { if (!controller.signal.aborted) setData(result); })
        .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'The card library could not be loaded.'); })
        .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    }, search ? 250 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [search, set, type, status, offset, retry]);
  const filter = (update: (value: string) => void, value: string) => { update(value); setOffset(0); };
  const preview = (card: CatalogCard) => card.preview || card.releaseStatus === 'preview';
  return <div className="card-catalog">
    <p className="catalog-intro">{t('Browse every imported printing. Open a card to read its rules; preview cards are marked.')}</p>
    {data && <div className="catalog-summary">
      <span><Database size={17} /><strong>{data.summary.total.toLocaleString()}</strong>{t('Imported printings')}</span>
      <span><CircleCheck size={17} /><strong>{data.summary.implemented.toLocaleString()}</strong>{t('Ready to play')}</span>
      {!!data.summary.missing && <span className="catalog-missing"><strong>{data.summary.missing.toLocaleString()}</strong>{t('Awaiting engine support')}</span>}
    </div>}
    <div className="catalog-filters">
      <label className="catalog-search"><Search size={17} /><input type="search" value={search} onChange={event => filter(setSearch, event.target.value)} aria-label={t('Search all cards')} placeholder={t('Name, card code or rules text')} maxLength={160} /></label>
      <label><span>{t('Set')}</span><select aria-label={t('Card set')} value={set} onChange={event => filter(setSet, event.target.value)}><option value="all">{t('All sets')}</option>{data?.summary.sets.map(item => <option value={item.code} key={item.code}>{item.code}{item.name ? ` · ${item.name}` : ''}</option>)}</select></label>
      <label><span>{t('Type')}</span><select aria-label={t('Card type')} value={type} onChange={event => filter(setType, event.target.value)}>{[['all', 'All types'], ['leader', 'Leader'], ['base', 'Base'], ['unit', 'Unit'], ['event', 'Event'], ['upgrade', 'Upgrade'], ['token', 'Token']].map(([value, label]) => <option value={value} key={value}>{t(label)}</option>)}</select></label>
      <label><span>{t('Availability')}</span><select aria-label={t('Engine support')} value={status} onChange={event => filter(setStatus, event.target.value)}><option value="all">{t('All cards')}</option><option value="supported">{t('Ready to play')}</option><option value="unsupported">{t('Awaiting engine support')}</option></select></label>
    </div>
    <div className="catalog-results-heading" aria-live="polite"><span>{busy ? t('Searching cards…') : t('{count} matching printings', { count: data?.total || 0 })}</span>{busy && <LoaderCircle size={16} className="spin" />}</div>
    {error ? <div className="catalog-empty" role="alert"><p>{t(error)}</p><button className="secondary-button" onClick={() => setRetry(value => value + 1)}>{t('Try again')}</button></div>
      : data && !data.cards.length && !busy ? <div className="catalog-empty"><Search size={28} /><p>{t('No cards match these filters.')}</p><button className="secondary-button" onClick={() => { setSearch(''); setSet('all'); setType('all'); setStatus('all'); setOffset(0); }}>{t('Clear filters')}</button></div>
        : <div className="catalog-grid" aria-busy={busy}>{data?.cards.map(card => <button {...bindCardHover(card)} className={`catalog-card ${card.engineSupported ? '' : 'catalog-card-pending'}`} key={card.code} onClick={() => onInspect(card)} aria-label={t('Inspect {card}', { card: `${card.name}${card.subtitle ? ` · ${card.subtitle}` : ''} (${card.code})` })}>
          <div className={`catalog-art ${isLandscapeCard(card) ? 'landscape' : ''}`}><CardArtwork card={card} decorative /></div>
          <div className="catalog-card-copy"><span className="catalog-code">{card.code}{preview(card) && <em>{t('Preview')}</em>}</span><strong>{card.name}</strong>{card.subtitle && <small>{card.subtitle}</small>}<span className={`catalog-support ${card.engineSupported ? 'ready' : ''}`}>{card.engineSupported ? t('Ready to play') : card.engineStatus === 'missing-script' ? t('Needs a card script') : t('No engine definition')}</span></div>
        </button>)}</div>}
    {data && data.total > PAGE_SIZE && <nav className="catalog-pagination" aria-label={t('Card library pages')}><button className="secondary-button" disabled={busy || offset === 0} onClick={() => setOffset(value => Math.max(0, value - PAGE_SIZE))}><ArrowLeft size={16} />{t('Previous')}</button><span>{t('Page {page} of {pages}', { page: Math.floor(offset / PAGE_SIZE) + 1, pages: Math.ceil(data.total / PAGE_SIZE) })}</span><button className="secondary-button" disabled={busy || offset + PAGE_SIZE >= data.total} onClick={() => setOffset(value => value + PAGE_SIZE)}>{t('Next')}<ArrowRight size={16} /></button></nav>}
    {data?.asOf && <p className="catalog-snapshot">{t('Catalog snapshot: {date}. Counts include reprints and tokens.', { date: data.asOf })}</p>}
  </div>;
}
