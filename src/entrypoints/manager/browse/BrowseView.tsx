// Browse: provider sites embedded as pages, one tab per session. The bar (tab strip and
// toolbar) is the only glass; the page, the summary panel and the new tab page are opaque.
//
// The page itself is never rendered here. <FrameSlot> marks where the stage puts it, so opening
// the summary panel changes the layout in one step and the page never reloads or drifts.
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { FrameSlot } from '../workspace/FrameStage.js';
import { RestingPage } from '../workspace/RestingPage.js';
import { useWorkspaceContext } from '../workspace/context.js';
import { Icon } from '../shell/icons.js';
import { NewTabPage } from './NewTabPage.js';
import { SummaryPanel } from './SummaryPanel.js';
import { TabStrip, tabDomId } from './TabStrip.js';
import { Toolbar, type AddressNotice } from './Toolbar.js';

export function BrowseView() {
  const { workspace, openInChromeTab, announce } = useWorkspaceContext();
  const idPrefix = useId().replace(/:/g, '');
  const panelId = `${idPrefix}-stage`;
  const summaryId = `${idPrefix}-summary`;
  const { tabs, activeTabId } = workspace.state;
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;

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

  // A tab that becomes the active one some other way (the side rail, another view) leaves the
  // new tab page.
  useEffect(() => {
    if (newTabOpen && activeTabId !== openedOver.current) setNewTabOpen(false);
  }, [activeTabId, newTabOpen]);

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

  const openNewTab = () => {
    openedOver.current = activeTabId;
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

  const toggleSummary = () => {
    setSummaryOpen((open) => !open);
  };

  const closeSummary = () => {
    setSummaryOpen(false);
    summaryButtonRef.current?.focus();
  };

  return (
    <div
      className="tk-browse"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && newTabOpen && activeTab && !event.defaultPrevented) {
          event.preventDefault();
          leaveNewTab();
        }
      }}
    >
      <div className="tk-browse-bar tk-glass" role="group" aria-label="Browser">
        <TabStrip
          idPrefix={idPrefix}
          selectedId={tab?.id ?? null}
          panelId={panelId}
          onActivate={activate}
          onNewTab={openNewTab}
          newTabRef={newTabRef}
          newTabOpen={showNewTab}
        />
        <Toolbar
          tab={tab}
          summaryOpen={summaryOpen && tab !== null}
          summaryId={summaryId}
          summaryButtonRef={summaryButtonRef}
          onToggleSummary={toggleSummary}
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
    </div>
  );
}
