// The Dashboard: pinned sessions in one to four live panes. The bar picks what goes in the
// focused pane and how many panes there are; each pane keeps its page loaded through the frame
// stage, so changing layout or view never reloads a session.
import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import type { ConversationRecord } from '../../../core/schema.js';
import { DASHBOARD_LAYOUTS, type DashboardLayout } from '../../../core/workspace/types.js';
import { AccountChip, Notice, ProviderMark, RunState, Segmented, type SegmentOption } from '../shell/primitives.js';
import { useWorkspaceContext } from '../workspace/context.js';
import { threadTabId } from '../workspace/state.js';
import { AGENT_STATE_LABELS } from '../../../core/workspace/types.js';
import { DashboardPane } from './DashboardPane.js';
import { hasWebPage, pinnedSessions, sessionTitle } from './shared.js';

const LAYOUT_OPTIONS: ReadonlyArray<SegmentOption<DashboardLayout>> = DASHBOARD_LAYOUTS.map((n) => ({
  value: n,
  label: `${n} ${n === 1 ? 'pane' : 'panes'}`,
  icon: `pane${n}` as 'pane1' | 'pane2' | 'pane3' | 'pane4',
  hideLabel: true,
}));

export function DashboardView() {
  const ctx = useWorkspaceContext();
  const { workspace, conversations, conversationByKey, view } = ctx;
  const { layout, panes, focusedPane } = workspace.state.dashboard;
  const pinned = useMemo(() => pinnedSessions(conversations), [conversations]);
  const pinnedKeys = useMemo(() => new Set(pinned.map((c) => c.threadKey)), [pinned]);
  const shown = useMemo(() => Array.from({ length: layout }, (_, i) => panes[i] ?? null), [panes, layout]);

  // Latest controller and context for effects that must not re-run on every render.
  const live = useRef({ workspace, ctx });
  live.current = { workspace, ctx };

  // Every pane's session has its tab; a pane whose session is gone or no longer pinned is cleared.
  useEffect(() => {
    const { workspace: ws } = live.current;
    const library = conversationByKey.size > 0 || conversations.length > 0;
    shown.forEach((key, i) => {
      if (!key) return;
      const conv = conversationByKey.get(key);
      if (!conv || !pinnedKeys.has(key)) {
        // An empty library may just not have loaded yet; only a missing session in a loaded one is gone.
        if (conv || library) {
          ws.dispatch({ type: 'dashboard_pane', index: i, threadKey: null });
          // Clearing a pane must not move the person's focus.
          if (i !== focusedPane) ws.dispatch({ type: 'dashboard_focus', index: focusedPane });
        }
        return;
      }
      if (!ws.state.tabs.some((t) => t.id === threadTabId(key)) && hasWebPage(conv)) {
        ws.openThread(conv, { activate: false });
      }
    });
  }, [shown, pinnedKeys, conversationByKey, conversations, workspace.state.tabs, focusedPane]);

  const focusPane = useCallback((index: number) => {
    const { workspace: ws } = live.current;
    if (ws.state.dashboard.focusedPane !== index) ws.dispatch({ type: 'dashboard_focus', index });
  }, []);

  const place = useCallback((index: number, conv: ConversationRecord) => {
    const { workspace: ws, ctx: c } = live.current;
    const outcome = ws.openThread(conv, { activate: false });
    if (!outcome.ok) {
      c.announce(outcome.message);
      c.openSession(conv, 'threads');
      return;
    }
    ws.dispatch({ type: 'dashboard_pane', index, threadKey: conv.threadKey });
    c.announce(`${sessionTitle(conv)} shown in pane ${index + 1}.`);
  }, []);

  const swap = useCallback((index: number, conv: ConversationRecord) => {
    const { workspace: ws } = live.current;
    const previous = ws.state.dashboard.panes[index] ?? null;
    const at = ws.state.dashboard.panes.indexOf(conv.threadKey);
    place(index, conv);
    // A session already in another pane trades places instead of leaving that pane empty.
    if (at >= 0 && at !== index && previous) ws.dispatch({ type: 'dashboard_pane', index: at, threadKey: previous });
    ws.dispatch({ type: 'dashboard_focus', index });
  }, [place]);

  const pressPinned = (conv: ConversationRecord) => {
    if (!hasWebPage(conv)) {
      ctx.openSession(conv, 'threads');
      return;
    }
    place(focusedPane, conv);
  };

  // Alt+1 .. Alt+4 focus a pane while the Dashboard is showing. Alt changes the typed character
  // on some keyboards, so the physical key is used.
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (view !== 'dashboard') return;
    const onKey = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const match = /^(?:Digit|Numpad)([1-4])$/.exec(event.code);
      const n = match ? Number(match[1]) : /^[1-4]$/.test(event.key) ? Number(event.key) : 0;
      if (!n || n > layout) return;
      event.preventDefault();
      focusPane(n - 1);
      root.current?.querySelector<HTMLElement>(`[data-pane-focus="${n - 1}"]`)?.focus();
      const key = shown[n - 1];
      const conv = key ? conversationByKey.get(key) : null;
      live.current.ctx.announce(conv ? `Pane ${n}: ${sessionTitle(conv)}` : `Pane ${n}: empty`);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view, layout, shown, conversationByKey, focusPane]);

  if (pinned.length === 0) {
    return (
      <div className="tk-dash tk-dash-none">
        <Notice
          icon="pin"
          title="No pinned sessions yet"
          actions={
            <button type="button" className="tk-btn tk-btn-primary" onClick={() => ctx.setView('threads')}>
              Go to Threads
            </button>
          }
        >
          <p>Pin a session from its thread or its tab’s summary and it appears here, ready to work in.</p>
        </Notice>
      </div>
    );
  }

  return (
    <div className="tk-dash" ref={root}>
      <header className="tk-dash-bar tk-glass" aria-label="Dashboard tools">
        <span className="tk-dash-label">Pinned</span>
        <div className="tk-dash-pins" role="group" aria-label="Pinned sessions">
          {pinned.map((conv) => {
            const slot = shown.indexOf(conv.threadKey);
            const owner = ctx.accountOfThread(conv);
            const web = hasWebPage(conv);
            const title = sessionTitle(conv);
            const state = conv.agentState && conv.agentState !== 'unknown' ? AGENT_STATE_LABELS[conv.agentState] : null;
            const label = [
              title,
              owner.account?.label ?? 'Removed account',
              state,
              slot >= 0 ? `in pane ${slot + 1}` : null,
            ]
              .filter(Boolean)
              .join(', ');
            return (
              <button
                key={conv.threadKey}
                type="button"
                className="tk-dash-pin"
                aria-pressed={slot >= 0 && slot === focusedPane}
                aria-label={`${label}. ${web ? 'Show in the focused pane' : 'Open in Threads'}`}
                title={web ? title : `${title}: this session has no web page to show here. Pressing it opens it in Threads.`}
                onClick={() => pressPinned(conv)}
              >
                <ProviderMark provider={conv.provider} size="sm" />
                <span className="tk-dash-pin-label tk-ellipsis">{title}</span>
                <AccountChip account={owner.account} active={owner.active} showName={false} />
                <RunState state={conv.agentState} observedAt={conv.agentStateAt} compact />
                {slot >= 0 && <span className="tk-dash-slot tk-tabular" aria-hidden="true">{slot + 1}</span>}
              </button>
            );
          })}
        </div>
        <span className="tk-dash-label">Panes</span>
        <Segmented
          label="Number of panes"
          value={layout}
          options={LAYOUT_OPTIONS}
          onChange={(next) => workspace.dispatch({ type: 'dashboard_layout', layout: next })}
        />
      </header>
      <div className="tk-dash-panes" data-n={layout}>
        {shown.map((key, i) => {
          const conv = key ? conversationByKey.get(key) ?? null : null;
          return (
            <DashboardPane
              key={i}
              index={i}
              conv={conv && pinnedKeys.has(conv.threadKey) ? conv : null}
              focused={i === focusedPane}
              pinned={pinned}
              placed={shown}
              onFocus={focusPane}
              onPlace={place}
              onSwap={swap}
            />
          );
        })}
      </div>
    </div>
  );
}
