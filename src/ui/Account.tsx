import { useEffect, useRef, useState } from 'react';
import { getConfig, signInDev, signInWithGoogle, signOut, syncNow, type ServerConfig } from '../data/sync';
import { relDate } from '../data/notes';
import { openMenu, useUI } from './store';

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize(o: { client_id: string; callback: (r: { credential: string }) => void }): void;
          renderButton(el: HTMLElement, o: Record<string, unknown>): void;
        };
      };
    };
  }
}

let gisScript: Promise<void> | null = null;
function loadGis() {
  return (gisScript ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Could not load Google sign-in'));
    document.head.append(s);
  }));
}

/** Dół panelu bocznego: logowanie i stan synchronizacji. */
export function Account() {
  const user = useUI((s) => s.user);
  const sync = useUI((s) => s.sync);

  if (!user) return <SignIn />;

  const label =
    sync.state === 'syncing' ? 'Syncing…'
    : sync.state === 'ok' ? `Synced ${sync.at ? relDate(sync.at) : ''}`
    : sync.state === 'offline' ? 'Offline – saved on this computer'
    : sync.state === 'error' ? 'Sync problem – click to retry'
    : 'Not syncing';

  return (
    <div
      className="account"
      onClick={(e) =>
        openMenu(e, [
          { label: user.email, header: true },
          { label: 'Sync now', onClick: () => void syncNow() },
          { label: 'Sign out', danger: true, onClick: () => void signOut() },
        ])
      }
      title={sync.error}
    >
      <span className="avatar">{(user.name || user.email)[0].toUpperCase()}</span>
      <span className="account-text">
        <span className="account-name">{user.name || user.email}</span>
        <span className={'sync-state ' + sync.state}>{label}</span>
      </span>
    </div>
  );
}

function SignIn() {
  const [config, setConfig] = useState<ServerConfig | null | undefined>(undefined);
  const [error, setError] = useState('');
  const btn = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void getConfig().then(setConfig);
  }, []);

  useEffect(() => {
    const clientId = config?.googleClientId;
    if (!clientId) return;
    loadGis()
      .then(() => {
        if (!btn.current || !window.google) return;
        window.google.accounts.id.initialize({
          client_id: clientId,
          callback: (r) => signInWithGoogle(r.credential).catch((e: Error) => setError(e.message)),
        });
        window.google.accounts.id.renderButton(btn.current, { theme: 'outline', size: 'medium', width: 250, text: 'signin_with' });
      })
      .catch((e: Error) => setError(e.message));
  }, [config]);

  if (config === undefined) return null;

  return (
    <div className="account signin">
      {config === null ? (
        <span className="sync-state offline">Server unreachable – notes are saved on this computer.</span>
      ) : (
        <>
          <span className="sync-hint">Sign in to sync notes between computers</span>
          {config.googleClientId && <div ref={btn} />}
          {config.devLogin && (
            <button className="link-btn" onClick={() => signInDev().catch((e: Error) => setError(e.message))}>
              Dev sign-in (local only)
            </button>
          )}
          {!config.googleClientId && !config.devLogin && <span className="sync-state error">Google sign-in not configured.</span>}
        </>
      )}
      {error && <span className="sync-state error">{error}</span>}
    </div>
  );
}
