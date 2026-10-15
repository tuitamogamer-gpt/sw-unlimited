import { useState } from 'react';
import { Check, Cloud, CloudOff, CloudUpload, CircleAlert, LoaderCircle, RefreshCw } from 'lucide-react';
import { t, useLanguage } from '../i18n';
import type { Deck } from '../types';
import type { CloudConflict, CloudSaveStatus as SaveStatus } from './cloud-saves';
import './cloud-saves.css';

const titles: Record<SaveStatus['state'], string> = {
  loading: 'Loading account saves…',
  synced: 'Saved to your account',
  pending: 'Syncing your saves…',
  offline: 'Offline. Local copy kept.',
  unavailable: 'Cloud saves unavailable',
  conflict: 'A save changed on another device',
};
function conflictName(conflict: CloudConflict): string {
  if (conflict.kind === 'deck') {
    const value = conflict.localValue || conflict.cloudValue;
    if (value && typeof value === 'object' && 'name' in value && typeof value.name === 'string') return value.name;
    return t('Saved deck');
  }
  return t({ preferences: 'Settings', currentGame: 'Current game', match: 'Finished game', training: 'Training progress' }[conflict.kind]);
}
function saveSummary(conflict: CloudConflict, value: unknown, decks: Pick<Deck, 'id' | 'name'>[], gameVersion?: number): string[] {
  if (value === null) return [t('Removed')];
  if (!value || typeof value !== 'object') return [];
  const saved = value as Record<string, unknown>;
  if (conflict.kind === 'preferences') {
    const summary: string[] = [];
    const difficulty = { easy: 'Kadet', normal: 'Zapovjednik', hard: 'Veliki admiral' }[String(saved.difficulty)];
    if (difficulty) summary.push(t(difficulty));
    for (const [key, label] of [['deckId', 'Player deck'], ['opponentDeckId', 'Opponent deck']]) {
      const deck = decks.find(item => item.id === saved[key]);
      if (deck) summary.push(t('{label}: {value}', { label: t(label), value: deck.name }));
    }
    for (const [key, label] of [['compact', 'Compact cards'], ['showLog', 'Battle log']]) {
      if (typeof saved[key] === 'boolean') summary.push(t('{label}: {value}', { label: t(label), value: t(saved[key] ? 'On' : 'Off') }));
    }
    return summary.length ? summary : [t('Saved settings')];
  }
  if (conflict.kind === 'deck' && typeof saved.name === 'string') return [saved.name];
  if (conflict.kind === 'currentGame' && typeof gameVersion === 'number' && Number.isSafeInteger(gameVersion) && gameVersion >= 0) return [t('Game progress: {count} actions', { count: gameVersion })];
  return [];
}

/** Account-modal content. Conflicting opaque checkpoints are never displayed. */
export function CloudSaveStatus({ status, decks = [], onRetry, onResolveConflict }: {
  status: SaveStatus;
  decks?: Pick<Deck, 'id' | 'name'>[];
  onRetry: () => void | Promise<void>;
  onResolveConflict: (key: string, choice: 'local' | 'cloud') => void | Promise<void>;
}) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const { language } = useLanguage();
  const changedAt = (timestamp?: number) => {
    if (!timestamp || !Number.isFinite(timestamp)) return null;
    const date = new Date(timestamp);
    if (!Number.isFinite(date.getTime())) return null;
    return <time dateTime={date.toISOString()}>{t('Changed {date}', { date: date.toLocaleString(language === 'sr' ? 'sr-Latn' : 'en', { dateStyle: 'medium', timeStyle: 'medium' }) })}</time>;
  };
  const run = async (action: () => void | Promise<void>) => {
    if (working) return;
    setWorking(true); setError('');
    try { await action(); }
    catch { setError('This save could not be updated. Your local copy has been kept.'); }
    finally { setWorking(false); }
  };
  const loading = status.state === 'loading' || status.state === 'pending';
  const Icon = loading ? CloudUpload : status.state === 'synced' ? Cloud : status.state === 'offline' ? CloudOff : CircleAlert;
  return <section className={`cloud-save-status cloud-save-${status.state}`} data-cloud-save-status={status.state} aria-busy={working}>
    <div className="cloud-save-heading"><Icon size={19} aria-hidden="true" /><div role="status" aria-live="polite"><strong>{t(titles[status.state])}</strong>
      {status.state === 'synced' && <p>{t('Your decks, current game and progress can follow you to another device.')}</p>}
      {status.message && <p>{t(status.message)}</p>}
      {status.pendingCount > 0 && !status.message && <p>{t('{count} changes waiting to sync.', { count: status.pendingCount })}</p>}
    </div>{status.state === 'synced' && <Check size={15} aria-hidden="true" />}</div>
    {status.conflicts.length > 0 && <div className="cloud-save-conflicts"><p>{t('Choose a version for each conflicting save. Other saves can still sync.')}</p>
      {status.conflicts.map(conflict => <article className="cloud-save-conflict" key={conflict.key}>
        <h4>{conflictName(conflict)}</h4><p>{t('Using the account version replaces this device’s conflicting save.')}</p>
        <div className="cloud-save-comparison">
          <div data-save-version="local"><strong>{t('This device')}</strong>{saveSummary(conflict, conflict.localValue, decks, conflict.localGameVersion).map((line, index) => <span key={index}>{line}</span>)}{changedAt(conflict.localUpdatedAt)}</div>
          <div data-save-version="account"><strong>{t('Your account')}</strong>{saveSummary(conflict, conflict.cloudValue, decks, conflict.cloudGameVersion).map((line, index) => <span key={index}>{line}</span>)}{changedAt(conflict.cloudUpdatedAt)}</div>
        </div>
        {conflict.canKeepLocal === false && <p>{t('Your account has a newer turn of this game. Use the account version to continue.')}</p>}
        <div className="cloud-save-conflict-actions">
          <button type="button" disabled={working || conflict.canKeepLocal === false} onClick={() => void run(() => onResolveConflict(conflict.key, 'local'))}>{t('Keep this device’s version')}</button>
          <button type="button" disabled={working} onClick={() => void run(() => onResolveConflict(conflict.key, 'cloud'))}>{t('Use account version')}</button>
        </div>
      </article>)}
    </div>}
    {['offline', 'unavailable', 'conflict'].includes(status.state) && <button type="button" className="cloud-save-retry" disabled={working} onClick={() => void run(onRetry)}>
      {working ? <LoaderCircle size={13} className="spin" aria-hidden="true" /> : <RefreshCw size={13} aria-hidden="true" />}{t('Retry sync')}
    </button>}
    {error && <p className="cloud-save-error" role="alert">{t(error)}</p>}
  </section>;
}
