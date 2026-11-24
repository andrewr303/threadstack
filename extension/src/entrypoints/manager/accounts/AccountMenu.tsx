// The button that shows which account a sign-in is on, and the menu that goes to another one.
// Every account of a sign-in stays signed in; choosing one only changes which is in front.
import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../shell/icons.js';
import { AccountChip, accountSubtitle, onMenuKeyDown, usePopover } from '../shell/primitives.js';
import { useWorkspaceContext } from '../workspace/context.js';
import { needsSignIn } from '../workspace/state.js';
import type { AccountRecord } from '../../../core/workspace/types.js';

export interface AccountMenuButtonProps {
  /** The sign-in whose accounts the menu lists. */
  realmId: string;
  /**
   * `toolbar`: "Claude · Work" with a chevron, in the Browse toolbar.
   * `rail`: one row of the "Accounts" list in the side navigation.
   */
  variant: 'toolbar' | 'rail';
  /** The account in front where the button sits (the tab's). Defaults to the one Browse shows, else the browser's own. */
  accountId?: string | null;
}

interface MenuPlace {
  left: number;
  top?: number;
  bottom?: number;
}

const MENU_WIDTH = 340;
const EDGE = 8;

/** What the right-hand side of an account's row says about its sign-in. */
export function accountState(account: AccountRecord, browserAccountId: string | null): 'browser' | 'signed_in' | 'signed_out' {
  if (account.id === browserAccountId) return 'browser';
  return needsSignIn(account) ? 'signed_out' : 'signed_in';
}

/** The button that shows which account a sign-in is on and opens the menu to go to another. */
export function AccountMenuButton({ realmId, variant, accountId }: AccountMenuButtonProps) {
  const { workspace, announce, requestAddAccount, openSettings, setView } = useWorkspaceContext();
  const popover = usePopover();
  const [error, setError] = useState<string | null>(null);
  const [place, setPlace] = useState<MenuPlace | null>(null);

  const entry = workspace.realms.find((r) => r.realm.id === realmId) ?? null;
  const busy = workspace.busyRealm === realmId;
  const { open, setOpen } = popover;

  // The menu is drawn on the page, not inside the toolbar or the rail: those are glass, and a
  // glass menu inside glass loses its blur and can be clipped by the strip it came from. Its
  // place is measured in the click that opens it, so it exists, and can take focus, at once.
  const measure = useCallback(() => {
    const button = popover.triggerProps.ref.current;
    if (!button) return;
    const r = button.getBoundingClientRect();
    const maxLeft = Math.max(EDGE, window.innerWidth - MENU_WIDTH - EDGE);
    if (variant === 'rail') {
      setPlace({ left: Math.min(r.right + EDGE, maxLeft), bottom: Math.max(EDGE, window.innerHeight - r.bottom) });
    } else {
      setPlace({ left: Math.min(Math.max(EDGE, r.left), maxLeft), top: r.bottom + 6 });
    }
  }, [variant, popover.triggerProps.ref]);

  useEffect(() => {
    if (!open) return;
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open, measure]);

  useEffect(() => {
    if (!open) {
      setError(null);
      setPlace(null);
    }
  }, [open]);

  // A menu with nothing to choose still needs focus inside it, so Escape and Tab behave.
  useEffect(() => {
    if (!open || !place) return;
    const menu = popover.menuProps.ref.current;
    if (menu && !menu.querySelector('[role^="menuitem"]')) menu.focus({ preventScroll: true });
  }, [open, place, popover.menuProps.ref]);

  if (!entry) return null;

  const { realm } = entry;
  // Every account opens inside ThreadStack now, including ones that used to open in their own window.
  const accounts = entry.accounts;
  const browseTab = workspace.state.tabs.find((t) => t.id === workspace.state.activeTabId) ?? null;
  const inFrontId = accountId ?? (browseTab?.realm === realmId ? browseTab.accountId : null) ?? entry.activeAccountId;
  const inFront = accounts.find((a) => a.id === inFrontId) ?? accounts.find((a) => a.id === entry.activeAccountId) ?? null;
  const pending = entry.pendingSignIn ? accounts.find((a) => a.id === entry.pendingSignIn?.accountId) ?? null : null;

  const closeToButton = () => {
    setOpen(false);
    popover.triggerProps.ref.current?.focus();
  };

  const choose = (account: AccountRecord) => {
    setError(null);
    const outcome = workspace.goToAccount(account.id);
    if (!outcome.ok) {
      setError(outcome.message);
      return;
    }
    setView('browse');
    announce(
      needsSignIn(account) && account.id !== entry.activeAccountId
        ? `${account.label} is not signed in to ${realm.label} yet. Choose how to sign in.`
        : `Showing ${realm.label} as ${account.label}.`
    );
    closeToButton();
  };

  const buttonLabel = realm.switchable
    ? `${realm.label} account: ${inFront ? inFront.label : 'not known yet'}. ${accounts.length > 1 ? 'Choose another account' : 'Accounts'}`
    : `${realm.label} accounts`;

  return (
    <>
      <button
        type="button"
        className="tk-btn tk-btn-quiet tk-acct-menu-btn"
        data-variant={variant}
        data-busy={busy ? 'true' : undefined}
        aria-label={buttonLabel}
        aria-busy={busy || undefined}
        {...popover.triggerProps}
        onClick={() => {
          if (!open) measure();
          popover.toggle();
        }}
      >
        <span className="tk-acct-realm">{realm.label}</span>
        {inFront ? (
          <AccountChip account={inFront} active={accountState(inFront, entry.activeAccountId) !== 'signed_out'} />
        ) : (
          <span className="tk-acct-fixed">{realm.switchable ? 'No account yet' : 'This browser’s sign-in'}</span>
        )}
        <Icon name="chevronDown" size={14} className="tk-acct-chev" />
      </button>
      {open &&
        place &&
        createPortal(
          <div
            {...popover.menuProps}
            className="tk-pop tk-acct-menu"
            aria-label={`${realm.label} accounts`}
            aria-busy={busy || undefined}
            tabIndex={-1}
            style={{ left: place.left, top: place.top, bottom: place.bottom }}
            onKeyDown={onMenuKeyDown}
          >
            <div className="tk-acct-menu-head">
              <strong>{realm.label} accounts</strong>
              {realm.switchable ? (
                <span>Every account stays signed in. Choose one to go to its tabs.</span>
              ) : (
                <span>{realm.fixedReason}</span>
              )}
            </div>
            {realm.switchable &&
              accounts.map((account) => {
                const state = accountState(account, entry.activeAccountId);
                const front = account.id === inFront?.id;
                return (
                  <button
                    key={account.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={front}
                    className="tk-acct-item"
                    onClick={() => choose(account)}
                  >
                    <span className="tk-acct-swatch" data-color={account.color} aria-hidden="true" />
                    <span className="tk-acct-item-text">
                      <span className="tk-acct-item-name">{account.label}</span>
                      <span className="tk-acct-item-sub">{accountSubtitle(account, state === 'browser')}</span>
                    </span>
                    <span className="tk-acct-item-right">
                      {front && <Icon name="check" size={14} />}
                      {pending?.id === account.id
                        ? 'Signing in…'
                        : state === 'browser'
                          ? 'This browser'
                          : state === 'signed_in'
                            ? 'Signed in'
                            : 'Sign in'}
                    </span>
                  </button>
                );
              })}
            {error && (
              <p className="tk-acct-menu-error" role="alert">
                {error}
              </p>
            )}
            {realm.switchable && (
              <>
                <div className="tk-acct-menu-sep" role="separator" />
                <button
                  type="button"
                  role="menuitem"
                  className="tk-acct-item tk-acct-item-short"
                  onClick={() => {
                    closeToButton();
                    requestAddAccount(realmId);
                  }}
                >
                  <Icon name="userPlus" />
                  <span className="tk-acct-item-name">Add account</span>
                  <span />
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="tk-acct-item tk-acct-item-short"
                  onClick={() => {
                    closeToButton();
                    openSettings('accounts');
                  }}
                >
                  <Icon name="settings" />
                  <span className="tk-acct-item-name">Manage accounts</span>
                  <span />
                </button>
              </>
            )}
          </div>,
          document.body
        )}
    </>
  );
}
