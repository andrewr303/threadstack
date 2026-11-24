// Shown at the top of the full page when the library is empty on a Mac: the moment someone who
// loaded ThreadStack from another folder, or added it again, sees no threads and thinks their
// history is gone. If the Mac helper holds a backup, it is offered right here.
//
// The helper's permission is per extension ID, so a new copy usually does not hold it yet. Then
// the banner only offers to look, and asks for the permission in that click.
import React, { useEffect, useState } from 'react';
import type { BackupListing } from '../../../core/backup-helper.js';
import { workspaceApi } from '../workspace/client.js';
import { useMounted } from './common.js';

const DISMISSED_KEY = 'tk.restoreOffer.dismissed';

type State =
  | { kind: 'hidden' }
  /** Permission not held yet: offer to look. */
  | { kind: 'ask' }
  | { kind: 'looking' }
  | { kind: 'found'; backup: BackupListing }
  | { kind: 'restoring'; backup: BackupListing }
  | { kind: 'restored'; threads: number }
  | { kind: 'note'; text: string };

function isMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent || '');
}

function dismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

const count = (n: number) => `${n.toLocaleString()} ${n === 1 ? 'thread' : 'threads'}`;

function date(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString(undefined, { dateStyle: 'medium' }) : 'an earlier date';
}

/** `threads`: how many threads the library has, or null while that is not known yet. */
export function RestoreOfferBanner({ threads }: { threads: number | null }) {
  const mounted = useMounted();
  const [state, setState] = useState<State>({ kind: 'hidden' });

  const look = async (): Promise<void> => {
    const status = await workspaceApi.backupStatus();
    if (!mounted.current) return;
    if (!status.ok || !Array.isArray(status.backups)) return setState({ kind: 'note', text: 'ThreadStack could not check for backups. Try again from Settings, Accounts.' });
    if (!status.helper) return setState({ kind: 'note', text: status.reason ?? 'The Mac helper is not connected.' });
    const fullest = status.backups.reduce<BackupListing | null>((best, b) => (!best || b.threads > best.threads ? b : best), null);
    if (!fullest || fullest.threads === 0) return setState({ kind: 'note', text: 'No library backup was found on this Mac.' });
    setState({ kind: 'found', backup: fullest });
  };

  useEffect(() => {
    if (threads !== 0 || state.kind !== 'hidden' || !isMac() || dismissed()) return;
    if (typeof chrome === 'undefined' || !chrome.permissions?.contains) return;
    let cancelled = false;
    void chrome.permissions
      .contains({ permissions: ['nativeMessaging'] })
      .then(async (held) => {
        if (cancelled) return;
        if (!held) return setState({ kind: 'ask' });
        setState({ kind: 'looking' });
        await look();
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // Runs when the thread count becomes known; `look` only reads the client.
  }, [threads]);

  // A library that has threads needs no offer, except to finish saying what was just restored.
  if (state.kind === 'hidden' || (threads !== 0 && threads !== null && state.kind !== 'restored')) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISSED_KEY, '1');
    } catch {
      // private mode: dismissed for this page only
    }
    setState({ kind: 'hidden' });
  };

  const askAndLook = async () => {
    setState({ kind: 'looking' });
    let granted = false;
    try {
      // First thing in the click: the browser only prompts in response to one.
      granted = await chrome.permissions.request({ permissions: ['nativeMessaging'] });
    } catch {
      granted = false;
    }
    if (!mounted.current) return;
    if (!granted) return setState({ kind: 'note', text: 'The browser did not allow ThreadStack to talk to the Mac helper, so backups could not be checked.' });
    await look();
  };

  const restore = async (backup: BackupListing) => {
    setState({ kind: 'restoring', backup });
    const result = await workspaceApi.backupRestore(backup.name);
    if (!mounted.current) return;
    if (!result.ok) return setState({ kind: 'note', text: `The backup was not restored. ${result.error}` });
    setState({ kind: 'restored', threads: result.threadsAdded });
  };

  const busy = state.kind === 'looking' || state.kind === 'restoring';
  return (
    <div className="tk-banner" role="status" data-testid="restore-offer-banner">
      <div className="tk-banner-body">
        {state.kind === 'ask' && (
          <>
            <strong>Used ThreadStack on this Mac before?</strong>
            <span>This library is empty. If the Mac helper kept a backup of your earlier library, it can be restored.</span>
          </>
        )}
        {state.kind === 'looking' && <span>Checking for library backups…</span>}
        {state.kind === 'found' && (
          <>
            <strong>Your earlier library is backed up on this Mac</strong>
            <span>
              A backup from {date(state.backup.createdAt)} holds {count(state.backup.threads)}.
            </span>
          </>
        )}
        {state.kind === 'restoring' && <span>Restoring {count(state.backup.threads)}. Keep this page open…</span>}
        {state.kind === 'restored' && (
          <>
            <strong>Restored {count(state.threads)}</strong>
            <span>Reload ThreadStack to see them. Accounts need signing in again.</span>
          </>
        )}
        {state.kind === 'note' && <span>{state.text}</span>}
      </div>
      {state.kind === 'ask' && (
        <button type="button" className="tk-btn tk-btn-primary" onClick={() => void askAndLook()}>
          Check for backups
        </button>
      )}
      {state.kind === 'found' && (
        <button type="button" className="tk-btn tk-btn-primary" onClick={() => void restore(state.backup)}>
          Restore
        </button>
      )}
      {state.kind === 'restored' && (
        <button type="button" className="tk-btn tk-btn-primary" onClick={() => window.location.reload()}>
          Reload ThreadStack
        </button>
      )}
      {!busy && state.kind !== 'restored' && (
        <button type="button" className="tk-btn" onClick={dismiss}>
          {state.kind === 'note' ? 'Close' : 'Not now'}
        </button>
      )}
    </div>
  );
}
