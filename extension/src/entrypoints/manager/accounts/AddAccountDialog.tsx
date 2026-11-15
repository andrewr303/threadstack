// The "Add account" dialog: pick a sign-in, name the account, give it a colour. The account
// opens beside the ones already there (nothing is signed out); the person signs in to it once,
// from the tab that opens for it.
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Icon } from '../shell/icons.js';
import { useWorkspaceContext } from '../workspace/context.js';
import { realmById, switchableRealms, type RealmInfo } from '../../../core/workspace/realms.js';
import type { AccountColor, WorkspaceFailure } from '../../../core/workspace/types.js';
import { ACCOUNT_COLORS, COLOR_LABELS, MAX_ACCOUNT_NAME, realmHostOrigins, requestOrigins, useMounted } from './common.js';

export interface AddAccountDialogProps {
  dialogRef: React.MutableRefObject<HTMLDialogElement | null>;
  /** Sign-in the dialog starts on, when it was opened from one provider's menu. */
  realmId: string | null;
  onClosed: () => void;
}

const NAME_REQUIRED = 'Add a name so you can tell this account apart.';

function startingRealm(realmId: string | null): string {
  const realms = switchableRealms();
  return realms.find((r) => r.id === realmId)?.id ?? realms[0]?.id ?? 'anthropic';
}

export function AddAccountDialog({ dialogRef, realmId, onClosed }: AddAccountDialogProps) {
  const { workspace, setView, announce } = useWorkspaceContext();
  const mounted = useMounted();
  const ids = useId();
  const realms = switchableRealms();
  const nameRef = useRef<HTMLInputElement>(null);

  const firstFreeColor = useCallback(
    (realm: string): AccountColor => {
      const taken = new Set(workspace.realms.find((r) => r.realm.id === realm)?.accounts.map((a) => a.color));
      return ACCOUNT_COLORS.find((c) => !taken.has(c)) ?? 'teal';
    },
    [workspace.realms]
  );

  const [realm, setRealm] = useState(() => startingRealm(realmId));
  const [name, setName] = useState('');
  const [color, setColor] = useState<AccountColor>(() => firstFreeColor(startingRealm(realmId)));
  const [colorTouched, setColorTouched] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [failure, setFailure] = useState<WorkspaceFailure | null>(null);
  const [busy, setBusy] = useState(false);

  // Latest values for the callbacks that outlive a render (the dialog's open observer).
  const latest = useRef({ realmId, firstFreeColor });
  latest.current = { realmId, firstFreeColor };

  const reset = useCallback(() => {
    const start = startingRealm(latest.current.realmId);
    setRealm(start);
    setName('');
    setColor(latest.current.firstFreeColor(start));
    setColorTouched(false);
    setNameError(null);
    setFailure(null);
    setBusy(false);
  }, []);

  // A fresh form each time the dialog opens, whoever opened it (the app calls showModal).
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const watch = new MutationObserver(() => {
      if (dialog.hasAttribute('open')) {
        reset();
        window.setTimeout(() => nameRef.current?.focus(), 0);
      }
    });
    watch.observe(dialog, { attributes: true, attributeFilter: ['open'] });
    return () => watch.disconnect();
  }, [dialogRef, reset]);

  // Opened from one sign-in's menu: start on it.
  useEffect(() => {
    if (realmId) {
      const start = startingRealm(realmId);
      setRealm(start);
      if (!colorTouched) setColor(firstFreeColor(start));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [realmId]);

  const info: RealmInfo | null = realmById(realm);

  const close = () => dialogRef.current?.close();

  const attempt = async (asking: boolean) => {
    if (!info) return;
    const label = name.trim();
    setBusy(true);
    setFailure(null);
    // Chrome shows a permission prompt only in response to a click, so this comes first. Only a
    // sign-in host on another domain is asked for; the sign-in's own host is held from install,
    // and a refusal of that comes back as needs_host_access, which offers the wider request.
    if (asking && info.extraHostPatterns.length > 0) await requestOrigins(info.extraHostPatterns);
    const result = await workspace.addAccount({ realm: info.id, mode: 'embedded', label, color });
    if (!mounted.current) return;
    setBusy(false);
    if (!result.ok) {
      setFailure(result);
      return;
    }
    close();
    if (!result.account) {
      announce(`${label} was added for ${info.label}.`);
      return;
    }
    // Its first tab: it shows the two ways to sign in, and after that the account itself.
    const opened = workspace.openUrl(info.homeUrl, { accountId: result.account.id, title: `${info.label} · ${label}` });
    if (opened.ok) setView('browse');
    announce(`${label} was added for ${info.label}. Choose how to sign in to it.`);
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const label = name.trim();
    if (!label) {
      setNameError(NAME_REQUIRED);
      nameRef.current?.focus();
      return;
    }
    if (label.length > MAX_ACCOUNT_NAME) {
      setNameError(`Use at most ${MAX_ACCOUNT_NAME} characters.`);
      nameRef.current?.focus();
      return;
    }
    setNameError(null);
    void attempt(true);
  };

  const allowAndRetry = async () => {
    if (!info || busy) return;
    // Inside the click: the prompt needs it.
    await requestOrigins(realmHostOrigins(info));
    if (!mounted.current) return;
    void attempt(false);
  };

  const titleId = `${ids}-title`;
  const nameId = `${ids}-name`;
  const nameHelpId = `${ids}-name-help`;
  const realmFieldId = `${ids}-realm`;
  const colorLabelId = `${ids}-color`;
  const noteId = `${ids}-note`;

  const help = failure ? failureHelp(failure, info) : null;

  return (
    <dialog
      ref={dialogRef}
      id="tk-add-account-dialog"
      className="tk-modal-dialog tk-acct-dialog"
      aria-labelledby={titleId}
      onClose={() => {
        reset();
        onClosed();
      }}
    >
      <form onSubmit={submit} noValidate>
        <header className="tk-acct-dialog-head">
          <div>
            <h2 id={titleId} className="tk-acct-dialog-title">
              Add account
            </h2>
            <p className="tk-acct-dialog-lead">Use another account of the same sign-in beside the one you use now. Both stay signed in.</p>
          </div>
          <button type="button" className="tk-icon-btn" aria-label="Close" onClick={close}>
            <Icon name="close" />
          </button>
        </header>

        <div className="tk-acct-dialog-body">
          <div className="tk-acct-field">
            <label className="tk-acct-flabel" htmlFor={realmFieldId}>
              Sign-in
            </label>
            <select
              id={realmFieldId}
              className="tk-select"
              value={realm}
              onChange={(e) => {
                setRealm(e.target.value);
                setFailure(null);
                if (!colorTouched) setColor(firstFreeColor(e.target.value));
              }}
            >
              {realms.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>

          <div className="tk-acct-field">
            <label className="tk-acct-flabel" htmlFor={nameId}>
              Name
            </label>
            <input
              ref={nameRef}
              id={nameId}
              className="tk-input"
              type="text"
              value={name}
              maxLength={MAX_ACCOUNT_NAME}
              placeholder="Work"
              autoComplete="off"
              required
              aria-required="true"
              aria-invalid={nameError ? 'true' : undefined}
              aria-describedby={nameError ? `${nameHelpId} ${nameId}-error` : nameHelpId}
              onChange={(e) => {
                setName(e.target.value);
                if (nameError) setNameError(null);
              }}
            />
            <p id={nameHelpId} className="tk-acct-help">
              Shown next to the colour on tabs, panes and threads. Up to {MAX_ACCOUNT_NAME} characters.
            </p>
            {nameError && (
              <p id={`${nameId}-error`} className="tk-acct-field-error" role="alert">
                {nameError}
              </p>
            )}
          </div>

          <div className="tk-acct-field">
            <span className="tk-acct-flabel" id={colorLabelId}>
              Colour
            </span>
            <div role="radiogroup" aria-labelledby={colorLabelId} className="tk-acct-swatches">
              {ACCOUNT_COLORS.map((c) => (
                <label key={c} className="tk-acct-opt tk-acct-opt-swatch">
                  <input
                    type="radio"
                    className="tk-visually-hidden"
                    name={`${ids}-color`}
                    value={c}
                    checked={color === c}
                    onChange={() => {
                      setColor(c);
                      setColorTouched(true);
                    }}
                  />
                  <span className="tk-acct-swatch" data-color={c} aria-hidden="true" />
                  <span className="tk-acct-opt-title">{COLOR_LABELS[c]}</span>
                </label>
              ))}
            </div>
          </div>

          <p id={noteId} className="tk-acct-explain">
            Nothing is signed out. {info?.label ?? 'This sign-in'} opens a tab for the new account, where you sign in to it once:
            inside Threadkeeper, or in a browser tab when your sign-in uses Google, Apple or a passkey. Its sign-in is then
            kept on this device, encrypted, and never exported or sent anywhere.
          </p>

          {failure && help && (
            <div className="tk-acct-failure" role="alert">
              <p className="tk-acct-failure-text">{failure.error}</p>
              {help.text && <p className="tk-acct-failure-help">{help.text}</p>}
              {help.action === 'allow' && (
                <button type="button" className="tk-btn" disabled={busy} onClick={() => void allowAndRetry()}>
                  Allow access to {info?.label ?? 'this sign-in'} and retry
                </button>
              )}
            </div>
          )}
        </div>

        <footer className="tk-acct-dialog-foot">
          <button type="button" className="tk-btn" disabled={busy} onClick={close}>
            Cancel
          </button>
          <button type="submit" className="tk-btn tk-btn-primary tk-acct-submit" disabled={busy} aria-describedby={noteId}>
            {busy ? 'Adding account…' : 'Add account'}
          </button>
        </footer>
      </form>
    </dialog>
  );
}

function failureHelp(
  failure: WorkspaceFailure,
  info: RealmInfo | null
): { text: string | null; action: 'allow' | null } {
  const name = info?.label ?? 'this sign-in';
  switch (failure.code) {
    case 'needs_host_access':
      return {
        text: `Threadkeeper needs your permission for ${name} before it can show the account's pages and keep its sign-in on this device. Nothing was changed.`,
        action: 'allow',
      };
    case 'not_switchable':
      return {
        text: `Threadkeeper does not keep separate accounts for ${name}. Use the site's own account switcher instead.`,
        action: null,
      };
    default:
      return { text: null, action: null };
  }
}
