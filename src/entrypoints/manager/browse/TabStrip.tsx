// The row of open sessions at the top of Browse: a tablist with a sliding underline under the
// selected tab, and the new-tab button fixed at its end.
import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { providerCategory } from '../../../core/providers.js';
import type { SessionTab } from '../../../core/workspace/types.js';
import { Icon } from '../shell/icons.js';
import { AccountChip, ProviderMark, RunState, providerName } from '../shell/primitives.js';
import { useWorkspaceContext } from '../workspace/context.js';
import { findAccount } from '../workspace/state.js';

/** DOM id of a tab button, stable for aria-controls and aria-labelledby. */
export function tabDomId(prefix: string, tabId: string): string {
  return `${prefix}-tab-${tabId.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

export function TabStrip({
  idPrefix,
  selectedId,
  panelId,
  onActivate,
  onNewTab,
  newTabRef,
  newTabOpen,
}: {
  idPrefix: string;
  /** The tab shown in the stage; null while the new tab page is shown. */
  selectedId: string | null;
  panelId: string;
  onActivate: (id: string) => void;
  onNewTab: () => void;
  newTabRef: React.RefObject<HTMLButtonElement>;
  newTabOpen: boolean;
}) {
  const { workspace, conversationByKey, announce } = useWorkspaceContext();
  const tabs = workspace.state.tabs;
  const activeTabId = workspace.state.activeTabId;
  const stripRef = useRef<HTMLDivElement>(null);
  const indicatorRef = useRef<HTMLSpanElement>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const placed = useRef(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  // After a close, focus goes to whichever tab took the closed tab's place.
  const pending = useRef<{ closedId: string; neighbour: string | null; wasActive: boolean } | null>(null);

  const rovingId = tabs.some((t) => t.id === focusId)
    ? focusId
    : tabs.some((t) => t.id === (selectedId ?? activeTabId))
      ? (selectedId ?? activeTabId)
      : (tabs[0]?.id ?? null);

  const place = useCallback(() => {
    const strip = stripRef.current;
    const indicator = indicatorRef.current;
    if (!strip || !indicator) return;
    const button = selectedId ? buttons.current.get(selectedId) : null;
    const el = button?.parentElement ?? null;
    if (!el) {
      indicator.hidden = true;
      placed.current = false;
      return;
    }
    indicator.hidden = false;
    const x = el.offsetLeft + 14;
    const w = Math.max(10, el.offsetWidth - 28);
    if (!placed.current) {
      // First placement: appear in position instead of sliding in from the corner.
      indicator.style.transition = 'none';
      indicator.style.transform = `translateX(${x}px) scaleX(${w})`;
      void indicator.getBoundingClientRect();
      indicator.style.transition = '';
      placed.current = true;
    } else {
      indicator.style.transform = `translateX(${x}px) scaleX(${w})`;
    }
    // Keep the selected tab in view without scrolling anything but the strip.
    const r = el.getBoundingClientRect();
    const s = strip.getBoundingClientRect();
    if (r.width > 0) {
      if (r.right > s.right) strip.scrollLeft += r.right - s.right + 8;
      else if (r.left < s.left) strip.scrollLeft -= s.left - r.left + 8;
    }
  }, [selectedId]);

  useLayoutEffect(() => {
    place();
  }, [place, tabs]);

  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (!strip || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => place());
    observer.observe(strip);
    return () => observer.disconnect();
  }, [place, tabs.length]);

  useLayoutEffect(() => {
    const p = pending.current;
    if (!p || tabs.some((t) => t.id === p.closedId)) return;
    pending.current = null;
    const target = (p.wasActive ? activeTabId : p.neighbour) ?? p.neighbour;
    const el = (target && buttons.current.get(target)) || (p.neighbour && buttons.current.get(p.neighbour)) || null;
    if (el) {
      setFocusId(el.dataset.tabId ?? null);
      el.focus();
    } else {
      newTabRef.current?.focus();
    }
  }, [tabs, activeTabId, newTabRef]);

  const close = (tab: SessionTab) => {
    const index = tabs.findIndex((t) => t.id === tab.id);
    pending.current = {
      closedId: tab.id,
      neighbour: tabs[index + 1]?.id ?? tabs[index - 1]?.id ?? null,
      wasActive: tab.id === activeTabId,
    };
    workspace.closeTab(tab.id);
    announce(`Closed ${tab.title || 'tab'}`);
  };

  const move = (to: number) => {
    const next = tabs[(to + tabs.length) % tabs.length];
    if (!next) return;
    setFocusId(next.id);
    buttons.current.get(next.id)?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, tab: SessionTab, index: number) => {
    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault();
        move(index + 1);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        move(index - 1);
        break;
      case 'Home':
        event.preventDefault();
        move(0);
        break;
      case 'End':
        event.preventDefault();
        move(tabs.length - 1);
        break;
      case 'Delete':
      case 'Backspace':
        event.preventDefault();
        close(tab);
        break;
    }
  };

  const otherAccountLabel = (tab: SessionTab): string | null => {
    const entry = workspace.realms.find((r) => r.realm.id === tab.realm);
    const signedIn = entry?.activeAccountId ? findAccount(workspace.realms, entry.activeAccountId) : null;
    return signedIn?.label ?? null;
  };

  return (
    <div className="tk-browse-row">
      {tabs.length === 0 ? (
        <span className="tk-browse-tabs-empty">No open sessions</span>
      ) : (
        <div ref={stripRef} className="tk-browse-tabs" role="tablist" aria-label="Open sessions">
          {tabs.map((tab, index) => {
            const rest = workspace.plan.resting[tab.id];
            const paused = rest === 'account';
            const isolated = rest === 'isolated';
            const account = workspace.accountOf(tab);
            const conv = tab.threadKey ? conversationByKey.get(tab.threadKey) : undefined;
            const runState = providerCategory(tab.provider ?? '') === 'coding_agent'
              ? (workspace.runtime(tab.id).agentState ?? conv?.agentState ?? null)
              : null;
            const title = tab.title || 'Untitled session';
            const selected = tab.id === selectedId;
            const parts = [title, providerName(tab.provider), account?.label ?? 'removed account'];
            if (paused) {
              const other = otherAccountLabel(tab);
              parts.push(other ? `paused, signed in as ${other}` : 'paused');
            }
            if (isolated) parts.push('opens in its own window');
            const label = parts.join(', ');
            const tip = paused
              ? `${title} (paused until you switch to ${account?.label ?? 'this account'})`
              : isolated
                ? `${title} (opens in its own window)`
                : title;
            const signedIn = !paused;
            return (
              <div
                key={tab.id}
                className="tk-browse-tab"
                role="presentation"
                data-active={selected ? 'true' : 'false'}
                data-paused={paused ? 'true' : 'false'}
                data-isolated={isolated ? 'true' : 'false'}
              >
                <button
                  type="button"
                  role="tab"
                  id={tabDomId(idPrefix, tab.id)}
                  data-tab-id={tab.id}
                  className="tk-browse-tab-main"
                  aria-selected={selected}
                  aria-controls={selected ? panelId : undefined}
                  aria-label={label}
                  title={tip}
                  tabIndex={tab.id === rovingId ? 0 : -1}
                  ref={(el) => {
                    if (el) buttons.current.set(tab.id, el);
                    else buttons.current.delete(tab.id);
                  }}
                  onClick={() => onActivate(tab.id)}
                  onFocus={() => setFocusId(tab.id)}
                  onKeyDown={(event) => onKeyDown(event, tab, index)}
                  onMouseDown={(event) => {
                    // Middle click closes; stop the browser's auto-scroll cursor.
                    if (event.button === 1) event.preventDefault();
                  }}
                  onAuxClick={(event) => {
                    if (event.button !== 1) return;
                    event.preventDefault();
                    close(tab);
                  }}
                >
                  <ProviderMark provider={tab.provider} size="sm" />
                  <span className="tk-browse-tab-title">{title}</span>
                  {paused && <Icon name="pause" size={12} className="tk-browse-tab-pause" />}
                  {isolated && <Icon name="window" size={12} className="tk-browse-tab-pause" />}
                  {runState && <RunState state={runState} observedAt={conv?.agentStateAt} compact />}
                  <AccountChip account={account} active={signedIn} showName={false} />
                </button>
                <button
                  type="button"
                  className="tk-browse-tab-close"
                  aria-label={`Close ${title}`}
                  title="Close tab"
                  tabIndex={-1}
                  onClick={() => close(tab)}
                >
                  <Icon name="close" size={14} />
                </button>
              </div>
            );
          })}
          <span ref={indicatorRef} className="tk-browse-tab-ind" aria-hidden="true" hidden />
        </div>
      )}
      <button
        type="button"
        ref={newTabRef}
        className="tk-icon-btn tk-browse-newtab"
        aria-label="Open new tab"
        data-open={newTabOpen ? 'true' : 'false'}
        title="New tab"
        onClick={onNewTab}
      >
        <Icon name="plus" />
      </button>
    </div>
  );
}
