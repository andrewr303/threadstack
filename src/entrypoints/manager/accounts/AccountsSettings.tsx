// Settings, Accounts: the accounts of every sign-in, how switching works, and the Mac helper.
// The workspace exists only on the full page; on the side panel and the in-page overlay this
// panel says where accounts are managed instead.
import React, { useEffect, useRef, useState } from 'react';
import { Icon } from '../shell/icons.js';
import { useOptionalWorkspaceContext, type WorkspaceContextValue } from '../workspace/context.js';
import type { AccountColor, AccountRecord, RealmAccounts } from '../../../core/workspace/types.js';
import { ACCOUNT_COLORS, COLOR_LABELS, MAX_ACCOUNT_NAME, openFullPage, useMounted } from './common.js';
import { HelperPanel } from './HelperPanel.js';

function identityLine(account: AccountRecord): string {
  if (account.identity?.display) return account.identity.display;
  return account.identity ? 'Signed in, name not shown by the site' : 'Identity not seen yet';
}

function signedInLine(account: AccountRecord, active: boolean): string {
  if (account.mode === 'isolated') return 'Signed in inside its own Chrome window';
  if (active) return 'Signed in now';
  return account.hasJar ? 'Not signed in now. Its sign-in is saved on this device.' : 'Not signed in now';
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
          <dt>Runs</dt>
          <dd>{account.mode === 'isolated' ? 'In its own Chrome window' : 'In the workspace'}</dd>
        </div>
      </dl>
      {account.primary && <p className="tk-acct-help">This is the sign-in your browser already had, so it cannot be removed.</p>}
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
          How switching works
        </h3>
        <p className="tk-settings-note">
          Chrome keeps one set of cookies per sign-in, so one account of each sign-in is signed in at a time, in Threadkeeper and
          in every other Chrome tab. Switching saves the outgoing account's sign-in cookies on this device (encrypted, never
          exported or sent anywhere), clears them, restores the other account's, and reloads that sign-in's pages.
        </p>
        <p className="tk-settings-note">
          Only cookies are swapped. Other data a site stores, such as drafts, is shared between the accounts. Threadkeeper never
          sees or stores your passwords. An account kept in its own Chrome window uses a separate profile through the Mac helper,
          which is how two accounts of one sign-in can be signed in at the same moment.
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
