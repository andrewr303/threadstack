// The side rail of the full page: the brand, the view switch, recent sessions, the Threads
// navigation the app passes in, and (pinned to the bottom) the signed-in accounts, Settings and
// the theme. A glass island over the canvas; a 64px icon strip when collapsed; below 900px wide
// it is that strip, and opens as a drawer over the page.
import React, { useCallback, useEffect, useState } from 'react';
import type { WorkspaceView } from '../../../core/workspace/types.js';
import type { SectionId } from '../SettingsDialog.js';
import { useWorkspaceContext } from '../workspace/context.js';
import { Icon, type IconName } from './icons.js';
import { Segmented, hasOpenPopover } from './primitives.js';
import { RailAccounts } from './RailAccounts.js';
import { SessionsNav } from './SessionsNav.js';

export interface RailProps {
  /** Narrow, icon-only rail. */
  collapsed: boolean;
  /** Small windows: the rail slides over the page instead of sitting beside it. */
  drawerOpen: boolean;
  view: WorkspaceView;
  effectiveTheme: 'light' | 'dark';
  onViewChange: (view: WorkspaceView) => void;
  onToggleCollapsed: () => void;
  onCloseDrawer: () => void;
  onToggleTheme: () => void;
  onOpenSettings: (section?: SectionId) => void;
  /** Navigation that belongs to the Threads view (projects and resurfacing queues). */
  children?: React.ReactNode;
}

const VIEWS: ReadonlyArray<{ value: WorkspaceView; label: string; icon: IconName }> = [
  { value: 'browse', label: 'Browse', icon: 'browse' },
  { value: 'threads', label: 'Threads', icon: 'threads' },
  { value: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
];

/** Same width as the `max-width: 899px` rules in styles/10-shell.css. */
const NARROW_QUERY = '(max-width: 899px)';

function useMediaQuery(query: string): boolean {
  const read = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
  const [matches, setMatches] = useState(read);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(query);
    const onChange = () => setMatches(list.matches);
    onChange();
    list.addEventListener?.('change', onChange);
    return () => list.removeEventListener?.('change', onChange);
  }, [query]);
  return matches;
}

export function Rail({
  collapsed,
  drawerOpen,
  view,
  effectiveTheme,
  onViewChange,
  onToggleCollapsed,
  onCloseDrawer,
  onToggleTheme,
  onOpenSettings,
  children,
}: RailProps) {
  const { workspace } = useWorkspaceContext();
  const narrow = useMediaQuery(NARROW_QUERY);
  // In a small window the rail's own expand button opens the drawer; the app may open it too.
  const [ownDrawer, setOwnDrawer] = useState(false);
  const drawer = narrow && (drawerOpen || ownDrawer);
  const iconOnly = drawer ? false : collapsed || narrow;

  const closeDrawer = useCallback(() => {
    setOwnDrawer(false);
    onCloseDrawer();
  }, [onCloseDrawer]);

  // Leaving the small-window layout closes the drawer.
  useEffect(() => {
    if (!narrow) setOwnDrawer(false);
  }, [narrow]);

  // Escape closes the drawer (after any menu inside it, which handles Escape first).
  useEffect(() => {
    if (!drawer) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || hasOpenPopover()) return;
      event.preventDefault();
      event.stopPropagation();
      closeDrawer();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [drawer, closeDrawer]);

  const toggleLabel = iconOnly ? 'Expand navigation' : 'Collapse navigation';
  const onToggle = () => {
    if (drawer) closeDrawer();
    else if (narrow) setOwnDrawer(true);
    else onToggleCollapsed();
  };
  // Choosing something in the drawer shows it, so the drawer steps out of the way.
  const afterChoice = () => {
    if (drawer) closeDrawer();
  };
  // Arrow keys move through the view switch one view at a time, so a view change leaves the
  // drawer open; Escape or the scrim closes it.
  const changeView = (next: WorkspaceView) => onViewChange(next);

  return (
    <>
      {drawer && <div className="tk-rail-scrim" aria-hidden="true" onClick={closeDrawer} />}
      <aside
        className="tk-rail tk-glass"
        data-collapsed={iconOnly ? 'true' : 'false'}
        data-drawer-open={drawer ? 'true' : 'false'}
        aria-label="Workspace"
      >
        <div className="tk-rail-head">
          <div className="tk-rail-brand" title={iconOnly ? 'Threadkeeper' : undefined}>
            <span className="tk-rail-mark" aria-hidden="true">
              T
            </span>
            {iconOnly ? (
              <span className="tk-visually-hidden">Threadkeeper</span>
            ) : (
              <span className="tk-rail-wordmark">Threadkeeper</span>
            )}
          </div>
          <button
            type="button"
            className="tk-icon-btn tk-rail-toggle"
            aria-label={toggleLabel}
            title={toggleLabel}
            aria-expanded={!iconOnly}
            onClick={onToggle}
          >
            <Icon name="panelLeft" />
          </button>
        </div>

        {iconOnly ? (
          <nav aria-label="Views">
            <ul className="tk-rail-viewlist">
              {VIEWS.map((option) => (
                <li key={option.value}>
                  <button
                    type="button"
                    className="tk-icon-btn"
                    aria-label={option.label}
                    title={option.label}
                    aria-current={view === option.value ? 'page' : undefined}
                    onClick={() => changeView(option.value)}
                  >
                    <Icon name={option.icon} size={18} />
                  </button>
                </li>
              ))}
            </ul>
          </nav>
        ) : (
          <div className="tk-rail-views">
            <Segmented label="View" value={view} options={VIEWS} onChange={changeView} className="tk-rail-seg" />
          </div>
        )}

        {workspace.error && (
          <p className="tk-rail-notice" role="status" title={workspace.error}>
            <Icon name="alert" />
            {iconOnly ? (
              <span className="tk-visually-hidden">Embedded pages are unavailable. {workspace.error}</span>
            ) : (
              <span>
                <strong>Embedded pages are unavailable</strong>
                <span className="tk-rail-notice-detail">{workspace.error}</span>
              </span>
            )}
          </p>
        )}

        {/* The session lists and the Threads navigation need words; the icon strip leaves them out. */}
        {iconOnly ? (
          <div className="tk-rail-scroll" />
        ) : (
          <div className="tk-rail-scroll">
            <SessionsNav onOpened={afterChoice} />
            {children}
          </div>
        )}

        <RailAccounts
          collapsed={iconOnly}
          effectiveTheme={effectiveTheme}
          onOpenSettings={(section) => {
            afterChoice();
            onOpenSettings(section);
          }}
          onToggleTheme={onToggleTheme}
        />
      </aside>
    </>
  );
}
