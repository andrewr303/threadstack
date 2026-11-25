// Browse: provider sites embedded as pages, one tab per session. The bar (tab strip and
// toolbar) is the only glass; the page, the summary panel and the new tab page are opaque.
//
// Split view shows two panes side by side, each with its own bar, tabs and page; sessions open
// in the focused pane. The status board replaces both with the sessions by run state.
//
// The page itself is never rendered here. <FrameSlot> marks where the stage puts it, so opening
// the summary panel or splitting the view changes the layout in one step and no page reloads.
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { BrowsePane } from '../../../core/workspace/types.js';
import { FrameSlot } from '../workspace/FrameStage.js';
import { RestingPage } from '../workspace/RestingPage.js';
import { useWorkspaceContext } from '../workspace/context.js';
import { browseOf, paneOfTab, tabsInPane } from '../workspace/state.js';
import { Icon } from '../shell/icons.js';
import { NewTabPage } from './NewTabPage.js';
import { StatusBoard } from './StatusBoard.js';
import { SummaryPanel } from './SummaryPanel.js';
import { TabStrip, tabDomId } from './TabStrip.js';
import { Toolbar, type AddressNotice } from './Toolbar.js';

export function BrowseView() {
  const { workspace } = useWorkspaceContext();
  const layout = browseOf(workspace.state);
  const { dispatch } = workspace;

  // Focus follows a click into an embedded page: the page's frame is not inside the pane's DOM
  // (the stage owns every frame), so the click is seen as this window losing focus to that frame.
  const stateRef = useRef(workspace.state);
  stateRef.current = workspace.state;
  useEffect(() => {
    if (!layout.split) return;
    const onBlur = () => {
      setTimeout(() => {
        const active = document.activeElement;
        if (!(active instanceof HTMLIFrameElement) || !active.dataset.tab) return;
        const state = stateRef.current;
        const tab = state.tabs.find((t) => t.id === active.dataset.tab);
        const current = browseOf(state);
        if (tab && current.split && current.mode === 'tabs' && paneOfTab(tab) !== current.focusedPane) {
          dispatch({ type: 'browse_focus', pane: paneOfTab(tab) });
        }
      }, 0);
    };
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, [layout.split, dispatch]);

  if (layout.mode === 'board') {
    return <StatusBoard onShowTabs={() => dispatch({ type: 'browse_mode', mode: 'tabs' })} />;
  }

  return (
    <div className="tk-browse" data-split={layout.split ? 'true' : 'false'}>
      {layout.split ? (
        <>
          <BrowsePaneView pane={0} />
          <BrowsePaneView pane={1} />
        </>
      ) : (
        <BrowsePaneView pane={null} />
      )}
    </div>
  );
}

/**
 * One Browse pane: its bar, its page and its summary. `pane` null is the single, unsplit view
 * over every tab; 0 or 1 is that side of the split view, over that pane's tabs only.
 */
function BrowsePaneView({ pane }: { pane: BrowsePane | null }) {
  const { workspace, openInChromeTab, announce } = useWorkspaceContext();
  const idPrefix = useId().replace(/:/g, '');
  const panelId = `${idPrefix}-stage`;
  const summaryId = `${idPrefix}-summary`;
  const layout = browseOf(workspace.state);
  const split = pane !== null;
  const focused = !split || layout.focusedPane === pane;
  const allTabs = workspace.state.tabs;
  const tabs = useMemo(() => (pane === null ? allTabs : tabsInPane(allTabs, pane)), [allTabs, pane]);
  const paneActiveId = split ? layout.paneActive[pane] : workspace.state.activeTabId;
  const activeTab = tabs.find((t) => t.id === paneActiveId) ?? null;

  const [newTabOpen, setNewTabOpen] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [notice, setNotice] = useState<AddressNotice | null>(null);
  const newTabRef = useRef<HTMLButtonElement>(null);
  const summaryButtonRef = useRef<HTMLButtonElement>(null);
  const launchRef = useRef<HTMLDivElement>(null);
  const openedOver = useRef<string | null>(null);
  // Focus follows the page that opens or closes: into the new tab page, back to its button.
  const focusAfter = useRef<'launch' | 'button' | null>(null);

  const showNewTab = newTabOpen || !activeTab;
  const tab = showNewTab ? null : activeTab;

  // A tab that becomes this pane's tab some other way (the side rail, another view) leaves the
  // new tab page.
  useEffect(() => {
    if (newTabOpen && paneActiveId !== openedOver.current) setNewTabOpen(false);
  }, [paneActiveId, newTabOpen]);

  // A message about one address belongs to the tab it was typed in.
  useEffect(() => {
    setNotice(null);
  }, [tab?.id]);

  useEffect(() => {
    const target = focusAfter.current;
    if (!target) return;
    focusAfter.current = null;
    (target === 'launch' ? launchRef.current : newTabRef.current)?.focus();
  }, [newTabOpen]);

  /** Sessions opened from here (the new tab page, an address) go to this pane. */
  const focusPane = useCallback(() => {
    if (pane !== null && browseOf(workspace.state).split && browseOf(workspace.state).focusedPane !== pane) {
      workspace.dispatch({ type: 'browse_focus', pane });
    }
  }, [pane, workspace]);

  const openNewTab = () => {
    focusPane();
    openedOver.current = paneActiveId;
    setNotice(null);
    // Move into the page so Escape works from the keyboard.
    focusAfter.current = 'launch';
    setNewTabOpen(true);
  };

  const leaveNewTab = useCallback(() => {
    focusAfter.current = 'button';
    setNewTabOpen(false);
  }, []);

  const activate = (id: string) => {
    setNewTabOpen(false);
    workspace.activateTab(id);
  };

  const launch = (url: string, accountId?: string) => {
    focusPane();
    const result = workspace.openUrl(url, accountId ? { accountId } : undefined);
    if (result.ok) {
      setNotice(null);
      setNewTabOpen(false);
      announce('Opened a new tab');
    } else {
      setNotice({ message: result.message, chromeUrl: url });
      announce(result.message);
    }
  };

  const closeSummary = () => {
    setSummaryOpen(false);
    summaryButtonRef.current?.focus();
  };

  const label = pane === null ? undefined : pane === 0 ? 'Left pane' : 'Right pane';

  return (
    <section
      className="tk-browse-pane"
      aria-label={label}
      data-pane={pane ?? undefined}
      data-focused={split && focused ? 'true' : undefined}
      // Any click or keyboard focus inside a pane makes it the one sessions open in.
      onPointerDownCapture={focusPane}
      onFocusCapture={focusPane}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && newTabOpen && activeTab && !event.defaultPrevented) {
          event.preventDefault();
          leaveNewTab();
        }
      }}
    >
      <div className="tk-browse-bar tk-glass" role="group" aria-label={label ? `Browser, ${label.toLowerCase()}` : 'Browser'}>
        <TabStrip
          idPrefix={idPrefix}
          tabs={tabs}
          activeId={paneActiveId}
          selectedId={tab?.id ?? null}
          panelId={panelId}
          onActivate={activate}
          onNewTab={openNewTab}
          newTabRef={newTabRef}
          newTabOpen={showNewTab}
          // The board button sits once, in the single bar or the left pane's.
          showBoard={pane === null || pane === 0}
        />
        <Toolbar
          tab={tab}
          compact={split}
          pane={pane}
          summaryOpen={summaryOpen && tab !== null}
          summaryId={summaryId}
          summaryButtonRef={summaryButtonRef}
          onToggleSummary={() => setSummaryOpen((open) => !open)}
          onNotice={setNotice}
        />
      </div>
      {notice && (
        <div className="tk-browse-notice" role="group" aria-label="Address problem">
          <Icon name="alert" size={16} />
          <p className="tk-browse-notice-text">{notice.message}</p>
          {notice.chromeUrl && (
            <button type="button" className="tk-btn" onClick={() => openInChromeTab(notice.chromeUrl as string)}>
              <Icon name="external" />
              Open in Chrome tab
            </button>
          )}
          <button type="button" className="tk-icon-btn" aria-label="Dismiss message" title="Dismiss" onClick={() => setNotice(null)}>
            <Icon name="close" />
          </button>
        </div>
      )}
      <div className="tk-browse-body">
        {tab ? (
          <div
            id={panelId}
            className="tk-browse-panel"
            role="tabpanel"
            aria-labelledby={tabDomId(idPrefix, tab.id)}
          >
            <FrameSlot tabId={tab.id} className="tk-browse-stage">
              <RestingPage tab={tab} noun="tab" />
            </FrameSlot>
          </div>
        ) : (
          <NewTabPage ref={launchRef} onOpen={launch} />
        )}
        {tab && summaryOpen && <SummaryPanel id={summaryId} tab={tab} onClose={closeSummary} />}
      </div>
    </section>
  );
}
