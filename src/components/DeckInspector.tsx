import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Check, ChevronDown, Eye, Layers3, Search, Shield, Swords, X, Zap } from 'lucide-react';
import type { Card, Deck } from '../types';
import { t } from '../i18n';
import { CardArtwork, cardType } from './CardArtwork';
import './inspectors.css';

export interface DeckInspectorProps {
  deck: Deck;
  onInspect: (card: Card) => void;
  onSelect: () => void;
  selected?: boolean;
  busy?: boolean;
}

type TypeFilter = 'all' | 'unit' | 'event' | 'upgrade';
type CardRow = { card: Card; count: number };
const FILTERS: { id: TypeFilter; label: string }[] = [
  { id: 'all', label: 'All cards' }, { id: 'unit', label: 'Units' }, { id: 'event', label: 'Events' }, { id: 'upgrade', label: 'Upgrades' },
];
const COST_BUCKETS = Array.from({ length: 9 }, (_, index) => index);
function costBucket(card: Card): number | null { return card.cost != null && Number.isFinite(Number(card.cost)) ? Math.min(8, Math.max(0, Number(card.cost))) : null; }
function rowType(row: CardRow) { return cardType(row.card); }
function cardSearch(card: Card): string {
  return [card.name, card.subtitle, card.type, card.text, ...(card.traits || []), ...(card.keywords || []).map(keyword => typeof keyword === 'string' ? keyword : keyword.name)].filter(Boolean).join(' ').toLowerCase();
}

export function DeckInspector({ deck, onInspect, onSelect, selected = false, busy = false }: DeckInspectorProps) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<TypeFilter>('all');
  const [costFilter, setCostFilter] = useState<number | null>(null);
  const [sort, setSort] = useState<'cost' | 'name' | 'type'>('cost');
  const searchInput = useRef<HTMLInputElement>(null);
  const rows = deck.cards || [];
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const typeCounts = useMemo(() => Object.fromEntries(FILTERS.map(item => [item.id, item.id === 'all' ? total : rows.filter(row => rowType(row) === item.id).reduce((sum, row) => sum + row.count, 0)])), [rows, total]);
  const curve = useMemo(() => COST_BUCKETS.map(cost => rows.filter(row => costBucket(row.card) === cost).reduce((sum, row) => sum + row.count, 0)), [rows]);
  const curveMaximum = Math.max(...curve, 1);
  const cardsWithCost = rows.filter(row => row.card.cost != null);
  const weightedCost = cardsWithCost.reduce((sum, row) => sum + Number(row.card.cost) * row.count, 0);
  const costCount = cardsWithCost.reduce((sum, row) => sum + row.count, 0);
  const averageCost = costCount ? (weightedCost / costCount).toFixed(1) : '—';
  const baseHealth = deck.baseHealth ?? deck.base?.hp;
  const query = search.trim().toLowerCase();
  const filtered = rows.filter(row => (filter === 'all' || rowType(row) === filter) && (costFilter == null || costBucket(row.card) === costFilter) && (!query || cardSearch(row.card).includes(query))).sort((a, b) => sort === 'name' ? (a.card.name || '').localeCompare(b.card.name || '') : sort === 'type' ? rowType(a).localeCompare(rowType(b)) || (a.card.cost ?? 99) - (b.card.cost ?? 99) || (a.card.name || '').localeCompare(b.card.name || '') : (a.card.cost ?? 99) - (b.card.cost ?? 99) || (a.card.name || '').localeCompare(b.card.name || ''));
  const shownCount = filtered.reduce((sum, row) => sum + row.count, 0);
  const hasFilter = !!search || filter !== 'all' || costFilter != null;
  const clearFilters = () => { setSearch(''); setFilter('all'); setCostFilter(null); };

  useEffect(() => { setSearch(''); setFilter('all'); setCostFilter(null); setSort('cost'); }, [deck.id]);
  useEffect(() => {
    if (!window.matchMedia('(pointer: fine)').matches) return;
    const frame = requestAnimationFrame(() => searchInput.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [deck.id]);

  return <div className="di-root" data-deck-id={deck.id}>
    <section className="di-commanders" aria-label={t('Leader and base')}>
      <button className="di-commander di-leader" type="button" onClick={() => onInspect(deck.leader)} aria-label={t('Inspect {name}', { name: deck.leader.name || t('Leader') })}><CardArtwork card={deck.leader} face="front" eager decorative /><span className="di-commander-shade" /><span className="di-commander-copy"><span className="eyebrow">{t('LEADER')}</span><strong>{deck.leader.name}</strong><small>{deck.leader.subtitle}</small></span><Eye size={16} /></button>
      {deck.base && <button className="di-commander di-base" type="button" onClick={() => onInspect(deck.base!)} aria-label={t('Inspect {name}', { name: deck.base.name || t('Base') })}><CardArtwork card={deck.base} face="front" eager decorative /><span className="di-commander-shade" /><span className="di-commander-copy"><span className="eyebrow">{t('BASE')}{baseHealth != null && <span><Shield size={11} />{baseHealth} {t('HP')}</span>}</span><strong>{deck.base.name}</strong><small>{deck.base.subtitle || t('Your last line of defense.')}</small></span><Eye size={16} /></button>}
    </section>
    <div className="di-overview"><div><span className="di-set">{deck.setName || deck.set}</span><span className="di-format">{deck.format || t('Premier')}</span>{selected && <span className="di-selected"><Check size={11} />{t('SELECTED')}</span>}</div><p>{t(deck.description || deck.playstyle || 'An official preconstructed deck, ready to play.')}</p><div className="di-aspects" aria-label={t('Deck aspects')}>{(deck.aspects || [...(deck.leader.aspects || []), ...(deck.base?.aspects || [])]).map((aspect, index) => <span key={`${aspect}-${index}`}><i className={`aspect aspect-${aspect.toLowerCase()}`} />{t(aspect.charAt(0).toUpperCase() + aspect.slice(1))}</span>)}</div></div>
    {rows.length > 0 ? <>
      <section className="di-analysis" aria-label={t('Deck statistics')}><div className="di-stat-grid"><div><Layers3 size={16} /><strong>{total}</strong><span>{t('CARDS')}</span></div><div><Swords size={16} /><strong>{typeCounts.unit || 0}</strong><span>{t('UNITS')}</span></div><div><Zap size={16} /><strong>{averageCost}</strong><span>{t('AVG. COST')}</span></div></div><div className="di-curve"><div className="di-curve-heading"><h3>{t('Resource curve')}</h3><span>{t('Tap a cost to filter')}</span></div><div className="di-curve-bars" role="group" aria-label={t('Resource cost distribution')}>{COST_BUCKETS.map(cost => <button type="button" key={cost} className={costFilter === cost ? 'active' : ''} aria-pressed={costFilter === cost} aria-label={t('{cost} cost: {count} cards', { cost: cost === 8 ? '8+' : cost, count: curve[cost] })} disabled={!curve[cost]} onClick={() => setCostFilter(current => current === cost ? null : cost)}><span className="di-curve-count">{curve[cost] || '—'}</span><span className="di-curve-track"><i style={{ height: `${Math.max(curve[cost] ? 7 : 0, curve[cost] / curveMaximum * 100)}%` }} /></span><span className="di-curve-cost">{cost === 8 ? '8+' : cost}</span></button>)}</div></div></section>
      <section className="di-cards" aria-label={t('Deck contents')}>
        <div className="di-list-toolbar"><label className="di-search"><Search size={15} /><input ref={searchInput} type="search" placeholder={t('Search cards or rules…')} aria-label={t('Search deck cards')} value={search} onChange={event => setSearch(event.target.value)} />{search && <button type="button" aria-label={t('Clear search')} onClick={() => { setSearch(''); searchInput.current?.focus(); }}><X size={13} /></button>}</label><label className="di-sort"><span className="sr-only">{t('Sort cards')}</span><select aria-label={t('Sort cards')} value={sort} onChange={event => setSort(event.target.value as 'cost' | 'name' | 'type')}><option value="cost">{t('By cost')}</option><option value="name">{t('By name')}</option><option value="type">{t('By type')}</option></select><ChevronDown size={13} /></label></div>
        <div className="di-type-filters" role="group" aria-label={t('Filter card type')}>{FILTERS.map(item => <button type="button" key={item.id} className={filter === item.id ? 'active' : ''} aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>{t(item.label)}<span>{typeCounts[item.id] || 0}</span></button>)}</div>
        <div className="di-results"><span>{t('{shown} of {total} cards', { shown: shownCount, total })}{costFilter != null && <span className="di-cost-filter"><Zap size={10} />{costFilter === 8 ? '8+' : costFilter}<button type="button" aria-label={t('Clear cost filter')} onClick={() => setCostFilter(null)}><X size={10} /></button></span>}</span>{hasFilter && <button type="button" onClick={clearFilters}>{t('Clear filters')}</button>}</div>
        <div className="di-card-list">{filtered.length ? filtered.map(({ card, count }, index) => <button type="button" className="di-card-row" key={card.id || card.code || index} onClick={() => onInspect(card)} aria-label={t('Inspect {name}', { name: card.name || card.code || t('Card') })}><span className="di-card-count">{count}<small>×</small></span><span className="di-card-thumbnail"><CardArtwork card={card} decorative /></span><span className="di-card-identity"><strong>{card.name || card.code}</strong><small>{card.subtitle || t(rowType({ card, count }).replace(/^\w/, letter => letter.toUpperCase()))}</small></span><span className="di-card-cost" title={t('Resource cost')}><Zap size={11} />{card.cost ?? '—'}</span><Eye size={14} /></button>) : <div className="di-empty"><Search size={25} /><h3>{t('No matching cards')}</h3><p>{t('Try a different name, rule, type, or cost.')}</p><button className="secondary-button small-button" type="button" onClick={clearFilters}>{t('Clear filters')}</button></div>}</div>
      </section>
    </> : <div className="di-empty"><Layers3 size={25} /><p>{t('This deck has no card list available.')}</p></div>}
    {deck.supported === false && <div className="di-support-warning"><Shield size={16} /><p>{t('This deck includes cards whose scripts are unavailable.')}{deck.coverage?.missing?.length ? ` ${deck.coverage.missing.join(', ')}` : ''}</p></div>}
    <footer className="di-footer"><span><Layers3 size={15} />{t('{count} cards', { count: total || deck.count || 50 })}{baseHealth != null && <> · <Shield size={13} />{baseHealth} {t('base HP')}</>}</span><button type="button" className="primary-button" disabled={busy || deck.supported === false} onClick={onSelect}>{t(selected ? 'Use selected deck' : 'Use this deck')}<ArrowRight size={16} /></button></footer>
  </div>;
}

export default DeckInspector;
