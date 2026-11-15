// Settings, Accounts: the accounts of every sign-in, how they work side by side, and the Mac helper.
// The workspace exists only on the full page; on the side panel and the in-page overlay this
// panel says where accounts are managed instead.
import React, { useEffect, useRef, useState } from 'react';
import { Icon } from '../shell/icons.js';
import { useOptionalWorkspaceContext, type WorkspaceContextValue } from '../workspace/context.js';
import type { AccountColor, AccountRecord, RealmAccounts } from '../../../core/workspace/types.js';
import { needsSignIn } from '../workspace/state.js';
import { ACCOUNT_COLORS, COLOR_LABELS, MAX_ACCOUNT_NAME, openFullPage, useMounted } from './common.js';
import { HelperPanel } from './HelperPanel.js';

function identityLine(account: AccountRecord): string {
  if (account.identity?.display) return account.identity.display;
  return account.identity ? 'Signed in, name not shown by the site' : 'Identity not seen yet';
}

function signedInLine(account: AccountRecord, browser: boolean): string {
  if (browser) return 'The account this browser is signed in to';
  return needsSignIn(account) ? 'Not signed in yet' : 'Signed in. Its sign-in is kept on this device, encrypted.';
}

function AccountRow({
  account,
  active,
  ctx,
  onRemoved,
}: {
  account: AccountRecord;
  active: boolean;
  ctx: WorkspaceContextValue;
  onRemoved: () => void;
}) {
  const { workspace, announce } = ctx;
  const mounted = useMounted();
  const [draft, setDraft] = useState(account.label);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmingBrowser, setConfirmingBrowser] = useState(false);
  const removeRef = useRef<HTMLButtonElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);

  useEffect(() => setDraft(account.label), [account.label]);

  useEffect(() => {
    if (confirming) keepRef.current?.focus();
    else if (wasConfirming.current) removeRef.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);

  const trimmed = draft.trim();
  const dirty = trimmed !== account.label;

  const saveName = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!dirty || busy) return;
    if (!trimmed) {
      setError('A name is required.');
      return;
    }
    if (trimmed.length > MAX_ACCOUNT_NAME) {
      setError(`Use at most ${MAX_ACCOUNT_NAME} characters.`);
      return;
    }
    setBusy(true);
    setError(null);
    const result = await workspace.updateAccount(account.id, { label: trimmed });
    if (!mounted.current) return;
    setBusy(false);
    if (result.ok) announce(`Renamed the account to ${trimmed}.`);
    else setError(result.error);
  };

  const setColor = async (color: AccountColor) => {
    setError(null);
    const result = await workspace.updateAccount(account.id, { color });
    if (!mounted.current) return;
    if (result.ok) announce(`${account.label} is now ${COLOR_LABELS[color]}.`);
    else setError(result.error);
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    const result = await workspace.removeAccount(account.id);
    if (!mounted.current) return;
    setBusy(false);
    if (result.ok) {
      announce(`Removed ${account.label}. Its threads stay in the library.`);
      onRemoved();
    } else {
      setError(result.error);
      setConfirming(false);
    }
  };

  const realmEntry = workspace.realms.find((r) => r.realm.id === account.realm);
  const realmName = realmEntry?.realm.label ?? 'this sign-in';
  const pendingHere = Boolean(realmEntry?.pendingSignIn);
  const signedOut = needsSignIn(account);

  const signInWithBrowser = async () => {
    setBusy(true);
    setError(null);
    const result = await workspace.beginBrowserSignIn(account.id);
    if (!mounted.current) return;
    setBusy(false);
    if (result.ok) announce(`Sign in to ${realmName} as ${account.label} in the browser tab that opened.`);
    else setError(result.error);
  };

  const makeBrowserAccount = async () => {
    setBusy(true);
    setError(null);
    const result = await workspace.useAsBrowserAccount(account.id);
    if (!mounted.current) return;
    setBusy(false);
    setConfirmingBrowser(false);
    if (result.ok) announce(`This browser is now signed in to ${realmName} as ${account.label}.`);
    else setError(result.error);
  };

  const nameId = `tk-acct-name-${account.id}`;
  return (
    <li className="tk-acct-row" data-color={account.color}>
      <div className="tk-acct-row-main">
        <span className="tk-acct-swatch" data-color={account.color} aria-hidden="true" />
        <form className="tk-acct-rename" onSubmit={(e) => void saveName(e)}>
          <label className="tk-visually-hidden" htmlFor={nameId}>
            Name of account {account.label}
          </label>
          <input
            id={nameId}
            className="tk-input tk-acct-name-input"
            type="text"
            value={draft}
            maxLength={MAX_ACCOUNT_NAME}
            autoComplete="off"
            aria-invalid={error && !trimmed ? 'true' : undefined}
            onChange={(e) => {
              setDraft(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && dirty) {
                // Revert the edit; a second Escape closes Settings.
                e.preventDefault();
                e.stopPropagation();
                setDraft(account.label);
              }
            }}
          />
          {dirty && (
            <button type="submit" className="tk-btn tk-btn-primary" disabled={busy}>
              Save name
            </button>
          )}
        </form>
        <label className="tk-acct-colorpick">
          <span className="tk-visually-hidden">Colour of {account.label}</span>
          <select
            className="tk-select"
            value={account.color}
            onChange={(e) => void setColor(e.target.value as AccountColor)}
          >
            {ACCOUNT_COLORS.map((c) => (
              <option key={c} value={c}>
                {COLOR_LABELS[c]}
              </option>
            ))}
          </select>
        </label>
        {!account.primary && !confirming && (
          <button
            ref={removeRef}
            type="button"
            className="tk-btn tk-btn-quiet"
            aria-label={`Remove ${account.label}`}
            disabled={busy}
            onClick={() => setConfirming(true)}
          >
            Remove
          </button>
        )}
      </div>
      <dl className="tk-acct-facts">
        <div>
          <dt>Identity</dt>
          <dd>{identityLine(account)}</dd>
        </div>
        <div>
          <dt>Sign-in</dt>
          <dd>{signedInLine(account, active)}</dd>
        </div>
        <div>
          <dt>Used</dt>
          <dd>{active ? 'In Threadkeeper and in your ordinary tabs' : 'Inside Threadkeeper only'}</dd>
        </div>
      </dl>
      {account.primary && <p className="tk-acct-help">This is the sign-in your browser already had, so it cannot be removed.</p>}
      {!active && !confirmingBrowser && (
        <div className="tk-acct-row-actions">
          <button type="button" className="tk-btn" disabled={busy || pendingHere} onClick={() => void signInWithBrowser()}>
            {signedOut ? 'Sign in with a browser tab' : 'Sign in again with a browser tab'}
          </button>
          {!signedOut && (
            <button type="button" className="tk-btn tk-btn-quiet" disabled={busy || pendingHere} onClick={() => setConfirmingBrowser(true)}>
              Make this the browser’s sign-in
            </button>
          )}
        </div>
      )}
      {confirmingBrowser && (
        <div className="tk-acct-confirm" role="group" aria-label={`Make ${account.label} the browser's sign-in`}>
          <p>
            Sign this browser in to {realmName} as {account.label}? Every {realmName} tab changes to this account. The account the
            browser uses now is kept and stays available inside Threadkeeper.
          </p>
          <div className="tk-acct-confirm-actions">
            <button type="button" className="tk-btn" disabled={busy} onClick={() => setConfirmingBrowser(false)}>
              Keep as it is
            </button>
            <button type="button" className="tk-btn tk-btn-primary" disabled={busy} onClick={() => void makeBrowserAccount()}>
              {busy ? 'Changing…' : 'Change the browser’s sign-in'}
            </button>
          </div>
        </div>
      )}
      {confirming && (
        <div className="tk-acct-confirm" role="group" aria-label={`Remove ${account.label}`}>
          <p>
            Remove {account.label}? Its saved sign-in is deleted from this device and its threads stay in the library.
          </p>
          <div className="tk-acct-confirm-actions">
            <button ref={keepRef} type="button" className="tk-btn" disabled={busy} onClick={() => setConfirming(false)}>
              Keep account
            </button>
            <button type="button" className="tk-btn tk-btn-danger" disabled={busy} onClick={() => void remove()}>
              {busy ? 'Removing…' : 'Remove account'}
            </button>
          </div>
        </div>
      )}
      {error && (
        <p className="tk-acct-field-error" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

function RealmGroup({ entry, ctx, onRemoved }: { entry: RealmAccounts; ctx: WorkspaceContextValue; onRemoved: () => void }) {
  const id = `tk-acct-realm-${entry.realm.id}`;
  return (
    <section className="tk-acct-realm-group" aria-labelledby={id}>
      <h4 className="tk-acct-subhead" id={id}>
        {entry.realm.label}
      </h4>
      <ul className="tk-acct-list">
        {entry.accounts.map((account) => (
          <AccountRow
            key={account.id}
            account={account}
            active={account.id === entry.activeAccountId}
            ctx={ctx}
            onRemoved={onRemoved}
          />
        ))}
      </ul>
    </section>
  );
}

export function AccountsSettings() {
  const ctx = useOptionalWorkspaceContext();
  const addRef = useRef<HTMLButtonElement>(null);

  if (!ctx || !ctx.workspace.enabled) {
    return (
      <section className="tk-settings-section tk-acct-settings" aria-labelledby="tk-acct-settings-h">
        <h3 className="tk-settings-h3" id="tk-acct-settings-h">
          Accounts
        </h3>
        <p className="tk-settings-note">
          Accounts are managed from the full page, where provider sites open inside Threadkeeper. Open the full page, then come
          back to Settings, Accounts.
        </p>
        <div className="tk-field-row">
          <button type="button" className="tk-btn tk-btn-primary" onClick={openFullPage}>
            <Icon name="external" />
            Open the full page
          </button>
        </div>
      </section>
    );
  }

  const withAccounts = ctx.workspace.realms.filter((r) => r.accounts.length > 0);
  return (
    <>
      <section className="tk-settings-section tk-acct-settings" aria-labelledby="tk-acct-how-h">
        <h3 className="tk-settings-h3" id="tk-acct-how-h">
          How accounts work
        </h3>
        <p className="tk-settings-note">
          Every sign-in has the account your browser itself is signed in to, plus any accounts you add. An added account is signed
          in inside Threadkeeper only: its sign-in is kept on this device (encrypted, never exported or sent anywhere) and loaded
          into a space of its own each time Threadkeeper opens. Nothing is signed out for it, so it works beside your browser’s
          account, in tabs, in the sidebar and on the dashboard.
        </p>
        <p className="tk-settings-note">
          Two accounts of one sign-in can be open at the same moment: the browser’s own and one more. A third takes the second
          place after Threadkeeper reloads its pages. An added account starts with fresh site storage each time Threadkeeper is
          opened, so drafts a site keeps only in the browser are not carried over, and the browser holds about 10 KB of cookies
          per site for it. Threadkeeper never sees or stores your passwords.
        </p>
      </section>

      <section className="tk-settings-section" aria-labelledby="tk-acct-list-h">
        <h3 className="tk-settings-h3" id="tk-acct-list-h">
          Your accounts
        </h3>
        {withAccounts.length === 0 ? (
          <p className="tk-settings-note">
            No accounts yet. Threadkeeper adds the account your browser is signed in to the first time it opens a sign-in.
          </p>
        ) : (
          withAccounts.map((entry) => (
            <RealmGroup key={entry.realm.id} entry={entry} ctx={ctx} onRemoved={() => addRef.current?.focus()} />
          ))
        )}
        <div className="tk-field-row">
          <button ref={addRef} type="button" className="tk-btn" onClick={() => ctx.requestAddAccount()}>
            <Icon name="userPlus" />
            Add account
          </button>
        </div>
      </section>

      <HelperPanel />
    </>
  );
}
