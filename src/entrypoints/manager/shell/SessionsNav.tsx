// The "Sessions" part of the rail: recent sessions grouped as coding agents, chats and bots. A row
// opens its session where the person is working (a tab in Browse, the selection in Threads, the
// focused pane in Dashboard). Collapsed groups are kept in the workspace state.
import React, { useId, useMemo } from 'react';
import { getDisplayTitle, type ConversationRecord } from '../../../core/schema.js';
import { useWorkspaceContext } from '../workspace/context.js';
import {
  SESSION_GROUP_LABELS,
  SESSION_GROUP_ORDER,
  sessionGroupOf,
  threadTabId,
  type SessionGroup,
} from '../workspace/state.js';
import { Icon } from './icons.js';
import { AccountChip, ProviderMark, RunState, providerName } from './primitives.js';

/** Most rows a group shows in the rail; the rest are a click away in Threads. */
export const RAIL_GROUP_LIMIT = 6;

function updatedAt(conv: ConversationRecord): number {
  const stamp = Date.parse(conv.updatedAt ?? conv.lastCapturedAt ?? '');
  return Number.isFinite(stamp) ? stamp : 0;
}

/** Sessions worth listing: no synthetic benchmark records, no archived threads; newest first. */
export function railSessionGroups(
  conversations: readonly ConversationRecord[]
): Array<{ group: SessionGroup; sessions: ConversationRecord[] }> {
  const byGroup = new Map<SessionGroup, ConversationRecord[]>();
  for (const conv of conversations) {
    if (conv.isSyntheticBenchmark || conv.workflowState === 'archived') continue;
    const group = sessionGroupOf(conv.provider);
    const list = byGroup.get(group);
    if (list) list.push(conv);
    else byGroup.set(group, [conv]);
  }
  return SESSION_GROUP_ORDER.flatMap((group) => {
    const sessions = byGroup.get(group);
    if (!sessions || sessions.length === 0) return [];
    return [{ group, sessions: [...sessions].sort((a, b) => updatedAt(b) - updatedAt(a)) }];
  });
}

/** A visually hidden separator, so a row's accessible name reads as a sentence. */
const Sep = () => <span className="tk-visually-hidden">, </span>;

export function SessionsNav({ onOpened }: { onOpened?: () => void }) {
  const ctx = useWorkspaceContext();
  const { workspace, conversations, view, selectedThreadKey, accountOfThread, openSession, setView } = ctx;
  const headingId = useId();
  const groups = useMemo(() => railSessionGroups(conversations), [conversations]);
  const collapsed = workspace.state.collapsedGroups;

  // Which thread is showing right now, in the view that is showing.
  const currentKey = useMemo(() => {
    if (view === 'browse') {
      const tab = workspace.state.tabs.find((t) => t.id === workspace.state.activeTabId);
      return tab?.threadKey ?? null;
    }
    if (view === 'threads') return selectedThreadKey;
    const { panes, focusedPane } = workspace.state.dashboard;
    return panes[focusedPane] ?? null;
  }, [view, workspace.state.tabs, workspace.state.activeTabId, workspace.state.dashboard, selectedThreadKey]);

  // Threads whose page is loaded in the workspace right now.
  const openKeys = useMemo(() => {
    const live = new Set(workspace.plan.live);
    const keys = new Set<string>();
    for (const tab of workspace.state.tabs) {
      if (tab.threadKey && live.has(tab.id)) keys.add(tab.threadKey);
    }
    return { live, keys };
  }, [workspace.plan.live, workspace.state.tabs]);

  const accountCount = (realmId: string | undefined) =>
    realmId ? workspace.realms.find((r) => r.realm.id === realmId)?.accounts.length ?? 0 : 0;

  if (groups.length === 0) {
    return (
      <section className="tk-rail-sessions" aria-labelledby={headingId}>
        <h2 className="tk-rail-label" id={headingId}>
          Sessions
        </h2>
        <p className="tk-rail-empty">Sessions you open or capture appear here.</p>
      </section>
    );
  }

  return (
    <section className="tk-rail-sessions" aria-labelledby={headingId}>
      <h2 className="tk-rail-label" id={headingId}>
        Sessions
      </h2>
      {groups.map(({ group, sessions }) => {
        const label = SESSION_GROUP_LABELS[group];
        const open = !collapsed.includes(group);
        const listId = `${headingId}-${group}`;
        const shown = sessions.slice(0, RAIL_GROUP_LIMIT);
        return (
          <div className="tk-rail-group" key={group}>
            <button
              type="button"
              className="tk-rail-group-head"
              aria-expanded={open}
              aria-controls={listId}
              onClick={() => workspace.dispatch({ type: 'toggle_group', group })}
            >
              <Icon name="chevronDown" size={12} />
              <span>{label}</span>
              <span className="tk-rail-count">
                {sessions.length}
                <span className="tk-visually-hidden"> {sessions.length === 1 ? 'session' : 'sessions'}</span>
              </span>
            </button>
            <ul className="tk-rail-list" id={listId} hidden={!open}>
              {shown.map((conv) => {
                const title = getDisplayTitle(conv) || 'Untitled session';
                const owner = accountOfThread(conv);
                // The account says something only when there is a choice of accounts, or when
                // this session is not on the one signed in.
                const showAccount = owner.realm !== null && (accountCount(owner.realm.id) > 1 || !owner.active);
                const isOpen = openKeys.live.has(threadTabId(conv.threadKey)) || openKeys.keys.has(conv.threadKey);
                const run = group === 'coding' ? conv.agentState : null;
                const hasRun = Boolean(run && run !== 'unknown');
                return (
                  <li key={conv.threadKey}>
                    <button
                      type="button"
                      className="tk-rail-row"
                      title={title}
                      aria-current={currentKey === conv.threadKey ? 'true' : undefined}
                      data-open={isOpen ? 'true' : undefined}
                      onClick={() => {
                        openSession(conv);
                        onOpened?.();
                      }}
                    >
                      <ProviderMark provider={conv.provider} />
                      <span className="tk-rail-row-text">
                        <span className="tk-rail-row-title">{title}</span>
                        <Sep />
                        <span className="tk-visually-hidden">{providerName(conv.provider)}</span>
                        {(showAccount || hasRun) && (
                          <span className="tk-rail-row-meta">
                            {showAccount && (
                              <>
                                <span className="tk-visually-hidden">, </span>
                                <AccountChip account={owner.account} active={owner.active} />
                              </>
                            )}
                            {hasRun && (
                              <>
                                <span className="tk-visually-hidden">, last seen </span>
                                <RunState state={run} observedAt={conv.agentStateAt} />
                              </>
                            )}
                          </span>
                        )}
                      </span>
                      {isOpen && (
                        <span className="tk-rail-row-open" title="Open in the workspace">
                          <Icon name="live" size={14} />
                          <span className="tk-visually-hidden">, Open</span>
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
            {open && sessions.length > RAIL_GROUP_LIMIT && (
              <button
                type="button"
                className="tk-rail-more"
                aria-label={`Show all ${sessions.length} ${label.toLowerCase()} in Threads`}
                onClick={() => {
                  setView('threads');
                  onOpened?.();
                }}
              >
                Show all
              </button>
            )}
          </div>
        );
      })}
    </section>
  );
}
