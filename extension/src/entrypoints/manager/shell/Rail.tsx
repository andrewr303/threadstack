// The side rail of the full page: the ThreadStack brand and its tools (theme, add account,
// Settings, the session palette, collapse), the view switch, recent sessions and the Threads
// navigation the app passes in. A glass island over the canvas; a 64px icon strip when collapsed
// (brand mark, expand, search, the five views, then add account, Settings and the theme at the
// foot); below 900px wide it is that strip, and opens as a drawer over the page. Accounts and the
// Paperclip connection live in Settings and in the Browse and Paperclip views.
import React, { useCallback, useEffect, useState } from 'react';
import type { WorkspaceView } from '../../../core/workspace/types.js';
import type { SectionId } from '../SettingsDialog.js';
import { useWorkspaceContext } from '../workspace/context.js';
import { Icon, type IconName } from './icons.js';
import { Segmented, hasOpenPopover } from './primitives.js';
import { SessionsNav } from './SessionsNav.js';

/** Brand images, copied next to manager.html by scripts/build-extension.mjs. */
export const BRAND_WORDMARK = 'assets/brand/threadstack-wordmark.png';
export const BRAND_MARK = 'assets/brand/threadstack-mark.png';

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
  /** The complete Threads index replaces the recent-session preview in this same sidebar. */
  sessions?: React.ReactNode;
  /**
   * REQ-6 fused mode: Paperclip's sidebar is the only view switch, so this rail draws none and
   * becomes the left column of the ThreadStack view (sessions, accounts, Settings).
   */
  fused?: boolean;
  /**
   * Threads view only: receives the element at the top of the rail, beside the view switch, where
   * the Threads list renders its search and grouping controls (a portal keeps them in its tree).
   */
  onThreadsTop?: (element: HTMLDivElement | null) => void;
}

const VIEWS: ReadonlyArray<{ value: WorkspaceView; label: string; icon: IconName }> = [
  { value: 'browse', label: 'Browse', icon: 'browse' },
  { value: 'threads', label: 'Threads', icon: 'threads' },
  { value: 'table', label: 'Table', icon: 'table' },
  { value: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
  { value: 'paperclip', label: 'Paperclip', icon: 'window' },
];

/**
 * The expanded rail's switch shows icons only: five names do not fit its width ("Dashboard" needs
 * about 60px of a 48px slot). Each name stays the button's accessible name and tooltip.
 */
const RAIL_SEGMENTS = VIEWS.map((option) => ({ ...option, hideLabel: true }));

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
  sessions,
  fused = false,
  onThreadsTop,
}: RailProps) {
  const { workspace, requestAddAccount, openPalette, paletteEnabled } = useWorkspaceContext();
  const paletteOn = Boolean(paletteEnabled && openPalette);
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

  const themeHint = effectiveTheme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
  const tools = (
    <>
      <button type="button" className="tk-icon-btn tk-rail-tool" aria-label="Toggle color theme" title={themeHint} onClick={onToggleTheme}>
        <Icon name={effectiveTheme === 'dark' ? 'sun' : 'moon'} />
      </button>
      <button
        type="button"
        className="tk-icon-btn tk-rail-tool"
        aria-label="Add account"
        title="Add account"
        aria-haspopup="dialog"
        onClick={() => {
          afterChoice();
          requestAddAccount();
        }}
      >
        <Icon name="userPlus" />
      </button>
      <button
        type="button"
        className="tk-icon-btn tk-rail-tool"
        aria-label="Settings"
        title="Settings"
        aria-haspopup="dialog"
        onClick={() => {
          afterChoice();
          onOpenSettings();
        }}
      >
        <Icon name="settings" />
      </button>
    </>
  );
  const search = paletteOn ? (
    <button
      type="button"
      className="tk-icon-btn tk-rail-tool"
      aria-label="Search sessions"
      title="Search sessions (⌘K)"
      aria-haspopup="dialog"
      aria-keyshortcuts="Meta+K Control+K"
      onClick={() => {
        afterChoice();
        openPalette?.();
      }}
    >
      <Icon name="search" />
    </button>
  ) : null;
  const toggle = (
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
  );

  return (
    <>
      {drawer && <div className="tk-rail-scrim" aria-hidden="true" onClick={closeDrawer} />}
      <aside
        className="tk-rail tk-glass"
        data-collapsed={iconOnly ? 'true' : 'false'}
        data-drawer-open={drawer ? 'true' : 'false'}
        data-view={view}
        aria-label="Workspace"
      >
        {iconOnly ? (
          <div className="tk-rail-head">
            <span className="tk-rail-brand" title="ThreadStack">
              <img className="tk-rail-mark" src={BRAND_MARK} alt="ThreadStack" width={32} height={32} draggable={false} />
            </span>
            {toggle}
            {search}
          </div>
        ) : (
          <div className="tk-rail-top">
            <div className="tk-rail-head">
              <span className="tk-rail-brand">
                <img className="tk-rail-wordmark" src={BRAND_WORDMARK} alt="ThreadStack" height={29} draggable={false} />
              </span>
              <div className="tk-rail-actions">
                {tools}
                {search}
                {toggle}
              </div>
            </div>
            {fused ? null : (
              <div className="tk-rail-views">
                <Segmented label="View" value={view} options={RAIL_SEGMENTS} onChange={changeView} className="tk-rail-seg" />
              </div>
            )}
            {/* Threads lifts its search and grouping controls up here, beside the switch. */}
            {sessions && view === 'threads' && <div className="tk-rail-threads-top" ref={onThreadsTop} />}
          </div>
        )}

        {fused || !iconOnly ? null : (
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

        {/* Keep the full Threads index mounted across view changes and collapse so an Ask draft,
            expanded filters and scroll position survive. The preview is used on other views. */}
        {sessions ? (
          <>
            <div className="tk-rail-scroll" data-thread-index="true" hidden={iconOnly || view !== 'threads'}
              onClick={(event) => {
                if (event.target instanceof Element && event.target.closest('button.tk-row-btn')) afterChoice();
              }}>
              {sessions}
              {children && <details className="tk-rail-collections"><summary>Projects &amp; queues</summary>{children}</details>}
            </div>
            {!iconOnly && view !== 'threads' && <div className="tk-rail-scroll"><SessionsNav onOpened={afterChoice} /></div>}
          </>
        ) : iconOnly ? (
          <div className="tk-rail-scroll" />
        ) : (
          <div className="tk-rail-scroll">
            <SessionsNav onOpened={afterChoice} />
            {children}
          </div>
        )}

        {iconOnly && <div className="tk-rail-foot">{tools}</div>}
      </aside>
    </>
  );
}
