import { useEffect, useState } from 'react';
import { ArrowRight, CircleAlert, CircleCheck, HardDrive, LoaderCircle, LogOut, RefreshCw, ShieldCheck, UserRound } from 'lucide-react';
import { t } from '../i18n';
import type { AccountController, AccountUser } from './use-account';
import { ACCOUNT_MESSAGES } from './auth-client';
import './account.css';

export { useAccount } from './use-account';
export type { AccountController, AccountInfo, AccountUser } from './use-account';

function Avatar({ user, large = false }: { user?: AccountUser | null; large?: boolean }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [user?.image]);
  return <span className={`account-avatar ${large ? 'account-avatar-large' : ''}`} aria-hidden="true">
    {user?.image && !failed ? <img src={user.image} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      : user?.name.trim() ? <span>{user.name.trim().split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase()}</span> : <UserRound size={large ? 30 : 16} />}
  </span>;
}
function GoogleMark() {
  return <svg width="19" height="19" viewBox="0 0 48 48" aria-hidden="true" focusable="false"><path fill="#4285F4" d="M43.6 20.5H24v8.1h11.2c-.5 2.6-2 4.8-4.1 6.2v5.1h6.6c3.8-3.5 5.9-8.7 5.9-14.9 0-1.5-.1-3-.4-4.5z" /><path fill="#34A853" d="M24 44c5.4 0 9.9-1.8 13.2-4.9l-6.6-5.1c-1.8 1.2-4.1 2-6.6 2-5.2 0-9.7-3.5-11.3-8.2H5.9V33C9.2 39.5 16 44 24 44z" /><path fill="#FBBC05" d="M12.7 27.8c-.4-1.2-.6-2.5-.6-3.8s.2-2.6.6-3.8V15H5.9C4.6 17.7 4 20.8 4 24s.6 6.3 1.9 9l6.8-5.2z" /><path fill="#EA4335" d="M24 12c2.9 0 5.4 1 7.4 2.9l5.6-5.6C33.9 6 29.4 4 24 4 16 4 9.2 8.5 5.9 15l6.8 5.2C14.3 15.5 18.8 12 24 12z" /></svg>;
}

export function AccountButton({ account, onClick, disabled = false, compact = false }: {
  account: AccountController;
  onClick: () => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const label = account.user ? 'Open account' : 'Sign in';
  return <button type="button" className={`account-trigger ${compact ? 'account-trigger-compact' : ''} ${account.user ? 'is-signed-in' : ''}`} data-account-trigger
    aria-label={t(label)} title={account.user ? `${t('Account')}: ${account.user.name}` : t('Sign in or play as a guest')} onClick={onClick} disabled={disabled}>
    {account.loading || account.authBusy ? <LoaderCircle size={16} className="spin" /> : <Avatar user={account.user} />}
    <span className="account-trigger-label">{account.user ? account.user.name.split(' ')[0] || t('Account') : t('Sign in')}</span>
    {account.error && <i className="account-trigger-notice" aria-hidden="true" />}
  </button>;
}

/** Content only: the parent supplies its existing accessible modal. */
export function AccountPanel({ account, busy = false, onClose }: {
  account: AccountController;
  busy?: boolean;
  onClose: () => void;
}) {
  const disabled = busy || account.authBusy || account.loading;
  const configured = account.account?.enabled === true;
  return <div className="account-panel" data-account-panel aria-busy={account.loading || account.authBusy}>
    <div className="account-profile"><Avatar user={account.user} large /><span className="eyebrow">{t(account.user ? 'YOUR ACCOUNT' : 'GUEST PLAY')}</span>
      <h3>{account.user?.name || t('Play your way.')}</h3>
      {account.user?.email && <p className="account-email">{account.user.email}</p>}
      {account.user ? <span className="account-session-status"><CircleCheck size={14} />{t('Signed in with Google')}</span>
        : <p className="account-intro">{t('Play as a guest, or sign in with Google to keep a separate collection on this device.')}</p>}
    </div>
    <div className="account-device-note"><HardDrive size={20} /><div><strong>{t('Saved on this device')}</strong><p>{t('Your saved games and decks stay in this browser. They are not synced across devices.')}</p><p>{t('Guest play and each signed-in account keep separate saves. Switching accounts keeps the other saves on this device.')}</p></div></div>
    {account.loading && <div className="account-loading" role="status"><LoaderCircle size={17} className="spin" />{t('Checking your account…')}</div>}
    {!account.loading && account.account && !configured && <div className="account-unavailable" role="status"><CircleAlert size={17} /><p>{t(ACCOUNT_MESSAGES.unavailable)}</p></div>}
    {account.error && <div className="account-error" role="alert"><CircleAlert size={17} /><div><p>{t(account.error)}</p><button type="button" className="text-button" data-account-action="retry" onClick={() => void account.refresh()} disabled={disabled}><RefreshCw size={13} />{t('Check again')}</button></div></div>}
    {busy && <p className="account-wait" role="status"><ShieldCheck size={14} />{t('Wait for the current game action to finish before changing accounts.')}</p>}
    <div className="account-actions">
      {account.user ? <button type="button" className="secondary-button account-signout" data-account-action="signout" onClick={() => void account.signOut()} disabled={disabled}>{account.authBusy ? <LoaderCircle size={17} className="spin" /> : <LogOut size={17} />}{t(account.authBusy ? 'Signing out…' : 'Sign out')}</button>
        : <button type="button" className="account-google-button" data-account-action="signin" onClick={() => void account.signIn()} disabled={disabled || !configured}>{account.authBusy ? <LoaderCircle size={19} className="spin" /> : <GoogleMark />}{t(account.authBusy ? 'Opening Google…' : 'Continue with Google')}</button>}
      <button type="button" className="account-guest-button" data-account-action="guest" onClick={onClose} disabled={account.authBusy}>{t(account.user ? 'Back to game' : 'Continue as a guest')}<ArrowRight size={15} /></button>
    </div>
  </div>;
}
