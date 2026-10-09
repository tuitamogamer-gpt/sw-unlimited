import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowLeft, ArrowRight, ArrowUpRight, BookOpen, Check, ChevronDown, CircleHelp, Crosshair, Crown, ExternalLink, Eye, Flag, Globe2, Layers3, LoaderCircle, Maximize2, Minus, Orbit, Plus, Radio, RotateCcw, Search, Settings2, Shield, Swords, Target, X, Zap, Download, Trash2, Upload } from 'lucide-react';
import type { Card, Deck, GameAction, GameView, Player, PromptButton, ImportedDeck, SavedCustomDeck, PublicPlayEvent } from './types';
import { t, useLanguage, translatePrompt as translate, phaseName } from './i18n';
import { api, storedValue, rememberGame, forgetGame, SESSION_KEY, mutateGame, resumeGame, checkpointNotice } from './game-client';
import { BattleFeedbackContext, useBattleFeedback, useOverflowCues } from './battle-feedback';
import { CardInspector } from './components/CardInspector';
import { CardEffects, ArenaDefeats } from './components/BattleEffects';
import { OpponentPlayPreview } from './components/OpponentPlayPreview';
import { useOpponentPresentation } from './use-opponent-presentation';
import { OPPONENT_PREVIEW_MS } from './opponent-presentation';
import { DeckInspector } from './components/DeckInspector';
import { CustomDeckImport } from './components/CustomDeckImport';
import { CardCatalog } from './components/CardCatalog';
import { readCustomDecks, persistCustomDecks, exportCustomDeck } from './custom-decks';
import './components/custom-decks.css';

type Source = { title?: string; name?: string; url: string; description?: string; kind?: string };
type ArenaReveal = { id: string; arena: 'ground' | 'space' } | null;
type Drawer = 'rules' | 'sources' | 'settings' | null;
const modalStack: symbol[] = [];
let modalBodyOverflow = '';
const PREFERENCES_KEY = 'swu-command-preferences';
const DIFFICULTIES = [{ id: 'easy', label: 'Kadet', detail: 'Prvi koraci i opuštena partija.' }, { id: 'normal', label: 'Zapovjednik', detail: 'Procjenjuje tempo, prijetnje i vrijednost karata.' }, { id: 'hard', label: 'Veliki admiral', detail: 'Prioriteti borbe, sinergije i planiranje resursa.' }];
const DEFAULT_SOURCES: Source[] = [
  { title: 'Službena pravila i errata', url: 'https://starwarsunlimited.com/how-to-play', description: 'Fantasy Flight Games · referentna pravila' },
  { title: 'SWUDB', url: 'https://swudb.com', description: 'Baza karata i javni API' },
  { title: 'Forceteki / Karabast', url: 'https://github.com/SWU-Karabast/forceteki', description: 'Otvoreni sustav pravila i skripte karata' },
  { title: 'Reddit · r/starwarsunlimited', url: 'https://www.reddit.com/r/starwarsunlimited/', description: 'Rasprave o kartama i situacijama u igri' },
  { title: 'BoardGameGeek', url: 'https://boardgamegeek.com/boardgame/393040/star-wars-unlimited', description: 'Pitanja o pravilima i rasprave zajednice' },
];

function preference(): { deckId?: string; opponentDeckId?: string; difficulty?: string; compact?: boolean; showLog?: boolean } {
  try { return JSON.parse(localStorage.getItem(PREFERENCES_KEY) || '{}'); } catch { return {}; }
}
function imageUrl(card?: Partial<Card>): string | undefined {
  if (card?.image) return card.image;
  if (card?.code) { const [set, number] = card.code.split('_'); return `https://cdn.swu-db.com/images/cards/${set?.toUpperCase()}/${number}.png`; }
  return undefined;
}
function IconButton({ children, label, onClick, className = '', disabled }: { children: ReactNode; label: string; onClick: () => void; className?: string; disabled?: boolean }) { return <button type="button" className={`icon-button ${className}`} onClick={onClick} aria-label={label} title={label} disabled={disabled}>{children}</button>; }
function CardImage({ card, className = '', decorative = false }: { card?: Partial<Card>; className?: string; decorative?: boolean }) {
  const [failed, setFailed] = useState(false); const url = imageUrl(card);
  useEffect(() => setFailed(false), [url]);
  return url && !failed ? <img src={url} alt={decorative ? '' : card?.name || t('Karta')} className={className} loading="lazy" onError={() => setFailed(true)} /> : <div className={`card-art-fallback ${className}`}><Orbit size={36} /><span>{card?.name || 'STAR WARS'}</span></div>;
}
function Brand({ small = false }: { small?: boolean }) { return <div className={`brand ${small ? 'brand-small' : ''}`}><div className="brand-emblem"><Orbit strokeWidth={1.3} /></div><div className="brand-wordmark"><span>{t("STAR WARS")}</span><strong>{t("UNLIMITED")}</strong></div><span className="brand-divider" /><span className="brand-app">{t("COMMAND")}<span>{t("SOLO PLAY SYSTEM")}</span></span></div>; }
function AspectDots({ aspects = [] }: { aspects?: string[] }) { return <div className="aspects" aria-label={aspects.join(', ')}>{aspects.map((aspect, i) => <span key={`${aspect}-${i}`} className={`aspect aspect-${aspect.toLowerCase()}`} title={aspect} />)}</div>; }
function Modal({ title, children, close, wide = false }: { title: string; children: ReactNode; close: () => void; wide?: boolean }) {
  const dialog = useRef<HTMLDivElement>(null);
  const modalId = useRef(Symbol('modal'));
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const id = modalId.current;
    if (!modalStack.length) modalBodyOverflow = document.body.style.overflow;
    modalStack.push(id);
    document.body.style.overflow = 'hidden';
    const onKey = (event: KeyboardEvent) => {
      if (modalStack.at(-1) !== id) return;
      if (event.key === 'Escape') close();
      if (event.key === 'Tab') {
        const nodes = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]') || [])].filter(node => node.getClientRects().length > 0);
        if (!nodes?.length) return;
        const first = nodes[0], last = nodes[nodes.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey); dialog.current?.querySelector<HTMLElement>('button')?.focus();
    return () => { document.removeEventListener('keydown', onKey); const index = modalStack.indexOf(id); if (index !== -1) modalStack.splice(index, 1); if (!modalStack.length) document.body.style.overflow = modalBodyOverflow; if (previous && document.contains(previous)) previous.focus(); };
  }, [close]);
  return <div className="modal-scrim" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}><div ref={dialog} className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}><header className="modal-header"><div><span className="eyebrow">{t("COMMAND DATABASE")}</span><h2>{title}</h2></div><IconButton label={t("Zatvori")} onClick={close}><X size={20} /></IconButton></header>{children}</div></div>;
}

export default function App() {
  const { language, setLanguage } = useLanguage();
  const prefs = useMemo(preference, []);
  const [customDecks, setCustomDecks] = useState<SavedCustomDeck[]>(readCustomDecks);
  const customDecksRef = useRef(customDecks); customDecksRef.current = customDecks;
  const [importOpen, setImportOpen] = useState(false);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [removeDeck, setRemoveDeck] = useState<SavedCustomDeck | null>(null);
  const closeImport = useCallback(() => setImportOpen(false), []);
  const closeCatalog = useCallback(() => setCatalogOpen(false), []);
  const closeRemoveDeck = useCallback(() => setRemoveDeck(null), []);
  const [decks, setDecks] = useState<Deck[]>([]); const [sources, setSources] = useState<Source[]>(DEFAULT_SOURCES);
  const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [deckId, setDeckId] = useState(prefs.deckId || ''); const [opponentDeckId, setOpponentDeckId] = useState(prefs.opponentDeckId || '');
  const [difficulty, setDifficulty] = useState(prefs.difficulty || 'normal'); const [game, setGame] = useState<GameView | null>(null);
  const [savedSession, setSavedSession] = useState(() => storedValue(SESSION_KEY));
  const requestPending = useRef(false);
  const [connectionNotice, setConnectionNotice] = useState('');
  const [feedbackEpoch, setFeedbackEpoch] = useState(0);
  const [presentationRevision, setPresentationRevision] = useState(0);
  const [arenaReveal, setArenaReveal] = useState<ArenaReveal>(null);
  const { preview, present, onPreviewReady } = useOpponentPresentation();
  const [newGameOpen, setNewGameOpen] = useState(false);
  const [drawer, setDrawer] = useState<Drawer>(null); const [inspect, setInspect] = useState<Card | null>(null);
  const [inspectHistory, setInspectHistory] = useState<Card[]>([]);
  const [inspectDeck, setInspectDeck] = useState<Deck | null>(null); const [rulesVersion, setRulesVersion] = useState('');
  const [slot, setSlot] = useState<'human' | 'bot'>('human'); const [setFilter, setSetFilter] = useState('all'); const [search, setSearch] = useState('');
  const [showLog, setShowLog] = useState(prefs.showLog !== false); const [finishedDismissed, setFinishedDismissed] = useState(false);
  const [compact, setCompact] = useState(prefs.compact === true);
  const allDecks = [...decks, ...customDecks];
  const selected = allDecks.find(deck => deck.id === deckId); const opponent = allDecks.find(deck => deck.id === opponentDeckId);
  const closeInspect = useCallback(() => { setInspect(null); setInspectHistory([]); }, []);
  const openInspect = (card: Card) => { setInspectHistory([]); setInspect(card); };
  const inspectRelated = (card: Card) => { if (inspect) setInspectHistory(history => [...history, inspect]); setInspect(card); };
  const previousInspect = () => { setInspect(inspectHistory.at(-1) || null); setInspectHistory(history => history.slice(0, -1)); }; const closeDeck = useCallback(() => setInspectDeck(null), []); const closeDrawer = useCallback(() => setDrawer(null), []);
  const inspectedCard = useMemo(() => {
    if (!inspect || !game || !inspect.uuid) return inspect;
    const flatten = (cards: Card[]): Card[] => cards.filter(Boolean).flatMap(card => [card, ...flatten(card.upgrades || []), ...flatten(card.captured || [])]);
    const visible = Object.values(game.players).flatMap(player => flatten([player.base, ...player.leaders, ...player.hand, ...player.ground, ...player.space, ...player.resources, ...player.discard, ...(player.credits || []), ...(player.outsideTheGame || [])]));
    return visible.find(card => card.uuid === inspect.uuid) || inspect;
  }, [inspect, game]);
  const loadDecks = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const data = await api<{ decks: Deck[]; sources?: Source[]; rulesVersion?: string } | Deck[]>('/api/decks');
      const list = (Array.isArray(data) ? data : data.decks).map(deck => ({ ...deck, aspects: deck.aspects || [...(deck.leader?.aspects || []), ...(deck.base?.aspects || [])] }));
      setDecks(list); setDeckId(old => list.some(d => d.id === old) || customDecksRef.current.some(d => d.id === old) ? old : list[0]?.id || ''); setOpponentDeckId(old => list.some(d => d.id === old) || customDecksRef.current.some(d => d.id === old) ? old : list[1]?.id || list[0]?.id || '');
      if (!Array.isArray(data)) { if (data.sources?.length) setSources(data.sources); setRulesVersion(data.rulesVersion || ''); }
    } catch (e) { setError((e as Error).message); } finally { setLoading(false); }
  }, []);
  useEffect(() => { void loadDecks(); }, [loadDecks]);
  useEffect(() => { try { localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ deckId, opponentDeckId, difficulty, compact, showLog })); } catch { /* Preferences are optional. */ } }, [deckId, opponentDeckId, difficulty, compact, showLog]);
  const showGameFrame = (view: GameView, revealed?: PublicPlayEvent) => {
    setGame(view); setPresentationRevision(value => value + 1);
    if (revealed) {
      const arena = (['ground', 'space'] as const).find(zone => view.players.bot[zone].some(card => card.uuid === revealed.card.uuid));
      if (arena) setArenaReveal({ id: revealed.id, arena });
    }
  };
  const acceptGame = (view: GameView, resetFeedback = false) => { rememberGame(view); if (resetFeedback) setFeedbackEpoch(value => value + 1); showGameFrame(view); setSavedSession(view.id); setConnectionNotice(checkpointNotice(view.id) || ''); };
  const closeNewGame = useCallback(() => setNewGameOpen(false), []);
  const startGame = async () => {
    if (!deckId || !opponentDeckId || requestPending.current) return;
    requestPending.current = true;
    setBusy(true); setError(''); setConnectionNotice(''); setNewGameOpen(false); setFinishedDismissed(false);
    try { const previous = game?.id || savedSession; const playerRecipe = customDecks.find(deck => deck.id === deckId)?.recipe; const opponentRecipe = customDecks.find(deck => deck.id === opponentDeckId)?.recipe; const next = await api<GameView>('/api/games', { ...(playerRecipe ? { playerDeck: playerRecipe } : { deckId }), ...(opponentRecipe ? { opponentDeck: opponentRecipe } : { opponentDeckId }), difficulty }); acceptGame(next); if (previous && previous !== next.id) void api(`/api/games/${encodeURIComponent(previous)}`, {}, 'DELETE').catch(() => {}).finally(() => forgetGame(previous)); window.scrollTo({ top: 0 }); }
    catch (e) { setError((e as Error).message); } finally { requestPending.current = false; setBusy(false); }
  };
  const resume = async () => {
    if (requestPending.current) return;
    requestPending.current = true;
    setBusy(true); setError('');
    try { acceptGame(await resumeGame(savedSession), true); }
    catch (e) { setError(t(`Spremljena sesija nije dostupna. ${(e as Error).message}`)); if ([400, 401, 403, 404, 410].includes((e as Error & { status?: number }).status || 0)) { forgetGame(savedSession); setSavedSession(''); } }
    finally { requestPending.current = false; setBusy(false); }
  };
  const act = async (action: GameAction) => {
    if (!game || requestPending.current) return;
    requestPending.current = true;
    setBusy(true); setError('');
    try { const result = await mutateGame(game, action); if (await present(game, result.view, result.restored, showGameFrame)) { acceptGame(result.view, result.restored); setConnectionNotice(result.notice || ''); } }
    catch (e) { setError((e as Error).message); } finally { requestPending.current = false; setBusy(false); }
  };
  const continueBot = async () => {
    if (!game || requestPending.current) return; requestPending.current = true; setBusy(true); setError('');
    try { const result = await mutateGame(game, 'bot'); if (await present(game, result.view, result.restored, showGameFrame)) { acceptGame(result.view, result.restored); setConnectionNotice(result.notice || ''); } }
    catch (e) { setError((e as Error).message); } finally { requestPending.current = false; setBusy(false); }
  };
  const requestNewGame = async () => { if (game ? !game.winnerIds.length : !!savedSession) setNewGameOpen(true); else await startGame(); };
  const reconnect = async () => {
    if (requestPending.current || !(game?.id || savedSession)) return;
    requestPending.current = true; setBusy(true); setError('');
    try { const restored = await resumeGame(game?.id || savedSession); acceptGame(restored, true); setConnectionNotice(checkpointNotice(restored.id) || 'Reconnected. Your saved game is ready.'); }
    catch (e) { setError((e as Error).message); }
    finally { requestPending.current = false; setBusy(false); }
  };
  const saveCustomDeck = (deck: ImportedDeck, seat?: 'human' | 'bot') => {
    const stored: SavedCustomDeck = { ...deck, aspects: deck.aspects || [...(deck.leader.aspects || []), ...(deck.base?.aspects || [])], savedAt: Date.now() };
    const next = [stored, ...customDecks.filter(existing => existing.id !== stored.id)];
    persistCustomDecks(next);
    setCustomDecks(next);
    if (seat === 'human') { setDeckId(stored.id); setSlot('human'); }
    if (seat === 'bot') { setOpponentDeckId(stored.id); setSlot('bot'); }
    setImportOpen(false);
    setConnectionNotice('Deck saved to your collection.');
  };
  const removeCustomDeck = () => {
    if (!removeDeck) return;
    const next = customDecks.filter(deck => deck.id !== removeDeck.id);
    try {
      persistCustomDecks(next); setCustomDecks(next);
      if (deckId === removeDeck.id) setDeckId(decks[0]?.id || next[0]?.id || '');
      if (opponentDeckId === removeDeck.id) setOpponentDeckId(decks[1]?.id || decks[0]?.id || next[0]?.id || '');
      if (inspectDeck?.id === removeDeck.id) setInspectDeck(null);
      setRemoveDeck(null); setConnectionNotice('Deck removed from your collection.');
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'This deck could not be removed.'); setRemoveDeck(null); }
  };
  const sets = [...new Set(decks.map(deck => deck.set))];
  const filtered = decks.filter(deck => (setFilter === 'all' || deck.set === setFilter) && `${deck.name} ${deck.leader?.name} ${deck.setName || ''}`.toLowerCase().includes(search.toLowerCase()));
  return <><div data-game-content inert={!!preview} className={`app ${game ? 'in-game' : ''} ${compact ? 'compact' : ''}`}>
    <header className="site-header"><button className="brand-button" onClick={() => setGame(null)} aria-label={t("Povratak u zapovjedništvo")}><Brand /></button><nav aria-label={t("Glavna navigacija")}><button className={!game ? 'nav-link active' : 'nav-link'} onClick={() => setGame(null)}><Layers3 size={15} /><span>{t("Zapovjedništvo")}</span></button><button className="nav-link" onClick={() => setDrawer('rules')}><BookOpen size={15} /><span>{t("Pravila igre")}</span></button><button className="nav-link" onClick={() => setDrawer('sources')}><Globe2 size={15} /><span>{t("Izvori")}</span></button></nav><div className="header-right"><select className="language-select" aria-label={t('Language')} value={language} onChange={event => setLanguage(event.target.value as 'en' | 'sr')}><option value="en">{t("EN")}</option><option value="sr">{t("SR")}</option></select><span className="system-status"><i /> {t("SUSTAV AKTIVAN")}</span><IconButton label={t("Postavke")} onClick={() => setDrawer('settings')}><Settings2 size={18} /></IconButton></div></header>
    {error && <div className="error-banner" role="alert"><CircleHelp size={18} /><span>{t(error)}</span>{game && <button className="reconnect-button" disabled={busy} onClick={() => void reconnect()}>{t('Reconnect')}</button>}<button onClick={() => setError('')} aria-label={t("Zatvori obavijest")}><X size={18} /></button></div>}
    {connectionNotice && <div className="connection-notice" role="status"><Radio size={16} /><span>{t(connectionNotice)}</span><button onClick={() => setConnectionNotice('')} aria-label={t('Dismiss')}><X size={17} /></button></div>}
    {game ? <GameTable game={game} feedbackEpoch={feedbackEpoch} presentationRevision={presentationRevision} arenaReveal={arenaReveal} busy={busy} act={act} inspect={openInspect} showLog={showLog} setShowLog={setShowLog} restart={requestNewGame} continueBot={continueBot} back={() => setGame(null)} help={() => setDrawer('rules')} /> : <main className="lobby">
      <section className="hero"><div className="hero-copy"><div className="eyebrow hero-eyebrow"><span className="signal-line" /> {t("TAKTIČKI SIMULATOR · 1 NA 1")}</div><h1>{t("GALAKSIJA ČEKA")}<br />{t("TVOG ")}<span>{t("ZAPOVJEDNIKA.")}</span></h1><p>{t("Izaberi svoju stranu. Okupi flotu.")}<br />{t("Odmjeri snage s AI protivnikom u igri Star Wars: Unlimited.")}</p><div className="hero-tags"><span><Swords size={15} /> {t("Igra protiv AI-ja")}</span><span><Zap size={15} /> {t("Automatizirana pravila")}</span><span><Layers3 size={15} /> {t("Početni špilovi")}</span></div>{savedSession && <button className="resume-button" onClick={resume} disabled={busy}><Radio size={16} /> {t("Nastavi posljednju partiju ")}<ArrowUpRight size={16} /></button>}</div><div className="hero-art" aria-hidden="true"><div className="orbit orbit-one" /><div className="orbit orbit-two" /><div className="orbit-crosshair" /><span className="sector-label">{t("SECTOR 07 / OUTER RIM")}</span><div className="hero-card hero-card-back"><CardImage card={opponent?.leader} decorative /></div><div className="hero-card hero-card-front"><CardImage card={selected?.leader} decorative /></div><div className="hero-art-label"><span className="signal-dot" /> {t("SUKOB JE NEIZBJEŽAN")}<span>{t("ODLUKA JE TVOJA.")}</span></div></div></section>
      <section className="mission-panel" aria-label={t("Postavljanje partije")}><div className="mission-heading"><span className="eyebrow">{t("01 / PRIPREMA MISIJE")}</span><span>{selected?.format?.includes('Intro') || opponent?.format?.includes('Intro') ? 'INTRO BATTLE · 20 HP' : 'PREMIER · 1V1'}</span></div><div className="mission-content"><button className={`combatant-select ${slot === 'human' ? 'selected' : ''}`} onClick={() => setSlot('human')}><div className="combatant-portrait friendly"><CardImage card={selected?.leader} decorative /></div><div><span className="eyebrow"><span className="friendly-dot" /> {t("TVOJ ŠPIL")}</span><h3>{selected?.leader?.name || t('Odaberi zapovjednika')}</h3><p>{selected?.name || t('Učitavanje arhive…')}</p></div><ChevronDown size={16} /></button><div className="versus"><span /><Swords size={23} /><span /></div><button className={`combatant-select enemy ${slot === 'bot' ? 'selected' : ''}`} onClick={() => setSlot('bot')}><div className="combatant-portrait"><CardImage card={opponent?.leader} decorative /></div><div><span className="eyebrow"><span className="enemy-dot" /> {t("AI PROTIVNIK")}</span><h3>{opponent?.leader?.name || t('Odaberi protivnika')}</h3><p>{opponent?.name || t('Učitavanje arhive…')}</p></div><ChevronDown size={16} /></button><div className="mission-launch"><label htmlFor="difficulty" className="eyebrow">{t("RAZINA PROTIVNIKA")}</label><div className="select-wrap"><select id="difficulty" value={difficulty} onChange={event => setDifficulty(event.target.value)}>{DIFFICULTIES.map(item => <option value={item.id} key={item.id}>{t(item.label)}</option>)}</select><ChevronDown size={14} /></div><button className="primary-button launch-button" onClick={requestNewGame} disabled={busy || loading || !selected || !opponent || selected?.supported === false || opponent?.supported === false}>{busy ? <LoaderCircle className="spin" size={19} /> : <Crosshair size={19} />}{busy ? t('Priprema bojišta…') : t('Započni bitku')}{!busy && <ArrowRight size={18} />}</button></div></div></section>
      <section className="custom-collection" aria-label={t('Your collection')}><div className="collection-tools"><div><span className="eyebrow">{t('YOUR COLLECTION')}</span><p>{t('Import a deck or browse every available card.')}</p></div><div><button type="button" className="secondary-button" onClick={() => setCatalogOpen(true)}><BookOpen size={15} />{t('Card library')}</button><button type="button" className="primary-button" onClick={() => setImportOpen(true)}><Upload size={15} />{t('Import a deck')}</button></div></div>{customDecks.length > 0 && <><div className="custom-collection-heading"><h2>{t('Custom decks')}<span>{customDecks.length}</span></h2><span>{t('Stored in this browser')}</span></div><div className="custom-deck-grid">{customDecks.map(deck => <article className={`custom-deck-row ${deck.id === deckId ? 'custom-player-selected' : ''} ${deck.id === opponentDeckId ? 'custom-bot-selected' : ''}`} data-custom-deck-id={deck.id} key={deck.id}><button type="button" className="custom-deck-identity" data-custom-action="inspect-cover" onClick={() => setInspectDeck(deck)}><span className="custom-deck-art"><CardImage card={deck.leader} decorative /></span><span><span className="eyebrow">{t('CUSTOM DECK')}</span><strong>{deck.name}</strong><small>{deck.leader.name} · {t('{count} cards', { count: deck.cards?.reduce((sum, row) => sum + row.count, 0) || 0 })}</small></span><Eye size={15} /></button><div className="custom-deck-seats"><button type="button" data-custom-seat="human" aria-pressed={deck.id === deckId} onClick={() => { setDeckId(deck.id); setSlot('human'); }}>{deck.id === deckId ? <Check size={13} /> : <Shield size={13} />}{t('Use as my deck')}</button><button type="button" data-custom-seat="bot" aria-pressed={deck.id === opponentDeckId} onClick={() => { setOpponentDeckId(deck.id); setSlot('bot'); }}>{deck.id === opponentDeckId ? <Check size={13} /> : <Crosshair size={13} />}{t('Use as AI deck')}</button></div><div className="custom-deck-actions"><button type="button" data-custom-action="inspect" onClick={() => setInspectDeck(deck)}><Eye size={12} />{t('View deck')}</button><button type="button" data-custom-action="export" onClick={() => exportCustomDeck(deck)}><Download size={12} />{t('Export JSON')}</button><button type="button" data-custom-action="remove" onClick={() => setRemoveDeck(deck)} aria-label={t('Remove custom deck')}><Trash2 size={13} /></button></div></article>)}</div></>}</section>
      <section className="deck-library" aria-labelledby="library-title"><div className="section-heading"><div><span className="eyebrow">{t("02 / ARHIVA ŠPILOVA")}</span><h2 id="library-title">{t("IZABERI SVOJU STRANU")}<span>{decks.length.toString().padStart(2, '0')}</span></h2></div><div className={`selection-indicator ${slot === 'bot' ? 'enemy-text' : ''}`}><span className="signal-dot" /> {t("Biraš špil za: ")}<strong>{slot === 'human' ? t('sebe') : t('AI protivnika')}</strong></div></div><div className="library-toolbar"><div className="set-filters" aria-label={t("Filtriraj set")}><button className={setFilter === 'all' ? 'active' : ''} onClick={() => setSetFilter('all')}>{t("Svi špilovi")}</button>{sets.map(set => <button className={setFilter === set ? 'active' : ''} key={set} onClick={() => setSetFilter(set)}>{set}</button>)}</div><label className="search-field"><Search size={16} /><input aria-label={t("Pretraži špilove")} placeholder={t("Pronađi zapovjednika…")} value={search} onChange={e => setSearch(e.target.value)} /></label></div>
        {loading ? <div className="loading-state"><LoaderCircle className="spin" size={28} /><p>{t("Pristup galaktičkoj arhivi…")}</p></div> : decks.length === 0 ? <div className="empty-state"><Radio size={32} /><h3>{t("Arhiva trenutačno nije dostupna")}</h3><p>{t("Provjeri vezu s poslužiteljem i pokušaj ponovo.")}</p><button className="secondary-button" onClick={loadDecks}><RotateCcw size={16} /> {t("Pokušaj ponovo")}</button></div> : filtered.length === 0 ? <div className="empty-state"><Search size={28} /><h3>{t("Nema pronađenih špilova")}</h3><button className="text-button" onClick={() => { setSearch(''); setSetFilter('all'); }}>{t("Očisti filtere")}</button></div> : <div className="deck-grid">{filtered.map((deck, i) => <DeckTile key={deck.id} deck={deck} index={i} playerSelected={deck.id === deckId} botSelected={deck.id === opponentDeckId} activeSelected={deck.id === (slot === 'human' ? deckId : opponentDeckId)} select={() => slot === 'human' ? setDeckId(deck.id) : setOpponentDeckId(deck.id)} inspect={() => setInspectDeck(deck)} />)}</div>}
      </section><section className="how-it-works"><div><span className="eyebrow">{t("TAKTIČKA PREDNOST")}</span><h2>{t("Jedna akcija. Bezbroj mogućnosti.")}</h2><p>{t("Igrajte naizmjence, razvijajte resurse i napadajte u dvije arene. Uništi protivničku bazu prije nego što padne tvoja.")}</p></div><div className="how-item"><span>01</span><Crosshair /><h3>{t("Preuzmi inicijativu")}</h3><p>{t("Prvi potez sljedeće runde može promijeniti sve.")}</p></div><div className="how-item"><span>02</span><Orbit /><h3>{t("Vladaj objema arenama")}</h3><p>{t("Poveži kopnene snage i svemirsku flotu.")}</p></div><div className="how-item"><span>03</span><Crown /><h3>{t("Rasporedi vođu")}</h3><p>{t("U pravom trenutku pošalji zapovjednika u borbu.")}</p></div></section>
    </main>}
    {!game && <footer className="site-footer"><Brand small /><p>{t("Neslužbeni projekt zajednice. Star Wars i pripadajući sadržaj © Lucasfilm / Fantasy Flight Games.")}</p><button className="text-button" onClick={() => setDrawer('sources')}>{t("Podaci i izvori ")}<ArrowUpRight size={14} /></button></footer>}
    {drawer && <Modal title={drawer === 'rules' ? t('Priručnik zapovjednika') : drawer === 'sources' ? t('Izvori i podaci') : t('Postavke sustava')} close={closeDrawer} wide={drawer === 'rules'}>{drawer === 'rules' ? <RulesContent openSources={() => setDrawer('sources')} version={rulesVersion} /> : drawer === 'sources' ? <div className="modal-body sources-body"><p className="muted">{t("Službena pravila imaju prednost pred tumačenjima zajednice. Izvori zajednice služe za pojašnjenja specifičnih situacija.")}</p>{sources.map((source, i) => <a key={i} className="source-link" href={source.url} target="_blank" rel="noreferrer"><span><strong>{t(source.title || source.name || new URL(source.url).hostname)}</strong><small>{t(source.description || source.kind || source.url)}</small></span><ExternalLink size={17} /></a>)}<div className="notice"><CircleHelp size={18} /><span>{t("Projekt nije službeno povezan s Lucasfilmom, FFG-om ili Karabastom. Katalog prikazuje dostupnost skripti; posebna ograničenja navedena su uz špil.")}</span></div></div> : <div className="modal-body"><div className="setting-block"><h3>{t("Razina AI protivnika")}</h3><p className="muted">{t("Promjena vrijedi za sljedeću partiju.")}</p><div className="difficulty-options">{DIFFICULTIES.map(item => <button key={item.id} className={difficulty === item.id ? 'selected' : ''} onClick={() => setDifficulty(item.id)}><span><strong>{t(item.label)}</strong><small>{t(item.detail)}</small></span>{difficulty === item.id && <Check size={18} />}</button>)}</div></div><div className="setting-row"><span><strong>{t("Kompaktne karte")}</strong><small>{t("Više prostora za velike arene.")}</small></span><button className={`toggle ${compact ? 'on' : ''}`} role="switch" aria-checked={compact} aria-label={t("Kompaktne karte")} onClick={() => setCompact(!compact)}><i /></button></div><div className="setting-row"><span><strong>{t("Dnevnik partije")}</strong><small>{t("Prikaži poteze uz bojište.")}</small></span><button className={`toggle ${showLog ? 'on' : ''}`} role="switch" aria-checked={showLog} aria-label={t("Dnevnik partije")} onClick={() => setShowLog(!showLog)}><i /></button></div><div className="notice"><Radio size={17} /><span>{t("Partija se šifrirano pamti u ovom pregledniku do šest sati od početka. Možeš je nastaviti nakon osvježavanja stranice. Koristi jednu karticu preglednika po partiji.")}</span></div></div>}</Modal>}
    {newGameOpen && <Modal title={t('Start a new game?')} close={closeNewGame}><div className="modal-body"><p>{t('Your current saved game will be replaced. Keep playing to return to it.')}</p><div className="claim-actions"><button className="secondary-button" onClick={closeNewGame}>{t('Keep playing')}</button><button className="primary-button" disabled={busy} onClick={() => void startGame()}>{t('Start new game')}</button></div></div></Modal>}
    {catalogOpen && <Modal title={t('Card library')} close={closeCatalog} wide><CardCatalog onInspect={openInspect} /></Modal>}
    {importOpen && <Modal title={t('Import a deck')} close={closeImport} wide><CustomDeckImport initialSeat={slot} onSave={saveCustomDeck} onInspect={openInspect} /></Modal>}
    {removeDeck && <Modal title={t('Remove custom deck?')} close={closeRemoveDeck}><div className="modal-body custom-remove-confirmation"><Trash2 size={29} /><p>{t('This removes {name} from this browser. Any saved game can still be resumed.', { name: removeDeck.name })}</p><div className="claim-actions"><button type="button" className="secondary-button" onClick={closeRemoveDeck}>{t('Keep deck')}</button><button type="button" className="primary-button" onClick={removeCustomDeck}>{t('Remove deck')}</button></div></div></Modal>}
    {inspectDeck && <Modal title={inspectDeck.name} close={closeDeck} wide><DeckInspector deck={inspectDeck} onInspect={openInspect} onSelect={() => { slot === 'human' ? setDeckId(inspectDeck.id) : setOpponentDeckId(inspectDeck.id); setInspectDeck(null); }} selected={(slot === 'human' ? deckId : opponentDeckId) === inspectDeck.id} busy={busy} /></Modal>}
    {inspectedCard && <Modal title={inspectedCard.name || t('Card details')} close={closeInspect} wide><CardInspector card={inspectedCard} onInspect={inspectRelated} onBack={inspectHistory.length ? previousInspect : undefined} action={game?.legalActions.find(action => action.type === 'card' && action.cardId === inspectedCard.uuid)} onAction={action => { const legal = game?.legalActions.find(candidate => candidate.type === action.type && candidate.cardId === action.cardId && candidate.promptId === action.promptId); closeInspect(); if (legal) void act(legal); }} busy={busy} /></Modal>}
    {game && !preview && game.winnerIds?.length > 0 && !finishedDismissed && <Modal title={game.winnerIds.length > 1 ? t('Neriješen ishod') : game.winnerIds.includes('human') ? t('Misija uspješno završena') : t('Bitka je završena')} close={() => setFinishedDismissed(true)}><div className="victory-content"><div className={`victory-symbol ${game.winnerIds.includes('human') ? 'won' : ''}`}>{game.winnerIds.includes('human') ? <Crown size={48} /> : <Shield size={48} />}</div><span className="eyebrow">{t("RUNDA ")}{game.round}</span><h2>{game.winnerIds.length > 1 ? t('RAVNOTEŽA U GALAKSIJI.') : game.winnerIds.includes('human') ? t('POBJEDA JE TVOJA.') : t('GALAKSIJA PAMTI HRABRE.')}</h2><p>{game.winnerIds.length > 1 ? t('Obje baze pale su istodobno. Partija je završila neriješeno.') : game.winnerIds.includes('human') ? t('Protivnička baza je pala. Odličan posao, zapovjedniče.') : t('Ovaj put protivnik je bio uspješniji. Novi plan, nova prilika.')}</p><button className="primary-button" onClick={requestNewGame} disabled={busy}><RotateCcw size={17} /> {t("Nova partija")}</button><button className="text-button" onClick={() => setFinishedDismissed(true)}>{t("Pregledaj završno stanje ")}<ArrowRight size={15} /></button></div></Modal>}
  </div>{preview && <OpponentPlayPreview key={preview.id} card={preview.card} kind={preview.kind} sequenceKey={preview.id} durationMs={OPPONENT_PREVIEW_MS} onReady={() => onPreviewReady(preview.id)} />}</>;
}

function DeckTile({ deck, index, playerSelected, botSelected, activeSelected, select, inspect }: { deck: Deck; index: number; playerSelected: boolean; botSelected: boolean; activeSelected: boolean; select: () => void; inspect: () => void }) {
  return <article className={`deck-tile ${activeSelected ? 'deck-selected' : ''} ${deck.supported === false ? 'deck-unsupported' : ''}`} style={{ '--tile-delay': `${Math.min(index, 12) * 35}ms` } as React.CSSProperties}><button className="deck-tile-main" onClick={select} aria-label={t(`Odaberi špil ${deck.name}`)} aria-pressed={activeSelected}><div className="deck-art"><CardImage card={deck.leader} decorative /><span className="deck-set">{deck.set}</span><div className="deck-selection-badges">{playerSelected && <span className="your-deck"><Check size={10} /> {t("TVOJ ŠPIL")}</span>}{botSelected && <span className="bot-deck"><Crosshair size={10} /> {t("AI")}</span>}</div><span className="deck-art-index">{(index + 1).toString().padStart(2, '0')}</span></div><div className="deck-info"><div className="deck-faction"><span>{deck.format?.includes('Intro') ? 'INTRO BATTLE · 20 HP' : deck.product?.includes('Spotlight') ? 'SPOTLIGHT DECK' : 'STARTER DECK'}</span><AspectDots aspects={deck.aspects} /></div><h3>{deck.leader?.name || deck.name}</h3><p>{deck.leader?.subtitle || deck.name}</p></div></button><div className="deck-tile-footer"><span className={deck.supported === false ? 'unsupported-label' : ''}>{deck.supported === false ? t('Skripte nedostaju') : t('{count} cards', { count: deck.count || deck.cards?.reduce((sum, row) => sum + row.count, 0) || 50 })}</span><button onClick={inspect}>{t("Pregled špila ")}<ArrowUpRight size={14} /></button></div></article>;
}

function GameTable({ game, feedbackEpoch, presentationRevision, arenaReveal, busy, act, inspect, showLog, setShowLog, restart, continueBot, back, help }: { game: GameView; feedbackEpoch: number; presentationRevision: number; arenaReveal: ArenaReveal; busy: boolean; act: (a: GameAction) => Promise<void>; inspect: (card: Card) => void; showLog: boolean; setShowLog: (show: boolean) => void; restart: () => Promise<void>; continueBot: () => Promise<void>; back: () => void; help: () => void }) {
  const { language, setLanguage } = useLanguage();
  const human = game.players.human, bot = game.players.bot;
  const feedback = useBattleFeedback(game, { resetKey: feedbackEpoch, presentationRevision });
  const handOverflow = useOverflowCues();
  const allCards = useMemo(() => { const flatten = (cards: Card[]): Card[] => cards.filter(Boolean).flatMap(card => [card, ...flatten(card.upgrades || []), ...flatten(card.captured || [])]); return Object.values(game.players).flatMap(player => flatten([player.base, ...(player.leaders || [player.leader]), ...player.hand, ...player.ground, ...player.space, ...player.resources, ...player.discard, ...(player.credits || []), ...(player.outsideTheGame || [])])); }, [game]);
  const [activeArena, setActiveArena] = useState<'ground' | 'space'>('ground');
  const [pile, setPile] = useState<{ title: string; cards: Card[] } | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [cardNotice, setCardNotice] = useState('');
  const closePile = useCallback(() => setPile(null), []);
  const closeLog = useCallback(() => setLogOpen(false), []);
  const stage = promptStage(game);
  const cardAction = (card: Card) => game.legalActions.find(a => a.type === 'card' && a.cardId === card.uuid);
  useEffect(() => { setCardNotice(''); }, [game.prompt.id]);
  useEffect(() => { if (arenaReveal) setActiveArena(arenaReveal.arena); }, [arenaReveal]);
  useEffect(() => {
    if (stage !== 'target') return;
    const groundTargets = [...human.ground, ...bot.ground].some(card => game.prompt.selectableCardIds.includes(card.uuid));
    const spaceTargets = [...human.space, ...bot.space].some(card => game.prompt.selectableCardIds.includes(card.uuid));
    if (groundTargets && !spaceTargets) setActiveArena('ground');
    if (spaceTargets && !groundTargets) setActiveArena('space');
  }, [game.prompt.id, stage, human.ground, human.space, bot.ground, bot.space, game.prompt.selectableCardIds]);
  const handleCard = (card: Card) => {
    const action = cardAction(card);
    if (action) { setCardNotice(''); void act(action); return; }
    if (card.hidden) return;
    if (card.zone === 'hand' && stage === 'action') {
      setCardNotice(card.playBlockedReason || 'This card has no legal play right now. Open its details to check its requirements.');
      return;
    }
    if (card.exhausted && (card.zone === 'groundArena' || card.zone === 'spaceArena') && card.controllerId === 'human') {
      setCardNotice('This unit is exhausted. It readies during regroup.');
      return;
    }
    inspect(card);
  };
  const currentReason = game.botReason || game.botThinking?.reason || game.ai?.reason || game.ai?.lastDecision?.reason || game.botHistory?.at(-1)?.reason;
  const ended = game.winnerIds?.length > 0;
  const legalInArena = (arena: 'ground' | 'space') => [...human[arena], ...bot[arena]].filter(card => !!cardAction(card)).length;
  const renderLog = () => <><div className="ai-status"><div className="ai-icon"><Crosshair size={22} /></div><div><span className="eyebrow">{t('AI OPPONENT')}</span><h3>{t(DIFFICULTIES.find(d => d.id === game.difficulty)?.label || 'Commander')}</h3></div><span className="signal-dot enemy-dot" /></div><div className="ai-reason"><span className="eyebrow">{t('LATEST DECISION')}</span><p>{t(currentReason || (busy ? 'Evaluating the battlefield…' : 'The AI weighs base damage, tempo, threats, and favorable trades.'))}</p></div><div className="log-heading"><h3>{t('Battle log')}</h3><span>{game.log.length}</span></div><div className="game-log" role="log" aria-label={t('Battle log')}>{game.log.length ? [...game.log].reverse().map((entry, i) => <div className={`log-entry ${i === 0 ? 'latest' : ''}`} key={typeof entry === 'string' ? `${game.log.length - i}` : entry.id || `${game.log.length - i}`}><span className="log-marker" /><div><p>{t(typeof entry === 'string' ? entry : entry.message || entry.text || '')}</p>{typeof entry !== 'string' && entry.round != null && <span>{t('ROUND')} {entry.round}</span>}</div></div>) : <div className="log-empty">{t('Awaiting your first orders.')}</div>}</div></>;
  return <BattleFeedbackContext.Provider value={feedback}><main className={`game-shell ${showLog ? '' : 'without-log'}`} data-stage={stage}>
    <div className="game-topbar"><button className="text-button" onClick={back} aria-label={t('Back to command')}><ArrowLeft size={15} /><span>{t('Command')}</span></button><div className="round-label"><span>{t('ROUND')}</span><strong>{String(game.round || 1).padStart(2, '0')}</strong><i /><span>{phaseName(game.phase)}</span></div><div className="game-tools"><button className="icon-button mobile-log-button" aria-label={t('Battle log')} onClick={() => setLogOpen(true)}><Radio size={16} /></button><IconButton className="desktop-log-button" label={showLog ? t('Hide battle log') : t('Show battle log')} onClick={() => setShowLog(!showLog)}><Radio size={17} /></IconButton><IconButton label={t('How to play')} onClick={help}><CircleHelp size={16} /></IconButton><select className="language-select" aria-label={t('Language')} value={language} onChange={event => setLanguage(event.target.value as 'en' | 'sr')}><option value="en">{t("EN")}</option><option value="sr">{t("SR")}</option></select><IconButton className="desktop-log-button" label={t('Start a new game')} onClick={() => void restart()} disabled={busy}><RotateCcw size={16} /></IconButton></div></div>
    <div className="battle-layout"><div className="battlefield">
      <div className="commander-row opponent-row"><PlayerPanel player={bot} enemy inspect={inspect} cardAction={cardAction} onCard={handleCard} busy={busy} /><div className="commander-meta"><div className="opponent-hand" aria-label={t('Opponent hand: {count} cards', { count: bot.handCount })}>{Array.from({ length: Math.min(bot.handCount, 7) }, (_, i) => <div className="card-back" key={i}><Orbit size={21} strokeWidth={1} /></div>)}<span>{bot.handCount} {t('IN HAND')}</span></div><div className="resource-mini"><Zap size={14} /><strong>{bot.readyResources}<small>{t("/")}{bot.resourceCount}</small></strong><span>{t('RESOURCES')}</span></div><PilePanel player={bot} enemy open={setPile} /></div><Initiative game={game} player={bot} /></div>
      <div className="arena-tabs" role="tablist" aria-label={t('Battle arena')}>{(['ground', 'space'] as const).map(arena => <button key={arena} id={`tab-${arena}`} role="tab" tabIndex={activeArena === arena ? 0 : -1} onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const next = event.key === 'Home' ? 'ground' : event.key === 'End' ? 'space' : arena === 'ground' ? 'space' : 'ground'; setActiveArena(next); document.getElementById(`tab-${next}`)?.focus(); } }} aria-selected={activeArena === arena} aria-controls={`arena-${arena}`} aria-label={t(arena === 'ground' ? 'Ground' : 'Space')} className={`${activeArena === arena ? 'active' : ''} ${legalInArena(arena) ? 'has-target' : ''}`} onClick={() => setActiveArena(arena)}>{arena === 'ground' ? <Target size={15} /> : <Orbit size={15} />}<span>{t(arena === 'ground' ? 'Ground' : 'Space')}</span><strong>{human[arena].length} <small>{t("/ ")}{bot[arena].length}</small></strong>{legalInArena(arena) > 0 && stage === 'target' && <i />}</button>)}</div>
      <div className="arenas" data-active-arena={activeArena}><Arena name={t('GROUND ARENA')} kind="ground" enemyCards={bot.ground} friendlyCards={human.ground} cardAction={cardAction} onCard={handleCard} inspect={inspect} busy={busy} attackerId={game.prompt?.attackerId} stage={stage} /><Arena name={t('SPACE ARENA')} kind="space" enemyCards={bot.space} friendlyCards={human.space} cardAction={cardAction} onCard={handleCard} inspect={inspect} busy={busy} attackerId={game.prompt?.attackerId} stage={stage} /></div>
      <div className="commander-row friendly-row"><PlayerPanel player={human} inspect={inspect} cardAction={cardAction} onCard={handleCard} busy={busy} /><div className="commander-meta"><button className="resource-mini friendly-resources" onClick={() => setPile({ title: t('Your resources'), cards: human.resources })} aria-label={t('View your resources')}><Zap size={17} /><strong>{human.readyResources}<small>{t("/")}{human.resourceCount}</small></strong><span>{t('READY RESOURCES')}</span><div className="resource-pips">{Array.from({ length: Math.min(human.resourceCount, 12) }, (_, i) => <i key={i} className={i < human.readyResources ? 'ready' : ''} />)}</div></button><PilePanel player={human} open={setPile} /></div><Initiative game={game} player={human} /></div>
      <section className="hand-section" aria-label={t('Your hand')}><div className="hand-heading"><span className="eyebrow">{t('YOUR HAND')} <b>{human.hand.length}</b></span>{feedback.message && <button className="battle-update" title={t(feedback.message)} onClick={() => setLogOpen(true)} aria-label={`${t('Latest move')}: ${t(feedback.message)}`}><Radio size={12} /><span>{t(feedback.message)}</span></button>}{!feedback.message && <span className={stage === 'resource' ? 'resource-hand-cue' : 'play-hand-cue'}>{handOverflow.overflowing ? <span className="hand-overflow-cue"><ArrowLeft size={11} />{t('Swipe for more')}<ArrowRight size={11} /></span> : stage === 'resource' ? <><Layers3 size={12} />{t('SELECT RESOURCES')}</> : stage === 'action' ? <><Zap size={12} />{t(human.hand.some(card => card.playable) ? 'TAP A PLAY BUTTON' : 'NO PLAYABLE CARDS')}</> : <><Eye size={12} />{t('TAP TO INSPECT')}</>}</span>}<span className="sr-only" role="status" aria-live="polite">{feedback.message ? t(feedback.message) : ''}</span></div><div ref={handOverflow.ref} tabIndex={0} aria-label={t('Your hand')} className={`hand-cards ${handOverflow.className}`}>{human.hand.map((card, i) => <GameCard key={card.uuid || i} card={card} mode="hand" canAct={!!cardAction(card)} action={cardAction(card)} stage={stage} readyResources={human.readyResources} onClick={() => handleCard(card)} inspect={() => inspect(card)} busy={busy} />)}{!human.hand.length && <div className="empty-hand"><Layers3 size={20} />{t('Your hand is empty.')}</div>}</div></section>
      <div className="command-dock"><TokenControls game={game} busy={busy} act={act} inspect={inspect} /><PromptPanel game={game} busy={busy} act={act} cards={allCards} inspect={inspect} notice={cardNotice} clearNotice={() => setCardNotice('')} />{game.warnings?.length ? <button className="secondary-button bot-recovery" disabled={busy} onClick={() => void continueBot()}><RotateCcw size={14} />{t('Continue AI turn')}</button> : null}</div>
    </div>{showLog && <aside className="command-sidebar"><div className="sidebar-title"><span className="eyebrow">{t('TACTICAL CENTER')}</span><Radio size={15} /></div>{renderLog()}<div className="sidebar-footer"><Shield size={14} /><span>{t(ended ? 'Game complete' : 'Rules enforced by the game engine')}</span></div></aside>}</div>
    {logOpen && <Modal title={t('Battle log')} close={closeLog}><div className="battle-log-overlay">{renderLog()}</div></Modal>}
    {pile && <Modal title={pile.title} close={closePile} wide><div className="pile-grid">{pile.cards.length ? pile.cards.map((card, i) => card.hidden ? <div className="hidden-pile-card" key={i}><Orbit /><span>{t('Hidden card')}</span></div> : <GameCard key={card.uuid || i} card={card} mode="hand" canAct={!!cardAction(card)} action={cardAction(card)} stage={stage} onClick={() => { if (cardAction(card)) { handleCard(card); setPile(null); } else { setPile(null); inspect(card); } }} inspect={() => { setPile(null); inspect(card); }} busy={busy} />) : <div className="empty-state">{t('This pile is empty.')}</div>}</div></Modal>}
  </main></BattleFeedbackContext.Provider>;
}

function promptStage(game: GameView): string {
  if (game.winnerIds?.length) return 'finished';
  if (game.prompt.stage) return game.prompt.stage;
  if (game.prompt.type === 'resource' || /cards? to resource/i.test(game.prompt.title)) return 'resource';
  if (game.prompt.type === 'actionWindow') return 'action';
  if (/mulligan/i.test(game.prompt.title)) return 'mulligan';
  if (game.prompt.type === 'initiative') return 'initiative';
  if (game.prompt.attackerId || /target|attack/i.test(game.prompt.title)) return 'target';
  return game.prompt.active ? 'choice' : 'waiting';
}

function PlayerPanel({ player, enemy = false, inspect, cardAction, onCard, busy }: { player: Player; enemy?: boolean; inspect: (card: Card) => void; cardAction: (c: Card) => GameAction | undefined; onCard: (card: Card) => void; busy: boolean }) {
  const feedback = useContext(BattleFeedbackContext);
  const base = player.base; const maximum = Number(base?.hp) || 30; const remaining = base?.remainingHp ?? maximum - (base?.damage || 0); const leader = player.leader || player.leaders?.[0];
  return <div className={`player-panel ${enemy ? 'enemy' : 'friendly'} ${player.active ? 'player-active' : ''}`}><div className="player-name"><span className={enemy ? 'enemy-dot' : 'friendly-dot'} /><span>{t(enemy ? 'AI OPPONENT' : 'YOUR COMMAND')}</span>{player.active && <small>{t('ACTIVE')}</small>}</div><div className="player-cards"><div className={`leader-mini ${leader?.exhausted ? 'is-exhausted' : ''} ${leader && cardAction(leader) ? 'is-legal' : ''}`}><button data-card-id={leader?.uuid} onClick={() => leader && onCard(leader)} disabled={busy || !leader} aria-label={leader?.name || t('Leader')}><CardImage card={leader} decorative /><span>{leader?.name || t('Leader')}</span>{leader && cardAction(leader) && <em className="leader-action-hint">{t(cardAction(leader)?.intent === 'deploy' ? 'DEPLOY' : 'ABILITY')}</em>}</button>{leader && <IconButton label={t('Inspect {name}', { name: leader.name || '' })} onClick={() => inspect(leader)}><Maximize2 size={11} /></IconButton>}</div><button data-card-id={base?.uuid} className={`base-panel ${base && cardAction(base) ? 'is-legal' : ''} ${feedback.damaged.has(base.uuid) ? 'is-damaged' : ''} ${feedback.healed.has(base.uuid) ? 'is-healed' : ''}`} onClick={() => base && onCard(base)} disabled={busy || !base} aria-label={t('{name}, {hp} of {max} health', { name: base?.name || t('Base'), hp: remaining, max: maximum })}><span className="base-art"><CardImage card={base} decorative /></span><span className="base-content"><span className="base-name"><Shield size={12} /><span>{base?.name || t('BASE')}</span></span><span className="base-health"><strong>{remaining}</strong><span>{t("/ ")}{maximum}</span></span><span className="health-track"><i style={{ width: `${Math.max(0, Math.min(100, remaining / maximum * 100))}%` }} /></span>{base && cardAction(base) && <span className="base-target-label"><Crosshair size={10} />{t('TARGET BASE')}</span>}</span><CardEffects cardId={base.uuid} /></button></div></div>;
}
function PilePanel({ player, enemy = false, open }: { player: Player; enemy?: boolean; open: (p: { title: string; cards: Card[] }) => void }) { return <div className="pile-panel"><div className="pile-stat" title={t('Cards in deck')}><Layers3 size={16} /><strong>{player.deckCount}</strong><span>{t('DECK')}</span></div><button className="pile-stat" onClick={() => open({ title: t(enemy ? 'Opponent discard pile' : 'Your discard pile'), cards: player.discard })}><Layers3 size={16} /><strong>{player.discard.length}</strong><span>{t('DISCARD')}</span></button></div>; }
function Initiative({ game, player }: { game: GameView; player: Player }) { return <div className={`initiative ${player.hasInitiative ? 'held' : ''}`} title={t(player.hasInitiative ? 'Has initiative' : 'No initiative')}><div><Crosshair size={23} /></div><span>{t('INITIATIVE')}</span><small>{player.hasInitiative ? t(game.initiativeClaimed ? 'CLAIMED' : 'READY') : '—'}</small></div>; }
function Arena({ name, kind, enemyCards, friendlyCards, cardAction, onCard, inspect, busy, attackerId, stage }: { name: string; kind: 'ground' | 'space'; enemyCards: Card[]; friendlyCards: Card[]; cardAction: (c: Card) => GameAction | undefined; onCard: (c: Card) => void; inspect: (c: Card) => void; busy: boolean; attackerId?: string; stage: string }) {
  const enemyOverflow = useOverflowCues(), friendlyOverflow = useOverflowCues();
  return <section id={`arena-${kind}`} className={`arena arena-${kind}`} aria-label={name}><div className="arena-label">{kind === 'ground' ? <Target size={14} /> : <Orbit size={15} />}<span>{name}</span><small>{enemyCards.length + friendlyCards.length} {t('UNITS')}</small></div><div ref={enemyOverflow.ref} tabIndex={0} aria-label={t('Opponent units')} className={`arena-side enemy-arena ${enemyOverflow.className}`}>{enemyCards.map(card => <GameCard key={card.uuid} card={card} canAct={!!cardAction(card)} action={cardAction(card)} stage={stage} onClick={() => onCard(card)} inspect={() => inspect(card)} busy={busy} enemy attacking={attackerId === card.uuid} />)}{!enemyCards.length && <div className="arena-empty"><span /><small>{t('OPPONENT SECTOR')}</small><span /></div>}</div><div className="arena-midline"><i /><span>{t(kind === 'ground' ? 'GROUND' : 'SPACE')}</span><i /><ArenaDefeats kind={kind} /></div><div ref={friendlyOverflow.ref} tabIndex={0} aria-label={t('Your units')} className={`arena-side friendly-arena ${friendlyOverflow.className}`}>{friendlyCards.map(card => <GameCard key={card.uuid} card={card} canAct={!!cardAction(card)} action={cardAction(card)} stage={stage} onClick={() => onCard(card)} inspect={() => inspect(card)} busy={busy} attacking={attackerId === card.uuid} />)}{!friendlyCards.length && <div className="arena-empty"><span /><small>{t('YOUR SECTOR')}</small><span /></div>}</div></section>;
}
function GameCard({ card, canAct, action, stage = 'choice', readyResources, onClick, inspect, busy, mode = 'unit', enemy = false, attacking = false }: { card: Card; canAct: boolean; action?: GameAction; stage?: string; readyResources?: number; onClick: () => void; inspect: () => void; busy: boolean; mode?: 'unit' | 'hand'; enemy?: boolean; attacking?: boolean }) {
  const feedback = useContext(BattleFeedbackContext);
  const events = feedback.byCard[card.uuid] || [];
  const intent = action?.intent || (stage === 'resource' ? 'resource' : stage === 'action' ? mode === 'hand' ? 'play' : 'attack' : 'select');
  const cost = card.playCost ?? card.cost;
  const unaffordable = stage === 'action' && mode === 'hand' && !canAct && readyResources != null && cost != null && cost > readyResources;
  const actionLabel = canAct ? t(intent === 'resource' ? card.selected ? 'RESOURCE SELECTED' : 'RESOURCE' : intent === 'play' ? 'PLAY' : intent === 'attack' ? 'ATTACK' : intent === 'deploy' ? 'DEPLOY' : intent === 'ability' ? 'ABILITY' : card.selected ? 'SELECTED' : 'SELECT TARGET') : unaffordable ? t('NEED +{count}', { count: Math.max(0, (cost || 0) - (readyResources || 0)) }) : stage === 'action' && mode === 'hand' ? t('UNAVAILABLE') : '';
  const actionBadge = actionLabel && <span className={`card-action-label card-action-${intent}`}>{canAct && intent === 'attack' ? <Swords size={10} /> : canAct && intent === 'play' ? <Plus size={10} /> : canAct && intent === 'resource' ? <Zap size={10} /> : null}{actionLabel}{canAct && intent === 'play' && cost != null && <b>{cost}</b>}</span>;
  const face = <><CardImage card={card} decorative /><span className="game-card-shade" /><span className="card-cost" title={t('Resource cost')}>{cost ?? '•'}</span>
    {card.selected && <span className="card-selected-badge"><Check size={15} /></span>}
    <span className="game-card-name">{card.name}</span>
    {mode === 'unit' && <span className="unit-stats"><span className="stat-power"><Swords size={12} />{card.power ?? 0}</span>
      {(card.damage || 0) > 0 && <span className="stat-damage damage-counter" title={t('{count} damage', { count: card.damage || 0 })}>{card.damage}</span>}
      <span className="stat-health"><Shield size={12} />{card.remainingHp ?? card.hp ?? 0}</span></span>}
  </>;
  return <div className={`game-card ${mode === 'hand' ? 'hand-card' : 'unit-card has-status-pocket'} ${canAct ? 'is-legal' : ''} ${canAct && intent === 'play' ? 'is-playable' : ''} ${unaffordable ? 'is-unaffordable' : ''} ${canAct && intent === 'select' ? 'is-target' : ''} ${card.selected ? 'is-selected' : ''} ${card.exhausted ? 'is-exhausted' : ''} ${enemy ? 'enemy-card' : ''} ${attacking ? 'is-attacking' : ''} ${feedback.added.has(card.uuid) ? 'is-new' : ''} ${feedback.damaged.has(card.uuid) ? 'is-damaged' : ''} ${feedback.healed.has(card.uuid) ? 'is-healed' : ''} ${events.some(event => event.kind === 'shieldBreak') ? 'is-shield-hit' : ''}`}>
    <button className="game-card-click" data-card-id={card.uuid} onClick={onClick} disabled={busy}
      title={t(canAct ? action?.displayLabel || actionLabel : card.playBlockedReason || card.name)}
      aria-label={`${card.name}, ${mode === 'unit' ? `${t('Power')} ${card.power ?? 0}, ${t('Health')} ${card.remainingHp ?? card.hp ?? 0}, ${t('{count} damage', { count: card.damage || 0 })}, ` : ''}${card.exhausted ? `${t('Exhausted')}, ` : ''}${actionLabel || t('inspect card')}`} aria-pressed={card.selected || undefined}>
      {mode === 'unit' ? <><span className="card-face">{face}</span><span className="card-status-pocket">
        {card.exhausted ? <span className="card-exhausted-token"><RotateCcw size={9} />{t('Exhausted')}</span> : actionBadge}
      </span></> : <>{face}{actionBadge}</>}
    </button>
    <IconButton className="card-inspect" label={t('Inspect {name}', { name: card.name || '' })} onClick={inspect}><Maximize2 size={13} /></IconButton>
    {!!card.upgrades?.length && <span className="upgrade-badge"><ArrowUpRight size={11} /> {card.upgrades.length}</span>}
    {!!card.captured?.length && <span className="capture-badge">{card.captured.length} {t('captured')}</span>}
    <CardEffects cardId={card.uuid} />
  </div>;
}

function PromptPanel({ game, busy, act, cards, inspect, notice, clearNotice }: { game: GameView; busy: boolean; act: (action: GameAction) => Promise<void>; cards: Card[]; inspect: (card: Card) => void; notice: string; clearNotice: () => void }) {
  const prompt = game.prompt;
  const [number, setNumber] = useState('0'); const [dropdown, setDropdown] = useState(''); const [distribution, setDistribution] = useState<Record<string, number>>({});
  const [choicesOpen, setChoicesOpen] = useState(false); const [claimAction, setClaimAction] = useState<GameAction | null>(null);
  const closeChoices = useCallback(() => setChoicesOpen(false), []); const closeClaim = useCallback(() => setClaimAction(null), []);
  const complex = !!(prompt.number || prompt.dropdown?.length || prompt.displayCards?.length || prompt.distribution);
  useEffect(() => { setNumber(String(prompt?.number?.min ?? 0)); setDropdown(prompt?.dropdown?.[0] || ''); setDistribution({}); setChoicesOpen(complex); setClaimAction(null); }, [prompt?.id, prompt?.number?.min, prompt?.dropdown?.join('|'), complex]);
  if (!prompt) return null;
  const stage = promptStage(game);
  const targetCards = cards.filter((card, i, arr) => !card.hidden && prompt.selectableCardIds.includes(card.uuid) && arr.findIndex(c => c.uuid === card.uuid) === i);
  const count = Object.values(distribution).reduce((a, b) => a + b, 0); const d = prompt.distribution;
  const targetCount = Object.values(distribution).filter(value => value > 0).length;
  const validDistribution = !!d && (count === 0 ? !!d.canChooseNoTargets : (d.canDistributeLess ? count <= d.amount : count === d.amount) && (!d.maxTargets || targetCount <= d.maxTargets));
  const buttonAction = (button: PromptButton): GameAction => game.legalActions.find(action => action.type === 'button' && action.arg === button.arg) || { type: 'button', arg: button.arg, method: button.command || 'menuButton', promptId: prompt.id, label: button.text };
  const buttons = (prompt.buttons || []).filter(button => button.command !== 'statefulPromptResults' && !(prompt.number && /^\d+$/.test(button.arg)) && !(prompt.dropdown?.includes(button.arg)));
  const submitDistribution = () => { if (d) void act({ type: 'stateful', promptId: prompt.id, result: { type: d.type, valueDistribution: Object.entries(distribution).filter(([, amount]) => amount > 0).map(([uuid, amount]) => ({ uuid, amount })) } }); };
  const displayCardAction = (card: Card & { cardUuid?: string }): GameAction | undefined => game.legalActions.find(a => a.type === 'card' && a.cardId === (card.uuid || card.cardUuid)) || game.legalActions.find(a => a.type === 'button' && a.arg === (card.uuid || card.cardUuid));
  const finished = game.winnerIds?.length > 0;
  const resourceCount = prompt.resourceSelection?.max || (/Select (\d+) cards? to resource/i.exec(prompt.title)?.[1] ? Number(/Select (\d+)/i.exec(prompt.title)?.[1]) : 2);
  const title = finished ? t('Game complete') : busy ? t('Resolving your action…') : stage === 'resource' ? t(resourceCount === 1 ? 'Resource step · optional' : 'Choose your starting resources') : stage === 'action' ? t('Your action') : stage === 'mulligan' ? t('Keep your hand or redraw?') : stage === 'initiative' ? t('Who takes the initiative?') : translate(prompt.title) || t('Waiting for the next action…');
  const playableHandCards = game.players.human.hand.filter(card => game.legalActions.some(action => action.type === 'card' && action.cardId === card.uuid)).length;
  const cue = stage === 'resource' ? t(resourceCount === 1 ? 'Choose 1 card as a resource, or skip. Then the action phase begins.' : 'Choose 2 cards as resources. Keep low-cost units in hand to play this round.') : stage === 'action' ? t(playableHandCards ? 'Play a card from your hand, attack with a ready unit, or use an ability.' : 'No cards can be played now. Use a ready unit or ability, or pass.') : stage === 'mulligan' ? t('You may replace your entire starting hand once.') : stage === 'target' ? t('Choose a highlighted target. The other arena may also have targets.') : prompt.selectMode === 'multiple' ? t('Select your cards, then confirm the choice.') : '';
  const clickButton = (button: PromptButton) => { const action = buttonAction(button); if (/claim.*initiative/i.test(button.arg + button.text)) setClaimAction(action); else void act(action); };
  const choiceControls = <>
    {!!game.legalActions.filter(action => action.type === 'card').length && !d && <div className="target-action-list expanded-target-list"><div>{game.legalActions.filter(action => action.type === 'card').map((action, i) => <button key={`${action.cardId}-${i}`} data-card-id={action.cardId} className="secondary-button small-button" disabled={busy || action.disabled} onClick={() => void act(action)}>{prompt.selectedCardIds.includes(action.cardId || '') && <Check size={13} />}{t(action.displayLabel || action.label || cards.find(card => card.uuid === action.cardId)?.name || 'Hidden card')}</button>)}</div></div>}
    {prompt.number && <div className="number-prompt"><label htmlFor="prompt-number">{t('Choose a number')} {t("(")}{prompt.number.min}{t("–")}{prompt.number.max}{t(")")}</label><input id="prompt-number" type="number" min={prompt.number.min} max={prompt.number.max} value={number} onChange={e => setNumber(e.target.value)} /><button className="primary-button small-button" disabled={busy || !number || +number < prompt.number.min || +number > prompt.number.max || !Number.isInteger(+number)} onClick={() => void act({ type: 'button', arg: number, promptId: prompt.id })}>{t('Confirm')}</button></div>}
    {!!prompt.dropdown?.length && <div className="number-prompt"><select aria-label={t('Choose an option')} value={dropdown} onChange={e => setDropdown(e.target.value)}>{prompt.dropdown.map(option => <option key={option}>{option}</option>)}</select><button className="primary-button small-button" disabled={busy} onClick={() => void act({ type: 'button', arg: dropdown, promptId: prompt.id })}>{t('Confirm choice')}</button></div>}
    {!!prompt.displayCards?.length && <div className="display-card-prompt">{prompt.displayCards.map((card, i) => { const action = displayCardAction(card); const perCard = game.legalActions.filter(a => a.type === 'perCard' && a.cardId === (card.uuid || card.cardUuid)); return <div key={card.uuid || card.cardUuid || i}><GameCard card={{ ...card, uuid: card.uuid || card.cardUuid || String(i), selected: card.selected || card.selectionState === 'selected' }} canAct={!!action} action={action} stage={stage} onClick={() => action ? void act(action) : inspect(card)} inspect={() => inspect(card)} busy={busy} mode="hand" />{card.displayText && <small>{t(card.displayText)}</small>}{perCard.map((action, k) => <button key={k} data-action-arg={action.arg} data-card-id={action.cardId} className="secondary-button small-button" disabled={busy} onClick={() => void act(action)}>{translate(action.label)}</button>)}</div>; })}</div>}
    {d && <div className="distribution-prompt"><div className="distribution-heading"><span>{t(d.type.toLowerCase().includes('healing') ? 'Distribute healing' : d.type.toLowerCase().includes('token') ? 'Distribute tokens' : 'Distribute damage')}</span><strong>{count} {t("/ ")}{d.amount}</strong></div>{targetCards.map(card => { const max = d.isIndirectDamage && !card.type?.includes('base') ? Math.min(d.amount, card.remainingHp ?? card.hp ?? d.amount) : d.amount; return <div className="distribution-target" data-target-id={card.uuid} key={card.uuid}><button className="text-button" onClick={() => inspect(card)}>{card.name}<Eye size={13} /></button><div><IconButton label={t('Decrease {name}', { name: card.name || '' })} onClick={() => setDistribution(old => ({ ...old, [card.uuid]: Math.max(0, (old[card.uuid] || 0) - 1) }))} disabled={busy || !distribution[card.uuid]}><Minus size={14} /></IconButton><input type="number" aria-label={t('Amount for {name}', { name: card.name || '' })} min="0" max={max} value={distribution[card.uuid] || 0} onChange={e => setDistribution(old => ({ ...old, [card.uuid]: Math.min(max, Math.max(0, Math.floor(Number(e.target.value) || 0))) }))} /><IconButton label={t('Increase {name}', { name: card.name || '' })} onClick={() => setDistribution(old => ({ ...old, [card.uuid]: Math.min(max, (old[card.uuid] || 0) + 1) }))} disabled={busy || (distribution[card.uuid] || 0) >= max || count >= d.amount}><Plus size={14} /></IconButton></div></div>; })}<div className="distribution-footer"><small>{d.maxTargets ? t('Up to {count} targets. ', { count: d.maxTargets }) : ''}{t(d.canDistributeLess ? 'You may distribute less than the total.' : 'Distribute the full amount.')}</small><button className="primary-button small-button" disabled={busy || !validDistribution} onClick={submitDistribution}>{t('Confirm distribution')}<Check size={15} /></button></div></div>}
    {!!game.warnings?.length && <div className="game-warnings">{game.warnings.map((warning, i) => <p key={i}><CircleHelp size={14} />{t(warning)}</p>)}</div>}
  </>;
  const renderButtons = () => buttons.map((button, i) => <button key={`${button.arg}-${i}`} className={/initiative/i.test(button.text) ? 'initiative-button' : /done|keep|yes|confirm/i.test(button.arg + button.text) ? 'primary-button small-button' : 'secondary-button small-button'} disabled={busy || button.disabled || finished} onClick={() => clickButton(button)}>{/initiative/i.test(button.text) && <Crosshair size={14} />}<span>{translate(button.text)}{/initiative/i.test(button.text) && <small>{t('End your actions this phase')}</small>}</span></button>);
  return <section className={`prompt-panel prompt-stage-${stage} ${prompt.active ? 'prompt-active' : ''} ${busy ? 'prompt-busy' : ''}`} aria-label={t('Commands')} aria-busy={busy}>
    <div className="prompt-main"><div className="prompt-symbol">{busy ? <LoaderCircle className="spin" size={21} /> : finished ? <Flag size={21} /> : stage === 'resource' ? <Zap size={21} /> : <Crosshair size={21} />}</div><div className="prompt-copy"><span className="eyebrow">{t(finished ? 'MISSION COMPLETE' : stage === 'resource' ? 'RESOURCE SELECTION' : busy ? 'PROCESSING' : prompt.active ? 'YOUR TURN' : 'OPPONENT TURN')}{stage === 'resource' && <b>{prompt.selectedCardIds.length}{t("/")}{resourceCount}</b>}</span><h3>{title}</h3>{cue && <p className="context-banner">{cue}</p>}{notice && <p className="card-notice" role="status">{t(notice)}<button onClick={clearNotice} aria-label={t('Dismiss')}><X size={12} /></button></p>}</div><div className="prompt-buttons">{renderButtons()}{(complex || game.legalActions.some(action => action.type === 'card')) && <button className="secondary-button small-button prompt-more-button" onClick={() => setChoicesOpen(true)} disabled={busy}><Layers3 size={13} /><span>{t(complex ? 'Choose options' : stage === 'action' ? 'All actions' : 'All targets')}</span></button>}</div></div>
    {choicesOpen && <Modal title={translate(prompt.title) || t('Available choices')} close={closeChoices} wide><div className="prompt-choice-body">{choiceControls}<div className="modal-actions prompt-modal-actions">{renderButtons()}<button className="secondary-button small-button" onClick={closeChoices}>{t('Back to battlefield')}</button></div></div></Modal>}
    {claimAction && <Modal title={t('Claim initiative?')} close={closeClaim}><div className="modal-body claim-confirmation"><Crosshair size={32} /><p>{t('You will take no more actions this phase. Your opponent may keep playing. You act first next round.')}</p><div className="claim-actions"><button className="secondary-button" onClick={closeClaim}>{t('Keep playing')}</button><button className="primary-button" disabled={busy} onClick={() => { const action = claimAction; setClaimAction(null); void act(action); }}>{t('Claim initiative')}</button></div></div></Modal>}
  </section>;
}

function TokenControls({ game, busy, act, inspect }: { game: GameView; busy: boolean; act: (action: GameAction) => Promise<void>; inspect: (card: Card) => void }) {
  const players = Object.values(game.players).filter(player => player.forceToken?.active || player.credits?.length);
  if (!players.length) return null;
  return <div className="token-controls">{players.map(player => <div key={player.id}><span className="eyebrow">{t(player.id === 'human' ? 'YOUR TOKENS' : 'ENEMY TOKENS')}</span>{player.forceToken?.active && <button data-card-id={player.forceToken?.uuid} className={`token-button ${game.legalActions.some(action => action.cardId === player.forceToken?.uuid) ? 'is-legal' : ''}`} disabled={busy || !game.legalActions.some(action => action.cardId === player.forceToken?.uuid)} onClick={() => { const action = game.legalActions.find(action => action.cardId === player.forceToken?.uuid); if (action) void act(action); }}><Orbit size={15} />{t('The Force')}</button>}{player.credits?.map(card => <button data-card-id={card.uuid} className={`token-button ${game.legalActions.some(action => action.cardId === card.uuid) ? 'is-legal' : ''}`} disabled={busy} key={card.uuid} onClick={() => { const action = game.legalActions.find(action => action.cardId === card.uuid); if (action) void act(action); else if (!card.hidden) inspect(card); }}><Zap size={14} />{card.name || t('Credit')}</button>)}</div>)}</div>;
}

function RulesContent({ openSources, version }: { openSources: () => void; version: string }) {
  return <div className="modal-body rules-content"><div className="rules-intro"><Crosshair size={32} /><div><h3>{t("Tvoja misija: uništi protivničku bazu.")}</h3><p>{t("Sustav obrađuje troškove, dopuštene ciljeve, okidače i učinke. Ti donosiš odluke.")}</p></div></div><div className="rules-grid"><article><span>{t("01 / PRIPREMA")}</span><h3>{t("Odaberi resurse")}</h3><p>{t("Počinješ sa šest karata. Možeš jednom zamijeniti cijelu početnu ruku. Zatim odaberi dvije karte iz ruke koje postaju resursi.")}</p></article><article><span>{t("02 / AKCIJSKA FAZA")}</span><h3>{t("Jedna akcija naizmjence")}</h3><p>{t("Odigraj kartu, napadni spremnom jedinicom, upotrijebi sposobnost ili preuzmi inicijativu. Označene karte imaju dostupnu akciju ili su dopušteni ciljevi.")}</p></article><article><span>{t("03 / BORBA")}</span><h3>{t("Dvije zasebne arene")}</h3><p>{t("Kopnene jedinice napadaju u kopnenoj areni, svemirske u svemirskoj. Obje mogu napasti bazu. Jedinice istodobno nanose štetu, osim kada učinak karte kaže drukčije.")}</p></article><article><span>{t("04 / NOVA RUNDA")}</span><h3>{t("Regrupiranje")}</h3><p>{t("Izvuci dvije karte, po želji pretvori jednu kartu iz ruke u resurs i pripremi iscrpljene karte. Igrač s inicijativom započinje sljedeću rundu.")}</p></article></div><div className="rules-tips"><h3>{t("Komande na bojištu")}</h3><p><span className="example-outline" /> {t("Označena karta — klikni za akciju ili odabir cilja.")}</p><p><Maximize2 size={15} /> {t("Povećalo — otvori sliku, tekst i stanje karte.")}</p><p><Check size={15} /> {t("Kod višestrukog odabira označi karte, zatim potvrdi.")}</p><p><Crosshair size={15} /> {t("Preuzimanje inicijative završava tvoje akcije za ovu fazu.")}</p></div><div className="notice"><BookOpen size={18} /><span>{t("Tekst na kartama može promijeniti osnovna pravila. Izvorni nazivi i tekst sposobnosti ostaju na engleskom radi preciznosti.")}{version ? t(' Reference: {version}.', { version }) : ''}</span></div><button className="secondary-button" onClick={openSources}>{t("Službena pravila, errata i izvori ")}<ExternalLink size={16} /></button></div>;
}
