// The button that shows which account a sign-in is using, and the menu that switches it.
import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../shell/icons.js';
import { AccountChip, accountSubtitle, onMenuKeyDown, usePopover } from '../shell/primitives.js';
import { useWorkspaceContext } from '../workspace/context.js';
import type { AccountRecord } from '../../../core/workspace/types.js';
import { useMounted } from './common.js';

export interface AccountMenuButtonProps {
  /** The sign-in whose accounts the menu lists and switches. */
  realmId: string;
  /**
   * `toolbar`: "Claude · Work" with a chevron, in the Browse toolbar.
   * `rail`: one row of the "Signed in" list in the side navigation.
   */
  variant: 'toolbar' | 'rail';
}

interface MenuPlace {
  left: number;
  top?: number;
  bottom?: number;
}

const MENU_WIDTH = 340;
const EDGE = 8;

/** The button that shows which account a sign-in is using and opens the menu to switch it. */
export function AccountMenuButton({ realmId, variant }: AccountMenuButtonProps) {
  const { workspace, announce, requestAddAccount, openSettings } = useWorkspaceContext();
  const popover = usePopover();
  const mounted = useMounted();
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [place, setPlace] = useState<MenuPlace | null>(null);

  const entry = workspace.realms.find((r) => r.realm.id === realmId) ?? null;
  const switching = workspace.switchingRealm === realmId;
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
  const active = entry.accounts.find((a) => a.id === entry.activeAccountId) ?? null;
  const embedded = entry.accounts.filter((a) => a.mode === 'embedded');
  const isolated = entry.accounts.filter((a) => a.mode === 'isolated');

  const closeToButton = () => {
    setOpen(false);
    popover.triggerProps.ref.current?.focus();
  };

  const choose = async (account: AccountRecord) => {
    if (switching) return;
    if (account.id === entry.activeAccountId) {
      closeToButton();
      return;
    }
    setError(null);
    setPendingId(account.id);
    const result = await workspace.switchAccount(account.id);
    if (!mounted.current) return;
    setPendingId(null);
    if (result.ok) {
      announce(`${realm.label} is now signed in as ${account.label}.`);
      closeToButton();
    } else {
      setError(result.error);
    }
  };

  const openWindow = async (account: AccountRecord) => {
    setError(null);
    const result = await workspace.openIsolated(account.id, realm.homeUrl);
    if (!mounted.current) return;
    if (result.ok) {
      announce(`Opening ${account.label} in its own Chrome window.`);
      closeToButton();
    } else {
      setError(result.error);
    }
  };

  const buttonLabel = realm.switchable
    ? `${realm.label} account: ${active ? `${active.label}, signed in` : 'not known yet'}. Switch account`
    : `${realm.label} accounts`;

  return (
    <>
      <button
        type="button"
        className="tk-btn tk-btn-quiet tk-acct-menu-btn"
        data-variant={variant}
        data-busy={switching ? 'true' : undefined}
        aria-label={buttonLabel}
        aria-busy={switching || undefined}
        {...popover.triggerProps}
        onClick={() => {
          if (!open) measure();
          popover.toggle();
        }}
      >
        <span className="tk-acct-realm">{realm.label}</span>
        {active ? (
          <AccountChip account={active} active />
        ) : (
          <span className="tk-acct-fixed">{realm.switchable ? 'Not signed in' : 'This browser’s sign-in'}</span>
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
            aria-busy={switching || undefined}
            tabIndex={-1}
            style={{ left: place.left, top: place.top, bottom: place.bottom }}
            onKeyDown={onMenuKeyDown}
          >
            <div className="tk-acct-menu-head">
              <strong>{realm.label} accounts</strong>
              {realm.switchable ? (
                <span>One account is signed in at a time. Switching reloads {realm.label} tabs.</span>
              ) : (
                <span>{realm.fixedReason}</span>
              )}
            </div>
            {realm.switchable && (
              <>
                {embedded.map((account) => {
                  const isActive = account.id === entry.activeAccountId;
                  const isPending = pendingId === account.id;
                  return (
                    <button
                      key={account.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={isActive}
                      aria-disabled={switching || undefined}
                      className="tk-acct-item"
                      data-busy={isPending ? 'true' : undefined}
                      onClick={() => void choose(account)}
                    >
                      <span className="tk-acct-swatch" data-color={account.color} aria-hidden="true" />
                      <span className="tk-acct-item-text">
                        <span className="tk-acct-item-name">{account.label}</span>
                        <span className="tk-acct-item-sub">{accountSubtitle(account)}</span>
                      </span>
                      <span className="tk-acct-item-right">
                        {isPending ? (
                          'Switching…'
                        ) : isActive ? (
                          <>
                            <Icon name="check" size={14} />
                            Signed in
                          </>
                        ) : null}
                      </span>
                    </button>
                  );
                })}
                {isolated.length > 0 && (
                  <div role="group" aria-labelledby={`${popover.menuProps.id}-own`}>
                    <div className="tk-acct-menu-group" id={`${popover.menuProps.id}-own`}>
                      In their own window
                    </div>
                    {isolated.map((account) => (
                      <button
                        key={account.id}
                        type="button"
                        role="menuitem"
                        className="tk-acct-item"
                        onClick={() => void openWindow(account)}
                      >
                        <span className="tk-acct-swatch" data-color={account.color} aria-hidden="true" />
                        <span className="tk-acct-item-text">
                          <span className="tk-acct-item-name">{account.label}</span>
                          <span className="tk-acct-item-sub">{accountSubtitle(account)}</span>
                        </span>
                        <span className="tk-acct-item-right">
                          <Icon name="window" size={14} />
                          Open window
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
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
