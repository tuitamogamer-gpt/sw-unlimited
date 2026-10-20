import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Copy, Link, LoaderCircle, Radio, Shield, Swords } from 'lucide-react';
import { GameTable, Modal } from '../App';
import type { AccountStorage } from '../account/storage';
import { createOnlineClient, parseInvitation, RoomRequestError } from '../online-client';
import type { RoomSnapshot } from '../online-client';
import type { Card, Deck, GameAction, GameView } from '../types';
import { publicData } from '../public-data';
import { readCustomDecks } from '../custom-decks';
import { t, useLanguage } from '../i18n';
import { CardInspector } from './CardInspector';
import { CardArtwork } from './CardArtwork';
import type { HandView } from './HandTray';
import { useOpponentPresentation } from '../use-opponent-presentation';
import { OpponentPlayPreview } from './OpponentPlayPreview';
import { DamagePresentation } from './DamagePresentation';
import './online-play.css';

export function OnlinePlay({ client, storage, back, onHoverDisabledChange }: {
  client: ReturnType<typeof createOnlineClient>; storage: AccountStorage; back: () => void; onHoverDisabledChange: (disabled: boolean) => void;
}) {
  const { language, setLanguage } = useLanguage();
  const [decks, setDecks] = useState<Deck[]>([]), [deckId, setDeckId] = useState('sor-luke-skywalker');
  const [enabled, setEnabled] = useState<boolean | null>(null), [retry, setRetry] = useState(0);
  const [invite, setInvite] = useState(() => window.location.hash.startsWith('#join=') ? window.location.href : '');
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null), [display, setDisplay] = useState<GameView | null>(null);
  const latest = useRef<RoomSnapshot | null>(null), pending = useRef(false), mounted = useRef(true);
  const [hasSeat, setHasSeat] = useState(client.hasSeat), [busy, setBusy] = useState(false), [connected, setConnected] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [menu, setMenu] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false), [confirmForget, setConfirmForget] = useState(false);
  const [inspect, setInspect] = useState<Card | null>(null), [help, setHelp] = useState(false);
  const closeInspect = useCallback(() => setInspect(null), []), closeHelp = useCallback(() => setHelp(false), []);
  const closeLeave = useCallback(() => setConfirmLeave(false), []), closeForget = useCallback(() => setConfirmForget(false), []);
  const [showLog, setShowLog] = useState(true), [handView, setHandView] = useState<HandView>(() => {
    try { return JSON.parse(storage.getItem('swu-command-preferences') || '{}').handView === 'fan' ? 'fan' : 'classic'; } catch { return 'classic'; }
  });
  const [presentationRevision, setPresentationRevision] = useState(0);
  const [arenaReveal, setArenaReveal] = useState<{ id: string; arena: 'ground' | 'space' } | null>(null);
  const { preview, damagePreview, present, onPreviewReady } = useOpponentPresentation();
  const presentation = useRef(present); presentation.current = present;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { onHoverDisabledChange(busy || !!preview || !!damagePreview); return () => onHoverDisabledChange(false); }, [busy, preview, damagePreview, onHoverDisabledChange]);
  useEffect(() => {
    let alive = true;
    setEnabled(null); setError('');
    void Promise.all([client.config(), publicData.loadDecks()]).then(([config, catalog]) => {
      if (!alive) return;
      setEnabled(!!config?.enabled); setDecks([...catalog.decks, ...readCustomDecks(storage)].filter(deck => deck.supported !== false));
    }).catch(() => { if (alive) setError('Online play could not be checked. Try again.'); });
    return () => { alive = false; };
  }, [client, storage, retry]);
  const accept = useCallback(async (next: RoomSnapshot, animate = false) => {
    const before = latest.current;
    if (!mounted.current || before?.room.id === next.room.id && before.room.revision > next.room.revision) return;
    latest.current = next;
    if (animate && before?.game && next.game && next.game.version > before.game.version) {
      setBusy(true);
      const shown = await presentation.current(before.game, next.game, false, (frame, revealed) => {
        setDisplay(frame); setPresentationRevision(value => value + 1);
        if (revealed.card.zone === 'spaceArena' || revealed.card.zone === 'groundArena') setArenaReveal({ id: revealed.id, arena: revealed.card.zone === 'spaceArena' ? 'space' : 'ground' });
      });
      if (!shown) return;
    }
    if (!mounted.current) return;
    setSnapshot(next); setDisplay(next.game || null); setConnected(true); setBusy(false); setHasSeat(client.hasSeat());
    history.replaceState(null, '', window.location.pathname + window.location.search + '#room');
  }, [client]);
  const operate = async (task: () => Promise<RoomSnapshot>, animate = false) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    try { await accept(await task(), animate); }
    catch (caught) {
      if (!mounted.current) return;
      setConnected(false); setError(caught instanceof Error ? caught.message : 'The room could not be loaded. Try again.');
      // An interrupted move may have succeeded. Read the committed position;
      // never repeat a move automatically or reconstruct it in the browser.
      if (latest.current && !(caught instanceof RoomRequestError && [401, 403, 404, 410].includes(caught.status))) {
        try { await accept(await client.resume()); } catch { /* The reconnect control remains available. */ }
      }
    } finally { pending.current = false; if (mounted.current) { setBusy(false); setHasSeat(client.hasSeat()); } }
  };
  useEffect(() => {
    if (!snapshot || !['waiting', 'active'].includes(snapshot.room.status)) return;
    let alive = true, failures = 0, nextPoll = Date.now() + 1500, polling = false;
    const poll = async () => {
      if (!alive || polling || Date.now() < nextPoll) return;
      polling = true;
      try { if (!pending.current && latest.current) {
        try {
          const next = await client.poll(latest.current.room.revision);
          if (!alive || pending.current) return;
          if (next) { pending.current = true; try { await accept(next, true); } finally { pending.current = false; } }
          setConnected(true); setError(''); failures = 0;
        } catch (caught) {
          if (!alive) return;
          setConnected(false); failures++;
          setError(caught instanceof Error ? caught.message : 'Connection interrupted. Reconnect to check the latest position.');
          if (caught instanceof RoomRequestError && [401, 403, 404, 410].includes(caught.status)) { alive = false; return; }
        }
      }
      } finally { polling = false; nextPoll = Date.now() + Math.min(30_000, (document.hidden ? 10_000 : 2000) * 2 ** Math.min(failures, 4)); }
    };
    const wake = () => { if (!document.hidden) { nextPoll = 0; void poll(); } };
    const timer = setInterval(() => void poll(), 500);
    window.addEventListener('online', wake); document.addEventListener('visibilitychange', wake);
    return () => { alive = false; clearInterval(timer); window.removeEventListener('online', wake); document.removeEventListener('visibilitychange', wake); };
  }, [snapshot?.room.id, snapshot?.room.status, client, accept]);
  const act = async (action: GameAction) => {
    if (connected && latest.current) await operate(() => client.act(latest.current!, action), true);
  };
  const forget = () => {
    client.forget(); latest.current = null; setSnapshot(null); setDisplay(null); setHasSeat(false); setError(''); setNotice(''); setMenu(false); setConfirmForget(false); setConnected(false);
  };
  const selected = decks.find(deck => deck.id === deckId) || decks[0];
  const invitation = parseInvitation(invite), link = client.invitation(window.location.origin);
  const table = !!display && !menu;
  const terminal = snapshot && ['finished', 'cancelled'].includes(snapshot.room.status);
  const saveHandView = (mode: HandView) => {
    setHandView(mode);
    try { storage.setItem('swu-command-preferences', JSON.stringify({ ...JSON.parse(storage.getItem('swu-command-preferences') || '{}'), handView: mode })); } catch { /* View choice remains usable in this tab. */ }
  };
  return <><div data-game-content data-room-revision={snapshot?.room.revision} inert={!!preview || !!damagePreview} className={`app online-app ${table ? 'in-game' : ''}`}>
    {!table && <header className="site-header"><button className="text-button" onClick={back}><ArrowLeft size={16} />{t('Back to command')}</button><span className="online-wordmark"><Swords size={20} />{t('PLAY A FRIEND')}</span><select className="language-select" aria-label={t('Language')} value={language} onChange={event => setLanguage(event.target.value as 'en' | 'sr')}><option value="en">EN</option><option value="sr">SR</option></select></header>}
    {error && <div className="error-banner" role="alert"><span>{t(error)}</span><button className="secondary-button" disabled={busy} onClick={() => hasSeat ? void operate(client.resume) : setRetry(value => value + 1)}>{t(hasSeat ? 'Reconnect' : 'Try again')}</button><button className="text-button" onClick={() => setError('')}>{t('Dismiss')}</button></div>}
    {!client.isPersistent() && <div className="connection-notice" role="status">{t('Keep this tab open. This browser could not save your room access.')}</div>}
    {notice && <div className="connection-notice" role="status">{t(notice)}</div>}
    {table && display ? <><div className="online-turn" role="status"><Radio size={14} /><span>{t(!connected ? 'Reconnecting…' : busy ? 'Processing…' : terminal ? display.winnerIds.length > 1 ? 'Draw' : display.winnerIds.includes('human') ? 'Victory' : 'Defeat' : display.prompt.active ? 'Your decision' : 'Waiting for your opponent')}</span><button className="text-button" onClick={() => setMenu(true)}>{t('Room options')}</button></div><GameTable game={display} handView={handView} setHandView={saveHandView} feedbackEpoch={0} presentationRevision={presentationRevision} arenaReveal={arenaReveal} busy={busy || !connected} act={act} inspect={setInspect} showLog={showLog} setShowLog={setShowLog} restart={async () => setMenu(true)} continueBot={async () => {}} back={() => setMenu(true)} help={() => setHelp(true)} nextTraining={async () => {}} openReview={() => {}} accountControl={null} /></> : <main className="online-lobby">
      <section className="online-heading"><span className="eyebrow">{t('PRIVATE ONLINE MATCH')}</span><h1>{t('Across the table.')}<br /><span>{t('Across the galaxy.')}</span></h1><p>{t('Choose your deck, invite a friend and take command. Each player keeps their own hand private.')}</p></section>
      {enabled === false && <div className="online-unavailable" role="status"><Shield size={24} /><div><h2>{t('Online play is not ready yet')}</h2><p>{t('Private rooms are being connected. You can keep playing solo in the meantime.')}</p><button className="secondary-button" onClick={back}>{t('Back to command')}</button></div></div>}
      {enabled === null && !error && <p role="status"><LoaderCircle className="spin" size={18} /> {t('Checking online play…')}</p>}
      {hasSeat ? <section className="online-room"><div className="online-room-title"><Swords size={24} /><div><span className="eyebrow">{t('YOUR ROOM')}</span><h2>{t(!snapshot ? 'Resume your room' : snapshot.room.status === 'waiting' ? 'Waiting for a friend' : snapshot.room.status === 'cancelled' ? 'Room closed' : terminal ? 'Game complete' : 'Match in progress')}</h2></div></div>
        {snapshot && <p className="online-deck-pair">{snapshot.room.yourDeck}{snapshot.room.opponentJoined ? ` · ${snapshot.room.opponentDeck}` : ''}</p>}
        {snapshot?.room.status === 'waiting' && link && <><label htmlFor="room-invitation">{t('Invitation link')}</label><div className="online-invite-copy"><input id="room-invitation" readOnly value={link} onFocus={event => event.currentTarget.select()} /><button className="secondary-button" onClick={async () => { try { await navigator.clipboard.writeText(link); setNotice('Invitation copied. Send it to your friend.'); } catch { setNotice('Select and copy the invitation link above.'); } }}><Copy size={16} />{t('Copy link')}</button></div><p className="muted">{t('The first person to join takes the second seat. Send this link only to your opponent.')}</p></>}
        <div className="online-buttons">{!snapshot && <button className="primary-button" disabled={busy || !enabled} onClick={() => void operate(client.resume)}>{busy ? <LoaderCircle className="spin" size={17} /> : <Radio size={17} />}{t('Resume room')}</button>}{display && <button className="primary-button" onClick={() => setMenu(false)}>{t('Return to the table')}</button>}{snapshot && !terminal && <button className="secondary-button" disabled={busy || !connected} onClick={() => setConfirmLeave(true)}>{t(snapshot.room.status === 'waiting' ? 'Cancel room' : 'Concede match')}</button>}{terminal && <button className="secondary-button" onClick={forget}>{t('Create another room')}</button>}{(!snapshot || !connected) && <button className="text-button" disabled={busy} onClick={() => setConfirmForget(true)}>{t('Forget saved room')}</button>}</div><p className="muted">{t('Closing this tab keeps your seat. Return in this browser within six hours to continue.')}</p>
      </section> : enabled && <section className="online-setup"><div className="online-deck-choice"><span className="eyebrow">{t('01 / YOUR DECK')}</span>{selected && <div className="online-deck-art"><CardArtwork card={selected.leader} decorative /></div>}<label htmlFor="online-deck">{t('Choose your deck')}</label><select id="online-deck" value={selected?.id || ''} onChange={event => setDeckId(event.target.value)} disabled={busy}>{decks.map(deck => <option key={deck.id} value={deck.id}>{deck.name}</option>)}</select><p className="muted">{t('Your imported decks are available here too.')}</p></div><div className="online-invitation"><span className="eyebrow">{t('02 / YOUR OPPONENT')}</span><h2>{t('Make it a duel.')}</h2><p>{t('Create a room and share its invitation, or join a friend below.')}</p><button className="primary-button online-create" disabled={busy || !selected} onClick={() => selected && void operate(() => client.create(selected))}><Swords size={18} />{t('Create private room')}</button><div className="online-or"><span>{t('or join a friend')}</span></div><label htmlFor="online-invitation">{t('Paste invitation link')}</label><input id="online-invitation" type="text" value={invite} onChange={event => setInvite(event.target.value)} placeholder={`${window.location.origin}/#join=…`} autoComplete="off" spellCheck={false} /><button className="secondary-button" disabled={busy || !selected || !invitation} onClick={() => selected && invitation && void operate(() => client.join(selected, invitation))}><Link size={17} />{t('Join room')}</button>{invite && !invitation && <p className="online-input-error">{t('Paste the complete invitation link from your friend.')}</p>}</div></section>}
    </main>}
    {inspect && <Modal title={inspect.name || t('Card')} close={closeInspect} wide><CardInspector card={inspect} onInspect={setInspect} /></Modal>}
    {help && <Modal title={t('How to play')} close={closeHelp}><div className="modal-body"><p>{t('Take turns using the highlighted cards and choices. Both players follow the same official game rules.')}</p><p>{t('Ambush can attack an enemy unit in the same arena. It cannot attack a base.')}</p><a className="secondary-button" href="https://starwarsunlimited.com/how-to-play" target="_blank" rel="noreferrer">{t('Official rules')}</a></div></Modal>}
    {confirmLeave && <Modal title={t(snapshot?.room.status === 'waiting' ? 'Cancel room?' : 'Concede match?')} close={closeLeave}><div className="modal-body"><p>{t(snapshot?.room.status === 'waiting' ? 'This invitation will stop accepting players.' : 'Your opponent will win this match. This cannot be undone.')}</p><div className="online-buttons"><button className="secondary-button" disabled={busy} onClick={closeLeave}>{t('Keep playing')}</button><button className="primary-button" disabled={busy || !connected} onClick={async () => { if (latest.current) await operate(() => client.leave(latest.current!)); setConfirmLeave(false); }}>{t(snapshot?.room.status === 'waiting' ? 'Cancel room' : 'Concede match')}</button></div></div></Modal>}
    {confirmForget && <Modal title={t('Forget saved room?')} close={closeForget}><div className="modal-body"><p>{t('You will lose access to this seat. This does not cancel the room or concede the match.')}</p><div className="online-buttons"><button className="secondary-button" onClick={closeForget}>{t('Keep room')}</button><button className="primary-button" onClick={forget}>{t('Forget saved room')}</button></div></div></Modal>}
  </div>{preview && <OpponentPlayPreview card={preview.card} kind={preview.kind} sequenceKey={preview.id} onReady={() => onPreviewReady(preview.id)} />}{damagePreview && <DamagePresentation events={damagePreview} />}</>;
}
