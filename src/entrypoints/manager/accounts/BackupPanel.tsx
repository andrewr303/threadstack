// "Library backups" under the Mac helper in Settings, Accounts: whether backups are being kept,
// the ones on disk, back up now, and restore. The work happens in the service worker
// (core/backup-helper.ts); this panel only asks and shows.
import React, { useCallback, useEffect, useState } from 'react';
import type { BackupListing, BackupStatus } from '../../../core/backup-helper.js';
import { workspaceApi } from '../workspace/client.js';
import { useMounted } from './common.js';

type Action = { state: 'idle' } | { state: 'busy'; text: string } | { state: 'done'; text: string; reload?: boolean } | { state: 'failed'; text: string };

function when(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'Unknown date';
  return new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function size(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const threads = (n: number) => `${n.toLocaleString()} ${n === 1 ? 'thread' : 'threads'}`;

/** Whether the optional permission is already held, without prompting. */
async function helperAllowed(): Promise<boolean> {
  try {
    return typeof chrome !== 'undefined' && !!chrome.permissions?.contains && (await chrome.permissions.contains({ permissions: ['nativeMessaging'] }));
  } catch {
    return false;
  }
}

export function BackupPanel({ connected }: { connected: boolean }) {
  const mounted = useMounted();
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [action, setAction] = useState<Action>({ state: 'idle' });
  const [confirm, setConfirm] = useState<BackupListing | null>(null);

  const refresh = useCallback(async () => {
    const result = await workspaceApi.backupStatus();
    if (!mounted.current) return;
    // Only an answer of the expected shape is shown; anything else reads as "not known yet".
    setStatus(result.ok && Array.isArray(result.backups) && typeof result.threads === 'number' ? result : null);
  }, [mounted]);

  // Loaded once the helper is known to be allowed: after a successful Check connection, or at
  // once when the permission was granted earlier. Never prompts on its own.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (connected || (await helperAllowed())) {
        if (!cancelled) await refresh();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connected, refresh]);

  const backUp = async () => {
    setAction({ state: 'busy', text: 'Backing up the library…' });
    const result = await workspaceApi.backupNow();
    if (!mounted.current) return;
    setAction(
      result.ok
        ? { state: 'done', text: `Backed up ${threads(result.threads)} (${size(result.bytes)}).` }
        : { state: 'failed', text: `The backup was not saved. ${result.error}` }
    );
    await refresh();
  };

  const restore = async (backup: BackupListing) => {
    setConfirm(null);
    setAction({ state: 'busy', text: `Restoring ${threads(backup.threads)}. Keep this page open…` });
    const result = await workspaceApi.backupRestore(backup.name);
    if (!mounted.current) return;
    if (!result.ok) {
      setAction({ state: 'failed', text: `The backup was not restored. ${result.error}` });
    } else if (result.threadsAdded === 0 && !result.settingsRestored) {
      setAction({ state: 'done', text: 'Nothing to restore: the library already has every thread in that backup.' });
    } else {
      setAction({
        state: 'done',
        text: `Restored ${threads(result.threadsAdded)}${result.settingsRestored ? ' and your settings' : ''}. Reload Threadkeeper to see them.${result.settingsRestored ? ' Accounts need signing in again.' : ''}`,
        reload: true,
      });
    }
    await refresh();
  };

  const busy = action.state === 'busy';
  const empty = status !== null && status.threads === 0;
  const fullest = status?.backups.reduce<BackupListing | null>((best, b) => (!best || b.threads > best.threads ? b : best), null) ?? null;

  return (
    <div className="tk-acct-backups">
      <h4 className="tk-acct-subhead" id="tk-acct-backups-h">
        Library backups
      </h4>
      <p className="tk-settings-note">
        A browser keeps Threadkeeper's library under the extension's ID. Loading Threadkeeper from another folder, removing and
        adding it again, or moving to another browser starts with an empty library. With the Mac helper connected, the whole
        library (threads, messages, summaries, search data and settings, including any API keys you entered) is saved to a
        folder on this Mac about once an hour when it has changed, and can be restored from here. Saved sign-ins are never in
        a backup.
      </p>

      {status === null && (
        <p className="tk-acct-help">Choose Check connection above to see your backups.</p>
      )}

      {status !== null && !status.helper && (
        <p className="tk-acct-help" role="status">
          Backups are not being kept. {status.reason}
        </p>
      )}

      {status !== null && status.helper && (
        <>
          {empty && fullest && fullest.threads > 0 && (
            <div className="tk-acct-backup-offer" role="status">
              <p>
                This library is empty, and a backup with {threads(fullest.threads)} from {when(fullest.createdAt)} is on this Mac.
              </p>
              <button type="button" className="tk-btn tk-btn-primary" disabled={busy} onClick={() => void restore(fullest)}>
                Restore that backup
              </button>
            </div>
          )}

          <p className="tk-acct-help" role="status">
            {status.last && !status.last.error
              ? `Last backup: ${when(status.last.at)}, ${threads(status.last.threads)}.`
              : status.last?.error
                ? `The last backup did not finish. ${status.last.error}`
                : empty
                  ? 'Backups start once the library has threads.'
                  : 'No backup from this library yet. The first one is made within a few minutes.'}
          </p>

          <div className="tk-field-row">
            <button type="button" className="tk-btn" disabled={busy || empty} onClick={() => void backUp()}>
              Back up now
            </button>
          </div>

          {status.backups.length > 0 && (
            <ul className="tk-acct-backup-list" aria-labelledby="tk-acct-backups-h">
              {status.backups.map((b) => (
                <li key={b.name} className="tk-acct-backup-row">
                  <span className="tk-acct-backup-what">
                    <span className="tk-acct-backup-when">{when(b.createdAt)}</span>
                    <span className="tk-acct-backup-detail">
                      {threads(b.threads)}, {size(b.bytes)}
                    </span>
                  </span>
                  {confirm?.name === b.name ? (
                    <span className="tk-acct-backup-confirm">
                      <span>Adds the threads this library lacks. Threads already here, or deleted here, are left as they are.</span>
                      <button type="button" className="tk-btn tk-btn-primary" disabled={busy} onClick={() => void restore(b)}>
                        Restore
                      </button>
                      <button type="button" className="tk-btn" onClick={() => setConfirm(null)}>
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="tk-btn"
                      disabled={busy}
                      aria-label={`Restore the backup from ${when(b.createdAt)}`}
                      onClick={() => setConfirm(b)}
                    >
                      Restore…
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="tk-settings-note">
            Backups are in Library, Application Support, Threadkeeper, Backups in your home folder. The newest five are kept, and
            the fullest one is never removed.
          </p>
        </>
      )}

      <div className="tk-acct-backup-action" role="status" aria-live="polite">
        {action.state !== 'idle' && <span data-state={action.state}>{action.text}</span>}
        {action.state === 'done' && action.reload && (
          <button type="button" className="tk-btn" onClick={() => window.location.reload()}>
            Reload Threadkeeper
          </button>
        )}
      </div>
    </div>
  );
}
