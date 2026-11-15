// The "Sessions" part of the rail: sessions grouped (by type unless the person chose otherwise),
// filtered and sorted through the shared lens, with the Organize menu beside the heading. A row
// opens its session where the person is working (a tab in Browse, the selection in Threads, the
// focused pane in Dashboard). Collapsed groups are kept in the workspace state.
import React, { useId, useMemo } from 'react';
import { getDisplayTitle, type ConversationRecord } from '../../../core/schema.js';
import { useWorkspaceContext } from '../workspace/context.js';
import {
  EMPTY_LENS_FILTERS,
  applyLensFilters,
  collapseToggleId,
  groupLens,
  isGroupCollapsed,
  isLensFiltered,
  lensGroupLabel,
  selfConversation,
  sortLens,
  type LensGroup,
} from '../workspace/lens.js';
import { SESSION_GROUP_LABELS, sessionGroupOf, threadTabId } from '../workspace/state.js';
import { buildRepositoryIndex } from '../threads/grouping.js';
import { Icon } from './icons.js';
import { OrganizeMenu, useLensUniverse, useSurfaceLens } from './OrganizeMenu.js';
import { AccountChip, ProviderMark, RunState, providerName } from './primitives.js';

/** Most rows a group shows in the rail; the rest are a click away in Threads. */
export const RAIL_GROUP_LIMIT = 6;
/** The single "no grouping" list has no headers to scan, so it shows more. */
export const RAIL_UNGROUPED_LIMIT = 12;

/** Sessions worth listing: no synthetic benchmark records, no archived threads. */
export function railEligibleSessions(conversations: readonly ConversationRecord[]): ConversationRecord[] {
  return conversations.filter((conv) => !conv.isSyntheticBenchmark && conv.workflowState !== 'archived');
}

/** A visually hidden separator, so a row's accessible name reads as a sentence. */
const Sep = () => <span className="tk-visually-hidden">, </span>;

/** An element id fragment from a group id (which may hold account ids and repository names). */
const idPart = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, '_');

export function SessionsNav({ onOpened }: { onOpened?: () => void }) {
  const ctx = useWorkspaceContext();
  const { workspace, conversations, view, selectedThreadKey, accountOfThread, openSession, setView, showInThreads } = ctx;
  const headingId = useId();
  const lens = useSurfaceLens('sidebar');
  const { groupBy, sortBy, filters } = lens;
  const eligible = useMemo(() => railEligibleSessions(conversations), [conversations]);
  const universe = useLensUniverse(eligible);
  const filtered = useMemo(
    () => applyLensFilters(eligible, filters, selfConversation, universe.accountIdOf),
    [eligible, filters, universe.accountIdOf]
  );
  const sorted = useMemo(() => sortLens(filtered, sortBy, selfConversation), [filtered, sortBy]);
  const repositoryIndex = useMemo(() => (groupBy === 'repository' ? buildRepositoryIndex(conversations) : null), [groupBy, conversations]);
  const groups = useMemo(
    () =>
      groupLens(sorted, groupBy, selfConversation, {
        now: Date.now(),
        accountIdOf: universe.accountIdOf,
        accountOrder: universe.accountOrder,
        repositoryOf: repositoryIndex ? (conv) => repositoryIndex.get(conv.threadKey) ?? null : undefined,
      }),
    [sorted, groupBy, universe.accountIdOf, universe.accountOrder, repositoryIndex]
  );
  const collapsed = workspace.state.collapsedGroups;
  const filtering = isLensFiltered(filters);

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

  const names = universe.describeFilters(filters);

  /** What a group header shows, and the name the group goes by in labels. */
  const titleOf = (group: LensGroup<ConversationRecord>): { node: React.ReactNode; name: string } => {
    if (groupBy === 'kind') {
      const name = SESSION_GROUP_LABELS[group.key as keyof typeof SESSION_GROUP_LABELS] ?? lensGroupLabel('kind', group.key);
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
    if (groupBy === 'account') {
      const owner = group.key ? accountOfThread(group.sessions[0]) : null;
      if (!owner?.account) return { node: <span>No account</span>, name: 'No account' };
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
    if (groupBy === 'repository' && group.key) {
      return { node: <span className="tk-rail-mono">{group.key}</span>, name: group.key };
    }
    const name = lensGroupLabel(groupBy, group.key);
    return { node: <span>{name}</span>, name };
  };

  const showAll = (group: LensGroup<ConversationRecord>) => {
    if (showInThreads) showInThreads({ by: groupBy, key: group.key });
    else setView('threads');
    onOpened?.();
  };

  /** "Show all 8 coding agents in Threads": what pressing it leads to, in words. */
  const showAllLabel = (group: LensGroup<ConversationRecord>, name: string) => {
    const n = group.sessions.length;
    if (groupBy === 'kind') return `Show all ${n} ${name.toLowerCase()} in Threads`;
    if (groupBy === 'provider' || groupBy === 'account' || groupBy === 'repository') return `Show all ${n} sessions of ${name} in Threads`;
    return `Show all ${n} sessions in Threads`;
  };

  if (eligible.length === 0) {
    return (
      <section className="tk-rail-sessions" aria-labelledby={headingId}>
        <h2 className="tk-rail-label" id={headingId}>
          Sessions
        </h2>
        <p className="tk-rail-empty">Sessions you open or capture appear here.</p>
      </section>
    );
  }

  const renderRow = (conv: ConversationRecord) => {
    const title = getDisplayTitle(conv) || 'Untitled session';
    const owner = accountOfThread(conv);
    // The account says something only when there is a choice of accounts, or when
    // this session is not on the one signed in.
    const showAccount = owner.realm !== null && (accountCount(owner.realm.id) > 1 || !owner.active);
    const isOpen = openKeys.live.has(threadTabId(conv.threadKey)) || openKeys.keys.has(conv.threadKey);
    const run = sessionGroupOf(conv.provider) === 'coding' ? conv.agentState : null;
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
  };

  return (
    <section className="tk-rail-sessions" aria-labelledby={headingId}>
      <div className="tk-rail-heading">
        <h2 className="tk-rail-label" id={headingId}>
          Sessions
        </h2>
        <OrganizeMenu
          surface="sidebar"
          universe={universe}
          groupBy={groupBy}
          sortBy={sortBy}
          filters={filters}
          onGroupBy={lens.setGroupBy}
          onSortBy={lens.setSortBy}
          onFilters={lens.setFilters}
          onReset={lens.reset}
          placement="side"
        />
      </div>
      {filtering && (
        <p className="tk-rail-filters">
          <span className="tk-rail-filters-text">Showing only {names.join(', ')}</span>
          <button
            type="button"
            className="tk-rail-clear"
            aria-label="Clear session filters"
            onClick={() => {
              lens.setFilters(EMPTY_LENS_FILTERS);
              ctx.announce('Session filters cleared.');
            }}
          >
            Clear
          </button>
        </p>
      )}
      {groups.length === 0 && <p className="tk-rail-empty">No sessions match these filters.</p>}
      {groups.map((group) => {
        const { node, name } = titleOf(group);
        const ungrouped = groupBy === 'none';
        const open = ungrouped || !isGroupCollapsed(collapsed, group.id);
        const listId = `${headingId}-${idPart(group.id)}`;
        const limit = ungrouped ? RAIL_UNGROUPED_LIMIT : RAIL_GROUP_LIMIT;
        const shown = group.sessions.slice(0, limit);
        return (
          <div className="tk-rail-group" key={group.id}>
            {!ungrouped && (
              <button
                type="button"
                className="tk-rail-group-head"
                aria-expanded={open}
                aria-controls={listId}
                onClick={() => workspace.dispatch({ type: 'toggle_group', group: collapseToggleId(collapsed, group.id) })}
              >
                <Icon name="chevronDown" size={12} />
                {node}
                <span className="tk-rail-count">
                  {group.sessions.length}
                  <span className="tk-visually-hidden"> {group.sessions.length === 1 ? 'session' : 'sessions'}</span>
                </span>
              </button>
            )}
            <ul className="tk-rail-list" id={listId} hidden={!open}>
              {shown.map(renderRow)}
            </ul>
            {open && group.sessions.length > limit && (
              <button type="button" className="tk-rail-more" aria-label={showAllLabel(group, name)} onClick={() => showAll(group)}>
                Show all
              </button>
            )}
          </div>
        );
      })}
    </section>
  );
}
