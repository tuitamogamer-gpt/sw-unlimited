import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, CircleAlert, CircleCheck, Download, Eye, FileJson, FileText, Layers3, Link2, LoaderCircle, Shield, Upload, X } from 'lucide-react';
import { api, GameClientError } from '../game-client';
import type { Card, DeckImportResponse, ImportedDeck } from '../types';
import { t } from '../i18n';
import { exportCustomDeck, isImportedDeck } from '../custom-decks';
import { CardArtwork } from './CardArtwork';
import './custom-decks.css';

export interface CustomDeckImportProps {
  initialSeat?: 'human' | 'bot';
  onSave: (deck: ImportedDeck, seat?: 'human' | 'bot') => void | Promise<void>;
  onInspect: (card: Card) => void;
}

const MAX_FILE_BYTES = 100 * 1024;

function diagnostics(data: unknown): DeckImportResponse | null {
  if (!data || typeof data !== 'object') return null;
  const value = data as Partial<DeckImportResponse>;
  if (!Array.isArray(value.errors) && !Array.isArray(value.warnings)) return null;
  return { deck: value.deck, errors: Array.isArray(value.errors) ? value.errors : [], warnings: Array.isArray(value.warnings) ? value.warnings : [], issues: Array.isArray(value.issues) ? value.issues : [] };
}

export function CustomDeckImport({ initialSeat = 'human', onSave, onInspect }: CustomDeckImportProps) {
  const [input, setInput] = useState('');
  const [name, setName] = useState('');
  const [seat, setSeat] = useState<'human' | 'bot' | 'save'>(initialSeat);
  const [result, setResult] = useState<DeckImportResponse | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [filename, setFilename] = useState('');
  const [dragging, setDragging] = useState(false);
  const [showAllCards, setShowAllCards] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const preview = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; controller.current?.abort(); }; }, []);
  const deck = result?.deck;
  const canSave = !!deck && isImportedDeck(deck) && deck.validation?.valid === true && deck.supported !== false && result?.errors.length === 0;
  const cards = deck?.cards || [];
  const cardCount = cards.reduce((sum, row) => sum + row.count, 0) || deck?.recipe?.deck.reduce((sum, row) => sum + row.count, 0) || 0;
  const sideboardCount = deck?.recipe?.sideboard?.reduce((sum, row) => sum + row.count, 0) || 0;
  const shownCards = showAllCards ? cards : cards.slice(0, 8);

  const resetResult = () => { setResult(null); setError(''); setShowAllCards(false); };
  const loadFile = async (file?: File) => {
    if (!file || busy || saving) return;
    resetResult();
    if (!/\.(json|txt)$/i.test(file.name)) { setError('Choose a .json or .txt deck file.'); return; }
    if (file.size > MAX_FILE_BYTES) { setError('Deck files must be 100 KB or smaller.'); return; }
    try { const text = await file.text(); if (mounted.current) { setInput(text); setFilename(file.name); } }
    catch { if (mounted.current) setError('The deck file could not be read. Try pasting its contents instead.'); }
  };
  const validate = async () => {
    if (!input.trim() || busy || saving) return;
    if (new TextEncoder().encode(input).byteLength > MAX_FILE_BYTES) { setError('Deck input must be 100 KB or smaller.'); return; }
    setBusy(true); setError(''); setResult(null); setShowAllCards(false);
    controller.current?.abort();
    controller.current = new AbortController();
    try {
      const response = await api<DeckImportResponse>('/api/decks/import', { input: input.trim(), ...(name.trim() ? { name: name.trim() } : {}) }, 'POST', { signal: controller.current.signal, timeoutMs: 45_000 });
      if (!mounted.current) return;
      const parsed = diagnostics(response);
      if (!parsed) throw new Error('The import response was incomplete. Please validate the deck again.');
      setResult(parsed);
    } catch (caught) {
      if (!mounted.current) return;
      const parsed = caught instanceof GameClientError ? diagnostics(caught.details) : null;
      if (parsed) setResult(parsed); else setError(caught instanceof Error ? caught.message : 'This deck could not be imported. Try again.');
    } finally {
      if (mounted.current) { setBusy(false); requestAnimationFrame(() => preview.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })); }
    }
  };
  const save = async () => {
    if (!canSave || !deck || saving) return;
    setSaving(true); setError('');
    try { await onSave(deck, seat === 'save' ? undefined : seat); }
    catch (caught) { if (mounted.current) setError(caught instanceof Error ? caught.message : 'This deck could not be saved.'); }
    finally { if (mounted.current) setSaving(false); }
  };
  const renderIssues = (severity: 'error' | 'warning') => {
    const structured = result?.issues?.filter(issue => issue.severity === severity) || [];
    const fallback = severity === 'error' ? result?.errors || [] : result?.warnings || [];
    if (!structured.length && !fallback.length) return null;
    return <div className={`cdi-diagnostics cdi-${severity}`} role={severity === 'error' ? 'alert' : 'status'}><div><CircleAlert size={17} /><strong>{t(severity === 'error' ? 'Fix these issues before saving' : 'Import notes')}</strong></div><ul>{structured.length ? structured.map((issue, index) => <li key={`${issue.code}-${index}`}>{t(issue.message, { ...issue.params, ...(typeof issue.params?.section === 'string' ? { section: t(issue.params.section) } : {}) })}</li>) : fallback.map((message, index) => <li key={index}>{t(message)}</li>)}</ul></div>;
  };

  return <div className="cdi-root">
    <div className="cdi-intro"><span className="cdi-intro-icon"><FileJson size={26} /></span><div><h3>{t('Bring your own strategy.')}</h3><p>{t('Paste a SWUDB export, a text deck list, or a public SWUDB deck link. You can also upload a JSON or TXT file.')}</p></div></div>
    <div className="cdi-steps" aria-label={t('Import progress')}><span className={input.trim() ? 'complete' : 'active'}><b>{input.trim() ? <Check size={12} /> : '1'}</b>{t('Add deck')}</span><i /><span className={canSave ? 'complete' : result || busy ? 'active' : ''}><b>{canSave ? <Check size={12} /> : '2'}</b>{t('Validate')}</span><i /><span><b>3</b>{t('Save locally')}</span></div>
    <div className="cdi-form">
      <label className="cdi-name"><span>{t('Deck name')}<small>{t('Optional')}</small></span><input value={name} disabled={busy || saving} maxLength={100} placeholder={t('My custom deck')} onChange={event => { setName(event.target.value); resetResult(); }} /></label>
      <div className={`cdi-drop-area ${dragging ? 'is-dragging' : ''}`} onDragOver={event => { event.preventDefault(); if (!busy && !saving) setDragging(true); }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }} onDrop={event => { event.preventDefault(); setDragging(false); void loadFile(event.dataTransfer.files[0]); }}>
        <div className="cdi-input-heading"><label htmlFor="custom-deck-input">{t('Deck export or link')}</label><span><FileJson size={12} />{t('JSON')}<FileText size={12} />{t('TXT')}<Link2 size={12} />{t('LINK')}</span></div>
        <textarea id="custom-deck-input" spellCheck={false} value={input} disabled={busy || saving} placeholder={t('Paste your deck here…')} onChange={event => { setInput(event.target.value); setFilename(''); resetResult(); }} />
        <div className="cdi-input-footer"><button type="button" className="text-button" disabled={busy || saving} onClick={() => fileInput.current?.click()}><Upload size={14} />{t('Upload JSON / TXT')}</button>{filename ? <span className="cdi-filename" title={filename}>{filename}<button type="button" aria-label={t('Clear uploaded file')} disabled={busy || saving} onClick={() => { setInput(''); setFilename(''); resetResult(); }}><X size={12} /></button></span> : <span>{t('or drop a file here')}</span>}</div>
        <input ref={fileInput} type="file" accept=".json,.txt,application/json,text/plain" hidden onChange={event => { void loadFile(event.target.files?.[0]); event.target.value = ''; }} />
      </div>
      <p className="cdi-format-note">{t('Text lists should identify a leader, a base, and the main deck. If a public link is unavailable, use the SWUDB JSON export.')}</p>
      <details className="cdi-format-help"><summary>{t('Supported text format')}</summary><p>{t('Use section headings, then a quantity and card code on each line. Official card names are also accepted when unambiguous.')}</p><pre>{'Leader\n1 SOR_005\n\nBase\n1 SOR_029\n\nMain Deck\n3 SOR_042\n…'}</pre><p>{t('This is an excerpt. Add the remaining cards for a main deck of at least 50 cards.')}</p></details>
      <button type="button" className="primary-button cdi-validate" disabled={busy || saving || !input.trim()} onClick={() => void validate()}>{busy ? <LoaderCircle size={16} className="spin" /> : <Shield size={16} />}{t(busy ? 'Checking cards and scripts…' : 'Validate deck')}{!busy && <ArrowRight size={15} />}</button>
    </div>
    {error && <div className="cdi-error-message" role="alert"><CircleAlert size={17} /><p>{t(error)}</p><button type="button" aria-label={t('Dismiss')} onClick={() => setError('')}><X size={14} /></button></div>}
    {result && <div ref={preview} className="cdi-preview">
      <div className={`cdi-preview-status ${canSave ? 'is-valid' : 'is-invalid'}`}>{canSave ? <CircleCheck size={23} /> : <CircleAlert size={23} />}<div><h3>{t(canSave ? 'Your deck is ready.' : 'This deck needs a few changes.')}</h3><p>{t(canSave ? 'Every card is recognized and its rules are supported.' : 'Review the details below, update your list, and validate again.')}</p></div></div>
      {renderIssues('error')}{renderIssues('warning')}
      {deck && <><div className="cdi-preview-header"><div><span className="eyebrow">{t('CUSTOM DECK')}</span><h3>{deck.name}</h3></div><div><Layers3 size={16} /><strong>{cardCount}</strong><span>{t('main-deck cards')}</span>{sideboardCount > 0 && <small>{t('{count} sideboard cards', { count: sideboardCount })}</small>}</div></div><div className="cdi-commanders">{[deck.leader, deck.base].filter((card): card is Card => !!card).map((card, index) => <button type="button" key={card.id || index} onClick={() => onInspect(card)} aria-label={t('Inspect {name}', { name: card.name || '' })}><CardArtwork card={card} face="front" decorative /><span><small>{t(index === 0 ? 'LEADER' : 'BASE')}</small><strong>{card.name}</strong></span><Eye size={14} /></button>)}</div><div className="cdi-card-list">{shownCards.map(({ card, count }, index) => <button type="button" key={card.id || index} onClick={() => onInspect(card)}><span>{count}×</span><strong>{card.name || card.code}</strong><small>{card.code}</small><Eye size={12} /></button>)}</div>{cards.length > 8 && <button type="button" className="text-button cdi-show-all" onClick={() => setShowAllCards(value => !value)}>{t(showAllCards ? 'Show fewer cards' : 'Show all {count} card entries', { count: cards.length })}</button>}{!!deck.coverage?.missing?.length && <div className="cdi-missing-scripts"><strong>{t('Missing card scripts')}</strong><p>{deck.coverage.missing.join(' · ')}</p></div>}</>}
      {canSave && <div className="cdi-save-panel"><label><span>{t('After saving')}</span><select value={seat} onChange={event => setSeat(event.target.value as 'human' | 'bot' | 'save')} disabled={saving}><option value="human">{t('Use as my deck')}</option><option value="bot">{t('Use as AI deck')}</option><option value="save">{t('Save to collection only')}</option></select></label><p><Shield size={14} />{t('Saved in this browser. Card legality and scripts are checked again before each new game.')}</p><div><button type="button" className="secondary-button" onClick={() => deck && exportCustomDeck(deck)} disabled={saving}><Download size={15} />{t('Export JSON')}</button><button type="button" className="primary-button" disabled={saving} onClick={() => void save()}>{saving ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}{t(saving ? 'Saving…' : 'Save deck')}</button></div></div>}
      {!canSave && <button type="button" className="secondary-button cdi-return" onClick={() => document.getElementById('custom-deck-input')?.focus()}><ArrowLeft size={14} />{t('Edit deck list')}</button>}
    </div>}
  </div>;
}

export default CustomDeckImport;
