// The Dashboard: pinned sessions in one to four live panes. The bar picks what goes in the
// focused pane and how many panes there are; each pane keeps its page loaded through the frame
// stage, so changing layout or view never reloads a session.
import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import type { ConversationRecord } from '../../../core/schema.js';
import { DASHBOARD_LAYOUTS, type DashboardLayout } from '../../../core/workspace/types.js';
import { OrganizeMenu, useLensUniverse, useSurfaceLens } from '../shell/OrganizeMenu.js';
import { AccountChip, Notice, ProviderMark, RunState, Segmented, providerName, type SegmentOption } from '../shell/primitives.js';
import { useWorkspaceContext } from '../workspace/context.js';
import { EMPTY_LENS_FILTERS, SESSION_KIND_LABELS, isLensFiltered, lensGroupLabel, type LensGroup } from '../workspace/lens.js';
import { threadTabId } from '../workspace/state.js';
import { AGENT_STATE_LABELS } from '../../../core/workspace/types.js';
import { DashboardPane } from './DashboardPane.js';
import { hasWebPage, organizePinned, pinnedSessions, sessionTitle } from './shared.js';

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

  // The lens: filters narrow which pinned sessions the bar offers, sort orders them, group puts
  // them in labelled clusters. A session already in a pane keeps its pane whatever they say.
  const lens = useSurfaceLens('dashboard');
  const universe = useLensUniverse(pinned);
  const { groupBy, sortBy, filters } = lens;
  const filtering = isLensFiltered(filters);
  const organized = useMemo(
    () =>
      organizePinned(
        pinned,
        { filters, sortBy, groupBy },
        { accountIdOf: universe.accountIdOf, accountOrder: universe.accountOrder, now: Date.now() }
      ),
    [pinned, filters, sortBy, groupBy, universe.accountIdOf, universe.accountOrder]
  );
  const offered = useMemo(() => {
    if (!filtering) return organized.visible;
    const visibleKeys = new Set(organized.visible.map((c) => c.threadKey));
    return [...organized.visible, ...pinned.filter((c) => shown.includes(c.threadKey) && !visibleKeys.has(c.threadKey))];
  }, [filtering, organized.visible, pinned, shown]);
  // Pinned sessions an empty pane could take but the filters hide, so it can say so.
  const hiddenByFilters = useMemo(() => {
    if (!filtering) return 0;
    const offeredKeys = new Set(offered.map((c) => c.threadKey));
    return pinned.filter((c) => !offeredKeys.has(c.threadKey) && hasWebPage(c)).length;
  }, [filtering, offered, pinned]);
  const clearFilters = () => {
    lens.setFilters(EMPTY_LENS_FILTERS);
    ctx.announce('Dashboard filters cleared.');
  };

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

  const renderPin = (conv: ConversationRecord) => {
    const slot = shown.indexOf(conv.threadKey);
    const owner = ctx.accountOfThread(conv);
    const web = hasWebPage(conv);
    const title = sessionTitle(conv);
    const state = conv.agentState && conv.agentState !== 'unknown' ? AGENT_STATE_LABELS[conv.agentState] : null;
    const label = [title, owner.account?.label ?? 'Removed account', state, slot >= 0 ? `in pane ${slot + 1}` : null]
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
  };

  /** The label of a cluster of pinned sessions: type, provider or account. */
  const clusterTitle = (group: LensGroup<ConversationRecord>): { node: React.ReactNode; name: string } => {
    if (groupBy === 'kind') {
      const name = lensGroupLabel('kind', group.key, SESSION_KIND_LABELS);
      return { node: <span>{name}</span>, name };
    }
    if (groupBy === 'provider' && group.key) {
      const name = providerName(group.key);
      return {
        node: (
          <>
            <ProviderMark provider={group.key} size="sm" />
            <span>{name}</span>
          </>
        ),
        name,
      };
    }
    const owner = groupBy === 'account' && group.key ? ctx.accountOfThread(group.sessions[0]) : null;
    if (owner?.account) {
      const name = `${owner.realm ? `${owner.realm.label} · ` : ''}${owner.account.label}`;
      return {
        node: (
          <>
            <span className="tk-acct" data-color={owner.account.color} data-active={owner.active ? 'true' : 'false'}>
              <span className="tk-acct-dot" aria-hidden="true" />
            </span>
            <span>{name}</span>
          </>
        ),
        name,
      };
    }
    const name = lensGroupLabel(groupBy, group.key);
    return { node: <span>{name}</span>, name };
  };

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
        <OrganizeMenu
          surface="dashboard"
          universe={universe}
          groupBy={groupBy}
          sortBy={sortBy}
          filters={filters}
          onGroupBy={lens.setGroupBy}
          onSortBy={lens.setSortBy}
          onFilters={lens.setFilters}
          onReset={lens.reset}
        />
        <div className="tk-dash-pins" role="group" aria-label="Pinned sessions">
          {organized.visible.length === 0 ? (
            <p className="tk-dash-nomatch" role="status">
              <span>No pinned sessions match {universe.describeFilters(filters).join(', ') || 'the filters'}.</span>
              <button type="button" className="tk-btn tk-btn-quiet" onClick={clearFilters}>
                Clear
              </button>
            </p>
          ) : groupBy === 'none' ? (
            organized.visible.map(renderPin)
          ) : (
            organized.groups.map((group) => {
              const { node, name } = clusterTitle(group);
              const n = group.sessions.length;
              return (
                <div className="tk-dash-cluster" role="group" aria-label={`${name}, ${n} ${n === 1 ? 'session' : 'sessions'}`} key={group.id}>
                  <span className="tk-dash-cluster-label" aria-hidden="true">
                    {node}
                    <span className="tk-tabular">{n}</span>
                  </span>
                  {group.sessions.map(renderPin)}
                </div>
              );
            })
          )}
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
              pinned={offered}
              placed={shown}
              hiddenByFilters={hiddenByFilters}
              onClearFilters={clearFilters}
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
