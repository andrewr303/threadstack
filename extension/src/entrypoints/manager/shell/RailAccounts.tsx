// The foot of the rail: which account each sign-in is using, adding an account, Settings and the
// theme. Pinned to the bottom of the rail; icons only when the rail is collapsed.
import React, { useId } from 'react';
import { AccountMenuButton } from '../accounts/AccountMenu.js';
import type { SectionId } from '../SettingsDialog.js';
import { useWorkspaceContext } from '../workspace/context.js';
import { Icon } from './icons.js';

export function RailAccounts({
  collapsed,
  effectiveTheme,
  onOpenSettings,
  onToggleTheme,
}: {
  collapsed: boolean;
  effectiveTheme: 'light' | 'dark';
  onOpenSettings: (section?: SectionId) => void;
  onToggleTheme: () => void;
}) {
  const { workspace, requestAddAccount } = useWorkspaceContext();
  const headingId = useId();
  // A sign-in earns a row only when there is something to choose: it has more than one account.
  // With a single account the row would say nothing the page does not already show, and six
  // such rows crowd out the sessions above. "Add account" is how a second one starts.
  const realms = workspace.realms.filter((r) => r.accounts.length > 1);
  // Named "Toggle color theme" like the library header's button, which the full page hides.
  const themeLabel = 'Toggle color theme';
  const themeHint = effectiveTheme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';

  return (
    <div className="tk-rail-foot">
      {realms.length > 0 && (
        <section aria-labelledby={headingId}>
          <h2 className={collapsed ? 'tk-visually-hidden' : 'tk-rail-label'} id={headingId}>
            Signed in
          </h2>
          <ul className="tk-rail-realms">
            {realms.map((r) => (
              <li key={r.realm.id}>
                <AccountMenuButton realmId={r.realm.id} variant="rail" />
              </li>
            ))}
          </ul>
        </section>
      )}
      {collapsed ? (
        <div className="tk-rail-tools">
          <button
            type="button"
            className="tk-icon-btn"
            aria-label="Add account"
            title="Add account"
            aria-haspopup="dialog"
            onClick={() => requestAddAccount()}
          >
            <Icon name="userPlus" />
          </button>
          <button
            type="button"
            className="tk-icon-btn"
            aria-label="Settings"
            title="Settings"
            aria-haspopup="dialog"
            onClick={() => onOpenSettings()}
          >
            <Icon name="settings" />
          </button>
          <button type="button" className="tk-icon-btn" aria-label={themeLabel} title={themeHint} onClick={onToggleTheme}>
            <Icon name={effectiveTheme === 'dark' ? 'sun' : 'moon'} />
          </button>
        </div>
      ) : (
        <>
          <button
            type="button"
            className="tk-btn tk-btn-quiet tk-rail-add"
            aria-haspopup="dialog"
            onClick={() => requestAddAccount()}
          >
            <Icon name="userPlus" />
            Add account
          </button>
          <div className="tk-rail-tools">
            <button type="button" className="tk-btn tk-btn-quiet" aria-haspopup="dialog" onClick={() => onOpenSettings()}>
              <Icon name="settings" />
              Settings
            </button>
            <button type="button" className="tk-icon-btn" aria-label={themeLabel} title={themeHint} onClick={onToggleTheme}>
              <Icon name={effectiveTheme === 'dark' ? 'sun' : 'moon'} />
            </button>
          </div>
        </>
      )}
    </div>
  );
}
