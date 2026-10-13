import { useState } from 'react';
import { Check, Cloud, CloudOff, CloudUpload, CircleAlert, LoaderCircle, RefreshCw } from 'lucide-react';
import { t } from '../i18n';
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

/** Account-modal content. Conflicting opaque checkpoints are never displayed. */
export function CloudSaveStatus({ status, onRetry, onResolveConflict }: {
  status: SaveStatus;
  onRetry: () => void | Promise<void>;
  onResolveConflict: (key: string, choice: 'local' | 'cloud') => void | Promise<void>;
}) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
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
